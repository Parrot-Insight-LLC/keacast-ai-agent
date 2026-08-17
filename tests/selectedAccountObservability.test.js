'use strict';

const { check, section } = require('./harness');
const { cashflowHttpTimeoutMs } = require('../services/keaRequestBudget');
const { buildSelectedAccountAxiosConfig } = require('../tools/keacast_tool_layer');
const logging = require('../middleware/logging');
const { identityFromCashflowAuth } = require('../services/keaTelemetry');
const { __testables: T } = require('../controllers/openaiController');

async function run() {
  section('selected-account request-id propagation');

  const withId = buildSelectedAccountAxiosConfig({
    token: 'jwt-token',
    timeoutMs: 25000,
    requestId: 'kea-browser-req-1',
  });
  check('forwards X-Request-Id', withId.headers['X-Request-Id'] === 'kea-browser-req-1');
  check('keeps Authorization', withId.headers.Authorization === 'Bearer jwt-token');
  check('keeps timeout', withId.timeout === 25000);
  check('does not set extra axios keys', Object.keys(withId).sort().join(',') === 'headers,timeout');

  const noId = buildSelectedAccountAxiosConfig({
    token: 'jwt-token',
    timeoutMs: 25000,
  });
  check('omits X-Request-Id when requestId absent', noId.headers['X-Request-Id'] === undefined);
  check('auth-only headers unchanged without requestId', Object.keys(noId.headers).join(',') === 'Authorization');

  const blank = buildSelectedAccountAxiosConfig({
    token: 'jwt-token',
    requestId: '   ',
  });
  check('blank requestId does not attach header', blank.headers['X-Request-Id'] === undefined);
  check('blank requestId still applies HTTP timeout', blank.timeout === cashflowHttpTimeoutMs());

  section('pino customProps no longer emit anon identity');
  const propsEarly = logging.buildPinoCustomProps({ id: 'req-1', body: { sessionId: 7 } });
  check('customProps has requestId', propsEarly.requestId === 'req-1');
  check('customProps has no userId', propsEarly.userId === undefined);
  check('customProps has no sessionId', propsEarly.sessionId === undefined);
  check('customProps has no authenticated guess before auth', propsEarly.authenticated === undefined);

  const propsAfterAuth = logging.buildPinoCustomProps({
    id: 'req-2',
    cashflowUser: { id: 7 },
    body: { sessionId: 7 },
  });
  check('customProps still does not log raw user id after auth', propsAfterAuth.userId === undefined && propsAfterAuth.sessionId === undefined);

  section('Redis session key still uses trusted cashflow identity');
  check(
    'buildSessionKey prefers cashflowUser.id',
    T.buildSessionKey({ cashflowUser: { id: 7 }, body: { sessionId: 99 }, query: {}, headers: {} }) === 'session:7'
  );
  check(
    'authenticated chat is not session:anonymous',
    T.buildSessionKey({ cashflowUser: { id: 7 }, body: {}, query: {}, headers: {} }) !== 'session:anonymous'
  );
  check(
    'identityFromCashflowAuth does not use body.sessionId as userKey material',
    identityFromCashflowAuth({ cashflowUser: { id: 7 }, body: { sessionId: 99 } }).userKey
      === identityFromCashflowAuth({ cashflowUser: { id: 7 } }).userKey
  );
}

module.exports = { run };
