'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');
const {
  routeCapability,
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
const { frequencyLabel } = require('../utils/frequencyLabel');
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

function sampleRecurringResult() {
  return {
    status: 'ok',
    accountScope: 'selected_account',
    recurringDefinition: 'kea_scheduled_series',
    sourceKinds: ['kea_scheduled_series'],
    expenses: [
      {
        label: 'Netflix',
        category: 'Entertainment',
        frequency: 30,
        frequencyLabel: 'Monthly',
        amount: 15.99,
        monthlyEquivalent: 15.99,
        nextDate: '2026-09-01',
      },
      {
        label: 'Rent',
        category: 'Housing',
        frequency: 30,
        frequencyLabel: 'Monthly',
        amount: 1400,
        monthlyEquivalent: 1400,
        nextDate: '2026-09-01',
      },
    ],
    income: [
      {
        label: 'Paycheck',
        category: 'Income',
        frequency: 14,
        frequencyLabel: 'Bi-Weekly',
        amount: 2000,
        monthlyEquivalent: Number((2000 * 26 / 12).toFixed(2)),
        nextDate: '2026-08-21',
      },
    ],
    totals: {
      recurringExpenseMonthlyEquivalent: 1415.99,
      recurringIncomeMonthlyEquivalent: Number((2000 * 26 / 12).toFixed(2)),
      nextOccurrenceExpenseSum: 1415.99,
    },
    observations: [
      { code: 'largest_recurring_expense', label: 'Rent', monthlyEquivalent: 1400, frequencyLabel: 'Monthly' },
      { code: 'largest_recurring_income', label: 'Paycheck', monthlyEquivalent: Number((2000 * 26 / 12).toFixed(2)), frequencyLabel: 'Bi-Weekly' },
      { code: 'monthly_recurring_expense_total' },
      { code: 'monthly_recurring_income_total' },
      { code: 'next_recurring_expense', label: 'Netflix', nextDate: '2026-09-01', amount: 15.99 },
    ],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
    clientDate: '2026-08-16',
    streamCounts: { expense: 2, income: 1 },
  };
}

async function run() {
  section('Phase 2B.3 router');

  const expenses = route('What recurring expenses do I have?');
  check('recurring expenses → cashflow_recurring', expenses.capability === 'cashflow_recurring');
  check('recurring expenses metricScope expense', expenses.slots.metricScope === 'expense');

  const cost = route('How much do my recurring bills cost?');
  check('recurring bills cost → cashflow_recurring', cost.capability === 'cashflow_recurring');
  check('recurring bills metricScope expense', cost.slots.metricScope === 'expense');

  const income = route('What recurring income do I get?');
  check('recurring income → cashflow_recurring', income.capability === 'cashflow_recurring');
  check('recurring income metricScope income', income.slots.metricScope === 'income');

  const regular = route('What regular payments do I have?');
  check('regular payments → cashflow_recurring', regular.capability === 'cashflow_recurring');

  const subs = route('What subscriptions do I have?');
  check('subscriptions → recurring capability', subs.capability === 'cashflow_recurring');
  check('subscriptions unsupported', subs.slots.recurringError === 'recurring_definition_unsupported');

  const billsWeek = route('What bills are due next week?');
  check('bills due next week is not recurring', billsWeek.capability !== 'cashflow_recurring');

  const trend = route('How did spending change over last 3 months?');
  check('3-month change → trend', trend.capability === 'cashflow_trend');

  const cmp = route('Compare July and June');
  check('July vs June → comparison', cmp.capability === 'cashflow_comparison');

  const lookup = route('How much did I spend at Walmart last month?');
  check('Walmart last month → lookup', lookup.capability === 'financial_lookup');

  const share = route('How much of my spending is recurring?');
  check('share → recurring unsupported', share.capability === 'cashflow_recurring'
    && share.slots.recurringError === 'recurring_share_unsupported');

  const recTrend = route('Has my recurring spending increased?');
  check('recurring increased → not posted trend', recTrend.capability === 'cashflow_recurring');
  check('recurring increased unsupported', recTrend.slots.recurringError === 'recurring_trend_unsupported');

  const mixed = route('What are my recurring expenses and can I afford $500?');
  check('recurring + afford → mixed_macro', mixed.capability === 'mixed_macro');

  const mixedCmp = route('Show recurring expenses and compare July with June.');
  check('recurring + compare → mixed_macro', mixedCmp.capability === 'mixed_macro');

  section('Phase 2B.3 continuation');

  const ds = T.emptyDialogueState();
  ds.lastCapability = 'cashflow_recurring';
  ds.lastAccountId = '10';
  ds.lastRecurring = { metricScope: 'expense' };

  const largest = route('Which is the largest?', { dialogueState: ds, accountId: '10' });
  check('largest follow-up is recurring continuation', largest.capability === 'continuation'
    && largest.parentCapability === 'cashflow_recurring'
    && largest.continuationUsed === true);
  check('largest follow-up keeps expense scope', largest.slots.metricScope === 'expense');
  check('largest follow-up rankingMode', largest.slots.rankingMode === 'largest');

  const aboutIncome = route('What about income?', { dialogueState: ds, accountId: '10' });
  check('what about income is continuation', aboutIncome.capability === 'continuation'
    && aboutIncome.parentCapability === 'cashflow_recurring');
  check('income follow-up metricScope', aboutIncome.slots.metricScope === 'income');

  const changed = route('How has that changed?', { dialogueState: ds, accountId: '10' });
  check('how has that changed stays recurring', changed.capability === 'continuation'
    && changed.parentCapability === 'cashflow_recurring');
  check('change follow-up is trend unsupported', changed.slots.recurringError === 'recurring_trend_unsupported');

  const postedAfter = route('How has spending changed over the last 3 months?', {
    dialogueState: ds,
    accountId: '10',
  });
  check('explicit posted trend after recurring → trend', postedAfter.capability === 'cashflow_trend');

  applyContinuationPersistence(ds, expenses, { accountId: '10' });
  check('persists lastRecurring metricScope', ds.lastRecurring && ds.lastRecurring.metricScope === 'expense');
  check('fresh expense persist rankingMode null', ds.lastRecurring.rankingMode == null);

  const rankDs = T.emptyDialogueState();
  applyContinuationPersistence(rankDs, expenses, { accountId: '10' });
  const largestAfterList = route('Which is the largest?', { dialogueState: rankDs, accountId: '10' });
  applyContinuationPersistence(rankDs, largestAfterList, { accountId: '10' });
  check('persists rankingMode largest', rankDs.lastRecurring
    && rankDs.lastRecurring.metricScope === 'expense'
    && rankDs.lastRecurring.rankingMode === 'largest');
  const incomeAfterLargest = route('What about income?', { dialogueState: rankDs, accountId: '10' });
  check('largest then income keeps rankingMode', incomeAfterLargest.continuationUsed === true
    && incomeAfterLargest.slots.metricScope === 'income'
    && incomeAfterLargest.slots.rankingMode === 'largest');
  const changedAfterLargest = route('How has that changed?', { dialogueState: rankDs, accountId: '10' });
  check('trend follow-up clears rankingMode', changedAfterLargest.slots.rankingMode == null);
  const freshIncome = route('What recurring income do I have?', { dialogueState: rankDs, accountId: '10' });
  check('fresh income is not continuation', freshIncome.capability === 'cashflow_recurring'
    && !freshIncome.continuationUsed);
  check('fresh income rankingMode null', freshIncome.slots.metricScope === 'income'
    && freshIncome.slots.rankingMode == null);

  const allRecurring = route('What recurring income and expenses do I have?');
  check('unscoped recurring metricScope all', allRecurring.capability === 'cashflow_recurring'
    && allRecurring.slots.metricScope === 'all'
    && allRecurring.slots.rankingMode == null);

  const explicitLargest = route('Which recurring expense is largest?');
  check('explicit largest expense rankingMode', explicitLargest.capability === 'cashflow_recurring'
    && explicitLargest.slots.metricScope === 'expense'
    && explicitLargest.slots.rankingMode === 'largest');

  section('Phase 2B.3 grounding');

  const recPolicy = resolveGroundingPolicy(expenses, { message: 'What recurring expenses do I have?' });
  check('recurring grounding REQUIRED', recPolicy.groundingRequired === true
    && recPolicy.prefetchKind === 'cashflow_recurring_macro');
  check('recurring bundle has no tools', allowedToolsFor('cashflow_recurring').size === 0);

  const fetchCalls = [];
  const recEv = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-16',
    policy: recPolicy,
    route: expenses,
    fetchRecurringAnalysis: async (args) => {
      fetchCalls.push(args);
      return sampleRecurringResult();
    },
  });
  check('recurring evidence source', recEv.status === 'ok' && recEv.source[0] === 'cashflow_recurring');
  check('recurring definition in facts', recEv.facts.recurringDefinition === 'kea_scheduled_series');
  check('recurring HTTP used clientDate only', fetchCalls.length === 1
    && fetchCalls[0].body.clientDate === '2026-08-16'
    && fetchCalls[0].timeoutMs > 0);
  check('recurring force direct', shouldForceDirectAnswer({
    route: expenses,
    policy: recPolicy,
    evidence: recEv,
  }) === true);

  const compact = azureFacingEvidence(recEv);
  check('azure compact omits groupid', !JSON.stringify(compact).includes('groupid'));
  const expenseCodes = (compact.observations || []).map((row) => row && row.code);
  check('expense compact has expenses', Array.isArray(compact.facts.expenses) && compact.facts.expenses.length === 2);
  check('expense compact omits income list', compact.facts.income == null);
  check('expense compact keeps expense total', compact.facts.totals
    && compact.facts.totals.recurringExpenseMonthlyEquivalent === 1415.99);
  check('expense compact omits income total', !compact.facts.totals
    || compact.facts.totals.recurringIncomeMonthlyEquivalent == null);
  check('expense compact has largest expense', expenseCodes.includes('largest_recurring_expense'));
  check('expense compact omits largest income', !expenseCodes.includes('largest_recurring_income'));
  check('expense compact omits income total observation', !expenseCodes.includes('monthly_recurring_income_total'));
  check('expense compact omits paycheck label', !JSON.stringify(compact).includes('Paycheck'));

  const prompt = buildEvidenceSystemSection(recEv);
  check('prompt says scheduled in Keacast', /scheduled in (the user'?s )?Keacast forecast/i.test(prompt));
  check('prompt forbids bank-detected', /Do not say the bank detected/i.test(prompt));
  check('prompt forbids subscriptions inference', /Do not call these subscriptions/i.test(prompt));
  check('prompt forbids payday', /confirmed payday/i.test(prompt));
  check('prompt expense scope only', /If facts.metricScope is expense, narrate scheduled recurring expenses only/i.test(prompt));
  check('prompt omits paycheck when expense scoped', !/paycheck/i.test(prompt));

  async function prefetchRecurringRoute(routeObj, message) {
    return prefetchGrounding({
      accountId: '10',
      token: 't',
      currentDate: '2026-08-16',
      policy: resolveGroundingPolicy(routeObj, { message }),
      route: routeObj,
      fetchRecurringAnalysis: async () => sampleRecurringResult(),
    });
  }

  const incomeCompact = azureFacingEvidence(await prefetchRecurringRoute(income, 'What recurring income do I get?'));
  const incomeCodes = (incomeCompact.observations || []).map((row) => row && row.code);
  check('income compact has income', Array.isArray(incomeCompact.facts.income) && incomeCompact.facts.income.length === 1);
  check('income compact omits expenses list', incomeCompact.facts.expenses == null);
  check('income compact keeps income total', incomeCompact.facts.totals
    && incomeCompact.facts.totals.recurringIncomeMonthlyEquivalent != null);
  check('income compact omits expense total', !incomeCompact.facts.totals
    || incomeCompact.facts.totals.recurringExpenseMonthlyEquivalent == null);
  check('income compact omits nextOccurrenceExpenseSum', !incomeCompact.facts.totals
    || incomeCompact.facts.totals.nextOccurrenceExpenseSum == null);
  check('income compact has largest income', incomeCodes.includes('largest_recurring_income'));
  check('income compact omits largest expense', !incomeCodes.includes('largest_recurring_expense'));
  check('income compact omits next expense', !incomeCodes.includes('next_recurring_expense'));
  check('income compact omits rent label', !JSON.stringify(incomeCompact).includes('Rent'));

  const allCompact = azureFacingEvidence(await prefetchRecurringRoute(allRecurring, 'What recurring income and expenses do I have?'));
  const allCodes = (allCompact.observations || []).map((row) => row && row.code);
  check('all compact keeps both lists', Array.isArray(allCompact.facts.expenses)
    && allCompact.facts.expenses.length === 2
    && Array.isArray(allCompact.facts.income)
    && allCompact.facts.income.length === 1);
  check('all compact keeps both largest observations', allCodes.includes('largest_recurring_expense')
    && allCodes.includes('largest_recurring_income'));

  const largestCompact = azureFacingEvidence(await prefetchRecurringRoute(largestAfterList, 'Which is the largest?'));
  const largestCodes = (largestCompact.observations || []).map((row) => row && row.code);
  check('largest expense compact rankingMode', largestCompact.facts.rankingMode === 'largest');
  check('largest expense compact one stream', Array.isArray(largestCompact.facts.expenses)
    && largestCompact.facts.expenses.length === 1
    && largestCompact.facts.expenses[0].label === 'Rent');
  check('largest expense compact omits income', largestCompact.facts.income == null);
  check('largest expense compact omits income total', !largestCompact.facts.totals
    || largestCompact.facts.totals.recurringIncomeMonthlyEquivalent == null);
  check('largest expense observation only', largestCodes.includes('largest_recurring_expense')
    && !largestCodes.includes('largest_recurring_income')
    && !largestCodes.includes('monthly_recurring_income_total')
    && !largestCodes.includes('next_recurring_expense'));

  const incomeLargestCompact = azureFacingEvidence(
    await prefetchRecurringRoute(incomeAfterLargest, 'What about income?')
  );
  const incomeLargestCodes = (incomeLargestCompact.observations || []).map((row) => row && row.code);
  check('largest income compact rankingMode', incomeLargestCompact.facts.rankingMode === 'largest');
  check('largest income compact one stream', Array.isArray(incomeLargestCompact.facts.income)
    && incomeLargestCompact.facts.income.length === 1
    && incomeLargestCompact.facts.income[0].label === 'Paycheck');
  check('largest income compact omits expenses', incomeLargestCompact.facts.expenses == null);
  check('largest income observation only', incomeLargestCodes.includes('largest_recurring_income')
    && !incomeLargestCodes.includes('largest_recurring_expense')
    && !incomeLargestCodes.includes('monthly_recurring_expense_total'));

  const freshIncomeCompact = azureFacingEvidence(
    await prefetchRecurringRoute(freshIncome, 'What recurring income do I have?')
  );
  check('fresh income compact is list not largest-only', Array.isArray(freshIncomeCompact.facts.income)
    && freshIncomeCompact.facts.rankingMode !== 'largest'
    && freshIncomeCompact.facts.expenses == null
    && (freshIncomeCompact.observations || []).some((row) => row && row.code === 'monthly_recurring_income_total'));

  const subPolicy = resolveGroundingPolicy(subs, { message: 'What subscriptions do I have?' });
  const subEv = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-16',
    policy: subPolicy,
    route: subs,
    fetchRecurringAnalysis: async () => {
      throw new Error('should not call cashflow for subscriptions');
    },
  });
  check('subscriptions fail-soft unavailable', subEv.status === 'unavailable');
  check('subscriptions no cashflow call', isFailSoft(subPolicy, subEv) === true);
  check('subscriptions copy', /cannot reliably classify which of those are subscriptions/i.test(failSoftTextFor(subEv)));

  const sharePolicy = resolveGroundingPolicy(share, { message: 'How much of my spending is recurring?' });
  const shareEv = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-16',
    policy: sharePolicy,
    route: share,
    fetchRecurringAnalysis: async () => sampleRecurringResult(),
  });
  check('share does not compute ratio', shareEv.status === 'unavailable'
    && shareEv.limitations.includes('recurring_share_unsupported'));

  const recTrendPolicy = resolveGroundingPolicy(recTrend, { message: 'Has my recurring spending increased?' });
  const recTrendEv = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-16',
    policy: recTrendPolicy,
    route: recTrend,
    fetchTrendAnalysis: async () => {
      throw new Error('must not reuse posted trend');
    },
    fetchRecurringAnalysis: async () => sampleRecurringResult(),
  });
  check('recurring trend unsupported not posted trend', recTrendEv.status === 'unavailable'
    && recTrendEv.limitations.includes('recurring_trend_unsupported'));

  const timeoutEv = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-16',
    policy: recPolicy,
    route: expenses,
    fetchRecurringAnalysis: async () => {
      const err = new Error('timeout');
      err.code = 'ECONNABORTED';
      throw err;
    },
  });
  check('prefetch timeout unavailable', timeoutEv.status === 'unavailable');
  check('timeout fail-soft', isFailSoft(recPolicy, timeoutEv) === true);

  const named = route('When is Netflix due next?');
  check('when is Netflix due → recurring', named.capability === 'cashflow_recurring');
  const namedEv = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(named, { message: 'When is Netflix due next?' }),
    route: named,
    fetchRecurringAnalysis: async () => sampleRecurringResult(),
  });
  check('named Netflix match', namedEv.status === 'ok'
    && namedEv.facts.expenses.length === 1
    && namedEv.facts.expenses[0].label === 'Netflix');

  const unmatched = route('When is Peloton due next?');
  const unmatchedEv = await prefetchGrounding({
    accountId: '10',
    token: 't',
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(unmatched, { message: 'When is Peloton due next?' }),
    route: unmatched,
    fetchRecurringAnalysis: async () => sampleRecurringResult(),
  });
  check('unmatched named item fail-soft', unmatchedEv.status === 'unavailable'
    && unmatchedEv.limitations.includes('recurring_item_unmatched'));

  section('Phase 2B.3 frequency labels');
  check('frequency 59 bi-monthly', frequencyLabel(59) === 'bi-monthly');
  check('frequency 60 bi-monthly', frequencyLabel(60) === 'bi-monthly');
  check('frequency 61 bi-monthly', frequencyLabel(61) === 'bi-monthly');
  check('frequency 62 bi-monthly', frequencyLabel(62) === 'bi-monthly');

  section('Phase 2B.3 no Plaid in Agent client');
  const toolSrc = fs.readFileSync(path.join(__dirname, '../tools/keacast_tool_layer.js'), 'utf8');
  check('getKeaRecurringAnalysis exists', /async function getKeaRecurringAnalysis/.test(toolSrc));
  check('recurring client uses bounded timeout', /async function getKeaRecurringAnalysis[\s\S]{0,400}buildSelectedAccountAxiosConfig/.test(toolSrc));
  check('recurring client has no timeout 0', !/getKeaRecurringAnalysis[\s\S]{0,500}timeout:\s*0/.test(toolSrc));

  const telemetry = createKeaTelemetry({ requestId: 'r1' });
  telemetry.recordGrounding({
    financial_macro: 'recurring_analysis',
    recurring_performed: true,
    recurring_status: 'ok',
    recurring_ms: 12,
    recurring_source_kind: 'kea_scheduled_series',
    recurring_stream_count_bucket: '1-3',
  });
  const payload = telemetry.toPayload();
  check('telemetry financial_macro', payload.financial_macro === 'recurring_analysis');
  check('telemetry recurring_source_kind', payload.recurring_source_kind === 'kea_scheduled_series');
  check('telemetry no merchant', !JSON.stringify(payload).toLowerCase().includes('netflix'));
}

module.exports = { run };
