'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');
const { cloneJson } = require('../services/keaEvidenceLedger');
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
const {
  shouldUseLedgerPrompt,
  shouldUseLookupLedgerPrompt,
  projectApprovedMacroEvidence,
  projectLookupEvidence,
  LEDGER_PROMPT_ENV_KEY,
  LOOKUP_PROMPT_ENV_KEY,
} = require('../services/keaEvidencePromptCutover');
const { telemetryForNonCutoverTurn } = require('../services/keaEvidenceTelemetry');
const {
  CLASSIFICATION,
  CURRENT_CONTEXT_INVENTORY,
  SUPPORTED_SNAPSHOT_QUESTION_CLASSES,
  EXPECTED_SOURCE_DESCRIPTION,
  isSnapshotShadowEligible,
  wouldFmtMoneyRound,
  sanitizeShadowReport,
  buildSnapshotShadowArtifacts,
  shadowSnapshotEvidence,
} = require('../services/keaSnapshotEvidenceShadow');

function route(message, extra = {}) {
  return routeCapability({
    message,
    currentDate: extra.currentDate || '2026-08-16',
    accountId: extra.accountId || '10',
    knownCategories: extra.knownCategories || ['Restaurants', 'Groceries'],
  });
}

function paginatedFetch(allRows, calls) {
  return async ({ page, limit }) => {
    if (calls) calls.push({ page, limit });
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

async function prefetchForecast(snapshot, fetchPage) {
  const routed = route('What do I have upcoming in the next two weeks?');
  const evidence = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(routed, { message: 'What do I have upcoming in the next two weeks?' }),
    route: routed,
    fetchPage: fetchPage || paginatedFetch([]),
    assertFn: async () => ({ access: 'owner' }),
  });
  return { routed, evidence };
}

function runShadow(evidence, selectedAccount, capability, extra = {}) {
  return shadowSnapshotEvidence({
    evidence,
    selectedAccount,
    capability,
    route: extra.route || null,
    accountContext: extra.accountContext || { accountId: '10', accountLabel: 'Checking' },
    captureArtifacts: extra.captureArtifacts === true,
  });
}

function hasClass(report, code, classification) {
  return (report.differences || []).some((row) => row.code === code && row.classification === classification);
}

function leakedValues(src) {
  const hits = [];
  const needles = [
    'MERIDIAN', 'Northwestern', 'Daycare', 'Mercury', 'Costco', 'Payroll', 'Target', 'Checking',
    '4626.36', '162.24', '267.32', '4846.97', '220.85', '79.99', '19.99',
  ];
  for (let i = 0; i < needles.length; i += 1) {
    if (src.indexOf(needles[i]) !== -1) hits.push(needles[i]);
  }
  return hits;
}

