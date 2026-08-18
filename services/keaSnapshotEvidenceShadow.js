'use strict';

/**
 * Phase 3B.3B.4 — request-local snapshot Ledger / Prompt View shadow parity.
 *
 * Compares structured compact selectedAccount + phase1 snapshot facts with the
 * adapted Ledger / Prompt View. Production Azure uses projectSnapshotEvidence
 * (3B.3B.5). This harness remains request-local parity coverage and must not
 * fetch, must not call Azure, and must not own the prompt.
 */

const {
  collectBannedKeys,
  LIMITATION_TEXT_BY_CODE,
} = require('./keaEvidencePromptView');
const {
  isEligibleLookupCutover,
  isEligibleSnapshotCutover,
  projectSnapshotLedgerView,
} = require('./keaEvidencePromptCutover');

const PRODUCTION_MODE = 'legacy';

const CLASSIFICATION = Object.freeze({
  EXACT_PARITY: 'EXACT_PARITY',
  INTENTIONAL_IMPROVEMENT: 'INTENTIONAL_IMPROVEMENT',
  LEGACY_BUG_TO_REMOVE_AT_CUTOVER: 'LEGACY_BUG_TO_REMOVE_AT_CUTOVER',
  MISSING_LEDGER_FACT_BLOCKER: 'MISSING_LEDGER_FACT_BLOCKER',
  PHASE_3C_RESIDUAL: 'PHASE_3C_RESIDUAL',
  PHASE_3D_CONCERN: 'PHASE_3D_CONCERN',
});

const REQUIRED_SCALARS = Object.freeze([
  'availableBalance',
  'currentBalance',
  'reconciledBalance',
  'credit_limit',
  'monthIncome',
  'monthExpenses',
  'monthNet',
  'savingsPotential',
  'upcomingExpenseTotal',
  'upcomingIncomeTotal',
  'upcomingWindowDays',
  'negativePreviewCount',
  'hasNegativePreview',
  'negativesInRequestedPeriodCount',
  'hasNegativeInRequestedPeriod',
]);

const SNAPSHOT_LIMITATION_CODES = Object.freeze([
  'upcoming_window_15d',
  'negatives_preview_5_of_90d',
  'recents_capped_10',
]);

const EXPECTED_SOURCE_DESCRIPTION = 'compact selected-account snapshot, including a 15-day upcoming window';

const CURRENT_CONTEXT_INVENTORY = Object.freeze([
  { code: 'balances', cutover: 'required' },
  { code: 'credit_limit', cutover: 'required_if_present' },
  { code: 'month_snapshot', cutover: 'required' },
  { code: 'upcoming_totals', cutover: 'required' },
  { code: 'upcoming_rows', cutover: 'required' },
  { code: 'recents', cutover: 'required' },
  { code: 'future_negatives', cutover: 'required' },
  { code: 'top_categories', cutover: 'not_required' },
  { code: 'top_merchants', cutover: 'not_required' },
  { code: 'goals', cutover: 'not_required' },
  { code: 'plaid_latest', cutover: 'not_required' },
  { code: 'available_categories', cutover: 'not_required' },
  { code: 'product_knowledge', cutover: 'not_required' },
  { code: 'memory_history_summary', cutover: 'not_required' },
  { code: 'disposable_wording', cutover: 'phase_3c' },
]);

const SUPPORTED_SNAPSHOT_QUESTION_CLASSES = Object.freeze([
  {
    id: 'snapshot_forecast_upcoming',
    example: 'What do I have upcoming in the next two weeks?',
    capability: 'financial_forecast',
    required: ['upcoming', 'upcomingExpenseTotal', 'upcomingIncomeTotal', 'upcomingWindowDays'],
  },
  {
    id: 'snapshot_lookup_balance',
    example: "What's my available balance?",
    capability: 'financial_lookup',
    required: ['availableBalance'],
  },
  {
    id: 'snapshot_forecast_next_month_balance',
    example: 'What will my balance be next month?',
    capability: 'financial_forecast',
    required: ['availableBalance', 'currentBalance', 'monthNet', 'savingsPotential'],
  },
]);

function fingerprint(value) {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return '';
  }
}

function isSnapshotShadowEligible({ capability, evidence } = {}) {
  if (isEligibleLookupCutover({ capability, evidence })) return false;
  return isEligibleSnapshotCutover({ capability, evidence });
}

