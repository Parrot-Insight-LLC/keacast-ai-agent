'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');
const {
  buildComparisonEvidenceLedger,
  buildSnapshotEvidenceLedger,
  buildTrendEvidenceLedger,
  buildRecurringEvidenceLedger,
  buildIncomeHorizonEvidenceLedger,
  buildLookupEvidenceLedger,
} = require('../services/keaEvidenceLedgerBuilders');
const {
  VALIDATION_STATUS,
  SEVERITY,
  VIOLATION_CODE,
  buildResponseValidationContract,
} = require('../services/keaResponseValidationContract');
const { validateResponseAgainstContract } = require('../services/keaResponseClaimValidator');
const {
  COMPARISON_METRIC_VALIDATION_ENV_KEY,
  COMPARISON_METRIC_REASON,
  isComparisonMetricValidationEnabled,
  evaluateComparisonMetricIdentity,
} = require('../services/keaComparisonMetricSemanticValidation');
const {
  SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY,
  SNAPSHOT_COVERAGE_VALIDATION_ENV_KEY,
  SNAPSHOT_SEMANTIC_REASON,
} = require('../services/keaSnapshotSemanticValidation');
const {
  COMPARISON_RELATION_VALIDATION_ENV_KEY,
  COMPARISON_RELATION_REASON,
} = require('../services/keaComparisonSemanticValidation');
const {
  TREND_COVERAGE_VALIDATION_ENV_KEY,
} = require('../services/keaTrendSemanticValidation');
const {
  LOOKUP_ATTRIBUTION_VALIDATION_ENV_KEY,
} = require('../services/keaLookupSemanticValidation');
const {
  SNAPSHOT_NEGATIVE_MINIMUM_VALIDATION_ENV_KEY,
} = require('../services/keaSnapshotNegativeBalanceSemanticValidation');
const {
  ENFORCEMENT_REASON,
  evaluateResponseEnforcement,
} = require('../services/keaResponseValidationEnforcement');
const {
  applyShadowResponseValidation,
  RESPONSE_VALIDATION_STATUS,
} = require('../services/keaResponseValidationShadow');
const {
  buildLookup,
  buildSnapshot,
  buildUpcomingMacro,
} = require('./keaResponseValidationContract.test');

const COMPARISON_METRIC_SCOPE_RESIDUAL = 'COMPLETE';
const COMPARISON_DELTA_METRIC_SCOPE_BACKLOG = 'OPEN';
const COMPARISON_MULTI_METRIC_COREFERENCE_BACKLOG = 'OPEN';
const COMPARISON_AMBIGUOUS_METRIC_LANGUAGE_BACKLOG = 'OPEN';
const COMPARISON_PERIOD_INTERPRETATION_BACKLOG = 'OPEN';
const COMPARISON_RELATIVE_PERIOD_BACKLOG = 'OPEN';
const TREND_GENERIC_TOTAL_COVERAGE_AMBIGUITY = 'OPEN';
const TREND_RELATIVE_COVERAGE_LANGUAGE_BACKLOG = 'OPEN';
const LOOKUP_RELATIVE_PERIOD_LANGUAGE_BACKLOG = 'OPEN';
const LOOKUP_MERCHANT_COREFERENCE_BACKLOG = 'OPEN';
const LOOKUP_PERIOD_COREFERENCE_BACKLOG = 'OPEN';
const LOOKUP_EXPLICIT_RANGE_LANGUAGE_BACKLOG = 'OPEN';
const LOOKUP_ACCOUNT_SCOPE_IDENTITY = 'OPEN';
const SNAPSHOT_SAME_DATE_MINIMUM_LANGUAGE_BACKLOG = 'OPEN';
const SNAPSHOT_NEGATIVE_EVENT_ORDER_BACKLOG = 'OPEN';
const INCOME_HORIZON_RICH_NARRATION_INDETERMINATE = 'OPEN';

