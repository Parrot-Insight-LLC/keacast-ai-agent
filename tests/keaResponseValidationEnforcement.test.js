'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');
const { createKeaTelemetry } = require('../services/keaTelemetry');
const {
  buildRecurringEvidenceLedger,
  buildComparisonEvidenceLedger,
  buildTrendEvidenceLedger,
  buildIncomeHorizonEvidenceLedger,
  buildAffordabilityEvidenceLedger,
} = require('../services/keaEvidenceLedgerBuilders');
const { VIOLATION_CODE, SEVERITY } = require('../services/keaResponseValidationContract');
const {
  applyShadowResponseValidation,
  RESPONSE_VALIDATION_STATUS,
  RESPONSE_VALIDATION_CONTRACT_STATUS,
} = require('../services/keaResponseValidationShadow');
const {
  RESPONSE_VALIDATION_ENFORCEMENT_ENV_KEY,
  RESPONSE_VALIDATION_FALLBACK,
  ENFORCEABLE_CAPABILITIES,
  EXCLUDED_CAPABILITIES,
  ENFORCEMENT_REASON,
  isResponseValidationEnforcementEnabled,
  sanitizeResponseEnforcementTelemetry,
  applyResponseValidationEnforcement,
  evaluateResponseEnforcement,
  comparisonClaimFamily,
} = require('../services/keaResponseValidationEnforcement');
const {
  buildLookup,
  buildSnapshot,
  buildUpcomingMacro,
} = require('./keaResponseValidationContract.test');
const { buildLiveEMacro, LIVE_E_TEXT } = require('./keaResponseClaimValidator.test');

const LIVE_C_TEXT = [
  'Your projected income for next month (September 2026) is $4626.36.',
  'Your projected expenses for next month are $3432.43.',
  'This results in a net positive cash flow of $1193.93.',
  'Your available balance is forecasted to be approximately $4846.97.',
  'Your balance is expected to increase by about $1194.',
].join(' ');

const CMP_VALID = 'Your spending decreased by 13.95% in July 2026 compared to June 2026.';
const CMP_WRONG_DIR = 'Your spending increased by 13.95% in July 2026 compared to June 2026.';
const CMP_14 = 'Spending decreased by 14%.';
const CMP_NEARLY_14 = 'Spending decreased by nearly 14%.';
const CMP_DELTA = 'Spending decreased by $2093.47.';
const CMP_WRONG_DELTA = 'Spending decreased by $2094.47.';
const CMP_PERIOD_SCALAR = 'In July, spending was $15010.46.';
const TREND_VALID = 'June: $12815.73. July: $11784.96. August: $10380.54.';
const TREND_WRONG_AMT = 'July: $11785.96';
const TREND_CROSS = 'July: $12815.73';
const RECURRING_VALID = 'Rent is $1400 monthly, next due 2026-09-01. Netflix is $15.99.';
const RECURRING_INVALID = 'Rent is $1401 monthly.';
const TARGET_VALID = 'In July 2026, you made 3 transactions at Target totaling $279.58.';
const TARGET_INVALID = 'You spent $280 at Target.';
const BALANCE_VALID = 'Your available balance is $4846.97.';
const BALANCE_INVALID = 'Your available balance is $5000.';
const HORIZON_VALID = 'Your next scheduled income is $4626.36 on 2026-08-31.';
const INDETERMINATE_TEXT = 'The code is 279.58.';

const LEAK_NEEDLES = [
  '$',
  '279.58',
  '13.95',
  '2093.47',
  '15010.46',
  '4626.36',
  '4846.97',
  'Target',
  'Daycare',
  'Main Account',
  'July 2026',
  'extractedClaimId',
  'evidenceClaimId',
  'itemId',
  'allowedClaims',
];

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

function withEnforcement(value, fn) {
  return withFlag(RESPONSE_VALIDATION_ENFORCEMENT_ENV_KEY, value, fn);
}

