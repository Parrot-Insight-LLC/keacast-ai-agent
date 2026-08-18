'use strict';

/**
 * Conversation State Resolver (Phase 3A.2 ownership + 3A.4 production authority)
 *
 * Given a validated Conversation Capsule and a fresh intent candidate, decide
 * whether the turn is a continuation, a fresh replacement, a hard-switch clear,
 * or an unresolved/clarify follow-up.
 *
 * This module does NOT:
 *   - call Azure, Cashflow, Redis, or tools
 *   - authorize writes or invitations
 *   - persist Capsule or mutate dialogueState / Capsule / freshCandidate
 *
 * Hard-switch (product_help / navigation_ui / narrow settings-password) clears
 * the conceptual active thread. Soft interjection (thanks) does not.
 */

const { THREAD_KINDS, isConversationCapsuleV1 } = require('./keaConversationCapsule');
const { parseContinuationAction } = require('./keaConversationContinuation');
const {
  classifyFreshIntentCandidate,
  wouldBreakContinuation,
  isShortFollowUp,
  isRecurringFollowUp,
  isUpcomingFollowUp,
  isIncomeHorizonFollowUp,
  isCasual,
  accountsMatch,
  FINANCIAL_CAPABILITIES,
} = require('./keaCapabilityRouter');

const KIND_TO_CAPABILITY = Object.freeze({
  [THREAD_KINDS.COMPARISON]: 'cashflow_comparison',
  [THREAD_KINDS.TREND]: 'cashflow_trend',
  [THREAD_KINDS.RECURRING]: 'cashflow_recurring',
  [THREAD_KINDS.UPCOMING]: 'cashflow_upcoming',
  [THREAD_KINDS.INCOME_HORIZON]: 'cashflow_income_horizon',
  [THREAD_KINDS.LOOKUP]: 'financial_lookup',
  [THREAD_KINDS.ANALYSIS]: 'cashflow_analysis',
  [THREAD_KINDS.FORECAST]: 'financial_forecast',
  [THREAD_KINDS.AFFORDABILITY]: 'affordability_or_planning',
});

const TRANSITION = Object.freeze({
  CREATED: 'created',
  CONTINUED: 'continued',
  REFINED: 'refined',
  REPLACED_BY_FRESH_INTENT: 'replaced_by_fresh_intent',
  CLEARED_ACCOUNT_CHANGE: 'cleared_account_change',
  CLEARED_HARD_SWITCH: 'cleared_hard_switch',
  UNSUPPORTED_FOLLOWUP: 'unsupported_followup',
  UNCHANGED: 'unchanged',
  NONE: 'none',
});

const RESOLUTION = Object.freeze({
  FRESH: 'fresh',
  CONTINUATION: 'continuation',
  CLARIFY: 'clarify',
  NONE: 'none',
});

const HARD_SWITCH_CAPS = new Set(['product_help', 'navigation_ui']);

function capabilityForKind(kind) {
  return kind ? (KIND_TO_CAPABILITY[kind] || null) : null;
}

function isContinuationShaped(message) {
  return isShortFollowUp(message)
    || isRecurringFollowUp(message)
    || isUpcomingFollowUp(message)
    || isIncomeHorizonFollowUp(message);
}

function matchesActiveThreadFollowUp(kind, message) {
  if (!kind) return false;
  if (kind === THREAD_KINDS.RECURRING && isRecurringFollowUp(message)) return true;
  if (kind === THREAD_KINDS.UPCOMING && isUpcomingFollowUp(message)) return true;
  if (kind === THREAD_KINDS.INCOME_HORIZON && isIncomeHorizonFollowUp(message)) return true;
  return isShortFollowUp(message);
}

function isSettingsHardSwitch(text) {
  const m = String(text || '').toLowerCase();
  if (!m || m.length > 120) return false;
  if (/\b(spend|spent|bill|income|forecast|afford|paycheck|balance)\b/.test(m)) return false;
  return /\b(change|reset|update)\b.{0,32}\bpassword\b/.test(m)
    || /\bpassword\b.{0,24}\b(change|reset|update)\b/.test(m)
    || /\b(account settings|privacy settings|login help)\b/.test(m);
}

