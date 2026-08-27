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
const { validateResponseAgainstContract } = require('../services/keaResponseClaimValidator');
const {
  COMPARISON_RELATION_VALIDATION_ENV_KEY,
  COMPARISON_RELATION_REASON,
  isComparisonRelationValidationEnabled,
  extractComparisonRelations,
  evaluateComparisonRelationIdentity,
} = require('../services/keaComparisonSemanticValidation');
const {
  SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY,
  SNAPSHOT_COVERAGE_VALIDATION_ENV_KEY,
  SNAPSHOT_SEMANTIC_REASON,
} = require('../services/keaSnapshotSemanticValidation');
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

const COMPARISON_AB_RELATION_IDENTITY_BACKLOG = 'COMPLETE';
const COMPARISON_METRIC_SCOPE_RESIDUAL = 'OPEN';
const COMPARISON_PERIOD_INTERPRETATION_BACKLOG = 'OPEN';
const COMPARISON_RELATIVE_PERIOD_BACKLOG = 'OPEN';

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

function withRelation(value, fn) {
  return withFlag(COMPARISON_RELATION_VALIDATION_ENV_KEY, value, fn);
}

function codes(result) {
  return (result.violations || []).map((v) => v.code);
}

function hasCode(result, code) {
  return codes(result).indexOf(code) !== -1;
}

function relationHit(result, reason) {
  return (result.violations || []).some((v) => v.code === VIOLATION_CODE.COMPARISON_RELATION_MISMATCH
    && (reason == null || v.reasonCode === reason)
    && v.severity === SEVERITY.HIGH);
}

function contractOf(ledger) {
  return buildResponseValidationContract(ledger).contract;
}

function decreaseLedger() {
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

function increaseLedger() {
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
          spending: 12916.99,
          net: -12916.99,
        },
        periodB: {
          label: 'July 2026',
          start: '2026-07-01',
          end: '2026-07-31',
          income: 0,
          spending: 15010.46,
          net: -15010.46,
        },
        changes: {
          income: { absolute: 0, percent: 0, baselineZero: false },
          spending: { absolute: 2093.47, percent: 13.95, direction: 'increased', baselineZero: false },
          net: { absolute: -2093.47, percent: -13.95, direction: 'worsened', baselineZero: false },
        },
      },
      observations: [{ code: 'spending_increased' }, { code: 'net_worsened' }],
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
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

