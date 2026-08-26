'use strict';

/**
 * Phase 3C.4 Slice 2 — snapshot horizon + list-role identity (shadow only).
 *
 * Derives semantic tuples from existing snapshot paths / list names.
 * Does not calculate finances, totals, minima, or period overlap.
 */

const { parseLedgerPromptFlag } = require('./keaEvidencePromptCutover');
const { CLAIM_KIND } = require('./keaResponseClaimExtractor');

const SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY = 'USE_SNAPSHOT_SEMANTIC_VALIDATION_SHADOW';

const SNAPSHOT_SEMANTIC_REASON = Object.freeze({
  WINDOW_HORIZON_MISMATCH: 'window_horizon_mismatch',
  SEMANTIC_ROLE_MISMATCH: 'semantic_role_mismatch',
  CURRENT_FUTURE_ROLE_MISMATCH: 'current_future_role_mismatch',
  LIST_ROLE_MISMATCH: 'list_role_mismatch',
});

const REASON_PRIORITY = Object.freeze([
  SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH,
  SNAPSHOT_SEMANTIC_REASON.CURRENT_FUTURE_ROLE_MISMATCH,
  SNAPSHOT_SEMANTIC_REASON.SEMANTIC_ROLE_MISMATCH,
  SNAPSHOT_SEMANTIC_REASON.LIST_ROLE_MISMATCH,
]);

const MONTH_INDEX = Object.freeze({
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
});

const MONTH_NAME_RE = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;

function isSnapshotSemanticValidationEnabled() {
  const raw = process.env[SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY];
  if (raw == null || String(raw).trim() === '') return false;
  return parseLedgerPromptFlag(raw).enabled === true;
}

function isSnapshotContract(contract) {
  return !!(contract && contract.sourceKind === 'kea_snapshot');
}

function hasHint(hints, name) {
  return Array.isArray(hints) && hints.indexOf(name) !== -1;
}

function spanDistance(aStart, bStart) {
  if (bStart > aStart) return bStart - aStart;
  return aStart - bStart;
}

function isoMonthYear(iso) {
  const s = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return { year: Number(s.slice(0, 4)), month: Number(s.slice(5, 7)) };
}

function currentPeriodIdentity(contract) {
  const period = contract && contract.scope && contract.scope.period;
  return isoMonthYear(period && period.start) || isoMonthYear(period && period.end);
}

function nextMonthIdentity(current) {
  if (!current || current.month == null) return null;
  let month = Number(current.month) + 1;
  let year = current.year != null ? Number(current.year) : null;
  if (month === 13) {
    month = 1;
    if (year != null) year += 1;
  }
  return { month, year };
}

function eventInNamedMonth(itemDate, named) {
  const id = isoMonthYear(itemDate);
  if (!id || !named || named.month == null) return false;
  if (id.month !== named.month) return false;
  if (named.year != null && id.year != null && named.year !== id.year) return false;
  return true;
}

function eventInNextMonth(itemDate, current) {
  return eventInNamedMonth(itemDate, nextMonthIdentity(current));
}

