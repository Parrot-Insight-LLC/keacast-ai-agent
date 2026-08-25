'use strict';

/**
 * Phase 3C.3 — initial critical/high response enforcement.
 *
 * Consumes the same-request shadow validation result. Never recalculates.
 * Never retries Azure. Never mutates validation verdicts.
 */

const { parseLedgerPromptFlag } = require('./keaEvidencePromptCutover');
const { CLAIM_KIND } = require('./keaResponseClaimExtractor');
const { SEVERITY, VIOLATION_CODE } = require('./keaResponseValidationContract');
const {
  RESPONSE_VALIDATION_STATUS,
  RESPONSE_VALIDATION_CONTRACT_STATUS,
} = require('./keaResponseValidationShadow');

const RESPONSE_VALIDATION_ENFORCEMENT_ENV_KEY = 'USE_RESPONSE_VALIDATION_ENFORCEMENT';

const RESPONSE_VALIDATION_FALLBACK =
  "I couldn't verify that answer against your Keacast data, so I don't want to give you an inaccurate financial result. Please try again.";

const ENFORCEABLE_CAPABILITIES = Object.freeze([
  'cashflow_trend',
  'cashflow_recurring',
  'cashflow_upcoming',
  'cashflow_income_horizon',
  'cashflow_comparison',
  'financial_lookup',
  'financial_forecast',
]);

const EXCLUDED_CAPABILITIES = Object.freeze([
  'affordability_or_planning',
  'cashflow_analysis',
]);

const COMPARISON_ENFORCED_FAMILIES = Object.freeze(['percent', 'absolute', 'direction']);

const BLOCKING_SEVERITIES = Object.freeze([SEVERITY.CRITICAL, SEVERITY.HIGH]);

const EXCLUDED_VIOLATION_CODES = Object.freeze([
  VIOLATION_CODE.UNSUPPORTED_CAPABILITY_OFFER,
  VIOLATION_CODE.UNSUPPORTED_DEFINITION,
  VIOLATION_CODE.UNSUPPORTED_RANKING,
  VIOLATION_CODE.PROHIBITED_NARRATION,
]);

const CORE_ENFORCEABLE_CODES = Object.freeze([
  VIOLATION_CODE.UNSUPPORTED_AMOUNT,
  VIOLATION_CODE.UNSUPPORTED_COUNT,
  VIOLATION_CODE.UNSUPPORTED_DATE,
  VIOLATION_CODE.UNSUPPORTED_PERIOD_ATTRIBUTION,
  VIOLATION_CODE.UNSUPPORTED_ENTITY,
  VIOLATION_CODE.UNSUPPORTED_COMPARISON,
  VIOLATION_CODE.UNSUPPORTED_DERIVATION,
  VIOLATION_CODE.UNSUPPORTED_FORECAST,
  VIOLATION_CODE.LIST_ITEM_MISMATCH,
  VIOLATION_CODE.UNAUTHORIZED_DIRECTION,
]);

const ENFORCEMENT_REASON = Object.freeze({
  NONE: 'none',
  FLAG_DISABLED: 'flag_disabled',
  NOT_ELIGIBLE_CAPABILITY: 'not_eligible_capability',
  NOT_ELIGIBLE_CLAIM_FAMILY: 'not_eligible_claim_family',
  VALIDATION_VALID: 'validation_valid',
  VALIDATION_INDETERMINATE: 'validation_indeterminate',
  VALIDATION_EXCEPTION: 'validation_exception',
  CONTRACT_NOT_OK: 'contract_not_ok',
  ELIGIBLE_INVALID_BLOCKED: 'eligible_invalid_blocked',
  WRITE_FLOW_EXCLUDED: 'write_flow_excluded',
  SIMULATION_EXCLUDED: 'simulation_excluded',
  INVITATION_EXCLUDED: 'invitation_excluded',
  DETERMINISTIC_EXCLUDED: 'deterministic_excluded',
  FAIL_OPEN: 'fail_open',
});

const ENFORCEMENT_REASONS = Object.freeze(Object.keys(ENFORCEMENT_REASON).map((k) => ENFORCEMENT_REASON[k]));

const ENFORCEMENT_CAPABILITY = Object.freeze(['none'].concat(ENFORCEABLE_CAPABILITIES, EXCLUDED_CAPABILITIES));

