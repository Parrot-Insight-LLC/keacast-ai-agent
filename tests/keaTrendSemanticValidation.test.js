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
  TREND_COVERAGE_VALIDATION_ENV_KEY,
  TREND_COVERAGE_REASON,
  isTrendCoverageValidationEnabled,
  spokenTrendCoverage,
  evaluateTrendCoverageIdentity,
} = require('../services/keaTrendSemanticValidation');
const {
  SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY,
  SNAPSHOT_COVERAGE_VALIDATION_ENV_KEY,
} = require('../services/keaSnapshotSemanticValidation');
const {
  COMPARISON_RELATION_VALIDATION_ENV_KEY,
  COMPARISON_RELATION_REASON,
} = require('../services/keaComparisonSemanticValidation');
const {
  RESPONSE_VALIDATION_ENFORCEMENT_ENV_KEY,
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

const TREND_MATCHED_ELAPSED_FULL_MONTH_COVERAGE = 'COMPLETE';
const TREND_GENERIC_TOTAL_COVERAGE_AMBIGUITY = 'OPEN';
const TREND_RELATIVE_COVERAGE_LANGUAGE_BACKLOG = 'OPEN';
const COMPARISON_METRIC_SCOPE_RESIDUAL = 'OPEN';
const COMPARISON_PERIOD_INTERPRETATION_BACKLOG = 'OPEN';
const COMPARISON_RELATIVE_PERIOD_BACKLOG = 'OPEN';
const SNAPSHOT_NEGATIVE_MINIMUM_COVERAGE_RESIDUAL = 'OPEN';
const LOOKUP_MERCHANT_PERIOD_BACKLOG = 'OPEN';
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

function withCoverage(value, fn) {
  return withFlag(TREND_COVERAGE_VALIDATION_ENV_KEY, value, fn);
}

function codes(result) {
  return (result.violations || []).map((v) => v.code);
}

function hasCode(result, code) {
  return codes(result).indexOf(code) !== -1;
}

function coverageHit(result) {
  return (result.violations || []).some((v) => v.code === VIOLATION_CODE.TREND_COVERAGE_MISMATCH
    && v.reasonCode === TREND_COVERAGE_REASON.MATCHED_ELAPSED_AS_FULL_MONTH
    && v.severity === SEVERITY.HIGH);
}

function coverageIds(result) {
  return (result.violations || [])
    .filter((v) => v.code === VIOLATION_CODE.TREND_COVERAGE_MISMATCH)
    .map((v) => v.extractedClaimId);
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

function matchedElapsedLedger() {
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

function frozenTrendLedger() {
  return buildTrendEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_trend'],
      facts: {
        accountScope: 'selected_account',
        windowKind: 'matched_elapsed',
        metricScope: 'spending',
        periods: [
          { label: 'June 1–23, 2026', start: '2026-06-01', end: '2026-06-23', spending: 12815.73 },
          { label: 'July 1–23, 2026', start: '2026-07-01', end: '2026-07-23', spending: 11784.96 },
          { label: 'August 1–23, 2026', start: '2026-08-01', end: '2026-08-23', spending: 10380.54 },
        ],
        trend: {
          spending: {
            direction: 'decreasing',
            firstToLast: { absolute: -2435.19, percent: -19, baselineZero: false },
          },
        },
      },
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function fullMonthsLedger() {
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

function sameCentsLedger() {
  return buildTrendEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_trend'],
      facts: {
        accountScope: 'selected_account',
        windowKind: 'matched_elapsed',
        metricScope: 'spending',
        periods: [
          { label: 'June 1–27, 2026', start: '2026-06-01', end: '2026-06-27', spending: 100 },
          { label: 'July 1–27, 2026', start: '2026-07-01', end: '2026-07-27', spending: 100 },
        ],
        trend: {
          spending: {
            direction: 'stable',
            firstToLast: { absolute: 0, percent: 0, baselineZero: false },
          },
        },
      },
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
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
          label: 'June 2026',
          start: '2026-06-01',
          end: '2026-06-30',
          income: 0,
          spending: 15010.46,
          net: -15010.46,
        },
        periodB: {
          label: 'July 2026',
          start: '2026-07-01',
          end: '2026-07-31',
          income: 0,
          spending: 12916.99,
          net: -12916.99,
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

function enforcementOf(validation, extra) {
  return evaluateResponseEnforcement(Object.assign({
    flagEnabled: true,
    capability: 'cashflow_trend',
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
  }, extra || {}));
}

function amountId(text, value) {
  const rows = extractResponseClaims(text);
  const hit = rows.find((row) => row.normalizedValue === value);
  return hit ? hit.id : null;
}

const MULTI_VALID = [
  'June 1–27 spending was $13556.82.',
  'July 1–27 spending was $12542.34.',
  'August 1–27 spending was $11697.64.',
  'Spending decreased by $1859.18, or 13.71%.',
].join('\n');

const MULTI_ALL_FULL = [
  "June's full-month spending was $13556.82.",
  "July's full-month spending was $12542.34.",
  "August's full-month spending was $11697.64.",
].join('\n');

async function run() {
  section('3C.4 Slice 5 flag defaults');
  withCoverage(undefined, () => {
    check('unset defaults OFF', isTrendCoverageValidationEnabled() === false);
  });
  withCoverage('', () => {
    check('empty defaults OFF', isTrendCoverageValidationEnabled() === false);
  });
  withCoverage('false', () => {
    check('false OFF', isTrendCoverageValidationEnabled() === false);
  });
  withCoverage('true', () => {
    check('true ON', isTrendCoverageValidationEnabled() === true);
  });
  check('flag name', TREND_COVERAGE_VALIDATION_ENV_KEY === 'USE_TREND_COVERAGE_VALIDATION_SHADOW');
  check('violation enum', VIOLATION_CODE.TREND_COVERAGE_MISMATCH === 'TREND_COVERAGE_MISMATCH');
  check('reason enum', TREND_COVERAGE_REASON.MATCHED_ELAPSED_AS_FULL_MONTH === 'matched_elapsed_as_full_month');

  const matched = matchedElapsedLedger();
  const frozen = frozenTrendLedger();
  const fullMonths = fullMonthsLedger();
  const sameCents = sameCentsLedger();
  check('windowKind matched_elapsed', contractOf(matched).scope.windowKind === 'matched_elapsed');
  check('windowKind full_months', contractOf(fullMonths).scope.windowKind === 'full_months');

  section('3C.4 Slice 5 flag OFF preserves pre-Slice-5 behavior');
  withCoverage('false', () => {
    check('OFF generic June VALID', validate(matched, 'June spending was $13556.82.').status === VALIDATION_STATUS.VALID);
    check('OFF June 1–27 VALID', validate(matched, 'June 1–27 spending was $13556.82.').status === VALIDATION_STATUS.VALID);
    check('OFF full-month still VALID', validate(matched, "June's full-month spending was $13556.82.").status === VALIDATION_STATUS.VALID);
    check('OFF monthly still VALID', validate(matched, 'June monthly spending was $13556.82.').status === VALIDATION_STATUS.VALID);
    check('OFF all of June still VALID', validate(matched, 'Total spending for all of June was $13556.82.').status === VALIDATION_STATUS.VALID);
    check('OFF no coverage code', !hasCode(
      validate(matched, "June's full-month spending was $13556.82."),
      VIOLATION_CODE.TREND_COVERAGE_MISMATCH
    ));
  });
  withCoverage(undefined, () => {
    check('unset full-month still VALID', validate(matched, "June's full-month spending was $13556.82.").status === VALIDATION_STATUS.VALID);
  });

  withCoverage('true', () => {
    section('3C.4 Slice 5 classifier locality');
    check('full-month phrase', spokenTrendCoverage("June's full-month spending was $13556.82.") === 'full_month');
    check('monthly spending phrase', spokenTrendCoverage('June monthly spending was $13556.82.') === 'full_month');
    check('generic June not full-month', spokenTrendCoverage('June spending was $13556.82.') == null);
    check('June total not full-month', spokenTrendCoverage('June total spending was $13556.82.') == null);
    check('monthly periods not full-month', spokenTrendCoverage('The chart compares monthly periods') == null);

    section('3C.4 Slice 5 matched-elapsed positives');
    check('generic June spending VALID', validate(matched, 'June spending was $13556.82.').status === VALIDATION_STATUS.VALID);
    check('In June VALID', validate(matched, 'In June, spending was $13556.82.').status === VALIDATION_STATUS.VALID);
    check('June 1–27 VALID', validate(matched, 'June 1–27 spending was $13556.82.').status === VALIDATION_STATUS.VALID);
    const through = validate(matched, 'Spending through June 27 was $13556.82.');
    check('through June 27 not coverage mismatch', !hasCode(through, VIOLATION_CODE.TREND_COVERAGE_MISMATCH));
    const fromThrough = validate(matched, 'From June 1 through June 27, spending was $13556.82.');
    check('June 1 through June 27 not coverage mismatch', !hasCode(fromThrough, VIOLATION_CODE.TREND_COVERAGE_MISMATCH));
    check('comparable June period VALID',
      validate(matched, 'For the comparable June period, spending was $13556.82.').status === VALIDATION_STATUS.VALID);
    const multiOk = validate(matched, MULTI_VALID);
    check('multi-period correct VALID', multiOk.status === VALIDATION_STATUS.VALID);
    check('multi-period 0 violations', (multiOk.violations || []).length === 0);
    const sameContract = contractOf(sameCents);
    check('same-cents helper generic June no mismatch', evaluateTrendCoverageIdentity({
      contract: sameContract,
      row: { start: 18, semanticHints: ['period_value'] },
      text: 'June spending was $100.',
    }).mismatch === false);
    check('same-cents helper generic July no mismatch', evaluateTrendCoverageIdentity({
      contract: sameContract,
      row: { start: 18, semanticHints: ['period_value'] },
      text: 'July spending was $100.',
    }).mismatch === false);
    const sameGeneric = validate(sameCents, 'June spending was $100.');
    check('same-cents generic preserves existing list binding',
      hasCode(sameGeneric, VIOLATION_CODE.LIST_ITEM_MISMATCH));
    check('same-cents generic is not coverage mismatch',
      !hasCode(sameGeneric, VIOLATION_CODE.TREND_COVERAGE_MISMATCH));

    section('3C.4 Slice 5 matched-elapsed negatives');
    const juneFull = validate(matched, "June's full-month spending was $13556.82.");
    check('June full-month INVALID', juneFull.status === VALIDATION_STATUS.INVALID);
    check('June full-month coverage', coverageHit(juneFull));
    check('full month of June INVALID', coverageHit(
      validate(matched, 'Spending for the full month of June was $13556.82.')
    ));
    check('all of June INVALID', coverageHit(
      validate(matched, "All of June's spending totaled $13556.82.")
    ));
    check('entire month of June INVALID', coverageHit(
      validate(matched, 'The entire month of June had $13556.82 in spending.')
    ));
    check('monthly spending INVALID', coverageHit(
      validate(matched, 'June monthly spending totaled $13556.82.')
    ));
    check('total for full month INVALID', coverageHit(
      validate(matched, 'The total for the full month of June was $13556.82.')
    ));
    const allFull = validate(matched, MULTI_ALL_FULL);
    check('multi-period all-full-month INVALID', allFull.status === VALIDATION_STATUS.INVALID);
    check('multi-period all-full-month coverage', coverageHit(allFull));
    const julyOnlyText = [
      'June spending was $13556.82.',
      "July's full-month spending was $12542.34.",
      'August spending was $11697.64.',
    ].join('\n');
    const julyOnly = validate(matched, julyOnlyText);
    check('only July full-month INVALID', julyOnly.status === VALIDATION_STATUS.INVALID);
    const julyId = amountId(julyOnlyText, 12542.34);
    const juneId = amountId(julyOnlyText, 13556.82);
    const augId = amountId(julyOnlyText, 11697.64);
    const julyCoverageIds = coverageIds(julyOnly);
    check('only July carries coverage mismatch', julyCoverageIds.length === 1 && julyCoverageIds[0] === julyId);
    check('June not contaminated', julyCoverageIds.indexOf(juneId) === -1);
    check('August not contaminated', julyCoverageIds.indexOf(augId) === -1);
    const contradictory = validate(matched, 'June 1–27 full-month spending was $13556.82.');
    check('correct range + full-month still coverage mismatch', coverageHit(contradictory));
    check('same-cents helper full-month mismatch', evaluateTrendCoverageIdentity({
      contract: sameContract,
      row: { start: 29, semanticHints: ['period_value'] },
      text: 'June full-month spending was $100.',
    }).mismatch === true);
    const sameFull = validate(sameCents, 'June full-month spending was $100.');
    check('same-cents full-month keeps existing list binding',
      hasCode(sameFull, VIOLATION_CODE.LIST_ITEM_MISMATCH));
    check('same-cents full-month is not coverage-only rewrite',
      sameFull.status === VALIDATION_STATUS.INVALID);

    section('3C.4 Slice 5 ambiguous / relative coverage');
    const juneTotal = validate(matched, 'June total spending was $13556.82.');
    check('June total spending remains VALID', juneTotal.status === VALIDATION_STATUS.VALID);
    check('June total not coverage mismatch', !hasCode(juneTotal, VIOLATION_CODE.TREND_COVERAGE_MISMATCH));
    const totalJune = validate(matched, 'Total June spending was $13556.82.');
    check('Total June spending remains VALID', totalJune.status === VALIDATION_STATUS.VALID);
    check('Total June not coverage mismatch', !hasCode(totalJune, VIOLATION_CODE.TREND_COVERAGE_MISMATCH));
    const mtd = validate(matched, 'Month to date spending was $11697.64.');
    check('MTD not coverage mismatch', !hasCode(mtd, VIOLATION_CODE.TREND_COVERAGE_MISMATCH));
    const soFar = validate(matched, 'Spending so far this month was $11697.64.');
    check('so far this month not coverage mismatch', !hasCode(soFar, VIOLATION_CODE.TREND_COVERAGE_MISMATCH));

    section('3C.4 Slice 5 full_months authority control');
    check('full_months full-month wording VALID',
      validate(fullMonths, "June's full-month spending was $18000.").status === VALIDATION_STATUS.VALID);
    check('full_months full month of June VALID',
      validate(fullMonths, 'Spending for the full month of June was $18000.').status === VALIDATION_STATUS.VALID);
    check('full_months monthly wording VALID',
      validate(fullMonths, 'June monthly spending was $18000.').status === VALIDATION_STATUS.VALID);

    section('3C.4 Slice 5 locality');
    check('monthly elsewhere does not contaminate',
      validate(matched, 'The chart compares monthly periods. June 1–27 spending was $13556.82.').status === VALIDATION_STATUS.VALID);
    const oneBadText = "June's full-month spending was $13556.82. July spending was $12542.34.";
    const oneBad = validate(matched, oneBadText);
    check('one bad period overall INVALID', oneBad.status === VALIDATION_STATUS.INVALID);
    const oneBadIds = coverageIds(oneBad);
    check('one bad period only June', oneBadIds.length === 1 && oneBadIds[0] === amountId(
      oneBadText,
      13556.82
    ));
    const summary = validate(matched, [
      'June 1–27 spending was $13556.82.',
      'July 1–27 spending was $12542.34.',
      'August 1–27 spending was $11697.64.',
      'Overall, spending declined over the three-month period.',
    ].join('\n'));
    check('summary trend language VALID', summary.status === VALIDATION_STATUS.VALID);
    const last3 = validate(matched, [
      'Your spending over the last 3 months:',
      'June 1–27 spending was $13556.82.',
      'July 1–27 spending was $12542.34.',
      'August 1–27 spending was $11697.64.',
    ].join('\n'));
    check('last 3 months narration VALID', last3.status === VALIDATION_STATUS.VALID);

    section('3C.4 Slice 5 existing trend regressions');
    check('exact period value VALID', validate(frozen, 'June: $12815.73. July: $11784.96. August: $10380.54.').status === VALIDATION_STATUS.VALID);
    check('exact range VALID', validate(matched, 'June 1–27 spending was $13556.82.').status === VALIDATION_STATUS.VALID);
    const wrongRange = validate(matched, 'From June 1 to June 27, 2026, you spent $12542.34.');
    check('wrong range remains existing invalid', wrongRange.status === VALIDATION_STATUS.INVALID);
    check('wrong range not converted to coverage', !hasCode(wrongRange, VIOLATION_CODE.TREND_COVERAGE_MISMATCH));
    check('exact absolute VALID', validate(matched, 'Spending decreased by $1859.18.').status === VALIDATION_STATUS.VALID);
    const wrongAbs = validate(matched, 'Spending decreased by $1860.18.');
    check('wrong absolute INVALID', wrongAbs.status === VALIDATION_STATUS.INVALID);
    check('exact percentage VALID', validate(matched, 'Spending decreased by 13.71%.').status === VALIDATION_STATUS.VALID);
    const wrongPct = validate(matched, 'Spending decreased by 20%.');
    check('wrong percentage INVALID', wrongPct.status === VALIDATION_STATUS.INVALID);
    check('wrong percent not coverage', !hasCode(wrongPct, VIOLATION_CODE.TREND_COVERAGE_MISMATCH));
    check('correct direction VALID', validate(matched, 'Spending decreased over the last three months.').status === VALIDATION_STATUS.VALID);
    const wrongDir = validate(matched, 'Spending increased over the last three months.');
    check('wrong direction INVALID', wrongDir.status === VALIDATION_STATUS.INVALID);
    check('from/to VALID', validate(matched, 'Spending dropped from June to August.').status === VALIDATION_STATUS.VALID);
    const wrongAmt = validate(matched, 'June 1–27 spending was $99999.');
    check('wrong amount UNSUPPORTED_AMOUNT', hasCode(wrongAmt, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
    check('wrong amount not coverage-only', !hasCode(wrongAmt, VIOLATION_CODE.TREND_COVERAGE_MISMATCH));
    const badCovWrongAmt = validate(matched, "June's full-month spending was $99999.");
    check('bad coverage + wrong value keeps unsupported', hasCode(badCovWrongAmt, VIOLATION_CODE.UNSUPPORTED_AMOUNT));

    section('3C.4 Slice 5 missing windowKind does not invent');
    const noKind = evaluateTrendCoverageIdentity({
      contract: { sourceKind: 'cashflow_trend', capability: 'cashflow_trend', scope: {} },
      row: { start: 0, semanticHints: ['period_value'] },
      text: "June's full-month spending was $13556.82.",
    });
    check('missing windowKind no mismatch', noKind.mismatch === false);

    section('3C.4 Slice 5 Slice 4 regressions');
    const cmp = comparisonLedger();
    withFlag(COMPARISON_RELATION_VALIDATION_ENV_KEY, 'true', () => {
      check('correct A→B VALID',
        validate(cmp, 'Spending decreased from June to July.').status === VALIDATION_STATUS.VALID);
      const reversed = validate(cmp, 'Spending decreased from July to June.');
      check('reversed B→A INVALID', reversed.status === VALIDATION_STATUS.INVALID);
      check('reversed is relation mismatch', hasCode(reversed, VIOLATION_CODE.COMPARISON_RELATION_MISMATCH));
      check('reversed reason', reversed.violations.some((v) => (
        v.code === VIOLATION_CODE.COMPARISON_RELATION_MISMATCH
        && v.reasonCode === COMPARISON_RELATION_REASON.PERIOD_RELATION_REVERSED
      )));
      const relEnf = evaluateResponseEnforcement({
        flagEnabled: true,
        capability: 'cashflow_comparison',
        responseSource: 'azure',
        writeResponseMode: 'none',
        shadow: {
          telemetry: {
            response_validation_performed: true,
            response_validation_status: reversed.status,
            response_validation_contract_status: 'ok',
          },
          validation: reversed,
        },
      });
      check('Slice 4 still shadow-only', relEnf.block === false);
    });

    section('3C.4 Slice 5 Slice 1 regressions');
    check('correct periodA VALID', validate(cmp, 'June spending was $15010.46.').status === VALIDATION_STATUS.VALID);
    check('correct periodB VALID', validate(cmp, 'July spending was $12916.99.').status === VALIDATION_STATUS.VALID);
    check('wrong-month scalar INVALID', validate(cmp, 'July spending was $15010.46.').status === VALIDATION_STATUS.INVALID);
    check('percent exact VALID', validate(cmp, 'Spending decreased by 13.95%.').status === VALIDATION_STATUS.VALID);
    check('absolute exact VALID', validate(cmp, 'Spending decreased by $2093.47.').status === VALIDATION_STATUS.VALID);
    check('direction exact VALID', validate(cmp, 'Spending decreased.').status === VALIDATION_STATUS.VALID);

    section('3C.4 Slice 5 Slice 2 / 3 regressions');
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
          upcomingIncomeTotal: 4100,
          upcoming: [
            { name: 'Mortgage', amount: -2824.83, start: '2026-08-28' },
            { name: 'Daycare', amount: -705, start: '2026-08-22' },
          ],
        });
        check('full-window total VALID',
          validate(cov, 'Upcoming expenses total $5627.40.').status === VALIDATION_STATUS.VALID);
        check('listed preview total INVALID',
          validate(cov, 'These listed upcoming expenses total $5627.40.').status === VALIDATION_STATUS.INVALID);
        check('complete list total INVALID',
          validate(cov, 'The complete list of upcoming expenses totals $5627.40.').status === VALIDATION_STATUS.INVALID);
        check('individual preview item VALID',
          validate(cov, 'The preview includes Mortgage for $2824.83.').status === VALIDATION_STATUS.VALID);
        const summed = validate(cov, 'Mortgage $2824.83 and Daycare $705 total $3529.83.');
        check('no preview summation authorized', summed.status !== VALIDATION_STATUS.VALID);
        check('preview sum is not trend coverage', !hasCode(summed, VIOLATION_CODE.TREND_COVERAGE_MISMATCH));
      });
    });

    section('3C.4 Slice 5 other capability regressions');
    check('frozen live-shaped trend VALID', validate(frozen, 'June: $12815.73. July: $11784.96. August: $10380.54. Spending decreased by $2435.19, or 19%.').status === VALIDATION_STATUS.VALID);
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
    check('Target lookup VALID', validateResponseAgainstContract({
      contract: contractOf(buildLookup()),
      text: 'You spent $279.58 at Target.',
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
    const availStd = snapshotFacts({ availableBalance: 2207.75, currentBalance: 2500 });
    check('available balance standard VALID',
      validate(availStd, 'Your available balance is $2207.75.').status === VALIDATION_STATUS.VALID);
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
    check('forecast existing codes', hasCode(forecastRes, VIOLATION_CODE.UNSUPPORTED_DERIVATION)
      || hasCode(forecastRes, VIOLATION_CODE.UNSUPPORTED_FORECAST)
      || hasCode(forecastRes, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
    check('forecast not trend coverage', !hasCode(forecastRes, VIOLATION_CODE.TREND_COVERAGE_MISMATCH));

    section('3C.4 Slice 5 enforcement isolation');
    const onlyCov = validate(matched, "June's full-month spending was $13556.82.");
    const onlyEnf = enforcementOf(onlyCov);
    check('Slice 5-only not blocked', onlyEnf.block === false);
    check('Slice 5-only not eligible family', onlyEnf.reason === ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY);
    const existingBad = validate(frozen, 'July: $11785.96');
    check('existing wrong amount still blocks', enforcementOf(existingBad).block === true);
    const mixed = validate(matched, "June's full-month spending was $13556.82. Spending increased.");
    check('mixed has coverage', coverageHit(mixed));
    check('mixed has direction', hasCode(mixed, VIOLATION_CODE.UNAUTHORIZED_DIRECTION));
    check('mixed still blocks', enforcementOf(mixed).block === true);
    const forecastShadow = applyShadowResponseValidation({
      text: liveC,
      ledger: forecast,
      capability: 'financial_forecast',
      responseSource: 'azure',
    });
    const forecastBlock = evaluateResponseEnforcement({
      flagEnabled: true,
      capability: 'financial_forecast',
      responseSource: 'azure',
      writeResponseMode: 'none',
      shadow: forecastShadow,
    });
    check('forecast still blocked', forecastBlock.block === true);
    check('one validation pass', forecastShadow.telemetry.response_validation_performed === true);
    const covShadow = applyShadowResponseValidation({
      text: "June's full-month spending was $13556.82.",
      ledger: matched,
      capability: 'cashflow_trend',
      responseSource: 'azure',
    });
    check('coverage shadow invalid',
      covShadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
    check('coverage primary sanitized',
      covShadow.telemetry.response_validation_primary_violation === VIOLATION_CODE.TREND_COVERAGE_MISMATCH);
    check('coverage high', covShadow.telemetry.response_validation_primary_severity === SEVERITY.HIGH);

    section('3C.4 Slice 5 performance');
    const tOk = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) validate(matched, 'June 1–27 spending was $13556.82.');
    const okMs = Number(process.hrtime.bigint() - tOk) / 1e6;
    console.log(`  1000 valid matched-elapsed claims: ${okMs.toFixed(2)}ms total, ${(okMs / 1000).toFixed(3)}ms avg`);

    const tBad = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) validate(matched, "June's full-month spending was $13556.82.");
    const badMs = Number(process.hrtime.bigint() - tBad) / 1e6;
    console.log(`  1000 full-month mismatches: ${badMs.toFixed(2)}ms total, ${(badMs / 1000).toFixed(3)}ms avg`);

    const tMulti = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) validate(matched, MULTI_VALID);
    const multiMs = Number(process.hrtime.bigint() - tMulti) / 1e6;
    console.log(`  1000 multi-period valid responses: ${multiMs.toFixed(2)}ms total, ${(multiMs / 1000).toFixed(3)}ms avg`);

    const tEnf = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) enforcementOf(onlyCov);
    const enfMs = Number(process.hrtime.bigint() - tEnf) / 1e6;
    console.log(`  1000 Slice 5 shadow decisions: ${enfMs.toFixed(2)}ms total, ${(enfMs / 1000).toFixed(3)}ms avg`);
    check('Slice 5 performance measured',
      Number.isFinite(okMs) && Number.isFinite(badMs)
      && Number.isFinite(multiMs) && Number.isFinite(enfMs));
  });

  section('3C.4 Slice 5 rollback / privacy / math');
  const helperSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaTrendSemanticValidation.js'), 'utf8');
  const validatorSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseClaimValidator.js'), 'utf8');
  const enfSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseValidationEnforcement.js'), 'utf8');
  const extractorSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseClaimExtractor.js'), 'utf8');
  check('no logger in helper', !/console\.(log|info|warn|error)|logger\./.test(helperSrc));
  check('no Date arithmetic', helperSrc.indexOf('new Date') === -1
    && helperSrc.indexOf('getDate') === -1
    && helperSrc.indexOf('getMonth') === -1
    && helperSrc.indexOf('daysInMonth') === -1);
  check('no financial reduce/abs', helperSrc.indexOf('.reduce(') === -1
    && helperSrc.indexOf('Math.abs') === -1
    && helperSrc.indexOf('Math.round') === -1);
  check('does not read period spending', helperSrc.indexOf('.spending') === -1);
  check('not in CORE_ENFORCEABLE_CODES',
    !/CORE_ENFORCEABLE_CODES[\s\S]{0,800}TREND_COVERAGE_MISMATCH/.test(enfSrc));
  check('extractor unchanged for coverage', extractorSrc.indexOf('full_month') === -1
    && extractorSrc.indexOf('period_coverage') === -1);
  check('validator does not derive direction from values',
    !/periodB.*<.*periodA|if \(.*spending.*<.*spending/.test(validatorSrc));
  check('backlog complete', TREND_MATCHED_ELAPSED_FULL_MONTH_COVERAGE === 'COMPLETE');
  check('generic total ambiguity open', TREND_GENERIC_TOTAL_COVERAGE_AMBIGUITY === 'OPEN');
  check('relative coverage backlog open', TREND_RELATIVE_COVERAGE_LANGUAGE_BACKLOG === 'OPEN');
  check('comparison residuals open', COMPARISON_METRIC_SCOPE_RESIDUAL === 'OPEN'
    && COMPARISON_PERIOD_INTERPRETATION_BACKLOG === 'OPEN'
    && COMPARISON_RELATIVE_PERIOD_BACKLOG === 'OPEN');
  check('snapshot residual open', SNAPSHOT_NEGATIVE_MINIMUM_COVERAGE_RESIDUAL === 'OPEN');
  check('lookup backlog open', LOOKUP_MERCHANT_PERIOD_BACKLOG === 'OPEN');
  check('income horizon backlog open', INCOME_HORIZON_RICH_NARRATION_INDETERMINATE === 'OPEN');

  withCoverage('false', () => {
    const hits = evaluateTrendCoverageIdentity({
      contract: contractOf(matched),
      row: { start: 0, semanticHints: ['period_value'] },
      text: "June's full-month spending was $13556.82.",
    });
    check('rollback helper no-ops when OFF', hits.mismatch === false);
    check('rollback full-month remains VALID',
      validate(matched, "June's full-month spending was $13556.82.").status === VALIDATION_STATUS.VALID);
    check('rollback preserves existing trend invalid',
      validate(frozen, 'July: $11785.96').status === VALIDATION_STATUS.INVALID);
  });

  withCoverage('true', () => {
    withFlag(RESPONSE_VALIDATION_ENFORCEMENT_ENV_KEY, 'true', () => {
      const shadow = applyShadowResponseValidation({
        text: "June's full-month spending was $13556.82.",
        ledger: matched,
        capability: 'cashflow_trend',
        responseSource: 'azure',
      });
      const raw = JSON.stringify(shadow.telemetry);
      const leaks = ['13556.82', '12542.34', '11697.64', 'June', 'July', 'August', '2026-06-01', 'Checking'];
      const hit = leaks.filter((n) => raw.indexOf(n) !== -1);
      check('privacy no financial/month/date/account', hit.length === 0, hit.join(','));
    });
  });
}

module.exports = {
  run,
  TREND_MATCHED_ELAPSED_FULL_MONTH_COVERAGE,
  TREND_GENERIC_TOTAL_COVERAGE_AMBIGUITY,
  TREND_RELATIVE_COVERAGE_LANGUAGE_BACKLOG,
};
