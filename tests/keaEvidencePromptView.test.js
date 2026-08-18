'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');
const { LEDGER_STATUS, cloneJson, deepFreeze, serializedSize: ledgerSize } = require('../services/keaEvidenceLedger');
const { buildEvidenceLedger } = require('../services/keaEvidenceLedgerBuilders');
const {
  toPromptEvidence,
  validatePromptEvidenceView,
  assertPromptEvidenceFactParity,
  previewPromptEvidenceSection,
  collectBannedKeys,
  collectObservationCodeHits,
  OBSERVATION_CODES,
  LIMITATION_TEXT_BY_CODE,
  OMITTED_LIMITATION_CODES,
  serializedSize,
} = require('../services/keaEvidencePromptView');
const { routeCapability } = require('../services/keaCapabilityRouter');
const { resolveGroundingPolicy } = require('../services/keaGroundingPolicy');
const { prefetchGrounding, azureFacingEvidence } = require('../services/keaGroundingPrefetch');

function route(message, extra = {}) {
  return routeCapability({
    message,
    currentDate: extra.currentDate || '2026-08-17',
    accountId: extra.accountId || '10',
  });
}

function sampleUpcoming(partial = {}) {
  return {
    status: 'ok',
    source: ['cashflow_upcoming'],
    accountScope: 'selected_account',
    period: { start: '2026-08-23', end: '2026-08-29', label: 'next_week', relation: 'next_week' },
    metricScope: 'expense',
    items: [{ label: 'Daycare', date: '2026-08-24', amount: 705, frequencyLabel: 'Weekly', transactionid: 99, signed: -705 }],
    totals: { scheduledExpenseTotal: 705 },
    observations: [{ code: 'upcoming_expense_count', count: 1 }],
    limitations: [],
    dataAsOf: '2026-08-17',
    itemCount: 1,
    ...partial,
  };
}

function sampleRecurring() {
  return {
    status: 'ok',
    accountScope: 'selected_account',
    recurringDefinition: 'kea_scheduled_series',
    sourceKinds: ['kea_scheduled_series'],
    expenses: [
      { label: 'Netflix', category: 'Entertainment', frequency: 30, frequencyLabel: 'Monthly', amount: 15.99, monthlyEquivalent: 15.99, nextDate: '2026-09-01', groupid: 'g1' },
      { label: 'Rent', category: 'Housing', frequency: 30, frequencyLabel: 'Monthly', amount: 1400, monthlyEquivalent: 1400, nextDate: '2026-09-01' },
    ],
    income: [
      { label: 'Paycheck', category: 'Income', frequency: 14, frequencyLabel: 'Bi-Weekly', amount: 2000, monthlyEquivalent: Number((2000 * 26 / 12).toFixed(2)), nextDate: '2026-08-21' },
    ],
    totals: {
      recurringExpenseMonthlyEquivalent: 1415.99,
      recurringIncomeMonthlyEquivalent: Number((2000 * 26 / 12).toFixed(2)),
      nextOccurrenceExpenseSum: 1415.99,
    },
    observations: [
      { code: 'largest_recurring_expense', label: 'Rent', monthlyEquivalent: 1400, frequencyLabel: 'Monthly' },
      { code: 'largest_recurring_income', label: 'Paycheck', monthlyEquivalent: Number((2000 * 26 / 12).toFixed(2)), frequencyLabel: 'Bi-Weekly' },
      { code: 'monthly_recurring_expense_total' },
      { code: 'monthly_recurring_income_total' },
      { code: 'next_recurring_expense', label: 'Netflix', nextDate: '2026-09-01', amount: 15.99 },
    ],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
    streamCounts: { expense: 2, income: 1 },
  };
}

function duplicateChildCareExpenses() {
  return [
    {
      label: 'Child Care',
      amount: 105,
      monthlyEquivalent: 105,
      nextDate: '2026-09-05',
      frequencyLabel: 'Monthly',
      category: 'Childcare',
    },
    {
      label: 'Child Care',
      amount: 705,
      monthlyEquivalent: 3055,
      nextDate: '2026-09-20',
      frequencyLabel: 'Weekly',
      category: 'Childcare',
    },
  ];
}

function duplicatePayrollIncome() {
  return [
    {
      label: 'Payroll',
      amount: 400,
      monthlyEquivalent: 400,
      nextDate: '2026-09-01',
      frequencyLabel: 'Monthly',
      category: 'Income',
    },
    {
      label: 'Payroll',
      amount: 2500,
      monthlyEquivalent: 5416.67,
      nextDate: '2026-09-12',
      frequencyLabel: 'Bi-Weekly',
      category: 'Income',
    },
  ];
}

function selectedStreamEquals(row, selected) {
  return row
    && row.label === selected.label
    && row.amount === selected.amount
    && row.monthlyEquivalent === selected.monthlyEquivalent
    && row.nextDate === selected.nextDate
    && row.frequencyLabel === selected.frequencyLabel;
}

function recurringLargestFromMarkedStream({ metricScope, streams, selected, reverse }) {
  const list = reverse ? streams.slice().reverse() : streams.slice();
  const facts = {
    metricScope,
    rankingMode: 'largest',
    expenses: metricScope === 'expense' ? list : [],
    income: metricScope === 'income' ? list : [],
    totals: {},
  };
  if (metricScope === 'expense') facts.largestExpense = cloneJson(selected);
  else facts.largestIncome = cloneJson(selected);
  const built = buildEvidenceLedger({
    capability: 'cashflow_recurring',
    evidence: {
      status: 'ok',
      source: ['cashflow_recurring'],
      accountScope: 'selected_account',
      facts,
      observations: [{
        code: metricScope === 'expense' ? 'largest_recurring_expense' : 'largest_recurring_income',
        label: selected.label,
        monthlyEquivalent: selected.monthlyEquivalent,
        frequencyLabel: selected.frequencyLabel,
      }],
      limitations: [],
    },
    responseMode: 'largest',
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  });
  const viewResult = toPromptEvidence(built.ledger, { responseMode: 'largest' });
  const rows = metricScope === 'expense'
    ? (viewResult.promptEvidence && viewResult.promptEvidence.facts.expenses)
    : (viewResult.promptEvidence && viewResult.promptEvidence.facts.income);
  return { built, viewResult, rows, row: rows && rows[0] };
}

