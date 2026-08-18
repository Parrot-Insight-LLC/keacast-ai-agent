'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');
const {
  routeCapability,
  applyContinuationPersistence,
  applyContinuationPersistenceFromEvidence,
} = require('../services/keaCapabilityRouter');
const {
  resolveUpcomingPeriod,
  rangesFromClientDate,
  shiftCalendarWeek,
} = require('../services/keaUpcomingPeriod');
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

function sampleUpcomingResult(partial = {}) {
  return {
    status: 'ok',
    source: ['cashflow_upcoming'],
    accountScope: 'selected_account',
    period: {
      start: '2026-08-23',
      end: '2026-08-29',
      label: 'next_week',
      relation: 'next_week',
    },
    metricScope: 'expense',
    items: [
      {
        label: 'Daycare',
        date: '2026-08-24',
        amount: 705,
        frequencyLabel: 'Weekly',
      },
    ],
    totals: {
      scheduledExpenseTotal: 705,
    },
    observations: [
      { code: 'upcoming_expense_count', count: 1 },
    ],
    limitations: [],
    dataAsOf: '2026-08-17',
    itemCount: 1,
    ...partial,
  };
}

function periodEq(actual, start, end, relation) {
  return actual
    && actual.start === start
    && actual.end === end
    && (actual.relation === relation || actual.label === relation);
}

