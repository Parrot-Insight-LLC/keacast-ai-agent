'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');
const { routeCapability } = require('../services/keaCapabilityRouter');
const { resolveGroundingPolicy } = require('../services/keaGroundingPolicy');
const {
  prefetchGrounding,
  buildSnapshotEvidence,
  buildEvidenceSystemSection,
  azureFacingEvidence,
} = require('../services/keaGroundingPrefetch');
const { compactSelectedAccount } = require('../services/keaAccountSnapshot');
const { adaptSnapshotEvidenceForLedger } = require('../services/keaSnapshotEvidenceAdapter');
const { buildEvidenceLedger } = require('../services/keaEvidenceLedgerBuilders');
const { toPromptEvidence, collectBannedKeys } = require('../services/keaEvidencePromptView');
const {
  shouldUseLedgerPrompt,
  shouldUseLookupLedgerPrompt,
  projectApprovedMacroEvidence,
  projectLookupEvidence,
  LEDGER_PROMPT_ENV_KEY,
  LOOKUP_PROMPT_ENV_KEY,
} = require('../services/keaEvidencePromptCutover');
const { telemetryForNonCutoverTurn } = require('../services/keaEvidenceTelemetry');

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function route(message, extra = {}) {
  return routeCapability({
    message,
    currentDate: extra.currentDate || '2026-08-16',
    accountId: extra.accountId || '10',
    knownCategories: extra.knownCategories || ['Restaurants', 'Groceries'],
  });
}

function paginatedFetch(allRows) {
  return async ({ page, limit }) => {
    const size = limit || 100;
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
}

function compactFixture(extra = {}) {
  return {
    _keaCompact: true,
    schemaVersion: 1,
    accountid: 10,
    accountname: 'Checking',
    institution_name: 'Bank',
    account_type: 'checking',
    balance: 5100.11,
    available: 4846.97,
    current: 5010.5,
    reconciledBalance: 5100.11,
    dataAsOf: '2026-08-16T12:00:00.000Z',
    savings: {
      totalIncome: 4000,
      totalExpenses: 2500,
      netCashFlow: 1500,
      savingsPotential: 900,
    },
    upcomingExpenseTotal: 1134.56,
    upcomingIncomeTotal: 4626.36,
    recents: extra.recents || [
      { name: 'Costco', amount: -79.99, date: '2026-08-10' },
      { name: 'Payroll', amount: 105, date: '2026-08-08' },
      { name: 'Target', amount: -19.99, date: '2026-08-07' },
    ],
    upcoming: extra.upcoming || [
      { name: 'MERIDIAN', amount: 4626.36, start: '2026-08-20', forecast_type: 'F' },
      { name: 'Northwestern', amount: -162.24, start: '2026-08-21', forecast_type: 'F' },
      { name: 'Daycare', amount: -705, start: '2026-08-22', forecast_type: 'F' },
      { name: 'Daycare', amount: -705, start: '2026-08-29', forecast_type: 'F' },
      { name: 'Mercury', amount: -267.32, start: '2026-08-24', forecast_type: 'F' },
    ],
    futureNegativeBalances: extra.futureNegativeBalances || [
      { amount: -220.85, date: '2026-11-08', daysUntil: 84 },
    ],
    ...extra.rest,
  };
}

function scanView(src) {
  const hits = [];
  if (/accountId/.test(src)) hits.push('accountId');
  if (/transactionid/i.test(src)) hits.push('transactionid');
  if (/groupid/i.test(src)) hits.push('groupid');
  if (/\buserId\b/.test(src)) hits.push('userId');
  if (/\bjwt\b/i.test(src)) hits.push('jwt');
  if (/prefetchMeta/.test(src)) hits.push('prefetchMeta');
  if (/"itemId"/.test(src)) hits.push('itemId');
  if (/"claims"/.test(src)) hits.push('claims');
  if (/"internal"/.test(src)) hits.push('internal');
  if (/"builder"/.test(src)) hits.push('builder');
  return hits;
}

async function prefetchForecast(snapshot) {
  const routed = route('What do I have upcoming in the next two weeks?');
  const evidence = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(routed, { message: 'What do I have upcoming in the next two weeks?' }),
    route: routed,
    fetchPage: paginatedFetch([]),
    assertFn: async () => ({ access: 'owner' }),
  });
  return { routed, evidence };
}

function projectAdapted(evidence, selectedAccount, capability = 'financial_forecast') {
  const adapted = adaptSnapshotEvidenceForLedger({ evidence, selectedAccount });
  const built = buildEvidenceLedger({
    capability,
    evidence: adapted,
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  });
  const view = toPromptEvidence(built.ledger);
  return { adapted, built, view, promptEvidence: view.promptEvidence };
}

