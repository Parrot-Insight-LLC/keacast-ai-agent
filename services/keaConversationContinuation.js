'use strict';

/**
 * Conversation continuation parser + thread-specific reducers (Phase 3A.4).
 *
 * Determines request-local route slots and the next activeThread after the
 * resolver has already decided this turn is a continuation of a typed thread.
 *
 * Does NOT:
 *   - call Azure, Cashflow, Redis, or tools
 *   - authorize writes, invitations, or simulations
 *   - persist Capsule / lastX
 *   - invent new conversational features
 *
 * Discriminated reducers only. Shared language is parsed generically, but the
 * active thread decides whether an action is valid.
 */

const { THREAD_KINDS } = require('./keaConversationCapsule');
const { shiftCalendarWeek } = require('./keaUpcomingPeriod');

let _router;
function router() {
  if (!_router) _router = require('./keaCapabilityRouter');
  return _router;
}

const GENERIC_ACTIONS = Object.freeze([
  'switch_scope_income',
  'switch_scope_expense',
  'set_category',
  'set_period_from_slots',
  'request_total',
]);

const CAPABILITY_ACTIONS = Object.freeze([
  'recurring_largest',
  'upcoming_week_after',
  'horizon_expenses_before',
  'horizon_negative_check',
  'horizon_after_payday_unsupported',
]);

function copyPeriod(raw, { withRelation } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const start = raw.start != null ? String(raw.start).slice(0, 10) : '';
  const end = raw.end != null ? String(raw.end).slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const period = { start, end };
  if (raw.label) period.label = String(raw.label).slice(0, withRelation ? 32 : 64);
  if (withRelation) {
    const relation = raw.relation || raw.label;
    if (relation) period.relation = String(relation).slice(0, 32);
  }
  return period;
}

function cloneThread(thread) {
  if (!thread || typeof thread !== 'object') return null;
  return JSON.parse(JSON.stringify(thread));
}

function threadWithoutTimestamps(thread) {
  if (!thread || typeof thread !== 'object') return thread;
  const copy = cloneThread(thread);
  delete copy.updatedAt;
  return copy;
}

function threadMutated(before, after) {
  return JSON.stringify(threadWithoutTimestamps(before)) !== JSON.stringify(threadWithoutTimestamps(after));
}

function hasIncomeWord(message) {
  return /\bincome\b/i.test(String(message || ''));
}

function hasExpenseOnlyWord(message) {
  return /\b(expense|bill)/i.test(String(message || '')) && !hasIncomeWord(message);
}

/**
 * Shared continuation language only. The thread reducer decides validity.
 */
function parseContinuationAction(message, activeThread) {
  const out = { responseMode: null, continuationAction: null };
  const kind = activeThread && activeThread.kind;
  const r = router();
  const text = String(message || '');
  if (!kind || !text) return out;

  const income = hasIncomeWord(text);
  const expenseOnly = hasExpenseOnlyWord(text);

  if (kind === THREAD_KINDS.RECURRING) {
    if (r.isRecurringLargestIntent(text)) out.continuationAction = 'recurring_largest';
    else if (income) out.continuationAction = 'switch_scope_income';
    else if (expenseOnly) out.continuationAction = 'switch_scope_expense';
    return out;
  }
  if (kind === THREAD_KINDS.UPCOMING) {
    if (r.isWeekAfterFollowUp(text)) out.continuationAction = 'upcoming_week_after';
    else if (income) out.continuationAction = 'switch_scope_income';
    else if (expenseOnly) out.continuationAction = 'switch_scope_expense';
    else if (r.isUpcomingFollowUp(text)) {
      out.continuationAction = 'request_total';
      out.responseMode = 'total';
    }
    return out;
  }
  if (kind === THREAD_KINDS.INCOME_HORIZON) {
    if (r.isAfterPaydayFollowUp(text)) {
      out.continuationAction = 'horizon_after_payday_unsupported';
    } else if (/\bwill i go negative\b/i.test(text)) {
      out.continuationAction = 'horizon_negative_check';
      out.responseMode = 'negative_check';
    } else if (/\bbefore then\b/i.test(text)) {
      out.continuationAction = 'horizon_expenses_before';
    } else if (r.isIncomeHorizonFollowUp(text) || /how much total|the total/i.test(text)) {
      out.continuationAction = 'request_total';
      out.responseMode = 'total';
    }
    return out;
  }
  if (kind === THREAD_KINDS.TREND) {
    if (income) out.continuationAction = 'switch_scope_income';
    return out;
  }
  if (kind === THREAD_KINDS.LOOKUP || kind === THREAD_KINDS.ANALYSIS || kind === THREAD_KINDS.FORECAST) {
    if (/\b(this month|last month|next month)\b/i.test(text)) {
      out.continuationAction = 'set_period_from_slots';
    }
    return out;
  }
  return out;
}

