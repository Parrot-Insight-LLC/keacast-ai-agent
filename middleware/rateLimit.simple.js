const rateLimit = require('express-rate-limit');

const globalLimiter = rateLimit({
  windowMs: 5 * 1000,        // 1 minute
  max: 120,                   // 120 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' }
});

const sensitiveLimiter = rateLimit({
  windowMs: 5 * 1000,
  max: 30,                    // stricter for LLM endpoints
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = { globalLimiter, sensitiveLimiter };
