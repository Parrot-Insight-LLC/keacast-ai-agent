// controllers/cacheController.js
const contextCache = require('../services/contextCache.service');
const redis = require('../services/redisService');

// ─── Admin-only flush helpers ───────────────────────────────────────────────
// These power the "wipe all summarization / autocategorize cache for every
// user" maintenance endpoints. They MUST never use KEYS or FLUSHDB — both
// block the Redis event loop on production-sized datasets and risk taking
// down chat/auth flows that share the same instance. We always use SCAN
// (cursor-based, non-blocking) and UNLINK (lazy free) when available.

// Cache-key prefixes documented across the controllers. Update this map if
// new LLM-cache shapes get introduced so flushes stay comprehensive.
const FLUSHABLE_PREFIXES = {
  summarization: [
    // Final LLM-written summaries (account-scoped, fingerprint-keyed).
    'summarization:session:*',
    // 5-min cache of the heavy /account/selected blob used by summarization.
    'summarization:tool:selectedaccount:*',
  ],
  autocategorize: [
    // Per-user/account/merchant/PFC suggestion cache.
    'autocat:*',
  ],
};

// Lower-cased header name the gate checks for the shared admin secret.
const ADMIN_KEY_HEADER = 'x-admin-key';

// Returns true if the request is allowed to flush. In production we require
// `x-admin-key` to match `process.env.ADMIN_CACHE_FLUSH_KEY`. In non-prod
// we skip the gate entirely so devs can curl the endpoint without env setup.
function isAdminFlushAllowed(req) {
  const expected = process.env.ADMIN_CACHE_FLUSH_KEY;
  const provided = req.headers[ADMIN_KEY_HEADER] || req.headers['X-Admin-Key'];
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd && !expected) return true; // dev / local convenience
  if (!expected) return false;            // prod with no key configured → refuse
  return typeof provided === 'string' && provided.length > 0 && provided === expected;
}

// Stream-scan + UNLINK by pattern. Returns { deleted, sampleKeys }.
//   - SCAN with MATCH + COUNT batches lookups so we never block Redis.
//   - UNLINK removes keys lazily on the Redis side (no foreground free).
//   - Falls back to DEL automatically if UNLINK isn't supported (Redis < 4).
async function scanAndUnlinkByPattern(pattern, { batchSize = 500, sampleLimit = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let deleted = 0;
    const sampleKeys = [];
    const stream = redis.scanStream({ match: pattern, count: batchSize });

    stream.on('data', async (keys) => {
      if (!keys || keys.length === 0) return;
      // Pause the stream while we issue the delete so we don't pile up
      // pipelined deletes faster than Redis can drain them.
      stream.pause();
      try {
        // Capture a small sample for the response (the first few keys we saw),
        // useful for confirming the operation matched the right shape.
        for (const k of keys) {
          if (sampleKeys.length < sampleLimit) sampleKeys.push(k);
          else break;
        }

        // Prefer UNLINK (non-blocking). ioredis exposes it as redis.unlink().
        if (typeof redis.unlink === 'function') {
          deleted += await redis.unlink(...keys);
        } else {
          deleted += await redis.del(...keys);
        }
      } catch (e) {
        stream.destroy(e);
        return;
      }
      stream.resume();
    });

    stream.on('end', () => resolve({ deleted, sampleKeys }));
    stream.on('error', (err) => reject(err));
  });
}

// Run multiple patterns and aggregate the totals.
async function flushPatterns(patterns) {
  const results = [];
  let totalDeleted = 0;
  for (const pattern of patterns) {
    const { deleted, sampleKeys } = await scanAndUnlinkByPattern(pattern);
    totalDeleted += deleted;
    results.push({ pattern, deleted, sampleKeys });
  }
  return { totalDeleted, perPattern: results };
}

/**
 * Invalidate all cached data for a user
 */
