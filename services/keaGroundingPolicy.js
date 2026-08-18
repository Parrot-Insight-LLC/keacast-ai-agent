'use strict';

const { asksForFinancialAmount, FINANCIAL_CAPABILITIES } = require('./keaCapabilityRouter');

const GROUNDING_NONE = 'NONE';
const GROUNDING_OPTIONAL = 'OPTIONAL';
const GROUNDING_REQUIRED = 'REQUIRED';

const MATRIX = Object.freeze({
  product_help: GROUNDING_NONE,
  casual_conversation: GROUNDING_NONE,
  navigation_ui: GROUNDING_NONE,
  confirmation: GROUNDING_OPTIONAL,
  transaction_write: GROUNDING_OPTIONAL,
  goal_write: GROUNDING_OPTIONAL,
  simulation: GROUNDING_OPTIONAL,
  financial_lookup: GROUNDING_REQUIRED,
  financial_forecast: GROUNDING_REQUIRED,
  cashflow_analysis: GROUNDING_REQUIRED,
  cashflow_comparison: GROUNDING_REQUIRED,
  cashflow_trend: GROUNDING_REQUIRED,
  cashflow_recurring: GROUNDING_REQUIRED,
  cashflow_upcoming: GROUNDING_REQUIRED,
  cashflow_income_horizon: GROUNDING_REQUIRED,
  affordability_or_planning: GROUNDING_REQUIRED,
  mixed_macro: GROUNDING_REQUIRED,
  invitation_continuation: GROUNDING_NONE,
  bare_affirmative_unresolved: GROUNDING_NONE,
  conversation_clarify: GROUNDING_NONE,
  continuation: 'inherited',
  unknown: GROUNDING_OPTIONAL,
});

const FAIL_SOFT_TEXT =
  "I couldn't verify the current Keacast data needed for that answer. Please try again in a moment, or check this account on the calendar.";

const FAIL_SOFT_BY_LIMITATION = Object.freeze({
  amount_invalid: 'I need a positive purchase amount to assess that. Name a dollar amount and a specific date, such as next Friday.',
  date_unresolved: 'I need a specific purchase date — a calendar date, tomorrow, next Friday, or September 15. I cannot use payday or a vague time like "sometime this month."',
  past_date: 'That purchase date is in the past. Affordability looks at upcoming dates in your 90-day Keacast forecast.',
  date_beyond_horizon: 'That date is more than 90 days out, which is beyond the Keacast forecast I use for this question.',
  purchase_not_in_forecast_window: 'That purchase date is outside the current Keacast forecast window, so I cannot compare a reliable baseline and hypothetical.',
  forecast_unavailable: "I couldn't load the Keacast forecast needed for that answer. Please try again in a moment.",
  access_unverified: FAIL_SOFT_TEXT,
  mixed_macro_unsupported: 'I can answer one of those at a time. Which should I do first — how you are doing this month, or whether you can afford that purchase?',
  forecast_comparison_unsupported: 'I can compare posted actual transactions between two past periods, but not forecasts. Try comparing two completed months, or this month so far with last month so far.',
  comparison_periods_unresolved: 'I need two specific periods to compare, such as this month vs last month, or July vs June.',
  invalid_explicit_bounds: 'Those date ranges are not a valid comparison window. Try dates like August 1 through 10 and July 1 through 10.',
  compound_comparison_unsupported: 'I can compare one category across those two periods at a time. Which category should I look at first?',
  forecast_trend_unsupported: 'I can show a posted-actual spending trend for recent months, but not a forecast trend.',
  trend_periods_unresolved: 'I need a 3-month window to show a trend, such as the last three months, or May through July.',
  trend_period_count_unsupported: 'I can show a 3-month trend right now. Try the last three months, or three named months such as May through July.',
  compound_trend_unsupported: 'I can show a trend for one category at a time. Which category should I look at first?',
  merchant_trend_unsupported: 'I can show a category or overall spending trend, but not a merchant trend yet.',
  recurring_definition_unsupported: 'I can analyze scheduled recurring expenses and income in your Keacast forecast, but I cannot reliably classify which of those are subscriptions.',
  recurring_share_unsupported: 'I cannot say what share of spending is recurring. Scheduled Keacast forecasts and posted spending are different measures.',
  recurring_trend_unsupported: 'I cannot trend recurring spending yet. I can list scheduled recurring items in your Keacast forecast.',
  recurring_item_unmatched: 'I don\'t see a matching scheduled recurring item in this Keacast account.',
  recurring_unavailable: FAIL_SOFT_TEXT,
  upcoming_period_unresolved: 'I need a specific upcoming period, such as today, tomorrow, this week, next week, the next 7 days, this month, or next month.',
  upcoming_historical_period: 'That period is in the past. Upcoming scheduled items are for today or future dates in your Keacast forecast.',
  upcoming_horizon_unsupported: 'I can look up scheduled items up to 90 days out. Try a shorter window such as the next 7 days or next week.',
  upcoming_unavailable: FAIL_SOFT_TEXT,
  no_scheduled_recurring_income: 'I don\'t see a qualifying future scheduled recurring income in this selected Keacast account. I can still show scheduled income for a specific future period.',
  income_horizon_unavailable: FAIL_SOFT_TEXT,
  income_horizon_unsupported: 'That next scheduled income is outside the current Keacast forecast window, so I cannot evaluate the days before it.',
  payday_affordability_unsupported: 'I can look at scheduled recurring income and the Keacast forecast before that date, but I cannot combine a specific purchase amount with payday yet. Try the amount on a calendar date, or ask about the days before your next scheduled income.',
  safe_spend_unsupported: 'I can\'t calculate a safe-to-spend amount before that income date. Keacast does not have a cushion or unmodeled-spending contract for that.',
  after_income_intraday_unsupported: 'I can\'t say what your balance will be immediately after that income. Keacast projects the calendar date as a whole at end of day and does not establish same-day order.',
  macro_error: FAIL_SOFT_TEXT,
  macro_timeout: FAIL_SOFT_TEXT,
});

