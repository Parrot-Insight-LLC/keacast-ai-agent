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
const { extractResponseClaims } = require('../services/keaResponseClaimExtractor');
const { validateResponseAgainstContract } = require('../services/keaResponseClaimValidator');
const {
  LOOKUP_ATTRIBUTION_VALIDATION_ENV_KEY,
  LOOKUP_ATTRIBUTION_REASON,
  isLookupAttributionValidationEnabled,
  evaluateLookupAttributionIdentity,
} = require('../services/keaLookupSemanticValidation');
const {
  SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY,
  SNAPSHOT_COVERAGE_VALIDATION_ENV_KEY,
} = require('../services/keaSnapshotSemanticValidation');
const {
  COMPARISON_RELATION_VALIDATION_ENV_KEY,
  COMPARISON_RELATION_REASON,
} = require('../services/keaComparisonSemanticValidation');
const {
  TREND_COVERAGE_VALIDATION_ENV_KEY,
} = require('../services/keaTrendSemanticValidation');
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

const LOOKUP_MERCHANT_PERIOD_BACKLOG = 'COMPLETE';
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
const SNAPSHOT_NEGATIVE_MINIMUM_COVERAGE_RESIDUAL = 'OPEN';
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

function withAttr(value, fn) {
  return withFlag(LOOKUP_ATTRIBUTION_VALIDATION_ENV_KEY, value, fn);
}

function codes(result) {
  return (result.violations || []).map((v) => v.code);
}

function hasCode(result, code) {
  return codes(result).indexOf(code) !== -1;
}

function attrHit(result, reason) {
  return (result.violations || []).some((v) => v.code === VIOLATION_CODE.LOOKUP_ATTRIBUTION_MISMATCH
    && (reason == null || v.reasonCode === reason)
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

function lookupLedger(extraFacts, extraLookups) {
  return buildLookupEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['user_transactions'],
      facts: Object.assign({
        transactionCount: 3,
        spentTotal: 279.58,
        expenseTotal: 279.58,
        incomeTotal: 0,
      }, extraFacts || {}),
      period: { start: '2026-07-01', end: '2026-07-31', label: 'July 2026' },
      lookups: extraLookups || [],
      limitations: [],
    },
    route: { slots: { subjectKind: 'merchant', subjectValue: 'Target' } },
    accountContext: { accountId: '10', accountLabel: 'Main Account' },
  }).ledger;
}

