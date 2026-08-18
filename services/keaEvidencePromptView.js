'use strict';

/**
 * Evidence Prompt View (Phase 3B.2)
 *
 * Narratable projection of EvidenceLedgerV1. Approved Phase 2 macros serialize
 * this view in production (3B.3A). Snapshot / lookup still do not.
 * Builders copy/filter/label only — no financial math.
 *
 * Phase 3C must validate against the Ledger, not this lossy view.
 */

const {
  LEDGER_STATUS,
  cloneJson,
  deepFreeze,
  copyPeriod,
  validateEvidenceLedgerV1,
} = require('./keaEvidenceLedger');

const PROMPTABLE_STATUSES = Object.freeze({
  complete: true,
  complete_empty: true,
  partial: true,
});

const DROP_FACT_KEYS = Object.freeze([
  'accountScope',
  'sourceKinds',
  'recurringDefinition',
  'incomeHorizonDefinition',
  'expenseCount',
  'incomeCount',
  'periodCount',
  'namedFilter',
]);

const STRIP_ROW_KEYS = Object.freeze([
  'itemId',
  'transactionid',
  'transactionId',
  'groupid',
  'groupId',
  'signed',
  'accountid',
  'accountId',
  'userid',
  'userId',
]);

const INTERNAL_KEY_BAN = /^(transactionid|transactionId|groupid|groupId|accountid|accountId|userid|userId|jwt|token|password|redis|prefetchMeta|builder)$/i;

const LIMITATION_TEXT_BY_CODE = Object.freeze({
  list_capped: 'The item list shown is capped; totals may represent more items than are listed.',
  recurring_list_capped: 'The recurring list shown is capped; totals may represent more streams than are listed.',
  same_day_order_unknown: 'Keacast does not know the intraday ordering of items scheduled on the same date.',
  upcoming_window_15d: 'The compact upcoming snapshot covers a 15-day window.',
  negatives_preview_5_of_90d: 'Negative-balance preview shows at most 5 dates from a 90-day window.',
  recents_capped_10: 'Recent posted transactions in the compact snapshot are capped at 10.',
  posted_actuals_only: 'Totals use posted actual transactions only.',
  duplicates_excluded: 'Duplicate transactions are excluded.',
  includes_all_forecast_types_in_window: 'The lookup window includes forecast types present in that period.',
  compound_lookup_capped: 'Not all requested lookups were included.',
  frequency_unnormalized: 'Some recurring frequencies could not be normalized to a monthly equivalent.',
  rollover_budget_excluded: 'Rollover budget items are excluded.',
  rf_rollover_not_fully_separated: 'RF rollover items are not fully separated from scheduled recurring series.',
  variable_scheduled_income: 'Scheduled income amount may vary.',
  incomplete_period_pages: 'Period transaction pages are incomplete; do not treat totals as complete.',
  affordability_not_calculated: 'Affordability was not calculated; this is a compact snapshot only.',
});

const OMITTED_LIMITATION_CODES = Object.freeze([
  'selected_account_scope',
  'no_upcoming_in_period',
  'no_scheduled_recurring',
]);

const OBSERVATION_CODES = Object.freeze([
  'no_upcoming_in_period',
  'upcoming_expense_count',
  'upcoming_income_count',
  'upcoming_item_count',
  'no_scheduled_recurring',
  'largest_recurring_expense',
  'largest_recurring_income',
  'monthly_recurring_expense_total',
  'monthly_recurring_income_total',
  'next_recurring_expense',
  'next_recurring_income',
  'frequency_unnormalized',
  'next_scheduled_recurring_income',
  'income_is_today',
  'multiple_income_same_day',
  'no_expenses_before_income',
  'same_day_order_unknown',
  'forecast_goes_negative_before_income',
  'no_negative_before_income',
  'both_periods_empty',
  'spending_increased',
  'spending_decreased',
  'income_increased',
  'income_decreased',
  'net_improved',
  'net_worsened',
  'baseline_zero_spending',
  'baseline_zero_income',
  'period_a_empty',
  'period_b_empty',
  'largest_category_increase',
  'largest_category_decrease',
  'all_periods_empty',
  'category_increasing',
  'category_decreasing',
  'category_mixed',
  'category_unchanged',
  'spending_increasing',
  'spending_decreasing',
  'spending_mixed',
  'spending_unchanged',
  'income_increasing',
  'income_decreasing',
  'income_mixed',
  'income_unchanged',
  'posted_net_positive',
  'posted_net_negative',
  'posted_net_zero',
  'date_beyond_horizon',
  'forecast_goes_negative',
  'no_negative_in_scope',
  'baseline_already_negative',
  'new_negative_introduced',
  'negative_starts_earlier',
  'negative_worsened',
  'no_new_negative',
]);

function stripRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = {};
  const keys = Object.keys(row);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (STRIP_ROW_KEYS.indexOf(key) !== -1) continue;
    out[key] = cloneJson(row[key]);
  }
  return out;
}

function stripRows(list) {
  if (!Array.isArray(list)) return list;
  return list.map(stripRow);
}

function dropKeys(obj, keys) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (let i = 0; i < keys.length; i += 1) delete out[keys[i]];
  return out;
}

function copyTotalsKeys(totals, keys) {
  const src = totals && typeof totals === 'object' ? totals : {};
  const out = {};
  for (let i = 0; i < keys.length; i += 1) {
    if (src[keys[i]] !== undefined) out[keys[i]] = cloneJson(src[keys[i]]);
  }
  return out;
}

function narrationTexts(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => (row && typeof row.text === 'string' ? row.text : null)).filter(Boolean);
}

function mapLimitations(codes) {
  const texts = [];
  const unmapped = [];
  const omitted = [];
  const list = Array.isArray(codes) ? codes : [];
  for (let i = 0; i < list.length; i += 1) {
    const code = list[i];
    if (OMITTED_LIMITATION_CODES.indexOf(code) !== -1) {
      omitted.push(code);
      continue;
    }
    if (LIMITATION_TEXT_BY_CODE[code]) {
      texts.push(LIMITATION_TEXT_BY_CODE[code]);
      continue;
    }
    unmapped.push(code);
  }
  return { texts, unmapped, omitted };
}

function assumptionTexts(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => (row && row.text ? row.text : null)).filter(Boolean);
}

function projectUpcomingFacts(facts, responseMode, lists) {
  const out = dropKeys(cloneJson(facts), DROP_FACT_KEYS);
  out.items = stripRows(out.items);
  const totalMode = responseMode === 'total';
  if (totalMode) delete out.items;
  const truncated = lists && lists.items && lists.items.truncated === true;
  return {
    facts: out,
    items: totalMode ? undefined : out.items,
    truncated,
  };
}

function selectedLargestRow(selected, gapCode, gaps) {
  if (selected) return [selected];
  gaps.push(gapCode);
  return [];
}

function projectRecurringFacts(facts, responseMode, gaps) {
  const src = cloneJson(facts) || {};
  const metricScope = src.metricScope || 'all';
  const rankingMode = src.rankingMode === 'largest' || responseMode === 'largest' ? 'largest' : null;
  const out = dropKeys(src, DROP_FACT_KEYS);
  out.expenses = stripRows(out.expenses);
  out.income = stripRows(out.income);
  if (out.largestExpense) out.largestExpense = stripRow(out.largestExpense);
  if (out.largestIncome) out.largestIncome = stripRow(out.largestIncome);

  if (metricScope === 'expense') {
    delete out.income;
    delete out.largestIncome;
    if (rankingMode === 'largest') {
      out.expenses = selectedLargestRow(out.largestExpense, 'largest_expense_missing', gaps);
      delete out.totals;
    } else {
      out.totals = copyTotalsKeys(out.totals, [
        'recurringExpenseMonthlyEquivalent',
        'nextOccurrenceExpenseSum',
      ]);
    }
  } else if (metricScope === 'income') {
    delete out.expenses;
    delete out.largestExpense;
    if (rankingMode === 'largest') {
      out.income = selectedLargestRow(out.largestIncome, 'largest_income_missing', gaps);
      delete out.totals;
    } else {
      out.totals = copyTotalsKeys(out.totals, ['recurringIncomeMonthlyEquivalent']);
    }
  } else if (rankingMode === 'largest') {
    out.expenses = selectedLargestRow(out.largestExpense, 'largest_expense_missing', gaps);
    out.income = selectedLargestRow(out.largestIncome, 'largest_income_missing', gaps);
    delete out.totals;
  }

  if (rankingMode === 'largest') {
    delete out.largestExpense;
    delete out.largestIncome;
  }

  return out;
}

