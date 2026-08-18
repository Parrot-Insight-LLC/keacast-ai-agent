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
const { allowedToolsFor } = require('../services/keaToolBundles');
const {
  LEDGER_PROMPT_ENV_KEY,
  LOOKUP_PROMPT_ENV_KEY,
  SNAPSHOT_PROMPT_ENV_KEY,
  shouldUseLedgerPrompt,
  shouldUseLookupLedgerPrompt,
  shouldUseSnapshotLedgerPrompt,
  isEligibleLookupCutover,
  isEligibleSnapshotCutover,
  isSnapshotBackedLookup,
  isLedgerPromptEnabled,
  isLookupLedgerPromptEnabled,
  isSnapshotLedgerPromptEnabled,
  isEvidenceRollbackActive,
  isLookupEvidenceRollbackActive,
  isSnapshotEvidenceRollbackActive,
  projectApprovedMacroEvidence,
  projectLookupEvidence,
  projectSnapshotEvidence,
} = require('../services/keaEvidencePromptCutover');
const { telemetryForNonCutoverTurn } = require('../services/keaEvidenceTelemetry');
const { collectBannedKeys } = require('../services/keaEvidencePromptView');
const { __testables: T } = require('../controllers/openaiController');

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

function withFlags(macro, lookup, snapshot, fn) {
  const keys = [LEDGER_PROMPT_ENV_KEY, LOOKUP_PROMPT_ENV_KEY, SNAPSHOT_PROMPT_ENV_KEY];
  const values = [macro, lookup, snapshot];
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

async function prefetchForecast(snapshot, fetchCalls) {
  const routed = route('What do I have upcoming in the next two weeks?');
  const evidence = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(routed, { message: 'What do I have upcoming in the next two weeks?' }),
    route: routed,
    fetchPage: paginatedFetch([], fetchCalls),
    assertFn: async () => ({ access: 'owner' }),
  });
  return { routed, evidence };
}

function assembleSnapshot(evidence, selectedAccount, extra = {}) {
  return T.buildSnapshotAnalysisPrompt({
    currentDate: extra.currentDate || '2026-08-16',
    firstName: 'Alex',
    account: selectedAccount,
    evidence,
    capability: extra.capability || 'financial_forecast',
    route: extra.route || null,
    accountContext: extra.accountContext || { accountId: '10', accountLabel: 'Checking' },
    longTermFacts: extra.longTermFacts || [],
    rollingSummary: extra.rollingSummary || '',
    dialogueState: extra.dialogueState || T.emptyDialogueState(),
  });
}

function scanIds(src) {
  const hits = [];
  if (/accountId/.test(src)) hits.push('accountId');
  if (/transactionid/i.test(src)) hits.push('transactionid');
  if (/groupid/i.test(src)) hits.push('groupid');
  if (/prefetchMeta/.test(src)) hits.push('prefetchMeta');
  if (/"builder"/.test(src)) hits.push('builder');
  return hits;
}