const ENFORCEMENT_SEVERITY = Object.freeze(['none', SEVERITY.CRITICAL, SEVERITY.HIGH, SEVERITY.MEDIUM, SEVERITY.LOW]);

function pickEnum(value, allowed, fallback) {
  return allowed.indexOf(value) === -1 ? fallback : value;
}

function isResponseValidationEnforcementEnabled() {
  const raw = process.env[RESPONSE_VALIDATION_ENFORCEMENT_ENV_KEY];
  if (raw == null || String(raw).trim() === '') return false;
  return parseLedgerPromptFlag(raw).enabled;
}

function emptyEnforcementTelemetry(overrides = {}) {
  return Object.assign({
    response_enforcement_eligible: false,
    response_enforcement_enabled: isResponseValidationEnforcementEnabled(),
    response_enforcement_blocked: false,
    response_enforcement_reason: ENFORCEMENT_REASON.NONE,
    response_enforcement_capability: 'none',
    response_enforcement_severity: 'none',
    response_enforcement_fallback_used: false,
  }, overrides);
}

function sanitizeResponseEnforcementTelemetry(input) {
  const base = emptyEnforcementTelemetry({ response_enforcement_enabled: false });
  if (!input || typeof input !== 'object') return base;
  try {
    return {
      response_enforcement_eligible: input.response_enforcement_eligible === true,
      response_enforcement_enabled: input.response_enforcement_enabled === true,
      response_enforcement_blocked: input.response_enforcement_blocked === true,
      response_enforcement_reason: pickEnum(
        input.response_enforcement_reason,
        ENFORCEMENT_REASONS,
        ENFORCEMENT_REASON.NONE
      ),
      response_enforcement_capability: pickEnum(
        input.response_enforcement_capability,
        ENFORCEMENT_CAPABILITY,
        'none'
      ),
      response_enforcement_severity: pickEnum(
        input.response_enforcement_severity,
        ENFORCEMENT_SEVERITY,
        'none'
      ),
      response_enforcement_fallback_used: input.response_enforcement_fallback_used === true,
    };
  } catch (err) {
    return emptyEnforcementTelemetry({
      response_enforcement_reason: ENFORCEMENT_REASON.FAIL_OPEN,
      response_enforcement_enabled: isResponseValidationEnforcementEnabled(),
    });
  }
}

function buildSafeValidationFallback() {
  return RESPONSE_VALIDATION_FALLBACK;
}

function ledgerSourceKind(ledger) {
  return ledger && ledger.source && ledger.source.kind ? ledger.source.kind : null;
}

function hasBillsBeforePaydaySurface(input) {
  // Identifiable specialized follow-up only. Do not treat a populated
  // expensesBeforeIncome list as exclusion — production horizon ledgers
  // often include that list on core next-income turns.
  return input.responseMode === 'negative_check';
}

function excludedRequestReason(input) {
  const writeMode = input.writeResponseMode || 'none';
  if (writeMode && writeMode !== 'none') return ENFORCEMENT_REASON.WRITE_FLOW_EXCLUDED;
  if (input.simulationMode === true) return ENFORCEMENT_REASON.SIMULATION_EXCLUDED;
  if (input.invitationWriteHandoff === true || input.repeatWriteHandoff === true) {
    return ENFORCEMENT_REASON.INVITATION_EXCLUDED;
  }
  if (input.responseMode === 'fail_soft' || input.responseMode === 'confirmation') {
    return ENFORCEMENT_REASON.DETERMINISTIC_EXCLUDED;
  }
  const source = input.responseSource || 'azure';
  if (source === 'fail_soft' || source === 'deterministic' || source === 'macro_fallback') {
    return ENFORCEMENT_REASON.DETERMINISTIC_EXCLUDED;
  }
  if (source !== 'azure') return ENFORCEMENT_REASON.DETERMINISTIC_EXCLUDED;
  return null;
}

function capabilityEligible(capability, input) {
  if (!capability || EXCLUDED_CAPABILITIES.indexOf(capability) !== -1) return false;
  if (ENFORCEABLE_CAPABILITIES.indexOf(capability) === -1) return false;
  if (capability === 'cashflow_income_horizon' && hasBillsBeforePaydaySurface(input)) return false;
  return true;
}

