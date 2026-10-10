'use strict';

const LOCAL_ANGULAR_ORIGIN = 'http://localhost:4200';

/** Capacitor WebView origins for com.parrotinsight.keacast (not the PWA). */
const CAPACITOR_WEBVIEW_ORIGINS = Object.freeze([
  'https://localhost',
  'capacitor://localhost',
  'ionic://localhost',
]);

const CORS_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Requested-With',
  'X-Request-Id',
  'X-Auth-Token',
  'X-Keacast-Client',
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
  CAPACITOR_WEBVIEW_ORIGINS.forEach((origin) => {
    if (!origins.includes(origin)) origins.push(origin);
  });
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
  CAPACITOR_WEBVIEW_ORIGINS,
  CORS_METHODS,
  CORS_ALLOWED_HEADERS,
  parseAllowedOrigins,
  resolveCorsOrigins,
  buildCorsOptions,
};
