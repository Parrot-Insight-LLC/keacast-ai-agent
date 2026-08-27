'use strict';

/**
 * Phase 3C.4 Slice 7 — snapshot negative-balance event vs minimum/ranking
 * identity (shadow only).
 *
 * Verifies that an authorized futureNegativeBalances event is not narrated
 * as a period/horizon minimum or ranked extreme unless the contract already
 * owns that ranking claim. Does not calculate minima, sort events, or rank.
 */

const { parseLedgerPromptFlag } = require('./keaEvidencePromptCutover');

const SNAPSHOT_NEGATIVE_MINIMUM_VALIDATION_ENV_KEY = 'USE_SNAPSHOT_NEGATIVE_MINIMUM_VALIDATION_SHADOW';

const SNAPSHOT_NEGATIVE_MINIMUM_REASON = Object.freeze({
  NEGATIVE_EVENT_AS_MINIMUM: 'negative_event_as_minimum',
});

const MONTH_NAME = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';

const MINIMUM_LANGUAGE_RE = /\b(?:lowest|minimum|worst)\s+(?:projected\s+)?(?:future\s+)?(?:negative\s+)?balance\b|\bmost\s+negative\s+(?:future\s+)?balance\b|\bbalance\s+(?:will\s+)?bottoms?\s+out\b|\bbottoms?\s+out\s+at\b|\bbottom\s+balance\b/i;

const BROAD_PERIOD_RE = /\b(?:next month|this month|forecast horizon|(?:over|across)\s+(?:the\s+)?(?:forecast\s+)?horizon|next\s+\d+\s+days|90 days|in the future|future balance)\b/i;

const MONTH_TOKEN_RE = new RegExp('\\b(' + MONTH_NAME + ')\\b', 'gi');
const AFTER_MONTH_DAY_RE = /^\s+\d{1,2}\b/;
const EXACT_DAY_RE = new RegExp('\\b(?:' + MONTH_NAME + ')\\s+\\d{1,2}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b', 'i');

function isSnapshotNegativeMinimumValidationEnabled() {
  const raw = process.env[SNAPSHOT_NEGATIVE_MINIMUM_VALIDATION_ENV_KEY];
  if (raw == null || String(raw).trim() === '') return false;
  return parseLedgerPromptFlag(raw).enabled === true;
}

function isSnapshotContract(contract) {
  return !!(contract && contract.sourceKind === 'kea_snapshot');
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

function isNegativeEventHit(hit) {
  return !!(hit && hit.listName === 'futureNegativeBalances');
}

function isNegativeEventClaim(boundHit, amountCandidates) {
  if (boundHit) return isNegativeEventHit(boundHit);
  const rows = Array.isArray(amountCandidates) ? amountCandidates : [];
  for (let i = 0; i < rows.length; i += 1) {
    if (isNegativeEventHit(rows[i])) return true;
  }
  return false;
}

function hasAuthorizedRankingClaim(contract) {
  const claims = (contract && Array.isArray(contract.allowedClaims)) ? contract.allowedClaims : [];
  for (let i = 0; i < claims.length; i += 1) {
    const claim = claims[i];
    if (!claim) continue;
    if (claim.semanticRole === 'ranking') return true;
    if (claim.type === 'RANKING') return true;
    const path = String(claim.path || '').toLowerCase();
    if (path.indexOf('minimum') !== -1 || path.indexOf('lowest') !== -1 || path.indexOf('worst') !== -1) {
      return true;
    }
  }
  return false;
}

function hasMinimumLanguage(clause) {
  return MINIMUM_LANGUAGE_RE.test(String(clause || ''));
}

function hasBroadPeriodLanguage(clause) {
  const src = String(clause || '');
  if (!src) return false;
  if (BROAD_PERIOD_RE.test(src)) return true;
  MONTH_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = MONTH_TOKEN_RE.exec(src))) {
    const after = src.slice(m.index + m[0].length);
    if (!AFTER_MONTH_DAY_RE.test(after)) return true;
  }
  return false;
}

function hasExactDayDate(clause) {
  return EXACT_DAY_RE.test(String(clause || ''));
}

function hasNegativeEventList(contract) {
  const rows = contract && contract.allowedListItems && contract.allowedListItems.futureNegativeBalances;
  return Array.isArray(rows) && rows.length > 0;
}

function clauseIsRankingMismatch(clause, contract) {
  if (hasAuthorizedRankingClaim(contract)) return false;
  if (!hasMinimumLanguage(clause)) return false;
  if (!hasBroadPeriodLanguage(clause) && hasExactDayDate(clause)) return false;
  return true;
}

function evaluateSnapshotNegativeMinimumIdentity({
  contract,
  row,
  text,
  amountCandidates,
  boundHit,
} = {}) {
  if (!isSnapshotNegativeMinimumValidationEnabled()) return { mismatch: false, reason: null };
  if (!isSnapshotContract(contract)) return { mismatch: false, reason: null };
  if (!isNegativeEventClaim(boundHit, amountCandidates)) return { mismatch: false, reason: null };
  if (!row) return { mismatch: false, reason: null };
  const src = String(text || '');
  if (!src) return { mismatch: false, reason: null };
  const idx = Number.isFinite(row.start) ? row.start
    : (Number.isFinite(row.position) ? row.position : null);
  if (idx == null) return { mismatch: false, reason: null };
  if (!clauseIsRankingMismatch(clauseContaining(src, idx), contract)) {
    return { mismatch: false, reason: null };
  }
  return {
    mismatch: true,
    reason: SNAPSHOT_NEGATIVE_MINIMUM_REASON.NEGATIVE_EVENT_AS_MINIMUM,
  };
}

function evaluateSnapshotNegativeMinimumNarration({ contract, text } = {}) {
  if (!isSnapshotNegativeMinimumValidationEnabled()) return [];
  if (!isSnapshotContract(contract)) return [];
  if (!hasNegativeEventList(contract)) return [];
  const src = String(text || '');
  if (!src) return [];
  const hits = [];
  let start = 0;
  for (let i = 0; i <= src.length; i += 1) {
    if (i < src.length && !isClauseBreak(src, i)) continue;
    const clause = src.slice(start, i);
    const pos = start;
    start = i + 1;
    if (clause.indexOf('$') !== -1) continue;
    if (!clauseIsRankingMismatch(clause, contract)) continue;
    hits.push({
      reason: SNAPSHOT_NEGATIVE_MINIMUM_REASON.NEGATIVE_EVENT_AS_MINIMUM,
      position: pos,
    });
  }
  return hits;
}

module.exports = {
  SNAPSHOT_NEGATIVE_MINIMUM_VALIDATION_ENV_KEY,
  SNAPSHOT_NEGATIVE_MINIMUM_REASON,
  isSnapshotNegativeMinimumValidationEnabled,
  isSnapshotContract,
  hasMinimumLanguage,
  evaluateSnapshotNegativeMinimumIdentity,
  evaluateSnapshotNegativeMinimumNarration,
};
