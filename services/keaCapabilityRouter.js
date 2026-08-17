'use strict';

const moment = require('moment');
const { frequencyLabel } = require('../utils/frequencyLabel');

const CAPABILITIES = Object.freeze([
  'confirmation',
  'continuation',
  'invitation_continuation',
  'bare_affirmative_unresolved',
  'product_help',
  'casual_conversation',
  'financial_lookup',
  'financial_forecast',
  'cashflow_analysis',
  'cashflow_comparison',
  'cashflow_trend',
  'affordability_or_planning',
  'mixed_macro',
  'transaction_write',
  'goal_write',
  'simulation',
  'navigation_ui',
  'unknown',
]);

const FINANCIAL_CAPABILITIES = new Set([
  'financial_lookup',
  'financial_forecast',
  'cashflow_analysis',
  'cashflow_comparison',
  'cashflow_trend',
  'affordability_or_planning',
]);

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

const SUBJECT_MAX = 64;
const MAX_LOOKUP_CLAUSES = 6;
const CATEGORY_WORDS = [
  'restaurants', 'restaurant', 'dining', 'groceries', 'grocery', 'gas',
  'rent', 'utilities', 'entertainment', 'travel', 'shopping', 'food',
  'coffee', 'subscriptions', 'insurance', 'healthcare', 'transportation',
];
const MONTH_NAMES = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

function clipSubject(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  return s.slice(0, SUBJECT_MAX);
}

function parseAmount(text) {
  if (!text) return null;
  const m = String(text).match(/\$\s*([\d,]+(?:\.\d+)?)|\b([\d,]+(?:\.\d+)?)\s*(?:dollars|bucks)\b/i);
  if (!m) return null;
  const n = Number((m[1] || m[2] || '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function purchaseDateResult(date, assumption, assumptionText) {
  return {
    date,
    assumption: assumption || null,
    assumptionText: assumptionText || null,
    error: null,
  };
}

function parsePurchaseDate(message, currentDate) {
  if (!message) return null;
  const today = moment(currentDate, 'YYYY-MM-DD', true).isValid()
    ? moment(currentDate, 'YYYY-MM-DD')
    : moment();
  const todayStr = today.format('YYYY-MM-DD');
  const m = String(message).toLowerCase();

  if (/\bpayday\b/.test(m) || /\bsometime\b/.test(m)) {
    return { date: null, assumption: null, assumptionText: null, error: 'date_unresolved' };
  }

  const iso = String(message).match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) {
    if (iso[1] < todayStr) {
      return { date: iso[1], assumption: null, assumptionText: null, error: 'past_date' };
    }
    return purchaseDateResult(iso[1]);
  }

  if (/\btomorrow\b/.test(m)) {
    return purchaseDateResult(today.clone().add(1, 'day').format('YYYY-MM-DD'));
  }

  const md = m.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\b/
  );
  if (md) {
    const month = MONTH_NAMES[md[1]];
    const day = Number(md[2]);
    let candidate = moment({ year: today.year(), month, day });
    if (!candidate.isValid() || candidate.date() !== day) {
      return { date: null, assumption: null, assumptionText: null, error: 'date_unresolved' };
    }
    if (!candidate.isAfter(today, 'day')) {
      candidate = moment({ year: today.year() + 1, month, day });
    }
    return purchaseDateResult(candidate.format('YYYY-MM-DD'));
  }

  const wd = m.match(/\b(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) {
    const want = WEEKDAYS[wd[1]];
    const next = today.clone();
    do {
      next.add(1, 'day');
    } while (next.day() !== want);
    return purchaseDateResult(next.format('YYYY-MM-DD'));
  }

  if (/\bnext month\b/.test(m)) {
    const first = today.clone().add(1, 'month').startOf('month');
    const date = first.format('YYYY-MM-DD');
    return purchaseDateResult(
      date,
      'next_month_first_day',
      `Assuming the purchase is on ${first.format('MMMM D')}...`
    );
  }

  if (/\bthis month\b/.test(m)) {
    return { date: null, assumption: null, assumptionText: null, error: 'date_unresolved' };
  }

  return null;
}

function parsePeriod(text, currentDate) {
  if (!text) return null;
  const today = moment(currentDate, 'YYYY-MM-DD', true).isValid()
    ? moment(currentDate, 'YYYY-MM-DD')
    : moment();
  const m = String(text).toLowerCase();

  if (/\blast month\b/.test(m)) {
    const start = today.clone().subtract(1, 'month').startOf('month');
    return {
      start: start.format('YYYY-MM-DD'),
      end: start.clone().endOf('month').format('YYYY-MM-DD'),
      label: 'last_month',
    };
  }
  if (/\bthis month\b/.test(m)) {
    return {
      start: today.clone().startOf('month').format('YYYY-MM-DD'),
      end: today.clone().endOf('month').format('YYYY-MM-DD'),
      label: 'this_month',
    };
  }
  if (/\bnext month\b/.test(m)) {
    const start = today.clone().add(1, 'month').startOf('month');
    return {
      start: start.format('YYYY-MM-DD'),
      end: start.clone().endOf('month').format('YYYY-MM-DD'),
      label: 'next_month',
    };
  }
  if (/\blast week\b/.test(m)) {
    const start = today.clone().subtract(1, 'week').startOf('week');
    return {
      start: start.format('YYYY-MM-DD'),
      end: start.clone().endOf('week').format('YYYY-MM-DD'),
      label: 'last_week',
    };
  }
  if (/\bthis week\b/.test(m)) {
    return {
      start: today.clone().startOf('week').format('YYYY-MM-DD'),
      end: today.clone().endOf('week').format('YYYY-MM-DD'),
      label: 'this_week',
    };
  }

  const named = m.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b(?:\s+(\d{4}))?/
  );
  if (named) {
    const month = MONTH_NAMES[named[1]];
    const year = named[2] ? Number(named[2]) : today.year();
    const start = moment({ year, month, day: 1 });
    return {
      start: start.format('YYYY-MM-DD'),
      end: start.clone().endOf('month').format('YYYY-MM-DD'),
      label: 'named_month',
    };
  }
  return null;
}

function yearForNamedMonth(monthIndex, today) {
  if (monthIndex > today.month()) return today.year() - 1;
  return today.year();
}

function matchedElapsedFrom(today) {
  const newerStart = today.clone().startOf('month');
  const prior = today.clone().subtract(1, 'month').startOf('month');
  const daysInPrior = prior.clone().endOf('month').date();
  const baselineDay = Math.min(today.date(), daysInPrior);
  return {
    windowKind: 'matched_elapsed',
    periodA: {
      start: prior.format('YYYY-MM-DD'),
      end: prior.clone().date(baselineDay).format('YYYY-MM-DD'),
    },
    periodB: {
      start: newerStart.format('YYYY-MM-DD'),
      end: today.format('YYYY-MM-DD'),
    },
    error: null,
  };
}

function fullMonthFrom(year, monthIndex) {
  const start = moment({ year, month: monthIndex, day: 1 });
  return {
    start: start.format('YYYY-MM-DD'),
    end: start.clone().endOf('month').format('YYYY-MM-DD'),
  };
}

function orderParsedPeriods(a, b, windowKind) {
  if (!a || !b) return { windowKind, periodA: a, periodB: b, error: null };
  if (a.start < b.start || (a.start === b.start && a.end <= b.end)) {
    return { windowKind, periodA: a, periodB: b, error: null };
  }
  return { windowKind, periodA: b, periodB: a, error: null };
}

function parseExplicitBoundPair(text, today) {
  const re = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(?:through|to|-|–)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?/g;
  const hits = [];
  let match;
  while ((match = re.exec(text))) {
    hits.push(match);
  }
  if (hits.length < 2) return null;
  const windows = hits.slice(0, 2).map((h) => {
    const month = MONTH_NAMES[h[1]];
    const startDay = Number(h[2]);
    const endDay = Number(h[3]);
    const year = h[4] ? Number(h[4]) : yearForNamedMonth(month, today);
    const start = moment({ year, month, day: startDay });
    const end = moment({ year, month, day: endDay });
    if (!start.isValid() || !end.isValid() || startDay !== start.date() || endDay !== end.date()) {
      return { invalid: true };
    }
    if (start.format('YYYY-MM-DD') > end.format('YYYY-MM-DD')) return { invalid: true };
    return {
      start: start.format('YYYY-MM-DD'),
      end: end.format('YYYY-MM-DD'),
    };
  });
  if (windows.some((w) => w.invalid)) {
    return { error: 'invalid_explicit_bounds', windowKind: 'explicit_bounds', periodA: null, periodB: null };
  }
  return orderParsedPeriods(windows[0], windows[1], 'explicit_bounds');
}

function parseNamedMonthPair(text, today) {
  const hits = collectNamedMonths(text, today);
  if (hits.length !== 2) return null;
  const a = fullMonthFrom(hits[0].year, hits[0].month);
  const b = fullMonthFrom(hits[1].year, hits[1].month);
  return orderParsedPeriods(a, b, 'full_months');
}

function collectNamedMonths(text, today) {
  const re = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b(?:\s+(\d{4}))?/g;
  const hits = [];
  const seen = new Set();
  let match;
  while ((match = re.exec(text))) {
    const key = `${match[1]}-${match[2] || ''}`;
    if (seen.has(key) && !match[2]) continue;
    seen.add(key);
    hits.push({
      month: MONTH_NAMES[match[1]],
      year: match[2] ? Number(match[2]) : yearForNamedMonth(MONTH_NAMES[match[1]], today),
    });
  }
  return hits;
}

