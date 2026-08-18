'use strict';

const { check, section } = require('./harness');
const {
  routeCapability,
  applyContinuationPersistenceFromEvidence,
} = require('../services/keaCapabilityRouter');
const { resolveGroundingPolicy, isFailSoft, failSoftTextFor } = require('../services/keaGroundingPolicy');
const {
  prefetchGrounding,
  buildEvidenceSystemSection,
  azureFacingEvidence,
  shouldForceDirectAnswer,
} = require('../services/keaGroundingPrefetch');
const { allowedToolsFor } = require('../services/keaToolBundles');
const { createKeaTelemetry } = require('../services/keaTelemetry');
const { __testables: T } = require('../controllers/openaiController');

function route(message, extra = {}) {
  return routeCapability({
    message,
    currentDate: extra.currentDate || '2026-08-17',
    simulationMode: extra.simulationMode === true,
    pendingWrite: extra.pendingWrite === true,
    pendingGoalWrite: extra.pendingGoalWrite === true,
    pendingDraft: extra.pendingDraft || extra.dialogueState?.draftTransaction || null,
    pendingGoalDraft: extra.pendingGoalDraft || extra.dialogueState?.draftGoal || null,
    userAffirmative: extra.userAffirmative === true,
    dialogueState: extra.dialogueState || T.emptyDialogueState(),
    accountId: extra.accountId || '10',
  });
}

function sampleHorizonResult(partial = {}) {
  return {
    status: 'ok',
    source: ['cashflow_income_horizon'],
    accountScope: 'selected_account',
    incomeHorizonDefinition: 'kea_scheduled_recurring_income',
    nextIncome: [
      {
        label: 'Direct Deposit',
        date: '2026-08-31',
        amount: 4626.36,
        frequencyLabel: 'Semi-Monthly',
        category: 'Income',
      },
    ],
    combinedScheduledIncomeAmount: 4626.36,
    window: {
      start: '2026-08-18',
      end: '2026-08-30',
      relation: 'before_next_scheduled_income',
    },
    expensesBeforeIncome: {
      count: 2,
      total: 200,
      items: [
        { label: 'Rent', date: '2026-08-20', amount: 100 },
        { label: 'Phone', date: '2026-08-25', amount: 100 },
      ],
    },
    forecast: {
      startingAvailable: 1400,
      lowestBalanceBeforeIncome: 250,
      lowestBalanceDate: '2026-08-30',
      projectedBalanceDayBeforeIncome: 250,
      firstNegativeDate: null,
      firstNegativeAmount: null,
      projectedShortfallBeforeIncome: 0,
      daysUntilNextIncome: 14,
    },
    observations: [
      { code: 'next_scheduled_recurring_income', date: '2026-08-31' },
      { code: 'no_negative_before_income' },
    ],
    limitations: ['selected_account_scope'],
    dataAsOf: '2026-08-17',
    ...partial,
  };
}