function sameValue(actual, expected) {
  if (actual === expected) return true;
  if (expected == null && actual == null) return true;
  return false;
}

function rowLabel(row) {
  if (!row || typeof row !== 'object') return null;
  return row.name || row.merchant_name || null;
}

function rowDate(row, kind) {
  if (!row || typeof row !== 'object') return null;
  if (kind === 'upcoming') return row.start || row.date || null;
  return row.date || row.start || null;
}

function wouldFmtMoneyRound(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return false;
  const abs = Math.abs(n);
  if (abs < 10) return false;
  return abs !== Math.round(abs);
}

function signOf(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n === 0) return 0;
  return n > 0 ? 1 : -1;
}

function emptyCounts() {
  return {
    comparedFactCount: 0,
    exactCount: 0,
    intentionalImprovementCount: 0,
    legacyBugCount: 0,
    missingLedgerFactCount: 0,
    phase3CResidualCount: 0,
    phase3DConcernCount: 0,
    unexplainedMismatchCount: 0,
  };
}

function skipResult(skippedReason) {
  return Object.assign({
    status: 'skipped',
    ran: false,
    productionMode: PRODUCTION_MODE,
    promptable: false,
    reason: skippedReason,
    skippedReason,
    differences: [],
    differenceCodes: [],
    readiness: { upcomingForecast: false, balanceLookup: false },
  }, emptyCounts());
}

function sortDifferences(rows) {
  return rows.slice().sort((a, b) => {
    const code = String(a.code || '').localeCompare(String(b.code || ''));
    if (code !== 0) return code;
    const path = String(a.legacyPath || '').localeCompare(String(b.legacyPath || ''));
    if (path !== 0) return path;
    return String(a.classification || '').localeCompare(String(b.classification || ''));
  });
}

function bump(counts, classification) {
  if (classification === CLASSIFICATION.EXACT_PARITY) counts.exactCount += 1;
  else if (classification === CLASSIFICATION.INTENTIONAL_IMPROVEMENT) counts.intentionalImprovementCount += 1;
  else if (classification === CLASSIFICATION.LEGACY_BUG_TO_REMOVE_AT_CUTOVER) counts.legacyBugCount += 1;
  else if (classification === CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER) counts.missingLedgerFactCount += 1;
  else if (classification === CLASSIFICATION.PHASE_3C_RESIDUAL) counts.phase3CResidualCount += 1;
  else if (classification === CLASSIFICATION.PHASE_3D_CONCERN) counts.phase3DConcernCount += 1;
}

function pushDiff(differences, counts, row) {
  differences.push({
    code: row.code,
    classification: row.classification,
    legacyPath: row.legacyPath,
    ledgerPath: row.ledgerPath,
    reason: row.reason,
  });
  counts.comparedFactCount += 1;
  bump(counts, row.classification);
}

function limitationTextPresent(texts, code) {
  const mapped = LIMITATION_TEXT_BY_CODE[code];
  if (!mapped || !Array.isArray(texts)) return false;
  return texts.indexOf(mapped) !== -1;
}

function compactList(selectedAccount, key) {
  if (!selectedAccount || !Array.isArray(selectedAccount[key])) return [];
  return selectedAccount[key];
}

