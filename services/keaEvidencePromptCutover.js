'use strict';

/**
 * Phase 3B.3A — production Prompt View cutover for approved Phase 2 macros.
 *
 * Ledger build and Prompt View projection stay in their 3B.1 / 3B.2 modules.
 * This file only decides whether to serialize Prompt View vs legacy evidence
 * and wraps Prompt View for Azure.
 */

const { buildEvidenceLedger } = require('./keaEvidenceLedgerBuilders');
const { toPromptEvidence } = require('./keaEvidencePromptView');
const { adaptSnapshotEvidenceForLedger } = require('./keaSnapshotEvidenceAdapter');
const {
  deriveFromLedgerProjection,
  emptyEvidenceTelemetry,
} = require('./keaEvidenceTelemetry');

const LEDGER_PROMPT_ENV_KEY = 'USE_EVIDENCE_LEDGER_PROMPT';
const LOOKUP_PROMPT_ENV_KEY = 'USE_LOOKUP_EVIDENCE_LEDGER_PROMPT';
const SNAPSHOT_PROMPT_ENV_KEY = 'USE_SNAPSHOT_EVIDENCE_LEDGER_PROMPT';
const FLAG_OFF = /^(0|false|off|no)$/i;
const FLAG_ON = /^(1|true|on|yes)$/i;

const APPROVED_MACRO_CAPABILITIES = Object.freeze([
  'cashflow_upcoming',
  'cashflow_recurring',
  'cashflow_income_horizon',
  'cashflow_comparison',
  'cashflow_trend',
  'cashflow_analysis',
  'affordability_or_planning',
]);

const APPROVED_SET = new Set(APPROVED_MACRO_CAPABILITIES);

function parseLedgerPromptFlag(raw) {
  if (raw == null || String(raw).trim() === '') {
    return { enabled: true, rollbackActive: false };
  }
  const value = String(raw).trim();
  if (FLAG_OFF.test(value)) return { enabled: false, rollbackActive: true };
  if (FLAG_ON.test(value) || value !== '') return { enabled: true, rollbackActive: false };
  return { enabled: true, rollbackActive: false };
}

function isLedgerPromptEnabled() {
  return parseLedgerPromptFlag(process.env[LEDGER_PROMPT_ENV_KEY]).enabled;
}

function isEvidenceRollbackActive() {
  return parseLedgerPromptFlag(process.env[LEDGER_PROMPT_ENV_KEY]).rollbackActive;
}

function isLookupLedgerPromptEnabled() {
  return parseLedgerPromptFlag(process.env[LOOKUP_PROMPT_ENV_KEY]).enabled;
}

function isLookupEvidenceRollbackActive() {
  return parseLedgerPromptFlag(process.env[LOOKUP_PROMPT_ENV_KEY]).rollbackActive;
}

function isSnapshotLedgerPromptEnabled() {
  return parseLedgerPromptFlag(process.env[SNAPSHOT_PROMPT_ENV_KEY]).enabled;
}

function isSnapshotEvidenceRollbackActive() {
  return parseLedgerPromptFlag(process.env[SNAPSHOT_PROMPT_ENV_KEY]).rollbackActive;
}

function firstEvidenceSource(evidence) {
  return evidence && Array.isArray(evidence.source) ? evidence.source[0] : null;
}

function isEligibleLookupCutover({ capability, evidence } = {}) {
  return capability === 'financial_lookup' && firstEvidenceSource(evidence) === 'user_transactions';
}

function isSnapshotBackedLookup({ capability, evidence } = {}) {
  return capability === 'financial_lookup' && firstEvidenceSource(evidence) === 'kea_snapshot';
}

function isEligibleSnapshotCutover({ capability, evidence } = {}) {
  if (firstEvidenceSource(evidence) !== 'kea_snapshot') return false;
  return capability === 'financial_forecast' || capability === 'financial_lookup';
}

function isApprovedMacroCapability(capability) {
  return APPROVED_SET.has(capability);
}

