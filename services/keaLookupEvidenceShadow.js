'use strict';

/**
 * Phase 3B.3B.1 — request-local financial_lookup Ledger / Prompt View parity.
 *
 * Production cutover (3B.3B.2) serializes Prompt View via projectLookupEvidence.
 * This module compares that same projection with azureFacingEvidence and must
 * not own the Azure prompt.
 */

const {
  validatePromptEvidenceView,
  assertPromptEvidenceFactParity,
  collectBannedKeys,
  LIMITATION_TEXT_BY_CODE,
  serializedSize,
} = require('./keaEvidencePromptView');
const { azureFacingEvidence } = require('./keaGroundingPrefetch');
const {
  buildLedgerEvidenceSystemSection,
  projectLookupLedgerView,
  isEligibleLookupCutover,
  isSnapshotBackedLookup,
} = require('./keaEvidencePromptCutover');

const PRODUCTION_MODE = 'legacy';

function isUserTransactionsLookup({ capability, evidence } = {}) {
  return isEligibleLookupCutover({ capability, evidence });
}

function emptyParity() {
  return { ok: false, missing: [], intentional: [], compared: 0 };
}

function skipResult(skippedReason, extra = {}) {
  return Object.assign({
    ran: false,
    ok: true,
    productionMode: PRODUCTION_MODE,
    promptable: false,
    ledgerStatus: null,
    parity: { ok: true, missing: [], intentional: [], compared: 0 },
    sizes: null,
    reason: skippedReason,
    skippedReason,
  }, extra);
}

function serialized(value) {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return '';
  }
}

function logShadowFailure(result) {
  try {
    const missing = result && result.parity && Array.isArray(result.parity.missing)
      ? result.parity.missing.map((row) => row && row.path).filter(Boolean).slice(0, 8)
      : [];
    console.warn('Chat endpoint: lookup evidence shadow (ignored):', {
      reason: (result && result.reason) || 'parity_mismatch',
      ledgerStatus: (result && result.ledgerStatus) || null,
      promptable: !!(result && result.promptable),
      missingCount: missing.length,
      missingPaths: missing,
    });
  } catch (err) {
    /* shadow logging must not throw */
  }
}

function expectedLedgerStatus(evidence) {
  const status = evidence && evidence.status;
  if (status === 'unavailable') return 'unavailable';
  if (status === 'partial') return 'partial';
  const facts = (evidence && evidence.facts) || {};
  const lookups = Array.isArray(evidence && evidence.lookups) ? evidence.lookups : [];
  const empty = facts.transactionCount === 0
    || (lookups.length > 0 && lookups.every((row) => row && row.transactionCount === 0));
  if (empty) return 'complete_empty';
  return 'complete';
}

function pushMissing(missing, path, expected, actual) {
  missing.push({ path, expected, actual });
}

