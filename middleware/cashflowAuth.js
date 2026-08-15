'use strict';

const jwt = require('jsonwebtoken');

/**
 * Verify a cashflow-backend user session JWT.
 *
 * Inspected contract (cashflow-backend-api):
 *   mint: services/loginSecurity.js signUserToken
 *         payload = { username, id: user.idusers, jti? }
 *         secret  = config.keyword = process.env.key_word
 *   verify: middlewares/authMiddleware.js authenticateToken
 *         jwt.verify(token, config.keyword)
 *         identity claim is `id` (not `userid`)
 *         if jti present, require user_sessions row (id=jti, user_id=id, revoked_at IS NULL)
 *         legacy tokens without jti are accepted until expiry
 *
 * Agent JWT_SECRET is a different secret used only by unused /api/auth/login.
 * Never verify cashflow tokens with JWT_SECRET.
 */

function getCashflowJwtSecret() {
  return process.env.CASHFLOW_JWT_SECRET || process.env.key_word || null;
}

function extractCashflowToken(req) {
  const bearer = req.headers?.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.split(' ')[1]
    : undefined;
  const headerToken = req.headers?.['x-auth-token'];
  const bodyToken = req.body?.token;
  return bearer || headerToken || bodyToken || null;
}

function extractSessionUserId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.id != null && payload.id !== '') return payload.id;
  return null;
}

async function isCashflowSessionActive(jti, userId, queryFn) {
  if (!jti || userId == null) return false;
  const rows = await queryFn(
    'SELECT id FROM user_sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL LIMIT 1',
    [jti, userId]
  );
  return !!(rows && rows.length);
}

function cashflowAuth(options = {}) {
  const injectedQuery = options.queryFn;
  return async function cashflowAuthMiddleware(req, res, next) {
    const secret = getCashflowJwtSecret();
    if (!secret) {
      return res.status(503).json({
        error: 'Cashflow JWT secret not configured',
        code: 'CASHFLOW_JWT_SECRET_MISSING',
        requestId: req.id,
      });
    }

    const token = extractCashflowToken(req);
    if (!token) {
      return res.status(401).json({
        error: 'Access denied, token missing',
        code: 'TOKEN_MISSING',
        requestId: req.id,
      });
    }

    let payload;
    try {
      payload = jwt.verify(token, secret);
    } catch (err) {
      return res.status(401).json({
        error: 'Invalid or expired token',
        code: 'TOKEN_INVALID',
        requestId: req.id,
      });
    }

    // Reject non-session tokens (password-setup temp JWT, satellite share links).
    if (payload.setup === true || payload.share) {
      return res.status(401).json({
        error: 'Token is not a user session token',
        code: 'TOKEN_WRONG_KIND',
        requestId: req.id,
      });
    }

    const userId = extractSessionUserId(payload);
    if (userId == null) {
      return res.status(401).json({
        error: 'Token is missing user id',
        code: 'TOKEN_NO_ID',
        requestId: req.id,
      });
    }

    if (payload.jti) {
      try {
        const queryFn = injectedQuery || require('../services/db').query;
        const active = await isCashflowSessionActive(payload.jti, userId, queryFn);
        if (!active) {
          return res.status(401).json({
            error: 'Session revoked or expired. Please log in again.',
            code: 'SESSION_REVOKED',
            requestId: req.id,
          });
        }
      } catch (e) {
        // Fail-soft: agent DB may not expose user_sessions. Documented as deferred
        // hard-fail in KEA_ARCHITECTURE.md. Signature check still applies.
        console.warn('cashflowAuth jti check failed (fail-soft):', e.message);
      }
    }

    req.cashflowUser = {
      id: userId,
      username: payload.username,
      jti: payload.jti || null,
    };
    req.cashflowToken = token;
    next();
  };
}

module.exports = {
  cashflowAuth,
  extractCashflowToken,
  extractSessionUserId,
  getCashflowJwtSecret,
  isCashflowSessionActive,
};
