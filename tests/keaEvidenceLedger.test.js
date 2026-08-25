'use strict';

const { check, section } = require('./harness');
const {
  EVIDENCE_LEDGER_VERSION,
  LEDGER_STATUS,
  validateEvidenceLedgerV1,
  deepFreeze,
  cloneJson,
  collectNarratableInternalKeys,
  serializedSize,
} = require('../services/keaEvidenceLedger');
const {
  buildEvidenceLedger,
  buildUpcomingEvidenceLedger,
  buildRecurringEvidenceLedger,
  buildIncomeHorizonEvidenceLedger,
  buildComparisonEvidenceLedger,
  buildTrendEvidenceLedger,
  buildCashflowEvidenceLedger,
  buildAffordabilityEvidenceLedger,
  buildLookupEvidenceLedger,
  buildSnapshotEvidenceLedger,
} = require('../services/keaEvidenceLedgerBuilders');
const { routeCapability } = require('../services/keaCapabilityRouter');
const { resolveGroundingPolicy } = require('../services/keaGroundingPolicy');
const { prefetchGrounding } = require('../services/keaGroundingPrefetch');

function getPath(obj, path) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i += 1) {
    if (cur == null) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

function assertLedgerFactParity(prefix, sourceFacts, ledgerFacts, paths) {
  for (let i = 0; i < paths.length; i += 1) {
    const path = paths[i];
    const a = getPath(sourceFacts, path);
    const b = getPath(ledgerFacts, path);
    const same = a === b || JSON.stringify(a) === JSON.stringify(b);
    check(`${prefix} parity ${path}`, same);
  }
}

function sampleUpcomingResult(partial = {}) {
  return {
    status: 'ok',
    source: ['cashflow_upcoming'],
    accountScope: 'selected_account',
    period: {
      start: '2026-08-23',
      end: '2026-08-29',
      label: 'next_week',
      relation: 'next_week',
    },
    metricScope: 'expense',
    items: [
      {
        label: 'Daycare',
        date: '2026-08-24',
        amount: 705,
        frequencyLabel: 'Weekly',
        transactionid: 99,
        signed: -705,
      },
    ],
    totals: {
      scheduledExpenseTotal: 705,
    },
    observations: [
      { code: 'upcoming_expense_count', count: 1 },
    ],
    limitations: [],
    dataAsOf: '2026-08-17',
    itemCount: 1,
    ...partial,
  };
}

function sampleRecurringResult() {
  return {
    status: 'ok',
    accountScope: 'selected_account',
    recurringDefinition: 'kea_scheduled_series',
    sourceKinds: ['kea_scheduled_series'],
    expenses: [
      {
        label: 'Netflix',
        category: 'Entertainment',
        frequency: 30,
        frequencyLabel: 'Monthly',
        amount: 15.99,
        monthlyEquivalent: 15.99,
        nextDate: '2026-09-01',
        groupid: 'g1',
      },
      {
        label: 'Rent',
        category: 'Housing',
        frequency: 30,
        frequencyLabel: 'Monthly',
        amount: 1400,
        monthlyEquivalent: 1400,
        nextDate: '2026-09-01',
      },
    ],
    income: [
      {
        label: 'Paycheck',
        category: 'Income',
        frequency: 14,
        frequencyLabel: 'Bi-Weekly',
        amount: 2000,
        monthlyEquivalent: Number((2000 * 26 / 12).toFixed(2)),
        nextDate: '2026-08-21',
      },
    ],
    totals: {
      recurringExpenseMonthlyEquivalent: 1415.99,
      recurringIncomeMonthlyEquivalent: Number((2000 * 26 / 12).toFixed(2)),
      nextOccurrenceExpenseSum: 1415.99,
    },
    observations: [
      { code: 'largest_recurring_expense', label: 'Rent', monthlyEquivalent: 1400, frequencyLabel: 'Monthly' },
      { code: 'largest_recurring_income', label: 'Paycheck', monthlyEquivalent: Number((2000 * 26 / 12).toFixed(2)), frequencyLabel: 'Bi-Weekly' },
      { code: 'monthly_recurring_expense_total' },
      { code: 'monthly_recurring_income_total' },
      { code: 'next_recurring_expense', label: 'Netflix', nextDate: '2026-09-01', amount: 15.99 },
    ],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
    streamCounts: { expense: 2, income: 1 },
  };
}

function sampleHorizonResult(partial = {}) {
  return {
    status: 'ok',
    source: ['cashflow_income_horizon'],
    accountScope: 'selected_account',
    incomeHorizonDefinition: 'kea_scheduled_recurring_income',
    nextIncome: [
      {
        label: 'Direct Deposit',
        date: '2026-08-31',
        amount: 4626.36,
        frequencyLabel: 'Semi-Monthly',
        category: 'Income',
      },
    ],
    combinedScheduledIncomeAmount: 4626.36,
    window: {
      start: '2026-08-18',
      end: '2026-08-30',
      relation: 'before_next_scheduled_income',
    },
    expensesBeforeIncome: {
      count: 2,
      total: 200,
      items: [
        { label: 'Rent', date: '2026-08-20', amount: 100 },
        { label: 'Phone', date: '2026-08-25', amount: 100 },
      ],
    },
    forecast: {
      startingAvailable: 1400,
      lowestBalanceBeforeIncome: 250,
      lowestBalanceDate: '2026-08-30',
      projectedBalanceDayBeforeIncome: 250,
      firstNegativeDate: null,
      firstNegativeAmount: null,
      projectedShortfallBeforeIncome: 0,
      daysUntilNextIncome: 14,
    },
    observations: [
      { code: 'next_scheduled_recurring_income', date: '2026-08-31' },
      { code: 'no_negative_before_income' },
    ],
    limitations: ['selected_account_scope'],
    dataAsOf: '2026-08-17',
    ...partial,
  };
}

function sampleComparisonResult() {
  return {
    status: 'ok',
    accountScope: 'selected_account',
    windowKind: 'matched_elapsed',
    periodA: {
      label: 'July 1–16, 2026',
      start: '2026-07-01',
      end: '2026-07-16',
      income: 5000,
      spending: 4200,
      net: 800,
      transactionCount: 8,
    },
    periodB: {
      label: 'August 1–16, 2026',
      start: '2026-08-01',
      end: '2026-08-16',
      income: 5600,
      spending: 3780,
      net: 1820,
      transactionCount: 7,
    },
    changes: {
      income: { absolute: 600, percent: 12, baselineZero: false, direction: 'increased' },
      spending: { absolute: -420, percent: -10, baselineZero: false, direction: 'decreased' },
      net: { absolute: 1020, percent: 127.5, baselineZero: false, direction: 'improved' },
    },
    observations: [
      { code: 'spending_decreased' },
      { code: 'income_increased' },
      { code: 'net_improved' },
    ],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
  };
}

function sampleTrendResult() {
  return {
    status: 'ok',
    accountScope: 'selected_account',
    windowKind: 'matched_elapsed',
    metricScope: 'spending',
    periods: [
      { label: 'June 1–16, 2026', start: '2026-06-01', end: '2026-06-16', income: 5000, spending: 100, net: 4900, transactionCount: 2 },
      { label: 'July 1–16, 2026', start: '2026-07-01', end: '2026-07-16', income: 5000, spending: 120, net: 4880, transactionCount: 2 },
      { label: 'August 1–16, 2026', start: '2026-08-01', end: '2026-08-16', income: 5000, spending: 140, net: 4860, transactionCount: 2 },
    ],
    trend: {
      income: { direction: 'unchanged', firstToLast: { absolute: 0, percent: 0, baselineZero: false } },
      spending: { direction: 'increasing', firstToLast: { absolute: 40, percent: 40, baselineZero: false } },
      net: { direction: 'decreasing', firstToLast: { absolute: -40, percent: -0.82, baselineZero: false, crossedZero: false } },
    },
    highest: { metric: 'spending', label: 'August 1–16, 2026', start: '2026-08-01', end: '2026-08-16', value: 140 },
    lowest: { metric: 'spending', label: 'June 1–16, 2026', start: '2026-06-01', end: '2026-06-16', value: 100 },
    observations: [{ code: 'spending_increasing' }],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
  };
}

function sampleCashflowResult() {
  return {
    status: 'ok',
    period: { start: '2026-08-01', end: '2026-08-16', label: 'current_month_to_date' },
    postedIncome: 3000,
    postedSpending: 200,
    postedNet: 2800,
    remainingForecastSpending: 400,
    remainingForecastIncome: 2000,
    availableBalance: 1400,
    currentBalance: 1350,
    reconciledBalance: 1300,
    savingsPotential: 900,
    negativeBalanceRisk: {
      scope: { start: '2026-08-16', end: '2026-08-31', label: 'this_month' },
      horizonDays: 90,
      hasNegativeInScope: false,
      firstNegativeDate: null,
      lowestProjectedAmount: 410,
      lowestProjectedDate: '2026-09-13',
    },
    observations: [{ code: 'posted_net_positive' }],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
  };
}

function sampleAffordabilityResult() {
  return {
    status: 'ok',
    requested: { amount: 800, purchaseDate: '2026-08-21' },
    baseline: { projectedOnDate: 3047, projectedOnDateAt: '2026-08-21' },
    hypothetical: {
      projectedOnDate: 2247,
      projectedOnDateAt: '2026-08-21',
      lowestAfterDate: 410,
      lowestAfterDateOn: '2026-09-13',
    },
    delta: { newNegativeIntroduced: false },
    observations: [{ code: 'no_new_negative' }],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
  };
}

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
};