function parseContinuationActionWithSlots(message, activeThread, slots) {
  const parsed = parseContinuationAction(message, activeThread);
  const kind = activeThread && activeThread.kind;
  if (slots && slots.subjectKind === 'category' && (
    kind === THREAD_KINDS.TREND || kind === THREAD_KINDS.COMPARISON || kind === THREAD_KINDS.LOOKUP
  )) {
    if (!parsed.continuationAction) parsed.continuationAction = 'set_category';
  }
  return parsed;
}

function baseSlotsFromExtracted(slots) {
  return {
    amount: slots && slots.amount != null ? slots.amount : null,
    period: (slots && slots.period) || null,
    subjectKind: (slots && slots.subjectKind) || null,
    subjectValue: (slots && slots.subjectValue) || null,
    purchaseDate: (slots && slots.purchaseDate) || null,
    purchaseDateAssumption: (slots && slots.purchaseDateAssumption) || null,
    purchaseDateAssumptionText: (slots && slots.purchaseDateAssumptionText) || null,
    purchaseDateError: (slots && slots.purchaseDateError) || null,
  };
}

function reduceRecurringThread(message, thread, slots, parsed) {
  const r = router();
  const updated = cloneThread(thread);
  const merged = baseSlotsFromExtracted(slots);
  merged.metricScope = thread.metricScope || 'all';
  merged.rankingMode = r.recurringRankingMode(message, thread.rankingMode);
  if (hasIncomeWord(message)) merged.metricScope = 'income';
  if (hasExpenseOnlyWord(message)) merged.metricScope = 'expense';
  if (/\b(changed|increased|decreased|trend)\b/i.test(message)) {
    merged.recurringError = 'recurring_trend_unsupported';
  }
  updated.metricScope = merged.metricScope;
  updated.rankingMode = merged.rankingMode === 'largest' ? 'largest' : null;
  return finish(updated, merged, parsed);
}

function reduceUpcomingThread(message, thread, slots, parsed) {
  const r = router();
  const updated = cloneThread(thread);
  const merged = baseSlotsFromExtracted(slots);
  merged.period = copyPeriod(thread.period, { withRelation: true }) || merged.period;
  merged.metricScope = thread.metricScope || 'all';
  if (hasIncomeWord(message)) merged.metricScope = 'income';
  if (hasExpenseOnlyWord(message)) merged.metricScope = 'expense';
  if (r.isWeekAfterFollowUp(message)) {
    const rel = merged.period && (merged.period.relation || merged.period.label);
    if (r.isCalendarWeekRelation(rel)) {
      const shifted = shiftCalendarWeek(merged.period);
      if (shifted) merged.period = shifted;
    }
  }
  updated.period = copyPeriod(merged.period, { withRelation: true }) || updated.period;
  updated.metricScope = merged.metricScope;
  return finish(updated, merged, parsed);
}

function reduceIncomeHorizonThread(message, thread, slots, parsed) {
  const r = router();
  const updated = cloneThread(thread);
  const merged = baseSlotsFromExtracted(slots);
  merged.incomeDate = thread.incomeDate || null;
  merged.windowStart = thread.windowStart || null;
  merged.windowEnd = thread.windowEnd || null;
  merged.incomeHorizonDefinition = thread.definition || 'kea_scheduled_recurring_income';
  if (r.isAfterPaydayFollowUp(message)) {
    merged.incomeHorizonError = 'after_income_intraday_unsupported';
  }
  return finish(updated, merged, parsed);
}

