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
  SNAPSHOT_NEGATIVE_MINIMUM_VALIDATION_ENV_KEY,
  SNAPSHOT_NEGATIVE_MINIMUM_REASON,
  isSnapshotNegativeMinimumValidationEnabled,
  evaluateSnapshotNegativeMinimumIdentity,
} = require('../services/keaSnapshotNegativeBalanceSemanticValidation');
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

const SNAPSHOT_NEGATIVE_MINIMUM_COVERAGE_RESIDUAL = 'COMPLETE';
const SNAPSHOT_SAME_DATE_MINIMUM_LANGUAGE_BACKLOG = 'OPEN';
const SNAPSHOT_NEGATIVE_EVENT_ORDER_BACKLOG = 'OPEN';
const LOOKUP_RELATIVE_PERIOD_LANGUAGE_BACKLOG = 'OPEN';
const LOOKUP_MERCHANT_COREFERENCE_BACKLOG = 'OPEN';
const LOOKUP_PERIOD_COREFERENCE_BACKLOG = 'OPEN';
const LOOKUP_EXPLICIT_RANGE_LANGUAGE_BACKLOG = 'OPEN';
const LOOKUP_ACCOUNT_SCOPE_IDENTITY = 'OPEN';
const TREND_GENERIC_TOTAL_COVERAGE_AMBIGUITY = 'OPEN';
const TREND_RELATIVE_COVERAGE_LANGUAGE_BACKLOG = 'OPEN';
const COMPARISON_METRIC_SCOPE_RESIDUAL = 'OPEN';
const COMPARISON_PERIOD_INTERPRETATION_BACKLOG = 'OPEN';
const COMPARISON_RELATIVE_PERIOD_BACKLOG = 'OPEN';
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

function withSlice7(value, fn) {
  return withFlag(SNAPSHOT_NEGATIVE_MINIMUM_VALIDATION_ENV_KEY, value, fn);
}

function codes(result) {
  return (result.violations || []).map((v) => v.code);
}

function hasCode(result, code) {
  return codes(result).indexOf(code) !== -1;
}