function expandNamedMonthSpan(text, today) {
  const month = 'january|february|march|april|may|june|july|august|september|october|november|december';
  const re = new RegExp(
    `\\b(?:from\\s+)?(${month})(?:\\s+(\\d{4}))?\\s*(?:through|thru|to|[-–])\\s*(${month})(?:\\s+(\\d{4}))?\\b`,
    'i'
  );
  const hit = String(text || '').toLowerCase().match(re);
  if (!hit) return null;
  const startMonth = MONTH_NAMES[hit[1]];
  const startYear = hit[2] ? Number(hit[2]) : yearForNamedMonth(startMonth, today);
  const endMonth = MONTH_NAMES[hit[3]];
  const endYear = hit[4] ? Number(hit[4]) : yearForNamedMonth(endMonth, today);
  let cursor = moment({ year: startYear, month: startMonth, day: 1 });
  let end = moment({ year: endYear, month: endMonth, day: 1 });
  if (end.isBefore(cursor)) {
    const tmp = cursor;
    cursor = end;
    end = tmp;
  }
  const hits = [];
  while (!cursor.isAfter(end, 'month')) {
    hits.push({ month: cursor.month(), year: cursor.year() });
    cursor = cursor.clone().add(1, 'month');
    if (hits.length > 12) break;
  }
  return hits;
}

function matchedElapsedSeriesFrom(today, count = 3) {
  const day = today.date();
  const periods = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const start = today.clone().subtract(i, 'month').startOf('month');
    const daysInMonth = start.clone().endOf('month').date();
    const endDay = Math.min(day, daysInMonth);
    periods.push({
      start: start.format('YYYY-MM-DD'),
      end: start.clone().date(endDay).format('YYYY-MM-DD'),
    });
  }
  return { windowKind: 'matched_elapsed', periods, error: null };
}

function lastCompletedMonthsFrom(today, count = 3) {
  const periods = [];
  for (let i = count; i >= 1; i -= 1) {
    const start = today.clone().subtract(i, 'month').startOf('month');
    periods.push(fullMonthFrom(start.year(), start.month()));
  }
  return { windowKind: 'full_months', periods, error: null };
}

function toMatchedElapsedSeries(periods, today) {
  const day = today.date();
  return (periods || []).map((period) => {
    const start = moment(period.start, 'YYYY-MM-DD').startOf('month');
    const daysInMonth = start.clone().endOf('month').date();
    const endDay = Math.min(day, daysInMonth);
    return {
      start: start.format('YYYY-MM-DD'),
      end: start.clone().date(endDay).format('YYYY-MM-DD'),
    };
  });
}

function parseRequestedMonthCount(text) {
  const m = String(text || '').toLowerCase();
  const hit = m.match(/\b(?:last|past|over the last)\s+(\d+|few|three|four|five|six|twelve)\s+months?\b/);
  if (!hit) return null;
  if (hit[1] === 'few' || hit[1] === 'three') return 3;
  return Number(hit[1]);
}

function trendMetricScope(text, subjectKind) {
  if (subjectKind === 'category') return 'category';
  const m = String(text || '').toLowerCase();
  if (/\bincome\b/.test(m) && !/\b(spend|spent|spending)\b/.test(m)) return 'income';
  if (/\bnet\b/.test(m) || (/\bcash ?flow\b/.test(m) && !/\b(spend|spent|spending)\b/.test(m))) return 'net';
  return 'spending';
}

function parseTrendPeriods(message, currentDate) {
  const today = moment(currentDate, 'YYYY-MM-DD', true).isValid()
    ? moment(currentDate, 'YYYY-MM-DD')
    : moment();
  const m = String(message || '').toLowerCase();
  if (!m) return { error: 'trend_periods_unresolved', periods: null, windowKind: null };

  if (/\bforecast(ed|s|ing)?\b/.test(m) || /\bprojected\b/.test(m) || /\bnext month\b/.test(m)) {
    return { error: 'forecast_trend_unsupported', periods: null, windowKind: null };
  }
  if (/\bthis year\b/.test(m)) {
    return { error: 'trend_period_count_unsupported', periods: null, windowKind: null };
  }

  const requestedCount = parseRequestedMonthCount(m);
  if (requestedCount != null && requestedCount !== 3) {
    return { error: 'trend_period_count_unsupported', periods: null, windowKind: null };
  }

  const span = expandNamedMonthSpan(m, today);
  if (span && span.length !== 3) {
    return { error: 'trend_period_count_unsupported', periods: null, windowKind: null };
  }
  const named = (span && span.length === 3) ? span : collectNamedMonths(m, today);
  if (named.length > 3) {
    return { error: 'trend_period_count_unsupported', periods: null, windowKind: null };
  }
  if (named.length === 3) {
    const periods = named
      .map((hit) => fullMonthFrom(hit.year, hit.month))
      .sort((a, b) => (a.start < b.start ? -1 : 1));
    const currentIncomplete = today.date() !== today.clone().endOf('month').date();
    const includesCurrent = periods.some((p) => p.start.slice(0, 7) === today.format('YYYY-MM'));
    if (currentIncomplete && includesCurrent) {
      return {
        windowKind: 'matched_elapsed',
        periods: toMatchedElapsedSeries(periods, today),
        error: null,
      };
    }
    return { windowKind: 'full_months', periods, error: null };
  }

  if (/\blast\s+3\s+completed months\b/.test(m) || /\blast three completed months\b/.test(m)) {
    return lastCompletedMonthsFrom(today);
  }

  return matchedElapsedSeriesFrom(today);
}

function parseComparisonPeriods(message, currentDate) {
  const today = moment(currentDate, 'YYYY-MM-DD', true).isValid()
    ? moment(currentDate, 'YYYY-MM-DD')
    : moment();
  const m = String(message || '').toLowerCase();
  if (!m) return { error: 'comparison_periods_unresolved', periodA: null, periodB: null, windowKind: null };

  if (/\bforecast(ed|s|ing)?\b/.test(m) || /\bprojected\b/.test(m) || /\bnext month\b/.test(m)) {
    return { error: 'forecast_comparison_unsupported', periodA: null, periodB: null, windowKind: null };
  }

  const explicit = parseExplicitBoundPair(m, today);
  if (explicit) return explicit;

  if (/\bthis month so far\b/.test(m) && /\blast month so far\b/.test(m)) {
    return matchedElapsedFrom(today);
  }

  if (/\blast month\b/.test(m) && /\b(the )?month before\b/.test(m)) {
    const last = today.clone().subtract(1, 'month').startOf('month');
    const before = today.clone().subtract(2, 'month').startOf('month');
    return {
      windowKind: 'full_months',
      periodA: {
        start: before.format('YYYY-MM-DD'),
        end: before.clone().endOf('month').format('YYYY-MM-DD'),
      },
      periodB: {
        start: last.format('YYYY-MM-DD'),
        end: last.clone().endOf('month').format('YYYY-MM-DD'),
      },
      error: null,
    };
  }

  const named = parseNamedMonthPair(m, today);
  if (named) return named;

  if (/\b(this month|last month)\b/.test(m)
    || /\b(more|less) than last month\b/.test(m)
    || /\bwhere did my spending (increase|decrease|change|go)\b/.test(m)) {
    return matchedElapsedFrom(today);
  }

  return { error: 'comparison_periods_unresolved', periodA: null, periodB: null, windowKind: null };
}

function isIncomeVersusExpenses(text) {
  const m = String(text || '').toLowerCase();
  return /\bincome\b.{0,32}\b(versus|vs\.?)\b.{0,32}\bexpenses?\b/.test(m)
    || /\bexpenses?\b.{0,32}\b(versus|vs\.?)\b.{0,32}\bincome\b/.test(m);
}

function isCashflowComparison(text) {
  const m = String(text || '').toLowerCase();
  if (!m || isIncomeVersusExpenses(m)) return false;
  if (/\b(compare|compared with|compared to|comparison)\b/.test(m)) return true;
  const periodish = /\b(this month|last month|this week|last week)\b/.test(m)
    || /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(m);
  if ((/\bvs\.?\b|\bversus\b/.test(m)) && periodish) return true;
  if (/\b(more than last month|less than last month)\b/.test(m)) return true;
  if (/\b(spend(?:ing|t)?|income)\b.{0,40}\b(more|less|higher|lower) than last month\b/.test(m)) return true;
  if (/\b(higher|lower) than\b/.test(m) && periodish) return true;
  if (/\b(higher|lower|more|less)\b.{0,48}\bthan\b/.test(m) && periodish) return true;
  if (/\bhow does this month compare\b/.test(m)) return true;
  if (/\b(spending more|spending less|spend more|spend less|spent more|spent less)\b/.test(m)
    && /\b(last month|this month|than)\b/.test(m)) return true;
  if (/\bwhere did my spending (increase|decrease|change|go)\b/.test(m)) return true;
  if (/\b(increased|decreased|changed)\b/.test(m)
    && periodish
    && /\b(from|since|vs|versus|compared|than|last month|this month)\b/.test(m)) return true;
  return false;
}

function isCashflowTrend(text) {
  const m = String(text || '').toLowerCase();
  if (!m) return false;
  if (/\b(trend|trending|trended)\b/.test(m)) return true;
  if (/\b(lately|recently)\b/.test(m)
    && /\b(spend|spent|spending|income|cash ?flow|net)\b/.test(m)) return true;
  if (/\b(?:last|past|over the last)\s+(\d+|few|three|four|five|six|twelve)\s+months?\b/.test(m)) return true;
  if (/\bthis year\b/.test(m)
    && /\b(trend|changed|change|spend|spent|spending|income|cash ?flow)\b/.test(m)) return true;
  if (/\bmonth over month\b/.test(m) || /\bmonth-over-month\b/.test(m)) return true;
  if (/\bthis month\b/.test(m) && /\b(prior|previous) two months\b/.test(m)) return true;
  if (/\blast\s+3\s+completed months\b/.test(m) || /\blast three completed months\b/.test(m)) return true;
  if (collectNamedMonths(m, moment()).length >= 3) return true;
  const namedSpan = expandNamedMonthSpan(m, moment());
  if (namedSpan && namedSpan.length >= 3) return true;
  if (/\b(declin|increas)\w*\b/.test(m)
    && /\b(income|spend|spent|spending|cash ?flow)\b/.test(m)
    && !isCashflowComparison(m)) {
    return true;
  }
  return false;
}

