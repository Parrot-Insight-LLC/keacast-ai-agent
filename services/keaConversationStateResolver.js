'use strict';

/**
 * Conversation State Resolver (Phase 3A.2)
 *
 * Shadow ownership layer: given a derived Conversation Capsule and a fresh
 * intent candidate, decide whether the turn is a continuation, a fresh
 * replacement, or an unresolved/clarify follow-up.
 *
 * This module does NOT:
 *   - call Azure, Cashflow, Redis, or tools
 *   - authorize writes or invitations
 *   - persist Capsule or mutate dialogueState / Capsule / freshCandidate
 *   - replace production routeCapability
 *
 * Production routing remains in keaCapabilityRouter. 3A.2 proves parity.
 *
 * Hard-switch (product_help / navigation clearing Capsule) is intentionally
 * NOT implemented. Soft interjection (thanks) also does not clear a thread.
 */

const { THREAD_KINDS, isConversationCapsuleV1 } = require('./keaConversationCapsule');
const {
  classifyFreshIntentCandidate,
  wouldBreakContinuation,
  isShortFollowUp,
  isRecurringFollowUp,
  isUpcomingFollowUp,
  isIncomeHorizonFollowUp,
  isWeekAfterFollowUp,
  isAfterPaydayFollowUp,
  isRecurringLargestIntent,
  isCasual,
  accountsMatch,
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
  UNSUPPORTED_FOLLOWUP: 'unsupported_followup',
});

const RESOLUTION = Object.freeze({
  FRESH: 'fresh',
  CONTINUATION: 'continuation',
  CLARIFY: 'clarify',
  NONE: 'none',
});

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
  // Same as production continuationEligible: any financial thread + short follow-up.
  return isShortFollowUp(message);
}

function continuationMeta(kind, message) {
  const out = { responseMode: null, continuationAction: null };
  if (!kind || !message) return out;
  const income = /\bincome\b/i.test(message);
  const expenseOnly = /\b(expense|bill)/i.test(message) && !income;

  if (kind === THREAD_KINDS.RECURRING) {
    if (isRecurringLargestIntent(message)) out.continuationAction = 'recurring_largest';
    else if (income) out.continuationAction = 'switch_scope_income';
    else if (expenseOnly) out.continuationAction = 'switch_scope_expense';
    return out;
  }
  if (kind === THREAD_KINDS.UPCOMING) {
    if (isWeekAfterFollowUp(message)) out.continuationAction = 'upcoming_week_after';
    else if (income) out.continuationAction = 'switch_scope_income';
    else if (expenseOnly) out.continuationAction = 'switch_scope_expense';
    else if (isUpcomingFollowUp(message)) {
      out.continuationAction = 'request_total';
      out.responseMode = 'total';
    }
    return out;
  }
  if (kind === THREAD_KINDS.INCOME_HORIZON) {
    if (isAfterPaydayFollowUp(message)) {
      out.continuationAction = 'horizon_after_payday_unsupported';
    } else if (/\bwill i go negative\b/i.test(message)) {
      out.continuationAction = 'horizon_negative_check';
      out.responseMode = 'negative_check';
    } else if (/\bbefore then\b/i.test(message)) {
      out.continuationAction = 'horizon_expenses_before';
    } else if (isIncomeHorizonFollowUp(message) || /how much total|the total/i.test(message)) {
      out.continuationAction = 'request_total';
      out.responseMode = 'total';
    }
    return out;
  }
  if (kind === THREAD_KINDS.TREND && income) {
    out.continuationAction = 'switch_scope_income';
  }
  return out;
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
      effectiveCapability: 'unknown',
      continuationUsed: false,
      transition: TRANSITION.CLEARED_ACCOUNT_CHANGE,
      activeThreadKind: null,
      accountMatch: false,
      reason: 'account_mismatch',
      confidence: 'low',
    });
  }

  const threadEligible = !!(threadKind && threadCap && !accountMismatch);
  const followUp = threadEligible && matchesActiveThreadFollowUp(threadKind, message);
  const strongTakeover = threadEligible && wouldBreakContinuation(message, threadCap, clientDate);

  if (threadEligible && followUp && !strongTakeover) {
    const meta = continuationMeta(threadKind, message);
    const refined = !!(meta.continuationAction && meta.continuationAction !== 'request_total');
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
      effectiveCapability: 'unknown',
      continuationUsed: false,
      transition: threadKind && !followUp ? TRANSITION.UNSUPPORTED_FOLLOWUP : null,
      activeThreadKind: null,
      accountMatch: accountMismatch ? false : (currentAccountId == null ? null : true),
      reason: capsuleValid ? 'no_active_thread' : 'invalid_capsule',
      confidence: 'low',
    });
  }

  if (threadEligible && shaped && !followUp && freshCap === 'unknown') {
    return emptyResult({
      resolution: RESOLUTION.CLARIFY,
      effectiveCapability: 'unknown',
      continuationUsed: false,
      transition: TRANSITION.UNSUPPORTED_FOLLOWUP,
      activeThreadKind: threadKind,
      accountMatch: accountMatch || currentAccountId == null || currentAccountId === '',
      reason: 'unsupported_thread_followup',
      confidence: 'low',
    });
  }

  const soft = isCasual(message);
  return emptyResult({
    resolution: freshCap === 'unknown' ? RESOLUTION.NONE : RESOLUTION.FRESH,
    effectiveCapability: freshCap,
    continuationUsed: false,
    transition: (!threadEligible && freshCap !== 'unknown' && freshCandidate.intentStrength === 'strong_fresh')
      ? TRANSITION.CREATED
      : null,
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
};
