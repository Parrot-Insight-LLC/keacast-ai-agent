'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');
const { routeCapability } = require('../services/keaCapabilityRouter');
const { resolveGroundingPolicy } = require('../services/keaGroundingPolicy');
const {
  prefetchGrounding,
  buildEvidenceSystemSection,
  shouldForceDirectAnswer,
} = require('../services/keaGroundingPrefetch');
const {
  LEDGER_PROMPT_ENV_KEY,
  LOOKUP_PROMPT_ENV_KEY,
  shouldUseLedgerPrompt,
  shouldUseLookupLedgerPrompt,
  isEligibleLookupCutover,
  isSnapshotBackedLookup,
  isLookupLedgerPromptEnabled,
  isLookupEvidenceRollbackActive,
  isLedgerPromptEnabled,
  isEvidenceRollbackActive,
  projectApprovedMacroEvidence,
  projectLookupEvidence,
} = require('../services/keaEvidencePromptCutover');
const { telemetryForNonCutoverTurn } = require('../services/keaEvidenceTelemetry');
const { __testables: T } = require('../controllers/openaiController');
const { collectBannedKeys } = require('../services/keaEvidencePromptView');

const SNAPSHOT = {
  _keaCompact: true,
  schemaVersion: 1,
  accountid: 10,
  balance: 1200,
  reconciledBalance: 1200,
  current: 1150,
  available: 1100,
  dataAsOf: '2026-08-16T12:00:00.000Z',
  savings: { totalIncome: 4000, totalExpenses: 2500, netCashFlow: 1500, savingsPotential: 900 },
  upcomingExpenseTotal: 200,
  upcomingIncomeTotal: 0,
  recents: [{ name: 'Costco', amount: -80, date: '2026-08-10' }],
  upcoming: [{ name: 'Rent', amount: -1400, start: '2026-09-01' }],
};

const ACCOUNT = {
  accountname: 'Checking',
  institution_name: 'Bank',
  account_type: 'checking',
  recents: [{ name: 'Costco', amount: -80, date: '2026-08-10' }],
  upcoming: [{ name: 'Rent', amount: -1400, start: '2026-09-01' }],
  upcomingExpenseTotal: 1400,
  upcomingIncomeTotal: 0,
  available: 1100,
  current: 1150,
  reconciledBalance: 1200,
};

const UNMATCHED = 'ZZ-UNMATCHED-COSTCO';

function route(message, extra = {}) {
  return routeCapability({
    message,
    currentDate: extra.currentDate || '2026-08-16',
    accountId: extra.accountId || '10',
    knownCategories: extra.knownCategories || ['Restaurants', 'Groceries'],
  });
}

function paginatedFetch(allRows, pageSize = 100) {
  const calls = [];
  const fetchPage = async ({ userId, accountId, page, limit, startDate, endDate }) => {
    calls.push({ userId, accountId, page, limit, startDate, endDate });
    const size = limit || pageSize;
    const start = (page - 1) * size;
    return {
      transactions: allRows.slice(start, start + size),
      pagination: {
        page,
        limit: size,
        total: allRows.length,
        pages: Math.ceil(allRows.length / size) || 1,
        hasNext: page * size < allRows.length,
      },
    };
  };
  return { fetchPage, calls };
}

function withFlags(macro, lookup, fn) {
  const keys = [LEDGER_PROMPT_ENV_KEY, LOOKUP_PROMPT_ENV_KEY];
  const values = [macro, lookup];
  const had = {};
  const prev = {};
  for (let i = 0; i < keys.length; i += 1) {
    had[keys[i]] = Object.prototype.hasOwnProperty.call(process.env, keys[i]);
    prev[keys[i]] = process.env[keys[i]];
    if (values[i] === undefined) delete process.env[keys[i]];
    else process.env[keys[i]] = values[i];
  }
  try {
    return fn();
  } finally {
    for (let i = 0; i < keys.length; i += 1) {
      if (had[keys[i]]) process.env[keys[i]] = prev[keys[i]];
      else delete process.env[keys[i]];
    }
  }
}