function sameValue(actual, expected) {
  if (actual === expected) return true;
  if (expected == null && actual == null) return true;
  try {
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch (err) {
    return false;
  }
}

function compareLookupParity({ evidence, legacy, promptEvidence, ledger }) {
  const intentional = [];
  const missing = [];
  intentional.push({ path: 'source', reason: 'source_replaced_by_description' });
  intentional.push({ path: 'limitations', reason: 'limitation_codes_mapped' });
  intentional.push({ path: 'prefetchMeta', reason: 'prefetchMeta_internal' });
  intentional.push({ path: 'status', reason: 'status_renamed_complete' });
  intentional.push({ path: 'dataAsOf', reason: 'dataAsOf_omitted' });
  intentional.push({ path: 'CURRENT CONTEXT', reason: 'generic_context_excluded' });
  intentional.push({ path: 'identity', reason: 'identity_excluded' });

  if (!ledger) {
    return { ok: false, missing: [{ path: 'ledger', expected: 'present', actual: null }], intentional, compared: 0 };
  }

  const expectedStatus = expectedLedgerStatus(evidence);
  if (ledger.status !== expectedStatus) {
    pushMissing(missing, 'ledger.status', expectedStatus, ledger.status);
  }

  if (expectedStatus === 'unavailable' || expectedStatus === 'unsupported') {
    if (promptEvidence != null) {
      pushMissing(missing, 'promptEvidence', null, 'present');
    }
    return {
      ok: missing.length === 0,
      missing,
      intentional,
      compared: 1,
      failSoft: true,
    };
  }

  if (!promptEvidence) {
    return {
      ok: false,
      missing: [{ path: 'promptEvidence', expected: 'present', actual: null }],
      intentional,
      compared: 0,
    };
  }

  const factParity = assertPromptEvidenceFactParity({
    current: legacy,
    promptView: promptEvidence,
    capability: 'financial_lookup',
  });
  for (let i = 0; i < (factParity.intentional || []).length; i += 1) {
    intentional.push(factParity.intentional[i]);
  }
  for (let i = 0; i < (factParity.missing || []).length; i += 1) {
    missing.push(factParity.missing[i]);
  }

  const facts = (legacy && legacy.facts) || {};
  const viewFacts = (promptEvidence && promptEvidence.facts) || {};
  const keys = ['transactionCount', 'spentTotal', 'expenseTotal', 'incomeTotal'];
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (facts[key] === undefined) continue;
    if (!sameValue(viewFacts[key], facts[key])) {
      pushMissing(missing, `facts.${key}`, facts[key], viewFacts[key]);
    }
  }

  if (legacy.period && legacy.period.start) {
    const start = promptEvidence.period && promptEvidence.period.start;
    const end = promptEvidence.period && promptEvidence.period.end;
    if (start !== legacy.period.start) pushMissing(missing, 'period.start', legacy.period.start, start);
    if (end !== legacy.period.end) pushMissing(missing, 'period.end', legacy.period.end, end);
  }

  const lookups = Array.isArray(legacy && legacy.lookups) ? legacy.lookups : [];
  const viewLookups = Array.isArray(viewFacts.lookups) ? viewFacts.lookups : [];
  if (lookups.length !== viewLookups.length) {
    pushMissing(missing, 'facts.lookups.length', lookups.length, viewLookups.length);
  }
  const lookupKeys = [
    'subjectKind', 'subjectValue', 'status', 'transactionCount', 'spentTotal', 'expenseTotal', 'incomeTotal',
  ];
  for (let i = 0; i < lookups.length; i += 1) {
    const src = lookups[i] || {};
    const dst = viewLookups[i] || {};
    for (let k = 0; k < lookupKeys.length; k += 1) {
      const key = lookupKeys[k];
      if (src[key] === undefined) continue;
      if (!sameValue(dst[key], src[key])) {
        pushMissing(missing, `facts.lookups[${i}].${key}`, src[key], dst[key]);
      }
    }
    if (src.period && src.period.start) {
      const start = dst.period && dst.period.start;
      const end = dst.period && dst.period.end;
      if (start !== src.period.start) {
        pushMissing(missing, `facts.lookups[${i}].period.start`, src.period.start, start);
      }
      if (end !== src.period.end) {
        pushMissing(missing, `facts.lookups[${i}].period.end`, src.period.end, end);
      }
    }
  }

  const codes = Array.isArray(evidence && evidence.limitations) ? evidence.limitations : [];
  const texts = Array.isArray(promptEvidence.limitations) ? promptEvidence.limitations : [];
  for (let i = 0; i < codes.length; i += 1) {
    const mapped = LIMITATION_TEXT_BY_CODE[codes[i]];
    if (!mapped) {
      intentional.push({ path: `limitations.${codes[i]}`, reason: 'unmapped_limitation_code' });
      continue;
    }
    if (texts.indexOf(mapped) === -1) {
      pushMissing(missing, `limitations.${codes[i]}`, mapped, null);
    }
  }

  const sourceText = promptEvidence.source && promptEvidence.source.description;
  if (sourceText !== 'posted transactions for the selected period') {
    pushMissing(
      missing,
      'source.description',
      'posted transactions for the selected period',
      sourceText
    );
  }

  if (viewFacts.signConvention && viewFacts.signConvention !== 'magnitude') {
    pushMissing(missing, 'facts.signConvention', 'magnitude', viewFacts.signConvention);
  }

  return {
    ok: missing.length === 0,
    missing,
    intentional,
    compared: (factParity.compared || 0) + keys.length + lookups.length,
  };
}

