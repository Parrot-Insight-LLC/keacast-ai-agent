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
  affordability_or_planning: GROUNDING_REQUIRED,
  continuation: 'inherited',
  unknown: GROUNDING_OPTIONAL,
});

const FAIL_SOFT_TEXT =
  "I couldn't verify the current Keacast data needed for that answer. Please try again in a moment, or check this account on the calendar.";

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
  if (capability === 'financial_forecast') return 'snapshot';
  if (capability === 'affordability_or_planning') return 'snapshot';
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
  resolveGroundingPolicy,
  resolveGroundingLevel,
  isFailSoft,
  responseModeFor,
  groundingStrategyFor,
};
