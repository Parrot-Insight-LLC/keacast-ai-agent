'use strict';

const { check, section } = require('./harness');
const {
  routeCapability,
  isAgreementPhrase,
  isRepeatWriteUtterance,
  applyRepeatWriteLifecycle,
  applyInvitationLifecycle,
  buildDeterministicAffirmativeText,
  shouldSkipAzureForRoute,
} = require('../services/keaCapabilityRouter');
const { bundleForCapability, allowedToolsFor } = require('../services/keaToolBundles');
const { frequencyLabel } = require('../utils/frequencyLabel');
const { __testables: T } = require('../controllers/openaiController');

function route(message, extra = {}) {
  return routeCapability({
    message,
    currentDate: extra.currentDate || '2026-08-16',
    simulationMode: extra.simulationMode === true,
    pendingWrite: extra.pendingWrite === true,
    pendingGoalWrite: extra.pendingGoalWrite === true,
    pendingDraft: extra.pendingDraft || extra.dialogueState && extra.dialogueState.draftTransaction || null,
    pendingGoalDraft: extra.pendingGoalDraft || null,
    userAffirmative: extra.userAffirmative != null ? extra.userAffirmative : T.isAffirmativeMessage(message),
    dialogueState: extra.dialogueState || T.emptyDialogueState(),
    accountId: extra.accountId || '10',
  });
}

function committedWrite(overrides = {}) {
  return {
    action: 'create',
    title: 'Test Expense',
    amount: -800,
    type: 'expense',
    start: '2026-08-21',
    frequency: 2,
    category: 'Test 3',
    ...overrides,
  };
}

function stateWithPriorWrite(overrides = {}) {
  const ds = T.emptyDialogueState();
  ds.lastCapability = 'affordability_or_planning';
  ds.recentWrites = [committedWrite(overrides)];
  ds.uiReferent = {
    kind: 'transaction',
    title: 'Miro Pest Control',
    amount: 80,
    category: 'Household',
    date: '2026-08-23',
  };
  return ds;
}

function baseDraft(overrides = {}) {
  return {
    title: 'Test Expense',
    amount: 800,
    type: 'expense',
    start: '2026-08-21',
    frequency: 2,
    category: 'Uncategorized',
    ...overrides,
  };
}

function writeCtx(draft, extras = {}) {
  const state = T.emptyDialogueState();
  state.draftTransaction = { ...draft };
  state.pendingConfirmation = true;
  return {
    userId: 5,
    token: 'trusted',
    accountId: 22,
    accountName: extras.accountName || 'Main Account',
    currentDate: '2026-08-16',
    dialogueState: state,
    pendingConfirmationAtStart: true,
    draftCompleteAtStart: true,
    userAffirmative: true,
    proposalInTranscript: false,
    categoryNames: extras.categoryNames || ['Uncategorized', 'Test 3', 'Electronics'],
    functionMap: extras.functionMap,
    queryAzureOpenAI: extras.queryAzureOpenAI,
    skipCacheInvalidate: true,
  };
}

function createCall(id, args) {
  return {
    id,
    function: { name: 'createTransaction', arguments: JSON.stringify(args || baseDraft()) },
  };
}

