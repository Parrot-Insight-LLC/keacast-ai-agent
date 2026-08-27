'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');
const { cloneJson, LEDGER_STATUS } = require('../services/keaEvidenceLedger');
const {
  buildUpcomingEvidenceLedger,
  buildRecurringEvidenceLedger,
  buildIncomeHorizonEvidenceLedger,
  buildComparisonEvidenceLedger,
  buildTrendEvidenceLedger,
  buildCashflowEvidenceLedger,
  buildAffordabilityEvidenceLedger,
  buildLookupEvidenceLedger,
  buildSnapshotEvidenceLedger,
  buildEvidenceLedger,
} = require('../services/keaEvidenceLedgerBuilders');
const {
  RESPONSE_VALIDATION_CONTRACT_VERSION,
  LIST_COVERAGE,
  VALIDATION_STATUS,
  SEVERITY,
  VIOLATION_CODE,
  buildResponseValidationContract,
} = require('../services/keaResponseValidationContract');

function claimByPath(contract, claimPath) {
  return (contract.allowedClaims || []).find((c) => c.path === claimPath) || null;
}

function buildLookup() {
  return buildLookupEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['user_transactions'],
      facts: {
        transactionCount: 3,
        spentTotal: 279.58,
        expenseTotal: 279.58,
      },
      period: { start: '2026-07-01', end: '2026-07-31', label: 'July 2026' },
      limitations: [],
    },
    route: { slots: { subjectKind: 'merchant', subjectValue: 'Target' } },
    accountContext: { accountId: '10', accountLabel: 'Main Account' },
  }).ledger;
}

function buildSnapshot(extraFacts = {}) {
  return buildSnapshotEvidenceLedger({
    capability: 'financial_forecast',
    evidence: {
      status: 'ok',
      source: ['kea_snapshot'],
      facts: {
        availableBalance: 4846.97,
        currentBalance: 5010.5,
        reconciledBalance: 5100.11,
        monthIncome: 4626.36,
        monthExpenses: 3432.43,
        upcomingExpenseTotal: 1134.56,
        upcomingIncomeTotal: 4626.36,
        upcomingWindowDays: 15,
        recents: [
          { name: 'Costco', amount: -79.99, date: '2026-08-10' },
          { name: 'Target', amount: -19.99, date: '2026-08-07' },
        ],
        upcoming: [
          { name: 'MERIDIAN', amount: 4626.36, start: '2026-08-20' },
          { name: 'Northwestern', amount: -162.24, start: '2026-08-21' },
          { name: 'Daycare', amount: -705, start: '2026-08-22' },
          { name: 'Daycare', amount: -705, start: '2026-08-29' },
          { name: 'Mercury', amount: -267.32, start: '2026-08-24' },
        ],
        futureNegativeBalances: [{ amount: -220.85, date: '2026-11-08', daysUntil: 84 }],
        ...extraFacts,
      },
      limitations: ['upcoming_window_15d'],
    },
    accountContext: { accountId: '10', accountLabel: 'Main Account' },
  }).ledger;
}

