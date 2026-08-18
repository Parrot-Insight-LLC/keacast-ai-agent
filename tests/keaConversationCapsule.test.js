'use strict';

const { check, section } = require('./harness');
const {
  CAPSULE_VERSION,
  THREAD_KINDS,
  INVALID,
  deriveConversationCapsule,
  validateConversationCapsule,
  isConversationCapsuleV1,
} = require('../services/keaConversationCapsule');

/** Mirrors openaiController.emptyDialogueState — local so this suite stays I/O-free. */
function emptyDialogueState() {
  return {
    intent: null,
    draftTransaction: {},
    pendingConfirmation: false,
    needsReconfirm: false,
    draftGoal: {},
    pendingGoalConfirmation: false,
    goalNeedsReconfirm: false,
    goalIntent: null,
    committed: false,
    lastCommitSignature: null,
    recentWrites: [],
    recentToolOutcomes: [],
    uiReferent: null,
    lastCapability: null,
    lastSubjectKind: null,
    lastSubjectValue: null,
    lastPeriod: null,
    lastPurchaseDate: null,
    lastPurchaseDateAssumption: null,
    lastPurchaseDateAssumptionText: null,
    lastAccountId: null,
    lastComparison: null,
    lastTrend: null,
    lastRecurring: null,
    lastUpcoming: null,
    lastIncomeHorizon: null,
    pendingInvitation: null,
    updatedAt: null,
  };
}

const EVIDENCE_KEYS = [
  'incomeAmount',
  'combinedIncomeAmount',
  'scheduledExpenseTotal',
  'monthlyEquivalent',
  'lowestBalance',
  'firstNegative',
  'shortfall',
  'trendDirection',
  'netChange',
  'percentChange',
  'observations',
];

const WRITE_KEYS = [
  'draftTransaction',
  'pendingConfirmation',
  'needsReconfirm',
  'intent',
  'committed',
  'lastCommitSignature',
  'draftGoal',
  'pendingGoalConfirmation',
  'goalNeedsReconfirm',
  'goalIntent',
];

function snapshot(obj) {
  return JSON.stringify(obj);
}

function serialized(capsule) {
  return JSON.stringify(capsule);
}

function hasAnyKey(text, keys) {
  return keys.some((k) => text.includes(`"${k}"`));
}

function baseState(extra = {}) {
  const ds = emptyDialogueState();
  ds.lastAccountId = '10';
  ds.updatedAt = '2026-08-17T16:00:00.000Z';
  return Object.assign(ds, extra);
}

