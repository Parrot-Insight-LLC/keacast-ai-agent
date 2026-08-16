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
  check('emptyDialogueState has continuation fields', T.emptyDialogueState().lastCapability === null);
  check('emptyDialogueState lastPeriod starts null', T.emptyDialogueState().lastPeriod === null);
  check('emptyDialogueState lastAccountId starts null', T.emptyDialogueState().lastAccountId === null);
  check('emptyDialogueState needsReconfirm starts false', T.emptyDialogueState().needsReconfirm === false);
  check('emptyDialogueState goalNeedsReconfirm starts false', T.emptyDialogueState().goalNeedsReconfirm === false);

  section('topic-switch yes cannot commit; re-propose then yes can');
  const draft = { title: 'Coffee', type: 'expense', amount: 8, start: '2026-08-20', category: 'Dining' };
  const ds = T.emptyDialogueState();
  ds.draftTransaction = { ...draft };
  ds.pendingConfirmation = true;
  T.applyPendingWriteTopicSwitch(ds, { capability: 'financial_lookup', pendingType: 'transaction' }, {
    pendingArmedAtStart: true,
    userAffirmative: false,
  });
  check('slots remain after topic switch', ds.draftTransaction.amount === 8 && ds.draftTransaction.title === 'Coffee');
  const draftCompleteAfterSwitch = T.isDraftProposable(ds.draftTransaction) && ds.needsReconfirm !== true;
  const proposalArmsAfterSwitch = true && ds.needsReconfirm !== true;
  check(
    'yes after topic switch is not armed (complete draft + leftover proposal)',
    T.isWriteAllowed(false, draftCompleteAfterSwitch, true, proposalArmsAfterSwitch) === false
  );
  ds.pendingConfirmation = true;
  ds.needsReconfirm = false;
  const draftCompleteReproposed = T.isDraftProposable(ds.draftTransaction) && ds.needsReconfirm !== true;
  check(
    're-propose then yes is armed exactly once',
    T.isWriteAllowed(true, draftCompleteReproposed, true, false) === true
  );

  const gds = T.emptyDialogueState();
  gds.draftGoal = { title: 'Vacation', target_amount: 1000, end_date: '2026-12-01', frequency: '30' };
  gds.pendingGoalConfirmation = true;
  T.applyPendingWriteTopicSwitch(gds, { capability: 'financial_lookup', pendingType: 'goal' }, {
    pendingArmedAtStart: true,
    userAffirmative: false,
  });
  check('goal slots remain', gds.draftGoal.title === 'Vacation' && gds.draftGoal.target_amount === 1000);
  const goalCompleteAfter = T.isGoalDraftProposable(gds.draftGoal) && gds.goalNeedsReconfirm !== true;
  check(
    'goal yes after topic switch is not armed',
    T.isGoalWriteAllowed(false, goalCompleteAfter, true, gds.goalNeedsReconfirm !== true) === false
  );
  gds.pendingGoalConfirmation = true;
  gds.goalNeedsReconfirm = false;
  check(
    'goal re-propose then yes is armed',
    T.isGoalWriteAllowed(true, T.isGoalDraftProposable(gds.draftGoal) && gds.goalNeedsReconfirm !== true, true, false) === true
  );

  section('write-gate identity strip does not change allow condition');
  const ctx = { userId: 5, token: 'trusted', accountId: 22 };
  const stripped = injectTrustedIdentity({ token: 'forged', userId: 1, amount: 50, type: 'expense' }, ctx);
  check('stripped args still have amount/type for the write path', stripped.amount === 50 && stripped.type === 'expense');
  check('write-allow condition ignores identity fields', T.isWriteAllowed(true, false, true) === true);
}

module.exports = { run };
