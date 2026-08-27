'use strict';

/**
 * Phase 3C.1 — request-local ResponseValidationContract.
 *
 * Thin projection of EvidenceLedgerV1 for later response validation.
 * Copy / normalize / classify metadata only. Does not calculate finances.
 * Not wired into production chat.
 */

const {
  LEDGER_STATUS,
  SIGN_CONVENTION,
  cloneJson,
  deepFreeze,
  copyPeriod,
  validateEvidenceLedgerV1,
} = require('./keaEvidenceLedger');

const RESPONSE_VALIDATION_CONTRACT_VERSION = 1;

const LIST_COVERAGE = Object.freeze({
  COMPLETE: 'complete',
  PREVIEW: 'preview',
  UNKNOWN: 'unknown',
});

const VALIDATION_STATUS = Object.freeze({
  VALID: 'valid',
  INVALID: 'invalid',
  INDETERMINATE: 'indeterminate',
});

const SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
});

const VIOLATION_CODE = Object.freeze({
  UNSUPPORTED_AMOUNT: 'UNSUPPORTED_AMOUNT',
  UNSUPPORTED_COUNT: 'UNSUPPORTED_COUNT',
  UNSUPPORTED_DATE: 'UNSUPPORTED_DATE',
  UNSUPPORTED_PERIOD_ATTRIBUTION: 'UNSUPPORTED_PERIOD_ATTRIBUTION',
  UNSUPPORTED_ENTITY: 'UNSUPPORTED_ENTITY',
  UNSUPPORTED_SOURCE_ATTRIBUTION: 'UNSUPPORTED_SOURCE_ATTRIBUTION',
  UNSUPPORTED_RANKING: 'UNSUPPORTED_RANKING',
  UNSUPPORTED_COMPARISON: 'UNSUPPORTED_COMPARISON',
  UNSUPPORTED_DERIVATION: 'UNSUPPORTED_DERIVATION',
  UNSUPPORTED_FORECAST: 'UNSUPPORTED_FORECAST',
  UNSUPPORTED_ABSENCE_CLAIM: 'UNSUPPORTED_ABSENCE_CLAIM',
  SCOPE_BROADENING: 'SCOPE_BROADENING',
  LIST_ITEM_MISMATCH: 'LIST_ITEM_MISMATCH',
  PREVIEW_TOTAL_MISATTRIBUTION: 'PREVIEW_TOTAL_MISATTRIBUTION',
  PARTIAL_AS_COMPLETE: 'PARTIAL_AS_COMPLETE',
  PROHIBITED_NARRATION: 'PROHIBITED_NARRATION',
  UNSUPPORTED_CAPABILITY_OFFER: 'UNSUPPORTED_CAPABILITY_OFFER',
  UNSUPPORTED_DEFINITION: 'UNSUPPORTED_DEFINITION',
  UNAUTHORIZED_DIRECTION: 'UNAUTHORIZED_DIRECTION',
  QUALIFIER_WITHOUT_VALUE: 'QUALIFIER_WITHOUT_VALUE',
  INVALID_CONTRACT: 'INVALID_CONTRACT',
  SNAPSHOT_SEMANTIC_MISMATCH: 'SNAPSHOT_SEMANTIC_MISMATCH',
  COMPARISON_RELATION_MISMATCH: 'COMPARISON_RELATION_MISMATCH',
});

const MATCH_RESULT = Object.freeze({
  MATCHED: 'matched',
  UNMATCHED: 'unmatched',
  AMBIGUOUS: 'ambiguous',
  WRONG_SEMANTIC_BINDING: 'wrong_semantic_binding',
});

const LIST_FACT_PATHS = Object.freeze({
  upcoming: ['upcoming'],
  recents: ['recents'],
  items: ['items'],
  lookups: ['lookups'],
  expenses: ['expenses'],
  income: ['income'],
  nextIncome: ['nextIncome'],
  expensesBeforeIncome: ['expensesBeforeIncome', 'items'],
  periods: ['periods'],
  largestCategories: ['largestCategories'],
  largestMerchants: ['largestMerchants'],
  futureNegativeBalances: ['futureNegativeBalances'],
});

function safeClone(value) {
  try {
    return cloneJson(value);
  } catch (e) {
    return undefined;
  }
}

function narrationCodes(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (typeof row === 'string' && row) out.push(row);
    else if (row && typeof row.code === 'string' && row.code) out.push(row.code);
  }
  return out;
}

