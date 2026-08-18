'use strict';

/**
 * Evidence Ledger V1 (Phase 3B.1)
 *
 * Request-local typed contract for deterministic financial evidence.
 * Builders copy/normalize/classify. They MUST NOT calculate.
 *
 * Approved Phase 2 macros serialize Prompt View in production (3B.3A).
 * Snapshot / lookup / rollback still use azureFacingEvidence.
 */

const EVIDENCE_LEDGER_VERSION = 1;

const LEDGER_STATUS = Object.freeze({
  COMPLETE: 'complete',
  COMPLETE_EMPTY: 'complete_empty',
  PARTIAL: 'partial',
  UNAVAILABLE: 'unavailable',
  UNSUPPORTED: 'unsupported',
});

const CLAIM_TYPES = Object.freeze([
  'AMOUNT',
  'TOTAL',
  'COUNT',
  'DATE',
  'DATE_RANGE',
  'BOOLEAN',
  'DIRECTION',
  'PERCENT',
  'DEFINITION',
  'LABEL',
]);

const CLAIM_UNITS = Object.freeze({
  USD: 'USD',
  PERCENT: 'percent',
  COUNT: 'count',
  DAYS: 'days',
  DATE: 'date',
  NONE: 'none',
});

const SIGN_CONVENTION = Object.freeze({
  MAGNITUDE: 'magnitude',
  SIGNED_LEDGER: 'signed_ledger',
});

const SCENARIO = Object.freeze({
  REAL: 'real',
  AFFORDABILITY_HYPOTHETICAL: 'affordability_hypothetical',
});

const SOURCE_KIND = Object.freeze({
  CASHFLOW_UPCOMING: 'cashflow_upcoming',
  CASHFLOW_RECURRING: 'cashflow_recurring',
  CASHFLOW_INCOME_HORIZON: 'cashflow_income_horizon',
  CASHFLOW_ANALYSIS: 'cashflow_analysis',
  CASHFLOW_PERIOD_COMPARISON: 'cashflow_period_comparison',
  CASHFLOW_TREND: 'cashflow_trend',
  AFFORDABILITY_ANALYSIS: 'affordability_analysis',
  KEA_SNAPSHOT: 'kea_snapshot',
  USER_TRANSACTIONS: 'user_transactions',
});

const SOURCE_DEFINITION = Object.freeze({
  KEA_SCHEDULED_SERIES: 'kea_scheduled_series',
  KEA_SCHEDULED_RECURRING_INCOME: 'kea_scheduled_recurring_income',
});

const NO_LEDGER_CAPABILITIES = Object.freeze([
  'product_help',
  'casual_conversation',
  'navigation_ui',
  'invitation_continuation',
  'bare_affirmative_unresolved',
  'conversation_clarify',
  'confirmation',
  'transaction_write',
  'goal_write',
  'simulation',
]);

const INTERNAL_ROW_KEYS = Object.freeze([
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

const NARRATABLE_KEY_BAN = /^(transactionid|transactionId|groupid|groupId|accountid|accountId|userid|userId|jwt|token|password|redis)/i;

const UNSUPPORTED_LIMITATIONS = Object.freeze([
  'mixed_macro_unsupported',
  'forecast_comparison_unsupported',
  'compound_comparison_unsupported',
  'forecast_trend_unsupported',
  'trend_period_count_unsupported',
  'compound_trend_unsupported',
  'merchant_trend_unsupported',
  'recurring_definition_unsupported',
  'recurring_share_unsupported',
  'recurring_trend_unsupported',
  'recurring_cancel_unsupported',
  'upcoming_horizon_unsupported',
  'income_horizon_unsupported',
  'payday_affordability_unsupported',
  'safe_spend_unsupported',
  'after_income_intraday_unsupported',
]);

const SOURCE_DESCRIPTION_BY_KIND = Object.freeze({
  cashflow_upcoming: Object.freeze({
    income: 'scheduled income in your Keacast forecast',
    expense: 'scheduled expenses in your Keacast forecast',
    all: 'scheduled items in your Keacast forecast',
  }),
  cashflow_recurring: 'scheduled recurring items in your Keacast forecast',
  cashflow_income_horizon: 'next scheduled recurring income in your Keacast forecast',
  cashflow_analysis: 'Keacast cashflow analysis for the selected account and period',
  cashflow_period_comparison: 'posted transactions for the selected periods',
  cashflow_trend: 'posted transactions for the selected periods',
  affordability_analysis: 'synthetic one-time expense compared with the Keacast forecast',
  kea_snapshot: 'compact selected-account snapshot, including a 15-day upcoming window',
  user_transactions: 'posted transactions for the selected period',
});

const ASSUMPTION_TEXT_BY_CODE = Object.freeze({
  one_time_expense: 'Modeled as a one-time expense in the Keacast forecast.',
  next_month_first_day: 'Purchase date assumed as the first day of next month.',
});

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) deepFreeze(value[i]);
    return value;
  }
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) deepFreeze(value[keys[i]]);
  return value;
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function copyPeriod(period) {
  if (!period || typeof period !== 'object') return null;
  const out = {
    start: period.start || null,
    end: period.end || null,
  };
  if (period.label != null) out.label = period.label;
  if (period.relation != null) out.relation = period.relation;
  return out;
}

