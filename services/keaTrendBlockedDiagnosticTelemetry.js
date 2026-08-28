'use strict';

/**
 * Temporary privacy-safe telemetry for blocked cashflow_trend responses.
 *
 * Observes existing one-pass validation artifacts only.
 * Does not calculate, authorize, repair, re-extract, or re-validate.
 * Does not accept or return raw Azure/user/assistant text.
 *
 * Removal backlog: TREND_BLOCK_DIAGNOSTIC_TELEMETRY_REMOVAL
 * Status: OPEN until a later trend-validator remediation is live + verified.
 */

const { parseLedgerPromptFlag } = require('./keaEvidencePromptCutover');

const TREND_BLOCK_DIAGNOSTIC_ENV_KEY = 'USE_TREND_BLOCK_DIAGNOSTIC_TELEMETRY';
const TREND_BLOCK_DIAGNOSTIC_TELEMETRY_REMOVAL = 'OPEN';

const FORBIDDEN_OUTPUT_KEYS = Object.freeze([
  'text', 'rawText', 'response', 'finalText', 'message',
  'amount', 'value', 'date', 'period', 'account', 'merchant', 'transaction',
  'claimId', 'claimPath', 'path', 'label', 'entity', 'snippet',
  'offset', 'start', 'end',
]);

const ENUMS = Object.freeze({
  trend_diag_performed: Object.freeze([true, false]),
  trend_diag_reason: Object.freeze([
    'not_trend', 'not_invalid', 'not_blocked', 'unsupported_violation', 'captured',
  ]),
  trend_diag_authorized_direction: Object.freeze([
    'increasing', 'decreasing', 'mixed', 'unchanged', 'insufficient_data', 'missing', 'unknown',
  ]),
  trend_diag_direction_token_count_bucket: Object.freeze(['0', '1', '2-3', '4+']),
  trend_diag_direction_polarity: Object.freeze(['none', 'up', 'down', 'mixed_tokens']),
  trend_diag_direction_match_status: Object.freeze([
    'not_applicable', 'authorized', 'mismatch', 'authority_non_polar', 'multiple', 'unknown',
  ]),
  trend_diag_direction_form: Object.freeze([
    'increase', 'decrease', 'higher', 'lower', 'rise', 'drop', 'fall',
    'upward', 'downward', 'other', 'none', 'multiple',
  ]),
  trend_diag_percent_token_count_bucket: Object.freeze(['0', '1', '2-3', '4+']),
  trend_diag_percent_match_status: Object.freeze([
    'not_applicable', 'all_authorized', 'exact', 'signed_magnitude', 'unmatched', 'mixed', 'unknown',
  ]),
  trend_diag_percent_numeric_relation: Object.freeze([
    'none', 'exact', 'signed_magnitude', 'unmatched', 'mixed',
  ]),
  trend_diag_percent_expense_hint: Object.freeze(['present', 'absent', 'mixed', 'not_applicable']),
  trend_diag_percent_role_hint: Object.freeze([
    'delta', 'period_value', 'unknown', 'mixed', 'not_applicable',
  ]),
  trend_diag_primary_failure: Object.freeze([
    'unsupported_comparison', 'unauthorized_direction', 'unsupported_amount', 'other', 'none',
  ]),
  trend_diag_percent_failure_reason: Object.freeze(['percent_not_in_ledger', 'none', 'other']),
  trend_diag_direction_failure_reason: Object.freeze(['direction_polarity_mismatch', 'none', 'other']),
  trend_diag_has_percent_failure: Object.freeze([true, false]),
  trend_diag_has_direction_failure: Object.freeze([true, false]),
  trend_diag_multiple_violation_families: Object.freeze([true, false]),
  trend_diag_violation_count_bucket: Object.freeze(['1', '2-3', '4-7', '8+']),
});

const TREND_DIAG_FIELD_KEYS = Object.freeze(Object.keys(ENUMS));

const POLAR_AUTH = Object.freeze({
  increasing: 'up',
  decreasing: 'down',
});
const NON_POLAR_AUTH = Object.freeze({
  mixed: true,
  unchanged: true,
  insufficient_data: true,
});

