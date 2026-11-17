'use strict';

const { id, authorizeAccount } = require('../services/legacyReadAuthorization');

function reject(res, status, code, requestId) {
  return res.status(status).json({ error: status === 503 ? 'Authorization temporarily unavailable' : 'Resource not accessible', code, requestId });
}

function requireSelfUser(req, res, next) {
  const actor = id(req.cashflowUser?.id);
  if (!actor || id(req.params.userId) !== actor) return reject(res, 403, 'LEGACY_ACCESS_DENIED', req.id);
  next();
}

function requireLegacyAccount(operation, options = {}) {
  return async (req, res, next) => {
    try {
      const actor = id(req.cashflowUser?.id);
      const context = await authorizeAccount(actor, req.params.accountId, operation, options);
      if (req.params.userId !== undefined) {
        const selector = id(req.params.userId);
        if (!selector || (selector !== actor && selector !== id(context.account.userid))) {
          return reject(res, 403, 'LEGACY_ACCESS_DENIED', req.id);
        }
      }
      req.legacyReadContext = context;
      next();
    } catch (error) {
      if (error.code === 'LEGACY_ACCESS_DENIED') return reject(res, 403, error.code, req.id);
      return reject(res, 503, 'LEGACY_AUTHORIZATION_UNAVAILABLE', req.id);
    }
  };
}

function requireSelfHistory(req, res, next) {
  const actor = id(req.cashflowUser?.id);
  if (!actor) return reject(res, 403, 'LEGACY_ACCESS_DENIED', req.id);
  const selectors = [];
  for (const source of [req.body, req.query, req.params]) {
    for (const key of ['sessionId', 'userId', 'userid', 'user_id']) {
      if (source && Object.prototype.hasOwnProperty.call(source, key)) selectors.push(source[key]);
    }
  }
  for (const key of ['x-user-id', 'x-session-id']) {
    if (req.headers && Object.prototype.hasOwnProperty.call(req.headers, key)) selectors.push(req.headers[key]);
  }
  if (selectors.some(value => id(value) !== actor)) return reject(res, 403, 'LEGACY_ACCESS_DENIED', req.id);
  next();
}

module.exports = { requireSelfUser, requireLegacyAccount, requireSelfHistory };
