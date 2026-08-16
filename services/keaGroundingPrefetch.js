'use strict';

const { merchantMatchKey } = require('../utils/vendorNormalize');
const { assertAccountAccess, AccountAccessError } = require('./keaAccountAccess');
const { getTransactionsByUserAndAccountPaginated } = require('./transactions.service');

const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
const MAX_ROWS = 1000;
const UPCOMING_WINDOW_DAYS = 15;

function num(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function emptyEvidence(extra = {}) {
  const out = {
    status: extra.status || 'unavailable',
    source: extra.source || [],
    period: extra.period || null,
    dataAsOf: extra.dataAsOf || null,
    facts: extra.facts || {},
    limitations: extra.limitations || [],
  };
  if (Array.isArray(extra.lookups)) out.lookups = extra.lookups;
  return out;
}

function snapshotDataAsOf(snapshot, currentDate) {
  return snapshot?.dataAsOf || snapshot?.lastSyncAt || currentDate || null;
}

function txnName(t) {
  return String(t?.merchant_name || t?.name || t?.title || '').trim();
}

function txnMatchesSubject(t, subjectKind, subjectValue) {
  if (!subjectKind || !subjectValue) return true;
  const want = merchantMatchKey(subjectValue);
  if (!want) return true;
  if (subjectKind === 'merchant') {
    const keys = [t?.merchant_name, t?.name, t?.title].filter(Boolean).map(merchantMatchKey);
    return keys.some((k) => k && (k === want || k.includes(want) || want.includes(k)));
  }
  if (subjectKind === 'category') {
    const cat = merchantMatchKey(t?.category || '');
    return cat && (cat === want || cat.includes(want) || want.includes(cat));
  }
  return true;
}

function findNamedInList(list, subjectValue) {
  if (!Array.isArray(list) || !subjectValue) return null;
  const want = merchantMatchKey(subjectValue);
  if (!want) return null;
  for (const t of list) {
    const keys = [t?.merchant_name, t?.name, t?.title].filter(Boolean).map(merchantMatchKey);
    if (keys.some((k) => k && (k === want || k.includes(want) || want.includes(k)))) {
      return {
        name: txnName(t) || null,
        amount: num(t.amount),
        date: t.date || t.start || null,
      };
    }
  }
  return null;
}

function negativesInPeriod(snapshot, period) {
  const list = Array.isArray(snapshot?.futureNegativeBalances) ? snapshot.futureNegativeBalances : [];
  if (!period || !period.start || !period.end) {
    return list
      .filter((n) => num(n.amount) != null)
      .map((n) => ({ amount: num(n.amount), date: n.date || null, daysUntil: n.daysUntil || null }));
  }
  return list
    .filter((n) => {
      const d = String(n.date || '').slice(0, 10);
      return d >= period.start && d <= period.end;
    })
    .map((n) => ({ amount: num(n.amount), date: n.date || null, daysUntil: n.daysUntil || null }));
}

function snapshotBalanceFacts(snapshot) {
  const facts = {};
  const reconciled = num(snapshot.reconciledBalance != null ? snapshot.reconciledBalance : snapshot.balance);
  const current = num(snapshot.currentBalance != null ? snapshot.currentBalance : snapshot.current);
  const available = num(snapshot.availableBalance != null ? snapshot.availableBalance : snapshot.available);
  if (reconciled != null) facts.reconciledBalance = reconciled;
  if (current != null) facts.currentBalance = current;
  if (available != null) facts.availableBalance = available;
  const credit = num(snapshot.credit_limit);
  if (credit != null && credit > 0) facts.credit_limit = credit;
  const sav = snapshot.savings && typeof snapshot.savings === 'object' ? snapshot.savings : null;
  if (sav) {
    const income = num(sav.totalIncome);
    const expenses = num(sav.totalExpenses);
    const net = num(sav.netCashFlow);
    const pot = num(sav.savingsPotential);
    if (income != null) facts.monthIncome = income;
    if (expenses != null) facts.monthExpenses = expenses;
    if (net != null) facts.monthNet = net;
    if (pot != null) facts.savingsPotential = pot;
  }
  const upExp = num(snapshot.upcomingExpenseTotal);
  const upInc = num(snapshot.upcomingIncomeTotal);
  if (upExp != null) facts.upcomingExpenseTotal = upExp;
  if (upInc != null) facts.upcomingIncomeTotal = upInc;
  facts.upcomingWindowDays = UPCOMING_WINDOW_DAYS;
  const negs = Array.isArray(snapshot.futureNegativeBalances) ? snapshot.futureNegativeBalances : [];
  facts.negativePreviewCount = negs.length;
  facts.hasNegativePreview = negs.length > 0;
  return facts;
}

function snapshotLimitations(snapshot) {
  const extra = Array.isArray(snapshot && snapshot.limitations) ? snapshot.limitations : [];
  return [
    'upcoming_window_15d',
    'negatives_preview_5_of_90d',
    'recents_capped_10',
    ...extra.filter((x) => typeof x === 'string'),
  ];
}

function hasUsableSnapshot(snapshot) {
  return !!(snapshot && typeof snapshot === 'object'
    && (snapshot.accountid !== undefined || num(snapshot.balance) != null));
}

/**
 * Page through a bounded period until complete or cap.
 * Never treat a single default page as a complete period total.
 */
async function fetchCompletePeriodTransactions({
  trustedUserId,
  accountId,
  startDate,
  endDate,
  fetchPage,
  pageLimit = PAGE_LIMIT,
  maxPages = MAX_PAGES,
  maxRows = MAX_ROWS,
}) {
  const fetch = fetchPage || ((opts) => getTransactionsByUserAndAccountPaginated(
    opts.userId,
    opts.accountId,
    { startDate: opts.startDate, endDate: opts.endDate, page: opts.page, limit: opts.limit }
  ));

  const first = await fetch({
    userId: trustedUserId,
    accountId,
    startDate,
    endDate,
    page: 1,
    limit: pageLimit,
  });
  const total = Number(first?.pagination?.total);
  const rows = Array.isArray(first?.transactions) ? first.transactions.slice() : [];
  const limit = Number(first?.pagination?.limit) || pageLimit;

  if (!Number.isFinite(total)) {
    return { transactions: rows, complete: false, total: rows.length, pageCount: 1, rowCount: rows.length, reason: 'missing_total' };
  }
  if (total > maxRows) {
    return { transactions: [], complete: false, total, pageCount: 1, rowCount: 0, reason: 'period_exceeds_prefetch_cap' };
  }
  if (total === 0) {
    return { transactions: [], complete: true, total: 0, pageCount: 1, rowCount: 0 };
  }

  let page = 1;
  while (rows.length < total && page < maxPages) {
    page += 1;
    const next = await fetch({
      userId: trustedUserId,
      accountId,
      startDate,
      endDate,
      page,
      limit,
    });
    const batch = Array.isArray(next?.transactions) ? next.transactions : [];
    if (batch.length === 0) break;
    rows.push(...batch);
  }

  const complete = rows.length >= total;
  return {
    transactions: complete ? rows.slice(0, total) : rows,
    complete,
    total,
    pageCount: page,
    rowCount: complete ? Math.min(rows.length, total) : rows.length,
    reason: complete ? null : 'incomplete_period_pages',
  };
}

function isHistoricalSpendQuery(message) {
  return /\b(spent|spend|spending|what did i spend|cost)\b/i.test(String(message || ''));
}

function isExcludedFromHistoricalSpend(t) {
  const dup = t && t.duplicate;
  if (dup === 1 || dup === '1' || dup === true) return true;
  const ft = String((t && t.forecast_type) || '').toUpperCase();
  if (ft === 'F' || ft === 'RF') return true;
  return false;
}

function aggregateTransactions(transactions, { subjectKind, subjectValue, postedExpensesOnly } = {}) {
  let expenseTotal = 0;
  let incomeTotal = 0;
  let transactionCount = 0;
  for (const t of transactions || []) {
    if (postedExpensesOnly && isExcludedFromHistoricalSpend(t)) continue;
    if (!txnMatchesSubject(t, subjectKind, subjectValue)) continue;
    const amount = num(t.amount);
    if (amount == null) continue;
    transactionCount += 1;
    if (amount < 0) expenseTotal += Math.abs(amount);
    else incomeTotal += amount;
  }
  return { transactionCount, expenseTotal, incomeTotal };
}

function periodKey(period) {
  if (!period || !period.start || !period.end) return null;
  return `${period.start}|${period.end}`;
}

function resolveLookupRequests(route, period, slots) {
  if (Array.isArray(route && route.lookupRequests) && route.lookupRequests.length) {
    return route.lookupRequests;
  }
  if (period && period.start && period.end) {
    return [{
      subjectKind: slots.subjectKind === 'account' ? null : slots.subjectKind,
      subjectValue: slots.subjectKind === 'account' ? null : slots.subjectValue,
      period,
      displaySubject: slots.displaySubject || slots.subjectValue || null,
    }];
  }
  return [];
}

function lookupResult({ request, status, transactionCount, expenseTotal, incomeTotal }) {
  const out = {
    subjectKind: request.subjectKind || null,
    subjectValue: request.subjectValue || null,
    period: request.period || null,
    status,
  };
  if (status === 'ok') {
    out.transactionCount = transactionCount || 0;
    out.expenseTotal = expenseTotal || 0;
    if (incomeTotal != null) out.incomeTotal = incomeTotal;
  }
  return out;
}

function shouldForceDirectAnswer({ route, policy, evidence } = {}) {
  if (!policy || !policy.groundingRequired) return false;
  if (route && route.wantsUiAction) return false;
  const cap = policy.effectiveCapability || (route && route.capability);
  if (cap !== 'financial_lookup') return false;
  if (!evidence || evidence.status !== 'ok') return false;
  if (Array.isArray(evidence.lookups) && evidence.lookups.length) {
    return evidence.lookups.every((lookup) => lookup && lookup.status === 'ok');
  }
  return Array.isArray(evidence.source) && evidence.source.length > 0;
}

async function prefetchGroupedLookups({
  trustedUserId,
  accountId,
  snapshot,
  currentDate,
  route,
  lookupRequests,
  queryFn,
  assertFn,
  fetchPage,
  pageLimit,
  message,
}) {
  const dataAsOf = snapshotDataAsOf(snapshot, currentDate);
  const postedExpensesOnly = isHistoricalSpendQuery(message)
    || lookupRequests.some((r) => r.subjectKind === 'merchant' || r.subjectKind === 'category');
  const limitations = postedExpensesOnly
    ? ['posted_actuals_only', 'duplicates_excluded']
    : ['includes_all_forecast_types_in_window'];
  if (route && route.compoundLookupCapped) limitations.push('compound_lookup_capped');

  const groups = new Map();
  for (const request of lookupRequests) {
    const key = periodKey(request.period);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { period: request.period, requests: [] });
    groups.get(key).requests.push(request);
  }

  const lookups = [];
  const prefetchMeta = {
    pageCount: 0,
    rowCount: 0,
    matchCount: 0,
    lookupCount: lookupRequests.length,
    periodReadCount: 0,
  };

  try {
    if (groups.size > 0) {
      await authorizedPrefetchRead({
        trustedUserId,
        accountId,
        queryFn,
        assertFn,
        readFn: async () => true,
      });
    }

    const fetchedByPeriod = new Map();
    for (const [key, group] of groups) {
      prefetchMeta.periodReadCount += 1;
      const fetched = await fetchCompletePeriodTransactions({
        trustedUserId,
        accountId,
        startDate: group.period.start,
        endDate: group.period.end,
        fetchPage,
        pageLimit: pageLimit || PAGE_LIMIT,
      });
      fetchedByPeriod.set(key, fetched);
      prefetchMeta.pageCount += fetched.pageCount || 1;
      prefetchMeta.rowCount += fetched.rowCount || 0;
    }

    for (const request of lookupRequests) {
      const key = periodKey(request.period);
      if (!key) {
        lookups.push(lookupResult({ request, status: 'unavailable' }));
        continue;
      }
      const fetched = fetchedByPeriod.get(key);
      if (!fetched) {
        lookups.push(lookupResult({ request, status: 'unavailable' }));
        continue;
      }
      if (!fetched.complete) {
        lookups.push(lookupResult({
          request,
          status: fetched.reason === 'period_exceeds_prefetch_cap' ? 'unavailable' : 'partial',
        }));
        continue;
      }
      const agg = aggregateTransactions(fetched.transactions, {
        subjectKind: request.subjectKind === 'account' ? null : request.subjectKind,
        subjectValue: request.subjectKind === 'account' ? null : request.subjectValue,
        postedExpensesOnly,
      });
      lookups.push(lookupResult({
        request,
        status: 'ok',
        transactionCount: agg.transactionCount,
        expenseTotal: agg.expenseTotal,
        incomeTotal: agg.incomeTotal,
      }));
      prefetchMeta.matchCount += agg.transactionCount;
    }
  } catch (err) {
    const code = err && err.code;
    const reason = code === 'ACCESS_DENIED' || code === 'ACCOUNT_REQUIRED' ? 'access_unverified' : 'read_failed';
    return emptyEvidence({
      status: 'unavailable',
      period: lookupRequests[0] && lookupRequests[0].period,
      dataAsOf,
      limitations: [reason],
      lookups: lookupRequests.map((request) => lookupResult({ request, status: 'unavailable' })),
    });
  }

  const okCount = lookups.filter((l) => l.status === 'ok').length;
  const failedCount = lookups.filter((l) => l.status !== 'ok').length;
  let status = 'ok';
  if (okCount === 0) status = 'unavailable';
  else if (failedCount > 0) status = 'partial';

  if (status !== 'ok') {
    const reasons = new Set();
    for (const request of lookupRequests) {
      if (!periodKey(request.period)) reasons.add('period_unspecified');
    }
    for (const lookup of lookups) {
      if (lookup.status === 'unavailable') reasons.add('period_exceeds_prefetch_cap');
      if (lookup.status === 'partial') reasons.add('incomplete_period_pages');
    }
    for (const reason of reasons) {
      if (!limitations.includes(reason)) limitations.push(reason);
    }
  }

  const firstOk = lookups.find((l) => l.status === 'ok') || null;
  const facts = firstOk
    ? {
        transactionCount: firstOk.transactionCount,
        expenseTotal: firstOk.expenseTotal,
        incomeTotal: firstOk.incomeTotal,
      }
    : {};

  return {
    status,
    source: ['user_transactions'],
    period: firstOk && firstOk.period
      ? firstOk.period
      : (lookupRequests[0] && lookupRequests[0].period) || null,
    dataAsOf,
    facts,
    lookups,
    limitations,
    prefetchMeta,
  };
}