function shouldUseLedgerPrompt(capability) {
  return isLedgerPromptEnabled() && isApprovedMacroCapability(capability);
}

function shouldUseLookupLedgerPrompt({ capability, evidence } = {}) {
  return isLookupLedgerPromptEnabled() && isEligibleLookupCutover({ capability, evidence });
}

function shouldUseSnapshotLedgerPrompt({ capability, evidence } = {}) {
  return isSnapshotLedgerPromptEnabled() && isEligibleSnapshotCutover({ capability, evidence });
}

function resolveCutoverCapability({ capability, route, evidence } = {}) {
  if (capability && capability !== 'continuation') return capability;
  if (route && route.parentCapability) return route.parentCapability;
  if (route && route.capability && route.capability !== 'continuation') return route.capability;
  const source = evidence && Array.isArray(evidence.source) ? evidence.source[0] : null;
  if (source === 'cashflow_upcoming') return 'cashflow_upcoming';
  if (source === 'cashflow_recurring') return 'cashflow_recurring';
  if (source === 'cashflow_income_horizon') return 'cashflow_income_horizon';
  if (source === 'cashflow_period_comparison') return 'cashflow_comparison';
  if (source === 'cashflow_trend') return 'cashflow_trend';
  if (source === 'cashflow_analysis') return 'cashflow_analysis';
  if (source === 'affordability_analysis') return 'affordability_or_planning';
  return capability || null;
}

function resolveCutoverResponseMode({ responseMode, route } = {}) {
  if (responseMode) return responseMode;
  if (route && route.responseMode) return route.responseMode;
  if (route && route.slots && route.slots.rankingMode === 'largest') return 'largest';
  return null;
}

function buildLedgerEvidenceSystemSection(promptEvidence) {
  if (!promptEvidence) return '';
  return [
    'GROUNDED EVIDENCE',
    'The following evidence is authoritative for this turn.',
    'Use only supplied financial values.',
    'Do not calculate new financial values.',
    'Do not broaden account, period, source, or metric scope.',
    'Follow limitations.',
    'Follow allowed/prohibited narration constraints.',
    JSON.stringify(promptEvidence),
  ].join('\n');
}

function logProjectionFailure(reason, capability) {
  console.warn('Chat endpoint: ledger prompt projection failed (fail-soft):', {
    reason: reason || 'projection_failed',
    capability: capability || null,
  });
}

function withTelemetry(result, extra = {}) {
  let telemetry;
  try {
    const rollbackActive = extra.rollbackActive != null
      ? extra.rollbackActive === true
      : isEvidenceRollbackActive();
    telemetry = deriveFromLedgerProjection({
      mode: result.mode,
      ok: result.ok,
      promptable: result.promptable,
      failSoft: result.failSoft,
      reason: extra.reason != null ? extra.reason : result.reason,
      ledger: extra.ledger || null,
      promptEvidence: result.promptEvidence || extra.promptEvidence || null,
      sourceKind: extra.sourceKind || null,
      rollbackActive,
    });
  } catch (err) {
    telemetry = emptyEvidenceTelemetry();
  }
  result.telemetry = telemetry;
  return result;
}