async function run() {
  section('3B.3B.3 adapter copies compact arrays without mutating sources');
  const compact = compactFixture();
  const compactBefore = cloneJson(compact);
  const { routed, evidence } = await prefetchForecast(compact);
  const evidenceBefore = cloneJson(evidence);
  check('prefetch omits recents from production facts', evidence.facts.recents === undefined);
  check('prefetch omits upcoming list from production facts', evidence.facts.upcoming === undefined);
  check('prefetch omits futureNegativeBalances from production facts', evidence.facts.futureNegativeBalances === undefined);
  check('production azureFacing has no recents', azureFacingEvidence(evidence).facts.recents === undefined);

  const { adapted, built, view, promptEvidence } = projectAdapted(evidence, compact);
  check('adapter returns new object', adapted !== evidence && adapted !== compact);
  check('phase1Evidence unchanged', JSON.stringify(evidence) === JSON.stringify(evidenceBefore));
  check('selectedAccount unchanged', JSON.stringify(compact) === JSON.stringify(compactBefore));
  check('production facts still lack recents after adapt', evidence.facts.recents === undefined);
  compact.recents[0].amount = 999;
  compact.upcoming.push({ name: 'Injected', amount: -1, start: '2026-08-30' });
  check('mutating compact after adapt does not change derived', adapted.facts.recents[0].amount === -79.99
    && adapted.facts.upcoming.length === 5);
  compact.recents[0].amount = compactBefore.recents[0].amount;
  compact.upcoming.pop();

  section('3B.3B.3 exact decimals, signs, order, duplicate labels');
  check('ledger ok', built.ok === true && built.ledger != null);
  check('promptable', view.ok === true && view.promptable === true);
  check('source kea_snapshot', built.ledger.source.kind === 'kea_snapshot');
  check('status complete', built.ledger.status === 'complete');
  check('signConvention signed_ledger', built.ledger.facts.signConvention === 'signed_ledger');
  check('availableBalance 4846.97', built.ledger.facts.availableBalance === 4846.97);
  check('upcomingWindowDays 15', built.ledger.facts.upcomingWindowDays === 15);
  check('upcomingExpenseTotal not recomputed', built.ledger.facts.upcomingExpenseTotal === 1134.56);
  check('recents length 3', adapted.facts.recents.length === 3);
  check('upcoming length 5', adapted.facts.upcoming.length === 5);
  check('negatives length 1', adapted.facts.futureNegativeBalances.length === 1);
  check('upcoming order preserved', adapted.facts.upcoming.map((r) => r.name).join('|')
    === 'MERIDIAN|Northwestern|Daycare|Daycare|Mercury');
  check('MERIDIAN +4626.36', adapted.facts.upcoming[0].amount === 4626.36);
  check('Northwestern -162.24', adapted.facts.upcoming[1].amount === -162.24);
  check('Mercury -267.32', adapted.facts.upcoming[4].amount === -267.32);
  check('negative preview -220.85', adapted.facts.futureNegativeBalances[0].amount === -220.85);
  check('recent Costco -79.99', adapted.facts.recents[0].amount === -79.99);
  check('recent payroll +105', adapted.facts.recents[1].amount === 105);
  check('duplicate Daycare both survive', adapted.facts.upcoming[2].name === 'Daycare'
    && adapted.facts.upcoming[3].name === 'Daycare'
    && adapted.facts.upcoming[2].start !== adapted.facts.upcoming[3].start);
  check('duplicate identities differ', built.ledger.facts.upcoming[2].itemId === 'item3'
    && built.ledger.facts.upcoming[3].itemId === 'item4');
  check('Prompt View exact 4626.36', promptEvidence.facts.upcoming[0].amount === 4626.36);
  check('Prompt View exact -162.24', promptEvidence.facts.upcoming[1].amount === -162.24);
  check('Prompt View exact -267.32', promptEvidence.facts.upcoming[4].amount === -267.32);
  check('Prompt View not rounded 4626', promptEvidence.facts.upcoming[0].amount !== 4626);
  check('Prompt View -220.85', promptEvidence.facts.futureNegativeBalances[0].amount === -220.85);
  check('Prompt View recents present', promptEvidence.facts.recents.length === 3);
  check('Prompt View upcoming present', promptEvidence.facts.upcoming.length === 5);
  check('Prompt View negatives present', promptEvidence.facts.futureNegativeBalances.length === 1);
  check('Prompt View strips itemId', promptEvidence.facts.upcoming.every((row) => row.itemId === undefined));
  const viewHits = scanView(JSON.stringify(promptEvidence));
  check('Prompt View internal/id scan', viewHits.length === 0, viewHits.join(','));
  check('Prompt View banned keys', collectBannedKeys(promptEvidence).length === 0);
  check('15-day limitation mapped', promptEvidence.limitations.some((t) => /15-day window/.test(t)));
  check('90-day negative limitation mapped', promptEvidence.limitations.some((t) => /90-day window/.test(t)));
  check('recents capped limitation mapped', promptEvidence.limitations.some((t) => /capped at 10/.test(t)));
  check('source description 15-day', /15-day upcoming window/.test(promptEvidence.source.description));
  check('horizons distinguishable', promptEvidence.facts.upcomingWindowDays === 15
    && /15-day window/.test(promptEvidence.limitations.join(' '))
    && /90-day window/.test(promptEvidence.limitations.join(' '))
    && promptEvidence.facts.futureNegativeBalances[0].date === '2026-11-08');
  check('list meta recents cap 10', built.ledger.lists.recents.cap === 10);
  check('list meta upcoming cap 10', built.ledger.lists.upcoming.cap === 10);
  check('list meta negatives cap 5', built.ledger.lists.futureNegativeBalances.cap === 5);
  check('truncated not fabricated', built.ledger.lists.upcoming.truncated === false);

  section('3B.3B.3 caps, empty lists, lookup feasibility');
  const tenRecents = new Array(10).fill(0).map((_, i) => ({
    name: `Recent${i}`,
    amount: -1.11,
    date: `2026-08-${String(16 - (i % 10)).padStart(2, '0')}`,
  }));
  const tenUpcoming = new Array(10).fill(0).map((_, i) => ({
    name: `Bill${i}`,
    amount: -10,
    start: `2026-08-${String(17 + i).padStart(2, '0')}`,
  }));
  const fiveNeg = new Array(5).fill(0).map((_, i) => ({
    amount: -1.5,
    date: `2026-09-${String(10 + i).padStart(2, '0')}`,
    daysUntil: 25 + i,
  }));
  const cappedCompact = compactFixture({
    recents: tenRecents,
    upcoming: tenUpcoming,
    futureNegativeBalances: fiveNeg,
  });
  const capped = projectAdapted(evidence, cappedCompact);
  check('recents cap preserved 10', capped.adapted.facts.recents.length === 10);
  check('upcoming cap preserved 10', capped.adapted.facts.upcoming.length === 10);
  check('negatives cap preserved 5', capped.adapted.facts.futureNegativeBalances.length === 5);

  const emptyCompact = compactFixture({
    recents: [],
    upcoming: [],
    futureNegativeBalances: [],
    rest: { upcomingExpenseTotal: 0, upcomingIncomeTotal: 0 },
  });
  const emptyEv = buildSnapshotEvidence(emptyCompact, { kind: 'forecast', currentDate: '2026-08-16' });
  const emptyProj = projectAdapted(emptyEv, emptyCompact);
  check('empty upcoming still complete', emptyProj.built.ledger.status === 'complete');
  check('empty recents []', Array.isArray(emptyProj.promptEvidence.facts.recents)
    && emptyProj.promptEvidence.facts.recents.length === 0);
  check('empty upcoming []', emptyProj.promptEvidence.facts.upcoming.length === 0);
  check('empty negatives []', emptyProj.promptEvidence.facts.futureNegativeBalances.length === 0);
  check('empty hasNegativePreview false', emptyProj.built.ledger.facts.hasNegativePreview === false);

  const balRoute = route("What's my available balance?");
  const balEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: compact,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(balRoute, { message: "What's my available balance?" }),
    route: balRoute,
    fetchPage: paginatedFetch([]),
    assertFn: async () => ({ access: 'owner' }),
  });
  const balAdapted = projectAdapted(balEv, compact, 'financial_lookup');
  check('snapshot-backed lookup adapter feasible', balAdapted.built.ok === true
    && balAdapted.built.ledger.source.kind === 'kea_snapshot'
    && balAdapted.promptEvidence.facts.availableBalance === 4846.97
    && Array.isArray(balAdapted.promptEvidence.facts.recents));
  check('production lookup projector still legacy for snapshot', projectLookupEvidence({
    capability: 'financial_lookup',
    evidence: balEv,
    route: balRoute,
  }).mode === 'legacy');

  const viaCompactFn = compactSelectedAccount({
    accountid: 10,
    accountname: 'Checking',
    balance: 100,
    available: 90,
    current: 95,
    recents: [{ name: 'A', amount: -5, date: '2026-08-15' }],
    upcoming: [{ name: 'B', amount: -8, start: '2026-08-18' }],
    futureNegativeBalances: [{ amount: -3, date: '2026-09-01', daysUntil: 16 }],
  }, '2026-08-16');
  const fromCompactFn = adaptSnapshotEvidenceForLedger({
    evidence: { status: 'ok', source: ['kea_snapshot'], facts: { availableBalance: 90 } },
    selectedAccount: viaCompactFn,
  });
  check('compactSelectedAccount arrays copied as-is', fromCompactFn.facts.upcoming[0].amount === -8
    && fromCompactFn.facts.recents[0].amount === -5);

  section('3B.3B.3 production snapshot remains legacy');
  check('forecast capability', routed.capability === 'financial_forecast');
  check('macro projector skips snapshot', projectApprovedMacroEvidence({
    capability: 'financial_forecast',
    evidence,
  }).mode === 'legacy');
  check('shouldUseLedgerPrompt forecast false', shouldUseLedgerPrompt('financial_forecast') === false);
  check('legacy section still used', /GROUNDED EVIDENCE \(authoritative/.test(buildEvidenceSystemSection(evidence)));
  const snapTel = telemetryForNonCutoverTurn({
    capability: 'financial_forecast',
    groundingStrategy: 'snapshot',
    evidence,
    rollbackActive: false,
  });
  check('forecast telemetry legacy', snapTel.evidence_prompt_mode === 'legacy'
    && snapTel.evidence_ledger_present === false
    && snapTel.evidence_source_kind === 'kea_snapshot'
    && snapTel.evidence_projection_status === 'legacy'
    && snapTel.evidence_rollback_active === false);
  check('macros remain ledger_v1', shouldUseLedgerPrompt('cashflow_upcoming') === true);
  check('lookup flag unchanged', LOOKUP_PROMPT_ENV_KEY === 'USE_LOOKUP_EVIDENCE_LEDGER_PROMPT');
  check('macro flag unchanged', LEDGER_PROMPT_ENV_KEY === 'USE_EVIDENCE_LEDGER_PROMPT');
  const lookupOn = shouldUseLookupLedgerPrompt({
    capability: 'financial_lookup',
    evidence: { source: ['user_transactions'], status: 'ok' },
  });
  check('transaction lookup still eligible', lookupOn === true);
  const lookupProj = projectLookupEvidence({
    capability: 'financial_lookup',
    evidence: {
      status: 'ok',
      source: ['user_transactions'],
      facts: { spentTotal: 279.58, expenseTotal: 279.58, incomeTotal: 0, transactionCount: 3 },
      lookups: [{
        subjectKind: 'merchant',
        subjectValue: 'target',
        status: 'ok',
        transactionCount: 3,
        spentTotal: 279.58,
        expenseTotal: 279.58,
        incomeTotal: 0,
      }],
      limitations: ['posted_actuals_only'],
      period: { start: '2026-07-01', end: '2026-07-31' },
    },
  });
  check('transaction lookup remains ledger_v1', lookupProj.mode === 'ledger_v1'
    && lookupProj.promptEvidence.facts.spentTotal === 279.58);

  const controllerSrc = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'openaiController.js'), 'utf8');
  const adapterSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaSnapshotEvidenceAdapter.js'), 'utf8');
  const prefetchSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaGroundingPrefetch.js'), 'utf8');
  check('controller does not call adapter', !/keaSnapshotEvidenceAdapter|adaptSnapshotEvidenceForLedger/.test(controllerSrc));
  check('legacy CURRENT CONTEXT 14-day wording unchanged', /Next 14 days/.test(controllerSrc));
  check('adapter does not use fmtMoney', !/fmtMoney/.test(adapterSrc));
  check('adapter does not log payloads', !/console\.(log|debug|info|warn)/.test(adapterSrc)
    && !/logger\.(log|debug|info|warn)/.test(adapterSrc));
  check('adapter does not fetch', !/http|redis|fetchPage|getTransactions/i.test(adapterSrc));
  check('buildSnapshotEvidence still omits recents assignment', !/facts\.recents\s*=/.test(prefetchSrc));
  check('no snapshot production flag', !/USE_SNAPSHOT_EVIDENCE_LEDGER_PROMPT/.test(adapterSrc)
    && !/USE_SNAPSHOT_EVIDENCE_LEDGER_PROMPT/.test(controllerSrc));
  check('version remains 1', built.ledger.version === 1);

  section('3B.3B.3 performance');
  const t0 = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    const derived = adaptSnapshotEvidenceForLedger({ evidence, selectedAccount: compact });
    const ledger = buildEvidenceLedger({
      capability: 'financial_forecast',
      evidence: derived,
      accountContext: { accountId: '10', accountLabel: 'Checking' },
    });
    toPromptEvidence(ledger.ledger);
  }
  const ms = Date.now() - t0;
  check(`1000 adapter+ledger+view < 2000ms (${ms}ms)`, ms < 2000);
}

module.exports = { run };
