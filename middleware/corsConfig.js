'use strict';

const LOCAL_ANGULAR_ORIGIN = 'http://localhost:4200';

const CORS_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Requested-With',
  'X-Request-Id',
  'X-Auth-Token',
];

function parseAllowedOrigins(envValue = process.env.ALLOWED_ORIGINS) {
  return String(envValue || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveCorsOrigins({
  nodeEnv = process.env.NODE_ENV,
  allowedOriginsEnv = process.env.ALLOWED_ORIGINS,
} = {}) {
  const fromEnv = parseAllowedOrigins(allowedOriginsEnv);
  if (nodeEnv !== 'production') {
    return true;
  }
  const origins = [...fromEnv];
  if (!origins.includes(LOCAL_ANGULAR_ORIGIN)) {
    origins.push(LOCAL_ANGULAR_ORIGIN);
  }
  return origins;
}

function buildCorsOptions(env = {}) {
  return {
    origin: resolveCorsOrigins(env),
    credentials: true,
    methods: CORS_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    optionsSuccessStatus: 204,
  };
}

module.exports = {
  LOCAL_ANGULAR_ORIGIN,
  CORS_METHODS,
  CORS_ALLOWED_HEADERS,
  parseAllowedOrigins,
  resolveCorsOrigins,
  buildCorsOptions,
};