function semanticRoleForPath(path) {
  const p = String(path || '');
  if (p === 'facts.availableBalance') return 'current_available_balance';
  if (p === 'facts.currentBalance') return 'current_balance';
  if (p === 'facts.reconciledBalance') return 'current_reconciled_balance';
  if (p === 'facts.upcomingExpenseTotal') return 'upcoming_window_expense_total';
  if (p === 'facts.upcomingIncomeTotal') return 'upcoming_window_income_total';
  if (p === 'facts.monthIncome') return 'current_month_income';
  if (p === 'facts.monthExpenses') return 'current_month_expenses';
  if (p === 'facts.monthNet') return 'current_month_net';
  if (p === 'facts.spentTotal') return 'lookup_spent_total';
  if (p === 'facts.expenseTotal') return 'lookup_expense_total';
  if (p === 'facts.incomeTotal') return 'lookup_income_total';
  if (p === 'facts.transactionCount') return 'lookup_transaction_count';
  if (p === 'facts.totals.scheduledExpenseTotal') return 'scheduled_expense_total';
  if (p === 'facts.totals.scheduledIncomeTotal') return 'scheduled_income_total';
  if (p === 'facts.totals.scheduledNet') return 'scheduled_net';
  if (p === 'facts.itemCount') return 'upcoming_item_count';
  if (/\.direction$/.test(p)) return 'direction';
  if (/\.absolute$/.test(p)) return 'comparison_absolute';
  if (/\.percent$/.test(p)) return 'comparison_percent';
  if (p.indexOf('largest') !== -1 || p.indexOf('highest') !== -1 || p.indexOf('lowest') !== -1) {
    return 'ranking';
  }
  if (p.indexOf('Expense') !== -1 || p.indexOf('spending') !== -1 || p.indexOf('Spending') !== -1) {
    return 'expense';
  }
  if (p.indexOf('Income') !== -1 || p.indexOf('income') !== -1) return 'income';
  return null;
}

function comparisonPeriodFromPath(path, ledger) {
  const p = String(path || '');
  const facts = (ledger && ledger.facts) || {};
  if ((p === 'facts.periodA' || p.indexOf('facts.periodA.') === 0) && facts.periodA) {
    return copyPeriod(facts.periodA);
  }
  if ((p === 'facts.periodB' || p.indexOf('facts.periodB.') === 0) && facts.periodB) {
    return copyPeriod(facts.periodB);
  }
  return null;
}

function projectClaim(claim, ledger) {
  const copied = safeClone(claim);
  if (!copied || typeof copied !== 'object') return null;
  const sourceKind = ledger.source && ledger.source.kind ? ledger.source.kind : null;
  const scope = ledger.scope || {};
  const pathPeriod = comparisonPeriodFromPath(copied.path, ledger);
  return {
    claimId: copied.id,
    type: copied.type,
    path: copied.path,
    value: copied.value,
    unit: copied.unit,
    visibility: copied.visibility || null,
    semanticRole: semanticRoleForPath(copied.path),
    period: pathPeriod || copyPeriod(scope.period),
    sourceKind,
    accountScope: scope.accountScope || null,
  };
}

function factList(facts, listName) {
  const path = LIST_FACT_PATHS[listName];
  if (!path) return [];
  let cur = facts;
  for (let i = 0; i < path.length; i += 1) {
    if (cur == null || typeof cur !== 'object') return [];
    cur = cur[path[i]];
  }
  return Array.isArray(cur) ? cur : [];
}

function projectListItem(row) {
  if (!row || typeof row !== 'object') return null;
  const copied = safeClone(row);
  if (!copied) return null;
  const item = { itemId: copied.itemId || null };
  const label = copied.label || copied.name || copied.merchant_name || copied.merchant || copied.category || null;
  if (label != null) item.label = label;
  if (copied.amount !== undefined) item.amount = copied.amount;
  else if (copied.spentTotal !== undefined) item.amount = copied.spentTotal;
  else if (copied.value !== undefined) item.amount = copied.value;
  else if (copied.spending !== undefined) item.amount = copied.spending;
  if (copied.monthlyEquivalent !== undefined) item.monthlyEquivalent = copied.monthlyEquivalent;
  const date = copied.date || copied.start || copied.nextDate || null;
  if (date != null) item.date = date;
  if (copied.category != null) item.category = copied.category;
  if (copied.merchant != null || copied.merchant_name != null) {
    item.merchant = copied.merchant || copied.merchant_name;
  }
  if (copied.subjectValue != null) item.subjectValue = copied.subjectValue;
  if (copied.subjectKind != null) item.subjectKind = copied.subjectKind;
  if (copied.transactionCount !== undefined) item.transactionCount = copied.transactionCount;
  if (copied.spentTotal !== undefined) item.spentTotal = copied.spentTotal;
  return item;
}

function listCoverageFor(listName, meta, sourceKind, limitations) {
  const codes = Array.isArray(limitations) ? limitations : [];
  if (sourceKind === 'kea_snapshot' && listName === 'upcoming') return LIST_COVERAGE.PREVIEW;
  if (sourceKind === 'kea_snapshot' && listName === 'recents') return LIST_COVERAGE.PREVIEW;
  if (sourceKind === 'kea_snapshot' && listName === 'futureNegativeBalances') {
    return LIST_COVERAGE.PREVIEW;
  }
  if (meta && meta.truncated === true) return LIST_COVERAGE.PREVIEW;
  if (codes.indexOf('list_capped') !== -1 && (listName === 'items' || listName === 'expenses' || listName === 'income')) {
    return LIST_COVERAGE.PREVIEW;
  }
  if (codes.indexOf('recurring_list_capped') !== -1 && (listName === 'expenses' || listName === 'income')) {
    return LIST_COVERAGE.PREVIEW;
  }
  if (meta && meta.truncated === false) return LIST_COVERAGE.COMPLETE;
  return LIST_COVERAGE.UNKNOWN;
}

