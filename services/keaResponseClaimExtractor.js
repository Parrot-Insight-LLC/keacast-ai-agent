'use strict';

/**
 * Phase 3C.1 — deterministic assistant-text claim extractor.
 *
 * Arabic-numeral USD, counts, dates, and colocated tuples only.
 * No Ledger dependency. No network. No logging.
 */

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

const CLAIM_KIND = Object.freeze({
  AMOUNT: 'amount',
  COUNT: 'count',
  DATE: 'date',
  PERIOD: 'period',
  RELATIVE_PERIOD: 'relative_period',
  DURATION: 'duration',
  YEAR: 'year',
  ENTITY_AMOUNT: 'entity_amount',
  ENTITY_AMOUNT_DATE: 'entity_amount_date',
  UNKNOWN_NUMERIC: 'unknown_numeric',
  PERCENT: 'percent',
  DIRECTION: 'direction',
  RANKING_CANDIDATE: 'ranking_candidate',
});

const MONEY_HINT = /\b(dollar|dollars|usd|expense|expenses|income|balance|amount|total|totals|totaling|totalling|spent|spend|spending|cost|net|cash|paid)\b/i;
const EXPENSE_HINT = /\b(expense|expenses|spent|spend|spending|bill|bills|cost|costs)\b/i;
const INCOME_HINT = /\b(income|paycheck|deposit|earned|revenue)\b/i;
const FUTURE_HINT = /\b(next month|end of next month|forecasted|forecasting|projected|will be|expected to|increase by|decrease by|next week)\b/i;
const PREVIEW_TOTAL_HINT = /\b(listed above|transactions listed|transactions above|above total|listed transactions)\b/i;
const APPROX_HINT = /\b(approximately|approx(?:imately)?|about|roughly|around)\b/i;
const INCREASE_HINT = /\b(increase by|net (?:positive )?cash flow|results in a net|net of)\b/i;
const RANKING_HINT = /\b(largest|smallest|highest|lowest|biggest)\s+(expense|income|bill|transaction|amount|category|merchant)\b/i;
const DIRECTION_HINT = /\b(will increase|will decrease|will rise|will fall|expected to increase|expected to decrease|increased|increasing|increase|decreased|decreasing|decrease|higher|lower|rose|rising|dropped|falling|upward|downward|less)\b/gi;
const MONTH_NAME = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

function used(consumed, start, end) {
  for (let i = 0; i < consumed.length; i += 1) {
    if (overlaps(consumed[i], { start, end })) return true;
  }
  return false;
}

function mark(consumed, start, end) {
  consumed.push({ start, end });
}

function windowText(text, start, end, radius) {
  const from = Math.max(0, start - radius);
  const to = Math.min(text.length, end + radius);
  return text.slice(from, to);
}

function concatHints(base, extra) {
  const out = Array.isArray(base) ? base.slice() : [];
  const add = Array.isArray(extra) ? extra : [];
  for (let i = 0; i < add.length; i += 1) {
    if (out.indexOf(add[i]) === -1) out.push(add[i]);
  }
  return out;
}

function amountRoleHints(text, start) {
  const before = text.slice(Math.max(0, start - 64), start);
  const hints = [];
  const changeNounWas = /\b(?:absolute\s+)?(?:decrease|increase|change|difference)(?:\s+in\s+(?:spending|income|expenses?))?\s+was\s+$/i.test(before)
    || /\b(?:spending|income|expenses?)\s+(?:decrease|increase|change|difference)\s+was\s+$/i.test(before);
  const metricWas = /\b(?:spending|income|expenses?)\s+was\s+$/i.test(before);
  if (/\b(?:further\s+)?(?:decreased|increased|fell|rose|dropped|falling)\s+to\s+$/i.test(before)
    || (metricWas && !changeNounWas)) {
    hints.push('period_value');
  }
  if (/\b(?:further\s+)?(?:decreased|increased|fell|rose|dropped)\s+by\s+$/i.test(before)
    || changeNounWas) {
    hints.push('delta');
  }
  return hints;
}