function claimById(contract, claimId) {
  if (!contract || !claimId || !Array.isArray(contract.allowedClaims)) return null;
  for (let i = 0; i < contract.allowedClaims.length; i += 1) {
    if (contract.allowedClaims[i].claimId === claimId) return contract.allowedClaims[i];
  }
  return null;
}

function extractedById(extractedClaims, id) {
  if (!id || !Array.isArray(extractedClaims)) return null;
  for (let i = 0; i < extractedClaims.length; i += 1) {
    if (extractedClaims[i].id === id) return extractedClaims[i];
  }
  return null;
}

function hasHint(hints, name) {
  return Array.isArray(hints) && hints.indexOf(name) !== -1;
}

/**
 * Classify a comparison violation into an enforcement family using existing
 * validator/extractor metadata only. No financial math.
 */
function comparisonClaimFamily(violation, extractedClaims, contract) {
  const extracted = extractedById(extractedClaims, violation && violation.extractedClaimId);
  const bound = claimById(contract, violation && violation.evidenceClaimId);
  const path = bound && bound.path ? String(bound.path) : '';
  const role = bound && bound.semanticRole ? String(bound.semanticRole) : '';
  const kind = extracted && extracted.kind;
  const hints = (extracted && extracted.semanticHints) || [];
  const code = violation && violation.code;

  if (code === VIOLATION_CODE.UNSUPPORTED_COMPARISON
    || kind === CLAIM_KIND.PERCENT
    || role === 'comparison_percent'
    || /\.percent$/.test(path)) {
    return 'percent';
  }
  if (code === VIOLATION_CODE.UNAUTHORIZED_DIRECTION
    || kind === CLAIM_KIND.DIRECTION
    || role === 'direction'
    || /\.direction$/.test(path)) {
    return 'direction';
  }
  if (role === 'comparison_absolute'
    || /\.absolute$/.test(path)
    || /facts\.changes\./.test(path)) {
    return 'absolute';
  }
  if (hasHint(hints, 'delta') && !hasHint(hints, 'period_value')) return 'absolute';
  if (hasHint(hints, 'period_value') || /facts\.period[AB]/.test(path)) return 'period_scalar';
  return 'unclassified';
}

function isBlockingSeverity(severity) {
  return BLOCKING_SEVERITIES.indexOf(severity) !== -1;
}

function violationEnforceable(capability, violation, extractedClaims, contract) {
  if (!violation || EXCLUDED_VIOLATION_CODES.indexOf(violation.code) !== -1) return false;
  if (!isBlockingSeverity(violation.severity)) return false;
  if (CORE_ENFORCEABLE_CODES.indexOf(violation.code) === -1) return false;
  if (capability !== 'cashflow_comparison') return true;
  const family = comparisonClaimFamily(violation, extractedClaims, contract);
  return COMPARISON_ENFORCED_FAMILIES.indexOf(family) !== -1;
}

function pickBlockingViolation(capability, validation, extractedClaims, contract) {
  const rows = validation && Array.isArray(validation.violations) ? validation.violations : [];
  let best = null;
  const rank = { critical: 0, high: 1 };
  for (let i = 0; i < rows.length; i += 1) {
    if (!violationEnforceable(capability, rows[i], extractedClaims, contract)) continue;
    if (!best) {
      best = rows[i];
      continue;
    }
    const br = rank[best.severity] != null ? rank[best.severity] : 99;
    const nr = rank[rows[i].severity] != null ? rank[rows[i].severity] : 99;
    if (nr < br) best = rows[i];
  }
  return best;
}