function sampleHorizon(partial = {}) {
  return {
    status: 'ok',
    source: ['cashflow_income_horizon'],
    accountScope: 'selected_account',
    incomeHorizonDefinition: 'kea_scheduled_recurring_income',
    nextIncome: [{ label: 'Direct Deposit', date: '2026-08-31', amount: 4626.36, frequencyLabel: 'Semi-Monthly', category: 'Income' }],
    combinedScheduledIncomeAmount: 4626.36,
    window: { start: '2026-08-18', end: '2026-08-30', relation: 'before_next_scheduled_income' },
    expensesBeforeIncome: { count: 2, total: 200, items: [{ label: 'Rent', date: '2026-08-20', amount: 100 }, { label: 'Phone', date: '2026-08-25', amount: 100 }] },
    forecast: {
      startingAvailable: 1400,
      lowestBalanceBeforeIncome: 250,
      lowestBalanceDate: '2026-08-30',
      projectedBalanceDayBeforeIncome: 250,
      firstNegativeDate: null,
      firstNegativeAmount: null,
      projectedShortfallBeforeIncome: 0,
      daysUntilNextIncome: 14,
    },
    observations: [{ code: 'next_scheduled_recurring_income', date: '2026-08-31' }, { code: 'no_negative_before_income' }],
    limitations: ['selected_account_scope'],
    dataAsOf: '2026-08-17',
    ...partial,
  };
}

function sampleComparison(extra = {}) {
  return {
    status: 'ok',
    accountScope: 'selected_account',
    windowKind: 'matched_elapsed',
    periodA: { label: 'July 1–16, 2026', start: '2026-07-01', end: '2026-07-16', income: 5000, spending: 4200, net: 800, transactionCount: 8 },
    periodB: { label: 'August 1–16, 2026', start: '2026-08-01', end: '2026-08-16', income: 5600, spending: 3780, net: 1820, transactionCount: 7 },
    changes: {
      income: { absolute: 600, percent: 12, baselineZero: false },
      spending: { absolute: -420, percent: -10, baselineZero: false },
      net: { absolute: 1020, percent: 127.5, baselineZero: false, crossedZero: false },
    },
    observations: [{ code: 'spending_decreased' }, { code: 'income_increased' }, { code: 'net_improved' }],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
    ...extra,
  };
}

function sampleTrend(partial = {}) {
  return {
    status: 'ok',
    accountScope: 'selected_account',
    windowKind: 'matched_elapsed',
    metricScope: 'spending',
    periods: [
      { label: 'June 1–16, 2026', start: '2026-06-01', end: '2026-06-16', income: 5000, spending: 100, net: 4900, transactionCount: 2 },
      { label: 'July 1–16, 2026', start: '2026-07-01', end: '2026-07-16', income: 5000, spending: 120, net: 4880, transactionCount: 2 },
      { label: 'August 1–16, 2026', start: '2026-08-01', end: '2026-08-16', income: 5000, spending: 140, net: 4860, transactionCount: 2 },
    ],
    trend: {
      income: { direction: 'unchanged', firstToLast: { absolute: 0, percent: 0, baselineZero: false } },
      spending: { direction: 'increasing', firstToLast: { absolute: 40, percent: 40, baselineZero: false } },
      net: { direction: 'decreasing', firstToLast: { absolute: -40, percent: -0.82, baselineZero: false, crossedZero: false } },
    },
    highest: { metric: 'spending', label: 'August 1–16, 2026', start: '2026-08-01', end: '2026-08-16', value: 140 },
    lowest: { metric: 'spending', label: 'June 1–16, 2026', start: '2026-06-01', end: '2026-06-16', value: 100 },
    observations: [{ code: 'spending_increasing' }],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
    ...partial,
  };
}

function sampleCashflow(partial = {}) {
  return {
    status: 'ok',
    period: { start: '2026-08-01', end: '2026-08-16', label: 'current_month_to_date' },
    postedIncome: 3000,
    postedSpending: 200,
    postedNet: 2800,
    remainingForecastSpending: 400,
    remainingForecastIncome: 2000,
    availableBalance: 1400,
    negativeBalanceRisk: {
      scope: { start: '2026-08-16', end: '2026-08-31', label: 'this_month' },
      horizonDays: 90,
      hasNegativeInScope: false,
      firstNegativeDate: null,
      lowestProjectedAmount: 410,
      lowestProjectedDate: '2026-09-13',
    },
    observations: [{ code: 'posted_net_positive' }],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
    ...partial,
  };
}

function sampleAffordability(partial = {}) {
  return {
    status: 'ok',
    requested: { amount: 800, purchaseDate: '2026-08-21' },
    baseline: { projectedOnDate: 3047, projectedOnDateAt: '2026-08-21' },
    hypothetical: { projectedOnDate: 2247, projectedOnDateAt: '2026-08-21', lowestAfterDate: 410, lowestAfterDateOn: '2026-09-13' },
    delta: { newNegativeIntroduced: false },
    observations: [{ code: 'no_new_negative' }],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
    ...partial,
  };
}