function reduceTrendThread(message, thread, slots, parsed) {
  const r = router();
  const updated = cloneThread(thread);
  const merged = baseSlotsFromExtracted(slots);
  merged.periods = Array.isArray(thread.periods) ? thread.periods.map((p) => copyPeriod(p)).filter(Boolean) : null;
  merged.windowKind = thread.windowKind || null;
  merged.metricScope = slots && slots.subjectKind === 'category'
    ? 'category'
    : (thread.metricScope || 'spending');
  const stems = r.categoryStemsIn(message);
  if (stems.size >= 2) merged.trendError = 'compound_trend_unsupported';
  else if (slots && slots.subjectKind === 'merchant') merged.trendError = 'merchant_trend_unsupported';
  updated.periods = merged.periods || updated.periods;
  updated.windowKind = merged.windowKind;
  updated.metricScope = merged.metricScope;
  if (slots && slots.subjectKind === 'category' && slots.subjectValue) {
    updated.categoryFilter = String(slots.subjectValue).slice(0, 64);
  } else {
    delete updated.categoryFilter;
  }
  return finish(updated, merged, parsed);
}

function reduceComparisonThread(message, thread, slots, parsed) {
  const r = router();
  const updated = cloneThread(thread);
  const merged = baseSlotsFromExtracted(slots);
  merged.periodA = copyPeriod(thread.periodA);
  merged.periodB = copyPeriod(thread.periodB);
  merged.windowKind = thread.windowKind || null;
  if (r.categoryStemsIn(message).size >= 2) {
    merged.comparisonError = 'compound_comparison_unsupported';
  }
  updated.periodA = merged.periodA || updated.periodA;
  updated.periodB = merged.periodB || updated.periodB;
  updated.windowKind = merged.windowKind;
  if (slots && slots.subjectKind === 'category' && slots.subjectValue) {
    updated.category = String(slots.subjectValue).slice(0, 64);
  }
  return finish(updated, merged, parsed);
}

function reduceLookupThread(message, thread, slots, parsed) {
  const updated = cloneThread(thread);
  const merged = baseSlotsFromExtracted(slots);
  if (!merged.period && thread.period) merged.period = copyPeriod(thread.period);
  if (!merged.subjectKind && thread.subjectKind) {
    merged.subjectKind = thread.subjectKind;
    merged.subjectValue = thread.subjectValue;
  }
  if (merged.subjectKind) {
    updated.subjectKind = merged.subjectKind;
    updated.subjectValue = merged.subjectValue;
  }
  if (merged.period) updated.period = copyPeriod(merged.period);
  return finish(updated, merged, parsed);
}

function reduceAnalysisLikeThread(message, thread, slots, parsed) {
  const updated = cloneThread(thread);
  const merged = baseSlotsFromExtracted(slots);
  if (!merged.period && thread.period) merged.period = copyPeriod(thread.period);
  if (merged.period) updated.period = copyPeriod(merged.period);
  return finish(updated, merged, parsed);
}

function reduceAffordabilityThread(message, thread, slots, parsed, clientDate) {
  const r = router();
  const updated = cloneThread(thread);
  const merged = baseSlotsFromExtracted(slots);
  if (merged.amount == null && thread.amount != null) {
    merged.amount = thread.amount;
    merged.subjectKind = 'amount';
    merged.subjectValue = String(thread.amount);
  }
  if (!merged.period && thread.period) merged.period = copyPeriod(thread.period);
  merged.purchaseDate = thread.purchaseDate || merged.purchaseDate || null;
  merged.purchaseDateAssumption = thread.purchaseDateAssumption || merged.purchaseDateAssumption || null;
  merged.purchaseDateAssumptionText = thread.purchaseDateAssumptionText || merged.purchaseDateAssumptionText || null;
  merged.purchaseDateError = null;

  if (slots && slots.subjectKind) {
    merged.subjectKind = slots.subjectKind;
    merged.subjectValue = slots.subjectValue;
  } else if (thread.amount != null) {
    merged.subjectKind = merged.subjectKind || 'amount';
    merged.subjectValue = merged.subjectValue || String(thread.amount);
  }
  if (slots && slots.amount != null) {
    merged.subjectKind = 'amount';
    merged.subjectValue = String(slots.amount);
    merged.amount = slots.amount;
  }

  const parsedPurchase = r.parsePurchaseDate(message, clientDate);
  if (parsedPurchase && parsedPurchase.error) {
    merged.purchaseDateError = parsedPurchase.error;
    if (parsedPurchase.date) merged.purchaseDate = parsedPurchase.date;
  } else if (parsedPurchase && parsedPurchase.date) {
    merged.purchaseDate = parsedPurchase.date;
    merged.purchaseDateAssumption = parsedPurchase.assumption;
    merged.purchaseDateAssumptionText = parsedPurchase.assumptionText;
    merged.purchaseDateError = null;
  }

  if (merged.amount != null && Number.isFinite(Number(merged.amount)) && Number(merged.amount) > 0) {
    updated.amount = Number(merged.amount);
  }
  if (merged.period) updated.period = copyPeriod(merged.period);
  if (merged.purchaseDate) updated.purchaseDate = String(merged.purchaseDate).slice(0, 10);
  if (merged.purchaseDateAssumption) {
    updated.purchaseDateAssumption = String(merged.purchaseDateAssumption).slice(0, 64);
  }
  if (merged.purchaseDateAssumptionText) {
    updated.purchaseDateAssumptionText = String(merged.purchaseDateAssumptionText).slice(0, 160);
  }
  return finish(updated, merged, parsed);
}

