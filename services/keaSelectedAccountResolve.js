'use strict';

const { compactSelectedAccount, measurePayloadKeyBytes } = require('./keaAccountSnapshot');
const { selectedAccountToolCacheKey, emitKeaSnapshotInvalidated } = require('./keaAccountCache');

const SELECTED_ACCOUNT_TOOL_TTL = 300;
const SELECTED_ACCOUNT_TOOL_TIMEOUT_MS = 25000;

function payloadHistogramEnabled() {
  return process.env.KEA_PAYLOAD_HISTOGRAM === '1';
}

function isAuthoritativeKeaCompact(obj) {
  return !!(
    obj &&
    typeof obj === 'object' &&
    obj._keaCompact === true &&
    Number(obj.schemaVersion) === 1
  );
}

class KeaContextFetchError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'KeaContextFetchError';
    this.cause = cause;
    this.status = cause && cause.response ? cause.response.status : undefined;
  }
}

async function cacheCompactJson(redis, toolCacheKey, compact, telemetry) {
  if (telemetry) telemetry.markStart('selected_account_stringify');
  const compactJson = JSON.stringify(compact);
  if (telemetry) telemetry.markEnd('selected_account_stringify');
  const payloadBytes = Buffer.byteLength(compactJson, 'utf8');
  if (telemetry) telemetry.markStart('selected_account_redis_set');
  try {
    await redis.set(toolCacheKey, compactJson, 'EX', SELECTED_ACCOUNT_TOOL_TTL);
  } catch (e) {
    console.warn('Selected-account compact cache write failed:', e.message);
  }
  if (telemetry) telemetry.markEnd('selected_account_redis_set');
  return payloadBytes;
}

/**
 * Redis compact snapshot, else POST /account/kea-context/:accid.
 * Caches schemaVersion 1 objects as-is. Does not call /account/selected.
 */
async function resolveKeaSelectedAccount({
  userId,
  accountId,
  token,
  currentDate,
  requestId,
  redis,
  fetchKeaContext,
  telemetry,
} = {}) {
  const result = {
    selectedAccount: null,
    source: 'none',
    cacheHit: null,
    payloadBytes: null,
    fullPayloadBytes: null,
    payloadKeyBytes: null,
    error: null,
  };

  if (!userId || !token || !accountId || typeof fetchKeaContext !== 'function' || !redis) {
    return result;
  }

  const toolCacheKey = selectedAccountToolCacheKey(userId, accountId);
  result.cacheHit = false;

  if (telemetry) telemetry.markStart('selected_account_redis_ping');
  try {
    await redis.ping();
  } catch (e) {
    console.warn('Selected-account redis ping failed:', e.message);
  }
  if (telemetry) telemetry.markEnd('selected_account_redis_ping');

  if (telemetry) telemetry.markStart('selected_account_cache_lookup');
  let cached = null;
  try {
    cached = await redis.get(toolCacheKey);
  } catch (e) {
    console.warn('Selected-account cache read failed:', e.message);
  }
  if (telemetry) telemetry.markEnd('selected_account_cache_lookup');

  if (cached) {
    result.payloadBytes = Buffer.byteLength(cached, 'utf8');
    if (telemetry) telemetry.markStart('selected_account_parse');
    try {
      const parsed = JSON.parse(cached);
      if (telemetry) telemetry.markEnd('selected_account_parse');

      if (isAuthoritativeKeaCompact(parsed)) {
        result.selectedAccount = parsed;
        result.source = 'tool-cache';
        result.cacheHit = true;
        return result;
      }

      if (payloadHistogramEnabled() && parsed && parsed._keaCompact !== true) {
        result.fullPayloadBytes = result.payloadBytes;
        result.payloadKeyBytes = measurePayloadKeyBytes(parsed);
      }

      if (telemetry) telemetry.markStart('selected_account_compact');
      const adapted = compactSelectedAccount(parsed, currentDate);
      if (telemetry) telemetry.markEnd('selected_account_compact');
      if (adapted && isAuthoritativeKeaCompact(adapted)) {
        result.payloadBytes = await cacheCompactJson(redis, toolCacheKey, adapted, telemetry);
        result.selectedAccount = adapted;
        result.source = 'tool-cache';
        result.cacheHit = true;
        emitKeaSnapshotInvalidated({
          reason: 'rewrite_legacy',
          requestId,
          userId,
          accountId,
        });
        return result;
      }
    } catch (parseErr) {
      if (telemetry) telemetry.markEnd('selected_account_parse');
      console.warn('Selected-account cache parse failed:', parseErr.message);
    }
  }

  if (telemetry) telemetry.markStart('selected_account_http');
  try {
    const fresh = await fetchKeaContext({
      accountId,
      token,
      body: { clientDate: currentDate },
      timeoutMs: SELECTED_ACCOUNT_TOOL_TIMEOUT_MS,
      requestId,
    });
    if (telemetry) telemetry.markEnd('selected_account_http');

    if (!isAuthoritativeKeaCompact(fresh)) {
      result.error = new KeaContextFetchError(
        'Kea context response failed schemaVersion 1 validation'
      );
      return result;
    }

    if (telemetry) telemetry.markStart('selected_account_compact');
    if (telemetry) telemetry.markEnd('selected_account_compact');
    result.payloadBytes = await cacheCompactJson(redis, toolCacheKey, fresh, telemetry);
    result.selectedAccount = fresh;
    result.source = 'tool-fresh';
    result.fullPayloadBytes = null;
    result.payloadKeyBytes = null;
    return result;
  } catch (err) {
    if (telemetry) telemetry.markEnd('selected_account_http');
    result.error = new KeaContextFetchError(
      (err && err.message) || 'Kea context fetch failed',
      err
    );
    return result;
  }
}

module.exports = {
  resolveKeaSelectedAccount,
  isAuthoritativeKeaCompact,
  SELECTED_ACCOUNT_TOOL_TTL,
  SELECTED_ACCOUNT_TOOL_TIMEOUT_MS,
  KeaContextFetchError,
};