function withFlag(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

function withSlice8(value, fn) {
  return withFlag(COMPARISON_METRIC_VALIDATION_ENV_KEY, value, fn);
}

function codes(result) {
  return (result.violations || []).map((v) => v.code);
}

function hasCode(result, code) {
  return codes(result).indexOf(code) !== -1;
}

function metricHit(result) {
  return (result.violations || []).some((v) => v.code === VIOLATION_CODE.COMPARISON_METRIC_MISMATCH
    && v.reasonCode === COMPARISON_METRIC_REASON.METRIC_IDENTITY_MISMATCH
    && v.severity === SEVERITY.HIGH);
}

function contractOf(ledger) {
  return buildResponseValidationContract(ledger).contract;
}

function validate(ledger, text) {
  return validateResponseAgainstContract({
    contract: contractOf(ledger),
    text,
  });
}

function comparisonFacts(facts) {
  return buildComparisonEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_period_comparison'],
      facts: Object.assign({
        accountScope: 'selected_account',
        windowKind: 'full_months',
      }, facts),
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function metricLedger() {
  return comparisonFacts({
    periodA: {
      label: 'June 2026', start: '2026-06-01', end: '2026-06-30',
      spending: 100, income: 200, net: 50,
    },
    periodB: {
      label: 'July 2026', start: '2026-07-01', end: '2026-07-31',
      spending: 80, income: 250, net: 170,
    },
    changes: {
      spending: { absolute: -20, percent: -20, direction: 'decreased', baselineZero: false },
      income: { absolute: 50, percent: 25, direction: 'increased', baselineZero: false },
      net: { absolute: 120, percent: 240, direction: 'improved', baselineZero: false },
    },
  });
}

function sameCentsLedger() {
  return comparisonFacts({
    periodA: {
      label: 'June 2026', start: '2026-06-01', end: '2026-06-30',
      spending: 100, income: 100, net: 100,
    },
    periodB: {
      label: 'July 2026', start: '2026-07-01', end: '2026-07-31',
      spending: 80, income: 80, net: 80,
    },
    changes: {
      spending: { absolute: -20, percent: -20, direction: 'decreased' },
    },
  });
}

function partialSameCentsLedger() {
  return comparisonFacts({
    periodA: {
      label: 'June 2026', start: '2026-06-01', end: '2026-06-30',
      spending: 100, income: 100, net: 50,
    },
    periodB: {
      label: 'July 2026', start: '2026-07-01', end: '2026-07-31',
      spending: 80, income: 80, net: 170,
    },
    changes: { spending: { absolute: -20, percent: -20, direction: 'decreased' } },
  });
}

function crossPeriodLedger() {
  return comparisonFacts({
    periodA: {
      label: 'June 2026', start: '2026-06-01', end: '2026-06-30',
      spending: 100, income: 40, net: -60,
    },
    periodB: {
      label: 'July 2026', start: '2026-07-01', end: '2026-07-31',
      spending: 70, income: 100, net: 30,
    },
    changes: { spending: { absolute: -30, percent: -30, direction: 'decreased' } },
  });
}

function canonicalLedger() {
  return comparisonFacts({
    periodA: {
      label: 'June 2026', start: '2026-06-01', end: '2026-06-30',
      income: 0, spending: 15010.46, net: -15010.46,
    },
    periodB: {
      label: 'July 2026', start: '2026-07-01', end: '2026-07-31',
      income: 0, spending: 12916.99, net: -12916.99,
    },
    changes: {
      income: { absolute: 0, percent: 0, baselineZero: false },
      spending: { absolute: -2093.47, percent: -13.95, direction: 'decreased', baselineZero: false },
      net: { absolute: 2093.47, percent: 13.95, direction: 'improved', baselineZero: false },
    },
  });
}

function snapshotFacts(facts, period) {
  return buildSnapshotEvidenceLedger({
    capability: 'financial_forecast',
    evidence: {
      status: 'ok',
      source: ['kea_snapshot'],
      facts: Object.assign({ upcomingWindowDays: 15 }, facts),
      period: period || { start: '2026-08-01', end: '2026-08-31', label: 'August 2026' },
      limitations: ['upcoming_window_15d'],
    },
    accountContext: { accountId: '10', accountLabel: 'Main Account' },
  }).ledger;
}

function lookupLedger() {
  return buildLookupEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['user_transactions'],
      facts: {
        transactionCount: 3,
        spentTotal: 279.58,
        expenseTotal: 279.58,
        incomeTotal: 0,
      },
      period: { start: '2026-07-01', end: '2026-07-31', label: 'July 2026' },
      lookups: [],
      limitations: [],
    },
    route: { slots: { subjectKind: 'merchant', subjectValue: 'Target' } },
    accountContext: { accountId: '10', accountLabel: 'Main Account' },
  }).ledger;
}