async function run() {
  section('3B.3B.4 eligibility and skip');
  const compact = compactFixture();
  const { routed, evidence } = await prefetchForecast(compact);
  check('forecast capability', routed.capability === 'financial_forecast');
  check('eligible forecast snapshot', isSnapshotShadowEligible({
    capability: 'financial_forecast',
    evidence,
  }) === true);
  const skippedMacro = runShadow(evidence, compact, 'cashflow_analysis');
  check('skip non-snapshot capability', skippedMacro.status === 'skipped' && skippedMacro.ran === false);
  const txLookup = {
    status: 'ok',
    source: ['user_transactions'],
    facts: { transactionCount: 3, spentTotal: 279.58 },
  };
  check('skip user_transactions lookup', isSnapshotShadowEligible({
    capability: 'financial_lookup',
    evidence: txLookup,
  }) === false);
  const skippedLookup = runShadow(txLookup, compact, 'financial_lookup');
  check('user_transactions shadow skipped', skippedLookup.status === 'skipped');

  section('3B.3B.4 A full populated snapshot');
  const evidenceBefore = cloneJson(evidence);
  const compactBefore = cloneJson(compact);
  const full = runShadow(evidence, compact, 'financial_forecast', { captureArtifacts: true });
  check('full status ok', full.status === 'ok', full.status);
  check('missing ledger facts 0', full.missingLedgerFactCount === 0, String(full.missingLedgerFactCount));
  check('unexplained mismatches 0', full.unexplainedMismatchCount === 0, String(full.unexplainedMismatchCount));
  check('productionMode legacy', full.productionMode === 'legacy');
  check('promptable', full.promptable === true);
  check('availableBalance 4846.97', full.promptEvidence.facts.availableBalance === 4846.97);
  check('monthIncome', full.promptEvidence.facts.monthIncome === 4000);
  check('monthExpenses', full.promptEvidence.facts.monthExpenses === 2500);
  check('monthNet', full.promptEvidence.facts.monthNet === 1500);
  check('savingsPotential', full.promptEvidence.facts.savingsPotential === 900);
  check('upcomingExpenseTotal', full.promptEvidence.facts.upcomingExpenseTotal === 1134.56);
  check('upcomingIncomeTotal', full.promptEvidence.facts.upcomingIncomeTotal === 4626.36);
  check('upcomingWindowDays 15', full.promptEvidence.facts.upcomingWindowDays === 15);
  check('upcoming row count 5', full.promptEvidence.facts.upcoming.length === 5);
  check('upcoming order', full.promptEvidence.facts.upcoming.map((r) => r.name).join('|')
    === 'MERIDIAN|Northwestern|Daycare|Daycare|Mercury');
  check('MERIDIAN +4626.36', full.promptEvidence.facts.upcoming[0].amount === 4626.36
    && full.promptEvidence.facts.upcoming[0].amount > 0);
  check('Northwestern -162.24', full.promptEvidence.facts.upcoming[1].amount === -162.24);
  check('Mercury -267.32', full.promptEvidence.facts.upcoming[4].amount === -267.32);
  check('Daycare duplicates preserved', full.promptEvidence.facts.upcoming[2].name === 'Daycare'
    && full.promptEvidence.facts.upcoming[3].name === 'Daycare'
    && full.promptEvidence.facts.upcoming[2].start !== full.promptEvidence.facts.upcoming[3].start);
  check('recents count 3', full.promptEvidence.facts.recents.length === 3);
  check('recent Costco -79.99', full.promptEvidence.facts.recents[0].amount === -79.99);
  check('recent Payroll +105', full.promptEvidence.facts.recents[1].amount === 105);
  check('recent Target -19.99', full.promptEvidence.facts.recents[2].amount === -19.99);
  check('negative -220.85', full.promptEvidence.facts.futureNegativeBalances[0].amount === -220.85);
  check('negative date', full.promptEvidence.facts.futureNegativeBalances[0].date === '2026-11-08');
  check('negativePreviewCount', full.promptEvidence.facts.negativePreviewCount === 1);
  check('requested-period negatives present', typeof full.promptEvidence.facts.negativesInRequestedPeriodCount === 'number'
    && typeof full.promptEvidence.facts.hasNegativeInRequestedPeriod === 'boolean');
  check('source description 15-day', full.promptEvidence.source.description === EXPECTED_SOURCE_DESCRIPTION);
  check('account scope', full.promptEvidence.accountScope === 'selected_account');
  check('account label not id', full.promptEvidence.account === 'Checking'
    && !/"accountId"/.test(JSON.stringify(full.promptEvidence)));
  check('signed_ledger', full.promptEvidence.facts.signConvention === 'signed_ledger');
  check('phase1Evidence unchanged', JSON.stringify(evidence) === JSON.stringify(evidenceBefore));
  check('selectedAccount unchanged', JSON.stringify(compact) === JSON.stringify(compactBefore));
  check('upcoming forecast readiness', full.readiness.upcomingForecast === true);
  check('exact count > 0', full.exactCount > 0);
  check('intentional > 0', full.intentionalImprovementCount > 0);
  check('legacy bugs > 0', full.legacyBugCount > 0);

  section('3B.3B.4 J 14-vs-15 and K fmtMoney classification');
  check('14 vs 15 classified legacy bug', hasClass(
    full,
    'legacy_upcoming_window_label_14d',
    CLASSIFICATION.LEGACY_BUG_TO_REMOVE_AT_CUTOVER
  ));
  check('window scalar is 15 not 14', full.promptEvidence.facts.upcomingWindowDays === 15
    && full.promptEvidence.facts.upcomingWindowDays !== 14);
  check('fmtMoney rounding classified', hasClass(
    full,
    'legacy_fmtMoney_rounding',
    CLASSIFICATION.LEGACY_BUG_TO_REMOVE_AT_CUTOVER
  ));
  check('exact decimals classified improvement', hasClass(
    full,
    'prompt_view_exact_decimals',
    CLASSIFICATION.INTENTIONAL_IMPROVEMENT
  ));
  check('4626.36 is not exact with 4626', full.promptEvidence.facts.upcoming[0].amount !== 4626
    && wouldFmtMoneyRound(4626.36) === true);
  check('wouldFmtMoneyRound 162.24', wouldFmtMoneyRound(-162.24) === true);
  check('wouldFmtMoneyRound 79.99', wouldFmtMoneyRound(-79.99) === true);
  check('wouldFmtMoneyRound 705 whole false', wouldFmtMoneyRound(-705) === false);
  check('horizon separation improvement', hasClass(
    full,
    'prompt_view_horizon_separation',
    CLASSIFICATION.INTENTIONAL_IMPROVEMENT
  ));
  check('mixed horizons legacy bug', hasClass(
    full,
    'legacy_mixed_horizons_in_current_context',
    CLASSIFICATION.LEGACY_BUG_TO_REMOVE_AT_CUTOVER
  ));
  check('15d limitation text', full.promptEvidence.limitations.some((t) => /15-day window/.test(t)));
  check('90d limitation text', full.promptEvidence.limitations.some((t) => /90-day window/.test(t)));
  check('disposable is 3C', hasClass(full, 'legacy_disposable_wording', CLASSIFICATION.PHASE_3C_RESIDUAL));
  check('ranking is 3C', hasClass(full, 'unauthorized_ranking_from_current_context', CLASSIFICATION.PHASE_3C_RESIDUAL));
  check('top categories not required', hasClass(full, 'top_categories_not_required', CLASSIFICATION.PHASE_3D_CONCERN));
  check('goals not required', hasClass(full, 'goals_not_required', CLASSIFICATION.PHASE_3D_CONCERN));

  section('3B.3B.4 B balance-only snapshot');
  const balanceOnly = compactFixture({
    recents: [],
    upcoming: [],
    futureNegativeBalances: [],
    rest: { upcomingExpenseTotal: 0, upcomingIncomeTotal: 0 },
  });
  const balanceEv = buildSnapshotEvidence(balanceOnly, { kind: 'lookup', currentDate: '2026-08-16' });
  const balShadow = runShadow(balanceEv, balanceOnly, 'financial_lookup', { captureArtifacts: true });
  check('balance-only ok', balShadow.status === 'ok');
  check('balance-only available', balShadow.promptEvidence.facts.availableBalance === 4846.97);
  check('L balance lookup readiness', balShadow.readiness.balanceLookup === true);
  check('balance-only missing 0', balShadow.missingLedgerFactCount === 0);

  section('3B.3B.4 C empty upcoming');
  const emptyUp = compactFixture({
    upcoming: [],
    rest: { upcomingExpenseTotal: 0, upcomingIncomeTotal: 0 },
  });
  const emptyUpEv = buildSnapshotEvidence(emptyUp, { kind: 'forecast', currentDate: '2026-08-16' });
  const emptyUpShadow = runShadow(emptyUpEv, emptyUp, 'financial_forecast', { captureArtifacts: true });
  check('empty upcoming ok', emptyUpShadow.status === 'ok' && emptyUpShadow.missingLedgerFactCount === 0);
  check('empty upcoming array', Array.isArray(emptyUpShadow.promptEvidence.facts.upcoming)
    && emptyUpShadow.promptEvidence.facts.upcoming.length === 0);
  check('empty upcoming still promptable', emptyUpShadow.promptable === true);
  check('empty upcoming complete', emptyUpShadow.ledger.status === 'complete');

  section('3B.3B.4 D empty recents');
  const emptyRec = compactFixture({ recents: [] });
  const emptyRecEv = buildSnapshotEvidence(emptyRec, { kind: 'forecast', currentDate: '2026-08-16' });
  const emptyRecShadow = runShadow(emptyRecEv, emptyRec, 'financial_forecast', { captureArtifacts: true });
  check('empty recents ok', emptyRecShadow.status === 'ok');
  check('empty recents array', emptyRecShadow.promptEvidence.facts.recents.length === 0);

  section('3B.3B.4 E no negative preview');
  const noNeg = compactFixture({ futureNegativeBalances: [] });
  const noNegEv = buildSnapshotEvidence(noNeg, { kind: 'forecast', currentDate: '2026-08-16' });
  const noNegShadow = runShadow(noNegEv, noNeg, 'financial_forecast', { captureArtifacts: true });
  check('no-negative ok', noNegShadow.status === 'ok');
  check('hasNegativePreview false', noNegShadow.promptEvidence.facts.hasNegativePreview === false);
  check('negativePreviewCount 0', noNegShadow.promptEvidence.facts.negativePreviewCount === 0);
  check('negatives []', noNegShadow.promptEvidence.facts.futureNegativeBalances.length === 0);

  section('3B.3B.4 F duplicate upcoming labels');
  check('duplicate labels both present', full.promptEvidence.facts.upcoming.filter((r) => r.name === 'Daycare').length === 2);
  check('duplicate not collapsed', full.ledger.facts.upcoming[2].itemId === 'item3'
    && full.ledger.facts.upcoming[3].itemId === 'item4');
  check('prompt view strips itemId', full.promptEvidence.facts.upcoming.every((row) => row.itemId === undefined));

  section('3B.3B.4 G/H decimal and signed-ledger fixtures');
  check('exact decimal fixture', full.promptEvidence.facts.upcoming[0].amount === 4626.36
    && full.promptEvidence.facts.upcoming[1].amount === -162.24
    && full.promptEvidence.facts.upcoming[4].amount === -267.32);
  check('signed income stays positive', full.promptEvidence.facts.upcoming[0].amount > 0);
  check('signed expenses stay negative', full.promptEvidence.facts.upcoming[1].amount < 0
    && full.promptEvidence.facts.recents[0].amount < 0);
  check('recent cents under 10 stay exact', full.promptEvidence.facts.recents[0].amount === -79.99
    && full.promptEvidence.facts.recents[2].amount === -19.99);

  section('3B.3B.4 I 15-day upcoming + 90-day negative');
  check('upcoming date in 15-day window', full.promptEvidence.facts.upcoming[0].start === '2026-08-20');
  check('negative date far horizon', full.promptEvidence.facts.futureNegativeBalances[0].date === '2026-11-08');
  check('horizons not the same list', full.promptEvidence.facts.upcoming[0].date !== full.promptEvidence.facts.futureNegativeBalances[0].date
    && full.promptEvidence.facts.upcomingWindowDays === 15);

  section('3B.3B.4 M forecast upcoming readiness');
  check('M upcoming readiness', full.readiness.upcomingForecast === true);
  check('supported classes enumerated', SUPPORTED_SNAPSHOT_QUESTION_CLASSES.length === 3
    && SUPPORTED_SNAPSHOT_QUESTION_CLASSES[0].id === 'snapshot_forecast_upcoming');
  check('Will I go negative is cashflow_analysis', route('Will I go negative?').capability === 'cashflow_analysis');
  check('next month balance is forecast', route('What will my balance be next month?').capability === 'financial_forecast');
  check('next month readiness from snapshot facts', full.readiness.nextMonthBalance === true);

  section('3B.3B.4 inventory exclusions');
  const inv = {};
  CURRENT_CONTEXT_INVENTORY.forEach((row) => { inv[row.code] = row.cutover; });
  check('top categories not required', inv.top_categories === 'not_required');
  check('top merchants not required', inv.top_merchants === 'not_required');
  check('goals not required', inv.goals === 'not_required');
  check('available categories not required', inv.available_categories === 'not_required');
  check('product knowledge not required', inv.product_knowledge === 'not_required');
  check('memory not required', inv.memory_history_summary === 'not_required');
  check('balances required', inv.balances === 'required');
  check('upcoming rows required', inv.upcoming_rows === 'required');

  section('3B.3B.4 no second fetch / immutability');
  const fetchCalls = [];
  const { evidence: fetched } = await prefetchForecast(compact, paginatedFetch([], fetchCalls));
  const fetchesAfterPrefetch = fetchCalls.length;
  runShadow(fetched, compact, 'financial_forecast');
  check('shadow does not fetch', fetchCalls.length === fetchesAfterPrefetch);
  const artifacts = buildSnapshotShadowArtifacts({
    evidence: fetched,
    selectedAccount: compact,
    capability: 'financial_forecast',
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  });
  compact.recents[0].amount = 999;
  check('mutating compact after artifacts does not change adapted', artifacts.adapted.facts.recents[0].amount === -79.99);
  compact.recents[0].amount = compactBefore.recents[0].amount;

  section('3B.3B.4 privacy and sanitization');
  const sanitized = sanitizeShadowReport(full);
  const sanitizedSrc = JSON.stringify(sanitized);
  const leaks = leakedValues(sanitizedSrc);
  check('sanitized report has no fixture values', leaks.length === 0, leaks.join(','));
  check('sanitized has no promptEvidence', sanitized.promptEvidence === undefined);
  check('sanitized has no ledger', sanitized.ledger === undefined);
  const prodShadow = runShadow(evidence, compact, 'financial_forecast');
  check('production shadow omits artifacts', prodShadow.promptEvidence === undefined && prodShadow.ledger === undefined);
  const prodLeaks = leakedValues(JSON.stringify(prodShadow));
  check('production shadow privacy', prodLeaks.length === 0, prodLeaks.join(','));

  section('3B.3B.4 logger scan and exception');
  const shadowSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaSnapshotEvidenceShadow.js'), 'utf8');
  check('no raw prompt log', !/console\.(log|warn|error)\([^)]*promptEvidence/.test(shadowSrc));
  check('no raw ledger log', !/console\.(log|warn|error)\([^)]*ledger/.test(shadowSrc));
  check('no JSON.stringify prompt log', !/console\.(log|warn|error)\([\s\S]*JSON\.stringify\(artifacts/.test(shadowSrc));
  check('warn uses counts only', /missingLedgerFactCount/.test(shadowSrc) && /differenceCodes/.test(shadowSrc));
  const circular = { status: 'ok', source: ['kea_snapshot'], facts: {} };
  circular.facts.self = circular;
  const boom = shadowSnapshotEvidence({
    capability: 'financial_forecast',
    evidence: circular,
    selectedAccount: compact,
  });
  check('exception caught', boom.status === 'exception' && boom.reason === 'shadow_exception');
  check('exception has no stack payload', boom.stack === undefined && boom.message === undefined);

  section('3B.3B.4 production snapshot remains legacy');
  check('legacy azureFacing has no recents', azureFacingEvidence(evidence).facts.recents === undefined);
  check('legacy section still used', /GROUNDED EVIDENCE \(authoritative/.test(buildEvidenceSystemSection(evidence)));
  check('macro projector skips snapshot', projectApprovedMacroEvidence({
    capability: 'financial_forecast',
    evidence,
  }).mode === 'legacy');
  check('shouldUseLedgerPrompt forecast false', shouldUseLedgerPrompt('financial_forecast') === false);
  const snapTel = telemetryForNonCutoverTurn({
    capability: 'financial_forecast',
    groundingStrategy: 'snapshot',
    evidence,
    rollbackActive: false,
  });
  check('forecast telemetry legacy', snapTel.evidence_prompt_mode === 'legacy'
    && snapTel.evidence_source_kind === 'kea_snapshot'
    && snapTel.evidence_ledger_present === false
    && snapTel.evidence_projection_status === 'legacy');

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
  check('snapshot-backed lookup eligible for shadow', isSnapshotShadowEligible({
    capability: 'financial_lookup',
    evidence: balEv,
  }) === true);
  check('production lookup projector still legacy for snapshot', projectLookupEvidence({
    capability: 'financial_lookup',
    evidence: balEv,
    route: balRoute,
  }).mode === 'legacy');
  const balTel = telemetryForNonCutoverTurn({
    capability: 'financial_lookup',
    groundingStrategy: 'snapshot',
    evidence: balEv,
    rollbackActive: false,
  });
  check('balance lookup telemetry legacy', balTel.evidence_prompt_mode === 'legacy'
    && balTel.evidence_source_kind === 'kea_snapshot'
    && balTel.evidence_ledger_present === false);

  section('3B.3B.4 lookup/macro/flag guards');
  check('lookup flag env key unchanged', LOOKUP_PROMPT_ENV_KEY === 'USE_LOOKUP_EVIDENCE_LEDGER_PROMPT');
  check('macro flag env key unchanged', LEDGER_PROMPT_ENV_KEY === 'USE_EVIDENCE_LEDGER_PROMPT');
  check('lookup cutover still on for user_transactions', shouldUseLookupLedgerPrompt({
    capability: 'financial_lookup',
    evidence: txLookup,
  }) === true);
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
  const fromCompact = adaptSnapshotEvidenceForLedger({
    evidence: { status: 'ok', source: ['kea_snapshot'], facts: { availableBalance: 90 } },
    selectedAccount: viaCompactFn,
  });
  check('adapter still copies compact arrays', fromCompact.facts.upcoming[0].amount === -8);

  const controllerSrc = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'openaiController.js'), 'utf8');
  check('controller still uses CURRENT CONTEXT chat builder', /buildChatAccountContext\(selectedAccount/.test(controllerSrc));
  check('controller still uses legacy evidence section', /groundedEvidenceBlock = buildEvidenceSystemSection\(phase1Evidence\)/.test(controllerSrc));
  check('shadow result not assigned to groundedEvidenceBlock', !/groundedEvidenceBlock = shadowSnapshotEvidence/.test(controllerSrc));
  check('shadow is invoked request-local', /shadowSnapshotEvidence\(\{/.test(controllerSrc));
  check('no snapshot cutover flag', !/USE_SNAPSHOT_EVIDENCE_LEDGER_PROMPT/.test(controllerSrc)
    && !/USE_SNAPSHOT_EVIDENCE_LEDGER_PROMPT/.test(shadowSrc));
  check('lookup shadow still not in controller', !/keaLookupEvidenceShadow/.test(controllerSrc));

  section('3B.3B.4 1000-run performance');
  const t0 = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    shadowSnapshotEvidence({
      evidence,
      selectedAccount: compact,
      capability: 'financial_forecast',
      accountContext: { accountId: '10', accountLabel: 'Checking' },
    });
  }
  const ms = Date.now() - t0;
  check(`1000 adapter+ledger+view+compare < 2000ms (${ms}ms)`, ms < 2000);

  section('3B.3B.4 difference order stable');
  const second = runShadow(evidence, compact, 'financial_forecast');
  check('difference codes stable', JSON.stringify(prodShadow.differenceCodes) === JSON.stringify(second.differenceCodes));
}

module.exports = { run };
