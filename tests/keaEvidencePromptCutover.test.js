'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');
const {
  toPromptEvidence,
  collectObservationCodeHits,
  OBSERVATION_CODES,
} = require('../services/keaEvidencePromptView');
const { buildEvidenceLedger } = require('../services/keaEvidenceLedgerBuilders');
const {
  LEDGER_PROMPT_ENV_KEY,
  APPROVED_MACRO_CAPABILITIES,
  isLedgerPromptEnabled,
  isEvidenceRollbackActive,
  parseLedgerPromptFlag,
  isApprovedMacroCapability,
  shouldUseLedgerPrompt,
  projectApprovedMacroEvidence,
} = require('../services/keaEvidencePromptCutover');
const { routeCapability } = require('../services/keaCapabilityRouter');
const { resolveGroundingPolicy, isFailSoft, failSoftTextFor } = require('../services/keaGroundingPolicy');
const {
  prefetchGrounding,
  buildEvidenceSystemSection,
  azureFacingEvidence,
} = require('../services/keaGroundingPrefetch');
const { allowedToolsFor } = require('../services/keaToolBundles');
const { __testables: T } = require('../controllers/openaiController');

function route(message, extra = {}) {
  return routeCapability({
    message,
    currentDate: extra.currentDate || '2026-08-17',
    accountId: extra.accountId || '10',
    dialogueState: extra.dialogueState || T.emptyDialogueState(),
  });
}

function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, LEDGER_PROMPT_ENV_KEY);
  const prev = process.env[LEDGER_PROMPT_ENV_KEY];
  if (value === undefined) delete process.env[LEDGER_PROMPT_ENV_KEY];
  else process.env[LEDGER_PROMPT_ENV_KEY] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[LEDGER_PROMPT_ENV_KEY] = prev;
    else delete process.env[LEDGER_PROMPT_ENV_KEY];
  }
}

function observationHitsInText(text) {
  const src = String(text || '');
  return OBSERVATION_CODES.filter((code) => src.indexOf(code) !== -1);
}

function bannedHitsInText(text) {
  const src = String(text || '');
  const hits = [];
  if (/accountId/.test(src)) hits.push('accountId');
  if (/transactionid/i.test(src)) hits.push('transactionid');
  if (/groupid/i.test(src)) hits.push('groupid');
  if (/\bjwt\b/i.test(src)) hits.push('jwt');
  if (/userId/.test(src)) hits.push('userId');
  if (/prefetchMeta/.test(src)) hits.push('prefetchMeta');
  if (/"builder"/.test(src)) hits.push('builder');
  return hits;
}

function assemble(evidence, extra = {}) {
  return T.buildMacroAnalysisPrompt({
    currentDate: extra.currentDate || '2026-08-16',
    firstName: 'Alex',
    account: extra.account || { accountname: 'Checking', institution_name: 'Bank' },
    evidence,
    capability: extra.capability,
    responseMode: extra.responseMode,
    route: extra.route,
    accountContext: extra.accountContext || { accountId: '10', accountLabel: 'Checking' },
  });
}

async function prefetch(message, fetchers, extra = {}) {
  const routed = extra.route || route(message, extra);
  return prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    token: 'jwt',
    currentDate: extra.currentDate || '2026-08-17',
    policy: resolveGroundingPolicy(routed, { message }),
    route: routed,
    snapshot: extra.snapshot,
    message,
    ...fetchers,
  });
}

function sampleUpcoming(partial = {}) {
  return {
    status: 'ok',
    source: ['cashflow_upcoming'],
    accountScope: 'selected_account',
    period: { start: '2026-08-23', end: '2026-08-29', label: 'next_week', relation: 'next_week' },
    metricScope: 'expense',
    items: [{ label: 'Daycare', date: '2026-08-24', amount: 705, frequencyLabel: 'Weekly', transactionid: 99, signed: -705 }],
    totals: { scheduledExpenseTotal: 705 },
    observations: [{ code: 'upcoming_expense_count', count: 1 }],
    limitations: [],
    dataAsOf: '2026-08-17',
    itemCount: 1,
    ...partial,
  };
}

