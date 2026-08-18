'use strict';

const { check, section } = require('./harness');
const {
  routeCapability,
  applyContinuationPersistence,
  extractSlots,
  shouldSkipAzureForRoute,
  buildDeterministicAffirmativeText,
} = require('../services/keaCapabilityRouter');
const {
  THREAD_KINDS,
  resolveCurrentConversationCapsule,
  isAuthoritativeEmptyCapsule,
  emptyAuthoritativeCapsule,
  deriveConversationCapsule,
} = require('../services/keaConversationCapsule');
const {
  applyConversationContinuation,
  legacyMergeContinuationSlots,
  assertContinuationSlotParity,
  threadMutated,
  buildConversationClarifyText,
} = require('../services/keaConversationContinuation');
const { TRANSITION } = require('../services/keaConversationStateResolver');
const { resolveGroundingPolicy } = require('../services/keaGroundingPolicy');
const { __testables: T } = require('../controllers/openaiController');
const { shiftCalendarWeek } = require('../services/keaUpcomingPeriod');
const { createKeaTelemetry } = require('../services/keaTelemetry');

const DATE = '2026-08-17';
const ACCOUNT = '10';

function route(message, extra = {}) {
  return routeCapability({
    message,
    currentDate: extra.currentDate || DATE,
    dialogueState: extra.dialogueState || T.emptyDialogueState(),
    accountId: extra.accountId || ACCOUNT,
    simulationMode: extra.simulationMode === true,
    pendingWrite: extra.pendingWrite === true,
    pendingGoalWrite: extra.pendingGoalWrite === true,
    pendingDraft: extra.pendingDraft || null,
    pendingGoalDraft: extra.pendingGoalDraft || null,
    userAffirmative: extra.userAffirmative === true,
  });
}

function persist(state, r, extra = {}) {
  applyContinuationPersistence(state, r, { accountId: extra.accountId || ACCOUNT, failSoft: extra.failSoft });
  return state;
}

let slotCases = 0;
let slotMismatches = 0;

function slotParity(name, message, dialogueState, kind) {
  const slots = extractSlots(message, DATE);
  const lastCap = dialogueState.lastCapability;
  const legacySlots = legacyMergeContinuationSlots({
    message,
    last: dialogueState,
    lastCap,
    slots,
    currentDate: DATE,
  });
  const capsule = resolveCurrentConversationCapsule(dialogueState, ACCOUNT);
  const applied = applyConversationContinuation({
    message,
    activeThread: capsule && capsule.activeThread,
    clientDate: DATE,
    slots,
  });
  const production = route(message, { dialogueState });
  const vsLegacy = assertContinuationSlotParity(name, {
    capability: lastCap,
    continuationUsed: true,
    slots: legacySlots,
    error: legacySlots.recurringError || legacySlots.trendError || legacySlots.comparisonError
      || legacySlots.incomeHorizonError || legacySlots.purchaseDateError || null,
    responseMode: applied.responseMode,
  }, {
    capability: applied.supported ? lastCap : null,
    continuationUsed: applied.supported,
    slots: applied.slots,
    error: applied.error,
    responseMode: applied.responseMode,
  }, kind);
  const vsProd = JSON.stringify(assertContinuationSlotParity(`${name} vs prod`, {
    capability: lastCap,
    continuationUsed: true,
    slots: applied.slots,
    error: applied.error,
    responseMode: applied.responseMode,
  }, {
    capability: production.parentCapability || production.capability,
    continuationUsed: production.continuationUsed,
    slots: production.slots,
    error: production.slots && (production.slots.recurringError || production.slots.trendError
      || production.slots.comparisonError || production.slots.incomeHorizonError
      || production.slots.purchaseDateError) || null,
    responseMode: production.responseMode || null,
  }, kind).ok);
  slotCases += 1;
  if (!vsLegacy.ok) slotMismatches += 1;
  check(name, vsLegacy.ok, vsLegacy.ok ? '' : JSON.stringify({
    expected: vsLegacy.expectedSlots,
    actual: vsLegacy.actualSlots,
    flags: {
      capabilityMatch: vsLegacy.capabilityMatch,
      continuationMatch: vsLegacy.continuationMatch,
      errorMatch: vsLegacy.errorMatch,
      responseModeMatch: vsLegacy.responseModeMatch,
      slotMatch: vsLegacy.slotMatch,
    },
  }));
  check(`${name} production uses reducer slots`, vsProd === 'true'
    && production.capability === 'continuation'
    && production.continuationUsed === true);
  return { applied, production, capsule };
}

