'use strict';

/**
 * Phase 3C.4 Slice 6 — lookup merchant + period attribution identity
 * (shadow only).
 *
 * Verifies that an explicit merchant or concrete period attached to a lookup
 * amount/count/no-income claim matches existing lookup scope authority.
 * Does not rerun search, sum transactions, fuzzy-match merchants, or
 * resolve relative periods.
 */

const { parseLedgerPromptFlag } = require('./keaEvidencePromptCutover');

const LOOKUP_ATTRIBUTION_VALIDATION_ENV_KEY = 'USE_LOOKUP_ATTRIBUTION_VALIDATION_SHADOW';

const LOOKUP_ATTRIBUTION_REASON = Object.freeze({
  MERCHANT_IDENTITY_MISMATCH: 'merchant_identity_mismatch',
  PERIOD_IDENTITY_MISMATCH: 'period_identity_mismatch',
});

const MONTH_INDEX = Object.freeze({
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
});

const MONTH_NAME = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';
const MONTH_TOKEN_RE = new RegExp('\\b(' + MONTH_NAME + ')(?:\\s+((?:19|20)\\d{2}))?\\b', 'gi');
const AT_MERCHANT_RE = /\b(?:at|from)\s+([A-Z][A-Za-z0-9&'.-]+)\b/g;
const MERCHANT_METRIC_RE = /\b([A-Z][A-Za-z0-9&'.-]+)\s+(?:spending|total|income|transactions?)\b/g;
const NO_INCOME_RE = /\bno\s+(?:recorded\s+)?(?:[A-Z][A-Za-z]+\s+)?income\b|\bincome recorded from\b/i;
const SKIP_MERCHANT = Object.freeze({
  you: true, your: true, this: true, that: true, there: true, the: true,
  in: true, during: true, for: true, from: true, last: true, next: true,
  posted: true, total: true, totals: true, spending: true, income: true,
  transaction: true, transactions: true, bill: true, bills: true,
  item: true, items: true, match: true, matches: true,
});

function isLookupAttributionValidationEnabled() {
  const raw = process.env[LOOKUP_ATTRIBUTION_VALIDATION_ENV_KEY];
  if (raw == null || String(raw).trim() === '') return false;
  return parseLedgerPromptFlag(raw).enabled === true;
}

function isLookupContract(contract) {
  return !!(contract && contract.sourceKind === 'user_transactions');
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

function clauseContaining(text, index) {
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
  let end = src.length;
  for (let i = idx; i < src.length; i += 1) {
    if (isClauseBreak(src, i)) {
      end = i;
      break;
    }
  }
  return src.slice(start, end);
}

function monthNum(name) {
  if (!name) return null;
  return MONTH_INDEX[String(name).toLowerCase()] || null;
}

function isMonthName(name) {
  return monthNum(name) != null;
}

function normalizeMerchant(value) {
  const s = String(value || '').trim().toLowerCase();
  return s || null;
}

function pushMerchant(out, raw) {
  const token = String(raw || '').trim();
  if (!token) return;
  if (SKIP_MERCHANT[token.toLowerCase()]) return;
  if (isMonthName(token)) return;
  if (out.indexOf(token) === -1) out.push(token);
}

function spokenMerchants(clause) {
  const src = String(clause || '');
  const out = [];
  if (!src) return out;
  AT_MERCHANT_RE.lastIndex = 0;
  let m;
  while ((m = AT_MERCHANT_RE.exec(src))) pushMerchant(out, m[1]);
  MERCHANT_METRIC_RE.lastIndex = 0;
  while ((m = MERCHANT_METRIC_RE.exec(src))) pushMerchant(out, m[1]);
  return out;
}

function spokenPeriods(clause) {
  const src = String(clause || '');
  const out = [];
  if (!src) return out;
  MONTH_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = MONTH_TOKEN_RE.exec(src))) {
    const month = monthNum(m[1]);
    if (!month) continue;
    const year = m[2] ? Number(m[2]) : null;
    out.push({ month, year: Number.isFinite(year) ? year : null });
  }
  return out;
}

function isoMonthYear(iso) {
  const s = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return { year: Number(s.slice(0, 4)), month: Number(s.slice(5, 7)) };
}

function authorityPeriod(contract) {
  const period = contract && contract.scope && contract.scope.period;
  if (!period) return null;
  const fromIso = isoMonthYear(period.start);
  if (fromIso) return fromIso;
  const label = String(period.label || '');
  const rows = spokenPeriods(label);
  return rows.length ? rows[0] : null;
}

function merchantMismatch(clause, authorizedMerchant) {
  const authorized = normalizeMerchant(authorizedMerchant);
  if (!authorized) return false;
  const spoken = spokenMerchants(clause);
  if (!spoken.length) return false;
  for (let i = 0; i < spoken.length; i += 1) {
    if (normalizeMerchant(spoken[i]) === authorized) return false;
  }
  return true;
}

function periodMismatch(clause, authorizedPeriod) {
  if (!authorizedPeriod || !authorizedPeriod.month) return false;
  const spoken = spokenPeriods(clause);
  if (!spoken.length) return false;
  for (let i = 0; i < spoken.length; i += 1) {
    const row = spoken[i];
    if (row.month !== authorizedPeriod.month) return true;
    if (row.year != null && authorizedPeriod.year != null && row.year !== authorizedPeriod.year) {
      return true;
    }
  }
  return false;
}

function classifyClause(clause, contract) {
  const reasons = [];
  const merchant = contract && contract.scope ? contract.scope.merchant : null;
  const period = authorityPeriod(contract);
  if (merchantMismatch(clause, merchant)) {
    reasons.push(LOOKUP_ATTRIBUTION_REASON.MERCHANT_IDENTITY_MISMATCH);
  }
  if (periodMismatch(clause, period)) {
    reasons.push(LOOKUP_ATTRIBUTION_REASON.PERIOD_IDENTITY_MISMATCH);
  }
  return reasons;
}

function evaluateLookupAttributionIdentity({ contract, row, text } = {}) {
  if (!isLookupAttributionValidationEnabled()) return { mismatch: false, reasons: [] };
  if (!isLookupContract(contract)) return { mismatch: false, reasons: [] };
  if (!row) return { mismatch: false, reasons: [] };
  const src = String(text || '');
  if (!src) return { mismatch: false, reasons: [] };
  const idx = Number.isFinite(row.start) ? row.start
    : (Number.isFinite(row.position) ? row.position : null);
  if (idx == null) return { mismatch: false, reasons: [] };
  const reasons = classifyClause(clauseContaining(src, idx), contract);
  if (!reasons.length) return { mismatch: false, reasons: [] };
  return { mismatch: true, reasons };
}

function evaluateLookupAbsenceAttribution({ contract, text } = {}) {
  if (!isLookupAttributionValidationEnabled()) return [];
  if (!isLookupContract(contract)) return [];
  const src = String(text || '');
  if (!src) return [];
  const hits = [];
  let start = 0;
  for (let i = 0; i <= src.length; i += 1) {
    if (i < src.length && !isClauseBreak(src, i)) continue;
    const clause = src.slice(start, i);
    const pos = start;
    start = i + 1;
    if (!NO_INCOME_RE.test(clause)) continue;
    const reasons = classifyClause(clause, contract);
    for (let r = 0; r < reasons.length; r += 1) {
      hits.push({ reason: reasons[r], position: pos });
    }
  }
  return hits;
}

module.exports = {
  LOOKUP_ATTRIBUTION_VALIDATION_ENV_KEY,
  LOOKUP_ATTRIBUTION_REASON,
  isLookupAttributionValidationEnabled,
  isLookupContract,
  spokenMerchants,
  spokenPeriods,
  evaluateLookupAttributionIdentity,
  evaluateLookupAbsenceAttribution,
};
