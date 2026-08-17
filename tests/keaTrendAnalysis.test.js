'use strict';

const { check, section } = require('./harness');
const {
  routeCapability,
  parseTrendPeriods,
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
    pendingWrite: extra.pendingWrite === true,
    pendingGoalWrite: extra.pendingGoalWrite === true,
    pendingDraft: extra.pendingDraft || extra.dialogueState?.draftTransaction || null,
    pendingGoalDraft: extra.pendingGoalDraft || extra.dialogueState?.draftGoal || null,
    userAffirmative: extra.userAffirmative === true,
    dialogueState: extra.dialogueState || T.emptyDialogueState(),
    accountId: extra.accountId || '10',
  });
}

function sampleTrendResult(body = {}) {
  const periods = body.periods || [
    { start: '2026-06-01', end: '2026-06-16' },
    { start: '2026-07-01', end: '2026-07-16' },
    { start: '2026-08-01', end: '2026-08-16' },
  ];
  return {
    status: 'ok',
    accountScope: 'selected_account',
    windowKind: body.windowKind || 'matched_elapsed',
    metricScope: body.metricScope || 'spending',
    periods: [
      { label: 'June 1–16, 2026', start: periods[0].start, end: periods[0].end, income: 5000, spending: 100, net: 4900, transactionCount: 2 },
      { label: 'July 1–16, 2026', start: periods[1].start, end: periods[1].end, income: 5000, spending: 120, net: 4880, transactionCount: 2 },
      { label: 'August 1–16, 2026', start: periods[2].start, end: periods[2].end, income: 5000, spending: 140, net: 4860, transactionCount: 2 },
    ],
    trend: {
      income: { direction: 'unchanged', firstToLast: { absolute: 0, percent: 0, baselineZero: false } },
      spending: { direction: 'increasing', firstToLast: { absolute: 40, percent: 40, baselineZero: false } },
      net: { direction: 'decreasing', firstToLast: { absolute: -40, percent: -0.82, baselineZero: false, crossedZero: false } },
    },
    highest: { metric: 'spending', label: 'August 1–16, 2026', start: '2026-08-01', end: '2026-08-16', value: 140 },
    lowest: { metric: 'spending', label: 'June 1–16, 2026', start: '2026-06-01', end: '2026-06-16', value: 100 },
    observations: [{ code: 'spending_increasing' }, { code: 'most_recent_high', metric: 'spending', label: 'August 1–16, 2026' }],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
    clientDate: '2026-08-16',
  };
}

