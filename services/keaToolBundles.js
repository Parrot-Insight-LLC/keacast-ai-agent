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
  'openTransactionSearch',
]);
const FINANCIAL_FORECAST = Object.freeze(['getRecurringForecasts']);
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
  affordability_or_planning: AFFORDABILITY,
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
  return new Set(bundleForCapability(capability, opts));
}

module.exports = {
  BUNDLES,
  TRANSACTION_WRITE,
  GOAL_WRITE,
  bundleForCapability,
  allowedToolsFor,
};