function dateMonthOf(row) {
  if (row && row.month) return row.month;
  if (row && row.iso && /^\d{4}-\d{2}-\d{2}$/.test(row.iso)) return Number(row.iso.slice(5, 7));
  return null;
}

function listItemBounds(text, index) {
  const src = String(text || '');
  const pos = Number(index) || 0;
  let start = 0;
  for (let i = pos - 1; i >= 0; i -= 1) {
    const ch = src.charAt(i);
    if (ch === '\n' || ch === '\r') {
      start = i + 1;
      break;
    }
  }
  let end = src.length;
  for (let i = pos; i < src.length; i += 1) {
    const ch = src.charAt(i);
    if (ch === '\n' || ch === '\r') {
      end = i;
      break;
    }
  }
  return { start, end };
}

const RECURRING_NEXT_DATE_PREFIX = /\b(?:next\s+(?:due|occurrence)|due)\s*:?\s*$/i;

function findSameItemRecurringNextDate(text, amount, dates) {
  if (!amount || !Array.isArray(dates) || !dates.length) return null;
  const bounds = listItemBounds(text, amount.start);
  const following = [];
  const preceding = [];
  for (let i = 0; i < dates.length; i += 1) {
    const date = dates[i];
    if (!date) continue;
    if (date.start < bounds.start || date.start >= bounds.end) continue;
    const prefix = String(text || '').slice(bounds.start, date.start);
    if (!RECURRING_NEXT_DATE_PREFIX.test(prefix)) continue;
    const followingDate = date.start >= (amount.end || amount.start);
    const dist = followingDate
      ? date.start - (amount.end || amount.start)
      : (amount.start || 0) - (date.end || date.start);
    const row = { date, dist };
    if (followingDate) following.push(row);
    else preceding.push(row);
  }
  const pool = following.length ? following : preceding;
  if (!pool.length) return null;
  let best = pool[0];
  for (let i = 1; i < pool.length; i += 1) {
    if (pool[i].dist < best.dist) best = pool[i];
  }
  return best.date;
}

function pickNearbyDate(amount, dates, entity) {
  const entityMonth = monthNum(entity);
  const scored = [];
  for (let d = 0; d < dates.length; d += 1) {
    const dist = dates[d].start > amount.start
      ? dates[d].start - amount.start
      : amount.start - dates[d].start;
    if (dist > 72) continue;
    scored.push({
      date: dates[d],
      dist,
      preceding: (dates[d].end || dates[d].start) <= amount.start,
      month: dateMonthOf(dates[d]),
    });
  }
  if (!scored.length) return null;
  function bestOf(rows) {
    let best = rows[0];
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i].dist < best.dist) best = rows[i];
      else if (rows[i].dist === best.dist && rows[i].preceding && !best.preceding) best = rows[i];
    }
    return best.date;
  }
  if (entityMonth) {
    const same = [];
    for (let i = 0; i < scored.length; i += 1) {
      if (scored[i].month === entityMonth) same.push(scored[i]);
    }
    if (same.length) return bestOf(same);
  }
  return bestOf(scored);
}

function nearbyHints(text, start, end) {
  const nearby = windowText(text, start, end, 96);
  const wide = windowText(text, start, end, 140);
  const hints = [];
  if (MONEY_HINT.test(nearby)) hints.push('money');
  if (EXPENSE_HINT.test(nearby)) hints.push('expense');
  if (INCOME_HINT.test(nearby)) hints.push('income');
  if (/\bbalance\b/i.test(nearby)) hints.push('balance');
  if (FUTURE_HINT.test(nearby)) hints.push('future');
  if (/\b(september|october|november|december)\b/i.test(nearby) && /\b(projected|forecasted|next month)\b/i.test(wide)) {
    if (hints.indexOf('future') === -1) hints.push('future');
    hints.push('named_future_month');
  }
  if (PREVIEW_TOTAL_HINT.test(wide)) hints.push('preview_total');
  if (APPROX_HINT.test(nearby)) hints.push('approximate');
  if (INCREASE_HINT.test(nearby)) hints.push('derivation');
  return hints;
}

