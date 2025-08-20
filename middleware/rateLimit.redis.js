const { RateLimiterRedis } = require('rate-limiter-flexible');
const redis = require('../services/redisService'); // your existing ioredis client

const limiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rlflx',
  points: 120,          // points per duration
  duration: 30,         // per 60s
  inmemoryBlockOnConsumed: 0
});

const strictLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rlflx_strict',
  points: 30,           // stricter for /chat + /summarize
  duration: 30
});

function wrapLimiter(instance) {
  return async (req, res, next) => {
    try {
      const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
      await instance.consume(key, 1);
      next();
    } catch (rej) {
      res.set('Retry-After', String(Math.ceil(rej.msBeforeNext / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }
  };
}

module.exports = {
  globalLimiter: wrapLimiter(limiter),
  sensitiveLimiter: wrapLimiter(strictLimiter)
};