function firstSourceKind(evidence) {
  if (!evidence || !Array.isArray(evidence.source) || !evidence.source.length) return null;
  return evidence.source[0] || null;
}

function sourceDescriptionFor(kind, metricScope) {
  const mapped = SOURCE_DESCRIPTION_BY_KIND[kind];
  if (!mapped) return null;
  if (typeof mapped === 'string') return mapped;
  if (metricScope && mapped[metricScope]) return mapped[metricScope];
  return mapped.all || mapped.expense || mapped.income || null;
}

function sourceDefinitionFor(kind, facts) {
  if (kind === SOURCE_KIND.CASHFLOW_RECURRING) {
    return (facts && facts.recurringDefinition) || SOURCE_DEFINITION.KEA_SCHEDULED_SERIES;
  }
  if (kind === SOURCE_KIND.CASHFLOW_INCOME_HORIZON) {
    return (facts && facts.incomeHorizonDefinition) || SOURCE_DEFINITION.KEA_SCHEDULED_RECURRING_INCOME;
  }
  return kind;
}

function copyLimitations(evidence) {
  return Array.isArray(evidence && evidence.limitations)
    ? evidence.limitations.filter((code) => typeof code === 'string')
    : [];
}

function copyObservations(evidence) {
  return Array.isArray(evidence && evidence.observations)
    ? cloneJson(evidence.observations)
    : [];
}

function copyAssumptions(evidence) {
  const rows = Array.isArray(evidence && evidence.assumptions) ? evidence.assumptions : [];
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return null;
    const code = row.code || null;
    const text = row.text != null
      ? row.text
      : (code && ASSUMPTION_TEXT_BY_CODE[code]) || null;
    return { code, text };
  }).filter(Boolean);
}

function hasLimitation(limitations, code) {
  return Array.isArray(limitations) && limitations.indexOf(code) !== -1;
}

function findObservation(observations, code) {
  if (!Array.isArray(observations)) return null;
  for (let i = 0; i < observations.length; i += 1) {
    const row = observations[i];
    if (row && row.code === code) return row;
  }
  return null;
}

function stripInternalRowKeys(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const out = {};
  const keys = Object.keys(row);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (INTERNAL_ROW_KEYS.indexOf(key) !== -1) continue;
    out[key] = cloneJson(row[key]);
  }
  return out;
}

function indexList(rows, { truncated, totalCount, cap } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const itemIds = [];
  const items = list.map((row, index) => {
    const itemId = `item${index + 1}`;
    itemIds.push(itemId);
    const copied = stripInternalRowKeys(row);
    copied.itemId = itemId;
    return copied;
  });
  return {
    items,
    meta: {
      itemIds,
      truncated: truncated === true,
      totalCount: totalCount != null ? totalCount : items.length,
      cap: cap != null ? cap : null,
    },
  };
}