async function run() {
  section('Phase 2.9 agreement phrases');
  check('this is correct is affirmative', T.isAffirmativeMessage('This is correct') === true);
  check("that's correct is affirmative", T.isAffirmativeMessage("that's correct") === true);
  check('looks right is affirmative', T.isAffirmativeMessage('looks right') === true);
  check('looks correct is affirmative', T.isAffirmativeMessage('looks correct') === true);
  check('sounds right is affirmative', T.isAffirmativeMessage('sounds right') === true);
  check('this looks right is affirmative', T.isAffirmativeMessage('this looks right') === true);
  check('that looks right is affirmative', T.isAffirmativeMessage('that looks right') === true);
  check('looks good still affirmative', T.isAffirmativeMessage('looks good') === true);
  check('sounds good still affirmative', T.isAffirmativeMessage('sounds good') === true);
  check('this is correct is agreement phrase', isAgreementPhrase('This is correct') === true);
  check('looks right is agreement phrase', isAgreementPhrase('looks right') === true);
  check('add another one is not agreement', isAgreementPhrase('Please add another one') === false);

  section('Phase 2.9 agreement + pending proposal → confirmation');
  const pendingDraft = baseDraft();
  const phrases = [
    'this is correct',
    "that's correct",
    'looks right',
    'looks good',
    'sounds right',
    'sounds good',
  ];
  for (const phrase of phrases) {
    const r = route(phrase, {
      pendingWrite: true,
      dialogueState: { pendingConfirmation: true, draftTransaction: pendingDraft },
    });
    check(`pending + "${phrase}" → confirmation`, r.capability === 'confirmation');
  }

  section('Phase 2.9 agreement without proposal → unresolved, no UI tools');
  const miro = stateWithPriorWrite();
  miro.recentWrites = [];
  const unresolvedPhrases = ['This is correct', 'looks right', 'sounds good', "that's correct"];
  for (const phrase of unresolvedPhrases) {
    const r = route(phrase, { dialogueState: miro });
    check(`no proposal + "${phrase}" → unresolved`, r.capability === 'bare_affirmative_unresolved');
    check(`no proposal + "${phrase}" skips Azure`, shouldSkipAzureForRoute(r) === true);
    check(`no proposal + "${phrase}" empty tools`, bundleForCapability(r.capability).length === 0);
  }
  check(
    'unresolved agreement does not include focused-entity tools',
    !allowedToolsFor('bare_affirmative_unresolved').has('getFocusedEntityDetails')
  );
  const miroText = buildDeterministicAffirmativeText(
    route('This is correct', { dialogueState: miro }),
    miro
  );
  check('Miro agreement fail-safe copy', miroText === 'Sure — what would you like me to continue with?');
  check('Miro agreement does not mention Miro', !/Miro/i.test(miroText));

  section('Phase 2.9 repeat-write routing');
  check('add another one is repeat write', isRepeatWriteUtterance('Please add another one') === true);
  check('add another is repeat write', isRepeatWriteUtterance('add another') === true);
  check('add it again is repeat write', isRepeatWriteUtterance('add it again') === true);
  check('add that again is repeat write', isRepeatWriteUtterance('add that again') === true);
  check('create another one is repeat write', isRepeatWriteUtterance('create another one') === true);
  check('duplicate that expense is repeat write', isRepeatWriteUtterance('duplicate that expense') === true);
  check('add the expense anyway is repeat write', isRepeatWriteUtterance('Please add the expense anyway') === true);
  check('yes is not repeat write', isRepeatWriteUtterance('Yes') === false);
  check('this is correct is not repeat write', isRepeatWriteUtterance('This is correct') === false);

  const prior = stateWithPriorWrite();
  const addAnother = route('Please add another one', { dialogueState: prior });
  check('add another one is transaction_write', addAnother.capability === 'transaction_write');
  check('add another one is not unknown', addAnother.capability !== 'unknown');
  check('add another one is not confirmation', addAnother.capability !== 'confirmation');
  check('add another one is repeat handoff', addAnother.repeatWriteHandoff === true);
  check('add another one skips Azure', shouldSkipAzureForRoute(addAnother) === true);
  applyRepeatWriteLifecycle(prior, addAnother);
  check('repeat draft pending', prior.pendingConfirmation === true);
  check('repeat draft proposable', T.isDraftProposable(prior.draftTransaction) === true);
  check('repeat draft title from committed write', prior.draftTransaction.title === 'Test Expense');
  check('repeat draft category from committed write', prior.draftTransaction.category === 'Test 3');
  check('repeat draft amount unsigned', prior.draftTransaction.amount === 800);
  check('repeat draft date', prior.draftTransaction.start === '2026-08-21');
  check('repeat draft frequency Once', Number(prior.draftTransaction.frequency) === 2);
  const repeatText = buildDeterministicAffirmativeText(addAnother, prior, { accountName: 'Main Account' });
  check('repeat proposal names Test Expense', /another Test Expense/.test(repeatText));
  check('repeat proposal $800', /\$800/.test(repeatText));
  check('repeat proposal August 21', /August 21, 2026/.test(repeatText));
  check('repeat proposal One-time', /Frequency: One-time/.test(repeatText));
  check('repeat proposal Test 3', /Category: Test 3/.test(repeatText));
  check('repeat proposal Main Account', /Account: Main Account/.test(repeatText));
  check('repeat proposal second-transaction warning', /second transaction/.test(repeatText));
  check('repeat proposal asks Confirm?', /Confirm\?/.test(repeatText));
  check('repeat proposal invariant holds', prior.pendingConfirmation === true && T.isDraftProposable(prior.draftTransaction) === true);
  check(
    'repeat write omits focused-entity tools',
    !allowedToolsFor('transaction_write', { omitFocusedEntityTools: true }).has('getFocusedEntityDetails')
  );

  const yesAfterRepeat = route('Yes', {
    pendingWrite: true,
    dialogueState: prior,
  });
  check('yes after repeat proposal is confirmation', yesAfterRepeat.capability === 'confirmation');
  check('yes after repeat is not unresolved', yesAfterRepeat.capability !== 'bare_affirmative_unresolved');

  const noPrior = route('Please add another one', { dialogueState: T.emptyDialogueState() });
  check('add another one without committed write is not repeat handoff', noPrior.repeatWriteHandoff !== true);

  section('Phase 2.9 anyway + pending proposal is not silent confirm');
  const pendingAnywayDs = T.emptyDialogueState();
  pendingAnywayDs.pendingConfirmation = true;
  pendingAnywayDs.draftTransaction = baseDraft();
  pendingAnywayDs.recentWrites = [committedWrite({ category: 'Uncategorized' })];
  const anywayPending = route('Please add the expense anyway', {
    pendingWrite: true,
    dialogueState: pendingAnywayDs,
  });
  check('anyway with prior write is new write intent', anywayPending.capability === 'transaction_write');
  check('anyway is not confirmation', anywayPending.capability !== 'confirmation');

  section('Phase 2.9 proposal/state invariant');
  const unstaged = T.emptyDialogueState();
  const invented = 'I can add Test Expense:\n- Amount: $800\n- Frequency: One-time\n- Category: Household\nplease confirm this exact transaction.';
  check('unstaged confirm prose is detected', T.looksLikeConcreteWriteProposal(invented) === true);
  check(
    'unstaged confirm prose is replaced',
    T.enforceProposalStateInvariant(invented, unstaged) === 'Sure — what would you like me to continue with?'
  );
  const staged = T.emptyDialogueState();
  staged.pendingConfirmation = true;
  staged.draftTransaction = baseDraft();
  check(
    'staged confirm prose is kept',
    T.enforceProposalStateInvariant(repeatText, staged) === repeatText
  );
  const affordInvite = 'Would you like me to add this $800 expense on August 21?';
  check('affordability invitation is not treated as staged proposal prose', T.looksLikeConcreteWriteProposal(affordInvite) === false);
  check('unknown bundle still has no updateDraftTransaction', !bundleForCapability('unknown').includes('updateDraftTransaction'));
  check('unknown bundle still has no createTransaction', !bundleForCapability('unknown').includes('createTransaction'));

  section('Phase 2.9 cross-turn create is allowed (category/frequency)');
  const messages = [{ role: 'user', content: 'Yes' }];
  let createCount = 0;
  const mockCreate = async (args) => {
    createCount += 1;
    return {
      success: true,
      action: 'create',
      transaction_id: 200 + createCount,
      group_id: null,
      title: args.title,
      amount: -Math.abs(Number(args.amount)),
      type: args.type,
      category: args.category,
      start: args.start,
      frequency: Number(args.frequency),
      frequency_label: frequencyLabel(args.frequency),
    };
  };

  createCount = 0;
  const ctxCat = writeCtx(baseDraft({ category: 'Uncategorized' }), {
    functionMap: { createTransaction: mockCreate },
    queryAzureOpenAI: async () => ({ choices: [{ message: { content: 'already been added' } }] }),
  });
  ctxCat.dialogueState.lastCommitSignature = T.draftSignature(baseDraft({ category: 'Test 3' }));
  ctxCat.dialogueState.recentWrites = [committedWrite({ category: 'Test 3' })];
  const catResult = await T.executeToolCalls(messages, [createCall('c-cat', baseDraft({ category: 'Uncategorized' }))], ctxCat);
  check('different category still creates', createCount === 1);
  check('different category receipt is Uncategorized', /Uncategorized/.test(catResult.content) && !/Test 3/.test(catResult.content));

  createCount = 0;
  const ctxFreq = writeCtx(baseDraft({ frequency: 7, category: 'Uncategorized' }), {
    functionMap: { createTransaction: mockCreate },
    queryAzureOpenAI: async () => ({ choices: [{ message: { content: 'already been added' } }] }),
  });
  ctxFreq.dialogueState.lastCommitSignature = T.draftSignature(baseDraft({ frequency: 2 }));
  const freqResult = await T.executeToolCalls(messages, [createCall('c-freq', baseDraft({ frequency: 7, category: 'Uncategorized' }))], ctxFreq);
  check('different frequency still creates', createCount === 1);
  check('different frequency receipt is Weekly', /Frequency: Weekly/.test(freqResult.content));

  createCount = 0;
  const ctxSecond = writeCtx(baseDraft({ category: 'Uncategorized' }), {
    functionMap: { createTransaction: mockCreate },
    queryAzureOpenAI: async () => ({ choices: [{ message: { content: 'already been added' } }] }),
  });
  ctxSecond.dialogueState.lastCommitSignature = T.draftSignature(baseDraft({ category: 'Uncategorized' }));
  ctxSecond.dialogueState.recentWrites = [committedWrite({ category: 'Uncategorized' })];
  const second = await T.executeToolCalls(messages, [createCall('c-second', baseDraft({ category: 'Uncategorized' }))], ctxSecond);
  check('intentional identical second create is allowed', createCount === 1);
  check('intentional second is deterministic_commit', second.writeResponseMode === 'deterministic_commit');
  check('intentional second receipt Uncategorized', /Uncategorized/.test(second.content));

  section('Phase 2.9 Phase 2.6 invitation regression');
  const inviteDs = T.emptyDialogueState();
  inviteDs.pendingInvitation = {
    kind: 'add_affordability_expense',
    amount: 800,
    date: '2026-08-21',
    accountId: '10',
    status: 'referent_asked',
  };
  const titleAsk = route('Yes.', { dialogueState: inviteDs });
  applyInvitationLifecycle(inviteDs, titleAsk, { accountId: '10', categoryNames: ['Uncategorized', 'Test 3'] });
  check('invitation yes is still title-ask', titleAsk.affirmativeResolution === 'invitation_title_ask');
  check('invitation yes still skips Azure', shouldSkipAzureForRoute(titleAsk) === true);
}

module.exports = { run };