function buildResponseValidationContract(ledger) {
  if (ledger == null) {
    return { ok: false, reason: 'missing_ledger', promptable: false, contract: null };
  }
  if (typeof ledger !== 'object' || Array.isArray(ledger)) {
    return { ok: false, reason: 'invalid_ledger', promptable: false, contract: null };
  }
  const cloned = safeClone(ledger);
  if (cloned === undefined) {
    return { ok: false, reason: 'unclonable_ledger', promptable: false, contract: null };
  }
  const validated = validateEvidenceLedgerV1(cloned);
  if (!validated.ok) {
    return { ok: false, reason: 'invalid_ledger', promptable: false, errors: validated.errors, contract: null };
  }
  if (cloned.status === LEDGER_STATUS.UNAVAILABLE || cloned.status === LEDGER_STATUS.UNSUPPORTED) {
    return {
      ok: true,
      reason: cloned.status,
      promptable: false,
      contract: deepFreeze({
        version: RESPONSE_VALIDATION_CONTRACT_VERSION,
        capability: cloned.capability || null,
        responseMode: cloned.responseMode || null,
        sourceKind: cloned.source && cloned.source.kind ? cloned.source.kind : null,
        sourceDefinition: cloned.source && cloned.source.definition ? cloned.source.definition : null,
        status: cloned.status,
        signConvention: (cloned.facts && cloned.facts.signConvention) || null,
        scope: {
          accountScope: cloned.scope && cloned.scope.accountScope ? cloned.scope.accountScope : null,
          period: copyPeriod(cloned.scope && cloned.scope.period),
        },
        allowedClaims: [],
        allowedListItems: {},
        listCoverage: {},
        allowedNarrationCodes: narrationCodes(cloned.allowedNarration),
        prohibitedNarrationCodes: narrationCodes(cloned.prohibitedNarration),
        limitations: Array.isArray(cloned.limitations) ? cloned.limitations.slice() : [],
      }),
    };
  }

  const sourceKind = cloned.source && cloned.source.kind ? cloned.source.kind : null;
  const facts = cloned.facts && typeof cloned.facts === 'object' ? cloned.facts : {};
  const claimsIn = Array.isArray(cloned.claims) ? cloned.claims : [];
  const allowedClaims = [];
  for (let i = 0; i < claimsIn.length; i += 1) {
    const projected = projectClaim(claimsIn[i], cloned);
    if (projected) allowedClaims.push(projected);
  }

  const listsMeta = cloned.lists && typeof cloned.lists === 'object' ? cloned.lists : {};
  const listNames = Object.keys(listsMeta);
  const allowedListItems = {};
  const listCoverage = {};
  for (let i = 0; i < listNames.length; i += 1) {
    const name = listNames[i];
    const rows = factList(facts, name);
    const items = [];
    for (let j = 0; j < rows.length; j += 1) {
      const item = projectListItem(rows[j]);
      if (item) items.push(item);
    }
    allowedListItems[name] = items;
    listCoverage[name] = listCoverageFor(name, listsMeta[name], sourceKind, cloned.limitations);
  }

  const scope = cloned.scope || {};
  const contract = {
    version: RESPONSE_VALIDATION_CONTRACT_VERSION,
    capability: cloned.capability || null,
    responseMode: cloned.responseMode || null,
    sourceKind,
    sourceDefinition: cloned.source && cloned.source.definition ? cloned.source.definition : null,
    status: cloned.status,
    signConvention: facts.signConvention || SIGN_CONVENTION.MAGNITUDE,
    scope: {
      accountScope: scope.accountScope || null,
      period: copyPeriod(scope.period),
      metricScope: scope.metricScope || null,
      category: scope.category || null,
      merchant: scope.merchant || null,
      windowKind: scope.windowKind || null,
      scenario: scope.scenario || null,
    },
    allowedClaims,
    allowedListItems,
    listCoverage,
    allowedNarrationCodes: narrationCodes(cloned.allowedNarration),
    prohibitedNarrationCodes: narrationCodes(cloned.prohibitedNarration),
    limitations: Array.isArray(cloned.limitations) ? cloned.limitations.slice() : [],
  };

  return {
    ok: true,
    reason: null,
    promptable: true,
    contract: deepFreeze(contract),
  };
}

module.exports = {
  RESPONSE_VALIDATION_CONTRACT_VERSION,
  LIST_COVERAGE,
  VALIDATION_STATUS,
  SEVERITY,
  VIOLATION_CODE,
  MATCH_RESULT,
  buildResponseValidationContract,
};
