'use strict';

const { check, section } = require('./harness');
const {
  routeCapability,
  applyContinuationPersistence,
} = require('../services/keaCapabilityRouter');
const { shiftCalendarWeek } = require('../services/keaUpcomingPeriod');
const {
  CAPSULE_VERSION,
  THREAD_KINDS,
  projectConversationCapsule,
  syncConversationCapsule,
  persistedCapsuleEqualsProjection,
  capsuleTelemetryFields,
} = require('../services/keaConversationCapsule');
const { __testables: T } = require('../controllers/openaiController');
const { createKeaTelemetry } = require('../services/keaTelemetry');

const DATE = '2026-08-17';
const ACCOUNT = '10';

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

function route(message, extra = {}) {
  return routeCapability({
    message,
    currentDate: extra.currentDate || DATE,
    dialogueState: extra.dialogueState || T.emptyDialogueState(),
    accountId: extra.accountId || ACCOUNT,
  });
}

function persist(ds, routed, extra = {}) {
  return applyContinuationPersistence(ds, routed, {
    accountId: extra.accountId || ACCOUNT,
    failSoft: extra.failSoft === true,
  });
}

function assertProjection(name, ds) {
  check(name, persistedCapsuleEqualsProjection(ds));
}

function capsuleJson(ds) {
  return JSON.stringify(ds.capsule || {});
}

