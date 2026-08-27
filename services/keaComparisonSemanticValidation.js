'use strict';

/**
 * Phase 3C.4 Slice 4 — comparison A/B period-relation identity (shadow only).
 *
 * Verifies that an explicit spoken A/B relation matches existing periodA → periodB
 * authority. Does not calculate values, derive direction from amounts, or
 * invent missing relations.
 */

const { parseLedgerPromptFlag } = require('./keaEvidencePromptCutover');

const COMPARISON_RELATION_VALIDATION_ENV_KEY = 'USE_COMPARISON_RELATION_VALIDATION_SHADOW';

const COMPARISON_RELATION_REASON = Object.freeze({
  PERIOD_RELATION_REVERSED: 'period_relation_reversed',
  BASELINE_TARGET_MISMATCH: 'baseline_target_mismatch',
  DIRECTION_RELATION_MISMATCH: 'direction_relation_mismatch',
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
const YEAR = '(?:19|20)\\d{2}';
const MONTH_TOKEN = '(' + MONTH_NAME + ')(?:\\s+(' + YEAR + '))?';

const FROM_TO_RE = new RegExp('\\bfrom\\s+' + MONTH_TOKEN + '\\s+to\\s+' + MONTH_TOKEN + '\\b', 'gi');
const COMPARED_COMMA_RE = new RegExp(
  '\\bcompared\\s+(?:with|to|against)\\s+' + MONTH_TOKEN + '\\s*[,;]\\s+' + MONTH_TOKEN + '\\b',
  'gi'
);
const COMPARED_RE = new RegExp(
  '\\b(?:compared\\s+(?:with|to|against)|relative\\s+to)\\s+' + MONTH_TOKEN + '\\b',
  'gi'
);
const THAN_RE = new RegExp(
  '\\b' + MONTH_TOKEN + '\\b([^\\n]{0,96}?)\\b(lower|higher|less)\\s+than\\s+(?:in\\s+)?' + MONTH_TOKEN + '\\b',
  'gi'
);
const LESS_IN_THAN_RE = new RegExp(
  '\\b(less|lower|higher)\\s+in\\s+' + MONTH_TOKEN + '\\s+than\\s+(?:in\\s+)?' + MONTH_TOKEN + '\\b',
  'gi'
);
const MONTH_FIND_RE = new RegExp('\\b' + MONTH_TOKEN + '\\b', 'gi');

function isComparisonRelationValidationEnabled() {
  const raw = process.env[COMPARISON_RELATION_VALIDATION_ENV_KEY];
  if (raw == null || String(raw).trim() === '') return false;
  return parseLedgerPromptFlag(raw).enabled === true;
}

function isComparisonContract(contract) {
  return !!(contract && (
    contract.sourceKind === 'cashflow_period_comparison'
    || contract.capability === 'cashflow_comparison'
  ));
}

function monthNum(name) {
  if (!name) return null;
  return MONTH_INDEX[String(name).toLowerCase()] || null;
}

function spokenPeriod(monthName, yearText) {
  const month = monthNum(monthName);
  if (!month) return null;
  const year = yearText ? Number(yearText) : null;
  return { month, year: Number.isFinite(year) ? year : null };
}

function isoMonthYear(iso) {
  const s = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return { year: Number(s.slice(0, 4)), month: Number(s.slice(5, 7)) };
}

function identityFromPeriod(period) {
  if (!period || typeof period !== 'object') return null;
  const fromIso = isoMonthYear(period.start);
  if (fromIso) return fromIso;
  const label = String(period.label || '');
  MONTH_FIND_RE.lastIndex = 0;
  const m = MONTH_FIND_RE.exec(label);
  if (!m) return null;
  return spokenPeriod(m[1], m[2]);
}

function directionPolarity(token) {
  const t = String(token || '').toLowerCase();
  if (!t) return null;
  if (t === 'decrease' || t === 'decreased' || t === 'decreasing' || t === 'lower'
    || t === 'dropped' || t === 'falling' || t === 'downward' || t === 'fell' || t === 'less'
    || t === 'worsened' || t === 'worsening') {
    return 'down';
  }
  if (t === 'increase' || t === 'increased' || t === 'increasing' || t === 'higher'
    || t === 'rose' || t === 'rising' || t === 'upward' || t === 'improved'
    || t === 'improving') {
    return 'up';
  }
  return null;
}

function comparisonAuthority(contract) {
  const claims = (contract && Array.isArray(contract.allowedClaims)) ? contract.allowedClaims : [];
  let periodA = null;
  let periodB = null;
  let spendingPolarity = null;
  let anyPolarity = null;
  for (let i = 0; i < claims.length; i += 1) {
    const claim = claims[i];
    if (!claim) continue;
    const path = String(claim.path || '');
    if (claim.period) {
      const ident = identityFromPeriod(claim.period);
      if (ident) {
        if (path === 'facts.periodA' || path.indexOf('facts.periodA.') === 0) periodA = ident;
        if (path === 'facts.periodB' || path.indexOf('facts.periodB.') === 0) periodB = ident;
      }
    }
    if (claim.type === 'DIRECTION') {
      const pol = directionPolarity(claim.value);
      if (pol) {
        anyPolarity = pol;
        if (/\.spending\.direction$/.test(path) || /spending/.test(path)) spendingPolarity = pol;
      }
    }
  }
  return {
    periodA,
    periodB,
    polarity: spendingPolarity || anyPolarity,
  };
}

function matchesPeriod(spoken, authority) {
  if (!spoken || !authority || spoken.month !== authority.month) return false;
  if (spoken.year != null && authority.year != null && spoken.year !== authority.year) return false;
  return true;
}

function sameSpokenPeriod(a, b) {
  if (!a || !b || a.month !== b.month) return false;
  if (a.year != null && b.year != null && a.year !== b.year) return false;
  return true;
}

function isAuthorizedPair(fromPeriod, toPeriod, authority) {
  return matchesPeriod(fromPeriod, authority.periodA)
    && matchesPeriod(toPeriod, authority.periodB);
}

function isReversedPair(fromPeriod, toPeriod, authority) {
  return matchesPeriod(fromPeriod, authority.periodB)
    && matchesPeriod(toPeriod, authority.periodA);
}

function clauseStart(text, index) {
  const src = String(text || '');
  const pos = Number(index) || 0;
  for (let i = pos - 1; i >= 0; i -= 1) {
    const ch = src.charAt(i);
    if (ch === '\n' || ch === '\r') return i + 1;
    if ((ch === '.' || ch === '!' || ch === '?')
      && (src.charAt(i + 1) === ' ' || src.charAt(i + 1) === '\n' || src.charAt(i + 1) === '')) {
      return i + 1;
    }
  }
  return 0;
}

function sameClause(text, from, to) {
  const mid = String(text || '').slice(from, to);
  if (mid.indexOf('\n') !== -1 || mid.indexOf('\r') !== -1) return false;
  if (/\.\s/.test(mid) || /!\s/.test(mid) || /\?\s/.test(mid)) return false;
  return true;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function lastMonthBefore(text, from, to) {
  const slice = String(text || '').slice(from, to);
  MONTH_FIND_RE.lastIndex = 0;
  let last = null;
  let m;
  while ((m = MONTH_FIND_RE.exec(slice))) {
    last = spokenPeriod(m[1], m[2]);
  }
  return last;
}

function pushUnique(rows, row) {
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].form === row.form
      && rows[i].start === row.start
      && rows[i].end === row.end) {
      return;
    }
  }
  rows.push(row);
}

