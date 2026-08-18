'use strict';

/**
 * Phase 3B.4 — sanitized Evidence Ledger / Prompt View telemetry.
 *
 * Derives low-cardinality fields only. Never logs Ledger, Prompt View,
 * amounts, dates, merchants, observation codes, or narration text.
 * Derivation failure must not affect chat control flow.
 */

const { SOURCE_KIND } = require('./keaEvidenceLedger');
const {
  collectBannedKeys,
  collectObservationCodeHits,
} = require('./keaEvidencePromptView');

const EVIDENCE_PROMPT_MODES = Object.freeze(['ledger_v1', 'legacy', 'none']);
const EVIDENCE_STATUSES = Object.freeze([
  'complete',
  'complete_empty',
  'partial',
  'unavailable',
  'unsupported',
  'none',
  'unknown',
]);
const EVIDENCE_PROJECTION_STATUSES = Object.freeze([
  'ok',
  'ledger_build_failed',
  'ledger_validation_failed',
  'prompt_view_failed',
  'not_applicable',
  'legacy',
  'fail_soft',
]);
const EVIDENCE_FAILURE_REASONS = Object.freeze([
  'none',
  'missing_evidence',
  'ledger_build_failed',
  'ledger_invalid',
  'prompt_view_build_failed',
  'prompt_view_invalid',
  'unsupported_status',
  'not_promptable',
  'unavailable',
  'projection_exception',
]);
const CLAIM_COUNT_BUCKETS = Object.freeze(['0', '1-3', '4-7', '8-15', '16-31', '32+']);
const CHARS_BUCKETS = Object.freeze([
  '0',
  '1-512',
  '513-1024',
  '1025-2048',
  '2049-4096',
  '4097-8192',
  '8193+',
  'unknown',
]);

const SOURCE_KIND_VALUES = Object.freeze(
  Object.keys(SOURCE_KIND).map((k) => SOURCE_KIND[k]).concat(['none', 'unknown'])
);

const DEFAULT_EVIDENCE_TELEMETRY = Object.freeze({
  evidence_ledger_present: false,
  evidence_prompt_mode: 'none',
  evidence_source_kind: 'none',
  evidence_status: 'none',
  evidence_projection_status: 'not_applicable',
  evidence_promptable: false,
  evidence_claim_count_bucket: '0',
  evidence_list_truncated: false,
  evidence_prompt_chars_bucket: '0',
  evidence_ledger_chars_bucket: '0',
  evidence_internal_stripped: false,
  evidence_rollback_active: false,
  evidence_projection_failure_reason: 'none',
});

const LEGACY_BY_CAPABILITY = Object.freeze({
  financial_forecast: true,
  financial_lookup: true,
});

function emptyEvidenceTelemetry() {
  return Object.assign({}, DEFAULT_EVIDENCE_TELEMETRY);
}

function pickEnum(value, allowed, fallback) {
  return allowed.indexOf(value) === -1 ? fallback : value;
}

function claimCountBucket(n) {
  const count = Number(n) || 0;
  if (count <= 0) return '0';
  if (count <= 3) return '1-3';
  if (count <= 7) return '4-7';
  if (count <= 15) return '8-15';
  if (count <= 31) return '16-31';
  return '32+';
}

function charsBucket(n) {
  if (n == null || !Number.isFinite(n)) return 'unknown';
  if (n <= 0) return '0';
  if (n <= 512) return '1-512';
  if (n <= 1024) return '513-1024';
  if (n <= 2048) return '1025-2048';
  if (n <= 4096) return '2049-4096';
  if (n <= 8192) return '4097-8192';
  return '8193+';
}

function serializedCharsBucket(value) {
  if (value == null) return '0';
  try {
    return charsBucket(JSON.stringify(value).length);
  } catch (err) {
    return 'unknown';
  }
}

function sourceKindOf(kind) {
  if (kind == null || kind === '') return 'none';
  return pickEnum(kind, SOURCE_KIND_VALUES, 'unknown');
}

function statusOf(status) {
  if (status == null || status === '') return 'none';
  return pickEnum(status, EVIDENCE_STATUSES, 'unknown');
}

function anyListTruncated(ledger) {
  const lists = ledger && ledger.lists;
  if (!lists || typeof lists !== 'object') return false;
  const keys = Object.keys(lists);
  for (let i = 0; i < keys.length; i += 1) {
    const list = lists[keys[i]];
    if (list && list.meta && list.meta.truncated === true) return true;
    if (list && list.truncated === true) return true;
  }
  return false;
}