function isTrendBlockDiagnosticEnabled() {
  const raw = process.env[TREND_BLOCK_DIAGNOSTIC_ENV_KEY];
  if (raw == null || String(raw).trim() === '') return false;
  return parseLedgerPromptFlag(raw).enabled === true;
}

function pickEnum(value, allowed, fallback) {
  for (let i = 0; i < allowed.length; i += 1) {
    if (allowed[i] === value) return value;
  }
  return fallback;
}

function tokenCountBucket(n) {
  const count = Number(n) || 0;
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2-3';
  return '4+';
}

function violationCountBucket(n) {
  const count = Number(n) || 0;
  if (count <= 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 7) return '4-7';
  return '8+';
}

function claimsList(extractedClaims) {
  if (Array.isArray(extractedClaims)) return extractedClaims;
  if (extractedClaims && Array.isArray(extractedClaims.claims)) return extractedClaims.claims;
  return [];
}

function violationsList(validationResult) {
  if (validationResult && Array.isArray(validationResult.violations)) return validationResult.violations;
  return [];
}

function allowedClaims(contract) {
  if (contract && Array.isArray(contract.allowedClaims)) return contract.allowedClaims;
  return [];
}

/**
 * Same polarity mapping the current validator uses. Copied, not imported,
 * so this helper cannot change validator semantics.
 */
function directionPolarity(token) {
  const t = String(token || '').toLowerCase();
  if (!t) return null;
  if (t === 'decrease' || t === 'decreased' || t === 'decreasing' || t === 'lower'
    || t === 'dropped' || t === 'falling' || t === 'downward' || t === 'fell' || t === 'less'
    || t === 'will decrease' || t === 'will fall' || t === 'expected to decrease') {
    return 'down';
  }
  if (t === 'increase' || t === 'increased' || t === 'increasing' || t === 'higher'
    || t === 'rose' || t === 'rising' || t === 'upward' || t === 'improved'
    || t === 'will increase' || t === 'will rise' || t === 'expected to increase') {
    return 'up';
  }
  return null;
}

function directionForm(token) {
  const t = String(token || '').toLowerCase();
  if (t === 'increase' || t === 'increased' || t === 'increasing'
    || t === 'will increase' || t === 'expected to increase') return 'increase';
  if (t === 'decrease' || t === 'decreased' || t === 'decreasing'
    || t === 'will decrease' || t === 'expected to decrease') return 'decrease';
  if (t === 'higher') return 'higher';
  if (t === 'lower' || t === 'less') return 'lower';
  if (t === 'rose' || t === 'rising' || t === 'will rise') return 'rise';
  if (t === 'dropped') return 'drop';
  if (t === 'falling' || t === 'will fall' || t === 'fell') return 'fall';
  if (t === 'upward') return 'upward';
  if (t === 'downward') return 'downward';
  return 'other';
}

function authorizedDirectionEnum(contract) {
  const rows = allowedClaims(contract).filter((c) => c && c.type === 'DIRECTION');
  if (!rows.length) return 'missing';
  let chosen = rows[0];
  for (let i = 0; i < rows.length; i += 1) {
    const path = String(rows[i].path || '');
    if (path.indexOf('spending') !== -1) {
      chosen = rows[i];
      break;
    }
  }
  const raw = String(chosen && chosen.value != null ? chosen.value : '').toLowerCase();
  return pickEnum(raw, ENUMS.trend_diag_authorized_direction, 'unknown');
}