function compareList({
  differences,
  counts,
  compactRows,
  viewRows,
  kind,
  labelKey,
  amountKey,
}) {
  const src = Array.isArray(compactRows) ? compactRows : [];
  const dst = Array.isArray(viewRows) ? viewRows : [];
  const lengthCode = `${kind}_row_count`;
  if (src.length !== dst.length) {
    counts.unexplainedMismatchCount += 1;
    pushDiff(differences, counts, {
      code: lengthCode,
      classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
      legacyPath: `selectedAccount.${kind}.length`,
      ledgerPath: `facts.${kind}.length`,
      reason: 'row_count_mismatch',
    });
  } else {
    counts.comparedFactCount += 1;
    counts.exactCount += 1;
  }

  const n = src.length < dst.length ? src.length : dst.length;
  for (let i = 0; i < n; i += 1) {
    const left = src[i] || {};
    const right = dst[i] || {};
    const nameLeft = rowLabel(left);
    const nameRight = rowLabel(right);
    if (nameLeft != null && !sameValue(nameRight, nameLeft)) {
      counts.unexplainedMismatchCount += 1;
      pushDiff(differences, counts, {
        code: `${kind}_label_${i}`,
        classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
        legacyPath: `selectedAccount.${kind}[${i}].${labelKey}`,
        ledgerPath: `facts.${kind}[${i}].${labelKey}`,
        reason: 'label_mismatch',
      });
    } else if (nameLeft != null) {
      counts.comparedFactCount += 1;
      counts.exactCount += 1;
    }

    const amtLeft = left[amountKey];
    const amtRight = right[amountKey];
    if (amtLeft !== undefined && !sameValue(amtRight, amtLeft)) {
      counts.unexplainedMismatchCount += 1;
      pushDiff(differences, counts, {
        code: `${kind}_amount_${i}`,
        classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
        legacyPath: `selectedAccount.${kind}[${i}].amount`,
        ledgerPath: `facts.${kind}[${i}].amount`,
        reason: 'value_mismatch',
      });
    } else if (amtLeft !== undefined) {
      counts.comparedFactCount += 1;
      counts.exactCount += 1;
    }

    if (amtLeft !== undefined && signOf(amtLeft) !== signOf(amtRight)) {
      counts.unexplainedMismatchCount += 1;
      pushDiff(differences, counts, {
        code: `${kind}_sign_${i}`,
        classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
        legacyPath: `selectedAccount.${kind}[${i}].amount`,
        ledgerPath: `facts.${kind}[${i}].amount`,
        reason: 'sign_mismatch',
      });
    } else if (amtLeft !== undefined) {
      counts.comparedFactCount += 1;
      counts.exactCount += 1;
    }

    const dateLeft = rowDate(left, kind);
    const dateRight = rowDate(right, kind);
    if (dateLeft != null && !sameValue(dateRight, dateLeft)) {
      counts.unexplainedMismatchCount += 1;
      pushDiff(differences, counts, {
        code: `${kind}_date_${i}`,
        classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
        legacyPath: `selectedAccount.${kind}[${i}].date`,
        ledgerPath: `facts.${kind}[${i}].date`,
        reason: 'order_or_date_mismatch',
      });
    } else if (dateLeft != null) {
      counts.comparedFactCount += 1;
      counts.exactCount += 1;
    }
  }
}

function collectRoundedAmounts(selectedAccount, evidence) {
  const amounts = [];
  const facts = (evidence && evidence.facts) || {};
  const scalarKeys = [
    'availableBalance', 'currentBalance', 'reconciledBalance', 'credit_limit',
    'monthIncome', 'monthExpenses', 'monthNet', 'savingsPotential',
    'upcomingExpenseTotal', 'upcomingIncomeTotal',
  ];
  for (let i = 0; i < scalarKeys.length; i += 1) {
    const n = facts[scalarKeys[i]];
    if (wouldFmtMoneyRound(n)) amounts.push(n);
  }
  const lists = [
    compactList(selectedAccount, 'recents'),
    compactList(selectedAccount, 'upcoming'),
    compactList(selectedAccount, 'futureNegativeBalances'),
  ];
  for (let i = 0; i < lists.length; i += 1) {
    for (let j = 0; j < lists[i].length; j += 1) {
      const n = lists[i][j] && lists[i][j].amount;
      if (wouldFmtMoneyRound(n)) amounts.push(n);
    }
  }
  return amounts;
}

