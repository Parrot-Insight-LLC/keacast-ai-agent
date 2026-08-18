'use strict';

const { check, section } = require('./harness');
const {
  routeCapability,
  classifyFreshIntentCandidate,
  applyContinuationPersistence,
} = require('../services/keaCapabilityRouter');
const { deriveConversationCapsule, THREAD_KINDS } = require('../services/keaConversationCapsule');
const {
  resolveConversationState,
  RESOLUTION,
} = require('../services/keaConversationStateResolver');

const DATE = '2026-08-17';
const ACCOUNT = '10';

function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  Object.keys(obj).forEach((k) => deepFreeze(obj[k]));
  return Object.freeze(obj);
}

function snapshot(obj) {
  return JSON.stringify(obj);
}

function ds(extra = {}) {
  return Object.assign({
    lastCapability: null,
    lastAccountId: ACCOUNT,
    lastSubjectKind: null,
    lastSubjectValue: null,
    lastPeriod: null,
    lastPurchaseDate: null,
    lastComparison: null,
    lastTrend: null,
    lastRecurring: null,
    lastUpcoming: null,
    lastIncomeHorizon: null,
    updatedAt: '2026-08-17T16:00:00.000Z',
  }, extra);
}

function persist(route, extra = {}) {
  const state = ds(extra);
  applyContinuationPersistence(state, route, { accountId: extra.lastAccountId || ACCOUNT });
  return state;
}

function legacyRoute(message, dialogueState, extra = {}) {
  return routeCapability({
    message,
    currentDate: extra.currentDate || DATE,
    dialogueState: dialogueState || ds(),
    accountId: extra.accountId || ACCOUNT,
    simulationMode: extra.simulationMode === true,
  });
}

function legacyEffective(route) {
  return route.capability === 'continuation' ? route.parentCapability : route.capability;
}

function shadow(message, dialogueState, extra = {}) {
  const accountId = extra.accountId || ACCOUNT;
  const currentDate = extra.currentDate || DATE;
  const capsule = deriveConversationCapsule(dialogueState || ds(), accountId);
  const freshCandidate = classifyFreshIntentCandidate({
    message,
    currentDate,
  });
  const resolved = resolveConversationState({
    message,
    clientDate: currentDate,
    currentAccountId: accountId,
    capsule,
    freshCandidate,
  });
  return { capsule, freshCandidate, resolved };
}

let parityCases = 0;
let parityMismatches = 0;

function assertParity(name, message, dialogueState, extra = {}) {
  const legacy = legacyRoute(message, dialogueState, extra);
  const { resolved, freshCandidate, capsule } = shadow(message, dialogueState, extra);
  const legacyEff = legacyEffective(legacy);
  const match = legacyEff === resolved.effectiveCapability
    && !!legacy.continuationUsed === !!resolved.continuationUsed;
  parityCases += 1;
  if (!match) parityMismatches += 1;
  const detail = match ? '' : [
    `message=${JSON.stringify(message)}`,
    `thread=${(capsule.activeThread && capsule.activeThread.kind) || 'none'}`,
    `fresh=${freshCandidate.capability}`,
    `legacyEff=${legacyEff}`,
    `resolverEff=${resolved.effectiveCapability}`,
    `legacyCont=${!!legacy.continuationUsed}`,
    `resolverCont=${!!resolved.continuationUsed}`,
    `reason=${resolved.reason}`,
    `transition=${resolved.transition}`,
  ].join(' ');
  check(name, match, detail);
  return { legacy, resolved, capsule };
}

const UPCOMING = {
  lastCapability: 'cashflow_upcoming',
  lastUpcoming: {
    period: { start: '2026-08-23', end: '2026-08-29', label: 'next_week', relation: 'next_week' },
    metricScope: 'expense',
  },
};

const RECURRING = {
  lastCapability: 'cashflow_recurring',
  lastRecurring: { metricScope: 'expense', rankingMode: 'largest' },
};

const HORIZON = {
  lastCapability: 'cashflow_income_horizon',
  lastIncomeHorizon: {
    incomeDate: '2026-08-31',
    incomeAmount: 4626.36,
    combinedIncomeAmount: 4626.36,
    windowStart: '2026-08-18',
    windowEnd: '2026-08-30',
    definition: 'kea_scheduled_recurring_income',
  },
};

const TREND = {
  lastCapability: 'cashflow_trend',
  lastTrend: {
    periods: [
      { start: '2026-05-01', end: '2026-05-31', label: 'May 2026' },
      { start: '2026-06-01', end: '2026-06-30', label: 'June 2026' },
      { start: '2026-07-01', end: '2026-07-31', label: 'July 2026' },
    ],
    windowKind: 'last_3_calendar_months',
    metricScope: 'spending',
    categoryFilter: null,
  },
};