function mapFailureReason(reason) {
  if (!reason) return 'none';
  if (reason === 'validation_failed' || reason === 'invalid_ledger' || reason === 'ledger_invalid') {
    return 'ledger_invalid';
  }
  if (reason === 'missing_evidence' || reason === 'invalid_input') return 'missing_evidence';
  if (reason === 'unsupported_capability' || reason === 'ledger_failed' || reason === 'ledger_build_failed') {
    return 'ledger_build_failed';
  }
  if (reason === 'validation_failed_view' || reason === 'prompt_view_invalid') return 'prompt_view_invalid';
  if (reason === 'prompt_view_failed' || reason === 'no_ledger' || reason === 'invalid_input_view') {
    return 'prompt_view_build_failed';
  }
  if (reason === 'unsupported' || reason === 'unsupported_status') return 'unsupported_status';
  if (reason === 'not_promptable') return 'not_promptable';
  if (reason === 'unavailable') return 'unavailable';
  if (reason === 'projection_exception') return 'projection_exception';
  return pickEnum(reason, EVIDENCE_FAILURE_REASONS, 'projection_exception');
}

function mapProjectionStatus({ mode, ok, promptable, failSoft, reason } = {}) {
  if (mode === 'legacy') return 'legacy';
  if (mode !== 'ledger_v1') return 'not_applicable';
  if (ok && promptable && !failSoft) return 'ok';
  if (reason === 'ledger_invalid' || reason === 'invalid_ledger') return 'ledger_validation_failed';
  if (reason === 'prompt_view_invalid' || reason === 'validation_failed_view'
    || reason === 'prompt_view_failed' || reason === 'no_ledger') {
    return 'prompt_view_failed';
  }
  if (reason === 'missing_evidence' || reason === 'invalid_input' || reason === 'unsupported_capability'
    || reason === 'ledger_failed' || reason === 'ledger_build_failed' || reason === 'projection_exception') {
    return 'ledger_build_failed';
  }
  if (failSoft || reason === 'unavailable' || reason === 'unsupported' || reason === 'unsupported_status'
    || reason === 'not_promptable') {
    return 'fail_soft';
  }
  if (!ok) return 'prompt_view_failed';
  return 'fail_soft';
}

function internalStripped(promptEvidence) {
  if (!promptEvidence) return false;
  try {
    return collectBannedKeys(promptEvidence).length === 0
      && collectObservationCodeHits(promptEvidence).length === 0
      && promptEvidence.internal == null
      && promptEvidence.claims == null;
  } catch (err) {
    return false;
  }
}

function deriveFromLedgerProjection(input = {}) {
  try {
    const rollbackActive = input.rollbackActive === true;
    const mode = input.mode === 'ledger_v1' || input.mode === 'legacy' ? input.mode : 'none';
    if (mode === 'legacy') {
      const source = sourceKindOf(input.sourceKind);
      return {
        evidence_ledger_present: false,
        evidence_prompt_mode: 'legacy',
        evidence_source_kind: source,
        evidence_status: 'none',
        evidence_projection_status: 'legacy',
        evidence_promptable: false,
        evidence_claim_count_bucket: '0',
        evidence_list_truncated: false,
        evidence_prompt_chars_bucket: '0',
        evidence_ledger_chars_bucket: '0',
        evidence_internal_stripped: false,
        evidence_rollback_active: rollbackActive,
        evidence_projection_failure_reason: 'none',
      };
    }
    if (mode !== 'ledger_v1') return Object.assign(emptyEvidenceTelemetry(), { evidence_rollback_active: rollbackActive });

    const ledger = input.ledger || null;
    const promptEvidence = input.promptEvidence || null;
    const reason = mapFailureReason(input.reason);
    const status = statusOf(ledger && ledger.status);
    const source = sourceKindOf((ledger && ledger.source && ledger.source.kind) || input.sourceKind);
    const present = !!ledger;
    const promptable = input.promptable === true;
    const stripped = promptable && !!promptEvidence && internalStripped(promptEvidence);
    return {
      evidence_ledger_present: present,
      evidence_prompt_mode: 'ledger_v1',
      evidence_source_kind: source,
      evidence_status: status,
      evidence_projection_status: mapProjectionStatus(input),
      evidence_promptable: promptable,
      evidence_claim_count_bucket: claimCountBucket(ledger && Array.isArray(ledger.claims) ? ledger.claims.length : 0),
      evidence_list_truncated: anyListTruncated(ledger),
      evidence_prompt_chars_bucket: serializedCharsBucket(promptEvidence),
      evidence_ledger_chars_bucket: serializedCharsBucket(ledger),
      evidence_internal_stripped: stripped,
      evidence_rollback_active: rollbackActive,
      evidence_projection_failure_reason: input.ok === true && promptable ? 'none' : reason,
    };
  } catch (err) {
    return emptyEvidenceTelemetry();
  }
}