function compareSnapshotParity({
  evidence,
  selectedAccount,
  promptEvidence,
  ledger,
} = {}) {
  const differences = [];
  const counts = emptyCounts();
  const facts = (evidence && evidence.facts) || {};
  const viewFacts = (promptEvidence && promptEvidence.facts) || {};

  if (!ledger) {
    pushDiff(differences, counts, {
      code: 'ledger',
      classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
      legacyPath: 'phase1Evidence',
      ledgerPath: 'ledger',
      reason: 'ledger_missing',
    });
    return finalizeParity(differences, counts, promptEvidence);
  }
  if (!promptEvidence) {
    pushDiff(differences, counts, {
      code: 'prompt_evidence',
      classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
      legacyPath: 'phase1Evidence',
      ledgerPath: 'promptEvidence',
      reason: 'prompt_view_missing',
    });
    return finalizeParity(differences, counts, promptEvidence);
  }

  for (let i = 0; i < REQUIRED_SCALARS.length; i += 1) {
    const key = REQUIRED_SCALARS[i];
    if (facts[key] === undefined) continue;
    if (viewFacts[key] === undefined) {
      pushDiff(differences, counts, {
        code: `scalar_${key}`,
        classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
        legacyPath: `phase1Evidence.facts.${key}`,
        ledgerPath: `facts.${key}`,
        reason: 'missing_ledger_fact',
      });
      continue;
    }
    if (!sameValue(viewFacts[key], facts[key])) {
      counts.unexplainedMismatchCount += 1;
      pushDiff(differences, counts, {
        code: `scalar_${key}`,
        classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
        legacyPath: `phase1Evidence.facts.${key}`,
        ledgerPath: `facts.${key}`,
        reason: 'value_mismatch',
      });
      continue;
    }
    counts.comparedFactCount += 1;
    counts.exactCount += 1;
  }

  compareList({
    differences,
    counts,
    compactRows: compactList(selectedAccount, 'upcoming'),
    viewRows: viewFacts.upcoming,
    kind: 'upcoming',
    labelKey: 'name',
    amountKey: 'amount',
  });
  compareList({
    differences,
    counts,
    compactRows: compactList(selectedAccount, 'recents'),
    viewRows: viewFacts.recents,
    kind: 'recents',
    labelKey: 'name',
    amountKey: 'amount',
  });
  compareList({
    differences,
    counts,
    compactRows: compactList(selectedAccount, 'futureNegativeBalances'),
    viewRows: viewFacts.futureNegativeBalances,
    kind: 'futureNegativeBalances',
    labelKey: 'date',
    amountKey: 'amount',
  });

  const codes = Array.isArray(evidence && evidence.limitations) ? evidence.limitations : [];
  const texts = Array.isArray(promptEvidence.limitations) ? promptEvidence.limitations : [];
  for (let i = 0; i < SNAPSHOT_LIMITATION_CODES.length; i += 1) {
    const code = SNAPSHOT_LIMITATION_CODES[i];
    if (codes.indexOf(code) === -1) continue;
    if (!limitationTextPresent(texts, code)) {
      pushDiff(differences, counts, {
        code: `limitation_${code}`,
        classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
        legacyPath: `phase1Evidence.limitations.${code}`,
        ledgerPath: 'limitations',
        reason: 'limitation_meaning_missing',
      });
    } else {
      counts.comparedFactCount += 1;
      counts.exactCount += 1;
    }
  }

  const sourceText = promptEvidence.source && promptEvidence.source.description;
  if (sourceText !== EXPECTED_SOURCE_DESCRIPTION) {
    pushDiff(differences, counts, {
      code: 'source_description',
      classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
      legacyPath: 'kea_snapshot',
      ledgerPath: 'source.description',
      reason: 'source_broader_or_missing_15d',
    });
  } else {
    counts.comparedFactCount += 1;
    counts.exactCount += 1;
  }

  if (promptEvidence.accountScope !== 'selected_account') {
    pushDiff(differences, counts, {
      code: 'account_scope',
      classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
      legacyPath: 'selected_account',
      ledgerPath: 'accountScope',
      reason: 'account_scope_mismatch',
    });
  } else {
    counts.comparedFactCount += 1;
    counts.exactCount += 1;
  }

  const viewSrc = fingerprint(promptEvidence);
  if (/accountId|accountid/.test(viewSrc)) {
    pushDiff(differences, counts, {
      code: 'account_id_exposed',
      classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
      legacyPath: 'selectedAccount.accountid',
      ledgerPath: 'promptEvidence',
      reason: 'account_id_in_prompt_view',
    });
  }

  const horizonsDistinct = viewFacts.upcomingWindowDays === 15
    && limitationTextPresent(texts, 'upcoming_window_15d')
    && limitationTextPresent(texts, 'negatives_preview_5_of_90d')
    && Array.isArray(viewFacts.upcoming)
    && Array.isArray(viewFacts.futureNegativeBalances);
  if (!horizonsDistinct) {
    counts.unexplainedMismatchCount += 1;
    pushDiff(differences, counts, {
      code: 'horizon_ambiguity',
      classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
      legacyPath: 'CURRENT CONTEXT mixed 15d+90d',
      ledgerPath: 'facts.upcoming + facts.futureNegativeBalances',
      reason: 'horizons_not_distinguishable',
    });
  } else {
    pushDiff(differences, counts, {
      code: 'prompt_view_horizon_separation',
      classification: CLASSIFICATION.INTENTIONAL_IMPROVEMENT,
      legacyPath: 'CURRENT CONTEXT mixes 15-day upcoming and ~90-day negatives',
      ledgerPath: 'facts.upcomingWindowDays + negatives_preview_5_of_90d',
      reason: 'separate_15d_and_90d_scopes',
    });
  }

  pushDiff(differences, counts, {
    code: 'legacy_upcoming_window_label_14d',
    classification: CLASSIFICATION.LEGACY_BUG_TO_REMOVE_AT_CUTOVER,
    legacyPath: 'CURRENT CONTEXT Next 14 days',
    ledgerPath: 'facts.upcomingWindowDays',
    reason: 'legacy_hardcodes_14_on_15_day_source',
  });
  pushDiff(differences, counts, {
    code: 'legacy_mixed_horizons_in_current_context',
    classification: CLASSIFICATION.LEGACY_BUG_TO_REMOVE_AT_CUTOVER,
    legacyPath: 'CURRENT CONTEXT upcoming + future negatives',
    ledgerPath: 'facts.upcoming vs facts.futureNegativeBalances',
    reason: 'short_horizon_contaminated_by_90d_preview',
  });

  const rounded = collectRoundedAmounts(selectedAccount, evidence);
  if (rounded.length > 0) {
    pushDiff(differences, counts, {
      code: 'legacy_fmtMoney_rounding',
      classification: CLASSIFICATION.LEGACY_BUG_TO_REMOVE_AT_CUTOVER,
      legacyPath: 'CURRENT CONTEXT fmtMoney',
      ledgerPath: 'facts exact numbers',
      reason: 'fmtMoney_rounds_ge_10',
    });
    pushDiff(differences, counts, {
      code: 'prompt_view_exact_decimals',
      classification: CLASSIFICATION.INTENTIONAL_IMPROVEMENT,
      legacyPath: 'CURRENT CONTEXT fmtMoney',
      ledgerPath: 'facts exact numbers',
      reason: 'prompt_view_keeps_source_decimals',
    });
  }

  pushDiff(differences, counts, {
    code: 'legacy_disposable_wording',
    classification: CLASSIFICATION.PHASE_3C_RESIDUAL,
    legacyPath: 'CURRENT CONTEXT forecasted disposable',
    ledgerPath: 'facts.monthNet + facts.savingsPotential',
    reason: 'disposable_is_wording_not_a_fact',
  });
  pushDiff(differences, counts, {
    code: 'unauthorized_ranking_from_current_context',
    classification: CLASSIFICATION.PHASE_3C_RESIDUAL,
    legacyPath: 'CURRENT CONTEXT top categories as levers',
    ledgerPath: 'not a snapshot Ledger ranking claim',
    reason: 'ranking_is_phase_3c',
  });
  pushDiff(differences, counts, {
    code: 'top_categories_not_required',
    classification: CLASSIFICATION.PHASE_3D_CONCERN,
    legacyPath: 'CURRENT CONTEXT top recent spending categories',
    ledgerPath: 'omitted from snapshot parity requirement',
    reason: 'owned_by_cashflow_analysis_or_fat_context',
  });
  pushDiff(differences, counts, {
    code: 'top_merchants_not_required',
    classification: CLASSIFICATION.PHASE_3D_CONCERN,
    legacyPath: 'compact topSpendingMerchants',
    ledgerPath: 'omitted from snapshot parity requirement',
    reason: 'not_required_for_snapshot_cutover',
  });
  pushDiff(differences, counts, {
    code: 'goals_not_required',
    classification: CLASSIFICATION.PHASE_3D_CONCERN,
    legacyPath: 'goalsBlock / facts.goalCount',
    ledgerPath: 'omitted from snapshot parity requirement',
    reason: 'planning_or_3d_context',
  });
  pushDiff(differences, counts, {
    code: 'generic_identity_history_product_faq',
    classification: CLASSIFICATION.PHASE_3D_CONCERN,
    legacyPath: 'identity / history / summary / product FAQ',
    ledgerPath: 'not snapshot financial evidence',
    reason: 'phase_3d_generic_context',
  });

  return finalizeParity(differences, counts, promptEvidence);
}

