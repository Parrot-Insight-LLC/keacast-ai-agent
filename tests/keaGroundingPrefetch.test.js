'use strict';

const { check, section } = require('./harness');
const { AccountAccessError } = require('../services/keaAccountAccess');
const { routeCapability } = require('../services/keaCapabilityRouter');
const { resolveGroundingPolicy, isFailSoft, FAIL_SOFT_TEXT } = require('../services/keaGroundingPolicy');
const {
  prefetchGrounding,
  authorizedPrefetchRead,
  fetchCompletePeriodTransactions,
  aggregateTransactions,
  buildEvidenceSystemSection,
} = require('../services/keaGroundingPrefetch');

const SNAPSHOT = {
  _keaCompact: true,
  schemaVersion: 1,
  accountid: 10,
  balance: 1200,
  available: 1100,
  credit_limit: 0,
  dataAsOf: '2026-08-16T12:00:00.000Z',
  savings: {
    totalIncome: 4000,
    totalExpenses: 2500,
    netCashFlow: 1500,
    savingsPotential: 900,
  },
  upcomingExpenseTotal: 200,
  upcomingIncomeTotal: 0,
  futureNegativeBalances: [{ amount: -40, date: '2026-09-12', daysUntil: 27 }],
  recents: [{ name: 'Costco', amount: -80, date: '2026-08-10' }],
  upcoming: [{ name: 'Rent', amount: -1400, start: '2026-09-01', forecast_type: 'F' }],
  goals: [{ goalid: 1, title: 'Emergency', target_amount: 5000, accumulated_amount: 1000 }],
};

function paginatedFetch(allRows, pageSize = 50) {
  const calls = [];
  const fetchPage = async ({ userId, accountId, page, limit, startDate, endDate }) => {
    calls.push({ userId, accountId, page, limit, startDate, endDate });
    const size = limit || pageSize;
    const start = (page - 1) * size;
    return {
      transactions: allRows.slice(start, start + size),
      pagination: {
        page,
        limit: size,
        total: allRows.length,
        pages: Math.ceil(allRows.length / size),
        hasNext: page * size < allRows.length,
      },
    };
  };
  return { fetchPage, calls };
}