async function run() {
  section('3A.4 slot parity — recurring');

  const rec = T.emptyDialogueState();
  persist(rec, route('What recurring expenses do I have?'));
  check('fresh recurring thread', rec.capsule.activeThread.kind === THREAD_KINDS.RECURRING
    && rec.capsule.activeThread.metricScope === 'expense'
    && rec.capsule.activeThread.rankingMode == null);
  slotParity('recurring largest slots', 'Which is the largest?', rec, THREAD_KINDS.RECURRING);
  persist(rec, route('Which is the largest?', { dialogueState: rec }));
  check('ranking persisted', rec.capsule.activeThread.rankingMode === 'largest');
  slotParity('recurring income after largest', 'What about income?', rec, THREAD_KINDS.RECURRING);
  persist(rec, route('What about income?', { dialogueState: rec }));
  check('income keeps largest', rec.capsule.activeThread.metricScope === 'income'
    && rec.capsule.activeThread.rankingMode === 'largest');
  const freshIncome = route('What recurring income do I have?', { dialogueState: rec });
  check('fresh recurring resets ranking', freshIncome.capability === 'cashflow_recurring'
    && freshIncome.continuationUsed === false
    && (freshIncome.slots.rankingMode == null || freshIncome.slots.rankingMode === null));
  persist(rec, freshIncome);
  check('fresh income thread ranking null', rec.capsule.activeThread.metricScope === 'income'
    && rec.capsule.activeThread.rankingMode == null);

  section('3A.4 slot parity — upcoming');

  const up = T.emptyDialogueState();
  persist(up, route('What bills are due next week?'));
  check('upcoming absolute period', up.capsule.activeThread.period.start === '2026-08-23'
    && up.capsule.activeThread.period.end === '2026-08-29'
    && up.capsule.activeThread.period.relation === 'next_week');
  const total = slotParity('upcoming total', 'How much total?', up, THREAD_KINDS.UPCOMING);
  check('total is request-local', total.production.responseMode === 'total'
    && total.applied.updatedThread.responseMode === undefined);
  persist(up, total.production);
  check('total does not persist responseMode', up.capsule.activeThread.responseMode === undefined
    && up.capsule.activeThread.period.start === '2026-08-23');
  const laterDate = route('How much total?', { dialogueState: up, currentDate: '2026-08-18' });
  check('clientDate change does not re-resolve next week', laterDate.slots.period.start === '2026-08-23'
    && laterDate.slots.period.end === '2026-08-29');
  slotParity('upcoming income', 'What about income?', up, THREAD_KINDS.UPCOMING);
  persist(up, route('What about income?', { dialogueState: up }));
  check('upcoming income keeps dates', up.capsule.activeThread.period.start === '2026-08-23'
    && up.capsule.activeThread.metricScope === 'income');
  slotParity('upcoming week after', 'What about the week after?', up, THREAD_KINDS.UPCOMING);
  persist(up, route('What about the week after?', { dialogueState: up }));
  const shifted = shiftCalendarWeek({ start: '2026-08-23', end: '2026-08-29', relation: 'next_week' });
  check('week after uses shiftCalendarWeek', up.capsule.activeThread.period.start === shifted.start
    && up.capsule.activeThread.period.end === shifted.end);

  section('3A.4 unsupported financial follow-up escape');

  const upUnsup = T.emptyDialogueState();
  persist(upUnsup, route('What bills are due next week?'));
  const storedStart = upUnsup.capsule.activeThread.period.start;
  const storedEnd = upUnsup.capsule.activeThread.period.end;
  const largestOnUp = route('Which is the largest?', { dialogueState: upUnsup });
  check('upcoming largest is conversation_clarify', largestOnUp.capability === 'conversation_clarify'
    && largestOnUp.continuationUsed === false
    && largestOnUp.capsuleTransition === TRANSITION.UNSUPPORTED_FOLLOWUP
    && largestOnUp.capsuleClear !== true
    && largestOnUp.clarifyReason === 'unsupported_thread_followup');
  check('upcoming largest skips Azure', shouldSkipAzureForRoute(largestOnUp) === true);
  const largestGrounding = resolveGroundingPolicy(largestOnUp, { message: 'Which is the largest?' });
  check('upcoming largest has no Azure grounding path', largestGrounding.grounding === 'NONE'
    && largestGrounding.effectiveCapability === 'conversation_clarify');
  const largestText = buildDeterministicAffirmativeText(largestOnUp, upUnsup, { message: 'Which is the largest?' });
  check('upcoming largest clarify is not ranking', typeof largestText === 'string'
    && /isn'?t supported/i.test(largestText)
    && !/rank/i.test(largestText));
  persist(upUnsup, largestOnUp);
  check('unsupported follow-up preserves upcoming capsule',
    upUnsup.capsule.activeThread
    && upUnsup.capsule.activeThread.kind === THREAD_KINDS.UPCOMING
    && upUnsup.capsule.activeThread.period.start === storedStart
    && upUnsup.capsule.activeThread.period.end === storedEnd);
  const totalAfterUnsupported = route('How much total?', { dialogueState: upUnsup });
  check('total after unsupported is upcoming continuation',
    totalAfterUnsupported.capability === 'continuation'
    && totalAfterUnsupported.parentCapability === 'cashflow_upcoming'
    && totalAfterUnsupported.continuationUsed === true
    && totalAfterUnsupported.slots.period.start === storedStart
    && totalAfterUnsupported.slots.period.end === storedEnd);

  const recUnsup = T.emptyDialogueState();
  persist(recUnsup, route('What recurring expenses do I have?'));
  const recLargest = route('Which is the largest?', { dialogueState: recUnsup });
  check('recurring largest still continues', recLargest.capability === 'continuation'
    && recLargest.parentCapability === 'cashflow_recurring'
    && recLargest.continuationUsed === true
    && recLargest.slots.rankingMode === 'largest'
    && recLargest.capsuleTransition === TRANSITION.REFINED);

  section('3A.4 slot parity — income horizon');

  const hz = T.emptyDialogueState();
  persist(hz, {
    capability: 'cashflow_income_horizon',
    confidence: 'high',
    slots: {
      incomeDate: '2026-08-31',
      incomeAmount: 4626.36,
      windowStart: '2026-08-18',
      windowEnd: '2026-08-30',
    },
  });
  check('horizon Capsule has no amount', hz.capsule.activeThread.incomeAmount === undefined);
  slotParity('horizon expenses before', 'What expenses are due before then?', hz, THREAD_KINDS.INCOME_HORIZON);
  slotParity('horizon total', 'How much total?', hz, THREAD_KINDS.INCOME_HORIZON);
  const neg = slotParity('horizon will I go negative', 'Will I go negative?', hz, THREAD_KINDS.INCOME_HORIZON);
  check('horizon negative is continuation', neg.production.continuationUsed === true
    && neg.production.parentCapability === 'cashflow_income_horizon'
    && neg.production.responseMode === 'negative_check');
  const afterPay = slotParity('horizon after payday', 'What about after payday?', hz, THREAD_KINDS.INCOME_HORIZON);
  check('after payday unsupported on same thread', afterPay.production.slots.incomeHorizonError === 'after_income_intraday_unsupported'
    && afterPay.production.parentCapability === 'cashflow_income_horizon');
  const takeover = route('What income is coming next week?', { dialogueState: hz });
  check('horizon takeover is fresh upcoming', takeover.capability === 'cashflow_upcoming'
    && takeover.continuationUsed === false);

  section('3A.4 slot parity — trend / comparison / lookup / analysis / affordability');

  const tr = T.emptyDialogueState();
  persist(tr, route('How has my spending changed over the last 3 months?'));
  slotParity('trend restaurants', 'What about restaurants?', tr, THREAD_KINDS.TREND);
  persist(tr, route('What about restaurants?', { dialogueState: tr }));
  check('trend categoryFilter restaurants', tr.capsule.activeThread.categoryFilter === 'restaurants'
    || tr.lastTrend.categoryFilter === 'restaurants');
  const cmpFresh = route('Compare July and June.', { dialogueState: tr });
  check('fresh comparison replaces trend', cmpFresh.capability === 'cashflow_comparison'
    && cmpFresh.continuationUsed === false);
  persist(tr, cmpFresh);
  slotParity('comparison restaurants', 'What about restaurants?', tr, THREAD_KINDS.COMPARISON);
  const trendFresh = route('How has my spending changed over the last 3 months?', { dialogueState: tr });
  check('fresh trend after comparison', trendFresh.capability === 'cashflow_trend'
    && trendFresh.continuationUsed === false);

  const lk = T.emptyDialogueState();
  persist(lk, route('How much did I spend at Target last month?'));
  slotParity('lookup Walmart', 'What about Walmart?', lk, THREAD_KINDS.LOOKUP);
  persist(lk, route('What about Walmart?', { dialogueState: lk }));
  slotParity('lookup this month', 'What about this month?', lk, THREAD_KINDS.LOOKUP);

  const an = T.emptyDialogueState();
  persist(an, route('How am I doing this month?'));
  slotParity('analysis next month', 'What about next month?', an, THREAD_KINDS.ANALYSIS);

  const af = T.emptyDialogueState();
  persist(af, route('Can I afford $800 next month?'));
  check('affordability assumption stored on thread',
    af.capsule.activeThread.purchaseDateAssumption === 'next_month_first_day'
    && !!af.capsule.activeThread.purchaseDateAssumptionText);
  slotParity('affordability amount refinement', 'What about $1,200?', af, THREAD_KINDS.AFFORDABILITY);
  persist(af, route('What about $1,200?', { dialogueState: af }));
  check('amount change keeps assumption', af.capsule.activeThread.amount === 1200
    && af.capsule.activeThread.purchaseDateAssumption === 'next_month_first_day');

  section('3A.4 no-thread clarification');

  const phrases = [
    'How much total?',
    'What about income?',
    'Which is the largest?',
    'The week after?',
    'What expenses are due before then?',
  ];
  for (const phrase of phrases) {
    const r = route(phrase);
    check(`no-thread "${phrase}" clarifies`, r.capability === 'conversation_clarify'
      && r.continuationUsed === false
      && shouldSkipAzureForRoute(r) === true);
    const text = buildDeterministicAffirmativeText(r, T.emptyDialogueState(), { message: phrase });
    check(`no-thread "${phrase}" has deterministic text`, typeof text === 'string' && text.length > 10 && !/azure/i.test(text));
  }
  check('clarify copy for total', /period or financial view/.test(buildConversationClarifyText({ message: 'How much total?' })));

  section('3A.4 hard-switch / soft-switch');

  const hs = T.emptyDialogueState();
  persist(hs, route('What bills are due next week?'));
  const help = route('How do I use Keacast goals?', { dialogueState: hs });
  check('product_help hard switch', help.capability === 'product_help'
    && help.capsuleClear === true
    && help.capsuleTransition === TRANSITION.CLEARED_HARD_SWITCH);
  persist(hs, help);
  check('help clears Capsule', hs.capsule.activeThread == null && isAuthoritativeEmptyCapsule(hs.capsule));
  const afterHelp = route('How much total?', { dialogueState: hs });
  check('total after help clarifies', afterHelp.capability === 'conversation_clarify'
    && afterHelp.continuationUsed === false);

  const nav = T.emptyDialogueState();
  persist(nav, route('What bills are due next week?'));
  const openProfile = route('Open my profile', { dialogueState: nav });
  check('open profile is navigation', openProfile.capability === 'navigation_ui'
    && openProfile.capsuleClear === true);
  persist(nav, openProfile);
  check('nav then total clarifies', route('How much total?', { dialogueState: nav }).capability === 'conversation_clarify');

  const pw = T.emptyDialogueState();
  persist(pw, route('What bills are due next week?'));
  const password = route('How do I change my password?', { dialogueState: pw });
  check('password is hard switch unknown', password.capability === 'unknown'
    && password.capsuleClear === true
    && password.continuationUsed === false);
  persist(pw, password);
  check('password then total clarifies not upcoming',
    route('How much total?', { dialogueState: pw }).capability === 'conversation_clarify');

  const soft = T.emptyDialogueState();
  persist(soft, route('What bills are due next week?'));
  const thanks = route('Thanks.', { dialogueState: soft });
  check('thanks is casual and does not clear', thanks.capability === 'casual_conversation'
    && thanks.capsuleClear !== true);
  persist(soft, thanks);
  check('thanks then total still upcoming', route('How much total?', { dialogueState: soft }).parentCapability === 'cashflow_upcoming');
  const gotIt = route('got it', { dialogueState: soft });
  check('got it is casual', gotIt.capability === 'casual_conversation');

  section('3A.4 Capsule load / corrupt / conflict');

  const oldRedis = T.emptyDialogueState();
  oldRedis.capsule = null;
  oldRedis.lastCapability = 'cashflow_upcoming';
  oldRedis.lastAccountId = ACCOUNT;
  oldRedis.lastUpcoming = {
    period: { start: '2026-08-23', end: '2026-08-29', label: 'next_week', relation: 'next_week' },
    metricScope: 'expense',
  };
  const derived = resolveCurrentConversationCapsule(oldRedis, ACCOUNT);
  check('old Redis derives Capsule', derived && derived.activeThread && derived.activeThread.kind === THREAD_KINDS.UPCOMING);
  check('old Redis continuation works', route('How much total?', { dialogueState: oldRedis }).parentCapability === 'cashflow_upcoming');
  persist(oldRedis, route('How much total?', { dialogueState: oldRedis }));
  check('next save persists Capsule', oldRedis.capsule.activeThread.kind === THREAD_KINDS.UPCOMING);

  const corrupt = T.emptyDialogueState();
  persist(corrupt, route('What bills are due next week?'));
  const loaded = Object.assign({}, corrupt, { capsule: { version: 99, junk: true } });
  check('corrupt Capsule falls back to lastX', route('How much total?', { dialogueState: loaded }).parentCapability === 'cashflow_upcoming');
  persist(loaded, route('How much total?', { dialogueState: loaded }));
  check('persist repairs Capsule', loaded.capsule.version === 1 && loaded.capsule.activeThread.kind === THREAD_KINDS.UPCOMING);

  const conflict = T.emptyDialogueState();
  persist(conflict, route('What bills are due next week?'));
  conflict.lastCapability = 'cashflow_recurring';
  conflict.lastRecurring = { metricScope: 'expense', rankingMode: 'largest' };
  const conflictRoute = route('How much total?', { dialogueState: conflict });
  check('valid Capsule wins over zombie lastCapability', conflictRoute.parentCapability === 'cashflow_upcoming'
    && conflictRoute.continuationUsed === true);
  const resolvedConflict = resolveCurrentConversationCapsule(conflict, ACCOUNT);
  check('load helper returns Capsule upcoming not recurring',
    resolvedConflict.activeThread.kind === THREAD_KINDS.UPCOMING);

  const emptyAuth = T.emptyDialogueState();
  emptyAuth.lastCapability = 'cashflow_upcoming';
  emptyAuth.lastAccountId = ACCOUNT;
  emptyAuth.lastUpcoming = conflict.lastUpcoming;
  emptyAuth.capsule = emptyAuthoritativeCapsule(ACCOUNT, null);
  check('authoritative empty does not derive lastX',
    resolveCurrentConversationCapsule(emptyAuth, ACCOUNT).activeThread == null);
  check('authoritative empty total clarifies',
    route('How much total?', { dialogueState: emptyAuth }).capability === 'conversation_clarify');

  section('3A.4 write / invitation / UI safety');

  const writeDs = T.emptyDialogueState();
  writeDs.pendingConfirmation = true;
  writeDs.draftTransaction = { title: 'Coffee', amount: -4, start: '2026-08-20' };
  const yes = route('yes', {
    dialogueState: writeDs,
    pendingWrite: true,
    userAffirmative: T.isAffirmativeMessage('yes'),
  });
  check('yes still confirms before Capsule', yes.capability === 'confirmation');
  persist(writeDs, route('What bills are due next week?', { dialogueState: writeDs }));
  writeDs.needsReconfirm = true;
  writeDs.pendingConfirmation = true;
  const yesAfter = route('yes', {
    dialogueState: writeDs,
    pendingWrite: true,
    userAffirmative: T.isAffirmativeMessage('yes'),
  });
  check('yes after topic switch does not confirm', yesAfter.capability !== 'confirmation');

  const invite = T.emptyDialogueState();
  persist(invite, route('Can I afford $800 next month?'));
  invite.pendingInvitation = {
    kind: 'add_affordability_expense',
    amount: 800,
    date: '2026-09-01',
    accountId: ACCOUNT,
    status: 'offered',
  };
  persist(invite, route('What bills are due next week?', { dialogueState: invite }));
  const yesInvite = route('yes', {
    dialogueState: invite,
    userAffirmative: T.isAffirmativeMessage('yes'),
  });
  check('yes after invitation topic switch is unresolved',
    yesInvite.capability === 'bare_affirmative_unresolved'
    || yesInvite.capability === 'invitation_continuation');
  if (yesInvite.capability === 'invitation_continuation') {
    check('invitation not revived after topic switch', yesInvite.invitationWriteHandoff !== true
      || invite.pendingInvitation == null);
  }

  const ui = T.emptyDialogueState();
  ui.uiReferent = { type: 'transaction', id: 'tx-1' };
  const focused = route('This is correct', { dialogueState: ui });
  check('focused UI this is correct is not confirmation', focused.capability !== 'confirmation'
    && focused.capability !== 'transaction_write');

  const sim = route('What if I add a $50 coffee tomorrow?', { simulationMode: true });
  check('simulation still outside Capsule', sim.capability === 'simulation');

  section('3A.4 telemetry + performance');

  const telState = T.emptyDialogueState();
  persist(telState, route('What bills are due next week?'));
  const telRoute = route('How much total?', { dialogueState: telState });
  const t = createKeaTelemetry({ requestId: '3a4' });
  t.recordGrounding({
    continuation_used: !!telRoute.continuationUsed,
    capsule_transition: telRoute.capsuleTransition,
    capsule_present: true,
    capsule_kind: 'upcoming',
    capsule_version: 1,
    capsule_account_match: true,
  });
  const payload = t.toPayload();
  check('continuation_used from resolver route', payload.continuation_used === true);
  check('capsule_transition continued for total', payload.capsule_transition === 'continued');
  check('telemetry has no account ids', payload.accountId === undefined);

  const t0 = Date.now();
  const perfThread = telState.capsule.activeThread;
  for (let i = 0; i < 1000; i += 1) {
    applyConversationContinuation({
      message: 'How much total?',
      activeThread: perfThread,
      clientDate: DATE,
    });
  }
  const elapsed = Date.now() - t0;
  console.log(`  reducer 1000 iterations: ${elapsed}ms`);
  check('reducer 1000 iterations under 250ms', elapsed < 250, `${elapsed}ms`);

  section('3A.4 slot parity summary');
  console.log(`  slot parity cases: ${slotCases}; mismatches: ${slotMismatches}`);
  check('no unexplained slot mismatches', slotMismatches === 0, `${slotMismatches} of ${slotCases}`);
  check('threadMutated detects week-after', threadMutated(
    { kind: 'upcoming', period: { start: '2026-08-23', end: '2026-08-29' } },
    { kind: 'upcoming', period: { start: '2026-08-30', end: '2026-09-05' } }
  ) === true);
}

module.exports = { run };

if (require.main === module) {
  run().then(() => {
    const { failed } = require('./harness').totals();
    process.exit(failed === 0 ? 0 : 1);
  });
}
