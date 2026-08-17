'use strict';

const jwt = require('jsonwebtoken');
const { check, section } = require('./harness');
const { cashflowAuth, extractSessionUserId, getCashflowJwtSecret } = require('../middleware/cashflowAuth');

const SECRET = 'phase0-cashflow-test-secret';

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

function mockReq(overrides = {}) {
  return {
    id: 'req-1',
    headers: {},
    body: {},
    ...overrides,
  };
}

function nextFlag() {
  const state = { called: false };
  return { state, next: () => { state.called = true; } };
}

async function run() {
  const prev = process.env.CASHFLOW_JWT_SECRET;
  process.env.CASHFLOW_JWT_SECRET = SECRET;
  section('cashflowAuth');

  check('secret prefers CASHFLOW_JWT_SECRET', getCashflowJwtSecret() === SECRET);
  check('extractSessionUserId uses `id` not userid', extractSessionUserId({ id: 42, userid: 99 }) === 42);
  check('extractSessionUserId ignores userid-only payload', extractSessionUserId({ userid: 99 }) === null);

  const mw = cashflowAuth({ queryFn: async () => [{ id: 'jti-1' }] });

  {
    const req = mockReq();
    const res = mockRes();
    const { state, next } = nextFlag();
    await mw(req, res, next);
    check('missing token → 401 TOKEN_MISSING', res.statusCode === 401 && res.body?.code === 'TOKEN_MISSING' && !state.called);
  }

  {
    const token = jwt.sign({ username: 'a', id: 7, jti: 'jti-1' }, SECRET, { expiresIn: '1h' });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const { state, next } = nextFlag();
    await mw(req, res, next);
    check('valid session JWT sets cashflowUser.id from `id`', state.called && req.cashflowUser?.id === 7 && req.cashflowToken === token);
  }

  {
    const token = jwt.sign({ username: 'a', id: 7 }, 'wrong-secret', { expiresIn: '1h' });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const { state, next } = nextFlag();
    await mw(req, res, next);
    check('forged JWT (wrong secret) → 401 TOKEN_INVALID', res.statusCode === 401 && res.body?.code === 'TOKEN_INVALID' && !state.called);
  }

  {
    const token = jwt.sign({ username: 'a', id: 7, jti: 'revoked' }, SECRET, { expiresIn: '1h' });
    const denyMw = cashflowAuth({ queryFn: async () => [] });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const { state, next } = nextFlag();
    await denyMw(req, res, next);
    check('revoked jti → 401 SESSION_REVOKED', res.statusCode === 401 && res.body?.code === 'SESSION_REVOKED' && !state.called);
  }

  {
    const token = jwt.sign({ setup: true, id: 7 }, SECRET, { expiresIn: '10m' });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const { state, next } = nextFlag();
    await mw(req, res, next);
    check('setup token rejected', res.statusCode === 401 && res.body?.code === 'TOKEN_WRONG_KIND' && !state.called);
  }

  {
    const token = jwt.sign({ share: 'sharelink' }, SECRET, { expiresIn: '1h' });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const { state, next } = nextFlag();
    await mw(req, res, next);
    check('sharelink token rejected', res.statusCode === 401 && !state.called);
  }

  {
    const token = jwt.sign({ username: 'a', id: 7 }, SECRET, { expiresIn: '1h' });
    const req = mockReq({ body: { token, sessionId: 999 } });
    const res = mockRes();
    const { state, next } = nextFlag();
    await mw(req, res, next);
    check('body.token accepted; sessionId does not set identity', state.called && req.cashflowUser?.id === 7);
  }

  {
    const mw = cashflowAuth({ queryFn: async () => [] });
    const req = mockReq({ method: 'OPTIONS' });
    const res = mockRes();
    const { state, next } = nextFlag();
    await mw(req, res, next);
    check('OPTIONS skips JWT verification', state.called && res.statusCode === 200);
  }

  {
    const token = jwt.sign({ username: 'a', id: 7, jti: 'jti-hang' }, SECRET, { expiresIn: '1h' });
    const hungMw = cashflowAuth({
      queryFn: () => new Promise(() => {}),
      dbTimeoutMs: 40,
    });
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } });
    const res = mockRes();
    const { state, next } = nextFlag();
    const started = Date.now();
    await hungMw(req, res, next);
    const elapsed = Date.now() - started;
    check('hung user_sessions lookup is bounded', elapsed < 500);
    check('auth db timeout keeps JWT fail-soft', state.called && req.cashflowUser?.id === 7);
  }

  if (prev === undefined) delete process.env.CASHFLOW_JWT_SECRET;
  else process.env.CASHFLOW_JWT_SECRET = prev;
}

module.exports = { run };