function factReady(viewFacts, key) {
  if (key === 'upcoming') return Array.isArray(viewFacts.upcoming);
  return viewFacts[key] !== undefined;
}

function classReadiness(promptEvidence, questionClass) {
  const facts = (promptEvidence && promptEvidence.facts) || {};
  const required = questionClass.required || [];
  for (let i = 0; i < required.length; i += 1) {
    if (!factReady(facts, required[i])) return false;
  }
  return !!(promptEvidence && promptEvidence.facts);
}

function finalizeParity(differences, counts, promptEvidence) {
  const sorted = sortDifferences(differences);
  const readiness = {
    upcomingForecast: classReadiness(promptEvidence, SUPPORTED_SNAPSHOT_QUESTION_CLASSES[0]),
    balanceLookup: classReadiness(promptEvidence, SUPPORTED_SNAPSHOT_QUESTION_CLASSES[1]),
    nextMonthBalance: classReadiness(promptEvidence, SUPPORTED_SNAPSHOT_QUESTION_CLASSES[2]),
  };
  const blocked = counts.missingLedgerFactCount > 0 || counts.unexplainedMismatchCount > 0;
  return {
    status: blocked ? 'mismatch' : 'ok',
    ran: true,
    productionMode: PRODUCTION_MODE,
    promptable: !!(promptEvidence && promptEvidence.facts),
    comparedFactCount: counts.comparedFactCount,
    exactCount: counts.exactCount,
    intentionalImprovementCount: counts.intentionalImprovementCount,
    legacyBugCount: counts.legacyBugCount,
    missingLedgerFactCount: counts.missingLedgerFactCount,
    phase3CResidualCount: counts.phase3CResidualCount,
    phase3DConcernCount: counts.phase3DConcernCount,
    unexplainedMismatchCount: counts.unexplainedMismatchCount,
    differences: sorted,
    differenceCodes: sorted.map((row) => row.code),
    readiness,
  };
}