async function run() {
  section('3A.1 capsule empty / version');

  const empty = deriveConversationCapsule(emptyDialogueState());
  check('empty version 1', empty.version === CAPSULE_VERSION);
  check('empty accountId null', empty.accountId === null);
  check('empty updatedAt null', empty.updatedAt === null);
  check('empty activeThread null', empty.activeThread === null);
  check('empty is V1', isConversationCapsuleV1(empty) === true);
  check('empty validate ok', validateConversationCapsule(empty).ok === true);
  check('null input is empty V1', deriveConversationCapsule(null).activeThread === null);
  check('unknown version rejected', isConversationCapsuleV1({ ...empty, version: 2 }) === false);
  check('malformed version rejected', isConversationCapsuleV1({ ...empty, version: '1' }) === false);
  check('missing version rejected', isConversationCapsuleV1({ accountId: null, activeThread: null }) === false);

  section('3A.1 comparison thread');

  const cmp = deriveConversationCapsule(baseState({
    lastCapability: 'cashflow_comparison',
    lastSubjectKind: 'category',
    lastSubjectValue: 'restaurants',
    lastComparison: {
      periodA: { start: '2026-06-01', end: '2026-06-30', label: 'June 2026' },
      periodB: { start: '2026-07-01', end: '2026-07-31', label: 'July 2026' },
      windowKind: 'full_calendar_month',
    },
  }), '10');
  check('comparison kind', cmp.activeThread && cmp.activeThread.kind === THREAD_KINDS.COMPARISON);
  check('comparison account header', cmp.activeThread.accountId === '10' && cmp.accountId === '10');
  check('comparison updatedAt copied', cmp.activeThread.updatedAt === '2026-08-17T16:00:00.000Z');
  check('comparison periodA', cmp.activeThread.periodA.start === '2026-06-01' && cmp.activeThread.periodA.end === '2026-06-30');
  check('comparison periodB', cmp.activeThread.periodB.label === 'July 2026');
  check('comparison category mapped', cmp.activeThread.category === 'restaurants');
  check('comparison no totals', hasAnyKey(serialized(cmp), ['income', 'spending', 'net', 'percent']) === false);

  section('3A.1 trend thread');

  const trend = deriveConversationCapsule(baseState({
    lastCapability: 'cashflow_trend',
    lastTrend: {
      periods: [
        { start: '2026-05-01', end: '2026-05-31', label: 'May 2026' },
        { start: '2026-06-01', end: '2026-06-30', label: 'June 2026' },
        { start: '2026-07-01', end: '2026-07-31', label: 'July 2026' },
      ],
      windowKind: 'last_3_calendar_months',
      metricScope: 'spending',
      categoryFilter: 'restaurants',
    },
  }), '10');
  check('trend kind', trend.activeThread && trend.activeThread.kind === THREAD_KINDS.TREND);
  check('trend 3 periods', trend.activeThread.periods.length === 3);
  check('trend categoryFilter', trend.activeThread.categoryFilter === 'restaurants');
  check('trend metricScope', trend.activeThread.metricScope === 'spending');
  check('trend no direction/totals', hasAnyKey(serialized(trend), ['direction', 'trendDirection', 'spendingTotal']) === false);

  section('3A.1 recurring thread');

  const rec = deriveConversationCapsule(baseState({
    lastCapability: 'cashflow_recurring',
    lastRecurring: { metricScope: 'expense', rankingMode: 'largest' },
  }), '10');
  check('recurring kind', rec.activeThread && rec.activeThread.kind === THREAD_KINDS.RECURRING);
  check('recurring expense+largest', rec.activeThread.metricScope === 'expense' && rec.activeThread.rankingMode === 'largest');
  check('recurring no stream list', hasAnyKey(serialized(rec), ['streams', 'monthlyEquivalent', 'largestAmount']) === false);

  section('3A.1 upcoming thread');

  const up = deriveConversationCapsule(baseState({
    lastCapability: 'cashflow_upcoming',
    lastUpcoming: {
      period: {
        start: '2026-08-23',
        end: '2026-08-29',
        label: 'next_week',
        relation: 'next_week',
      },
      metricScope: 'expense',
    },
  }), '10');
  check('upcoming kind', up.activeThread && up.activeThread.kind === THREAD_KINDS.UPCOMING);
  check('upcoming absolute dates', up.activeThread.period.start === '2026-08-23' && up.activeThread.period.end === '2026-08-29');
  check('upcoming relation preserved', up.activeThread.period.relation === 'next_week');
  check('upcoming label preserved', up.activeThread.period.label === 'next_week');
  check('upcoming metricScope', up.activeThread.metricScope === 'expense');

  section('3A.1 income-horizon thread omits amounts');

  const horizon = deriveConversationCapsule(baseState({
    lastCapability: 'cashflow_income_horizon',
    lastIncomeHorizon: {
      incomeDate: '2026-08-31',
      incomeAmount: 4626.36,
      combinedIncomeAmount: 4626.36,
      windowStart: '2026-08-18',
      windowEnd: '2026-08-30',
      definition: 'kea_scheduled_recurring_income',
    },
  }), '10');
  check('horizon kind', horizon.activeThread && horizon.activeThread.kind === THREAD_KINDS.INCOME_HORIZON);
  check('horizon dates', horizon.activeThread.incomeDate === '2026-08-31'
    && horizon.activeThread.windowStart === '2026-08-18'
    && horizon.activeThread.windowEnd === '2026-08-30');
  check('horizon definition', horizon.activeThread.definition === 'kea_scheduled_recurring_income');
  check('horizon omits incomeAmount', Object.prototype.hasOwnProperty.call(horizon.activeThread, 'incomeAmount') === false);
  check('horizon omits combinedIncomeAmount', Object.prototype.hasOwnProperty.call(horizon.activeThread, 'combinedIncomeAmount') === false);
  check('horizon json has no amount fields', hasAnyKey(serialized(horizon), ['incomeAmount', 'combinedIncomeAmount']) === false);

  section('3A.1 lookup / analysis / forecast / affordability');

  const lookup = deriveConversationCapsule(baseState({
    lastCapability: 'financial_lookup',
    lastSubjectKind: 'merchant',
    lastSubjectValue: 'target',
    lastPeriod: { start: '2026-07-01', end: '2026-07-31', label: 'July 2026' },
  }), '10');
  check('lookup kind', lookup.activeThread && lookup.activeThread.kind === THREAD_KINDS.LOOKUP);
  check('lookup subject', lookup.activeThread.subjectKind === 'merchant' && lookup.activeThread.subjectValue === 'target');
  check('lookup period', lookup.activeThread.period && lookup.activeThread.period.start === '2026-07-01');
  check('lookup no result totals', hasAnyKey(serialized(lookup), ['matchCount', 'spendTotal']) === false);

  const analysis = deriveConversationCapsule(baseState({
    lastCapability: 'cashflow_analysis',
    lastPeriod: { start: '2026-08-01', end: '2026-08-31', label: 'August 2026' },
  }), '10');
  check('analysis kind', analysis.activeThread && analysis.activeThread.kind === THREAD_KINDS.ANALYSIS);
  check('analysis period only', analysis.activeThread.period.start === '2026-08-01' && analysis.activeThread.lowestBalance === undefined);

  const forecast = deriveConversationCapsule(baseState({
    lastCapability: 'financial_forecast',
    lastPeriod: { start: '2026-08-17', end: '2026-11-15', label: 'forecast_horizon' },
  }), '10');
  check('forecast maps to thin forecast thread', forecast.activeThread && forecast.activeThread.kind === THREAD_KINDS.FORECAST);
  check('forecast period copied', forecast.activeThread.period && forecast.activeThread.period.label === 'forecast_horizon');

  const afford = deriveConversationCapsule(baseState({
    lastCapability: 'affordability_or_planning',
    lastSubjectKind: 'amount',
    lastSubjectValue: '800',
    lastPurchaseDate: '2026-08-22',
    pendingInvitation: {
      kind: 'add_affordability_expense',
      amount: 800,
      date: '2026-08-22',
      accountId: '10',
      status: 'offered',
    },
  }), '10');
  check('affordability kind', afford.activeThread && afford.activeThread.kind === THREAD_KINDS.AFFORDABILITY);
  check('affordability user-stated amount/date', afford.activeThread.amount === 800 && afford.activeThread.purchaseDate === '2026-08-22');
  check('affordability omits invitation', hasAnyKey(serialized(afford), ['pendingInvitation', 'add_affordability_expense']) === false);

  section('3A.1 zombie lastX — lastCapability wins');

  const zombies = baseState({
    lastCapability: 'cashflow_upcoming',
    lastComparison: {
      periodA: { start: '2026-06-01', end: '2026-06-30', label: 'June 2026' },
      periodB: { start: '2026-07-01', end: '2026-07-31', label: 'July 2026' },
      windowKind: 'full_calendar_month',
    },
    lastRecurring: { metricScope: 'expense', rankingMode: 'largest' },
    lastUpcoming: {
      period: { start: '2026-08-23', end: '2026-08-29', label: 'next_week', relation: 'next_week' },
      metricScope: 'expense',
    },
    lastTrend: {
      periods: [{ start: '2026-05-01', end: '2026-05-31', label: 'May 2026' }],
      metricScope: 'spending',
    },
  });
  const beforeZ = snapshot(zombies);
  const zCap = deriveConversationCapsule(zombies, '10');
  check('zombie activeThread is upcoming only', zCap.activeThread && zCap.activeThread.kind === THREAD_KINDS.UPCOMING);
  check('zombie does not become comparison', zCap.activeThread.periodA === undefined);
  check('zombie does not become recurring', zCap.activeThread.rankingMode === undefined);
  check('zombie dialogue state unchanged', snapshot(zombies) === beforeZ);

  section('3A.1 account binding');

  const bound = deriveConversationCapsule(baseState({
    lastCapability: 'cashflow_recurring',
    lastRecurring: { metricScope: 'income', rankingMode: null },
  }), '10');
  check('account match yields thread', bound.activeThread && bound.activeThread.kind === THREAD_KINDS.RECURRING);

  const mismatchDs = baseState({
    lastCapability: 'cashflow_upcoming',
    lastUpcoming: {
      period: { start: '2026-08-23', end: '2026-08-29', label: 'next_week', relation: 'next_week' },
      metricScope: 'expense',
    },
  });
  const beforeMis = snapshot(mismatchDs);
  const mismatch = deriveConversationCapsule(mismatchDs, '99');
  check('account mismatch null thread', mismatch.activeThread === null);
  check('account mismatch reason', mismatch.invalidReason === INVALID.ACCOUNT_MISMATCH);
  check('account mismatch keeps legacy accountId', mismatch.accountId === '10');
  check('account mismatch does not mutate dialogue', snapshot(mismatchDs) === beforeMis);
  check('numeric/string account match', deriveConversationCapsule(baseState({
    lastCapability: 'cashflow_recurring',
    lastRecurring: { metricScope: 'all', rankingMode: null },
  }), 10).activeThread && deriveConversationCapsule(baseState({
    lastCapability: 'cashflow_recurring',
    lastRecurring: { metricScope: 'all', rankingMode: null },
  }), 10).activeThread.kind === THREAD_KINDS.RECURRING);

  const missingAcct = deriveConversationCapsule(Object.assign(emptyDialogueState(), {
    lastCapability: 'cashflow_recurring',
    lastRecurring: { metricScope: 'expense', rankingMode: null },
    updatedAt: '2026-08-17T16:00:00.000Z',
  }));
  check('missing lastAccountId yields no thread', missingAcct.activeThread === null);
  check('missing lastAccountId reason', missingAcct.invalidReason === INVALID.MISSING_ACCOUNT);

  section('3A.1 malformed / unknown capability');

  const malformed = deriveConversationCapsule(baseState({
    lastCapability: 'cashflow_recurring',
    lastRecurring: { metricScope: 'not-a-scope', rankingMode: 'largest' },
    lastUpcoming: {
      period: { start: '2026-08-23', end: '2026-08-29', relation: 'next_week' },
      metricScope: 'expense',
    },
  }), '10');
  check('malformed recurring does not fall back to zombie upcoming', malformed.activeThread === null);
  check('malformed reason', malformed.invalidReason === INVALID.MALFORMED_THREAD);

  const unsupportedCaps = [
    'unknown',
    'product_help',
    'casual_conversation',
    'navigation_ui',
    'simulation',
    'transaction_write',
    'goal_write',
    'confirmation',
    'mixed_macro',
  ];
  let allUnsupported = true;
  for (const cap of unsupportedCaps) {
    const got = deriveConversationCapsule(baseState({ lastCapability: cap }), '10');
    if (got.activeThread != null) allUnsupported = false;
  }
  check('non-V1 capabilities have no financial thread', allUnsupported === true);

  section('3A.1 write / invitation / UI / recentWrites exclusion');

  const armed = baseState({
    lastCapability: 'cashflow_analysis',
    lastPeriod: { start: '2026-08-01', end: '2026-08-31', label: 'August 2026' },
    draftTransaction: { title: 'Starbucks', type: 'expense', amount: 20, start: '2026-08-18' },
    pendingConfirmation: true,
    needsReconfirm: false,
    intent: 'create',
    committed: false,
    lastCommitSignature: 'sig',
    draftGoal: { title: 'Vacation' },
    pendingGoalConfirmation: true,
    goalNeedsReconfirm: false,
    goalIntent: 'create',
    pendingInvitation: { kind: 'add_affordability_expense', amount: 20, date: '2026-08-18', accountId: '10', status: 'offered' },
    uiReferent: { type: 'transaction', id: 77, label: 'Miro' },
    recentWrites: [{ action: 'create', transaction_id: 9, title: 'Coffee', amount: 5 }],
    recentToolOutcomes: [{ name: 'createTransaction' }],
  });
  const armedCap = deriveConversationCapsule(armed, '10');
  const armedJson = serialized(armedCap);
  check('write fields absent', hasAnyKey(armedJson, WRITE_KEYS) === false);
  check('invitation absent', armedJson.includes('pendingInvitation') === false && armedJson.includes('add_affordability_expense') === false);
  check('uiReferent absent', armedJson.includes('uiReferent') === false && armedJson.includes('Miro') === false);
  check('recentWrites absent', armedJson.includes('recentWrites') === false && armedJson.includes('Coffee') === false);
  check('recentToolOutcomes absent', armedJson.includes('recentToolOutcomes') === false);
  check('evidence keys absent', hasAnyKey(armedJson, EVIDENCE_KEYS) === false);

  section('3A.1 helper API does not take history/summary');

  check('derive arity is dialogueState + optional account', deriveConversationCapsule.length === 2);
  check('no history in exports', Object.prototype.hasOwnProperty.call(require('../services/keaConversationCapsule'), 'summarize') === false);

  section('3A.1 serialized size');

  const largest = deriveConversationCapsule(baseState({
    lastCapability: 'cashflow_trend',
    lastTrend: {
      periods: [
        { start: '2026-05-01', end: '2026-05-31', label: 'May 2026' },
        { start: '2026-06-01', end: '2026-06-30', label: 'June 2026' },
        { start: '2026-07-01', end: '2026-07-31', label: 'July 2026' },
      ],
      windowKind: 'last_3_calendar_months',
      metricScope: 'spending',
      categoryFilter: 'restaurants-and-dining-out',
    },
  }), '10');
  const sizes = {
    empty: Buffer.byteLength(serialized(empty), 'utf8'),
    comparison: Buffer.byteLength(serialized(cmp), 'utf8'),
    trend: Buffer.byteLength(serialized(trend), 'utf8'),
    recurring: Buffer.byteLength(serialized(rec), 'utf8'),
    upcoming: Buffer.byteLength(serialized(up), 'utf8'),
    horizon: Buffer.byteLength(serialized(horizon), 'utf8'),
    lookup: Buffer.byteLength(serialized(lookup), 'utf8'),
    analysis: Buffer.byteLength(serialized(analysis), 'utf8'),
    forecast: Buffer.byteLength(serialized(forecast), 'utf8'),
    affordability: Buffer.byteLength(serialized(afford), 'utf8'),
    largest: Buffer.byteLength(serialized(largest), 'utf8'),
  };
  console.log('  capsule byte sizes:', sizes);
  check('largest V1 thread under 1KB', sizes.largest < 1024, `${sizes.largest} bytes`);
  check('all representative types under 1KB', Object.values(sizes).every((n) => n < 1024));

  section('3A.1 updatedAt contract');

  const noTs = deriveConversationCapsule({
    lastCapability: 'cashflow_recurring',
    lastAccountId: '10',
    lastRecurring: { metricScope: 'all', rankingMode: null },
  }, '10');
  check('missing updatedAt is null, not fabricated', noTs.updatedAt === null && noTs.activeThread && noTs.activeThread.updatedAt === null);
}

module.exports = { run };

if (require.main === module) {
  run().then(() => {
    const { failed } = require('./harness').totals();
    process.exit(failed === 0 ? 0 : 1);
  });
}