function projectHorizonFacts(facts) {
  const out = dropKeys(cloneJson(facts), DROP_FACT_KEYS);
  out.nextIncome = stripRows(out.nextIncome);
  if (out.expensesBeforeIncome && Array.isArray(out.expensesBeforeIncome.items)) {
    out.expensesBeforeIncome = {
      ...out.expensesBeforeIncome,
      items: stripRows(out.expensesBeforeIncome.items),
    };
  }
  return out;
}

function projectGenericFacts(facts) {
  const out = dropKeys(cloneJson(facts), DROP_FACT_KEYS);
  if (Array.isArray(out.items)) out.items = stripRows(out.items);
  if (Array.isArray(out.expenses)) out.expenses = stripRows(out.expenses);
  if (Array.isArray(out.income)) out.income = stripRows(out.income);
  if (Array.isArray(out.periods)) out.periods = stripRows(out.periods);
  if (Array.isArray(out.lookups)) out.lookups = stripRows(out.lookups);
  if (Array.isArray(out.largestCategories)) out.largestCategories = stripRows(out.largestCategories);
  if (Array.isArray(out.largestMerchants)) out.largestMerchants = stripRows(out.largestMerchants);
  if (Array.isArray(out.recents)) out.recents = stripRows(out.recents);
  if (Array.isArray(out.upcoming)) out.upcoming = stripRows(out.upcoming);
  if (Array.isArray(out.futureNegativeBalances)) {
    out.futureNegativeBalances = stripRows(out.futureNegativeBalances);
  }
  return out;
}

function projectFacts(ledger, responseMode, gaps) {
  const cap = ledger.capability;
  const facts = ledger.facts || {};
  if (cap === 'cashflow_upcoming') {
    return projectUpcomingFacts(facts, responseMode, ledger.lists);
  }
  if (cap === 'cashflow_recurring') {
    return { facts: projectRecurringFacts(facts, responseMode, gaps) };
  }
  if (cap === 'cashflow_income_horizon') {
    return { facts: projectHorizonFacts(facts) };
  }
  return { facts: projectGenericFacts(facts) };
}

function toPromptEvidence(ledger, requestContext) {
  if (ledger == null) {
    return { ok: true, promptable: false, promptEvidence: null, reason: 'no_ledger' };
  }
  if (typeof ledger !== 'object' || Array.isArray(ledger)) {
    return { ok: false, reason: 'invalid_input', promptEvidence: null };
  }
  const validated = validateEvidenceLedgerV1(ledger);
  if (!validated.ok) {
    return { ok: false, reason: 'invalid_ledger', errors: validated.errors, promptEvidence: null };
  }
  if (!PROMPTABLE_STATUSES[ledger.status]) {
    return {
      ok: true,
      promptable: false,
      promptEvidence: null,
      reason: ledger.status === LEDGER_STATUS.UNSUPPORTED ? 'unsupported' : 'unavailable',
    };
  }

  const responseMode = (requestContext && requestContext.responseMode) || ledger.responseMode || null;
  const gaps = [];
  const projected = projectFacts(ledger, responseMode, gaps);
  const limitationMap = mapLimitations(ledger.limitations);
  const limitationTexts = limitationMap.texts.slice();
  if (ledger.status === LEDGER_STATUS.PARTIAL) {
    limitationTexts.unshift('This evidence is incomplete; do not present it as complete.');
  }

  const view = {
    status: ledger.status,
    source: {
      description: (ledger.source && ledger.source.description) || null,
    },
    account: (ledger.scope && ledger.scope.accountLabel) || null,
    accountScope: (ledger.scope && ledger.scope.accountScope) || 'selected_account',
    period: copyPeriod(ledger.scope && ledger.scope.period),
    metricScope: (ledger.scope && ledger.scope.metricScope) || (projected.facts && projected.facts.metricScope) || null,
    facts: projected.facts,
    limitations: limitationTexts,
    assumptions: assumptionTexts(ledger.assumptions),
    allowedNarration: narrationTexts(ledger.allowedNarration),
    prohibitedNarration: narrationTexts(ledger.prohibitedNarration),
  };
  if (projected.items !== undefined) view.items = projected.items;
  if (ledger.scope && ledger.scope.windowKind) view.windowKind = ledger.scope.windowKind;
  if (ledger.scope && ledger.scope.scenario) view.scenario = ledger.scope.scenario;
  if (responseMode) view.responseMode = responseMode;

  const check = validatePromptEvidenceView(view);
  if (!check.ok) {
    return { ok: false, reason: 'validation_failed', errors: check.errors, promptEvidence: null };
  }

  return {
    ok: true,
    promptable: true,
    promptEvidence: deepFreeze(view),
    unmappedLimitations: limitationMap.unmapped,
    omittedLimitations: limitationMap.omitted,
    ledgerGaps: gaps,
  };
}