function minHit(result) {
  return (result.violations || []).some((v) => v.code === VIOLATION_CODE.SNAPSHOT_NEGATIVE_MINIMUM_MISMATCH
    && v.reasonCode === SNAPSHOT_NEGATIVE_MINIMUM_REASON.NEGATIVE_EVENT_AS_MINIMUM
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

function negLedger() {
  return snapshotFacts({
    availableBalance: 2207.75,
    currentBalance: 2500,
    futureNegativeBalances: [
      { amount: -125.40, date: '2026-09-14', daysUntil: 14 },
      { amount: -80.10, date: '2026-10-02', daysUntil: 32 },
    ],
  });
}

function sameCentsNegLedger() {
  return snapshotFacts({
    availableBalance: 2207.75,
    futureNegativeBalances: [
      { amount: -100, date: '2026-09-14', daysUntil: 14 },
      { amount: -100, date: '2026-10-02', daysUntil: 32 },
    ],
  });
}

function multiNegLedger() {
  return snapshotFacts({
    availableBalance: 2207.75,
    futureNegativeBalances: [
      { amount: -125.40, date: '2026-09-14', daysUntil: 14 },
      { amount: -200.00, date: '2026-09-21', daysUntil: 21 },
    ],
  });
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

function comparisonLedger() {
  return buildComparisonEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_period_comparison'],
      facts: {
        accountScope: 'selected_account',
        windowKind: 'full_months',
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
      },
      observations: [{ code: 'spending_decreased' }, { code: 'net_improved' }],
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
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
    capability: capability || 'financial_forecast',
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
  section('3C.4 Slice 7 flag defaults');
  withSlice7(undefined, () => {
    check('unset defaults OFF', isSnapshotNegativeMinimumValidationEnabled() === false);
  });
  withSlice7('', () => {
    check('empty defaults OFF', isSnapshotNegativeMinimumValidationEnabled() === false);
  });
  withSlice7('false', () => {
    check('false OFF', isSnapshotNegativeMinimumValidationEnabled() === false);
  });
  withSlice7('true', () => {
    check('true ON', isSnapshotNegativeMinimumValidationEnabled() === true);
  });
  check('flag name', SNAPSHOT_NEGATIVE_MINIMUM_VALIDATION_ENV_KEY === 'USE_SNAPSHOT_NEGATIVE_MINIMUM_VALIDATION_SHADOW');
  check('violation enum', VIOLATION_CODE.SNAPSHOT_NEGATIVE_MINIMUM_MISMATCH === 'SNAPSHOT_NEGATIVE_MINIMUM_MISMATCH');
  check('reason enum', SNAPSHOT_NEGATIVE_MINIMUM_REASON.NEGATIVE_EVENT_AS_MINIMUM === 'negative_event_as_minimum');

  const neg = negLedger();
  check('listCoverage preview', contractOf(neg).listCoverage.futureNegativeBalances === 'preview');
  check('events unsorted', contractOf(neg).allowedListItems.futureNegativeBalances[0].date === '2026-09-14'
    && contractOf(neg).allowedListItems.futureNegativeBalances[1].date === '2026-10-02');

  section('3C.4 Slice 7 flag OFF preserves pre-Slice-7 behavior');
  withFlag(SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY, 'true', () => {
    withSlice7('false', () => {
      check('OFF exact event VALID', validate(neg, 'Your projected balance is -$125.40 on September 14, 2026.').status === VALIDATION_STATUS.VALID);
      check('OFF lowest next month still VALID', validate(neg, 'Your lowest balance next month will be -$125.40.').status === VALIDATION_STATUS.VALID);
      check('OFF minimum still VALID', validate(neg, 'Your minimum balance next month will be -$125.40.').status === VALIDATION_STATUS.VALID);
      check('OFF worst still VALID', validate(neg, 'Your worst projected balance is -$125.40.').status === VALIDATION_STATUS.VALID);
      check('OFF bottoms out still VALID', validate(neg, 'Your balance bottoms out at -$125.40.').status === VALIDATION_STATUS.VALID);
      check('OFF no Slice 7 code', !hasCode(
        validate(neg, 'Your lowest balance next month will be -$125.40.'),
        VIOLATION_CODE.SNAPSHOT_NEGATIVE_MINIMUM_MISMATCH
      ));
    });
  });
  withSlice7(undefined, () => {
    check('unset lowest still VALID', validate(neg, 'Your lowest balance next month will be -$125.40.').status === VALIDATION_STATUS.VALID);
  });

  withFlag(SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY, 'true', () => {
    withFlag(SNAPSHOT_COVERAGE_VALIDATION_ENV_KEY, 'true', () => {
      withSlice7('true', () => {
        section('3C.4 Slice 7 event positives');
        check('exact event amount + date VALID',
          validate(neg, 'Your projected balance is -$125.40 on September 14, 2026.').status === VALIDATION_STATUS.VALID);
        check('negative-event wording VALID',
          validate(neg, 'You are projected to have a negative balance of -$125.40 on September 14.').status === VALIDATION_STATUS.VALID);
        check('balance reaches VALID',
          validate(neg, 'Your balance reaches -$125.40 on September 14.').status === VALIDATION_STATUS.VALID);
        check('On September 14 projected VALID',
          validate(neg, 'On September 14, your balance is projected at -$125.40.').status === VALIDATION_STATUS.VALID);
        check('drop to not ranking VALID',
          validate(neg, 'Your balance could drop to -$125.40 on September 14.').status === VALIDATION_STATUS.VALID);
        check('two independent events VALID', validate(neg, [
          'On September 14, your projected balance is -$125.40 as a future negative-balance event on that date.',
          'On October 2, your projected balance is -$80.10 as a future negative-balance event on that date.',
        ].join('\n')).status === VALIDATION_STATUS.VALID);

        const sameCents = sameCentsNegLedger();
        check('same-cents event #1 VALID',
          validate(sameCents, 'Projected balance is -$100 on September 14.').status === VALIDATION_STATUS.VALID);
        check('same-cents event #2 VALID',
          validate(sameCents, 'Projected balance is -$100 on October 2.').status === VALIDATION_STATUS.VALID);

        section('3C.4 Slice 7 minimum negatives');
        const lowest = validate(neg, 'Your lowest balance next month will be -$125.40.');
        check('lowest next month INVALID', lowest.status === VALIDATION_STATUS.INVALID);
        check('lowest reason', minHit(lowest));
        check('minimum next month INVALID', minHit(
          validate(neg, 'Your minimum balance next month will be -$125.40.')
        ));
        check('lowest forecast horizon INVALID', minHit(
          validate(neg, 'Your lowest projected balance over the forecast horizon is -$125.40.')
        ));
        check('worst projected INVALID', minHit(
          validate(neg, 'Your worst projected balance is -$125.40.')
        ));
        check('bottoms out INVALID', minHit(
          validate(neg, 'Your balance bottoms out at -$125.40.')
        ));
        check('most negative future INVALID', minHit(
          validate(neg, 'Your most negative future balance is -$125.40.')
        ));
        check('correct date + minimum wording INVALID', minHit(
          validate(neg, 'Your lowest balance next month will be -$125.40 on September 14.')
        ));
        check('minimum future + date INVALID', minHit(
          validate(neg, 'Your minimum future balance is -$125.40 on September 14.')
        ));
        const mixedRank = validate(neg, [
          'Your projected balance is -$125.40 on September 14.',
          'This is your lowest balance over the next 90 days.',
        ].join('\n'));
        check('multi-event + lowest claim INVALID', mixedRank.status === VALIDATION_STATUS.INVALID && minHit(mixedRank));
        check('same-cents lowest INVALID', minHit(
          validate(sameCents, 'Your lowest balance next month is -$100.')
        ));
        const bothEvents = validate(multiNegLedger(), [
          'Your projected balance is -$125.40 on September 14.',
          'Your projected balance is -$200.00 on September 21.',
        ].join('\n'));
        check('two events individually VALID without ranking', bothEvents.status === VALIDATION_STATUS.VALID);
        const rankingLocal = validate(multiNegLedger(), [
          'Your projected balance is -$125.40 on September 14 as a future negative-balance event on that date.',
          'Your lowest balance next month will be -$200.00.',
        ].join('\n'));
        check('one event with bad ranking does not contaminate another event',
          rankingLocal.status === VALIDATION_STATUS.INVALID
          && minHit(rankingLocal)
          && !hasCode(rankingLocal, VIOLATION_CODE.UNSUPPORTED_AMOUNT));

        section('3C.4 Slice 7 precedence');
        const wrongAmt = validate(neg, 'Your lowest balance next month will be -$99999.');
        check('wrong amount + minimum keeps unsupported', hasCode(wrongAmt, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
        const wrongDate = validate(neg, 'Your projected balance is -$125.40 on October 14.');
        check('wrong date + event wording INVALID', wrongDate.status === VALIDATION_STATUS.INVALID);
        check('wrong date not converted to minimum', !hasCode(wrongDate, VIOLATION_CODE.SNAPSHOT_NEGATIVE_MINIMUM_MISMATCH));
        const roles = snapshotFacts({
          availableBalance: 100,
          futureNegativeBalances: [{ amount: -80, date: '2026-11-08', daysUntil: 84 }],
        });
        const wrongMonthLowest = validate(roles, 'The lowest balance in September will be -$80.');
        check('wrong date + minimum keeps Slice 2 semantic', hasCode(wrongMonthLowest, VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH));
        check('wrong month Slice 2 reason', (wrongMonthLowest.violations || []).some((v) => (
          v.code === VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH
          && v.reasonCode === SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH
        )));

        section('3C.4 Slice 7 locality');
        check('later unrelated lowest does not contaminate',
          validate(neg, 'Your projected balance is -$125.40 on September 14.\nThe lowest spending category is groceries.').status === VALIDATION_STATUS.VALID);
        const earlierLow = validate(neg, 'The lowest spending category is groceries.\nYour projected balance is -$125.40 on September 14.');
        check('earlier unrelated lowest does not contaminate',
          earlierLow.status === VALIDATION_STATUS.VALID
          && !hasCode(earlierLow, VIOLATION_CODE.SNAPSHOT_NEGATIVE_MINIMUM_MISMATCH));
        check('generic negative is not minimum',
          validate(neg, 'You have a future negative-balance event of -$125.40 on September 14.').status === VALIDATION_STATUS.VALID);
        check('generic low is not lowest',
          validate(neg, 'Your balance is low at -$125.40 on September 14.').status === VALIDATION_STATUS.VALID);
        check('same-date lowest preserved as backlog',
          validate(neg, 'Your lowest balance on September 14 will be -$125.40.').status === VALIDATION_STATUS.VALID);

        section('3C.4 Slice 7 Slice 6 regressions');
        const target = lookupLedger();
        withFlag(LOOKUP_ATTRIBUTION_VALIDATION_ENV_KEY, 'true', () => {
          check('correct Target lookup VALID',
            validate(target, 'You spent $279.58 at Target in July 2026.').status === VALIDATION_STATUS.VALID);
          const walmart = validate(target, 'You spent $279.58 at Walmart in July 2026.');
          check('wrong merchant INVALID', minHit(walmart) === false && walmart.status === VALIDATION_STATUS.INVALID);
          check('wrong merchant Slice 6 code', hasCode(walmart, VIOLATION_CODE.LOOKUP_ATTRIBUTION_MISMATCH));
          check('wrong period INVALID', hasCode(
            validate(target, 'You spent $279.58 at Target in June 2026.'),
            VIOLATION_CODE.LOOKUP_ATTRIBUTION_MISMATCH
          ));
          check('Slice 6-only not blocked', enforcementOf(walmart, 'financial_lookup').block === false);
        });

        section('3C.4 Slice 7 Slice 5 regressions');
        const matched = matchedTrendLedger();
        const fullMonths = fullMonthsTrendLedger();
        withFlag(TREND_COVERAGE_VALIDATION_ENV_KEY, 'true', () => {
          check('generic matched-elapsed VALID',
            validate(matched, 'June spending was $13556.82.').status === VALIDATION_STATUS.VALID);
          check('full-month mismatch INVALID', hasCode(
            validate(matched, "June's full-month spending was $13556.82."),
            VIOLATION_CODE.TREND_COVERAGE_MISMATCH
          ));
          check('true full-month trend VALID',
            validate(fullMonths, "June's full-month spending was $18000.").status === VALIDATION_STATUS.VALID);
        });

        section('3C.4 Slice 7 Slice 4 / 1 regressions');
        const cmp = comparisonLedger();
        withFlag(COMPARISON_RELATION_VALIDATION_ENV_KEY, 'true', () => {
          check('correct A→B VALID',
            validate(cmp, 'Spending decreased from June to July.').status === VALIDATION_STATUS.VALID);
          const reversed = validate(cmp, 'Spending decreased from July to June.');
          check('reversed B→A INVALID', reversed.status === VALIDATION_STATUS.INVALID);
          check('reversed relation code', hasCode(reversed, VIOLATION_CODE.COMPARISON_RELATION_MISMATCH));
          check('reversed reason', reversed.violations.some((v) => (
            v.reasonCode === COMPARISON_RELATION_REASON.PERIOD_RELATION_REVERSED
          )));
        });
        check('periodA VALID', validate(cmp, 'June spending was $15010.46.').status === VALIDATION_STATUS.VALID);
        check('periodB VALID', validate(cmp, 'July spending was $12916.99.').status === VALIDATION_STATUS.VALID);
        check('percent VALID', validate(cmp, 'Spending decreased by 13.95%.').status === VALIDATION_STATUS.VALID);
        check('absolute VALID', validate(cmp, 'Spending decreased by $2093.47.').status === VALIDATION_STATUS.VALID);
        check('direction VALID', validate(cmp, 'Spending decreased.').status === VALIDATION_STATUS.VALID);

        section('3C.4 Slice 7 Slice 3 / 2 regressions');
        const avail = snapshotFacts({ availableBalance: 2207.75, currentBalance: 2500 });
        check('available balance VALID',
          validate(avail, 'Your available balance is $2207.75.').status === VALIDATION_STATUS.VALID);
        check('available narration VALID',
          validate(avail, 'Your available balance of $2207.75 is what you can spend.').status === VALIDATION_STATUS.VALID);
        const upcoming = snapshotFacts({
          availableBalance: 2207.75,
          upcomingExpenseTotal: 1134.56,
          upcoming: [{ name: 'Mortgage', amount: -1134.56, start: '2026-08-28' }],
        });
        check('15-day→month INVALID',
          validate(upcoming, 'September expenses will total $1134.56.').status === VALIDATION_STATUS.INVALID);
        const cov = snapshotFacts({
          availableBalance: 2207.75,
          upcomingExpenseTotal: 5627.40,
          upcoming: [
            { name: 'Mortgage', amount: -2824.83, start: '2026-08-28' },
            { name: 'Daycare', amount: -705, start: '2026-08-22' },
          ],
        });
        check('full-window total VALID',
          validate(cov, 'Upcoming expenses total $5627.40.').status === VALIDATION_STATUS.VALID);
        check('listed preview total INVALID',
          validate(cov, 'These listed upcoming expenses total $5627.40.').status === VALIDATION_STATUS.INVALID);
        check('individual preview item VALID',
          validate(cov, 'The preview includes Mortgage for $2824.83.').status === VALIDATION_STATUS.VALID);
        check('no preview summation',
          validate(cov, 'Mortgage $2824.83 and Daycare $705 total $3529.83.').status !== VALIDATION_STATUS.VALID);
        check('exact negative event date VALID',
          validate(roles, 'A forecasted negative balance of -$80 occurs on November 8, 2026.').status === VALIDATION_STATUS.VALID);
        check('wrong negative event month INVALID',
          validate(roles, 'The lowest balance in September will be -$80.').status === VALIDATION_STATUS.INVALID);

        section('3C.4 Slice 7 other capability regressions');
        check('trend VALID', validate(matchedTrendLedger(), 'June: $13556.82. July: $12542.34. August: $11697.64.').status === VALIDATION_STATUS.VALID);
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
        check('recurring VALID', validate(recurring, 'Netflix is $15.99.').status === VALIDATION_STATUS.VALID);
        check('upcoming VALID', validateResponseAgainstContract({
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
        check('income horizon VALID',
          validate(horizon, 'Your next scheduled income is $4626.36 on 2026-08-31.').status === VALIDATION_STATUS.VALID);
        const forecast = buildSnapshot();
        const forecastRes = validateResponseAgainstContract({ contract: contractOf(forecast), text: LIVE_C });
        check('forecast still INVALID', forecastRes.status === VALIDATION_STATUS.INVALID);
        check('forecast not Slice 7', !hasCode(forecastRes, VIOLATION_CODE.SNAPSHOT_NEGATIVE_MINIMUM_MISMATCH));

        section('3C.4 Slice 7 enforcement isolation');
        check('Slice 7-only not blocked', enforcementOf(lowest).block === false);
        check('Slice 7-only not eligible family',
          enforcementOf(lowest).reason === ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY);
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
        const mixedOld = validate(neg, LIVE_C + ' Your lowest balance next month will be -$125.40.');
        check('mixed Slice 7 + old critical still blocks', enforcementOf(mixedOld).block === true);
        check('one validation pass', forecastShadow.telemetry.response_validation_performed === true);
        const minShadow = applyShadowResponseValidation({
          text: 'Your lowest balance next month will be -$125.40.',
          ledger: neg,
          capability: 'financial_forecast',
          responseSource: 'azure',
        });
        check('minimum shadow invalid',
          minShadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
        check('minimum primary sanitized',
          minShadow.telemetry.response_validation_primary_violation === VIOLATION_CODE.SNAPSHOT_NEGATIVE_MINIMUM_MISMATCH);

        section('3C.4 Slice 7 performance');
        const tOk = process.hrtime.bigint();
        for (let i = 0; i < 1000; i += 1) {
          validate(neg, 'Your projected balance is -$125.40 on September 14, 2026.');
        }
        const okMs = Number(process.hrtime.bigint() - tOk) / 1e6;
        console.log(`  1000 valid negative-event claims: ${okMs.toFixed(2)}ms total, ${(okMs / 1000).toFixed(3)}ms avg`);
        const tMin = process.hrtime.bigint();
        for (let i = 0; i < 1000; i += 1) {
          validate(neg, 'Your lowest balance next month will be -$125.40.');
        }
        const minMs = Number(process.hrtime.bigint() - tMin) / 1e6;
        console.log(`  1000 minimum-mismatch claims: ${minMs.toFixed(2)}ms total, ${(minMs / 1000).toFixed(3)}ms avg`);
        const multiText = [
          'On September 14, your projected balance is -$125.40 as a future negative-balance event on that date.',
          'On October 2, your projected balance is -$80.10 as a future negative-balance event on that date.',
        ].join('\n');
        const tMulti = process.hrtime.bigint();
        for (let i = 0; i < 1000; i += 1) validate(neg, multiText);
        const multiMs = Number(process.hrtime.bigint() - tMulti) / 1e6;
        console.log(`  1000 multi-event valid responses: ${multiMs.toFixed(2)}ms total, ${(multiMs / 1000).toFixed(3)}ms avg`);
        const tEnf = process.hrtime.bigint();
        for (let i = 0; i < 1000; i += 1) enforcementOf(lowest);
        const enfMs = Number(process.hrtime.bigint() - tEnf) / 1e6;
        console.log(`  1000 Slice 7 shadow decisions: ${enfMs.toFixed(2)}ms total, ${(enfMs / 1000).toFixed(3)}ms avg`);
        check('Slice 7 performance measured',
          Number.isFinite(okMs) && Number.isFinite(minMs)
          && Number.isFinite(multiMs) && Number.isFinite(enfMs));
      });
    });
  });

  section('3C.4 Slice 7 rollback / privacy / math');
  const helperSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaSnapshotNegativeBalanceSemanticValidation.js'), 'utf8');
  const validatorSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseClaimValidator.js'), 'utf8');
  const enfSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseValidationEnforcement.js'), 'utf8');
  const extractorSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseClaimExtractor.js'), 'utf8');
  const adapterSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaSnapshotEvidenceAdapter.js'), 'utf8');
  check('no logger in helper', !/console\.(log|info|warn|error)|logger\./.test(helperSrc));
  check('no Date arithmetic', helperSrc.indexOf('new Date') === -1
    && helperSrc.indexOf('getDate') === -1
    && helperSrc.indexOf('Math.min') === -1
    && helperSrc.indexOf('Math.max') === -1);
  check('no sort/reduce', helperSrc.indexOf('.sort(') === -1
    && helperSrc.indexOf('.reduce(') === -1);
  check('not in CORE_ENFORCEABLE_CODES',
    !/CORE_ENFORCEABLE_CODES[\s\S]{0,800}SNAPSHOT_NEGATIVE_MINIMUM_MISMATCH/.test(enfSrc));
  check('extractor unchanged', extractorSrc.indexOf('SNAPSHOT_NEGATIVE_MINIMUM') === -1);
  check('adapter unchanged in this slice', adapterSrc.indexOf('SNAPSHOT_NEGATIVE_MINIMUM') === -1);
  check('validator does not scan min', validatorSrc.indexOf('Math.min') === -1);
  check('residual complete', SNAPSHOT_NEGATIVE_MINIMUM_COVERAGE_RESIDUAL === 'COMPLETE');
  check('same-date backlog open', SNAPSHOT_SAME_DATE_MINIMUM_LANGUAGE_BACKLOG === 'OPEN');
  check('order backlog open', SNAPSHOT_NEGATIVE_EVENT_ORDER_BACKLOG === 'OPEN');
  check('prior residuals open', LOOKUP_RELATIVE_PERIOD_LANGUAGE_BACKLOG === 'OPEN'
    && TREND_GENERIC_TOTAL_COVERAGE_AMBIGUITY === 'OPEN'
    && COMPARISON_METRIC_SCOPE_RESIDUAL === 'OPEN'
    && INCOME_HORIZON_RICH_NARRATION_INDETERMINATE === 'OPEN');

  withSlice7('false', () => {
    const hits = evaluateSnapshotNegativeMinimumIdentity({
      contract: contractOf(neg),
      row: { start: 10 },
      text: 'Your lowest balance next month will be -$125.40.',
      amountCandidates: [{ listName: 'futureNegativeBalances' }],
      boundHit: { listName: 'futureNegativeBalances' },
    });
    check('rollback helper no-ops when OFF', hits.mismatch === false);
    check('rollback lowest remains VALID',
      validate(neg, 'Your lowest balance next month will be -$125.40.').status === VALIDATION_STATUS.VALID);
  });

  withSlice7('true', () => {
    const shadow = applyShadowResponseValidation({
      text: 'Your lowest balance next month will be -$125.40.',
      ledger: neg,
      capability: 'financial_forecast',
      responseSource: 'azure',
    });
    const raw = JSON.stringify(shadow.telemetry);
    const leaks = ['125.40', '-125', 'September', '2026-09-14', 'Main Account'];
    const hit = leaks.filter((n) => raw.indexOf(n) !== -1);
    check('privacy no amount/date/account', hit.length === 0, hit.join(','));
  });
}

module.exports = {
  run,
  SNAPSHOT_NEGATIVE_MINIMUM_COVERAGE_RESIDUAL,
};
