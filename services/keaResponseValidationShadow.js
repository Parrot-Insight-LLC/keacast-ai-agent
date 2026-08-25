'use strict';

/**
 * Phase 3C.2 — production shadow response validation.
 *
 * Observes Azure finalText against the same-request EvidenceLedgerV1.
 * Never mutates the response. Never retries Azure. Never fail-softs.
 */

const { parseLedgerPromptFlag } = require('./keaEvidencePromptCutover');
const { LEDGER_STATUS } = require('./keaEvidenceLedger');
const {
  VALIDATION_STATUS,
  SEVERITY,
  VIOLATION_CODE,
  buildResponseValidationContract,
} = require('./keaResponseValidationContract');
const { CLAIM_KIND, extractResponseClaims } = require('./keaResponseClaimExtractor');
const {
  validateResponseClaims,
  summarizeValidationResult,
} = require('./keaResponseClaimValidator');

const RESPONSE_VALIDATION_SHADOW_ENV_KEY = 'USE_RESPONSE_VALIDATION_SHADOW';

const ELIGIBLE_CAPABILITIES = Object.freeze([
  'cashflow_upcoming',
  'cashflow_recurring',
  'cashflow_income_horizon',
  'cashflow_comparison',
  'cashflow_trend',
  'cashflow_analysis',
  'affordability_or_planning',
  'financial_lookup',
  'financial_forecast',
]);

const RESPONSE_VALIDATION_STATUS = Object.freeze({
  NOT_APPLICABLE: 'not_applicable',
  DISABLED: 'disabled',
  VALID: 'valid',
  INVALID: 'invalid',
  INDETERMINATE: 'indeterminate',
  CONTRACT_FAILED: 'contract_failed',
  EXCEPTION: 'exception',
});

const RESPONSE_VALIDATION_CONTRACT_STATUS = Object.freeze({
  OK: 'ok',
  NOT_PROMPTABLE: 'not_promptable',
  INVALID_LEDGER: 'invalid_ledger',
  BUILD_FAILED: 'build_failed',
  NOT_APPLICABLE: 'not_applicable',
});

const RESPONSE_VALIDATION_EXCEPTION_REASON = Object.freeze({
  NONE: 'none',
  CONTRACT_BUILD_FAILED: 'contract_build_failed',
  EXTRACTOR_FAILED: 'extractor_failed',
  VALIDATOR_FAILED: 'validator_failed',
  SUMMARY_FAILED: 'summary_failed',
  VALIDATION_EXCEPTION: 'validation_exception',
});

const RESPONSE_VALIDATION_COUNT_BUCKETS = Object.freeze(['0', '1', '2-3', '4-7', '8+']);

const SEVERITY_RANK = Object.freeze({
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
});

const VIOLATION_CODES = Object.freeze(Object.keys(VIOLATION_CODE).map((k) => VIOLATION_CODE[k]));

const MATERIAL_KINDS = Object.freeze([
  CLAIM_KIND.AMOUNT,
  CLAIM_KIND.COUNT,
  CLAIM_KIND.ENTITY_AMOUNT,
  CLAIM_KIND.ENTITY_AMOUNT_DATE,
]);

function pickEnum(value, allowed, fallback) {
  return allowed.indexOf(value) === -1 ? fallback : value;
}

function validationCountBucket(n) {
  const count = Number(n) || 0;
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 7) return '4-7';
  return '8+';
}

function isResponseValidationShadowEnabled() {
  return parseLedgerPromptFlag(process.env[RESPONSE_VALIDATION_SHADOW_ENV_KEY]).enabled;
}