async function prefetchLookup(message, rows, extra = {}) {
  const routed = extra.route || route(message, extra);
  const fetch = paginatedFetch(rows, extra.pageSize || 100);
  const evidence = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: extra.snapshot || SNAPSHOT,
    currentDate: extra.currentDate || '2026-08-16',
    policy: resolveGroundingPolicy(routed, { message }),
    route: routed,
    message,
    fetchPage: fetch.fetchPage,
    pageLimit: extra.pageSize || 100,
    assertFn: extra.assertFn || (async () => ({ access: 'owner' })),
  });
  return { route: routed, evidence, calls: fetch.calls };
}

function assembleLookup(evidence, routed, extra = {}) {
  return T.buildLookupAnalysisPrompt({
    currentDate: extra.currentDate || '2026-08-16',
    firstName: 'Alex',
    account: extra.account === undefined ? ACCOUNT : extra.account,
    evidence,
    route: routed,
    accountContext: extra.accountContext || { accountId: '10', accountLabel: 'Checking' },
    longTermFacts: extra.longTermFacts || [],
    rollingSummary: extra.rollingSummary || '',
    dialogueState: extra.dialogueState || T.emptyDialogueState(),
  });
}

function targetRows() {
  const rows = [
    { name: 'Target', amount: -100.00, start: '2026-07-03', forecast_type: 'A' },
    { name: 'Target', amount: -100.00, start: '2026-07-12', forecast_type: 'A' },
    { name: 'Target', amount: -79.58, start: '2026-07-28', forecast_type: 'A' },
  ];
  for (let i = 0; i < 131; i += 1) {
    rows.push({
      name: UNMATCHED,
      amount: -1.11,
      start: `2026-07-${String((i % 28) + 1).padStart(2, '0')}`,
      forecast_type: 'A',
    });
  }
  return rows;
}

function scanPrompt(src) {
  const hits = [];
  if (/accountId/.test(src)) hits.push('accountId');
  if (/transactionid/i.test(src)) hits.push('transactionid');
  if (/groupid/i.test(src)) hits.push('groupid');
  if (/\bjwt\b/i.test(src)) hits.push('jwt');
  if (/userId/.test(src)) hits.push('userId');
  if (/prefetchMeta/.test(src)) hits.push('prefetchMeta');
  if (/"pageCount"/.test(src)) hits.push('pageCount');
  if (/"rowCount"/.test(src)) hits.push('rowCount');
  if (/"matchCount"/.test(src)) hits.push('matchCount');
  if (/periodReadCount/.test(src)) hits.push('periodReadCount');
  if (src.indexOf(UNMATCHED) !== -1) hits.push('unmatched');
  return hits;
}