function sampleRecurring() {
  return {
    status: 'ok',
    accountScope: 'selected_account',
    recurringDefinition: 'kea_scheduled_series',
    sourceKinds: ['kea_scheduled_series'],
    expenses: [
      { label: 'Netflix', category: 'Entertainment', frequency: 30, frequencyLabel: 'Monthly', amount: 15.99, monthlyEquivalent: 15.99, nextDate: '2026-09-01', groupid: 'g1' },
      { label: 'Rent', category: 'Housing', frequency: 30, frequencyLabel: 'Monthly', amount: 1400, monthlyEquivalent: 1400, nextDate: '2026-09-01' },
    ],
    income: [
      { label: 'Paycheck', category: 'Income', frequency: 14, frequencyLabel: 'Bi-Weekly', amount: 2000, monthlyEquivalent: Number((2000 * 26 / 12).toFixed(2)), nextDate: '2026-08-21' },
    ],
    totals: {
      recurringExpenseMonthlyEquivalent: 1415.99,
      recurringIncomeMonthlyEquivalent: Number((2000 * 26 / 12).toFixed(2)),
      nextOccurrenceExpenseSum: 1415.99,
    },
    observations: [
      { code: 'largest_recurring_expense', label: 'Rent', monthlyEquivalent: 1400, frequencyLabel: 'Monthly' },
      { code: 'largest_recurring_income', label: 'Paycheck', monthlyEquivalent: Number((2000 * 26 / 12).toFixed(2)), frequencyLabel: 'Bi-Weekly' },
    ],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
  };
}

function sampleHorizon(partial = {}) {
  return {
    status: 'ok',
    source: ['cashflow_income_horizon'],
    accountScope: 'selected_account',
    incomeHorizonDefinition: 'kea_scheduled_recurring_income',
    nextIncome: [{ label: 'Direct Deposit', date: '2026-08-31', amount: 4626.36, frequencyLabel: 'Semi-Monthly', category: 'Income' }],
    combinedScheduledIncomeAmount: 4626.36,
    window: { start: '2026-08-18', end: '2026-08-30', relation: 'before_next_scheduled_income' },
    expensesBeforeIncome: { count: 2, total: 200, items: [{ label: 'Rent', date: '2026-08-20', amount: 100 }, { label: 'Phone', date: '2026-08-25', amount: 100 }] },
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
    observations: [{ code: 'next_scheduled_recurring_income', date: '2026-08-31' }, { code: 'no_negative_before_income' }],
    limitations: ['selected_account_scope'],
    dataAsOf: '2026-08-17',
    ...partial,
  };
}

function sampleComparison() {
  return {
    status: 'ok',
    accountScope: 'selected_account',
    windowKind: 'matched_elapsed',
    periodA: { label: 'July 1–16, 2026', start: '2026-07-01', end: '2026-07-16', income: 5000, spending: 4200, net: 800, transactionCount: 8 },
    periodB: { label: 'August 1–16, 2026', start: '2026-08-01', end: '2026-08-16', income: 5600, spending: 3780, net: 1820, transactionCount: 7 },
    changes: {
      income: { absolute: 600, percent: 12, baselineZero: false },
      spending: { absolute: -420, percent: -10, baselineZero: false },
      net: { absolute: 1020, percent: 127.5, baselineZero: false, crossedZero: false },
    },
    observations: [{ code: 'spending_decreased' }, { code: 'income_increased' }, { code: 'net_improved' }],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
  };
}

function sampleTrend() {
  return {
    status: 'ok',
    accountScope: 'selected_account',
    windowKind: 'matched_elapsed',
    metricScope: 'spending',
    periods: [
      { label: 'June 1–16, 2026', start: '2026-06-01', end: '2026-06-16', income: 5000, spending: 100, net: 4900, transactionCount: 2 },
      { label: 'July 1–16, 2026', start: '2026-07-01', end: '2026-07-16', income: 5000, spending: 120, net: 4880, transactionCount: 2 },
      { label: 'August 1–16, 2026', start: '2026-08-01', end: '2026-08-16', income: 5000, spending: 140, net: 4860, transactionCount: 2 },
    ],
    trend: {
      income: { direction: 'unchanged', firstToLast: { absolute: 0, percent: 0, baselineZero: false } },
      spending: { direction: 'increasing', firstToLast: { absolute: 40, percent: 40, baselineZero: false } },
      net: { direction: 'decreasing', firstToLast: { absolute: -40, percent: -0.82, baselineZero: false, crossedZero: false } },
    },
    highest: { metric: 'spending', label: 'August 1–16, 2026', start: '2026-08-01', end: '2026-08-16', value: 140 },
    lowest: { metric: 'spending', label: 'June 1–16, 2026', start: '2026-06-01', end: '2026-06-16', value: 100 },
    observations: [{ code: 'spending_increasing' }],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
  };
}

