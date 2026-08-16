'use strict';

const http = require('http');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { check, section } = require('./harness');
const requestId = require('../middleware/requestId');
const { cashflowAuth } = require('../middleware/cashflowAuth');
const { buildCorsOptions, LOCAL_ANGULAR_ORIGIN } = require('../middleware/corsConfig');

const SECRET = 'phase0-cors-preflight-secret';
const DISALLOWED_ORIGIN = 'https://evil.example';

function headerList(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function hasHeader(allowHeader, name) {
  return headerList(allowHeader).includes(String(name).toLowerCase());
}

function createChatApp() {
  const app = express();
  app.use(requestId);
  app.use(cors(buildCorsOptions({
    nodeEnv: 'production',
    allowedOriginsEnv: 'https://keacast.app',
  })));
  app.use(express.json());

  let chatHits = 0;
  app.post('/api/agent/chat', cashflowAuth({ queryFn: async () => [{ id: 'jti-1' }] }), (req, res) => {
    chatHits += 1;
    res.status(200).json({
      reached: 'chat',
      userId: req.cashflowUser && req.cashflowUser.id,
    });
  });

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  return {
    app,
    getChatHits: () => chatHits,
  };
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function request(server, { method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function run() {
  section('CORS preflight /api/agent/chat');

  const prevSecret = process.env.CASHFLOW_JWT_SECRET;
  process.env.CASHFLOW_JWT_SECRET = SECRET;

  const { app, getChatHits } = createChatApp();
  const server = await listen(app);

  try {
    const preflight = await request(server, {
      method: 'OPTIONS',
      path: '/api/agent/chat',
      headers: {
        Origin: LOCAL_ANGULAR_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type, x-request-id',
      },
    });

    check(
      'localhost preflight succeeds without JWT',
      (preflight.status === 204 || preflight.status === 200) && getChatHits() === 0
    );
    check(
      'preflight ACAO is http://localhost:4200',
      preflight.headers['access-control-allow-origin'] === LOCAL_ANGULAR_ORIGIN
    );
    check(
      'preflight Allow-Methods includes POST',
      hasHeader(preflight.headers['access-control-allow-methods'], 'POST')
    );
    check(
      'preflight permits Authorization',
      hasHeader(preflight.headers['access-control-allow-headers'], 'Authorization')
    );
    check(
      'preflight permits Content-Type',
      hasHeader(preflight.headers['access-control-allow-headers'], 'Content-Type')
    );
    check(
      'preflight permits X-Request-Id',
      hasHeader(preflight.headers['access-control-allow-headers'], 'X-Request-Id')
    );

    const unauth = await request(server, {
      method: 'POST',
      path: '/api/agent/chat',
      headers: {
        Origin: LOCAL_ANGULAR_ORIGIN,
        'Content-Type': 'application/json',
        'X-Request-Id': 'test-req-1',
      },
      body: { message: 'hello' },
    });
    const unauthBody = (() => { try { return JSON.parse(unauth.body); } catch { return {}; } })();
    check(
      'POST without JWT is rejected',
      unauth.status === 401 && unauthBody.code === 'TOKEN_MISSING' && getChatHits() === 0
    );
    check(
      'rejected POST still reflects localhost origin',
      unauth.headers['access-control-allow-origin'] === LOCAL_ANGULAR_ORIGIN
    );

    const token = jwt.sign({ username: 'a', id: 7, jti: 'jti-1' }, SECRET, { expiresIn: '1h' });
    const authed = await request(server, {
      method: 'POST',
      path: '/api/agent/chat',
      headers: {
        Origin: LOCAL_ANGULAR_ORIGIN,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Request-Id': 'test-req-2',
      },
      body: { message: 'hello' },
    });
    const authedBody = (() => { try { return JSON.parse(authed.body); } catch { return {}; } })();
    check(
      'POST with valid JWT reaches the chat route',
      authed.status === 200 && authedBody.reached === 'chat' && authedBody.userId === 7 && getChatHits() === 1
    );

    const denied = await request(server, {
      method: 'OPTIONS',
      path: '/api/agent/chat',
      headers: {
        Origin: DISALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type, x-request-id',
      },
    });
    check(
      'disallowed origin is not reflected in ACAO',
      denied.headers['access-control-allow-origin'] !== DISALLOWED_ORIGIN
      && !denied.headers['access-control-allow-origin']
    );
  } finally {
    await close(server);
    if (prevSecret === undefined) delete process.env.CASHFLOW_JWT_SECRET;
    else process.env.CASHFLOW_JWT_SECRET = prevSecret;
  }
}

module.exports = { run };
