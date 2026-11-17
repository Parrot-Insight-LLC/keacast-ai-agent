'use strict';
const jwt = require('jsonwebtoken');
const { getCashflowJwtSecret, isCashflowSessionActive } = require('../middleware/cashflowAuth');
const { id } = require('./legacyReadAuthorization');

class SessionAuthorizationError extends Error {
  constructor(code, status) {
    super(status === 503 ? 'Session verification temporarily unavailable.' : 'An active user session is required for this operation.');
    this.name = 'SessionAuthorizationError';
    this.code = code;
    this.status = status;
  }
}

// Fresh authorization at the real executor boundary, not a cached ingress flag.
// Reuses the issuer resolver and bounded parameterized session lookup; model
// arguments, "verified" flags and ctx claims cannot replace token verification.
async function assertActiveCashflowSession(token, actorId, { queryFn, dbTimeoutMs } = {}) {
  const secret = getCashflowJwtSecret();
  if (!secret) throw new SessionAuthorizationError('SESSION_CHECK_UNAVAILABLE', 503);
  if (typeof token !== 'string' || !token) throw new SessionAuthorizationError('SESSION_REQUIRED', 401);
  let payload;
  try { payload = jwt.verify(token, secret, { algorithms: ['HS256'] }); }
  catch (_) { throw new SessionAuthorizationError('TOKEN_INVALID', 401); }
  if (!payload || typeof payload !== 'object' || payload.setup || payload.share || payload.sat) {
    throw new SessionAuthorizationError('TOKEN_WRONG_KIND', 401);
  }
  if (!id(actorId) || id(payload.id) !== id(actorId)) {
    throw new SessionAuthorizationError('SESSION_ACTOR_MISMATCH', 401);
  }
  if (typeof payload.jti !== 'string' || !payload.jti.trim()) {
    throw new SessionAuthorizationError('SESSION_REQUIRED', 401);
  }
  let active;
  try {
    const query = queryFn || require('./db').query;
    active = await isCashflowSessionActive(payload.jti, payload.id, query, dbTimeoutMs);
  } catch (_) {
    throw new SessionAuthorizationError('SESSION_CHECK_UNAVAILABLE', 503);
  }
  if (!active) throw new SessionAuthorizationError('SESSION_REVOKED', 401);
  return { id: payload.id, jti: payload.jti };
}

module.exports = { assertActiveCashflowSession, SessionAuthorizationError };
