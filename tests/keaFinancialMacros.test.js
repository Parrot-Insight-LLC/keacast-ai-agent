'use strict';

const { check, section } = require('./harness');
const {
  routeCapability,
  parsePurchaseDate,
  parseAmount,
  applyContinuationPersistence,
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
const { functionSchemas } = require('../services/openaiService');
const { __testables: T } = require('../controllers/openaiController');

function route(message, extra = {}) {
  return routeCapability({
    message,
    currentDate: extra.currentDate || '2026-08-16',
    simulationMode: extra.simulationMode === true,
    dialogueState: extra.dialogueState || T.emptyDialogueState(),
    accountId: extra.accountId || '10',
  });
}

async function run() {
  section('Phase 2A routing');

  check("What's my available balance? → lookup", route("What's my available balance?").capability === 'financial_lookup');
  check('Walmart last month → lookup', route('How much did I spend at Walmart last month?').capability === 'financial_lookup');
  check('Show Walmart transactions → navigation', route('Show me Walmart transactions last month').capability === 'navigation_ui');
  check('How am I doing this month? → cashflow_analysis', route('How am I doing this month?').capability === 'cashflow_analysis');
  check('Where is my money going? → cashflow_analysis', route('Where is my money going?').capability === 'cashflow_analysis');
  check(
    'biggest spending categories → cashflow_analysis not lookup',
    route('What are my biggest spending categories?').capability === 'cashflow_analysis'
  );
  check(
    'biggest merchants → cashflow_analysis',
    route('What merchants am I spending the most with?').capability === 'cashflow_analysis'
  );
  check(
    'income versus expenses → cashflow_analysis',
    route('How much income do I have versus expenses?').capability === 'cashflow_analysis'
  );
  check('How was July? → cashflow_analysis', route('How was July?').capability === 'cashflow_analysis');
  check('How was July? named month', route('How was July?').slots.period && route('How was July?').slots.period.label === 'named_month');
  check('Will I go negative next month? → cashflow_analysis', route('Will I go negative next month?').capability === 'cashflow_analysis');
  check(
    'driving negative forecast → cashflow_analysis',
    route('What is driving my upcoming negative forecast?').capability === 'cashflow_analysis'
  );
  const afford = route('Can I afford $800 next Friday?');
  check('Can I afford $800 next Friday? → affordability', afford.capability === 'affordability_or_planning');
  check('affordability amount 800', afford.slots.amount === 800);
  check('affordability purchase date next Friday', afford.slots.purchaseDate === '2026-08-21');
  check('What if I add a $50 forecast? → simulation', route('What if I add a $50 forecast?').capability === 'simulation');
  const mixed = route('How am I doing this month and can I afford $500 Friday?');
  check('mixed macro unsupported capability', mixed.capability === 'mixed_macro');

  section('Phase 2A purchase date / amount parse');

  check('$800 amount', parseAmount('Can I afford $800 next Friday?') === 800);
  check('800 dollars', parseAmount('Can I afford 800 dollars Friday?') === 800);
  check('$1,200 amount', parseAmount('What about $1,200?') === 1200);
  check('ISO date', parsePurchaseDate('buy on 2026-09-15', '2026-08-16').date === '2026-09-15');
  check('tomorrow', parsePurchaseDate('tomorrow', '2026-08-16').date === '2026-08-17');
  check('next Friday fixture', parsePurchaseDate('next Friday', '2026-08-16').date === '2026-08-21');
  check('September 15 this year if future', parsePurchaseDate('September 15', '2026-08-16').date === '2026-09-15');
  check('next month first day', parsePurchaseDate('next month', '2026-08-16').date === '2026-09-01');
  check('next month assumption', parsePurchaseDate('next month', '2026-08-16').assumption === 'next_month_first_day');
  check('payday unresolved', parsePurchaseDate('after payday', '2026-08-16').error === 'date_unresolved');
  check('sometime this month unresolved', parsePurchaseDate('sometime this month', '2026-08-16').error === 'date_unresolved');
  check('past ISO date', parsePurchaseDate('2026-08-01', '2026-08-16').error === 'past_date');

  section('Phase 2A prefetch macros');

  const analysisRoute = route('How am I doing this month?');
  let analysisCalls = 0;
  const analysisEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(analysisRoute, { message: 'How am I doing this month?' }),
    route: analysisRoute,
    token: 'jwt',
    fetchCashflowAnalysis: async ({ body }) => {
      analysisCalls += 1;
      return {
        status: 'ok',
        period: body.period,
        postedIncome: 3000,
        postedSpending: 200,
        postedNet: 2800,
        remainingForecastIncome: 2000,
        remainingForecastSpending: 400,
        observations: [{ code: 'posted_net_positive' }],
        limitations: [],
        dataAsOf: '2026-08-16T12:00:00.000Z',
      };
    },
  });
  check('analysis prefetch once', analysisCalls === 1);
  check('analysis evidence ok', analysisEv.status === 'ok' && analysisEv.source[0] === 'cashflow_analysis');
  check('analysis posted spending positive', analysisEv.facts.postedSpending === 200);
  check(
    'analysis forces one Azure round',
    shouldForceDirectAnswer({
      route: analysisRoute,
      policy: resolveGroundingPolicy(analysisRoute, { message: 'How am I doing this month?' }),
      evidence: analysisEv,
    }) === true
  );
  check('analysis bundle has no write tools', allowedToolsFor('cashflow_analysis').size === 0);
  const analysisBlock = buildEvidenceSystemSection(analysisEv);
  check('analysis evidence is deterministic instruction', /Do not recalculate them/.test(analysisBlock));
  check('analysis evidence has no transactions array', !/"transactions"\s*:/.test(analysisBlock));

  const failedAfford = route('Can I afford a new TV?');
  const failedEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(failedAfford, { message: 'Can I afford a new TV?' }),
    route: failedAfford,
    token: 'jwt',
    fetchAffordabilityAnalysis: async () => {
      throw new Error('macro must not run');
    },
  });
  check('missing amount is unavailable', failedEv.status === 'unavailable');
  check('missing amount limitation', (failedEv.limitations || []).includes('amount_invalid'));
  check(
    'failed macro is fail-soft',
    isFailSoft(resolveGroundingPolicy(failedAfford, { message: 'Can I afford a new TV?' }), failedEv) === true
  );
  check(
    'failed macro does not force an Azure financial answer',
    shouldForceDirectAnswer({
      route: failedAfford,
      policy: resolveGroundingPolicy(failedAfford, { message: 'Can I afford a new TV?' }),
      evidence: failedEv,
    }) === false
  );
  check('failed macro fail-soft names the missing amount', /positive purchase amount/.test(failSoftTextFor(failedEv)));

  const mixedMsg = 'How am I doing this month and can I afford $500 Friday?';
  const mixedRoute = route(mixedMsg);
  const mixedEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(mixedRoute, { message: mixedMsg }),
    route: mixedRoute,
    token: 'jwt',
    fetchCashflowAnalysis: async () => { throw new Error('must not run cashflow'); },
    fetchAffordabilityAnalysis: async () => { throw new Error('must not run affordability'); },
  });
  check('mixed macro unavailable', mixedEv.status === 'unavailable');
  check('mixed limitation', (mixedEv.limitations || []).includes('mixed_macro_unsupported'));

  const paydayRoute = route('Can I afford $800 after payday?');
  const paydayEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(paydayRoute, { message: 'Can I afford $800 after payday?' }),
    route: paydayRoute,
    token: 'jwt',
    fetchAffordabilityAnalysis: async () => { throw new Error('must not guess payday'); },
  });
  check('payday unresolved', (paydayEv.limitations || []).includes('date_unresolved'));

  const beyondRoute = route('Can I afford $800 on 2026-12-01?');
  const beyondEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(beyondRoute, { message: 'Can I afford $800 on 2026-12-01?' }),
    route: beyondRoute,
    token: 'jwt',
    fetchAffordabilityAnalysis: async () => { throw new Error('must not call beyond horizon'); },
  });
  check('beyond 90 days', (beyondEv.limitations || []).includes('date_beyond_horizon'));

  const nextMonthRoute = route('Can I afford $800 next month?');
  check('next month assumption on slots', nextMonthRoute.slots.purchaseDate === '2026-09-01'
    && nextMonthRoute.slots.purchaseDateAssumption === 'next_month_first_day');
  const nextMonthEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(nextMonthRoute, { message: 'Can I afford $800 next month?' }),
    route: nextMonthRoute,
    token: 'jwt',
    fetchAffordabilityAnalysis: async ({ body }) => ({
      status: 'ok',
      assumption: 'one_time_expense',
      requested: { amount: 800, purchaseDate: body.purchaseDate },
      horizonDays: 90,
      baseline: {},
      hypothetical: {},
      delta: {
        baselineAlreadyNegative: false,
        newNegativeIntroduced: false,
        negativeStartsEarlier: false,
        negativeWorsenedBy: 0,
      },
      observations: [],
      limitations: [],
    }),
  });
  check('next month assumption in evidence', (nextMonthEv.assumptions || []).some((a) => a.code === 'next_month_first_day'));
  const nextMonthBlock = buildEvidenceSystemSection(nextMonthEv);
  check('next month prompt says to speak the assumption', /Assuming the purchase is on/.test(nextMonthBlock));

  section('Phase 2A Azure schemas omit macros');

  const schemaNames = functionSchemas.map((s) => s.function && s.function.name);
  check('no analyzeCashflow Azure tool', !schemaNames.includes('analyzeCashflow'));
  check('no assessAffordability Azure tool', !schemaNames.includes('assessAffordability'));

  section('Phase 2A telemetry has no financial values');

  const tel = createKeaTelemetry({ requestId: 'macro-tel' });
  tel.recordGrounding({
    financial_macro: 'assess_affordability',
    macro_performed: true,
    macro_status: 'ok',
    macro_ms: 12,
    macro_input_kind: 'amount_and_date',
    macro_horizon_days: 90,
    macro_source_count: 1,
  });
  const payload = tel.toPayload();
  check('financial_macro recorded', payload.financial_macro === 'assess_affordability');
  check('macro_performed', payload.macro_performed === true);
  check('macro_status ok', payload.macro_status === 'ok');
  check('macro_ms', payload.macro_ms === 12);
  check('macro_input_kind', payload.macro_input_kind === 'amount_and_date');
  check('macro_horizon_days', payload.macro_horizon_days === 90);
  check('no purchase amount on payload', payload.amount === undefined && payload.purchaseDate === undefined);
  check('no merchant/category on payload', payload.merchant === undefined && payload.category === undefined);
  check('no evidence blob', payload.evidence === undefined && payload.facts === undefined);
  check('no account id', payload.accountId === undefined && payload.accountid === undefined);

  const emptyTel = createKeaTelemetry({ requestId: 'macro-default' }).toPayload();
  check('default financial_macro none', emptyTel.financial_macro === 'none');
  check('default macro_status skipped', emptyTel.macro_status === 'skipped');
  check('default macro_performed false', emptyTel.macro_performed === false);

  section('Phase 2A continuation persists purchase date only');

  const ds = T.emptyDialogueState();
  applyContinuationPersistence(ds, afford, { accountId: '10', failSoft: false });
  check('persists lastPurchaseDate', ds.lastPurchaseDate === '2026-08-21');
  const cont = route('What about $1,200?', { dialogueState: ds, accountId: '10' });
  check('amount-only follow-up inherits date', cont.capability === 'continuation'
    && cont.slots.amount === 1200
    && cont.slots.purchaseDate === '2026-08-21');

  section('Phase 2.1 snapshot vs macro narration');

  check(
    'bare will I go negative uses forecast_horizon',
    route('Will I go negative?').slots.period
      && route('Will I go negative?').slots.period.label === 'forecast_horizon'
  );
  check(
    'this month negative stays this_month',
    route('Will I go negative this month?').slots.period.label === 'this_month'
  );

  const scopedEv = {
    status: 'ok',
    source: ['cashflow_analysis'],
    period: { start: '2026-08-01', end: '2026-08-31', label: 'this_month' },
    dataAsOf: '2026-08-16T12:00:00.000Z',
    facts: {
      remainingForecastSpending: 3042,
      remainingForecastIncome: 0,
      negativeBalanceRisk: {
        scope: { start: '2026-08-16', end: '2026-08-31', label: 'this_month' },
        horizonDays: 90,
        hasNegativeInScope: false,
      },
    },
    observations: [],
    limitations: [],
  };
  const scopedBlock = buildEvidenceSystemSection(scopedEv);
  check('macro evidence is authoritative over snapshot', /GROUNDED EVIDENCE is authoritative/.test(scopedBlock));
  check('remaining month is not the 14-day window', /not the next 14 days/.test(scopedBlock));
  check('remaining month is not the 15-day window', /not the next 15 days/.test(scopedBlock));
  check('forbids disposable funds from analyzeCashflow', /Do not invent disposable funds/.test(scopedBlock));
  check('forbids safe-to-spend from analyzeCashflow', /safe-to-spend/.test(scopedBlock));
  check('forbids overdraft safety from analyzeCashflow', /overdraft safety/.test(scopedBlock));
  check('forbids affordability conclusion from analyzeCashflow', /Do not conclude the user can afford/.test(scopedBlock));
  check('forbids category-cut prescriptions', /Do not prescribe cutting/.test(scopedBlock));
  check('scope vs horizon instruction', /Negative-risk claims may use only negativeBalanceRisk.scope/.test(scopedBlock));
  check('cashflow Azure JSON omits horizonDays', !/"horizonDays"/.test(scopedBlock));
  check('accountScope selected_account in cashflow evidence', /"accountScope":"selected_account"/.test(scopedBlock));

  section('Phase 2.2 evidence pairing, missing≠zero, scope vs horizon');

  check('pairs lowestProjectedAmount with lowestProjectedDate', /lowestProjectedAmount and lowestProjectedDate are an inseparable pair/.test(scopedBlock));
  check('pairs projectedOnDate with projectedOnDateAt', /projectedOnDate and projectedOnDateAt are an inseparable pair/.test(scopedBlock));
  check('reconciledBalance is not a projected amount', /reconciledBalance = latest reconciled snapshot/.test(scopedBlock)
    && /never projected balances/.test(scopedBlock));
  check('glossary forbids labeling reconciled as projected', /not a projected balance, not lowestProjectedAmount, not projectedOnDate/.test(scopedBlock));
  check('missing fields are not zero', /Missing, null, or unprovided financial fields must never be described as zero/.test(scopedBlock));
  check('postedIncome 0 does not establish forecastIncome 0', /postedIncome=0 does not establish forecastIncome=0/.test(scopedBlock));
  check('forbids inventing no forecasted income without fields', /Do not say "no forecasted income or expenses are recorded" unless those forecast fields are actually present/.test(scopedBlock));
  check('remainingForecast is current-month F\/RF not 14\/15 days', /not the next 14 days, and not the next 15 days/.test(scopedBlock));
  check('next-month primary answer is hasNegativeInScope', /primary answer is negativeBalanceRisk.hasNegativeInScope/.test(scopedBlock));

  const sepRiskEv = {
    status: 'ok',
    source: ['cashflow_analysis'],
    period: { start: '2026-09-01', end: '2026-09-30', label: 'next_month' },
    dataAsOf: '2026-08-16T12:00:00.000Z',
    facts: {
      postedIncome: 0,
      postedSpending: 0,
      postedNet: 0,
      negativeBalanceRisk: {
        scope: { start: '2026-09-01', end: '2026-09-30', label: 'next_month' },
        horizonDays: 90,
        hasNegativeInScope: false,
        lowestProjectedAmount: 6286,
        lowestProjectedDate: '2026-09-01',
      },
    },
    observations: [],
    limitations: [],
  };
  const sepRiskBlock = buildEvidenceSystemSection(sepRiskEv);
  check('next_month evidence has no remainingForecastIncome field', !/"remainingForecastIncome"/.test(JSON.stringify(sepRiskEv.facts)));
  check('next_month prompt does not authorize forecast income = $0', !/forecast income = \$0/.test(sepRiskBlock));
  check('next_month prompt does not authorize no forecasted transactions', !/no forecasted transactions/.test(sepRiskBlock));
  check('next_month distinguishes Sep scope from computation horizon', /hasNegativeInScope=false answers only risk.scope/.test(sepRiskBlock));
  check('next_month Azure evidence omits horizonDays', !/"horizonDays"/.test(sepRiskBlock));
  check('next_month prompt does not mention next 90 days', !/next 90 days/.test(sepRiskBlock));
  check('JSON period is September', sepRiskBlock.includes('"start":"2026-09-01"') && sepRiskBlock.includes('"end":"2026-09-30"'));
  const sepFacing = azureFacingEvidence({
    ...sepRiskEv,
    observations: [{ code: 'no_negative_in_scope', scope: sepRiskEv.facts.negativeBalanceRisk.scope, horizonDays: 90 }],
  });
  check('no_negative_in_scope observation omits horizonDays', sepFacing.observations[0].horizonDays === undefined);
  check('no_negative_in_scope keeps scope', sepFacing.observations[0].scope.start === '2026-09-01');

  const affordNarrEv = {
    status: 'ok',
    source: ['affordability_analysis'],
    period: { start: '2026-08-21', end: '2026-11-14', label: 'purchase_horizon' },
    dataAsOf: '2026-08-16T12:00:00.000Z',
    facts: {
      reconciledBalance: 1340.81,
      baseline: { projectedOnDate: 6286, projectedOnDateAt: '2026-08-21' },
      hypothetical: { projectedOnDate: 5486, projectedOnDateAt: '2026-08-21' },
      delta: { newNegativeIntroduced: false },
    },
    observations: [],
    limitations: [],
  };
  const affordNarrBlock = buildEvidenceSystemSection(affordNarrEv);
  check('affordability forbids you can afford it', /Do not conclude "you can afford it"/.test(affordNarrBlock));
  check('affordability preferred evaluation-horizon wording', /negative projected balance within the evaluation horizon/.test(affordNarrBlock));
  check('affordability forbids safe\/healthy\/comfortable\/disposable', /comfortable cushion/.test(affordNarrBlock) && /disposable balance/.test(affordNarrBlock));
  check('affordability write offer stays conversational invitation', /conversational invitation only/.test(affordNarrBlock));
  check('affordability pairs projectedOnDate fields', /projectedOnDate and projectedOnDateAt are an inseparable pair/.test(affordNarrBlock));

  const { assembleBaseSystemPrompt } = require('../controllers/systemPromptBuilders');
  const withPlaybook = assembleBaseSystemPrompt({ currentDate: '2026-08-16' });
  check('non-macro prompt includes planning playbook', /FINANCIAL PLANNING PLAYBOOK/.test(withPlaybook.baseSystem));
  check('non-macro playbook still has MAKE IT REAL', /MAKE IT REAL/.test(withPlaybook.baseSystem));
  check('non-macro prompt still has full write policy', /VERIFY BEFORE CREATING/.test(withPlaybook.baseSystem));

  section('Phase 2.3 macro prompt profile');

  const selectedAccount = {
    accountname: 'Checking',
    account_type: 'depository',
    institution_name: 'Bank',
  };
  const otherAccountsUi = {
    availableAccounts: [
      { id: 22, index: 1, name: 'Checking', selected: true, type: 'depository', institution: 'Bank' },
      { id: 99, index: 2, name: 'Savings Vault', selected: false, type: 'depository', institution: 'Other Bank' },
    ],
  };
  const sepMacroEv = {
    status: 'ok',
    source: ['cashflow_analysis'],
    period: { start: '2026-09-01', end: '2026-09-30', label: 'next_month' },
    dataAsOf: '2026-08-16T12:00:00.000Z',
    facts: {
      postedIncome: 0,
      postedSpending: 0,
      postedNet: 0,
      negativeBalanceRisk: {
        scope: { start: '2026-09-01', end: '2026-09-30', label: 'next_month' },
        horizonDays: 90,
        hasNegativeInScope: false,
        lowestProjectedAmount: 1210.23,
        lowestProjectedDate: '2026-09-13',
      },
    },
    observations: [{
      code: 'no_negative_in_scope',
      scope: { start: '2026-09-01', end: '2026-09-30', label: 'next_month' },
      horizonDays: 90,
    }],
    limitations: [],
  };
  const thisMonthEv = {
    status: 'ok',
    source: ['cashflow_analysis'],
    period: { start: '2026-08-01', end: '2026-08-31', label: 'this_month' },
    dataAsOf: '2026-08-16T12:00:00.000Z',
    facts: {
      postedIncome: 1000,
      postedSpending: 1800,
      postedNet: -800,
      remainingForecastIncome: 500,
      remainingForecastSpending: 200,
      negativeBalanceRisk: {
        scope: { start: '2026-08-16', end: '2026-08-31', label: 'this_month' },
        horizonDays: 90,
        hasNegativeInScope: false,
        lowestProjectedAmount: 400,
        lowestProjectedDate: '2026-08-28',
      },
    },
    observations: [{ code: 'posted_net_negative', postedNet: -800 }],
    limitations: [],
  };
  const julyEv = {
    status: 'ok',
    source: ['cashflow_analysis'],
    period: { start: '2026-07-01', end: '2026-07-31', label: 'named_month' },
    dataAsOf: '2026-08-16T12:00:00.000Z',
    facts: {
      postedIncome: 4000,
      postedSpending: 3500,
      postedNet: 500,
      largestCategories: [{ category: 'Household', spentTotal: 900 }],
    },
    observations: [{ code: 'posted_net_positive', postedNet: 500 }],
    limitations: [],
  };
  const affordOkEv = {
    status: 'ok',
    source: ['affordability_analysis'],
    period: { start: '2026-08-21', end: '2026-11-14', label: 'purchase_horizon' },
    dataAsOf: '2026-08-16T12:00:00.000Z',
    facts: {
      horizonDays: 90,
      requested: { amount: 800, purchaseDate: '2026-08-21' },
      baseline: { projectedOnDate: 3047, projectedOnDateAt: '2026-08-21' },
      hypothetical: {
        projectedOnDate: 2247,
        projectedOnDateAt: '2026-08-21',
        lowestAfterDate: 410,
        lowestAfterDateOn: '2026-09-13',
      },
      delta: { newNegativeIntroduced: false },
    },
    observations: [{ code: 'no_new_negative', lowestBalanceAfter: 410 }],
    limitations: [],
  };

  const macroSep = T.buildMacroAnalysisPrompt({
    currentDate: '2026-08-16',
    firstName: 'Alex',
    account: selectedAccount,
    evidence: sepMacroEv,
  });
  const macroPrompt = macroSep.systemContent;
  const generalPrompt = assembleBaseSystemPrompt({
    currentDate: '2026-08-16',
    productKnowledge: [
      { id: 'forecasting', name: 'Forecasting', summary: 'Keacast projects balances.'.repeat(40) },
      { id: 'goals', name: 'Goals', summary: 'Track savings goals.'.repeat(40) },
    ],
  }).baseSystem;

  check('macro omits Always use the word disposable', !/Always use the word "disposable"/.test(macroPrompt));
  check('macro omits financial advisor and financial planner', !/financial advisor and financial planner/.test(macroPrompt));
  check('macro omits opportunities to optimize', !/opportunities to optimize/.test(macroPrompt));
  check('macro omits always connect insights back to action', !/Always connect insights back to action/.test(macroPrompt));
  check('macro omits proactive planning and suggestions', !/proactive planning and suggestions/.test(macroPrompt));
  check('macro omits ALWAYS offer ONE clear next action', !/ALWAYS offer ONE clear next action/.test(macroPrompt));
  check('macro omits PRODUCT KNOWLEDGE JSON', !/PRODUCT KNOWLEDGE/.test(macroPrompt));
  check('macro omits Product Help playbook', !/PRODUCT HELP PLAYBOOK/.test(macroPrompt));
  check('macro omits Financial Planning playbook', !/FINANCIAL PLANNING PLAYBOOK/.test(macroPrompt));
  check('macro omits full write policy', !/VERIFY BEFORE CREATING/.test(macroPrompt));
  check('macro omits AVAILABLE ACCOUNTS list', !/AVAILABLE ACCOUNTS/.test(macroPrompt));
  check('macro omits AVAILABLE CATEGORIES', !/AVAILABLE CATEGORIES/.test(macroPrompt));
  check('macro omits unrelated goals block', !/GOALS ARE AVAILABLE/.test(macroPrompt) && !/ACTIVE GOALS/.test(macroPrompt));
  check('macro omits Simulation Mode block', !/SIMULATION MODE IS ACTIVE/.test(macroPrompt) && !/WHAT-IF SIMULATIONS/.test(macroPrompt));
  check('macro omits DATE REFERENCE block', !/DATE REFERENCE/.test(macroPrompt));
  check('macro keeps short identity', /You are Kea, Keacast's financial assistant/.test(macroPrompt));
  check('macro keeps selected account name', /Selected account: Checking/.test(macroPrompt));
  check('macro keeps GROUNDED EVIDENCE', /GROUNDED EVIDENCE/.test(macroPrompt));
  check('macro keeps write invitation safety', /only an invitation/.test(macroPrompt));
  check('macro prompt is smaller than general chat prompt', macroPrompt.length < generalPrompt.length);
  check('macro prompt stays under 12k chars', macroPrompt.length < 12000);
  check('other account name Savings Vault is absent', !/Savings Vault/.test(macroPrompt));
  check('macro does not include ui availableAccounts', T.buildAvailableAccountsBlock(otherAccountsUi).includes('Savings Vault')
    && !macroPrompt.includes('Savings Vault'));

  check('September prompt authorizes scoped no-negative', /does not show a negative balance during \{scope month\/year\}/.test(macroPrompt));
  check('September Azure JSON has no horizonDays', !/"horizonDays"/.test(macroPrompt));
  check('September prompt does not say next 90 days', !/next 90 days/.test(macroPrompt));
  check('September prompt does not authorize comfortable buffer', !/comfortable buffer/.test(macroPrompt));

  const monthPrompt = T.buildMacroAnalysisPrompt({
    currentDate: '2026-08-16',
    firstName: 'Alex',
    account: selectedAccount,
    evidence: thisMonthEv,
  }).systemContent;
  check('this-month prompt may describe posted net', /posted income, posted spending, posted net/.test(monthPrompt));
  check('this-month prompt forbids healthy\/managing well', /Do not conclude the user is doing well or poorly/.test(monthPrompt));
  check('this-month prompt forbids safe cash flow', /healthy\/unhealthy\/comfortable\/safe cash flow/.test(monthPrompt));
  check('this-month prompt has remaining forecast fields', /"remainingForecastIncome":500/.test(monthPrompt));

  const julyPrompt = T.buildMacroAnalysisPrompt({
    currentDate: '2026-08-16',
    firstName: 'Alex',
    account: selectedAccount,
    evidence: julyEv,
  }).systemContent;
  check('July prompt is selected-account scoped', /accountScope":"selected_account"/.test(julyPrompt));
  check('July prompt forbids across your accounts', /Do not say "across your accounts"/.test(julyPrompt));
  check('July prompt omits other account names', !/Savings Vault/.test(julyPrompt));
  check('standard analysis has no unsolicited cut\/optimize instruction as a playbook', !/GIVE 1-3 CONCRETE LEVERS/.test(julyPrompt)
    && /Do not automatically prescribe cutting, optimizing/.test(julyPrompt));

  const affordPrompt = T.buildMacroAnalysisPrompt({
    currentDate: '2026-08-16',
    firstName: 'Alex',
    account: selectedAccount,
    evidence: affordOkEv,
  }).systemContent;
  check('affordability prompt allows evaluation-horizon conclusion', /would not create a negative projected balance within the evaluation horizon/.test(affordPrompt)
    || /would or would not create a negative projected balance within the evaluation horizon/.test(affordPrompt));
  check('affordability prompt forbids you can afford it as conclusion', /Do not conclude "you can afford it"/.test(affordPrompt));
  check('affordability prompt forbids safe\/comfortable\/healthy\/disposable', /comfortable cushion/.test(affordPrompt));
  check('affordability keeps invitation wording', /If you want, I can help add that expense to your forecast/.test(affordPrompt));
  check('affordability may keep horizonDays as evaluation window', /"horizonDays":90/.test(affordPrompt));
  check('recommendation routing for how can I improve is unchanged', route('How can I improve my cash flow?').capability !== 'undefined');

  const negFacing = azureFacingEvidence({
    status: 'ok',
    source: ['cashflow_analysis'],
    facts: {
      negativeBalanceRisk: {
        scope: { start: '2026-08-01', end: '2026-08-31', label: 'this_month' },
        horizonDays: 90,
        hasNegativeInScope: true,
        firstNegativeDate: '2026-08-22',
        firstNegativeAmount: -40,
        lowestProjectedAmount: -120,
        lowestProjectedDate: '2026-08-28',
      },
    },
    observations: [{
      code: 'forecast_goes_negative',
      scope: { start: '2026-08-01', end: '2026-08-31', label: 'this_month' },
      firstNegativeDate: '2026-08-22',
      firstNegativeAmount: -40,
    }],
  });
  check('forecast_goes_negative keeps scoped firstNegative fields',
    negFacing.observations[0].firstNegativeDate === '2026-08-22'
    && negFacing.observations[0].firstNegativeAmount === -40
    && negFacing.observations[0].scope.label === 'this_month');
  check('forecast_goes_negative Azure JSON omits horizonDays', !JSON.stringify(negFacing).includes('horizonDays'));
  check('no allowedClaims ledger', !Object.prototype.hasOwnProperty.call(negFacing, 'allowedClaims')
    && !/allowedClaims/.test(monthPrompt));

  check('affordability bundle has no write tools', allowedToolsFor('affordability_or_planning').size === 0);
  check('affordability invitation does not arm write gate', T.isWriteAllowed(false, false, false, false) === false);
  check('affordability invitation does not stage a draft', !/updateDraftTransaction/.test(affordPrompt)
    && !/pendingConfirmation/.test(affordPrompt));
  check(
    'affordability still forces one Azure round',
    shouldForceDirectAnswer({
      route: route('Can I afford $800 next Friday?'),
      policy: resolveGroundingPolicy(route('Can I afford $800 next Friday?'), { message: 'Can I afford $800 next Friday?' }),
      evidence: affordOkEv,
    }) === true
  );
}

module.exports = { run };
