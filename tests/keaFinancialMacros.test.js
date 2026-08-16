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
}

module.exports = { run };