function sanitizeShadowReport(report) {
  if (!report || typeof report !== 'object') return skipResult('invalid_report');
  const differences = Array.isArray(report.differences)
    ? report.differences.map((row) => ({
      code: row && row.code,
      classification: row && row.classification,
      legacyPath: row && row.legacyPath,
      ledgerPath: row && row.ledgerPath,
      reason: row && row.reason,
    }))
    : [];
  return {
    status: report.status,
    ran: !!report.ran,
    productionMode: PRODUCTION_MODE,
    promptable: !!report.promptable,
    comparedFactCount: report.comparedFactCount || 0,
    exactCount: report.exactCount || 0,
    intentionalImprovementCount: report.intentionalImprovementCount || 0,
    legacyBugCount: report.legacyBugCount || 0,
    missingLedgerFactCount: report.missingLedgerFactCount || 0,
    phase3CResidualCount: report.phase3CResidualCount || 0,
    phase3DConcernCount: report.phase3DConcernCount || 0,
    unexplainedMismatchCount: report.unexplainedMismatchCount || 0,
    differences,
    differenceCodes: Array.isArray(report.differenceCodes) ? report.differenceCodes.slice() : [],
    readiness: {
      upcomingForecast: !!(report.readiness && report.readiness.upcomingForecast),
      balanceLookup: !!(report.readiness && report.readiness.balanceLookup),
      nextMonthBalance: !!(report.readiness && report.readiness.nextMonthBalance),
    },
    reason: report.reason || report.skippedReason || null,
  };
}

function logShadowFailure(result) {
  try {
    console.warn('Chat endpoint: snapshot evidence shadow (ignored):', {
      status: (result && result.status) || 'mismatch',
      missingLedgerFactCount: (result && result.missingLedgerFactCount) || 0,
      unexplainedMismatchCount: (result && result.unexplainedMismatchCount) || 0,
      differenceCodes: Array.isArray(result && result.differenceCodes)
        ? result.differenceCodes.slice(0, 12)
        : [],
    });
  } catch (err) {
    /* shadow logging must not throw */
  }
}

