'use strict';

const { check, section } = require('./harness');
const {
  routeCapability,
  parseComparisonPeriods,
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
    pendingWrite: extra.pendingWrite === true,
    pendingGoalWrite: extra.pendingGoalWrite === true,
    pendingDraft: extra.pendingDraft || extra.dialogueState?.draftTransaction || null,
    pendingGoalDraft: extra.pendingGoalDraft || extra.dialogueState?.draftGoal || null,
    userAffirmative: extra.userAffirmative === true,
    dialogueState: extra.dialogueState || T.emptyDialogueState(),
    accountId: extra.accountId || '10',
  });
}

function sampleComparisonResult(body = {}) {
  return {
    status: 'ok',
    accountScope: 'selected_account',
    windowKind: body.windowKind || 'matched_elapsed',
    periodA: {
      label: 'July 1–16, 2026',
      start: (body.periodA && body.periodA.start) || '2026-07-01',
      end: (body.periodA && body.periodA.end) || '2026-07-16',
      income: 5000,
      spending: 4200,
      net: 800,
      transactionCount: 8,
    },
    periodB: {
      label: 'August 1–16, 2026',
      start: (body.periodB && body.periodB.start) || '2026-08-01',
      end: (body.periodB && body.periodB.end) || '2026-08-16',
      income: 5600,
      spending: 3780,
      net: 1820,
      transactionCount: 7,
    },
    changes: {
      income: { absolute: 600, percent: 12, baselineZero: false },
      spending: { absolute: -420, percent: -10, baselineZero: false },
      net: { absolute: 1020, percent: 127.5, baselineZero: false },
    },
    categoryChanges: {
      topIncreases: [{ category: 'Dining', periodA: 300, periodB: 480, absolute: 180, percent: 60, baselineZero: false }],
      topDecreases: [{ category: 'Retail', periodA: 400, periodB: 150, absolute: -250, percent: -62.5, baselineZero: false }],
    },
    observations: [
      { code: 'spending_decreased' },
      { code: 'income_increased' },
      { code: 'net_improved' },
    ],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
    clientDate: '2026-08-16',
  };
}