function emptyShadowTelemetry(overrides = {}) {
  return Object.assign({
    response_validation_performed: false,
    response_validation_shadow: false,
    response_validation_status: RESPONSE_VALIDATION_STATUS.NOT_APPLICABLE,
    response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.NOT_APPLICABLE,
    response_validation_primary_violation: 'none',
    response_validation_primary_severity: 'none',
    response_validation_violation_count_bucket: '0',
    response_validation_indeterminate_count_bucket: '0',
    response_validation_material_claim_count_bucket: '0',
    response_validation_ms: 0,
    response_validation_exception_reason: RESPONSE_VALIDATION_EXCEPTION_REASON.NONE,
    response_validation_flag_enabled: isResponseValidationShadowEnabled(),
  }, overrides);
}

function sanitizeResponseValidationTelemetry(input) {
  const base = emptyShadowTelemetry({
    response_validation_flag_enabled: false,
  });
  if (!input || typeof input !== 'object') return base;
  try {
    const status = pickEnum(
      input.response_validation_status,
      Object.keys(RESPONSE_VALIDATION_STATUS).map((k) => RESPONSE_VALIDATION_STATUS[k]),
      RESPONSE_VALIDATION_STATUS.NOT_APPLICABLE
    );
    const contractStatus = pickEnum(
      input.response_validation_contract_status,
      Object.keys(RESPONSE_VALIDATION_CONTRACT_STATUS).map((k) => RESPONSE_VALIDATION_CONTRACT_STATUS[k]),
      RESPONSE_VALIDATION_CONTRACT_STATUS.NOT_APPLICABLE
    );
    const exceptionReason = pickEnum(
      input.response_validation_exception_reason,
      Object.keys(RESPONSE_VALIDATION_EXCEPTION_REASON).map((k) => RESPONSE_VALIDATION_EXCEPTION_REASON[k]),
      RESPONSE_VALIDATION_EXCEPTION_REASON.NONE
    );
    const violation = input.response_validation_primary_violation === 'none'
      || input.response_validation_primary_violation == null
      ? 'none'
      : pickEnum(input.response_validation_primary_violation, VIOLATION_CODES, 'none');
    const severity = input.response_validation_primary_severity === 'none'
      || input.response_validation_primary_severity == null
      ? 'none'
      : pickEnum(
        input.response_validation_primary_severity,
        [SEVERITY.CRITICAL, SEVERITY.HIGH, SEVERITY.MEDIUM, SEVERITY.LOW],
        'none'
      );
    const ms = Number(input.response_validation_ms);
    return {
      response_validation_performed: input.response_validation_performed === true,
      response_validation_shadow: input.response_validation_shadow === true,
      response_validation_status: status,
      response_validation_contract_status: contractStatus,
      response_validation_primary_violation: violation,
      response_validation_primary_severity: severity,
      response_validation_violation_count_bucket: pickEnum(
        input.response_validation_violation_count_bucket,
        RESPONSE_VALIDATION_COUNT_BUCKETS,
        '0'
      ),
      response_validation_indeterminate_count_bucket: pickEnum(
        input.response_validation_indeterminate_count_bucket,
        RESPONSE_VALIDATION_COUNT_BUCKETS,
        '0'
      ),
      response_validation_material_claim_count_bucket: pickEnum(
        input.response_validation_material_claim_count_bucket,
        RESPONSE_VALIDATION_COUNT_BUCKETS,
        '0'
      ),
      response_validation_ms: Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : 0,
      response_validation_exception_reason: exceptionReason,
      response_validation_flag_enabled: input.response_validation_flag_enabled === true,
    };
  } catch (err) {
    return emptyShadowTelemetry({
      response_validation_status: RESPONSE_VALIDATION_STATUS.EXCEPTION,
      response_validation_exception_reason: RESPONSE_VALIDATION_EXCEPTION_REASON.VALIDATION_EXCEPTION,
      response_validation_flag_enabled: isResponseValidationShadowEnabled(),
    });
  }
}