function authorizedPercentValues(contract) {
  const out = [];
  const rows = allowedClaims(contract);
  for (let i = 0; i < rows.length; i += 1) {
    const claim = rows[i];
    if (!claim || claim.type !== 'PERCENT') continue;
    if (claim.unit != null && claim.unit !== 'percent') continue;
    const n = Number(claim.value);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function percentNumericRelation(extractedPct, authorizedPcts) {
  if (!Number.isFinite(extractedPct) || !authorizedPcts.length) return 'unmatched';
  for (let i = 0; i < authorizedPcts.length; i += 1) {
    if (authorizedPcts[i] === extractedPct) return 'exact';
  }
  for (let i = 0; i < authorizedPcts.length; i += 1) {
    if (authorizedPcts[i] === -extractedPct) return 'signed_magnitude';
  }
  return 'unmatched';
}

function hasHint(hints, name) {
  if (!Array.isArray(hints)) return false;
  for (let i = 0; i < hints.length; i += 1) {
    if (hints[i] === name) return true;
  }
  return false;
}

function mapPrimaryFailure(code) {
  if (code === 'UNSUPPORTED_COMPARISON') return 'unsupported_comparison';
  if (code === 'UNAUTHORIZED_DIRECTION') return 'unauthorized_direction';
  if (code === 'UNSUPPORTED_AMOUNT') return 'unsupported_amount';
  if (!code || code === 'none') return 'none';
  return 'other';
}

function aggregateEnums(values, singleOk, allSameLabel, mixedLabel, emptyLabel) {
  if (!values.length) return emptyLabel;
  const unique = [];
  for (let i = 0; i < values.length; i += 1) {
    if (unique.indexOf(values[i]) === -1) unique.push(values[i]);
  }
  if (unique.length === 1) {
    if (values.length === 1 && singleOk) return unique[0];
    if (allSameLabel) return allSameLabel;
    return unique[0];
  }
  return mixedLabel;
}

function sanitizeTrendDiagnosticTelemetry(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.trend_diag_performed !== true) return null;
  const out = {};
  for (let i = 0; i < TREND_DIAG_FIELD_KEYS.length; i += 1) {
    const key = TREND_DIAG_FIELD_KEYS[i];
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    if (FORBIDDEN_OUTPUT_KEYS.indexOf(key) !== -1) continue;
    const allowed = ENUMS[key];
    const fallback = allowed[allowed.length - 1];
    out[key] = pickEnum(input[key], allowed, fallback);
  }
  if (out.trend_diag_performed !== true) return null;
  for (let i = 0; i < FORBIDDEN_OUTPUT_KEYS.length; i += 1) {
    if (Object.prototype.hasOwnProperty.call(out, FORBIDDEN_OUTPUT_KEYS[i])) {
      delete out[FORBIDDEN_OUTPUT_KEYS[i]];
    }
  }
  return out;
}

function resolveCapability(input) {
  if (input && typeof input.capability === 'string') return input.capability;
  if (input && input.contract && typeof input.contract.capability === 'string') {
    return input.contract.capability;
  }
  return null;
}

function resolveSourceKind(input) {
  if (input && typeof input.sourceKind === 'string') return input.sourceKind;
  if (input && input.contract && typeof input.contract.sourceKind === 'string') {
    return input.contract.sourceKind;
  }
  return null;
}

function resolveValidationStatus(input) {
  const tel = input && input.validationTelemetry;
  if (tel && typeof tel.response_validation_status === 'string') {
    return tel.response_validation_status;
  }
  const result = input && input.validationResult;
  if (result && typeof result.status === 'string') return result.status;
  return null;
}

function resolveValidationPerformed(input) {
  const tel = input && input.validationTelemetry;
  if (tel && tel.response_validation_performed === true) return true;
  if (input && input.validationResult && typeof input.validationResult.status === 'string') {
    return true;
  }
  return false;
}

function resolvePrimaryCode(input) {
  const tel = input && input.validationTelemetry;
  if (tel && typeof tel.response_validation_primary_violation === 'string'
    && tel.response_validation_primary_violation !== 'none') {
    return tel.response_validation_primary_violation;
  }
  const violations = violationsList(input && input.validationResult);
  return violations.length ? violations[0].code : 'none';
}

function buildTrendBlockedDiagnosticTelemetry(input) {
  if (!isTrendBlockDiagnosticEnabled()) return null;
  const capability = resolveCapability(input);
  const sourceKind = resolveSourceKind(input);
  if (capability !== 'cashflow_trend' || sourceKind !== 'cashflow_trend') return null;
  if (resolveValidationPerformed(input) !== true) return null;
  if (resolveValidationStatus(input) !== 'invalid') return null;
  const decision = input && input.enforcementDecision;
  if (!decision || decision.block !== true) return null;

  const extracted = claimsList(input && input.extractedClaims);
  const violations = violationsList(input && input.validationResult);
  const contract = input && input.contract;
  const authorizedPcts = authorizedPercentValues(contract);
  const authorizedDirection = authorizedDirectionEnum(contract);

  const directionRows = [];
  const percentRows = [];
  for (let i = 0; i < extracted.length; i += 1) {
    const row = extracted[i];
    if (!row) continue;
    if (row.kind === 'direction') directionRows.push(row);
    else if (row.kind === 'percent') percentRows.push(row);
  }

  const polarities = [];
  const forms = [];
  for (let d = 0; d < directionRows.length; d += 1) {
    const token = directionRows[d].token || directionRows[d].rawSpan;
    const pol = directionPolarity(token);
    if (pol) polarities.push(pol);
    forms.push(directionForm(token));
  }
  let directionPolaritySummary = 'none';
  if (polarities.indexOf('up') !== -1 && polarities.indexOf('down') !== -1) {
    directionPolaritySummary = 'mixed_tokens';
  } else if (polarities.indexOf('up') !== -1) {
    directionPolaritySummary = 'up';
  } else if (polarities.indexOf('down') !== -1) {
    directionPolaritySummary = 'down';
  }

  let directionMatch = 'not_applicable';
  if (directionRows.length === 0) {
    directionMatch = 'not_applicable';
  } else if (NON_POLAR_AUTH[authorizedDirection]) {
    directionMatch = 'authority_non_polar';
  } else if (directionPolaritySummary === 'mixed_tokens') {
    directionMatch = 'multiple';
  } else if (POLAR_AUTH[authorizedDirection]) {
    if (directionPolaritySummary === 'none') directionMatch = 'unknown';
    else if (directionPolaritySummary === POLAR_AUTH[authorizedDirection]) directionMatch = 'authorized';
    else directionMatch = 'mismatch';
  } else {
    directionMatch = 'unknown';
  }

  const uniqueForms = [];
  for (let f = 0; f < forms.length; f += 1) {
    if (uniqueForms.indexOf(forms[f]) === -1) uniqueForms.push(forms[f]);
  }
  let directionFormSummary = 'none';
  if (uniqueForms.length === 1) directionFormSummary = uniqueForms[0];
  else if (uniqueForms.length > 1) directionFormSummary = 'multiple';

  const numericRelations = [];
  const matchStatuses = [];
  const expenseHints = [];
  const roleHints = [];
  for (let p = 0; p < percentRows.length; p += 1) {
    const row = percentRows[p];
    const extractedPct = Number(row.normalizedValue);
    const numeric = percentNumericRelation(extractedPct, authorizedPcts);
    numericRelations.push(numeric);
    const hints = row.semanticHints || [];
    expenseHints.push(hasHint(hints, 'expense') ? 'present' : 'absent');
    if (hasHint(hints, 'delta') && hasHint(hints, 'period_value')) roleHints.push('mixed');
    else if (hasHint(hints, 'delta')) roleHints.push('delta');
    else if (hasHint(hints, 'period_value')) roleHints.push('period_value');
    else roleHints.push('unknown');
    let rejected = false;
    for (let v = 0; v < violations.length; v += 1) {
      if (violations[v].code === 'UNSUPPORTED_COMPARISON'
        && violations[v].extractedClaimId === row.id) {
        rejected = true;
        break;
      }
    }
    if (rejected) matchStatuses.push('unmatched');
    else if (numeric === 'exact') matchStatuses.push('exact');
    else if (numeric === 'signed_magnitude') matchStatuses.push('signed_magnitude');
    else matchStatuses.push('unmatched');
  }

  let percentMatchStatus = 'not_applicable';
  if (percentRows.length === 1) {
    percentMatchStatus = matchStatuses[0];
  } else if (percentRows.length > 1) {
    let anyAuthorized = false;
    let anyUnmatched = false;
    for (let m = 0; m < matchStatuses.length; m += 1) {
      if (matchStatuses[m] === 'unmatched') anyUnmatched = true;
      else anyAuthorized = true;
    }
    if (anyAuthorized && anyUnmatched) percentMatchStatus = 'mixed';
    else if (anyUnmatched) percentMatchStatus = 'unmatched';
    else percentMatchStatus = 'all_authorized';
  }

  let percentNumeric = 'none';
  if (numericRelations.length === 1) percentNumeric = numericRelations[0];
  else if (numericRelations.length > 1) {
    percentNumeric = aggregateEnums(numericRelations, false, null, 'mixed', 'none');
    if (percentNumeric !== 'mixed' && percentNumeric !== 'none') {
      // all same relation
    } else if (!numericRelations.length) percentNumeric = 'none';
  }

  let expenseHint = 'not_applicable';
  if (expenseHints.length === 1) expenseHint = expenseHints[0];
  else if (expenseHints.length > 1) {
    expenseHint = aggregateEnums(expenseHints, false, null, 'mixed', 'not_applicable');
  }

  let roleHint = 'not_applicable';
  if (roleHints.length === 1) roleHint = roleHints[0];
  else if (roleHints.length > 1) {
    roleHint = aggregateEnums(roleHints, false, null, 'mixed', 'not_applicable');
  }

  let hasPercentFailure = false;
  let hasDirectionFailure = false;
  let percentFailureReason = 'none';
  let directionFailureReason = 'none';
  for (let v = 0; v < violations.length; v += 1) {
    const code = violations[v].code;
    const reason = violations[v].reasonCode;
    if (code === 'UNSUPPORTED_COMPARISON') {
      hasPercentFailure = true;
      if (reason === 'percent_not_in_ledger' && percentFailureReason === 'none') {
        percentFailureReason = 'percent_not_in_ledger';
      } else if (reason !== 'percent_not_in_ledger' && percentFailureReason === 'none') {
        percentFailureReason = 'other';
      }
    }
    if (code === 'UNAUTHORIZED_DIRECTION') {
      hasDirectionFailure = true;
      if (reason === 'direction_polarity_mismatch' && directionFailureReason === 'none') {
        directionFailureReason = 'direction_polarity_mismatch';
      } else if (reason !== 'direction_polarity_mismatch' && directionFailureReason === 'none') {
        directionFailureReason = 'other';
      }
    }
  }

  const primaryCode = resolvePrimaryCode(input);
  const primaryFailure = mapPrimaryFailure(primaryCode);

  return sanitizeTrendDiagnosticTelemetry({
    trend_diag_performed: true,
    trend_diag_reason: 'captured',
    trend_diag_authorized_direction: authorizedDirection,
    trend_diag_direction_token_count_bucket: tokenCountBucket(directionRows.length),
    trend_diag_direction_polarity: directionPolaritySummary,
    trend_diag_direction_match_status: directionMatch,
    trend_diag_direction_form: directionFormSummary,
    trend_diag_percent_token_count_bucket: tokenCountBucket(percentRows.length),
    trend_diag_percent_match_status: percentMatchStatus,
    trend_diag_percent_numeric_relation: percentNumeric,
    trend_diag_percent_expense_hint: expenseHint,
    trend_diag_percent_role_hint: roleHint,
    trend_diag_primary_failure: primaryFailure,
    trend_diag_percent_failure_reason: percentFailureReason,
    trend_diag_direction_failure_reason: directionFailureReason,
    trend_diag_has_percent_failure: hasPercentFailure,
    trend_diag_has_direction_failure: hasDirectionFailure,
    trend_diag_multiple_violation_families: hasPercentFailure && hasDirectionFailure,
    trend_diag_violation_count_bucket: violationCountBucket(violations.length),
  });
}

module.exports = {
  TREND_BLOCK_DIAGNOSTIC_ENV_KEY,
  TREND_BLOCK_DIAGNOSTIC_TELEMETRY_REMOVAL,
  TREND_DIAG_FIELD_KEYS,
  ENUMS,
  FORBIDDEN_OUTPUT_KEYS,
  isTrendBlockDiagnosticEnabled,
  sanitizeTrendDiagnosticTelemetry,
  buildTrendBlockedDiagnosticTelemetry,
};
