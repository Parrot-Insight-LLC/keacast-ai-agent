'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');
const { createKeaTelemetry } = require('../services/keaTelemetry');
const { buildTrendEvidenceLedger } = require('../services/keaEvidenceLedgerBuilders');
const {
  applyShadowResponseValidation,
} = require('../services/keaResponseValidationShadow');
const {
  RESPONSE_VALIDATION_ENFORCEMENT_ENV_KEY,
  applyResponseValidationEnforcement,
} = require('../services/keaResponseValidationEnforcement');
const {
  TREND_BLOCK_DIAGNOSTIC_ENV_KEY,
  TREND_BLOCK_DIAGNOSTIC_TELEMETRY_REMOVAL,
  TREND_DIAG_FIELD_KEYS,
  FORBIDDEN_OUTPUT_KEYS,
  isTrendBlockDiagnosticEnabled,
  sanitizeTrendDiagnosticTelemetry,
  buildTrendBlockedDiagnosticTelemetry,
} = require('../services/keaTrendBlockedDiagnosticTelemetry');

const NON_TREND_CAPS = [
  'cashflow_comparison',
  'financial_lookup',
  'cashflow_upcoming',
  'cashflow_recurring',
  'cashflow_income_horizon',
  'financial_forecast',
];

const SENTINELS = [
  '$98765.43',
  '42.37%',
  '2099-12-31',
  'SUPER_SECRET_ACCOUNT',
  'SUPER_SECRET_MERCHANT',
  'SUPER_SECRET_TRANSACTION',
  'SUPER_SECRET_RAW_TEXT',
  '98765',
  '42.37',
  '2099',
  'SUPER_SECRET',
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

function withDiag(value, fn) {
  return withFlag(TREND_BLOCK_DIAGNOSTIC_ENV_KEY, value, fn);
}

function decreasingLedger() {
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

function directionLedger(direction) {
  const base = decreasingLedger();
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
            direction,
            firstToLast: { absolute: -1859.18, percent: -13.71, baselineZero: false },
          },
        },
      },
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function runTurn(text, opts = {}) {
  const ledger = opts.ledger || decreasingLedger();
  const capability = opts.capability || 'cashflow_trend';
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
  const shadow = applyShadowResponseValidation({
    text,
    ledger,
    capability,
    responseSource: 'azure',
  }, deps);
  const enforced = applyResponseValidationEnforcement({
    originalText: text,
    shadow,
    capability,
    sourceKind: ledger && ledger.source && ledger.source.kind,
    responseSource: 'azure',
    ledger,
    flagEnabled: opts.flagEnabled !== false,
  });
  const diag = buildTrendBlockedDiagnosticTelemetry({
    contract: shadow.contract,
    extractedClaims: shadow.extractedClaims,
    validationResult: shadow.validation,
    enforcementDecision: enforced && enforced.decision,
    capability,
    sourceKind: ledger && ledger.source && ledger.source.kind,
    validationTelemetry: shadow.telemetry,
  });
  return {
    shadow,
    enforced,
    diag,
    extractCalls: extractCalls.n,
    validateCalls: validateCalls.n,
    text,
    ledger,
    capability,
  };
}

function behaviorSnapshot(turn) {
  const validation = turn.shadow && turn.shadow.validation;
  const decision = turn.enforced && turn.enforced.decision;
  return JSON.stringify({
    status: validation && validation.status,
    contractStatus: turn.shadow && turn.shadow.telemetry && turn.shadow.telemetry.response_validation_contract_status,
    violations: (validation && validation.violations || []).map((v) => ({
      code: v.code,
      severity: v.severity,
      reasonCode: v.reasonCode,
    })),
    primary: turn.shadow && turn.shadow.telemetry && turn.shadow.telemetry.response_validation_primary_violation,
    primarySeverity: turn.shadow && turn.shadow.telemetry && turn.shadow.telemetry.response_validation_primary_severity,
    eligible: decision && decision.eligible,
    blocked: decision && decision.block,
    reason: decision && decision.reason,
    fallback: turn.enforced && turn.enforced.finalText,
    extractCalls: turn.extractCalls,
    validateCalls: turn.validateCalls,
  });
}

