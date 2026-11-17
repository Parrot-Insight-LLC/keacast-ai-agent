'use strict';

// Serialization only: do not alter URLs used by routing or authorization.
// Queries, fragments, origin and URL userinfo are never useful in request logs.
function safeLogPath(value) {
  if (typeof value !== 'string' || !value) return '-';
  try {
    const url = new URL(value, 'http://request.invalid');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '[invalid-url]';
    return url.pathname.replace(/[\u0000-\u001f\u007f]/g, '');
  } catch (_) {
    return '[invalid-url]';
  }
}

module.exports = { safeLogPath };