function enforcementOf(validation, extra) {
  return evaluateResponseEnforcement(Object.assign({
    flagEnabled: true,
    capability: 'cashflow_comparison',
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

async function run() {
  section('3C.4 Slice 4 flag defaults');
  withRelation(undefined, () => {
    check('unset defaults OFF', isComparisonRelationValidationEnabled() === false);
  });
  withRelation('', () => {
    check('empty defaults OFF', isComparisonRelationValidationEnabled() === false);
  });
  withRelation('false', () => {
    check('false OFF', isComparisonRelationValidationEnabled() === false);
  });
  withRelation('true', () => {
    check('true ON', isComparisonRelationValidationEnabled() === true);
  });
  check('flag name', COMPARISON_RELATION_VALIDATION_ENV_KEY === 'USE_COMPARISON_RELATION_VALIDATION_SHADOW');
  check('violation enum', VIOLATION_CODE.COMPARISON_RELATION_MISMATCH === 'COMPARISON_RELATION_MISMATCH');
  check('reason enums', COMPARISON_RELATION_REASON.PERIOD_RELATION_REVERSED === 'period_relation_reversed'
    && COMPARISON_RELATION_REASON.BASELINE_TARGET_MISMATCH === 'baseline_target_mismatch'
    && COMPARISON_RELATION_REASON.DIRECTION_RELATION_MISMATCH === 'direction_relation_mismatch');

  const dec = decreaseLedger();
  const inc = increaseLedger();
  const reversed = 'Spending decreased from July to June.';

  section('3C.4 Slice 4 flag OFF preserves pre-Slice-4 behavior');
  withRelation('false', () => {
    check('OFF A→B VALID', validate(dec, 'Spending decreased from June to July.').status === VALIDATION_STATUS.VALID);
    check('OFF B→A still VALID', validate(dec, reversed).status === VALIDATION_STATUS.VALID);
    check('OFF no relation mismatch', !hasCode(validate(dec, reversed), VIOLATION_CODE.COMPARISON_RELATION_MISMATCH));
  });
  withRelation(undefined, () => {
    check('unset B→A still VALID', validate(dec, reversed).status === VALIDATION_STATUS.VALID);
  });

  withRelation('true', () => {
    section('3C.4 Slice 4 extractor relation forms');
    const fromTo = extractComparisonRelations('Spending decreased from June to July.');
    check('from-to extracted', fromTo.length === 1 && fromTo[0].form === 'from_to'
      && fromTo[0].fromPeriod.month === 6 && fromTo[0].toPeriod.month === 7);
    const compared = extractComparisonRelations('July spending decreased compared with June.');
    check('compared-with extracted', compared.length === 1 && compared[0].form === 'compared_with'
      && compared[0].toPeriod.month === 7 && compared[0].fromPeriod.month === 6);
    const comparedTo = extractComparisonRelations('July spending decreased compared to June.');
    check('compared-to extracted', comparedTo.length === 1 && comparedTo[0].toPeriod.month === 7);
    const than = extractComparisonRelations('July spending was 13.95% lower than June.');
    check('lower-than extracted', than.some((r) => r.form === 'than' && r.toPeriod.month === 7
      && r.fromPeriod.month === 6 && r.polarity === 'down'));
    const vs = extractComparisonRelations('June vs July spending differed.');
    check('bare vs not directional', vs.length === 0);
    const relativeOnly = extractComparisonRelations('Spending decreased last month compared with the month before.');
    check('relative months not bound', relativeOnly.length === 0);

    section('3C.4 Slice 4 decrease fixture');
    const aToB = validate(dec, 'Spending decreased from June to July.');
    check('1 A→B decreased VALID', aToB.status === VALIDATION_STATUS.VALID && !relationHit(aToB));
    const absOk = validate(dec, 'Spending decreased by $2093.47 from June to July.');
    check('2 absolute + A→B VALID', absOk.status === VALIDATION_STATUS.VALID);
    const bCmpA = validate(dec, 'July spending decreased compared with June.');
    check('3 B compared with A VALID', bCmpA.status === VALIDATION_STATUS.VALID);
    const bCmpToA = validate(dec, 'July spending decreased compared to June.');
    check('B compared to A VALID', bCmpToA.status === VALIDATION_STATUS.VALID);
    const downPct = validate(dec, 'July spending was down 13.95% compared with June.');
    check('4 down percent compared with A VALID', downPct.status === VALIDATION_STATUS.VALID);
    const liveForm = validate(dec, 'Your spending decreased by 13.95% in July 2026 compared to June 2026.');
    check('live July compared to June VALID', liveForm.status === VALIDATION_STATUS.VALID
      && (liveForm.violations || []).length === 0);

    const bToA = validate(dec, reversed);
    check('5 B→A decreased INVALID', bToA.status === VALIDATION_STATUS.INVALID);
    check('5 COMPARISON_RELATION_MISMATCH', hasCode(bToA, VIOLATION_CODE.COMPARISON_RELATION_MISMATCH));
    check('5 period_relation_reversed', relationHit(bToA, COMPARISON_RELATION_REASON.PERIOD_RELATION_REVERSED));
    const absRev = validate(dec, 'Spending decreased by $2093.47 from July to June.');
    check('6 absolute + B→A INVALID', absRev.status === VALIDATION_STATUS.INVALID && relationHit(absRev));
    const aCmpB = validate(dec, 'June spending decreased compared with July.');
    check('7 A compared with B INVALID', aCmpB.status === VALIDATION_STATUS.INVALID && relationHit(aCmpB));
    const aCmpToB = validate(dec, 'June spending decreased compared to July.');
    check('A compared to B INVALID', aCmpToB.status === VALIDATION_STATUS.INVALID && relationHit(aCmpToB));
    const downPctRev = validate(dec, 'June spending was down 13.95% compared with July.');
    check('8 down percent compared with B INVALID', downPctRev.status === VALIDATION_STATUS.INVALID
      && relationHit(downPctRev));
    const lowerOk = validate(dec, 'July spending was 13.95% lower than June.');
    check('E B lower than A VALID', lowerOk.status === VALIDATION_STATUS.VALID);
    const lowerRev = validate(dec, 'June spending was 13.95% lower than July.');
    check('F A lower than B INVALID', lowerRev.status === VALIDATION_STATUS.INVALID && relationHit(lowerRev));
    const dollarLower = validate(dec, 'July spending was $2093.47 lower than June.');
    check('B lower-than absolute not reversed', !relationHit(dollarLower));
    const dollarLowerRev = validate(dec, 'June spending was $2093.47 lower than July.');
    check('A lower-than absolute INVALID', dollarLowerRev.status === VALIDATION_STATUS.INVALID
      && relationHit(dollarLowerRev));

    section('3C.4 Slice 4 increase fixture');
    check('9 A→B increased VALID',
      validate(inc, 'Spending increased from June to July.').status === VALIDATION_STATUS.VALID);
    check('10 B compared with A increased VALID',
      validate(inc, 'July spending increased compared with June.').status === VALIDATION_STATUS.VALID);
    const incRev = validate(inc, 'Spending increased from July to June.');
    check('11 B→A increased INVALID', incRev.status === VALIDATION_STATUS.INVALID && relationHit(incRev));
    const incSubjRev = validate(inc, 'June spending increased compared with July.');
    check('12 A compared with B increased INVALID', incSubjRev.status === VALIDATION_STATUS.INVALID
      && relationHit(incSubjRev));
    check('B higher than A increased VALID',
      validate(inc, 'July spending was 13.95% higher than June.').status === VALIDATION_STATUS.VALID);

    section('3C.4 Slice 4 multi-claim / locality');
    const scalarsOk = validate(dec, [
      'June spending was $15010.46.',
      'July spending was $12916.99.',
      'Spending decreased from June to July by $2093.47, or 13.95%.',
    ].join('\n'));
    check('13 scalars + correct relation VALID', scalarsOk.status === VALIDATION_STATUS.VALID);
    const central = validate(dec, [
      'June spending was $15010.46.',
      'July spending was $12916.99.',
      'Spending decreased from July to June by $2093.47, or 13.95%.',
    ].join('\n'));
    check('14 central reversed relation INVALID', central.status === VALIDATION_STATUS.INVALID);
    check('14 relation mismatch', relationHit(central, COMPARISON_RELATION_REASON.PERIOD_RELATION_REVERSED));
    check('14 scalars not rejected as unsupported amount',
      !hasCode(central, VIOLATION_CODE.UNSUPPORTED_AMOUNT));

    const wrongScalar = validate(dec, 'June spending was $12916.99. Spending decreased from June to July.');
    check('15 correct relation + wrong scalar INVALID', wrongScalar.status === VALIDATION_STATUS.INVALID
      && hasCode(wrongScalar, VIOLATION_CODE.UNSUPPORTED_PERIOD_ATTRIBUTION));
    const wrongPct = validate(dec, 'Spending decreased from June to July by 14%.');
    check('16 correct relation + wrong percent INVALID', wrongPct.status === VALIDATION_STATUS.INVALID
      && hasCode(wrongPct, VIOLATION_CODE.UNSUPPORTED_COMPARISON));
    const wrongDirRev = validate(dec, 'Spending increased from July to June.');
    check('17 reversed + wrong direction has direction',
      hasCode(wrongDirRev, VIOLATION_CODE.UNAUTHORIZED_DIRECTION));
    check('17 reversed + wrong direction has relation', relationHit(wrongDirRev));
    const missingRel = validate(dec, 'Spending decreased by 13.95%.');
    check('18 missing explicit relation stays VALID', missingRel.status === VALIDATION_STATUS.VALID);
    const symmetric = validate(dec, 'June and July spending differed by $2093.47.');
    check('19 symmetric differed-by stays VALID', symmetric.status === VALIDATION_STATUS.VALID);
    const twoOk = validate(dec, [
      'Spending decreased from June to July.',
      'July spending decreased compared with June.',
    ].join('\n'));
    check('20 two correct relations VALID', twoOk.status === VALIDATION_STATUS.VALID);
    const mixedRel = validate(dec, [
      'Spending decreased from June to July.',
      'June spending decreased compared with July.',
    ].join('\n'));
    check('21 one reversed relation INVALID', mixedRel.status === VALIDATION_STATUS.INVALID && relationHit(mixedRel));
    const clauseOk = validate(dec, [
      'June spending was $15010.46. July spending was $12916.99.',
      'Compared with June, July spending decreased.',
    ].join('\n'));
    check('22 compared-with comma VALID', clauseOk.status === VALIDATION_STATUS.VALID);
    const clauseBad = validate(dec, [
      'June spending was $15010.46. July spending was $12916.99.',
      'Compared with July, June spending decreased.',
    ].join('\n'));
    check('23 compared-with comma reversed INVALID', clauseBad.status === VALIDATION_STATUS.INVALID
      && relationHit(clauseBad));
    const noGlobal = validate(dec, 'June spending was $15010.46. July spending was $12916.99. Spending decreased.');
    check('72 no global month-token contamination', noGlobal.status === VALIDATION_STATUS.VALID);
    const relativeBacklog = validate(dec, 'Spending decreased last month compared with the month before.');
    check('relative-period backlog remains VALID', relativeBacklog.status === VALIDATION_STATUS.VALID);
    const unknownAmt = validate(dec, 'Spending decreased from July to June by $99999.');
    check('wrong value still unsupported amount', hasCode(unknownAmt, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
    check('wrong value does not hide relation', relationHit(unknownAmt));

    section('3C.4 Slice 4 Slice 1 regressions');
    check('periodA scalar VALID',
      validate(dec, 'In June 2026, spending was $15010.46.').status === VALIDATION_STATUS.VALID);
    check('periodB scalar VALID',
      validate(dec, 'In July 2026, spending was $12916.99.').status === VALIDATION_STATUS.VALID);
    const cross = validate(dec, 'In July 2026, spending was $15010.46.');
    check('wrong period scalar INVALID', cross.status === VALIDATION_STATUS.INVALID
      && hasCode(cross, VIOLATION_CODE.UNSUPPORTED_PERIOD_ATTRIBUTION));
    check('exact percent VALID', validate(dec, 'Spending decreased 13.95%.').status === VALIDATION_STATUS.VALID);
    check('wrong percent INVALID', validate(dec, 'Spending decreased 14%.').status === VALIDATION_STATUS.INVALID
      && hasCode(validate(dec, 'Spending decreased 14%.'), VIOLATION_CODE.UNSUPPORTED_COMPARISON));
    check('exact absolute VALID',
      validate(dec, 'Spending decreased by $2093.47.').status === VALIDATION_STATUS.VALID);
    check('wrong absolute INVALID',
      validate(dec, 'Spending decreased by $2094.47.').status === VALIDATION_STATUS.INVALID);
    check('correct direction VALID', validate(dec, 'Spending decreased.').status === VALIDATION_STATUS.VALID);
    check('wrong direction INVALID', validate(dec, 'Spending increased.').status === VALIDATION_STATUS.INVALID
      && hasCode(validate(dec, 'Spending increased.'), VIOLATION_CODE.UNAUTHORIZED_DIRECTION));

    section('3C.4 Slice 4 Slice 2 / 3 regressions');
    withFlag(SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY, 'true', () => {
      withFlag(SNAPSHOT_COVERAGE_VALIDATION_ENV_KEY, 'true', () => {
        const roles = snapshotFacts({
          availableBalance: 100,
          currentBalance: 200,
          reconciledBalance: 300,
          upcomingExpenseTotal: 600,
          upcomingIncomeTotal: 700,
          futureNegativeBalances: [{ amount: -80, date: '2026-11-08', daysUntil: 84 }],
        });
        check('available balance VALID',
          validate(roles, 'Your available balance is $100.').status === VALIDATION_STATUS.VALID);
        check('available narration FP sentence VALID', validate(roles, [
          'Your available balance is $100.',
          'This is the amount currently accessible for spending or withdrawal.',
        ].join(' ')).status === VALIDATION_STATUS.VALID);
        check('wrong balance role INVALID',
          validate(roles, 'Your available balance is $300.').status === VALIDATION_STATUS.INVALID);
        const snap = buildSnapshot();
        check('15-day horizon INVALID', validateResponseAgainstContract({
          contract: contractOf(snap),
          text: 'September expenses will total $1134.56.',
        }).status === VALIDATION_STATUS.INVALID);
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
        check('preview shows total INVALID',
          validate(cov, 'The preview shows a total of $5627.40.').status === VALIDATION_STATUS.INVALID);
        check('individual preview item VALID',
          validate(cov, 'The preview includes Mortgage for $2824.83.').status === VALIDATION_STATUS.VALID);
        const summed = validate(cov, 'Mortgage $2824.83 and Daycare $705 total $3529.83.');
        check('no preview summation authorized', summed.status !== VALIDATION_STATUS.VALID);
        check('preview sum is not relation mismatch',
          !hasCode(summed, VIOLATION_CODE.COMPARISON_RELATION_MISMATCH));
      });
    });

    section('3C.4 Slice 4 other capability regressions');
    const trend = buildTrendEvidenceLedger({
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
    check('trend VALID', validate(trend, 'June: $12815.73. July: $11784.96. August: $10380.54. Spending decreased by $2435.19, or 19%.').status === VALIDATION_STATUS.VALID);
    check('trend from-to not comparison-relation', !hasCode(
      validate(trend, 'Spending dropped from June to August.'),
      VIOLATION_CODE.COMPARISON_RELATION_MISMATCH
    ));

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
    check('recurring VALID',
      validate(recurring, 'Netflix is $15.99.').status === VALIDATION_STATUS.VALID);

    const upcomingC = contractOf(buildUpcomingMacro());
    check('upcoming VALID', validateResponseAgainstContract({
      contract: upcomingC,
      text: 'Total scheduled expenses are $1297.30.',
    }).status === VALIDATION_STATUS.VALID);

    const lookupC = contractOf(buildLookup());
    check('Target lookup VALID', validateResponseAgainstContract({
      contract: lookupC,
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
    check('forecast not relation mismatch', !hasCode(forecastRes, VIOLATION_CODE.COMPARISON_RELATION_MISMATCH));

    section('3C.4 Slice 4 enforcement isolation');
    const onlyRel = validate(dec, reversed);
    const onlyEnf = enforcementOf(onlyRel);
    check('Slice 4-only not blocked', onlyEnf.block === false);
    check('Slice 4-only not eligible family', onlyEnf.reason === ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY);
    const dirBad = validate(dec, 'Spending increased by $2093.47.');
    const dirEnf = enforcementOf(dirBad);
    check('existing wrong-direction still blocks', dirEnf.block === true);
    const mixedEnf = enforcementOf(wrongDirRev);
    check('mixed relation+direction still blocks', mixedEnf.block === true);
    check('mixed still has direction', hasCode(wrongDirRev, VIOLATION_CODE.UNAUTHORIZED_DIRECTION));
    const pctEnf = enforcementOf(wrongPct);
    check('existing wrong-percent still blocks', pctEnf.block === true);

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
    check('shadow status invalid',
      forecastShadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);

    const relShadow = applyShadowResponseValidation({
      text: reversed,
      ledger: dec,
      capability: 'cashflow_comparison',
      responseSource: 'azure',
    });
    check('relation shadow invalid',
      relShadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
    check('relation primary sanitized',
      relShadow.telemetry.response_validation_primary_violation === VIOLATION_CODE.COMPARISON_RELATION_MISMATCH);
    check('relation high', relShadow.telemetry.response_validation_primary_severity === SEVERITY.HIGH);

    section('3C.4 Slice 4 performance');
    const tOk = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) validate(dec, 'Spending decreased from June to July.');
    const okMs = Number(process.hrtime.bigint() - tOk) / 1e6;
    console.log(`  1000 valid A→B relations: ${okMs.toFixed(2)}ms total, ${(okMs / 1000).toFixed(3)}ms avg`);

    const tRev = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) validate(dec, reversed);
    const revMs = Number(process.hrtime.bigint() - tRev) / 1e6;
    console.log(`  1000 reversed B→A relations: ${revMs.toFixed(2)}ms total, ${(revMs / 1000).toFixed(3)}ms avg`);

    const tScalar = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) {
      validate(dec, [
        'June spending was $15010.46.',
        'July spending was $12916.99.',
        'Spending decreased from June to July by $2093.47, or 13.95%.',
      ].join('\n'));
    }
    const scalarMs = Number(process.hrtime.bigint() - tScalar) / 1e6;
    console.log(`  1000 scalar + valid relation: ${scalarMs.toFixed(2)}ms total, ${(scalarMs / 1000).toFixed(3)}ms avg`);

    const tEnf = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) enforcementOf(onlyRel);
    const enfMs = Number(process.hrtime.bigint() - tEnf) / 1e6;
    console.log(`  1000 Slice 4 shadow decisions: ${enfMs.toFixed(2)}ms total, ${(enfMs / 1000).toFixed(3)}ms avg`);
    check('Slice 4 performance measured',
      Number.isFinite(okMs) && Number.isFinite(revMs)
      && Number.isFinite(scalarMs) && Number.isFinite(enfMs));
  });

  section('3C.4 Slice 4 rollback / privacy / math');
  const helperSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaComparisonSemanticValidation.js'), 'utf8');
  const validatorSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseClaimValidator.js'), 'utf8');
  const enfSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseValidationEnforcement.js'), 'utf8');
  check('no logger in helper', !/console\.(log|info|warn|error)|logger\./.test(helperSrc));
  check('no financial reduce/abs in helper', helperSrc.indexOf('.reduce(') === -1
    && helperSrc.indexOf('Math.abs') === -1);
  check('does not compare period values', helperSrc.indexOf('periodA.spending') === -1
    && helperSrc.indexOf('periodB.spending') === -1);
  check('not in CORE_ENFORCEABLE_CODES',
    !/CORE_ENFORCEABLE_CODES[\s\S]{0,500}COMPARISON_RELATION_MISMATCH/.test(enfSrc));
  check('not in COMPARISON_ENFORCED_FAMILIES', enfSrc.indexOf('relation') === -1
    || /COMPARISON_ENFORCED_FAMILIES = Object\.freeze\(\['percent', 'absolute', 'direction'\]\)/.test(enfSrc));
  check('validator does not derive direction from values',
    !/periodB.*<.*periodA|if \(.*spending.*<.*spending/.test(validatorSrc));
  check('backlog complete', COMPARISON_AB_RELATION_IDENTITY_BACKLOG === 'COMPLETE');
  check('metric scope residual open', COMPARISON_METRIC_SCOPE_RESIDUAL === 'OPEN');
  check('period interpretation backlog open', COMPARISON_PERIOD_INTERPRETATION_BACKLOG === 'OPEN');
  check('relative period backlog open', COMPARISON_RELATIVE_PERIOD_BACKLOG === 'OPEN');

  withRelation('false', () => {
    const hits = evaluateComparisonRelationIdentity({
      contract: contractOf(dec),
      text: reversed,
    });
    check('rollback helper no-ops when OFF', hits.length === 0);
    check('rollback reversed remains VALID', validate(dec, reversed).status === VALIDATION_STATUS.VALID);
  });
}

module.exports = {
  run,
  COMPARISON_AB_RELATION_IDENTITY_BACKLOG,
  COMPARISON_METRIC_SCOPE_RESIDUAL,
  COMPARISON_PERIOD_INTERPRETATION_BACKLOG,
  COMPARISON_RELATIVE_PERIOD_BACKLOG,
};