function buildComparisonJuneJuly() {
  return buildComparisonEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_period_comparison'],
      facts: {
        accountScope: 'selected_account',
        windowKind: 'matched_elapsed',
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
        highest: { metric: 'spending', label: 'June 1–23, 2026', value: 12815.73 },
        lowest: { metric: 'spending', label: 'August 1–23, 2026', value: 10380.54 },
      },
      limitations: [],
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
        totals: { recurringExpenseMonthlyEquivalent: 1415.99 },
      },
      observations: [],
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function buildHorizonCore() {
  return buildIncomeHorizonEvidenceLedger({
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
}

function buildHorizonBillsBeforePayday() {
  return buildIncomeHorizonEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_income_horizon'],
      facts: {
        incomeHorizonDefinition: 'kea_scheduled_recurring_income',
        nextIncome: [{ label: 'Direct Deposit', date: '2026-08-31', amount: 4626.36 }],
        expensesBeforeIncome: {
          count: 1,
          total: 100,
          items: [{ label: 'Rent', date: '2026-08-20', amount: 100 }],
        },
      },
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
        hypothetical: { projectedOnDate: 2247, projectedOnDateAt: '2026-08-21' },
        delta: { newNegativeIntroduced: false },
      },
      assumptions: [{ code: 'one_time_expense' }],
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function enforceTurn(text, opts = {}) {
  const ledger = opts.ledger;
  const capability = opts.capability;
  const extractCalls = { n: 0 };
  const validateCalls = { n: 0 };
  const deps = {
    extractClaims: (src) => {
      extractCalls.n += 1;
      const { extractResponseClaims } = require('../services/keaResponseClaimExtractor');
      return extractResponseClaims(src);
    },
    validateClaims: (input) => {
      validateCalls.n += 1;
      const { validateResponseClaims } = require('../services/keaResponseClaimValidator');
      return validateResponseClaims(input);
    },
  };
  if (opts.throwExtractor) {
    deps.extractClaims = () => { throw new Error('extractor boom'); };
  }
  const shadow = applyShadowResponseValidation({
    text,
    ledger,
    capability,
    responseSource: opts.responseSource || 'azure',
    responseMode: opts.responseMode,
    writeResponseMode: opts.writeResponseMode || 'none',
    simulationMode: opts.simulationMode === true,
    invitationWriteHandoff: opts.invitationWriteHandoff === true,
    repeatWriteHandoff: opts.repeatWriteHandoff === true,
  }, deps);
  const enforced = applyResponseValidationEnforcement({
    originalText: text,
    shadow,
    capability,
    sourceKind: ledger && ledger.source && ledger.source.kind,
    responseMode: opts.responseMode,
    responseSource: opts.responseSource || 'azure',
    writeResponseMode: opts.writeResponseMode || 'none',
    simulationMode: opts.simulationMode === true,
    invitationWriteHandoff: opts.invitationWriteHandoff === true,
    ledger,
    flagEnabled: opts.flagEnabled,
  });
  return {
    shadow,
    enforced,
    extractCalls: extractCalls.n,
    validateCalls: validateCalls.n,
    persisted: [{ role: 'assistant', content: enforced.finalText }],
  };
}

function leakHits(obj) {
  const raw = JSON.stringify(obj);
  return LEAK_NEEDLES.filter((n) => raw.indexOf(n) !== -1);
}

async function run() {
  section('3C.3 flag parsing');
  withEnforcement(undefined, () => {
    check('unset defaults OFF', isResponseValidationEnforcementEnabled() === false);
  });
  withEnforcement('', () => {
    check('empty defaults OFF', isResponseValidationEnforcementEnabled() === false);
  });
  withEnforcement('true', () => {
    check('true ON', isResponseValidationEnforcementEnabled() === true);
  });
  withEnforcement('false', () => {
    check('false OFF', isResponseValidationEnforcementEnabled() === false);
  });
  check('flag name', RESPONSE_VALIDATION_ENFORCEMENT_ENV_KEY === 'USE_RESPONSE_VALIDATION_ENFORCEMENT');
  check('fallback has no dollars', RESPONSE_VALIDATION_FALLBACK.indexOf('$') === -1);
  check('fallback has no validator internals',
    RESPONSE_VALIDATION_FALLBACK.indexOf('UNSUPPORTED') === -1
    && RESPONSE_VALIDATION_FALLBACK.indexOf('Ledger') === -1
    && RESPONSE_VALIDATION_FALLBACK.indexOf('validator') === -1);
  check('trend is enforceable', ENFORCEABLE_CAPABILITIES.indexOf('cashflow_trend') !== -1);
  check('affordability excluded', EXCLUDED_CAPABILITIES.indexOf('affordability_or_planning') !== -1);
  check('cashflow_analysis excluded', EXCLUDED_CAPABILITIES.indexOf('cashflow_analysis') !== -1);

  const comparisonLedger = buildComparisonJuneJuly();
  const trendLedger = buildTrend();
  const recurringLedger = buildRecurring();
  const upcomingLedger = buildUpcomingMacro();
  const liveELedger = buildLiveEMacro();
  const lookupLedger = buildLookup();
  const snapshotLedger = buildSnapshot();
  const horizonLedger = buildHorizonCore();
  const affordLedger = buildAffordability();

  withEnforcement('true', () => {
    section('3C.3 A valid trend');
    const a = enforceTurn(TREND_VALID, { ledger: trendLedger, capability: 'cashflow_trend' });
    check('A eligible', a.enforced.decision.eligible === true);
    check('A not blocked', a.enforced.decision.block === false);
    check('A original returned', a.enforced.finalText === TREND_VALID);
    check('A validation valid', a.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.VALID);

    section('3C.3 B invalid trend amount');
    const b = enforceTurn(TREND_WRONG_AMT, { ledger: trendLedger, capability: 'cashflow_trend' });
    check('B validation invalid', a.shadow && b.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
    check('B eligible', b.enforced.decision.eligible === true);
    check('B blocked', b.enforced.decision.block === true);
    check('B fallback returned', b.enforced.finalText === RESPONSE_VALIDATION_FALLBACK);
    check('B original not persisted', b.persisted[0].content !== TREND_WRONG_AMT
      && b.persisted[0].content === RESPONSE_VALIDATION_FALLBACK);

    section('3C.3 C wrong trend period item');
    const c = enforceTurn(TREND_CROSS, { ledger: trendLedger, capability: 'cashflow_trend' });
    check('C invalid', c.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
    check('C high or critical',
      c.shadow.telemetry.response_validation_primary_severity === SEVERITY.HIGH
      || c.shadow.telemetry.response_validation_primary_severity === SEVERITY.CRITICAL);
    check('C blocked', c.enforced.decision.block === true);
    check('C LIST_ITEM_MISMATCH',
      c.shadow.telemetry.response_validation_primary_violation === VIOLATION_CODE.LIST_ITEM_MISMATCH
      || (c.shadow.validation.violations || []).some((v) => v.code === VIOLATION_CODE.LIST_ITEM_MISMATCH));

    section('3C.3 D valid recurring');
    const d = enforceTurn(RECURRING_VALID, { ledger: recurringLedger, capability: 'cashflow_recurring' });
    check('D valid unchanged', d.enforced.finalText === RECURRING_VALID && d.enforced.decision.block === false);

    section('3C.3 E invalid recurring item');
    const e = enforceTurn(RECURRING_INVALID, { ledger: recurringLedger, capability: 'cashflow_recurring' });
    check('E blocked', e.enforced.decision.block === true && e.enforced.finalText === RESPONSE_VALIDATION_FALLBACK);

    section('3C.3 F valid upcoming');
    const f = enforceTurn('Bills due next week total $1297.30.', {
      ledger: upcomingLedger,
      capability: 'cashflow_upcoming',
    });
    check('F unchanged', f.enforced.decision.block === false && f.enforced.finalText.indexOf('1297.30') !== -1);

    section('3C.3 G invalid upcoming');
    const g = enforceTurn('Mira Pest Control: $80.99 on August 23', {
      ledger: liveELedger,
      capability: 'cashflow_upcoming',
    });
    check('G invalid', g.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
    check('G high or critical',
      g.shadow.telemetry.response_validation_primary_severity === SEVERITY.HIGH
      || g.shadow.telemetry.response_validation_primary_severity === SEVERITY.CRITICAL);
    check('G blocked', g.enforced.decision.block === true);
    const gOk = enforceTurn(LIVE_E_TEXT, { ledger: liveELedger, capability: 'cashflow_upcoming' });
    check('G live-E valid not blocked', gOk.enforced.decision.block === false && gOk.enforced.finalText === LIVE_E_TEXT);

    section('3C.3 H valid Target lookup');
    const h = enforceTurn(TARGET_VALID, { ledger: lookupLedger, capability: 'financial_lookup' });
    check('H unchanged', h.enforced.finalText === TARGET_VALID && h.enforced.decision.block === false);

    section('3C.3 I invalid Target lookup');
    const i = enforceTurn(TARGET_INVALID, { ledger: lookupLedger, capability: 'financial_lookup' });
    check('I blocked', i.enforced.decision.block === true && i.enforced.finalText === RESPONSE_VALIDATION_FALLBACK);

    section('3C.3 J valid balance');
    const j = enforceTurn(BALANCE_VALID, { ledger: snapshotLedger, capability: 'financial_forecast' });
    check('J unchanged', j.enforced.finalText === BALANCE_VALID && j.enforced.decision.block === false);

    section('3C.3 K invalid balance amount');
    const k = enforceTurn(BALANCE_INVALID, { ledger: snapshotLedger, capability: 'financial_lookup' });
    check('K blocked', k.enforced.decision.block === true);

    section('3C.3 L forecast unsupported derivation');
    const l = enforceTurn(LIVE_C_TEXT, { ledger: snapshotLedger, capability: 'financial_forecast' });
    check('L invalid', l.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
    check('L critical or high',
      l.shadow.telemetry.response_validation_primary_severity === SEVERITY.CRITICAL
      || l.shadow.telemetry.response_validation_primary_severity === SEVERITY.HIGH);
    check('L blocked', l.enforced.decision.block === true);
    check('L fallback', l.enforced.finalText === RESPONSE_VALIDATION_FALLBACK);
    check('L azure prose hidden', l.enforced.finalText.indexOf('1193.93') === -1
      && l.enforced.finalText.indexOf('next month') === -1);

    section('3C.3 M comparison valid');
    const m = enforceTurn(CMP_VALID, { ledger: comparisonLedger, capability: 'cashflow_comparison' });
    check('M valid', m.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.VALID);
    check('M unchanged', m.enforced.finalText === CMP_VALID && m.enforced.decision.block === false);

    section('3C.3 N comparison 14%');
    const n = enforceTurn(CMP_14, { ledger: comparisonLedger, capability: 'cashflow_comparison' });
    check('N invalid comparison', n.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
    check('N UNSUPPORTED_COMPARISON',
      n.shadow.telemetry.response_validation_primary_violation === VIOLATION_CODE.UNSUPPORTED_COMPARISON
      || (n.shadow.validation.violations || []).some((v) => v.code === VIOLATION_CODE.UNSUPPORTED_COMPARISON));
    check('N blocked', n.enforced.decision.block === true);
    const nNear = enforceTurn(CMP_NEARLY_14, { ledger: comparisonLedger, capability: 'cashflow_comparison' });
    check('N nearly 14 blocked', nNear.enforced.decision.block === true);

    section('3C.3 O comparison wrong direction');
    const o = enforceTurn(CMP_WRONG_DIR, { ledger: comparisonLedger, capability: 'cashflow_comparison' });
    check('O invalid', o.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
    check('O UNAUTHORIZED_DIRECTION',
      (o.shadow.validation.violations || []).some((v) => v.code === VIOLATION_CODE.UNAUTHORIZED_DIRECTION));
    check('O blocked', o.enforced.decision.block === true);

    section('3C.3 P comparison wrong delta');
    const p = enforceTurn(CMP_WRONG_DELTA, { ledger: comparisonLedger, capability: 'cashflow_comparison' });
    check('P invalid', p.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
    check('P blocked', p.enforced.decision.block === true);
    const pOk = enforceTurn(CMP_DELTA, { ledger: comparisonLedger, capability: 'cashflow_comparison' });
    check('P exact delta not blocked', pOk.enforced.decision.block === false && pOk.enforced.finalText === CMP_DELTA);

    section('3C.3 Q comparison period-scalar exclusion');
    const q = enforceTurn(CMP_PERIOD_SCALAR, { ledger: comparisonLedger, capability: 'cashflow_comparison' });
    check('Q invalid period identity', q.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
    check('Q UNSUPPORTED_PERIOD_ATTRIBUTION',
      (q.shadow.validation.violations || []).some((v) => (
        v.code === VIOLATION_CODE.UNSUPPORTED_PERIOD_ATTRIBUTION
        && v.reasonCode === 'period_identity_mismatch'
      )));
    const qFamilies = (q.shadow.validation.violations || []).map((v) => (
      comparisonClaimFamily(v, q.shadow.extractedClaims, q.shadow.contract)
    ));
    check('Q violations are excluded families', qFamilies.length > 0 && qFamilies.every((f) => (
      f === 'period_scalar' || f === 'unclassified'
    )));
    check('Q not blocked', q.enforced.decision.block === false);
    check('Q original returned', q.enforced.finalText === CMP_PERIOD_SCALAR);
    check('Q reason not_eligible_claim_family',
      q.enforced.decision.reason === ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY);

    section('3C.3 R affordability exclusion');
    const r = enforceTurn('You can afford the $800 purchase.', {
      ledger: affordLedger,
      capability: 'affordability_or_planning',
    });
    check('R not eligible', r.enforced.decision.eligible === false);
    check('R not blocked', r.enforced.decision.block === false);
    check('R original returned', r.enforced.finalText === 'You can afford the $800 purchase.');

    section('3C.3 S indeterminate only');
    const s = enforceTurn(INDETERMINATE_TEXT, { ledger: lookupLedger, capability: 'financial_lookup' });
    check('S not blocked', s.enforced.decision.block === false);
    check('S original returned', s.enforced.finalText === INDETERMINATE_TEXT);

    section('3C.3 T validation exception fail-open');
    const t = enforceTurn(TARGET_INVALID, {
      ledger: lookupLedger,
      capability: 'financial_lookup',
      throwExtractor: true,
    });
    check('T exception status', t.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.EXCEPTION);
    check('T not blocked', t.enforced.decision.block === false);
    check('T original returned', t.enforced.finalText === TARGET_INVALID);
    check('T reason validation_exception',
      t.enforced.decision.reason === ENFORCEMENT_REASON.VALIDATION_EXCEPTION);

    section('3C.3 V write flow');
    const v = enforceTurn(TARGET_INVALID, {
      ledger: lookupLedger,
      capability: 'financial_lookup',
      writeResponseMode: 'deterministic_commit',
    });
    check('V not eligible', v.enforced.decision.eligible === false);
    check('V not blocked', v.enforced.decision.block === false);
    check('V original returned', v.enforced.finalText === TARGET_INVALID);

    section('3C.3 W simulation');
    const w = enforceTurn(TARGET_INVALID, {
      ledger: lookupLedger,
      capability: 'financial_lookup',
      simulationMode: true,
    });
    check('W not eligible', w.enforced.decision.eligible === false);
    check('W not blocked', w.enforced.decision.block === false);

    section('3C.3 X blocked history persistence');
    const x = enforceTurn(LIVE_C_TEXT, { ledger: snapshotLedger, capability: 'financial_forecast' });
    check('X persisted is fallback', x.persisted[0].content === RESPONSE_VALIDATION_FALLBACK);
    check('X azure text absent from history', x.persisted[0].content.indexOf('1193.93') === -1);

    section('3C.3 Y valid history persistence');
    const y = enforceTurn(CMP_VALID, { ledger: comparisonLedger, capability: 'cashflow_comparison' });
    check('Y persisted original', y.persisted[0].content === CMP_VALID);

    section('3C.3 Z single validation pass');
    const z = enforceTurn(CMP_14, { ledger: comparisonLedger, capability: 'cashflow_comparison' });
    check('Z extract once', z.extractCalls === 1);
    check('Z validate once', z.validateCalls === 1);

    section('3C.3 income horizon core / bills-before-payday');
    const hz = enforceTurn(HORIZON_VALID, {
      ledger: horizonLedger,
      capability: 'cashflow_income_horizon',
    });
    check('horizon core not blocked', hz.enforced.decision.block === false && hz.enforced.decision.eligible === true);
    const hzBills = enforceTurn('Rent before payday is $9999.', {
      ledger: buildHorizonBillsBeforePayday(),
      capability: 'cashflow_income_horizon',
      responseMode: 'negative_check',
    });
    check('bills-before-payday excluded', hzBills.enforced.decision.eligible === false
      && hzBills.enforced.decision.block === false);
    check('bills-before-payday original returned', hzBills.enforced.finalText === 'Rent before payday is $9999.');
    const hzWithList = enforceTurn(HORIZON_VALID, {
      ledger: buildHorizonBillsBeforePayday(),
      capability: 'cashflow_income_horizon',
    });
    check('core horizon still eligible when list present', hzWithList.enforced.decision.eligible === true);

    section('3C.3 cashflow_analysis excluded');
    const analysis = enforceTurn('Posted net is $999999.', {
      ledger: lookupLedger,
      capability: 'cashflow_analysis',
    });
    check('analysis not eligible', analysis.enforced.decision.eligible === false);
    check('analysis not blocked', analysis.enforced.decision.block === false);

    section('3C.3 medium/low do not block');
    const medium = evaluateResponseEnforcement({
      capability: 'cashflow_trend',
      responseSource: 'azure',
      writeResponseMode: 'none',
      flagEnabled: true,
      shadow: {
        telemetry: {
          response_validation_performed: true,
          response_validation_status: RESPONSE_VALIDATION_STATUS.INVALID,
          response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.OK,
        },
        validation: {
          status: 'invalid',
          violations: [{ code: VIOLATION_CODE.UNSUPPORTED_AMOUNT, severity: SEVERITY.MEDIUM }],
        },
      },
    });
    check('medium not blocked', medium.block === false
      && medium.reason === ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY);
    const low = evaluateResponseEnforcement({
      capability: 'cashflow_trend',
      responseSource: 'azure',
      writeResponseMode: 'none',
      flagEnabled: true,
      shadow: {
        telemetry: {
          response_validation_performed: true,
          response_validation_status: RESPONSE_VALIDATION_STATUS.INVALID,
          response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.OK,
        },
        validation: {
          status: 'invalid',
          violations: [{ code: VIOLATION_CODE.UNSUPPORTED_AMOUNT, severity: SEVERITY.LOW }],
        },
      },
    });
    check('low not blocked', low.block === false);

    section('3C.3 missing contract fail-open');
    const missingContract = evaluateResponseEnforcement({
      capability: 'financial_lookup',
      responseSource: 'azure',
      writeResponseMode: 'none',
      flagEnabled: true,
      shadow: {
        telemetry: {
          response_validation_performed: true,
          response_validation_status: RESPONSE_VALIDATION_STATUS.INVALID,
          response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.NOT_APPLICABLE,
        },
        validation: {
          status: 'invalid',
          violations: [{ code: VIOLATION_CODE.UNSUPPORTED_AMOUNT, severity: SEVERITY.CRITICAL }],
        },
      },
    });
    check('missing contract not blocked', missingContract.block === false
      && missingContract.reason === ENFORCEMENT_REASON.CONTRACT_NOT_OK);
  });

  section('3C.3 U flag off');
  withEnforcement('false', () => {
    const u = enforceTurn(TARGET_INVALID, { ledger: lookupLedger, capability: 'financial_lookup' });
    check('U validation still invalid', u.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
    check('U not blocked', u.enforced.decision.block === false);
    check('U original returned', u.enforced.finalText === TARGET_INVALID);
    check('U reason flag_disabled', u.enforced.decision.reason === ENFORCEMENT_REASON.FLAG_DISABLED);
    check('U enabled false', u.enforced.telemetry.response_enforcement_enabled === false);
  });
  withEnforcement(undefined, () => {
    const unset = enforceTurn(LIVE_C_TEXT, { ledger: snapshotLedger, capability: 'financial_forecast' });
    check('unset flag not blocked', unset.enforced.decision.block === false);
    check('unset returns azure text', unset.enforced.finalText === LIVE_C_TEXT);
  });

  section('3C.4 Slice 2 enforcement isolation');
  const {
    SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY,
    SNAPSHOT_SEMANTIC_REASON,
  } = require('../services/keaSnapshotSemanticValidation');
  withFlag(SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY, 'true', () => {
    withEnforcement('true', () => {
      const onlySemantic = evaluateResponseEnforcement({
        flagEnabled: true,
        capability: 'financial_forecast',
        responseSource: 'azure',
        writeResponseMode: 'none',
        shadow: {
          telemetry: {
            response_validation_performed: true,
            response_validation_status: RESPONSE_VALIDATION_STATUS.INVALID,
            response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.OK,
          },
          validation: {
            status: 'invalid',
            violations: [{
              code: VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH,
              severity: SEVERITY.CRITICAL,
              reasonCode: SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH,
            }],
          },
        },
      });
      check('semantic-only not blocked', onlySemantic.block === false);
      check('semantic-only not eligible family',
        onlySemantic.reason === ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY);

      const mixed = evaluateResponseEnforcement({
        flagEnabled: true,
        capability: 'financial_forecast',
        responseSource: 'azure',
        writeResponseMode: 'none',
        shadow: {
          telemetry: {
            response_validation_performed: true,
            response_validation_status: RESPONSE_VALIDATION_STATUS.INVALID,
            response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.OK,
          },
          validation: {
            status: 'invalid',
            violations: [
              {
                code: VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH,
                severity: SEVERITY.HIGH,
                reasonCode: SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH,
              },
              {
                code: VIOLATION_CODE.UNSUPPORTED_DERIVATION,
                severity: SEVERITY.CRITICAL,
                reasonCode: 'unauthorized_derived_amount',
              },
            ],
          },
        },
      });
      check('mixed semantic+derivation still blocked', mixed.block === true);

      const liveC = enforceTurn(LIVE_C_TEXT, {
        ledger: snapshotLedger,
        capability: 'financial_forecast',
      });
      check('LIVE_C still blocked with Slice 2 ON', liveC.enforced.decision.block === true);
      check('LIVE_C still fallback', liveC.enforced.finalText === RESPONSE_VALIDATION_FALLBACK);
      check('LIVE_C one validation pass', liveC.validateCalls === 1);
      check('LIVE_C zero extra extract', liveC.extractCalls === 1);

      const sept = enforceTurn('September expenses will total $1134.56.', {
        ledger: snapshotLedger,
        capability: 'financial_forecast',
      });
      check('September 15-day invalid in shadow',
        sept.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
      check('September 15-day not blocked', sept.enforced.decision.block === false);
      check('September original reaches user', sept.enforced.finalText === 'September expenses will total $1134.56.');
      check('September primary semantic',
        sept.shadow.telemetry.response_validation_primary_violation === VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH);
    });
  });

  section('3C.4 Slice 3 coverage enforcement isolation');
  const {
    SNAPSHOT_COVERAGE_VALIDATION_ENV_KEY,
  } = require('../services/keaSnapshotSemanticValidation');
  withFlag(SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY, 'true', () => {
    withFlag(SNAPSHOT_COVERAGE_VALIDATION_ENV_KEY, 'true', () => {
      withEnforcement('true', () => {
        const onlyCoverage = evaluateResponseEnforcement({
          flagEnabled: true,
          capability: 'financial_forecast',
          responseSource: 'azure',
          writeResponseMode: 'none',
          shadow: {
            telemetry: {
              response_validation_performed: true,
              response_validation_status: RESPONSE_VALIDATION_STATUS.INVALID,
              response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.OK,
            },
            validation: {
              status: 'invalid',
              violations: [{
                code: VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH,
                severity: SEVERITY.HIGH,
                reasonCode: SNAPSHOT_SEMANTIC_REASON.COVERAGE_ROLE_MISMATCH,
              }],
            },
          },
        });
        check('coverage-only not blocked', onlyCoverage.block === false);
        check('coverage-only not eligible family',
          onlyCoverage.reason === ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY);

        const mixedCoverage = evaluateResponseEnforcement({
          flagEnabled: true,
          capability: 'financial_forecast',
          responseSource: 'azure',
          writeResponseMode: 'none',
          shadow: {
            telemetry: {
              response_validation_performed: true,
              response_validation_status: RESPONSE_VALIDATION_STATUS.INVALID,
              response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.OK,
            },
            validation: {
              status: 'invalid',
              violations: [
                {
                  code: VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH,
                  severity: SEVERITY.HIGH,
                  reasonCode: SNAPSHOT_SEMANTIC_REASON.COVERAGE_ROLE_MISMATCH,
                },
                {
                  code: VIOLATION_CODE.UNSUPPORTED_DERIVATION,
                  severity: SEVERITY.CRITICAL,
                  reasonCode: 'unauthorized_derived_amount',
                },
              ],
            },
          },
        });
        check('mixed coverage+derivation still blocked', mixedCoverage.block === true);
      });
    });
  });
  withFlag(SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY, 'false', () => {
    withEnforcement('true', () => {
      const liveC = enforceTurn(LIVE_C_TEXT, {
        ledger: snapshotLedger,
        capability: 'financial_forecast',
      });
      check('Slice 2 OFF does not disable 3C.3', liveC.enforced.decision.block === true);
    });
  });

  section('3C.4 Slice 4 relation enforcement isolation');
  const {
    COMPARISON_RELATION_VALIDATION_ENV_KEY,
    COMPARISON_RELATION_REASON,
  } = require('../services/keaComparisonSemanticValidation');
  const CMP_REVERSED = 'Spending decreased from July to June.';
  withFlag(COMPARISON_RELATION_VALIDATION_ENV_KEY, 'true', () => {
    withEnforcement('true', () => {
      const onlyRel = evaluateResponseEnforcement({
        flagEnabled: true,
        capability: 'cashflow_comparison',
        responseSource: 'azure',
        writeResponseMode: 'none',
        shadow: {
          telemetry: {
            response_validation_performed: true,
            response_validation_status: RESPONSE_VALIDATION_STATUS.INVALID,
            response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.OK,
          },
          validation: {
            status: 'invalid',
            violations: [{
              code: VIOLATION_CODE.COMPARISON_RELATION_MISMATCH,
              severity: SEVERITY.HIGH,
              reasonCode: COMPARISON_RELATION_REASON.PERIOD_RELATION_REVERSED,
            }],
          },
        },
      });
      check('relation-only not blocked', onlyRel.block === false);
      check('relation-only not eligible family',
        onlyRel.reason === ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY);

      const mixedRel = evaluateResponseEnforcement({
        flagEnabled: true,
        capability: 'cashflow_comparison',
        responseSource: 'azure',
        writeResponseMode: 'none',
        shadow: {
          telemetry: {
            response_validation_performed: true,
            response_validation_status: RESPONSE_VALIDATION_STATUS.INVALID,
            response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.OK,
          },
          validation: {
            status: 'invalid',
            violations: [
              {
                code: VIOLATION_CODE.COMPARISON_RELATION_MISMATCH,
                severity: SEVERITY.HIGH,
                reasonCode: COMPARISON_RELATION_REASON.PERIOD_RELATION_REVERSED,
              },
              {
                code: VIOLATION_CODE.UNAUTHORIZED_DIRECTION,
                severity: SEVERITY.HIGH,
                reasonCode: 'direction_polarity_mismatch',
              },
            ],
          },
        },
      });
      check('mixed relation+direction still blocked', mixedRel.block === true);

      const liveRel = enforceTurn(CMP_VALID, {
        ledger: comparisonLedger,
        capability: 'cashflow_comparison',
      });
      check('live July compared to June not blocked', liveRel.enforced.decision.block === false);
      check('live comparison remains VALID',
        liveRel.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.VALID);

      const reversedLive = enforceTurn(CMP_REVERSED, {
        ledger: comparisonLedger,
        capability: 'cashflow_comparison',
      });
      check('reversed relation invalid in shadow',
        reversedLive.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
      check('reversed relation not blocked', reversedLive.enforced.decision.block === false);
      check('reversed original reaches user', reversedLive.enforced.finalText === CMP_REVERSED);
      check('reversed primary relation',
        reversedLive.shadow.telemetry.response_validation_primary_violation
          === VIOLATION_CODE.COMPARISON_RELATION_MISMATCH);

      const dirStill = enforceTurn(CMP_WRONG_DIR, {
        ledger: comparisonLedger,
        capability: 'cashflow_comparison',
      });
      check('wrong direction still blocked with Slice 4 ON', dirStill.enforced.decision.block === true);
    });
  });
  withFlag(COMPARISON_RELATION_VALIDATION_ENV_KEY, 'false', () => {
    withEnforcement('true', () => {
      const off = enforceTurn(CMP_REVERSED, {
        ledger: comparisonLedger,
        capability: 'cashflow_comparison',
      });
      check('Slice 4 OFF reversed not relation-invalid',
        off.shadow.telemetry.response_validation_status !== RESPONSE_VALIDATION_STATUS.INVALID
        || !(off.shadow.validation.violations || []).some((v) => (
          v.code === VIOLATION_CODE.COMPARISON_RELATION_MISMATCH
        )));
      check('Slice 4 OFF does not disable 3C.3',
        enforceTurn(LIVE_C_TEXT, {
          ledger: snapshotLedger,
          capability: 'financial_forecast',
        }).enforced.decision.block === true);
    });
  });

  section('3C.4 Slice 5 trend coverage enforcement isolation');
  const {
    TREND_COVERAGE_VALIDATION_ENV_KEY,
    TREND_COVERAGE_REASON,
  } = require('../services/keaTrendSemanticValidation');
  const TREND_FULL_MONTH = "June's full-month spending was $12815.73.";
  const TREND_MIXED_COV = "June's full-month spending was $12815.73. Spending increased.";
  withFlag(TREND_COVERAGE_VALIDATION_ENV_KEY, 'true', () => {
    withEnforcement('true', () => {
      const onlyCov = evaluateResponseEnforcement({
        flagEnabled: true,
        capability: 'cashflow_trend',
        responseSource: 'azure',
        writeResponseMode: 'none',
        shadow: {
          telemetry: {
            response_validation_performed: true,
            response_validation_status: RESPONSE_VALIDATION_STATUS.INVALID,
            response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.OK,
          },
          validation: {
            status: 'invalid',
            violations: [{
              code: VIOLATION_CODE.TREND_COVERAGE_MISMATCH,
              severity: SEVERITY.HIGH,
              reasonCode: TREND_COVERAGE_REASON.MATCHED_ELAPSED_AS_FULL_MONTH,
            }],
          },
        },
      });
      check('coverage-only not blocked', onlyCov.block === false);
      check('coverage-only not eligible family',
        onlyCov.reason === ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY);

      const mixedCov = evaluateResponseEnforcement({
        flagEnabled: true,
        capability: 'cashflow_trend',
        responseSource: 'azure',
        writeResponseMode: 'none',
        shadow: {
          telemetry: {
            response_validation_performed: true,
            response_validation_status: RESPONSE_VALIDATION_STATUS.INVALID,
            response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.OK,
          },
          validation: {
            status: 'invalid',
            violations: [
              {
                code: VIOLATION_CODE.TREND_COVERAGE_MISMATCH,
                severity: SEVERITY.HIGH,
                reasonCode: TREND_COVERAGE_REASON.MATCHED_ELAPSED_AS_FULL_MONTH,
              },
              {
                code: VIOLATION_CODE.UNAUTHORIZED_DIRECTION,
                severity: SEVERITY.HIGH,
                reasonCode: 'direction_polarity_mismatch',
              },
            ],
          },
        },
      });
      check('mixed coverage+direction still blocked', mixedCov.block === true);

      const liveTrend = enforceTurn(TREND_VALID, {
        ledger: trendLedger,
        capability: 'cashflow_trend',
      });
      check('live matched-elapsed trend not blocked', liveTrend.enforced.decision.block === false);
      check('live trend remains VALID',
        liveTrend.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.VALID);

      const fullMonthLive = enforceTurn(TREND_FULL_MONTH, {
        ledger: trendLedger,
        capability: 'cashflow_trend',
      });
      check('full-month coverage invalid in shadow',
        fullMonthLive.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
      check('full-month coverage not blocked', fullMonthLive.enforced.decision.block === false);
      check('full-month original reaches user', fullMonthLive.enforced.finalText === TREND_FULL_MONTH);
      check('full-month primary coverage',
        fullMonthLive.shadow.telemetry.response_validation_primary_violation
          === VIOLATION_CODE.TREND_COVERAGE_MISMATCH);

      const mixedLive = enforceTurn(TREND_MIXED_COV, {
        ledger: trendLedger,
        capability: 'cashflow_trend',
      });
      check('mixed coverage+direction live blocked', mixedLive.enforced.decision.block === true);

      const amtStill = enforceTurn(TREND_WRONG_AMT, {
        ledger: trendLedger,
        capability: 'cashflow_trend',
      });
      check('wrong amount still blocked with Slice 5 ON', amtStill.enforced.decision.block === true);
    });
  });
  withFlag(TREND_COVERAGE_VALIDATION_ENV_KEY, 'false', () => {
    withEnforcement('true', () => {
      const off = enforceTurn(TREND_FULL_MONTH, {
        ledger: trendLedger,
        capability: 'cashflow_trend',
      });
      check('Slice 5 OFF full-month not coverage-invalid',
        off.shadow.telemetry.response_validation_status !== RESPONSE_VALIDATION_STATUS.INVALID
        || !(off.shadow.validation.violations || []).some((v) => (
          v.code === VIOLATION_CODE.TREND_COVERAGE_MISMATCH
        )));
      check('Slice 5 OFF does not disable 3C.3',
        enforceTurn(LIVE_C_TEXT, {
          ledger: snapshotLedger,
          capability: 'financial_forecast',
        }).enforced.decision.block === true);
      check('Slice 5 OFF existing trend wrong amount still blocked',
        enforceTurn(TREND_WRONG_AMT, {
          ledger: trendLedger,
          capability: 'cashflow_trend',
        }).enforced.decision.block === true);
    });
  });

  section('3C.4 Slice 6 lookup attribution enforcement isolation');
  const {
    LOOKUP_ATTRIBUTION_VALIDATION_ENV_KEY,
    LOOKUP_ATTRIBUTION_REASON,
  } = require('../services/keaLookupSemanticValidation');
  const TARGET_WALMART = 'You spent $279.58 at Walmart in July 2026.';
  const TARGET_JUNE = 'You spent $279.58 at Target in June 2026.';
  const TARGET_MIXED_AMT = 'You spent $99999 at Walmart in July 2026.';
  withFlag(LOOKUP_ATTRIBUTION_VALIDATION_ENV_KEY, 'true', () => {
    withEnforcement('true', () => {
      const onlyMerch = evaluateResponseEnforcement({
        flagEnabled: true,
        capability: 'financial_lookup',
        responseSource: 'azure',
        writeResponseMode: 'none',
        shadow: {
          telemetry: {
            response_validation_performed: true,
            response_validation_status: RESPONSE_VALIDATION_STATUS.INVALID,
            response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.OK,
          },
          validation: {
            status: 'invalid',
            violations: [{
              code: VIOLATION_CODE.LOOKUP_ATTRIBUTION_MISMATCH,
              severity: SEVERITY.HIGH,
              reasonCode: LOOKUP_ATTRIBUTION_REASON.MERCHANT_IDENTITY_MISMATCH,
            }],
          },
        },
      });
      check('attribution-only merchant not blocked', onlyMerch.block === false);
      check('attribution-only not eligible family',
        onlyMerch.reason === ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY);

      const liveGood = enforceTurn(TARGET_VALID, {
        ledger: lookupLedger,
        capability: 'financial_lookup',
      });
      check('live Target lookup not blocked', liveGood.enforced.decision.block === false);
      check('live Target remains VALID',
        liveGood.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.VALID);

      const walmartLive = enforceTurn(TARGET_WALMART, {
        ledger: lookupLedger,
        capability: 'financial_lookup',
      });
      check('wrong-merchant invalid in shadow',
        walmartLive.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
      check('wrong-merchant not blocked', walmartLive.enforced.decision.block === false);
      check('wrong-merchant original reaches user', walmartLive.enforced.finalText === TARGET_WALMART);
      check('wrong-merchant primary attribution',
        walmartLive.shadow.telemetry.response_validation_primary_violation
          === VIOLATION_CODE.LOOKUP_ATTRIBUTION_MISMATCH);

      const juneLive = enforceTurn(TARGET_JUNE, {
        ledger: lookupLedger,
        capability: 'financial_lookup',
      });
      check('wrong-period invalid in shadow',
        juneLive.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
      check('wrong-period not blocked', juneLive.enforced.decision.block === false);

      const mixedLive = enforceTurn(TARGET_MIXED_AMT, {
        ledger: lookupLedger,
        capability: 'financial_lookup',
      });
      check('mixed attribution+amount live blocked', mixedLive.enforced.decision.block === true);

      const amtStill = enforceTurn(TARGET_INVALID, {
        ledger: lookupLedger,
        capability: 'financial_lookup',
      });
      check('wrong amount still blocked with Slice 6 ON', amtStill.enforced.decision.block === true);
    });
  });
  withFlag(LOOKUP_ATTRIBUTION_VALIDATION_ENV_KEY, 'false', () => {
    withEnforcement('true', () => {
      const off = enforceTurn(TARGET_WALMART, {
        ledger: lookupLedger,
        capability: 'financial_lookup',
      });
      check('Slice 6 OFF Walmart not attribution-invalid',
        off.shadow.telemetry.response_validation_status !== RESPONSE_VALIDATION_STATUS.INVALID
        || !(off.shadow.validation.violations || []).some((v) => (
          v.code === VIOLATION_CODE.LOOKUP_ATTRIBUTION_MISMATCH
        )));
      check('Slice 6 OFF does not disable 3C.3',
        enforceTurn(LIVE_C_TEXT, {
          ledger: snapshotLedger,
          capability: 'financial_forecast',
        }).enforced.decision.block === true);
      check('Slice 6 OFF existing lookup wrong amount still blocked',
        enforceTurn(TARGET_INVALID, {
          ledger: lookupLedger,
          capability: 'financial_lookup',
        }).enforced.decision.block === true);
    });
  });

  section('3C.4 Slice 7 snapshot negative-minimum enforcement isolation');
  const {
    SNAPSHOT_NEGATIVE_MINIMUM_VALIDATION_ENV_KEY,
    SNAPSHOT_NEGATIVE_MINIMUM_REASON,
  } = require('../services/keaSnapshotNegativeBalanceSemanticValidation');
  const { buildSnapshotEvidenceLedger } = require('../services/keaEvidenceLedgerBuilders');
  const NEG_LEDGER = buildSnapshotEvidenceLedger({
    capability: 'financial_forecast',
    evidence: {
      status: 'ok',
      source: ['kea_snapshot'],
      facts: {
        upcomingWindowDays: 15,
        availableBalance: 2207.75,
        futureNegativeBalances: [
          { amount: -125.40, date: '2026-09-14', daysUntil: 14 },
        ],
      },
      period: { start: '2026-08-01', end: '2026-08-31', label: 'August 2026' },
      limitations: ['upcoming_window_15d'],
    },
    accountContext: { accountId: '10', accountLabel: 'Main Account' },
  }).ledger;
  const NEG_VALID = 'Your projected balance is -$125.40 on September 14, 2026.';
  const NEG_LOWEST = 'Your lowest balance next month will be -$125.40.';
  withFlag(SNAPSHOT_NEGATIVE_MINIMUM_VALIDATION_ENV_KEY, 'true', () => {
    withEnforcement('true', () => {
      const onlyMin = evaluateResponseEnforcement({
        flagEnabled: true,
        capability: 'financial_forecast',
        responseSource: 'azure',
        writeResponseMode: 'none',
        shadow: {
          telemetry: {
            response_validation_performed: true,
            response_validation_status: RESPONSE_VALIDATION_STATUS.INVALID,
            response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.OK,
          },
          validation: {
            status: 'invalid',
            violations: [{
              code: VIOLATION_CODE.SNAPSHOT_NEGATIVE_MINIMUM_MISMATCH,
              severity: SEVERITY.HIGH,
              reasonCode: SNAPSHOT_NEGATIVE_MINIMUM_REASON.NEGATIVE_EVENT_AS_MINIMUM,
            }],
          },
        },
      });
      check('minimum-only not blocked', onlyMin.block === false);
      check('minimum-only not eligible family',
        onlyMin.reason === ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY);

      const eventLive = enforceTurn(NEG_VALID, {
        ledger: NEG_LEDGER,
        capability: 'financial_forecast',
      });
      check('exact negative event not blocked', eventLive.enforced.decision.block === false);
      check('exact negative event remains VALID',
        eventLive.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.VALID);

      const lowestLive = enforceTurn(NEG_LOWEST, {
        ledger: NEG_LEDGER,
        capability: 'financial_forecast',
      });
      check('lowest invalid in shadow',
        lowestLive.shadow.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
      check('lowest not blocked', lowestLive.enforced.decision.block === false);
      check('lowest original reaches user', lowestLive.enforced.finalText === NEG_LOWEST);
      check('lowest primary Slice 7',
        lowestLive.shadow.telemetry.response_validation_primary_violation
          === VIOLATION_CODE.SNAPSHOT_NEGATIVE_MINIMUM_MISMATCH);

      check('LIVE_C still blocked with Slice 7 ON',
        enforceTurn(LIVE_C_TEXT, {
          ledger: snapshotLedger,
          capability: 'financial_forecast',
        }).enforced.decision.block === true);
      const mixed = enforceTurn(NEG_LOWEST + ' ' + LIVE_C_TEXT, {
        ledger: NEG_LEDGER,
        capability: 'financial_forecast',
      });
      check('mixed Slice 7 + old critical still blocked', mixed.enforced.decision.block === true);
    });
  });
  withFlag(SNAPSHOT_NEGATIVE_MINIMUM_VALIDATION_ENV_KEY, 'false', () => {
    withEnforcement('true', () => {
      const off = enforceTurn(NEG_LOWEST, {
        ledger: NEG_LEDGER,
        capability: 'financial_forecast',
      });
      check('Slice 7 OFF lowest not minimum-invalid',
        off.shadow.telemetry.response_validation_status !== RESPONSE_VALIDATION_STATUS.INVALID
        || !(off.shadow.validation.violations || []).some((v) => (
          v.code === VIOLATION_CODE.SNAPSHOT_NEGATIVE_MINIMUM_MISMATCH
        )));
      check('Slice 7 OFF does not disable 3C.3',
        enforceTurn(LIVE_C_TEXT, {
          ledger: snapshotLedger,
          capability: 'financial_forecast',
        }).enforced.decision.block === true);
    });
  });

  section('3C.3 telemetry privacy');
  withEnforcement('true', () => {
    const t = createKeaTelemetry({ requestId: 'enf-1' });
    const blocked = enforceTurn(TARGET_INVALID, { ledger: lookupLedger, capability: 'financial_lookup' });
    t.recordResponseValidation(blocked.shadow.telemetry);
    t.recordResponseEnforcement(blocked.enforced.telemetry);
    const payload = t.toPayload();
    check('enforcement blocked true', payload.response_enforcement_blocked === true);
    check('enforcement eligible true', payload.response_enforcement_eligible === true);
    check('validation fields unchanged', payload.response_validation_status === 'invalid');
    check('no leak in payload', leakHits(payload).length === 0, leakHits(payload).join(','));
    t.recordResponseEnforcement({
      response_enforcement_blocked: true,
      amount: 280,
      merchant: 'Target',
      text: TARGET_INVALID,
      path: 'facts.spentTotal',
    });
    check('enforcement sanitizer drops extras', t.toPayload().amount === undefined
      && t.toPayload().merchant === undefined
      && t.toPayload().text === undefined);
    const sanitized = sanitizeResponseEnforcementTelemetry({
      response_enforcement_reason: 'not_a_real_reason',
      response_enforcement_capability: 'hacked',
      extra: 'Target $280',
    });
    check('unknown reason falls back', sanitized.response_enforcement_reason === ENFORCEMENT_REASON.NONE);
    check('sanitizer has no extras', sanitized.extra === undefined);
  });

  section('3C.3 controller insertion');
  const controller = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'openaiController.js'), 'utf8');
  const azure = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaAzureChat.js'), 'utf8');
  check('controller imports enforcement',
    controller.indexOf("require('../services/keaResponseValidationEnforcement')") !== -1);
  check('controller still imports shadow',
    controller.indexOf("require('../services/keaResponseValidationShadow')") !== -1);
  check('controller does not import validator',
    controller.indexOf('keaResponseClaimValidator') === -1
    && controller.indexOf('keaResponseClaimExtractor') === -1);
  check('enforcement after shadow',
    controller.indexOf('applyShadowResponseValidation')
      < controller.indexOf('applyResponseValidationEnforcement'));
  check('enforcement before persist',
    controller.indexOf('applyResponseValidationEnforcement')
      < controller.indexOf('await persistAnswerThenRefreshSummary'));
  check('history uses finalText after enforcement',
    /role:\s*'assistant',\s*content:\s*finalText/.test(controller));
  check('no second Azure call in enforcement',
    !/applyResponseValidationEnforcement[\s\S]{0,800}queryAzureOpenAI/.test(controller));
  check('no retry after enforcement',
    controller.indexOf('Please answer again') === -1);
  check('env flag not hardcoded in controller',
    controller.indexOf('USE_RESPONSE_VALIDATION_ENFORCEMENT') === -1);
  check('azure chat has no enforcement', azure.indexOf('keaResponseValidationEnforcement') === -1);

  section('3C.3 no logging of blocked prose');
  const enfSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseValidationEnforcement.js'), 'utf8');
  check('no logger in enforcement module', !/console\.(log|info|warn|error)|logger\./.test(enfSrc));
  check('no JSON.stringify of original text', enfSrc.indexOf('JSON.stringify(original') === -1);

  section('3C.3 performance');
  withEnforcement('true', () => {
    const validShadow = applyShadowResponseValidation({
      text: CMP_VALID,
      ledger: comparisonLedger,
      capability: 'cashflow_comparison',
      responseSource: 'azure',
    });
    const tValid = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) {
      applyResponseValidationEnforcement({
        originalText: CMP_VALID,
        shadow: validShadow,
        capability: 'cashflow_comparison',
        ledger: comparisonLedger,
      });
    }
    const validMs = Number(process.hrtime.bigint() - tValid) / 1e6;
    console.log(`  1000 eligible VALID decisions: ${validMs.toFixed(2)}ms total, ${(validMs / 1000).toFixed(3)}ms avg`);

    const invalidShadow = applyShadowResponseValidation({
      text: LIVE_C_TEXT,
      ledger: snapshotLedger,
      capability: 'financial_forecast',
      responseSource: 'azure',
    });
    const tInvalid = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) {
      applyResponseValidationEnforcement({
        originalText: LIVE_C_TEXT,
        shadow: invalidShadow,
        capability: 'financial_forecast',
        ledger: snapshotLedger,
      });
    }
    const invalidMs = Number(process.hrtime.bigint() - tInvalid) / 1e6;
    console.log(`  1000 eligible INVALID blocks: ${invalidMs.toFixed(2)}ms total, ${(invalidMs / 1000).toFixed(3)}ms avg`);

    const tInelig = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) {
      evaluateResponseEnforcement({
        capability: 'affordability_or_planning',
        responseSource: 'azure',
        writeResponseMode: 'none',
        shadow: { telemetry: { response_validation_performed: true, response_validation_status: 'invalid' } },
      });
    }
    const ineligMs = Number(process.hrtime.bigint() - tInelig) / 1e6;
    console.log(`  1000 ineligible decisions: ${ineligMs.toFixed(2)}ms total, ${(ineligMs / 1000).toFixed(3)}ms avg`);
    check('performance measured', Number.isFinite(validMs) && Number.isFinite(invalidMs) && Number.isFinite(ineligMs));
  });
}

module.exports = { run };
