'use strict';

const { check, section } = require('./harness');
const {
  resolveKeaSelectedAccount,
  isAuthoritativeKeaCompact,
  SELECTED_ACCOUNT_TOOL_TTL,
} = require('../services/keaSelectedAccountResolve');
const { selectedAccountToolCacheKey } = require('../services/keaAccountCache');
const { getKeaAccountContext, buildSelectedAccountAxiosConfig } = require('../tools/keacast_tool_layer');
const axios = require('axios');

function compactV1() {
  return {
    _keaCompact: true,
    schemaVersion: 1,
    accountid: 22,
    balance: 1500,
    available: 1400,
  };
}

function mockRedis({ getValue = null } = {}) {
  const sets = [];
  return {
    ping: async () => 'PONG',
    get: async () => getValue,
    set: async (key, val, ex, ttl) => {
      sets.push({ key, val, ex, ttl });
      return 'OK';
    },
    _sets: sets,
  };
}

async function run() {
  section('kea compact contract helpers');
  check('TTL remains 300', SELECTED_ACCOUNT_TOOL_TTL === 300);
  check('authoritative compact v1', isAuthoritativeKeaCompact(compactV1()) === true);
  check('compact without version is not authoritative', isAuthoritativeKeaCompact({ _keaCompact: true }) === false);
  check('full blob is not authoritative', isAuthoritativeKeaCompact({ accountid: 22, cfTransactions: [] }) === false);

  section('cache hit → no Cashflow request');
  {
    let fetches = 0;
    const redis = mockRedis({ getValue: JSON.stringify(compactV1()) });
    const resolved = await resolveKeaSelectedAccount({
      userId: 7,
      accountId: 22,
      token: 'jwt',
      currentDate: '2026-08-15',
      requestId: 'req-hit',
      redis,
      fetchKeaContext: async () => {
        fetches += 1;
        throw new Error('should not fetch on hit');
      },
    });
    check('hit source tool-cache', resolved.source === 'tool-cache');
    check('hit cacheHit true', resolved.cacheHit === true);
    check('hit uses cached object', resolved.selectedAccount.accountid === 22);
    check('hit does not HTTP', fetches === 0);
    check('hit does not rewrite Redis', redis._sets.length === 0);
    check('hit full_payload_bytes null', resolved.fullPayloadBytes === null);
  }

  section('cache miss → kea-context exactly once, cached as-is');
  {
    const httpCalls = [];
    const redis = mockRedis({ getValue: null });
    const payload = compactV1();
    const resolved = await resolveKeaSelectedAccount({
      userId: 7,
      accountId: 22,
      token: 'jwt',
      currentDate: '2026-08-15',
      requestId: 'req-miss',
      redis,
      fetchKeaContext: async (opts) => {
        httpCalls.push(opts);
        return payload;
      },
    });
    check('miss source tool-fresh', resolved.source === 'tool-fresh');
    check('miss cacheHit false', resolved.cacheHit === false);
    check('fetched once', httpCalls.length === 1);
    check('requestId forwarded to fetch', httpCalls[0].requestId === 'req-miss');
    check('clientDate forwarded', httpCalls[0].body.clientDate === '2026-08-15');
    check('cached object is the HTTP payload', resolved.selectedAccount === payload);
    check('Redis SET once', redis._sets.length === 1);
    check('Redis SET uses EX 300', redis._sets[0].ex === 'EX' && redis._sets[0].ttl === 300);
    check(
      'Redis key family unchanged',
      redis._sets[0].key === selectedAccountToolCacheKey(7, 22)
    );
    check('cached JSON is the compact contract', JSON.parse(redis._sets[0].val).schemaVersion === 1);
    check('miss full_payload_bytes null', resolved.fullPayloadBytes === null);
    check('miss histogram absent', resolved.payloadKeyBytes === null);
  }

  section('invalid compact contract fails clearly');
  {
    const redis = mockRedis({ getValue: null });
    const resolved = await resolveKeaSelectedAccount({
      userId: 7,
      accountId: 22,
      token: 'jwt',
      currentDate: '2026-08-15',
      redis,
      fetchKeaContext: async () => ({ accountid: 22, cfTransactions: [1] }),
    });
    check('invalid schema sets error', !!resolved.error);
    check('does not accept full blob', resolved.selectedAccount === null);
    check('does not cache invalid payload', redis._sets.length === 0);
  }

  section('fetch failure fails clearly with no selected fallback');
  {
    const redis = mockRedis({ getValue: null });
    const resolved = await resolveKeaSelectedAccount({
      userId: 7,
      accountId: 22,
      token: 'jwt',
      currentDate: '2026-08-15',
      redis,
      fetchKeaContext: async () => {
        const err = new Error('connect timeout');
        err.response = { status: 504 };
        throw err;
      },
    });
    check('error present', !!resolved.error);
    check('no account after failure', resolved.selectedAccount === null);
    check('no Redis write after failure', redis._sets.length === 0);
  }

  section('legacy full Redis value is adapted, not used as-is');
  {
    const redis = mockRedis({
      getValue: JSON.stringify({
        accountid: 22,
        balance: 10,
        available: 9,
        cfTransactions: [{ title: 'x', amount: -1 }],
        access_token: 'secret',
      }),
    });
    let fetches = 0;
    const resolved = await resolveKeaSelectedAccount({
      userId: 7,
      accountId: 22,
      token: 'jwt',
      currentDate: '2026-08-15',
      requestId: 'req-legacy',
      redis,
      fetchKeaContext: async () => {
        fetches += 1;
        return compactV1();
      },
    });
    check('legacy rewrite is cache hit', resolved.cacheHit === true);
    check('legacy rewrite does not HTTP', fetches === 0);
    check('legacy rewrite is compact v1', resolved.selectedAccount._keaCompact === true && resolved.selectedAccount.schemaVersion === 1);
    check('legacy rewrite drops access_token', resolved.selectedAccount.access_token === undefined);
    check('legacy rewrite drops cfTransactions', resolved.selectedAccount.cfTransactions === undefined);
    check('legacy rewrite caches compact', redis._sets.length === 1);
    check('legacy rewrite histogram off by default', resolved.payloadKeyBytes === null);
  }

  section('getKeaAccountContext URL and requestId');
  {
    const cfg = buildSelectedAccountAxiosConfig({
      token: 'jwt-token',
      timeoutMs: 25000,
      requestId: 'kea-browser-req-1',
    });
    check('kea-context axios config forwards X-Request-Id', cfg.headers['X-Request-Id'] === 'kea-browser-req-1');

    const origPost = axios.post;
    let captured = null;
    axios.post = async (url, body, config) => {
      captured = { url, body, config };
      return { data: compactV1() };
    };
    try {
      await getKeaAccountContext({
        accountId: 22,
        token: 'jwt-token',
        body: { clientDate: '2026-08-15', userId: 99 },
        timeoutMs: 25000,
        requestId: 'rid-1',
      });
      check('posts kea-context path', /\/account\/kea-context\/22$/.test(captured.url));
      check('does not call /account/selected', captured.url.includes('/account/selected') === false);
      check('path has no userid segment before accid', captured.url.includes('/kea-context/99') === false);
      check('forwards requestId header', captured.config.headers['X-Request-Id'] === 'rid-1');
      check('body still sent (userId ignored by Cashflow)', captured.body.clientDate === '2026-08-15');
    } finally {
      axios.post = origPost;
    }
  }
}

module.exports = { run };