exports.invalidateUserCache = async (req, res) => {
  try {
    const { userId } = req.params;
    const { token, userId: authUserId } = extractAuthFromRequest(req);
    
    // Ensure user can only invalidate their own cache or admin access
    if (userId !== authUserId && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    console.log('Cache invalidation requested for user:', userId);
    const invalidatedCount = await contextCache.invalidateUserCache(userId);
    
    res.json({
      success: true,
      message: `Invalidated ${invalidatedCount} cache entries for user ${userId}`,
      invalidatedKeys: invalidatedCount,
      userId: userId
    });
  } catch (error) {
    console.error('Error invalidating user cache:', error);
    res.status(500).json({ 
      error: 'Failed to invalidate cache',
      details: error.message 
    });
  }
};

/**
 * Invalidate cache for specific account
 */
exports.invalidateAccountCache = async (req, res) => {
  try {
    const { userId, accountId } = req.params;
    const { token, userId: authUserId } = extractAuthFromRequest(req);
    
    // Ensure user can only invalidate their own cache
    if (userId !== authUserId && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    console.log('Account cache invalidation requested for user:', userId, 'account:', accountId);
    await contextCache.invalidateAccountCache(userId, accountId);
    
    res.json({
      success: true,
      message: `Invalidated cache for user ${userId} account ${accountId}`,
      userId: userId,
      accountId: accountId
    });
  } catch (error) {
    console.error('Error invalidating account cache:', error);
    res.status(500).json({ 
      error: 'Failed to invalidate account cache',
      details: error.message 
    });
  }
};

/**
 * Warm up cache for a user
 */
exports.warmUpCache = async (req, res) => {
  try {
    const { userId, accountId } = req.params;
    const { token, userId: authUserId } = extractAuthFromRequest(req);
    const location = req.body?.location;
    
    // Ensure user can only warm up their own cache
    if (userId !== authUserId && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    if (!token) {
      return res.status(400).json({ error: 'Authentication token required' });
    }
    
    console.log('Cache warm-up requested for user:', userId, 'account:', accountId);
    const success = await contextCache.warmUpCache(userId, token, accountId, location);
    
    if (success) {
      res.json({
        success: true,
        message: `Cache warmed up successfully for user ${userId} account ${accountId}`,
        userId: userId,
        accountId: accountId
      });
    } else {
      res.status(500).json({
        success: false,
        message: `Failed to warm up cache for user ${userId} account ${accountId}`,
        userId: userId,
        accountId: accountId
      });
    }
  } catch (error) {
    console.error('Error warming up cache:', error);
    res.status(500).json({ 
      error: 'Failed to warm up cache',
      details: error.message 
    });
  }
};

/**
 * Get cache statistics for a user
 */
exports.getCacheStats = async (req, res) => {
  try {
    const { userId } = req.params;
    const { token, userId: authUserId } = extractAuthFromRequest(req);
    
    // Ensure user can only view their own cache stats
    if (userId !== authUserId && !req.user?.isAdmin) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    console.log('Cache stats requested for user:', userId);
    const stats = await contextCache.getCacheStats(userId);
    
    res.json({
      success: true,
      userId: userId,
      cacheStats: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting cache stats:', error);
    res.status(500).json({ 
      error: 'Failed to get cache statistics',
      details: error.message 
    });
  }
};

// ─── Flush endpoints (admin-gated) ──────────────────────────────────────────
// These wipe LLM-cache key groups across EVERY user. Intended for one-shot
// maintenance when a prompt change means previously-cached answers should no
// longer be served (e.g. category-policy update, summarization prompt
// rewrite). They never block: the SCAN cursor + UNLINK fan-out is bounded by
// FLUSHABLE_PREFIXES which we own.
//
// Auth: provide `x-admin-key: <ADMIN_CACHE_FLUSH_KEY>` in production. In
// non-prod the gate is open so devs can curl without env setup.

/**
 * DELETE /api/cache/flush/summarization
 * Drops every cached summary AND the 5-min /account/selected blob cache.
 * Next call to /summarization for any user/account will rebuild from scratch.
 */
exports.flushSummarizationCache = async (req, res) => {
  if (!isAdminFlushAllowed(req)) {
    return res.status(403).json({ error: 'Admin key required' });
  }
  try {
    const t0 = Date.now();
    const result = await flushPatterns(FLUSHABLE_PREFIXES.summarization);
    console.log(
      'Cache flush (summarization): deleted', result.totalDeleted,
      'keys across', result.perPattern.length, 'patterns in', Date.now() - t0, 'ms'
    );
    return res.json({
      success: true,
      target: 'summarization',
      deleted: result.totalDeleted,
      perPattern: result.perPattern,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Cache flush (summarization) failed:', error);
    return res.status(500).json({
      error: 'Failed to flush summarization cache',
      details: error.message,
    });
  }
};

/**
 * DELETE /api/cache/flush/autocategorize
 * Drops every cached auto-categorization suggestion across all users.
 * Next call to /auto-categorize for any merchant will rebuild from scratch.
 */
exports.flushAutoCategorizeCache = async (req, res) => {
  if (!isAdminFlushAllowed(req)) {
    return res.status(403).json({ error: 'Admin key required' });
  }
  try {
    const t0 = Date.now();
    const result = await flushPatterns(FLUSHABLE_PREFIXES.autocategorize);
    console.log(
      'Cache flush (autocategorize): deleted', result.totalDeleted,
      'keys across', result.perPattern.length, 'patterns in', Date.now() - t0, 'ms'
    );
    return res.json({
      success: true,
      target: 'autocategorize',
      deleted: result.totalDeleted,
      perPattern: result.perPattern,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Cache flush (autocategorize) failed:', error);
    return res.status(500).json({
      error: 'Failed to flush autocategorize cache',
      details: error.message,
    });
  }
};

/**
 * DELETE /api/cache/flush/all
 * Drops both summarization and autocategorize caches in one call. Use this
 * after a major prompt-engineering change that affects both endpoints.
 */
exports.flushLLMCache = async (req, res) => {
  if (!isAdminFlushAllowed(req)) {
    return res.status(403).json({ error: 'Admin key required' });
  }
  try {
    const t0 = Date.now();
    const allPatterns = [
      ...FLUSHABLE_PREFIXES.summarization,
      ...FLUSHABLE_PREFIXES.autocategorize,
    ];
    const result = await flushPatterns(allPatterns);
    console.log(
      'Cache flush (all LLM): deleted', result.totalDeleted,
      'keys across', result.perPattern.length, 'patterns in', Date.now() - t0, 'ms'
    );
    return res.json({
      success: true,
      target: 'all-llm-caches',
      deleted: result.totalDeleted,
      perPattern: result.perPattern,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Cache flush (all LLM) failed:', error);
    return res.status(500).json({
      error: 'Failed to flush LLM caches',
      details: error.message,
    });
  }
};

/**
 * Get cache health status
 */
exports.getCacheHealth = async (req, res) => {
  try {
    const redis = require('../services/redisService');
    
    // Test Redis connection
    const testKey = `health-check-${Date.now()}`;
    await redis.set(testKey, 'ok', 'EX', 10);
    const testValue = await redis.get(testKey);
    await redis.del(testKey);
    
    // Get Redis info
    const redisInfo = await redis.info('memory');
    const memoryLines = redisInfo.split('\n').filter(line => 
      line.includes('used_memory_human') || 
      line.includes('maxmemory_human') ||
      line.includes('used_memory_peak_human')
    );
    
    const memoryInfo = {};
    memoryLines.forEach(line => {
      const [key, value] = line.split(':');
      if (key && value) {
        memoryInfo[key.trim()] = value.trim();
      }
    });
    
    res.json({
      success: true,
      status: 'healthy',
      redis: {
        connected: true,
        testPassed: testValue === 'ok',
        memory: memoryInfo
      },
      contextCache: {
        enabled: true,
        version: '1.0.0'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Cache health check failed:', error);
    res.status(503).json({
      success: false,
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// Helper function to extract auth info from request
function extractAuthFromRequest(req) {
  const bearerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.split(' ')[1]
    : undefined;
  const headerToken = req.headers['x-auth-token'];
  const bodyToken = req.body?.token;
  const token = bearerToken || headerToken || bodyToken;

  const headerUserId = req.headers['x-user-id'];
  const bodyUserId = req.body?.sessionId;
  const jwtUserId = req.user?.id;
  const userId = bodyUserId || headerUserId || jwtUserId;

  return { token, userId, authHeader: req.headers.authorization };
}