async function authorizedPrefetchRead({
  trustedUserId,
  accountId,
  queryFn,
  assertFn = assertAccountAccess,
  readFn,
}) {
  if (trustedUserId == null || trustedUserId === '') {
    const err = new AccountAccessError('ACCESS_DENIED', 'Authenticated user is required.');
    throw err;
  }
  if (accountId == null || accountId === '') {
    const err = new AccountAccessError('ACCOUNT_REQUIRED', 'An account is required.');
    throw err;
  }
  await assertFn(trustedUserId, accountId, queryFn ? { queryFn } : {});
  return readFn();
}

function buildSnapshotEvidence(snapshot, { period, slots, kind, currentDate } = {}) {
  if (!hasUsableSnapshot(snapshot)) {
    return emptyEvidence({ limitations: ['snapshot_unavailable'] });
  }
  const facts = snapshotBalanceFacts(snapshot);
  const limitations = snapshotLimitations(snapshot);
  if (kind === 'affordability') {
    if (slots?.amount != null) facts.requestedAmount = slots.amount;
    if (period) facts.requestedPeriod = period.label;
    limitations.push('affordability_not_calculated');
  }
  if (kind === 'forecast' || kind === 'affordability') {
    const inPeriod = negativesInPeriod(snapshot, period);
    facts.negativesInRequestedPeriodCount = inPeriod.length;
    facts.hasNegativeInRequestedPeriod = inPeriod.length > 0;
  }
  if (kind === 'lookup' && slots?.subjectValue && slots.subjectKind !== 'account' && slots.subjectKind !== 'amount') {
    const matched = findNamedInList(snapshot.recents, slots.subjectValue)
      || findNamedInList(snapshot.upcoming, slots.subjectValue);
    if (matched) facts.matchedCompactItem = matched;
  }
  if (Array.isArray(snapshot.goals) && snapshot.goals.length && (kind === 'affordability' || kind === 'forecast')) {
    facts.goalCount = snapshot.goals.length;
  }
  return {
    status: kind === 'affordability' ? 'partial' : 'ok',
    source: ['kea_snapshot'],
    period: period || null,
    dataAsOf: snapshotDataAsOf(snapshot, currentDate),
    facts,
    limitations,
  };
}

