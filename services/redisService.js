const Redis = require('ioredis');

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
});

module.exports = redis;