async function run() {
  section('Phase 2B.2 router');

  const lately = route('Am I spending more lately?');
  check('lately → cashflow_trend', lately.capability === 'cashflow_trend');
  check('lately matched elapsed', lately.slots.windowKind === 'matched_elapsed');
  check('lately Jun 1-16', lately.slots.periods[0].start === '2026-06-01' && lately.slots.periods[0].end === '2026-06-16');
  check('lately Aug 1-16', lately.slots.periods[2].start === '2026-08-01' && lately.slots.periods[2].end === '2026-08-16');
  check('lately metricScope spending', lately.slots.metricScope === 'spending');

  const last3 = route('How has my spending changed over the last three months?');
  check('last three months → trend', last3.capability === 'cashflow_trend');
  check('last three months matched elapsed', last3.slots.windowKind === 'matched_elapsed');

  const cashflowTrend = route("What's my cash flow trend?");
  check('cash flow trend → trend not analysis', cashflowTrend.capability === 'cashflow_trend');
  check('cash flow trend metricScope net', cashflowTrend.slots.metricScope === 'net');

  const incomeDown = route('Has my income been declining?');
  check('income declining → trend', incomeDown.capability === 'cashflow_trend');
  check('income declining metricScope income', incomeDown.slots.metricScope === 'income');

  const named = route('How did spending trend from May through July?');
  check('May through July → trend', named.capability === 'cashflow_trend');
  check('May through July full months', named.slots.windowKind === 'full_months');
  check('May start', named.slots.periods[0].start === '2026-05-01');
  check('July end', named.slots.periods[2].end === '2026-07-31');

  const juneAug = route('How did June, July, and August compare?');
  check('three named months → trend not two-period comparison', juneAug.capability === 'cashflow_trend');
  check('June-August on Aug 16 is matched elapsed', juneAug.slots.windowKind === 'matched_elapsed');
  check('June 1-16', juneAug.slots.periods[0].end === '2026-06-16');

  const last6 = route('How has my spending changed over the last 6 months?');
  check('last 6 months still routes trend', last6.capability === 'cashflow_trend');
  check('last 6 months unsupported count', last6.slots.trendError === 'trend_period_count_unsupported');

  check('this vs last stays comparison', route('How does this month compare with last month?').capability === 'cashflow_comparison');
  check('more than last month stays comparison', route('Am I spending more than last month?').capability === 'cashflow_comparison');
  check('July spend stays lookup', route('How much did I spend in July?').capability === 'financial_lookup');
  check('How was July stays analysis', route('How was July?').capability === 'cashflow_analysis');
  check('How am I doing stays analysis', route('How am I doing this month?').capability === 'cashflow_analysis');
  check('afford stays affordability', route('Can I afford $800?').capability === 'affordability_or_planning');

  const mixed = route('Show my 3-month trend and tell me if I can afford $500 Friday.');
  check('trend+afford is mixed_macro', mixed.capability === 'mixed_macro');

  const mixedCmp = route('Compare July and June and show the 3-month trend.');
  check('comparison+trend is mixed_macro', mixedCmp.capability === 'mixed_macro');

  const parsed = parseTrendPeriods('Am I spending more lately?', '2026-08-16');
  check('parser lately windows', parsed.periods[0].start === '2026-06-01' && parsed.periods[2].end === '2026-08-16');
  const yearRoll = parseTrendPeriods('How has spending changed over the last 3 months?', '2027-01-16');
  check('parser year rollover Nov 2026', yearRoll.periods[0].start === '2026-11-01' && yearRoll.periods[2].start === '2027-01-01');

  section('Phase 2B.2 grounding');

  const trendRoute = route('Am I spending more lately?');
  const trendPolicy = resolveGroundingPolicy(trendRoute, { message: 'Am I spending more lately?' });
  check('trend grounding REQUIRED', trendPolicy.groundingRequired === true && trendPolicy.prefetchKind === 'cashflow_trend_macro');
  check('trend bundle has no tools', allowedToolsFor('cashflow_trend').size === 0);

  let trendCalls = 0;
  const trendEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: trendPolicy,
    route: trendRoute,
    token: 'jwt',
    fetchTrendAnalysis: async ({ body }) => {
      trendCalls += 1;
      return sampleTrendResult(body);
    },
    fetchPeriodComparison: async () => { throw new Error('must not run comparison'); },
    fetchCashflowAnalysis: async () => { throw new Error('must not run analysis'); },
  });
  check('trend prefetch once', trendCalls === 1);
  check('trend evidence source', trendEv.status === 'ok' && trendEv.source[0] === 'cashflow_trend');
  check('trend facts have periods not periodA', Array.isArray(trendEv.facts.periods) && trendEv.facts.periodA === undefined);
  check('spending prefetch metricScope spending', trendEv.facts.metricScope === 'spending');

  const netStampEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(cashflowTrend, { message: "What's my cash flow trend?" }),
    route: cashflowTrend,
    token: 'jwt',
    fetchTrendAnalysis: async () => sampleTrendResult({ metricScope: 'spending' }),
  });
  check('cash flow prefetch stamps net metricScope', netStampEv.facts.metricScope === 'net');
  check('trend forces one Azure round', shouldForceDirectAnswer({
    route: trendRoute,
    policy: trendPolicy,
    evidence: trendEv,
  }) === true);

  const trendBlock = buildEvidenceSystemSection(trendEv);
  check('trend prompt forbids own direction', /Do not calculate your own percentages, deltas, slopes, or trend direction/.test(trendBlock));
  check('trend prompt forbids periodA speech', /Never say periodA/.test(trendBlock));
  check('trend prompt forbids extrapolation', /Do not forecast that the trend will continue/.test(trendBlock));
  check('trend prompt forbids mixed-as-increasing', /Do not call a mixed series increasing/.test(trendBlock));
  check('trend prompt uses supplied labels', /Use the supplied periods\[\]\.label/.test(trendBlock));
  check('spending trend prompt leads with spending', /facts\.metricScope=spending[\s\S]*trend\.spending\.direction/.test(trendBlock));
  check('spending trend prompt does not lead with net', /Do not lead with net or income/.test(trendBlock));
  check('trend prompt mixed is not improved', /Do not say the trend improved when direction is mixed/.test(trendBlock));
  check('trend prompt exact labels not early August', /Do not say early August, first half, or mid-August/.test(trendBlock));
  check('trend prompt category spending-only', /Category trend is spending-only/.test(trendBlock));
  check('trend prompt no restaurant income claim', /Do not claim there was no income related to the category/.test(trendBlock));
  check('trend prompt prefers natural direction wording', /Do not say "trending decreasing"/.test(trendBlock));

  const mixedFacing = azureFacingEvidence({
    status: 'ok',
    source: ['cashflow_trend'],
    facts: {
      metricScope: 'net',
      periods: [
        { label: 'June 1–17, 2026', start: '2026-06-01', end: '2026-06-17', income: 7357.85, spending: 10829.73, net: -3471.88, transactionCount: 3 },
        { label: 'July 1–17, 2026', start: '2026-07-01', end: '2026-07-17', income: 4798, spending: 10464.98, net: -5666.98, transactionCount: 3 },
        { label: 'August 1–17, 2026', start: '2026-08-01', end: '2026-08-17', income: 8231.12, spending: 7924.36, net: 306.76, transactionCount: 3 },
      ],
      trend: {
        income: { direction: 'mixed', firstToLast: { absolute: 873.27, percent: 11.87, baselineZero: false } },
        spending: { direction: 'decreasing', firstToLast: { absolute: -2905.37, percent: -26.83, baselineZero: false } },
        net: { direction: 'mixed', firstToLast: { absolute: 3778.64, percent: null, baselineZero: false, crossedZero: true, crossing: 'negative_to_positive' } },
      },
    },
    observations: [{ code: 'net_mixed' }],
  });
  check('mixed net direction preserved in compact', mixedFacing.facts.trend.net.direction === 'mixed');
  check('mixed firstToLast remains separate', mixedFacing.facts.trend.net.firstToLast.absolute === 3778.64);
  check('net compact puts net trend first', Object.keys(mixedFacing.facts.trend)[0] === 'net');
  const netBlock = buildEvidenceSystemSection({
    status: 'ok',
    source: ['cashflow_trend'],
    facts: mixedFacing.facts,
    observations: [{ code: 'net_mixed' }],
  });
  check('cash flow trend prompt leads with net', /facts\.metricScope=net[\s\S]*trend\.net\.direction/.test(netBlock));
  check('cash flow trend prompt net is focused', /For a cash flow trend, net is the focused metric/.test(netBlock));
  check('cash flow trend prompt spending is supporting', /Income and spending are supporting context only/.test(netBlock));
  check('mixed remains mixed in net prompt', /Do not say the trend improved when direction is mixed/.test(netBlock));
  check('net prompt keeps exact period labels', /Do not say early August, first half, or mid-August/.test(netBlock));

  const incomeFacing = azureFacingEvidence({
    status: 'ok',
    source: ['cashflow_trend'],
    facts: {
      metricScope: 'income',
      periods: mixedFacing.facts.periods,
      trend: mixedFacing.facts.trend,
    },
  });
  check('income compact puts income trend first', Object.keys(incomeFacing.facts.trend)[0] === 'income');
  const incomeBlock = buildEvidenceSystemSection({
    status: 'ok',
    source: ['cashflow_trend'],
    facts: { metricScope: 'income', periods: mixedFacing.facts.periods, trend: mixedFacing.facts.trend },
  });
  check('income trend prompt leads with income', /facts\.metricScope=income[\s\S]*trend\.income\.direction/.test(incomeBlock));
  check('income trend prompt does not lead with spending', /Do not lead with spending or net/.test(incomeBlock));

  const catFacing = azureFacingEvidence({
    status: 'ok',
    source: ['cashflow_trend'],
    facts: {
      metricScope: 'category',
      categoryFilter: 'restaurants',
      periods: [
        { label: 'June 1–16, 2026', start: '2026-06-01', end: '2026-06-16', income: 0, spending: 40, net: -40, transactionCount: 2 },
        { label: 'July 1–16, 2026', start: '2026-07-01', end: '2026-07-16', income: 0, spending: 30, net: -30, transactionCount: 2 },
        { label: 'August 1–16, 2026', start: '2026-08-01', end: '2026-08-16', income: 0, spending: 20, net: -20, transactionCount: 2 },
      ],
      trend: {
        income: { direction: 'unchanged', firstToLast: { absolute: 0, percent: 0, baselineZero: true } },
        spending: { direction: 'decreasing', firstToLast: { absolute: -20, percent: -50, baselineZero: false } },
        net: { direction: 'increasing', firstToLast: { absolute: 20, percent: 50, baselineZero: false } },
      },
    },
    observations: [{ code: 'category_decreasing', category: 'restaurants' }],
  });
  check('category compact omits income zeros', catFacing.facts.periods.every((p) => p.income === undefined && p.net === undefined));
  check('category compact keeps spending', catFacing.facts.periods[0].spending === 40);
  check('category compact omits trend.income', catFacing.facts.trend.income === undefined);
  check('category compact puts spending trend first', Object.keys(catFacing.facts.trend)[0] === 'spending');
  const catBlock = buildEvidenceSystemSection({
    status: 'ok',
    source: ['cashflow_trend'],
    facts: {
      metricScope: 'category',
      categoryFilter: 'restaurants',
      periods: [
        { label: 'June 1–16, 2026', start: '2026-06-01', end: '2026-06-16', income: 0, spending: 40, net: -40, transactionCount: 2 },
        { label: 'July 1–16, 2026', start: '2026-07-01', end: '2026-07-16', income: 0, spending: 30, net: -30, transactionCount: 2 },
        { label: 'August 1–16, 2026', start: '2026-08-01', end: '2026-08-16', income: 0, spending: 20, net: -20, transactionCount: 2 },
      ],
      trend: {
        income: { direction: 'unchanged' },
        spending: { direction: 'decreasing' },
        net: { direction: 'increasing' },
      },
    },
  });
  check('category trend prompt leads with category spending', /facts\.metricScope=category[\s\S]*trend\.spending\.direction for the category/.test(catBlock));
  check('category trend prompt does not lead with net', /Do not lead with net or income/.test(catBlock));
  check('restaurant category still routes category', route('Is restaurant spending trending up?').slots.metricScope === 'category');

  const macroPrompt = T.buildMacroAnalysisPrompt({
    currentDate: '2026-08-16',
    firstName: 'Alex',
    account: { accountname: 'Main Account', institution_name: 'Bank' },
    evidence: trendEv,
  });
  check('trend prompt omits write policy', !/VERIFY BEFORE CREATING/.test(macroPrompt.systemContent));
  check('trend prompt stays compact', macroPrompt.systemContent.length < 8000);

  const last6Ev = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(last6, { message: 'How has my spending changed over the last 6 months?' }),
    route: last6,
    token: 'jwt',
    fetchTrendAnalysis: async () => { throw new Error('must not run trend'); },
  });
  check('last 6 fail-soft', last6Ev.status === 'unavailable');
  check('last 6 limitation', (last6Ev.limitations || []).includes('trend_period_count_unsupported'));
  check('last 6 fail-soft text', /3-month trend/.test(failSoftTextFor(last6Ev)));
  check('failed trend does not force Azure', shouldForceDirectAnswer({
    route: last6,
    policy: resolveGroundingPolicy(last6),
    evidence: last6Ev,
  }) === false);
  check('failed trend is fail-soft', isFailSoft(resolveGroundingPolicy(last6), last6Ev) === true);

  section('Phase 2B.2 continuation');

  const ds = T.emptyDialogueState();
  applyContinuationPersistence(ds, lately, { accountId: '10', failSoft: false });
  check('persists lastTrend windows', !!(ds.lastTrend && ds.lastTrend.periods[0].start === '2026-06-01'));
  const follow = route('What about restaurants?', { dialogueState: ds, accountId: '10' });
  check('restaurants follow-up is trend continuation', follow.capability === 'continuation' && follow.parentCapability === 'cashflow_trend');
  check('follow-up inherits trend windows', follow.slots.periods[2].end === '2026-08-16');
  check('follow-up category subject', follow.slots.subjectKind === 'category');

  const cmpDs = T.emptyDialogueState();
  applyContinuationPersistence(cmpDs, route('How does this month compare with last month?'), { accountId: '10', failSoft: false });
  const afterCmp = route('What about the last three months?', { dialogueState: cmpDs, accountId: '10' });
  check('last three months after comparison is fresh trend', afterCmp.capability === 'cashflow_trend');

  const afterTrend = route('Compare just July and June.', { dialogueState: ds, accountId: '10' });
  check('explicit two months after trend is comparison', afterTrend.capability === 'cashflow_comparison');

  section('Phase 2B.2 telemetry');

  const tel = createKeaTelemetry({ requestId: 'trend-tel' });
  tel.recordGrounding({
    financial_macro: 'trend_periods',
    macro_performed: true,
    macro_status: 'ok',
    trend_performed: true,
    trend_status: 'ok',
    trend_ms: 12,
    trend_period_count: 3,
    trend_window_kind: 'matched_elapsed',
  });
  const payload = tel.toPayload();
  check('financial_macro trend_periods', payload.financial_macro === 'trend_periods');
  check('trend_performed', payload.trend_performed === true);
  check('trend_period_count 3', payload.trend_period_count === 3);
  check('no dollars in trend telemetry', payload.spending === undefined && payload.evidence === undefined);
  check('no account id in trend telemetry', payload.accountId === undefined);

  const schemaNames = functionSchemas.map((s) => s.function && s.function.name);
  check('no analyzePostedTrend Azure tool', !schemaNames.includes('analyzePostedTrend'));
  check('no getKeaTrendAnalysis Azure tool', !schemaNames.includes('getKeaTrendAnalysis'));
}

module.exports = { run };