function validatePromptEvidenceView(view) {
  const errors = [];
  if (view == null) return { ok: true, errors: [] };
  if (typeof view !== 'object' || Array.isArray(view)) {
    return { ok: false, errors: ['view_not_object'] };
  }
  if (!view.source || typeof view.source.description !== 'string') errors.push('source_description_missing');
  if (view.facts == null || typeof view.facts !== 'object' || Array.isArray(view.facts)) {
    errors.push('facts_invalid');
  }
  if (!Array.isArray(view.limitations)) errors.push('limitations_invalid');
  if (!Array.isArray(view.allowedNarration)) errors.push('allowedNarration_invalid');
  if (!Array.isArray(view.prohibitedNarration)) errors.push('prohibitedNarration_invalid');
  if (view.internal) errors.push('internal_present');
  if (view.claims) errors.push('claims_present');
  const banned = collectBannedKeys(view);
  if (banned.length) errors.push('banned_keys');
  const codes = collectObservationCodeHits(view);
  if (codes.length) errors.push('observation_codes_present');
  return { ok: errors.length === 0, errors, bannedKeys: banned, observationHits: codes };
}

function walk(value, visit, path) {
  if (value == null) return;
  if (typeof value === 'string') {
    visit('string', path, value);
    return;
  }
  if (typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) walk(value[i], visit, `${path}[${i}]`);
    return;
  }
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    visit('key', `${path}.${keys[i]}`, keys[i]);
    walk(value[keys[i]], visit, `${path}.${keys[i]}`);
  }
}

function collectBannedKeys(view) {
  const hits = [];
  walk(view, (kind, path, value) => {
    if (kind === 'key' && INTERNAL_KEY_BAN.test(value)) hits.push(path);
  }, 'view');
  return hits;
}

function collectObservationCodeHits(view) {
  const serialized = JSON.stringify(view);
  const hits = [];
  for (let i = 0; i < OBSERVATION_CODES.length; i += 1) {
    const code = OBSERVATION_CODES[i];
    if (serialized.indexOf(`"${code}"`) !== -1 || serialized.indexOf(`'${code}'`) !== -1) {
      hits.push(code);
      continue;
    }
    const wrapped = new RegExp(`(^|[^A-Za-z0-9_])${code}([^A-Za-z0-9_]|$)`);
    if (wrapped.test(serialized)) hits.push(code);
  }
  return hits;
}

function leafValues(obj, prefix, out) {
  if (obj === null || typeof obj !== 'object') {
    out.push({ path: prefix, value: obj });
    return;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i += 1) leafValues(obj[i], `${prefix}[${i}]`, out);
    return;
  }
  const keys = Object.keys(obj);
  if (!keys.length) {
    out.push({ path: prefix, value: obj });
    return;
  }
  for (let i = 0; i < keys.length; i += 1) {
    leafValues(obj[keys[i]], prefix ? `${prefix}.${keys[i]}` : keys[i], out);
  }
}

