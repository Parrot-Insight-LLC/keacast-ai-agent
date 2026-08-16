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
  shouldSkipAzureForRoute,
  INVITATION_FREQUENCY_ONCE,
  INVITATION_DEFAULT_CATEGORY,
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
    knownCategories: extra.knownCategories,
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

const CATEGORIES = ['Electronics', 'Household', 'Uncategorized'];

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
  check('second yes → invitation_continuation', secondYes.capability === 'invitation_continuation');
  check('second yes is title ask', secondYes.affirmativeResolution === 'invitation_title_ask');
  check('second yes is not confirmation', secondYes.capability !== 'confirmation');
  check('second yes is not transaction_write', secondYes.capability !== 'transaction_write');
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
  check('explicit add without title waits for title', dsAdd.pendingInvitation
    && dsAdd.pendingInvitation.status === 'awaiting_title');
  check('explicit add without title does not arm confirmation', dsAdd.pendingConfirmation === false);

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

  section('Phase 2.6 live failure: referent yes seeds trusted draft and asks title');
  const liveFail = inviteState({ status: 'referent_asked', uiReferent: MIRO });
  liveFail.draftTransaction = {
    title: 'Laptop Purchase',
    category: 'Expense',
    amount: 80,
    start: '2026-08-23',
    type: 'expense',
    merchant: 'Best Buy',
    memo: 'Miro Pest Control',
  };
  const titleAskRoute = route('Yes.', { dialogueState: liveFail });
  applyInvitationLifecycle(liveFail, titleAskRoute, { accountId: '10', categoryNames: CATEGORIES });
  const titleAskText = buildDeterministicAffirmativeText(titleAskRoute, liveFail);
  const draftAfterYes = liveFail.draftTransaction || {};
  check('title-ask capability is invitation_continuation', titleAskRoute.capability === 'invitation_continuation');
  check('title-ask resolution', titleAskRoute.affirmativeResolution === 'invitation_title_ask');
  check('title-ask skips Azure', shouldSkipAzureForRoute(titleAskRoute) === true);
  check('title-ask tools empty', bundleForCapability(titleAskRoute.capability).length === 0);
  check('seeded amount is 800', draftAfterYes.amount === 800);
  check('seeded start is Aug 21', draftAfterYes.start === '2026-08-21');
  check('seeded type is expense', draftAfterYes.type === 'expense');
  check('seeded frequency is Once', draftAfterYes.frequency === INVITATION_FREQUENCY_ONCE);
  check('title remains unset', draftAfterYes.title == null || String(draftAfterYes.title).trim() === '');
  check('category remains unset', draftAfterYes.category == null || String(draftAfterYes.category).trim() === '');
  check('merchant not copied', draftAfterYes.merchant == null);
  check('memo not copied', draftAfterYes.memo == null);
  check('pendingConfirmation stays false after referent yes', liveFail.pendingConfirmation === false);
  check('invitation status awaiting_title', liveFail.pendingInvitation && liveFail.pendingInvitation.status === 'awaiting_title');
  check('title-ask text', titleAskText === 'I can prepare the $800 expense for August 21. What would you like to call it?');
  check('title-ask has no Laptop Purchase', !/Laptop Purchase/i.test(titleAskText));
  check('title-ask has no Expense category', !/\bExpense\b/.test(titleAskText));
  check('title-ask has no Household', !/Household/i.test(titleAskText));
  check('title-ask has no Best Buy', !/Best Buy/i.test(titleAskText));
  check('title-ask has no Miro', !/Miro/i.test(titleAskText));
  check('title-ask has no forecast claim', !/forecast positive|negative balances|fits your plan|\bsafe\b|\bcomfortable\b|\baffordable\b/i.test(titleAskText));
  check('incomplete seed is not proposable', T.isDraftProposable(draftAfterYes) === false);

  section('Phase 2.6 title only produces proposal');
  const titleOnlyDs = inviteState({ status: 'awaiting_title' });
  titleOnlyDs.draftTransaction = {
    amount: 800,
    start: '2026-08-21',
    type: 'expense',
    frequency: INVITATION_FREQUENCY_ONCE,
  };
  const titleOnlyRoute = route('Laptop', { dialogueState: titleOnlyDs, knownCategories: CATEGORIES });
  applyInvitationLifecycle(titleOnlyDs, titleOnlyRoute, { accountId: '10', categoryNames: CATEGORIES });
  const titleOnlyText = buildDeterministicAffirmativeText(titleOnlyRoute, titleOnlyDs, { accountName: 'Main Account' });
  check('title-only is slot_fill', titleOnlyRoute.capability === 'invitation_continuation'
    && titleOnlyRoute.affirmativeResolution === 'invitation_slot_fill');
  check('title-only sets Laptop', titleOnlyDs.draftTransaction.title === 'Laptop');
  check('title-only keeps amount/date', titleOnlyDs.draftTransaction.amount === 800
    && titleOnlyDs.draftTransaction.start === '2026-08-21');
  check('title-only defaults Uncategorized', titleOnlyDs.draftTransaction.category === INVITATION_DEFAULT_CATEGORY);
  check('title-only arms pendingConfirmation', titleOnlyDs.pendingConfirmation === true);
  check('title-only consumes invitation', titleOnlyDs.pendingInvitation == null);
  check('title-only is proposable', T.isDraftProposable(titleOnlyDs.draftTransaction) === true);
  check('title-only proposal names Laptop', /Title: Laptop/.test(titleOnlyText));
  check('title-only proposal amount', /Amount: \$800/.test(titleOnlyText));
  check('title-only proposal date', /Date: August 21, 2026/.test(titleOnlyText));
  check('title-only proposal frequency', /Frequency: One-time/.test(titleOnlyText));
  check('title-only proposal category Uncategorized', /Category: Uncategorized/.test(titleOnlyText));
  check('title-only proposal account', /Account: Main Account/.test(titleOnlyText));
  check('title-only proposal asks confirm', /Confirm\?/.test(titleOnlyText));
  check('title-only proposal has no forecast claim', !/forecast positive|negative balances|fits your plan|\bsafe\b|\bcomfortable\b|\baffordable\b/i.test(titleOnlyText));
  check('title-only does not ask for category', !/what (category|would you like to (put|categorize))/i.test(titleOnlyText));

  section('Phase 2.6 title + category');
  const bothDs = inviteState({ status: 'awaiting_title' });
  bothDs.draftTransaction = {
    amount: 800,
    start: '2026-08-21',
    type: 'expense',
    frequency: INVITATION_FREQUENCY_ONCE,
  };
  const bothRoute = route('Call it Laptop and put it under Electronics.', {
    dialogueState: bothDs,
    knownCategories: CATEGORIES,
  });
  applyInvitationLifecycle(bothDs, bothRoute, { accountId: '10', categoryNames: CATEGORIES });
  const bothText = buildDeterministicAffirmativeText(bothRoute, bothDs, { accountName: 'Main Account' });
  check('title+category sets Laptop', bothDs.draftTransaction.title === 'Laptop');
  check('title+category snaps Electronics', bothDs.draftTransaction.category === 'Electronics');
  check('title+category keeps trusted slots', bothDs.draftTransaction.amount === 800
    && bothDs.draftTransaction.start === '2026-08-21'
    && bothDs.draftTransaction.type === 'expense'
    && bothDs.draftTransaction.frequency === INVITATION_FREQUENCY_ONCE);
  check('title+category proposes', bothDs.pendingConfirmation === true && /Title: Laptop/.test(bothText)
    && /Category: Electronics/.test(bothText));

  section('Phase 2.6 category only still asks for title');
  const catOnlyDs = inviteState({ status: 'awaiting_title' });
  catOnlyDs.draftTransaction = {
    amount: 800,
    start: '2026-08-21',
    type: 'expense',
    frequency: INVITATION_FREQUENCY_ONCE,
  };
  const catOnlyRoute = route('Put it under Electronics.', {
    dialogueState: catOnlyDs,
    knownCategories: CATEGORIES,
  });
  applyInvitationLifecycle(catOnlyDs, catOnlyRoute, { accountId: '10', categoryNames: CATEGORIES });
  const catOnlyText = buildDeterministicAffirmativeText(catOnlyRoute, catOnlyDs);
  check('category-only sets Electronics', catOnlyDs.draftTransaction.category === 'Electronics');
  check('category-only title still missing', !catOnlyDs.draftTransaction.title);
  check('category-only does not propose', catOnlyDs.pendingConfirmation === false);
  check('category-only invitation remains', catOnlyDs.pendingInvitation
    && catOnlyDs.pendingInvitation.status === 'awaiting_title');
  check('category-only asks for title', catOnlyText === 'What would you like to call the $800 expense?');
  check('category-only is not proposable', T.isDraftProposable(catOnlyDs.draftTransaction) === false);

  section('Phase 2.6 user never said Laptop');
  check('original affordability does not capture laptop', route('Can I afford $800 next Friday?').slots.title == null);
  check('title-ask draft has no Laptop', !/Laptop/i.test(JSON.stringify(draftAfterYes)));

  section('Phase 2.6 focused Miro cannot fill invitation slots');
  check('miro leftover title was wiped', draftAfterYes.title == null || String(draftAfterYes.title).trim() === '');
  check('miro leftover category was wiped', draftAfterYes.category == null);
  check('miro leftover amount was not kept', draftAfterYes.amount !== 80);
  check('miro leftover date was not kept', draftAfterYes.start !== '2026-08-23');

  section('Phase 2.6 old history cannot supply title/category');
  const histDs = inviteState({ status: 'referent_asked' });
  histDs.draftTransaction = {
    title: 'Laptop Purchase',
    category: 'Household',
    amount: 50,
    start: '2026-01-01',
    type: 'expense',
  };
  const histRoute = route('yes', { dialogueState: histDs });
  applyInvitationLifecycle(histDs, histRoute, { accountId: '10', categoryNames: CATEGORIES });
  check('history Best Buy/Laptop/Household not in seed', histDs.draftTransaction.title == null
    && histDs.draftTransaction.category == null
    && histDs.draftTransaction.amount === 800
    && histDs.draftTransaction.start === '2026-08-21');

  section('Phase 2.6 full sequence one commit');
  const seq = inviteState();
  const seqYes1 = route('Yes.', { dialogueState: seq });
  applyInvitationLifecycle(seq, seqYes1, { accountId: '10', categoryNames: CATEGORIES });
  check('seq step 1 referent asked', seq.pendingInvitation.status === 'referent_asked');
  check('seq step 1 cannot commit', T.isWriteAllowed(seq.pendingConfirmation, T.isDraftProposable(seq.draftTransaction), true, false) === false);
  const seqYes2 = route('Yes.', { dialogueState: seq });
  applyInvitationLifecycle(seq, seqYes2, { accountId: '10', categoryNames: CATEGORIES });
  check('seq step 2 title ask', seqYes2.affirmativeResolution === 'invitation_title_ask');
  check('seq step 2 cannot commit', T.isWriteAllowed(seq.pendingConfirmation, T.isDraftProposable(seq.draftTransaction), true, false) === false);
  const seqTitle = route('Laptop', { dialogueState: seq, knownCategories: CATEGORIES });
  applyInvitationLifecycle(seq, seqTitle, { accountId: '10', categoryNames: CATEGORIES });
  check('seq step 3 proposal armed', seq.pendingConfirmation === true && T.isDraftProposable(seq.draftTransaction) === true);
  const seqConfirm = route('yes', {
    pendingWrite: true,
    userAffirmative: true,
    dialogueState: seq,
  });
  check('seq step 4 yes is confirmation', seqConfirm.capability === 'confirmation');
  check('seq step 4 write confirmation', seqConfirm.affirmativeResolution === 'write_confirmation');
  check('seq step 4 can commit once', T.isWriteAllowed(true, true, T.isAffirmativeMessage('yes'), false) === true);
  check('seq final draft trusted+user', seq.draftTransaction.title === 'Laptop'
    && seq.draftTransaction.amount === 800
    && seq.draftTransaction.start === '2026-08-21'
    && seq.draftTransaction.type === 'expense'
    && seq.draftTransaction.frequency === INVITATION_FREQUENCY_ONCE
    && seq.draftTransaction.category === INVITATION_DEFAULT_CATEGORY);

  section('Phase 2.6 explicit fast path');
  const fastDs = inviteState();
  const fastRoute = route('Add it as Laptop under Electronics.', {
    dialogueState: fastDs,
    knownCategories: CATEGORIES,
  });
  applyInvitationLifecycle(fastDs, fastRoute, { accountId: '10', categoryNames: CATEGORIES });
  const fastText = buildDeterministicAffirmativeText(fastRoute, fastDs, { accountName: 'Main Account' });
  check('fast path is transaction_write', fastRoute.capability === 'transaction_write');
  check('fast path is write_handoff', fastRoute.affirmativeResolution === 'write_handoff');
  check('fast path skips Azure', shouldSkipAzureForRoute(fastRoute) === true);
  check('fast path uses invitation amount/date', fastDs.draftTransaction.amount === 800
    && fastDs.draftTransaction.start === '2026-08-21');
  check('fast path title from user', fastDs.draftTransaction.title === 'Laptop');
  check('fast path category from user', fastDs.draftTransaction.category === 'Electronics');
  check('fast path type/frequency deterministic', fastDs.draftTransaction.type === 'expense'
    && fastDs.draftTransaction.frequency === INVITATION_FREQUENCY_ONCE);
  check('fast path proposes', fastDs.pendingConfirmation === true && /Title: Laptop/.test(fastText)
    && /Category: Electronics/.test(fastText));
  check('fast path skips referent question', !/Do you mean/.test(fastText));
  const fastYes = route('yes', { pendingWrite: true, userAffirmative: true, dialogueState: fastDs });
  check('fast path later yes commits', fastYes.capability === 'confirmation'
    && T.isWriteAllowed(true, true, true, false) === true);

  section('Phase 2.6 normal write regression keeps ESTIMATE path');
  const normalWrite = route('Add an $800 expense next Friday.');
  check('normal write is transaction_write', normalWrite.capability === 'transaction_write');
  check('normal write is not invitation handoff', normalWrite.invitationWriteHandoff === false);
  check('normal write still uses Azure', shouldSkipAzureForRoute(normalWrite) === false);

  section('Phase 2.6 Phase 2.5 regression: first yes / unresolved / telemetry');
  check('first yes still invitation_clarify', inviteYes.affirmativeResolution === 'invitation_clarify');
  check('first yes still deterministic', isDeterministicAffirmativeCapability(inviteYes.capability) === true);
  check('unresolved yes still unresolved_clarify', nothingYes.affirmativeResolution === 'unresolved_clarify');
  check('unresolved yes tools empty', bundleForCapability(nothingYes.capability).length === 0);
}

module.exports = { run };