function shouldShadowValidateResponse(input = {}) {
  const flagEnabled = input.flagEnabled != null
    ? input.flagEnabled === true
    : isResponseValidationShadowEnabled();
  if (!flagEnabled) {
    return { eligible: false, status: RESPONSE_VALIDATION_STATUS.DISABLED, reason: 'flag_off' };
  }
  const writeMode = input.writeResponseMode || 'none';
  if (writeMode && writeMode !== 'none') {
    return { eligible: false, status: RESPONSE_VALIDATION_STATUS.NOT_APPLICABLE, reason: 'write' };
  }
  if (input.simulationMode === true) {
    return { eligible: false, status: RESPONSE_VALIDATION_STATUS.NOT_APPLICABLE, reason: 'simulation' };
  }
  if (input.invitationWriteHandoff === true || input.repeatWriteHandoff === true) {
    return { eligible: false, status: RESPONSE_VALIDATION_STATUS.NOT_APPLICABLE, reason: 'invitation' };
  }
  if (input.responseMode === 'fail_soft' || input.responseMode === 'confirmation') {
    return { eligible: false, status: RESPONSE_VALIDATION_STATUS.NOT_APPLICABLE, reason: 'response_mode' };
  }
  const source = input.responseSource || 'azure';
  if (source === 'fail_soft' || source === 'deterministic' || source === 'macro_fallback') {
    return { eligible: false, status: RESPONSE_VALIDATION_STATUS.NOT_APPLICABLE, reason: 'deterministic_response' };
  }
  if (source !== 'azure') {
    return { eligible: false, status: RESPONSE_VALIDATION_STATUS.NOT_APPLICABLE, reason: 'non_azure' };
  }
  const capability = input.capability || null;
  if (ELIGIBLE_CAPABILITIES.indexOf(capability) === -1) {
    return { eligible: false, status: RESPONSE_VALIDATION_STATUS.NOT_APPLICABLE, reason: 'ineligible_capability' };
  }
  const ledger = input.ledger;
  if (!ledger || typeof ledger !== 'object') {
    return { eligible: false, status: RESPONSE_VALIDATION_STATUS.CONTRACT_FAILED, reason: 'missing_ledger' };
  }
  if (ledger.status === LEDGER_STATUS.UNAVAILABLE || ledger.status === LEDGER_STATUS.UNSUPPORTED) {
    return { eligible: false, status: RESPONSE_VALIDATION_STATUS.NOT_APPLICABLE, reason: 'not_promptable' };
  }
  return { eligible: true, status: null, reason: null };
}

/**
 * Primary violation: severity first (critical → low), then earlier response
 * position, then violation code lexical. Closed 3C.1 codes only.
 */
function pickPrimaryViolation(result) {
  const rows = result && Array.isArray(result.violations) ? result.violations : [];
  if (!rows.length) return { code: 'none', severity: 'none' };
  let best = rows[0];
  let bestRank = SEVERITY_RANK[best.severity] != null ? SEVERITY_RANK[best.severity] : 99;
  let bestPos = best.position != null ? best.position : 0;
  for (let i = 1; i < rows.length; i += 1) {
    const rank = SEVERITY_RANK[rows[i].severity] != null ? SEVERITY_RANK[rows[i].severity] : 99;
    const pos = rows[i].position != null ? rows[i].position : 0;
    if (rank < bestRank) {
      best = rows[i];
      bestRank = rank;
      bestPos = pos;
    } else if (rank === bestRank) {
      if (pos < bestPos) {
        best = rows[i];
        bestPos = pos;
      } else if (pos === bestPos) {
        const codeCmp = String(rows[i].code || '').localeCompare(String(best.code || ''));
        if (codeCmp < 0) best = rows[i];
      }
    }
  }
  return {
    code: best.code || 'none',
    severity: best.severity || 'none',
  };
}

function materialClaimCount(extracted) {
  if (!Array.isArray(extracted)) return 0;
  let n = 0;
  for (let i = 0; i < extracted.length; i += 1) {
    if (MATERIAL_KINDS.indexOf(extracted[i].kind) !== -1) n += 1;
  }
  return n;
}