async function run() {
  section('3B.3B.2 flag parsing and isolation');
  check('lookup flag default ON', withFlags(undefined, undefined, () => isLookupLedgerPromptEnabled() === true));
  check('lookup flag off', withFlags(undefined, 'false', () => isLookupLedgerPromptEnabled() === false));
  check('lookup rollback when off', withFlags(undefined, '0', () => isLookupEvidenceRollbackActive() === true));
  check('lookup rollback false when unset', withFlags(undefined, undefined, () => isLookupEvidenceRollbackActive() === false));
  check('lookup flag name', LOOKUP_PROMPT_ENV_KEY === 'USE_LOOKUP_EVIDENCE_LEDGER_PROMPT');
  check('macro flag name unchanged', LEDGER_PROMPT_ENV_KEY === 'USE_EVIDENCE_LEDGER_PROMPT');

  withFlags('true', 'false', () => {
    check('macro ON lookup OFF: macro enabled', isLedgerPromptEnabled() === true && isEvidenceRollbackActive() === false);
    check('macro ON lookup OFF: lookup rollback', isLookupLedgerPromptEnabled() === false && isLookupEvidenceRollbackActive() === true);
  });
  withFlags('false', 'true', () => {
    check('macro OFF lookup ON: macro rollback', isLedgerPromptEnabled() === false && isEvidenceRollbackActive() === true);
    check('macro OFF lookup ON: lookup enabled', isLookupLedgerPromptEnabled() === true && isLookupEvidenceRollbackActive() === false);
  });
  withFlags('false', 'false', () => {
    check('both OFF: both rollback', isEvidenceRollbackActive() === true && isLookupEvidenceRollbackActive() === true);
  });
  withFlags(undefined, undefined, () => {
    check('both unset: both ON', isLedgerPromptEnabled() === true && isLookupLedgerPromptEnabled() === true);
  });

  section('3B.3B.2 Target production assembly');
  const targetMsg = 'How much did I spend at Target last month?';
  const { route: targetRoute, evidence: targetEv, calls: targetCalls } = await prefetchLookup(targetMsg, targetRows());
  check('eligible user_transactions', isEligibleLookupCutover({
    capability: 'financial_lookup',
    evidence: targetEv,
  }) === true);
  check('shouldUseLookupLedgerPrompt default', shouldUseLookupLedgerPrompt({
    capability: 'financial_lookup',
    evidence: targetEv,
  }) === true);
  check('macro shouldUseLedgerPrompt false', shouldUseLedgerPrompt('financial_lookup') === false);

  const beforeCalls = targetCalls.length;
  const projected = projectLookupEvidence({
    capability: 'financial_lookup',
    evidence: targetEv,
    route: targetRoute,
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  });
  check('no second prefetch on project', targetCalls.length === beforeCalls);
  check('projected ledger_v1', projected.mode === 'ledger_v1' && projected.ok === true && projected.failSoft === false);
  check('projected promptable', projected.promptable === true && !!projected.block);
  check('Target spentTotal 279.58 in Prompt View', projected.promptEvidence.facts.spentTotal === 279.58);
  check('Target count 3', projected.promptEvidence.facts.transactionCount === 3);
  check('Target period July', projected.promptEvidence.period.start === '2026-07-01' && projected.promptEvidence.period.end === '2026-07-31');
  check('Target subject', projected.promptEvidence.facts.lookups[0].subjectKind === 'merchant'
    && projected.promptEvidence.facts.lookups[0].subjectValue === targetEv.lookups[0].subjectValue);
  check('exact decimal not 280', projected.promptEvidence.facts.spentTotal !== 280);
  check('magnitude not negative', projected.promptEvidence.facts.spentTotal >= 0
    && projected.promptEvidence.facts.signConvention === 'magnitude');
  check('no matched-row list', projected.promptEvidence.facts.lookups[0].name === undefined
    && projected.promptEvidence.facts.transactions === undefined);

  const prompt = assembleLookup(targetEv, targetRoute);
  check('assembly not failed', prompt.projectionFailed !== true);
  check('assembly mode ledger_v1', prompt.evidencePromptMode === 'ledger_v1');
  check('uses compact account brief', /Selected account: Checking/.test(prompt.accountBrief)
    && !/Recent posted/.test(prompt.accountBrief)
    && !/Upcoming forecasted/.test(prompt.accountBrief)
    && !/Next 14 days:/.test(prompt.accountBrief));
  check('final prompt has 279.58', /279\.58/.test(prompt.systemContent));
  check('final prompt has count 3', /"transactionCount":3/.test(prompt.systemContent.replace(/\s+/g, '')));
  check('final prompt has posted-actual limitation', /posted actual/.test(prompt.systemContent));
  check('final prompt has July bounds', /2026-07-01/.test(prompt.systemContent) && /2026-07-31/.test(prompt.systemContent));
  check('no fat CURRENT CONTEXT financial dump', !/Recent posted \(Name\|Amt\|Date\)/.test(prompt.systemContent)
    && !/Upcoming forecasted \(Name\|Amt\|Date\)/.test(prompt.systemContent));
  const promptHits = scanPrompt(prompt.systemContent);
  check('final prompt internal/unmatched scan', promptHits.length === 0, promptHits.join(','));
  check('banned keys empty', collectBannedKeys(projected.promptEvidence).length === 0);
  check('wrapper not legacy glossary', prompt.groundedEvidenceBlock.indexOf('GROUNDED EVIDENCE\n') === 0
    && !/GROUNDED EVIDENCE \(authoritative/.test(prompt.groundedEvidenceBlock));
  check('forceDirectAnswer preserved', shouldForceDirectAnswer({
    route: targetRoute,
    policy: resolveGroundingPolicy(targetRoute, { message: targetMsg }),
    evidence: targetEv,
  }) === true);

  const tel = projected.telemetry;
  check('telemetry present', tel.evidence_ledger_present === true);
  check('telemetry mode ledger_v1', tel.evidence_prompt_mode === 'ledger_v1');
  check('telemetry source user_transactions', tel.evidence_source_kind === 'user_transactions');
  check('telemetry status complete', tel.evidence_status === 'complete');
  check('telemetry projection ok', tel.evidence_projection_status === 'ok');
  check('telemetry promptable', tel.evidence_promptable === true);
  check('telemetry stripped', tel.evidence_internal_stripped === true);
  check('telemetry rollback false', tel.evidence_rollback_active === false);
  check('telemetry no failure', tel.evidence_projection_failure_reason === 'none');
  check('telemetry size buckets populated', tel.evidence_prompt_chars_bucket !== '0'
    && tel.evidence_ledger_chars_bucket !== '0');
  check('telemetry no amount leak', JSON.stringify(tel).indexOf('279.58') === -1);

  section('3B.3B.2 zero / category / refund / duplicate');
  const zero = await prefetchLookup(targetMsg, [{ name: UNMATCHED, amount: -40, start: '2026-07-02', forecast_type: 'A' }]);
  const zeroProj = projectLookupEvidence({
    capability: 'financial_lookup',
    evidence: zero.evidence,
    route: zero.route,
  });
  check('zero complete_empty', zeroProj.promptEvidence && zeroProj.promptEvidence.status === 'complete_empty');
  check('zero not fail-soft', zeroProj.failSoft === false && zeroProj.promptable === true);
  check('zero totals 0', zeroProj.promptEvidence.facts.transactionCount === 0 && zeroProj.promptEvidence.facts.spentTotal === 0);
  const zeroPrompt = assembleLookup(zero.evidence, zero.route);
  check('zero assembly has complete_empty', /complete_empty/.test(zeroPrompt.systemContent));
  check('zero unmatched absent', zeroPrompt.systemContent.indexOf(UNMATCHED) === -1);

  const catMsg = 'How much did I spend on groceries in July?';
  const cat = await prefetchLookup(catMsg, [
    { name: 'Kroger', category: 'Groceries', amount: -22.40, start: '2026-07-04', forecast_type: 'A' },
    { name: 'Chipotle', category: 'Restaurants', amount: -18.00, start: '2026-07-05', forecast_type: 'A' },
  ]);
  const catProj = projectLookupEvidence({ capability: 'financial_lookup', evidence: cat.evidence, route: cat.route });
  check('category ledger_v1', catProj.mode === 'ledger_v1' && catProj.promptEvidence.facts.spentTotal === 22.4);
  check('category subjectKind', catProj.promptEvidence.facts.lookups[0].subjectKind === 'category');

  const mixed = await prefetchLookup(targetMsg, [
    { name: 'Target', amount: -100.00, start: '2026-07-03', forecast_type: 'A' },
    { name: 'Target', amount: 20.00, start: '2026-07-08', forecast_type: 'A' },
    { name: 'Target', amount: -50.00, start: '2026-07-10', forecast_type: 'A', duplicate: 1 },
    { name: 'Target', amount: -10.00, start: '2026-07-11', forecast_type: 'F' },
  ]);
  const mixedProj = projectLookupEvidence({ capability: 'financial_lookup', evidence: mixed.evidence, route: mixed.route });
  check('refund incomeTotal 20', mixedProj.promptEvidence.facts.incomeTotal === 20);
  check('duplicate/F excluded spend 100', mixedProj.promptEvidence.facts.spentTotal === 100);

  const compoundEv = {
    status: 'ok',
    source: ['user_transactions'],
    period: { start: '2026-07-01', end: '2026-07-31', label: 'last_month' },
    facts: { transactionCount: 1, spentTotal: 20, expenseTotal: 20, incomeTotal: 0 },
    lookups: [
      {
        subjectKind: 'merchant',
        subjectValue: 'walmart',
        period: { start: '2026-07-01', end: '2026-07-31' },
        status: 'ok',
        transactionCount: 1,
        spentTotal: 20,
        expenseTotal: 20,
        incomeTotal: 0,
      },
      {
        subjectKind: 'category',
        subjectValue: 'restaurants',
        period: { start: '2026-07-01', end: '2026-07-31' },
        status: 'ok',
        transactionCount: 1,
        spentTotal: 15,
        expenseTotal: 15,
        incomeTotal: 0,
      },
    ],
    limitations: ['posted_actuals_only', 'duplicates_excluded'],
  };
  const compoundProj = projectLookupEvidence({
    capability: 'financial_lookup',
    evidence: compoundEv,
    route: route('How much did I spend at Walmart last month?'),
  });
  check('compound lookups preserved', compoundProj.promptEvidence && compoundProj.promptEvidence.facts.lookups.length === 2);
  check('compound second spent 15', compoundProj.promptEvidence.facts.lookups[1].spentTotal === 15);

  section('3B.3B.2 unavailable / projection failure / rollback');
  const oversize = new Array(1201).fill(0).map(() => ({ name: 'Target', amount: -1, start: '2026-07-01' }));
  const cap = await prefetchLookup(targetMsg, oversize, { pageSize: 50 });
  const capProj = projectLookupEvidence({ capability: 'financial_lookup', evidence: cap.evidence, route: cap.route });
  check('cap fail-soft', capProj.failSoft === true && capProj.promptable === false && capProj.block == null);
  check('cap no Azure block', capProj.mode === 'ledger_v1');
  const capPrompt = assembleLookup(cap.evidence, cap.route);
  check('cap assembly fail-soft', capPrompt.projectionFailed === true && capPrompt.groundedEvidenceBlock === '');
  check('cap does not send raw evidence', !/"spentTotal"/.test(capPrompt.systemContent) || capPrompt.projectionFailed === true);

  const malformed = {
    status: 'ok',
    source: ['user_transactions'],
    facts: {
      metricScope: 'spend',
      items: [{ label: 'x', amount: 1n }],
      spentTotal: 1n,
      expenseTotal: 1n,
      incomeTotal: 0,
      transactionCount: 1,
    },
    lookups: [{
      subjectKind: 'merchant',
      subjectValue: 'target',
      status: 'ok',
      transactionCount: 1,
      spentTotal: 1n,
      expenseTotal: 1n,
      incomeTotal: 0,
    }],
    limitations: ['posted_actuals_only'],
  };
  const boom = projectLookupEvidence({ capability: 'financial_lookup', evidence: malformed, route: targetRoute });
  check('projection exception fail-soft', boom.failSoft === true && boom.ok === false && boom.block == null);
  check('projection exception no legacy block', boom.mode === 'ledger_v1');
  check('projection exception reason', boom.telemetry.evidence_projection_status !== 'ok');
  check('legacy builder still exists for rollback', /GROUNDED EVIDENCE/.test(buildEvidenceSystemSection(targetEv)));

  withFlags(undefined, 'false', () => {
    const rolled = projectLookupEvidence({
      capability: 'financial_lookup',
      evidence: targetEv,
      route: targetRoute,
    });
    check('lookup flag OFF mode legacy', rolled.mode === 'legacy');
    check('lookup flag OFF rollback true', rolled.telemetry.evidence_rollback_active === true);
    check('lookup flag OFF source user_transactions', rolled.telemetry.evidence_source_kind === 'user_transactions');
    check('lookup flag OFF no ledger present', rolled.telemetry.evidence_ledger_present === false);
    check('eligible still true when flag off', isEligibleLookupCutover({
      capability: 'financial_lookup',
      evidence: targetEv,
    }) === true);
    check('shouldUseLookup false when flag off', shouldUseLookupLedgerPrompt({
      capability: 'financial_lookup',
      evidence: targetEv,
    }) === false);
  });

  section('3B.3B.2 snapshot / macro protection');
  const balMsg = "What's my available balance?";
  const balRoute = route(balMsg);
  const balEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(balRoute, { message: balMsg }),
    route: balRoute,
    message: balMsg,
    fetchPage: paginatedFetch([]).fetchPage,
    assertFn: async () => ({ access: 'owner' }),
  });
  check('balance source kea_snapshot', balEv.source && balEv.source[0] === 'kea_snapshot');
  check('snapshot-backed lookup', isSnapshotBackedLookup({ capability: 'financial_lookup', evidence: balEv }) === true);
  check('not eligible cutover', isEligibleLookupCutover({ capability: 'financial_lookup', evidence: balEv }) === false);
  const balProj = projectLookupEvidence({ capability: 'financial_lookup', evidence: balEv, route: balRoute });
  check('balance lookup stays legacy', balProj.mode === 'legacy' && balProj.telemetry.evidence_rollback_active === false);
  check('balance source kind kea_snapshot', balProj.telemetry.evidence_source_kind === 'kea_snapshot');

  const forecastRoute = route('What do I have upcoming in the next two weeks?');
  check('forecast capability', forecastRoute.capability === 'financial_forecast');
  const snapTel = telemetryForNonCutoverTurn({
    capability: 'financial_forecast',
    groundingStrategy: 'snapshot',
    evidence: { source: ['kea_snapshot'] },
    rollbackActive: false,
  });
  check('forecast telemetry legacy kea_snapshot', snapTel.evidence_prompt_mode === 'legacy'
    && snapTel.evidence_source_kind === 'kea_snapshot'
    && snapTel.evidence_rollback_active === false);

  const upcomingEv = {
    status: 'ok',
    source: ['cashflow_upcoming'],
    period: { start: '2026-08-23', end: '2026-08-29' },
    facts: { itemCount: 0, totals: { scheduledExpenseTotal: 0 }, items: [] },
    observations: [{ code: 'no_upcoming_in_period' }],
  };
  withFlags('true', 'false', () => {
    const up = projectApprovedMacroEvidence({ capability: 'cashflow_upcoming', evidence: upcomingEv });
    check('macro still ledger_v1 when lookup OFF', up.mode === 'ledger_v1');
  });
  withFlags('false', 'true', () => {
    const up = projectApprovedMacroEvidence({ capability: 'cashflow_upcoming', evidence: upcomingEv });
    check('macro rolls back when macro flag OFF', up.mode === 'legacy' && up.telemetry.evidence_rollback_active === true);
    const look = projectLookupEvidence({ capability: 'financial_lookup', evidence: targetEv, route: targetRoute });
    check('lookup stays ledger_v1 when macro OFF', look.mode === 'ledger_v1' && look.telemetry.evidence_rollback_active === false);
  });

  section('3B.3B.2 sizes + performance + source guards');
  const oldBlock = buildEvidenceSystemSection(targetEv);
  const oldCtx = T.buildChatAccountContext(ACCOUNT, 'Alex', '2026-08-16');
  check('old evidence block measured', oldBlock.length > 0);
  check('new evidence block measured', prompt.groundedEvidenceBlock.length > 0);
  check('old CURRENT CONTEXT measured', oldCtx.length > 0);
  check('new brief smaller than fat CONTEXT', prompt.accountBrief.length < oldCtx.length);
  check('new brief has no recents', !/Recent posted/.test(prompt.accountBrief));
  const t0 = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    projectLookupEvidence({
      capability: 'financial_lookup',
      evidence: targetEv,
      route: targetRoute,
      accountContext: { accountId: '10', accountLabel: 'Checking' },
    });
  }
  const ms = Date.now() - t0;
  check(`1000 lookup projections < 2000ms (${ms}ms)`, ms < 2000);

  const controllerSrc = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'openaiController.js'), 'utf8');
  const prefetchSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaGroundingPrefetch.js'), 'utf8');
  check('controller uses lookup analysis prompt', /buildLookupAnalysisPrompt/.test(controllerSrc)
    && /projectLookupEvidence/.test(controllerSrc));
  check('controller does not call shadow in production', !/runLookupEvidenceShadowSafe/.test(controllerSrc)
    && !/keaLookupEvidenceShadow/.test(controllerSrc));
  check('legacy path preserved', /buildEvidenceSystemSection\(phase1Evidence\)/.test(controllerSrc));
  check('prefetch functions unchanged', /function fetchCompletePeriodTransactions/.test(prefetchSrc)
    && /function aggregateTransactions/.test(prefetchSrc)
    && /function lookupResult/.test(prefetchSrc));
  check('no new claim types', !/CLAIM_TYPES/.test(fs.readFileSync(path.join(__dirname, '..', 'services', 'keaEvidencePromptCutover.js'), 'utf8')));
}

module.exports = { run };