function isIntentionalCurrentPath(path, { capability, responseMode, current }) {
  if (/transactionid|transactionId|groupid|groupId|signed|accountid|accountId|userid|userId/i.test(path)) {
    return 'internal_ids_removed';
  }
  if (/observations/.test(path)) return 'observation_codes_removed';
  if (/^source(\[|$)/.test(path) || path === 'source') return 'source_replaced_by_description';
  if (/^limitations/.test(path)) return 'limitation_codes_mapped';
  if (/assumptions\[[0-9]+\]\.code$/.test(path)) return 'assumption_code_omitted';
  if (/facts\.(incomeHorizonDefinition|recurringDefinition|sourceKinds|accountScope)/.test(path)) {
    return 'definition_token_replaced_by_source_description';
  }
  if (/horizonDays/.test(path)) return 'horizonDays_stripped';
  if (capability === 'cashflow_upcoming' && responseMode === 'total' && /facts\.items/.test(path)) {
    return 'total_mode_omits_items';
  }
  if (capability === 'cashflow_recurring') {
    const metric = current && current.facts && current.facts.metricScope;
    const ranking = (current && current.facts && current.facts.rankingMode) || responseMode;
    if (metric === 'expense' && /facts\.income/.test(path)) return 'recurring_metric_scope';
    if (metric === 'income' && /facts\.expenses/.test(path)) return 'recurring_metric_scope';
    if (ranking === 'largest' && /facts\.totals/.test(path)) return 'largest_mode_omits_unrelated_totals';
  }
  if (path === 'status') return 'status_renamed_complete';
  if (path === 'dataAsOf') return 'dataAsOf_omitted';
  if (path === 'accountScope') return 'accountScope_moved';
  if (path === 'windowKind') return 'windowKind_moved';
  return null;
}

function getPath(obj, path) {
  const tokens = [];
  String(path).replace(/([^.\[\]]+)|\[(\d+)\]/g, (_, key, idx) => {
    tokens.push(idx != null ? Number(idx) : key);
  });
  let cur = obj;
  for (let i = 0; i < tokens.length; i += 1) {
    if (cur == null) return undefined;
    cur = cur[tokens[i]];
  }
  return cur;
}

/**
 * Shadow fact parity: every current narratable leaf needed for supported
 * behavior must exist in Prompt View with the same value, except intentional
 * differences.
 */
function assertPromptEvidenceFactParity({ current, promptView, capability, responseMode }) {
  const missing = [];
  const intentional = [];
  const compared = [];
  if (!current || !promptView) {
    return { ok: false, missing: [{ path: '(root)', expected: 'present', actual: null }], intentional, compared: 0 };
  }
  const leaves = [];
  leafValues(current.facts || {}, 'facts', leaves);
  if (current.period) leafValues(current.period, 'period', leaves);
  if (current.lookups) leafValues(current.lookups, 'lookups', leaves);
  if (current.windowKind != null) leaves.push({ path: 'windowKind', value: current.windowKind });

  for (let i = 0; i < leaves.length; i += 1) {
    const { path, value } = leaves[i];
    const reason = isIntentionalCurrentPath(path, { capability, responseMode, current });
    if (reason) {
      intentional.push({ path, reason });
      continue;
    }
    let actual;
    if (path.indexOf('facts.') === 0) actual = getPath(promptView, path);
    else if (path.indexOf('period.') === 0) actual = getPath(promptView, path);
    else if (path === 'windowKind') actual = promptView.windowKind != null ? promptView.windowKind : getPath(promptView, 'facts.windowKind');
    else if (path.indexOf('lookups') === 0) actual = getPath(promptView, `facts.${path}`);
    else actual = getPath(promptView, path);

    compared.push(path);
    const same = actual === value || JSON.stringify(actual) === JSON.stringify(value);
    if (!same) {
      missing.push({ path, expected: value, actual });
    }
  }
  return {
    ok: missing.length === 0,
    missing,
    intentional,
    compared: compared.length,
  };
}

function previewPromptEvidenceSection(promptEvidence) {
  if (!promptEvidence) return '';
  return [
    'GROUNDED EVIDENCE',
    JSON.stringify(promptEvidence),
    'Use only supplied facts.',
    'Do not calculate new financial values.',
    'Follow the evidence source/date/scope exactly.',
    'Follow allowed/prohibited narration constraints.',
  ].join('\n');
}

function serializedSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (err) {
    return null;
  }
}

module.exports = {
  toPromptEvidence,
  validatePromptEvidenceView,
  assertPromptEvidenceFactParity,
  previewPromptEvidenceSection,
  collectBannedKeys,
  collectObservationCodeHits,
  OBSERVATION_CODES,
  LIMITATION_TEXT_BY_CODE,
  OMITTED_LIMITATION_CODES,
  PROMPTABLE_STATUSES,
  serializedSize,
};