async function run() {
  section('snapshot grounding — no extra read');

  const balanceRoute = routeCapability({
    message: "What's my balance?",
    currentDate: '2026-08-16',
    accountId: '10',
  });
  const balancePolicy = resolveGroundingPolicy(balanceRoute, { message: "What's my balance?" });
  const { fetchPage: unusedFetch, calls: unusedCalls } = paginatedFetch([]);
  const balanceEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: balancePolicy,
    route: balanceRoute,
    fetchPage: unusedFetch,
    assertFn: async () => ({ access: 'owner' }),
  });
  check('balance evidence from snapshot', balanceEv.source.includes('kea_snapshot'));
  check('balance fact present', balanceEv.facts.balance === 1200);
  check('balance did not call transaction read', unusedCalls.length === 0);
  check('upcoming window labeled 15 days', balanceEv.facts.upcomingWindowDays === 15);
  check('balance status ok', balanceEv.status === 'ok');

  const negRoute = routeCapability({
    message: 'Will I go negative next month?',
    currentDate: '2026-08-16',
    accountId: '10',
  });
  const negEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(negRoute, { message: 'Will I go negative next month?' }),
    route: negRoute,
    fetchPage: unusedFetch,
  });
  check('forecast uses snapshot', negEv.source.includes('kea_snapshot') && !negEv.source.includes('user_transactions'));
  check('forecast did not call getUserTransactions', unusedCalls.length === 0);
  check('negative in next month detected', negEv.facts.hasNegativeInRequestedPeriod === true);
  check('limitations mention 15-day window', (negEv.limitations || []).includes('upcoming_window_15d'));

  const affordRoute = routeCapability({
    message: 'Can I afford $800 next month?',
    currentDate: '2026-08-16',
    accountId: '10',
  });
  const affordEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(affordRoute, { message: 'Can I afford $800 next month?' }),
    route: affordRoute,
    fetchPage: unusedFetch,
  });
  check('affordability is partial (no assessAffordability)', affordEv.status === 'partial');
  check('affordability includes requestedAmount', affordEv.facts.requestedAmount === 800);
  check('affordability limitation not_calculated', (affordEv.limitations || []).includes('affordability_not_calculated'));
  check('affordability has savingsPotential not a new formula', affordEv.facts.savingsPotential === 900);
  check('affordability facts have no affordabilityScore', affordEv.facts.affordabilityScore === undefined);

  section('historical lookup prefetch — complete period');

  const walmartRows = [];
  for (let i = 0; i < 120; i += 1) {
    walmartRows.push({
      name: i % 3 === 0 ? 'Walmart' : 'Other Store',
      merchant_name: i % 3 === 0 ? 'Walmart Supercenter' : 'Other',
      amount: i % 3 === 0 ? -10 : -5,
      start: '2026-07-15',
    });
  }
  const { fetchPage, calls } = paginatedFetch(walmartRows, 50);
  const walmartRoute = routeCapability({
    message: 'How much did I spend at Walmart last month?',
    currentDate: '2026-08-16',
    accountId: '10',
  });
  let assertCalled = false;
  const walmartEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(walmartRoute, { message: 'How much did I spend at Walmart last month?' }),
    route: walmartRoute,
    fetchPage,
    pageLimit: 50,
    assertFn: async (userId, accountId) => {
      assertCalled = true;
      check('assert uses trusted user 5', userId === 5);
      check('assert uses selected account 10', accountId === 10);
      return { access: 'owner' };
    },
  });
  check('owner prefetch allowed', walmartEv.status === 'ok');
  check('assertAccountAccess ran before read', assertCalled === true);
  check('paged past default 50-row page', calls.length >= 3);
  check('complete period not first-page-only', walmartEv.facts.transactionCount === 40);
  check('walmart expense total 400', walmartEv.facts.expenseTotal === 400);
  check('does not dump transactions into facts', walmartEv.facts.transactions === undefined);
  check('fetch used trusted userId', calls.every((c) => c.userId === 5));

  const oversize = new Array(1201).fill(0).map(() => ({ name: 'Walmart', amount: -1, start: '2026-07-01' }));
  const { fetchPage: bigFetch, calls: bigCalls } = paginatedFetch(oversize, 50);
  const bigEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(walmartRoute, { message: 'How much did I spend at Walmart last month?' }),
    route: walmartRoute,
    fetchPage: bigFetch,
    assertFn: async () => ({ access: 'owner' }),
  });
  check('oversize period is unavailable not a false total', bigEv.status === 'unavailable');
  check('oversize does not publish expenseTotal', bigEv.facts.expenseTotal === undefined);
  check('oversize stopped after first page total', bigCalls.length === 1);

  section('authorized prefetch — owner / satellite / denied / identity');

  {
    const result = await authorizedPrefetchRead({
      trustedUserId: 5,
      accountId: 10,
      assertFn: async () => ({ access: 'owner' }),
      readFn: async () => 'ok-owner',
    });
    check('owner authorized read returns', result === 'ok-owner');
  }
  {
    const result = await authorizedPrefetchRead({
      trustedUserId: 9,
      accountId: 10,
      assertFn: async (userId) => {
        if (userId !== 9) throw new AccountAccessError('ACCESS_DENIED', 'no');
        return { access: 'satellite' };
      },
      readFn: async () => 'ok-sat',
    });
    check('satellite authorized read returns', result === 'ok-sat');
  }
  {
    let readRan = false;
    try {
      await authorizedPrefetchRead({
        trustedUserId: 9,
        accountId: 10,
        assertFn: async () => { throw new AccountAccessError('ACCESS_DENIED', 'no'); },
        readFn: async () => { readRan = true; return 'leak'; },
      });
      check('unauthorized throws', false);
    } catch (e) {
      check('unauthorized denied before read', e.code === 'ACCESS_DENIED' && readRan === false);
    }
  }
  {
    let readRan = false;
    try {
      await authorizedPrefetchRead({
        trustedUserId: null,
        accountId: 10,
        assertFn: async () => ({ access: 'owner' }),
        readFn: async () => { readRan = true; return 'leak'; },
      });
      check('missing trusted user throws', false);
    } catch (e) {
      check('missing trusted user denied before read', e.code === 'ACCESS_DENIED' && readRan === false);
    }
  }

  const { fetchPage: idFetch, calls: idCalls } = paginatedFetch([
    { name: 'Walmart', amount: -20, start: '2026-07-02' },
  ], 50);
  await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(walmartRoute, { message: 'How much did I spend at Walmart last month?' }),
    route: walmartRoute,
    fetchPage: idFetch,
    assertFn: async (userId) => {
      check('body/model userId cannot replace trusted id', userId === 5);
      return { access: 'owner' };
    },
    userId: 99,
    bodyUserId: 99,
    sessionId: 'forged',
  });
  check('prefetch read identity is trusted user 5', idCalls[0] && idCalls[0].userId === 5);
  check('prefetch ignored body userId 99', idCalls.every((c) => c.userId !== 99));

  const deniedEv = await prefetchGrounding({
    trustedUserId: 9,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(walmartRoute, { message: 'How much did I spend at Walmart last month?' }),
    route: walmartRoute,
    fetchPage: async () => { throw new Error('read must not run'); },
    assertFn: async () => { throw new AccountAccessError('ACCESS_DENIED', 'no'); },
  });
  check('denied prefetch is unavailable', deniedEv.status === 'unavailable');
  check('denied is fail-soft', isFailSoft(resolveGroundingPolicy(walmartRoute, { message: 'How much did I spend at Walmart last month?' }), deniedEv) === true);

  section('snapshot grounding failure / evidence contract');

  const missingSnap = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: null,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(negRoute, { message: 'Will I go negative next month?' }),
    route: negRoute,
  });
  check('missing snapshot is unavailable', missingSnap.status === 'unavailable');
  const failBlock = buildEvidenceSystemSection(missingSnap);
  check('fail-soft evidence instructs no invented dollars', /do not invent missing dollar values/i.test(failBlock));
  check('fail-soft canned text has no $ amounts', !/\$\s*\d/.test(FAIL_SOFT_TEXT));

  const okBlock = buildEvidenceSystemSection(balanceEv);
  check('evidence block labeled GROUNDED EVIDENCE', okBlock.startsWith('GROUNDED EVIDENCE'));
  check('evidence JSON has no account hash field', !/"accountKey"/.test(okBlock));

  section('complete-period helper');

  const rows = new Array(120).fill(0).map((_, i) => ({ amount: -1, name: 'x', start: '2026-07-01' }));
  const { fetchPage: paged, calls: pageCalls } = paginatedFetch(rows, 50);
  const complete = await fetchCompletePeriodTransactions({
    trustedUserId: 5,
    accountId: 10,
    startDate: '2026-07-01',
    endDate: '2026-07-31',
    fetchPage: paged,
    pageLimit: 50,
  });
  check('120 rows across default page size is complete', complete.complete === true && complete.transactions.length === 120);
  check('used more than one page', pageCalls.length === 3);
  const agg = aggregateTransactions(rows);
  check('aggregate expenseTotal is full period', agg.expenseTotal === 120);
}

module.exports = { run };