function isHardSwitchFresh(freshCap, message) {
  if (HARD_SWITCH_CAPS.has(freshCap)) return true;
  if (freshCap === 'unknown' && isSettingsHardSwitch(message)) return true;
  return false;
}

function continuationMeta(kind, message) {
  return parseContinuationAction(message, kind ? { kind } : null);
}

function emptyResult(extra = {}) {
  return {
    resolution: extra.resolution || RESOLUTION.NONE,
    effectiveCapability: extra.effectiveCapability || 'unknown',
    continuationUsed: extra.continuationUsed === true,
    transition: extra.transition || null,
    activeThreadKind: extra.activeThreadKind || null,
    responseMode: extra.responseMode || null,
    continuationAction: extra.continuationAction || null,
    accountMatch: extra.accountMatch,
    reason: extra.reason || null,
    confidence: extra.confidence || 'low',
  };
}

/**
 * @param {{
 *   message: string,
 *   clientDate?: string,
 *   currentAccountId?: string|number,
 *   capsule?: object,
 *   freshCandidate?: object,
 *   knownCategories?: string[],
 * }} input
 */
function resolveConversationState(input = {}) {
  const message = String(input.message || '');
  const clientDate = input.clientDate;
  const currentAccountId = input.currentAccountId;
  const capsule = input.capsule && typeof input.capsule === 'object' ? input.capsule : null;
  const knownCategories = input.knownCategories;

  const freshCandidate = input.freshCandidate && typeof input.freshCandidate === 'object'
    ? input.freshCandidate
    : classifyFreshIntentCandidate({
      message,
      currentDate: clientDate,
      knownCategories,
    });

  const capsuleValid = !!(capsule && isConversationCapsuleV1(capsule));
  const thread = capsuleValid ? capsule.activeThread : null;
  const threadKind = thread && thread.kind ? thread.kind : null;
  const threadCap = capabilityForKind(threadKind);
  const accountMatch = !!(
    capsuleValid
    && capsule.accountId
    && currentAccountId != null
    && currentAccountId !== ''
    && accountsMatch(capsule.accountId, currentAccountId)
  );
  const accountMismatch = !!(
    capsuleValid
    && capsule.accountId
    && currentAccountId != null
    && currentAccountId !== ''
    && !accountsMatch(capsule.accountId, currentAccountId)
  );

  const freshCap = freshCandidate.capability || 'unknown';
  const freshConfidence = freshCandidate.confidence || 'low';
  const shaped = isContinuationShaped(message);

  if (accountMismatch && shaped && (freshCap === 'unknown' || freshCandidate.intentStrength === 'none')) {
    return emptyResult({
      resolution: RESOLUTION.CLARIFY,
      effectiveCapability: 'conversation_clarify',
      continuationUsed: false,
      transition: TRANSITION.CLEARED_ACCOUNT_CHANGE,
      activeThreadKind: null,
      accountMatch: false,
      reason: 'account_mismatch',
      confidence: 'low',
    });
  }

  const threadEligible = !!(threadKind && threadCap && !accountMismatch);

  if (threadEligible && isHardSwitchFresh(freshCap, message)) {
    return emptyResult({
      resolution: freshCap === 'unknown' ? RESOLUTION.NONE : RESOLUTION.FRESH,
      effectiveCapability: freshCap,
      continuationUsed: false,
      transition: TRANSITION.CLEARED_HARD_SWITCH,
      activeThreadKind: null,
      accountMatch: accountMatch || currentAccountId == null || currentAccountId === '',
      reason: 'hard_switch',
      confidence: freshConfidence,
    });
  }

  const followUp = threadEligible && matchesActiveThreadFollowUp(threadKind, message);
  const strongTakeover = threadEligible && wouldBreakContinuation(message, threadCap, clientDate);

  if (threadEligible && followUp && !strongTakeover) {
    const meta = continuationMeta(threadKind, message);
    const refined = !!(meta.continuationAction
      && meta.continuationAction !== 'request_total'
      && meta.continuationAction !== 'horizon_expenses_before'
      && meta.continuationAction !== 'horizon_negative_check'
      && meta.continuationAction !== 'horizon_after_payday_unsupported');
    return {
      resolution: RESOLUTION.CONTINUATION,
      effectiveCapability: threadCap,
      continuationUsed: true,
      transition: refined ? TRANSITION.REFINED : TRANSITION.CONTINUED,
      activeThreadKind: threadKind,
      responseMode: meta.responseMode,
      continuationAction: meta.continuationAction,
      accountMatch: accountMatch || currentAccountId == null || currentAccountId === '',
      reason: 'matching_active_thread',
      confidence: 'high',
    };
  }

  if (threadEligible && strongTakeover && freshCap !== 'unknown' && freshCap !== threadCap) {
    return emptyResult({
      resolution: RESOLUTION.FRESH,
      effectiveCapability: freshCap,
      continuationUsed: false,
      transition: TRANSITION.REPLACED_BY_FRESH_INTENT,
      activeThreadKind: threadKind,
      accountMatch: accountMatch || currentAccountId == null || currentAccountId === '',
      reason: 'strong_fresh_intent',
      confidence: freshConfidence,
    });
  }

  if (!threadEligible && shaped && (freshCap === 'unknown' || freshCandidate.intentStrength === 'none')) {
    return emptyResult({
      resolution: RESOLUTION.CLARIFY,
      effectiveCapability: 'conversation_clarify',
      continuationUsed: false,
      transition: threadKind && !followUp ? TRANSITION.UNSUPPORTED_FOLLOWUP : TRANSITION.NONE,
      activeThreadKind: null,
      accountMatch: accountMismatch ? false : (currentAccountId == null ? null : true),
      reason: capsuleValid ? 'no_active_thread' : 'invalid_capsule',
      confidence: 'low',
    });
  }

  if (threadEligible && shaped && !followUp && freshCap === 'unknown') {
    return emptyResult({
      resolution: RESOLUTION.CLARIFY,
      effectiveCapability: 'conversation_clarify',
      continuationUsed: false,
      transition: TRANSITION.UNSUPPORTED_FOLLOWUP,
      activeThreadKind: threadKind,
      accountMatch: accountMatch || currentAccountId == null || currentAccountId === '',
      reason: 'unsupported_thread_followup',
      confidence: 'low',
    });
  }

  const soft = isCasual(message);
  let transition = null;
  if (soft && threadEligible) {
    transition = TRANSITION.UNCHANGED;
  } else if (threadEligible && FINANCIAL_CAPABILITIES.has(freshCap) && freshCap !== threadCap) {
    transition = TRANSITION.REPLACED_BY_FRESH_INTENT;
  } else if (!threadEligible && freshCap !== 'unknown' && freshCandidate.intentStrength === 'strong_fresh') {
    transition = TRANSITION.CREATED;
  }

  return emptyResult({
    resolution: freshCap === 'unknown' ? RESOLUTION.NONE : RESOLUTION.FRESH,
    effectiveCapability: freshCap,
    continuationUsed: false,
    transition,
    activeThreadKind: threadEligible ? threadKind : null,
    accountMatch: accountMismatch ? false : (threadEligible ? (accountMatch || currentAccountId == null || currentAccountId === '') : null),
    reason: soft && threadEligible ? 'soft_interjection' : (freshCap === 'unknown' ? 'none' : 'fresh_candidate'),
    confidence: freshConfidence,
  });
}

module.exports = {
  KIND_TO_CAPABILITY,
  TRANSITION,
  RESOLUTION,
  resolveConversationState,
  capabilityForKind,
  isContinuationShaped,
  isSettingsHardSwitch,
  isHardSwitchFresh,
};
