'use strict';
const morgan = require('morgan');
const { safeLogPath } = require('./logSafeUrl');

function createAccessLogger({ nodeEnv = process.env.NODE_ENV, stream } = {}) {
  const configured = morgan[nodeEnv === 'production' ? 'combined' : 'dev'];
  const format = typeof configured === 'function' ? configured : morgan.compile(configured);
  return morgan((tokens, req, res) => {
    const safeTokens = Object.create(tokens);
    safeTokens.url = () => safeLogPath(req.originalUrl || req.url);
    // Combined has a second URL carrier: Referer/Referrer.
    safeTokens.referrer = () => safeLogPath(req.headers.referer || req.headers.referrer);
    return format(safeTokens, req, res);
  }, stream ? { stream } : {});
}

module.exports = { createAccessLogger };