function finish(updatedThread, slots, parsed) {
  delete updatedThread.responseMode;
  const error = slots.recurringError
    || slots.trendError
    || slots.comparisonError
    || slots.incomeHorizonError
    || slots.purchaseDateError
    || null;
  return {
    updatedThread,
    slots,
    responseMode: parsed.responseMode || null,
    continuationAction: parsed.continuationAction || null,
    supported: true,
    error,
  };
}

function unsupportedResult(slots, parsed, error) {
  return {
    updatedThread: null,
    slots: slots || {},
    responseMode: parsed && parsed.responseMode || null,
    continuationAction: parsed && parsed.continuationAction || null,
    supported: false,
    error: error || 'unsupported_continuation',
  };
}

/**
 * Apply a continuation action to a typed activeThread.
 * `clientDate` is used only for parsePurchaseDate / extractSlots — never to
 * re-resolve an already stored upcoming period.
 */
function applyConversationContinuation(input = {}) {
  const message = String(input.message || '');
  const activeThread = input.activeThread && typeof input.activeThread === 'object'
    ? input.activeThread
    : null;
  const clientDate = input.clientDate;
  const knownCategories = input.knownCategories;
  const r = router();
  const slots = input.slots || r.extractSlots(message, clientDate, knownCategories);
  const parsed = parseContinuationActionWithSlots(message, activeThread, slots);

  if (!activeThread || !activeThread.kind) {
    return unsupportedResult(slots, parsed, 'no_active_thread');
  }

  switch (activeThread.kind) {
    case THREAD_KINDS.RECURRING:
      return reduceRecurringThread(message, activeThread, slots, parsed);
    case THREAD_KINDS.UPCOMING:
      return reduceUpcomingThread(message, activeThread, slots, parsed);
    case THREAD_KINDS.INCOME_HORIZON:
      return reduceIncomeHorizonThread(message, activeThread, slots, parsed);
    case THREAD_KINDS.TREND:
      return reduceTrendThread(message, activeThread, slots, parsed);
    case THREAD_KINDS.COMPARISON:
      return reduceComparisonThread(message, activeThread, slots, parsed);
    case THREAD_KINDS.LOOKUP:
      return reduceLookupThread(message, activeThread, slots, parsed);
    case THREAD_KINDS.ANALYSIS:
    case THREAD_KINDS.FORECAST:
      return reduceAnalysisLikeThread(message, activeThread, slots, parsed);
    case THREAD_KINDS.AFFORDABILITY:
      return reduceAffordabilityThread(message, activeThread, slots, parsed, clientDate);
    default:
      return unsupportedResult(slots, parsed, 'unsupported_thread_kind');
  }
}

