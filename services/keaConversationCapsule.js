'use strict';

/**
 * Conversation Capsule (Phase 3A.1)
 *
 * Stores conversational REFERENTS needed to resolve the next financial/read
 * turn deterministically: which capability/thread is active, which account it
 * is bound to, which period/window/scope/category the user is talking about.
 *
 * It does NOT store:
 *   - financial evidence (totals, lowest balance, shortfall, trend direction,
 *     item lists, computed income amounts)
 *   - write authority (drafts, pendingConfirmation, needsReconfirm)
 *   - invitation authority (pendingInvitation)
 *   - UI focus (uiReferent / focusedEntity)
 *   - simulation state
 *   - Azure memory (history, rolling summary, long-term facts)
 *
 * Phase 3A.1: derive-only. lastX objects remain production routing state.
 * Phase 3A.3: projectConversationCapsule() is the persistence hygiene helper
 * (strip invalidReason, persist null when there is no active thread).
 * Phase 3A.4: resolveCurrentConversationCapsule() is the production load helper.
 * A valid persisted Capsule with an activeThread is authority even if zombie
 * lastCapability disagrees. capsule: null means "not projected yet" (derive from
 * lastX). A valid V1 object with activeThread: null is an authoritative empty
 * (hard-switch / account-mismatch) and must NOT fall back to lastX.
 *
 * Forecast mapping (3A.1): financial_forecast uses the same generic lastPeriod
 * machinery as analysis, so it maps to a thin `forecast` thread with period
 * only. No invented forecast-specific payload.
 *
 * Conversation identity: dialogue state is user-scoped (no conversationId).
 * Multi-tab / cross-device sharing is an existing limitation, not solved here.
 */

const CAPSULE_VERSION = 1;

const THREAD_KINDS = Object.freeze({
  COMPARISON: 'comparison',
  TREND: 'trend',
  RECURRING: 'recurring',
  UPCOMING: 'upcoming',
  INCOME_HORIZON: 'income_horizon',
  LOOKUP: 'lookup',
  ANALYSIS: 'analysis',
  FORECAST: 'forecast',
  AFFORDABILITY: 'affordability',
});