function runShadowResponseValidation(input = {}, deps = {}) {
  const t0 = process.hrtime.bigint();
  const flagEnabled = isResponseValidationShadowEnabled();
  const artifacts = { validation: null, contract: null, extractedClaims: null };
  function timed(overrides) {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return {
      telemetry: sanitizeResponseValidationTelemetry(Object.assign({
        response_validation_flag_enabled: flagEnabled,
        response_validation_ms: ms,
      }, overrides)),
      validation: artifacts.validation,
      contract: artifacts.contract,
      extractedClaims: artifacts.extractedClaims,
    };
  }

  try {
    const decision = shouldShadowValidateResponse(Object.assign({ flagEnabled }, input));
    if (!decision.eligible) {
      const contractStatus = decision.reason === 'missing_ledger'
        ? RESPONSE_VALIDATION_CONTRACT_STATUS.INVALID_LEDGER
        : (decision.reason === 'not_promptable'
          ? RESPONSE_VALIDATION_CONTRACT_STATUS.NOT_PROMPTABLE
          : RESPONSE_VALIDATION_CONTRACT_STATUS.NOT_APPLICABLE);
      return timed({
        response_validation_performed: false,
        response_validation_shadow: false,
        response_validation_status: decision.status,
        response_validation_contract_status: contractStatus,
        response_validation_exception_reason: RESPONSE_VALIDATION_EXCEPTION_REASON.NONE,
      });
    }

    const buildFn = deps.buildContract || buildResponseValidationContract;
    let built;
    try {
      built = buildFn(input.ledger);
    } catch (err) {
      return timed({
        response_validation_performed: true,
        response_validation_shadow: true,
        response_validation_status: RESPONSE_VALIDATION_STATUS.EXCEPTION,
        response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.BUILD_FAILED,
        response_validation_exception_reason: RESPONSE_VALIDATION_EXCEPTION_REASON.CONTRACT_BUILD_FAILED,
      });
    }
    if (!built || built.ok !== true || !built.contract) {
      return timed({
        response_validation_performed: true,
        response_validation_shadow: true,
        response_validation_status: RESPONSE_VALIDATION_STATUS.CONTRACT_FAILED,
        response_validation_contract_status: built && built.reason === 'unclonable_ledger'
          ? RESPONSE_VALIDATION_CONTRACT_STATUS.BUILD_FAILED
          : RESPONSE_VALIDATION_CONTRACT_STATUS.INVALID_LEDGER,
        response_validation_exception_reason: RESPONSE_VALIDATION_EXCEPTION_REASON.NONE,
      });
    }
    if (built.promptable === false) {
      return timed({
        response_validation_performed: false,
        response_validation_shadow: true,
        response_validation_status: RESPONSE_VALIDATION_STATUS.NOT_APPLICABLE,
        response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.NOT_PROMPTABLE,
        response_validation_exception_reason: RESPONSE_VALIDATION_EXCEPTION_REASON.NONE,
      });
    }

    const extractFn = deps.extractClaims || extractResponseClaims;
    let extracted;
    try {
      extracted = extractFn(input.text || '');
    } catch (err) {
      return timed({
        response_validation_performed: true,
        response_validation_shadow: true,
        response_validation_status: RESPONSE_VALIDATION_STATUS.EXCEPTION,
        response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.OK,
        response_validation_exception_reason: RESPONSE_VALIDATION_EXCEPTION_REASON.EXTRACTOR_FAILED,
      });
    }

    const validateFn = deps.validateClaims || validateResponseClaims;
    let result;
    try {
      result = validateFn({ contract: built.contract, extractedClaims: extracted });
    } catch (err) {
      return timed({
        response_validation_performed: true,
        response_validation_shadow: true,
        response_validation_status: RESPONSE_VALIDATION_STATUS.EXCEPTION,
        response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.OK,
        response_validation_exception_reason: RESPONSE_VALIDATION_EXCEPTION_REASON.VALIDATOR_FAILED,
      });
    }

    const summarizeFn = deps.summarize || summarizeValidationResult;
    let summary;
    try {
      summary = summarizeFn(result);
    } catch (err) {
      return timed({
        response_validation_performed: true,
        response_validation_shadow: true,
        response_validation_status: RESPONSE_VALIDATION_STATUS.EXCEPTION,
        response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.OK,
        response_validation_exception_reason: RESPONSE_VALIDATION_EXCEPTION_REASON.SUMMARY_FAILED,
      });
    }

    const mappedStatus = summary.status === VALIDATION_STATUS.INVALID
      ? RESPONSE_VALIDATION_STATUS.INVALID
      : (summary.status === VALIDATION_STATUS.INDETERMINATE
        ? RESPONSE_VALIDATION_STATUS.INDETERMINATE
        : RESPONSE_VALIDATION_STATUS.VALID);
    const primary = pickPrimaryViolation(result);
    artifacts.validation = result;
    artifacts.contract = built.contract;
    artifacts.extractedClaims = extracted;
    return timed({
      response_validation_performed: true,
      response_validation_shadow: true,
      response_validation_status: mappedStatus,
      response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.OK,
      response_validation_primary_violation: primary.code,
      response_validation_primary_severity: primary.severity,
      response_validation_violation_count_bucket: validationCountBucket(summary.violationCount),
      response_validation_indeterminate_count_bucket: validationCountBucket(summary.indeterminateCount),
      response_validation_material_claim_count_bucket: validationCountBucket(materialClaimCount(extracted)),
      response_validation_exception_reason: RESPONSE_VALIDATION_EXCEPTION_REASON.NONE,
    });
  } catch (err) {
    return timed({
      response_validation_performed: true,
      response_validation_shadow: flagEnabled,
      response_validation_status: RESPONSE_VALIDATION_STATUS.EXCEPTION,
      response_validation_contract_status: RESPONSE_VALIDATION_CONTRACT_STATUS.NOT_APPLICABLE,
      response_validation_exception_reason: RESPONSE_VALIDATION_EXCEPTION_REASON.VALIDATION_EXCEPTION,
    });
  }
}

