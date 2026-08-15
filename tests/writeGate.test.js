'use strict';

const { check, section } = require('./harness');
const { __testables: T } = require('../controllers/openaiController');
const { injectTrustedIdentity } = require('../services/keaIdentity');

async function run() {
  section('write-gate regressions (propose → confirm → write unchanged)');

  check('block write when nothing pending or drafted', T.isWriteAllowed(false, false, T.isAffirmativeMessage('add a carpet forecast')) === false);
  check('allow write when flag armed + affirmative', T.isWriteAllowed(true, false, T.isAffirmativeMessage('yes please')) === true);
  check('allow write when draft complete + affirmative', T.isWriteAllowed(false, true, T.isAffirmativeMessage('this definitely works for me')) === true);
  check('block write when armed but not affirmative', T.isWriteAllowed(false, true, T.isAffirmativeMessage('actually, maybe later')) === false);
  check('goal write blocked when only tx draft is complete', T.isGoalWriteAllowed(false, false, true, false) === false);
  check('goal write allowed when goal draft complete + affirmative', T.isGoalWriteAllowed(false, true, true, false) === true);

  section('write-gate identity strip does not change allow condition');
  const ctx = { userId: 5, token: 'trusted', accountId: 22 };
  const stripped = injectTrustedIdentity({ token: 'forged', userId: 1, amount: 50, type: 'expense' }, ctx);
  check('stripped args still have amount/type for the write path', stripped.amount === 50 && stripped.type === 'expense');
  check('write-allow condition ignores identity fields', T.isWriteAllowed(true, false, true) === true);
}

module.exports = { run };
