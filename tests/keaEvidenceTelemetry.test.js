'use strict';

const { check, section } = require('./harness');
const {
  emptyEvidenceTelemetry,
  claimCountBucket,
  charsBucket,
  serializedCharsBucket,
  sourceKindOf,
  statusOf,
  mapFailureReason,
  mapProjectionStatus,
  deriveFromLedgerProjection,
  telemetryForNonCutoverTurn,
  sanitizeEvidenceTelemetry,
} = require('../services/keaEvidenceTelemetry');
const { validateEvidenceLedgerV1, EVIDENCE_LEDGER_VERSION } = require('../services/keaEvidenceLedger');

async function run() {
  section('3B.4 evidence telemetry buckets');
  check('claim 0', claimCountBucket(0) === '0');
  check('claim 1-3', claimCountBucket(3) === '1-3');
  check('claim 4-7', claimCountBucket(7) === '4-7');
  check('claim 8-15', claimCountBucket(8) === '8-15');
  check('claim 16-31', claimCountBucket(31) === '16-31');
  check('claim 32+', claimCountBucket(32) === '32+');
  check('chars 0', charsBucket(0) === '0');
  check('chars 1-512', charsBucket(12) === '1-512');
  check('chars 513-1024', charsBucket(513) === '513-1024');
  check('chars 8193+', charsBucket(9000) === '8193+');
  check('chars unknown', charsBucket(NaN) === 'unknown');
  const cyclic = {};
  cyclic.self = cyclic;
  check('stringify failure unknown', serializedCharsBucket(cyclic) === 'unknown');

  section('3B.4 enums');
  check('source allowlist', sourceKindOf('cashflow_upcoming') === 'cashflow_upcoming');
  check('source unknown url', sourceKindOf('https://evil') === 'unknown');
  check('status complete_empty', statusOf('complete_empty') === 'complete_empty');
  check('status unknown', statusOf('totally_made_up') === 'unknown');
  check('failure ledger_invalid', mapFailureReason('validation_failed') === 'ledger_invalid');
  check('failure exception', mapFailureReason('Error: boom at amount 12') === 'projection_exception');
  check('projection ok', mapProjectionStatus({ mode: 'ledger_v1', ok: true, promptable: true, failSoft: false }) === 'ok');
  check('projection legacy', mapProjectionStatus({ mode: 'legacy' }) === 'legacy');
  check('projection ledger invalid', mapProjectionStatus({
    mode: 'ledger_v1', ok: false, promptable: false, failSoft: true, reason: 'ledger_invalid',
  }) === 'ledger_validation_failed');
  check('projection prompt view failed', mapProjectionStatus({
    mode: 'ledger_v1', ok: false, promptable: false, failSoft: true, reason: 'prompt_view_invalid',
  }) === 'prompt_view_failed');
  check('projection fail-soft unavailable', mapProjectionStatus({
    mode: 'ledger_v1', ok: true, promptable: false, failSoft: true, reason: 'unavailable',
  }) === 'fail_soft');

  section('3B.4 unknown ledger version');
  const versionCheck = validateEvidenceLedgerV1({
    version: 99,
    status: 'complete',
    capability: 'cashflow_upcoming',
    source: { kind: 'cashflow_upcoming', definition: null, description: 'x' },
    scope: {},
    facts: {},
    claims: [],
    lists: {},
    limitations: [],
    assumptions: [],
    allowedNarration: [],
    prohibitedNarration: [],
    internal: {},
  });
  check('unknown version invalid', versionCheck.ok === false && versionCheck.errors.indexOf('version_invalid') !== -1);
  check('current version constant is 1', EVIDENCE_LEDGER_VERSION === 1);

  section('3B.4 non-cutover telemetry');
  const snap = telemetryForNonCutoverTurn({
    capability: 'financial_forecast',
    groundingStrategy: 'snapshot',
    evidence: { source: ['kea_snapshot'] },
    rollbackActive: false,
  });
  check('snapshot mode legacy', snap.evidence_prompt_mode === 'legacy');
  check('snapshot ledger absent', snap.evidence_ledger_present === false);
  check('snapshot rollback false', snap.evidence_rollback_active === false);
  check('snapshot source', snap.evidence_source_kind === 'kea_snapshot');

  const lookup = telemetryForNonCutoverTurn({
    capability: 'financial_lookup',
    groundingStrategy: 'prefetch_read',
    evidence: { source: ['user_transactions'] },
    rollbackActive: false,
  });
  check('lookup mode legacy', lookup.evidence_prompt_mode === 'legacy');
  check('lookup rollback false', lookup.evidence_rollback_active === false);

  const thanks = telemetryForNonCutoverTurn({ capability: 'casual_conversation', rollbackActive: false });
  check('non-financial mode none', thanks.evidence_prompt_mode === 'none');
  check('non-financial no ledger', thanks.evidence_ledger_present === false);

  const write = telemetryForNonCutoverTurn({ capability: 'transaction_write', rollbackActive: false });
  check('write mode none', write.evidence_prompt_mode === 'none');

  const sim = telemetryForNonCutoverTurn({ capability: 'simulation', rollbackActive: false });
  check('simulation mode none', sim.evidence_prompt_mode === 'none');

  const clarify = telemetryForNonCutoverTurn({ capability: 'conversation_clarify', rollbackActive: false });
  check('clarify mode none', clarify.evidence_prompt_mode === 'none');

  section('3B.4 sanitize + isolation');
  const dirty = sanitizeEvidenceTelemetry({
    evidence_prompt_mode: 'ledger_v1',
    evidence_status: 'complete',
    amount: 100,
    merchant: 'Target',
    date: '2026-08-25',
    accountId: '10',
    observations: ['no_upcoming_in_period'],
  });
  check('sanitize keeps mode', dirty.evidence_prompt_mode === 'ledger_v1');
  check('sanitize drops amount', dirty.amount === undefined);
  const serialized = JSON.stringify(dirty);
  check('sanitize json has no amount', serialized.indexOf('100') === -1);
  check('sanitize json has no merchant', serialized.indexOf('Target') === -1);
  check('sanitize json has no date', serialized.indexOf('2026-08-25') === -1);
  check('sanitize json has no accountId', serialized.indexOf('accountId') === -1);
  check('sanitize json has no observation', serialized.indexOf('no_upcoming_in_period') === -1);

  check('empty defaults mode none', emptyEvidenceTelemetry().evidence_prompt_mode === 'none');

  const boom = deriveFromLedgerProjection(null);
  check('derive null safe', boom.evidence_prompt_mode === 'none');

  const truncated = deriveFromLedgerProjection({
    mode: 'ledger_v1',
    ok: true,
    promptable: true,
    failSoft: false,
    rollbackActive: false,
    ledger: {
      status: 'complete',
      source: { kind: 'cashflow_upcoming' },
      claims: [{}],
      lists: { items: { meta: { truncated: true } } },
    },
    promptEvidence: { status: 'complete', facts: {} },
  });
  check('list truncated true', truncated.evidence_list_truncated === true);

  const unknownSrc = deriveFromLedgerProjection({
    mode: 'ledger_v1',
    ok: true,
    promptable: true,
    failSoft: false,
    ledger: { status: 'weird_status', source: { kind: 'https://evil.example' }, claims: [] },
    promptEvidence: { status: 'complete' },
  });
  check('unknown source kind mapped', unknownSrc.evidence_source_kind === 'unknown');
  check('unknown status mapped', unknownSrc.evidence_status === 'unknown');

  const frozenLedger = Object.freeze({
    status: 'complete',
    source: Object.freeze({ kind: 'cashflow_upcoming' }),
    claims: Object.freeze([]),
    lists: Object.freeze({}),
  });
  const beforeKeys = Object.keys(frozenLedger).join(',');
  deriveFromLedgerProjection({
    mode: 'ledger_v1',
    ok: true,
    promptable: true,
    failSoft: false,
    ledger: frozenLedger,
    promptEvidence: { status: 'complete' },
  });
  check('derive does not mutate ledger keys', Object.keys(frozenLedger).join(',') === beforeKeys);

  const telSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'keaEvidenceTelemetry.js'), 'utf8');
  check('no ledgerFingerprint', telSrc.indexOf('ledgerFingerprint') === -1);
  check('telemetry logger has no ledger dump', !/console\.(log|info|debug|warn)\(.*ledger/.test(telSrc)
    && !/logger\.(info|debug|warn)\(.*ledger/.test(telSrc));

  section('3B.4 derivation performance');
  const sample = {
    mode: 'ledger_v1',
    ok: true,
    promptable: true,
    failSoft: false,
    rollbackActive: false,
    ledger: { status: 'complete', source: { kind: 'cashflow_upcoming' }, claims: [{}, {}, {}], lists: { items: { meta: { truncated: false } } } },
    promptEvidence: { status: 'complete', source: { description: 'scheduled' }, facts: {}, limitations: [], allowedNarration: [], prohibitedNarration: [] },
  };
  const t0 = Date.now();
  for (let i = 0; i < 1000; i += 1) deriveFromLedgerProjection(sample);
  const elapsed = Date.now() - t0;
  check(`1000 derivations ${elapsed}ms`, elapsed < 1000, String(elapsed));
}

module.exports = { run };