async function run() {
  section('upcoming period parser — 2026-08-17');
  const clientDate = '2026-08-17';
  check('today', periodEq(resolveUpcomingPeriod('today', clientDate), '2026-08-17', '2026-08-17', 'today'));
  check('tomorrow', periodEq(resolveUpcomingPeriod('payments due tomorrow', clientDate), '2026-08-18', '2026-08-18', 'tomorrow'));
  check('this week', periodEq(resolveUpcomingPeriod('this week', clientDate), '2026-08-16', '2026-08-22', 'this_week'));
  check('next week', periodEq(resolveUpcomingPeriod('bills due next week', clientDate), '2026-08-23', '2026-08-29', 'next_week'));
  check('next 7 days', periodEq(resolveUpcomingPeriod('coming in the next 7 days', clientDate), '2026-08-18', '2026-08-24', 'next_7_days'));
  check('this month', periodEq(resolveUpcomingPeriod('this month', clientDate), '2026-08-01', '2026-08-31', 'this_month'));
  check('next month', periodEq(resolveUpcomingPeriod('next month', clientDate), '2026-09-01', '2026-09-30', 'next_month'));

  section('next week != next 7 days');
  const nextWeek = resolveUpcomingPeriod('next week', clientDate);
  const next7 = resolveUpcomingPeriod('next 7 days', clientDate);
  check('different start', nextWeek.start !== next7.start);
  check('different end', nextWeek.end !== next7.end);
  check('next week is calendar week', nextWeek.relation === 'next_week');
  check('next 7 is rolling', next7.relation === 'next_7_days');

  section('Sunday boundary');
  const sunday = '2026-08-23';
  check('Sunday this week', periodEq(resolveUpcomingPeriod('this week', sunday), '2026-08-23', '2026-08-29', 'this_week'));
  check('Sunday next week', periodEq(resolveUpcomingPeriod('next week', sunday), '2026-08-30', '2026-09-05', 'next_week'));

  section('year and leap boundaries');
  const dec = rangesFromClientDate('2026-12-28');
  check('late December next week crosses January', dec.next_week.start === '2027-01-03' && dec.next_week.end === '2027-01-09');
  check('December next month is January next year', dec.next_month.start === '2027-01-01' && dec.next_month.end === '2027-01-31');
  const jan = rangesFromClientDate('2026-01-15');
  check('January last month is prior December', jan.last_month.start === '2025-12-01' && jan.last_month.end === '2025-12-31');
  const feb = rangesFromClientDate('2028-02-10');
  check('Feb 2028 this month is leap', feb.this_month.start === '2028-02-01' && feb.this_month.end === '2028-02-29');
  check('named month deferred', resolveUpcomingPeriod('what expenses are coming in January?', clientDate) == null);
  check('by Friday deferred', resolveUpcomingPeriod('bills by Friday', clientDate) == null);

  section('upcoming router');
  const bills = route('What bills are due next week?');
  check('bills due next week → cashflow_upcoming', bills.capability === 'cashflow_upcoming');
  check('bills metricScope expense', bills.slots.metricScope === 'expense');
  check('bills period next_week', periodEq(bills.slots.period, '2026-08-23', '2026-08-29', 'next_week'));

  check('expenses coming next week', route('What expenses are coming next week?').capability === 'cashflow_upcoming');
  const next7q = route("What's coming in the next 7 days?");
  check('next 7 days → upcoming', next7q.capability === 'cashflow_upcoming');
  check('next 7 days metricScope all', next7q.slots.metricScope === 'all');
  check('next 7 days relation', periodEq(next7q.slots.period, '2026-08-18', '2026-08-24', 'next_7_days'));

  const income = route('What income is coming next week?');
  check('income coming → upcoming income', income.capability === 'cashflow_upcoming' && income.slots.metricScope === 'income');
  check('paycheck coming → income', route('What paycheck is coming next week?').slots.metricScope === 'income');
  check('payments due → expense', route('What payments are due tomorrow?').slots.metricScope === 'expense');
  check('transactions coming → all', route('What transactions are coming this week?').slots.metricScope === 'all');

  check('recurring expenses stay recurring', route('What recurring expenses do I have?').capability === 'cashflow_recurring');
  check('can I afford bills next week → affordability', route('Can I afford my bills next week?').capability === 'affordability_or_planning');
  check('will I have enough → affordability', route('Will I have enough for my bills next week?').capability === 'affordability_or_planning');
  const balanceAfter = route("What will my balance be after next week's bills?");
  check('balance after bills is not upcoming', balanceAfter.capability !== 'cashflow_upcoming');
  check('balance after bills is forecast/analysis', balanceAfter.capability === 'financial_forecast' || balanceAfter.capability === 'cashflow_analysis');
  check('spending changed → trend', route('How has spending changed?').capability === 'cashflow_trend');
  check('compare July and June', route('Compare July and June').capability === 'cashflow_comparison');

  section('upcoming continuation');
  const ds = T.emptyDialogueState();
  applyContinuationPersistence(ds, bills, { accountId: '10' });
  check('persists lastUpcoming period', ds.lastUpcoming
    && ds.lastUpcoming.period
    && ds.lastUpcoming.period.relation === 'next_week'
    && ds.lastUpcoming.metricScope === 'expense');

  const total = route('How much total?', { dialogueState: ds });
  check('how much total continues upcoming', total.capability === 'continuation'
    && total.parentCapability === 'cashflow_upcoming'
    && periodEq(total.slots.period, '2026-08-23', '2026-08-29', 'next_week')
    && total.slots.metricScope === 'expense');

  const aboutIncome = route('What about income?', { dialogueState: ds });
  check('what about income same period income scope', aboutIncome.capability === 'continuation'
    && aboutIncome.parentCapability === 'cashflow_upcoming'
    && periodEq(aboutIncome.slots.period, '2026-08-23', '2026-08-29', 'next_week')
    && aboutIncome.slots.metricScope === 'income');

  const weekAfter = route('What about the week after?', { dialogueState: ds });
  const shifted = shiftCalendarWeek({ start: '2026-08-23', end: '2026-08-29', relation: 'next_week' });
  check('week after is +7', weekAfter.capability === 'continuation'
    && periodEq(weekAfter.slots.period, shifted.start, shifted.end, 'week_after'));

  check('fresh recurring clears upcoming inheritance', route('What recurring expenses do I have?', { dialogueState: ds }).capability === 'cashflow_recurring');
  check('fresh comparison clears upcoming inheritance', route('Compare July and June', { dialogueState: ds }).capability === 'cashflow_comparison');

  section('upcoming grounding');
  const policy = resolveGroundingPolicy(bills, { message: 'What bills are due next week?' });
  check('upcoming grounding REQUIRED', policy.groundingRequired === true
    && policy.prefetchKind === 'cashflow_upcoming_macro');
  check('upcoming bundle has no tools', allowedToolsFor('cashflow_upcoming').size === 0);

  const fetchCalls = [];
  const ev = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-17',
    policy,
    route: bills,
    fetchUpcomingAnalysis: async (args) => {
      fetchCalls.push(args);
      return sampleUpcomingResult();
    },
  });
  check('upcoming evidence source', ev.status === 'ok' && ev.source[0] === 'cashflow_upcoming');
  check('upcoming HTTP uses resolved bounds', fetchCalls.length === 1
    && fetchCalls[0].body.clientDate === '2026-08-17'
    && fetchCalls[0].body.start === '2026-08-23'
    && fetchCalls[0].body.end === '2026-08-29'
    && fetchCalls[0].body.metricScope === 'expense'
    && fetchCalls[0].timeoutMs > 0);
  check('upcoming force direct', shouldForceDirectAnswer({
    route: bills,
    policy,
    evidence: ev,
  }) === true);

  const compact = azureFacingEvidence(ev);
  const compactJson = JSON.stringify(compact);
  check('compact has items and total', compact.facts.items.length === 1
    && compact.facts.totals.scheduledExpenseTotal === 705);
  check('compact omits balances', !/availableBalance|reconciledBalance|currentBalance|futureNegativeBalances|savingsPotential/.test(compactJson));
  check('compact omits ids', !/transactionid|groupid|match_id|accountid/.test(compactJson));

  const prompt = buildEvidenceSystemSection(ev);
  check('prompt forbids summing', /Do not sum items/i.test(prompt));
  check('prompt forbids sufficiency', /Do not calculate sufficiency/i.test(prompt));
  check('prompt forbids balance comparison', /Do not compare totals to available balance/i.test(prompt));
  check('prompt prefers scheduled expenses', /scheduled expenses/i.test(prompt));
  check('prompt forbids all of your bills', /all of your bills/i.test(prompt));
  check('prompt omits warn-the-user', !/warn the user/i.test(prompt));

  const telemetry = createKeaTelemetry({ requestId: 'up-1' });
  telemetry.recordGrounding({
    conversation_intent: 'cashflow_upcoming',
    effective_capability: 'cashflow_upcoming',
    grounding_required: true,
    grounding_performed: true,
    grounding_strategy: 'cashflow_upcoming_macro',
    financial_macro: 'upcoming_period',
    macro_input_kind: 'upcoming_period',
    upcoming_performed: true,
    upcoming_status: 'ok',
    upcoming_ms: 20,
    upcoming_period_relation: 'next_week',
    upcoming_metric_scope: 'expense',
    upcoming_item_count_bucket: '1-3',
  });
  const payload = telemetry.toPayload();
  check('telemetry financial_macro upcoming_period', payload.financial_macro === 'upcoming_period');
  check('telemetry upcoming_status ok', payload.upcoming_status === 'ok');
  check('telemetry relation next_week', payload.upcoming_period_relation === 'next_week');
  check('telemetry metric expense', payload.upcoming_metric_scope === 'expense');
  check('telemetry no titles', payload.upcoming_titles == null);

  section('upcoming fail-soft');
  const timeoutEv = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-17',
    policy,
    route: bills,
    fetchUpcomingAnalysis: async () => {
      const err = new Error('timeout of 8000ms exceeded');
      err.code = 'ECONNABORTED';
      throw err;
    },
  });
  check('timeout unavailable', timeoutEv.status === 'unavailable');
  check('timeout is fail-soft', isFailSoft(policy, timeoutEv) === true);
  check('timeout does not force Azure', shouldForceDirectAnswer({
    route: bills,
    policy,
    evidence: timeoutEv,
  }) === false);
  check('timeout fail-soft text', typeof failSoftTextFor(timeoutEv) === 'string' && failSoftTextFor(timeoutEv).length > 0);

  const unresolved = route('What bills are due?');
  check('unresolved period still upcoming capability', unresolved.capability === 'cashflow_upcoming'
    && unresolved.slots.upcomingError === 'upcoming_period_unresolved');
  const unresolvedEv = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-17',
    policy: resolveGroundingPolicy(unresolved, { message: 'What bills are due?' }),
    route: unresolved,
    fetchUpcomingAnalysis: async () => {
      throw new Error('should not fetch');
    },
  });
  check('unresolved does not call cashflow', unresolvedEv.status === 'unavailable'
    && unresolvedEv.limitations.includes('upcoming_period_unresolved'));

  section('upcoming freeze hardening — apostrophe and shorthand');
  const asciiNext7 = route("What's coming in the next 7 days?");
  check('ASCII What\'s coming next 7 days → upcoming all next_7_days', asciiNext7.capability === 'cashflow_upcoming'
    && asciiNext7.slots.metricScope === 'all'
    && periodEq(asciiNext7.slots.period, '2026-08-18', '2026-08-24', 'next_7_days'));

  const curlyNext7Text = 'What\u2019s coming in the next 7 days?';
  check('curly fixture is U+2019 not ASCII apostrophe', curlyNext7Text.includes('\u2019') && !curlyNext7Text.includes('\u0027'));
  const curlyNext7 = route(curlyNext7Text);
  check('U+2019 What\u2019s coming next 7 days → identical to ASCII', curlyNext7.capability === 'cashflow_upcoming'
    && curlyNext7.slots.metricScope === 'all'
    && periodEq(curlyNext7.slots.period, '2026-08-18', '2026-08-24', 'next_7_days'));

  const whatIsNext7 = route('What is coming in the next 7 days?');
  check('What is coming next 7 days → upcoming all next_7_days', whatIsNext7.capability === 'cashflow_upcoming'
    && whatIsNext7.slots.metricScope === 'all'
    && periodEq(whatIsNext7.slots.period, '2026-08-18', '2026-08-24', 'next_7_days'));

  const whatsNext7 = route('Whats coming in the next 7 days?');
  check('Whats coming next 7 days → upcoming all next_7_days', whatsNext7.capability === 'cashflow_upcoming'
    && whatsNext7.slots.metricScope === 'all'
    && periodEq(whatsNext7.slots.period, '2026-08-18', '2026-08-24', 'next_7_days'));

  const curlyNextWeekText = 'What\u2019s coming next week?';
  check('curly next-week fixture is U+2019', curlyNextWeekText.includes('\u2019'));
  const curlyNextWeek = route(curlyNextWeekText);
  check('U+2019 What\u2019s coming next week → all next_week Aug 23-29', curlyNextWeek.capability === 'cashflow_upcoming'
    && curlyNextWeek.slots.metricScope === 'all'
    && periodEq(curlyNextWeek.slots.period, '2026-08-23', '2026-08-29', 'next_week'));

  check('ASCII What\'s coming? is not upcoming', route("What's coming?").capability !== 'cashflow_upcoming');
  check('U+2019 What\u2019s coming? is not upcoming', route('What\u2019s coming?').capability !== 'cashflow_upcoming');
  check('What is coming? is not upcoming', route('What is coming?').capability !== 'cashflow_upcoming');
  check('What\'s coming next in Keacast? is not upcoming', route("What's coming next in Keacast?").capability !== 'cashflow_upcoming');
  check('What features are coming next? is not upcoming', route('What features are coming next?').capability !== 'cashflow_upcoming');

  check('transactions coming next 7 days → all', route('What transactions are coming in the next 7 days?').capability === 'cashflow_upcoming'
    && route('What transactions are coming in the next 7 days?').slots.metricScope === 'all');
  check('expenses coming next 7 days → expense', route('What expenses are coming in the next 7 days?').capability === 'cashflow_upcoming'
    && route('What expenses are coming in the next 7 days?').slots.metricScope === 'expense');
  check('income coming next 7 days → income', route('What income is coming in the next 7 days?').capability === 'cashflow_upcoming'
    && route('What income is coming in the next 7 days?').slots.metricScope === 'income');
  check('bills due tomorrow still upcoming', route('What bills are due tomorrow?').capability === 'cashflow_upcoming'
    && route('What bills are due tomorrow?').slots.metricScope === 'expense');

  const curlyNext14 = route('What\u2019s coming in the next 14 days?');
  check('U+2019 next 14 days → all next_n_days Aug 18-31', curlyNext14.capability === 'cashflow_upcoming'
    && curlyNext14.slots.metricScope === 'all'
    && periodEq(curlyNext14.slots.period, '2026-08-18', '2026-08-31', 'next_n_days'));
  check('next 30 days relation next_n_days', route("What's coming in the next 30 days?").capability === 'cashflow_upcoming'
    && route("What's coming in the next 30 days?").slots.period.relation === 'next_n_days');
  check('next 90 days relation next_n_days', route("What's coming in the next 90 days?").capability === 'cashflow_upcoming'
    && route("What's coming in the next 90 days?").slots.period.relation === 'next_n_days');
  check('next 91 days shorthand fail-soft', route("What's coming in the next 91 days?").capability === 'cashflow_upcoming'
    && route("What's coming in the next 91 days?").slots.upcomingError === 'upcoming_horizon_unsupported');
  check('next days shorthand is not upcoming', route("What's coming in the next days?").capability !== 'cashflow_upcoming');

  check('afford ASCII what\'s coming next week', route("Can I afford what's coming next week?").capability === 'affordability_or_planning');
  check('afford U+2019 what\u2019s coming next week', route('Can I afford what\u2019s coming next week?').capability === 'affordability_or_planning');
  check('recurring expenses coming stays recurring', route('What recurring expenses are coming?').capability === 'cashflow_recurring');
  check('spending changed stays trend', route('How has spending changed?').capability === 'cashflow_trend');
  check('compare July and June stays comparison', route('Compare July and June').capability === 'cashflow_comparison');

  section('upcoming freeze hardening — continuation relation stamp');
  const cashflowDatesOnly = {
    start: '2026-08-23',
    end: '2026-08-29',
    label: null,
    relation: null,
  };
  const stampedEv = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-17',
    policy,
    route: bills,
    fetchUpcomingAnalysis: async () => sampleUpcomingResult({
      period: cashflowDatesOnly,
      totals: { scheduledExpenseTotal: 1297.3 },
    }),
  });
  check('stamp keeps cashflow dates', stampedEv.period.start === '2026-08-23' && stampedEv.period.end === '2026-08-29');
  check('stamp copies next_week onto evidence.period', stampedEv.period.relation === 'next_week'
    && stampedEv.period.label === 'next_week');
  check('stamp copies next_week onto facts.period', stampedEv.facts.period.relation === 'next_week'
    && stampedEv.facts.period.label === 'next_week');

  const persistDs = T.emptyDialogueState();
  applyContinuationPersistence(persistDs, bills, { accountId: '10' });
  applyContinuationPersistenceFromEvidence(persistDs, bills, stampedEv, { accountId: '10' });
  check('lastUpcoming keeps next_week after cashflow-null relation', persistDs.lastUpcoming
    && persistDs.lastUpcoming.period.relation === 'next_week'
    && persistDs.lastUpcoming.period.start === '2026-08-23'
    && persistDs.lastUpcoming.period.end === '2026-08-29');

  const howMuch = route('How much total?', { dialogueState: persistDs });
  check('How much total keeps next_week dates and relation', howMuch.capability === 'continuation'
    && howMuch.parentCapability === 'cashflow_upcoming'
    && periodEq(howMuch.slots.period, '2026-08-23', '2026-08-29', 'next_week')
    && howMuch.slots.metricScope === 'expense');
  const howMuchEv = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-17',
    policy: resolveGroundingPolicy(howMuch, { message: 'How much total?' }),
    route: howMuch,
    fetchUpcomingAnalysis: async () => sampleUpcomingResult({
      period: cashflowDatesOnly,
      totals: { scheduledExpenseTotal: 1297.3 },
    }),
  });
  check('How much total evidence relation next_week', howMuchEv.period.relation === 'next_week'
    && howMuchEv.facts.period.relation === 'next_week');
  applyContinuationPersistenceFromEvidence(persistDs, howMuch, howMuchEv, { accountId: '10' });

  const aboutIncome2 = route('What about income?', { dialogueState: persistDs });
  check('What about income keeps next_week and income scope', aboutIncome2.capability === 'continuation'
    && aboutIncome2.parentCapability === 'cashflow_upcoming'
    && periodEq(aboutIncome2.slots.period, '2026-08-23', '2026-08-29', 'next_week')
    && aboutIncome2.slots.metricScope === 'income');
  const aboutIncomeEv = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-17',
    policy: resolveGroundingPolicy(aboutIncome2, { message: 'What about income?' }),
    route: aboutIncome2,
    fetchUpcomingAnalysis: async () => sampleUpcomingResult({
      period: cashflowDatesOnly,
      metricScope: 'income',
      items: [],
      totals: { scheduledIncomeTotal: 0 },
      observations: [{ code: 'no_upcoming_in_period' }],
      itemCount: 0,
    }),
  });
  check('What about income evidence relation next_week', aboutIncomeEv.period.relation === 'next_week'
    && aboutIncomeEv.facts.period.relation === 'next_week'
    && aboutIncomeEv.facts.metricScope === 'income');

  const compactStamped = azureFacingEvidence(stampedEv);
  check('compact period relation next_week', compactStamped.period.relation === 'next_week');

  check('prompt does not call next_week this week', /Do not call next_week "this week"/i.test(prompt));
  check('prompt uses supplied period.relation', /period\.relation/i.test(prompt));
  check('prompt next_7_days wording', /the next 7 days/i.test(prompt));
  check('prompt two decimal places', /two decimal places/i.test(prompt) && /\$1297\.30/.test(prompt));
  check('prompt empty income is scheduled Keacast forecast', /scheduled income in the Keacast forecast/i.test(prompt));
  check('prompt empty income forbids no incoming funds', /Do not say no incoming funds/i.test(prompt));

  section('DATE REFERENCE defense-in-depth');
  const dateRef = T.buildDateReferenceBlock('2026-08-17');
  check('date ref has next week range', /next week: 2026-08-23 to 2026-08-29/.test(dateRef));
  check('date ref has next 7 days range', /next 7 days: 2026-08-18 to 2026-08-24/.test(dateRef));
  check('date ref keeps never do calendar math', /never do calendar math yourself/.test(dateRef));

  section('upcoming HTTP client reliability');
  const toolSrc = fs.readFileSync(path.join(__dirname, '../tools/keacast_tool_layer.js'), 'utf8');
  check('getKeaUpcomingAnalysis exists', /async function getKeaUpcomingAnalysis/.test(toolSrc));
  check('upcoming client uses bounded timeout', /async function getKeaUpcomingAnalysis[\s\S]{0,400}buildSelectedAccountAxiosConfig/.test(toolSrc));
  check('upcoming client has no timeout 0', !/getKeaUpcomingAnalysis[\s\S]{0,500}timeout:\s*0/.test(toolSrc));
}

module.exports = { run };
