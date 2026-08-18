'use strict';

const { check, section } = require('./harness');
const { routeCapability } = require('../services/keaCapabilityRouter');
const {
  resolveGroundingPolicy,
  isFailSoft,
  responseModeFor,
  groundingStrategyFor,
  FAIL_SOFT_TEXT,
  MATRIX,
} = require('../services/keaGroundingPolicy');

function policyFor(message, extra = {}) {
  const route = routeCapability({
    message,
    currentDate: '2026-08-16',
    accountId: '10',
    dialogueState: extra.dialogueState || {},
    pendingWrite: extra.pendingWrite,
    pendingGoalWrite: extra.pendingGoalWrite,
    userAffirmative: extra.userAffirmative,
    simulationMode: extra.simulationMode,
  });
  return { route, policy: resolveGroundingPolicy(route, { message }) };
}

async function run() {
  section('grounding matrix');

  check('product_help NONE', policyFor('What is reconciliation?').policy.grounding === 'NONE');
  check('product_help not required', policyFor('What is reconciliation?').policy.groundingRequired === false);
  check('casual NONE', policyFor('Hi Kea').policy.grounding === 'NONE');
  check('lookup REQUIRED', policyFor('How much did I spend at Walmart last month?').policy.groundingRequired === true);
  check('forecast REQUIRED', policyFor('Will I go negative next month?').policy.groundingRequired === true);
  check('affordability REQUIRED', policyFor('Can I afford $800 next month?').policy.groundingRequired === true);
  check(
    'unknown amount question is REQUIRED so we do not invent',
    policyFor('how much is it').policy.groundingRequired === true
    && policyFor('how much is it').policy.effectiveCapability === 'unknown'
  );
  check('confirmation OPTIONAL', MATRIX.confirmation === 'OPTIONAL');
  check('transaction_write OPTIONAL', MATRIX.transaction_write === 'OPTIONAL');
  check('simulation OPTIONAL', MATRIX.simulation === 'OPTIONAL');
  check('invitation_continuation NONE', MATRIX.invitation_continuation === 'NONE');
  check('bare_affirmative_unresolved NONE', MATRIX.bare_affirmative_unresolved === 'NONE');

  const cont = policyFor('What about $1,200?', {
    dialogueState: {
      lastCapability: 'affordability_or_planning',
      lastSubjectKind: 'amount',
      lastSubjectValue: '800',
      lastPeriod: { start: '2026-09-01', end: '2026-09-30', label: 'next_month' },
      lastAccountId: '10',
    },
  });
  check('continuation inherits REQUIRED', cont.policy.groundingRequired === true);
  check('continuation effective affordability', cont.policy.effectiveCapability === 'affordability_or_planning');

  check('lookup prefetch_read for merchant period', policyFor('How much did I spend at Walmart last month?').policy.prefetchKind === 'prefetch_read');
  check('balance uses snapshot', policyFor("What's my balance?").policy.prefetchKind === 'snapshot');
  check('negative-risk uses cashflow_macro', policyFor('Will I go negative next month?').policy.prefetchKind === 'cashflow_macro');
  check('affordability uses affordability_macro', policyFor('Can I afford $800 next month?').policy.prefetchKind === 'affordability_macro');
  check('how am I doing uses cashflow_macro', policyFor('How am I doing this month?').policy.prefetchKind === 'cashflow_macro');
  check('spending lately uses cashflow_trend_macro', policyFor('Am I spending more lately?').policy.prefetchKind === 'cashflow_trend_macro');
  check('recurring expenses uses cashflow_recurring_macro', policyFor('What recurring expenses do I have?').policy.prefetchKind === 'cashflow_recurring_macro');
  check('bills due next week uses cashflow_upcoming_macro', policyFor('What bills are due next week?').policy.prefetchKind === 'cashflow_upcoming_macro');
  check('next paycheck uses cashflow_income_horizon_macro', policyFor('When is my next paycheck?').policy.prefetchKind === 'cashflow_income_horizon_macro');
  check('future balance wording still snapshot forecast', policyFor('What will my balance be next month?').policy.prefetchKind === 'snapshot');

  section('fail-soft policy');

  const required = policyFor('How much did I spend at Walmart last month?').policy;
  check('REQUIRED + no evidence is fail-soft', isFailSoft(required, null) === true);
  check('REQUIRED + unavailable is fail-soft', isFailSoft(required, { status: 'unavailable' }) === true);
  check('REQUIRED + ok is not fail-soft', isFailSoft(required, { status: 'ok' }) === false);
  check('REQUIRED + partial is not fail-soft', isFailSoft(required, { status: 'partial' }) === false);
  check('fail-soft text has no dollar amount', !/\$\s*\d/.test(FAIL_SOFT_TEXT));
  check(
    'fail-soft response_mode',
    responseModeFor({ policy: required, failSoft: true, capability: 'financial_lookup' }) === 'fail_soft'
  );
  check(
    'failed strategy',
    groundingStrategyFor({ policy: required, failSoft: true }) === 'failed'
  );
  check(
    'confirmation response_mode',
    responseModeFor({ capability: 'confirmation', failSoft: false }) === 'confirmation'
  );
}

module.exports = { run };
