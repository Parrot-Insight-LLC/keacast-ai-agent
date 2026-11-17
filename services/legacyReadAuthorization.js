'use strict';

// SEC-01: read-only subset of the backend accountTransactionAuth policy at
// cd988ab8d157a053ed1c77e9fad4225a37f34dd0. Keep valid-grant parity tests when
// changing this adapter; never import the backend's DB-initializing module.
const GRANTS = new Set(['Owner', 'Full Access', 'All', 'View', 'Forecast',
  'Reconcile', 'Balances', 'Administrator', 'Notifications']);
const ALIASES = { Reconciliation: 'Reconcile', Forecasting: 'Forecast' };

function id(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (!/^\d+$/.test(String(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? String(number) : null;
}

// Reject malformed/unknown stored grants rather than searching substrings
// (e.g. "NotView" must not grant View). Preserve valid product tokens/aliases.
function readCapabilities(raw) {
  const labels = new Set();
  let valid = true;
  function scan(value, depth = 0) {
    if (depth > 8 || value == null) { valid = false; return; }
    if (Array.isArray(value)) {
      if (!value.length) valid = false;
      value.forEach(item => scan(item, depth + 1));
      return;
    }
    if (typeof value === 'object') {
      const values = Object.values(value);
      if (!values.length) valid = false;
      values.forEach(item => scan(item, depth + 1));
      return;
    }
    if (typeof value !== 'string' || !value.trim()) { valid = false; return; }
    const text = value.trim();
    if (text.startsWith('[') || text.startsWith('{')) {
      try { scan(JSON.parse(text), depth + 1); } catch (_) { valid = false; }
      return;
    }
    for (const part of text.split('+')) {
      const token = part.trim();
      if (token === 'View Balances') { labels.add('View'); labels.add('Balances'); }
      else if (Object.prototype.hasOwnProperty.call(ALIASES, token)) labels.add(ALIASES[token]);
      else if (GRANTS.has(token)) labels.add(token);
      else valid = false;
    }
  }
  scan(raw);
  if (!valid || !labels.size) return new Set();
  const full = labels.has('Owner') || labels.has('All') || labels.has('Full Access');
  const capabilities = new Set(['TRANSACTION_READ']);
  if (full || labels.has('Forecast') || labels.has('Reconcile')) capabilities.add('FORECAST_READ');
  return capabilities;
}

function denied() {
  const error = new Error('Resource not accessible');
  error.code = 'LEGACY_ACCESS_DENIED';
  return error;
}

async function authorizeAccount(actor, accountId, operation, { queryFn } = {}) {
  const actorId = id(actor);
  const resourceId = id(accountId);
  if (!actorId || !resourceId || !['TRANSACTION_READ', 'FORECAST_READ'].includes(operation)) throw denied();
  const query = queryFn || require('./db').query;
  const rows = await query('SELECT accountid, userid, satelite_id FROM accounts WHERE accountid = ? LIMIT 1', [resourceId]);
  const account = rows && rows[0];
  if (!account || id(account.accountid) !== resourceId || !id(account.userid)) throw denied();
  if (id(account.userid) === actorId) return { account, role: 'OWNER' };
  if (!id(account.satelite_id)) throw denied();
  const relationships = await query(
    'SELECT satelite_id, owner_id, satelite_user_id, permission_level FROM satelite WHERE satelite_id = ? AND satelite_user_id = ?',
    [account.satelite_id, actorId]);
  if (!Array.isArray(relationships) || !relationships.length) throw denied();
  if (relationships.some(row => !row || id(row.satelite_id) !== id(account.satelite_id)
      || id(row.satelite_user_id) !== actorId || id(row.owner_id) !== id(account.userid))) throw denied();
  if (new Set(relationships.map(row => String(row.permission_level ?? ''))).size !== 1) throw denied();
  if (!readCapabilities(relationships[0].permission_level).has(operation)) throw denied();
  return { account, role: 'SATELLITE' };
}

function sanitizeAccounts(result) {
  return { ...result, accounts: result.accounts.map(account => {
    const { access_token, processor_token, disabled_access_token, ...safe } = account;
    return safe;
  }) };
}

module.exports = { id, readCapabilities, authorizeAccount, sanitizeAccounts };
