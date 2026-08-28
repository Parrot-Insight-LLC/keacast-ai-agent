'use strict';

/**
 * Phase 3C.4 Slice 8 — comparison period-scalar metric identity (shadow only).
 *
 * Verifies that an explicit spending/income/net label matches the deterministic
 * periodA/periodB claim that owns the spoken amount. Does not calculate values,
 * derive net, or reclassify metrics from sign or magnitude.
 */

const { parseLedgerPromptFlag } = require('./keaEvidencePromptCutover');

const COMPARISON_METRIC_VALIDATION_ENV_KEY = 'USE_COMPARISON_METRIC_VALIDATION_SHADOW';

const COMPARISON_METRIC_REASON = Object.freeze({
  METRIC_IDENTITY_MISMATCH: 'metric_identity_mismatch',
});

const PERIOD_SCALAR_PATH_RE = /^facts\.period[AB]\.(spending|income|net)$/;

function isComparisonMetricValidationEnabled() {
  const raw = process.env[COMPARISON_METRIC_VALIDATION_ENV_KEY];
  if (raw == null || String(raw).trim() === '') return false;
  return parseLedgerPromptFlag(raw).enabled === true;
}

function isComparisonContract(contract) {
  return !!(contract && (
    contract.sourceKind === 'cashflow_period_comparison'
    || contract.capability === 'cashflow_comparison'
  ));
}

function isClauseBreak(src, i) {
  const ch = src.charAt(i);
  if (ch === '!' || ch === '?' || ch === '\n' || ch === '\r' || ch === ';') return true;
  if (ch !== '.') return false;
  const prev = i > 0 ? src.charAt(i - 1) : '';
  const next = i + 1 < src.length ? src.charAt(i + 1) : '';
  if (/\d/.test(prev) && /\d/.test(next)) return false;
  return true;
}

function clausePrefixBefore(text, index) {
  const src = String(text || '');
  if (!src) return '';
  let idx = Number(index);
  if (!Number.isFinite(idx)) idx = 0;
  if (idx < 0) idx = 0;
  if (idx > src.length) idx = src.length;
  let start = 0;
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (isClauseBreak(src, i)) {
      start = i + 1;
      break;
    }
  }
  return src.slice(start, idx);
}

function pushUniqueSpan(rows, start, end, metric) {
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].start === start && rows[i].end === end) return;
  }
  rows.push({ start, end, metric });
}

function collectMetricTokens(before) {
  const src = String(before || '');
  const rows = [];
  const netFlow = /\bnet\s+cash\s*-?flow\b/gi;
  let m;
  while ((m = netFlow.exec(src))) {
    pushUniqueSpan(rows, m.index, m.index + m[0].length, 'net');
  }
  const spending = /\b(?:spending|expenses?|spent)\b/gi;
  while ((m = spending.exec(src))) {
    pushUniqueSpan(rows, m.index, m.index + m[0].length, 'spending');
  }
  const income = /\bincome\b/gi;
  while ((m = income.exec(src))) {
    pushUniqueSpan(rows, m.index, m.index + m[0].length, 'income');
  }
  const netBare = /\bnet\b/gi;
  while ((m = netBare.exec(src))) {
    const start = m.index;
    const end = m.index + m[0].length;
    let covered = false;
    for (let i = 0; i < rows.length; i += 1) {
      if (start >= rows[i].start && end <= rows[i].end && rows[i].metric === 'net') {
        covered = true;
        break;
      }
    }
    if (!covered) pushUniqueSpan(rows, start, end, 'net');
  }
  return rows;
}

function spokenMetricNearAmount(text, index) {
  const before = clausePrefixBefore(text, index);
  if (!before) return null;
  if (/\bnet\s+(?:spending|income|expenses?)\b/i.test(before)) return null;
  const tokens = collectMetricTokens(before);
  if (!tokens.length) return null;
  let last = tokens[0];
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i].start >= last.start) last = tokens[i];
  }
  return last.metric;
}

function metricFromPeriodScalarPath(path) {
  const m = String(path || '').match(PERIOD_SCALAR_PATH_RE);
  return m ? m[1] : null;
}

function isPeriodScalarClaim(claim) {
  return !!(claim && metricFromPeriodScalarPath(claim.path));
}

function evaluateComparisonMetricIdentity({
  contract,
  row,
  text,
  matches,
  roleDelta,
} = {}) {
  if (!isComparisonMetricValidationEnabled()) return { mismatch: false, reason: null };
  if (!isComparisonContract(contract)) return { mismatch: false, reason: null };
  if (roleDelta) return { mismatch: false, reason: null };
  if (!row) return { mismatch: false, reason: null };
  const spoken = spokenMetricNearAmount(text, Number.isFinite(row.start) ? row.start : row.position);
  if (!spoken) return { mismatch: false, reason: null };
  const rows = Array.isArray(matches) ? matches : [];
  const scalars = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (isPeriodScalarClaim(rows[i])) scalars.push(rows[i]);
  }
  if (!scalars.length) return { mismatch: false, reason: null };
  for (let i = 0; i < scalars.length; i += 1) {
    if (metricFromPeriodScalarPath(scalars[i].path) === spoken) {
      return { mismatch: false, reason: null };
    }
  }
  return {
    mismatch: true,
    reason: COMPARISON_METRIC_REASON.METRIC_IDENTITY_MISMATCH,
  };
}

module.exports = {
  COMPARISON_METRIC_VALIDATION_ENV_KEY,
  COMPARISON_METRIC_REASON,
  isComparisonMetricValidationEnabled,
  isComparisonContract,
  spokenMetricNearAmount,
  evaluateComparisonMetricIdentity,
};