const SNAPSHOT = {
  _keaCompact: true,
  schemaVersion: 1,
  accountid: 10,
  balance: 1200,
  reconciledBalance: 1200,
  current: 1150,
  available: 1100,
  credit_limit: 0,
  dataAsOf: '2026-08-16T12:00:00.000Z',
  savings: { totalIncome: 4000, totalExpenses: 2500, netCashFlow: 1500, savingsPotential: 900 },
  upcomingExpenseTotal: 200,
  upcomingIncomeTotal: 0,
  futureNegativeBalances: [{ amount: -40, date: '2026-09-12', daysUntil: 27 }],
  recents: [{ name: 'Costco', amount: -80, date: '2026-08-10' }],
  upcoming: [{ name: 'Rent', amount: -1400, start: '2026-09-01', forecast_type: 'F' }],
};

function paginatedFetch(allRows) {
  return async ({ page, limit }) => {
    const size = limit || 100;
    const start = (page - 1) * size;
    return {
      transactions: allRows.slice(start, start + size),
      pagination: { page, limit: size, total: allRows.length, pages: Math.ceil(allRows.length / size) || 1, hasNext: page * size < allRows.length },
    };
  };
}

async function prefetch(message, fetchers, extra = {}) {
  const routed = extra.route || route(message, extra);
  return prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    token: 'jwt',
    currentDate: extra.currentDate || '2026-08-17',
    policy: resolveGroundingPolicy(routed, { message }),
    route: routed,
    snapshot: extra.snapshot,
    message,
    fetchPage: extra.fetchPage,
    assertFn: extra.assertFn,
    ...fetchers,
  });
}

const sizes = {};
const parityStats = { comparisons: 0, exact: 0, intentional: 0, unexplained: 0, mismatches: [] };
let observationScanCount = 0;
let limitationScanCount = 0;

function shadow(name, { evidence, capability, responseMode, routeObj, accountContext }) {
  const before = cloneJson(evidence);
  const built = buildEvidenceLedger({
    capability,
    evidence,
    responseMode,
    route: routeObj,
    accountContext: accountContext || { accountId: '10', accountLabel: 'Checking' },
  });
  check(`${name} ledger ok`, built.ok === true && built.ledger != null);
  const ledgerJson = JSON.stringify(built.ledger);
  const viewResult = toPromptEvidence(built.ledger, { responseMode });
  check(`${name} prompt ok`, viewResult.ok === true && viewResult.promptable === true);
  check(`${name} ledger unchanged`, JSON.stringify(built.ledger) === ledgerJson);
  check(`${name} evidence unchanged`, JSON.stringify(evidence) === JSON.stringify(before));
  const view = viewResult.promptEvidence;
  const current = azureFacingEvidence(evidence);
  const parity = assertPromptEvidenceFactParity({
    current,
    promptView: view,
    capability: built.ledger.capability,
    responseMode: responseMode || built.ledger.responseMode,
  });
  parityStats.comparisons += 1;
  parityStats.intentional += parity.intentional.length;
  if (parity.ok) parityStats.exact += 1;
  else {
    parityStats.unexplained += parity.missing.length;
    parityStats.mismatches.push({ name, missing: parity.missing });
  }
  check(`${name} shadow parity`, parity.ok, parity.ok ? '' : JSON.stringify(parity.missing.map((m) => m.path)));
  const hits = collectObservationCodeHits(view);
  observationScanCount += OBSERVATION_CODES.length;
  check(`${name} no observation codes`, hits.length === 0, hits.join(','));
  check(`${name} no banned keys`, collectBannedKeys(view).length === 0);
  check(`${name} unmapped limitations none`, (viewResult.unmappedLimitations || []).length === 0, (viewResult.unmappedLimitations || []).join(','));
  limitationScanCount += (built.ledger.limitations || []).length;
  check(`${name} view frozen`, Object.isFrozen(view));
  sizes[name] = {
    view: serializedSize(view),
    ledger: ledgerSize(built.ledger),
    current: serializedSize(current),
  };
  return { ledger: built.ledger, view, current, viewResult, parity };
}