function extractComparisonRelations(text) {
  const src = String(text || '');
  const rows = [];
  if (!src) return rows;

  FROM_TO_RE.lastIndex = 0;
  let m;
  while ((m = FROM_TO_RE.exec(src))) {
    const fromPeriod = spokenPeriod(m[1], m[2]);
    const toPeriod = spokenPeriod(m[3], m[4]);
    if (!fromPeriod || !toPeriod || sameSpokenPeriod(fromPeriod, toPeriod)) continue;
    if (m[0].indexOf('\n') !== -1 || m[0].indexOf('\r') !== -1) continue;
    pushUnique(rows, {
      form: 'from_to',
      fromPeriod,
      toPeriod,
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  COMPARED_COMMA_RE.lastIndex = 0;
  while ((m = COMPARED_COMMA_RE.exec(src))) {
    const reference = spokenPeriod(m[1], m[2]);
    const subject = spokenPeriod(m[3], m[4]);
    if (!reference || !subject || sameSpokenPeriod(subject, reference)) continue;
    if (m[0].indexOf('\n') !== -1 || m[0].indexOf('\r') !== -1) continue;
    pushUnique(rows, {
      form: 'compared_with',
      fromPeriod: reference,
      toPeriod: subject,
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  COMPARED_RE.lastIndex = 0;
  while ((m = COMPARED_RE.exec(src))) {
    const reference = spokenPeriod(m[1], m[2]);
    if (!reference) continue;
    if (m[0].indexOf('\n') !== -1 || m[0].indexOf('\r') !== -1) continue;
    let covered = false;
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].form === 'compared_with'
        && overlaps(rows[i].start, rows[i].end, m.index, m.index + m[0].length)) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    const subject = lastMonthBefore(src, clauseStart(src, m.index), m.index);
    if (!subject || sameSpokenPeriod(subject, reference)) continue;
    pushUnique(rows, {
      form: 'compared_with',
      fromPeriod: reference,
      toPeriod: subject,
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  THAN_RE.lastIndex = 0;
  while ((m = THAN_RE.exec(src))) {
    const subject = spokenPeriod(m[1], m[2]);
    const gap = m[3] || '';
    const token = String(m[4] || '').toLowerCase();
    const reference = spokenPeriod(m[5], m[6]);
    if (!subject || !reference || sameSpokenPeriod(subject, reference)) continue;
    if (m[0].indexOf('\n') !== -1 || m[0].indexOf('\r') !== -1) continue;
    if (!sameClause(src, m.index, m.index + m[0].length)) continue;
    if (/\bcompared\b/i.test(gap)) continue;
    const polarity = token === 'higher' ? 'up' : 'down';
    pushUnique(rows, {
      form: 'than',
      fromPeriod: reference,
      toPeriod: subject,
      polarity,
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  LESS_IN_THAN_RE.lastIndex = 0;
  while ((m = LESS_IN_THAN_RE.exec(src))) {
    const token = String(m[1] || '').toLowerCase();
    const subject = spokenPeriod(m[2], m[3]);
    const reference = spokenPeriod(m[4], m[5]);
    if (!subject || !reference || sameSpokenPeriod(subject, reference)) continue;
    if (m[0].indexOf('\n') !== -1 || m[0].indexOf('\r') !== -1) continue;
    pushUnique(rows, {
      form: 'than',
      fromPeriod: reference,
      toPeriod: subject,
      polarity: token === 'higher' ? 'up' : 'down',
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  return rows;
}

function classifyRelation(row, authority) {
  if (!row || !authority || !authority.periodA || !authority.periodB) return null;
  if (row.form === 'from_to' || row.form === 'compared_with') {
    if (isAuthorizedPair(row.fromPeriod, row.toPeriod, authority)) return null;
    if (isReversedPair(row.fromPeriod, row.toPeriod, authority)) {
      return row.form === 'compared_with'
        ? COMPARISON_RELATION_REASON.BASELINE_TARGET_MISMATCH
        : COMPARISON_RELATION_REASON.PERIOD_RELATION_REVERSED;
    }
    return null;
  }
  if (row.form === 'than') {
    if (isAuthorizedPair(row.fromPeriod, row.toPeriod, authority)) {
      if (authority.polarity && row.polarity && row.polarity !== authority.polarity) {
        return COMPARISON_RELATION_REASON.DIRECTION_RELATION_MISMATCH;
      }
      return null;
    }
    if (isReversedPair(row.fromPeriod, row.toPeriod, authority)) {
      if (authority.polarity && row.polarity && row.polarity === authority.polarity) {
        return COMPARISON_RELATION_REASON.PERIOD_RELATION_REVERSED;
      }
      return null;
    }
  }
  return null;
}

function evaluateComparisonRelationIdentity({ contract, text } = {}) {
  if (!isComparisonRelationValidationEnabled()) return [];
  if (!isComparisonContract(contract)) return [];
  const src = String(text || '');
  if (!src) return [];
  const authority = comparisonAuthority(contract);
  if (!authority.periodA || !authority.periodB) return [];
  const relations = extractComparisonRelations(src);
  const out = [];
  for (let i = 0; i < relations.length; i += 1) {
    const reason = classifyRelation(relations[i], authority);
    if (!reason) continue;
    out.push({
      reason,
      position: relations[i].start || 0,
    });
  }
  return out;
}

module.exports = {
  COMPARISON_RELATION_VALIDATION_ENV_KEY,
  COMPARISON_RELATION_REASON,
  isComparisonRelationValidationEnabled,
  isComparisonContract,
  extractComparisonRelations,
  evaluateComparisonRelationIdentity,
};