function parseGroupedNumber(raw) {
  const signed = /^-/.test(String(raw).replace(/^\$/, ''));
  const cleaned = String(raw).replace(/[$,]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return { value: n, negative: signed || n < 0 };
}

function monthNum(name) {
  const key = String(name || '').toLowerCase();
  return MONTH_INDEX[key] || null;
}

function isoFromParts(year, month, day) {
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function extractResponseClaims(text, options) {
  void options;
  const src = typeof text === 'string' ? text : '';
  const consumed = [];
  const claims = [];
  let n = 0;

  function add(partial) {
    n += 1;
    const row = Object.assign({ id: `e${n}`, position: partial.start }, partial);
    claims.push(row);
  }

  const isoRe = /\b(\d{4}-\d{2}-\d{2})\b/g;
  let m;
  while ((m = isoRe.exec(src))) {
    add({
      kind: CLAIM_KIND.DATE,
      rawSpan: m[1],
      iso: m[1],
      year: Number(m[1].slice(0, 4)),
      month: Number(m[1].slice(5, 7)),
      day: Number(m[1].slice(8, 10)),
      start: m.index,
      end: m.index + m[0].length,
    });
    mark(consumed, m.index, m.index + m[0].length);
  }

  const monthDayYear = new RegExp(
    `\\b(${MONTH_NAME})\\s+(\\d{1,2})(?:,)?\\s+(\\d{4})\\b`,
    'gi'
  );
  while ((m = monthDayYear.exec(src))) {
    if (used(consumed, m.index, m.index + m[0].length)) continue;
    const month = monthNum(m[1]);
    const day = Number(m[2]);
    const year = Number(m[3]);
    if (!month || day < 1 || day > 31) continue;
    add({
      kind: CLAIM_KIND.DATE,
      rawSpan: m[0],
      iso: isoFromParts(year, month, day),
      year,
      month,
      day,
      start: m.index,
      end: m.index + m[0].length,
    });
    mark(consumed, m.index, m.index + m[0].length);
  }

  const monthYear = new RegExp(`\\b(${MONTH_NAME})\\s+(\\d{4})\\b`, 'gi');
  while ((m = monthYear.exec(src))) {
    if (used(consumed, m.index, m.index + m[0].length)) continue;
    const month = monthNum(m[1]);
    const year = Number(m[2]);
    if (!month) continue;
    add({
      kind: CLAIM_KIND.PERIOD,
      rawSpan: m[0],
      year,
      month,
      start: m.index,
      end: m.index + m[0].length,
    });
    mark(consumed, m.index, m.index + m[0].length);
  }

  const monthDay = new RegExp(`\\b(${MONTH_NAME})\\s+(\\d{1,2})\\b`, 'gi');
  while ((m = monthDay.exec(src))) {
    if (used(consumed, m.index, m.index + m[0].length)) continue;
    const month = monthNum(m[1]);
    const day = Number(m[2]);
    if (!month || day < 1 || day > 31) continue;
    add({
      kind: CLAIM_KIND.DATE,
      rawSpan: m[0],
      iso: null,
      month,
      day,
      start: m.index,
      end: m.index + m[0].length,
    });
    mark(consumed, m.index, m.index + m[0].length);
  }

  const durationRe = /\b(\d+)\s+(days?|weeks?)\b/gi;
  while ((m = durationRe.exec(src))) {
    if (used(consumed, m.index, m.index + m[0].length)) continue;
    add({
      kind: CLAIM_KIND.DURATION,
      rawSpan: m[0],
      normalizedValue: Number(m[1]),
      unit: /week/i.test(m[2]) ? 'weeks' : 'days',
      start: m.index,
      end: m.index + m[0].length,
    });
    mark(consumed, m.index, m.index + m[0].length);
  }

  const countRe = /\b(\d+)\s+(?:[A-Za-z][A-Za-z'-]+\s+)?(transactions?|bills?|matches?|items?)\b/gi;
  while ((m = countRe.exec(src))) {
    if (used(consumed, m.index, m.index + m[0].length)) continue;
    add({
      kind: CLAIM_KIND.COUNT,
      rawSpan: m[0],
      normalizedValue: Number(m[1]),
      unit: 'count',
      nearbyTerms: windowText(src, m.index, m.index + m[0].length, 32),
      start: m.index,
      end: m.index + m[0].length,
    });
    mark(consumed, m.index, m.index + m[0].length);
  }

  const percentRe = /([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(%|percent\b)/gi;
  while ((m = percentRe.exec(src))) {
    const prev = m.index > 0 ? src.charAt(m.index - 1) : '';
    if (prev === '$') continue;
    if (used(consumed, m.index, m.index + m[0].length)) continue;
    const parsed = parseGroupedNumber(m[1]);
    if (!parsed) continue;
    add({
      kind: CLAIM_KIND.PERCENT,
      rawSpan: m[0],
      normalizedValue: parsed.value,
      unit: 'percent',
      sign: parsed.value < 0 ? 'negative' : 'positive',
      semanticHints: nearbyHints(src, m.index, m.index + m[0].length),
      nearbyTerms: windowText(src, m.index, m.index + m[0].length, 48),
      start: m.index,
      end: m.index + m[0].length,
    });
    mark(consumed, m.index, m.index + m[0].length);
  }

  const dollarRe = /(?:-\$|\$\-?)(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?/g;
  while ((m = dollarRe.exec(src))) {
    if (used(consumed, m.index, m.index + m[0].length)) continue;
    const parsed = parseGroupedNumber(m[0]);
    if (!parsed) continue;
    const hints = concatHints(
      nearbyHints(src, m.index, m.index + m[0].length),
      amountRoleHints(src, m.index)
    );
    add({
      kind: CLAIM_KIND.AMOUNT,
      rawSpan: m[0],
      normalizedValue: parsed.value,
      currency: 'USD',
      sign: parsed.value < 0 ? 'negative' : 'positive',
      semanticHints: hints,
      nearbyTerms: windowText(src, m.index, m.index + m[0].length, 48),
      start: m.index,
      end: m.index + m[0].length,
    });
    mark(consumed, m.index, m.index + m[0].length);
  }

  const dollarsWord = /(\-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s+dollars\b/gi;
  while ((m = dollarsWord.exec(src))) {
    if (used(consumed, m.index, m.index + m[0].length)) continue;
    const parsed = parseGroupedNumber(m[1]);
    if (!parsed) continue;
    add({
      kind: CLAIM_KIND.AMOUNT,
      rawSpan: m[0],
      normalizedValue: parsed.value,
      currency: 'USD',
      sign: parsed.value < 0 ? 'negative' : 'positive',
      semanticHints: concatHints(
        nearbyHints(src, m.index, m.index + m[0].length).concat(['money']),
        amountRoleHints(src, m.index)
      ),
      nearbyTerms: windowText(src, m.index, m.index + m[0].length, 48),
      start: m.index,
      end: m.index + m[0].length,
    });
    mark(consumed, m.index, m.index + m[0].length);
  }

  const yearRe = /\b((?:19|20)\d{2})\b/g;
  while ((m = yearRe.exec(src))) {
    if (used(consumed, m.index, m.index + m[0].length)) continue;
    add({
      kind: CLAIM_KIND.YEAR,
      rawSpan: m[1],
      normalizedValue: Number(m[1]),
      year: Number(m[1]),
      start: m.index,
      end: m.index + m[0].length,
    });
    mark(consumed, m.index, m.index + m[0].length);
  }

  const relativeRe = /\b(next month|last month|next week|last week|next two weeks|this month)\b/gi;
  while ((m = relativeRe.exec(src))) {
    add({
      kind: CLAIM_KIND.RELATIVE_PERIOD,
      rawSpan: m[0],
      token: m[0].toLowerCase().replace(/\s+/g, '_'),
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  const bareDecimal = /\b\d+\.\d{2}\b/g;
  while ((m = bareDecimal.exec(src))) {
    if (used(consumed, m.index, m.index + m[0].length)) continue;
    const nearby = windowText(src, m.index, m.index + m[0].length, 32);
    const nVal = Number(m[0]);
    if (!Number.isFinite(nVal)) continue;
    if (MONEY_HINT.test(nearby)) {
      add({
        kind: CLAIM_KIND.AMOUNT,
        rawSpan: m[0],
        normalizedValue: nVal,
        currency: 'USD',
        sign: 'positive',
        semanticHints: concatHints(
          nearbyHints(src, m.index, m.index + m[0].length),
          amountRoleHints(src, m.index)
        ),
        nearbyTerms: nearby,
        start: m.index,
        end: m.index + m[0].length,
      });
    } else {
      add({
        kind: CLAIM_KIND.UNKNOWN_NUMERIC,
        rawSpan: m[0],
        normalizedValue: nVal,
        semanticHints: ['ambiguous'],
        nearbyTerms: nearby,
        start: m.index,
        end: m.index + m[0].length,
      });
    }
    mark(consumed, m.index, m.index + m[0].length);
  }

  DIRECTION_HINT.lastIndex = 0;
  while ((m = DIRECTION_HINT.exec(src))) {
    add({
      kind: CLAIM_KIND.DIRECTION,
      rawSpan: m[0],
      token: m[0].toLowerCase(),
      semanticHints: nearbyHints(src, m.index, m.index + m[0].length).concat(['direction']),
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  if (RANKING_HINT.test(src)) {
    const rm = src.match(RANKING_HINT);
    if (rm) {
      add({
        kind: CLAIM_KIND.RANKING_CANDIDATE,
        rawSpan: rm[0],
        token: rm[0].toLowerCase(),
        start: src.indexOf(rm[0]),
        end: src.indexOf(rm[0]) + rm[0].length,
      });
    }
  }

  const amounts = claims.filter((c) => c.kind === CLAIM_KIND.AMOUNT);
  const dates = claims.filter((c) => c.kind === CLAIM_KIND.DATE);
  for (let i = 0; i < amounts.length; i += 1) {
    const amount = amounts[i];
    const before = src.slice(Math.max(0, amount.start - 64), amount.start);
    const capRe = /\b([A-Z][A-Za-z]{2,})\b/g;
    let entity = null;
    let cap;
    while ((cap = capRe.exec(before))) {
      entity = cap[1];
    }
    const sameItemDate = findSameItemRecurringNextDate(src, amount, dates);
    const nearDate = sameItemDate || pickNearbyDate(amount, dates, entity);
    if (sameItemDate) {
      amount.semanticHints = concatHints(amount.semanticHints, ['recurring_next_due']);
    }
    if (entity && nearDate) {
      amount.kind = CLAIM_KIND.ENTITY_AMOUNT_DATE;
      amount.entity = entity;
      amount.dateIso = nearDate.iso || null;
      amount.dateMonth = nearDate.month;
      amount.dateDay = nearDate.day;
    } else if (entity) {
      amount.kind = CLAIM_KIND.ENTITY_AMOUNT;
      amount.entity = entity;
    } else if (sameItemDate) {
      amount.dateIso = sameItemDate.iso || null;
      amount.dateMonth = sameItemDate.month;
      amount.dateDay = sameItemDate.day;
    }
  }

  claims.sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return String(a.kind).localeCompare(String(b.kind));
  });
  return claims;
}

module.exports = {
  CLAIM_KIND,
  extractResponseClaims,
};
