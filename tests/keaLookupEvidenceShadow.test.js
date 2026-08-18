'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');
const { cloneJson, CLAIM_TYPES } = require('../services/keaEvidenceLedger');
const { routeCapability } = require('../services/keaCapabilityRouter');
const { resolveGroundingPolicy } = require('../services/keaGroundingPolicy');
const {
  prefetchGrounding,
  azureFacingEvidence,
  buildEvidenceSystemSection,
} = require('../services/keaGroundingPrefetch');
const {
  shouldUseLedgerPrompt,
  projectApprovedMacroEvidence,
  LEDGER_PROMPT_ENV_KEY,
} = require('../services/keaEvidencePromptCutover');
const { telemetryForNonCutoverTurn } = require('../services/keaEvidenceTelemetry');
const {
  shadowLookupEvidence,
  isUserTransactionsLookup,
  isSnapshotBackedLookup,
  evidenceFingerprint,
} = require('../services/keaLookupEvidenceShadow');

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

const FOUR_Q = [
  'How much did I spend at Walmart last month?',
  '',
  'How much did I spend at restaurants last month?',
  '',
  'How much did I spend on groceries in July?',
  '',
  'What did I spend at Amazon in June?',
].join('\n');

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

function incompleteFetch(firstPageRows, claimedTotal) {
  const calls = [];
  const fetchPage = async ({ page, limit, startDate, endDate }) => {
    calls.push({ page, limit, startDate, endDate });
    if (page === 1) {
      return {
        transactions: firstPageRows,
        pagination: {
          page: 1,
          limit: limit || 100,
          total: claimedTotal,
          pages: 3,
          hasNext: true,
        },
      };
    }
    return {
      transactions: [],
      pagination: {
        page,
        limit: limit || 100,
        total: claimedTotal,
        pages: 3,
        hasNext: false,
      },
    };
  };
  return { fetchPage, calls };
}