/**
 * Authoritative evidence for the current turn.
 * Identity: trustedUserId from cashflowAuth only. Never body/model userId.
 * Account: currently selected authorized account only. Never lastAccountId.
 */
async function prefetchGrounding({
  trustedUserId,
  accountId,
  snapshot,
  currentDate,
  policy,
  route,
  queryFn,
  assertFn,
  fetchPage,
  pageLimit,
  message,
} = {}) {
  const effective = policy?.effectiveCapability || route?.capability;
  const slots = route?.slots || {};
  const period = slots.period || null;
  const msg = message || route?.message || '';

  if (!policy || policy.grounding === 'NONE' || !policy.groundingRequired) {
    return emptyEvidence({ status: 'ok', source: [], limitations: [] });
  }

  if (policy.prefetchKind === 'snapshot' || effective === 'financial_forecast' || effective === 'affordability_or_planning') {
    const kind = effective === 'affordability_or_planning'
      ? 'affordability'
      : (effective === 'financial_forecast' ? 'forecast' : 'lookup');
    return buildSnapshotEvidence(snapshot, { period, slots, kind, currentDate });
  }

  if (effective === 'financial_lookup' && slots.subjectKind === 'account') {
    return buildSnapshotEvidence(snapshot, { period, slots, kind: 'lookup', currentDate });
  }

  if (effective === 'financial_lookup' && !period && slots.subjectKind === 'account') {
    return buildSnapshotEvidence(snapshot, { period, slots, kind: 'lookup', currentDate });
  }

  // Historical / merchant / category lookup: authorized period-grouped reads.
  if (effective === 'financial_lookup') {
    const lookupRequests = resolveLookupRequests(route, period, slots);
    const hasPeriod = lookupRequests.some((r) => periodKey(r.period));
    if (!hasPeriod) {
      if (hasUsableSnapshot(snapshot) && slots.subjectValue) {
        const matched = findNamedInList(snapshot.recents, slots.subjectValue)
          || findNamedInList(snapshot.upcoming, slots.subjectValue);
        if (matched) {
          const evidence = buildSnapshotEvidence(snapshot, { period, slots, kind: 'lookup', currentDate });
          evidence.status = 'partial';
          evidence.limitations = [...(evidence.limitations || []), 'period_unspecified'];
          return evidence;
        }
      }
      return emptyEvidence({
        status: 'unavailable',
        limitations: ['period_unspecified'],
        dataAsOf: snapshotDataAsOf(snapshot, currentDate),
      });
    }

    return prefetchGroupedLookups({
      trustedUserId,
      accountId,
      snapshot,
      currentDate,
      route,
      lookupRequests,
      queryFn,
      assertFn,
      fetchPage,
      pageLimit,
      message: msg,
    });
  }

  if (policy.groundingRequired && effective === 'unknown') {
    return emptyEvidence({
      status: 'unavailable',
      dataAsOf: snapshotDataAsOf(snapshot, currentDate),
      limitations: ['capability_unresolved'],
    });
  }

  if (policy.groundingRequired) {
    return buildSnapshotEvidence(snapshot, { period, slots, kind: 'lookup', currentDate });
  }

  return emptyEvidence({ status: 'ok', source: [], limitations: [] });
}