const CAPABILITY_TO_KIND = Object.freeze({
  cashflow_comparison: THREAD_KINDS.COMPARISON,
  cashflow_trend: THREAD_KINDS.TREND,
  cashflow_recurring: THREAD_KINDS.RECURRING,
  cashflow_upcoming: THREAD_KINDS.UPCOMING,
  cashflow_income_horizon: THREAD_KINDS.INCOME_HORIZON,
  financial_lookup: THREAD_KINDS.LOOKUP,
  cashflow_analysis: THREAD_KINDS.ANALYSIS,
  financial_forecast: THREAD_KINDS.FORECAST,
  affordability_or_planning: THREAD_KINDS.AFFORDABILITY,
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RECURRING_SCOPES = new Set(['all', 'income', 'expense']);
const UPCOMING_SCOPES = new Set(['all', 'income', 'expense']);
const INCOME_HORIZON_DEFINITION = 'kea_scheduled_recurring_income';

const INVALID = Object.freeze({
  ACCOUNT_MISMATCH: 'account_mismatch',
  MISSING_ACCOUNT: 'missing_account',
  MALFORMED_THREAD: 'malformed_thread',
  UNSUPPORTED_CAPABILITY: 'unsupported_capability',
});

/**
 * Same contract as keaCapabilityRouter.accountsMatch.
 * Duplicated so this module has no router / I/O dependency.
 */
function accountsMatch(a, b) {
  if (a == null || b == null || a === '' || b === '') return false;
  return String(a) === String(b);
}

function normalizeAccountId(value) {
  if (value == null || value === '') return null;
  return String(value);
}

function isIsoDate(value) {
  return typeof value === 'string' && ISO_DATE.test(value);
}

function copyIsoDate(value) {
  if (value == null || value === '') return null;
  const sliced = String(value).slice(0, 10);
  return isIsoDate(sliced) ? sliced : null;
}

function copyLabel(value, max) {
  if (value == null || value === '') return undefined;
  const s = String(value).slice(0, max);
  return s || undefined;
}

function copyPeriod(raw, { withRelation } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const start = copyIsoDate(raw.start);
  const end = copyIsoDate(raw.end);
  if (!start || !end) return null;
  const period = { start, end };
  const label = copyLabel(raw.label, withRelation ? 32 : 64);
  if (label) period.label = label;
  if (withRelation) {
    const relation = copyLabel(raw.relation || raw.label, 32);
    if (relation) period.relation = relation;
  }
  return period;
}

function emptyCapsule(accountId, updatedAt, invalidReason) {
  const capsule = {
    version: CAPSULE_VERSION,
    accountId: accountId == null ? null : accountId,
    updatedAt: updatedAt == null ? null : updatedAt,
    activeThread: null,
  };
  if (invalidReason) capsule.invalidReason = invalidReason;
  return capsule;
}

function threadHeader(kind, accountId, updatedAt) {
  return {
    kind,
    accountId: accountId == null ? null : accountId,
    updatedAt: updatedAt == null ? null : updatedAt,
  };
}

function mapComparison(ds, accountId, updatedAt) {
  const src = ds && ds.lastComparison;
  if (!src || typeof src !== 'object') return null;
  const periodA = copyPeriod(src.periodA);
  const periodB = copyPeriod(src.periodB);
  if (!periodA || !periodB) return null;
  const thread = {
    ...threadHeader(THREAD_KINDS.COMPARISON, accountId, updatedAt),
    periodA,
    periodB,
    windowKind: src.windowKind ? String(src.windowKind).slice(0, 32) : null,
  };
  if (ds.lastSubjectKind === 'category' && ds.lastSubjectValue) {
    thread.category = String(ds.lastSubjectValue).slice(0, 64);
  }
  return thread;
}

function mapTrend(ds, accountId, updatedAt) {
  const src = ds && ds.lastTrend;
  if (!src || typeof src !== 'object' || !Array.isArray(src.periods) || !src.periods.length) {
    return null;
  }
  const periods = src.periods.slice(0, 3).map((p) => copyPeriod(p)).filter(Boolean);
  if (!periods.length) return null;
  const thread = {
    ...threadHeader(THREAD_KINDS.TREND, accountId, updatedAt),
    periods,
    windowKind: src.windowKind ? String(src.windowKind).slice(0, 32) : null,
    metricScope: src.metricScope ? String(src.metricScope).slice(0, 16) : 'spending',
  };
  if (src.categoryFilter) thread.categoryFilter = String(src.categoryFilter).slice(0, 64);
  return thread;
}

function mapRecurring(ds, accountId, updatedAt) {
  const src = ds && ds.lastRecurring;
  if (!src || typeof src !== 'object') return null;
  const metricScope = src.metricScope ? String(src.metricScope).slice(0, 16) : 'all';
  if (!RECURRING_SCOPES.has(metricScope)) return null;
  const rankingMode = src.rankingMode === 'largest' ? 'largest' : null;
  if (src.rankingMode != null && src.rankingMode !== 'largest') return null;
  return {
    ...threadHeader(THREAD_KINDS.RECURRING, accountId, updatedAt),
    metricScope,
    rankingMode,
  };
}

function mapUpcoming(ds, accountId, updatedAt) {
  const src = ds && ds.lastUpcoming;
  if (!src || typeof src !== 'object') return null;
  const period = copyPeriod(src.period, { withRelation: true });
  if (!period) return null;
  const metricScope = src.metricScope ? String(src.metricScope).slice(0, 16) : 'all';
  if (!UPCOMING_SCOPES.has(metricScope)) return null;
  return {
    ...threadHeader(THREAD_KINDS.UPCOMING, accountId, updatedAt),
    period,
    metricScope,
  };
}

function mapIncomeHorizon(ds, accountId, updatedAt) {
  const src = ds && ds.lastIncomeHorizon;
  if (!src || typeof src !== 'object') return null;
  const incomeDate = copyIsoDate(src.incomeDate);
  const windowStart = copyIsoDate(src.windowStart);
  const windowEnd = copyIsoDate(src.windowEnd);
  if (!incomeDate || !windowStart || !windowEnd) return null;
  const definition = src.definition
    ? String(src.definition)
    : INCOME_HORIZON_DEFINITION;
  if (definition !== INCOME_HORIZON_DEFINITION) return null;
  return {
    ...threadHeader(THREAD_KINDS.INCOME_HORIZON, accountId, updatedAt),
    incomeDate,
    windowStart,
    windowEnd,
    definition,
  };
}

function mapLookup(ds, accountId, updatedAt) {
  const period = copyPeriod(ds && ds.lastPeriod);
  const hasSubject = !!(ds && ds.lastSubjectKind && ds.lastSubjectValue);
  if (!hasSubject && !period) return null;
  const thread = threadHeader(THREAD_KINDS.LOOKUP, accountId, updatedAt);
  if (hasSubject) {
    thread.subjectKind = String(ds.lastSubjectKind).slice(0, 32);
    thread.subjectValue = String(ds.lastSubjectValue).slice(0, 64);
  }
  if (period) thread.period = period;
  return thread;
}

function mapAnalysisLike(kind, ds, accountId, updatedAt) {
  const thread = threadHeader(kind, accountId, updatedAt);
  const period = copyPeriod(ds && ds.lastPeriod);
  if (period) thread.period = period;
  return thread;
}

function mapAffordability(ds, accountId, updatedAt) {
  const thread = threadHeader(THREAD_KINDS.AFFORDABILITY, accountId, updatedAt);
  if (ds.lastSubjectKind === 'amount' && ds.lastSubjectValue != null && ds.lastSubjectValue !== '') {
    const amount = Number(ds.lastSubjectValue);
    if (Number.isFinite(amount) && amount > 0) thread.amount = amount;
  }
  const purchaseDate = copyIsoDate(ds.lastPurchaseDate);
  if (purchaseDate) thread.purchaseDate = purchaseDate;
  if (ds.lastPurchaseDateAssumption) {
    thread.purchaseDateAssumption = String(ds.lastPurchaseDateAssumption).slice(0, 64);
  }
  if (ds.lastPurchaseDateAssumptionText) {
    thread.purchaseDateAssumptionText = String(ds.lastPurchaseDateAssumptionText).slice(0, 160);
  }
  const period = copyPeriod(ds && ds.lastPeriod);
  if (period) thread.period = period;
  return thread;
}

function mapThread(kind, ds, accountId, updatedAt) {
  switch (kind) {
    case THREAD_KINDS.COMPARISON:
      return mapComparison(ds, accountId, updatedAt);
    case THREAD_KINDS.TREND:
      return mapTrend(ds, accountId, updatedAt);
    case THREAD_KINDS.RECURRING:
      return mapRecurring(ds, accountId, updatedAt);
    case THREAD_KINDS.UPCOMING:
      return mapUpcoming(ds, accountId, updatedAt);
    case THREAD_KINDS.INCOME_HORIZON:
      return mapIncomeHorizon(ds, accountId, updatedAt);
    case THREAD_KINDS.LOOKUP:
      return mapLookup(ds, accountId, updatedAt);
    case THREAD_KINDS.ANALYSIS:
      return mapAnalysisLike(THREAD_KINDS.ANALYSIS, ds, accountId, updatedAt);
    case THREAD_KINDS.FORECAST:
      return mapAnalysisLike(THREAD_KINDS.FORECAST, ds, accountId, updatedAt);
    case THREAD_KINDS.AFFORDABILITY:
      return mapAffordability(ds, accountId, updatedAt);
    default:
      return null;
  }
}

function validatePeriod(period, { requireRelation } = {}) {
  if (!period || typeof period !== 'object') return false;
  if (!isIsoDate(period.start) || !isIsoDate(period.end)) return false;
  if (requireRelation && !period.relation && !period.label) return false;
  return true;
}

function validateThread(thread) {
  if (!thread || typeof thread !== 'object' || !thread.kind) return false;
  if (!Object.values(THREAD_KINDS).includes(thread.kind)) return false;
  if (thread.accountId == null || thread.accountId === '') return false;
  switch (thread.kind) {
    case THREAD_KINDS.COMPARISON:
      return validatePeriod(thread.periodA) && validatePeriod(thread.periodB);
    case THREAD_KINDS.TREND:
      return Array.isArray(thread.periods) && thread.periods.length > 0
        && thread.periods.every((p) => validatePeriod(p));
    case THREAD_KINDS.RECURRING:
      return RECURRING_SCOPES.has(thread.metricScope)
        && (thread.rankingMode === null || thread.rankingMode === 'largest');
    case THREAD_KINDS.UPCOMING:
      return validatePeriod(thread.period) && UPCOMING_SCOPES.has(thread.metricScope);
    case THREAD_KINDS.INCOME_HORIZON:
      return isIsoDate(thread.incomeDate)
        && isIsoDate(thread.windowStart)
        && isIsoDate(thread.windowEnd)
        && thread.definition === INCOME_HORIZON_DEFINITION
        && thread.incomeAmount === undefined
        && thread.combinedIncomeAmount === undefined;
    case THREAD_KINDS.LOOKUP:
      return !!(thread.subjectKind && thread.subjectValue) || validatePeriod(thread.period);
    case THREAD_KINDS.ANALYSIS:
    case THREAD_KINDS.FORECAST:
      return thread.period == null || validatePeriod(thread.period);
    case THREAD_KINDS.AFFORDABILITY: {
      if (thread.amount != null && !(Number.isFinite(thread.amount) && thread.amount > 0)) return false;
      if (thread.purchaseDate != null && !isIsoDate(thread.purchaseDate)) return false;
      if (thread.purchaseDateAssumption != null && typeof thread.purchaseDateAssumption !== 'string') return false;
      if (thread.purchaseDateAssumptionText != null && typeof thread.purchaseDateAssumptionText !== 'string') return false;
      if (thread.period != null && !validatePeriod(thread.period)) return false;
      return true;
    }
    default:
      return false;
  }
}

function isConversationCapsuleV1(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.version !== CAPSULE_VERSION) return false;
  if (!Object.prototype.hasOwnProperty.call(value, 'accountId')) return false;
  if (!Object.prototype.hasOwnProperty.call(value, 'activeThread')) return false;
  if (value.activeThread == null) return true;
  return validateThread(value.activeThread);
}

function validateConversationCapsule(value) {
  if (!isConversationCapsuleV1(value)) {
    return { ok: false, capsule: null };
  }
  return { ok: true, capsule: value };
}

/**
 * Derive a V1 Conversation Capsule from existing dialogue-state lastX fields.
 *
 * Active thread is chosen by lastCapability only — never "whichever lastX
 * is populated." Zombie lastX objects from prior capabilities are ignored.
 *
 * updatedAt is copied from dialogueState.updatedAt (or null). This helper
 * does not invent a timestamp.
 *
 * @param {object} dialogueState
 * @param {string|number} [currentAccountId] selected account for this request
 * @returns {object} ConversationCapsule V1
 */
function deriveConversationCapsule(dialogueState, currentAccountId) {
  const ds = dialogueState && typeof dialogueState === 'object' ? dialogueState : {};
  const updatedAt = ds.updatedAt == null || ds.updatedAt === '' ? null : ds.updatedAt;
  const lastAccountId = normalizeAccountId(ds.lastAccountId);
  const selectedId = arguments.length > 1 ? normalizeAccountId(currentAccountId) : null;
  const lastCap = ds.lastCapability || null;
  const kind = lastCap ? CAPABILITY_TO_KIND[lastCap] : null;

  if (!lastCap) {
    return emptyCapsule(lastAccountId, updatedAt);
  }
  if (!kind) {
    return emptyCapsule(lastAccountId, updatedAt, INVALID.UNSUPPORTED_CAPABILITY);
  }
  if (!lastAccountId) {
    return emptyCapsule(null, updatedAt, INVALID.MISSING_ACCOUNT);
  }
  if (arguments.length > 1 && !accountsMatch(lastAccountId, selectedId)) {
    return emptyCapsule(lastAccountId, updatedAt, INVALID.ACCOUNT_MISMATCH);
  }

  const thread = mapThread(kind, ds, lastAccountId, updatedAt);
  if (!thread || !validateThread(thread)) {
    return emptyCapsule(lastAccountId, updatedAt, INVALID.MALFORMED_THREAD);
  }
  return {
    version: CAPSULE_VERSION,
    accountId: lastAccountId,
    updatedAt,
    activeThread: thread,
  };
}

/**
 * Persistence projection: valid Capsule V1 with an active thread, or null.
 *
 * - Derives from lastX / lastCapability only (ignores any existing .capsule).
 * - Strips invalidReason (debug/derivation metadata, never stored).
 * - Returns null when there is no active referent (canonical empty contract).
 * - Returns null rather than a malformed object.
 *
 * Does not take currentAccountId: persistence projects the stored lastAccountId
 * thread. Request-vs-stored account mismatch is a routing concern, not a reason
 * to fabricate or wipe the stored projection here.
 */
function projectConversationCapsule(dialogueState) {
  const derived = deriveConversationCapsule(dialogueState);
  if (!derived || derived.activeThread == null) return null;
  const persisted = {
    version: derived.version,
    accountId: derived.accountId,
    updatedAt: derived.updatedAt,
    activeThread: derived.activeThread,
  };
  if (!isConversationCapsuleV1(persisted)) return null;
  return persisted;
}

function isAuthoritativeEmptyCapsule(capsule) {
  return !!(
    capsule
    && typeof capsule === 'object'
    && isConversationCapsuleV1(capsule)
    && Object.prototype.hasOwnProperty.call(capsule, 'activeThread')
    && capsule.activeThread == null
  );
}

function emptyAuthoritativeCapsule(accountId, updatedAt) {
  return {
    version: CAPSULE_VERSION,
    accountId: accountId == null || accountId === '' ? null : String(accountId),
    updatedAt: updatedAt == null ? null : updatedAt,
    activeThread: null,
  };
}

/**
 * Production load/fallback:
 * 1. Valid persisted Capsule with a thread → Capsule wins (even vs lastCapability).
 * 2. Valid persisted Capsule with activeThread null → authoritative empty, no lastX fallback.
 * 3. Missing / corrupt / unknown version → derive from lastX when possible.
 * Never throws.
 */
function resolveCurrentConversationCapsule(dialogueState, currentAccountId) {
  try {
    const ds = dialogueState && typeof dialogueState === 'object' ? dialogueState : {};
    const persisted = ds.capsule;
    if (isConversationCapsuleV1(persisted) && persisted.activeThread) {
      return persisted;
    }
    if (isAuthoritativeEmptyCapsule(persisted)) {
      return persisted;
    }
    if (arguments.length > 1) {
      const derived = deriveConversationCapsule(ds, currentAccountId);
      if (derived && isConversationCapsuleV1(derived)) return derived;
      return null;
    }
    const derived = deriveConversationCapsule(ds);
    if (derived && isConversationCapsuleV1(derived)) return derived;
    return null;
  } catch (e) {
    return null;
  }
}

function syncConversationCapsule(dialogueState) {
  if (!dialogueState || typeof dialogueState !== 'object') return dialogueState;
  if (isAuthoritativeEmptyCapsule(dialogueState.capsule)) {
    dialogueState.capsule = emptyAuthoritativeCapsule(
      dialogueState.capsule.accountId,
      dialogueState.updatedAt == null ? dialogueState.capsule.updatedAt : dialogueState.updatedAt
    );
    return dialogueState;
  }
  dialogueState.capsule = projectConversationCapsule(dialogueState);
  return dialogueState;
}

function persistedCapsuleEqualsProjection(dialogueState) {
  if (!dialogueState || typeof dialogueState !== 'object') return false;
  return JSON.stringify(dialogueState.capsule) === JSON.stringify(projectConversationCapsule(dialogueState));
}

/**
 * Low-cardinality Capsule telemetry. No account ids, subjects, or amounts.
 * Semantics: authoritative Capsule intended for the next turn (the loaded or
 * post-persist Capsule, not a zombie lastX inference).
 */
function capsuleTelemetryFields(capsule, currentAccountId) {
  const valid = !!(capsule && isConversationCapsuleV1(capsule) && capsule.activeThread);
  let accountMatch = null;
  if (valid && currentAccountId != null && currentAccountId !== '') {
    accountMatch = accountsMatch(capsule.accountId, currentAccountId);
  }
  return {
    capsule_present: valid,
    capsule_kind: valid ? capsule.activeThread.kind : 'none',
    capsule_version: valid ? CAPSULE_VERSION : null,
    capsule_account_match: accountMatch,
  };
}

module.exports = {
  CAPSULE_VERSION,
  THREAD_KINDS,
  INVALID,
  deriveConversationCapsule,
  validateConversationCapsule,
  isConversationCapsuleV1,
  projectConversationCapsule,
  syncConversationCapsule,
  persistedCapsuleEqualsProjection,
  capsuleTelemetryFields,
  resolveCurrentConversationCapsule,
  isAuthoritativeEmptyCapsule,
  emptyAuthoritativeCapsule,
};
