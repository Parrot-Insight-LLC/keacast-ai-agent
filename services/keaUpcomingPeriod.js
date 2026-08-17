'use strict';

const moment = require('moment');

function dateOnlyMoment(clientDate) {
  if (clientDate && moment(clientDate, 'YYYY-MM-DD', true).isValid()) {
    return moment(clientDate, 'YYYY-MM-DD');
  }
  return null;
}

function makePeriod(start, end, relation) {
  return {
    start,
    end,
    label: relation,
    relation,
  };
}

function sundaySaturdayWeek(day) {
  return {
    start: day.clone().day(0).format('YYYY-MM-DD'),
    end: day.clone().day(6).format('YYYY-MM-DD'),
  };
}

function rangesFromClientDate(clientDate) {
  const today = dateOnlyMoment(clientDate);
  if (!today) return null;

  const todayStr = today.format('YYYY-MM-DD');
  const tomorrow = today.clone().add(1, 'day');
  const thisWeek = sundaySaturdayWeek(today);
  const nextWeekStart = today.clone().day(0).add(7, 'days');
  const lastWeekStart = today.clone().day(0).subtract(7, 'days');
  const next7Start = today.clone().add(1, 'day');
  const next7End = today.clone().add(7, 'days');
  const thisMonthStart = today.clone().startOf('month');
  const nextMonthStart = today.clone().add(1, 'month').startOf('month');
  const lastMonthStart = today.clone().subtract(1, 'month').startOf('month');

  return {
    today: makePeriod(todayStr, todayStr, 'today'),
    tomorrow: makePeriod(tomorrow.format('YYYY-MM-DD'), tomorrow.format('YYYY-MM-DD'), 'tomorrow'),
    this_week: makePeriod(thisWeek.start, thisWeek.end, 'this_week'),
    next_week: makePeriod(
      nextWeekStart.format('YYYY-MM-DD'),
      nextWeekStart.clone().day(6).format('YYYY-MM-DD'),
      'next_week'
    ),
    last_week: makePeriod(
      lastWeekStart.format('YYYY-MM-DD'),
      lastWeekStart.clone().day(6).format('YYYY-MM-DD'),
      'last_week'
    ),
    next_7_days: makePeriod(
      next7Start.format('YYYY-MM-DD'),
      next7End.format('YYYY-MM-DD'),
      'next_7_days'
    ),
    this_month: makePeriod(
      thisMonthStart.format('YYYY-MM-DD'),
      today.clone().endOf('month').format('YYYY-MM-DD'),
      'this_month'
    ),
    next_month: makePeriod(
      nextMonthStart.format('YYYY-MM-DD'),
      nextMonthStart.clone().endOf('month').format('YYYY-MM-DD'),
      'next_month'
    ),
    last_month: makePeriod(
      lastMonthStart.format('YYYY-MM-DD'),
      lastMonthStart.clone().endOf('month').format('YYYY-MM-DD'),
      'last_month'
    ),
  };
}

function shiftCalendarWeek(period) {
  if (!period || !period.start || !period.end) return null;
  const start = moment(period.start, 'YYYY-MM-DD', true);
  const end = moment(period.end, 'YYYY-MM-DD', true);
  if (!start.isValid() || !end.isValid()) return null;
  return makePeriod(
    start.clone().add(7, 'days').format('YYYY-MM-DD'),
    end.clone().add(7, 'days').format('YYYY-MM-DD'),
    'week_after'
  );
}

function parseNextDayCount(text) {
  const m = String(text || '').toLowerCase();
  const numeric = m.match(/\bnext\s+(\d{1,3})\s+days?\b/);
  if (numeric) {
    const n = Number(numeric[1]);
    return Number.isFinite(n) ? n : null;
  }
  if (/\bnext\s+seven\s+days?\b/.test(m)) return 7;
  return null;
}

function resolveUpcomingPeriod(text, clientDate) {
  const ranges = rangesFromClientDate(clientDate);
  if (!ranges) return null;
  const m = String(text || '').toLowerCase();
  if (!m) return null;

  const n = parseNextDayCount(m);
  if (n != null) {
    if (n < 1 || n > 90) {
      return {
        start: null,
        end: null,
        label: null,
        relation: null,
        error: 'upcoming_horizon_unsupported',
      };
    }
    const today = dateOnlyMoment(clientDate);
    const start = today.clone().add(1, 'day').format('YYYY-MM-DD');
    const end = today.clone().add(n, 'days').format('YYYY-MM-DD');
    const relation = n === 7 ? 'next_7_days' : 'next_n_days';
    return makePeriod(start, end, relation);
  }

  if (/\bnext week\b/.test(m)) return ranges.next_week;
  if (/\bthis week\b/.test(m)) return ranges.this_week;
  if (/\blast week\b/.test(m)) return { ...ranges.last_week, error: 'upcoming_historical_period' };
  if (/\bnext month\b/.test(m)) return ranges.next_month;
  if (/\bthis month\b/.test(m)) return ranges.this_month;
  if (/\blast month\b/.test(m)) return { ...ranges.last_month, error: 'upcoming_historical_period' };
  if (/\btomorrow\b/.test(m)) return ranges.tomorrow;
  if (/\btoday\b/.test(m)) return ranges.today;
  return null;
}

function isUpcomingPeriodCurrentOrFuture(period, clientDate) {
  if (!period || !period.end) return false;
  const today = String(clientDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return false;
  return String(period.end).slice(0, 10) >= today;
}

module.exports = {
  dateOnlyMoment,
  rangesFromClientDate,
  resolveUpcomingPeriod,
  shiftCalendarWeek,
  isUpcomingPeriodCurrentOrFuture,
};