function matchedTrendLedger() {
  return buildTrendEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_trend'],
      facts: {
        accountScope: 'selected_account',
        windowKind: 'matched_elapsed',
        metricScope: 'spending',
        periods: [
          { label: 'June 1–27, 2026', start: '2026-06-01', end: '2026-06-27', spending: 13556.82 },
          { label: 'July 1–27, 2026', start: '2026-07-01', end: '2026-07-27', spending: 12542.34 },
          { label: 'August 1–27, 2026', start: '2026-08-01', end: '2026-08-27', spending: 11697.64 },
        ],
        trend: {
          spending: {
            direction: 'decreasing',
            firstToLast: { absolute: -1859.18, percent: -13.71, baselineZero: false },
          },
        },
      },
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function fullMonthsTrendLedger() {
  return buildTrendEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_trend'],
      facts: {
        accountScope: 'selected_account',
        windowKind: 'full_months',
        metricScope: 'spending',
        periods: [
          { label: 'June 2026', start: '2026-06-01', end: '2026-06-30', spending: 18000 },
          { label: 'July 2026', start: '2026-07-01', end: '2026-07-31', spending: 17000 },
        ],
        trend: {
          spending: {
            direction: 'decreasing',
            firstToLast: { absolute: -1000, percent: -5.56, baselineZero: false },
          },
        },
      },
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function enforcementOf(validation, capability) {
  return evaluateResponseEnforcement({
    flagEnabled: true,
    capability: capability || 'cashflow_comparison',
    responseSource: 'azure',
    writeResponseMode: 'none',
    shadow: {
      telemetry: {
        response_validation_performed: true,
        response_validation_status: validation.status,
        response_validation_contract_status: 'ok',
      },
      validation,
    },
  });
}

const LIVE_C = [
  'Your projected income for next month (September 2026) is $4626.36.',
  'Your projected expenses for next month are $3432.43.',
  'This results in a net positive cash flow of $1193.93.',
  'Your available balance is forecasted to be approximately $4846.97.',
  'Your balance is expected to increase by about $1194.',
].join(' ');

async function run() {
  section('3C.4 Slice 8 flag defaults');
  withSlice8(undefined, () => {
    check('unset defaults OFF', isComparisonMetricValidationEnabled() === false);
  });
  withSlice8('', () => {
    check('empty defaults OFF', isComparisonMetricValidationEnabled() === false);
  });
  withSlice8('false', () => {
    check('false OFF', isComparisonMetricValidationEnabled() === false);
  });
  withSlice8('true', () => {
    check('true ON', isComparisonMetricValidationEnabled() === true);
  });
  check('flag name', COMPARISON_METRIC_VALIDATION_ENV_KEY === 'USE_COMPARISON_METRIC_VALIDATION_SHADOW');
  check('violation enum', VIOLATION_CODE.COMPARISON_METRIC_MISMATCH === 'COMPARISON_METRIC_MISMATCH');
  check('reason enum', COMPARISON_METRIC_REASON.METRIC_IDENTITY_MISMATCH === 'metric_identity_mismatch');

  const metric = metricLedger();
  const paths = contractOf(metric).allowedClaims.map((c) => c.path);
  check('periodA spending path', paths.indexOf('facts.periodA.spending') !== -1);
  check('periodA income path', paths.indexOf('facts.periodA.income') !== -1);
  check('periodA net path', paths.indexOf('facts.periodA.net') !== -1);
  check('periodB spending path', paths.indexOf('facts.periodB.spending') !== -1);

  section('3C.4 Slice 8 flag OFF preserves pre-Slice-8 behavior');
  withFlag(COMPARISON_RELATION_VALIDATION_ENV_KEY, 'true', () => {
    withSlice8('false', () => {
      check('OFF June spending correct VALID', validate(metric, 'June spending was $100.').status === VALIDATION_STATUS.VALID);
      check('OFF June spending using income still VALID', validate(metric, 'June spending was $200.').status === VALIDATION_STATUS.VALID);
      check('OFF June net using income still VALID', validate(metric, 'June net was $200.').status === VALIDATION_STATUS.VALID);
      check('OFF July spending using income still VALID', validate(metric, 'July spending was $250.').status === VALIDATION_STATUS.VALID);
      check('OFF no Slice 8 code', !hasCode(
        validate(metric, 'June spending was $200.'),
        VIOLATION_CODE.COMPARISON_METRIC_MISMATCH
      ));
    });
  });
  withSlice8(undefined, () => {
    check('unset spending/income swap still VALID', validate(metric, 'June spending was $200.').status === VALIDATION_STATUS.VALID);
  });

  withFlag(COMPARISON_RELATION_VALIDATION_ENV_KEY, 'true', () => {
    withFlag(SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY, 'true', () => {
      withFlag(SNAPSHOT_COVERAGE_VALIDATION_ENV_KEY, 'true', () => {
        withFlag(TREND_COVERAGE_VALIDATION_ENV_KEY, 'true', () => {
          withFlag(LOOKUP_ATTRIBUTION_VALIDATION_ENV_KEY, 'true', () => {
            withFlag(SNAPSHOT_NEGATIVE_MINIMUM_VALIDATION_ENV_KEY, 'true', () => {
              withSlice8('true', () => {
                section('3C.4 Slice 8 metric positives');
                check('June spending correct', validate(metric, 'June spending was $100.').status === VALIDATION_STATUS.VALID);
                check('June income correct', validate(metric, 'June income was $200.').status === VALIDATION_STATUS.VALID);
                check('June net correct', validate(metric, 'June net was $50.').status === VALIDATION_STATUS.VALID);
                check('July spending correct', validate(metric, 'July spending was $80.').status === VALIDATION_STATUS.VALID);
                check('July income correct', validate(metric, 'July income was $250.').status === VALIDATION_STATUS.VALID);
                check('July net correct', validate(metric, 'July net was $170.').status === VALIDATION_STATUS.VALID);
                check('June expenses synonym VALID', validate(metric, 'June expenses were $100.').status === VALIDATION_STATUS.VALID);
                check('June net cash flow VALID', validate(metric, 'June net cash flow was $50.').status === VALIDATION_STATUS.VALID);

                section('3C.4 Slice 8 metric negatives');
                const spendAsIncome = validate(metric, 'June spending was $200.');
                check('June spending using June income amount INVALID', spendAsIncome.status === VALIDATION_STATUS.INVALID);
                check('June spending using income reason', metricHit(spendAsIncome));
                check('June income using June spending amount keeps unsupported', hasCode(
                  validate(metric, 'June income was $100.'),
                  VIOLATION_CODE.UNSUPPORTED_AMOUNT
                ));
                check('June net using June income amount INVALID', metricHit(
                  validate(metric, 'June net was $200.')
                ));
                check('July spending using July income amount INVALID', metricHit(
                  validate(metric, 'July spending was $250.')
                ));
                check('July income using July spending amount keeps unsupported', hasCode(
                  validate(metric, 'July income was $80.'),
                  VIOLATION_CODE.UNSUPPORTED_AMOUNT
                ));
                check('July net using July income amount INVALID', metricHit(
                  validate(metric, 'July net was $250.')
                ));
                check('June spending using net amount INVALID', metricHit(
                  validate(metric, 'June spending was $50.')
                ));
                check('June income using net amount INVALID', metricHit(
                  validate(metric, 'June income was $50.')
                ));

                section('3C.4 Slice 8 same-cents');
                const allSame = sameCentsLedger();
                check('all three metrics same cents spending VALID',
                  validate(allSame, 'June spending was $100.').status === VALIDATION_STATUS.VALID);
                check('all three metrics same cents income VALID',
                  validate(allSame, 'June income was $100.').status === VALIDATION_STATUS.VALID);
                check('all three metrics same cents net VALID',
                  validate(allSame, 'June net was $100.').status === VALIDATION_STATUS.VALID);
                const partial = partialSameCentsLedger();
                check('partial collision spending VALID',
                  validate(partial, 'June spending was $100.').status === VALIDATION_STATUS.VALID);
                check('partial collision income VALID',
                  validate(partial, 'June income was $100.').status === VALIDATION_STATUS.VALID);
                check('partial collision wrong net INVALID', metricHit(
                  validate(partial, 'June net was $100.')
                ));
                const cross = crossPeriodLedger();
                check('cross-period June spending VALID',
                  validate(cross, 'June spending was $100.').status === VALIDATION_STATUS.VALID);
                check('cross-period July income VALID',
                  validate(cross, 'July income was $100.').status === VALIDATION_STATUS.VALID);
                check('cross-period June income INVALID',
                  validate(cross, 'June income was $100.').status === VALIDATION_STATUS.INVALID);

                section('3C.4 Slice 8 period / value precedence');
                const wrongPeriod = validate(metric, 'July spending was $100.');
                check('correct metric wrong period INVALID', wrongPeriod.status === VALIDATION_STATUS.INVALID);
                check('wrong period existing violation preserved', hasCode(
                  wrongPeriod,
                  VIOLATION_CODE.UNSUPPORTED_PERIOD_ATTRIBUTION
                ));
                check('wrong period not converted to metric', !hasCode(
                  wrongPeriod,
                  VIOLATION_CODE.COMPARISON_METRIC_MISMATCH
                ));
                check('correct value wrong period INVALID', hasCode(
                  validate(metric, 'June income was $250.'),
                  VIOLATION_CODE.UNSUPPORTED_PERIOD_ATTRIBUTION
                ));
                const wrongAmt = validate(metric, 'June spending was $99999.');
                check('wrong arbitrary amount INVALID', hasCode(wrongAmt, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
                check('existing unsupported classification preserved', !hasCode(
                  wrongAmt,
                  VIOLATION_CODE.COMPARISON_METRIC_MISMATCH
                ));

                section('3C.4 Slice 8 locality / missing metric');
                check('separate sentences do not contaminate',
                  validate(metric, 'June spending was $100.\nIncome increased later.').status === VALIDATION_STATUS.VALID);
                check('earlier income does not contaminate spending',
                  validate(metric, 'Income was discussed separately. June spending was $100.').status === VALIDATION_STATUS.VALID);
                check('semicolon claims independent',
                  validate(metric, 'June spending was $100; June income was $200.').status === VALIDATION_STATUS.VALID);
                check('two metrics same sentence',
                  validate(metric, 'June spending was $100 while income was $200.').status === VALIDATION_STATUS.VALID);
                check('cross-period semicolon both VALID',
                  validate(metric, 'June spending was $100; July income was $250.').status === VALIDATION_STATUS.VALID);
                const mixedClaims = validate(metric, 'June spending was $100 and June income was $100.');
                check('multi-claim mixed INVALID', mixedClaims.status === VALIDATION_STATUS.INVALID && metricHit(mixedClaims));
                const swapped = validate(metric, 'June spending was $200 and income was $100.');
                check('swapped multi-claim INVALID', swapped.status === VALIDATION_STATUS.INVALID);
                check('missing metric not over-rejected',
                  validate(metric, 'June was $100.').status === VALIDATION_STATUS.VALID);
                check('generic total not over-interpreted',
                  validate(metric, 'June total was $100.').status === VALIDATION_STATUS.VALID);
                check('ambiguous net spending not Slice 8', !hasCode(
                  validate(metric, 'June net spending was $100.'),
                  VIOLATION_CODE.COMPARISON_METRIC_MISMATCH
                ));

                section('3C.4 Slice 8 delta / relation regressions');
                const canon = canonicalLedger();
                check('absolute exact', validate(canon, 'Spending decreased by $2093.47.').status === VALIDATION_STATUS.VALID);
                check('percent exact', validate(canon, 'Spending decreased by 13.95%.').status === VALIDATION_STATUS.VALID);
                check('direction exact', validate(canon, 'Spending decreased.').status === VALIDATION_STATUS.VALID);
                check('from-to scalars VALID',
                  validate(canon, 'Spending decreased from $15010.46 in June to $12916.99 in July.').status === VALIDATION_STATUS.VALID);
                check('correct A→B relation',
                  validate(canon, 'Spending decreased from June to July.').status === VALIDATION_STATUS.VALID);
                const reversed = validate(canon, 'Spending decreased from July to June.');
                check('reversed A/B existing INVALID', reversed.status === VALIDATION_STATUS.INVALID);
                check('reversed relation code', hasCode(reversed, VIOLATION_CODE.COMPARISON_RELATION_MISMATCH));
                check('reversed reason', (reversed.violations || []).some((v) => (
                  v.reasonCode === COMPARISON_RELATION_REASON.PERIOD_RELATION_REVERSED
                )));
                check('periodA regression', validate(canon, 'June spending was $15010.46.').status === VALIDATION_STATUS.VALID);
                check('periodB regression', validate(canon, 'July spending was $12916.99.').status === VALIDATION_STATUS.VALID);
                check('wrong month regression', validate(canon, 'July spending was $15010.46.').status === VALIDATION_STATUS.INVALID);

                section('3C.4 Slice 8 Slice 7 regressions');
                const avail = snapshotFacts({ availableBalance: 2207.75, currentBalance: 2500 });
                check('available', validate(avail, 'Your available balance is $2207.75.').status === VALIDATION_STATUS.VALID);
                const neg = snapshotFacts({
                  availableBalance: 2207.75,
                  futureNegativeBalances: [
                    { amount: -125.40, date: '2026-09-14', daysUntil: 14 },
                  ],
                });
                check('future negative event',
                  validate(neg, 'Your projected balance is -$125.40 on September 14, 2026.').status === VALIDATION_STATUS.VALID);
                check('minimum mismatch', hasCode(
                  validate(neg, 'Your lowest balance next month will be -$125.40.'),
                  VIOLATION_CODE.SNAPSHOT_NEGATIVE_MINIMUM_MISMATCH
                ));
                const forecast = buildSnapshot();
                const forecastRes = validate(forecast, LIVE_C);
                check('forecast still INVALID', forecastRes.status === VALIDATION_STATUS.INVALID);
                check('forecast not Slice 8', !hasCode(forecastRes, VIOLATION_CODE.COMPARISON_METRIC_MISMATCH));

                section('3C.4 Slice 8 Slice 6 regressions');
                const target = lookupLedger();
                check('Target correct', validate(target, 'You spent $279.58 at Target in July 2026.').status === VALIDATION_STATUS.VALID);
                check('wrong merchant', hasCode(
                  validate(target, 'You spent $279.58 at Walmart in July 2026.'),
                  VIOLATION_CODE.LOOKUP_ATTRIBUTION_MISMATCH
                ));
                check('wrong period', hasCode(
                  validate(target, 'You spent $279.58 at Target in June 2026.'),
                  VIOLATION_CODE.LOOKUP_ATTRIBUTION_MISMATCH
                ));

                section('3C.4 Slice 8 Slice 5 regressions');
                check('matched-elapsed valid',
                  validate(matchedTrendLedger(), 'June spending was $13556.82.').status === VALIDATION_STATUS.VALID);
                check('full-month mismatch', hasCode(
                  validate(matchedTrendLedger(), "June's full-month spending was $13556.82."),
                  VIOLATION_CODE.TREND_COVERAGE_MISMATCH
                ));
                check('true full-month trend',
                  validate(fullMonthsTrendLedger(), "June's full-month spending was $18000.").status === VALIDATION_STATUS.VALID);

                section('3C.4 Slice 8 Slice 3 / 2 regressions');
                const upcoming = snapshotFacts({
                  availableBalance: 2207.75,
                  upcomingExpenseTotal: 1134.56,
                  upcoming: [{ name: 'Mortgage', amount: -1134.56, start: '2026-08-28' }],
                });
                check('15-day→month', validate(upcoming, 'September expenses will total $1134.56.').status === VALIDATION_STATUS.INVALID);
                const cov = snapshotFacts({
                  availableBalance: 2207.75,
                  upcomingExpenseTotal: 5627.40,
                  upcoming: [
                    { name: 'Mortgage', amount: -2824.83, start: '2026-08-28' },
                    { name: 'Daycare', amount: -705, start: '2026-08-22' },
                  ],
                });
                check('full-window total', validate(cov, 'Upcoming expenses total $5627.40.').status === VALIDATION_STATUS.VALID);
                check('preview-total mismatch', validate(cov, 'These listed upcoming expenses total $5627.40.').status === VALIDATION_STATUS.INVALID);
                check('individual preview item',
                  validate(cov, 'The preview includes Mortgage for $2824.83.').status === VALIDATION_STATUS.VALID);
                const roles = snapshotFacts({
                  availableBalance: 100,
                  futureNegativeBalances: [{ amount: -80, date: '2026-11-08', daysUntil: 84 }],
                });
                check('negative event wrong month',
                  validate(roles, 'The lowest balance in September will be -$80.').status === VALIDATION_STATUS.INVALID);

                section('3C.4 Slice 8 other capability regressions');
                check('trend', validate(matchedTrendLedger(), 'June: $13556.82. July: $12542.34. August: $11697.64.').status === VALIDATION_STATUS.VALID);
                const recurring = buildRecurringEvidenceLedger({
                  evidence: {
                    status: 'ok',
                    source: ['cashflow_recurring'],
                    facts: {
                      metricScope: 'expense',
                      recurringDefinition: 'kea_scheduled_series',
                      expenses: [
                        { label: 'Netflix', amount: 15.99, monthlyEquivalent: 15.99, nextDate: '2026-09-01', category: 'Entertainment' },
                      ],
                      totals: { recurringExpenseMonthlyEquivalent: 15.99 },
                    },
                    limitations: [],
                  },
                  accountContext: { accountId: '10', accountLabel: 'Checking' },
                }).ledger;
                check('recurring', validate(recurring, 'Netflix is $15.99.').status === VALIDATION_STATUS.VALID);
                check('upcoming', validateResponseAgainstContract({
                  contract: contractOf(buildUpcomingMacro()),
                  text: 'Total scheduled expenses are $1297.30.',
                }).status === VALIDATION_STATUS.VALID);
                const horizon = buildIncomeHorizonEvidenceLedger({
                  evidence: {
                    status: 'ok',
                    source: ['cashflow_income_horizon'],
                    facts: {
                      incomeHorizonDefinition: 'kea_scheduled_recurring_income',
                      nextIncome: [{ label: 'Direct Deposit', date: '2026-08-31', amount: 4626.36 }],
                      combinedScheduledIncomeAmount: 4626.36,
                    },
                    limitations: [],
                  },
                  accountContext: { accountId: '10', accountLabel: 'Checking' },
                }).ledger;
                check('income horizon',
                  validate(horizon, 'Your next scheduled income is $4626.36 on 2026-08-31.').status === VALIDATION_STATUS.VALID);

                section('3C.4 Slice 8 enforcement isolation');
                check('Slice 8-only not blocked', enforcementOf(spendAsIncome).block === false);
                check('Slice 8-only not eligible family',
                  enforcementOf(spendAsIncome).reason === ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY);
                const forecastShadow = applyShadowResponseValidation({
                  text: LIVE_C,
                  ledger: forecast,
                  capability: 'financial_forecast',
                  responseSource: 'azure',
                });
                check('forecast still blocked', evaluateResponseEnforcement({
                  flagEnabled: true,
                  capability: 'financial_forecast',
                  responseSource: 'azure',
                  writeResponseMode: 'none',
                  shadow: forecastShadow,
                }).block === true);
                const mixedOld = validate(metric, 'June spending was $99999.');
                check('wrong amount still unsupported', hasCode(mixedOld, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
                check('period-scalar wrong amount not blocked', enforcementOf(mixedOld).block === false);
                const mixedBoth = validate(metric, 'June spending was $200. Spending decreased by 14%.');
                check('mixed Slice 8 + old comparison still blocks', enforcementOf(mixedBoth).block === true);
                check('one validation pass', forecastShadow.telemetry.response_validation_performed === true);
                const minShadow = applyShadowResponseValidation({
                  text: 'June spending was $200.',
                  ledger: metric,
                  capability: 'cashflow_comparison',
                  responseSource: 'azure',
                });
                check('metric shadow invalid',
                  minShadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
                check('metric primary sanitized',
                  minShadow.telemetry.response_validation_primary_violation === VIOLATION_CODE.COMPARISON_METRIC_MISMATCH);

                section('3C.4 Slice 8 performance');
                const tOk = process.hrtime.bigint();
                for (let i = 0; i < 1000; i += 1) validate(metric, 'June spending was $100.');
                const okMs = Number(process.hrtime.bigint() - tOk) / 1e6;
                console.log(`  1000 valid comparison metric claims: ${okMs.toFixed(2)}ms total, ${(okMs / 1000).toFixed(3)}ms avg`);
                const tBad = process.hrtime.bigint();
                for (let i = 0; i < 1000; i += 1) validate(metric, 'June spending was $200.');
                const badMs = Number(process.hrtime.bigint() - tBad) / 1e6;
                console.log(`  1000 metric mismatch claims: ${badMs.toFixed(2)}ms total, ${(badMs / 1000).toFixed(3)}ms avg`);
                const tSame = process.hrtime.bigint();
                for (let i = 0; i < 1000; i += 1) validate(allSame, 'June spending was $100.');
                const sameMs = Number(process.hrtime.bigint() - tSame) / 1e6;
                console.log(`  1000 same-cents claims: ${sameMs.toFixed(2)}ms total, ${(sameMs / 1000).toFixed(3)}ms avg`);
                const tEnf = process.hrtime.bigint();
                for (let i = 0; i < 1000; i += 1) enforcementOf(spendAsIncome);
                const enfMs = Number(process.hrtime.bigint() - tEnf) / 1e6;
                console.log(`  1000 Slice 8 shadow decisions: ${enfMs.toFixed(2)}ms total, ${(enfMs / 1000).toFixed(3)}ms avg`);
                check('Slice 8 performance measured',
                  Number.isFinite(okMs) && Number.isFinite(badMs)
                  && Number.isFinite(sameMs) && Number.isFinite(enfMs));
              });
            });
          });
        });
      });
    });
  });

  section('3C.4 Slice 8 rollback / privacy / math');
  const helperSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaComparisonMetricSemanticValidation.js'), 'utf8');
  const validatorSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseClaimValidator.js'), 'utf8');
  const enfSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseValidationEnforcement.js'), 'utf8');
  const extractorSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseClaimExtractor.js'), 'utf8');
  const builderSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaEvidenceLedgerBuilders.js'), 'utf8');
  check('no logger in helper', !/console\.(log|info|warn|error)|logger\./.test(helperSrc));
  check('no financial math', helperSrc.indexOf('Math.') === -1
    && helperSrc.indexOf('income -') === -1
    && helperSrc.indexOf('spending -') === -1
    && helperSrc.indexOf('.sort(') === -1);
  check('not in CORE_ENFORCEABLE_CODES',
    !/CORE_ENFORCEABLE_CODES[\s\S]{0,800}COMPARISON_METRIC_MISMATCH/.test(enfSrc));
  check('extractor unchanged', extractorSrc.indexOf('COMPARISON_METRIC') === -1);
  check('ledger builder unchanged in this slice', builderSrc.indexOf('COMPARISON_METRIC') === -1);
  check('validator does not derive net', validatorSrc.indexOf('income - spending') === -1);
  check('residual complete', COMPARISON_METRIC_SCOPE_RESIDUAL === 'COMPLETE');
  check('delta backlog open', COMPARISON_DELTA_METRIC_SCOPE_BACKLOG === 'OPEN');
  check('multi-metric backlog open', COMPARISON_MULTI_METRIC_COREFERENCE_BACKLOG === 'OPEN');
  check('ambiguous metric backlog open', COMPARISON_AMBIGUOUS_METRIC_LANGUAGE_BACKLOG === 'OPEN');
  check('prior residuals open', COMPARISON_PERIOD_INTERPRETATION_BACKLOG === 'OPEN'
    && COMPARISON_RELATIVE_PERIOD_BACKLOG === 'OPEN'
    && TREND_GENERIC_TOTAL_COVERAGE_AMBIGUITY === 'OPEN'
    && INCOME_HORIZON_RICH_NARRATION_INDETERMINATE === 'OPEN');

  withSlice8('false', () => {
    const hits = evaluateComparisonMetricIdentity({
      contract: contractOf(metric),
      row: { start: 5 },
      text: 'June spending was $200.',
      matches: [{ path: 'facts.periodA.income' }],
    });
    check('rollback helper no-ops when OFF', hits.mismatch === false);
    check('rollback swap remains VALID',
      validate(metric, 'June spending was $200.').status === VALIDATION_STATUS.VALID);
  });

  withSlice8('true', () => {
    const shadow = applyShadowResponseValidation({
      text: 'June spending was $200.',
      ledger: metric,
      capability: 'cashflow_comparison',
      responseSource: 'azure',
    });
    const raw = JSON.stringify(shadow.telemetry);
    const leaks = ['June 2026', '2026-06-01', '$200', 'Checking', 'facts.periodA'];
    const hit = leaks.filter((n) => raw.indexOf(n) !== -1);
    check('privacy no amount/date/account', hit.length === 0, hit.join(','));
  });
}

module.exports = {
  run,
  COMPARISON_METRIC_SCOPE_RESIDUAL,
};