function measureSizes({ evidence, ledger, promptEvidence }) {
  const legacy = azureFacingEvidence(evidence);
  const wrapper = promptEvidence ? buildLedgerEvidenceSystemSection(promptEvidence) : '';
  return {
    legacy: serializedSize(legacy),
    ledger: serializedSize(ledger),
    promptView: serializedSize(promptEvidence),
    wrapper: wrapper ? Buffer.byteLength(wrapper, 'utf8') : 0,
  };
}

function privacyHits(promptEvidence, unmatchedLabels) {
  const src = serialized(promptEvidence);
  const hits = [];
  const banned = collectBannedKeys(promptEvidence);
  if (banned.length) hits.push('banned_keys');
  if (/"prefetchMeta"/.test(src) || /pageCount|rowCount|matchCount|periodReadCount/.test(src)) {
    hits.push('prefetchMeta');
  }
  if (/transactionid|groupid|accountId|userid|jwt/i.test(src)) hits.push('internal_id');
  const labels = Array.isArray(unmatchedLabels) ? unmatchedLabels : [];
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    if (label && src.indexOf(label) !== -1) hits.push(`unmatched:${label}`);
  }
  return hits;
}

function shadowLookupEvidenceUnsafe(input = {}) {
  const capability = input.capability;
  const evidence = input.evidence;
  if (capability !== 'financial_lookup') {
    return skipResult('not_financial_lookup');
  }
  if (isSnapshotBackedLookup({ capability, evidence })) {
    return skipResult('snapshot_backed_lookup');
  }
  if (!isUserTransactionsLookup({ capability, evidence })) {
    return skipResult('not_user_transactions');
  }

  const projected = projectLookupLedgerView({
    evidence,
    route: input.route || null,
    accountContext: input.accountContext || null,
    responseMode: input.responseMode || null,
  });
  if (!projected.ok && !projected.ledger) {
    const result = {
      ran: true,
      ok: false,
      productionMode: PRODUCTION_MODE,
      promptable: false,
      ledgerStatus: null,
      parity: emptyParity(),
      sizes: null,
      reason: projected.reason || 'ledger_failed',
      promptEvidence: null,
      ledger: null,
    };
    logShadowFailure(result);
    return result;
  }

  const view = projected.view || { ok: false, promptable: false, promptEvidence: null, unmappedLimitations: [] };
  const promptable = !!(projected.promptable && view.promptEvidence);
  const legacy = azureFacingEvidence(evidence);
  const parity = compareLookupParity({
    evidence,
    legacy,
    promptEvidence: view.promptEvidence || null,
    ledger: projected.ledger,
  });

  if (promptable) {
    const validated = validatePromptEvidenceView(view.promptEvidence);
    if (!validated.ok) {
      parity.ok = false;
      parity.missing.push({ path: 'validatePromptEvidenceView', expected: 'ok', actual: validated.errors });
    }
  }

  const sizes = measureSizes({
    evidence,
    ledger: projected.ledger,
    promptEvidence: view.promptEvidence || null,
  });

  const result = {
    ran: true,
    ok: parity.ok,
    productionMode: PRODUCTION_MODE,
    promptable,
    ledgerStatus: projected.ledger ? projected.ledger.status : null,
    parity,
    sizes,
    reason: parity.ok ? null : 'parity_mismatch',
    promptEvidence: view.promptEvidence || null,
    ledger: projected.ledger,
    unmappedLimitations: view.unmappedLimitations || [],
    privacyHits: promptable ? privacyHits(view.promptEvidence, input.unmatchedLabels) : [],
  };
  if (!result.ok) logShadowFailure(result);
  return result;
}

function shadowLookupEvidence(input) {
  try {
    return shadowLookupEvidenceUnsafe(input);
  } catch (err) {
    const result = {
      ran: true,
      ok: false,
      productionMode: PRODUCTION_MODE,
      promptable: false,
      ledgerStatus: null,
      parity: emptyParity(),
      sizes: null,
      reason: 'shadow_exception',
      promptEvidence: null,
      ledger: null,
    };
    logShadowFailure(result);
    return result;
  }
}

function evidenceFingerprint(evidence) {
  return serialized(evidence);
}

module.exports = {
  PRODUCTION_MODE,
  isUserTransactionsLookup,
  isSnapshotBackedLookup,
  shadowLookupEvidence,
  compareLookupParity,
  privacyHits,
  evidenceFingerprint,
};