function emptyScope() {
  return {
    accountScope: null,
    accountLabel: null,
    period: null,
    metricScope: null,
    category: null,
    merchant: null,
    windowKind: null,
    scenario: SCENARIO.REAL,
  };
}

function ClaimIndex() {
  this.n = 0;
  this.claims = [];
}

ClaimIndex.prototype.add = function addClaim(type, path, value, unit) {
  if (value === undefined) return;
  this.n += 1;
  this.claims.push({
    id: `c${this.n}`,
    type,
    path,
    value,
    unit: unit || CLAIM_UNITS.NONE,
    visibility: 'narratable',
  });
};

function narration(code, text) {
  return { code, text };
}

function statusFromEvidence(evidence, { empty } = {}) {
  const limitations = copyLimitations(evidence);
  const status = evidence && evidence.status;
  if (status === 'unavailable' || status == null) {
    if (limitations.some((code) => UNSUPPORTED_LIMITATIONS.indexOf(code) !== -1)) {
      return LEDGER_STATUS.UNSUPPORTED;
    }
    return LEDGER_STATUS.UNAVAILABLE;
  }
  if (status === 'partial') return LEDGER_STATUS.PARTIAL;
  if (empty === true) return LEDGER_STATUS.COMPLETE_EMPTY;
  return LEDGER_STATUS.COMPLETE;
}

function isCompletedHistoricalPeriod(period, clientDate) {
  const end = String(period && period.end || '').slice(0, 10);
  const today = String(clientDate || '').slice(0, 10);
  return isIsoDate(end) && isIsoDate(today) && end < today;
}

function completedHistoricalClientDate(evidence) {
  const fromEvidence = String(evidence && evidence.clientDate || '').slice(0, 10);
  if (isIsoDate(fromEvidence)) return fromEvidence;
  const fromDataAsOf = String(evidence && evidence.dataAsOf || '').slice(0, 10);
  return isIsoDate(fromDataAsOf) ? fromDataAsOf : '';
}

function baseLedger({
  status,
  capability,
  responseMode,
  source,
  scope,
  facts,
  claims,
  lists,
  limitations,
  assumptions,
  allowedNarration,
  prohibitedNarration,
  internal,
}) {
  return {
    version: EVIDENCE_LEDGER_VERSION,
    status,
    capability: capability || null,
    responseMode: responseMode || null,
    source: source || { kind: null, definition: null, description: null },
    scope: scope || emptyScope(),
    facts: facts || {},
    claims: Array.isArray(claims) ? claims : [],
    lists: lists || {},
    limitations: Array.isArray(limitations) ? limitations : [],
    assumptions: Array.isArray(assumptions) ? assumptions : [],
    allowedNarration: Array.isArray(allowedNarration) ? allowedNarration : [],
    prohibitedNarration: Array.isArray(prohibitedNarration) ? prohibitedNarration : [],
    internal: internal || {
      accountId: null,
      observations: [],
      prefetchMeta: null,
      builder: null,
    },
  };
}

function isNoLedgerCapability(capability) {
  return NO_LEDGER_CAPABILITIES.indexOf(capability) !== -1;
}