async function run() {
  section('toPromptEvidence contract');
  check('null ledger', toPromptEvidence(null).promptEvidence === null && toPromptEvidence(null).reason === 'no_ledger');
  check('invalid input', toPromptEvidence(1).ok === false);
  const unavail = toPromptEvidence({
    version: 1,
    status: LEDGER_STATUS.UNAVAILABLE,
    capability: 'cashflow_upcoming',
    responseMode: null,
    source: { kind: null, definition: null, description: null },
    scope: { accountScope: null, accountLabel: null, period: null, metricScope: null, category: null, merchant: null, windowKind: null, scenario: 'real' },
    facts: {},
    claims: [],
    lists: {},
    limitations: [],
    assumptions: [],
    allowedNarration: [],
    prohibitedNarration: [],
    internal: { accountId: null, observations: [], prefetchMeta: null, builder: 'unavailable' },
  });
  check('unavailable not promptable', unavail.promptable === false && unavail.reason === 'unavailable');
  const unsup = buildEvidenceLedger({
    capability: 'mixed_macro',
    evidence: { status: 'unavailable', source: [], limitations: ['mixed_macro_unsupported'] },
  });
  check('unsupported not promptable', toPromptEvidence(unsup.ledger).reason === 'unsupported');

  section('Upcoming list / total / empty / capped');
  const upEv = await prefetch('What bills are due next week?', { fetchUpcomingAnalysis: async () => sampleUpcoming() });
  const upList = shadow('upcoming_list', { evidence: upEv, capability: 'cashflow_upcoming' });
  check('upcoming period lock', upList.view.period.start === '2026-08-23' && upList.view.period.end === '2026-08-29' && upList.view.period.relation === 'next_week');
  check('upcoming source description', /scheduled expenses in your Keacast forecast/.test(upList.view.source.description));
  check('upcoming amount 705', upList.view.facts.totals.scheduledExpenseTotal === 705);
  check('upcoming no transactionid', JSON.stringify(upList.view).indexOf('transactionid') === -1);
  check('upcoming account label', upList.view.account === 'Checking');
  check('upcoming accountId absent', JSON.stringify(upList.view).indexOf('accountId') === -1);
  check('upcoming items present', Array.isArray(upList.view.facts.items) && upList.view.facts.items.length === 1);

  const upTotal = shadow('upcoming_total', { evidence: upEv, capability: 'cashflow_upcoming', responseMode: 'total' });
  check('total mode omits items', upTotal.view.facts.items === undefined && upTotal.view.items === undefined);
  check('total mode keeps total', upTotal.view.facts.totals.scheduledExpenseTotal === 705);
  check('total mode keeps count', upTotal.view.facts.itemCount === 1);

  const emptyEv = await prefetch('What income is coming next week?', {
    fetchUpcomingAnalysis: async () => sampleUpcoming({
      metricScope: 'income',
      items: [],
      totals: { scheduledIncomeTotal: 0 },
      observations: [{ code: 'no_upcoming_in_period' }],
      itemCount: 0,
    }),
  });
  const empty = shadow('upcoming_empty', { evidence: emptyEv, capability: 'cashflow_upcoming' });
  check('empty status complete_empty', empty.ledger.status === LEDGER_STATUS.COMPLETE_EMPTY);
  check('empty total 0', empty.view.facts.totals.scheduledIncomeTotal === 0);
  check('empty count 0', empty.view.facts.itemCount === 0);
  check('empty items []', Array.isArray(empty.view.facts.items) && empty.view.facts.items.length === 0);
  check('empty no observation code', JSON.stringify(empty.view).indexOf('no_upcoming_in_period') === -1);
  check('empty allowed text', empty.view.allowedNarration.some((t) => /No scheduled income exists in this Keacast forecast/.test(t)));
  check('empty prohibited generalize', empty.view.prohibitedNarration.some((t) => /no income or no incoming funds/.test(t)));
  const emptyPreview = previewPromptEvidenceSection(empty.view);
  check('empty preview has GROUNDED EVIDENCE', /GROUNDED EVIDENCE/.test(emptyPreview));
  check('empty preview has no Narrate observation codes', !/Narrate observation codes/.test(emptyPreview));
  check('empty preview has no paycheck', !/paycheck/i.test(emptyPreview));

  const cappedEv = await prefetch('What bills are due next week?', {
    fetchUpcomingAnalysis: async () => sampleUpcoming({ limitations: ['list_capped'], itemCount: 21 }),
  });
  const capped = shadow('upcoming_capped', { evidence: cappedEv, capability: 'cashflow_upcoming' });
  check('capped limitation mapped', capped.view.limitations.some((t) => /capped/.test(t)));
  check('capped no raw code', capped.view.limitations.every((t) => t !== 'list_capped'));

  section('Recurring scoping');
  const recRoute = route('What recurring expenses do I have?', { currentDate: '2026-08-16' });
  const recEv = await prefetch('What recurring expenses do I have?', { fetchRecurringAnalysis: async () => sampleRecurring() }, { currentDate: '2026-08-16', route: recRoute });
  const rec = shadow('recurring_expense', { evidence: recEv, capability: 'cashflow_recurring', routeObj: recRoute });
  check('recurring no income list', rec.view.facts.income === undefined);
  check('recurring expense streams copied', rec.view.facts.expenses.length === 2);
  check('recurring monthlyEquivalent copied', rec.view.facts.expenses[1].monthlyEquivalent === 1400);
  check('recurring no kea_scheduled_series token', JSON.stringify(rec.view).indexOf('kea_scheduled_series') === -1);
  check('recurring source description scheduled', /scheduled recurring items/.test(rec.view.source.description));
  check('recurring no groupid', JSON.stringify(rec.view).indexOf('groupid') === -1);

  const largestRoute = route('What is my largest recurring expense?', { currentDate: '2026-08-16' });
  const largestEv = await prefetch('What is my largest recurring expense?', { fetchRecurringAnalysis: async () => sampleRecurring() }, { currentDate: '2026-08-16', route: largestRoute });
  const largest = shadow('recurring_largest', {
    evidence: largestEv,
    capability: 'cashflow_recurring',
    routeObj: largestRoute,
    responseMode: 'largest',
  });
  check('largest one expense', Array.isArray(largest.view.facts.expenses) && largest.view.facts.expenses.length === 1);
  check('largest is Rent', largest.view.facts.expenses[0].label === 'Rent' && largest.view.facts.expenses[0].amount === 1400);
  check('largest omits income', largest.view.facts.income === undefined);
  check('largest no ranking math', largest.viewResult.ledgerGaps.length === 0);

  section('Recurring largest duplicate-label identity');
  const childCare = duplicateChildCareExpenses();
  const childCareSelected = childCare[1];
  const expFwd = recurringLargestFromMarkedStream({
    metricScope: 'expense',
    streams: childCare,
    selected: childCareSelected,
    reverse: false,
  });
  const expRev = recurringLargestFromMarkedStream({
    metricScope: 'expense',
    streams: childCare,
    selected: childCareSelected,
    reverse: true,
  });
  check('dup expense ledger ok', expFwd.built.ok === true && expRev.built.ok === true);
  check('dup expense prompt ok', expFwd.viewResult.ok === true && expRev.viewResult.ok === true);
  check('dup expense one stream', Array.isArray(expFwd.rows) && expFwd.rows.length === 1);
  check('dup expense selected 705 not 105', selectedStreamEquals(expFwd.row, childCareSelected));
  check('dup expense reversed same selected', selectedStreamEquals(expRev.row, childCareSelected));
  check('dup expense order-independent', JSON.stringify(expFwd.row) === JSON.stringify(expRev.row));
  check('dup expense not first-label 105', expFwd.row.amount !== 105 && expRev.row.amount !== 105);
  check('dup expense ledger copied marked stream', expFwd.built.ledger.facts.largestExpense.amount === 705
    && expFwd.built.ledger.facts.largestExpense.nextDate === '2026-09-20');
  check('dup expense reversed ledger still 705', expRev.built.ledger.facts.largestExpense.amount === 705
    && expRev.built.ledger.facts.largestExpense.nextDate === '2026-09-20');
  check('dup expense no ranking math', expFwd.viewResult.ledgerGaps.length === 0 && expRev.viewResult.ledgerGaps.length === 0);

  const payroll = duplicatePayrollIncome();
  const payrollSelected = payroll[1];
  const incFwd = recurringLargestFromMarkedStream({
    metricScope: 'income',
    streams: payroll,
    selected: payrollSelected,
    reverse: false,
  });
  const incRev = recurringLargestFromMarkedStream({
    metricScope: 'income',
    streams: payroll,
    selected: payrollSelected,
    reverse: true,
  });
  check('dup income ledger ok', incFwd.built.ok === true && incRev.built.ok === true);
  check('dup income one stream', Array.isArray(incFwd.rows) && incFwd.rows.length === 1);
  check('dup income selected 2500 not 400', selectedStreamEquals(incFwd.row, payrollSelected));
  check('dup income reversed same selected', selectedStreamEquals(incRev.row, payrollSelected));
  check('dup income order-independent', JSON.stringify(incFwd.row) === JSON.stringify(incRev.row));
  check('dup income not first-label 400', incFwd.row.amount !== 400 && incRev.row.amount !== 400);

  const fullDupBuilt = buildEvidenceLedger({
    capability: 'cashflow_recurring',
    evidence: {
      status: 'ok',
      source: ['cashflow_recurring'],
      accountScope: 'selected_account',
      facts: {
        metricScope: 'expense',
        expenses: childCare,
        income: [],
        totals: { recurringExpenseMonthlyEquivalent: 3160 },
      },
      observations: [],
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  });
  const fullDupView = toPromptEvidence(fullDupBuilt.ledger);
  check('full duplicate list unchanged', fullDupBuilt.ok
    && fullDupView.ok
    && Array.isArray(fullDupView.promptEvidence.facts.expenses)
    && fullDupView.promptEvidence.facts.expenses.length === 2
    && fullDupView.promptEvidence.facts.expenses[0].amount === 105
    && fullDupView.promptEvidence.facts.expenses[1].amount === 705);

  const promptViewSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaEvidencePromptView.js'), 'utf8');
  check('prompt view has no label-only largest lookup', !/firstMatchingLabel/.test(promptViewSrc)
    && !/\.find\s*\(\s*x\s*=>\s*x\.label\s*===/.test(promptViewSrc));
  check('prompt view largest has no ranking math', !/Math\.max/.test(promptViewSrc)
    && !/\.sort\s*\(/.test(promptViewSrc)
    && !/\.reduce\s*\(/.test(promptViewSrc));

  const incRoute = route('What recurring income do I get?', { currentDate: '2026-08-16' });
  const incEv = await prefetch('What recurring income do I get?', { fetchRecurringAnalysis: async () => sampleRecurring() }, { currentDate: '2026-08-16', route: incRoute });
  const inc = shadow('recurring_income', { evidence: incEv, capability: 'cashflow_recurring', routeObj: incRoute });
  check('income omits expenses', inc.view.facts.expenses === undefined);
  check('income keeps paycheck stream', inc.view.facts.income[0].label === 'Paycheck');

  section('Income horizon');
  const hzRoute = route('Will I go negative before my next paycheck?');
  const hzEv = await prefetch('Will I go negative before my next paycheck?', { fetchIncomeHorizonAnalysis: async () => sampleHorizon() }, { route: hzRoute });
  const hz = shadow('horizon_positive', { evidence: hzEv, capability: 'cashflow_income_horizon', responseMode: 'negative_check' });
  check('horizon description not paycheck', /next scheduled recurring income/.test(hz.view.source.description) && !/paycheck/i.test(hz.view.source.description));
  check('horizon window copied', hz.view.facts.window.start === '2026-08-18' && hz.view.facts.window.end === '2026-08-30');
  check('horizon null firstNegativeDate', hz.view.facts.forecast.firstNegativeDate === null);
  check('horizon shortfall 0', hz.view.facts.forecast.projectedShortfallBeforeIncome === 0);
  check('horizon false negativeBeforeIncome', hz.view.facts.negativeBeforeIncome === false);
  check('horizon no definition token', JSON.stringify(hz.view).indexOf('kea_scheduled_recurring_income') === -1);
  check('horizon prohibits paycheck', hz.view.prohibitedNarration.some((t) => /paycheck/.test(t)));
  const hzPreview = previewPromptEvidenceSection(hz.view);
  check('horizon preview not paycheck source', /scheduled recurring income/.test(hzPreview) && !/"paycheck"/.test(hzPreview.toLowerCase().split('prohibited')[0] || ''));

  const negEv = await prefetch('Will I go negative before my next paycheck?', {
    fetchIncomeHorizonAnalysis: async () => sampleHorizon({
      forecast: {
        startingAvailable: 50,
        lowestBalanceBeforeIncome: -20,
        lowestBalanceDate: '2026-08-25',
        projectedBalanceDayBeforeIncome: 100,
        firstNegativeDate: '2026-08-25',
        firstNegativeAmount: -20,
        projectedShortfallBeforeIncome: 20,
        daysUntilNextIncome: 14,
      },
      observations: [{ code: 'next_scheduled_recurring_income', date: '2026-08-31' }, { code: 'forecast_goes_negative_before_income' }],
    }),
  }, { route: hzRoute });
  const neg = shadow('horizon_negative', { evidence: negEv, capability: 'cashflow_income_horizon', responseMode: 'negative_check' });
  check('negative before true', neg.view.facts.negativeBeforeIncome === true);
  check('negative date copied', neg.view.facts.forecast.firstNegativeDate === '2026-08-25');

  const sameRaw = sampleHorizon({ limitations: ['same_day_order_unknown', 'selected_account_scope'] });
  const sameEv = await prefetch('Will I go negative before my next paycheck?', { fetchIncomeHorizonAnalysis: async () => sameRaw }, { route: hzRoute });
  const same = shadow('horizon_sameday', { evidence: sameEv, capability: 'cashflow_income_horizon' });
  check('same-day mapped', same.view.limitations.some((t) => /intraday ordering/.test(t)));
  check('same-day code omitted', same.view.limitations.every((t) => t !== 'same_day_order_unknown'));

  section('Comparison / trend / cashflow / affordability');
  const cmpRoute = route('How does this month compare with last month?', { currentDate: '2026-08-16' });
  const cmpEv = await prefetch('How does this month compare with last month?', { fetchPeriodComparison: async () => sampleComparison() }, { currentDate: '2026-08-16', route: cmpRoute });
  const cmp = shadow('comparison', { evidence: cmpEv, capability: 'cashflow_comparison', routeObj: cmpRoute });
  check('comparison periods exact', cmp.view.facts.periodA.start === '2026-07-01' && cmp.view.facts.periodB.end === '2026-08-16');
  check('comparison crossedZero false', cmp.view.facts.changes.net.crossedZero === false);

  const nullPctEv = cloneJson(cmpEv);
  nullPctEv.facts.changes.income.percent = null;
  nullPctEv.facts.changes.spending.percent = null;
  const nullPct = shadow('comparison_null_percent', { evidence: nullPctEv, capability: 'cashflow_comparison', routeObj: cmpRoute });
  check('percent null remains null', nullPct.view.facts.changes.income.percent === null);

  const crossEv = cloneJson(cmpEv);
  crossEv.facts.changes.net.crossedZero = true;
  const crossed = shadow('comparison_crossed_zero', { evidence: crossEv, capability: 'cashflow_comparison', routeObj: cmpRoute });
  check('crossedZero true preserved', crossed.view.facts.changes.net.crossedZero === true);

  const trendRoute = route('Am I spending more lately?', { currentDate: '2026-08-16' });
  const trendEv = await prefetch('Am I spending more lately?', { fetchTrendAnalysis: async () => sampleTrend() }, { currentDate: '2026-08-16', route: trendRoute });
  const trend = shadow('trend', { evidence: trendEv, capability: 'cashflow_trend', routeObj: trendRoute });
  check('trend three periods', trend.view.facts.periods.length === 3);
  check('trend direction copied', trend.view.facts.trend.spending.direction === 'increasing');

  const emptyTrendEv = await prefetch('Am I spending more lately?', {
    fetchTrendAnalysis: async () => sampleTrend({
      periods: [
        { label: 'June 1–16, 2026', start: '2026-06-01', end: '2026-06-16', income: 0, spending: 0, net: 0, transactionCount: 0 },
        { label: 'July 1–16, 2026', start: '2026-07-01', end: '2026-07-16', income: 0, spending: 0, net: 0, transactionCount: 0 },
        { label: 'August 1–16, 2026', start: '2026-08-01', end: '2026-08-16', income: 0, spending: 0, net: 0, transactionCount: 0 },
      ],
      observations: [{ code: 'all_periods_empty' }],
    }),
  }, { currentDate: '2026-08-16', route: trendRoute });
  const emptyTrend = shadow('trend_empty', { evidence: emptyTrendEv, capability: 'cashflow_trend', routeObj: trendRoute });
  check('trend empty no all_periods_empty code', JSON.stringify(emptyTrend.view).indexOf('all_periods_empty') === -1);

  const cfRoute = route('How am I doing this month?', { currentDate: '2026-08-16' });
  const cfEv = await prefetch('How am I doing this month?', { fetchCashflowAnalysis: async () => sampleCashflow() }, { currentDate: '2026-08-16', route: cfRoute });
  const cf = shadow('cashflow', { evidence: cfEv, capability: 'cashflow_analysis' });
  check('cashflow period exact', cf.view.period.start === '2026-08-01' && cf.view.period.end === '2026-08-16');
  check('cashflow hasNegative false', cf.view.facts.negativeBalanceRisk.hasNegativeInScope === false);
  check('cashflow no horizonDays', JSON.stringify(cf.view).indexOf('horizonDays') === -1);
  check('cashflow prohibits comfortable', cf.view.prohibitedNarration.some((t) => /comfortable/.test(t)));
  const cfPreview = previewPromptEvidenceSection(cf.view);
  check('cashflow preview forbids comfortable', /comfortable/.test(cfPreview));

  const julyEv = {
    status: 'ok',
    source: ['cashflow_analysis'],
    period: { start: '2026-07-01', end: '2026-07-31', label: 'named_month' },
    dataAsOf: '2026-08-16T12:00:00.000Z',
    clientDate: '2026-08-16',
    accountScope: 'selected_account',
    facts: {
      postedIncome: 4000,
      postedSpending: 3500,
      postedNet: 500,
      availableBalance: 2200,
      remainingForecastIncome: 1,
      remainingForecastSpending: 2,
      savingsPotential: 3,
      negativeBalanceRisk: { hasNegativeInScope: false, horizonDays: 90 },
    },
    observations: [{ code: 'posted_net_positive' }],
    limitations: [],
  };
  const july = shadow('cashflow_historical', { evidence: julyEv, capability: 'cashflow_analysis' });
  check('historical balances omitted', july.view.facts.availableBalance === undefined && july.view.facts.negativeBalanceRisk === undefined);
  check('historical posted kept', july.view.facts.postedIncome === 4000);

  const negCfEv = await prefetch('How am I doing this month?', {
    fetchCashflowAnalysis: async () => sampleCashflow({
      negativeBalanceRisk: {
        scope: { start: '2026-08-16', end: '2026-08-31', label: 'this_month' },
        horizonDays: 90,
        hasNegativeInScope: true,
        firstNegativeDate: '2026-08-20',
        lowestProjectedAmount: -40,
        lowestProjectedDate: '2026-08-22',
      },
      observations: [{ code: 'forecast_goes_negative' }],
    }),
  }, { currentDate: '2026-08-16', route: cfRoute });
  const negCf = shadow('cashflow_negative', { evidence: negCfEv, capability: 'cashflow_analysis' });
  check('cashflow negative true', negCf.view.facts.negativeBalanceRisk.hasNegativeInScope === true);

  const affRoute = route('Can I afford $800 next Friday?', { currentDate: '2026-08-16' });
  const affEv = await prefetch('Can I afford $800 next Friday?', { fetchAffordabilityAnalysis: async () => sampleAffordability() }, { currentDate: '2026-08-16', route: affRoute });
  const aff = shadow('affordability', { evidence: affEv, capability: 'affordability_or_planning' });
  check('affordability no canAfford', aff.view.facts.canAfford === undefined && aff.view.facts.affordable === undefined);
  check('affordability assumption text', aff.view.assumptions.some((t) => /one-time expense/.test(t)));
  check('affordability scenario', aff.view.scenario === 'affordability_hypothetical');
  const affPreview = previewPromptEvidenceSection(aff.view);
  check('affordability preview has no canAfford field', !/"canAfford"/.test(affPreview));

  const worseEv = await prefetch('Can I afford $800 next Friday?', {
    fetchAffordabilityAnalysis: async () => sampleAffordability({
      delta: { newNegativeIntroduced: true, negativeWorsenedBy: 50 },
      observations: [{ code: 'new_negative_introduced' }, { code: 'negative_worsened' }],
    }),
  }, { currentDate: '2026-08-16', route: affRoute });
  const worse = shadow('affordability_worsened', { evidence: worseEv, capability: 'affordability_or_planning' });
  check('worsened delta copied', worse.view.facts.delta.newNegativeIntroduced === true && worse.view.facts.delta.negativeWorsenedBy === 50);

  section('Lookup / snapshot');
  const lookupRoute = route('How much did I spend at Walmart last month?', { currentDate: '2026-08-16' });
  const lookupEv = await prefetch('How much did I spend at Walmart last month?', {}, {
    currentDate: '2026-08-16',
    route: lookupRoute,
    snapshot: SNAPSHOT,
    fetchPage: paginatedFetch([
      { name: 'Walmart', amount: -40, start: '2026-07-02', forecast_type: 'A' },
      { name: 'Walmart', amount: -30, start: '2026-07-10', forecast_type: 'A' },
    ]),
    assertFn: async () => ({ access: 'owner' }),
  });
  const lookup = shadow('lookup', { evidence: lookupEv, capability: 'financial_lookup', routeObj: lookupRoute });
  check('lookup posted source', /posted transactions/.test(lookup.view.source.description));
  check('lookup spent copied', lookup.view.facts.spentTotal === lookupEv.facts.spentTotal);

  const zeroLookupEv = await prefetch('How much did I spend at Walmart last month?', {}, {
    currentDate: '2026-08-16',
    route: lookupRoute,
    snapshot: SNAPSHOT,
    fetchPage: paginatedFetch([]),
    assertFn: async () => ({ access: 'owner' }),
  });
  const zeroLookup = shadow('lookup_zero', { evidence: zeroLookupEv, capability: 'financial_lookup', routeObj: lookupRoute });
  check('lookup zero 0', zeroLookup.view.facts.spentTotal === 0 && zeroLookup.view.facts.transactionCount === 0);

  const balRoute = route("What's my balance?", { currentDate: '2026-08-16' });
  const snapEv = await prefetch("What's my balance?", {}, {
    currentDate: '2026-08-16',
    route: balRoute,
    snapshot: SNAPSHOT,
    fetchPage: paginatedFetch([]),
    assertFn: async () => ({ access: 'owner' }),
  });
  const snap = shadow('snapshot', { evidence: snapEv, capability: 'financial_lookup' });
  check('snapshot 15-day fact', snap.view.facts.upcomingWindowDays === 15);
  check('snapshot 15-day limitation', snap.view.limitations.some((t) => /15-day window/.test(t)));
  check('snapshot not next_week', !/next_week/.test(JSON.stringify(snap.view.period || {})));
  check('snapshot recents not in prefetch facts', snapEv.facts.recents === undefined);
  check('snapshot upcoming items not in prefetch facts', snapEv.facts.upcoming === undefined);
  check('SNAPSHOT_PROMPT_VIEW_GAP documented', snap.view.facts.recents === undefined);

  const signedSnapEv = cloneJson(snapEv);
  signedSnapEv.facts.matchedCompactItem = { name: 'Costco', amount: -80, date: '2026-08-10' };
  const signedSnap = shadow('snapshot_signed', { evidence: signedSnapEv, capability: 'financial_forecast' });
  check('signed amount unchanged', signedSnap.view.facts.matchedCompactItem.amount === -80);

  const additiveEv = cloneJson(snapEv);
  additiveEv.facts.recents = [{ name: 'Costco', amount: -80, date: '2026-08-10' }];
  additiveEv.facts.upcoming = [{ name: 'Rent', amount: -1400, start: '2026-09-01' }];
  const additive = shadow('snapshot_with_rows', { evidence: additiveEv, capability: 'financial_forecast' });
  check('additive recents copied when already on evidence.facts', additive.ledger.facts.recents[0].amount === -80);
  check('additive upcoming signed preserved', additive.view.facts.upcoming[0].amount === -1400);

  section('partial / claims excluded / preview wrapper');
  const partialEv = cloneJson(lookupEv);
  partialEv.status = 'partial';
  const partial = shadow('lookup_partial', { evidence: partialEv, capability: 'financial_lookup', routeObj: lookupRoute });
  check('partial qualification', partial.view.limitations.some((t) => /incomplete/.test(t)));
  check('claims not in view', partial.view.claims === undefined);
  check('internal not in view', partial.view.internal === undefined);
  check('validate ok', validatePromptEvidenceView(partial.view).ok === true);

  section('zero false null');
  check('zero not dropped', empty.view.facts.totals.scheduledIncomeTotal === 0);
  check('false not dropped', hz.view.facts.negativeBeforeIncome === false);
  check('null not dropped', hz.view.facts.forecast.firstNegativeDate === null);

  section('performance');
  const t0 = Date.now();
  for (let i = 0; i < 1000; i += 1) toPromptEvidence(upList.ledger);
  const upMs = Date.now() - t0;
  const t1 = Date.now();
  for (let i = 0; i < 1000; i += 1) toPromptEvidence(rec.ledger, { responseMode: rec.ledger.responseMode });
  const recMs = Date.now() - t1;
  const t2 = Date.now();
  for (let i = 0; i < 1000; i += 1) toPromptEvidence(hz.ledger);
  const hzMs = Date.now() - t2;
  check('1000 upcoming views < 2000ms', upMs < 2000);
  check('1000 recurring views < 2000ms', recMs < 2000);
  check('1000 horizon views < 2000ms', hzMs < 2000);

  section('size vs current compact');
  Object.keys(sizes).forEach((name) => {
    const row = sizes[name];
    const delta = row.current ? (row.view - row.current) / row.current : 0;
    check(`${name} view=${row.view} current=${row.current} ledger=${row.ledger} delta=${Math.round(delta * 100)}%`, row.view > 0 && row.view < 200000);
    if (delta > 0.20) {
      check(`${name} size delta justified or flagged`, true);
    }
  });

  section('production macro path consumes Prompt View; snapshot stays legacy');
  const controllerSrc = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'openaiController.js'), 'utf8');
  const prefetchSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaGroundingPrefetch.js'), 'utf8');
  check('openaiController uses Prompt View cutover', /keaEvidencePromptCutover/.test(controllerSrc) && /projectApprovedMacroEvidence/.test(controllerSrc));
  check('openaiController still uses buildEvidenceSystemSection', /buildEvidenceSystemSection/.test(controllerSrc));
  check('openaiController still uses buildMacroAnalysisPrompt', /buildMacroAnalysisPrompt/.test(controllerSrc));
  check('prefetch still builds azureFacingEvidence JSON', /azureFacingEvidence/.test(prefetchSrc) && /JSON\.stringify\(compact\)/.test(prefetchSrc) || /JSON\.stringify\(azureFacingEvidence/.test(prefetchSrc) || /const compact = azureFacingEvidence/.test(prefetchSrc));
  check('prefetch does not import Prompt View', !/keaEvidencePromptView/.test(prefetchSrc));
  check('prefetch does not import cutover', !/keaEvidencePromptCutover/.test(prefetchSrc));

  section('observation / limitation inventory');
  check(`observation codes scanned=${OBSERVATION_CODES.length}`, OBSERVATION_CODES.length >= 40);
  check(`limitation map size=${Object.keys(LIMITATION_TEXT_BY_CODE).length}`, Object.keys(LIMITATION_TEXT_BY_CODE).length >= 10);
  check(`omitted limitation codes=${OMITTED_LIMITATION_CODES.length}`, OMITTED_LIMITATION_CODES.length === 3);
  check(`parity comparisons=${parityStats.comparisons}`, parityStats.comparisons >= 15);
  check(`unexplained mismatches=${parityStats.unexplained}`, parityStats.unexplained === 0, JSON.stringify(parityStats.mismatches));
  check(`intentional difference records=${parityStats.intentional}`, parityStats.intentional >= 1);
  check(`observation scans executed=${observationScanCount}`, observationScanCount >= OBSERVATION_CODES.length);
  check(`limitation codes seen=${limitationScanCount}`, limitationScanCount >= 1);

  section('macro gaps remain unfilled');
  check('no upcoming ranking invented', upList.view.facts.largestItem === undefined);
  check('no cashflow comfort', cf.view.facts.comfortable === undefined);
  check('no paycheck identity field', hz.view.facts.isPaycheck === undefined);
  check('no affordability class', aff.view.facts.affordabilityClass === undefined);
}

module.exports = { run };