function sampleCashflow() {
  return {
    status: 'ok',
    period: { start: '2026-08-01', end: '2026-08-16', label: 'current_month_to_date' },
    postedIncome: 3000,
    postedSpending: 200,
    postedNet: 2800,
    remainingForecastSpending: 400,
    remainingForecastIncome: 2000,
    availableBalance: 1400,
    negativeBalanceRisk: {
      scope: { start: '2026-08-16', end: '2026-08-31', label: 'this_month' },
      horizonDays: 90,
      hasNegativeInScope: false,
      firstNegativeDate: null,
      lowestProjectedAmount: 410,
      lowestProjectedDate: '2026-09-13',
    },
    observations: [{ code: 'posted_net_positive' }],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
  };
}

function sampleAffordability() {
  return {
    status: 'ok',
    requested: { amount: 800, purchaseDate: '2026-08-21' },
    baseline: { projectedOnDate: 3047, projectedOnDateAt: '2026-08-21' },
    hypothetical: { projectedOnDate: 2247, projectedOnDateAt: '2026-08-21', lowestAfterDate: 410, lowestAfterDateOn: '2026-09-13' },
    delta: { newNegativeIntroduced: false },
    observations: [{ code: 'no_new_negative' }],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
  };
}

function assertMacroPrompt(name, prompt, extra = {}) {
  check(`${name} assembled`, !!(prompt && prompt.systemContent));
  check(`${name} ledger mode`, prompt.evidencePromptMode === 'ledger_v1');
  check(`${name} not projection failed`, prompt.projectionFailed !== true);
  check(`${name} Prompt View wrapper`, prompt.groundedEvidenceBlock.indexOf('GROUNDED EVIDENCE\n') === 0);
  check(`${name} no legacy evidence wrapper`, !/GROUNDED EVIDENCE \(authoritative/.test(prompt.systemContent));
  check(`${name} no Narrate observation codes`, !/Narrate observation codes/.test(prompt.systemContent));
  check(`${name} no full CURRENT CONTEXT dump`, !/ON-SCREEN/.test(prompt.systemContent) && !/AVAILABLE CATEGORIES/.test(prompt.systemContent));
  const obs = observationHitsInText(prompt.systemContent);
  check(`${name} no observation codes`, obs.length === 0, obs.join(','));
  const banned = bannedHitsInText(prompt.systemContent);
  check(`${name} no banned keys`, banned.length === 0, banned.join(','));
  check(`${name} has evidence telemetry`, !!(prompt && prompt.evidenceTelemetry));
  check(`${name} telemetry mode ledger_v1`, prompt.evidenceTelemetry.evidence_prompt_mode === 'ledger_v1');
  check(`${name} telemetry ledger present`, prompt.evidenceTelemetry.evidence_ledger_present === true);
  check(`${name} telemetry projection ok`, prompt.evidenceTelemetry.evidence_projection_status === 'ok');
  check(`${name} telemetry promptable`, prompt.evidenceTelemetry.evidence_promptable === true);
  check(`${name} telemetry stripped`, prompt.evidenceTelemetry.evidence_internal_stripped === true);
  check(`${name} telemetry rollback false`, prompt.evidenceTelemetry.evidence_rollback_active === false);
  check(`${name} telemetry no failure`, prompt.evidenceTelemetry.evidence_projection_failure_reason === 'none');
  if (extra.must) {
    extra.must.forEach((re, i) => check(`${name} must[${i}]`, re.test(prompt.systemContent)));
  }
  if (extra.mustNot) {
    extra.mustNot.forEach((re, i) => check(`${name} mustNot[${i}]`, !re.test(prompt.systemContent)));
  }
}

async function run() {
  section('3B.3A flag and capability gates');
  check('default flag on when unset', withEnv(undefined, () => isLedgerPromptEnabled() === true));
  check('flag off for 0', withEnv('0', () => isLedgerPromptEnabled() === false));
  check('flag off for false', withEnv('false', () => isLedgerPromptEnabled() === false));
  check('flag off for FALSE', withEnv('FALSE', () => isLedgerPromptEnabled() === false));
  check('flag off for off', withEnv('off', () => isLedgerPromptEnabled() === false));
  check('flag off for no', withEnv('NO', () => isLedgerPromptEnabled() === false));
  check('flag on for true', withEnv('true', () => isLedgerPromptEnabled() === true));
  check('flag on for 1', withEnv('1', () => isLedgerPromptEnabled() === true));
  check('flag on for on', withEnv('ON', () => isLedgerPromptEnabled() === true));
  check('flag on for yes', withEnv('yes', () => isLedgerPromptEnabled() === true));
  check('rollback active when off', withEnv('false', () => isEvidenceRollbackActive() === true));
  check('rollback inactive when unset', withEnv(undefined, () => isEvidenceRollbackActive() === false));
  check('parse unknown enables', parseLedgerPromptFlag('maybe').enabled === true && parseLedgerPromptFlag('maybe').rollbackActive === false);
  check('approved count 7', APPROVED_MACRO_CAPABILITIES.length === 7);
  check('upcoming approved', isApprovedMacroCapability('cashflow_upcoming') === true);
  check('snapshot not approved', isApprovedMacroCapability('financial_forecast') === false);
  check('lookup not approved', isApprovedMacroCapability('financial_lookup') === false);
  check('unknown not approved', isApprovedMacroCapability('unknown') === false);
  check('clarify not approved', isApprovedMacroCapability('conversation_clarify') === false);
  check('write not approved', isApprovedMacroCapability('write') === false);
  check('cutover has no ranking math', !/Math\.max|\.sort\s*\(|\.reduce\s*\(/.test(
    fs.readFileSync(path.join(__dirname, '..', 'services', 'keaEvidencePromptCutover.js'), 'utf8')
  ));

  section('3B.3A production assembly goldens');
  const sizes = {};

  const upRoute = route('What bills are due next week?', { currentDate: '2026-08-16' });
  const upEv = await prefetch('What bills are due next week?', { fetchUpcomingAnalysis: async () => sampleUpcoming() }, { currentDate: '2026-08-16', route: upRoute });
  const upPrompt = assemble(upEv, { capability: 'cashflow_upcoming', route: upRoute });
  sizes.upcoming = {
    old: buildEvidenceSystemSection(upEv).length,
    neu: upPrompt.groundedEvidenceBlock.length,
    system: upPrompt.systemContent.length,
  };
  assertMacroPrompt('upcoming normal', upPrompt, {
    must: [/2026-08-23/, /2026-08-29/, /Daycare/, /"scheduledExpenseTotal":705/, /scheduled expenses in your Keacast forecast/],
    mustNot: [/no_upcoming_in_period/, /transactionid/],
  });
  check('upcoming tools empty', allowedToolsFor('cashflow_upcoming').size === 0);

  const emptyEv = {
    status: 'ok',
    source: ['cashflow_upcoming'],
    accountScope: 'selected_account',
    period: { start: '2026-08-23', end: '2026-08-29', label: 'next_week', relation: 'next_week' },
    facts: {
      metricScope: 'income',
      period: { start: '2026-08-23', end: '2026-08-29', label: 'next_week', relation: 'next_week' },
      items: [],
      totals: { scheduledIncomeTotal: 0 },
      itemCount: 0,
    },
    observations: [{ code: 'no_upcoming_in_period' }],
    limitations: [],
  };
  const emptyPrompt = assemble(emptyEv, { capability: 'cashflow_upcoming' });
  sizes.upcoming_empty = {
    old: buildEvidenceSystemSection(emptyEv).length,
    neu: emptyPrompt.groundedEvidenceBlock.length,
    system: emptyPrompt.systemContent.length,
  };
  assertMacroPrompt('upcoming empty', emptyPrompt, {
    must: [
      /2026-08-23/,
      /2026-08-29/,
      /"metricScope":"income"/,
      /"scheduledIncomeTotal":0/,
      /No scheduled income exists in this Keacast forecast/,
      /Do not claim the user has no income or no incoming funds/,
    ],
    mustNot: [
      /no_upcoming_in_period/,
      /You have no income/,
      /nothing is planned or detected/,
    ],
  });
  check('upcoming empty is not fail-soft', emptyPrompt.projectionFailed !== true && emptyEv.status === 'ok');

  const recRoute = route('What recurring expenses do I have?', { currentDate: '2026-08-16' });
  const recEv = await prefetch('What recurring expenses do I have?', { fetchRecurringAnalysis: async () => sampleRecurring() }, { currentDate: '2026-08-16', route: recRoute });
  const recPrompt = assemble(recEv, { capability: 'cashflow_recurring', route: recRoute });
  sizes.recurring = {
    old: buildEvidenceSystemSection(recEv).length,
    neu: recPrompt.groundedEvidenceBlock.length,
    system: recPrompt.systemContent.length,
  };
  assertMacroPrompt('recurring', recPrompt, {
    must: [/scheduled recurring items/, /"metricScope":"expense"/, /Rent/, /Netflix/],
    mustNot: [/largest_recurring_expense/, /no_scheduled_recurring/, /groupid/],
  });

  const largestRoute = route('What is my largest recurring expense?', { currentDate: '2026-08-16' });
  const largestEv = await prefetch('What is my largest recurring expense?', { fetchRecurringAnalysis: async () => sampleRecurring() }, { currentDate: '2026-08-16', route: largestRoute });
  const largestPrompt = assemble(largestEv, {
    capability: 'cashflow_recurring',
    route: largestRoute,
    responseMode: 'largest',
  });
  sizes.recurring_largest = {
    old: buildEvidenceSystemSection(largestEv).length,
    neu: largestPrompt.groundedEvidenceBlock.length,
    system: largestPrompt.systemContent.length,
  };
  assertMacroPrompt('recurring largest', largestPrompt, {
    must: [/Rent/, /"amount":1400/],
    mustNot: [/largest_recurring_expense/, /largest_recurring_income/, /Netflix/],
  });

  const childCareSmall = { label: 'Child Care', amount: 105, monthlyEquivalent: 105, nextDate: '2026-09-05', frequencyLabel: 'Monthly' };
  const childCareLarge = { label: 'Child Care', amount: 705, monthlyEquivalent: 3055, nextDate: '2026-09-20', frequencyLabel: 'Weekly' };
  const dupEv = {
    status: 'ok',
    source: ['cashflow_recurring'],
    accountScope: 'selected_account',
    facts: {
      metricScope: 'expense',
      rankingMode: 'largest',
      expenses: [childCareSmall, childCareLarge],
      income: [],
      totals: {},
      largestExpense: childCareLarge,
    },
    observations: [{ code: 'largest_recurring_expense', label: 'Child Care', monthlyEquivalent: 3055, frequencyLabel: 'Weekly' }],
    limitations: [],
  };
  const dupPrompt = assemble(dupEv, { capability: 'cashflow_recurring', responseMode: 'largest' });
  const dupRevPrompt = assemble({
    ...dupEv,
    facts: { ...dupEv.facts, expenses: [childCareLarge, childCareSmall], largestExpense: childCareLarge },
  }, { capability: 'cashflow_recurring', responseMode: 'largest' });
  check('dup largest amount 705', /"amount":705/.test(dupPrompt.systemContent));
  check('dup largest not 105', !/"amount":105/.test(dupPrompt.systemContent));
  check('dup reversed still 705', /"amount":705/.test(dupRevPrompt.systemContent) && !/"amount":105/.test(dupRevPrompt.systemContent));
  check('dup no observation code', observationHitsInText(dupPrompt.systemContent).length === 0);

  const hzRoute = route('Will I go negative before my next paycheck?');
  const hzEv = await prefetch('Will I go negative before my next paycheck?', { fetchIncomeHorizonAnalysis: async () => sampleHorizon() }, { route: hzRoute });
  const hzPrompt = assemble(hzEv, { capability: 'cashflow_income_horizon', route: hzRoute, responseMode: 'negative_check' });
  sizes.horizon = {
    old: buildEvidenceSystemSection(hzEv).length,
    neu: hzPrompt.groundedEvidenceBlock.length,
    system: hzPrompt.systemContent.length,
  };
  assertMacroPrompt('horizon', hzPrompt, {
    must: [
      /next scheduled recurring income/,
      /2026-08-31/,
      /4626\.36/,
      /"negativeBeforeIncome":false/,
      /"firstNegativeDate":null/,
      /paycheck/,
    ],
    mustNot: [
      /no_negative_before_income/,
      /forecast_goes_negative_before_income/,
      /same_day_order_unknown/,
      /kea_scheduled_recurring_income/,
    ],
  });
  check('horizon paycheck only as prohibition', /Do not call this a paycheck, payday, salary deposit, or employer-confirmed payroll/.test(hzPrompt.systemContent));

  const cmpRoute = route('How does this month compare with last month?', { currentDate: '2026-08-16' });
  const cmpEv = await prefetch('How does this month compare with last month?', { fetchPeriodComparison: async () => sampleComparison() }, { currentDate: '2026-08-16', route: cmpRoute });
  const cmpPrompt = assemble(cmpEv, { capability: 'cashflow_comparison', route: cmpRoute });
  sizes.comparison = {
    old: buildEvidenceSystemSection(cmpEv).length,
    neu: cmpPrompt.groundedEvidenceBlock.length,
    system: cmpPrompt.systemContent.length,
  };
  assertMacroPrompt('comparison', cmpPrompt, {
    must: [/2026-07-01/, /2026-08-16/, /"percent":null|"percent":12|"percent":-10|"percent":127\.5/],
    mustNot: [/both_periods_empty/, /posted_net_/],
  });
  check('comparison percent 12 preserved', /"percent":12/.test(cmpPrompt.systemContent));
  check('comparison crossedZero false', /"crossedZero":false/.test(cmpPrompt.systemContent));

  const trendRoute = route('Am I spending more lately?', { currentDate: '2026-08-16' });
  const trendEv = await prefetch('Am I spending more lately?', { fetchTrendAnalysis: async () => sampleTrend() }, { currentDate: '2026-08-16', route: trendRoute });
  const trendPrompt = assemble(trendEv, { capability: 'cashflow_trend', route: trendRoute });
  sizes.trend = {
    old: buildEvidenceSystemSection(trendEv).length,
    neu: trendPrompt.groundedEvidenceBlock.length,
    system: trendPrompt.systemContent.length,
  };
  assertMacroPrompt('trend', trendPrompt, {
    must: [/June 1–16, 2026/, /"direction":"increasing"/, /2026-06-01/, /2026-08-16/],
    mustNot: [/all_periods_empty/, /posted_net_/],
  });

  const cfRoute = route('How am I doing this month?', { currentDate: '2026-08-16' });
  const cfEv = await prefetch('How am I doing this month?', { fetchCashflowAnalysis: async () => sampleCashflow() }, { currentDate: '2026-08-16', route: cfRoute });
  const cfPrompt = assemble(cfEv, { capability: 'cashflow_analysis', route: cfRoute });
  sizes.cashflow = {
    old: buildEvidenceSystemSection(cfEv).length,
    neu: cfPrompt.groundedEvidenceBlock.length,
    system: cfPrompt.systemContent.length,
  };
  assertMacroPrompt('cashflow', cfPrompt, {
    must: [/"postedNet":2800/, /Do not say comfortable, healthy, safe, enough, or affordable/, /"hasNegativeInScope":false/],
    mustNot: [/posted_net_positive/, /canAfford/],
  });

  const affRoute = route('Can I afford $800 on August 21?', { currentDate: '2026-08-16' });
  const affEv = await prefetch('Can I afford $800 on August 21?', { fetchAffordabilityAnalysis: async () => sampleAffordability() }, { currentDate: '2026-08-16', route: affRoute });
  const affPrompt = assemble(affEv, { capability: 'affordability_or_planning', route: affRoute });
  sizes.affordability = {
    old: buildEvidenceSystemSection(affEv).length,
    neu: affPrompt.groundedEvidenceBlock.length,
    system: affPrompt.systemContent.length,
  };
  assertMacroPrompt('affordability', affPrompt, {
    must: [/"amount":800/, /2026-08-21/, /"newNegativeIntroduced":false/, /Do not say affordable, safe, comfortable/],
    mustNot: [/no_new_negative/, /canAfford/, /"horizonDays"/],
  });

  section('3B.3A zero / false / null / total mode');
  check('zero scheduledIncomeTotal', /"scheduledIncomeTotal":0/.test(emptyPrompt.systemContent));
  check('false negativeBeforeIncome', /"negativeBeforeIncome":false/.test(hzPrompt.systemContent));
  check('null firstNegativeDate', /"firstNegativeDate":null/.test(hzPrompt.systemContent));
  const nullPctEv = JSON.parse(JSON.stringify(cmpEv));
  nullPctEv.facts.changes.income.percent = null;
  const nullPctPrompt = assemble(nullPctEv, { capability: 'cashflow_comparison', route: cmpRoute });
  check('null percent preserved', /"percent":null/.test(nullPctPrompt.systemContent));

  const totalPrompt = assemble(upEv, { capability: 'cashflow_upcoming', route: upRoute, responseMode: 'total' });
  check('total mode omits item rows', !/"label":"Daycare"/.test(totalPrompt.systemContent));
  check('total mode keeps period and total', /2026-08-23/.test(totalPrompt.systemContent) && /"scheduledExpenseTotal":705/.test(totalPrompt.systemContent));

  section('3B.3A rollback / snapshot / lookup / fail-soft / projection failure');
  withEnv('0', () => {
    check('flag off uses legacy', shouldUseLedgerPrompt('cashflow_upcoming') === false);
    const legacy = assemble(upEv, { capability: 'cashflow_upcoming', route: upRoute });
    check('rollback mode legacy', legacy.evidencePromptMode === 'legacy');
    check('rollback still has Narrate observation codes', /Narrate observation codes/.test(legacy.systemContent));
    check('rollback still has azureFacing JSON source array', /"source":\["cashflow_upcoming"\]/.test(legacy.systemContent.replace(/\s+/g, '')));
    check('rollback telemetry mode legacy', legacy.evidenceTelemetry.evidence_prompt_mode === 'legacy');
    check('rollback telemetry rollback true', legacy.evidenceTelemetry.evidence_rollback_active === true);
    check('rollback telemetry ledger absent', legacy.evidenceTelemetry.evidence_ledger_present === false);
    check('rollback telemetry projection legacy', legacy.evidenceTelemetry.evidence_projection_status === 'legacy');
  });

  const snapProjected = projectApprovedMacroEvidence({
    capability: 'financial_forecast',
    evidence: { status: 'ok', source: ['kea_snapshot'], facts: { recents: [{ label: 'Coffee' }], upcoming: [{ label: 'Rent' }] }, observations: [{ code: 'no_upcoming_in_period' }] },
  });
  check('snapshot project mode legacy', snapProjected.mode === 'legacy');
  const snapLegacy = buildEvidenceSystemSection({
    status: 'ok',
    source: ['kea_snapshot'],
    facts: { recents: [{ label: 'Coffee' }], upcoming: [{ label: 'Rent' }] },
  });
  check('snapshot still uses legacy builder', /GROUNDED EVIDENCE \(authoritative/.test(snapLegacy));

  const lookupProjected = projectApprovedMacroEvidence({
    capability: 'financial_lookup',
    evidence: { status: 'ok', source: ['user_transactions'], facts: { spentTotal: 30 }, lookups: [] },
  });
  check('lookup project mode legacy', lookupProjected.mode === 'legacy');
  check('lookup not cut over', shouldUseLedgerPrompt('financial_lookup') === false);

  const unknownProjected = projectApprovedMacroEvidence({
    capability: 'unknown',
    evidence: { status: 'ok', source: ['kea_snapshot'], facts: {} },
  });
  check('unknown stays legacy', unknownProjected.mode === 'legacy');
  check('clarify not cut over', shouldUseLedgerPrompt('conversation_clarify') === false);

  const unavailableEv = { status: 'unavailable', source: [], limitations: ['upcoming_unavailable'], period: { start: '2026-08-23', end: '2026-08-29' } };
  check('unavailable is fail-soft', isFailSoft(resolveGroundingPolicy(upRoute), unavailableEv) === true);
  const unavailableProjected = projectApprovedMacroEvidence({ capability: 'cashflow_upcoming', evidence: unavailableEv });
  check('unavailable not sent as prompt view', unavailableProjected.promptable === false && unavailableProjected.block == null);
  check('unavailable fail-soft text', /couldn't verify the current Keacast data/.test(failSoftTextFor(unavailableEv)));

  const bad = {
    status: 'ok',
    source: ['cashflow_upcoming'],
    facts: { metricScope: 'income', items: [{ label: 'x', amount: 1n }], totals: { scheduledIncomeTotal: 0 } },
  };
  const failed = projectApprovedMacroEvidence({ capability: 'cashflow_upcoming', evidence: bad });
  check('projection failure fail-soft', failed.failSoft === true && failed.ok === false);
  check('projection failure no block', failed.block == null);
  const failedPrompt = assemble(bad, { capability: 'cashflow_upcoming' });
  check('projection failure does not send raw evidence', failedPrompt.projectionFailed === true && failedPrompt.groundedEvidenceBlock === '');
  check('projection failure does not include raw facts dump', !/"amount":/.test(failedPrompt.systemContent));
  check('projection failure telemetry not ok', failed.telemetry.evidence_projection_status !== 'ok');
  check('projection failure telemetry not promptable', failed.telemetry.evidence_promptable === false);
  check('projection failure telemetry reason controlled', failed.telemetry.evidence_projection_failure_reason === 'projection_exception');
  check('projection failure telemetry no amount', JSON.stringify(failed.telemetry).indexOf('amount') === -1);

  section('3B.4 capability telemetry goldens');
  check('upcoming empty status complete_empty', emptyPrompt.evidenceTelemetry.evidence_status === 'complete_empty');
  check('upcoming empty not truncated', emptyPrompt.evidenceTelemetry.evidence_list_truncated === false);
  check('upcoming empty source', emptyPrompt.evidenceTelemetry.evidence_source_kind === 'cashflow_upcoming');
  check('upcoming normal source', upPrompt.evidenceTelemetry.evidence_source_kind === 'cashflow_upcoming');
  check('upcoming normal status complete', upPrompt.evidenceTelemetry.evidence_status === 'complete' || upPrompt.evidenceTelemetry.evidence_status === 'complete_empty');
  check('recurring mode ledger_v1', recPrompt.evidenceTelemetry.evidence_prompt_mode === 'ledger_v1' && recPrompt.evidenceTelemetry.evidence_source_kind === 'cashflow_recurring');
  check('horizon source', hzPrompt.evidenceTelemetry.evidence_source_kind === 'cashflow_income_horizon');
  check('comparison source', cmpPrompt.evidenceTelemetry.evidence_source_kind === 'cashflow_period_comparison');
  check('trend source', trendPrompt.evidenceTelemetry.evidence_source_kind === 'cashflow_trend');
  check('cashflow source', cfPrompt.evidenceTelemetry.evidence_source_kind === 'cashflow_analysis');
  check('affordability source', affPrompt.evidenceTelemetry.evidence_source_kind === 'affordability_analysis');
  check('snapshot telemetry rollback false', snapProjected.telemetry.evidence_rollback_active === false);
  check('snapshot telemetry mode legacy', snapProjected.telemetry.evidence_prompt_mode === 'legacy');
  check('lookup telemetry mode legacy', lookupProjected.telemetry.evidence_prompt_mode === 'legacy');

  const cutoverSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaEvidencePromptCutover.js'), 'utf8');
  const telSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaEvidenceTelemetry.js'), 'utf8');
  check('cutover logger has no ledger dump', !/console\.(log|info|debug)\(.*ledger/.test(cutoverSrc) && !/JSON\.stringify\(built\.ledger\)/.test(cutoverSrc));
  check('telemetry module has no financial math', !/Math\.max|\.reduce\s*\(|percentage/.test(telSrc));

  section('3B.3A size and performance');
  Object.keys(sizes).forEach((name) => {
    const row = sizes[name];
    const delta = row.neu - row.old;
    const pct = row.old ? Math.round((delta / row.old) * 100) : 0;
    check(`${name} evidence size old=${row.old} new=${row.neu} delta=${delta} (${pct}%) system=${row.system}`, true);
  });
  const t0 = Date.now();
  for (let i = 0; i < 200; i += 1) {
    projectApprovedMacroEvidence({ capability: 'cashflow_upcoming', evidence: upEv, route: upRoute });
  }
  const elapsed = Date.now() - t0;
  check(`200 projections ${elapsed}ms`, elapsed < 2000, String(elapsed));

  const identitySrc = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'systemPromptBuilders.js'), 'utf8');
  check('macro identity no observation-code instruction', /Narrate only facts supplied in GROUNDED EVIDENCE/.test(identitySrc)
    && !/Narrate only facts and observation codes/.test(identitySrc));
  check('legacy builder still has Narrate observation codes', /Narrate observation codes and supplied facts only/.test(
    fs.readFileSync(path.join(__dirname, '..', 'services', 'keaGroundingPrefetch.js'), 'utf8')
  ));
  check(`observation corpus size=${OBSERVATION_CODES.length}`, OBSERVATION_CODES.length >= 40);
}

module.exports = { run };