function validateEvidenceLedgerV1(ledger) {
  const errors = [];
  if (ledger == null) {
    return { ok: true, errors: [], ledger: null };
  }
  if (typeof ledger !== 'object' || Array.isArray(ledger)) {
    return { ok: false, errors: ['ledger_not_object'] };
  }
  if (ledger.version !== EVIDENCE_LEDGER_VERSION) {
    errors.push('version_invalid');
  }
  const statuses = Object.keys(LEDGER_STATUS).map((k) => LEDGER_STATUS[k]);
  if (statuses.indexOf(ledger.status) === -1) errors.push('status_invalid');
  if (typeof ledger.capability !== 'string' && ledger.capability !== null) {
    errors.push('capability_invalid');
  }
  if (!ledger.source || typeof ledger.source !== 'object') errors.push('source_missing');
  else {
    if (ledger.source.kind == null && ledger.status !== LEDGER_STATUS.UNAVAILABLE
      && ledger.status !== LEDGER_STATUS.UNSUPPORTED) {
      errors.push('source_kind_missing');
    }
    if (typeof ledger.source !== 'object') errors.push('source_invalid');
  }
  if (!ledger.scope || typeof ledger.scope !== 'object') errors.push('scope_missing');
  if (!ledger.facts || typeof ledger.facts !== 'object' || Array.isArray(ledger.facts)) {
    errors.push('facts_invalid');
  }
  if (!Array.isArray(ledger.claims)) errors.push('claims_invalid');
  else {
    for (let i = 0; i < ledger.claims.length; i += 1) {
      const claim = ledger.claims[i];
      if (!claim || typeof claim !== 'object') {
        errors.push('claim_invalid');
        break;
      }
      if (typeof claim.id !== 'string' || !/^c\d+$/.test(claim.id)) errors.push('claim_id_invalid');
      if (CLAIM_TYPES.indexOf(claim.type) === -1) errors.push('claim_type_invalid');
      if (typeof claim.path !== 'string') errors.push('claim_path_invalid');
      if (claim.visibility !== 'narratable' && claim.visibility !== 'internal') {
        errors.push('claim_visibility_invalid');
      }
      if (claim.value === undefined) errors.push('claim_value_missing');
    }
  }
  if (!ledger.lists || typeof ledger.lists !== 'object' || Array.isArray(ledger.lists)) {
    errors.push('lists_invalid');
  }
  if (!Array.isArray(ledger.limitations)) errors.push('limitations_invalid');
  if (!Array.isArray(ledger.assumptions)) errors.push('assumptions_invalid');
  if (!Array.isArray(ledger.allowedNarration)) errors.push('allowedNarration_invalid');
  if (!Array.isArray(ledger.prohibitedNarration)) errors.push('prohibitedNarration_invalid');
  if (!ledger.internal || typeof ledger.internal !== 'object') errors.push('internal_missing');
  return { ok: errors.length === 0, errors };
}

function walkKeys(value, visit, path) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) walkKeys(value[i], visit, `${path}[${i}]`);
    return;
  }
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    visit(key, `${path}.${key}`, value[key]);
    walkKeys(value[key], visit, `${path}.${key}`);
  }
}

/**
 * Test helper: narratable ledger surfaces must not contain internal identifiers.
 * Does not inspect ledger.internal.
 */
function collectNarratableInternalKeys(ledger) {
  if (!ledger) return [];
  const hits = [];
  const surfaces = {
    source: ledger.source,
    scope: ledger.scope,
    facts: ledger.facts,
    claims: ledger.claims,
    lists: ledger.lists,
    limitations: ledger.limitations,
    assumptions: ledger.assumptions,
    allowedNarration: ledger.allowedNarration,
    prohibitedNarration: ledger.prohibitedNarration,
  };
  walkKeys(surfaces, (key, path) => {
    if (NARRATABLE_KEY_BAN.test(key)) hits.push(path);
  }, 'ledger');
  return hits;
}

function serializedSize(ledger) {
  try {
    return Buffer.byteLength(JSON.stringify(ledger), 'utf8');
  } catch (err) {
    return null;
  }
}

module.exports = {
  EVIDENCE_LEDGER_VERSION,
  LEDGER_STATUS,
  CLAIM_TYPES,
  CLAIM_UNITS,
  SIGN_CONVENTION,
  SCENARIO,
  SOURCE_KIND,
  SOURCE_DEFINITION,
  NO_LEDGER_CAPABILITIES,
  UNSUPPORTED_LIMITATIONS,
  SOURCE_DESCRIPTION_BY_KIND,
  cloneJson,
  deepFreeze,
  isIsoDate,
  copyPeriod,
  firstSourceKind,
  sourceDescriptionFor,
  sourceDefinitionFor,
  copyLimitations,
  copyObservations,
  copyAssumptions,
  hasLimitation,
  findObservation,
  stripInternalRowKeys,
  indexList,
  emptyScope,
  ClaimIndex,
  narration,
  statusFromEvidence,
  isCompletedHistoricalPeriod,
  completedHistoricalClientDate,
  baseLedger,
  isNoLedgerCapability,
  validateEvidenceLedgerV1,
  collectNarratableInternalKeys,
  serializedSize,
};
