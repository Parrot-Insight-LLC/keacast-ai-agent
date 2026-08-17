'use strict';

const { check, section } = require('./harness');
const { filterFunctionSchemas, functionSchemas } = require('../services/openaiService');
const { bundleForCapability, allowedToolsFor } = require('../services/keaToolBundles');

function names(schemas) {
  return schemas.map((s) => s.function.name);
}

async function run() {
  section('tool bundles');

  check('product_help has navigateTo', bundleForCapability('product_help').includes('navigateTo'));
  check('casual has no tools', bundleForCapability('casual_conversation').length === 0);
  check(
    'lookup omits getUpcomingTransactions',
    !bundleForCapability('financial_lookup').includes('getUpcomingTransactions')
  );
  check(
    'lookup omits getUserAccounts',
    !bundleForCapability('financial_lookup').includes('getUserAccounts')
  );
  check(
    'forecast has getRecurringForecasts only as read',
    bundleForCapability('financial_forecast').includes('getRecurringForecasts')
    && !bundleForCapability('financial_forecast').includes('getUpcomingTransactions')
  );
  check('affordability has no model tools', bundleForCapability('affordability_or_planning').length === 0);
  check('cashflow_analysis has no model tools', bundleForCapability('cashflow_analysis').length === 0);
  check('cashflow_comparison has no model tools', bundleForCapability('cashflow_comparison').length === 0);
  check('cashflow_trend has no model tools', bundleForCapability('cashflow_trend').length === 0);
  check('mixed_macro has no model tools', bundleForCapability('mixed_macro').length === 0);
  check(
    'affordability omits getGoals',
    !bundleForCapability('affordability_or_planning').includes('getGoals')
  );
  check(
    'transaction_write keeps confirm + create',
    bundleForCapability('transaction_write').includes('confirmTransaction')
    && bundleForCapability('transaction_write').includes('createTransaction')
    && bundleForCapability('transaction_write').includes('updateDraftTransaction')
    && bundleForCapability('transaction_write').includes('deleteTransaction')
  );
  check(
    'goal_write keeps draft + writes',
    bundleForCapability('goal_write').includes('updateDraftGoal')
    && bundleForCapability('goal_write').includes('createGoal')
    && bundleForCapability('goal_write').includes('previewGoalCadence')
  );
  check(
    'confirmation tx bundle has confirmTransaction',
    bundleForCapability('confirmation', { pendingType: 'transaction' }).includes('confirmTransaction')
    && bundleForCapability('confirmation', { pendingType: 'transaction' }).includes('createTransaction')
  );
  check(
    'confirmation goal bundle does not include createTransaction',
    bundleForCapability('confirmation', { pendingType: 'goal' }).includes('createGoal')
    && !bundleForCapability('confirmation', { pendingType: 'goal' }).includes('createTransaction')
  );
  check(
    'simulation has propose tools only for writes',
    bundleForCapability('simulation').includes('proposeSimulationAdd')
    && !bundleForCapability('simulation').includes('createTransaction')
  );
  check(
    'continuation inherits lookup',
    bundleForCapability('continuation', { parentCapability: 'financial_lookup' }).includes('getUserTransactions')
  );
  check(
    'unknown has no write tools',
    !bundleForCapability('unknown').includes('createTransaction')
    && !bundleForCapability('unknown').includes('createGoal')
  );
  check('invitation_continuation has no tools', bundleForCapability('invitation_continuation').length === 0);
  check('bare_affirmative_unresolved has no tools', bundleForCapability('bare_affirmative_unresolved').length === 0);
  check('unknown still has getFocusedEntityDetails', bundleForCapability('unknown').includes('getFocusedEntityDetails'));

  section('bundle ∩ availability; simulation omit LAST');

  const confirmTools = filterFunctionSchemas(functionSchemas, {
    simulationMode: false,
    goalsAvailable: true,
    simulationAvailable: true,
    allowedTools: allowedToolsFor('confirmation', { pendingType: 'transaction' }),
  });
  check(
    'confirmation retains confirmTransaction',
    names(confirmTools).includes('confirmTransaction')
  );
  check(
    'confirmation retains createTransaction',
    names(confirmTools).includes('createTransaction')
  );

  const simConfirm = filterFunctionSchemas(functionSchemas, {
    simulationMode: true,
    goalsAvailable: true,
    simulationAvailable: true,
    allowedTools: allowedToolsFor('confirmation', { pendingType: 'transaction' }),
  });
  check(
    'sim mode strips real writes even on confirmation bundle',
    !names(simConfirm).includes('createTransaction')
    && !names(simConfirm).includes('confirmTransaction')
  );
  const simBundle = filterFunctionSchemas(functionSchemas, {
    simulationMode: true,
    goalsAvailable: true,
    simulationAvailable: true,
    allowedTools: allowedToolsFor('simulation'),
  });
  check(
    'sim bundle still has proposeSimulationAdd',
    names(simBundle).includes('proposeSimulationAdd')
  );

  const noGoals = filterFunctionSchemas(functionSchemas, {
    simulationMode: false,
    goalsAvailable: false,
    simulationAvailable: true,
    allowedTools: allowedToolsFor('goal_write'),
  });
  check('goals unavailable omits createGoal', !names(noGoals).includes('createGoal'));

  const lookup = filterFunctionSchemas(functionSchemas, {
    allowedTools: allowedToolsFor('financial_lookup'),
  });
  check('lookup bundle does not leak getUpcomingTransactions', !names(lookup).includes('getUpcomingTransactions'));
  check('lookup bundle does not leak getUserAccounts', !names(lookup).includes('getUserAccounts'));
  check('lookup bundle does not leak getSelectedKeacastAccounts', !names(lookup).includes('getSelectedKeacastAccounts'));

  const lookupOmit = filterFunctionSchemas(functionSchemas, {
    allowedTools: allowedToolsFor('financial_lookup', { omitGetUserTransactions: true }),
  });
  check('omitGetUserTransactions drops getUserTransactions', !names(lookupOmit).includes('getUserTransactions'));
  const lookupKeep = allowedToolsFor('financial_lookup');
  check('lookup without omit still has getUserTransactions', lookupKeep.has('getUserTransactions'));
  check('generic lookup does not expose openTransactionSearch', !lookupKeep.has('openTransactionSearch'));
  check(
    'wantsUiAction re-enables openTransactionSearch',
    allowedToolsFor('financial_lookup', { includeOpenTransactionSearch: true }).has('openTransactionSearch')
  );
}

module.exports = { run };