async function run() {
  section('Phase 2B.1 router');

  const thisVsLast = route('How does this month compare with last month?');
  check('this vs last → cashflow_comparison', thisVsLast.capability === 'cashflow_comparison');
  check('this vs last matched elapsed', thisVsLast.slots.windowKind === 'matched_elapsed');
  check('this vs last A is Jul 1-16', thisVsLast.slots.periodA.start === '2026-07-01' && thisVsLast.slots.periodA.end === '2026-07-16');
  check('this vs last B is Aug 1-16', thisVsLast.slots.periodB.start === '2026-08-01' && thisVsLast.slots.periodB.end === '2026-08-16');

  const spendingMore = route('Am I spending more than last month?');
  check('spending more than last month → comparison not lookup', spendingMore.capability === 'cashflow_comparison');

  const julyJune = route('Compare July and June');
  check('Compare July and June → comparison', julyJune.capability === 'cashflow_comparison');
  check('June is periodA even if July named first', julyJune.slots.periodA.start === '2026-06-01' && julyJune.slots.periodB.start === '2026-07-01');
  check('named months are full_months', julyJune.slots.windowKind === 'full_months');
  check('June end is 30', julyJune.slots.periodA.end === '2026-06-30');
  check('July end is 31', julyJune.slots.periodB.end === '2026-07-31');

  const incomeHigher = route('Was my income higher in July than June?');
  check('income higher July than June → comparison', incomeHigher.capability === 'cashflow_comparison');
  check('income higher still June baseline', incomeHigher.capability === 'cashflow_comparison'
    && incomeHigher.slots.periodA
    && incomeHigher.slots.periodA.start === '2026-06-01');

  check('How much did I spend in July? stays lookup', route('How much did I spend in July?').capability === 'financial_lookup');
  check('How much at Walmart in July stays lookup', route('How much did I spend at Walmart in July?').capability === 'financial_lookup');
  check('How was July? stays analysis', route('How was July?').capability === 'cashflow_analysis');
  check('How am I doing this month? stays analysis', route('How am I doing this month?').capability === 'cashflow_analysis');
  check('income versus expenses stays analysis', route('How much income do I have versus expenses?').capability === 'cashflow_analysis');
  check('Can I afford $500 next Friday? stays affordability', route('Can I afford $500 next Friday?').capability === 'affordability_or_planning');
  check('Add a $40 expense stays write', route('Add a $40 expense').capability === 'transaction_write');

  const yesPending = route('Yes', {
    pendingWrite: true,
    userAffirmative: true,
    dialogueState: { ...T.emptyDialogueState(), pendingConfirmation: true, draftTransaction: { title: 'Coffee', amount: -40 } },
  });
  check('Yes with pending proposal stays confirmation', yesPending.capability === 'confirmation');

  const mixed = route('Compare July and June and can I afford $500 Friday?');
  check('mixed comparison+affordability is mixed_macro', mixed.capability === 'mixed_macro');

  const forecastCmp = route('Compare my September forecast with August.');
  check('forecast comparison routes as comparison', forecastCmp.capability === 'cashflow_comparison');
  check('forecast comparison is unsupported', forecastCmp.slots.comparisonError === 'forecast_comparison_unsupported');
  check('will spend more next month unsupported', route('Will I spend more next month than this month?').slots.comparisonError === 'forecast_comparison_unsupported');

  section('Phase 2B.1 two-period parser');

  const parsedElapsed = parseComparisonPeriods('How does this month compare with last month?', '2026-08-16');
  check('parser matched elapsed', parsedElapsed.windowKind === 'matched_elapsed'
    && parsedElapsed.periodA.start === '2026-07-01'
    && parsedElapsed.periodB.end === '2026-08-16');

  const mar = parseComparisonPeriods('How does this month compare with last month?', '2026-03-31');
  check('parser Feb clamp', mar.periodA.start === '2026-02-01' && mar.periodA.end === '2026-02-28' && mar.periodB.end === '2026-03-31');

  const leap = parseComparisonPeriods('How does this month compare with last month?', '2028-03-31');
  check('parser leap Feb 29', leap.periodA.end === '2028-02-29');

  const yearBound = parseComparisonPeriods('Compare December with November', '2027-01-15');
  check('year boundary Nov/Dec 2026', yearBound.periodA.start === '2026-11-01' && yearBound.periodB.start === '2026-12-01');
  check('year boundary not 2027', yearBound.periodA.start.indexOf('2027') === -1 && yearBound.periodB.start.indexOf('2027') === -1);

  const explicit = parseComparisonPeriods('Compare August 1 through 10 with July 1 through 10.', '2026-08-16');
  check('explicit bounds windowKind', explicit.windowKind === 'explicit_bounds');
  check('explicit July 1-10 is A', explicit.periodA.start === '2026-07-01' && explicit.periodA.end === '2026-07-10');
  check('explicit August 1-10 is B', explicit.periodB.start === '2026-08-01' && explicit.periodB.end === '2026-08-10');

  const soFar = parseComparisonPeriods('Compare this month so far with last month so far.', '2026-08-16');
  check('so far is matched elapsed', soFar.windowKind === 'matched_elapsed');

  section('Phase 2B.1 grounding / prefetch');

  const cmpRoute = route('How does this month compare with last month?');
  const cmpPolicy = resolveGroundingPolicy(cmpRoute, { message: 'How does this month compare with last month?' });
  check('comparison grounding REQUIRED', cmpPolicy.groundingRequired === true && cmpPolicy.prefetchKind === 'cashflow_comparison_macro');

  let cmpCalls = 0;
  const cmpEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: cmpPolicy,
    route: cmpRoute,
    token: 'jwt',
    fetchPeriodComparison: async ({ body }) => {
      cmpCalls += 1;
      return sampleComparisonResult(body);
    },
    fetchCashflowAnalysis: async () => { throw new Error('must not run cashflow analysis'); },
    fetchAffordabilityAnalysis: async () => { throw new Error('must not run affordability'); },
  });
  check('comparison prefetch once', cmpCalls === 1);
  check('comparison evidence source', cmpEv.status === 'ok' && cmpEv.source[0] === 'cashflow_period_comparison');
  check('comparison accountScope', cmpEv.accountScope === 'selected_account');
  check('comparison facts have no raw transactions', cmpEv.facts.transactions === undefined);
  check('comparison forces one Azure round', shouldForceDirectAnswer({
    route: cmpRoute,
    policy: cmpPolicy,
    evidence: cmpEv,
  }) === true);
  check('comparison bundle has no tools', allowedToolsFor('cashflow_comparison').size === 0);
  check('continuation of comparison has no tools', allowedToolsFor('continuation', { parentCapability: 'cashflow_comparison' }).size === 0);

  const cmpBlock = buildEvidenceSystemSection(cmpEv);
  check('comparison prompt forbids own percentages', /Do not calculate your own percentages/.test(cmpBlock));
  check('comparison prompt forbids full-month mislabel', /not full months/.test(cmpBlock));
  check('comparison prompt forbids all accounts', /Do not say across your accounts/.test(cmpBlock));
  check('comparison prompt forbids subjective words', /Do not say healthy/.test(cmpBlock));
  check('comparison prompt null percent not 0%', /do not say 0%/.test(cmpBlock));
  check('comparison prompt forbids causal because/due to', /Do not say because, due to, driven by, or primarily because/.test(cmpBlock));
  check('comparison prompt forbids unsupported proportional cause', /Do not claim a larger proportional or percentage change caused the net result/.test(cmpBlock));
  check('comparison prompt forbids inventing which component drove net', /You may not invent which component drove the net change/.test(cmpBlock));
  check('comparison prompt suppresses net percent on crossedZero', /If changes\.net\.crossedZero is true[\s\S]*Do not narrate a net percentage/.test(cmpBlock));
  check('comparison uses compact macro identity when assembled', !/Always use the word "disposable"/.test(cmpBlock));
  check('comparison evidence has no transactions array', !/"transactions"\s*:/.test(cmpBlock));

  const crossedEv = {
    ...cmpEv,
    facts: {
      ...cmpEv.facts,
      periodA: { ...cmpEv.facts.periodA, net: 725.96 },
      periodB: { ...cmpEv.facts.periodB, net: -2979.63 },
      changes: {
        ...cmpEv.facts.changes,
        net: {
          absolute: -3705.59,
          percent: null,
          baselineZero: false,
          crossedZero: true,
          crossing: 'positive_to_negative',
        },
      },
    },
  };
  const crossedBlock = buildEvidenceSystemSection(crossedEv);
  check('crossedZero evidence reaches Azure JSON', /"crossedZero":true/.test(crossedBlock.replace(/\s+/g, '')));
  check('crossedZero evidence has null net percent', /"percent":null/.test(crossedBlock.replace(/\s+/g, '')));
  check('crossedZero prompt still forbids inventing a percentage', /do not say 0% or invent one/.test(crossedBlock));
  check('unsupported proportional claim is not an allowed instruction', !/larger proportional decrease in spending/.test(crossedBlock));

  const macroPrompt = T.buildMacroAnalysisPrompt({
    currentDate: '2026-08-16',
    firstName: 'Alex',
    account: { accountname: 'Main Account', institution_name: 'Bank' },
    evidence: cmpEv,
  });
  check('comparison prompt omits full write policy', !/VERIFY BEFORE CREATING/.test(macroPrompt.systemContent));
  check('comparison prompt omits planning playbook', !/FINANCIAL PLANNING PLAYBOOK/.test(macroPrompt.systemContent));
  check('comparison prompt omits product knowledge', !/PRODUCT KNOWLEDGE/.test(macroPrompt.systemContent));
  check('comparison prompt stays compact', macroPrompt.systemContent.length < 8000);

  const mixedEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(mixed, { message: 'Compare July and June and can I afford $500 Friday?' }),
    route: mixed,
    token: 'jwt',
    fetchPeriodComparison: async () => { throw new Error('must not run comparison'); },
    fetchAffordabilityAnalysis: async () => { throw new Error('must not run affordability'); },
  });
  check('mixed comparison+afford does not execute', mixedEv.status === 'unavailable');
  check('mixed limitation', (mixedEv.limitations || []).includes('mixed_macro_unsupported'));

  const forecastEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(forecastCmp, { message: 'Compare my September forecast with August.' }),
    route: forecastCmp,
    token: 'jwt',
    fetchPeriodComparison: async () => { throw new Error('must not force posted comparison'); },
  });
  check('forecast comparison fail-soft', forecastEv.status === 'unavailable');
  check('forecast limitation', (forecastEv.limitations || []).includes('forecast_comparison_unsupported'));
  check('forecast fail-soft text', /not forecasts/.test(failSoftTextFor(forecastEv)));
  check('failed comparison does not force Azure guess', shouldForceDirectAnswer({
    route: forecastCmp,
    policy: resolveGroundingPolicy(forecastCmp, { message: 'Compare my September forecast with August.' }),
    evidence: forecastEv,
  }) === false);
  check('failed comparison is fail-soft', isFailSoft(resolveGroundingPolicy(forecastCmp), forecastEv) === true);

  const deniedEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: cmpPolicy,
    route: cmpRoute,
    token: 'jwt',
    fetchPeriodComparison: async () => {
      const err = new Error('forbidden');
      err.response = { status: 403 };
      throw err;
    },
  });
  check('unauthorized comparison fail-soft', deniedEv.status === 'unavailable' && deniedEv.limitations.includes('access_unverified'));

  section('Phase 2B.1 continuation');

  const ds = T.emptyDialogueState();
  applyContinuationPersistence(ds, thisVsLast, { accountId: '10', failSoft: false });
  check('persists lastComparison windows', !!(ds.lastComparison && ds.lastComparison.periodA.start === '2026-07-01'));
  const follow = route('What about restaurants?', { dialogueState: ds, accountId: '10' });
  check('restaurants follow-up is comparison continuation', follow.capability === 'continuation' && follow.parentCapability === 'cashflow_comparison');
  check('follow-up inherits windows', follow.slots.periodA.start === '2026-07-01' && follow.slots.periodB.start === '2026-08-01');
  check('follow-up has restaurant subject', follow.slots.subjectKind === 'category');

  const compound = route('What about restaurants and groceries?', { dialogueState: ds, accountId: '10' });
  check('compound category continuation is unsupported', compound.slots.comparisonError === 'compound_comparison_unsupported');

  section('Phase 2B.1 telemetry and schemas');

  const tel = createKeaTelemetry({ requestId: 'cmp-tel' });
  tel.recordGrounding({
    financial_macro: 'compare_periods',
    macro_performed: true,
    macro_status: 'ok',
    comparison_performed: true,
    comparison_status: 'ok',
    comparison_ms: 9,
    period_relation: 'matched_elapsed',
  });
  const payload = tel.toPayload();
  check('financial_macro compare_periods', payload.financial_macro === 'compare_periods');
  check('comparison_performed', payload.comparison_performed === true);
  check('period_relation matched_elapsed', payload.period_relation === 'matched_elapsed');
  check('no category dollars in telemetry', payload.Dining === undefined && payload.spending === undefined);
  check('no evidence payload', payload.evidence === undefined && payload.facts === undefined);
  check('no account id in comparison telemetry', payload.accountId === undefined);

  const schemaNames = functionSchemas.map((s) => s.function && s.function.name);
  check('no comparePostedPeriods Azure tool', !schemaNames.includes('comparePostedPeriods'));
  check('no getKeaPeriodComparison Azure tool', !schemaNames.includes('getKeaPeriodComparison'));
}

module.exports = { run };
