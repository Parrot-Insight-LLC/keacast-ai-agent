'use strict';

/**
 * Phase 3C.4 Slice 5 — trend matched-elapsed / full-month coverage identity
 * (shadow only).
 *
 * Verifies that an explicit full-month coverage phrase attached to a trend
 * period scalar is compatible with existing windowKind authority.
 * Does not calculate totals, extrapolate partial months, infer completeness
 * from dates, or derive trend direction / percent / absolute change.
 */

const { parseLedgerPromptFlag } = require('./keaEvidencePromptCutover');

const TREND_COVERAGE_VALIDATION_ENV_KEY = 'USE_TREND_COVERAGE_VALIDATION_SHADOW';

const TREND_COVERAGE_REASON = Object.freeze({
  MATCHED_ELAPSED_AS_FULL_MONTH: 'matched_elapsed_as_full_month',
});

const MONTH_NAME = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';

const FULL_MONTH_RE = /\b(?:full[- ]month|entire[- ]month|whole[- ]month|complete[- ]month)\b/i;
const ALL_OF_MONTH_RE = new RegExp(
  '\\ball\\s+of\\s+(?:the\\s+month|(?:' + MONTH_NAME + '))\\b',
  'i'
);
const ALL_MONTH_RE = /\ball\s+month\b/i;
const THROUGH_END_RE = /\bthrough\s+the\s+end\s+of\s+the\s+month\b/i;
const MONTHLY_METRIC_RE = /\bmonthly\s+(?:spending|total|expense|expenses|income)\b|\b(?:spending|total|expense|expenses|income)\s+monthly\b|\btotal\s+monthly\s+(?:spending|expense|expenses)\b|\bmonth\s+total\b/i;

function isTrendCoverageValidationEnabled() {
  const raw = process.env[TREND_COVERAGE_VALIDATION_ENV_KEY];
  if (raw == null || String(raw).trim() === '') return false;
  return parseLedgerPromptFlag(raw).enabled === true;
}

function isTrendContract(contract) {
  return !!(contract && (
    contract.sourceKind === 'cashflow_trend'
    || contract.capability === 'cashflow_trend'
  ));
}

function hasHint(hints, name) {
  return Array.isArray(hints) && hints.indexOf(name) !== -1;
}

function isClauseBreak(ch) {
  return ch === '.' || ch === '!' || ch === '?' || ch === '\n' || ch === '\r' || ch === ';';
}

function clauseContaining(text, index) {
  const src = String(text || '');
  if (!src) return '';
  let idx = Number(index);
  if (!Number.isFinite(idx)) idx = 0;
  if (idx < 0) idx = 0;
  if (idx > src.length) idx = src.length;
  let start = 0;
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (isClauseBreak(src.charAt(i))) {
      start = i + 1;
      break;
    }
  }
  let end = src.length;
  for (let i = idx; i < src.length; i += 1) {
    if (isClauseBreak(src.charAt(i))) {
      end = i;
      break;
    }
  }
  return src.slice(start, end);
}

function spokenTrendCoverage(clause) {
  const src = String(clause || '');
  if (!src) return null;
  if (FULL_MONTH_RE.test(src)) return 'full_month';
  if (ALL_OF_MONTH_RE.test(src)) return 'full_month';
  if (ALL_MONTH_RE.test(src)) return 'full_month';
  if (THROUGH_END_RE.test(src)) return 'full_month';
  if (MONTHLY_METRIC_RE.test(src)) return 'full_month';
  return null;
}

function evaluateTrendCoverageIdentity({ contract, row, text } = {}) {
  if (!isTrendCoverageValidationEnabled()) return { mismatch: false };
  if (!isTrendContract(contract)) return { mismatch: false };
  const windowKind = contract.scope && contract.scope.windowKind;
  if (windowKind !== 'matched_elapsed') return { mismatch: false };
  if (!row) return { mismatch: false };
  const hints = row.semanticHints || [];
  if (hasHint(hints, 'delta') && !hasHint(hints, 'period_value')) {
    return { mismatch: false };
  }
  const src = String(text || '');
  if (!src) return { mismatch: false };
  const idx = Number.isFinite(row.start) ? row.start
    : (Number.isFinite(row.position) ? row.position : null);
  if (idx == null) return { mismatch: false };
  const clause = clauseContaining(src, idx);
  if (spokenTrendCoverage(clause) !== 'full_month') return { mismatch: false };
  return {
    mismatch: true,
    reason: TREND_COVERAGE_REASON.MATCHED_ELAPSED_AS_FULL_MONTH,
  };
}

module.exports = {
  TREND_COVERAGE_VALIDATION_ENV_KEY,
  TREND_COVERAGE_REASON,
  isTrendCoverageValidationEnabled,
  isTrendContract,
  clauseContaining,
  spokenTrendCoverage,
  evaluateTrendCoverageIdentity,
};
