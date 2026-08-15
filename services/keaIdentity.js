'use strict';

const IDENTITY_STRIP_KEYS = ['token', 'userId', 'authorization', 'authHeader', 'access_token'];

/**
 * Strip model-controlled identity fields and default accountId from trusted ctx.
 * Does not put userId/token back onto args — callers must use ctx for those.
 */
function injectTrustedIdentity(args, ctx) {
  const out = args && typeof args === 'object' ? { ...args } : {};
  for (const key of IDENTITY_STRIP_KEYS) {
    delete out[key];
  }
  if ((out.accountId == null || out.accountId === '') && ctx && ctx.accountId != null && ctx.accountId !== '') {
    out.accountId = ctx.accountId;
  }
  return out;
}

module.exports = { injectTrustedIdentity, IDENTITY_STRIP_KEYS };