function categoryStemsIn(text) {
  const m = String(text || '').toLowerCase();
  const stems = new Set();
  for (const word of CATEGORY_WORDS) {
    if (!new RegExp(`\\b${word}\\b`).test(m)) continue;
    let stem = word;
    if (stem.endsWith('ies')) stem = `${stem.slice(0, -3)}y`;
    else if (stem.endsWith('s') && stem.length > 4) stem = stem.slice(0, -1);
    stems.add(stem);
  }
  return stems;
}

function parseCategory(text) {
  const m = String(text || '').toLowerCase();
  for (const word of CATEGORY_WORDS) {
    if (new RegExp(`\\b${word}\\b`).test(m)) return clipSubject(word);
  }
  const onCat = m.match(/\bon\s+([a-z][a-z0-9 &-]{1,40})/);
  if (onCat) {
    const raw = onCat[1].replace(/\b(last|this|next)\s+(month|week)\b.*$/, '').trim();
    if (raw) return clipSubject(raw);
  }
  return null;
}

function parseAtToken(text) {
  const m = String(text || '');
  const at = m.match(/\bat\s+([A-Za-z0-9][A-Za-z0-9 &'.-]{1,40})/);
  if (!at) return null;
  const raw = at[1]
    .replace(/\b(last|this|next)\s+(month|week)\b.*$/i, '')
    .replace(/\b(in|on|for)\s+\w+$/i, '')
    .trim();
  if (!raw) return null;
  return { display: raw, value: clipSubject(raw) };
}

function parseMerchant(text) {
  const tok = parseAtToken(text);
  return tok ? tok.value : null;
}

function knownCategorySet(knownCategories) {
  const set = new Set(CATEGORY_WORDS);
  if (Array.isArray(knownCategories)) {
    for (const n of knownCategories) {
      const c = clipSubject(n);
      if (c) set.add(c);
    }
  }
  return set;
}

function isKnownCategoryToken(token, knownCategories) {
  const c = clipSubject(token);
  return !!(c && knownCategorySet(knownCategories).has(c));
}

function extractSlots(message, currentDate, knownCategories) {
  const amount = parseAmount(message);
  const period = parsePeriod(message, currentDate);
  const category = parseCategory(message);
  const atTok = parseAtToken(message);
  const purchase = parsePurchaseDate(message, currentDate);
  let subjectKind = null;
  let subjectValue = null;
  let displaySubject = null;
  if (atTok && isKnownCategoryToken(atTok.value, knownCategories)) {
    subjectKind = 'category';
    subjectValue = atTok.value;
    displaySubject = atTok.display;
  } else if (atTok) {
    subjectKind = 'merchant';
    subjectValue = atTok.value;
    displaySubject = atTok.display;
  } else if (category) {
    subjectKind = 'category';
    subjectValue = category;
    displaySubject = category;
  } else if (amount != null) {
    subjectKind = 'amount';
    subjectValue = String(amount);
  }
  return {
    amount,
    period,
    subjectKind,
    subjectValue,
    displaySubject,
    purchaseDate: purchase && purchase.date ? purchase.date : null,
    purchaseDateAssumption: purchase && purchase.assumption ? purchase.assumption : null,
    purchaseDateAssumptionText: purchase && purchase.assumptionText ? purchase.assumptionText : null,
    purchaseDateError: purchase && purchase.error ? purchase.error : null,
  };
}

function isShortFollowUp(text) {
  const m = String(text || '').trim();
  if (!m || m.length > 80) return false;
  return /^(what about|how about|and (what about|how about)?|this month|last month|next month|that month)\b/i.test(m)
    || /^\$\s*[\d,]+(?:\.\d+)?\s*\??$/i.test(m);
}

function isBareAffirmative(text) {
  const m = String(text || '').trim();
  if (!m || m.length > 40) return false;
  return /^(y(es|ep|eah|up)?|sure|ok(ay)?)(\s+please)?[.!?]*$/i.test(m)
    || /^(go ahead|do it|please do)[.!?]*$/i.test(m);
}

function isAgreementPhrase(text) {
  const m = String(text || '').trim();
  if (!m || m.length > 60) return false;
  return /^(this|that|it) is (correct|right)[.!?]*$/i.test(m)
    || /^(that'?s|thats) (correct|right)[.!?]*$/i.test(m)
    || /^(this|that) looks (right|correct|good)[.!?]*$/i.test(m)
    || /^looks (right|correct|good)[.!?]*$/i.test(m)
    || /^sounds (right|correct|good)[.!?]*$/i.test(m);
}

function lastCommittedCreate(dialogueState) {
  const writes = Array.isArray(dialogueState && dialogueState.recentWrites)
    ? dialogueState.recentWrites
    : [];
  for (let i = writes.length - 1; i >= 0; i--) {
    if (writes[i] && writes[i].action === 'create') return writes[i];
  }
  return null;
}

function isSeedableCommittedWrite(prior) {
  if (!prior) return false;
  const title = String(prior.title || '').trim();
  const amount = Math.abs(Number(prior.amount));
  const start = String(prior.start || '').slice(0, 10);
  return !!(title && Number.isFinite(amount) && amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(start));
}

function isRepeatWriteUtterance(text) {
  const m = String(text || '').trim();
  if (!m || m.length > 80) return false;
  return /^(please\s+)?(add|create)\s+(another(\s+one)?|it again|that again)[.!?]*$/i.test(m)
    || /^(please\s+)?(add|create)\s+another\s+(expense|transaction|forecast)[.!?]*$/i.test(m)
    || /^(please\s+)?duplicate that (expense|transaction|forecast)[.!?]*$/i.test(m)
    || /^(please\s+)?(add|create) (it|that|the (expense|transaction|forecast)) anyway[.!?]*$/i.test(m);
}

function isBareNegative(text) {
  const m = String(text || '').trim();
  if (!m || m.length > 40) return false;
  return /^(no|nope|nah|no thanks|not now|no thank you)[.!?]*$/i.test(m);
}

function accountsMatch(a, b) {
  if (a == null || b == null || a === '' || b === '') return false;
  return String(a) === String(b);
}

function isWriteUtterance(text) {
  const m = String(text || '').toLowerCase();
  return /\b(add|create|delete|remove|update|change|schedule|log|move)\b/.test(m)
    && /\b(forecast|transaction|expense|income|bill|goal|purchase)\b/.test(m)
    || /\b(add|create|schedule)\b.{0,40}\b(forecast|expense|income|bill)\b/.test(m)
    || /\bdelete (the |that |this )?(forecast|transaction|expense|income)\b/.test(m);
}

function isGoalWriteUtterance(text) {
  const m = String(text || '').toLowerCase();
  return /\b(goal|save toward|savings goal)\b/.test(m)
    && /\b(add|create|update|delete|remove|change|set)\b/.test(m);
}

function isSimUtterance(text) {
  const m = String(text || '').toLowerCase();
  return /\b(what if|hypothetically|simulate|if i (had|added|removed|cancelled|didn't))\b/.test(m);
}

function isNavUtterance(text) {
  const m = String(text || '').toLowerCase();
  return /\b(open|go to|show|switch to|select account|take me to|navigate)\b/.test(m)
    && /\b(calendar|search|account|settings|goals|feed|day)\b/.test(m);
}

function isProductHelp(text) {
  const m = String(text || '').toLowerCase();
  if (/\b(spend|spent|afford|negative)\b/.test(m)) return false;
  if (/\bhow much\b/.test(m) && !/\bsimulation mode\b/.test(m)) return false;
  if (/\b(what is|how does|how do i|explain)\b.{0,48}\bsimulation( mode)?\b/.test(m)) return true;
  if (/\b(spend|spent|balance|afford|negative|how much)\b/.test(m)
    && !/\bsimulation( mode)?\b/.test(m)) return false;
  return /\bwhat is (reconciliation|a forecast|keacast|matching|a satellite|rollover|simulation mode)\b/.test(m)
    || /\bhow (does|do i|can i) (reconciliation|keacast|matching|forecast|simulation)/.test(m)
    || /\b(what is reconciliation|how does keacast|how do i (use|link|match))\b/.test(m)
    || /\bexplain (reconciliation|forecasting|matching|simulation mode)\b/.test(m);
}

function isCasual(text) {
  const m = String(text || '').trim().toLowerCase();
  return /^(hi|hey|hello|thanks|thank you|yo|sup|good (morning|afternoon|evening))(\s+kea)?[!?.]*$/i.test(m)
    || /^hi kea[!?.]*$/i.test(m);
}

function isAffordability(text) {
  const m = String(text || '').toLowerCase();
  return /\b(can i afford|afford|do i have enough|is \$?[\d,]+ (ok|safe|fine|too much))\b/.test(m);
}

function isNegativeRiskQuestion(text) {
  const m = String(text || '').toLowerCase();
  return /\b(go negative|be negative|run out of money|overdraft|will i (be|go) (broke|negative)|driving .{0,60}negative)\b/.test(m);
}

function isCashflowAnalysis(text) {
  const m = String(text || '').toLowerCase();
  if (isNegativeRiskQuestion(text)) return true;
  if (/\bhow am i doing\b/.test(m)) return true;
  if (/\bhow was\b/.test(m)) return true;
  if (/\bwhere is my money going\b/.test(m)) return true;
  if (/\b(biggest|top) spending categor/.test(m)) return true;
  if (/\b(biggest|top) merchants?\b/.test(m)) return true;
  if (/\bmerchants? am i spending\b/.test(m)) return true;
  if (/\bincome\b.+\bexpenses\b/.test(m)) return true;
  if (/\bcash ?flow\b/.test(m)) return true;
  return false;
}

function isMixedMacro(text) {
  if (isAffordability(text) && (isCashflowAnalysis(text) || isCashflowComparison(text) || isCashflowTrend(text))) {
    return true;
  }
  const m = String(text || '').toLowerCase();
  if (!/\band\b/.test(m)) return false;
  if (collectNamedMonths(m, moment()).length >= 3) return false;
  return isCashflowComparison(m) && isCashflowTrend(m);
}

function isForecast(text) {
  const m = String(text || '').toLowerCase();
  return /\b(go negative|be negative|run out|overdraft|upcoming|projected (balance|low)|will i (be|go) (broke|negative)|next month'?s? (balance|cashflow)|what will my (available )?balance)\b/.test(m);
}

function isLookup(text) {
  const m = String(text || '').toLowerCase();
  return /\b(how much (did i|have i|do i)|spent|spend|spending|what did i spend|balance|available|credit limit|how much (is|was) in)\b/.test(m)
    || /\b(what did .+ cost|cost (last|this|in) )\b/.test(m);
}

function isLookupClause(text) {
  return isLookup(text) || /\b(what did i spend|what did .+ cost)\b/i.test(String(text || ''));
}

function detectWantsUiAction(text) {
  const m = String(text || '').toLowerCase();
  const hasVerb = /\b(show|open|find|list|pull up)\b/.test(m);
  const hasTarget = /\b(transaction|transactions|charges|purchases|search)\b/.test(m);
  return hasVerb && hasTarget;
}

function splitLookupClauses(message) {
  const text = String(message || '');
  const byBreaks = text.split(/(?:\?+|\r?\n)+/);
  const clauses = [];
  for (const chunk of byBreaks) {
    const pieces = chunk.split(/\band\s+(?=(?:how much|what did i spend)\b)/i);
    for (const piece of pieces) {
      const trimmed = String(piece || '').replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '').trim();
      if (trimmed) clauses.push(trimmed);
    }
  }
  return clauses;
}

function lookupFromSlots(slots) {
  if (!slots) return null;
  const hasSubject = slots.subjectKind === 'merchant' || slots.subjectKind === 'category';
  const hasPeriod = !!(slots.period && slots.period.start && slots.period.end);
  if (!hasSubject && !hasPeriod) return null;
  return {
    subjectKind: slots.subjectKind || null,
    subjectValue: slots.subjectValue || null,
    period: slots.period || null,
    displaySubject: slots.displaySubject || slots.subjectValue || null,
  };
}

function extractNavSubjectToken(text) {
  const original = String(text || '');
  const noise = /\b(show\s+me|show|open|find|list|pull\s+up|my|the|from|in|on|at|last|this|next|month|week|january|february|march|april|may|june|july|august|september|october|november|december|transactions|charges|purchases|search)\b/gi;
  const leftover = original
    .replace(noise, ' ')
    .replace(/[^A-Za-z0-9 &'-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!leftover) return null;
  const words = leftover.split(/\s+/).filter(Boolean).slice(0, 3);
  return words.join(' ') || null;
}

function extractLookupRequests(message, currentDate, knownCategories) {
  const clauses = splitLookupClauses(message);
  const accepted = [];
  let extraLookupClauses = 0;
  for (const clause of clauses) {
    if (!isLookupClause(clause)) continue;
    const req = lookupFromSlots(extractSlots(clause, currentDate, knownCategories));
    if (!req) continue;
    if (accepted.length >= MAX_LOOKUP_CLAUSES) {
      extraLookupClauses += 1;
      continue;
    }
    accepted.push(req);
  }
  return { lookupRequests: accepted, capped: extraLookupClauses > 0 };
}

function extractNavLookup(message, currentDate, knownCategories) {
  const slots = extractSlots(message, currentDate, knownCategories);
  if (slots.subjectKind === 'merchant' || slots.subjectKind === 'category') {
    return lookupFromSlots(slots);
  }
  const token = extractNavSubjectToken(message);
  if (!token) return lookupFromSlots({ ...slots, subjectKind: null, subjectValue: null });
  const kind = isKnownCategoryToken(token, knownCategories) ? 'category' : 'merchant';
  return lookupFromSlots({
    ...slots,
    subjectKind: kind,
    subjectValue: clipSubject(token),
    displaySubject: token,
  });
}

function titleCaseSubject(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  return s.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function buildOpenSearchAction(route) {
  if (!route || !route.wantsUiAction) return null;
  const req = Array.isArray(route.lookupRequests) && route.lookupRequests[0]
    ? route.lookupRequests[0]
    : null;
  const slots = req || route.slots || {};
  const action = { type: 'open_search' };
  const term = slots.displaySubject || titleCaseSubject(slots.subjectValue);
  if (term) action.search_term = term;
  if (slots.period && /^\d{4}-\d{2}-\d{2}$/.test(String(slots.period.start || ''))) {
    action.startDate = String(slots.period.start);
  }
  if (slots.period && /^\d{4}-\d{2}-\d{2}$/.test(String(slots.period.end || ''))) {
    action.endDate = String(slots.period.end);
  }
  return action;
}

function mergeOpenSearchUiActions(uiActions, route) {
  const actions = Array.isArray(uiActions) ? uiActions.slice() : [];
  const suggested = buildOpenSearchAction(route);
  if (!suggested) return actions;
  const existing = actions.find((a) => a && a.type === 'open_search');
  if (existing) {
    if (!existing.search_term && suggested.search_term) existing.search_term = suggested.search_term;
    if (!existing.startDate && suggested.startDate) existing.startDate = suggested.startDate;
    if (!existing.endDate && suggested.endDate) existing.endDate = suggested.endDate;
    return actions;
  }
  actions.push(suggested);
  return actions;
}

function attachLookupMeta(result, message, currentDate, knownCategories) {
  const extras = extractLookupRequests(message, currentDate, knownCategories);
  const wantsUi = detectWantsUiAction(message);
  let lookupRequests = extras.lookupRequests;
  if (wantsUi && !lookupRequests.length) {
    const nav = extractNavLookup(message, currentDate, knownCategories);
    if (nav) lookupRequests = [nav];
  }
  let slots = result.slots || {};
  if (result.capability === 'continuation'
    && !lookupRequests.length
    && (slots.subjectKind === 'merchant' || slots.subjectKind === 'category')) {
    const cont = lookupFromSlots(slots);
    if (cont) lookupRequests = [cont];
  }
  if (lookupRequests.length
    && result.capability === 'financial_lookup'
    && slots.subjectKind !== 'account') {
    const first = lookupRequests[0];
    slots = {
      ...slots,
      subjectKind: first.subjectKind || slots.subjectKind,
      subjectValue: first.subjectValue || slots.subjectValue,
      period: first.period || slots.period,
      displaySubject: first.displaySubject || slots.displaySubject,
    };
  }
  if (wantsUi && lookupRequests.length && result.capability === 'navigation_ui') {
    const first = lookupRequests[0];
    slots = {
      ...slots,
      subjectKind: first.subjectKind || slots.subjectKind,
      subjectValue: first.subjectValue || slots.subjectValue,
      period: first.period || slots.period,
      displaySubject: first.displaySubject || slots.displaySubject,
    };
  }
  return {
    ...result,
    slots,
    lookupRequests,
    compoundLookupCapped: extras.capped,
    wantsUiAction: wantsUi,
  };
}

function asksForFinancialAmount(text) {
  const m = String(text || '').toLowerCase();
  return /\$\s*\d/.test(m)
    || /\b(how much|spend|spent|balance|afford|negative|income|expense|total)\b/.test(m);
}

function isClearTopicSwitch(text) {
  return isLookup(text)
    || isForecast(text)
    || isCashflowComparison(text)
    || isAffordability(text)
    || isProductHelp(text)
    || isCasual(text)
    || isNavUtterance(text)
    || isSimUtterance(text);
}

function draftSlotHaystack(draft) {
  if (!draft || typeof draft !== 'object') return '';
  return ['title', 'category', 'amount', 'start', 'type', 'frequency', 'merchant_name']
    .map((k) => (draft[k] != null ? String(draft[k]).toLowerCase() : ''))
    .filter(Boolean)
    .join(' ');
}

function isWriteAmendmentOrSlotFill(text, pendingDraft) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (isClearTopicSwitch(raw)) return false;
  if (isWriteUtterance(raw) || isGoalWriteUtterance(raw)) return true;
  const m = raw.toLowerCase();
  if (/\b(make it|change it|change that|change the amount|change the date|make that|use \w+ instead|actually use|instead)\b/.test(m)) {
    return true;
  }
  if (/\b(make|change|switch)\b.{0,24}\b(weekly|monthly|bi-?weekly|daily|annually|once)\b/.test(m)) {
    return true;
  }
  if (/^(make it |change (it|that|the amount) (to )?)?\$?\s*[\d,]+(\.\d{2})?\s*$/i.test(m)) {
    return true;
  }
  if (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow)\b/.test(m)
    && (/\b(change|make|to|on)\b/.test(m) || m.split(/\s+/).length <= 4)) {
    return true;
  }
  const hay = draftSlotHaystack(pendingDraft);
  if (hay && /\b(use|change|actually|instead|make)\b/.test(m)) {
    const tokens = m.split(/[^a-z0-9.$]+/).filter((t) => t.length > 2);
    if (tokens.some((t) => hay.includes(t))) return true;
  }
  return false;
}

function pendingWriteType(input) {
  if (input.pendingGoalWrite && !input.pendingWrite) return 'goal';
  if (input.pendingWrite && !input.pendingGoalWrite) return 'transaction';
  if (input.pendingWrite && input.pendingGoalWrite) return 'both';
  return null;
}

const INVITATION_KINDS = new Set(['add_affordability_expense']);

function normalizePendingInvitation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!INVITATION_KINDS.has(raw.kind)) return null;
  const amount = Number(raw.amount);
  const date = raw.date ? String(raw.date).slice(0, 10) : '';
  if (!(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const status = (raw.status === 'referent_asked' || raw.status === 'awaiting_title')
    ? raw.status
    : 'offered';
  return {
    kind: 'add_affordability_expense',
    sourceCapability: 'affordability_or_planning',
    amount,
    date,
    accountId: raw.accountId == null || raw.accountId === '' ? null : String(raw.accountId),
    status,
  };
}

function buildAffordabilityInvitation(route, accountId) {
  const cap = route && (route.capability === 'continuation' ? route.parentCapability : route.capability);
  if (cap !== 'affordability_or_planning') return null;
  const slots = (route && route.slots) || {};
  const amount = Number(slots.amount);
  const date = slots.purchaseDate ? String(slots.purchaseDate).slice(0, 10) : '';
  if (!(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    kind: 'add_affordability_expense',
    sourceCapability: 'affordability_or_planning',
    amount,
    date,
    accountId: accountId == null || accountId === '' ? null : String(accountId),
    status: 'offered',
  };
}

function formatInvitationAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return `$${n}`;
  const fixed = n.toFixed(2).replace(/\.00$/, '');
  return `$${fixed}`;
}

function formatInvitationDate(date) {
  const m = moment(String(date || ''), 'YYYY-MM-DD', true);
  return m.isValid() ? m.format('MMMM D') : '';
}

function formatInvitationDateLong(date) {
  const m = moment(String(date || ''), 'YYYY-MM-DD', true);
  return m.isValid() ? m.format('MMMM D, YYYY') : '';
}

// Matches tools/functionMap FREQUENCY_ONCE. Local so this router does not
// import the tool layer.
const INVITATION_FREQUENCY_ONCE = 2;
const INVITATION_DEFAULT_CATEGORY = 'Uncategorized';

function snapInvitationCategory(input, knownCategories) {
  const q = String(input || '').trim();
  if (!q) return null;
  if (!Array.isArray(knownCategories) || knownCategories.length === 0) return q;
  const needle = q.toLowerCase();
  for (const n of knownCategories) {
    if (String(n).trim().toLowerCase() === needle) return n;
  }
  for (const n of knownCategories) {
    const ln = String(n).trim().toLowerCase();
    if (ln && (ln.includes(needle) || needle.includes(ln))) return n;
  }
  return null;
}

function invitationDraftIsProposable(draft) {
  if (!draft || typeof draft !== 'object') return false;
  return ['title', 'type', 'amount', 'start'].every((k) => {
    const v = draft[k];
    return v !== undefined && v !== null && String(v).trim() !== '';
  });
}

function looksLikeInvitationSeed(draft, invitation) {
  if (!draft || !invitation) return false;
  return Number(draft.amount) === Number(invitation.amount)
    && String(draft.start || '').slice(0, 10) === invitation.date
    && String(draft.type || '').toLowerCase() === 'expense'
    && (!draft.title || String(draft.title).trim() === '');
}

function seedTrustedInvitationDraft(dialogueState, invitation, { replace } = {}) {
  if (!dialogueState || !invitation) return;
  const next = {
    amount: invitation.amount,
    start: invitation.date,
    type: 'expense',
    frequency: INVITATION_FREQUENCY_ONCE,
  };
  const prev = dialogueState.draftTransaction && typeof dialogueState.draftTransaction === 'object'
    ? dialogueState.draftTransaction
    : {};
  const sameSeed = !replace
    && Number(prev.amount) === Number(invitation.amount)
    && String(prev.start || '').slice(0, 10) === invitation.date
    && String(prev.type || '').toLowerCase() === 'expense';
  if (sameSeed) {
    if (prev.title && String(prev.title).trim()) next.title = String(prev.title).trim();
    if (prev.category && String(prev.category).trim()) next.category = String(prev.category).trim();
  }
  dialogueState.draftTransaction = next;
  if (replace || !sameSeed) dialogueState.pendingConfirmation = false;
}

function applyUserInvitationSlots(dialogueState, slots, categoryNames) {
  if (!dialogueState.draftTransaction || typeof dialogueState.draftTransaction !== 'object') {
    dialogueState.draftTransaction = {};
  }
  const draft = dialogueState.draftTransaction;
  if (slots && slots.title) draft.title = String(slots.title).trim();
  if (slots && slots.category) {
    const snapped = snapInvitationCategory(slots.category, categoryNames);
    if (snapped) draft.category = snapped;
  }
}

function finalizeInvitationDraft(dialogueState, invitation) {
  const draft = dialogueState.draftTransaction;
  if (!invitationDraftIsProposable(draft)) {
    dialogueState.pendingConfirmation = false;
    if (invitation) {
      dialogueState.pendingInvitation = { ...invitation, status: 'awaiting_title' };
    }
    return false;
  }
  if (!draft.category || !String(draft.category).trim()) {
    draft.category = INVITATION_DEFAULT_CATEGORY;
  }
  dialogueState.pendingConfirmation = true;
  dialogueState.needsReconfirm = false;
  dialogueState.pendingInvitation = null;
  return true;
}

function applyInvitationDrafting(dialogueState, invitation, route, { categoryNames, replace } = {}) {
  const slots = (route && route.slots) || {};
  const amount = slots.amount != null ? Number(slots.amount) : invitation.amount;
  const date = slots.purchaseDate ? String(slots.purchaseDate).slice(0, 10) : invitation.date;
  seedTrustedInvitationDraft(dialogueState, { ...invitation, amount, date }, { replace });
  applyUserInvitationSlots(dialogueState, slots, categoryNames);
  finalizeInvitationDraft(dialogueState, invitation);
}

function clearInvitation(dialogueState, invitation) {
  if (dialogueState.pendingConfirmation !== true
    && looksLikeInvitationSeed(dialogueState.draftTransaction, invitation)) {
    dialogueState.draftTransaction = {};
  }
  dialogueState.pendingInvitation = null;
}

function parseInvitationSlotFill(message, knownCategories) {
  const text = String(message || '').trim();
  const result = { title: null, category: null };
  if (!text) return result;

  const under = text.match(/\bunder\s+([A-Za-z][A-Za-z0-9 &'-]{0,40})/i);
  if (under) {
    const catRaw = String(under[1] || '').replace(/\s+and\b.*$/i, '').replace(/[.!?]+$/g, '').trim();
    const snapped = snapInvitationCategory(catRaw, knownCategories);
    if (snapped) result.category = snapped;
  }

  const callIt = text.match(/\b(?:call it|name it|title(?:\s+it)?(?:\s+is)?)\s+["']?([^"'.,!?]+?)(?:["']|\s+and\b|\s+under\b|$)/i);
  const addAs = text.match(/\b(?:add|create|log|schedule)\s+it\s+as\s+["']?([^"'.,!?]+?)(?:["']|\s+under\b|$)/i);
  const asUnder = text.match(/\bas\s+["']?([^"'.,!?]+?)\s+under\b/i);
  let titleRaw = null;
  if (callIt) titleRaw = callIt[1];
  else if (addAs) titleRaw = addAs[1];
  else if (asUnder) titleRaw = asUnder[1];
  if (titleRaw) {
    titleRaw = String(titleRaw).replace(/\s+and\s*$/i, '').trim();
    if (titleRaw) result.title = titleRaw.replace(/\s+/g, ' ');
  }
  return result;
}

function parseAwaitingTitleMessage(message, knownCategories) {
  const parsed = parseInvitationSlotFill(message, knownCategories);
  if (parsed.title || parsed.category) return parsed;
  const text = String(message || '').trim().replace(/[.!?]+$/g, '').trim();
  if (!text || text.length > 60 || /\?/.test(message)) return parsed;
  if (isBareAffirmative(message) || isBareNegative(message)) return parsed;
  if (/\b(can i|will i|how much|what about|afford|negative|forecast|balance)\b/i.test(text)) {
    return parsed;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 &'.-]{0,48}$/.test(text) || text.split(/\s+/).length > 6) {
    return parsed;
  }
  const snapped = snapInvitationCategory(text, knownCategories);
  if (snapped && Array.isArray(knownCategories) && knownCategories.some((n) => String(n).trim().toLowerCase() === text.toLowerCase())) {
    parsed.category = snapped;
    return parsed;
  }
  parsed.title = text.replace(/\s+/g, ' ');
  return parsed;
}

function isInvitationReferringWrite(text) {
  return /^(add it|create it|log it|schedule it)\b/i.test(String(text || '').trim());
}

function invitationHandoffSlots(invitation, slots, parsed) {
  const next = { ...slots };
  if (invitation && slots.amount == null && !slots.purchaseDate) {
    next.amount = invitation.amount;
    next.purchaseDate = invitation.date;
    next.subjectKind = slots.subjectKind || 'amount';
    next.subjectValue = slots.subjectValue || String(invitation.amount);
  }
  if (parsed && parsed.title) next.title = parsed.title;
  if (parsed && parsed.category) next.category = parsed.category;
  return next;
}

function buildInvitationClarifyText(invitation) {
  const inv = normalizePendingInvitation(invitation);
  if (!inv) return 'Sure — what would you like me to continue with?';
  const amount = formatInvitationAmount(inv.amount);
  const date = formatInvitationDate(inv.date);
  return `Do you mean you'd like me to add the ${amount} expense on ${date}?`;
}

function buildInvitationTitleAskText(src) {
  const amt = formatInvitationAmount(src && src.amount);
  const date = formatInvitationDate(src && (src.start || src.purchaseDate || src.date));
  if (src && src.category && !src.title) {
    return `What would you like to call the ${amt} expense?`;
  }
  return `I can prepare the ${amt} expense for ${date}. What would you like to call it?`;
}

function frequencyDisplayLabelLocal(freq) {
  const f = Number(freq);
  if (!Number.isFinite(f) || f <= 0 || f === 2) return 'One-time';
  return frequencyLabel(f)
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-');
}

function buildInvitationProposalText(draft, { accountName } = {}) {
  const amount = formatInvitationAmount(draft && draft.amount);
  const date = formatInvitationDateLong(draft && draft.start);
  const category = draft && draft.category && String(draft.category).trim()
    ? String(draft.category).trim()
    : INVITATION_DEFAULT_CATEGORY;
  const account = accountName && String(accountName).trim() ? String(accountName).trim() : 'your account';
  const title = draft && draft.title ? String(draft.title).trim() : '';
  return [
    'I propose adding:',
    '',
    `- Title: ${title}`,
    `- Amount: ${amount}`,
    `- Date: ${date}`,
    '- Frequency: One-time',
    `- Category: ${category}`,
    `- Account: ${account}`,
    '',
    'Confirm?',
  ].join('\n');
}

function buildRepeatWriteProposalText(draft, { accountName } = {}) {
  const amount = formatInvitationAmount(draft && draft.amount);
  const date = formatInvitationDateLong(draft && draft.start);
  const freq = Number(draft && draft.frequency);
  const freqLabel = frequencyDisplayLabelLocal(freq);
  const dateLabel = freq === 2 || !Number.isFinite(freq) || freq <= 0 ? 'Date' : 'Start date';
  const category = draft && draft.category && String(draft.category).trim()
    ? String(draft.category).trim()
    : INVITATION_DEFAULT_CATEGORY;
  const account = accountName && String(accountName).trim() ? String(accountName).trim() : 'your account';
  const title = draft && draft.title ? String(draft.title).trim() : 'expense';
  return [
    `I can add another ${title}:`,
    '',
    `- Amount: ${amount}`,
    `- ${dateLabel}: ${date}`,
    `- Frequency: ${freqLabel}`,
    `- Category: ${category}`,
    `- Account: ${account}`,
    '',
    'This will create a second transaction.',
    '',
    'Confirm?',
  ].join('\n');
}

function seedRepeatWriteDraft(dialogueState, prior) {
  if (!dialogueState || !isSeedableCommittedWrite(prior)) return false;
  dialogueState.draftTransaction = {
    title: String(prior.title).trim(),
    type: prior.type && String(prior.type).trim() ? String(prior.type).trim() : 'expense',
    amount: Math.abs(Number(prior.amount)),
    start: String(prior.start).slice(0, 10),
    frequency: prior.frequency != null && Number.isFinite(Number(prior.frequency))
      ? Number(prior.frequency)
      : INVITATION_FREQUENCY_ONCE,
    category: prior.category && String(prior.category).trim()
      ? String(prior.category).trim()
      : INVITATION_DEFAULT_CATEGORY,
  };
  dialogueState.pendingConfirmation = true;
  dialogueState.needsReconfirm = false;
  dialogueState.intent = 'repeat_write';
  dialogueState.pendingInvitation = null;
  return true;
}

function applyRepeatWriteLifecycle(dialogueState, route) {
  if (!dialogueState || typeof dialogueState !== 'object') return dialogueState;
  if (!route || !route.repeatWriteHandoff) return dialogueState;
  seedRepeatWriteDraft(dialogueState, lastCommittedCreate(dialogueState));
  return dialogueState;
}

function buildDeterministicAffirmativeText(route, dialogueState, extras = {}) {
  const resolution = route && route.affirmativeResolution;
  if (resolution === 'declined') return 'Okay.';
  if (resolution === 'invitation_clarify') {
    return buildInvitationClarifyText({
      kind: 'add_affordability_expense',
      amount: route.slots && route.slots.amount,
      date: route.slots && route.slots.purchaseDate,
      status: 'offered',
    });
  }
  if (resolution === 'analysis_clarify') {
    return 'Which would you like me to look at more closely?';
  }
  const draft = dialogueState && dialogueState.draftTransaction;
  if (resolution === 'repeat_write') {
    if (invitationDraftIsProposable(draft) && dialogueState && dialogueState.pendingConfirmation === true) {
      return buildRepeatWriteProposalText(draft, extras);
    }
    return 'Sure — what would you like me to continue with?';
  }
  if (invitationDraftIsProposable(draft) && dialogueState && dialogueState.pendingConfirmation === true) {
    return buildInvitationProposalText(draft, extras);
  }
  if (resolution === 'invitation_title_ask'
    || resolution === 'invitation_slot_fill'
    || resolution === 'write_handoff') {
    const src = draft && (draft.amount != null || draft.start)
      ? draft
      : {
          amount: route && route.slots && route.slots.amount,
          start: route && route.slots && (route.slots.purchaseDate || route.slots.start),
          category: route && route.slots && route.slots.category,
          title: route && route.slots && route.slots.title,
        };
    return buildInvitationTitleAskText(src);
  }
  return 'Sure — what would you like me to continue with?';
}

function isDeterministicAffirmativeCapability(capability) {
  return capability === 'invitation_continuation' || capability === 'bare_affirmative_unresolved';
}

function shouldSkipAzureForRoute(route) {
  if (!route) return false;
  return isDeterministicAffirmativeCapability(route.capability)
    || !!route.invitationWriteHandoff
    || !!route.repeatWriteHandoff;
}

function invitationMatchesAccount(invitation, accountId) {
  const inv = normalizePendingInvitation(invitation);
  if (!inv || !inv.accountId) return false;
  return accountsMatch(inv.accountId, accountId);
}

function applyInvitationLifecycle(dialogueState, route, { accountId, categoryNames } = {}) {
  if (!dialogueState || typeof dialogueState !== 'object') return dialogueState;
  const inv = normalizePendingInvitation(dialogueState.pendingInvitation);
  if (!inv) {
    dialogueState.pendingInvitation = null;
    return dialogueState;
  }
  const cap = route && route.capability;
  const resolution = route && route.affirmativeResolution;
  if (cap === 'invitation_continuation') {
    if (resolution === 'declined') {
      clearInvitation(dialogueState, inv);
      return dialogueState;
    }
    if (resolution === 'invitation_clarify') {
      dialogueState.pendingInvitation = { ...inv, status: 'referent_asked' };
      return dialogueState;
    }
    if (resolution === 'invitation_title_ask' || resolution === 'invitation_slot_fill') {
      applyInvitationDrafting(dialogueState, inv, route, {
        categoryNames,
        replace: resolution === 'invitation_title_ask',
      });
      return dialogueState;
    }
    return dialogueState;
  }
  if (cap === 'bare_affirmative_unresolved') {
    clearInvitation(dialogueState, inv);
    return dialogueState;
  }
  if (cap === 'transaction_write') {
    if (route && route.invitationWriteHandoff) {
      applyInvitationDrafting(dialogueState, inv, route, { categoryNames, replace: false });
      return dialogueState;
    }
    clearInvitation(dialogueState, inv);
    return dialogueState;
  }
  if (cap === 'confirmation') return dialogueState;
  if (cap) clearInvitation(dialogueState, inv);
  return dialogueState;
}

function maybeSetAffordabilityInvitation(dialogueState, {
  route,
  accountId,
  failSoft,
  macroOwnsTurn,
  evidence,
} = {}) {
  if (!dialogueState || typeof dialogueState !== 'object') return dialogueState;
  if (failSoft || !macroOwnsTurn) return dialogueState;
  if (!evidence || evidence.status !== 'ok') return dialogueState;
  const inv = buildAffordabilityInvitation(route, accountId);
  if (inv) dialogueState.pendingInvitation = inv;
  return dialogueState;
}

/**
 * Deterministic first-match capability router. No LLM.
 */
function routeCapabilityUnwrapped(input = {}) {
  const message = String(input.message || '');
  const currentDate = input.currentDate;
  const knownCategories = input.knownCategories;
  const slots = extractSlots(message, currentDate, knownCategories);
  const pendingType = pendingWriteType(input);
  const last = input.dialogueState || {};
  const currentAccountId = input.accountId;
  const invitation = normalizePendingInvitation(last.pendingInvitation);
  const invitationOk = invitation && invitationMatchesAccount(invitation, currentAccountId);

  const base = {
    capability: 'unknown',
    parentCapability: null,
    pendingType,
    confidence: 'low',
    continuationUsed: false,
    slots,
    accountChanged: false,
    affirmativeResolution: 'none',
    invitationWriteHandoff: false,
    repeatWriteHandoff: false,
  };

  // 1. Simulation constraints: real-write / what-if language in sim mode
  //    becomes simulation, unless this is an affirmative confirm of a pending write.
  if (input.simulationMode && !(pendingType && input.userAffirmative)) {
    if (isWriteUtterance(message) || isGoalWriteUtterance(message) || isSimUtterance(message)) {
      return { ...base, capability: 'simulation', confidence: 'high' };
    }
  }

  // 1b. Explicit repeat-write ("add another one") is a NEW write operation,
  //     never confirmation of the prior proposal, and never unknown.
  if (!input.simulationMode
    && isRepeatWriteUtterance(message)
    && isSeedableCommittedWrite(lastCommittedCreate(last))) {
    return {
      ...base,
      capability: 'transaction_write',
      confidence: 'high',
      repeatWriteHandoff: true,
      affirmativeResolution: 'repeat_write',
    };
  }

  // 2. Pending write + affirmative → confirmation, unless a topic switch
  //    suspended confirmation (needsReconfirm). Generic "yes" must not
  //    commit an old proposal; the draft slots stay for a later re-propose.
  if (pendingType && input.userAffirmative) {
    const ds = input.dialogueState || {};
    const txSuspended = ds.needsReconfirm === true;
    const goalSuspended = ds.goalNeedsReconfirm === true;
    const confirmationSuspended =
      (pendingType === 'goal' && goalSuspended)
      || (pendingType === 'transaction' && txSuspended)
      || (pendingType === 'both' && (txSuspended || goalSuspended));
    if (!confirmationSuspended) {
      return { ...base, capability: 'confirmation', confidence: 'high', affirmativeResolution: 'write_confirmation' };
    }
  }

  // 3. Pending write + amendment / slot-fill only — unrelated topics fall through.
  if (pendingType && !input.userAffirmative) {
    const draft = pendingType === 'goal' ? input.pendingGoalDraft : input.pendingDraft;
    if (isWriteAmendmentOrSlotFill(message, draft || input.pendingDraft)) {
      const capability = pendingType === 'goal' ? 'goal_write' : 'transaction_write';
      return { ...base, capability, confidence: 'high' };
    }
  }

  // 4. Short financial continuation (same authorized account only)
  const lastCap = last.lastCapability;
  const accountChanged = !!(last.lastAccountId && currentAccountId
    && !accountsMatch(last.lastAccountId, currentAccountId));
  const continuationEligible = FINANCIAL_CAPABILITIES.has(lastCap)
    && isShortFollowUp(message)
    && !accountChanged
    && accountsMatch(last.lastAccountId, currentAccountId);

  const namedFollowUp = collectNamedMonths(String(message || '').toLowerCase(),
    moment(currentDate, 'YYYY-MM-DD', true).isValid() ? moment(currentDate, 'YYYY-MM-DD') : moment());
  const breakContinuation = (namedFollowUp.length === 2 && lastCap === 'cashflow_trend')
    || (isCashflowTrend(message) && lastCap !== 'cashflow_trend')
    || (isCashflowComparison(message) && !isCashflowTrend(message) && lastCap === 'cashflow_trend');

  if (continuationEligible && !breakContinuation) {
    const parsedPurchase = parsePurchaseDate(message, currentDate);
    const merged = {
      amount: slots.amount != null ? slots.amount : (lastCap === 'affordability_or_planning' && last.lastSubjectKind === 'amount'
        ? Number(last.lastSubjectValue)
        : null),
      period: slots.period || last.lastPeriod || null,
      subjectKind: slots.subjectKind || last.lastSubjectKind || null,
      subjectValue: slots.subjectValue || last.lastSubjectValue || null,
      purchaseDate: last.lastPurchaseDate || null,
      purchaseDateAssumption: last.lastPurchaseDateAssumption || null,
      purchaseDateAssumptionText: last.lastPurchaseDateAssumptionText || null,
      purchaseDateError: null,
    };
    if (slots.period) merged.period = slots.period;
    if (slots.subjectKind) {
      merged.subjectKind = slots.subjectKind;
      merged.subjectValue = slots.subjectValue;
    } else {
      merged.subjectKind = last.lastSubjectKind || merged.subjectKind;
      merged.subjectValue = last.lastSubjectValue || merged.subjectValue;
    }
    if (slots.amount != null && (last.lastSubjectKind === 'amount' || lastCap === 'affordability_or_planning')) {
      merged.subjectKind = 'amount';
      merged.subjectValue = String(slots.amount);
      merged.amount = slots.amount;
    }
    if (parsedPurchase && parsedPurchase.error) {
      merged.purchaseDateError = parsedPurchase.error;
      if (parsedPurchase.date) merged.purchaseDate = parsedPurchase.date;
    } else if (parsedPurchase && parsedPurchase.date) {
      merged.purchaseDate = parsedPurchase.date;
      merged.purchaseDateAssumption = parsedPurchase.assumption;
      merged.purchaseDateAssumptionText = parsedPurchase.assumptionText;
      merged.purchaseDateError = null;
    }
    if (lastCap === 'cashflow_comparison' && last.lastComparison) {
      merged.periodA = last.lastComparison.periodA || null;
      merged.periodB = last.lastComparison.periodB || null;
      merged.windowKind = last.lastComparison.windowKind || null;
      if (categoryStemsIn(message).size >= 2) {
        merged.comparisonError = 'compound_comparison_unsupported';
      }
    }
    if (lastCap === 'cashflow_trend' && last.lastTrend) {
      merged.periods = last.lastTrend.periods || null;
      merged.windowKind = last.lastTrend.windowKind || null;
      merged.metricScope = slots.subjectKind === 'category'
        ? 'category'
        : (last.lastTrend.metricScope || 'spending');
      if (categoryStemsIn(message).size >= 2) {
        merged.trendError = 'compound_trend_unsupported';
      } else if (slots.subjectKind === 'merchant') {
        merged.trendError = 'merchant_trend_unsupported';
      }
    }
    return {
      ...base,
      capability: 'continuation',
      parentCapability: lastCap,
      confidence: 'high',
      continuationUsed: true,
      slots: merged,
      accountChanged: false,
    };
  }

  // Account switch: never inherit prior financial subject as continuation.
  // A fully re-specified question still falls through to the normal classifier.
  if (accountChanged && isShortFollowUp(message) && !slots.period && !parseMerchant(message) && !parseCategory(message)) {
    return { ...base, capability: 'unknown', confidence: 'low', accountChanged: true };
  }

  // 5. Deterministic normal classifier
  if (input.simulationMode && isSimUtterance(message)) {
    return { ...base, capability: 'simulation', confidence: 'high', accountChanged };
  }
  if (isProductHelp(message)) {
    return { ...base, capability: 'product_help', confidence: 'high', accountChanged };
  }
  if (isSimUtterance(message)) {
    return { ...base, capability: 'simulation', confidence: 'medium', accountChanged };
  }
  if (isGoalWriteUtterance(message)) {
    return { ...base, capability: 'goal_write', confidence: 'high', accountChanged };
  }
  if (isWriteUtterance(message) || (invitationOk && isInvitationReferringWrite(message))) {
    const parsed = invitationOk ? parseInvitationSlotFill(message, knownCategories) : { title: null, category: null };
    const writeSlots = invitationHandoffSlots(invitationOk ? invitation : null, slots, parsed);
    return {
      ...base,
      capability: 'transaction_write',
      confidence: 'high',
      accountChanged,
      slots: writeSlots,
      invitationWriteHandoff: !!invitationOk,
      affirmativeResolution: invitationOk ? 'write_handoff' : 'none',
    };
  }
  if (isNavUtterance(message)) {
    return { ...base, capability: 'navigation_ui', confidence: 'high', accountChanged };
  }
  if (detectWantsUiAction(message)) {
    const nav = extractNavLookup(message, currentDate, knownCategories);
    const navSlots = nav
      ? {
          ...slots,
          subjectKind: nav.subjectKind || slots.subjectKind,
          subjectValue: nav.subjectValue || slots.subjectValue,
          period: nav.period || slots.period,
          displaySubject: nav.displaySubject || slots.displaySubject,
        }
      : slots;
    return {
      ...base,
      capability: 'navigation_ui',
      confidence: 'high',
      accountChanged,
      slots: navSlots,
    };
  }
  if (isCasual(message)) {
    return { ...base, capability: 'casual_conversation', confidence: 'high', accountChanged };
  }
  if (isMixedMacro(message)) {
    return { ...base, capability: 'mixed_macro', confidence: 'high', accountChanged, slots };
  }
  if (isAffordability(message)) {
    return { ...base, capability: 'affordability_or_planning', confidence: 'high', accountChanged, slots };
  }
  if (isCashflowTrend(message)) {
    const trend = parseTrendPeriods(message, currentDate);
    const trendError = slots.subjectKind === 'merchant'
      ? 'merchant_trend_unsupported'
      : (categoryStemsIn(message).size >= 2 ? 'compound_trend_unsupported' : (trend.error || null));
    return {
      ...base,
      capability: 'cashflow_trend',
      confidence: 'high',
      accountChanged,
      slots: {
        ...slots,
        periods: trend.periods || null,
        windowKind: trend.windowKind || null,
        metricScope: trendMetricScope(message, slots.subjectKind),
        trendError,
      },
    };
  }
  if (isCashflowComparison(message)) {
    const comparison = parseComparisonPeriods(message, currentDate);
    return {
      ...base,
      capability: 'cashflow_comparison',
      confidence: 'high',
      accountChanged,
      slots: {
        ...slots,
        periodA: comparison.periodA || null,
        periodB: comparison.periodB || null,
        windowKind: comparison.windowKind || null,
        comparisonError: comparison.error || null,
      },
    };
  }
  if (isCashflowAnalysis(message)) {
    let period = slots.period;
    if (!period && isNegativeRiskQuestion(message)) {
      const today = moment(currentDate, 'YYYY-MM-DD', true).isValid()
        ? moment(currentDate, 'YYYY-MM-DD')
        : moment();
      period = {
        start: today.format('YYYY-MM-DD'),
        end: today.clone().add(90, 'days').format('YYYY-MM-DD'),
        label: 'forecast_horizon',
      };
    } else if (!period) {
      period = parsePeriod('this month', currentDate);
    }
    return {
      ...base,
      capability: 'cashflow_analysis',
      confidence: 'high',
      accountChanged,
      slots: { ...slots, period },
    };
  }
  if (isForecast(message)) {
    return { ...base, capability: 'financial_forecast', confidence: 'high', accountChanged, slots };
  }
  if (isLookup(message)) {
    const kind = /\b(balance|available|credit limit)\b/.test(message.toLowerCase()) && !/\b(spend|spent)\b/.test(message.toLowerCase())
      ? 'account'
      : slots.subjectKind;
    const value = kind === 'account' ? 'balance' : slots.subjectValue;
    return {
      ...base,
      capability: 'financial_lookup',
      confidence: 'high',
      accountChanged,
      slots: { ...slots, subjectKind: kind || slots.subjectKind, subjectValue: value || slots.subjectValue },
    };
  }

  // 6. Bare-affirmative continuation — never unknown, never UI deixis.
  if (isBareNegative(message) && invitation) {
    return {
      ...base,
      capability: 'invitation_continuation',
      confidence: 'high',
      accountChanged,
      affirmativeResolution: 'declined',
    };
  }
  if (isBareAffirmative(message) && !pendingType) {
    if (invitation && !invitationOk) {
      return {
        ...base,
        capability: 'bare_affirmative_unresolved',
        confidence: 'high',
        accountChanged: true,
        affirmativeResolution: 'unresolved_clarify',
      };
    }
    if (invitationOk && (invitation.status === 'referent_asked' || invitation.status === 'awaiting_title')) {
      return {
        ...base,
        capability: 'invitation_continuation',
        confidence: 'high',
        accountChanged: false,
        invitationWriteHandoff: true,
        affirmativeResolution: 'invitation_title_ask',
        slots: {
          ...slots,
          amount: invitation.amount,
          purchaseDate: invitation.date,
          subjectKind: 'amount',
          subjectValue: String(invitation.amount),
        },
      };
    }
    if (invitationOk) {
      return {
        ...base,
        capability: 'invitation_continuation',
        confidence: 'high',
        accountChanged: false,
        affirmativeResolution: 'invitation_clarify',
        slots: {
          ...slots,
          amount: invitation.amount,
          purchaseDate: invitation.date,
          subjectKind: 'amount',
          subjectValue: String(invitation.amount),
        },
      };
    }
    if (last.lastCapability === 'cashflow_analysis') {
      return {
        ...base,
        capability: 'bare_affirmative_unresolved',
        confidence: 'high',
        accountChanged,
        affirmativeResolution: 'analysis_clarify',
      };
    }
    return {
      ...base,
      capability: 'bare_affirmative_unresolved',
      confidence: 'high',
      accountChanged,
      affirmativeResolution: 'unresolved_clarify',
    };
  }
  if (isAgreementPhrase(message) && !pendingType) {
    if (invitationOk && (invitation.status === 'referent_asked' || invitation.status === 'awaiting_title')) {
      return {
        ...base,
        capability: 'invitation_continuation',
        confidence: 'high',
        accountChanged: false,
        invitationWriteHandoff: true,
        affirmativeResolution: 'invitation_title_ask',
        slots: {
          ...slots,
          amount: invitation.amount,
          purchaseDate: invitation.date,
          subjectKind: 'amount',
          subjectValue: String(invitation.amount),
        },
      };
    }
    return {
      ...base,
      capability: 'bare_affirmative_unresolved',
      confidence: 'high',
      accountChanged,
      affirmativeResolution: 'unresolved_clarify',
    };
  }
  if (input.userAffirmative && !pendingType) {
    return {
      ...base,
      capability: 'bare_affirmative_unresolved',
      confidence: 'high',
      accountChanged,
      affirmativeResolution: 'unresolved_clarify',
    };
  }

  if (invitationOk && invitation.status === 'awaiting_title' && !pendingType) {
    const parsed = parseAwaitingTitleMessage(message, knownCategories);
    if (parsed.title || parsed.category) {
      return {
        ...base,
        capability: 'invitation_continuation',
        confidence: 'high',
        accountChanged: false,
        invitationWriteHandoff: true,
        affirmativeResolution: 'invitation_slot_fill',
        slots: {
          ...slots,
          amount: invitation.amount,
          purchaseDate: invitation.date,
          subjectKind: slots.subjectKind || 'amount',
          subjectValue: slots.subjectValue || String(invitation.amount),
          title: parsed.title,
          category: parsed.category,
        },
      };
    }
  }

  // 7. unknown
  return { ...base, capability: 'unknown', confidence: 'low', accountChanged };
}

function routeCapability(input = {}) {
  const result = routeCapabilityUnwrapped(input);
  return attachLookupMeta(
    result,
    String(input.message || ''),
    input.currentDate,
    input.knownCategories
  );
}

const PERSIST_CAPABILITIES = new Set([
  'financial_lookup',
  'financial_forecast',
  'cashflow_analysis',
  'cashflow_comparison',
  'cashflow_trend',
  'affordability_or_planning',
  'continuation',
]);

function shouldPersistContinuation(route, { failSoft } = {}) {
  if (!route || failSoft) return false;
  if (route.confidence === 'low' && route.capability === 'unknown') return false;
  if (route.capability === 'confirmation'
    || route.capability === 'casual_conversation'
    || route.capability === 'product_help'
    || route.capability === 'navigation_ui'
    || route.capability === 'invitation_continuation'
    || route.capability === 'bare_affirmative_unresolved') {
    return false;
  }
  return PERSIST_CAPABILITIES.has(route.capability);
}

function applyContinuationPersistence(dialogueState, route, { accountId, failSoft } = {}) {
  if (!dialogueState || typeof dialogueState !== 'object') return dialogueState;
  if (!shouldPersistContinuation(route, { failSoft })) return dialogueState;

  const cap = route.capability === 'continuation' ? route.parentCapability : route.capability;
  const slots = route.slots || {};
  dialogueState.lastCapability = cap || null;
  dialogueState.lastSubjectKind = slots.subjectKind || null;
  dialogueState.lastSubjectValue = clipSubject(slots.subjectValue);
  dialogueState.lastPeriod = slots.period && slots.period.label
    ? {
        start: String(slots.period.start || '').slice(0, 10),
        end: String(slots.period.end || '').slice(0, 10),
        label: String(slots.period.label).slice(0, 32),
      }
    : null;
  dialogueState.lastAccountId = accountId == null || accountId === '' ? null : String(accountId);
  if (cap === 'affordability_or_planning') {
    dialogueState.lastPurchaseDate = slots.purchaseDate ? String(slots.purchaseDate).slice(0, 10) : null;
    dialogueState.lastPurchaseDateAssumption = slots.purchaseDateAssumption
      ? String(slots.purchaseDateAssumption).slice(0, 64)
      : null;
    dialogueState.lastPurchaseDateAssumptionText = slots.purchaseDateAssumptionText
      ? String(slots.purchaseDateAssumptionText).slice(0, 160)
      : null;
  }
  if (cap === 'cashflow_comparison' && slots.periodA && slots.periodB) {
    dialogueState.lastComparison = {
      periodA: {
        start: String(slots.periodA.start || '').slice(0, 10),
        end: String(slots.periodA.end || '').slice(0, 10),
        label: slots.periodA.label ? String(slots.periodA.label).slice(0, 64) : undefined,
      },
      periodB: {
        start: String(slots.periodB.start || '').slice(0, 10),
        end: String(slots.periodB.end || '').slice(0, 10),
        label: slots.periodB.label ? String(slots.periodB.label).slice(0, 64) : undefined,
      },
      windowKind: slots.windowKind ? String(slots.windowKind).slice(0, 32) : null,
    };
  }
  if (cap === 'cashflow_trend' && Array.isArray(slots.periods) && slots.periods.length) {
    dialogueState.lastTrend = {
      periods: slots.periods.slice(0, 3).map((p) => ({
        start: String(p.start || '').slice(0, 10),
        end: String(p.end || '').slice(0, 10),
        label: p.label ? String(p.label).slice(0, 64) : undefined,
      })),
      windowKind: slots.windowKind ? String(slots.windowKind).slice(0, 32) : null,
      metricScope: slots.metricScope ? String(slots.metricScope).slice(0, 16) : 'spending',
      categoryFilter: slots.subjectKind === 'category' ? clipSubject(slots.subjectValue) : null,
    };
  }
  return dialogueState;
}

function applyContinuationPersistenceFromEvidence(dialogueState, route, evidence, opts) {
  const lookups = Array.isArray(evidence && evidence.lookups) ? evidence.lookups : [];
  let lastOk = null;
  for (const lookup of lookups) {
    if (lookup && lookup.status === 'ok'
      && (lookup.subjectKind === 'merchant' || lookup.subjectKind === 'category')) {
      lastOk = lookup;
    }
  }
  const persistRoute = lastOk
    ? {
        ...route,
        slots: {
          ...(route.slots || {}),
          subjectKind: lastOk.subjectKind,
          subjectValue: lastOk.subjectValue,
          period: lastOk.period,
        },
      }
    : route;
  const facts = evidence && evidence.facts;
  if ((persistRoute.capability === 'cashflow_comparison'
      || persistRoute.parentCapability === 'cashflow_comparison')
    && facts && facts.periodA && facts.periodB) {
    return applyContinuationPersistence(dialogueState, {
      ...persistRoute,
      slots: {
        ...(persistRoute.slots || {}),
        periodA: facts.periodA,
        periodB: facts.periodB,
        windowKind: facts.windowKind || evidence.windowKind || persistRoute.slots.windowKind,
      },
    }, opts);
  }
  if ((persistRoute.capability === 'cashflow_trend'
      || persistRoute.parentCapability === 'cashflow_trend')
    && facts && Array.isArray(facts.periods) && facts.periods.length) {
    return applyContinuationPersistence(dialogueState, {
      ...persistRoute,
      slots: {
        ...(persistRoute.slots || {}),
        periods: facts.periods,
        windowKind: facts.windowKind || evidence.windowKind || persistRoute.slots.windowKind,
        metricScope: facts.metricScope || persistRoute.slots.metricScope,
      },
    }, opts);
  }
  return applyContinuationPersistence(dialogueState, persistRoute, opts);
}

module.exports = {
  CAPABILITIES,
  FINANCIAL_CAPABILITIES,
  MAX_LOOKUP_CLAUSES,
  routeCapability,
  extractSlots,
  extractLookupRequests,
  parsePeriod,
  parseComparisonPeriods,
  parseTrendPeriods,
  parseAmount,
  parsePurchaseDate,
  shouldPersistContinuation,
  applyContinuationPersistence,
  applyContinuationPersistenceFromEvidence,
  asksForFinancialAmount,
  clipSubject,
  isWriteAmendmentOrSlotFill,
  isProductHelp,
  isSimUtterance,
  isLookup,
  isForecast,
  isCashflowAnalysis,
  isCashflowComparison,
  isCashflowTrend,
  isAffordability,
  detectWantsUiAction,
  buildOpenSearchAction,
  mergeOpenSearchUiActions,
  isKnownCategoryToken,
  isBareAffirmative,
  isBareNegative,
  isAgreementPhrase,
  isRepeatWriteUtterance,
  isShortFollowUp,
  lastCommittedCreate,
  normalizePendingInvitation,
  buildAffordabilityInvitation,
  applyInvitationLifecycle,
  applyRepeatWriteLifecycle,
  maybeSetAffordabilityInvitation,
  buildInvitationClarifyText,
  buildDeterministicAffirmativeText,
  isDeterministicAffirmativeCapability,
  shouldSkipAzureForRoute,
  parseInvitationSlotFill,
  invitationDraftIsProposable,
  INVITATION_FREQUENCY_ONCE,
  INVITATION_DEFAULT_CATEGORY,
};