function scanLegacyMarkers(src) {
  const hits = [];
  if (/Next 14 days/.test(src)) hits.push('Next 14 days');
  if (/Recent posted \(Name\|Amt\|Date\)/.test(src) || /Recent posted \(last/.test(src)) {
    hits.push('Recent posted');
  }
  if (/Upcoming forecasted \(Name\|Amt\|Date\)/.test(src) || /Upcoming forecasted \(next 14/.test(src)) {
    hits.push('Upcoming forecasted');
  }
  if (/Future negative projected balances/.test(src)) hits.push('Future negative');
  if (/GROUNDED EVIDENCE \(authoritative/.test(src)) hits.push('legacy wrapper');
  return hits;
}

async function run() {
  section('3B.3B.5 flag parsing and isolation');
  check('snapshot flag name', SNAPSHOT_PROMPT_ENV_KEY === 'USE_SNAPSHOT_EVIDENCE_LEDGER_PROMPT');
  check('lookup flag name unchanged', LOOKUP_PROMPT_ENV_KEY === 'USE_LOOKUP_EVIDENCE_LEDGER_PROMPT');
  check('macro flag name unchanged', LEDGER_PROMPT_ENV_KEY === 'USE_EVIDENCE_LEDGER_PROMPT');
  check('snapshot default ON', withFlags(undefined, undefined, undefined, () => isSnapshotLedgerPromptEnabled() === true));
  check('snapshot off false', withFlags(undefined, undefined, 'false', () => isSnapshotLedgerPromptEnabled() === false));
  check('snapshot off 0', withFlags(undefined, undefined, '0', () => isSnapshotLedgerPromptEnabled() === false));
  check('snapshot off OFF', withFlags(undefined, undefined, 'OFF', () => isSnapshotLedgerPromptEnabled() === false));
  check('snapshot off no', withFlags(undefined, undefined, 'no', () => isSnapshotLedgerPromptEnabled() === false));
  check('snapshot on true', withFlags(undefined, undefined, 'true', () => isSnapshotLedgerPromptEnabled() === true));
  check('snapshot on 1', withFlags(undefined, undefined, '1', () => isSnapshotLedgerPromptEnabled() === true));
  check('snapshot on yes', withFlags(undefined, undefined, 'YES', () => isSnapshotLedgerPromptEnabled() === true));
  check('snapshot other nonempty ON', withFlags(undefined, undefined, 'maybe', () => isSnapshotLedgerPromptEnabled() === true));
  check('snapshot rollback when off', withFlags(undefined, undefined, 'false', () => isSnapshotEvidenceRollbackActive() === true));
  check('snapshot rollback false when unset', withFlags(undefined, undefined, undefined, () => isSnapshotEvidenceRollbackActive() === false));

  withFlags('true', 'true', 'true', () => {
    check('all ON: macro', isLedgerPromptEnabled() === true && isEvidenceRollbackActive() === false);
    check('all ON: lookup', isLookupLedgerPromptEnabled() === true && isLookupEvidenceRollbackActive() === false);
    check('all ON: snapshot', isSnapshotLedgerPromptEnabled() === true && isSnapshotEvidenceRollbackActive() === false);
  });
  withFlags('true', 'true', 'false', () => {
    check('macro ON lookup ON snapshot OFF: snapshot rollback', isSnapshotLedgerPromptEnabled() === false
      && isSnapshotEvidenceRollbackActive() === true);
    check('macro ON lookup ON snapshot OFF: others on', isLedgerPromptEnabled() === true && isLookupLedgerPromptEnabled() === true);
  });
  withFlags('true', 'false', 'true', () => {
    check('macro ON lookup OFF snapshot ON: lookup rollback', isLookupLedgerPromptEnabled() === false
      && isLookupEvidenceRollbackActive() === true);
    check('macro ON lookup OFF snapshot ON: snapshot on', isSnapshotLedgerPromptEnabled() === true);
  });
  withFlags('false', 'true', 'true', () => {
    check('macro OFF lookup ON snapshot ON: macro rollback', isLedgerPromptEnabled() === false
      && isEvidenceRollbackActive() === true);
    check('macro OFF lookup ON snapshot ON: snapshot on', isSnapshotLedgerPromptEnabled() === true);
  });
  withFlags('false', 'false', 'false', () => {
    check('all OFF: all rollback', isEvidenceRollbackActive() === true
      && isLookupEvidenceRollbackActive() === true
      && isSnapshotEvidenceRollbackActive() === true);
  });

  section('3B.3B.5 forecast upcoming assembly');
  const compact = compactFixture();
  const fetchCalls = [];
  const { routed, evidence } = await prefetchForecast(compact, fetchCalls);
  check('forecast capability', routed.capability === 'financial_forecast');
  check('eligible snapshot forecast', isEligibleSnapshotCutover({
    capability: 'financial_forecast',
    evidence,
  }) === true);
  check('product_help not eligible', isEligibleSnapshotCutover({
    capability: 'product_help',
    evidence,
  }) === false);
  check('cashflow_upcoming not eligible', isEligibleSnapshotCutover({
    capability: 'cashflow_upcoming',
    evidence,
  }) === false);
  check('shouldUseSnapshot default', shouldUseSnapshotLedgerPrompt({
    capability: 'financial_forecast',
    evidence,
  }) === true);
  check('macro projector still skips snapshot', shouldUseLedgerPrompt('financial_forecast') === false);
  const fetchesAfterPrefetch = fetchCalls.length;
  const prompt = assembleSnapshot(evidence, compact, { route: routed });
  check('no second fetch', fetchCalls.length === fetchesAfterPrefetch);
  check('prompt mode ledger_v1', prompt.evidencePromptMode === 'ledger_v1');
  check('projection not failed', prompt.projectionFailed === false);
  const src = prompt.systemContent;
  check('one financial authority wrapper', /GROUNDED EVIDENCE\nThe following evidence is authoritative/.test(src));
  check('no dual legacy wrapper', scanLegacyMarkers(src).length === 0, scanLegacyMarkers(src).join(','));
  check('no Next 14 days', !/Next 14 days/.test(src));
  check('exact 4626.36', src.indexOf('4626.36') !== -1);
  check('exact -162.24', src.indexOf('-162.24') !== -1);
  check('exact -267.32', src.indexOf('-267.32') !== -1);
  check('exact -220.85', src.indexOf('-220.85') !== -1);
  check('signed income positive', /"amount":4626.36/.test(src.replace(/\s+/g, '')));
  check('15-day window', /"upcomingWindowDays":15/.test(src.replace(/\s+/g, '')) && /15-day window/.test(src));
  check('90-day limitation', /90-day window/.test(src));
  check('two Daycare rows', (src.match(/"name":"Daycare"/g) || []).length === 2);
  check('MERIDIAN before Northwestern', src.indexOf('MERIDIAN') < src.indexOf('Northwestern'));
  check('availableBalance 4846.97', /"availableBalance":4846.97/.test(src.replace(/\s+/g, '')));
  check('monthNet 1500', /"monthNet":1500/.test(src.replace(/\s+/g, '')));
  check('upcomingExpenseTotal 1134.56', /"upcomingExpenseTotal":1134.56/.test(src.replace(/\s+/g, '')));
  check('upcomingIncomeTotal 4626.36', /"upcomingIncomeTotal":4626.36/.test(src.replace(/\s+/g, '')));
  check('signed_ledger', /"signConvention":"signed_ledger"/.test(src.replace(/\s+/g, '')));
  check('compact brief no balances', !/availableBalance/.test(prompt.accountBrief)
    && !/Recent posted/.test(prompt.accountBrief)
    && !/Upcoming forecasted/.test(prompt.accountBrief));
  check('brief has selected account', /Selected account: Checking/.test(prompt.accountBrief));
  check('id scan', scanIds(src).length === 0, scanIds(src).join(','));
  const jsonStart = prompt.groundedEvidenceBlock.indexOf('{');
  const viewJson = JSON.parse(prompt.groundedEvidenceBlock.slice(jsonStart));
  check('prompt view banned keys', collectBannedKeys(viewJson).length === 0);
  check('no itemId', viewJson.facts.upcoming.every((row) => row.itemId === undefined)
    && viewJson.facts.recents.every((row) => row.itemId === undefined));
  check('no top categories in view', viewJson.facts.topSpendingCategories === undefined);
  check('no top merchants in view', viewJson.facts.topSpendingMerchants === undefined);
  check('recents Costco exact', src.indexOf('-79.99') !== -1 && src.indexOf('Costco') !== -1);
  check('recents order', src.indexOf('Costco') < src.indexOf('Payroll') && src.indexOf('Payroll') < src.indexOf('"name":"Target"'));
  check('negative date order', src.indexOf('2026-11-08') !== -1);
  check('no fmtMoney whole-dollar authority', !/\$4626\b/.test(src) && !/\$4,626/.test(src));
  check('no warn-the-user policy', !/warn the user/.test(src));
  check('compact identity not fat disposable guide', /Do not recalculate them/.test(src)
    && !/Always use the word "disposable"/.test(src)
    && !/forecasted disposable \(net cash flow\)/.test(src));
  check('forecast does not newly force-direct', shouldForceDirectAnswer({
    route: routed,
    policy: resolveGroundingPolicy(routed, { message: 'What do I have upcoming in the next two weeks?' }),
    evidence,
  }) === false);
  check('telemetry success', prompt.evidenceTelemetry.evidence_prompt_mode === 'ledger_v1'
    && prompt.evidenceTelemetry.evidence_source_kind === 'kea_snapshot'
    && prompt.evidenceTelemetry.evidence_ledger_present === true
    && prompt.evidenceTelemetry.evidence_status === 'complete'
    && prompt.evidenceTelemetry.evidence_projection_status === 'ok'
    && prompt.evidenceTelemetry.evidence_promptable === true
    && prompt.evidenceTelemetry.evidence_internal_stripped === true
    && prompt.evidenceTelemetry.evidence_rollback_active === false
    && prompt.evidenceTelemetry.evidence_projection_failure_reason === 'none');
  check('list truncated false', prompt.evidenceTelemetry.evidence_list_truncated === false);
  check('forecast tools unchanged', allowedToolsFor('financial_forecast').has('getRecurringForecasts')
    && allowedToolsFor('financial_forecast').size === 1);

  section('3B.3B.5 snapshot-backed balance lookup');
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
  check('balance source kea_snapshot', balEv.source[0] === 'kea_snapshot');
  check('snapshot-backed lookup', isSnapshotBackedLookup({ capability: 'financial_lookup', evidence: balEv }) === true);
  check('not transaction lookup cutover', isEligibleLookupCutover({ capability: 'financial_lookup', evidence: balEv }) === false);
  check('eligible snapshot lookup', isEligibleSnapshotCutover({ capability: 'financial_lookup', evidence: balEv }) === true);
  const lookupProj = projectLookupEvidence({ capability: 'financial_lookup', evidence: balEv, route: balRoute });
  check('projectLookupEvidence still legacy for snapshot', lookupProj.mode === 'legacy');
  const balPrompt = assembleSnapshot(balEv, compact, { capability: 'financial_lookup', route: balRoute });
  check('balance prompt ledger_v1', balPrompt.evidencePromptMode === 'ledger_v1' && balPrompt.projectionFailed === false);
  check('balance exact 4846.97', /"availableBalance":4846.97/.test(balPrompt.systemContent.replace(/\s+/g, '')));
  check('balance no fat context', scanLegacyMarkers(balPrompt.systemContent).length === 0);
  check('balance telemetry kea_snapshot ledger_v1', balPrompt.evidenceTelemetry.evidence_prompt_mode === 'ledger_v1'
    && balPrompt.evidenceTelemetry.evidence_source_kind === 'kea_snapshot'
    && balPrompt.evidenceTelemetry.evidence_rollback_active === false);
  check('snapshot lookup still force-direct', shouldForceDirectAnswer({
    route: balRoute,
    policy: resolveGroundingPolicy(balRoute, { message: "What's my available balance?" }),
    evidence: balEv,
  }) === true);
  check('lookup tools unchanged', allowedToolsFor('financial_lookup').has('getUserTransactions')
    && allowedToolsFor('financial_lookup').has('getFocusedEntityDetails')
    && allowedToolsFor('financial_lookup').size === 2);

  section('3B.3B.5 next-month balance does not invent a scalar');
  const nextRoute = route('What will my balance be next month?');
  check('next-month is financial_forecast', nextRoute.capability === 'financial_forecast');
  const nextPrompt = assembleSnapshot(evidence, compact, { route: nextRoute });
  check('next-month uses same snapshot facts', /"availableBalance":4846.97/.test(nextPrompt.systemContent.replace(/\s+/g, '')));
  check('no invented nextMonthBalance', !/"nextMonthBalance"/.test(nextPrompt.systemContent)
    && !/"projectedNextMonth"/.test(nextPrompt.systemContent));

  section('3B.3B.5 empty lists remain complete');
  const emptyCompact = compactFixture({
    recents: [],
    upcoming: [],
    futureNegativeBalances: [],
    rest: { upcomingExpenseTotal: 0, upcomingIncomeTotal: 0 },
  });
  const emptyPrefetch = await prefetchForecast(emptyCompact);
  const emptyPrompt = assembleSnapshot(emptyPrefetch.evidence, emptyCompact, { route: emptyPrefetch.routed });
  check('empty lists promptable', emptyPrompt.projectionFailed === false && emptyPrompt.evidencePromptMode === 'ledger_v1');
  check('empty lists complete', emptyPrompt.evidenceTelemetry.evidence_status === 'complete');
  check('empty upcoming array', /"upcoming":\[\]/.test(emptyPrompt.systemContent.replace(/\s+/g, '')));

  section('3B.3B.5 flag OFF rollback');
  withFlags(undefined, undefined, 'false', () => {
    const rolled = projectSnapshotEvidence({
      capability: 'financial_forecast',
      evidence,
      selectedAccount: compact,
    });
    check('flag OFF mode legacy', rolled.mode === 'legacy');
    check('flag OFF rollback true', rolled.telemetry.evidence_rollback_active === true);
    check('flag OFF source kea_snapshot', rolled.telemetry.evidence_source_kind === 'kea_snapshot');
    check('flag OFF ledger absent', rolled.telemetry.evidence_ledger_present === false);
    check('flag OFF projection legacy', rolled.telemetry.evidence_projection_status === 'legacy');
    check('shouldUseSnapshot false', shouldUseSnapshotLedgerPrompt({
      capability: 'financial_forecast',
      evidence,
    }) === false);
    const rolledPrompt = assembleSnapshot(evidence, compact, { route: routed });
    check('flag OFF assembly uses legacy fallback flag', rolledPrompt.useLegacyAssembly === true
      || rolledPrompt.evidencePromptMode === 'legacy');
  });
  const helperOff = telemetryForNonCutoverTurn({
    capability: 'financial_forecast',
    groundingStrategy: 'snapshot',
    evidence,
    rollbackActive: true,
  });
  check('non-cutover helper rollback true', helperOff.evidence_rollback_active === true
    && helperOff.evidence_prompt_mode === 'legacy');

  section('3B.3B.5 projection failure fail-soft');
  const circular = { status: 'ok', source: ['kea_snapshot'], facts: {} };
  circular.facts.self = circular;
  const boom = projectSnapshotEvidence({
    capability: 'financial_forecast',
    evidence: circular,
    selectedAccount: compact,
  });
  check('circular fail-soft', boom.failSoft === true && boom.promptable === false && boom.mode === 'ledger_v1');
  check('circular no block', boom.block == null);
  check('circular reason', boom.reason === 'projection_exception');
  const boomPrompt = assembleSnapshot(circular, compact);
  check('circular assembly projectionFailed', boomPrompt.projectionFailed === true);
  check('circular assembly no legacy evidence', !/GROUNDED EVIDENCE \(authoritative/.test(boomPrompt.systemContent)
    && !/Next 14 days/.test(boomPrompt.systemContent));

  const unavailable = projectSnapshotEvidence({
    capability: 'financial_forecast',
    evidence: { status: 'unavailable', source: ['kea_snapshot'], facts: {} },
    selectedAccount: compact,
  });
  check('unavailable fail-soft', unavailable.failSoft === true && unavailable.promptable === false);

  section('3B.3B.5 family isolation');
  const txEv = {
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
  };
  withFlags(undefined, undefined, 'false', () => {
    const look = projectLookupEvidence({ capability: 'financial_lookup', evidence: txEv });
    check('lookup stays ledger_v1 when snapshot OFF', look.mode === 'ledger_v1'
      && look.promptEvidence.facts.spentTotal === 279.58);
    const up = projectApprovedMacroEvidence({
      capability: 'cashflow_upcoming',
      evidence: {
        status: 'ok',
        source: ['cashflow_upcoming'],
        facts: { itemCount: 0, totals: { scheduledExpenseTotal: 0 }, items: [] },
      },
    });
    check('macro stays ledger_v1 when snapshot OFF', up.mode === 'ledger_v1');
  });
  withFlags('false', 'false', 'true', () => {
    const look = projectLookupEvidence({ capability: 'financial_lookup', evidence: txEv });
    check('lookup rolls back on lookup flag not snapshot', look.mode === 'legacy'
      && look.telemetry.evidence_rollback_active === true);
    const snap = projectSnapshotEvidence({
      capability: 'financial_forecast',
      evidence,
      selectedAccount: compact,
    });
    check('snapshot stays on when lookup/macro OFF', snap.mode === 'ledger_v1'
      && snap.telemetry.evidence_rollback_active === false);
  });
  check('snapshot projector skips user_transactions', projectSnapshotEvidence({
    capability: 'financial_lookup',
    evidence: txEv,
  }).mode === 'legacy');

  section('3B.3B.5 sizes + performance + source guards');
  const oldBlock = buildEvidenceSystemSection(evidence);
  const oldCtx = T.buildChatAccountContext(compact, 'Alex', '2026-08-16');
  const newBlock = prompt.groundedEvidenceBlock;
  const newBrief = prompt.accountBrief;
  check('old evidence measured', oldBlock.length > 0);
  check('new evidence measured', newBlock.length > 0);
  check('old CURRENT CONTEXT measured', oldCtx.length > 0);
  check('new brief smaller', newBrief.length < oldCtx.length);
  check('new wrapper is ledger section', /The following evidence is authoritative/.test(newBlock));
  const t0 = Date.now();
  for (let i = 0; i < 1000; i += 1) {
    projectSnapshotEvidence({
      capability: 'financial_forecast',
      evidence,
      selectedAccount: compact,
      accountContext: { accountId: '10', accountLabel: 'Checking' },
    });
  }
  const ms = Date.now() - t0;
  check(`1000 adapter+ledger+view+wrapper < 2000ms (${ms}ms)`, ms < 2000);

  const controllerSrc = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'openaiController.js'), 'utf8');
  const cutoverSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaEvidencePromptCutover.js'), 'utf8');
  check('controller uses snapshot analysis prompt', /buildSnapshotAnalysisPrompt/.test(controllerSrc)
    && /projectSnapshotEvidence/.test(controllerSrc));
  check('legacy path preserved for rollback', /buildEvidenceSystemSection\(phase1Evidence\)/.test(controllerSrc)
    && /buildChatAccountContext\(selectedAccount/.test(controllerSrc));
  check('shadow not in production request flow', !/keaSnapshotEvidenceShadow/.test(controllerSrc)
    && !/shadowSnapshotEvidence/.test(controllerSrc));
  check('no raw snapshot payload log', !/console\.(log|warn|error)\([^)]*promptEvidence/.test(cutoverSrc));
  check('privacy telemetry has no amounts', JSON.stringify(prompt.evidenceTelemetry).indexOf('4626.36') === -1
    && JSON.stringify(prompt.evidenceTelemetry).indexOf('Checking') === -1);
  check('Next 14 days remains only in legacy chat context helper', /Next 14 days/.test(controllerSrc)
    && /function buildChatAccountContext/.test(controllerSrc));

  console.log('SIZE snapshot old evidence', oldBlock.length);
  console.log('SIZE snapshot new evidence', newBlock.length);
  console.log('SIZE snapshot old context', oldCtx.length);
  console.log('SIZE snapshot new brief', newBrief.length);
  console.log('SIZE snapshot new system', prompt.systemContent.length);
  console.log('SIZE snapshot old system estimate', oldCtx.length + oldBlock.length + 8000);
}

module.exports = { run };