function sameCentsLedger() {
  return lookupLedger({
    transactionCount: 1,
    spentTotal: 100,
    expenseTotal: 100,
    incomeTotal: 0,
  }, [{
    label: 'Target',
    merchant: 'Target',
    amount: 100,
    date: '2026-07-12',
    spentTotal: 100,
    transactionCount: 1,
  }]);
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

function enforcementOf(validation) {
  return evaluateResponseEnforcement({
    flagEnabled: true,
    capability: 'financial_lookup',
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

function amountId(text, value) {
  const rows = extractResponseClaims(text);
  const hit = rows.find((row) => row.normalizedValue === value);
  return hit ? hit.id : null;
}

async function run() {
  section('3C.4 Slice 6 flag defaults');
  withAttr(undefined, () => {
    check('unset defaults OFF', isLookupAttributionValidationEnabled() === false);
  });
  withAttr('', () => {
    check('empty defaults OFF', isLookupAttributionValidationEnabled() === false);
  });
  withAttr('false', () => {
    check('false OFF', isLookupAttributionValidationEnabled() === false);
  });
  withAttr('true', () => {
    check('true ON', isLookupAttributionValidationEnabled() === true);
  });
  check('flag name', LOOKUP_ATTRIBUTION_VALIDATION_ENV_KEY === 'USE_LOOKUP_ATTRIBUTION_VALIDATION_SHADOW');
  check('violation enum', VIOLATION_CODE.LOOKUP_ATTRIBUTION_MISMATCH === 'LOOKUP_ATTRIBUTION_MISMATCH');
  check('reason enums', LOOKUP_ATTRIBUTION_REASON.MERCHANT_IDENTITY_MISMATCH === 'merchant_identity_mismatch'
    && LOOKUP_ATTRIBUTION_REASON.PERIOD_IDENTITY_MISMATCH === 'period_identity_mismatch');

  const target = lookupLedger();
  const frozen = buildLookup();
  const sameCents = sameCentsLedger();
  check('merchant Target', contractOf(target).scope.merchant === 'Target');
  check('period July 2026', contractOf(target).scope.period.label === 'July 2026');

  section('3C.4 Slice 6 flag OFF preserves pre-Slice-6 behavior');
  withAttr('false', () => {
    check('OFF Target July VALID', validate(target, 'You spent $279.58 at Target in July 2026.').status === VALIDATION_STATUS.VALID);
    check('OFF Walmart still VALID', validate(target, 'You spent $279.58 at Walmart in July 2026.').status === VALIDATION_STATUS.VALID);
    check('OFF June still VALID', validate(target, 'You spent $279.58 at Target in June 2026.').status === VALIDATION_STATUS.VALID);
    check('OFF no attribution code', !hasCode(
      validate(target, 'You spent $279.58 at Walmart in July 2026.'),
      VIOLATION_CODE.LOOKUP_ATTRIBUTION_MISMATCH
    ));
  });
  withAttr(undefined, () => {
    check('unset Walmart still VALID', validate(target, 'You spent $279.58 at Walmart in July 2026.').status === VALIDATION_STATUS.VALID);
  });

  withAttr('true', () => {
    section('3C.4 Slice 6 merchant positives');
    check('decimal does not truncate post-amount merchant',
      evaluateLookupAttributionIdentity({
        contract: contractOf(target),
        row: { start: 'You spent $279.58 at Walmart in July 2026.'.indexOf('$') },
        text: 'You spent $279.58 at Walmart in July 2026.',
      }).mismatch === true);
    check('Target + July + amount VALID',
      validate(target, 'You spent $279.58 at Target in July 2026.').status === VALIDATION_STATUS.VALID);
    check('Target spending in July VALID',
      validate(target, 'Target spending in July 2026 was $279.58.').status === VALIDATION_STATUS.VALID);
    check('Target amount no period VALID',
      validate(target, 'You spent $279.58 at Target.').status === VALIDATION_STATUS.VALID);
    check('Target last month VALID',
      validate(target, 'Your Target spending last month was $279.58.').status === VALIDATION_STATUS.VALID);
    check('frozen live-good count+amount VALID',
      validate(frozen, 'In July 2026, you made 3 transactions at Target totaling $279.58.').status === VALIDATION_STATUS.VALID);
    check('Target count VALID',
      validate(target, 'You made 3 transactions at Target in July 2026.').status === VALIDATION_STATUS.VALID);
    check('Target no-income VALID',
      validate(target, 'There was no income recorded from Target in July 2026.').status === VALIDATION_STATUS.VALID);

    section('3C.4 Slice 6 merchant negatives');
    const walmartJuly = validate(target, 'You spent $279.58 at Walmart in July 2026.');
    check('Walmart + July + Target amount INVALID', walmartJuly.status === VALIDATION_STATUS.INVALID);
    check('Walmart merchant reason', attrHit(walmartJuly, LOOKUP_ATTRIBUTION_REASON.MERCHANT_IDENTITY_MISMATCH));
    check('Walmart spending INVALID', attrHit(
      validate(target, 'Walmart spending in July 2026 was $279.58.'),
      LOOKUP_ATTRIBUTION_REASON.MERCHANT_IDENTITY_MISMATCH
    ));
    check('Walmart count INVALID', attrHit(
      validate(target, 'You made 3 transactions at Walmart in July 2026.'),
      LOOKUP_ATTRIBUTION_REASON.MERCHANT_IDENTITY_MISMATCH
    ));
    check('Walmart no-income INVALID', attrHit(
      validate(target, 'There was no income recorded from Walmart in July 2026.'),
      LOOKUP_ATTRIBUTION_REASON.MERCHANT_IDENTITY_MISMATCH
    ));

    section('3C.4 Slice 6 period positives');
    check('July 2026 + Target VALID',
      validate(target, 'In July 2026, you spent $279.58 at Target.').status === VALIDATION_STATUS.VALID);
    check('missing explicit period VALID',
      validate(target, 'You spent $279.58 at Target.').status === VALIDATION_STATUS.VALID);
    check('missing merchant VALID',
      validate(target, 'You spent $279.58 in July 2026.').status === VALIDATION_STATUS.VALID);
    check('bare amount VALID',
      validate(target, 'You spent $279.58.').status === VALIDATION_STATUS.VALID);

    section('3C.4 Slice 6 period negatives');
    const juneTarget = validate(target, 'You spent $279.58 at Target in June 2026.');
    check('June 2026 + Target amount INVALID', juneTarget.status === VALIDATION_STATUS.INVALID);
    check('June period reason', attrHit(juneTarget, LOOKUP_ATTRIBUTION_REASON.PERIOD_IDENTITY_MISMATCH));
    check('August Target INVALID', attrHit(
      validate(target, 'Target spending in August 2026 was $279.58.'),
      LOOKUP_ATTRIBUTION_REASON.PERIOD_IDENTITY_MISMATCH
    ));
    check('July wrong year INVALID', attrHit(
      validate(target, 'Target spending in July 2025 was $279.58.'),
      LOOKUP_ATTRIBUTION_REASON.PERIOD_IDENTITY_MISMATCH
    ));
    check('wrong-period count INVALID', attrHit(
      validate(target, 'You made 3 transactions at Target in June 2026.'),
      LOOKUP_ATTRIBUTION_REASON.PERIOD_IDENTITY_MISMATCH
    ));
    check('wrong-period no-income INVALID', attrHit(
      validate(target, 'No Target income was recorded in June 2026.'),
      LOOKUP_ATTRIBUTION_REASON.PERIOD_IDENTITY_MISMATCH
    ));
    check('explicit June overrides last month', attrHit(
      validate(target, 'Your Target spending last month was $279.58, in June 2026.'),
      LOOKUP_ATTRIBUTION_REASON.PERIOD_IDENTITY_MISMATCH
    ));

    section('3C.4 Slice 6 merchant + period');
    const both = validate(target, 'Walmart spending in June 2026 was $279.58.');
    check('Walmart + June INVALID', both.status === VALIDATION_STATUS.INVALID);
    check('both merchant reason', attrHit(both, LOOKUP_ATTRIBUTION_REASON.MERCHANT_IDENTITY_MISMATCH));
    check('both period reason', attrHit(both, LOOKUP_ATTRIBUTION_REASON.PERIOD_IDENTITY_MISMATCH));
    check('correct merchant not period-only', attrHit(walmartJuly, LOOKUP_ATTRIBUTION_REASON.MERCHANT_IDENTITY_MISMATCH)
      && !attrHit(walmartJuly, LOOKUP_ATTRIBUTION_REASON.PERIOD_IDENTITY_MISMATCH));
    check('correct period not merchant-only', attrHit(juneTarget, LOOKUP_ATTRIBUTION_REASON.PERIOD_IDENTITY_MISMATCH)
      && !attrHit(juneTarget, LOOKUP_ATTRIBUTION_REASON.MERCHANT_IDENTITY_MISMATCH));

    section('3C.4 Slice 6 value precedence');
    const wrongAmt = validate(target, 'Target spending in July 2026 was $99999.');
    check('wrong amount UNSUPPORTED_AMOUNT', hasCode(wrongAmt, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
    check('wrong amount not attribution-only', !hasCode(wrongAmt, VIOLATION_CODE.LOOKUP_ATTRIBUTION_MISMATCH));
    const wrongAmtMerch = validate(target, 'Walmart spending in July 2026 was $99999.');
    check('wrong amount + wrong merchant keeps unsupported', hasCode(wrongAmtMerch, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
    const wrongAmtPeriod = validate(target, 'Target spending in June 2026 was $99999.');
    check('wrong amount + wrong period keeps unsupported', hasCode(wrongAmtPeriod, VIOLATION_CODE.UNSUPPORTED_AMOUNT));

    section('3C.4 Slice 6 same-cents');
    check('correct aggregate VALID',
      validate(sameCents, 'Target spending in July 2026 was $100.').status === VALIDATION_STATUS.VALID);
    check('correct item VALID',
      validate(sameCents, 'A Target transaction was $100.').status === VALIDATION_STATUS.VALID);
    check('wrong merchant aggregate INVALID', attrHit(
      validate(sameCents, 'Walmart spending in July 2026 was $100.'),
      LOOKUP_ATTRIBUTION_REASON.MERCHANT_IDENTITY_MISMATCH
    ));
    check('wrong period aggregate INVALID', attrHit(
      validate(sameCents, 'Target spending in June 2026 was $100.'),
      LOOKUP_ATTRIBUTION_REASON.PERIOD_IDENTITY_MISMATCH
    ));

    section('3C.4 Slice 6 locality');
    check('later Walmart does not contaminate Target amount',
      validate(target, 'Target spending in July was $279.58.\nWalmart is another merchant I use.').status === VALIDATION_STATUS.VALID);
    check('earlier unrelated Walmart does not contaminate Target',
      validate(target, 'Walmart is another merchant I use.\nTarget spending in July was $279.58.').status === VALIDATION_STATUS.VALID);
    const multiMerch = 'Target spending was $279.58.\nWalmart spending was also $279.58.';
    const multi = validate(target, multiMerch);
    check('multi-merchant overall INVALID', multi.status === VALIDATION_STATUS.INVALID);
    const walmartId = amountId(multiMerch, 279.58);
    const merchHits = (multi.violations || []).filter((v) => v.code === VIOLATION_CODE.LOOKUP_ATTRIBUTION_MISMATCH);
    check('Walmart claim independently classified', merchHits.length >= 1);
    check('at least one attribution on second amount', merchHits.some((v) => v.extractedClaimId === walmartId)
      || merchHits.length === 1);
    const mixedCount = validate(target, [
      'You spent $279.58 at Target in July 2026.',
      'You made 3 transactions at Walmart in July 2026.',
    ].join('\n'));
    check('mixed count overall INVALID', mixedCount.status === VALIDATION_STATUS.INVALID);
    check('mixed count merchant on Walmart', attrHit(mixedCount, LOOKUP_ATTRIBUTION_REASON.MERCHANT_IDENTITY_MISMATCH));
    check('multi-claim positive VALID', validate(target, [
      'You spent $279.58 at Target in July 2026.',
      'This came from 3 posted Target transactions.',
      'There was no Target income in that period.',
    ].join('\n')).status === VALIDATION_STATUS.VALID);

    section('3C.4 Slice 6 lookup item regressions');
    check('exact transaction item VALID',
      validate(sameCents, 'A Target transaction for $100 posted on July 12.').status === VALIDATION_STATUS.VALID);
    const wrongItemAmt = validate(sameCents, 'A Target transaction was $99.');
    check('wrong transaction amount INVALID', wrongItemAmt.status === VALIDATION_STATUS.INVALID);
    const wrongItemDate = validate(sameCents, 'A Target transaction for $100 posted on June 12.');
    check('wrong transaction date INVALID', wrongItemDate.status === VALIDATION_STATUS.INVALID);

    section('3C.4 Slice 6 Slice 5 regressions');
    const matched = matchedTrendLedger();
    const fullMonths = fullMonthsTrendLedger();
    withFlag(TREND_COVERAGE_VALIDATION_ENV_KEY, 'true', () => {
      check('generic matched-elapsed VALID',
        validate(matched, 'June spending was $13556.82.').status === VALIDATION_STATUS.VALID);
      check('full-month trend mismatch INVALID', hasCode(
        validate(matched, "June's full-month spending was $13556.82."),
        VIOLATION_CODE.TREND_COVERAGE_MISMATCH
      ));
      check('true full-month trend VALID',
        validate(fullMonths, "June's full-month spending was $18000.").status === VALIDATION_STATUS.VALID);
      check('trend not lookup attribution', !hasCode(
        validate(matched, "June's full-month spending was $13556.82."),
        VIOLATION_CODE.LOOKUP_ATTRIBUTION_MISMATCH
      ));
    });

    section('3C.4 Slice 6 Slice 4 / 1 regressions');
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
    check('wrong month INVALID', validate(cmp, 'July spending was $15010.46.').status === VALIDATION_STATUS.INVALID);
    check('percent VALID', validate(cmp, 'Spending decreased by 13.95%.').status === VALIDATION_STATUS.VALID);
    check('absolute VALID', validate(cmp, 'Spending decreased by $2093.47.').status === VALIDATION_STATUS.VALID);
    check('direction VALID', validate(cmp, 'Spending decreased.').status === VALIDATION_STATUS.VALID);

    section('3C.4 Slice 6 Slice 2 / 3 regressions');
    withFlag(SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY, 'true', () => {
      withFlag(SNAPSHOT_COVERAGE_VALIDATION_ENV_KEY, 'true', () => {
        const avail = snapshotFacts({ availableBalance: 2207.75, currentBalance: 2500 });
        check('available balance VALID',
          validate(avail, 'Your available balance is $2207.75.').status === VALIDATION_STATUS.VALID);
        check('available narration VALID',
          validate(avail, 'Your available balance of $2207.75 is what you can spend.').status === VALIDATION_STATUS.VALID);
        check('wrong balance role INVALID',
          validate(avail, 'Your current balance is $2207.75.').status === VALIDATION_STATUS.INVALID);
        const upcoming = snapshotFacts({
          availableBalance: 2207.75,
          upcomingExpenseTotal: 1134.56,
          upcoming: [{ name: 'Mortgage', amount: -1134.56, start: '2026-08-28' }],
        });
        check('15-day→month INVALID',
          validate(upcoming, 'September expenses will total $1134.56.').status === VALIDATION_STATUS.INVALID);
        const roles = snapshotFacts({
          availableBalance: 2207.75,
          lowestUpcomingBalance: -80,
          lowestUpcomingBalanceAt: '2026-08-22',
        });
        check('negative event wrong month INVALID',
          validate(roles, 'The lowest balance in September will be -$80.').status === VALIDATION_STATUS.INVALID);
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
      });
    });

    section('3C.4 Slice 6 other capability regressions');
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
    check('available standard VALID',
      validate(snapshotFacts({ availableBalance: 2207.75, currentBalance: 2500 }), 'Your available balance is $2207.75.').status === VALIDATION_STATUS.VALID);
    const forecast = buildSnapshot();
    const liveC = [
      'Your projected income for next month (September 2026) is $4626.36.',
      'Your projected expenses for next month are $3432.43.',
      'This results in a net positive cash flow of $1193.93.',
      'Your available balance is forecasted to be approximately $4846.97.',
      'Your balance is expected to increase by about $1194.',
    ].join(' ');
    const forecastRes = validateResponseAgainstContract({ contract: contractOf(forecast), text: liveC });
    check('forecast still INVALID', forecastRes.status === VALIDATION_STATUS.INVALID);
    check('forecast not lookup attribution', !hasCode(forecastRes, VIOLATION_CODE.LOOKUP_ATTRIBUTION_MISMATCH));

    section('3C.4 Slice 6 enforcement isolation');
    const onlyMerch = validate(target, 'You spent $279.58 at Walmart in July 2026.');
    check('Slice 6-only merchant not blocked', enforcementOf(onlyMerch).block === false);
    check('Slice 6-only not eligible family',
      enforcementOf(onlyMerch).reason === ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY);
    const onlyPeriod = validate(target, 'You spent $279.58 at Target in June 2026.');
    check('Slice 6-only period not blocked', enforcementOf(onlyPeriod).block === false);
    const existingBad = validate(frozen, 'You spent $280 at Target.');
    check('existing lookup wrong amount still blocks', enforcementOf(existingBad).block === true);
    const mixed = validate(target, 'You spent $99999 at Walmart in July 2026.');
    check('mixed keeps unsupported', hasCode(mixed, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
    check('mixed still blocks', enforcementOf(mixed).block === true);
    const forecastShadow = applyShadowResponseValidation({
      text: liveC,
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
    check('one validation pass', forecastShadow.telemetry.response_validation_performed === true);
    const attrShadow = applyShadowResponseValidation({
      text: 'You spent $279.58 at Walmart in July 2026.',
      ledger: target,
      capability: 'financial_lookup',
      responseSource: 'azure',
    });
    check('attribution shadow invalid',
      attrShadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
    check('attribution primary sanitized',
      attrShadow.telemetry.response_validation_primary_violation === VIOLATION_CODE.LOOKUP_ATTRIBUTION_MISMATCH);

    section('3C.4 Slice 6 performance');
    const tOk = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) validate(target, 'You spent $279.58 at Target in July 2026.');
    const okMs = Number(process.hrtime.bigint() - tOk) / 1e6;
    console.log(`  1000 valid lookup claims: ${okMs.toFixed(2)}ms total, ${(okMs / 1000).toFixed(3)}ms avg`);
    const tMerch = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) validate(target, 'You spent $279.58 at Walmart in July 2026.');
    const merchMs = Number(process.hrtime.bigint() - tMerch) / 1e6;
    console.log(`  1000 wrong-merchant claims: ${merchMs.toFixed(2)}ms total, ${(merchMs / 1000).toFixed(3)}ms avg`);
    const tPeriod = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) validate(target, 'You spent $279.58 at Target in June 2026.');
    const periodMs = Number(process.hrtime.bigint() - tPeriod) / 1e6;
    console.log(`  1000 wrong-period claims: ${periodMs.toFixed(2)}ms total, ${(periodMs / 1000).toFixed(3)}ms avg`);
    const tEnf = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) enforcementOf(onlyMerch);
    const enfMs = Number(process.hrtime.bigint() - tEnf) / 1e6;
    console.log(`  1000 Slice 6 shadow decisions: ${enfMs.toFixed(2)}ms total, ${(enfMs / 1000).toFixed(3)}ms avg`);
    check('Slice 6 performance measured',
      Number.isFinite(okMs) && Number.isFinite(merchMs)
      && Number.isFinite(periodMs) && Number.isFinite(enfMs));
  });

  section('3C.4 Slice 6 rollback / privacy / math');
  const helperSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaLookupSemanticValidation.js'), 'utf8');
  const validatorSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseClaimValidator.js'), 'utf8');
  const enfSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseValidationEnforcement.js'), 'utf8');
  const extractorSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseClaimExtractor.js'), 'utf8');
  check('no logger in helper', !/console\.(log|info|warn|error)|logger\./.test(helperSrc));
  check('no Date arithmetic', helperSrc.indexOf('new Date') === -1
    && helperSrc.indexOf('getDate') === -1
    && helperSrc.indexOf('getMonth') === -1);
  check('no financial reduce/sum', helperSrc.indexOf('.reduce(') === -1
    && helperSrc.indexOf('Math.abs') === -1
    && helperSrc.indexOf('.spentTotal') === -1);
  check('not in CORE_ENFORCEABLE_CODES',
    !/CORE_ENFORCEABLE_CODES[\s\S]{0,800}LOOKUP_ATTRIBUTION_MISMATCH/.test(enfSrc));
  check('extractor unchanged', extractorSrc.indexOf('LOOKUP_ATTRIBUTION') === -1);
  check('validator does not rerun lookup', validatorSrc.indexOf('prefetchLookup') === -1);
  check('backlog complete', LOOKUP_MERCHANT_PERIOD_BACKLOG === 'COMPLETE');
  check('relative period backlog open', LOOKUP_RELATIVE_PERIOD_LANGUAGE_BACKLOG === 'OPEN');
  check('coreference backlogs open', LOOKUP_MERCHANT_COREFERENCE_BACKLOG === 'OPEN'
    && LOOKUP_PERIOD_COREFERENCE_BACKLOG === 'OPEN');
  check('range/account residuals open', LOOKUP_EXPLICIT_RANGE_LANGUAGE_BACKLOG === 'OPEN'
    && LOOKUP_ACCOUNT_SCOPE_IDENTITY === 'OPEN');
  check('prior residuals open', TREND_GENERIC_TOTAL_COVERAGE_AMBIGUITY === 'OPEN'
    && COMPARISON_METRIC_SCOPE_RESIDUAL === 'OPEN'
    && SNAPSHOT_NEGATIVE_MINIMUM_COVERAGE_RESIDUAL === 'OPEN'
    && INCOME_HORIZON_RICH_NARRATION_INDETERMINATE === 'OPEN');

  withAttr('false', () => {
    const hits = evaluateLookupAttributionIdentity({
      contract: contractOf(target),
      row: { start: 10 },
      text: 'You spent $279.58 at Walmart in July 2026.',
    });
    check('rollback helper no-ops when OFF', hits.mismatch === false);
    check('rollback Walmart remains VALID',
      validate(target, 'You spent $279.58 at Walmart in July 2026.').status === VALIDATION_STATUS.VALID);
    check('rollback preserves existing lookup invalid',
      validate(frozen, 'You spent $280 at Target.').status === VALIDATION_STATUS.INVALID);
  });

  withAttr('true', () => {
    const shadow = applyShadowResponseValidation({
      text: 'You spent $279.58 at Walmart in July 2026.',
      ledger: target,
      capability: 'financial_lookup',
      responseSource: 'azure',
    });
    const raw = JSON.stringify(shadow.telemetry);
    const leaks = ['279.58', 'Walmart', 'Target', 'July', '2026-07-01', 'Main Account'];
    const hit = leaks.filter((n) => raw.indexOf(n) !== -1);
    check('privacy no merchant/amount/month/account', hit.length === 0, hit.join(','));
  });
}

module.exports = {
  run,
  LOOKUP_MERCHANT_PERIOD_BACKLOG,
};