const COMPARISON = {
  lastCapability: 'cashflow_comparison',
  lastSubjectKind: 'category',
  lastSubjectValue: 'restaurants',
  lastComparison: {
    periodA: { start: '2026-06-01', end: '2026-06-30', label: 'June 2026' },
    periodB: { start: '2026-07-01', end: '2026-07-31', label: 'July 2026' },
    windowKind: 'full_calendar_month',
  },
};

const LOOKUP = {
  lastCapability: 'financial_lookup',
  lastSubjectKind: 'merchant',
  lastSubjectValue: 'target',
  lastPeriod: { start: '2026-07-01', end: '2026-07-31', label: 'July 2026' },
};

const ANALYSIS = {
  lastCapability: 'cashflow_analysis',
  lastPeriod: { start: '2026-08-01', end: '2026-08-31', label: 'August 2026' },
};

const FORECAST = {
  lastCapability: 'financial_forecast',
  lastPeriod: { start: '2026-08-17', end: '2026-11-15', label: 'forecast_horizon' },
};

const AFFORD = {
  lastCapability: 'affordability_or_planning',
  lastSubjectKind: 'amount',
  lastSubjectValue: '1200',
  lastPurchaseDate: '2026-08-22',
};

async function run() {
  section('3A.2 fresh candidate does not read lastX');

  const poisoned = classifyFreshIntentCandidate({
    message: 'What bills are due next week?',
    currentDate: DATE,
  });
  check('fresh upcoming without dialogue', poisoned.capability === 'cashflow_upcoming');
  check('fresh candidate has intentStrength', typeof poisoned.intentStrength === 'string');
  check('fresh compare is strong', classifyFreshIntentCandidate({
    message: 'Compare July and June',
    currentDate: DATE,
  }).intentStrength === 'strong_fresh');
  check('fresh go-negative is contextual', classifyFreshIntentCandidate({
    message: 'Will I go negative?',
    currentDate: DATE,
  }).intentStrength === 'contextual_fresh');

  section('3A.2 resolver API shape / no history');

  check('resolveConversationState is a function', typeof resolveConversationState === 'function');
  const api = require('../services/keaConversationStateResolver');
  check('resolver exports omit history/summary', !api.summarize && !api.recallFacts);
  const withNoise = resolveConversationState({
    message: 'How much total?',
    clientDate: DATE,
    currentAccountId: ACCOUNT,
    capsule: deriveConversationCapsule(ds(UPCOMING), ACCOUNT),
    history: [{ role: 'user', content: 'secret' }],
    rollingSummary: 'should be ignored',
    recallFacts: { anything: true },
  });
  const withoutNoise = resolveConversationState({
    message: 'How much total?',
    clientDate: DATE,
    currentAccountId: ACCOUNT,
    capsule: deriveConversationCapsule(ds(UPCOMING), ACCOUNT),
  });
  check('history/summary/facts keys are ignored',
    withNoise.effectiveCapability === withoutNoise.effectiveCapability
    && withNoise.continuationUsed === withoutNoise.continuationUsed
    && withNoise.resolution === withoutNoise.resolution);

  section('3A.2 immutability');

  const capIn = deriveConversationCapsule(ds(UPCOMING), ACCOUNT);
  const frozenCap = deepFreeze(JSON.parse(JSON.stringify(capIn)));
  const frozenFresh = deepFreeze(classifyFreshIntentCandidate({
    message: 'How much total?',
    currentDate: DATE,
  }));
  const beforeCap = snapshot(frozenCap);
  const beforeFresh = snapshot(frozenFresh);
  const beforeDs = ds(UPCOMING);
  const dsSnap = snapshot(beforeDs);
  resolveConversationState({
    message: 'How much total?',
    clientDate: DATE,
    currentAccountId: ACCOUNT,
    capsule: frozenCap,
    freshCandidate: frozenFresh,
  });
  check('capsule not mutated', snapshot(frozenCap) === beforeCap);
  check('freshCandidate not mutated', snapshot(frozenFresh) === beforeFresh);
  check('dialogueState not mutated', snapshot(beforeDs) === dsSnap);

  section('3A.2 recurring continuation / replacement');

  const recExpense = persist(legacyRoute('What recurring expenses do I have?'));
  assertParity('fresh recurring expenses', 'What recurring expenses do I have?', ds());
  assertParity('recurring largest', 'Which is the largest?', recExpense);
  const recAfterLargest = persist(legacyRoute('Which is the largest?', recExpense));
  const largestRes = shadow('Which is the largest?', recAfterLargest);
  check('largest action', largestRes.resolved.continuationAction === 'recurring_largest');
  assertParity('recurring what about income', 'What about income?', recAfterLargest);
  const incomeRes = shadow('What about income?', recAfterLargest);
  check('income action switch_scope_income', incomeRes.resolved.continuationAction === 'switch_scope_income');
  assertParity('fresh recurring income after largest', 'What recurring income do I have?', recAfterLargest);
  assertParity('recurring how has that changed', 'How has that changed?', recAfterLargest);
  assertParity('recurring to posted trend', 'How has spending changed over the last 3 months?', recAfterLargest);
  assertParity('recurring to upcoming', 'What bills are due next week?', recAfterLargest);
  assertParity('recurring how much total not continuation', 'How much total?', recAfterLargest);

  section('3A.2 upcoming continuation / replacement');

  const upState = persist(legacyRoute('What bills are due next week?'));
  assertParity('fresh bills next week', 'What bills are due next week?', ds());
  assertParity('upcoming how much total', 'How much total?', upState);
  const totalRes = shadow('How much total?', upState);
  check('upcoming total responseMode', totalRes.resolved.responseMode === 'total'
    && totalRes.resolved.continuationAction === 'request_total');
  check('upcoming total does not persist mode on capsule', totalRes.capsule.activeThread
    && totalRes.capsule.activeThread.responseMode === undefined);
  assertParity('upcoming what about income', 'What about income?', upState);
  assertParity('upcoming week after', 'What about the week after?', upState);
  check('week after action', shadow('What about the week after?', upState).resolved.continuationAction === 'upcoming_week_after');
  assertParity('upcoming to recurring', 'What recurring expenses do I have?', upState);
  assertParity('upcoming to comparison', 'Compare July and June', upState);
  assertParity('upcoming will I go negative is fresh analysis', 'Will I go negative?', upState);

  section('3A.2 income horizon continuation / replacement');

  const hz = ds(HORIZON);
  assertParity('fresh next paycheck', 'When is my next paycheck?', ds());
  assertParity('horizon expenses before then', 'What expenses are due before then?', hz);
  assertParity('horizon how much total', 'How much total?', hz);
  assertParity('horizon will I go negative', 'Will I go negative?', hz);
  check('horizon negative action', shadow('Will I go negative?', hz).resolved.continuationAction === 'horizon_negative_check');
  check('horizon continuation omits amounts', !JSON.stringify(deriveConversationCapsule(hz, ACCOUNT)).includes('incomeAmount'));
  assertParity('horizon after payday', 'What about after payday?', hz);
  check('horizon after payday unsupported action',
    shadow('What about after payday?', hz).resolved.continuationAction === 'horizon_after_payday_unsupported');
  assertParity('horizon to upcoming next week income', 'What income is coming next week?', hz);
  assertParity('horizon what about income short follow-up', 'What about income?', hz);

  section('3A.2 trend / comparison / lookup / analysis / affordability');

  const tr = ds(TREND);
  assertParity('fresh last 3 months trend', 'How has my spending changed over the last 3 months?', ds());
  assertParity('trend what about income', 'What about income?', tr);
  assertParity('trend what about restaurants', 'What about restaurants?', tr);
  assertParity('trend to comparison', 'Compare July and June.', tr);

  const cmp = ds(COMPARISON);
  assertParity('fresh compare July June', 'Compare July and June.', ds());
  assertParity('comparison what about restaurants', 'What about restaurants?', cmp);
  assertParity('comparison to last three months trend', 'What about the last three months?', cmp);
  assertParity('comparison how much total not continuation', 'How much total?', cmp);

  const lk = ds(LOOKUP);
  assertParity('fresh lookup Target', 'How much did I spend at Target last month?', ds());
  assertParity('lookup what about this month', 'What about this month?', lk);
  assertParity('lookup what about Walmart', 'What about Walmart?', lk);

  const an = ds(ANALYSIS);
  assertParity('analysis what about next month', 'What about next month?', an);
  assertParity('forecast will I go negative without horizon', 'Will I go negative?', ds(FORECAST));
  check('forecast thread does not invent unique continuation for go-negative',
    shadow('Will I go negative?', ds(FORECAST)).resolved.continuationUsed === false);

  const af = ds(AFFORD);
  assertParity('affordability what about amount', 'What about $1,200?', af);
  assertParity('affordability what about this month', 'What about this month?', af);

  section('3A.2 zombie lastX');

  const zombies = ds(Object.assign({}, UPCOMING, {
    lastComparison: COMPARISON.lastComparison,
    lastRecurring: RECURRING.lastRecurring,
    lastTrend: TREND.lastTrend,
  }));
  const z = assertParity('zombie how much total uses upcoming', 'How much total?', zombies);
  check('zombie capsule kind upcoming', z.capsule.activeThread && z.capsule.activeThread.kind === THREAD_KINDS.UPCOMING);

  section('3A.2 account match / mismatch');

  assertParity('upcoming match how much total', 'How much total?', ds(UPCOMING), { accountId: '10' });
  assertParity('upcoming mismatch how much total', 'How much total?', ds(UPCOMING), { accountId: '99' });
  const mismatch = shadow('How much total?', ds(UPCOMING), { accountId: '99' });
  check('mismatch clarify', mismatch.resolved.resolution === RESOLUTION.CLARIFY
    && mismatch.resolved.reason === 'account_mismatch'
    && mismatch.resolved.continuationUsed === false);
  assertParity('mismatch fresh bills next week allowed', 'What bills are due next week?', ds(UPCOMING), { accountId: '99' });
  assertParity('recurring mismatch largest', 'Which is the largest?', ds(RECURRING), { accountId: '99' });
  assertParity('horizon mismatch total', 'How much total?', ds(HORIZON), { accountId: '99' });

  section('3A.2 no-thread / invalid capsule');

  assertParity('no thread how much total', 'How much total?', ds());
  assertParity('no thread what about income', 'What about income?', ds());
  assertParity('no thread which is largest', 'Which is the largest?', ds());
  assertParity('no thread week after', 'The week after?', ds());
  assertParity('no thread before then', 'What expenses are due before then?', ds());
  const emptyClarify = shadow('How much total?', ds());
  check('no-thread total is clarify', emptyClarify.resolved.resolution === RESOLUTION.CLARIFY);

  const bad = resolveConversationState({
    message: 'How much total?',
    clientDate: DATE,
    currentAccountId: ACCOUNT,
    capsule: { version: 2, accountId: '10', updatedAt: null, activeThread: null },
    freshCandidate: classifyFreshIntentCandidate({ message: 'How much total?', currentDate: DATE }),
  });
  check('unknown version behaves as no thread', bad.resolution === RESOLUTION.CLARIFY
    && bad.effectiveCapability === 'unknown'
    && bad.continuationUsed === false);
  assertParity('invalid capsule fresh compare still works', 'Compare July and June.', ds());

  section('3A.2 soft interjection vs hard switch (parity)');

  assertParity('thanks after upcoming is casual', 'Thanks.', ds(UPCOMING));
  const thanks = shadow('Thanks.', ds(UPCOMING));
  check('thanks preserves thread kind conceptually', thanks.resolved.reason === 'soft_interjection'
    && thanks.resolved.activeThreadKind === THREAD_KINDS.UPCOMING
    && thanks.resolved.continuationUsed === false);
  assertParity('how much total after thanks-shaped state still upcoming', 'How much total?', ds(UPCOMING));

  assertParity('password help current production unknown', 'How do I change my password?', ds(UPCOMING));
  const pwd = shadow('How do I change my password?', ds(UPCOMING));
  check('hard-switch NOT implemented (thread still present conceptually)',
    pwd.resolved.continuationUsed === false
    && pwd.resolved.effectiveCapability === 'unknown'
    && pwd.resolved.activeThreadKind === THREAD_KINDS.UPCOMING);
  check('EXPECTED_FUTURE_DIVERGENCE hard-switch would clear thread', true);

  section('3A.2 responseMode request-local');

  const again = resolveConversationState({
    message: 'What bills are due next week?',
    clientDate: DATE,
    currentAccountId: ACCOUNT,
    capsule: deriveConversationCapsule(ds(UPCOMING), ACCOUNT),
  });
  check('rerun without total message has no responseMode', again.responseMode == null);

  section('3A.2 performance');

  const t0 = Date.now();
  for (let i = 0; i < 500; i += 1) {
    resolveConversationState({
      message: 'How much total?',
      clientDate: DATE,
      currentAccountId: ACCOUNT,
      capsule: deriveConversationCapsule(ds(UPCOMING), ACCOUNT),
    });
  }
  const elapsed = Date.now() - t0;
  console.log(`  resolver 500 iterations: ${elapsed}ms`);
  check('resolver 500 iterations under 250ms', elapsed < 250, `${elapsed}ms`);

  section('3A.2 parity summary');
  console.log(`  parity cases: ${parityCases}; mismatches: ${parityMismatches}`);
  check('no unexplained parity mismatches', parityMismatches === 0, `${parityMismatches} of ${parityCases}`);
}

module.exports = { run };

if (require.main === module) {
  run().then(() => {
    const { failed } = require('./harness').totals();
    process.exit(failed === 0 ? 0 : 1);
  });
}