function buildSnapshotShadowArtifacts(input = {}) {
  const projected = projectSnapshotLedgerView({
    evidence: input.evidence,
    selectedAccount: input.selectedAccount,
    capability: input.capability,
    route: input.route || null,
    accountContext: input.accountContext || null,
    responseMode: input.responseMode || null,
  });
  return {
    adapted: projected.adapted || null,
    ledger: projected.ledger || null,
    ledgerOk: !!projected.ok,
    view: projected.view || { ok: false, promptable: false, promptEvidence: null },
    promptEvidence: projected.view && projected.view.promptEvidence ? projected.view.promptEvidence : null,
  };
}

function shadowSnapshotEvidenceUnsafe(input = {}) {
  const capability = input.capability;
  const evidence = input.evidence;
  if (!isSnapshotShadowEligible({ capability, evidence })) {
    return skipResult('not_snapshot_backed');
  }

  const evidenceBefore = fingerprint(evidence);
  const compactBefore = fingerprint(input.selectedAccount);
  const artifacts = buildSnapshotShadowArtifacts(input);
  const adaptedBefore = fingerprint(artifacts.adapted);
  const ledgerBefore = fingerprint(artifacts.ledger);
  const viewBefore = fingerprint(artifacts.promptEvidence);

  const parity = compareSnapshotParity({
    evidence,
    selectedAccount: input.selectedAccount,
    promptEvidence: artifacts.promptEvidence,
    ledger: artifacts.ledger,
  });

  if (fingerprint(evidence) !== evidenceBefore || fingerprint(input.selectedAccount) !== compactBefore) {
    parity.status = 'mismatch';
    parity.missingLedgerFactCount += 1;
    parity.differences.push({
      code: 'input_mutated',
      classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
      legacyPath: 'phase1Evidence|selectedAccount',
      ledgerPath: 'shadow',
      reason: 'shadow_mutated_inputs',
    });
  }
  if (fingerprint(artifacts.adapted) !== adaptedBefore
    || fingerprint(artifacts.ledger) !== ledgerBefore
    || fingerprint(artifacts.promptEvidence) !== viewBefore) {
    parity.status = 'mismatch';
    parity.missingLedgerFactCount += 1;
    parity.differences.push({
      code: 'artifact_mutated',
      classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
      legacyPath: 'adapter|ledger|promptView',
      ledgerPath: 'shadow',
      reason: 'shadow_mutated_artifacts',
    });
  }

  if (artifacts.promptEvidence) {
    const banned = collectBannedKeys(artifacts.promptEvidence);
    if (banned.length) {
      parity.status = 'mismatch';
      parity.missingLedgerFactCount += 1;
      parity.differences.push({
        code: 'banned_keys',
        classification: CLASSIFICATION.MISSING_LEDGER_FACT_BLOCKER,
        legacyPath: 'n/a',
        ledgerPath: 'promptEvidence',
        reason: 'banned_keys_present',
      });
    }
  }

  const report = sanitizeShadowReport(parity);
  if (report.status !== 'ok') logShadowFailure(report);
  if (input.captureArtifacts === true) {
    return Object.assign({}, report, {
      adapted: artifacts.adapted,
      ledger: artifacts.ledger,
      promptEvidence: artifacts.promptEvidence,
    });
  }
  return report;
}

function shadowSnapshotEvidence(input) {
  try {
    return shadowSnapshotEvidenceUnsafe(input);
  } catch (err) {
    const result = Object.assign({
      status: 'exception',
      ran: true,
      productionMode: PRODUCTION_MODE,
      promptable: false,
      reason: 'shadow_exception',
      differences: [],
      differenceCodes: [],
      readiness: { upcomingForecast: false, balanceLookup: false, nextMonthBalance: false },
    }, emptyCounts());
    logShadowFailure(result);
    return result;
  }
}

module.exports = {
  PRODUCTION_MODE,
  CLASSIFICATION,
  CURRENT_CONTEXT_INVENTORY,
  SUPPORTED_SNAPSHOT_QUESTION_CLASSES,
  EXPECTED_SOURCE_DESCRIPTION,
  isSnapshotShadowEligible,
  wouldFmtMoneyRound,
  compareSnapshotParity,
  sanitizeShadowReport,
  buildSnapshotShadowArtifacts,
  shadowSnapshotEvidence,
};
