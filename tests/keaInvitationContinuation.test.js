'use strict';

const { check, section } = require('./harness');
const {
  routeCapability,
  isBareAffirmative,
  isBareNegative,
  isShortFollowUp,
  applyInvitationLifecycle,
  maybeSetAffordabilityInvitation,
  buildAffordabilityInvitation,
  buildInvitationClarifyText,
  buildDeterministicAffirmativeText,
  isDeterministicAffirmativeCapability,
} = require('../services/keaCapabilityRouter');
const { resolveGroundingPolicy } = require('../services/keaGroundingPolicy');
const { bundleForCapability, allowedToolsFor } = require('../services/keaToolBundles');
const { __testables: T } = require('../controllers/openaiController');

function route(message, extra = {}) {
  return routeCapability({
    message,
    currentDate: extra.currentDate || '2026-08-16',
    simulationMode: extra.simulationMode === true,
    pendingWrite: extra.pendingWrite === true,
    pendingGoalWrite: extra.pendingGoalWrite === true,
    pendingDraft: extra.pendingDraft || null,
    pendingGoalDraft: extra.pendingGoalDraft || null,
    userAffirmative: extra.userAffirmative === true ? true : T.isAffirmativeMessage(message),
    dialogueState: extra.dialogueState || T.emptyDialogueState(),
    accountId: extra.accountId || '10',
  });
}

function inviteState(extra = {}) {
  const ds = T.emptyDialogueState();
  ds.lastCapability = 'affordability_or_planning';
  ds.lastSubjectKind = 'amount';
  ds.lastSubjectValue = '800';
  ds.lastPurchaseDate = '2026-08-21';
  ds.lastAccountId = '10';
  ds.pendingInvitation = {
    kind: 'add_affordability_expense',
    sourceCapability: 'affordability_or_planning',
    amount: 800,
    date: '2026-08-21',
    accountId: '10',
    status: 'offered',
    ...extra,
  };
  if (extra.uiReferent !== undefined) {
    ds.uiReferent = extra.uiReferent;
    delete ds.pendingInvitation.uiReferent;
  }
  return ds;
}

const MIRO = {
  type: 'transaction',
  id: 9911,
  label: 'Miro Pest Control',
  amount: 80,
  date: '2026-08-23',
  category: 'Household',
};

