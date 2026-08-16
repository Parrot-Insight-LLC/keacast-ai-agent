'use strict';

const moment = require('moment');

const CAPABILITIES = Object.freeze([
  'confirmation',
  'continuation',
  'invitation_continuation',
  'bare_affirmative_unresolved',
  'product_help',
  'casual_conversation',
  'financial_lookup',
  'financial_forecast',
  'cashflow_analysis',
  'affordability_or_planning',
  'mixed_macro',
  'transaction_write',
  'goal_write',
  'simulation',
  'navigation_ui',
  'unknown',
]);

const FINANCIAL_CAPABILITIES = new Set([
  'financial_lookup',
  'financial_forecast',
  'cashflow_analysis',
  'affordability_or_planning',
]);

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

const SUBJECT_MAX = 64;
const MAX_LOOKUP_CLAUSES = 6;
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

function purchaseDateResult(date, assumption, assumptionText) {
  return {
    date,
    assumption: assumption || null,
    assumptionText: assumptionText || null,
    error: null,
  };
}

function parsePurchaseDate(message, currentDate) {
  if (!message) return null;
  const today = moment(currentDate, 'YYYY-MM-DD', true).isValid()
    ? moment(currentDate, 'YYYY-MM-DD')
    : moment();
  const todayStr = today.format('YYYY-MM-DD');
  const m = String(message).toLowerCase();

  if (/\bpayday\b/.test(m) || /\bsometime\b/.test(m)) {
    return { date: null, assumption: null, assumptionText: null, error: 'date_unresolved' };
  }

  const iso = String(message).match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) {
    if (iso[1] < todayStr) {
      return { date: iso[1], assumption: null, assumptionText: null, error: 'past_date' };
    }
    return purchaseDateResult(iso[1]);
  }

  if (/\btomorrow\b/.test(m)) {
    return purchaseDateResult(today.clone().add(1, 'day').format('YYYY-MM-DD'));
  }

  const md = m.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/
  );
  if (md) {
    const month = MONTH_NAMES[md[1]];
    const day = Number(md[2]);
    let candidate = moment({ year: today.year(), month, day });
    if (!candidate.isValid() || candidate.date() !== day) {
      return { date: null, assumption: null, assumptionText: null, error: 'date_unresolved' };
    }
    if (!candidate.isAfter(today, 'day')) {
      candidate = moment({ year: today.year() + 1, month, day });
    }
    return purchaseDateResult(candidate.format('YYYY-MM-DD'));
  }

  const wd = m.match(/\b(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) {
    const want = WEEKDAYS[wd[1]];
    const next = today.clone();
    do {
      next.add(1, 'day');
    } while (next.day() !== want);
    return purchaseDateResult(next.format('YYYY-MM-DD'));
  }

  if (/\bnext month\b/.test(m)) {
    const first = today.clone().add(1, 'month').startOf('month');
    const date = first.format('YYYY-MM-DD');
    return purchaseDateResult(
      date,
      'next_month_first_day',
      `Assuming the purchase is on ${first.format('MMMM D')}...`
    );
  }

  if (/\bthis month\b/.test(m)) {
    return { date: null, assumption: null, assumptionText: null, error: 'date_unresolved' };
  }

  return null;
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

function parseAtToken(text) {
  const m = String(text || '');
  const at = m.match(/\bat\s+([A-Za-z0-9][A-Za-z0-9 &'.-]{1,40})/);
  if (!at) return null;
  const raw = at[1]
    .replace(/\b(last|this|next)\s+(month|week)\b.*$/i, '')
    .replace(/\b(in|on|for)\s+\w+$/i, '')
    .trim();
  if (!raw) return null;
  return { display: raw, value: clipSubject(raw) };
}

function parseMerchant(text) {
  const tok = parseAtToken(text);
  return tok ? tok.value : null;
}

function knownCategorySet(knownCategories) {
  const set = new Set(CATEGORY_WORDS);
  if (Array.isArray(knownCategories)) {
    for (const n of knownCategories) {
      const c = clipSubject(n);
      if (c) set.add(c);
    }
  }
  return set;
}

function isKnownCategoryToken(token, knownCategories) {
  const c = clipSubject(token);
  return !!(c && knownCategorySet(knownCategories).has(c));
}

function extractSlots(message, currentDate, knownCategories) {
  const amount = parseAmount(message);
  const period = parsePeriod(message, currentDate);
  const category = parseCategory(message);
  const atTok = parseAtToken(message);
  const purchase = parsePurchaseDate(message, currentDate);
  let subjectKind = null;
  let subjectValue = null;
  let displaySubject = null;
  if (atTok && isKnownCategoryToken(atTok.value, knownCategories)) {
    subjectKind = 'category';
    subjectValue = atTok.value;
    displaySubject = atTok.display;
  } else if (atTok) {
    subjectKind = 'merchant';
    subjectValue = atTok.value;
    displaySubject = atTok.display;
  } else if (category) {
    subjectKind = 'category';
    subjectValue = category;
    displaySubject = category;
  } else if (amount != null) {
    subjectKind = 'amount';
    subjectValue = String(amount);
  }
  return {
    amount,
    period,
    subjectKind,
    subjectValue,
    displaySubject,
    purchaseDate: purchase && purchase.date ? purchase.date : null,
    purchaseDateAssumption: purchase && purchase.assumption ? purchase.assumption : null,
    purchaseDateAssumptionText: purchase && purchase.assumptionText ? purchase.assumptionText : null,
    purchaseDateError: purchase && purchase.error ? purchase.error : null,
  };
}

function isShortFollowUp(text) {
  const m = String(text || '').trim();
  if (!m || m.length > 80) return false;
  return /^(what about|how about|and (what about|how about)?|this month|last month|next month|that month)\b/i.test(m)
    || /^\$\s*[\d,]+(?:\.\d+)?\s*\??$/i.test(m);
}

function isBareAffirmative(text) {
  const m = String(text || '').trim();
  if (!m || m.length > 40) return false;
  return /^(y(es|ep|eah|up)?|sure|ok(ay)?)(\s+please)?[.!?]*$/i.test(m)
    || /^(go ahead|do it|please do)[.!?]*$/i.test(m);
}

function isBareNegative(text) {
  const m = String(text || '').trim();
  if (!m || m.length > 40) return false;
  return /^(no|nope|nah|no thanks|not now|no thank you)[.!?]*$/i.test(m);
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

function isNegativeRiskQuestion(text) {
  const m = String(text || '').toLowerCase();
  return /\b(go negative|be negative|run out of money|overdraft|will i (be|go) (broke|negative)|driving .{0,60}negative)\b/.test(m);
}

function isCashflowAnalysis(text) {
  const m = String(text || '').toLowerCase();
  if (isNegativeRiskQuestion(text)) return true;
  if (/\bhow am i doing\b/.test(m)) return true;
  if (/\bhow was\b/.test(m)) return true;
  if (/\bwhere is my money going\b/.test(m)) return true;
  if (/\b(biggest|top) spending categor/.test(m)) return true;
  if (/\b(biggest|top) merchants?\b/.test(m)) return true;
  if (/\bmerchants? am i spending\b/.test(m)) return true;
  if (/\bincome\b.+\bexpenses\b/.test(m)) return true;
  if (/\bcash ?flow\b/.test(m)) return true;
  return false;
}

function isMixedMacro(text) {
  return isAffordability(text) && isCashflowAnalysis(text);
}

function isForecast(text) {
  const m = String(text || '').toLowerCase();
  return /\b(go negative|be negative|run out|overdraft|upcoming|projected (balance|low)|will i (be|go) (broke|negative)|next month'?s? (balance|cashflow)|what will my (available )?balance)\b/.test(m);
}

function isLookup(text) {
  const m = String(text || '').toLowerCase();
  return /\b(how much (did i|have i|do i)|spent|spend|spending|what did i spend|balance|available|credit limit|how much (is|was) in)\b/.test(m)
    || /\b(what did .+ cost|cost (last|this|in) )\b/.test(m);
}

function isLookupClause(text) {
  return isLookup(text) || /\b(what did i spend|what did .+ cost)\b/i.test(String(text || ''));
}

function detectWantsUiAction(text) {
  const m = String(text || '').toLowerCase();
  const hasVerb = /\b(show|open|find|list|pull up)\b/.test(m);
  const hasTarget = /\b(transaction|transactions|charges|purchases|search)\b/.test(m);
  return hasVerb && hasTarget;
}

function splitLookupClauses(message) {
  const text = String(message || '');
  const byBreaks = text.split(/(?:\?+|\r?\n)+/);
  const clauses = [];
  for (const chunk of byBreaks) {
    const pieces = chunk.split(/\band\s+(?=(?:how much|what did i spend)\b)/i);
    for (const piece of pieces) {
      const trimmed = String(piece || '').replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '').trim();
      if (trimmed) clauses.push(trimmed);
    }
  }
  return clauses;
}

function lookupFromSlots(slots) {
  if (!slots) return null;
  const hasSubject = slots.subjectKind === 'merchant' || slots.subjectKind === 'category';
  const hasPeriod = !!(slots.period && slots.period.start && slots.period.end);
  if (!hasSubject && !hasPeriod) return null;
  return {
    subjectKind: slots.subjectKind || null,
    subjectValue: slots.subjectValue || null,
    period: slots.period || null,
    displaySubject: slots.displaySubject || slots.subjectValue || null,
  };
}

function extractNavSubjectToken(text) {
  const original = String(text || '');
  const noise = /\b(show\s+me|show|open|find|list|pull\s+up|my|the|from|in|on|at|last|this|next|month|week|january|february|march|april|may|june|july|august|september|october|november|december|transactions|charges|purchases|search)\b/gi;
  const leftover = original
    .replace(noise, ' ')
    .replace(/[^A-Za-z0-9 &'-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!leftover) return null;
  const words = leftover.split(/\s+/).filter(Boolean).slice(0, 3);
  return words.join(' ') || null;
}

function extractLookupRequests(message, currentDate, knownCategories) {
  const clauses = splitLookupClauses(message);
  const accepted = [];
  let extraLookupClauses = 0;
  for (const clause of clauses) {
    if (!isLookupClause(clause)) continue;
    const req = lookupFromSlots(extractSlots(clause, currentDate, knownCategories));
    if (!req) continue;
    if (accepted.length >= MAX_LOOKUP_CLAUSES) {
      extraLookupClauses += 1;
      continue;
    }
    accepted.push(req);
  }
  return { lookupRequests: accepted, capped: extraLookupClauses > 0 };
}

function extractNavLookup(message, currentDate, knownCategories) {
  const slots = extractSlots(message, currentDate, knownCategories);
  if (slots.subjectKind === 'merchant' || slots.subjectKind === 'category') {
    return lookupFromSlots(slots);
  }
  const token = extractNavSubjectToken(message);
  if (!token) return lookupFromSlots({ ...slots, subjectKind: null, subjectValue: null });
  const kind = isKnownCategoryToken(token, knownCategories) ? 'category' : 'merchant';
  return lookupFromSlots({
    ...slots,
    subjectKind: kind,
    subjectValue: clipSubject(token),
    displaySubject: token,
  });
}

function titleCaseSubject(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  return s.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function buildOpenSearchAction(route) {
  if (!route || !route.wantsUiAction) return null;
  const req = Array.isArray(route.lookupRequests) && route.lookupRequests[0]
    ? route.lookupRequests[0]
    : null;
  const slots = req || route.slots || {};
  const action = { type: 'open_search' };
  const term = slots.displaySubject || titleCaseSubject(slots.subjectValue);
  if (term) action.search_term = term;
  if (slots.period && /^\d{4}-\d{2}-\d{2}$/.test(String(slots.period.start || ''))) {
    action.startDate = String(slots.period.start);
  }
  if (slots.period && /^\d{4}-\d{2}-\d{2}$/.test(String(slots.period.end || ''))) {
    action.endDate = String(slots.period.end);
  }
  return action;
}

function mergeOpenSearchUiActions(uiActions, route) {
  const actions = Array.isArray(uiActions) ? uiActions.slice() : [];
  const suggested = buildOpenSearchAction(route);
  if (!suggested) return actions;
  const existing = actions.find((a) => a && a.type === 'open_search');
  if (existing) {
    if (!existing.search_term && suggested.search_term) existing.search_term = suggested.search_term;
    if (!existing.startDate && suggested.startDate) existing.startDate = suggested.startDate;
    if (!existing.endDate && suggested.endDate) existing.endDate = suggested.endDate;
    return actions;
  }
  actions.push(suggested);
  return actions;
}

function attachLookupMeta(result, message, currentDate, knownCategories) {
  const extras = extractLookupRequests(message, currentDate, knownCategories);
  const wantsUi = detectWantsUiAction(message);
  let lookupRequests = extras.lookupRequests;
  if (wantsUi && !lookupRequests.length) {
    const nav = extractNavLookup(message, currentDate, knownCategories);
    if (nav) lookupRequests = [nav];
  }
  let slots = result.slots || {};
  if (result.capability === 'continuation'
    && !lookupRequests.length
    && (slots.subjectKind === 'merchant' || slots.subjectKind === 'category')) {
    const cont = lookupFromSlots(slots);
    if (cont) lookupRequests = [cont];
  }
  if (lookupRequests.length
    && result.capability === 'financial_lookup'
    && slots.subjectKind !== 'account') {
    const first = lookupRequests[0];
    slots = {
      ...slots,
      subjectKind: first.subjectKind || slots.subjectKind,
      subjectValue: first.subjectValue || slots.subjectValue,
      period: first.period || slots.period,
      displaySubject: first.displaySubject || slots.displaySubject,
    };
  }
  if (wantsUi && lookupRequests.length && result.capability === 'navigation_ui') {
    const first = lookupRequests[0];
    slots = {
      ...slots,
      subjectKind: first.subjectKind || slots.subjectKind,
      subjectValue: first.subjectValue || slots.subjectValue,
      period: first.period || slots.period,
      displaySubject: first.displaySubject || slots.displaySubject,
    };
  }
  return {
    ...result,
    slots,
    lookupRequests,
    compoundLookupCapped: extras.capped,
    wantsUiAction: wantsUi,
  };
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

const INVITATION_KINDS = new Set(['add_affordability_expense']);

function normalizePendingInvitation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!INVITATION_KINDS.has(raw.kind)) return null;
  const amount = Number(raw.amount);
  const date = raw.date ? String(raw.date).slice(0, 10) : '';
  if (!(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const status = raw.status === 'referent_asked' ? 'referent_asked' : 'offered';
  return {
    kind: 'add_affordability_expense',
    sourceCapability: 'affordability_or_planning',
    amount,
    date,
    accountId: raw.accountId == null || raw.accountId === '' ? null : String(raw.accountId),
    status,
  };
}

function buildAffordabilityInvitation(route, accountId) {
  const cap = route && (route.capability === 'continuation' ? route.parentCapability : route.capability);
  if (cap !== 'affordability_or_planning') return null;
  const slots = (route && route.slots) || {};
  const amount = Number(slots.amount);
  const date = slots.purchaseDate ? String(slots.purchaseDate).slice(0, 10) : '';
  if (!(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    kind: 'add_affordability_expense',
    sourceCapability: 'affordability_or_planning',
    amount,
    date,
    accountId: accountId == null || accountId === '' ? null : String(accountId),
    status: 'offered',
  };
}

function formatInvitationAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return `$${n}`;
  const fixed = n.toFixed(2).replace(/\.00$/, '');
  return `$${fixed}`;
}

function formatInvitationDate(date) {
  const m = moment(String(date || ''), 'YYYY-MM-DD', true);
  return m.isValid() ? m.format('MMMM D') : '';
}

function buildInvitationClarifyText(invitation) {
  const inv = normalizePendingInvitation(invitation);
  if (!inv) return 'Sure — what would you like me to continue with?';
  const amount = formatInvitationAmount(inv.amount);
  const date = formatInvitationDate(inv.date);
  return `Do you mean you'd like me to add the ${amount} expense on ${date}?`;
}

function buildDeterministicAffirmativeText(route) {
  const resolution = route && route.affirmativeResolution;
  if (resolution === 'declined') return 'Okay.';
  if (resolution === 'invitation_clarify') {
    return buildInvitationClarifyText({
      kind: 'add_affordability_expense',
      amount: route.slots && route.slots.amount,
      date: route.slots && route.slots.purchaseDate,
      status: 'offered',
    });
  }
  if (resolution === 'analysis_clarify') {
    return 'Which would you like me to look at more closely?';
  }
  return 'Sure — what would you like me to continue with?';
}

function isDeterministicAffirmativeCapability(capability) {
  return capability === 'invitation_continuation' || capability === 'bare_affirmative_unresolved';
}

function invitationMatchesAccount(invitation, accountId) {
  const inv = normalizePendingInvitation(invitation);
  if (!inv || !inv.accountId) return false;
  return accountsMatch(inv.accountId, accountId);
}

function applyInvitationLifecycle(dialogueState, route, { accountId } = {}) {
  if (!dialogueState || typeof dialogueState !== 'object') return dialogueState;
  const inv = normalizePendingInvitation(dialogueState.pendingInvitation);
  if (!inv) {
    dialogueState.pendingInvitation = null;
    return dialogueState;
  }
  const cap = route && route.capability;
  if (cap === 'invitation_continuation') {
    if (route.affirmativeResolution === 'declined') {
      dialogueState.pendingInvitation = null;
    } else if (route.affirmativeResolution === 'invitation_clarify') {
      dialogueState.pendingInvitation = { ...inv, status: 'referent_asked' };
    }
    return dialogueState;
  }
  if (cap === 'bare_affirmative_unresolved') {
    dialogueState.pendingInvitation = null;
    return dialogueState;
  }
  if (cap === 'transaction_write') {
    dialogueState.pendingInvitation = null;
    return dialogueState;
  }
  if (cap === 'confirmation') return dialogueState;
  if (cap) dialogueState.pendingInvitation = null;
  return dialogueState;
}

function maybeSetAffordabilityInvitation(dialogueState, {
  route,
  accountId,
  failSoft,
  macroOwnsTurn,
  evidence,
} = {}) {
  if (!dialogueState || typeof dialogueState !== 'object') return dialogueState;
  if (failSoft || !macroOwnsTurn) return dialogueState;
  if (!evidence || evidence.status !== 'ok') return dialogueState;
  const inv = buildAffordabilityInvitation(route, accountId);
  if (inv) dialogueState.pendingInvitation = inv;
  return dialogueState;
}

/**
 * Deterministic first-match capability router. No LLM.
 */
function routeCapabilityUnwrapped(input = {}) {
  const message = String(input.message || '');
  const currentDate = input.currentDate;
  const knownCategories = input.knownCategories;
  const slots = extractSlots(message, currentDate, knownCategories);
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
    affirmativeResolution: 'none',
    invitationWriteHandoff: false,
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
      return { ...base, capability: 'confirmation', confidence: 'high', affirmativeResolution: 'write_confirmation' };
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
    const parsedPurchase = parsePurchaseDate(message, currentDate);
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
    const invitation = normalizePendingInvitation(last.pendingInvitation);
    const invitationOk = invitation && invitationMatchesAccount(invitation, currentAccountId);
    const writeSlots = invitationOk && slots.amount == null && !slots.purchaseDate
      ? {
          ...slots,
          amount: invitation.amount,
          purchaseDate: invitation.date,
          subjectKind: slots.subjectKind || 'amount',
          subjectValue: slots.subjectValue || String(invitation.amount),
        }
      : slots;
    return {
      ...base,
      capability: 'transaction_write',
      confidence: 'high',
      accountChanged,
      slots: writeSlots,
      invitationWriteHandoff: !!invitationOk,
      affirmativeResolution: invitationOk ? 'write_handoff' : 'none',
    };
  }
  if (isNavUtterance(message)) {
    return { ...base, capability: 'navigation_ui', confidence: 'high', accountChanged };
  }
  if (detectWantsUiAction(message)) {
    const nav = extractNavLookup(message, currentDate, knownCategories);
    const navSlots = nav
      ? {
          ...slots,
          subjectKind: nav.subjectKind || slots.subjectKind,
          subjectValue: nav.subjectValue || slots.subjectValue,
          period: nav.period || slots.period,
          displaySubject: nav.displaySubject || slots.displaySubject,
        }
      : slots;
    return {
      ...base,
      capability: 'navigation_ui',
      confidence: 'high',
      accountChanged,
      slots: navSlots,
    };
  }
  if (isCasual(message)) {
    return { ...base, capability: 'casual_conversation', confidence: 'high', accountChanged };
  }
  if (isMixedMacro(message)) {
    return { ...base, capability: 'mixed_macro', confidence: 'high', accountChanged, slots };
  }
  if (isAffordability(message)) {
    return { ...base, capability: 'affordability_or_planning', confidence: 'high', accountChanged, slots };
  }
  if (isCashflowAnalysis(message)) {
    let period = slots.period;
    if (!period && isNegativeRiskQuestion(message)) {
      const today = moment(currentDate, 'YYYY-MM-DD', true).isValid()
        ? moment(currentDate, 'YYYY-MM-DD')
        : moment();
      period = {
        start: today.format('YYYY-MM-DD'),
        end: today.clone().add(90, 'days').format('YYYY-MM-DD'),
        label: 'forecast_horizon',
      };
    } else if (!period) {
      period = parsePeriod('this month', currentDate);
    }
    return {
      ...base,
      capability: 'cashflow_analysis',
      confidence: 'high',
      accountChanged,
      slots: { ...slots, period },
    };
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

  // 6. Bare-affirmative continuation — never unknown, never UI deixis.
  const invitation = normalizePendingInvitation(last.pendingInvitation);
  const invitationOk = invitation && invitationMatchesAccount(invitation, currentAccountId);
  if (isBareNegative(message) && invitation) {
    return {
      ...base,
      capability: 'invitation_continuation',
      confidence: 'high',
      accountChanged,
      affirmativeResolution: 'declined',
    };
  }
  if (isBareAffirmative(message) && !pendingType) {
    if (invitation && !invitationOk) {
      return {
        ...base,
        capability: 'bare_affirmative_unresolved',
        confidence: 'high',
        accountChanged: true,
        affirmativeResolution: 'unresolved_clarify',
      };
    }
    if (invitationOk && invitation.status === 'referent_asked') {
      return {
        ...base,
        capability: 'transaction_write',
        confidence: 'high',
        accountChanged: false,
        invitationWriteHandoff: true,
        affirmativeResolution: 'write_handoff',
        slots: {
          ...slots,
          amount: invitation.amount,
          purchaseDate: invitation.date,
          subjectKind: 'amount',
          subjectValue: String(invitation.amount),
        },
      };
    }
    if (invitationOk) {
      return {
        ...base,
        capability: 'invitation_continuation',
        confidence: 'high',
        accountChanged: false,
        affirmativeResolution: 'invitation_clarify',
        slots: {
          ...slots,
          amount: invitation.amount,
          purchaseDate: invitation.date,
          subjectKind: 'amount',
          subjectValue: String(invitation.amount),
        },
      };
    }
    if (last.lastCapability === 'cashflow_analysis') {
      return {
        ...base,
        capability: 'bare_affirmative_unresolved',
        confidence: 'high',
        accountChanged,
        affirmativeResolution: 'analysis_clarify',
      };
    }
    return {
      ...base,
      capability: 'bare_affirmative_unresolved',
      confidence: 'high',
      accountChanged,
      affirmativeResolution: 'unresolved_clarify',
    };
  }
  if (input.userAffirmative && !pendingType) {
    return {
      ...base,
      capability: 'bare_affirmative_unresolved',
      confidence: 'high',
      accountChanged,
      affirmativeResolution: 'unresolved_clarify',
    };
  }

  // 7. unknown
  return { ...base, capability: 'unknown', confidence: 'low', accountChanged };
}

function routeCapability(input = {}) {
  const result = routeCapabilityUnwrapped(input);
  return attachLookupMeta(
    result,
    String(input.message || ''),
    input.currentDate,
    input.knownCategories
  );
}

const PERSIST_CAPABILITIES = new Set([
  'financial_lookup',
  'financial_forecast',
  'cashflow_analysis',
  'affordability_or_planning',
  'continuation',
]);

function shouldPersistContinuation(route, { failSoft } = {}) {
  if (!route || failSoft) return false;
  if (route.confidence === 'low' && route.capability === 'unknown') return false;
  if (route.capability === 'confirmation'
    || route.capability === 'casual_conversation'
    || route.capability === 'product_help'
    || route.capability === 'navigation_ui'
    || route.capability === 'invitation_continuation'
    || route.capability === 'bare_affirmative_unresolved') {
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
  if (cap === 'affordability_or_planning') {
    dialogueState.lastPurchaseDate = slots.purchaseDate ? String(slots.purchaseDate).slice(0, 10) : null;
    dialogueState.lastPurchaseDateAssumption = slots.purchaseDateAssumption
      ? String(slots.purchaseDateAssumption).slice(0, 64)
      : null;
    dialogueState.lastPurchaseDateAssumptionText = slots.purchaseDateAssumptionText
      ? String(slots.purchaseDateAssumptionText).slice(0, 160)
      : null;
  }
  return dialogueState;
}

function applyContinuationPersistenceFromEvidence(dialogueState, route, evidence, opts) {
  const lookups = Array.isArray(evidence && evidence.lookups) ? evidence.lookups : [];
  let lastOk = null;
  for (const lookup of lookups) {
    if (lookup && lookup.status === 'ok'
      && (lookup.subjectKind === 'merchant' || lookup.subjectKind === 'category')) {
      lastOk = lookup;
    }
  }
  const persistRoute = lastOk
    ? {
        ...route,
        slots: {
          ...(route.slots || {}),
          subjectKind: lastOk.subjectKind,
          subjectValue: lastOk.subjectValue,
          period: lastOk.period,
        },
      }
    : route;
  return applyContinuationPersistence(dialogueState, persistRoute, opts);
}

module.exports = {
  CAPABILITIES,
  FINANCIAL_CAPABILITIES,
  MAX_LOOKUP_CLAUSES,
  routeCapability,
  extractSlots,
  extractLookupRequests,
  parsePeriod,
  parseAmount,
  parsePurchaseDate,
  shouldPersistContinuation,
  applyContinuationPersistence,
  applyContinuationPersistenceFromEvidence,
  asksForFinancialAmount,
  clipSubject,
  isWriteAmendmentOrSlotFill,
  isProductHelp,
  isSimUtterance,
  isLookup,
  isForecast,
  isCashflowAnalysis,
  isAffordability,
  detectWantsUiAction,
  buildOpenSearchAction,
  mergeOpenSearchUiActions,
  isKnownCategoryToken,
  isBareAffirmative,
  isBareNegative,
  isShortFollowUp,
  normalizePendingInvitation,
  buildAffordabilityInvitation,
  applyInvitationLifecycle,
  maybeSetAffordabilityInvitation,
  buildInvitationClarifyText,
  buildDeterministicAffirmativeText,
  isDeterministicAffirmativeCapability,
};