function buildConversationClarifyText(route, message) {
  const m = String((route && route.message) || message || '').trim().toLowerCase();
  if (route && route.accountChanged) {
    return 'I need a period or financial view for this account. What should I look at?';
  }
  if (/how much total|what(?:'|’)?s the total|^the total\b/.test(m)) {
    return 'Which period or financial view would you like the total for?';
  }
  if (/what about income|how about income/.test(m)) {
    return 'Which period or analysis would you like me to use for income?';
  }
  if (/which is (the )?largest|what(?:'|’)?s the largest|^the largest\b/.test(m)) {
    return 'Which recurring items would you like me to rank?';
  }
  if (/week after/.test(m)) {
    return 'Which week should I look at?';
  }
  if (/before then/.test(m)) {
    return 'Which date or paycheck should I look at expenses before?';
  }
  return 'Which period or financial view would you like me to use?';
}

function relevantSlotKeysForKind(kind) {
  switch (kind) {
    case THREAD_KINDS.RECURRING:
      return ['metricScope', 'rankingMode', 'recurringError'];
    case THREAD_KINDS.UPCOMING:
      return ['period', 'metricScope'];
    case THREAD_KINDS.INCOME_HORIZON:
      return ['incomeDate', 'windowStart', 'windowEnd', 'incomeHorizonDefinition', 'incomeHorizonError'];
    case THREAD_KINDS.TREND:
      return ['periods', 'windowKind', 'metricScope', 'subjectKind', 'subjectValue', 'trendError'];
    case THREAD_KINDS.COMPARISON:
      return ['periodA', 'periodB', 'windowKind', 'subjectKind', 'subjectValue', 'comparisonError'];
    case THREAD_KINDS.LOOKUP:
      return ['subjectKind', 'subjectValue', 'period'];
    case THREAD_KINDS.ANALYSIS:
    case THREAD_KINDS.FORECAST:
      return ['period'];
    case THREAD_KINDS.AFFORDABILITY:
      return [
        'amount', 'purchaseDate', 'purchaseDateAssumption', 'purchaseDateAssumptionText',
        'purchaseDateError', 'subjectKind', 'subjectValue', 'period',
      ];
    default:
      return [];
  }
}

function pickRelevantSlots(slots, kind) {
  const keys = relevantSlotKeysForKind(kind);
  const out = {};
  for (const key of keys) {
    if (slots && Object.prototype.hasOwnProperty.call(slots, key)) out[key] = slots[key];
  }
  return out;
}

function assertContinuationSlotParity(name, expected, actual, kind) {
  const a = pickRelevantSlots(expected && expected.slots, kind);
  const b = pickRelevantSlots(actual && actual.slots, kind);
  const capabilityMatch = (expected.capability || expected.parentCapability)
    === (actual.capability || actual.parentCapability);
  const continuationMatch = !!expected.continuationUsed === !!actual.continuationUsed;
  const errorMatch = (expected.error || null) === (actual.error || null);
  const responseModeMatch = (expected.responseMode || null) === (actual.responseMode || null);
  const slotMatch = JSON.stringify(a) === JSON.stringify(b);
  return {
    name,
    ok: capabilityMatch && continuationMatch && errorMatch && responseModeMatch && slotMatch,
    capabilityMatch,
    continuationMatch,
    errorMatch,
    responseModeMatch,
    slotMatch,
    expectedSlots: a,
    actualSlots: b,
  };
}

/**
 * Frozen copy of the pre-3A.4 lastX merge, for slot-parity tests only.
 * Production routing must not call this.
 */
function legacyMergeContinuationSlots({ message, last, lastCap, slots, currentDate }) {
  const r = router();
  const parsedPurchase = r.parsePurchaseDate(message, currentDate);
  const merged = {
    amount: slots.amount != null ? slots.amount : (lastCap === 'affordability_or_planning' && last.lastSubjectKind === 'amount'
      ? Number(last.lastSubjectValue)
      : null),
    period: slots.period || last.lastPeriod || null,
    subjectKind: slots.subjectKind || last.lastSubjectKind || null,
    subjectValue: slots.subjectValue || last.lastSubjectValue || null,
    purchaseDate: last.lastPurchaseDate || null,
    purchaseDateAssumption: last.lastPurchaseDateAssumption || null,
    purchaseDateAssumptionText: last.lastPurchaseDateAssumptionText || null,
    purchaseDateError: null,
  };
  if (slots.period) merged.period = slots.period;
  if (slots.subjectKind) {
    merged.subjectKind = slots.subjectKind;
    merged.subjectValue = slots.subjectValue;
  } else {
    merged.subjectKind = last.lastSubjectKind || merged.subjectKind;
    merged.subjectValue = last.lastSubjectValue || merged.subjectValue;
  }
  if (slots.amount != null && (last.lastSubjectKind === 'amount' || lastCap === 'affordability_or_planning')) {
    merged.subjectKind = 'amount';
    merged.subjectValue = String(slots.amount);
    merged.amount = slots.amount;
  }
  if (parsedPurchase && parsedPurchase.error) {
    merged.purchaseDateError = parsedPurchase.error;
    if (parsedPurchase.date) merged.purchaseDate = parsedPurchase.date;
  } else if (parsedPurchase && parsedPurchase.date) {
    merged.purchaseDate = parsedPurchase.date;
    merged.purchaseDateAssumption = parsedPurchase.assumption;
    merged.purchaseDateAssumptionText = parsedPurchase.assumptionText;
    merged.purchaseDateError = null;
  }
  if (lastCap === 'cashflow_comparison' && last.lastComparison) {
    merged.periodA = last.lastComparison.periodA || null;
    merged.periodB = last.lastComparison.periodB || null;
    merged.windowKind = last.lastComparison.windowKind || null;
    if (r.categoryStemsIn(message).size >= 2) {
      merged.comparisonError = 'compound_comparison_unsupported';
    }
  }
  if (lastCap === 'cashflow_trend' && last.lastTrend) {
    merged.periods = last.lastTrend.periods || null;
    merged.windowKind = last.lastTrend.windowKind || null;
    merged.metricScope = slots.subjectKind === 'category'
      ? 'category'
      : (last.lastTrend.metricScope || 'spending');
    if (r.categoryStemsIn(message).size >= 2) {
      merged.trendError = 'compound_trend_unsupported';
    } else if (slots.subjectKind === 'merchant') {
      merged.trendError = 'merchant_trend_unsupported';
    }
  }
  if (lastCap === 'cashflow_recurring' && last.lastRecurring) {
    merged.metricScope = last.lastRecurring.metricScope || 'all';
    merged.rankingMode = r.recurringRankingMode(message, last.lastRecurring.rankingMode);
    if (/\bincome\b/i.test(message)) merged.metricScope = 'income';
    if (/\b(expense|bill)/i.test(message) && !/\bincome\b/i.test(message)) {
      merged.metricScope = 'expense';
    }
    if (/\b(changed|increased|decreased|trend)\b/i.test(message)) {
      merged.recurringError = 'recurring_trend_unsupported';
    }
  }
  if (lastCap === 'cashflow_upcoming' && last.lastUpcoming) {
    merged.period = last.lastUpcoming.period || merged.period;
    merged.metricScope = last.lastUpcoming.metricScope || 'all';
    if (/\bincome\b/i.test(message)) merged.metricScope = 'income';
    if (/\b(expense|bill)/i.test(message) && !/\bincome\b/i.test(message)) {
      merged.metricScope = 'expense';
    }
    if (r.isWeekAfterFollowUp(message)) {
      const rel = merged.period && (merged.period.relation || merged.period.label);
      if (r.isCalendarWeekRelation(rel)) {
        const shifted = shiftCalendarWeek(merged.period);
        if (shifted) merged.period = shifted;
      }
    }
  }
  if (lastCap === 'cashflow_income_horizon' && last.lastIncomeHorizon) {
    merged.incomeDate = last.lastIncomeHorizon.incomeDate || null;
    merged.windowStart = last.lastIncomeHorizon.windowStart || null;
    merged.windowEnd = last.lastIncomeHorizon.windowEnd || null;
    merged.incomeHorizonDefinition = last.lastIncomeHorizon.definition
      || 'kea_scheduled_recurring_income';
    if (r.isAfterPaydayFollowUp(message)) {
      merged.incomeHorizonError = 'after_income_intraday_unsupported';
    }
  }
  return merged;
}

module.exports = {
  GENERIC_ACTIONS,
  CAPABILITY_ACTIONS,
  parseContinuationAction,
  applyConversationContinuation,
  buildConversationClarifyText,
  threadMutated,
  assertContinuationSlotParity,
  pickRelevantSlots,
  relevantSlotKeysForKind,
  legacyMergeContinuationSlots,
};