function tupleFromClaim(claim) {
  const path = claim && claim.path ? String(claim.path) : '';
  const role = claim && claim.semanticRole ? String(claim.semanticRole) : '';
  if (path === 'facts.availableBalance' || role === 'current_available_balance') {
    return {
      metric: 'balance',
      balanceRole: 'available',
      temporalRole: 'current',
      windowKind: null,
      aggregateRole: null,
      listRole: null,
      itemDate: null,
    };
  }
  if (path === 'facts.currentBalance' || role === 'current_balance') {
    return {
      metric: 'balance',
      balanceRole: 'current',
      temporalRole: 'current',
      windowKind: null,
      aggregateRole: null,
      listRole: null,
      itemDate: null,
    };
  }
  if (path === 'facts.reconciledBalance' || role === 'current_reconciled_balance') {
    return {
      metric: 'balance',
      balanceRole: 'reconciled',
      temporalRole: 'current',
      windowKind: null,
      aggregateRole: null,
      listRole: null,
      itemDate: null,
    };
  }
  if (path === 'facts.monthIncome' || role === 'current_month_income') {
    return {
      metric: 'income',
      balanceRole: null,
      temporalRole: 'current_month',
      windowKind: null,
      aggregateRole: null,
      listRole: null,
      itemDate: null,
    };
  }
  if (path === 'facts.monthExpenses' || role === 'current_month_expenses') {
    return {
      metric: 'expense',
      balanceRole: null,
      temporalRole: 'current_month',
      windowKind: null,
      aggregateRole: null,
      listRole: null,
      itemDate: null,
    };
  }
  if (path === 'facts.monthNet' || role === 'current_month_net') {
    return {
      metric: 'net',
      balanceRole: null,
      temporalRole: 'current_month',
      windowKind: null,
      aggregateRole: null,
      listRole: null,
      itemDate: null,
    };
  }
  if (path === 'facts.upcomingExpenseTotal' || role === 'upcoming_window_expense_total') {
    return {
      metric: 'expense',
      balanceRole: null,
      temporalRole: 'next_15_days',
      windowKind: 'next_15_days',
      aggregateRole: 'upcoming_window_total',
      listRole: null,
      itemDate: null,
    };
  }
  if (path === 'facts.upcomingIncomeTotal' || role === 'upcoming_window_income_total') {
    return {
      metric: 'income',
      balanceRole: null,
      temporalRole: 'next_15_days',
      windowKind: 'next_15_days',
      aggregateRole: 'upcoming_window_total',
      listRole: null,
      itemDate: null,
    };
  }
  return {
    metric: role || null,
    balanceRole: null,
    temporalRole: null,
    windowKind: null,
    aggregateRole: null,
    listRole: null,
    itemDate: null,
  };
}

function tupleFromList(hit) {
  const name = hit && hit.listName ? String(hit.listName) : '';
  const date = hit && hit.item && hit.item.date ? hit.item.date : null;
  if (name === 'futureNegativeBalances') {
    return {
      metric: 'balance',
      balanceRole: null,
      temporalRole: 'future_event',
      windowKind: null,
      aggregateRole: null,
      listRole: 'negative_balance_event',
      itemDate: date,
    };
  }
  if (name === 'upcoming') {
    return {
      metric: null,
      balanceRole: null,
      temporalRole: 'next_15_days',
      windowKind: 'next_15_days',
      aggregateRole: null,
      listRole: 'upcoming_item',
      itemDate: date,
    };
  }
  if (name === 'recents') {
    return {
      metric: null,
      balanceRole: null,
      temporalRole: 'recent',
      windowKind: null,
      aggregateRole: null,
      listRole: 'recent_posted_item',
      itemDate: date,
    };
  }
  return {
    metric: null,
    balanceRole: null,
    temporalRole: null,
    windowKind: null,
    aggregateRole: null,
    listRole: name || null,
    itemDate: date,
  };
}

function nearbyTokens(row, extracted, kinds) {
  const amountStart = row && row.start != null ? row.start : 0;
  const rows = Array.isArray(extracted) ? extracted : [];
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const tok = rows[i];
    if (!tok || kinds.indexOf(tok.kind) === -1) continue;
    if (spanDistance(amountStart, tok.start || 0) > 96) continue;
    out.push(tok);
  }
  return out;
}

function spokenNamedMonth(row, extracted) {
  const dates = nearbyTokens(row, extracted, [CLAIM_KIND.PERIOD, CLAIM_KIND.DATE]);
  let best = null;
  for (let i = 0; i < dates.length; i += 1) {
    const tok = dates[i];
    const month = tok.month || MONTH_INDEX[String(tok.rawSpan || '').toLowerCase()] || null;
    if (!month) continue;
    const dist = spanDistance(row.start || 0, tok.start || 0);
    if (!best || dist < best.dist) {
      best = { month, year: tok.year != null ? Number(tok.year) : null, dist, hasDay: tok.day != null };
    }
  }
  const nearby = String((row && row.nearbyTerms) || '');
  const m = nearby.match(MONTH_NAME_RE);
  if (m) {
    const month = MONTH_INDEX[m[1].toLowerCase()];
    if (month && (!best || best.dist > 48)) {
      const yearHit = nearby.match(/\b((?:19|20)\d{2})\b/);
      best = {
        month,
        year: yearHit ? Number(yearHit[1]) : (best && best.year) || null,
        dist: 0,
        hasDay: best && best.hasDay,
      };
    }
  }
  if (!best) return null;
  return { month: best.month, year: best.year, hasDay: best.hasDay === true };
}

