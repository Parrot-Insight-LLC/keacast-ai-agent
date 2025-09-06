// controllers/cacheController.js
const contextCache = require('../services/contextCache.service');

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
