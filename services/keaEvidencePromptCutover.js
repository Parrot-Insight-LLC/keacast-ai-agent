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

const LEDGER_PROMPT_ENV_KEY = 'USE_EVIDENCE_LEDGER_PROMPT';

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

function isLedgerPromptEnabled() {
  const raw = process.env[LEDGER_PROMPT_ENV_KEY];
  if (raw == null || String(raw).trim() === '') return true;
  return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

function isApprovedMacroCapability(capability) {
  return APPROVED_SET.has(capability);
}

function shouldUseLedgerPrompt(capability) {
  return isLedgerPromptEnabled() && isApprovedMacroCapability(capability);
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

function projectApprovedMacroEvidenceUnsafe(input = {}) {
  const capability = resolveCutoverCapability(input);
  if (!shouldUseLedgerPrompt(capability)) {
    return {
      ok: true,
      mode: 'legacy',
      promptable: true,
      failSoft: false,
      block: null,
      reason: 'legacy',
      capability,
    };
  }

  const evidence = input.evidence;
  if (!evidence || typeof evidence !== 'object') {
    logProjectionFailure('missing_evidence', capability);
    return {
      ok: false,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: 'missing_evidence',
      capability,
    };
  }
  if (evidence.status === 'unavailable') {
    return {
      ok: true,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: 'unavailable',
      capability,
    };
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
    logProjectionFailure(built.reason || 'ledger_failed', capability);
    return {
      ok: false,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: built.reason || 'ledger_failed',
      capability,
    };
  }
  if (built.ledger.status === 'unavailable' || built.ledger.status === 'unsupported') {
    return {
      ok: true,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: built.ledger.status,
      capability,
    };
  }

  const view = toPromptEvidence(built.ledger, { responseMode });
  if (!view.ok || !view.promptable || !view.promptEvidence) {
    logProjectionFailure(view.reason || 'prompt_view_failed', capability);
    return {
      ok: false,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: view.reason || 'prompt_view_failed',
      capability,
    };
  }

  return {
    ok: true,
    mode: 'ledger_v1',
    promptable: true,
    failSoft: false,
    block: buildLedgerEvidenceSystemSection(view.promptEvidence),
    promptEvidence: view.promptEvidence,
    reason: null,
    capability,
  };
}

function projectApprovedMacroEvidence(input) {
  try {
    return projectApprovedMacroEvidenceUnsafe(input);
  } catch (err) {
    logProjectionFailure('projection_exception', input && input.capability);
    return {
      ok: false,
      mode: 'ledger_v1',
      promptable: false,
      failSoft: true,
      block: null,
      reason: 'projection_exception',
      capability: input && input.capability ? input.capability : null,
    };
  }
}

module.exports = {
  LEDGER_PROMPT_ENV_KEY,
  APPROVED_MACRO_CAPABILITIES,
  isLedgerPromptEnabled,
  isApprovedMacroCapability,
  shouldUseLedgerPrompt,
  resolveCutoverCapability,
  resolveCutoverResponseMode,
  buildLedgerEvidenceSystemSection,
  projectApprovedMacroEvidence,
};