function spokenSnapshotSemantics(row, extracted) {
  const nearby = String((row && row.nearbyTerms) || '');
  const hints = (row && row.semanticHints) || [];
  const spoken = {
    balanceRole: null,
    metric: null,
    upcomingExpense: false,
    upcomingIncome: false,
    windowKind: null,
    relativePeriod: null,
    namedMonth: null,
  };

  if (/\bavailable\s+balance\b/i.test(nearby)) spoken.balanceRole = 'available';
  else if (/\breconciled\s+balance\b/i.test(nearby)) spoken.balanceRole = 'reconciled';
  else if (/\bcurrent\s+balance\b/i.test(nearby)) spoken.balanceRole = 'current';

  const upcomingExpense = /\bupcoming\s+expenses?\b/i.test(nearby)
    || (/\bupcoming\b/i.test(nearby) && (hasHint(hints, 'expense') || /\bexpenses?\b/i.test(nearby))
      && !hasHint(hints, 'income') && !/\bincome\b/i.test(nearby));
  const upcomingIncome = /\bupcoming\s+income\b/i.test(nearby)
    || (/\bupcoming\b/i.test(nearby) && (hasHint(hints, 'income') || /\bincome\b/i.test(nearby))
      && !hasHint(hints, 'expense') && !/\bexpenses?\b/i.test(nearby));
  spoken.upcomingExpense = upcomingExpense;
  spoken.upcomingIncome = upcomingIncome;

  const localExpense = /\b(expenses?|bills?)\b/i.test(nearby);
  const localIncome = /\bincome\b/i.test(nearby);
  const localBalance = /\bbalance\b/i.test(nearby) || hasHint(hints, 'balance');

  if (/\bnet\b/i.test(nearby) && !/\bnetflix\b/i.test(nearby)) spoken.metric = 'net';
  else if (spoken.upcomingExpense) spoken.metric = 'expense';
  else if (spoken.upcomingIncome) spoken.metric = 'income';
  else if (spoken.balanceRole) spoken.metric = 'balance';
  else if (localExpense && !localIncome) spoken.metric = 'expense';
  else if (localIncome && !localExpense) spoken.metric = 'income';
  else if (localBalance) spoken.metric = 'balance';

  const relatives = nearbyTokens(row, extracted, [CLAIM_KIND.RELATIVE_PERIOD]);
  for (let i = 0; i < relatives.length; i += 1) {
    const token = String(relatives[i].token || relatives[i].rawSpan || '').toLowerCase().replace(/\s+/g, '_');
    if (token === 'next_month') spoken.relativePeriod = 'next_month';
    else if (token === 'this_month') spoken.relativePeriod = 'this_month';
    else if (token === 'next_week' || token === 'next_two_weeks') {
      spoken.windowKind = token === 'next_two_weeks' ? 'next_two_weeks' : 'next_week';
    }
  }
  if (!spoken.relativePeriod && /\b(?:this month|current[-\s]month)\b/i.test(nearby)) {
    spoken.relativePeriod = 'this_month';
  }
  if (!spoken.relativePeriod && /\bnext month\b/i.test(nearby)) {
    spoken.relativePeriod = 'next_month';
  }
  if (!spoken.windowKind && /\bnext week\b/i.test(nearby)) spoken.windowKind = 'next_week';

  const durations = nearbyTokens(row, extracted, [CLAIM_KIND.DURATION]);
  for (let i = 0; i < durations.length; i += 1) {
    const n = Number(durations[i].normalizedValue);
    const unit = durations[i].unit;
    if (unit === 'days' && n === 15) spoken.windowKind = 'next_15_days';
    else if (unit === 'days' && n === 7) spoken.windowKind = 'next_7_days';
    else if (unit === 'weeks' && n === 1) spoken.windowKind = 'next_week';
    else if (unit === 'weeks' && n === 2) spoken.windowKind = 'next_two_weeks';
    else if (Number.isFinite(n) && (unit === 'days' || unit === 'weeks')) {
      if (spoken.windowKind == null) spoken.windowKind = 'other_window';
    }
  }

  spoken.namedMonth = spokenNamedMonth(row, extracted);
  return spoken;
}