async function run() {
  section('income-horizon router');
  check('next paycheck', route('When is my next paycheck?').capability === 'cashflow_income_horizon');
  check('get paid', route('When do I get paid?').capability === 'cashflow_income_horizon');
  check('next scheduled income', route('When is my next scheduled income?').capability === 'cashflow_income_horizon');
  check('bills before payday', route('What bills are due before payday?').capability === 'cashflow_income_horizon');
  check('negative before payday', route('Will I go negative before payday?').capability === 'cashflow_income_horizon');
  check('enough until payday', route('Will I have enough until payday?').capability === 'cashflow_income_horizon');
  check('enough until payday is not affordability', route('Will I have enough until payday?').capability !== 'affordability_or_planning');
  check('amount affordability stays affordability', route('Can I afford $300?').capability === 'affordability_or_planning');
  const paydayMix = route('Can I afford $300 before payday?');
  check('amount + payday is income-horizon unsupported', paydayMix.capability === 'cashflow_income_horizon'
    && paydayMix.slots.incomeHorizonError === 'payday_affordability_unsupported');
  const safeSpend = route('How much can I safely spend before payday?');
  check('safe spend before payday unsupported', safeSpend.capability === 'cashflow_income_horizon'
    && safeSpend.slots.incomeHorizonError === 'safe_spend_unsupported');
  check('recurring income stays recurring', route('What recurring income do I have?').capability === 'cashflow_recurring');
  check('income next week stays upcoming', route('What income is coming next week?').capability === 'cashflow_upcoming');
  check('income changed is not income horizon', route('How has my income changed?').capability !== 'cashflow_income_horizon');
  check('balance next week stays forecast/analysis', ['financial_forecast', 'cashflow_analysis'].includes(
    route('What will my balance be next week?').capability
  ));

  section('income-horizon grounding');
  const paycheck = route('When is my next paycheck?');
  const policy = resolveGroundingPolicy(paycheck, { message: 'When is my next paycheck?' });
  check('grounding required', policy.groundingRequired === true);
  check('prefetch kind', policy.prefetchKind === 'cashflow_income_horizon_macro');
  check('empty tool bundle', allowedToolsFor('cashflow_income_horizon').size === 0);

  let fetchBody = null;
  const ev = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-17',
    policy,
    route: paycheck,
    fetchIncomeHorizonAnalysis: async (args) => {
      fetchBody = args.body;
      check('bounded timeout', args.timeoutMs > 0 && args.timeoutMs < 60000);
      return sampleHorizonResult();
    },
  });
  check('prefetch ok', ev.status === 'ok' && ev.source[0] === 'cashflow_income_horizon');
  check('clientDate only body', fetchBody && fetchBody.clientDate === '2026-08-17' && fetchBody.start == null);
  check('forces 1 Azure 0 tools', shouldForceDirectAnswer({
    route: paycheck,
    policy,
    evidence: ev,
  }) === true);

  const compact = azureFacingEvidence(ev);
  const compactJson = JSON.stringify(compact);
  check('compact has next income occurrence amount', compact.facts.nextIncome[0].amount === 4626.36);
  check('compact has window', compact.facts.window.start === '2026-08-18' && compact.facts.window.end === '2026-08-30');
  check('compact omits ids', !/groupid|transfer_id|transfer_pair_id|accountid/.test(compactJson));
  check('compact omits raw series', !/forecastedSeries|rawTransactions/.test(compactJson));

  const prompt = buildEvidenceSystemSection(ev);
  check('prompt forbids paycheck confirmation', /Do not call the income a confirmed paycheck/i.test(prompt));
  check('prompt forbids summing', /Do not sum expenses/i.test(prompt));
  check('prompt forbids same-day order', /Do not infer same-day order/i.test(prompt));
  check('prompt forbids safe spend', /Do not call a balance safe to spend/i.test(prompt));
  check('prompt uses scheduled terminology', /next scheduled recurring income/i.test(prompt));
  check('prompt size is compact', prompt.length < 12000);

  const telemetry = createKeaTelemetry({ requestId: 'ih-1' });
  telemetry.recordGrounding({
    conversation_intent: 'cashflow_income_horizon',
    effective_capability: 'cashflow_income_horizon',
    grounding_required: true,
    grounding_performed: true,
    grounding_strategy: 'cashflow_income_horizon_macro',
    financial_macro: 'income_horizon',
    macro_input_kind: 'income_horizon',
    income_horizon_performed: true,
    income_horizon_status: 'ok',
    income_horizon_ms: 18,
    income_horizon_definition: 'kea_scheduled_recurring_income',
    income_horizon_candidate_count_bucket: '1',
    income_horizon_horizon_days_bucket: '8-14',
    income_horizon_negative_before: false,
    income_horizon_expense_count_bucket: '1-3',
  });
  const payload = telemetry.toPayload();
  check('telemetry financial_macro income_horizon', payload.financial_macro === 'income_horizon');
  check('telemetry status ok', payload.income_horizon_status === 'ok');
  check('telemetry definition', payload.income_horizon_definition === 'kea_scheduled_recurring_income');
  check('telemetry no titles/amounts/dates', payload.income_title == null
    && payload.income_amount == null
    && payload.income_date == null
    && payload.groupid == null
    && payload.accountid == null);

  section('income-horizon fail-soft');
  const mixEv = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-17',
    policy: resolveGroundingPolicy(paydayMix, { message: 'Can I afford $300 before payday?' }),
    route: paydayMix,
    fetchIncomeHorizonAnalysis: async () => {
      throw new Error('should not fetch');
    },
  });
  check('payday affordability 0 HTTP', mixEv.status === 'unavailable'
    && mixEv.limitations.includes('payday_affordability_unsupported'));
  check('payday affordability fail-soft', isFailSoft(
    resolveGroundingPolicy(paydayMix, { message: 'Can I afford $300 before payday?' }),
    mixEv
  ) === true);
  check('payday affordability no Azure', shouldForceDirectAnswer({
    route: paydayMix,
    policy: resolveGroundingPolicy(paydayMix, { message: 'Can I afford $300 before payday?' }),
    evidence: mixEv,
  }) === false);
  check('payday affordability copy', /cannot combine a specific purchase amount with payday/i.test(failSoftTextFor(mixEv)));

  const safeEv = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-17',
    policy: resolveGroundingPolicy(safeSpend, { message: 'How much can I safely spend before payday?' }),
    route: safeSpend,
    fetchIncomeHorizonAnalysis: async () => {
      throw new Error('should not fetch');
    },
  });
  check('safe spend unsupported', safeEv.limitations.includes('safe_spend_unsupported'));
  check('safe spend copy has no surplus figure', !/\$/.test(failSoftTextFor(safeEv)));

  const noneEv = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-17',
    policy,
    route: paycheck,
    fetchIncomeHorizonAnalysis: async () => ({
      status: 'unavailable',
      source: [],
      nextIncome: [],
      limitations: ['no_scheduled_recurring_income'],
      dataAsOf: '2026-08-17',
    }),
  });
  check('no candidate unavailable', noneEv.status === 'unavailable'
    && noneEv.limitations.includes('no_scheduled_recurring_income'));
  check('no candidate 0 Azure', shouldForceDirectAnswer({
    route: paycheck,
    policy,
    evidence: noneEv,
  }) === false);
  check('no candidate copy', /qualifying future scheduled recurring income/i.test(failSoftTextFor(noneEv)));

  section('income-horizon continuation');
  const ds = T.emptyDialogueState();
  applyContinuationPersistenceFromEvidence(ds, paycheck, ev, { accountId: '10' });
  check('stores lastIncomeHorizon date', ds.lastIncomeHorizon && ds.lastIncomeHorizon.incomeDate === '2026-08-31');
  check('stores definition', ds.lastIncomeHorizon.definition === 'kea_scheduled_recurring_income');
  check('does not store item arrays', ds.lastIncomeHorizon.items == null && ds.lastIncomeHorizon.expenses == null);

  const expenses = route('What expenses are due before then?', { dialogueState: ds });
  check('expenses before then continues', expenses.capability === 'continuation'
    && expenses.parentCapability === 'cashflow_income_horizon'
    && expenses.continuationUsed === true
    && expenses.slots.incomeDate === '2026-08-31');
  const total = route('How much total?', { dialogueState: ds });
  check('how much total continues', total.capability === 'continuation'
    && total.parentCapability === 'cashflow_income_horizon'
    && total.slots.windowStart === '2026-08-18'
    && total.slots.windowEnd === '2026-08-30');
  const negative = route('Will I go negative?', { dialogueState: ds });
  check('will I go negative continues', negative.capability === 'continuation'
    && negative.parentCapability === 'cashflow_income_horizon');
  const after = route('What about after payday?', { dialogueState: ds });
  check('after payday unsupported', after.capability === 'continuation'
    && after.slots.incomeHorizonError === 'after_income_intraday_unsupported');

  const afterEv = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-17',
    policy: resolveGroundingPolicy(after, { message: 'What about after payday?' }),
    route: after,
    fetchIncomeHorizonAnalysis: async () => {
      throw new Error('should not fetch');
    },
  });
  check('after payday 0 HTTP', afterEv.limitations.includes('after_income_intraday_unsupported'));

  const freshRecurring = route('What recurring income do I have?', { dialogueState: ds });
  check('fresh recurring does not inherit horizon', freshRecurring.capability === 'cashflow_recurring');
  const freshUpcoming = route('What income is coming next week?', { dialogueState: ds });
  check('fresh upcoming does not inherit horizon', freshUpcoming.capability === 'cashflow_upcoming');
}

module.exports = { run };
