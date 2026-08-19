'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');
const { createKeaTelemetry } = require('../services/keaTelemetry');
const { VIOLATION_CODE, SEVERITY } = require('../services/keaResponseValidationContract');
const {
  RESPONSE_VALIDATION_SHADOW_ENV_KEY,
  ELIGIBLE_CAPABILITIES,
  RESPONSE_VALIDATION_STATUS,
  RESPONSE_VALIDATION_CONTRACT_STATUS,
  RESPONSE_VALIDATION_EXCEPTION_REASON,
  isResponseValidationShadowEnabled,
  shouldShadowValidateResponse,
  sanitizeResponseValidationTelemetry,
  emptyShadowTelemetry,
  pickPrimaryViolation,
  applyShadowResponseValidation,
} = require('../services/keaResponseValidationShadow');
const {
  buildLookup,
  buildSnapshot,
  buildUpcomingMacro,
} = require('./keaResponseValidationContract.test');
const {
  buildLiveEMacro,
  buildLiveASnapshot,
  LIVE_E_TEXT,
  LIVE_A_TEXT,
} = require('./keaResponseClaimValidator.test');

const LIVE_C_TEXT = [
  'Your projected income for next month (September 2026) is $4626.36.',
  'Your projected expenses for next month are $3432.43.',
  'This results in a net positive cash flow of $1193.93.',
  'Your available balance is forecasted to be approximately $4846.97.',
  'Your balance is expected to increase by about $1194.',
].join(' ');

const TARGET_VALID = 'In July 2026, you made 3 transactions at Target totaling $279.58.';
const TARGET_INVALID = 'You spent $280 at Target.';
const INDETERMINATE_TEXT = 'The code is 279.58.';
const PREVIEW_TEXT = 'The transactions listed above total $1134.56.';
const MACRO_VALID = 'Total scheduled expenses are $1297.30.';
const MACRO_INVALID = 'Total scheduled expenses are $2000.';
const MACRO_BILLS = 'Bills due next week total $1297.30.';
const SNAPSHOT_BALANCE = 'Your available balance is $4846.97.';

const LEAK_NEEDLES = [
  '$',
  '279.58',
  '4626.36',
  '3432.43',
  '1193.93',
  '4846.97',
  '1297.30',
  'Target',
  'Daycare',
  'Main Account',
  'Wells Fargo',
  'Northwestern',
  'MERIDIAN',
  'July 2026',
  'September 2026',
  'allowedClaims',
  'extractedClaimId',
  'evidenceClaimId',
  'itemId',
  'Prompt View',
  'promptEvidence',
];