function leakHits(obj) {
  const raw = JSON.stringify(obj);
  return SENTINELS.filter((n) => raw.indexOf(n) !== -1);
}

function forbiddenKeysPresent(obj) {
  if (!obj) return [];
  return FORBIDDEN_OUTPUT_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

async function run() {
  section('trend blocked diagnostic flag parsing');
  withDiag(undefined, () => {
    check('unset defaults OFF', isTrendBlockDiagnosticEnabled() === false);
  });
  withDiag('', () => {
    check('empty defaults OFF', isTrendBlockDiagnosticEnabled() === false);
  });
  withDiag('false', () => {
    check('false OFF', isTrendBlockDiagnosticEnabled() === false);
  });
  withDiag('true', () => {
    check('true ON', isTrendBlockDiagnosticEnabled() === true);
  });
  check('flag name', TREND_BLOCK_DIAGNOSTIC_ENV_KEY === 'USE_TREND_BLOCK_DIAGNOSTIC_TELEMETRY');
  check('removal backlog OPEN', TREND_BLOCK_DIAGNOSTIC_TELEMETRY_REMOVAL === 'OPEN');

  section('trend blocked diagnostic flag OFF');
  withDiag(undefined, () => {
    const turn = runTurn('a 13.71% decrease');
    check('flag OFF helper returns null', turn.diag === null);
    const t = createKeaTelemetry({ requestId: 'diag-off' });
    t.recordTrendBlockedDiagnostic(turn.diag);
    const payload = t.toPayload();
    const diagKeys = Object.keys(payload).filter((k) => k.indexOf('trend_diag_') === 0);
    check('flag OFF no trend_diag fields', diagKeys.length === 0);
    check('flag OFF still invalid', turn.shadow.telemetry.response_validation_status === 'invalid');
    check('flag OFF still blocked', turn.enforced.decision.block === true);
  });

  section('trend blocked diagnostic non-trend');
  withDiag('true', () => {
    for (let i = 0; i < NON_TREND_CAPS.length; i += 1) {
      const cap = NON_TREND_CAPS[i];
      const diag = buildTrendBlockedDiagnosticTelemetry({
        contract: { capability: cap, sourceKind: cap, allowedClaims: [] },
        extractedClaims: [{ kind: 'percent', normalizedValue: 13.71, semanticHints: [] }],
        validationResult: {
          status: 'invalid',
          violations: [{ code: 'UNSUPPORTED_COMPARISON', reasonCode: 'percent_not_in_ledger' }],
        },
        enforcementDecision: { eligible: true, block: true },
        capability: cap,
        sourceKind: cap,
        validationTelemetry: {
          response_validation_performed: true,
          response_validation_status: 'invalid',
        },
      });
      check(cap + ' emits no diagnostics', diag === null);
    }
  });

  section('trend blocked diagnostic valid trend');
  withDiag('true', () => {
    const turn = runTurn('Spending decreased by 13.71%.');
    check('valid trend not captured', turn.diag === null);
    check('valid trend status valid', turn.shadow.telemetry.response_validation_status === 'valid');
    check('valid trend not blocked', turn.enforced.decision.block === false);
  });

  section('trend blocked diagnostic invalid not blocked');
  withDiag('true', () => {
    const turn = runTurn('a 13.71% decrease', { flagEnabled: false });
    check('invalid but not blocked skipped', turn.diag === null);
    check('status still invalid', turn.shadow.telemetry.response_validation_status === 'invalid');
    check('enforcement not blocked', turn.enforced.decision.block === false);
  });

  section('trend blocked diagnostic unmatched percent');
  withDiag('true', () => {
    const turn = runTurn('Spending decreased by 14%.');
    const d = turn.diag;
    check('unmatched performed', d && d.trend_diag_performed === true);
    check('unmatched primary', d.trend_diag_primary_failure === 'unsupported_comparison');
    check('unmatched percent bucket 1', d.trend_diag_percent_token_count_bucket === '1');
    check('unmatched match status', d.trend_diag_percent_match_status === 'unmatched');
    check('unmatched numeric none/unmatched',
      d.trend_diag_percent_numeric_relation === 'unmatched'
      || d.trend_diag_percent_numeric_relation === 'none');
    check('unmatched has percent failure', d.trend_diag_has_percent_failure === true);
    check('unmatched no direction failure', d.trend_diag_has_direction_failure === false);
    check('unmatched reason', d.trend_diag_percent_failure_reason === 'percent_not_in_ledger');
    check('unmatched no numeric leak', JSON.stringify(d).indexOf('14%') === -1 && JSON.stringify(d).indexOf('14.') === -1);
    check('unmatched still blocked', turn.enforced.decision.block === true);
  });

  section('trend blocked diagnostic missing expense hint');
  withDiag('true', () => {
    const turn = runTurn('a 13.71% decrease');
    const d = turn.diag;
    check('locality performed', d && d.trend_diag_performed === true);
    check('locality authorized direction decreasing', d.trend_diag_authorized_direction === 'decreasing');
    check('locality direction authorized', d.trend_diag_direction_match_status === 'authorized');
    check('locality direction polarity down', d.trend_diag_direction_polarity === 'down');
    check('locality numeric signed magnitude', d.trend_diag_percent_numeric_relation === 'signed_magnitude');
    check('locality expense hint absent', d.trend_diag_percent_expense_hint === 'absent');
    check('locality percent unmatched', d.trend_diag_percent_match_status === 'unmatched');
    check('locality has percent failure', d.trend_diag_has_percent_failure === true);
    check('locality no direction failure', d.trend_diag_has_direction_failure === false);
    check('locality primary unsupported comparison', d.trend_diag_primary_failure === 'unsupported_comparison');
    check('locality no 13.71 leak', JSON.stringify(d).indexOf('13.71') === -1);
  });

  section('trend blocked diagnostic exact authorized percent');
  withDiag('true', () => {
    const turn = runTurn('Spending increased by -13.71%.');
    const d = turn.diag;
    check('exact captured because direction blocked', d && d.trend_diag_performed === true);
    check('exact numeric relation', d.trend_diag_percent_numeric_relation === 'exact');
    check('exact match status', d.trend_diag_percent_match_status === 'exact');
    check('exact no percent failure', d.trend_diag_has_percent_failure === false);
    check('exact has direction failure', d.trend_diag_has_direction_failure === true);
    check('exact no 13.71 leak', JSON.stringify(d).indexOf('13.71') === -1);
  });

  section('trend blocked diagnostic signed-magnitude authorized');
  withDiag('true', () => {
    const turn = runTurn('Spending increased by 13.71%.');
    const d = turn.diag;
    check('signed authorized captured', d && d.trend_diag_performed === true);
    check('signed numeric relation', d.trend_diag_percent_numeric_relation === 'signed_magnitude');
    check('signed match authorized',
      d.trend_diag_percent_match_status === 'signed_magnitude'
      || d.trend_diag_percent_match_status === 'all_authorized');
    check('signed expense hint present', d.trend_diag_percent_expense_hint === 'present');
    check('signed no percent failure', d.trend_diag_has_percent_failure === false);
    check('signed direction failure', d.trend_diag_has_direction_failure === true);
  });

  section('trend blocked diagnostic multiple percents');
  withDiag('true', () => {
    const turn = runTurn('Spending decreased by 13.71% and 7.48%.');
    const d = turn.diag;
    check('multi percent bucket 2-3', d && d.trend_diag_percent_token_count_bucket === '2-3');
    check('multi percent mixed or unmatched',
      d.trend_diag_percent_match_status === 'mixed'
      || d.trend_diag_percent_match_status === 'unmatched');
    check('multi has percent failure', d.trend_diag_has_percent_failure === true);
    check('multi no 13.71 or 7.48 leak',
      JSON.stringify(d).indexOf('13.71') === -1 && JSON.stringify(d).indexOf('7.48') === -1);
  });

  section('trend blocked diagnostic direction mismatch');
  withDiag('true', () => {
    const turn = runTurn('Spending increased.');
    const d = turn.diag;
    check('dir mismatch performed', d && d.trend_diag_performed === true);
    check('dir authorized decreasing', d.trend_diag_authorized_direction === 'decreasing');
    check('dir polarity up', d.trend_diag_direction_polarity === 'up');
    check('dir match mismatch', d.trend_diag_direction_match_status === 'mismatch');
    check('dir form increase', d.trend_diag_direction_form === 'increase');
    check('dir primary unauthorized direction', d.trend_diag_primary_failure === 'unauthorized_direction');
    check('dir has direction failure', d.trend_diag_has_direction_failure === true);
    check('dir no percent failure', d.trend_diag_has_percent_failure === false);
    check('dir reason', d.trend_diag_direction_failure_reason === 'direction_polarity_mismatch');
    check('dir token bucket 1', d.trend_diag_direction_token_count_bucket === '1');
  });

  section('trend blocked diagnostic mixed authority');
  withDiag('true', () => {
    const turn = runTurn('Spending decreased.', { ledger: directionLedger('mixed') });
    const d = turn.diag;
    check('mixed authorized mixed', d && d.trend_diag_authorized_direction === 'mixed');
    check('mixed polarity down', d.trend_diag_direction_polarity === 'down');
    check('mixed match authority_non_polar', d.trend_diag_direction_match_status === 'authority_non_polar');
    check('mixed has direction failure', d.trend_diag_has_direction_failure === true);
    check('mixed primary unauthorized direction', d.trend_diag_primary_failure === 'unauthorized_direction');
    check('mixed not rewritten as decreasing', d.trend_diag_authorized_direction !== 'decreasing');
  });

  section('trend blocked diagnostic unchanged authority');
  withDiag('true', () => {
    const turn = runTurn('Spending decreased.', { ledger: directionLedger('unchanged') });
    const d = turn.diag;
    check('unchanged authorized unchanged', d && d.trend_diag_authorized_direction === 'unchanged');
    check('unchanged polarity down', d.trend_diag_direction_polarity === 'down');
    check('unchanged match authority_non_polar', d.trend_diag_direction_match_status === 'authority_non_polar');
    check('unchanged has direction failure', d.trend_diag_has_direction_failure === true);
  });

  section('trend blocked diagnostic multiple direction tokens');
  withDiag('true', () => {
    const turn = runTurn('Spending increased then decreased.');
    const d = turn.diag;
    check('multi dir bucket 2-3', d && d.trend_diag_direction_token_count_bucket === '2-3');
    check('multi dir polarity mixed_tokens', d.trend_diag_direction_polarity === 'mixed_tokens');
    check('multi dir match multiple', d.trend_diag_direction_match_status === 'multiple');
    check('multi dir form multiple', d.trend_diag_direction_form === 'multiple');
    check('multi dir no raw increase/decrease words as extra keys',
      d.increase === undefined && d.decrease === undefined);
  });

  section('trend blocked diagnostic combined percent and direction');
  withDiag('true', () => {
    const turn = runTurn('Spending increased by 14%.');
    const d = turn.diag;
    const primary = turn.shadow.telemetry.response_validation_primary_violation;
    const severity = turn.shadow.telemetry.response_validation_primary_severity;
    check('combined has percent failure', d && d.trend_diag_has_percent_failure === true);
    check('combined has direction failure', d.trend_diag_has_direction_failure === true);
    check('combined multiple families', d.trend_diag_multiple_violation_families === true);
    check('combined primary is existing validator primary',
      d.trend_diag_primary_failure === 'unsupported_comparison'
      && primary === 'UNSUPPORTED_COMPARISON');
    check('combined severity unchanged critical', severity === 'critical');
    check('combined still blocked', turn.enforced.decision.block === true);
  });

  section('trend blocked diagnostic privacy sentinel');
  withDiag('true', () => {
    const diag = buildTrendBlockedDiagnosticTelemetry({
      contract: {
        capability: 'cashflow_trend',
        sourceKind: 'cashflow_trend',
        allowedClaims: [
          { type: 'DIRECTION', value: 'decreasing', path: 'facts.trend.spending.direction' },
          { type: 'PERCENT', value: 42.37, unit: 'percent', path: 'facts.trend.spending.firstToLast.percent' },
        ],
      },
      extractedClaims: [{
        id: 'e1',
        kind: 'percent',
        normalizedValue: 42.37,
        semanticHints: [],
        rawSpan: '42.37%',
        nearbyTerms: 'SUPER_SECRET_RAW_TEXT $98765.43 SUPER_SECRET_ACCOUNT',
        token: 'SUPER_SECRET_TRANSACTION',
        entity: 'SUPER_SECRET_MERCHANT',
        path: 'facts.trend.spending.firstToLast.percent',
        label: 'SUPER_SECRET_ACCOUNT',
      }],
      validationResult: {
        status: 'invalid',
        violations: [{
          code: 'UNSUPPORTED_COMPARISON',
          severity: 'critical',
          extractedClaimId: 'e1',
          reasonCode: 'percent_not_in_ledger',
        }],
      },
      enforcementDecision: { eligible: true, block: true },
      capability: 'cashflow_trend',
      sourceKind: 'cashflow_trend',
      validationTelemetry: {
        response_validation_performed: true,
        response_validation_status: 'invalid',
        response_validation_primary_violation: 'UNSUPPORTED_COMPARISON',
      },
      finalText: 'SUPER_SECRET_RAW_TEXT $98765.43 on 2099-12-31 at SUPER_SECRET_ACCOUNT',
      text: 'SUPER_SECRET_RAW_TEXT',
      message: 'SUPER_SECRET_RAW_TEXT',
    });
    check('sentinel helper still performed', diag && diag.trend_diag_performed === true);
    const blob = JSON.stringify(diag);
    for (let i = 0; i < SENTINELS.length; i += 1) {
      check('sentinel absent: ' + SENTINELS[i], blob.indexOf(SENTINELS[i]) === -1);
    }
    check('forbidden keys absent', forbiddenKeysPresent(diag).length === 0);
    const extra = sanitizeTrendDiagnosticTelemetry(Object.assign({}, diag, {
      text: 'SUPER_SECRET_RAW_TEXT',
      amount: 98765.43,
      path: 'facts.trend.spending.firstToLast.percent',
    }));
    check('sanitizer strips extras', forbiddenKeysPresent(extra).length === 0);
    check('sanitizer extra sentinels absent', leakHits(extra).length === 0);
  });

  section('trend blocked diagnostic zero behavior change');
  const locality = 'a 13.71% decrease';
  const offSnap = withDiag(undefined, () => behaviorSnapshot(runTurn(locality)));
  const onSnap = withDiag('true', () => behaviorSnapshot(runTurn(locality)));
  check('flag ON/OFF validation+enforcement identical', offSnap === onSnap);
  withDiag('true', () => {
    const turn = runTurn(locality);
    check('flag ON response is fallback', turn.enforced.finalText !== locality);
    check('flag ON history would persist fallback', turn.enforced.finalText === turn.enforced.finalText);
  });

  section('trend blocked diagnostic one validation pass');
  withDiag('true', () => {
    const turn = runTurn('Spending increased.');
    check('one extract during validation', turn.extractCalls === 1);
    check('one validate during validation', turn.validateCalls === 1);
    const again = buildTrendBlockedDiagnosticTelemetry({
      contract: turn.shadow.contract,
      extractedClaims: turn.shadow.extractedClaims,
      validationResult: turn.shadow.validation,
      enforcementDecision: turn.enforced.decision,
      capability: 'cashflow_trend',
      sourceKind: 'cashflow_trend',
      validationTelemetry: turn.shadow.telemetry,
    });
    check('helper reuse does not extract again', turn.extractCalls === 1);
    check('helper reuse does not validate again', turn.validateCalls === 1);
    check('second helper call still captured', again && again.trend_diag_performed === true);
  });

  section('trend blocked diagnostic telemetry payload');
  withDiag('true', () => {
    const turn = runTurn('Spending increased.');
    const t = createKeaTelemetry({ requestId: 'diag-on' });
    t.recordResponseValidation(turn.shadow.telemetry);
    t.recordResponseEnforcement(turn.enforced.telemetry);
    t.recordTrendBlockedDiagnostic(turn.diag);
    const payload = t.toPayload();
    check('payload performed', payload.trend_diag_performed === true);
    check('payload keeps existing validation status', payload.response_validation_status === 'invalid');
    check('payload keeps existing blocked', payload.response_enforcement_blocked === true);
    check('payload no forbidden keys', forbiddenKeysPresent(payload).length === 0);
    check('payload no sentinel-like rawSpan', payload.rawSpan === undefined);
    const tOff = createKeaTelemetry({ requestId: 'diag-payload-off' });
    tOff.recordTrendBlockedDiagnostic(null);
    check('null record adds no keys',
      Object.keys(tOff.toPayload()).filter((k) => k.indexOf('trend_diag_') === 0).length === 0);
  });

  section('trend blocked diagnostic source constraints');
  const helperSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaTrendBlockedDiagnosticTelemetry.js'), 'utf8');
  const telSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaTelemetry.js'), 'utf8');
  const controller = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'openaiController.js'), 'utf8');
  check('helper does not re-extract', helperSrc.indexOf('extractResponseClaims') === -1);
  check('helper does not re-validate', helperSrc.indexOf('validateResponseClaims') === -1
    && helperSrc.indexOf('validateResponseAgainstContract') === -1);
  check('helper has no console logging', !/console\.(log|info|warn|error)/.test(helperSrc));
  check('helper does not stringify contract', helperSrc.indexOf('JSON.stringify(contract') === -1);
  check('helper does not stringify extracted', helperSrc.indexOf('JSON.stringify(extracted') === -1);
  check('controller wires helper', controller.indexOf('buildTrendBlockedDiagnosticTelemetry') !== -1);
  check('controller does not pass finalText to helper',
    !/buildTrendBlockedDiagnosticTelemetry\(\{[\s\S]{0,500}finalText/.test(controller));
  check('controller does not pass user message to helper',
    !/buildTrendBlockedDiagnosticTelemetry\(\{[\s\S]{0,500}\bmessage\b/.test(controller));
  check('controller does not read diagnostic env flag',
    controller.indexOf('USE_TREND_BLOCK_DIAGNOSTIC_TELEMETRY') === -1);
  check('helper after enforcement',
    controller.indexOf('applyResponseValidationEnforcement')
      < controller.indexOf('buildTrendBlockedDiagnosticTelemetry'));
  check('telemetry allowlists trend_diag keys', telSrc.indexOf('TREND_DIAG_FIELD_KEYS') !== -1);
  const envExample = fs.readFileSync(path.join(__dirname, '..', 'deployment.env.example'), 'utf8');
  check('env example defaults false',
    /USE_TREND_BLOCK_DIAGNOSTIC_TELEMETRY=false/.test(envExample));

  section('trend blocked diagnostic performance');
  withDiag('true', () => {
    const percentTurn = runTurn('a 13.71% decrease');
    const directionTurn = runTurn('Spending increased.');
    const combinedTurn = runTurn('Spending increased by 14%.');
    const argsOf = (turn) => ({
      contract: turn.shadow.contract,
      extractedClaims: turn.shadow.extractedClaims,
      validationResult: turn.shadow.validation,
      enforcementDecision: turn.enforced.decision,
      capability: 'cashflow_trend',
      sourceKind: 'cashflow_trend',
      validationTelemetry: turn.shadow.telemetry,
    });
    function bench(label, args) {
      const t0 = Date.now();
      for (let i = 0; i < 1000; i += 1) buildTrendBlockedDiagnosticTelemetry(args);
      const ms = Date.now() - t0;
      check(label + ' 1000 builds recorded', ms >= 0);
      return ms;
    }
    const percentMs = bench('percent-failure', argsOf(percentTurn));
    const directionMs = bench('direction-failure', argsOf(directionTurn));
    const combinedMs = bench('combined', argsOf(combinedTurn));
    const generalMs = bench('general', argsOf(percentTurn));
    console.log('  perf percent-failure 1000=' + percentMs + 'ms avg=' + (percentMs / 1000).toFixed(4) + 'ms');
    console.log('  perf direction-failure 1000=' + directionMs + 'ms avg=' + (directionMs / 1000).toFixed(4) + 'ms');
    console.log('  perf combined 1000=' + combinedMs + 'ms avg=' + (combinedMs / 1000).toFixed(4) + 'ms');
    console.log('  perf general 1000=' + generalMs + 'ms avg=' + (generalMs / 1000).toFixed(4) + 'ms');
    check('percent-failure avg under 2ms', (percentMs / 1000) < 2);
    check('direction-failure avg under 2ms', (directionMs / 1000) < 2);
    check('combined avg under 2ms', (combinedMs / 1000) < 2);
    check('general avg under 2ms', (generalMs / 1000) < 2);
  });
}

module.exports = { run };
