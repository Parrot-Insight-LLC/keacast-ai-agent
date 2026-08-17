'use strict';

const PRODUCT_HELP = Object.freeze(['navigateTo', 'openCalendarDay', 'selectAccount']);
const CASUAL = Object.freeze([]);
const NAVIGATION_UI = Object.freeze([
  'navigateTo',
  'selectAccount',
  'openCalendarDay',
  'openTransactionSearch',
  'highlightTransaction',
]);
const FINANCIAL_LOOKUP = Object.freeze([
  'getUserTransactions',
  'getFocusedEntityDetails',
]);
const FINANCIAL_FORECAST = Object.freeze(['getRecurringForecasts']);
const CASHFLOW_ANALYSIS = Object.freeze([]);
const CASHFLOW_COMPARISON = Object.freeze([]);
const AFFORDABILITY = Object.freeze([]);
const TRANSACTION_WRITE = Object.freeze([
  'updateDraftTransaction',
  'confirmTransaction',
  'createTransaction',
  'updateTransaction',
  'deleteTransaction',
  'getRecurringForecasts',
  'getFocusedEntityDetails',
  'getUserTransactions',
]);
const GOAL_WRITE = Object.freeze([
  'updateDraftGoal',
  'confirmTransaction',
  'createGoal',
  'updateGoal',
  'deleteGoal',
  'previewGoalCadence',
]);
const SIMULATION = Object.freeze([
  'proposeSimulationAdd',
  'proposeSimulationModify',
  'proposeSimulationRemove',
  'getRecurringForecasts',
  'getFocusedEntityDetails',
  'getUserTransactions',
]);
const UNKNOWN = Object.freeze([
  'navigateTo',
  'openCalendarDay',
  'openTransactionSearch',
  'getUserTransactions',
  'getFocusedEntityDetails',
]);

const BUNDLES = Object.freeze({
  product_help: PRODUCT_HELP,
  casual_conversation: CASUAL,
  navigation_ui: NAVIGATION_UI,
  financial_lookup: FINANCIAL_LOOKUP,
  financial_forecast: FINANCIAL_FORECAST,
  cashflow_analysis: CASHFLOW_ANALYSIS,
  cashflow_comparison: CASHFLOW_COMPARISON,
  cashflow_trend: Object.freeze([]),
  cashflow_recurring: Object.freeze([]),
  cashflow_upcoming: Object.freeze([]),
  affordability_or_planning: AFFORDABILITY,
  mixed_macro: Object.freeze([]),
  invitation_continuation: Object.freeze([]),
  bare_affirmative_unresolved: Object.freeze([]),
  transaction_write: TRANSACTION_WRITE,
  goal_write: GOAL_WRITE,
  simulation: SIMULATION,
  unknown: UNKNOWN,
});

function unionNames(lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const name of list || []) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function bundleForCapability(capability, { parentCapability, pendingType } = {}) {
  if (capability === 'continuation') {
    return bundleForCapability(parentCapability || 'unknown', { pendingType });
  }
  if (capability === 'confirmation') {
    if (pendingType === 'goal') return GOAL_WRITE.slice();
    if (pendingType === 'both') return unionNames([TRANSACTION_WRITE, GOAL_WRITE]);
    return TRANSACTION_WRITE.slice();
  }
  const list = BUNDLES[capability];
  return list ? list.slice() : UNKNOWN.slice();
}

function allowedToolsFor(capability, opts = {}) {
  const names = bundleForCapability(capability, opts);
  let out = names;
  if (opts.omitGetUserTransactions) {
    out = out.filter((n) => n !== 'getUserTransactions');
  }
  if (opts.omitFocusedEntityTools) {
    out = out.filter((n) => n !== 'getFocusedEntityDetails' && n !== 'getUserTransactions');
  }
  if (opts.includeOpenTransactionSearch && !out.includes('openTransactionSearch')) {
    out = out.concat(['openTransactionSearch']);
  }
  return new Set(out);
}

module.exports = {
  BUNDLES,
  TRANSACTION_WRITE,
  GOAL_WRITE,
  bundleForCapability,
  allowedToolsFor,
};
