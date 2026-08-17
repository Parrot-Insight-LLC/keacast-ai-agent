const Redis = require('ioredis');
const { redisCommandTimeoutMs } = require('./keaRequestBudget');

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
  commandTimeout: redisCommandTimeoutMs(),
});

module.exports = redis;