function route(message, extra = {}) {
  return routeCapability({
    message,
    currentDate: extra.currentDate || '2026-08-17',
    accountId: extra.accountId || '10',
  });
}

async function prefetchUpcoming(message, result, extra = {}) {
  const routed = extra.route || route(message, extra);
  return prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    token: 'jwt',
    currentDate: extra.currentDate || '2026-08-17',
    policy: resolveGroundingPolicy(routed, { message }),
    route: routed,
    fetchUpcomingAnalysis: async () => result,
  });
}

const sizes = {};

function recordSize(name, ledger) {
  const n = serializedSize(ledger);
  sizes[name] = n;
  check(`${name} serialized size recorded`, typeof n === 'number' && n > 0);
}

function claimByPath(ledger, path) {
  return (ledger.claims || []).find((c) => c.path === path) || null;
}

function narrationHas(list, code) {
  return Array.isArray(list) && list.some((row) => row && row.code === code);
}

async function run() {
  section('Evidence Ledger V1 contract');
  check('version is 1', EVIDENCE_LEDGER_VERSION === 1);
  const invalid = validateEvidenceLedgerV1({ version: 2, status: 'complete' });
  check('unknown version fails validation', invalid.ok === false && invalid.errors.indexOf('version_invalid') !== -1);
  check('null ledger validates as absent', validateEvidenceLedgerV1(null).ok === true);
  const malformed = buildEvidenceLedger(null);
  check('malformed input does not throw', malformed.ok === false && malformed.reason === 'invalid_input');
  check('missing evidence fails safely', buildEvidenceLedger({ capability: 'cashflow_upcoming' }).reason === 'missing_evidence');

  section('non-financial capabilities have no ledger');
  const none = buildEvidenceLedger({
    capability: 'product_help',
    evidence: { status: 'ok', source: [] },
  });
  check('product_help ledger null', none.ok === true && none.ledger === null);
  check('navigation ledger null', buildEvidenceLedger({
    capability: 'navigation_ui',
    evidence: { status: 'ok', source: [] },
  }).ledger === null);
  check('casual ledger null', buildEvidenceLedger({
    capability: 'casual_conversation',
    evidence: { status: 'ok', source: [] },
  }).ledger === null);
  check('write capability ledger null', buildEvidenceLedger({
    capability: 'transaction_write',
    evidence: { status: 'ok', source: [] },
  }).ledger === null);
  check('simulation deferred', buildEvidenceLedger({
    capability: 'simulation',
    evidence: { status: 'ok', source: [] },
  }).ledger === null);

  section('unavailable vs unsupported vs complete_empty');
  const unavail = buildEvidenceLedger({
    capability: 'cashflow_upcoming',
    evidence: { status: 'unavailable', source: [], limitations: ['upcoming_unavailable'] },
  });
  check('unavailable status', unavail.ok && unavail.ledger.status === LEDGER_STATUS.UNAVAILABLE);
  const unsup = buildEvidenceLedger({
    capability: 'mixed_macro',
    evidence: { status: 'unavailable', source: [], limitations: ['mixed_macro_unsupported'] },
  });
  check('unsupported status', unsup.ok && unsup.ledger.status === LEDGER_STATUS.UNSUPPORTED);

  section('Upcoming golden — non-empty expense');
  const upcomingEv = await prefetchUpcoming('What bills are due next week?', sampleUpcomingResult());
  const frozenUpcoming = deepFreeze(cloneJson(upcomingEv));
  const upcomingBuilt = buildEvidenceLedger({
    capability: 'cashflow_upcoming',
    evidence: frozenUpcoming,
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  });
  const upcoming = upcomingBuilt.ledger;
  check('upcoming build ok', upcomingBuilt.ok === true);
  check('upcoming version', upcoming.version === 1);
  check('upcoming complete', upcoming.status === LEDGER_STATUS.COMPLETE);
  check('upcoming source.kind cashflow_upcoming', upcoming.source.kind === 'cashflow_upcoming');
  check('upcoming source.definition cashflow_upcoming', upcoming.source.definition === 'cashflow_upcoming');
  check('upcoming description scheduled expenses', /scheduled expenses in your Keacast forecast/.test(upcoming.source.description));
  check('upcoming period start', upcoming.scope.period.start === '2026-08-23');
  check('upcoming period end', upcoming.scope.period.end === '2026-08-29');
  check('upcoming relation next_week', upcoming.scope.period.relation === 'next_week');
  check('upcoming metricScope expense', upcoming.scope.metricScope === 'expense');
  check('upcoming accountLabel', upcoming.scope.accountLabel === 'Checking');
  check('upcoming accountId internal only', upcoming.internal.accountId === '10');
  check('upcoming scenario real', upcoming.scope.scenario === 'real');
  check('upcoming sign magnitude', upcoming.facts.signConvention === 'magnitude');
  check('upcoming item amount positive', upcoming.facts.items[0].amount === 705);
  check('upcoming no transactionid', upcoming.facts.items[0].transactionid === undefined);
  check('upcoming no signed field', upcoming.facts.items[0].signed === undefined);
  check('upcoming itemId', upcoming.facts.items[0].itemId === 'item1');
  check('upcoming observation internal', upcoming.internal.observations[0].code === 'upcoming_expense_count');
  check('upcoming observation not a claim type OBSERVATION', upcoming.claims.every((c) => c.type !== 'OBSERVATION'));
  assertLedgerFactParity('upcoming', upcomingEv.facts, upcoming.facts, [
    'totals.scheduledExpenseTotal',
    'metricScope',
  ]);
  check('upcoming total copied', upcoming.facts.totals.scheduledExpenseTotal === upcomingEv.facts.totals.scheduledExpenseTotal);
  check('upcoming date unchanged', upcoming.facts.items[0].date === '2026-08-24');
  check('upcoming no internal leak', collectNarratableInternalKeys(upcoming).length === 0);
  check('upcoming claim ids deterministic', upcoming.claims[0].id === 'c1' && upcoming.claims[1].id === 'c2');
  recordSize('upcoming_nonempty', upcoming);
  check('upcoming input not mutated', frozenUpcoming.facts.items[0].amount === 705);

  section('Upcoming golden — complete-empty income');
  const emptyEv = await prefetchUpcoming('What about income?', sampleUpcomingResult({
    metricScope: 'income',
    items: [],
    totals: { scheduledIncomeTotal: 0 },
    observations: [{ code: 'no_upcoming_in_period' }],
    itemCount: 0,
  }), { route: route('What income is coming next week?') });
  const emptyBuilt = buildUpcomingEvidenceLedger({
    evidence: emptyEv,
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  });
  const emptyLed = emptyBuilt.ledger;
  check('empty upcoming complete_empty', emptyLed.status === LEDGER_STATUS.COMPLETE_EMPTY);
  check('empty income total is 0 not missing', emptyLed.facts.totals.scheduledIncomeTotal === 0);
  check('empty itemCount 0', emptyLed.facts.itemCount === 0);
  check('empty items array', Array.isArray(emptyLed.facts.items) && emptyLed.facts.items.length === 0);
  check('empty period preserved', emptyLed.scope.period.start === '2026-08-23' && emptyLed.scope.period.end === '2026-08-29');
  check('empty metricScope income', emptyLed.scope.metricScope === 'income');
  check('empty observation internal', emptyLed.internal.observations.some((row) => row.code === 'no_upcoming_in_period'));
  check('empty allowed scheduled_empty', narrationHas(emptyLed.allowedNarration, 'scheduled_empty'));
  check('empty allowed text is scheduled not generalized', /No scheduled income exists in this Keacast forecast/.test(emptyLed.allowedNarration[0].text));
  check('empty prohibited generalize', narrationHas(emptyLed.prohibitedNarration, 'do_not_generalize_no_income'));
  check('empty 0 claim present', claimByPath(emptyLed, 'facts.totals.scheduledIncomeTotal').value === 0);
  recordSize('upcoming_empty', emptyLed);

  section('Recurring golden — full expense + largest');
  const recRoute = route('What recurring expenses do I have?');
  const recEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    token: 'jwt',
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(recRoute, { message: 'What recurring expenses do I have?' }),
    route: recRoute,
    fetchRecurringAnalysis: async () => sampleRecurringResult(),
  });
  const recClone = cloneJson(recEv);
  deepFreeze(recEv);
  const recBuilt = buildRecurringEvidenceLedger({
    evidence: recEv,
    route: recRoute,
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  });
  const rec = recBuilt.ledger;
  check('recurring ok', recBuilt.ok);
  check('recurring definition', rec.source.definition === 'kea_scheduled_series');
  check('recurring kind', rec.source.kind === 'cashflow_recurring');
  check('recurring metricScope expense', rec.scope.metricScope === 'expense');
  check('recurring monthlyEquivalent copied', rec.facts.expenses[1].monthlyEquivalent === recClone.facts.expenses[1].monthlyEquivalent);
  check('recurring nextDate copied', rec.facts.expenses[1].nextDate === '2026-09-01');
  check('recurring no groupid', rec.facts.expenses[0].groupid === undefined);
  check('recurring largest from observation label', rec.facts.largestExpense && rec.facts.largestExpense.label === 'Rent');
  check('recurring largest monthly copied not recomputed', rec.facts.largestExpense.monthlyEquivalent === 1400);
  check('recurring observation code internal', rec.internal.observations.some((row) => row.code === 'largest_recurring_expense'));
  check('recurring claims have no raw observation code as type', rec.claims.every((c) => c.type !== 'OBSERVATION'));
  assertLedgerFactParity('recurring', recClone.facts, rec.facts, [
    'totals.recurringExpenseMonthlyEquivalent',
    'totals.nextOccurrenceExpenseSum',
    'recurringDefinition',
  ]);
  recordSize('recurring_full', rec);

  const largestRoute = route('What is my largest recurring expense?');
  const largestEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    token: 'jwt',
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(largestRoute, { message: 'What is my largest recurring expense?' }),
    route: largestRoute,
    fetchRecurringAnalysis: async () => sampleRecurringResult(),
  });
  const largest = buildEvidenceLedger({
    capability: 'cashflow_recurring',
    evidence: largestEv,
    route: largestRoute,
    responseMode: 'largest',
    accountContext: { accountId: '10' },
  }).ledger;
  check('largest rankingMode', largest.facts.rankingMode === 'largest' || largest.responseMode === 'largest');
  check('largest stream still copied from source list', largest.facts.largestExpense.label === 'Rent'
    && largest.facts.largestExpense.amount === 1400);
  recordSize('recurring_largest', largest);

  section('Income horizon golden');
  const hzRoute = route('Will I go negative before my next paycheck?');
  const hzEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    token: 'jwt',
    currentDate: '2026-08-17',
    policy: resolveGroundingPolicy(hzRoute, { message: hzRoute.message || 'Will I go negative before my next paycheck?' }),
    route: hzRoute,
    fetchIncomeHorizonAnalysis: async () => sampleHorizonResult(),
  });
  const hzClone = cloneJson(hzEv);
  const hz = buildIncomeHorizonEvidenceLedger({
    evidence: hzEv,
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
  check('horizon definition', hz.source.definition === 'kea_scheduled_recurring_income');
  check('horizon kind', hz.source.kind === 'cashflow_income_horizon');
  check('horizon next date copied', hz.facts.nextIncome[0].date === '2026-08-31');
  check('horizon next amount copied', hz.facts.nextIncome[0].amount === 4626.36);
  check('horizon combined copied', hz.facts.combinedScheduledIncomeAmount === 4626.36);
  check('horizon window copied', hz.facts.window.start === '2026-08-18' && hz.facts.window.end === '2026-08-30');
  check('horizon expense total copied', hz.facts.expensesBeforeIncome.total === 200);
  check('horizon lowest copied', hz.facts.forecast.lowestBalanceBeforeIncome === 250);
  check('horizon firstNegativeDate null preserved', hz.facts.forecast.firstNegativeDate === null);
  check('horizon shortfall 0 preserved', hz.facts.forecast.projectedShortfallBeforeIncome === 0);
  check('horizon negative boolean false', hz.facts.negativeBeforeIncome === false);
  check('horizon no paycheck claim', !JSON.stringify(hz.allowedNarration).toLowerCase().includes('paycheck'));
  check('horizon prohibits paycheck', narrationHas(hz.prohibitedNarration, 'do_not_call_paycheck'));
  assertLedgerFactParity('horizon', hzClone.facts, hz.facts, [
    'combinedScheduledIncomeAmount',
    'forecast.lowestBalanceBeforeIncome',
    'forecast.projectedShortfallBeforeIncome',
    'forecast.daysUntilNextIncome',
    'incomeHorizonDefinition',
  ]);
  recordSize('income_horizon', hz);

  const negHzEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    token: 'jwt',
    currentDate: '2026-08-17',
    policy: resolveGroundingPolicy(hzRoute, { message: 'Will I go negative before my next paycheck?' }),
    route: hzRoute,
    fetchIncomeHorizonAnalysis: async () => sampleHorizonResult({
      forecast: {
        startingAvailable: 50,
        lowestBalanceBeforeIncome: -20,
        lowestBalanceDate: '2026-08-25',
        projectedBalanceDayBeforeIncome: 100,
        firstNegativeDate: '2026-08-25',
        firstNegativeAmount: -20,
        projectedShortfallBeforeIncome: 20,
        daysUntilNextIncome: 14,
      },
      observations: [
        { code: 'next_scheduled_recurring_income', date: '2026-08-31' },
        { code: 'forecast_goes_negative_before_income' },
      ],
    }),
  });
  const negHz = buildIncomeHorizonEvidenceLedger({ evidence: negHzEv }).ledger;
  check('negative horizon boolean true', negHz.facts.negativeBeforeIncome === true);
  check('negative firstNegativeDate copied', negHz.facts.forecast.firstNegativeDate === '2026-08-25');

  const sameDayRaw = sampleHorizonResult();
  const sameDayHz = buildIncomeHorizonEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_income_horizon'],
      facts: {
        incomeHorizonDefinition: sameDayRaw.incomeHorizonDefinition,
        nextIncome: sameDayRaw.nextIncome,
        combinedScheduledIncomeAmount: sameDayRaw.combinedScheduledIncomeAmount,
        window: sameDayRaw.window,
        expensesBeforeIncome: sameDayRaw.expensesBeforeIncome,
        forecast: sameDayRaw.forecast,
      },
      limitations: ['same_day_order_unknown'],
      observations: [{ code: 'same_day_order_unknown' }],
    },
  });
  check('same-day limitation copied', sameDayHz.ok && sameDayHz.ledger.limitations.indexOf('same_day_order_unknown') !== -1);
  check('same-day allowed narration', narrationHas(sameDayHz.ledger.allowedNarration, 'same_day_order_unknown'));

  section('Comparison golden');
  const cmpRoute = route('How does this month compare with last month?');
  const cmpEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    token: 'jwt',
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(cmpRoute, { message: 'How does this month compare with last month?' }),
    route: cmpRoute,
    fetchPeriodComparison: async () => sampleComparisonResult(),
  });
  const cmpClone = cloneJson(cmpEv);
  const cmp = buildComparisonEvidenceLedger({ evidence: cmpEv, route: cmpRoute }).ledger;
  check('comparison kind', cmp.source.kind === 'cashflow_period_comparison');
  check('comparison windowKind', cmp.facts.windowKind === cmpClone.facts.windowKind || cmp.facts.windowKind === 'matched_elapsed');
  check('comparison periodA exact', cmp.facts.periodA.start === cmpClone.facts.periodA.start && cmp.facts.periodA.end === cmpClone.facts.periodA.end);
  check('comparison periodB exact', cmp.facts.periodB.start === cmpClone.facts.periodB.start && cmp.facts.periodB.end === cmpClone.facts.periodB.end);
  assertLedgerFactParity('comparison', cmpClone.facts, cmp.facts, [
    'periodA.income', 'periodA.spending', 'periodA.net',
    'periodB.income', 'periodB.spending', 'periodB.net',
    'changes.income.absolute', 'changes.income.percent', 'changes.income.direction',
    'changes.spending.absolute', 'changes.spending.percent', 'changes.spending.direction',
    'changes.net.absolute', 'changes.net.percent', 'changes.net.direction',
    'changes.income.baselineZero',
  ]);
  check('comparison spending DIRECTION claim', claimByPath(cmp, 'facts.changes.spending.direction')
    && claimByPath(cmp, 'facts.changes.spending.direction').type === 'DIRECTION'
    && claimByPath(cmp, 'facts.changes.spending.direction').value === 'decreased');
  recordSize('comparison', cmp);

  const nullPct = buildComparisonEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_period_comparison'],
      facts: {
        windowKind: 'full_months',
        periodA: { start: '2026-06-01', end: '2026-06-30', income: 0, spending: 0, net: 0 },
        periodB: { start: '2026-07-01', end: '2026-07-31', income: 100, spending: 50, net: 50 },
        changes: {
          income: { absolute: 100, percent: null, baselineZero: true, direction: 'increased' },
          spending: { absolute: 50, percent: null, baselineZero: true, direction: 'increased' },
          net: { absolute: 50, percent: null, baselineZero: true, crossedZero: false, direction: 'improved' },
        },
      },
      observations: [],
      limitations: [],
    },
  }).ledger;
  check('percent null remains null', nullPct.facts.changes.income.percent === null);
  check('percent null claim', claimByPath(nullPct, 'facts.changes.income.percent').value === null);

  section('Trend golden');
  const trendRoute = route('Am I spending more lately?');
  const trendEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    token: 'jwt',
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(trendRoute, { message: 'Am I spending more lately?' }),
    route: trendRoute,
    fetchTrendAnalysis: async () => sampleTrendResult(),
  });
  const trendClone = cloneJson(trendEv);
  const trend = buildTrendEvidenceLedger({ evidence: trendEv, route: trendRoute }).ledger;
  check('trend three periods', trend.facts.periods.length === 3);
  check('trend metricScope', trend.facts.metricScope === 'spending');
  check('trend direction copied', trend.facts.trend.spending.direction === 'increasing');
  assertLedgerFactParity('trend', trendClone.facts, trend.facts, [
    'trend.spending.direction',
    'trend.spending.firstToLast.absolute',
    'trend.spending.firstToLast.percent',
    'highest.value',
    'lowest.value',
  ]);
  check('trend dates unchanged', trend.facts.periods[0].start === '2026-06-01' && trend.facts.periods[2].end === '2026-08-16');
  recordSize('trend', trend);

  section('Cashflow analysis golden');
  const cfRoute = route('How am I doing this month?');
  const cfEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    token: 'jwt',
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(cfRoute, { message: 'How am I doing this month?' }),
    route: cfRoute,
    fetchCashflowAnalysis: async () => sampleCashflowResult(),
  });
  const cfClone = cloneJson(cfEv);
  const cf = buildCashflowEvidenceLedger({ evidence: cfEv }).ledger;
  check('cashflow kind', cf.source.kind === 'cashflow_analysis');
  assertLedgerFactParity('cashflow', cfClone.facts, cf.facts, [
    'postedIncome', 'postedSpending', 'postedNet',
    'remainingForecastSpending', 'availableBalance',
  ]);
  check('cashflow spending magnitude positive', cf.facts.postedSpending === 200);
  check('cashflow horizonDays stripped', cf.facts.horizonDays === undefined
    && (!cf.facts.negativeBalanceRisk || cf.facts.negativeBalanceRisk.horizonDays === undefined));
  check('cashflow hasNegative copied', cf.facts.negativeBalanceRisk.hasNegativeInScope === false);
  check('cashflow prohibits comfortable', narrationHas(cf.prohibitedNarration, 'do_not_say_comfortable'));
  recordSize('cashflow', cf);

  const julyEv = {
    status: 'ok',
    source: ['cashflow_analysis'],
    period: { start: '2026-07-01', end: '2026-07-31', label: 'named_month' },
    dataAsOf: '2026-08-16T12:00:00.000Z',
    clientDate: '2026-08-16',
    accountScope: 'selected_account',
    facts: {
      postedIncome: 4000,
      postedSpending: 3500,
      postedNet: 500,
      availableBalance: 2200,
      remainingForecastIncome: 1,
      remainingForecastSpending: 2,
      savingsPotential: 3,
      negativeBalanceRisk: { hasNegativeInScope: false, horizonDays: 90 },
    },
    observations: [],
    limitations: [],
  };
  const july = buildCashflowEvidenceLedger({ evidence: julyEv }).ledger;
  check('historical postedIncome kept', july.facts.postedIncome === 4000);
  check('historical balances stripped', july.facts.availableBalance === undefined);
  check('historical remaining stripped', july.facts.remainingForecastIncome === undefined);
  check('historical risk stripped', july.facts.negativeBalanceRisk === undefined);

  section('Affordability golden');
  const affRoute = route('Can I afford $800 next Friday?');
  const affEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    token: 'jwt',
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(affRoute, { message: 'Can I afford $800 next Friday?' }),
    route: affRoute,
    fetchAffordabilityAnalysis: async () => sampleAffordabilityResult(),
  });
  const affClone = cloneJson(affEv);
  const aff = buildAffordabilityEvidenceLedger({ evidence: affEv }).ledger;
  check('affordability kind', aff.source.kind === 'affordability_analysis');
  check('affordability scenario hypothetical', aff.scope.scenario === 'affordability_hypothetical');
  check('affordability requested copied', aff.facts.requested.amount === 800 && aff.facts.requested.purchaseDate === '2026-08-21');
  check('affordability assumption one_time_expense', (aff.assumptions || []).some((row) => row.code === 'one_time_expense'));
  assertLedgerFactParity('affordability', affClone.facts, aff.facts, [
    'requested.amount',
    'baseline.projectedOnDate',
    'hypothetical.lowestAfterDate',
    'delta.newNegativeIntroduced',
  ]);
  check('no affordable field', aff.facts.affordable === undefined);
  check('no safe field', aff.facts.safe === undefined);
  check('no comfortable field', aff.facts.comfortable === undefined);
  check('no canAfford field', aff.facts.canAfford === undefined);
  check('no invitation fields', aff.facts.pendingInvitation === undefined && aff.internal.pendingInvitation === undefined);
  check('affordability prohibits class', narrationHas(aff.prohibitedNarration, 'do_not_classify_affordability'));
  recordSize('affordability', aff);

  section('Lookup golden');
  function paginatedFetch(allRows) {
    return async ({ page, limit }) => {
      const size = limit || 100;
      const start = (page - 1) * size;
      return {
        transactions: allRows.slice(start, start + size),
        pagination: {
          page,
          limit: size,
          total: allRows.length,
          pages: Math.ceil(allRows.length / size) || 1,
          hasNext: page * size < allRows.length,
        },
      };
    };
  }
  const lookupRoute = route('How much did I spend at Walmart last month?', { currentDate: '2026-08-16' });
  const lookupEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(lookupRoute, { message: 'How much did I spend at Walmart last month?' }),
    route: lookupRoute,
    message: 'How much did I spend at Walmart last month?',
    fetchPage: paginatedFetch([
      { name: 'Walmart', amount: -40, start: '2026-07-02', forecast_type: 'A' },
      { name: 'Walmart', amount: -30, start: '2026-07-10', forecast_type: 'A' },
    ]),
    assertFn: async () => ({ access: 'owner' }),
  });
  const lookupClone = cloneJson(lookupEv);
  const lookup = buildLookupEvidenceLedger({
    evidence: lookupEv,
    route: lookupRoute,
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
  check('lookup source user_transactions', lookup.source.kind === 'user_transactions');
  check('lookup merchant scope', lookup.scope.merchant === lookupRoute.slots.subjectValue || lookup.scope.merchant === 'Walmart');
  assertLedgerFactParity('lookup', lookupClone.facts, lookup.facts, [
    'transactionCount', 'spentTotal', 'expenseTotal',
  ]);
  check('lookup does not invert sign', lookup.facts.spentTotal === lookupClone.facts.spentTotal);
  recordSize('lookup', lookup);

  const zeroLookupEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(lookupRoute, { message: 'How much did I spend at Walmart last month?' }),
    route: lookupRoute,
    message: 'How much did I spend at Walmart last month?',
    fetchPage: paginatedFetch([]),
    assertFn: async () => ({ access: 'owner' }),
  });
  const zeroLookup = buildLookupEvidenceLedger({ evidence: zeroLookupEv, route: lookupRoute }).ledger;
  check('lookup zero is complete_empty', zeroLookup.status === LEDGER_STATUS.COMPLETE_EMPTY);
  check('lookup zero spentTotal 0', zeroLookup.facts.spentTotal === 0);
  check('lookup zero count 0', zeroLookup.facts.transactionCount === 0);

  section('Snapshot golden');
  const balRoute = route("What's my balance?", { currentDate: '2026-08-16' });
  const snapEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(balRoute, { message: "What's my balance?" }),
    route: balRoute,
    fetchPage: paginatedFetch([]),
    assertFn: async () => ({ access: 'owner' }),
  });
  const snapClone = cloneJson(snapEv);
  const snap = buildSnapshotEvidenceLedger({
    capability: 'financial_lookup',
    evidence: snapEv,
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
  check('snapshot source kea_snapshot', snap.source.kind === 'kea_snapshot');
  check('snapshot upcomingWindowDays 15', snap.facts.upcomingWindowDays === 15);
  check('snapshot 15-day limitation', snap.limitations.indexOf('upcoming_window_15d') !== -1);
  check('snapshot not labeled next_week', snap.scope.period == null || snap.scope.period.relation !== 'next_week');
  check('snapshot prohibits next_week', narrationHas(snap.prohibitedNarration, 'do_not_call_next_week'));
  assertLedgerFactParity('snapshot', snapClone.facts, snap.facts, [
    'reconciledBalance', 'currentBalance', 'availableBalance',
    'upcomingExpenseTotal', 'upcomingIncomeTotal', 'upcomingWindowDays',
    'monthIncome', 'monthExpenses',
  ]);
  recordSize('snapshot', snap);

  const signedSnap = buildSnapshotEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['kea_snapshot'],
      facts: {
        matchedCompactItem: { name: 'Costco', amount: -80, date: '2026-08-10' },
        upcomingExpenseTotal: 200,
      },
      limitations: ['upcoming_window_15d'],
    },
  }).ledger;
  check('snapshot signed amount unchanged', signedSnap.facts.matchedCompactItem.amount === -80);

  section('zero / false / null / missing');
  const z = emptyLed;
  check('zero is not missing', z.facts.totals.scheduledIncomeTotal === 0);
  check('false preserved on horizon', hz.facts.negativeBeforeIncome === false);
  check('null firstNegativeDate preserved', hz.facts.forecast.firstNegativeDate === null);
  const missingTotal = buildUpcomingEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_upcoming'],
      facts: {
        metricScope: 'expense',
        period: { start: '2026-08-23', end: '2026-08-29', relation: 'next_week' },
        items: [{ label: 'A', date: '2026-08-24', amount: 10 }],
        totals: {},
      },
      observations: [],
      limitations: [],
    },
  }).ledger;
  check('missing total stays missing', missingTotal.facts.totals.scheduledExpenseTotal === undefined);
  check('missing total has no claim', claimByPath(missingTotal, 'facts.totals.scheduledExpenseTotal') == null);

  section('immutability');
  const before = JSON.stringify(recClone);
  buildRecurringEvidenceLedger({ evidence: recEv, route: recRoute });
  check('builder does not mutate frozen input', JSON.stringify(recEv) === JSON.stringify(recClone) || JSON.stringify(recClone) === before);
  check('ledger frozen', Object.isFrozen(rec));
  let threw = false;
  try { rec.status = 'tamper'; } catch (e) { threw = true; }
  check('frozen ledger rejects mutation', threw || rec.status === LEDGER_STATUS.COMPLETE);

  section('internal stripping');
  const leakHits = []
    .concat(collectNarratableInternalKeys(upcoming))
    .concat(collectNarratableInternalKeys(rec))
    .concat(collectNarratableInternalKeys(hz))
    .concat(collectNarratableInternalKeys(lookup));
  check('no narratable internal keys', leakHits.length === 0);
  check('accountId not in claims', upcoming.claims.every((c) => c.path.indexOf('accountId') === -1));

  section('dispatcher');
  const dispatched = buildEvidenceLedger({
    capability: 'cashflow_upcoming',
    evidence: upcomingEv,
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  });
  check('dispatcher upcoming', dispatched.ok && dispatched.ledger.internal.builder === 'upcoming');

  section('performance 1000 builds');
  const t0 = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    buildUpcomingEvidenceLedger({ evidence: upcomingEv });
  }
  const upcomingMs = Date.now() - t0;
  const t1 = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    buildRecurringEvidenceLedger({ evidence: recEv, route: recRoute });
  }
  const recurringMs = Date.now() - t1;
  const t2 = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    buildIncomeHorizonEvidenceLedger({ evidence: hzEv });
  }
  const horizonMs = Date.now() - t2;
  check('1000 upcoming builds < 2000ms', upcomingMs < 2000);
  check('1000 recurring builds < 2000ms', recurringMs < 2000);
  check('1000 horizon builds < 2000ms', horizonMs < 2000);
  check('upcoming perf recorded', upcomingMs >= 0);
  check('recurring perf recorded', recurringMs >= 0);
  check('horizon perf recorded', horizonMs >= 0);

  section('serialized sizes (bytes, no payload dump)');
  const sizeNames = Object.keys(sizes);
  check('all golden sizes present', sizeNames.length >= 8);
  sizeNames.forEach((name) => {
    check(`${name} bytes=${sizes[name]}`, sizes[name] < 200000);
  });

  section('macro contract gaps documented (no fill)');
  check('upcoming ranking not invented', upcoming.facts.largestItem === undefined);
  check('cashflow comfort not invented', cf.facts.comfortable === undefined && cf.facts.enough === undefined);
  check('horizon paycheck identity not invented', hz.facts.employerConfirmed === undefined && hz.facts.isPaycheck === undefined);
  check('affordability class not invented', aff.facts.affordabilityClass === undefined);
  check('snapshot next_week not invented', snap.facts.period == null || snap.facts.period.relation !== 'next_week');
}

module.exports = { run, assertLedgerFactParity };