function projectSnapshotLedgerView(input = {}) {
  const evidence = input.evidence;
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, reason: 'missing_evidence', ledger: null, view: null, promptable: false, adapted: null };
  }
  const adapted = adaptSnapshotEvidenceForLedger({
    evidence,
    selectedAccount: input.selectedAccount,
  });
  const capability = input.capability === 'financial_lookup' ? 'financial_lookup' : 'financial_forecast';
  const built = buildEvidenceLedger({
    capability,
    evidence: adapted,
    route: input.route || null,
    accountContext: input.accountContext || null,
    responseMode: input.responseMode || null,
  });
  if (!built.ok || !built.ledger) {
    return {
      ok: false,
      reason: built.reason === 'validation_failed' ? 'ledger_invalid' : (built.reason || 'ledger_failed'),
      ledger: null,
      view: null,
      promptable: false,
      adapted,
    };
  }
  if (built.ledger.status === 'unavailable' || built.ledger.status === 'unsupported') {
    return {
      ok: true,
      reason: built.ledger.status,
      ledger: built.ledger,
      view: null,
      promptable: false,
      adapted,
    };
  }
  const view = toPromptEvidence(built.ledger, { responseMode: input.responseMode || null });
  if (!view.ok || !view.promptable || !view.promptEvidence) {
    const mapped = view.reason === 'validation_failed' || view.reason === 'invalid_ledger'
      ? 'prompt_view_invalid'
      : (view.reason || 'prompt_view_failed');
    return {
      ok: false,
      reason: mapped,
      ledger: built.ledger,
      view,
      promptable: false,
      adapted,
    };
  }
  return {
    ok: true,
    reason: null,
    ledger: built.ledger,
    view,
    promptable: true,
    adapted,
  };
}

function projectSnapshotEvidenceUnsafe(input = {}) {
  const capability = input.capability === 'financial_lookup' ? 'financial_lookup' : 'financial_forecast';
  const evidence = input.evidence;
  const sourceKind = firstEvidenceSource(evidence) || 'kea_snapshot';

  if (!isEligibleSnapshotCutover({ capability, evidence })) {
    return withTelemetry({
      ok: true,
      mode: 'legacy',
      promptable: true,
      failSoft: false,
      block: null,
      reason: 'legacy',
      capability,
    }, {
      rollbackActive: false,
      sourceKind: sourceKind || 'none',
    });
  }

  if (!isSnapshotLedgerPromptEnabled()) {
    return withTelemetry({
      ok: true,
      mode: 'legacy',
      promptable: true,
      failSoft: false,
      block: null,
      reason: 'legacy',
      capability,
    }, {
      rollbackActive: true,
      sourceKind: 'kea_snapshot',
    });
  }

  if (!evidence || typeof evidence !== 'object') {
    logProjectionFailure('missing_evidence', capability);
    return withTelemetry({
      ok: false,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: 'missing_evidence',
      capability,
    }, { rollbackActive: false, sourceKind: 'kea_snapshot' });
  }
  if (evidence.status === 'unavailable') {
    return withTelemetry({
      ok: true,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: 'unavailable',
      capability,
    }, { rollbackActive: false, sourceKind: 'kea_snapshot' });
  }

  const projected = projectSnapshotLedgerView(input);
  if (!projected.ok) {
    logProjectionFailure(projected.reason, capability);
    return withTelemetry({
      ok: false,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: projected.reason || 'projection_failed',
      capability,
    }, { ledger: projected.ledger, rollbackActive: false, sourceKind: 'kea_snapshot' });
  }
  if (!projected.promptable) {
    return withTelemetry({
      ok: true,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: projected.reason || 'unavailable',
      capability,
    }, { ledger: projected.ledger, rollbackActive: false, sourceKind: 'kea_snapshot' });
  }

  return withTelemetry({
    ok: true,
    mode: 'ledger_v1',
    promptable: true,
    failSoft: false,
    block: buildLedgerEvidenceSystemSection(projected.view.promptEvidence),
    promptEvidence: projected.view.promptEvidence,
    reason: null,
    capability,
  }, {
    ledger: projected.ledger,
    promptEvidence: projected.view.promptEvidence,
    rollbackActive: false,
    sourceKind: 'kea_snapshot',
  });
}

function projectSnapshotEvidence(input) {
  try {
    return projectSnapshotEvidenceUnsafe(input);
  } catch (err) {
    logProjectionFailure('projection_exception', input && input.capability);
    return withTelemetry({
      ok: false,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: 'projection_exception',
      capability: input && input.capability ? input.capability : 'financial_forecast',
    }, { rollbackActive: false, sourceKind: 'kea_snapshot' });
  }
}