function buildEvidenceSystemSection(evidence) {
  if (!evidence || !Array.isArray(evidence.source) || evidence.source.length === 0) {
    if (evidence && evidence.status === 'unavailable') {
      return [
        'GROUNDED EVIDENCE (authoritative for this answer — do not contradict; do not invent missing dollar values or dates; respect limitations; partial evidence does not justify unsupported certainty):',
        JSON.stringify({
          status: 'unavailable',
          source: [],
          period: evidence.period || null,
          dataAsOf: evidence.dataAsOf || null,
          facts: {},
          limitations: evidence.limitations || ['authoritative_data_unverified'],
        }),
        'Do not state dollar amounts, dates, or totals as fact.',
      ].join('\n');
    }
    return '';
  }
  const compact = {
    status: evidence.status,
    source: evidence.source,
    period: evidence.period || null,
    dataAsOf: evidence.dataAsOf || null,
    facts: evidence.facts || {},
    limitations: evidence.limitations || [],
  };
  if (Array.isArray(evidence.lookups) && evidence.lookups.length) {
    compact.lookups = evidence.lookups;
  }
  const lookupInstructions = compact.lookups
    ? [
      'Answer every requested lookup represented in lookups[].',
      'Use the corresponding subject and period for each result.',
      'Do not omit a lookup with status ok.',
      'Do not invent a result for missing/partial clauses.',
    ].join(' ')
    : '';
  const partialInstruction = compact.status === 'partial'
    ? (compact.lookups
      ? 'Partial evidence: answer completed lookup results and clearly state which requested result could not be fully verified. Do not invent a missing total.'
      : 'Partial evidence: qualify conclusions. Do not state a strong yes/no affordability result or any unsupported total.')
    : '';
  return [
    'GROUNDED EVIDENCE (authoritative for this answer — do not contradict; do not invent missing dollar values or dates; respect limitations; partial evidence does not justify unsupported certainty):',
    'Field glossary: availableBalance = Keacast UI Available; currentBalance = Keacast UI Current; reconciledBalance = latest reconciled snapshot (not Available); savingsPotential = lowest projected balance through the current month (not available money).',
    JSON.stringify(compact),
    lookupInstructions,
    partialInstruction,
  ].filter(Boolean).join('\n');
}

module.exports = {
  UPCOMING_WINDOW_DAYS,
  PAGE_LIMIT,
  MAX_ROWS,
  prefetchGrounding,
  authorizedPrefetchRead,
  fetchCompletePeriodTransactions,
  aggregateTransactions,
  buildSnapshotEvidence,
  buildEvidenceSystemSection,
  emptyEvidence,
  isHistoricalSpendQuery,
  isExcludedFromHistoricalSpend,
  shouldForceDirectAnswer,
};