function failSoftTextFor(evidence) {
  const limitations = Array.isArray(evidence && evidence.limitations) ? evidence.limitations : [];
  for (const code of limitations) {
    if (FAIL_SOFT_BY_LIMITATION[code]) return FAIL_SOFT_BY_LIMITATION[code];
  }
  return FAIL_SOFT_TEXT;
}

function resolveGroundingLevel(route, message) {
  if (!route || !route.capability) return GROUNDING_OPTIONAL;
  if (route.capability === 'continuation') {
    return MATRIX[route.parentCapability] || GROUNDING_OPTIONAL;
  }
  let level = MATRIX[route.capability] || GROUNDING_OPTIONAL;
  const msg = message || route.message || '';
  if (route.capability === 'unknown' && asksForFinancialAmount(msg)) {
    level = GROUNDING_REQUIRED;
  }
  return level;
}

function resolveGroundingPolicy(route, { message } = {}) {
  const msg = message || route?.message || '';
  const level = resolveGroundingLevel(route, msg);
  const effectiveCapability = route?.capability === 'continuation'
    ? route.parentCapability
    : route?.capability;
  let kind = prefetchKindFor(effectiveCapability, { ...route, message: msg });
  if (effectiveCapability === 'unknown' && level === GROUNDING_REQUIRED) {
    kind = 'none';
  }
  return {
    grounding: level,
    groundingRequired: level === GROUNDING_REQUIRED,
    effectiveCapability: effectiveCapability || 'unknown',
    prefetchKind: kind,
  };
}

function prefetchKindFor(capability, route) {
  if (capability === 'financial_lookup') {
    const kind = route?.slots?.subjectKind;
    if (kind === 'account') return 'snapshot';
    if (kind === 'merchant' || kind === 'category' || route?.slots?.period) return 'prefetch_read';
    if (/\b(balance|available|credit limit)\b/i.test(String(route?.message || ''))) return 'snapshot';
    return 'prefetch_read';
  }
  if (capability === 'cashflow_analysis') return 'cashflow_macro';
  if (capability === 'cashflow_comparison') return 'cashflow_comparison_macro';
  if (capability === 'cashflow_trend') return 'cashflow_trend_macro';
  if (capability === 'cashflow_recurring') return 'cashflow_recurring_macro';
  if (capability === 'cashflow_upcoming') return 'cashflow_upcoming_macro';
  if (capability === 'cashflow_income_horizon') return 'cashflow_income_horizon_macro';
  if (capability === 'affordability_or_planning') return 'affordability_macro';
  if (capability === 'mixed_macro') return 'none';
  if (capability === 'financial_forecast') return 'snapshot';
  if (FINANCIAL_CAPABILITIES.has(capability)) return 'snapshot';
  return 'none';
}

function isFailSoft(policy, evidence) {
  if (!policy || !policy.groundingRequired) return false;
  if (!evidence) return true;
  return evidence.status === 'unavailable';
}

function responseModeFor({ policy, evidence, capability, failSoft }) {
  if (failSoft) return 'fail_soft';
  if (capability === 'confirmation') return 'confirmation';
  if (policy && policy.groundingRequired && evidence && (evidence.status === 'ok' || evidence.status === 'partial')) {
    return 'grounded';
  }
  return 'ungrounded';
}

function groundingStrategyFor({ policy, evidence, failSoft }) {
  if (failSoft) return 'failed';
  if (!policy || policy.grounding === GROUNDING_NONE) return 'none';
  if (!evidence || !Array.isArray(evidence.source) || evidence.source.length === 0) return 'none';
  if (evidence.source.includes('cashflow_analysis')) return 'cashflow_macro';
  if (evidence.source.includes('cashflow_period_comparison')) return 'cashflow_comparison_macro';
  if (evidence.source.includes('cashflow_trend')) return 'cashflow_trend_macro';
  if (evidence.source.includes('cashflow_recurring')) return 'cashflow_recurring_macro';
  if (evidence.source.includes('cashflow_upcoming')) return 'cashflow_upcoming_macro';
  if (evidence.source.includes('cashflow_income_horizon')) return 'cashflow_income_horizon_macro';
  if (evidence.source.includes('affordability_analysis')) return 'affordability_macro';
  if (evidence.source.includes('user_transactions')) return 'prefetch_read';
  if (evidence.source.includes('kea_snapshot')) return 'snapshot';
  return 'none';
}

module.exports = {
  GROUNDING_NONE,
  GROUNDING_OPTIONAL,
  GROUNDING_REQUIRED,
  MATRIX,
  FAIL_SOFT_TEXT,
  failSoftTextFor,
  resolveGroundingPolicy,
  resolveGroundingLevel,
  isFailSoft,
  responseModeFor,
  groundingStrategyFor,
};