function evaluateResponseEnforcement(input = {}) {
  const enabled = input.flagEnabled != null
    ? input.flagEnabled === true
    : isResponseValidationEnforcementEnabled();
  const capability = input.capability || null;
  const telemetryCap = pickEnum(capability, ENFORCEMENT_CAPABILITY, 'none');
  const excluded = excludedRequestReason(input);
  const eligibleSurface = !excluded && capabilityEligible(capability, input);

  function finish(partial) {
    return {
      eligible: partial.eligible === true,
      block: partial.block === true,
      reason: partial.reason || ENFORCEMENT_REASON.NONE,
      severity: partial.severity || 'none',
      fallbackKind: partial.block === true ? 'unverified_financial' : 'none',
      telemetry: sanitizeResponseEnforcementTelemetry({
        response_enforcement_eligible: partial.eligible === true,
        response_enforcement_enabled: enabled,
        response_enforcement_blocked: partial.block === true,
        response_enforcement_reason: partial.reason,
        response_enforcement_capability: telemetryCap,
        response_enforcement_severity: partial.severity || 'none',
        response_enforcement_fallback_used: partial.block === true,
      }),
    };
  }

  if (excluded) {
    return finish({ eligible: false, block: false, reason: excluded });
  }
  if (!eligibleSurface) {
    return finish({
      eligible: false,
      block: false,
      reason: capability === 'cashflow_income_horizon' && hasBillsBeforePaydaySurface(input)
        ? ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY
        : ENFORCEMENT_REASON.NOT_ELIGIBLE_CAPABILITY,
    });
  }
  if (!enabled) {
    return finish({ eligible: true, block: false, reason: ENFORCEMENT_REASON.FLAG_DISABLED });
  }

  const shadow = input.shadow || {};
  const telemetry = shadow.telemetry || {};
  const validation = input.validation || shadow.validation || null;
  const contract = input.contract || shadow.contract || null;
  const extractedClaims = input.extractedClaims || shadow.extractedClaims || null;

  if (telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.EXCEPTION) {
    return finish({ eligible: true, block: false, reason: ENFORCEMENT_REASON.VALIDATION_EXCEPTION });
  }
  if (telemetry.response_validation_performed !== true) {
    return finish({ eligible: true, block: false, reason: ENFORCEMENT_REASON.FAIL_OPEN });
  }
  if (telemetry.response_validation_contract_status !== RESPONSE_VALIDATION_CONTRACT_STATUS.OK) {
    return finish({ eligible: true, block: false, reason: ENFORCEMENT_REASON.CONTRACT_NOT_OK });
  }
  if (telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.VALID) {
    return finish({ eligible: true, block: false, reason: ENFORCEMENT_REASON.VALIDATION_VALID });
  }
  if (telemetry.response_validation_status === RESPONSE_VALIDATION_STATUS.INDETERMINATE
    && (!validation || !Array.isArray(validation.violations) || validation.violations.length === 0)) {
    return finish({ eligible: true, block: false, reason: ENFORCEMENT_REASON.VALIDATION_INDETERMINATE });
  }
  if (telemetry.response_validation_status !== RESPONSE_VALIDATION_STATUS.INVALID) {
    return finish({ eligible: true, block: false, reason: ENFORCEMENT_REASON.FAIL_OPEN });
  }

  const blocking = pickBlockingViolation(capability, validation, extractedClaims, contract);
  if (!blocking) {
    return finish({
      eligible: true,
      block: false,
      reason: ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY,
    });
  }
  return finish({
    eligible: true,
    block: true,
    reason: ENFORCEMENT_REASON.ELIGIBLE_INVALID_BLOCKED,
    severity: blocking.severity,
  });
}

function applyResponseValidationEnforcement(input = {}) {
  const originalText = input && typeof input.originalText === 'string'
    ? input.originalText
    : '';
  let decision;
  try {
    decision = evaluateResponseEnforcement(input);
  } catch (err) {
    decision = {
      eligible: false,
      block: false,
      reason: ENFORCEMENT_REASON.FAIL_OPEN,
      severity: 'none',
      fallbackKind: 'none',
      telemetry: sanitizeResponseEnforcementTelemetry({
        response_enforcement_eligible: false,
        response_enforcement_enabled: isResponseValidationEnforcementEnabled(),
        response_enforcement_blocked: false,
        response_enforcement_reason: ENFORCEMENT_REASON.FAIL_OPEN,
      }),
    };
  }
  const finalText = decision.block === true ? buildSafeValidationFallback() : originalText;
  return { finalText, decision, telemetry: decision.telemetry };
}

module.exports = {
  RESPONSE_VALIDATION_ENFORCEMENT_ENV_KEY,
  RESPONSE_VALIDATION_FALLBACK,
  ENFORCEABLE_CAPABILITIES,
  EXCLUDED_CAPABILITIES,
  COMPARISON_ENFORCED_FAMILIES,
  ENFORCEMENT_REASON,
  isResponseValidationEnforcementEnabled,
  emptyEnforcementTelemetry,
  sanitizeResponseEnforcementTelemetry,
  buildSafeValidationFallback,
  comparisonClaimFamily,
  evaluateResponseEnforcement,
  applyResponseValidationEnforcement,
};
