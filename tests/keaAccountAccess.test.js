'use strict';

const { check, section } = require('./harness');
const { assertAccountAccess, AccountAccessError } = require('../services/keaAccountAccess');

function queryFromRows(map) {
  return async (sql, params) => {
    const key = `${sql}|${JSON.stringify(params)}`;
    if (map[key]) return map[key];
    if (sql.includes('FROM accounts')) {
      return map.account || [];
    }
    if (sql.includes('FROM satelite')) {
      return map.satellite || [];
    }
    return [];
  };
}

async function run() {
  section('assertAccountAccess');

  try {
    await assertAccountAccess(null, 1, { queryFn: async () => [] });
    check('missing userId throws', false);
  } catch (e) {
    check('missing userId throws ACCESS_DENIED', e instanceof AccountAccessError && e.code === 'ACCESS_DENIED');
  }

  try {
    await assertAccountAccess(5, null, { queryFn: async () => [] });
    check('missing accountId throws', false);
  } catch (e) {
    check('missing accountId throws ACCOUNT_REQUIRED', e instanceof AccountAccessError && e.code === 'ACCOUNT_REQUIRED');
  }

  {
    const queryFn = queryFromRows({
      account: [{ accountid: 10, userid: 5, satelite_id: null }],
    });
    const result = await assertAccountAccess(5, 10, { queryFn });
    check('owner userid match is allowed', result.access === 'owner');
  }

  {
    const queryFn = queryFromRows({
      account: [{ accountid: 10, userid: 5, satelite_id: null }],
    });
    try {
      await assertAccountAccess(9, 10, { queryFn });
      check('non-owner without satellite is denied', false);
    } catch (e) {
      check('non-owner without satellite is denied', e.code === 'ACCESS_DENIED');
    }
  }

  {
    const queryFn = async (sql, params) => {
      if (sql.includes('FROM accounts')) {
        return [{ accountid: 10, userid: 1, satelite_id: 77 }];
      }
      if (sql.includes('FROM satelite')) {
        check('satellite query uses satelite_id + satelite_user_id', params[0] === 77 && params[1] === 9);
        return [{ satelite_id: 77 }];
      }
      return [];
    };
    const result = await assertAccountAccess(9, 10, { queryFn });
    check('satellite member is allowed', result.access === 'satellite');
  }

  {
    const queryFn = async (sql) => {
      if (sql.includes('FROM accounts')) {
        return [{ accountid: 10, userid: 1, satelite_id: 77 }];
      }
      return [];
    };
    try {
      await assertAccountAccess(9, 10, { queryFn });
      check('unrelated user on satellite account is denied', false);
    } catch (e) {
      check('unrelated user on satellite account is denied', e.code === 'ACCESS_DENIED');
    }
  }
}

module.exports = { run };
