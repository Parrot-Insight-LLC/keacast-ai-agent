'use strict';

class AccountAccessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AccountAccessError';
    this.code = code;
  }
}

function idsEqual(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

/**
 * Owner OR satellite member may access an account.
 * Satellite table/columns are misspelled `satelite` in cashflow-backend
 * (AccountController gatherSatelliteAccounts / list-accounts).
 */
async function assertAccountAccess(userId, accountId, { queryFn } = {}) {
  if (userId == null || userId === '') {
    throw new AccountAccessError('ACCESS_DENIED', 'Authenticated user is required.');
  }
  if (accountId == null || accountId === '') {
    throw new AccountAccessError('ACCOUNT_REQUIRED', 'An account is required.');
  }

  const q = queryFn || require('./db').query;
  const rows = await q(
    'SELECT accountid, userid, satelite_id FROM accounts WHERE accountid = ? LIMIT 1',
    [accountId]
  );
  const account = rows && rows[0];
  if (!account) {
    throw new AccountAccessError('ACCESS_DENIED', 'Account not found or not accessible.');
  }
  if (idsEqual(account.userid, userId)) {
    return { account, access: 'owner' };
  }
  if (account.satelite_id != null && account.satelite_id !== '') {
    const sat = await q(
      'SELECT satelite_id FROM satelite WHERE satelite_id = ? AND satelite_user_id = ? LIMIT 1',
      [account.satelite_id, userId]
    );
    if (sat && sat.length) {
      return { account, access: 'satellite' };
    }
  }
  throw new AccountAccessError('ACCESS_DENIED', 'Account not found or not accessible.');
}

module.exports = { assertAccountAccess, AccountAccessError, idsEqual };