function projectLookupLedgerView(input = {}) {
  const evidence = input.evidence;
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, reason: 'missing_evidence', ledger: null, view: null, promptable: false };
  }
  const built = buildEvidenceLedger({
    capability: 'financial_lookup',
    evidence,
    route: input.route || null,
    accountContext: input.accountContext || null,
    responseMode: input.responseMode || null,
  });
  if (!built.ok || !built.ledger) {
    return {
      ok: false,
      reason: built.reason === 'validation_failed' ? 'ledger_invalid' : (built.reason || 'ledger_failed'),
      ledger: null,
      view: null,
      promptable: false,
    };
  }
  if (built.ledger.status === 'unavailable' || built.ledger.status === 'unsupported') {
    return {
      ok: true,
      reason: built.ledger.status,
      ledger: built.ledger,
      view: null,
      promptable: false,
    };
  }
  const view = toPromptEvidence(built.ledger, { responseMode: input.responseMode || null });
  if (!view.ok || !view.promptable || !view.promptEvidence) {
    const mapped = view.reason === 'validation_failed' || view.reason === 'invalid_ledger'
      ? 'prompt_view_invalid'
      : (view.reason || 'prompt_view_failed');
    return {
      ok: false,
      reason: mapped,
      ledger: built.ledger,
      view,
      promptable: false,
    };
  }
  return {
    ok: true,
    reason: null,
    ledger: built.ledger,
    view,
    promptable: true,
  };
}

function projectLookupEvidenceUnsafe(input = {}) {
  const capability = input.capability || 'financial_lookup';
  const evidence = input.evidence;
  const sourceKind = firstEvidenceSource(evidence) || null;

  if (!isEligibleLookupCutover({ capability, evidence })) {
    return withTelemetry({
      ok: true,
      mode: 'legacy',
      promptable: true,
      failSoft: false,
      block: null,
      reason: 'legacy',
      capability,
    }, {
      rollbackActive: false,
      sourceKind: sourceKind || 'none',
    });
  }

  if (!isLookupLedgerPromptEnabled()) {
    return withTelemetry({
      ok: true,
      mode: 'legacy',
      promptable: true,
      failSoft: false,
      block: null,
      reason: 'legacy',
      capability,
    }, {
      rollbackActive: true,
      sourceKind: 'user_transactions',
    });
  }

  if (!evidence || typeof evidence !== 'object') {
    logProjectionFailure('missing_evidence', capability);
    return withTelemetry({
      ok: false,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: 'missing_evidence',
      capability,
    }, { rollbackActive: false, sourceKind: 'user_transactions' });
  }
  if (evidence.status === 'unavailable') {
    return withTelemetry({
      ok: true,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: 'unavailable',
      capability,
    }, { rollbackActive: false, sourceKind: 'user_transactions' });
  }

  const projected = projectLookupLedgerView(input);
  if (!projected.ok) {
    logProjectionFailure(projected.reason, capability);
    return withTelemetry({
      ok: false,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: projected.reason || 'projection_failed',
      capability,
    }, { ledger: projected.ledger, rollbackActive: false, sourceKind: 'user_transactions' });
  }
  if (!projected.promptable) {
    return withTelemetry({
      ok: true,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: projected.reason || 'unavailable',
      capability,
    }, { ledger: projected.ledger, rollbackActive: false, sourceKind: 'user_transactions' });
  }

  return withTelemetry({
    ok: true,
    mode: 'ledger_v1',
    promptable: true,
    failSoft: false,
    block: buildLedgerEvidenceSystemSection(projected.view.promptEvidence),
    promptEvidence: projected.view.promptEvidence,
    reason: null,
    capability,
  }, {
    ledger: projected.ledger,
    promptEvidence: projected.view.promptEvidence,
    rollbackActive: false,
    sourceKind: 'user_transactions',
  });
}

function projectLookupEvidence(input) {
  try {
    return projectLookupEvidenceUnsafe(input);
  } catch (err) {
    logProjectionFailure('projection_exception', input && input.capability);
    return withTelemetry({
      ok: false,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: 'projection_exception',
      capability: input && input.capability ? input.capability : 'financial_lookup',
    }, { rollbackActive: false, sourceKind: 'user_transactions' });
  }
}

