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
  reconciledBalance: 1200,
  current: 1150,
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
  check('balance fact present', balanceEv.facts.reconciledBalance === 1200);
  check('availableBalance mapped', balanceEv.facts.availableBalance === 1100);
  check('currentBalance mapped', balanceEv.facts.currentBalance === 1150);
  check('no ambiguous facts.balance key', balanceEv.facts.balance === undefined);
  check('balance did not call transaction read', unusedCalls.length === 0);
  check('upcoming window labeled 15 days', balanceEv.facts.upcomingWindowDays === 15);
  check('balance status ok', balanceEv.status === 'ok');

  const negRoute = routeCapability({
    message: 'Will I go negative next month?',
    currentDate: '2026-08-16',
    accountId: '10',
  });
  let cashflowCalls = 0;
  const negEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(negRoute, { message: 'Will I go negative next month?' }),
    route: negRoute,
    token: 'jwt',
    fetchPage: unusedFetch,
    fetchCashflowAnalysis: async ({ accountId, body }) => {
      cashflowCalls += 1;
      check('analysis account is selected 10', String(accountId) === '10');
      check('analysis body has no userId', body.userId === undefined);
      return {
        status: 'ok',
        period: body.period,
        postedIncome: 0,
        postedSpending: 0,
        postedNet: 0,
        negativeBalanceRisk: {
          scope: { start: '2026-09-01', end: '2026-09-30', label: 'next_month' },
          horizonDays: 90,
          hasNegativeInScope: true,
          firstNegativeDate: '2026-09-12',
          firstNegativeAmount: -40,
        },
        observations: [{ code: 'forecast_goes_negative' }],
        limitations: [],
        dataAsOf: '2026-08-16T12:00:00.000Z',
      };
    },
  });
  check('negative-risk uses cashflow_analysis macro', negEv.source.includes('cashflow_analysis') && !negEv.source.includes('user_transactions'));
  check('negative-risk did not call getUserTransactions', unusedCalls.length === 0);
  check('negative-risk prefetched once', cashflowCalls === 1);
  check('negative-risk uses scoped flag', negEv.facts.negativeBalanceRisk.hasNegativeInScope === true);
  check('negative-risk status ok', negEv.status === 'ok');

  const affordRoute = routeCapability({
    message: 'Can I afford $800 next Friday?',
    currentDate: '2026-08-16',
    accountId: '10',
  });
  let affordCalls = 0;
  const affordEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(affordRoute, { message: 'Can I afford $800 next Friday?' }),
    route: affordRoute,
    token: 'jwt',
    fetchPage: unusedFetch,
    fetchAffordabilityAnalysis: async ({ accountId, body }) => {
      affordCalls += 1;
      check('afford account is selected 10', String(accountId) === '10');
      check('afford body has no userId', body.userId === undefined);
      check('afford amount 800', body.amount === 800);
      check('afford purchase date next Friday', body.purchaseDate === '2026-08-21');
      return {
        status: 'ok',
        assumption: 'one_time_expense',
        requested: { amount: 800, purchaseDate: '2026-08-21' },
        horizonDays: 90,
        baseline: { lowestAfterDate: 1100, firstNegativeDate: null },
        hypothetical: { lowestAfterDate: 300, firstNegativeDate: null },
        delta: {
          baselineAlreadyNegative: false,
          newNegativeIntroduced: false,
          negativeStartsEarlier: false,
          negativeWorsenedBy: 0,
          lowestBalanceBefore: 1100,
          lowestBalanceAfter: 300,
        },
        observations: [{ code: 'no_new_negative' }],
        limitations: ['available_unadjusted_no_provider_cache'],
        dataAsOf: '2026-08-16T12:00:00.000Z',
      };
    },
  });
  check('affordability status ok', affordEv.status === 'ok');
  check('affordability prefetched once', affordCalls === 1);
  check('affordability source', affordEv.source.includes('affordability_analysis'));
  check('affordability facts have no affordabilityScore', affordEv.facts.affordabilityScore === undefined);
  check('affordability keeps provider-cache limitation', (affordEv.limitations || []).includes('available_unadjusted_no_provider_cache'));
  check('affordability did not call transaction read', unusedCalls.length === 0);

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
    message: 'How much did I spend at Walmart last month?',
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
  check('walmart spentTotal is the same nonnegative magnitude', walmartEv.facts.spentTotal === 400
    && walmartEv.facts.spentTotal === walmartEv.facts.expenseTotal);
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
  check('oversize does not publish spentTotal', bigEv.facts.spentTotal === undefined);
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
  check('evidence glossary names availableBalance', /availableBalance = Keacast UI Available/.test(okBlock));
  check('evidence glossary says savingsPotential is not available', /not available money/.test(okBlock));
  check('evidence JSON has no account hash field', !/"accountKey"/.test(okBlock));
  check('evidence JSON omits prefetchMeta', !/"prefetchMeta"/.test(okBlock));
  check('evidence JSON omits facts.balance', !/"balance"\s*:/.test(okBlock.split('\n').find((l) => l.startsWith('{')) || ''));

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

  section('historical spend — posted actuals, duplicates, variants, month-end');

  const mixedRows = [
    { name: 'Walmart', amount: -10, start: '2026-07-02', forecast_type: 'A' },
    { name: 'Walmart', amount: -10, start: '2026-07-03', forecast_type: 'F' },
    { name: 'Walmart', amount: -10, start: '2026-07-04', forecast_type: 'RF' },
    { name: 'Walmart', amount: -10, start: '2026-07-05', forecast_type: 'A', duplicate: 1 },
    { name: 'WALMART', amount: -10, start: '2026-07-06' },
    { name: 'WAL-MART', amount: -10, start: '2026-07-07' },
    { name: 'Walmart #1234', amount: -10, start: '2026-07-08' },
    { merchant_name: 'WALMART.COM', amount: -10, start: '2026-07-09' },
    { title: 'Walmart Supercenter', amount: -10, start: '2026-07-10' },
    { name: 'Costco', amount: -99, start: '2026-07-11', category: 'Walmart', forecast_type: 'A' },
    { name: 'Walmart', amount: -10, start: '2026-07-31 18:45:00', forecast_type: 'A' },
  ];
  const { fetchPage: mixedFetch } = paginatedFetch(mixedRows, 100);
  const mixedEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(walmartRoute, { message: 'How much did I spend at Walmart last month?' }),
    route: walmartRoute,
    message: 'How much did I spend at Walmart last month?',
    fetchPage: mixedFetch,
    assertFn: async () => ({ access: 'owner' }),
  });
  check('F/RF Walmart forecasts excluded from spent', mixedEv.facts.expenseTotal === 70);
  check('posted Walmart actuals included', mixedEv.facts.transactionCount === 7);
  check('duplicate=1 excluded', mixedEv.facts.transactionCount === 7);
  check('category is not a merchant fallback', mixedEv.facts.expenseTotal !== 169);
  check('posted_actuals limitation', (mixedEv.limitations || []).includes('posted_actuals_only'));
  check('duplicates_excluded limitation', (mixedEv.limitations || []).includes('duplicates_excluded'));
  check('prefetchMeta page count', mixedEv.prefetchMeta.pageCount === 1);
  check('prefetchMeta match count is posted matches', mixedEv.prefetchMeta.matchCount === 7);

  const manyWalmart = new Array(60).fill(0).map((_, i) => ({
    name: 'Walmart',
    amount: -5,
    start: '2026-07-12',
    forecast_type: 'A',
  }));
  const { fetchPage: manyFetch, calls: manyCalls } = paginatedFetch(manyWalmart, 100);
  const manyEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(walmartRoute, { message: 'How much did I spend at Walmart last month?' }),
    route: walmartRoute,
    message: 'How much did I spend at Walmart last month?',
    fetchPage: manyFetch,
    pageLimit: 100,
    assertFn: async () => ({ access: 'owner' }),
  });
  check('>50 Walmart rows complete deterministic total', manyEv.status === 'ok' && manyEv.facts.expenseTotal === 300);
  check('>50 Walmart included all matches', manyEv.facts.transactionCount === 60);
  check('page size 100 used', manyCalls[0] && manyCalls[0].limit === 100);

  const { halfOpenRange } = require('../services/transactions.service');
  const july = halfOpenRange('2026-07-01', '2026-07-31');
  check('half-open end is day after period end', july.start === '2026-07-01' && july.endExclusive === '2026-08-01');
  const monthEndRow = '2026-07-31 18:45:00';
  const inclusiveEndWouldDrop = monthEndRow <= '2026-07-31';
  const halfOpenKeeps = monthEndRow >= july.start && monthEndRow < july.endExclusive;
  check('inclusive YYYY-MM-DD end would drop month-end DATETIME', inclusiveEndWouldDrop === false);
  check('half-open range keeps month-end DATETIME', halfOpenKeeps === true);

  section('Phase 1.3 — positive spending magnitude');

  const mag = aggregateTransactions([
    { name: 'Walmart', amount: -100, start: '2026-07-01', forecast_type: 'A' },
    { name: 'Walmart', amount: -50, start: '2026-07-02', forecast_type: 'A' },
    { name: 'Walmart', amount: -20, start: '2026-07-03', forecast_type: 'A' },
  ]);
  check('spentTotal is 170 not -170', mag.spentTotal === 170 && mag.expenseTotal === 170);
  check('spentTotal is not negative', mag.spentTotal >= 0);

  const { fetchPage: zeroFetch } = paginatedFetch([], 100);
  const zeroEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(walmartRoute, { message: 'How much did I spend at Walmart last month?' }),
    route: walmartRoute,
    message: 'How much did I spend at Walmart last month?',
    fetchPage: zeroFetch,
    assertFn: async () => ({ access: 'owner' }),
  });
  check('zero spending status ok', zeroEv.status === 'ok');
  check('zero transactionCount', zeroEv.facts.transactionCount === 0 && zeroEv.lookups[0].transactionCount === 0);
  check('zero spentTotal is +0', zeroEv.facts.spentTotal === 0 && zeroEv.lookups[0].spentTotal === 0);
  check('zero expenseTotal alias is +0', zeroEv.facts.expenseTotal === 0 && zeroEv.lookups[0].expenseTotal === 0);
  check('never negative zero spentTotal', !Object.is(zeroEv.facts.spentTotal, -0)
    && !Object.is(zeroEv.lookups[0].spentTotal, -0));
  const zeroBlock = buildEvidenceSystemSection(zeroEv);
  check('zero evidence includes spending glossary', /positive posted-spending magnitude/.test(zeroBlock));
  check('zero evidence prefers spentTotal', /Prefer spentTotal/.test(zeroBlock));
}

module.exports = { run };
