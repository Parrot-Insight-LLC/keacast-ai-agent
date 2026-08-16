'use strict';

const moment = require('moment');

const CAPABILITIES = Object.freeze([
  'confirmation',
  'continuation',
  'product_help',
  'casual_conversation',
  'financial_lookup',
  'financial_forecast',
  'affordability_or_planning',
  'transaction_write',
  'goal_write',
  'simulation',
  'navigation_ui',
  'unknown',
]);

const FINANCIAL_CAPABILITIES = new Set([
  'financial_lookup',
  'financial_forecast',
  'affordability_or_planning',
]);

const SUBJECT_MAX = 64;
const CATEGORY_WORDS = [
  'restaurants', 'restaurant', 'dining', 'groceries', 'grocery', 'gas',
  'rent', 'utilities', 'entertainment', 'travel', 'shopping', 'food',
  'coffee', 'subscriptions', 'insurance', 'healthcare', 'transportation',
];
const MONTH_NAMES = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

function clipSubject(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.slice(0, SUBJECT_MAX);
}

function parseAmount(text) {
  if (!text) return null;
  const m = String(text).match(/\$\s*([\d,]+(?:\.\d+)?)|\b([\d,]+(?:\.\d+)?)\s*(?:dollars|bucks)\b/i);
  if (!m) return null;
  const n = Number((m[1] || m[2] || '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parsePeriod(text, currentDate) {
  if (!text) return null;
  const today = moment(currentDate, 'YYYY-MM-DD', true).isValid()
    ? moment(currentDate, 'YYYY-MM-DD')
    : moment();
  const m = String(text).toLowerCase();

  if (/\blast month\b/.test(m)) {
    const start = today.clone().subtract(1, 'month').startOf('month');
    return {
      start: start.format('YYYY-MM-DD'),
      end: start.clone().endOf('month').format('YYYY-MM-DD'),
      label: 'last_month',
    };
  }
  if (/\bthis month\b/.test(m)) {
    return {
      start: today.clone().startOf('month').format('YYYY-MM-DD'),
      end: today.clone().endOf('month').format('YYYY-MM-DD'),
      label: 'this_month',
    };
  }
  if (/\bnext month\b/.test(m)) {
    const start = today.clone().add(1, 'month').startOf('month');
    return {
      start: start.format('YYYY-MM-DD'),
      end: start.clone().endOf('month').format('YYYY-MM-DD'),
      label: 'next_month',
    };
  }
  if (/\blast week\b/.test(m)) {
    const start = today.clone().subtract(1, 'week').startOf('week');
    return {
      start: start.format('YYYY-MM-DD'),
      end: start.clone().endOf('week').format('YYYY-MM-DD'),
      label: 'last_week',
    };
  }
  if (/\bthis week\b/.test(m)) {
    return {
      start: today.clone().startOf('week').format('YYYY-MM-DD'),
      end: today.clone().endOf('week').format('YYYY-MM-DD'),
      label: 'this_week',
    };
  }

  const named = m.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b(?:\s+(\d{4}))?/
  );
  if (named) {
    const month = MONTH_NAMES[named[1]];
    const year = named[2] ? Number(named[2]) : today.year();
    const start = moment({ year, month, day: 1 });
    return {
      start: start.format('YYYY-MM-DD'),
      end: start.clone().endOf('month').format('YYYY-MM-DD'),
      label: 'named_month',
    };
  }
  return null;
}

function parseCategory(text) {
  const m = String(text || '').toLowerCase();
  for (const word of CATEGORY_WORDS) {
    if (new RegExp(`\\b${word}\\b`).test(m)) return clipSubject(word);
  }
  const onCat = m.match(/\bon\s+([a-z][a-z0-9 &-]{1,40})/);
  if (onCat) {
    const raw = onCat[1].replace(/\b(last|this|next)\s+(month|week)\b.*$/, '').trim();
    if (raw) return clipSubject(raw);
  }
  return null;
}

function parseMerchant(text) {
  const m = String(text || '');
  const at = m.match(/\bat\s+([A-Za-z0-9][A-Za-z0-9 &'.-]{1,40})/);
  if (!at) return null;
  const raw = at[1]
    .replace(/\b(last|this|next)\s+(month|week)\b.*$/i, '')
    .replace(/\b(in|on|for)\s+\w+$/i, '')
    .trim();
  return clipSubject(raw);
}

function extractSlots(message, currentDate) {
  const amount = parseAmount(message);
  const period = parsePeriod(message, currentDate);
  const category = parseCategory(message);
  const merchant = parseMerchant(message);
  let subjectKind = null;
  let subjectValue = null;
  if (merchant) {
    subjectKind = 'merchant';
    subjectValue = merchant;
  } else if (category) {
    subjectKind = 'category';
    subjectValue = category;
  } else if (amount != null) {
    subjectKind = 'amount';
    subjectValue = String(amount);
  }
  return { amount, period, subjectKind, subjectValue };
}

function isShortFollowUp(text) {
  const m = String(text || '').trim();
  if (!m || m.length > 80) return false;
  return /^(what about|how about|and (what about|how about)?|this month|last month|next month|that month)\b/i.test(m)
    || /^\$\s*[\d,]+(?:\.\d+)?\s*\??$/i.test(m);
}

function accountsMatch(a, b) {
  if (a == null || b == null || a === '' || b === '') return false;
  return String(a) === String(b);
}

function isWriteUtterance(text) {
  const m = String(text || '').toLowerCase();
  return /\b(add|create|delete|remove|update|change|schedule|log|move)\b/.test(m)
    && /\b(forecast|transaction|expense|income|bill|goal|purchase)\b/.test(m)
    || /\b(add|create|schedule)\b.{0,40}\b(forecast|expense|income|bill)\b/.test(m)
    || /\bdelete (the |that |this )?(forecast|transaction|expense|income)\b/.test(m);
}

function isGoalWriteUtterance(text) {
  const m = String(text || '').toLowerCase();
  return /\b(goal|save toward|savings goal)\b/.test(m)
    && /\b(add|create|update|delete|remove|change|set)\b/.test(m);
}

function isSimUtterance(text) {
  const m = String(text || '').toLowerCase();
  return /\b(what if|hypothetically|simulate|if i (had|added|removed|cancelled|didn't))\b/.test(m);
}

function isNavUtterance(text) {
  const m = String(text || '').toLowerCase();
  return /\b(open|go to|show|switch to|select account|take me to|navigate)\b/.test(m)
    && /\b(calendar|search|account|settings|goals|feed|day)\b/.test(m);
}

function isProductHelp(text) {
  const m = String(text || '').toLowerCase();
  if (/\b(spend|spent|afford|negative)\b/.test(m)) return false;
  if (/\bhow much\b/.test(m) && !/\bsimulation mode\b/.test(m)) return false;
  if (/\b(what is|how does|how do i|explain)\b.{0,48}\bsimulation( mode)?\b/.test(m)) return true;
  if (/\b(spend|spent|balance|afford|negative|how much)\b/.test(m)
    && !/\bsimulation( mode)?\b/.test(m)) return false;
  return /\bwhat is (reconciliation|a forecast|keacast|matching|a satellite|rollover|simulation mode)\b/.test(m)
    || /\bhow (does|do i|can i) (reconciliation|keacast|matching|forecast|simulation)/.test(m)
    || /\b(what is reconciliation|how does keacast|how do i (use|link|match))\b/.test(m)
    || /\bexplain (reconciliation|forecasting|matching|simulation mode)\b/.test(m);
}

function isCasual(text) {
  const m = String(text || '').trim().toLowerCase();
  return /^(hi|hey|hello|thanks|thank you|yo|sup|good (morning|afternoon|evening))(\s+kea)?[!?.]*$/i.test(m)
    || /^hi kea[!?.]*$/i.test(m);
}

function isAffordability(text) {
  const m = String(text || '').toLowerCase();
  return /\b(can i afford|afford|do i have enough|is \$?[\d,]+ (ok|safe|fine|too much))\b/.test(m);
}

function isForecast(text) {
  const m = String(text || '').toLowerCase();
  return /\b(go negative|be negative|run out|overdraft|upcoming|projected (balance|low)|will i (be|go) (broke|negative)|next month'?s? (balance|cashflow)|what will my (available )?balance)\b/.test(m);
}

function isLookup(text) {
  const m = String(text || '').toLowerCase();
  return /\b(how much (did i|have i|do i)|spent|spend|spending|what did i spend|balance|available|credit limit|how much (is|was) in)\b/.test(m);
}

function asksForFinancialAmount(text) {
  const m = String(text || '').toLowerCase();
  return /\$\s*\d/.test(m)
    || /\b(how much|spend|spent|balance|afford|negative|income|expense|total)\b/.test(m);
}

function isClearTopicSwitch(text) {
  return isLookup(text)
    || isForecast(text)
    || isAffordability(text)
    || isProductHelp(text)
    || isCasual(text)
    || isNavUtterance(text)
    || isSimUtterance(text);
}

function draftSlotHaystack(draft) {
  if (!draft || typeof draft !== 'object') return '';
  return ['title', 'category', 'amount', 'start', 'type', 'frequency', 'merchant_name']
    .map((k) => (draft[k] != null ? String(draft[k]).toLowerCase() : ''))
    .filter(Boolean)
    .join(' ');
}

function isWriteAmendmentOrSlotFill(text, pendingDraft) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (isClearTopicSwitch(raw)) return false;
  if (isWriteUtterance(raw) || isGoalWriteUtterance(raw)) return true;
  const m = raw.toLowerCase();
  if (/\b(make it|change it|change that|change the amount|change the date|make that|use \w+ instead|actually use|instead)\b/.test(m)) {
    return true;
  }
  if (/\b(make|change|switch)\b.{0,24}\b(weekly|monthly|bi-?weekly|daily|annually|once)\b/.test(m)) {
    return true;
  }
  if (/^(make it |change (it|that|the amount) (to )?)?\$?\s*[\d,]+(\.\d{2})?\s*$/i.test(m)) {
    return true;
  }
  if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow)\b/.test(m)
    && (/\b(change|make|to|on)\b/.test(m) || m.split(/\s+/).length <= 4)) {
    return true;
  }
  const hay = draftSlotHaystack(pendingDraft);
  if (hay && /\b(use|change|actually|instead|make)\b/.test(m)) {
    const tokens = m.split(/[^a-z0-9.$]+/).filter((t) => t.length > 2);
    if (tokens.some((t) => hay.includes(t))) return true;
  }
  return false;
}

function pendingWriteType(input) {
  if (input.pendingGoalWrite && !input.pendingWrite) return 'goal';
  if (input.pendingWrite && !input.pendingGoalWrite) return 'transaction';
  if (input.pendingWrite && input.pendingGoalWrite) return 'both';
  return null;
}

/**
 * Deterministic first-match capability router. No LLM.
 */
function routeCapability(input = {}) {
  const message = String(input.message || '');
  const currentDate = input.currentDate;
  const slots = extractSlots(message, currentDate);
  const pendingType = pendingWriteType(input);
  const last = input.dialogueState || {};
  const currentAccountId = input.accountId;

  const base = {
    capability: 'unknown',
    parentCapability: null,
    pendingType,
    confidence: 'low',
    continuationUsed: false,
    slots,
    accountChanged: false,
  };

  // 1. Simulation constraints: real-write / what-if language in sim mode
  //    becomes simulation, unless this is an affirmative confirm of a pending write.
  if (input.simulationMode && !(pendingType && input.userAffirmative)) {
    if (isWriteUtterance(message) || isGoalWriteUtterance(message) || isSimUtterance(message)) {
      return { ...base, capability: 'simulation', confidence: 'high' };
    }
  }

  // 2. Pending write + affirmative → confirmation, unless a topic switch
  //    suspended confirmation (needsReconfirm). Generic "yes" must not
  //    commit an old proposal; the draft slots stay for a later re-propose.
  if (pendingType && input.userAffirmative) {
    const ds = input.dialogueState || {};
    const txSuspended = ds.needsReconfirm === true;
    const goalSuspended = ds.goalNeedsReconfirm === true;
    const confirmationSuspended =
      (pendingType === 'goal' && goalSuspended)
      || (pendingType === 'transaction' && txSuspended)
      || (pendingType === 'both' && (txSuspended || goalSuspended));
    if (!confirmationSuspended) {
      return { ...base, capability: 'confirmation', confidence: 'high' };
    }
  }

  // 3. Pending write + amendment / slot-fill only — unrelated topics fall through.
  if (pendingType && !input.userAffirmative) {
    const draft = pendingType === 'goal' ? input.pendingGoalDraft : input.pendingDraft;
    if (isWriteAmendmentOrSlotFill(message, draft || input.pendingDraft)) {
      const capability = pendingType === 'goal' ? 'goal_write' : 'transaction_write';
      return { ...base, capability, confidence: 'high' };
    }
  }

  // 4. Short financial continuation (same authorized account only)
  const lastCap = last.lastCapability;
  const accountChanged = !!(last.lastAccountId && currentAccountId
    && !accountsMatch(last.lastAccountId, currentAccountId));
  const continuationEligible = FINANCIAL_CAPABILITIES.has(lastCap)
    && isShortFollowUp(message)
    && !accountChanged
    && accountsMatch(last.lastAccountId, currentAccountId);

  if (continuationEligible) {
    const merged = {
      amount: slots.amount != null ? slots.amount : (lastCap === 'affordability_or_planning' && last.lastSubjectKind === 'amount'
        ? Number(last.lastSubjectValue)
        : null),
      period: slots.period || last.lastPeriod || null,
      subjectKind: slots.subjectKind || last.lastSubjectKind || null,
      subjectValue: slots.subjectValue || last.lastSubjectValue || null,
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
    return {
      ...base,
      capability: 'continuation',
      parentCapability: lastCap,
      confidence: 'high',
      continuationUsed: true,
      slots: merged,
      accountChanged: false,
    };
  }

  // Account switch: never inherit prior financial subject as continuation.
  // A fully re-specified question still falls through to the normal classifier.
  if (accountChanged && isShortFollowUp(message) && !slots.period && !parseMerchant(message) && !parseCategory(message)) {
    return { ...base, capability: 'unknown', confidence: 'low', accountChanged: true };
  }

  // 5. Deterministic normal classifier
  if (input.simulationMode && isSimUtterance(message)) {
    return { ...base, capability: 'simulation', confidence: 'high', accountChanged };
  }
  if (isProductHelp(message)) {
    return { ...base, capability: 'product_help', confidence: 'high', accountChanged };
  }
  if (isSimUtterance(message)) {
    return { ...base, capability: 'simulation', confidence: 'medium', accountChanged };
  }
  if (isGoalWriteUtterance(message)) {
    return { ...base, capability: 'goal_write', confidence: 'high', accountChanged };
  }
  if (isWriteUtterance(message)) {
    return { ...base, capability: 'transaction_write', confidence: 'high', accountChanged };
  }
  if (isNavUtterance(message)) {
    return { ...base, capability: 'navigation_ui', confidence: 'high', accountChanged };
  }
  if (isCasual(message)) {
    return { ...base, capability: 'casual_conversation', confidence: 'high', accountChanged };
  }
  if (isAffordability(message)) {
    return { ...base, capability: 'affordability_or_planning', confidence: 'high', accountChanged, slots };
  }
  if (isForecast(message)) {
    return { ...base, capability: 'financial_forecast', confidence: 'high', accountChanged, slots };
  }
  if (isLookup(message)) {
    const kind = /\b(balance|available|credit limit)\b/.test(message.toLowerCase()) && !/\b(spend|spent)\b/.test(message.toLowerCase())
      ? 'account'
      : slots.subjectKind;
    const value = kind === 'account' ? 'balance' : slots.subjectValue;
    return {
      ...base,
      capability: 'financial_lookup',
      confidence: 'high',
      accountChanged,
      slots: { ...slots, subjectKind: kind || slots.subjectKind, subjectValue: value || slots.subjectValue },
    };
  }

  // 6. unknown
  return { ...base, capability: 'unknown', confidence: 'low', accountChanged };
}

const PERSIST_CAPABILITIES = new Set([
  'financial_lookup',
  'financial_forecast',
  'affordability_or_planning',
  'continuation',
]);

function shouldPersistContinuation(route, { failSoft } = {}) {
  if (!route || failSoft) return false;
  if (route.confidence === 'low' && route.capability === 'unknown') return false;
  if (route.capability === 'confirmation'
    || route.capability === 'casual_conversation'
    || route.capability === 'product_help'
    || route.capability === 'navigation_ui') {
    return false;
  }
  return PERSIST_CAPABILITIES.has(route.capability);
}

function applyContinuationPersistence(dialogueState, route, { accountId, failSoft } = {}) {
  if (!dialogueState || typeof dialogueState !== 'object') return dialogueState;
  if (!shouldPersistContinuation(route, { failSoft })) return dialogueState;

  const cap = route.capability === 'continuation' ? route.parentCapability : route.capability;
  const slots = route.slots || {};
  dialogueState.lastCapability = cap || null;
  dialogueState.lastSubjectKind = slots.subjectKind || null;
  dialogueState.lastSubjectValue = clipSubject(slots.subjectValue);
  dialogueState.lastPeriod = slots.period && slots.period.label
    ? {
        start: String(slots.period.start || '').slice(0, 10),
        end: String(slots.period.end || '').slice(0, 10),
        label: String(slots.period.label).slice(0, 32),
      }
    : null;
  dialogueState.lastAccountId = accountId == null || accountId === '' ? null : String(accountId);
  return dialogueState;
}

module.exports = {
  CAPABILITIES,
  FINANCIAL_CAPABILITIES,
  routeCapability,
  extractSlots,
  parsePeriod,
  parseAmount,
  shouldPersistContinuation,
  applyContinuationPersistence,
  asksForFinancialAmount,
  clipSubject,
  isWriteAmendmentOrSlotFill,
  isProductHelp,
  isSimUtterance,
  isLookup,
  isForecast,
};