function applyShadowResponseValidation(input = {}, deps = {}) {
  const text = input && typeof input.text === 'string' ? input.text : '';
  let telemetry;
  let validation = null;
  let contract = null;
  let extractedClaims = null;
  try {
    const ran = runShadowResponseValidation(Object.assign({}, input, { text }), deps);
    telemetry = ran && ran.telemetry ? ran.telemetry : ran;
    validation = ran && ran.validation ? ran.validation : null;
    contract = ran && ran.contract ? ran.contract : null;
    extractedClaims = ran && ran.extractedClaims ? ran.extractedClaims : null;
  } catch (err) {
    telemetry = sanitizeResponseValidationTelemetry({
      response_validation_performed: true,
      response_validation_shadow: isResponseValidationShadowEnabled(),
      response_validation_status: RESPONSE_VALIDATION_STATUS.EXCEPTION,
      response_validation_exception_reason: RESPONSE_VALIDATION_EXCEPTION_REASON.VALIDATION_EXCEPTION,
      response_validation_flag_enabled: isResponseValidationShadowEnabled(),
    });
  }
  return { finalText: text, telemetry, validation, contract, extractedClaims };
}

module.exports = {
  RESPONSE_VALIDATION_SHADOW_ENV_KEY,
  ELIGIBLE_CAPABILITIES,
  RESPONSE_VALIDATION_STATUS,
  RESPONSE_VALIDATION_CONTRACT_STATUS,
  RESPONSE_VALIDATION_EXCEPTION_REASON,
  RESPONSE_VALIDATION_COUNT_BUCKETS,
  isResponseValidationShadowEnabled,
  shouldShadowValidateResponse,
  emptyShadowTelemetry,
  sanitizeResponseValidationTelemetry,
  validationCountBucket,
  pickPrimaryViolation,
  runShadowResponseValidation,
  applyShadowResponseValidation,
};