function spokenHasConstraint(spoken) {
  if (!spoken) return false;
  return !!(spoken.balanceRole
    || spoken.upcomingExpense
    || spoken.upcomingIncome
    || spoken.metric
    || spoken.windowKind
    || spoken.relativePeriod
    || (spoken.namedMonth && spoken.namedMonth.month));
}

function mismatchReason(tuple, spoken, currentPeriod) {
  if (spoken.balanceRole) {
    if (tuple.balanceRole !== spoken.balanceRole) {
      return SNAPSHOT_SEMANTIC_REASON.SEMANTIC_ROLE_MISMATCH;
    }
  }

  if (spoken.upcomingExpense) {
    if (!(tuple.metric === 'expense' && tuple.aggregateRole === 'upcoming_window_total')) {
      if (tuple.listRole) return SNAPSHOT_SEMANTIC_REASON.LIST_ROLE_MISMATCH;
      return SNAPSHOT_SEMANTIC_REASON.SEMANTIC_ROLE_MISMATCH;
    }
  }
  if (spoken.upcomingIncome) {
    if (!(tuple.metric === 'income' && tuple.aggregateRole === 'upcoming_window_total')) {
      if (tuple.listRole) return SNAPSHOT_SEMANTIC_REASON.LIST_ROLE_MISMATCH;
      return SNAPSHOT_SEMANTIC_REASON.SEMANTIC_ROLE_MISMATCH;
    }
  }

  if (spoken.metric === 'net' && tuple.metric !== 'net') {
    return SNAPSHOT_SEMANTIC_REASON.SEMANTIC_ROLE_MISMATCH;
  }
  if (spoken.metric === 'expense' && !spoken.upcomingExpense && tuple.metric && tuple.metric !== 'expense') {
    return SNAPSHOT_SEMANTIC_REASON.SEMANTIC_ROLE_MISMATCH;
  }
  if (spoken.metric === 'income' && !spoken.upcomingIncome && tuple.metric && tuple.metric !== 'income') {
    return SNAPSHOT_SEMANTIC_REASON.SEMANTIC_ROLE_MISMATCH;
  }
  if (spoken.metric === 'balance' && spoken.balanceRole && tuple.metric && tuple.metric !== 'balance') {
    return SNAPSHOT_SEMANTIC_REASON.SEMANTIC_ROLE_MISMATCH;
  }

  if (spoken.windowKind === 'next_15_days' && tuple.temporalRole !== 'next_15_days') {
    return SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH;
  }
  if (spoken.windowKind === 'next_7_days'
    || spoken.windowKind === 'next_week'
    || spoken.windowKind === 'next_two_weeks'
    || spoken.windowKind === 'other_window') {
    return SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH;
  }

  if (spoken.relativePeriod === 'next_month') {
    if (tuple.temporalRole === 'next_15_days') {
      return SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH;
    }
    if (tuple.temporalRole === 'current' || tuple.temporalRole === 'current_month') {
      return SNAPSHOT_SEMANTIC_REASON.CURRENT_FUTURE_ROLE_MISMATCH;
    }
    if (tuple.temporalRole === 'future_event' && !eventInNextMonth(tuple.itemDate, currentPeriod)) {
      return SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH;
    }
  }

  if (spoken.relativePeriod === 'this_month') {
    if (tuple.temporalRole && tuple.temporalRole !== 'current_month') {
      if (tuple.temporalRole === 'next_15_days') {
        return SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH;
      }
      if (tuple.temporalRole === 'current') {
        return SNAPSHOT_SEMANTIC_REASON.SEMANTIC_ROLE_MISMATCH;
      }
      return SNAPSHOT_SEMANTIC_REASON.CURRENT_FUTURE_ROLE_MISMATCH;
    }
  }

  if (spoken.namedMonth && spoken.namedMonth.month) {
    if (tuple.temporalRole === 'next_15_days' && tuple.listRole === 'upcoming_item') {
      if (!eventInNamedMonth(tuple.itemDate, spoken.namedMonth)) {
        return SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH;
      }
    } else if (tuple.temporalRole === 'next_15_days') {
      return SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH;
    }
    if (tuple.temporalRole === 'current') {
      return SNAPSHOT_SEMANTIC_REASON.CURRENT_FUTURE_ROLE_MISMATCH;
    }
    if (tuple.temporalRole === 'current_month') {
      const cur = currentPeriod;
      if (!cur || cur.month !== spoken.namedMonth.month
        || (spoken.namedMonth.year != null && cur.year != null && spoken.namedMonth.year !== cur.year)) {
        return SNAPSHOT_SEMANTIC_REASON.CURRENT_FUTURE_ROLE_MISMATCH;
      }
    }
    if (tuple.temporalRole === 'future_event' && !eventInNamedMonth(tuple.itemDate, spoken.namedMonth)) {
      return SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH;
    }
  }

  return null;
}