function projectApprovedMacroEvidenceUnsafe(input = {}) {
  const capability = resolveCutoverCapability(input);
  if (!shouldUseLedgerPrompt(capability)) {
    return withTelemetry({
      ok: true,
      mode: 'legacy',
      promptable: true,
      failSoft: false,
      block: null,
      reason: 'legacy',
      capability,
    });
  }

  const evidence = input.evidence;
  if (!evidence || typeof evidence !== 'object') {
    logProjectionFailure('missing_evidence', capability);
    return withTelemetry({
      ok: false,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: 'missing_evidence',
      capability,
    });
  }
  if (evidence.status === 'unavailable') {
    return withTelemetry({
      ok: true,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: 'unavailable',
      capability,
    });
  }

  const responseMode = resolveCutoverResponseMode(input);
  const built = buildEvidenceLedger({
    capability,
    responseMode,
    evidence,
    route: input.route || null,
    accountContext: input.accountContext || null,
  });
  if (!built.ok || !built.ledger) {
    const mapped = built.reason === 'validation_failed' ? 'ledger_invalid' : (built.reason || 'ledger_failed');
    logProjectionFailure(mapped, capability);
    return withTelemetry({
      ok: false,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: mapped,
      capability,
    });
  }
  if (built.ledger.status === 'unavailable' || built.ledger.status === 'unsupported') {
    return withTelemetry({
      ok: true,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: built.ledger.status,
      capability,
    }, { ledger: built.ledger });
  }

  const view = toPromptEvidence(built.ledger, { responseMode });
  if (!view.ok || !view.promptable || !view.promptEvidence) {
    const mapped = view.reason === 'validation_failed' || view.reason === 'invalid_ledger'
      ? 'prompt_view_invalid'
      : (view.reason || 'prompt_view_failed');
    logProjectionFailure(mapped, capability);
    return withTelemetry({
      ok: false,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: mapped,
      capability,
    }, { ledger: built.ledger });
  }

  return withTelemetry({
    ok: true,
    mode: 'ledger_v1',
    promptable: true,
    failSoft: false,
    block: buildLedgerEvidenceSystemSection(view.promptEvidence),
    promptEvidence: view.promptEvidence,
    reason: null,
    capability,
  }, { ledger: built.ledger, promptEvidence: view.promptEvidence });
}

function projectApprovedMacroEvidence(input) {
  try {
    return projectApprovedMacroEvidenceUnsafe(input);
  } catch (err) {
    logProjectionFailure('projection_exception', input && input.capability);
    return withTelemetry({
      ok: false,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: 'projection_exception',
      capability: input && input.capability ? input.capability : null,
    });
  }
}

module.exports = {
  LEDGER_PROMPT_ENV_KEY,
  LOOKUP_PROMPT_ENV_KEY,
  SNAPSHOT_PROMPT_ENV_KEY,
  APPROVED_MACRO_CAPABILITIES,
  isLedgerPromptEnabled,
  isEvidenceRollbackActive,
  isLookupLedgerPromptEnabled,
  isLookupEvidenceRollbackActive,
  isSnapshotLedgerPromptEnabled,
  isSnapshotEvidenceRollbackActive,
  parseLedgerPromptFlag,
  isApprovedMacroCapability,
  shouldUseLedgerPrompt,
  shouldUseLookupLedgerPrompt,
  shouldUseSnapshotLedgerPrompt,
  isEligibleLookupCutover,
  isEligibleSnapshotCutover,
  isSnapshotBackedLookup,
  firstEvidenceSource,
  resolveCutoverCapability,
  resolveCutoverResponseMode,
  buildLedgerEvidenceSystemSection,
  projectApprovedMacroEvidence,
  projectLookupLedgerView,
  projectLookupEvidence,
  projectSnapshotLedgerView,
  projectSnapshotEvidence,
};