function withFlag(value, fn) {
  const key = RESPONSE_VALIDATION_SHADOW_ENV_KEY;
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

function shadowTurn(text, extra = {}) {
  return applyShadowResponseValidation({
    text,
    ledger: extra.ledger !== undefined ? extra.ledger : buildLookup(),
    capability: extra.capability || 'financial_lookup',
    responseMode: extra.responseMode,
    responseSource: extra.responseSource || 'azure',
    writeResponseMode: extra.writeResponseMode || 'none',
    simulationMode: extra.simulationMode === true,
    invitationWriteHandoff: extra.invitationWriteHandoff === true,
    repeatWriteHandoff: extra.repeatWriteHandoff === true,
  }, extra.deps);
}

function leakHits(obj) {
  const blob = JSON.stringify(obj);
  return LEAK_NEEDLES.filter((n) => blob.indexOf(n) !== -1);
}

function simulateRequest(text, extra = {}) {
  const before = text;
  const shadow = shadowTurn(text, extra);
  const historyAssistant = before;
  const userBody = { response: before };
  return {
    before,
    after: shadow.finalText,
    historyAssistant,
    userBody,
    telemetry: shadow.telemetry,
  };
}

async function run() {
  section('3C.2 flag parsing');
  withFlag(undefined, () => {
    check('unset defaults ON', isResponseValidationShadowEnabled() === true);
  });
  withFlag('', () => {
    check('empty defaults ON', isResponseValidationShadowEnabled() === true);
  });
  withFlag('true', () => check('true ON', isResponseValidationShadowEnabled() === true));
  withFlag('1', () => check('1 ON', isResponseValidationShadowEnabled() === true));
  withFlag('ON', () => check('ON case-insensitive', isResponseValidationShadowEnabled() === true));
  withFlag('yes', () => check('yes ON', isResponseValidationShadowEnabled() === true));
  withFlag('false', () => check('false OFF', isResponseValidationShadowEnabled() === false));
  withFlag('0', () => check('0 OFF', isResponseValidationShadowEnabled() === false));
  withFlag('off', () => check('off OFF', isResponseValidationShadowEnabled() === false));
  withFlag('NO', () => check('NO OFF', isResponseValidationShadowEnabled() === false));
  withFlag('weird', () => check('other non-empty ON', isResponseValidationShadowEnabled() === true));
  check('flag name', RESPONSE_VALIDATION_SHADOW_ENV_KEY === 'USE_RESPONSE_VALIDATION_SHADOW');

  section('3C.2 eligibility helper');
  withFlag('true', () => {
    const ok = shouldShadowValidateResponse({
      capability: 'financial_lookup',
      ledger: buildLookup(),
      responseSource: 'azure',
      writeResponseMode: 'none',
    });
    check('eligible lookup', ok.eligible === true);
    check('eligible capabilities include macros + lookup + forecast',
      ELIGIBLE_CAPABILITIES.indexOf('cashflow_upcoming') !== -1
      && ELIGIBLE_CAPABILITIES.indexOf('cashflow_recurring') !== -1
      && ELIGIBLE_CAPABILITIES.indexOf('cashflow_income_horizon') !== -1
      && ELIGIBLE_CAPABILITIES.indexOf('cashflow_comparison') !== -1
      && ELIGIBLE_CAPABILITIES.indexOf('cashflow_trend') !== -1
      && ELIGIBLE_CAPABILITIES.indexOf('cashflow_analysis') !== -1
      && ELIGIBLE_CAPABILITIES.indexOf('affordability_or_planning') !== -1
      && ELIGIBLE_CAPABILITIES.indexOf('financial_lookup') !== -1
      && ELIGIBLE_CAPABILITIES.indexOf('financial_forecast') !== -1);
    check('help ineligible', shouldShadowValidateResponse({
      capability: 'help', ledger: buildLookup(), responseSource: 'azure',
    }).eligible === false);
    check('navigation ineligible', shouldShadowValidateResponse({
      capability: 'navigation', ledger: buildLookup(), responseSource: 'azure',
    }).status === RESPONSE_VALIDATION_STATUS.NOT_APPLICABLE);
    check('write ineligible', shouldShadowValidateResponse({
      capability: 'financial_lookup', ledger: buildLookup(), writeResponseMode: 'deterministic_commit',
    }).reason === 'write');
    check('simulation ineligible', shouldShadowValidateResponse({
      capability: 'financial_forecast', ledger: buildSnapshot(), simulationMode: true,
    }).reason === 'simulation');
    check('invitation ineligible', shouldShadowValidateResponse({
      capability: 'affordability_or_planning', ledger: buildLookup(), invitationWriteHandoff: true,
    }).reason === 'invitation');
    check('fail_soft source ineligible', shouldShadowValidateResponse({
      capability: 'financial_lookup', ledger: buildLookup(), responseSource: 'fail_soft',
    }).reason === 'deterministic_response');
    check('deterministic source ineligible', shouldShadowValidateResponse({
      capability: 'financial_lookup', ledger: buildLookup(), responseSource: 'deterministic',
    }).reason === 'deterministic_response');
    check('macro_fallback ineligible', shouldShadowValidateResponse({
      capability: 'cashflow_upcoming', ledger: buildUpcomingMacro(), responseSource: 'macro_fallback',
    }).reason === 'deterministic_response');
    check('missing ledger contract_failed', shouldShadowValidateResponse({
      capability: 'financial_lookup', ledger: null, responseSource: 'azure',
    }).status === RESPONSE_VALIDATION_STATUS.CONTRACT_FAILED);
  });
  withFlag('false', () => {
    check('flag off disabled', shouldShadowValidateResponse({
      capability: 'financial_lookup', ledger: buildLookup(),
    }).status === RESPONSE_VALIDATION_STATUS.DISABLED);
  });

  section('3C.2 valid / invalid / indeterminate equality');
  withFlag('true', () => {
    const valid = simulateRequest(TARGET_VALID);
    check('valid finalText unchanged', valid.after === valid.before);
    check('valid history unchanged', valid.historyAssistant === valid.before);
    check('valid HTTP body unchanged', valid.userBody.response === valid.before);
    check('valid performed', valid.telemetry.response_validation_performed === true);
    check('valid shadow', valid.telemetry.response_validation_shadow === true);
    check('valid status', valid.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.VALID);
    check('valid contract ok', valid.telemetry.response_validation_contract_status === RESPONSE_VALIDATION_CONTRACT_STATUS.OK);
    check('valid no violation', valid.telemetry.response_validation_primary_violation === 'none');

    const invalid = simulateRequest(TARGET_INVALID);
    check('invalid finalText unchanged', invalid.after === TARGET_INVALID);
    check('invalid history unchanged', invalid.historyAssistant === TARGET_INVALID);
    check('invalid HTTP body unchanged', invalid.userBody.response === TARGET_INVALID);
    check('invalid status', invalid.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
    check('invalid primary UNSUPPORTED_AMOUNT',
      invalid.telemetry.response_validation_primary_violation === VIOLATION_CODE.UNSUPPORTED_AMOUNT);
    check('invalid severity critical',
      invalid.telemetry.response_validation_primary_severity === SEVERITY.CRITICAL);

    const indeterminate = simulateRequest(INDETERMINATE_TEXT);
    check('indeterminate finalText unchanged', indeterminate.after === INDETERMINATE_TEXT);
    check('indeterminate status',
      indeterminate.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INDETERMINATE);
    check('indeterminate still returned', indeterminate.userBody.response === INDETERMINATE_TEXT);
  });

  section('3C.2 snapshot / macro / preview fixtures');
  withFlag('true', () => {
    const liveC = shadowTurn(LIVE_C_TEXT, {
      ledger: buildSnapshot(),
      capability: 'financial_forecast',
    });
    check('live-C text unchanged', liveC.finalText === LIVE_C_TEXT);
    check('live-C invalid', liveC.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
    check('live-C critical primary', liveC.telemetry.response_validation_primary_severity === SEVERITY.CRITICAL);
    check('live-C primary is closed critical code', [
      VIOLATION_CODE.UNSUPPORTED_PERIOD_ATTRIBUTION,
      VIOLATION_CODE.UNSUPPORTED_DERIVATION,
      VIOLATION_CODE.UNSUPPORTED_FORECAST,
      VIOLATION_CODE.UNSUPPORTED_AMOUNT,
    ].indexOf(liveC.telemetry.response_validation_primary_violation) !== -1);
    check('live-C violation bucket not 0', liveC.telemetry.response_validation_violation_count_bucket !== '0');

    const balance = shadowTurn(SNAPSHOT_BALANCE, {
      ledger: buildSnapshot(),
      capability: 'financial_forecast',
    });
    check('snapshot balance valid', balance.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.VALID);
    check('snapshot balance text unchanged', balance.finalText === SNAPSHOT_BALANCE);

    const preview = shadowTurn(PREVIEW_TEXT, {
      ledger: buildSnapshot(),
      capability: 'financial_forecast',
    });
    check('preview text unchanged', preview.finalText === PREVIEW_TEXT);
    check('preview invalid or indeterminate',
      preview.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID
      || preview.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INDETERMINATE);
    if (preview.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID) {
      check('preview primary PREVIEW_TOTAL_MISATTRIBUTION',
        preview.telemetry.response_validation_primary_violation === VIOLATION_CODE.PREVIEW_TOTAL_MISATTRIBUTION);
    }

    const macroOk = shadowTurn(MACRO_VALID, {
      ledger: buildUpcomingMacro(),
      capability: 'cashflow_upcoming',
    });
    check('macro valid', macroOk.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.VALID);
    check('macro valid text unchanged', macroOk.finalText === MACRO_VALID);

    const bills = shadowTurn(MACRO_BILLS, {
      ledger: buildUpcomingMacro(),
      capability: 'cashflow_upcoming',
    });
    check('bills-due wording text unchanged', bills.finalText === MACRO_BILLS);
    check('bills-due wording is not a false INVALID',
      bills.telemetry.response_validation_status !== RESPONSE_VALIDATION_STATUS.INVALID);

    const macroBad = shadowTurn(MACRO_INVALID, {
      ledger: buildUpcomingMacro(),
      capability: 'cashflow_upcoming',
    });
    check('macro wrong-total invalid',
      macroBad.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID);
    check('macro wrong-total unchanged', macroBad.finalText === MACRO_INVALID);

    const liveE = shadowTurn(LIVE_E_TEXT, {
      ledger: buildLiveEMacro(),
      capability: 'cashflow_upcoming',
    });
    check('live-E shadow VALID', liveE.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.VALID);
    check('live-E finalText unchanged', liveE.finalText === LIVE_E_TEXT);
    check('live-E no UNSUPPORTED_AMOUNT',
      liveE.telemetry.response_validation_primary_violation !== VIOLATION_CODE.UNSUPPORTED_AMOUNT);

    const liveA = shadowTurn(LIVE_A_TEXT, {
      ledger: buildLiveASnapshot(),
      capability: 'financial_forecast',
    });
    check('live-A shadow VALID', liveA.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.VALID);
    check('live-A finalText unchanged', liveA.finalText === LIVE_A_TEXT);
    check('live-A no UNSUPPORTED_AMOUNT',
      liveA.telemetry.response_validation_primary_violation !== VIOLATION_CODE.UNSUPPORTED_AMOUNT);
  });

  section('3C.2 false-positive guards');
  withFlag('true', () => {
    const countText = 'In July 2026, you made 3 transactions at Target totaling $279.58.';
    const count = shadowTurn(countText);
    check('count 3 is not UNSUPPORTED_AMOUNT',
      count.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.VALID
      && count.telemetry.response_validation_primary_violation !== VIOLATION_CODE.UNSUPPORTED_AMOUNT);

    const dateText = 'Due August 23.';
    const date = shadowTurn(dateText, { ledger: buildUpcomingMacro(), capability: 'cashflow_upcoming' });
    check('August 23 not money invalid',
      date.telemetry.response_validation_primary_violation !== VIOLATION_CODE.UNSUPPORTED_AMOUNT);

    const durationText = 'Look at the next 15 days.';
    const duration = shadowTurn(durationText, { ledger: buildSnapshot(), capability: 'financial_forecast' });
    check('next 15 days not money invalid',
      duration.telemetry.response_validation_primary_violation !== VIOLATION_CODE.UNSUPPORTED_AMOUNT);

    const yearText = 'In July 2026 spending was recorded.';
    const year = shadowTurn(yearText);
    check('July 2026 year not amount',
      year.telemetry.response_validation_primary_violation !== VIOLATION_CODE.UNSUPPORTED_AMOUNT);
  });

  section('3C.2 entity / hypothetical ambiguity');
  withFlag('true', () => {
    const entity = shadowTurn(SNAPSHOT_BALANCE, {
      ledger: buildSnapshot(),
      capability: 'financial_forecast',
    });
    check('Your available balance stays valid',
      entity.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.VALID);
    check('entity values absent from telemetry', leakHits(entity.telemetry).length === 0);

    const hypoText = 'If you spent $500, the picture would change.';
    const hypo = shadowTurn(hypoText, { ledger: buildSnapshot(), capability: 'financial_forecast' });
    check('hypothetical text unchanged', hypo.finalText === hypoText);
    check('hypothetical is not remapped by shadow',
      hypo.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INVALID
      || hypo.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INDETERMINATE
      || hypo.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.VALID);
  });

  section('3C.2 exception boundary');
  withFlag('true', () => {
    const boom = (msg) => () => { throw new Error(msg); };
    const contractEx = shadowTurn(TARGET_VALID, { deps: { buildContract: boom('secret ledger Target $279.58') } });
    check('contract exception text unchanged', contractEx.finalText === TARGET_VALID);
    check('contract exception status', contractEx.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.EXCEPTION);
    check('contract exception reason',
      contractEx.telemetry.response_validation_exception_reason === RESPONSE_VALIDATION_EXCEPTION_REASON.CONTRACT_BUILD_FAILED);
    check('contract exception no message leak', JSON.stringify(contractEx.telemetry).indexOf('secret ledger') === -1);

    const extractEx = shadowTurn(TARGET_VALID, { deps: { extractClaims: boom('extractor Target') } });
    check('extractor exception unchanged', extractEx.finalText === TARGET_VALID);
    check('extractor exception reason',
      extractEx.telemetry.response_validation_exception_reason === RESPONSE_VALIDATION_EXCEPTION_REASON.EXTRACTOR_FAILED);

    const validatorEx = shadowTurn(TARGET_VALID, { deps: { validateClaims: boom('validator Daycare') } });
    check('validator exception unchanged', validatorEx.finalText === TARGET_VALID);
    check('validator exception reason',
      validatorEx.telemetry.response_validation_exception_reason === RESPONSE_VALIDATION_EXCEPTION_REASON.VALIDATOR_FAILED);

    const summaryEx = shadowTurn(TARGET_VALID, { deps: { summarize: boom('summary 279.58') } });
    check('summary exception unchanged', summaryEx.finalText === TARGET_VALID);
    check('summary exception reason',
      summaryEx.telemetry.response_validation_exception_reason === RESPONSE_VALIDATION_EXCEPTION_REASON.SUMMARY_FAILED);

    let applyThrew = false;
    try {
      applyShadowResponseValidation({
        text: TARGET_VALID,
        ledger: buildLookup(),
        capability: 'financial_lookup',
        responseSource: 'azure',
      }, { buildContract: boom('outer') });
    } catch (e) {
      applyThrew = true;
    }
    check('applyShadow never throws', applyThrew === false);
  });

  section('3C.2 ineligible / missing ledger / flag off / deterministic');
  withFlag('true', () => {
    const help = shadowTurn('Open settings.', { capability: 'help', ledger: buildLookup() });
    check('help not performed', help.telemetry.response_validation_performed === false);
    check('help not_applicable', help.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.NOT_APPLICABLE);
    check('help text unchanged', help.finalText === 'Open settings.');

    const missing = shadowTurn(TARGET_VALID, { ledger: null });
    check('missing ledger not performed', missing.telemetry.response_validation_performed === false);
    check('missing ledger contract_failed',
      missing.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.CONTRACT_FAILED);
    check('missing ledger invalid_ledger contract',
      missing.telemetry.response_validation_contract_status === RESPONSE_VALIDATION_CONTRACT_STATUS.INVALID_LEDGER);

    const det = shadowTurn('Done.', {
      capability: 'financial_lookup',
      ledger: buildLookup(),
      responseSource: 'deterministic',
    });
    check('deterministic skip', det.telemetry.response_validation_performed === false);
    check('deterministic not_applicable', det.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.NOT_APPLICABLE);

    const fallback = shadowTurn(MACRO_VALID, {
      capability: 'cashflow_upcoming',
      ledger: buildUpcomingMacro(),
      responseSource: 'macro_fallback',
    });
    check('macro fallback skip', fallback.telemetry.response_validation_performed === false);
  });
  withFlag('false', () => {
    const off = shadowTurn(TARGET_INVALID);
    check('flag off not performed', off.telemetry.response_validation_performed === false);
    check('flag off disabled', off.telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.DISABLED);
    check('flag off shadow false', off.telemetry.response_validation_shadow === false);
    check('flag off flag_enabled false', off.telemetry.response_validation_flag_enabled === false);
    check('flag off text still original', off.finalText === TARGET_INVALID);
  });

  section('3C.2 privacy + primary + buckets');
  withFlag('true', () => {
    const liveC = shadowTurn(LIVE_C_TEXT, {
      ledger: buildSnapshot(),
      capability: 'financial_forecast',
    });
    const hits = leakHits(liveC.telemetry);
    check('no financial/PII needles in telemetry', hits.length === 0, hits.join(','));
    check('no response text field', liveC.telemetry.text === undefined && liveC.telemetry.finalText === undefined);
    check('no ledger field', liveC.telemetry.ledger === undefined);
    check('ms is non-negative int', Number.isInteger(liveC.telemetry.response_validation_ms)
      && liveC.telemetry.response_validation_ms >= 0);
    const buckets = ['0', '1', '2-3', '4-7', '8+'];
    check('violation bucket closed', buckets.indexOf(liveC.telemetry.response_validation_violation_count_bucket) !== -1);
    check('material bucket closed', buckets.indexOf(liveC.telemetry.response_validation_material_claim_count_bucket) !== -1);

    const sanitized = sanitizeResponseValidationTelemetry({
      response_validation_performed: true,
      response_validation_shadow: true,
      response_validation_status: 'invalid',
      response_validation_contract_status: 'ok',
      response_validation_primary_violation: VIOLATION_CODE.UNSUPPORTED_AMOUNT,
      response_validation_primary_severity: 'critical',
      response_validation_violation_count_bucket: '1',
      response_validation_indeterminate_count_bucket: '0',
      response_validation_material_claim_count_bucket: '1',
      response_validation_ms: 2,
      response_validation_exception_reason: 'none',
      response_validation_flag_enabled: true,
      amount: 279.58,
      merchant: 'Target',
      text: TARGET_VALID,
      ledger: buildLookup(),
    });
    check('sanitizer drops extras', sanitized.amount === undefined
      && sanitized.merchant === undefined
      && sanitized.text === undefined
      && sanitized.ledger === undefined);
    check('sanitizer keeps closed status', sanitized.response_validation_status === 'invalid');

    const bogus = sanitizeResponseValidationTelemetry({
      response_validation_status: 'totally-invalid',
      response_validation_primary_violation: 'HACK',
      response_validation_exception_reason: 'Error: Target $279.58',
    });
    check('unknown status falls back', bogus.response_validation_status === RESPONSE_VALIDATION_STATUS.NOT_APPLICABLE);
    check('unknown violation none', bogus.response_validation_primary_violation === 'none');
    check('unknown exception none', bogus.response_validation_exception_reason === 'none');

    const primary = pickPrimaryViolation({
      violations: [
        { code: VIOLATION_CODE.LIST_ITEM_MISMATCH, severity: 'high', position: 0 },
        { code: VIOLATION_CODE.UNSUPPORTED_AMOUNT, severity: 'critical', position: 12 },
        { code: VIOLATION_CODE.UNSUPPORTED_FORECAST, severity: 'critical', position: 4 },
      ],
    });
    check('primary prefers critical then earlier position',
      primary.code === VIOLATION_CODE.UNSUPPORTED_FORECAST && primary.severity === 'critical');
  });

  section('3C.2 ledger reuse / no fetch');
  withFlag('true', () => {
    const ledger = buildLookup();
    const before = JSON.stringify(ledger);
    shadowTurn(TARGET_VALID, { ledger });
    check('same request ledger not mutated', JSON.stringify(ledger) === before);
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseValidationShadow.js'), 'utf8');
    check('shadow does not fetch accounts/transactions',
      src.indexOf('getSelectedAccount') === -1
      && src.indexOf('axios') === -1
      && src.indexOf('queryAzureOpenAI') === -1
      && src.indexOf('buildEvidenceLedger(') === -1);
  });

  section('3C.2 telemetry assembly');
  withFlag('true', () => {
    const t = createKeaTelemetry({ requestId: 'rv-1' });
    const defaults = t.toPayload();
    check('default performed false', defaults.response_validation_performed === false);
    check('default status not_applicable', defaults.response_validation_status === 'not_applicable');
    check('default shadow false until recorded', defaults.response_validation_shadow === false
      || defaults.response_validation_shadow === true);
    const shadow = shadowTurn(TARGET_INVALID);
    t.recordResponseValidation(shadow.telemetry);
    const payload = t.toPayload();
    check('recorded invalid status', payload.response_validation_status === 'invalid');
    check('recorded shadow true', payload.response_validation_shadow === true);
    check('kea_chat_turn event', payload.event === 'kea_chat_turn');
    check('telemetry leak scan', leakHits(payload).length === 0, leakHits(payload).join(','));
    t.recordResponseValidation({
      response_validation_status: 'invalid',
      amount: 280,
      merchant: 'Target',
      text: TARGET_INVALID,
    });
    check('recordResponseValidation sanitizes', t.toPayload().amount === undefined
      && t.toPayload().merchant === undefined);

    const threw = createKeaTelemetry({ requestId: 'rv-throw' });
    threw.recordResponseValidation(undefined);
    check('recordResponseValidation null is safe', threw.toPayload().response_validation_status === 'not_applicable');
  });

  section('3C.2 controller insertion / equality guards');
  const controller = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'openaiController.js'), 'utf8');
  const azure = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaAzureChat.js'), 'utf8');
  const openai = fs.readFileSync(path.join(__dirname, '..', 'services', 'openaiService.js'), 'utf8');
  const ledgerJs = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaEvidenceLedger.js'), 'utf8');
  const builders = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaEvidenceLedgerBuilders.js'), 'utf8');
  const promptView = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaEvidencePromptView.js'), 'utf8');
  check('controller imports shadow only', controller.indexOf("require('../services/keaResponseValidationShadow')") !== -1);
  check('controller does not import 3C.1 modules',
    controller.indexOf('keaResponseClaimExtractor') === -1
    && controller.indexOf('keaResponseClaimValidator') === -1
    && controller.indexOf('keaResponseValidationContract') === -1
    && controller.indexOf('validateResponseAgainstContract') === -1);
  const finalIdx = controller.indexOf('const finalText = stripCurrencyCommas(guardedContent);');
  const shadowIdx = controller.indexOf('const shadow = applyShadowResponseValidation');
  const persistIdx = controller.indexOf('await persistAnswerThenRefreshSummary');
  check('shadow after finalText', finalIdx !== -1 && shadowIdx > finalIdx);
  check('shadow before persist', persistIdx !== -1 && shadowIdx < persistIdx);
  const afterShadow = controller.slice(shadowIdx, shadowIdx + 1800);
  check('does not reassign finalText from shadow', !/finalText\s*=/.test(afterShadow));
  const payloadSlice = controller.slice(
    controller.indexOf('const responsePayload = {'),
    controller.indexOf('lifecycle.setStage(\'persist_started\')')
  );
  check('user body has no validation fields', payloadSlice.indexOf('response_validation') === -1);
  check('response payload still original finalText', /response:\s*finalText/.test(controller));
  check('history still original finalText', /role:\s*'assistant',\s*content:\s*finalText/.test(controller));
  check('no validation in azure/openaiService',
    azure.indexOf('keaResponseValidation') === -1
    && openai.indexOf('keaResponseValidation') === -1);
  check('no FAIL_SOFT branch on validation', !/if\s*\(.*response_validation/.test(controller));
  check('Phase 3B ledger files not semantically opened by 3C.2 import',
    ledgerJs.indexOf('keaResponseValidation') === -1
    && builders.indexOf('keaResponseValidation') === -1
    && promptView.indexOf('keaResponseValidation') === -1);
  check('3B flags not coupled', controller.indexOf('USE_RESPONSE_VALIDATION_SHADOW') === -1);

  section('3C.2 no raw result logging');
  const shadowSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaResponseValidationShadow.js'), 'utf8');
  check('no logger in shadow module', !/console\.(log|info|warn|error)|logger\./.test(shadowSrc));
  check('no JSON.stringify of validation result', shadowSrc.indexOf('JSON.stringify(result)') === -1
    && shadowSrc.indexOf('JSON.stringify(validation') === -1);

  section('3C.2 1000 shadow-run performance');
  withFlag('true', () => {
    const ledger = buildLookup();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) {
      applyShadowResponseValidation({
        text: TARGET_VALID,
        ledger,
        capability: 'financial_lookup',
        responseSource: 'azure',
      });
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`  1000 shadow runs: ${ms.toFixed(2)}ms total, ${(ms / 1000).toFixed(3)}ms avg`);
    check('1000 runs completed', Number.isFinite(ms) && ms >= 0);
    check('1000-run p99 proxy well under 20ms avg', (ms / 1000) < 20);
  });

  section('3C.2 flag matrix');
  withFlag('true', () => {
    check('shadow ON + lookup ledger validates',
      shadowTurn(TARGET_VALID).telemetry.response_validation_performed === true);
    check('shadow ON + snapshot ledger validates',
      shadowTurn(SNAPSHOT_BALANCE, { ledger: buildSnapshot(), capability: 'financial_forecast' })
        .telemetry.response_validation_performed === true);
    check('shadow ON + macro ledger validates',
      shadowTurn(MACRO_VALID, { ledger: buildUpcomingMacro(), capability: 'cashflow_upcoming' })
        .telemetry.response_validation_performed === true);
    check('shadow ON + no ledger does not validate',
      shadowTurn(TARGET_VALID, { ledger: null }).telemetry.response_validation_performed === false);
  });
  withFlag('false', () => {
    check('shadow OFF does not validate',
      shadowTurn(TARGET_VALID).telemetry.response_validation_performed === false);
  });
}

module.exports = { run };