function pickReason(reasons) {
  for (let i = 0; i < REASON_PRIORITY.length; i += 1) {
    if (reasons.indexOf(REASON_PRIORITY[i]) !== -1) return REASON_PRIORITY[i];
  }
  return SNAPSHOT_SEMANTIC_REASON.SEMANTIC_ROLE_MISMATCH;
}

function collectCandidates(matches, amountCandidates, boundHit) {
  const out = [];
  const rows = Array.isArray(matches) ? matches : [];
  for (let i = 0; i < rows.length; i += 1) {
    out.push({
      tuple: tupleFromClaim(rows[i]),
      claimId: rows[i] && rows[i].claimId ? rows[i].claimId : null,
    });
  }
  const hits = [];
  if (boundHit) hits.push(boundHit);
  else if (Array.isArray(amountCandidates)) {
    for (let i = 0; i < amountCandidates.length; i += 1) hits.push(amountCandidates[i]);
  }
  for (let i = 0; i < hits.length; i += 1) {
    out.push({
      tuple: tupleFromList(hits[i]),
      claimId: null,
    });
  }
  return out;
}

function evaluateSnapshotSemanticIdentity(input) {
  if (!isSnapshotSemanticValidationEnabled()) return { mismatch: false };
  const contract = input && input.contract;
  if (!isSnapshotContract(contract)) return { mismatch: false };
  const row = input && input.row;
  if (!row) return { mismatch: false };

  const spoken = spokenSnapshotSemantics(row, input.extracted);
  if (!spokenHasConstraint(spoken)) return { mismatch: false };

  const candidates = collectCandidates(input.matches, input.amountCandidates, input.boundHit);
  if (!candidates.length) return { mismatch: false };

  const currentPeriod = currentPeriodIdentity(contract);
  const failures = [];
  let evidenceClaimId = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const reason = mismatchReason(candidates[i].tuple, spoken, currentPeriod);
    if (!reason) return { mismatch: false };
    failures.push(reason);
    if (!evidenceClaimId && candidates[i].claimId) evidenceClaimId = candidates[i].claimId;
  }
  return {
    mismatch: true,
    reason: pickReason(failures),
    evidenceClaimId,
  };
}

module.exports = {
  SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY,
  SNAPSHOT_SEMANTIC_REASON,
  isSnapshotSemanticValidationEnabled,
  isSnapshotContract,
  tupleFromClaim,
  tupleFromList,
  spokenSnapshotSemantics,
  evaluateSnapshotSemanticIdentity,
};
