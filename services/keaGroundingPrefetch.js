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
  return {
    status: extra.status || 'unavailable',
    source: extra.source || [],
    period: extra.period || null,
    dataAsOf: extra.dataAsOf || null,
    facts: extra.facts || {},
    limitations: extra.limitations || [],
  };
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
  return /\b(spent|spend|spending|what did i spend)\b/i.test(String(message || ''));
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

  // Historical / merchant / category lookup: authorized complete-period read.
  if (effective === 'financial_lookup') {
    if (!period || !period.start || !period.end) {
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

    try {
      const fetched = await authorizedPrefetchRead({
        trustedUserId,
        accountId,
        queryFn,
        assertFn,
        readFn: () => fetchCompletePeriodTransactions({
          trustedUserId,
          accountId,
          startDate: period.start,
          endDate: period.end,
          fetchPage,
          pageLimit: pageLimit || PAGE_LIMIT,
        }),
      });

      if (!fetched.complete) {
        const incomplete = emptyEvidence({
          status: fetched.reason === 'period_exceeds_prefetch_cap' ? 'unavailable' : 'partial',
          source: ['user_transactions'],
          period,
          dataAsOf: snapshotDataAsOf(snapshot, currentDate),
          limitations: [fetched.reason || 'incomplete_period_pages'],
        });
        incomplete.prefetchMeta = {
          pageCount: fetched.pageCount || 1,
          rowCount: fetched.rowCount || 0,
          matchCount: 0,
        };
        return incomplete;
      }

      const postedExpensesOnly = isHistoricalSpendQuery(msg)
        || slots.subjectKind === 'merchant'
        || slots.subjectKind === 'category';
      const agg = aggregateTransactions(fetched.transactions, {
        subjectKind: slots.subjectKind === 'account' ? null : slots.subjectKind,
        subjectValue: slots.subjectKind === 'account' ? null : slots.subjectValue,
        postedExpensesOnly,
      });
      return {
        status: 'ok',
        source: ['user_transactions'],
        period,
        dataAsOf: snapshotDataAsOf(snapshot, currentDate),
        facts: {
          transactionCount: agg.transactionCount,
          expenseTotal: agg.expenseTotal,
          incomeTotal: agg.incomeTotal,
        },
        limitations: postedExpensesOnly
          ? ['posted_actuals_only', 'duplicates_excluded']
          : ['includes_all_forecast_types_in_window'],
        prefetchMeta: {
          pageCount: fetched.pageCount || 1,
          rowCount: fetched.rowCount || fetched.transactions.length,
          matchCount: agg.transactionCount,
        },
      };
    } catch (err) {
      const code = err && err.code;
      return emptyEvidence({
        status: 'unavailable',
        period,
        dataAsOf: snapshotDataAsOf(snapshot, currentDate),
        limitations: [code === 'ACCESS_DENIED' || code === 'ACCOUNT_REQUIRED' ? 'access_unverified' : 'read_failed'],
      });
    }
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
  return [
    'GROUNDED EVIDENCE (authoritative for this answer — do not contradict; do not invent missing dollar values or dates; respect limitations; partial evidence does not justify unsupported certainty):',
    'Field glossary: availableBalance = Keacast UI Available; currentBalance = Keacast UI Current; reconciledBalance = latest reconciled snapshot (not Available); savingsPotential = lowest projected balance through the current month (not available money).',
    JSON.stringify(compact),
    compact.status === 'partial'
      ? 'Partial evidence: qualify conclusions. Do not state a strong yes/no affordability result or any unsupported total.'
      : '',
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
};
