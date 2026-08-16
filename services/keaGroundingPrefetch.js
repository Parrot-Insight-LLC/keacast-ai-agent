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
  if (Array.isArray(extra.observations)) out.observations = extra.observations;
  if (Array.isArray(extra.assumptions)) out.assumptions = extra.assumptions;
  if (extra.prefetchMeta) out.prefetchMeta = extra.prefetchMeta;
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

function nonnegativeSpendMagnitude(value) {
  const n = num(value);
  if (n == null || n <= 0) return 0;
  return n;
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
  const spentTotal = nonnegativeSpendMagnitude(expenseTotal);
  return { transactionCount, expenseTotal: spentTotal, spentTotal, incomeTotal };
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

function lookupResult({ request, status, transactionCount, expenseTotal, spentTotal, incomeTotal }) {
  const out = {
    subjectKind: request.subjectKind || null,
    subjectValue: request.subjectValue || null,
    period: request.period || null,
    status,
  };
  if (status === 'ok') {
    const magnitude = nonnegativeSpendMagnitude(spentTotal != null ? spentTotal : expenseTotal);
    out.transactionCount = transactionCount || 0;
    out.spentTotal = magnitude;
    out.expenseTotal = magnitude;
    if (incomeTotal != null) out.incomeTotal = incomeTotal;
  }
  return out;
}

function shouldForceDirectAnswer({ route, policy, evidence } = {}) {
  if (!policy || !policy.groundingRequired) return false;
  if (route && route.wantsUiAction) return false;
  const cap = policy.effectiveCapability || (route && route.capability);
  const directCaps = cap === 'financial_lookup'
    || cap === 'cashflow_analysis'
    || cap === 'affordability_or_planning';
  if (!directCaps) return false;
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
        spentTotal: agg.spentTotal,
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
        spentTotal: firstOk.spentTotal,
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

function horizonEnd(currentDate, days = 90) {
  const start = String(currentDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function macroFactsFromResult(result, source) {
  if (!result || typeof result !== 'object') return {};
  const facts = {};
  const copyKeys = source === 'cashflow_analysis'
    ? [
      'postedIncome', 'postedSpending', 'postedNet',
      'remainingForecastIncome', 'remainingForecastSpending', 'savingsPotential',
      'availableBalance', 'currentBalance', 'reconciledBalance',
      'largestCategories', 'largestMerchants', 'negativeBalanceRisk',
    ]
    : [
      'assumption', 'requested', 'horizonDays', 'availableBalance',
      'currentBalance', 'reconciledBalance', 'baseline', 'hypothetical', 'delta',
    ];
  for (const key of copyKeys) {
    if (result[key] !== undefined) facts[key] = result[key];
  }
  return facts;
}

function evidenceFromMacroResult(result, { source, period, currentDate, assumptions }) {
  if (!result || typeof result !== 'object') {
    return emptyEvidence({
      limitations: ['macro_error'],
      period,
      dataAsOf: currentDate || null,
    });
  }
  const limitations = Array.isArray(result.limitations) ? result.limitations.slice() : [];
  if (result.status === 'unavailable') {
    return emptyEvidence({
      status: 'unavailable',
      source: [],
      period: result.period || period || null,
      dataAsOf: result.dataAsOf || currentDate || null,
      limitations: limitations.length ? limitations : ['macro_error'],
      observations: Array.isArray(result.observations) ? result.observations : [],
      assumptions: assumptions || [],
    });
  }
  return {
    status: result.status === 'partial' ? 'partial' : 'ok',
    source: [source],
    period: result.period || period || null,
    dataAsOf: result.dataAsOf || currentDate || null,
    accountScope: 'selected_account',
    facts: macroFactsFromResult(result, source),
    observations: Array.isArray(result.observations) ? result.observations : [],
    assumptions: assumptions || [],
    limitations,
    clientDate: currentDate || null,
  };
}

async function defaultFetchCashflowAnalysis({ accountId, token, body, timeoutMs, requestId }) {
  const { getKeaCashflowAnalysis } = require('../tools/keacast_tool_layer');
  return getKeaCashflowAnalysis({ accountId, token, body, timeoutMs, requestId });
}

async function defaultFetchAffordabilityAnalysis({ accountId, token, body, timeoutMs, requestId }) {
  const { getKeaAffordabilityAnalysis } = require('../tools/keacast_tool_layer');
  return getKeaAffordabilityAnalysis({ accountId, token, body, timeoutMs, requestId });
}

async function prefetchCashflowMacro({
  accountId,
  token,
  requestId,
  currentDate,
  period,
  fetchCashflowAnalysis,
}) {
  if (accountId == null || accountId === '') {
    return emptyEvidence({ limitations: ['access_unverified'], period, dataAsOf: currentDate || null });
  }
  if (!token) {
    return emptyEvidence({ limitations: ['access_unverified'], period, dataAsOf: currentDate || null });
  }
  const fetch = fetchCashflowAnalysis || defaultFetchCashflowAnalysis;
  try {
    const result = await fetch({
      accountId,
      token,
      requestId,
      body: {
        clientDate: currentDate,
        period: period || undefined,
      },
    });
    return evidenceFromMacroResult(result, {
      source: 'cashflow_analysis',
      period,
      currentDate,
      assumptions: [],
    });
  } catch (err) {
    const status = err && err.response && err.response.status;
    const limitation = status === 401 || status === 403 ? 'access_unverified' : 'macro_error';
    return emptyEvidence({ limitations: [limitation], period, dataAsOf: currentDate || null });
  }
}

async function prefetchAffordabilityMacro({
  accountId,
  token,
  requestId,
  currentDate,
  slots,
  fetchAffordabilityAnalysis,
}) {
  const amount = slots && slots.amount;
  if (slots && slots.purchaseDateError) {
    return emptyEvidence({
      limitations: [slots.purchaseDateError],
      dataAsOf: currentDate || null,
    });
  }
  if (!(Number(amount) > 0)) {
    return emptyEvidence({
      limitations: ['amount_invalid'],
      dataAsOf: currentDate || null,
    });
  }
  const purchaseDate = slots && slots.purchaseDate;
  if (!purchaseDate) {
    return emptyEvidence({
      limitations: ['date_unresolved'],
      dataAsOf: currentDate || null,
    });
  }
  if (currentDate && purchaseDate < currentDate) {
    return emptyEvidence({
      limitations: ['past_date'],
      dataAsOf: currentDate || null,
    });
  }
  const end = horizonEnd(currentDate, 90);
  if (end && purchaseDate > end) {
    return emptyEvidence({
      limitations: ['date_beyond_horizon'],
      dataAsOf: currentDate || null,
    });
  }
  if (accountId == null || accountId === '') {
    return emptyEvidence({ limitations: ['access_unverified'], dataAsOf: currentDate || null });
  }
  if (!token) {
    return emptyEvidence({ limitations: ['access_unverified'], dataAsOf: currentDate || null });
  }

  const assumptions = [];
  if (slots.purchaseDateAssumption === 'next_month_first_day') {
    assumptions.push({
      code: 'next_month_first_day',
      text: slots.purchaseDateAssumptionText
        || `Assuming the purchase is on ${purchaseDate}...`,
    });
  }
  assumptions.push({ code: 'one_time_expense' });

  const fetch = fetchAffordabilityAnalysis || defaultFetchAffordabilityAnalysis;
  try {
    const result = await fetch({
      accountId,
      token,
      requestId,
      body: {
        clientDate: currentDate,
        amount,
        purchaseDate,
        title: slots.title || undefined,
        category: slots.category || undefined,
      },
    });
    return evidenceFromMacroResult(result, {
      source: 'affordability_analysis',
      currentDate,
      assumptions,
    });
  } catch (err) {
    const status = err && err.response && err.response.status;
    const limitation = status === 401 || status === 403 ? 'access_unverified' : 'macro_error';
    return emptyEvidence({ limitations: [limitation], dataAsOf: currentDate || null, assumptions });
  }
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
  token,
  requestId,
  fetchCashflowAnalysis,
  fetchAffordabilityAnalysis,
} = {}) {
  const effective = policy?.effectiveCapability || route?.capability;
  const slots = route?.slots || {};
  const period = slots.period || null;
  const msg = message || route?.message || '';

  if (!policy || policy.grounding === 'NONE' || !policy.groundingRequired) {
    return emptyEvidence({ status: 'ok', source: [], limitations: [] });
  }

  if (effective === 'mixed_macro') {
    return emptyEvidence({
      status: 'unavailable',
      limitations: ['mixed_macro_unsupported'],
      dataAsOf: snapshotDataAsOf(snapshot, currentDate),
    });
  }

  if (policy.prefetchKind === 'cashflow_macro' || effective === 'cashflow_analysis') {
    return prefetchCashflowMacro({
      accountId,
      token,
      requestId,
      currentDate,
      period,
      fetchCashflowAnalysis,
    });
  }

  if (policy.prefetchKind === 'affordability_macro' || effective === 'affordability_or_planning') {
    return prefetchAffordabilityMacro({
      accountId,
      token,
      requestId,
      currentDate,
      slots,
      fetchAffordabilityAnalysis,
    });
  }

  if (policy.prefetchKind === 'snapshot' || effective === 'financial_forecast') {
    const kind = effective === 'financial_forecast' ? 'forecast' : 'lookup';
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

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function completedHistoricalClientDate(evidence) {
  const fromEvidence = String(evidence && evidence.clientDate || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromEvidence)) return fromEvidence;
  const fromDataAsOf = String(evidence && evidence.dataAsOf || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(fromDataAsOf) ? fromDataAsOf : '';
}

function isCompletedHistoricalPeriod(period, clientDate) {
  const end = String(period && period.end || '').slice(0, 10);
  const today = String(clientDate || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(end) && /^\d{4}-\d{2}-\d{2}$/.test(today) && end < today;
}

function azureFacingEvidence(evidence) {
  const compact = {
    status: evidence.status,
    source: evidence.source,
    period: evidence.period || null,
    dataAsOf: evidence.dataAsOf || null,
    facts: cloneJson(evidence.facts || {}),
    limitations: evidence.limitations || [],
  };
  if (Array.isArray(evidence.lookups) && evidence.lookups.length) {
    compact.lookups = evidence.lookups;
  }
  if (Array.isArray(evidence.observations) && evidence.observations.length) {
    compact.observations = cloneJson(evidence.observations);
  }
  if (Array.isArray(evidence.assumptions) && evidence.assumptions.length) {
    compact.assumptions = evidence.assumptions;
  }
  const isMacro = Array.isArray(compact.source)
    && (compact.source.includes('cashflow_analysis') || compact.source.includes('affordability_analysis'));
  if (isMacro) {
    compact.accountScope = evidence.accountScope || 'selected_account';
  }
  const isCashflow = Array.isArray(compact.source) && compact.source.includes('cashflow_analysis');
  if (isCashflow) {
    if (compact.facts && compact.facts.negativeBalanceRisk && typeof compact.facts.negativeBalanceRisk === 'object') {
      const risk = { ...compact.facts.negativeBalanceRisk };
      delete risk.horizonDays;
      compact.facts.negativeBalanceRisk = risk;
    }
    if (compact.facts) delete compact.facts.horizonDays;
    if (Array.isArray(compact.observations)) {
      compact.observations = compact.observations.map((row) => {
        if (!row || typeof row !== 'object') return row;
        if (row.code !== 'no_negative_in_scope') return row;
        const copy = { ...row };
        delete copy.horizonDays;
        return copy;
      });
    }
    if (isCompletedHistoricalPeriod(compact.period, completedHistoricalClientDate(evidence)) && compact.facts) {
      delete compact.facts.availableBalance;
      delete compact.facts.currentBalance;
      delete compact.facts.reconciledBalance;
      delete compact.facts.remainingForecastIncome;
      delete compact.facts.remainingForecastSpending;
      delete compact.facts.savingsPotential;
      delete compact.facts.negativeBalanceRisk;
    }
  }
  return compact;
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
  const compact = azureFacingEvidence(evidence);
  const completedHistorical = compact.source.includes('cashflow_analysis')
    && isCompletedHistoricalPeriod(compact.period, completedHistoricalClientDate(evidence));
  const lookupInstructions = compact.lookups
    ? [
      'Answer every requested lookup represented in lookups[].',
      'Use the corresponding subject and period for each result.',
      'Do not omit a lookup with status ok.',
      'Do not invent a result for missing/partial clauses.',
    ].join(' ')
    : '';
  const hasSpendFacts = compact.facts
    && (compact.facts.spentTotal != null || compact.facts.expenseTotal != null
      || compact.facts.postedSpending != null);
  const spendingGlossary = (compact.lookups || hasSpendFacts)
    ? 'Spending glossary: spentTotal / expenseTotal / postedSpending represents a positive posted-spending magnitude. Prefer spentTotal for user-facing spending statements. When saying "you spent", "your expenses totaled", or "you had X in expenses", present the value as positive currency. Do not add a minus sign. Individual ledger transaction amounts may remain signed elsewhere.'
    : '';
  const isMacro = compact.source.includes('cashflow_analysis')
    || compact.source.includes('affordability_analysis');
  const macroInstruction = isMacro
    ? [
      'GROUNDED EVIDENCE is authoritative for this requested analysis.',
      'accountScope=selected_account: all financial values refer only to the currently selected account unless the evidence explicitly states otherwise. Do not say across your accounts, all accounts, or complete financial picture.',
      'These are deterministic Keacast calculations. Do not recalculate them. Do not contradict them. Explain their practical meaning.',
      'Narrate observation codes and supplied facts only. Do not invent a new financial judgment.',
      'remainingForecastSpending / remainingForecastIncome = remaining unmatched F/RF in the current calendar month — not the next 14 days, and not the next 15 days.',
      'Negative-risk claims may use only negativeBalanceRisk.scope (start, end, label). Do not broaden the date range beyond that scope.',
      'hasNegativeInScope=false answers only risk.scope.',
      'lowestProjectedAmount and lowestProjectedDate are an inseparable pair from the same object. projectedOnDate and projectedOnDateAt are an inseparable pair. lowestAfterDate and lowestAfterDateOn are an inseparable pair. Never combine scope.start with an unrelated projected amount.',
      'reconciledBalance, currentBalance, and availableBalance are never projected balances, never lowestProjectedAmount, and never projectedOnDate.',
      'Missing, null, or unprovided financial fields must never be described as zero. postedIncome=0 does not establish forecastIncome=0. Do not say "no forecasted income or expenses are recorded" unless those forecast fields are actually present.',
    ].join(' ')
    : '';
  const cashflowNarrationInstruction = compact.source.includes('cashflow_analysis')
    ? (completedHistorical
      ? [
        'This is a completed historical period. Describe only posted income, posted spending, posted net, categories, and merchants for that period.',
        'Do not mention availableBalance, currentBalance, reconciledBalance, or current balances as of now.',
        'If postedSpending exceeds postedIncome, you may state that fact. Do not conclude the user is doing well or poorly, managing well, or has healthy/unhealthy/comfortable/safe cash flow.',
        'Do not prescribe cutting, optimizing, reducing, or keeping an eye on the largest categories. State the factual category/merchant ranking instead.',
      ]
      : [
        'You may describe posted income, posted spending, posted net, remaining forecast income/spending, savingsPotential, categories, merchants, and scoped negative risk.',
        'If postedSpending exceeds postedIncome, you may state that fact. Do not conclude the user is doing well or poorly, managing well, or has healthy/unhealthy/comfortable/safe cash flow.',
        'Do not invent disposable funds, safe-to-spend, overdraft safety, affordability, or "enough money to cover everything" from analyzeCashflow.',
        'analyzeCashflow is not assessAffordability. Do not conclude the user can afford a purchase from this evidence.',
        'Do not prescribe cutting, optimizing, reducing, or keeping an eye on the largest categories. State the factual category/merchant ranking instead.',
        'For a next-month negative-balance question, the primary answer is negativeBalanceRisk.hasNegativeInScope. If false, prefer: "No. Your current Keacast forecast does not show a negative balance during {scope month/year}." If mentioning the lowest balance, both amount and date must come from negativeBalanceRisk.lowestProjectedAmount and negativeBalanceRisk.lowestProjectedDate together.',
      ]).join(' ')
    : '';
  const affordabilityInstruction = compact.source.includes('affordability_analysis')
    ? [
      'Preferred conclusion: based on the current Keacast forecast, adding the requested expense would or would not create a negative projected balance within the evaluation horizon.',
      'You may refer to that window as the evaluation horizon, or as the current 90-day Keacast forecast when horizonDays is present on this affordability evidence.',
      'Allowed supporting facts: baseline purchase-date projection, hypothetical purchase-date projection, lowest after purchase, low date, existing negative, new negative introduced, negative starts earlier, negative worsened by.',
      'Do not conclude "you can afford it", "you cannot afford it", safe, unsafe, comfortable, healthy, good idea, bad idea, financially responsible, disposable balance, or comfortable cushion.',
      'If a next_month_first_day assumption is present, say it out loud (for example: "Assuming the purchase is on September 1...").',
      'If you offer to add the expense to the forecast, keep it a conversational invitation only, for example: "If you want, I can help add that expense to your forecast." Do not stage a draft or call createTransaction on this turn.',
    ].join(' ')
    : '';
  const partialInstruction = compact.status === 'partial'
    ? (compact.lookups
      ? 'Partial evidence: answer completed lookup results and clearly state which requested result could not be fully verified. Do not invent a missing total.'
      : 'Partial evidence: qualify conclusions. Do not state a strong yes/no affordability result or any unsupported total.')
    : '';
  return [
    'GROUNDED EVIDENCE (authoritative for this answer — do not contradict; do not invent missing dollar values or dates; respect limitations; partial evidence does not justify unsupported certainty):',
    completedHistorical
      ? 'Field glossary: postedIncome / postedSpending / postedNet are posted actuals for the requested historical period on the selected account. Do not mention availableBalance, currentBalance, reconciledBalance, or current balances as of now.'
      : 'Field glossary: availableBalance = Keacast UI Available; currentBalance = Keacast UI Current; reconciledBalance = latest reconciled snapshot (not Available, not a projected balance, not lowestProjectedAmount, not projectedOnDate); savingsPotential = lowest projected balance through the current month (not available money).',
    spendingGlossary,
    JSON.stringify(compact),
    lookupInstructions,
    macroInstruction,
    cashflowNarrationInstruction,
    affordabilityInstruction,
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
  azureFacingEvidence,
  isHistoricalSpendQuery,
  isExcludedFromHistoricalSpend,
  shouldForceDirectAnswer,
};
