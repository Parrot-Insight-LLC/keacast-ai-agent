'use strict';

function normalizeCacheSegment(id) {
  if (id === undefined || id === null || id === '') return 'none';
  const str = String(id).trim();
  if (!str) return 'none';
  return str.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function selectedAccountToolCacheKey(userId, accountId) {
  return `summarization:tool:selectedaccount:${normalizeCacheSegment(userId)}:${normalizeCacheSegment(accountId)}`;
}

function selectedAccountUserPattern(userId) {
  return `summarization:tool:selectedaccount:${normalizeCacheSegment(userId)}:*`;
}

function emitKeaSnapshotInvalidated({ reason, requestId, userId, accountId } = {}) {
  try {
    const { hashUserKey, hashAccountKey } = require('./keaTelemetry');
    console.log(JSON.stringify({
      event: 'kea_snapshot_invalidated',
      reason: reason || null,
      requestId: requestId || null,
      userKey: hashUserKey(userId),
      accountKey: hashAccountKey(accountId),
    }));
  } catch (e) {
    console.warn('kea_snapshot_invalidated emit failed:', e.message);
  }
}

async function invalidateSelectedAccountToolCache(userId, accountId, { reason, requestId } = {}) {
  if (!userId || accountId === undefined || accountId === null || accountId === '') return;
  try {
    const redis = require('./redisService');
    await redis.del(selectedAccountToolCacheKey(userId, accountId));
    emitKeaSnapshotInvalidated({
      reason: reason || null,
      requestId,
      userId,
      accountId,
    });
  } catch (e) {
    console.warn('Selected-account tool cache invalidate failed:', e.message);
  }
}

module.exports = {
  normalizeCacheSegment,
  selectedAccountToolCacheKey,
  selectedAccountUserPattern,
  invalidateSelectedAccountToolCache,
  emitKeaSnapshotInvalidated,
};