function datedFetch(byPeriod, pageSize = 100) {
  const calls = [];
  const fetchPage = async ({ userId, accountId, page, limit, startDate, endDate }) => {
    calls.push({ userId, accountId, page, limit, startDate, endDate });
    const allRows = byPeriod[`${startDate}|${endDate}`] || [];
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

async function prefetchLookup(message, rowsOrFetch, extra = {}) {
  const routed = extra.route || route(message, extra);
  const fetch = typeof rowsOrFetch === 'function'
    ? { fetchPage: rowsOrFetch, calls: [] }
    : paginatedFetch(rowsOrFetch, extra.pageSize || 100);
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

function shadow(evidence, routed, extra = {}) {
  return shadowLookupEvidence({
    capability: extra.capability || 'financial_lookup',
    evidence,
    route: routed,
    accountContext: extra.accountContext || { accountId: '10', accountLabel: 'Checking' },
    unmatchedLabels: extra.unmatchedLabels,
  });
}

function checkParity(name, result) {
  check(`${name} ran`, result.ran === true);
  check(`${name} production still legacy`, result.productionMode === 'legacy');
  check(
    `${name} parity ok`,
    result.ok === true && result.parity && result.parity.ok === true,
    JSON.stringify(result.parity && result.parity.missing)
  );
}

async function run() {
  section('3B.3B.1 lookup shadow — Target 279.58');
  const targetMsg = 'How much did I spend at Target last month?';
  const unmatched = 'ZZ-UNMATCHED-COSTCO';
  const leakRows = [
    { name: 'Target', amount: -100.00, start: '2026-07-03', forecast_type: 'A' },
    { name: 'Target', amount: -100.00, start: '2026-07-12', forecast_type: 'A' },
    { name: 'Target', amount: -79.58, start: '2026-07-28', forecast_type: 'A' },
  ];
  for (let i = 0; i < 131; i += 1) {
    leakRows.push({
      name: unmatched,
      amount: -1.11,
      start: `2026-07-${String((i % 28) + 1).padStart(2, '0')}`,
      forecast_type: 'A',
    });
  }
  const { route: targetRoute, evidence: targetEv, calls: targetCalls } = await prefetchLookup(targetMsg, leakRows);
  const before = evidenceFingerprint(targetEv);
  const targetShadow = shadow(targetEv, targetRoute, { unmatchedLabels: [unmatched] });
  const after = evidenceFingerprint(targetEv);
  checkParity('Target', targetShadow);
  check('Target period July 2026', targetEv.period && targetEv.period.start === '2026-07-01'
    && targetEv.period.end === '2026-07-31');
  check('Target transactionCount 3', targetEv.facts.transactionCount === 3);
  check('Target spentTotal 279.58 exact', targetEv.facts.spentTotal === 279.58);
  check('Prompt View spentTotal 279.58', targetShadow.promptEvidence.facts.spentTotal === 279.58);
  check('Prompt View not rounded', targetShadow.promptEvidence.facts.spentTotal !== 280
    && String(targetShadow.promptEvidence.facts.spentTotal).indexOf('279.58') !== -1);
  check('Target subject preserved', targetShadow.promptEvidence.facts.lookups[0].subjectValue
    === targetEv.lookups[0].subjectValue);
  check('Target subjectKind merchant', targetShadow.promptEvidence.facts.lookups[0].subjectKind === 'merchant');
  check('prefetch pages used historical fetch', targetCalls.length >= 1);
  const callsAfterShadow = targetCalls.length;
  shadow(targetEv, targetRoute);
  check('shadow does not prefetch again', targetCalls.length === callsAfterShadow);
  check('evidence immutable', before === after);
  check('no unmatched merchant leak', targetShadow.privacyHits.indexOf(`unmatched:${unmatched}`) === -1);
  const targetJson = JSON.stringify(targetShadow.promptEvidence);
  check('no 134-row dump', !new RegExp(`${unmatched}`).test(targetJson));
  check('no matched-row list added', targetShadow.promptEvidence.facts.lookups[0].name === undefined
    && targetShadow.promptEvidence.facts.transactions === undefined
    && !Array.isArray(targetShadow.promptEvidence.facts.items));
  check('prefetchMeta omitted', !/"prefetchMeta"/.test(targetJson)
    && !/"pageCount"/.test(targetJson)
    && !/"rowCount"/.test(targetJson)
    && !/"matchCount"/.test(targetJson));
  check('no internal ids', !/transactionid|groupid|accountId|userid|jwt/i.test(targetJson));
  check('source posted period', targetShadow.promptEvidence.source.description
    === 'posted transactions for the selected period');
  check('sign magnitude', targetShadow.promptEvidence.facts.signConvention === 'magnitude');
  check('spentTotal not negative', targetShadow.promptEvidence.facts.spentTotal >= 0);
  check('posted_actuals limitation text', targetShadow.promptEvidence.limitations.some((t) => /posted actual/.test(t)));
  check('duplicates_excluded limitation text', targetShadow.promptEvidence.limitations.some((t) => /Duplicate/.test(t)));
  check('legacy evidence still has lookups totals', azureFacingEvidence(targetEv).facts.spentTotal === 279.58);
  check('ledger claims use existing types', targetShadow.ledger.claims.every((c) => CLAIM_TYPES.indexOf(c.type) !== -1));

  section('3B.3B.1 zero-match complete_empty');
  const zero = await prefetchLookup(targetMsg, [
    { name: unmatched, amount: -40, start: '2026-07-02', forecast_type: 'A' },
  ]);
  const zeroShadow = shadow(zero.evidence, zero.route, { unmatchedLabels: [unmatched] });
  checkParity('zero', zeroShadow);
  check('zero ledger complete_empty', zeroShadow.ledgerStatus === 'complete_empty');
  check('zero not unavailable', zero.evidence.status === 'ok' && zeroShadow.ledgerStatus !== 'unavailable');
  check('zero counts', zeroShadow.promptEvidence.facts.transactionCount === 0
    && zeroShadow.promptEvidence.facts.spentTotal === 0);
  check('zero unmatched label absent', zeroShadow.privacyHits.indexOf(`unmatched:${unmatched}`) === -1);

  section('3B.3B.1 category lookup');
  const catMsg = 'How much did I spend on groceries in July?';
  const cat = await prefetchLookup(catMsg, [
    { name: 'Kroger', category: 'Groceries', amount: -22.40, start: '2026-07-04', forecast_type: 'A' },
    { name: 'Chipotle', category: 'Restaurants', amount: -18.00, start: '2026-07-05', forecast_type: 'A' },
  ]);
  const catShadow = shadow(cat.evidence, cat.route);
  checkParity('category', catShadow);
  check('category subjectKind', catShadow.promptEvidence.facts.lookups[0].subjectKind === 'category');
  check('category spentTotal 22.4', catShadow.promptEvidence.facts.spentTotal === 22.4);
  check('category count 1', catShadow.promptEvidence.facts.transactionCount === 1);

  section('3B.3B.1 compound lookup');
  const compoundRoute = route(FOUR_Q);
  const { fetchPage: compoundFetch, calls: compoundCalls } = datedFetch({
    '2026-07-01|2026-07-31': [
      { name: 'Walmart', amount: -20, start: '2026-07-05', forecast_type: 'A' },
      { name: 'Chipotle', category: 'Restaurants', amount: -15, start: '2026-07-08', forecast_type: 'A' },
      { name: 'Kroger', category: 'Groceries', amount: -40, start: '2026-07-12', forecast_type: 'A' },
    ],
    '2026-06-01|2026-06-30': [
      { name: 'Amazon', amount: -30, start: '2026-06-11', forecast_type: 'A' },
    ],
  });
  const compoundEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(compoundRoute, { message: FOUR_Q }),
    route: compoundRoute,
    message: FOUR_Q,
    fetchPage: compoundFetch,
    assertFn: async () => ({ access: 'owner' }),
  });
  const compoundBefore = compoundCalls.length;
  const compoundShadow = shadow(compoundEv, compoundRoute);
  checkParity('compound', compoundShadow);
  check('compound preserves 4 lookups', compoundShadow.promptEvidence.facts.lookups.length === 4);
  check('compound no second period fetch', compoundCalls.length === compoundBefore);
  check('compound first spent 20', compoundShadow.promptEvidence.facts.lookups[0].spentTotal === 20);

  section('3B.3B.1 partial / unavailable / cap');
  const partialEv = cloneJson(targetEv);
  partialEv.status = 'partial';
  partialEv.limitations = [...(partialEv.limitations || []), 'incomplete_period_pages'];
  const partialShadow = shadow(partialEv, targetRoute);
  checkParity('constructed partial', partialShadow);
  check('partial ledger status', partialShadow.ledgerStatus === 'partial');
  check('partial human limitation', partialShadow.promptEvidence.limitations.some((t) => /incomplete/.test(t)));

  const { fetchPage: incompletePage, calls: incompleteCalls } = incompleteFetch(
    [{ name: 'Target', amount: -10, start: '2026-07-02', forecast_type: 'A' }],
    250
  );
  const incomplete = await prefetchLookup(targetMsg, incompletePage);
  const incompleteShadow = shadow(incomplete.evidence, incomplete.route);
  check('real incomplete envelope unavailable', incomplete.evidence.status === 'unavailable');
  checkParity('incomplete fail-soft', incompleteShadow);
  check('incomplete not promptable', incompleteShadow.promptable === false);
  check('incomplete ledger unavailable', incompleteShadow.ledgerStatus === 'unavailable');
  check('incomplete used one prefetch', incompleteCalls.length >= 1);

  const oversize = new Array(1201).fill(0).map(() => ({ name: 'Target', amount: -1, start: '2026-07-01' }));
  const cap = await prefetchLookup(targetMsg, oversize, { pageSize: 50 });
  const capShadow = shadow(cap.evidence, cap.route);
  check('cap envelope unavailable', cap.evidence.status === 'unavailable');
  check('cap no spentTotal', cap.evidence.facts.spentTotal === undefined);
  checkParity('cap fail-soft', capShadow);
  check('cap not promptable', capShadow.promptable === false);
  check('cap limitation present on evidence', (cap.evidence.limitations || []).indexOf('period_exceeds_prefetch_cap') !== -1);

  section('3B.3B.1 income / refund / duplicates');
  const mixed = await prefetchLookup(targetMsg, [
    { name: 'Target', amount: -100.00, start: '2026-07-03', forecast_type: 'A' },
    { name: 'Target', amount: 20.00, start: '2026-07-08', forecast_type: 'A' },
    { name: 'Target', amount: -50.00, start: '2026-07-10', forecast_type: 'A', duplicate: 1 },
    { name: 'Target', amount: -10.00, start: '2026-07-11', forecast_type: 'F' },
  ]);
  const mixedShadow = shadow(mixed.evidence, mixed.route);
  checkParity('refund/duplicate', mixedShadow);
  check('refund incomeTotal 20', mixedShadow.promptEvidence.facts.incomeTotal === 20);
  check('duplicate and F excluded from spend', mixedShadow.promptEvidence.facts.spentTotal === 100);
  check('posted match count excludes duplicate/F', mixed.evidence.facts.transactionCount === 2);

  section('3B.3B.1 CURRENT CONTEXT not a fact source');
  const ctxShadow = shadowLookupEvidence({
    capability: 'financial_lookup',
    evidence: targetEv,
    route: targetRoute,
    accountContext: {
      accountId: '10',
      accountLabel: 'Checking',
      recents: [{ name: unmatched, amount: -99999 }],
      spentTotal: 99999,
    },
  });
  checkParity('context-ignored', ctxShadow);
  check('totals still from lookup evidence', ctxShadow.promptEvidence.facts.spentTotal === 279.58);
  check('fake CONTEXT total absent', JSON.stringify(ctxShadow.promptEvidence).indexOf('99999') === -1);

  section('3B.3B.1 snapshot-backed lookup is not user_transactions shadow');
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
  check('isSnapshotBackedLookup', isSnapshotBackedLookup({ capability: 'financial_lookup', evidence: balEv }) === true);
  check('not user_transactions', isUserTransactionsLookup({ capability: 'financial_lookup', evidence: balEv }) === false);
  const balShadow = shadow(balEv, balRoute);
  check('snapshot lookup shadow skipped', balShadow.ran === false && balShadow.skippedReason === 'snapshot_backed_lookup');
  check('snapshot lookup production legacy', balShadow.productionMode === 'legacy');

  const forecastRoute = route('What is my forecast?');
  const forecastShadow = shadowLookupEvidence({
    capability: 'financial_forecast',
    evidence: { status: 'ok', source: ['kea_snapshot'], facts: {} },
    route: forecastRoute,
  });
  check('forecast shadow skipped', forecastShadow.ran === false);

  section('3B.3B.1 shadow failure does not change production');
  const circular = { status: 'ok', source: ['user_transactions'], facts: { spentTotal: 1 }, lookups: [] };
  circular.facts.loop = circular.facts;
  const boom = shadowLookupEvidence({ capability: 'financial_lookup', evidence: circular, route: targetRoute });
  check('shadow exception swallowed', boom.reason === 'shadow_exception' && boom.productionMode === 'legacy');
  check('legacy section still builds after exception', /GROUNDED EVIDENCE/.test(buildEvidenceSystemSection(targetEv)));

  section('3B.3B.1 shadow remains parity-only; macro projector does not own lookup');
  const controllerSrc = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'openaiController.js'), 'utf8');
  const shadowSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaLookupEvidenceShadow.js'), 'utf8');
  const prefetchSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaGroundingPrefetch.js'), 'utf8');
  check('shadow helper is not the Azure owner', targetShadow.productionMode === 'legacy');
  check('legacy builder preserved for rollback/snapshot', /groundedEvidenceBlock = buildEvidenceSystemSection\(phase1Evidence\)/.test(controllerSrc));
  check('shadow result not assigned to groundedEvidenceBlock', !/groundedEvidenceBlock = shadowLookupEvidence/.test(controllerSrc));
  check('lookup not approved for MACRO cutover', shouldUseLedgerPrompt('financial_lookup') === false);
  const lookupProjected = projectApprovedMacroEvidence({
    capability: 'financial_lookup',
    evidence: targetEv,
  });
  check('projectApprovedMacroEvidence lookup still legacy', lookupProjected.mode === 'legacy');
  const tel = telemetryForNonCutoverTurn({
    capability: 'financial_lookup',
    groundingStrategy: 'prefetch_read',
    evidence: targetEv,
    rollbackActive: false,
  });
  check('non-cutover helper still describes legacy lookup', tel.evidence_prompt_mode === 'legacy');
  check('telemetry source user_transactions', tel.evidence_source_kind === 'user_transactions');
  check('no feature flag in shadow module', !/process\.env/.test(shadowSrc) && !/USE_LOOKUP_EVIDENCE_LEDGER_PROMPT/.test(shadowSrc));
  check('macro flag constant unchanged', LEDGER_PROMPT_ENV_KEY === 'USE_EVIDENCE_LEDGER_PROMPT');
  check('prefetch fetch functions unchanged names', /function fetchCompletePeriodTransactions/.test(prefetchSrc)
    && /function aggregateTransactions/.test(prefetchSrc));
  const upcomingProjected = projectApprovedMacroEvidence({
    capability: 'cashflow_upcoming',
    evidence: {
      status: 'ok',
      source: ['cashflow_upcoming'],
      period: { start: '2026-08-23', end: '2026-08-29' },
      facts: { itemCount: 0, totals: { scheduledExpenseTotal: 0 }, items: [] },
      observations: [{ code: 'no_upcoming_in_period' }],
    },
  });
  check('macros remain ledger_v1', upcomingProjected.mode === 'ledger_v1');
  const snapTel = telemetryForNonCutoverTurn({
    capability: 'financial_forecast',
    groundingStrategy: 'snapshot',
    evidence: balEv,
    rollbackActive: false,
  });
  check('snapshot telemetry remains legacy', snapTel.evidence_prompt_mode === 'legacy'
    && snapTel.evidence_source_kind === 'kea_snapshot');

  section('3B.3B.1 sizes + performance');
  check('legacy size measured', targetShadow.sizes.legacy > 0 && targetShadow.sizes.legacy < 20000);
  check('ledger size measured', targetShadow.sizes.ledger > 0);
  check('prompt view size measured', targetShadow.sizes.promptView > 0);
  check('future wrapper size measured', targetShadow.sizes.wrapper > 0);
  const t0 = Date.now();
  for (let i = 0; i < 1000; i += 1) shadow(targetEv, targetRoute);
  const ms = Date.now() - t0;
  check(`1000 shadow+parity < 2000ms (${ms}ms)`, ms < 2000);
}

module.exports = { run };