async function run() {
  section('3A.3 empty contract / project helper');

  const empty = T.emptyDialogueState();
  check('emptyDialogueState.capsule is null', empty.capsule === null);
  check('project empty is null', projectConversationCapsule(empty) === null);
  check('project strips invalidReason empty-thread', (() => {
    const projected = projectConversationCapsule({
      lastCapability: 'cashflow_upcoming',
      lastAccountId: null,
      lastUpcoming: { period: { start: '2026-08-23', end: '2026-08-29', relation: 'next_week' }, metricScope: 'expense' },
    });
    return projected === null;
  })());

  section('3A.3 recurring projection');

  const rec = T.emptyDialogueState();
  persist(rec, route('What recurring expenses do I have?'));
  check('recurring lastCapability', rec.lastCapability === 'cashflow_recurring');
  check('recurring capsule kind', rec.capsule && rec.capsule.activeThread.kind === THREAD_KINDS.RECURRING);
  check('recurring metricScope expense ranking null', rec.capsule.activeThread.metricScope === 'expense'
    && rec.capsule.activeThread.rankingMode === null);
  assertProjection('recurring projection parity', rec);

  persist(rec, route('Which is the largest?', { dialogueState: rec }));
  check('recurring largest rankingMode', rec.capsule.activeThread.rankingMode === 'largest');
  assertProjection('recurring largest parity', rec);

  persist(rec, route('What about income?', { dialogueState: rec }));
  check('recurring income keeps largest', rec.capsule.activeThread.metricScope === 'income'
    && rec.capsule.activeThread.rankingMode === 'largest');
  assertProjection('recurring income parity', rec);

  section('3A.3 upcoming projection');

  const up = T.emptyDialogueState();
  persist(up, route('What bills are due next week?'));
  check('upcoming capsule kind', up.capsule && up.capsule.activeThread.kind === THREAD_KINDS.UPCOMING);
  check('upcoming absolute period', up.capsule.activeThread.period.start === '2026-08-23'
    && up.capsule.activeThread.period.end === '2026-08-29'
    && up.capsule.activeThread.period.relation === 'next_week'
    && up.capsule.activeThread.metricScope === 'expense');
  assertProjection('upcoming projection parity', up);

  const beforeTotal = JSON.stringify(up.capsule.activeThread);
  persist(up, route('How much total?', { dialogueState: up }));
  check('total does not persist responseMode', up.capsule.activeThread.responseMode === undefined);
  check('total period unchanged', JSON.stringify(up.capsule.activeThread.period) === JSON.parse(beforeTotal).period
    ? true
    : (up.capsule.activeThread.period.start === '2026-08-23' && up.capsule.activeThread.period.end === '2026-08-29'));
  assertProjection('upcoming total parity', up);

  persist(up, route('What about income?', { dialogueState: up }));
  check('upcoming income same period', up.capsule.activeThread.period.start === '2026-08-23'
    && up.capsule.activeThread.metricScope === 'income');
  assertProjection('upcoming income parity', up);

  const weekAfter = route('What about the week after?', { dialogueState: up });
  persist(up, weekAfter);
  const shifted = shiftCalendarWeek({ start: '2026-08-23', end: '2026-08-29', relation: 'next_week' });
  check('week after Capsule uses legacy shifted dates', up.capsule.activeThread.period.start === shifted.start
    && up.capsule.activeThread.period.end === shifted.end);
  assertProjection('week after parity', up);

  section('3A.3 income horizon projection');

  const hz = T.emptyDialogueState();
  persist(hz, {
    capability: 'cashflow_income_horizon',
    confidence: 'high',
    slots: {
      incomeDate: '2026-08-31',
      incomeAmount: 4626.36,
      combinedIncomeAmount: 4626.36,
      windowStart: '2026-08-18',
      windowEnd: '2026-08-30',
    },
  });
  check('horizon capsule kind', hz.capsule && hz.capsule.activeThread.kind === THREAD_KINDS.INCOME_HORIZON);
  check('horizon dates', hz.capsule.activeThread.incomeDate === '2026-08-31'
    && hz.capsule.activeThread.windowStart === '2026-08-18'
    && hz.capsule.activeThread.windowEnd === '2026-08-30'
    && hz.capsule.activeThread.definition === 'kea_scheduled_recurring_income');
  check('horizon Capsule omits amounts', hz.capsule.activeThread.incomeAmount === undefined
    && hz.capsule.activeThread.combinedIncomeAmount === undefined
    && !capsuleJson(hz).includes('incomeAmount'));
  check('legacy lastX still has amount', hz.lastIncomeHorizon.incomeAmount === 4626.36);
  assertProjection('horizon projection parity', hz);

  const hzThread = JSON.stringify(hz.capsule.activeThread);
  persist(hz, route('How much total?', { dialogueState: hz }));
  check('horizon total does not persist responseMode', hz.capsule.activeThread.responseMode === undefined);
  persist(hz, route('Will I go negative?', { dialogueState: hz }));
  check('horizon negative referent unchanged', hz.capsule.activeThread.incomeDate === '2026-08-31');
  check('horizon thread still omit amounts', !capsuleJson(hz).includes('incomeAmount'));
  assertProjection('horizon follow-up parity', hz);
  check('horizon thread keys stable aside from timestamps',
    JSON.parse(hzThread).incomeDate === hz.capsule.activeThread.incomeDate);

  section('3A.3 trend / comparison / lookup / analysis / forecast / affordability');

  const tr = T.emptyDialogueState();
  persist(tr, route('How has my spending changed over the last 3 months?'));
  check('trend capsule kind', tr.capsule && tr.capsule.activeThread.kind === THREAD_KINDS.TREND);
  check('trend has periods', Array.isArray(tr.capsule.activeThread.periods) && tr.capsule.activeThread.periods.length >= 1);
  assertProjection('trend projection parity', tr);

  persist(tr, route('Compare July and June.', { dialogueState: tr }));
  check('fresh comparison replaces trend kind', tr.capsule.activeThread.kind === THREAD_KINDS.COMPARISON);
  check('comparison has no trend categoryFilter', tr.capsule.activeThread.categoryFilter === undefined);
  check('zombie lastTrend still present', tr.lastTrend != null);
  assertProjection('comparison-after-trend parity', tr);

  persist(tr, route('What recurring expenses do I have?', { dialogueState: tr }));
  check('fresh recurring replaces comparison', tr.capsule.activeThread.kind === THREAD_KINDS.RECURRING);
  check('zombie lastComparison still present', tr.lastComparison != null);
  assertProjection('recurring-after-comparison parity', tr);

  const lk = T.emptyDialogueState();
  persist(lk, route('How much did I spend at Target last month?'));
  check('lookup capsule kind', lk.capsule && lk.capsule.activeThread.kind === THREAD_KINDS.LOOKUP);
  persist(lk, route('What about Walmart?', { dialogueState: lk }));
  check('lookup subject follows legacy persist', lk.capsule.activeThread.subjectValue === lk.lastSubjectValue);
  check('lookup Capsule has no totals', !/spentTotal|expenseTotal/.test(capsuleJson(lk)));
  assertProjection('lookup projection parity', lk);

  const an = T.emptyDialogueState();
  persist(an, route('How am I doing this month?'));
  check('analysis capsule kind', an.capsule && an.capsule.activeThread.kind === THREAD_KINDS.ANALYSIS);
  check('analysis has no negative-balance result', !/lowestBalance|firstNegative/.test(capsuleJson(an)));
  assertProjection('analysis projection parity', an);

  const fc = T.emptyDialogueState();
  persist(fc, route('Will I go negative?', { dialogueState: T.emptyDialogueState() }));
  const forecastCap = fc.lastCapability;
  check('forecast/analysis persist is thin thread',
    (forecastCap === 'financial_forecast' && fc.capsule.activeThread.kind === THREAD_KINDS.FORECAST)
    || (forecastCap === 'cashflow_analysis' && fc.capsule.activeThread.kind === THREAD_KINDS.ANALYSIS));
  check('forecast Capsule has no rows', !/projectedBalances|forecastRows/.test(capsuleJson(fc)));
  assertProjection('forecast/analysis go-negative parity', fc);

  const af = T.emptyDialogueState();
  persist(af, route('Can I afford $800 next Friday?'));
  check('affordability capsule kind', af.capsule && af.capsule.activeThread.kind === THREAD_KINDS.AFFORDABILITY);
  check('affordability maps lastX amount/date referents',
    (af.lastSubjectKind !== 'amount' || af.capsule.activeThread.amount === Number(af.lastSubjectValue))
    && (!af.lastPurchaseDate || af.capsule.activeThread.purchaseDate === af.lastPurchaseDate));
  check('affordability has no invitation', !capsuleJson(af).includes('pendingInvitation'));
  check('pendingInvitation not copied', af.pendingInvitation === null);
  assertProjection('affordability projection parity', af);

  section('3A.3 zombies / replacement / evidence exclusion');

  const zombies = T.emptyDialogueState();
  persist(zombies, route('Compare July and June.'));
  persist(zombies, route('How has my spending changed over the last 3 months?', { dialogueState: zombies }));
  persist(zombies, route('What recurring expenses do I have?', { dialogueState: zombies }));
  persist(zombies, route('What bills are due next week?', { dialogueState: zombies }));
  check('one activeThread upcoming', zombies.capsule.activeThread.kind === THREAD_KINDS.UPCOMING);
  check('zombies remain on lastX', !!(zombies.lastComparison && zombies.lastTrend && zombies.lastRecurring && zombies.lastUpcoming));
  assertProjection('zombie lastX projection parity', zombies);

  const blob = capsuleJson(zombies);
  EVIDENCE_KEYS.forEach((key) => {
    check(`upcoming Capsule omits ${key}`, blob.indexOf(key) === -1);
  });
  check('Capsule version 1', zombies.capsule.version === CAPSULE_VERSION);
  check('no invalidReason persisted', zombies.capsule.invalidReason === undefined);
  check('accountId matches lastAccountId', zombies.capsule.accountId === zombies.lastAccountId);

  section('3A.3 casual / help / fail-soft / account switch');

  const thanks = T.emptyDialogueState();
  persist(thanks, route('What bills are due next week?'));
  const thanksCap = JSON.stringify(thanks.capsule);
  persist(thanks, route('Thanks.', { dialogueState: thanks }));
  check('thanks does not persist financial lastX', thanks.lastCapability === 'cashflow_upcoming');
  check('thanks leaves Capsule upcoming', thanks.capsule && thanks.capsule.activeThread.kind === THREAD_KINDS.UPCOMING
    && JSON.stringify(thanks.capsule.activeThread.kind) === JSON.stringify(JSON.parse(thanksCap).activeThread.kind));

  persist(thanks, route('How do I change my password?', { dialogueState: thanks }));
  check('password hard-switch clears Capsule', thanks.capsule && thanks.capsule.activeThread == null);
  check('password leaves lastX zombie upcoming', thanks.lastCapability === 'cashflow_upcoming');

  const fail = T.emptyDialogueState();
  persist(fail, route('What bills are due next week?'), { failSoft: true });
  check('fail-soft does not persist lastX', fail.lastCapability === null && fail.capsule === null);

  persist(fail, route('What bills are due next week?'));
  const beforeFail = JSON.stringify(fail.capsule);
  persist(fail, route('What recurring expenses do I have?', { dialogueState: fail }), { failSoft: true });
  check('fail-soft does not replace Capsule', JSON.stringify(fail.capsule) === beforeFail
    && fail.lastCapability === 'cashflow_upcoming');

  const sw = T.emptyDialogueState();
  persist(sw, route('What bills are due next week?'), { accountId: '10' });
  const rejected = route('How much total?', { dialogueState: sw, accountId: '99' });
  persist(sw, rejected, { accountId: '99' });
  check('account mismatch clarifies and does not continue A on B',
    rejected.capability === 'conversation_clarify'
    && rejected.capsuleClear === true
    && rejected.continuationUsed === false);
  check('authoritative Capsule cleared, lastX remains A zombie',
    sw.capsule && sw.capsule.activeThread == null
    && sw.lastAccountId === '10'
    && sw.lastUpcoming != null);
  persist(sw, route('What bills are due next week?', { accountId: '99' }), { accountId: '99' });
  check('fresh B upcoming projects B', sw.capsule.accountId === '99'
    && sw.lastAccountId === '99'
    && sw.capsule.activeThread.kind === THREAD_KINDS.UPCOMING);
  assertProjection('account B projection parity', sw);

  section('3A.3 corrupt / old Redis / save timestamp');

  const corrupt = T.emptyDialogueState();
  persist(corrupt, route('What bills are due next week?'));
  const routedOnCorrupt = route('How much total?', {
    dialogueState: Object.assign({}, corrupt, { capsule: { version: 99, junk: true } }),
  });
  check('corrupt Capsule does not affect routing', routedOnCorrupt.capability === 'continuation'
    && routedOnCorrupt.parentCapability === 'cashflow_upcoming');
  corrupt.capsule = { version: 99, junk: true };
  persist(corrupt, routedOnCorrupt);
  check('persist overwrites corrupt Capsule', corrupt.capsule && corrupt.capsule.version === 1
    && corrupt.capsule.activeThread.kind === THREAD_KINDS.UPCOMING);
  assertProjection('corrupt recovery parity', corrupt);

  const oldRedis = {
    ...T.emptyDialogueState(),
    lastCapability: 'cashflow_upcoming',
    lastAccountId: '10',
    lastUpcoming: {
      period: { start: '2026-08-23', end: '2026-08-29', label: 'next_week', relation: 'next_week' },
      metricScope: 'expense',
    },
  };
  delete oldRedis.capsule;
  const merged = { ...T.emptyDialogueState(), ...oldRedis };
  check('old Redis merge capsule null', merged.capsule === null);
  check('old Redis still routes upcoming continuation',
    route('How much total?', { dialogueState: merged }).parentCapability === 'cashflow_upcoming');
  persist(merged, route('How much total?', { dialogueState: merged }));
  check('next persist backfills Capsule', merged.capsule && merged.capsule.activeThread.kind === THREAD_KINDS.UPCOMING);
  assertProjection('old Redis backfill parity', merged);

  const stamped = T.emptyDialogueState();
  persist(stamped, route('What bills are due next week?'));
  stamped.updatedAt = '2026-08-17T16:00:00.000Z';
  syncConversationCapsule(stamped);
  check('capsule.updatedAt matches dialogue after stamp',
    stamped.capsule.updatedAt === stamped.updatedAt
    && stamped.capsule.activeThread.updatedAt === stamped.updatedAt);
  assertProjection('timestamp stamp parity', stamped);

  const rollbackParsed = { extraUnused: true, capsule: { version: 1, accountId: '10', updatedAt: null, activeThread: null } };
  const rollbackLoad = { ...T.emptyDialogueState(), ...rollbackParsed };
  check('rollback extra capsule field is harmless', rollbackLoad.capsule != null && rollbackLoad.lastCapability === null);
  check('authoritative empty Capsule does not revive lastX-less thread',
    route('How much total?', { dialogueState: rollbackLoad }).capability === 'conversation_clarify');

  section('3A.3 write / invitation / UI exclusion');

  const writeDs = T.emptyDialogueState();
  writeDs.pendingConfirmation = true;
  writeDs.needsReconfirm = true;
  writeDs.draftTransaction = { title: 'Coffee', amount: -4, start: '2026-08-20' };
  persist(writeDs, route('What bills are due next week?'));
  check('write flags coexist', writeDs.needsReconfirm === true && writeDs.pendingConfirmation === true);
  check('Capsule has no write fields',
    writeDs.capsule.draftTransaction === undefined
    && writeDs.capsule.pendingConfirmation === undefined
    && writeDs.capsule.needsReconfirm === undefined
    && !capsuleJson(writeDs).includes('draftTransaction'));
  check('yes after financial question still has needsReconfirm', writeDs.needsReconfirm === true);
  assertProjection('write coexistence parity', writeDs);

  const invite = T.emptyDialogueState();
  invite.pendingInvitation = { kind: 'create', accountId: '10' };
  persist(invite, route('What bills are due next week?'));
  check('invitation remains independent', invite.pendingInvitation && invite.pendingInvitation.kind === 'create');
  check('Capsule omits invitation', !capsuleJson(invite).includes('pendingInvitation'));

  const ui = T.emptyDialogueState();
  ui.uiReferent = { type: 'transaction', id: 'x' };
  persist(ui, route('What bills are due next week?'));
  check('uiReferent remains separate', ui.uiReferent && ui.uiReferent.type === 'transaction');
  check('Capsule omits uiReferent', !capsuleJson(ui).includes('uiReferent'));
  check('Capsule omits history/summary', !capsuleJson(ui).includes('rollingSummary')
    && !capsuleJson(ui).includes('recallFacts'));

  section('3A.3 telemetry + size + performance');

  const tel = capsuleTelemetryFields(projectConversationCapsule(up), ACCOUNT);
  check('telemetry present', tel.capsule_present === true && tel.capsule_kind === 'upcoming' && tel.capsule_version === 1);
  check('telemetry account match true', tel.capsule_account_match === true);
  check('telemetry mismatch false', capsuleTelemetryFields(projectConversationCapsule(up), '99').capsule_account_match === false);
  check('telemetry empty', capsuleTelemetryFields(null, ACCOUNT).capsule_present === false
    && capsuleTelemetryFields(null, ACCOUNT).capsule_kind === 'none');

  const t = createKeaTelemetry({ requestId: 'cap-1' });
  t.recordGrounding({ continuation_used: true, ...tel });
  const payload = t.toPayload();
  check('turn telemetry continuation_used still from route', payload.continuation_used === true);
  check('turn telemetry capsule_kind', payload.capsule_kind === 'upcoming');
  check('turn telemetry capsule_transition defaults none', payload.capsule_transition === 'none');

  const baseline = T.emptyDialogueState();
  persist(baseline, route('What bills are due next week?'));
  const withLastX = { ...baseline, capsule: null };
  const baselineBytes = Buffer.byteLength(JSON.stringify(withLastX));
  const withCapsuleBytes = Buffer.byteLength(JSON.stringify(baseline));
  const delta = withCapsuleBytes - baselineBytes;
  console.log(`  dialogue bytes without Capsule: ${baselineBytes}`);
  console.log(`  dialogue bytes with Capsule: ${withCapsuleBytes}`);
  console.log(`  Capsule delta: ${delta}`);
  console.log(`  Capsule JSON bytes: ${Buffer.byteLength(JSON.stringify(baseline.capsule))}`);
  check('Capsule delta is small (< 1KB)', delta > 0 && delta < 1024);

  const t0 = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    projectConversationCapsule(baseline);
  }
  const elapsed = Date.now() - t0;
  console.log(`  1000 projections: ${elapsed}ms`);
  check('1000 projections under 250ms', elapsed < 250, `${elapsed}ms`);

  section('3A.4 Capsule is production authority');
  const ignore = T.emptyDialogueState();
  persist(ignore, route('What bills are due next week?'));
  ignore.capsule.activeThread.kind = 'recurring';
  const stillUpcoming = route('How much total?', { dialogueState: ignore });
  check('malformed Capsule falls back to lastX', stillUpcoming.parentCapability === 'cashflow_upcoming');
}

module.exports = { run };

if (require.main === module) {
  run().then(() => {
    const { failed } = require('./harness').totals();
    process.exit(failed === 0 ? 0 : 1);
  });
}
