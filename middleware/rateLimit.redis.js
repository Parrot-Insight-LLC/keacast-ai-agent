const { RateLimiterRedis } = require('rate-limiter-flexible');
const redis = require('../services/redisService'); // your existing ioredis client

const limiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rlflx',
  points: 120,          // points per duration
  duration: 1,         // per 60s
  inmemoryBlockOnConsumed: 0
});

const strictLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rlflx_strict',
  points: 30,           // stricter for /chat + /summarize
  duration: 1
});

function wrapLimiter(instance) {
  return async (req, res, next) => {
    try {
      const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
      await instance.consume(key, 1);
      next();
    } catch (rej) {
      if (rej && typeof rej.msBeforeNext === 'number') {
        res.set('Retry-After', String(Math.ceil(rej.msBeforeNext / 1000)));
        return res.status(429).json({ error: 'Too many requests' });
      }
      console.warn('Rate limiter store failed:', rej && rej.message);
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  };
}

module.exports = {
  globalLimiter: wrapLimiter(limiter),
  sensitiveLimiter: wrapLimiter(strictLimiter)
};