function telemetryForNonCutoverTurn({
  capability,
  groundingStrategy,
  evidence,
  rollbackActive,
} = {}) {
  try {
    const rollback = rollbackActive === true;
    const cap = capability || null;
    const strategy = groundingStrategy || null;
    const isLegacyCap = !!LEGACY_BY_CAPABILITY[cap]
      || strategy === 'snapshot'
      || strategy === 'prefetch_read';
    if (!isLegacyCap) {
      return Object.assign(emptyEvidenceTelemetry(), { evidence_rollback_active: rollback });
    }
    const sourceRaw = evidence && Array.isArray(evidence.source) ? evidence.source[0] : null;
    let source = 'none';
    if (cap === 'financial_forecast' || strategy === 'snapshot') {
      source = sourceKindOf(sourceRaw || SOURCE_KIND.KEA_SNAPSHOT);
    } else if (cap === 'financial_lookup' || strategy === 'prefetch_read') {
      source = sourceKindOf(sourceRaw || SOURCE_KIND.USER_TRANSACTIONS);
    }
    return {
      evidence_ledger_present: false,
      evidence_prompt_mode: 'legacy',
      evidence_source_kind: source,
      evidence_status: 'none',
      evidence_projection_status: 'legacy',
      evidence_promptable: false,
      evidence_claim_count_bucket: '0',
      evidence_list_truncated: false,
      evidence_prompt_chars_bucket: '0',
      evidence_ledger_chars_bucket: '0',
      evidence_internal_stripped: false,
      evidence_rollback_active: rollback,
      evidence_projection_failure_reason: 'none',
    };
  } catch (err) {
    return emptyEvidenceTelemetry();
  }
}

function sanitizeEvidenceTelemetry(input) {
  const base = emptyEvidenceTelemetry();
  if (!input || typeof input !== 'object') return base;
  try {
    return {
      evidence_ledger_present: input.evidence_ledger_present === true,
      evidence_prompt_mode: pickEnum(input.evidence_prompt_mode, EVIDENCE_PROMPT_MODES, 'none'),
      evidence_source_kind: sourceKindOf(input.evidence_source_kind),
      evidence_status: statusOf(input.evidence_status),
      evidence_projection_status: pickEnum(
        input.evidence_projection_status,
        EVIDENCE_PROJECTION_STATUSES,
        'not_applicable'
      ),
      evidence_promptable: input.evidence_promptable === true,
      evidence_claim_count_bucket: pickEnum(input.evidence_claim_count_bucket, CLAIM_COUNT_BUCKETS, '0'),
      evidence_list_truncated: input.evidence_list_truncated === true,
      evidence_prompt_chars_bucket: pickEnum(input.evidence_prompt_chars_bucket, CHARS_BUCKETS, '0'),
      evidence_ledger_chars_bucket: pickEnum(input.evidence_ledger_chars_bucket, CHARS_BUCKETS, '0'),
      evidence_internal_stripped: input.evidence_internal_stripped === true,
      evidence_rollback_active: input.evidence_rollback_active === true,
      evidence_projection_failure_reason: pickEnum(
        input.evidence_projection_failure_reason,
        EVIDENCE_FAILURE_REASONS,
        'none'
      ),
    };
  } catch (err) {
    return base;
  }
}

module.exports = {
  DEFAULT_EVIDENCE_TELEMETRY,
  EVIDENCE_PROMPT_MODES,
  EVIDENCE_STATUSES,
  EVIDENCE_PROJECTION_STATUSES,
  EVIDENCE_FAILURE_REASONS,
  CLAIM_COUNT_BUCKETS,
  CHARS_BUCKETS,
  SOURCE_KIND_VALUES,
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
};
