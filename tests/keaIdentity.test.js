'use strict';

const { check, section } = require('./harness');
const { injectTrustedIdentity } = require('../services/keaIdentity');

async function run() {
  section('injectTrustedIdentity');

  const ctx = { userId: 5, token: 'trusted-jwt', accountId: 22 };
  const injected = injectTrustedIdentity({
    token: 'model-supplied-token',
    userId: 999,
    accountId: 88,
    title: 'Rent',
  }, ctx);

  check('strips model token', injected.token === undefined);
  check('strips model userId', injected.userId === undefined);
  check('does not overwrite an explicit accountId', injected.accountId === 88);
  check('preserves non-identity args', injected.title === 'Rent');

  const defaulted = injectTrustedIdentity({ amount: 10 }, ctx);
  check('defaults accountId from ctx when omitted', defaulted.accountId === 22);
  check('does not inject userId onto args', defaulted.userId === undefined);
  check('does not inject token onto args', defaulted.token === undefined);
}

module.exports = { run };