function buildUpcomingMacro() {
  return buildUpcomingEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_upcoming'],
      facts: {
        metricScope: 'expense',
        accountScope: 'selected_account',
        period: { start: '2026-08-23', end: '2026-08-29', relation: 'next_week' },
        items: [{ label: 'Rent', date: '2026-08-24', amount: 1297.30 }],
        totals: { scheduledExpenseTotal: 1297.30 },
        itemCount: 1,
      },
      period: { start: '2026-08-23', end: '2026-08-29', relation: 'next_week', label: 'next_week' },
      observations: [],
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function buildEmptyUpcoming() {
  return buildUpcomingEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_upcoming'],
      facts: {
        metricScope: 'income',
        accountScope: 'selected_account',
        period: { start: '2026-08-23', end: '2026-08-29', relation: 'next_week' },
        items: [],
        totals: { scheduledIncomeTotal: 0 },
        itemCount: 0,
      },
      period: { start: '2026-08-23', end: '2026-08-29', relation: 'next_week' },
      observations: [{ code: 'no_upcoming_in_period' }],
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function buildPartialUpcoming() {
  return buildUpcomingEvidenceLedger({
    evidence: {
      status: 'partial',
      source: ['cashflow_upcoming'],
      facts: {
        metricScope: 'expense',
        accountScope: 'selected_account',
        period: { start: '2026-08-23', end: '2026-08-29', relation: 'next_week' },
        items: [{ label: 'Rent', date: '2026-08-24', amount: 100 }],
        totals: { scheduledExpenseTotal: 100 },
        itemCount: 1,
      },
      period: { start: '2026-08-23', end: '2026-08-29', relation: 'next_week' },
      observations: [],
      limitations: ['list_capped'],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function buildRecurring() {
  return buildRecurringEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_recurring'],
      facts: {
        metricScope: 'expense',
        recurringDefinition: 'kea_scheduled_series',
        expenses: [
          { label: 'Netflix', amount: 15.99, monthlyEquivalent: 15.99, nextDate: '2026-09-01', category: 'Entertainment' },
          { label: 'Rent', amount: 1400, monthlyEquivalent: 1400, nextDate: '2026-09-01', category: 'Housing' },
        ],
        income: [
          { label: 'Paycheck', amount: 2000, nextDate: '2026-08-21', category: 'Income' },
        ],
        totals: {
          recurringExpenseMonthlyEquivalent: 1415.99,
          recurringIncomeMonthlyEquivalent: 4333.33,
        },
      },
      observations: [
        { code: 'largest_recurring_expense', label: 'Rent', monthlyEquivalent: 1400 },
      ],
      limitations: [],
    },
    route: { slots: {} },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function buildHorizon() {
  return buildIncomeHorizonEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_income_horizon'],
      facts: {
        incomeHorizonDefinition: 'kea_scheduled_recurring_income',
        nextIncome: [{ label: 'Direct Deposit', date: '2026-08-31', amount: 4626.36 }],
        combinedScheduledIncomeAmount: 4626.36,
        window: { start: '2026-08-18', end: '2026-08-30', relation: 'before_next_scheduled_income' },
        expensesBeforeIncome: {
          count: 2,
          total: 200,
          items: [
            { label: 'Rent', date: '2026-08-20', amount: 100 },
            { label: 'Phone', date: '2026-08-25', amount: 100 },
          ],
        },
        forecast: {
          startingAvailable: 1400,
          lowestBalanceBeforeIncome: 250,
          lowestBalanceDate: '2026-08-30',
          firstNegativeDate: null,
          projectedShortfallBeforeIncome: 0,
          daysUntilNextIncome: 14,
        },
      },
      limitations: ['selected_account_scope'],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function buildComparison() {
  return buildComparisonEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_period_comparison'],
      facts: {
        accountScope: 'selected_account',
        windowKind: 'matched_elapsed',
        periodA: {
          label: 'July 1–16, 2026',
          start: '2026-07-01',
          end: '2026-07-16',
          income: 5000,
          spending: 4200,
          net: 800,
        },
        periodB: {
          label: 'August 1–16, 2026',
          start: '2026-08-01',
          end: '2026-08-16',
          income: 5600,
          spending: 3780,
          net: 1820,
        },
        changes: {
          income: { absolute: 600, percent: 12, direction: 'increased', baselineZero: false },
          spending: { absolute: -420, percent: -10, direction: 'decreased', baselineZero: false },
          net: { absolute: 1020, percent: 127.5, direction: 'improved', baselineZero: false },
        },
      },
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function buildTrend() {
  return buildTrendEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_trend'],
      facts: {
        accountScope: 'selected_account',
        windowKind: 'matched_elapsed',
        metricScope: 'spending',
        periods: [
          { label: 'June 1–16, 2026', start: '2026-06-01', end: '2026-06-16', spending: 100 },
          { label: 'July 1–16, 2026', start: '2026-07-01', end: '2026-07-16', spending: 120 },
          { label: 'August 1–16, 2026', start: '2026-08-01', end: '2026-08-16', spending: 140 },
        ],
        trend: {
          spending: { direction: 'increasing', firstToLast: { absolute: 40, percent: 40, baselineZero: false } },
        },
        highest: { metric: 'spending', label: 'August 1–16, 2026', value: 140 },
        lowest: { metric: 'spending', label: 'June 1–16, 2026', value: 100 },
      },
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function buildCashflow() {
  return buildCashflowEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_analysis'],
      facts: {
        postedIncome: 3000,
        postedSpending: 200,
        postedNet: 2800,
        remainingForecastSpending: 400,
        remainingForecastIncome: 2000,
        availableBalance: 1400,
        currentBalance: 1350,
        reconciledBalance: 1300,
        savingsPotential: 900,
        negativeBalanceRisk: {
          hasNegativeInScope: false,
          firstNegativeDate: null,
          lowestProjectedAmount: 410,
          lowestProjectedDate: '2026-09-13',
        },
      },
      period: { start: '2026-08-01', end: '2026-08-16', label: 'current_month_to_date' },
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function buildAffordability() {
  return buildAffordabilityEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['affordability_analysis'],
      facts: {
        requested: { amount: 800, purchaseDate: '2026-08-21' },
        baseline: { projectedOnDate: 3047, projectedOnDateAt: '2026-08-21' },
        hypothetical: {
          projectedOnDate: 2247,
          projectedOnDateAt: '2026-08-21',
          lowestAfterDate: 410,
          lowestAfterDateOn: '2026-09-13',
        },
        delta: { newNegativeIntroduced: false },
      },
      assumptions: [{ code: 'one_time_expense' }],
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

async function run() {
  section('3C.1 contract enums and controlled failures');
  check('contract version 1', RESPONSE_VALIDATION_CONTRACT_VERSION === 1);
  check('validation statuses', VALIDATION_STATUS.VALID === 'valid'
    && VALIDATION_STATUS.INVALID === 'invalid'
    && VALIDATION_STATUS.INDETERMINATE === 'indeterminate');
  check('severity enum', SEVERITY.CRITICAL === 'critical' && SEVERITY.HIGH === 'high');
  check('violation enum reserved', VIOLATION_CODE.UNSUPPORTED_AMOUNT === 'UNSUPPORTED_AMOUNT'
    && VIOLATION_CODE.PREVIEW_TOTAL_MISATTRIBUTION === 'PREVIEW_TOTAL_MISATTRIBUTION'
    && VIOLATION_CODE.UNSUPPORTED_DERIVATION === 'UNSUPPORTED_DERIVATION'
    && VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH === 'SNAPSHOT_SEMANTIC_MISMATCH'
    && VIOLATION_CODE.COMPARISON_RELATION_MISMATCH === 'COMPARISON_RELATION_MISMATCH');
  check('missing ledger controlled', buildResponseValidationContract(null).ok === false
    && buildResponseValidationContract(null).reason === 'missing_ledger'
    && buildResponseValidationContract(null).promptable === false);
  check('malformed ledger controlled', buildResponseValidationContract({ foo: 1 }).ok === false
    && buildResponseValidationContract({ foo: 1 }).promptable === false);
  const circular = { version: 1, status: 'complete' };
  circular.self = circular;
  const circ = buildResponseValidationContract(circular);
  check('circular ledger controlled', circ.ok === false && circ.reason === 'unclonable_ledger');

  const unavail = buildEvidenceLedger({
    capability: 'cashflow_upcoming',
    evidence: { status: 'unavailable', source: [], limitations: ['upcoming_unavailable'] },
  }).ledger;
  const unavailC = buildResponseValidationContract(unavail);
  check('unavailable non-promptable', unavailC.ok === true && unavailC.promptable === false
    && unavailC.contract.status === LEDGER_STATUS.UNAVAILABLE
    && unavailC.contract.allowedClaims.length === 0);

  section('3C.1 A lookup contract');
  const lookup = buildLookup();
  const lookupBefore = JSON.stringify(lookup);
  const lookupBuilt = buildResponseValidationContract(lookup);
  check('lookup contract ok', lookupBuilt.ok === true && lookupBuilt.promptable === true);
  const lookupC = lookupBuilt.contract;
  check('lookup source user_transactions', lookupC.sourceKind === 'user_transactions');
  check('lookup merchant Target', lookupC.scope.merchant === 'Target');
  check('lookup period July', lookupC.scope.period && lookupC.scope.period.label === 'July 2026');
  check('lookup spentTotal copied', claimByPath(lookupC, 'facts.spentTotal').value === 279.58);
  check('lookup count copied', claimByPath(lookupC, 'facts.transactionCount').value === 3);
  check('lookup claim ids reused', lookupC.allowedClaims[0].claimId === lookup.claims[0].id);
  check('lookup sign magnitude', lookupC.signConvention === 'magnitude');
  check('lookup ledger not mutated', JSON.stringify(lookup) === lookupBefore);
  check('lookup accountScope copied', lookupC.scope.accountScope === 'selected_account');

  section('3C.1 B snapshot contract + preview coverage');
  const snap = buildSnapshot();
  check('snapshot truncated false on ledger', snap.lists.upcoming.truncated === false);
  const snapC = buildResponseValidationContract(snap).contract;
  check('snapshot source kea_snapshot', snapC.sourceKind === 'kea_snapshot');
  check('snapshot signed_ledger', snapC.signConvention === 'signed_ledger');
  check('snapshot availableBalance', claimByPath(snapC, 'facts.availableBalance').value === 4846.97);
  check('snapshot upcomingExpenseTotal', claimByPath(snapC, 'facts.upcomingExpenseTotal').value === 1134.56);
  check('snapshot upcoming coverage preview despite truncated false',
    snapC.listCoverage.upcoming === LIST_COVERAGE.PREVIEW);
  check('snapshot recents coverage preview', snapC.listCoverage.recents === LIST_COVERAGE.PREVIEW);
  check('snapshot item ids preserved', snapC.allowedListItems.upcoming[2].itemId === 'item3'
    && snapC.allowedListItems.upcoming[3].itemId === 'item4');
  check('snapshot duplicate Daycare distinct', snapC.allowedListItems.upcoming[2].label === 'Daycare'
    && snapC.allowedListItems.upcoming[3].label === 'Daycare'
    && snapC.allowedListItems.upcoming[2].date !== snapC.allowedListItems.upcoming[3].date);
  check('snapshot prohibited codes copied', snapC.prohibitedNarrationCodes.indexOf('do_not_call_next_week') !== -1);
  check('snapshot limitations copied', snapC.limitations.indexOf('upcoming_window_15d') !== -1);
  check('snapshot no net 1193.93 claim', snapC.allowedClaims.every((c) => c.value !== 1193.93 && c.value !== 1194));

  section('3C.1 C upcoming macro contract');
  const up = buildUpcomingMacro();
  const upC = buildResponseValidationContract(up).contract;
  check('upcoming source cashflow_upcoming', upC.sourceKind === 'cashflow_upcoming');
  check('upcoming 1297.30 copied', claimByPath(upC, 'facts.totals.scheduledExpenseTotal').value === 1297.30);
  check('upcoming magnitude', upC.signConvention === 'magnitude');
  check('upcoming period copied', upC.scope.period && upC.scope.period.relation === 'next_week');
  check('upcoming metricScope expense', upC.scope.metricScope === 'expense');

  section('3C.1 D recurring contract');
  const rec = buildRecurring();
  const recC = buildResponseValidationContract(rec).contract;
  check('recurring source', recC.sourceKind === 'cashflow_recurring');
  check('recurring do_not_call_paycheck', recC.prohibitedNarrationCodes.indexOf('do_not_call_paycheck') !== -1);
  check('recurring do_not_imply_plaid_recurring', recC.prohibitedNarrationCodes.indexOf('do_not_imply_plaid_recurring') !== -1);
  check('recurring expenses not collapsed', recC.allowedListItems.expenses.length === 2);
  check('recurring monthlyEquivalent projected', recC.allowedListItems.expenses[0].monthlyEquivalent === 15.99
    && recC.allowedListItems.expenses[1].monthlyEquivalent === 1400);

  section('3C.1 E income horizon contract');
  const hz = buildHorizon();
  const hzC = buildResponseValidationContract(hz).contract;
  check('horizon source', hzC.sourceKind === 'cashflow_income_horizon');
  check('horizon next amount copied', claimByPath(hzC, 'facts.nextIncome[0].amount').value === 4626.36);
  check('horizon do_not_call_paycheck', hzC.prohibitedNarrationCodes.indexOf('do_not_call_paycheck') !== -1);
  check('horizon item ids on nextIncome', hzC.allowedListItems.nextIncome[0].itemId === 'item1');

  section('3C.1 F comparison contract');
  const cmp = buildComparison();
  const cmpC = buildResponseValidationContract(cmp).contract;
  check('comparison source', cmpC.sourceKind === 'cashflow_period_comparison');
  check('comparison absolute copied', claimByPath(cmpC, 'facts.changes.spending.absolute').value === -420);
  check('comparison percent copied not calculated', claimByPath(cmpC, 'facts.changes.income.percent').value === 12);
  check('comparison direction retained', cmpC.allowedClaims.some((c) => c.type === 'DIRECTION'
    && c.path === 'facts.changes.spending.direction' && c.value === 'decreased'));
  check('comparison windowKind', cmpC.scope.windowKind === 'matched_elapsed');
  check('comparison periodA spending period is periodA not scope.periodB',
    claimByPath(cmpC, 'facts.periodA.spending').period
    && claimByPath(cmpC, 'facts.periodA.spending').period.start === '2026-07-01'
    && claimByPath(cmpC, 'facts.periodA.spending').period.end === '2026-07-16'
    && claimByPath(cmpC, 'facts.periodA.spending').period.label === 'July 1–16, 2026');
  check('comparison periodB spending period is periodB',
    claimByPath(cmpC, 'facts.periodB.spending').period
    && claimByPath(cmpC, 'facts.periodB.spending').period.start === '2026-08-01'
    && claimByPath(cmpC, 'facts.periodB.spending').period.label === 'August 1–16, 2026');
  check('comparison change claims keep scope.period',
    claimByPath(cmpC, 'facts.changes.spending.absolute').period
    && claimByPath(cmpC, 'facts.changes.spending.absolute').period.start === '2026-08-01');

  section('3C.1 G trend contract');
  const trend = buildTrend();
  const trendC = buildResponseValidationContract(trend).contract;
  check('trend source', trendC.sourceKind === 'cashflow_trend');
  check('trend direction copied', trendC.allowedClaims.some((c) => c.type === 'DIRECTION'
    && c.value === 'increasing'));
  check('trend absolute copied', claimByPath(trendC, 'facts.trend.spending.firstToLast.absolute').value === 40);
  check('trend no new percent math', claimByPath(trendC, 'facts.trend.spending.firstToLast.percent').value === 40);
  check('trend period spending projected as amount', trendC.allowedListItems.periods.length === 3
    && trendC.allowedListItems.periods[0].amount === 100
    && trendC.allowedListItems.periods[1].amount === 120
    && trendC.allowedListItems.periods[2].amount === 140);

  section('3C.1 H cashflow analysis contract');
  const cf = buildCashflow();
  const cfC = buildResponseValidationContract(cf).contract;
  check('cashflow source', cfC.sourceKind === 'cashflow_analysis');
  check('cashflow postedNet copied', claimByPath(cfC, 'facts.postedNet').value === 2800);
  check('cashflow available copied', claimByPath(cfC, 'facts.availableBalance').value === 1400);

  section('3C.1 I affordability contract');
  const aff = buildAffordability();
  const affC = buildResponseValidationContract(aff).contract;
  check('affordability source', affC.sourceKind === 'affordability_analysis');
  check('affordability requested copied', claimByPath(affC, 'facts.requested.amount').value === 800);
  check('affordability hypothetical copied', claimByPath(affC, 'facts.hypothetical.projectedOnDate').value === 2247);
  check('affordability no synthesized boolean', affC.allowedClaims.every((c) => c.path.indexOf('affordable') === -1)
    && aff.facts.affordable === undefined);
  check('affordability scenario', affC.scope.scenario === 'affordability_hypothetical');
  check('affordability prohibited classify', affC.prohibitedNarrationCodes.indexOf('do_not_classify_affordability') !== -1);

  section('3C.1 J complete_empty contract');
  const empty = buildEmptyUpcoming();
  const emptyC = buildResponseValidationContract(empty).contract;
  check('complete_empty status preserved', emptyC.status === 'complete_empty');
  check('complete_empty source', emptyC.sourceKind === 'cashflow_upcoming');
  check('complete_empty metric income', emptyC.scope.metricScope === 'income');
  check('complete_empty allowed scheduled_empty', emptyC.allowedNarrationCodes.indexOf('scheduled_empty') !== -1);
  check('complete_empty prohibited generalize', emptyC.prohibitedNarrationCodes.indexOf('do_not_generalize_no_income') !== -1);
  check('complete_empty zero total copied', claimByPath(emptyC, 'facts.totals.scheduledIncomeTotal').value === 0);

  section('3C.1 K partial contract');
  const partial = buildPartialUpcoming();
  const partialC = buildResponseValidationContract(partial).contract;
  check('partial status preserved', partialC.status === 'partial');
  check('partial listCoverage preview from list_capped', partialC.listCoverage.items === LIST_COVERAGE.PREVIEW);

  section('3C.1 L duplicate list labels');
  const dupC = buildResponseValidationContract(buildSnapshot()).contract;
  const daycare = dupC.allowedListItems.upcoming.filter((row) => row.label === 'Daycare');
  check('duplicate labels remain two rows', daycare.length === 2);
  check('duplicate labels distinct ids', daycare[0].itemId !== daycare[1].itemId);

  section('3C.1 M snapshot preview + immutability');
  const mutable = cloneJson(buildSnapshot());
  const before = JSON.stringify(mutable);
  const built = buildResponseValidationContract(mutable);
  check('input ledger JSON unchanged', JSON.stringify(mutable) === before);
  mutable.facts.availableBalance = 1;
  check('mutating input after build does not change contract',
    claimByPath(built.contract, 'facts.availableBalance').value === 4846.97);
  let froze = false;
  try {
    built.contract.status = 'tampered';
  } catch (e) {
    froze = true;
  }
  check('contract frozen or unchanged', froze === true || built.contract.status === 'complete');

  section('3C.1 contract performance 1000 builds');
  const perfLedger = buildSnapshot();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) buildResponseValidationContract(perfLedger);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  1000 contract builds: ${ms.toFixed(2)}ms total, ${(ms / 1000).toFixed(3)}ms avg`);
  check('1000 contract builds completed', Number.isFinite(ms) && ms >= 0);

  section('3C.1 no production chat hook');
  const controller = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'openaiController.js'), 'utf8');
  check('openaiController does not import 3C.1 modules',
    controller.indexOf('keaResponseClaimExtractor') === -1
    && controller.indexOf('keaResponseClaimValidator') === -1
    && controller.indexOf('keaResponseValidationContract') === -1
    && controller.indexOf('validateResponseAgainstContract') === -1);
}

module.exports = { run, buildLookup, buildSnapshot, buildUpcomingMacro, buildEmptyUpcoming };