async function run() {
  section('Phase 2.5 bare-affirmative detector is not isShortFollowUp');
  check('yes is bare affirmative', isBareAffirmative('Yes.') === true);
  check('yep is bare affirmative', isBareAffirmative('yep') === true);
  check('sure is bare affirmative', isBareAffirmative('sure') === true);
  check('okay is bare affirmative', isBareAffirmative('okay') === true);
  check('yes is not short follow-up', isShortFollowUp('yes') === false);
  check('okay is not short follow-up', isShortFollowUp('okay') === false);
  check('Add it to my forecast is not bare affirmative', isBareAffirmative('Add it to my forecast.') === false);
  check('no thanks is bare negative', isBareNegative('No thanks') === true);

  section('Phase 2.5 router precedence');
  const pendingYes = route('yes', {
    pendingWrite: true,
    userAffirmative: true,
    dialogueState: inviteState(),
  });
  check('real pending + yes → confirmation', pendingYes.capability === 'confirmation');
  check('real pending + yes is write_confirmation', pendingYes.affirmativeResolution === 'write_confirmation');

  const inviteYes = route('Yes.', { dialogueState: inviteState() });
  check('pendingInvitation + yes → invitation_continuation', inviteYes.capability === 'invitation_continuation');
  check('pendingInvitation + yes is invitation_clarify', inviteYes.affirmativeResolution === 'invitation_clarify');
  check('pendingInvitation + yes is not unknown', inviteYes.capability !== 'unknown');
  check('pendingInvitation + yes is not confirmation', inviteYes.capability !== 'confirmation');
  check('invitation yes keeps $800', inviteYes.slots.amount === 800);
  check('invitation yes keeps Aug 21', inviteYes.slots.purchaseDate === '2026-08-21');

  const analysisYes = route('yes', {
    dialogueState: { ...T.emptyDialogueState(), lastCapability: 'cashflow_analysis', lastAccountId: '10' },
  });
  check('analysis follow-up + yes → unresolved analysis_clarify', analysisYes.capability === 'bare_affirmative_unresolved');
  check('analysis follow-up resolution', analysisYes.affirmativeResolution === 'analysis_clarify');

  const nothingYes = route('yes');
  check('nothing pending + yes → unresolved', nothingYes.capability === 'bare_affirmative_unresolved');
  check('nothing pending resolution', nothingYes.affirmativeResolution === 'unresolved_clarify');
  check('nothing pending is not unknown', nothingYes.capability !== 'unknown');

  const addAfter = route('Add it to my forecast.', { dialogueState: inviteState() });
  check('explicit add after invitation → transaction_write', addAfter.capability === 'transaction_write');
  check('explicit add uses invitation amount', addAfter.slots.amount === 800);
  check('explicit add uses invitation date', addAfter.slots.purchaseDate === '2026-08-21');
  check('explicit add is write_handoff', addAfter.invitationWriteHandoff === true);

  section('Phase 2.5 live failure: focused Miro cannot replace invitation');
  const liveDs = inviteState({ uiReferent: MIRO });
  const liveYes = route('Yes.', { dialogueState: liveDs });
  const liveText = buildDeterministicAffirmativeText(liveYes);
  check('live yes is invitation_continuation', liveYes.capability === 'invitation_continuation');
  check('live yes text asks about $800', /\$800/.test(liveText) && /August 21/.test(liveText));
  check('live yes text has no Miro', !/Miro/i.test(liveText));
  check('live yes text has no $80', !/\$80\b/.test(liveText));
  check('live yes text has no Aug 23', !/August 23/.test(liveText) && !/2026-08-23/.test(liveText));
  check('live yes is deterministic (no Azure/tools)', isDeterministicAffirmativeCapability(liveYes.capability) === true);
  check('live yes tools empty', bundleForCapability(liveYes.capability).length === 0);
  check('invitation does not arm write', T.isWriteAllowed(false, false, T.isAffirmativeMessage('yes'), false) === false);
  check('invitation pendingConfirmation stays false', liveDs.pendingConfirmation === false);

  const noFocusYes = route('Yes.', { dialogueState: inviteState() });
  check('no-focus yes matches focused yes', noFocusYes.capability === liveYes.capability
    && noFocusYes.slots.amount === liveYes.slots.amount
    && noFocusYes.slots.purchaseDate === liveYes.slots.purchaseDate);

  section('Phase 2.5 referent confirmation is not write confirmation');
  const asked = inviteState({ status: 'referent_asked' });
  const secondYes = route('yes', { dialogueState: asked });
  check('second yes → transaction_write', secondYes.capability === 'transaction_write');
  check('second yes is not confirmation', secondYes.capability !== 'confirmation');
  check('second yes is write_handoff', secondYes.invitationWriteHandoff === true);
  check('second yes still does not commit', T.isWriteAllowed(
    false,
    T.isDraftProposable(asked.draftTransaction),
    T.isAffirmativeMessage('yes'),
    false
  ) === false);

  section('Phase 2.5 invitation lifecycle');
  const created = T.emptyDialogueState();
  maybeSetAffordabilityInvitation(created, {
    route: route('Can I afford $800 next Friday?'),
    accountId: '10',
    failSoft: false,
    macroOwnsTurn: true,
    evidence: { status: 'ok', source: ['affordability_analysis'] },
  });
  check('successful affordability creates invitation', created.pendingInvitation
    && created.pendingInvitation.kind === 'add_affordability_expense'
    && created.pendingInvitation.amount === 800
    && created.pendingInvitation.date === '2026-08-21'
    && created.pendingInvitation.status === 'offered');
  check('invitation is not pendingConfirmation', created.pendingConfirmation === false);

  const noMacro = T.emptyDialogueState();
  maybeSetAffordabilityInvitation(noMacro, {
    route: route('Can I afford $800 next Friday?'),
    accountId: '10',
    failSoft: false,
    macroOwnsTurn: false,
    evidence: { status: 'ok', source: ['affordability_analysis'] },
  });
  check('capability alone does not create invitation', noMacro.pendingInvitation == null);

  const dsClarify = inviteState();
  applyInvitationLifecycle(dsClarify, inviteYes, { accountId: '10' });
  check('yes marks referent_asked', dsClarify.pendingInvitation && dsClarify.pendingInvitation.status === 'referent_asked');

  const dsDecline = inviteState();
  const declined = route('No thanks', { dialogueState: dsDecline });
  applyInvitationLifecycle(dsDecline, declined, { accountId: '10' });
  check('negative clears invitation', dsDecline.pendingInvitation == null);
  check('negative is not unknown', declined.capability === 'invitation_continuation');
  check('decline text is brief', buildDeterministicAffirmativeText(declined) === 'Okay.');

  const dsTopic = inviteState();
  const nextMonth = route('Will I go negative next month?', { dialogueState: dsTopic });
  applyInvitationLifecycle(dsTopic, nextMonth, { accountId: '10' });
  check('new topic is cashflow_analysis', nextMonth.capability === 'cashflow_analysis');
  check('new topic clears invitation', dsTopic.pendingInvitation == null);
  check('new topic does not set needsReconfirm', dsTopic.needsReconfirm !== true);
  const laterYes = route('yes', { dialogueState: dsTopic });
  check('later yes cannot recover $800 invitation', laterYes.capability !== 'invitation_continuation');
  check('later yes is not confirmation', laterYes.capability !== 'confirmation');

  const dsAcct = inviteState();
  const switchedYes = route('yes', { dialogueState: dsAcct, accountId: '99' });
  check('account change ignores invitation', switchedYes.capability === 'bare_affirmative_unresolved');
  applyInvitationLifecycle(dsAcct, switchedYes, { accountId: '99' });
  check('account change clears invitation', dsAcct.pendingInvitation == null);

  const dsAdd = inviteState();
  applyInvitationLifecycle(dsAdd, addAfter, { accountId: '10' });
  check('explicit add consumes invitation', dsAdd.pendingInvitation == null);

  section('Phase 2.5 invitation paraphrases share structured semantics');
  const affordRoute = route('Can I afford $800 next Friday?');
  const inv = buildAffordabilityInvitation(affordRoute, '10');
  check('controlled affordability path builds the same invitation shape', inv
    && inv.kind === 'add_affordability_expense'
    && inv.amount === 800
    && inv.date === '2026-08-21');
  const clarify = buildInvitationClarifyText(inv);
  check('clarify text is referent confirmation', clarify === "Do you mean you'd like me to add the $800 expense on August 21?");

  section('Phase 2.5 tool bundles and grounding');
  check('invitation_continuation tools empty', bundleForCapability('invitation_continuation').length === 0);
  check('unresolved affirmative tools empty', bundleForCapability('bare_affirmative_unresolved').length === 0);
  check('unknown still has getFocusedEntityDetails', bundleForCapability('unknown').includes('getFocusedEntityDetails'));
  check('deictic lookup still has getFocusedEntityDetails', bundleForCapability('financial_lookup').includes('getFocusedEntityDetails'));
  check('confirmation still has createTransaction', bundleForCapability('confirmation', { pendingType: 'transaction' }).includes('createTransaction'));
  check(
    'invitation write omits focused-entity tools',
    !allowedToolsFor('transaction_write', { omitFocusedEntityTools: true }).has('getFocusedEntityDetails')
    && !allowedToolsFor('transaction_write', { omitFocusedEntityTools: true }).has('getUserTransactions')
    && allowedToolsFor('transaction_write', { omitFocusedEntityTools: true }).has('updateDraftTransaction')
  );
  check(
    'normal transaction_write keeps focused-entity tools',
    allowedToolsFor('transaction_write').has('getFocusedEntityDetails')
  );

  const invitePolicy = resolveGroundingPolicy(inviteYes, { message: 'Yes.' });
  check('invitation yes grounding NONE', invitePolicy.grounding === 'NONE');
  check('invitation yes not required', invitePolicy.groundingRequired === false);
  const unresolvedPolicy = resolveGroundingPolicy(nothingYes, { message: 'Yes.' });
  check('unresolved yes grounding NONE', unresolvedPolicy.grounding === 'NONE');

  section('Phase 2.5 needsReconfirm / real proposal regression');
  const realDs = T.emptyDialogueState();
  realDs.pendingConfirmation = true;
  realDs.draftTransaction = { title: 'Widget', type: 'expense', amount: 800, start: '2026-08-21' };
  realDs.pendingInvitation = inviteState().pendingInvitation;
  const realYes = route('yes', { pendingWrite: true, userAffirmative: true, dialogueState: realDs });
  check('real proposal still beats invitation', realYes.capability === 'confirmation');
  check('real proposal still write-allowed', T.isWriteAllowed(true, true, T.isAffirmativeMessage('yes'), false) === true);

  const switched = T.emptyDialogueState();
  switched.draftTransaction = { title: 'Widget', type: 'expense', amount: 800, start: '2026-08-21' };
  switched.pendingConfirmation = true;
  const lookupRoute = route('How much did I spend at Walmart last month?', { pendingWrite: true });
  T.applyPendingWriteTopicSwitch(switched, lookupRoute, { pendingArmedAtStart: true, userAffirmative: false });
  check('topic switch still sets needsReconfirm', switched.needsReconfirm === true);
  check('topic switch still clears pendingConfirmation', switched.pendingConfirmation === false);
  const yesAfterSwitch = route('yes', {
    pendingWrite: true,
    userAffirmative: true,
    dialogueState: switched,
  });
  check('yes after needsReconfirm is not confirmation', yesAfterSwitch.capability !== 'confirmation');
  check('yes after needsReconfirm cannot commit', T.isWriteAllowed(
    false,
    T.isDraftProposable(switched.draftTransaction) && switched.needsReconfirm !== true,
    T.isAffirmativeMessage('yes'),
    false
  ) === false);
}

module.exports = { run };
