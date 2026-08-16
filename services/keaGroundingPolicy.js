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
  affordability_or_planning: GROUNDING_REQUIRED,
  mixed_macro: GROUNDING_REQUIRED,
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
  macro_error: FAIL_SOFT_TEXT,
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
