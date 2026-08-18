'use strict';

/**
 * Phase 3B.3B.3 — request-local snapshot evidence adapter.
 *
 * Copies already-compact recents / upcoming / futureNegativeBalances onto a
 * derived evidence object so EvidenceLedgerV1 can represent item-level
 * snapshot facts. Does not mutate production phase1Evidence, does not fetch,
 * and does not recap/sort/recalculate. Production Azure (3B.3B.5) consumes
 * this adapter through projectSnapshotEvidence when the snapshot flag is on.
 */

const { cloneJson, deepFreeze } = require('./keaEvidenceLedger');

const DROP_ROW_KEYS = Object.freeze([
  'transactionid',
  'transactionId',
  'groupid',
  'groupId',
  'accountid',
  'accountId',
  'userid',
  'userId',
  'jwt',
  'itemId',
]);

function copyRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const src = cloneJson(row);
  const out = {};
  const keys = Object.keys(src);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (DROP_ROW_KEYS.indexOf(key) !== -1) continue;
    out[key] = src[key];
  }
  return out;
}

function copyList(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const copied = copyRow(rows[i]);
    if (copied) out.push(copied);
  }
  return out;
}

function adaptSnapshotEvidenceForLedger({ evidence, selectedAccount } = {}) {
  const derived = evidence && typeof evidence === 'object' ? cloneJson(evidence) : {};
  if (!derived.facts || typeof derived.facts !== 'object' || Array.isArray(derived.facts)) {
    derived.facts = {};
  }
  if (Array.isArray(derived.source) === false) {
    derived.source = ['kea_snapshot'];
  }
  const compact = selectedAccount && typeof selectedAccount === 'object' ? selectedAccount : null;
  if (compact) {
    derived.facts.recents = copyList(compact.recents);
    derived.facts.upcoming = copyList(compact.upcoming);
    derived.facts.futureNegativeBalances = copyList(compact.futureNegativeBalances);
  }
  return deepFreeze(derived);
}

module.exports = {
  adaptSnapshotEvidenceForLedger,
};
