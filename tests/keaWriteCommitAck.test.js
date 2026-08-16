'use strict';

const { check, section } = require('./harness');
const { __testables: T } = require('../controllers/openaiController');
const { frequencyLabel } = require('../utils/frequencyLabel');

const FORBIDDEN_ONCE = [
  'weekly',
  'every week',
  'recurring',
  'safe',
  'comfortable',
  'affordable',
  'positive forecast',
  'already been added',
];

function containsForbidden(text, words) {
  const lower = String(text || '').toLowerCase();
  return words.filter((w) => lower.includes(w.toLowerCase()));
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
    categoryNames: extras.categoryNames || ['Uncategorized', 'Electronics'],
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
  section('Phase 2.8 frequency display mapping');
  const mapping = [
    [2, 'one-time', 'One-time'],
    [1, 'daily', 'Daily'],
    [7, 'weekly', 'Weekly'],
    [14, 'bi-weekly', 'Bi-Weekly'],
    [30, 'monthly', 'Monthly'],
    [91, 'quarterly', 'Quarterly'],
    [365, 'annually', 'Annually'],
  ];
  for (const [code, raw, display] of mapping) {
    check(`frequencyLabel(${code})`, frequencyLabel(code) === raw);
    check(`frequencyDisplayLabel(${code})`, T.frequencyDisplayLabel(code) === display);
  }

  section('Phase 2.8 date/amount formatting');
  check('UTC midnight ISO stays August 21', T.formatCommitDate('2026-08-21T00:00:00.000Z') === 'August 21, 2026');
  check('date-only start stays August 21', T.formatCommitDate('2026-08-21') === 'August 21, 2026');
  check('expense amount is unsigned $800', T.formatCommitAmount(-800) === '$800');
  check('positive amount is $800', T.formatCommitAmount(800) === '$800');

  section('Phase 2.8 proposal-vs-commit consistency');
  const expected = baseDraft();
  const committed = {
    title: 'Test Expense',
    type: 'expense',
    amount: -800,
    start: '2026-08-21T00:00:00.000Z',
    frequency: 2,
    category: 'Uncategorized',
  };
  check('matching commit is ok', T.commitMatchesExpected(committed, expected).ok === true);
  check('title mismatch detected', T.commitMatchesExpected({ ...committed, title: 'Other' }, expected).mismatched.includes('title'));
  check('frequency mismatch detected', T.commitMatchesExpected({ ...committed, frequency: 7 }, expected).mismatched.includes('frequency'));
  check('category mismatch detected', T.commitMatchesExpected({ ...committed, category: 'Dining' }, expected).mismatched.includes('category'));

  section('Phase 2.8 deterministic Once acknowledgment copy');
  const onceWrite = {
    action: 'create',
    title: 'Test Expense',
    amount: -800,
    type: 'expense',
    start: '2026-08-21T00:00:00.000Z',
    frequency: 2,
    category: 'Uncategorized',
  };
  const onceAck = T.buildCreateAckLines(onceWrite, { accountName: 'Main Account' });
  check('Once ack has title', /Test Expense/.test(onceAck));
  check('Once ack has $800', /\$800/.test(onceAck));
  check('Once ack has August 21, 2026', /August 21, 2026/.test(onceAck));
  check('Once ack has One-time', /Frequency: One-time/.test(onceAck));
  check('Once ack has Uncategorized', /Category: Uncategorized/.test(onceAck));
  check('Once ack has Main Account', /Account: Main Account/.test(onceAck));
  check('Once ack has no forbidden wording', containsForbidden(onceAck, FORBIDDEN_ONCE).length === 0);

  const weeklyAck = T.buildCreateAckLines({
    ...onceWrite,
    title: 'Gym Membership',
    amount: -50,
    frequency: 7,
    category: 'Health',
  }, { accountName: 'Main Account' });
  check('Weekly ack has Weekly', /Frequency: Weekly/.test(weeklyAck));
  check('Weekly ack does not say One-time', !/One-time/.test(weeklyAck));
  check('Weekly ack uses Start date', /Start date: August 21, 2026/.test(weeklyAck));

  const electronicsAck = T.buildCreateAckLines({
    ...onceWrite,
    category: 'Electronics',
  });
  check('Electronics category preserved', /Category: Electronics/.test(electronicsAck));

  const mismatchAck = T.resolvePostCreateAck({
    createMeta: [{ write: { ...onceWrite, title: 'Other' }, expected: baseDraft() }],
    sawCreateDuplicate: false,
    recentWrites: [],
    accountName: 'Main Account',
  });
  check('mismatch does not claim Added Other', mismatchAck && !/^Added Other/.test(mismatchAck.content));
  check('mismatch is still deterministic', mismatchAck && mismatchAck.mode === 'deterministic_commit');
  check('mismatch does not invent weekly', mismatchAck && !/weekly/i.test(mismatchAck.content));

  const dupAck = T.resolvePostCreateAck({
    createMeta: [],
    sawCreateDuplicate: true,
    accountName: 'Main Account',
  });
  check('duplicate mode', dupAck && dupAck.mode === 'duplicate_commit');
  check('duplicate copy is not already-been-added', dupAck && !/already been added/i.test(dupAck.content));
  check('duplicate copy names in-turn protection', dupAck && /already created/.test(dupAck.content) && /duplicate/.test(dupAck.content));
  check('duplicate without this-turn write does not restate old recentWrites', dupAck && !/Test 3/.test(dupAck.content) && !/Uncategorized/.test(dupAck.content));

  const currentOpDup = T.resolvePostCreateAck({
    createMeta: [{ write: onceWrite, expected: baseDraft() }],
    sawCreateDuplicate: true,
    accountName: 'Main Account',
  });
  check('same-op duplicate uses current write category', currentOpDup && /Uncategorized/.test(currentOpDup.content));
  check('same-op duplicate does not use older Test 3', currentOpDup && !/Test 3/.test(currentOpDup.content));
  check('same-op duplicate restates One-time', currentOpDup && /One-time/.test(currentOpDup.content));

  section('Phase 2.8 executeToolCalls skips post-create Azure narration');
  const messages = [{ role: 'user', content: 'Yes' }];
  let azureCalls = 0;
  let createCount = 0;
  let lastCreateArgs = null;
  const mockCreate = async (args) => {
    createCount += 1;
    lastCreateArgs = args;
    return {
      success: true,
      action: 'create',
      transaction_id: 101,
      group_id: null,
      title: args.title,
      amount: -Math.abs(Number(args.amount)),
      type: args.type,
      category: args.category,
      start: '2026-08-21T00:00:00.000Z',
      frequency: Number(args.frequency),
      frequency_label: frequencyLabel(args.frequency),
      message: 'Transaction has been successfully created.',
    };
  };
  const ctxOnce = writeCtx(baseDraft(), {
    functionMap: { createTransaction: mockCreate },
    queryAzureOpenAI: async () => {
      azureCalls += 1;
      return { choices: [{ message: { content: 'The recurring Test Expense of $800 every week has already been added.' } }] };
    },
  });
  const resultOnce = await T.executeToolCalls(messages, [createCall('c1')], ctxOnce);
  check('exactly one create', createCount === 1);
  check('create args frequency is 2', Number(lastCreateArgs && lastCreateArgs.frequency) === 2);
  check('effective create frequency from ack', /Frequency: One-time/.test(resultOnce.content));
  check('no post-create Azure narration', azureCalls === 0);
  check('writeResponseMode deterministic_commit', resultOnce.writeResponseMode === 'deterministic_commit');
  check('one committed write', resultOnce.writes.length === 1 && resultOnce.writes[0].action === 'create');
  check('Once ack values', /Test Expense/.test(resultOnce.content)
    && /\$800/.test(resultOnce.content)
    && /August 21, 2026/.test(resultOnce.content)
    && /Uncategorized/.test(resultOnce.content));
  check('Once ack forbids Azure wording', containsForbidden(resultOnce.content, FORBIDDEN_ONCE).length === 0);
  check('does not use tool-results nudge', !/Using the tool results above/.test(resultOnce.content));
  check('pendingConfirmation cleared', ctxOnce.dialogueState.pendingConfirmation === false);
  check('draft cleared', Object.keys(ctxOnce.dialogueState.draftTransaction || {}).length === 0);
  check('lastCommitSignature kept', !!ctxOnce.dialogueState.lastCommitSignature);

  azureCalls = 0;
  createCount = 0;
  const ctxWeekly = writeCtx(baseDraft({ title: 'Gym Membership', amount: 50, frequency: 7, category: 'Electronics' }), {
    functionMap: { createTransaction: mockCreate },
    queryAzureOpenAI: async () => { azureCalls += 1; return { choices: [{ message: { content: 'One-time' } }] }; },
  });
  const resultWeekly = await T.executeToolCalls(messages, [createCall('w1', baseDraft({ title: 'Gym Membership', amount: 50, frequency: 7, category: 'Electronics' }))], ctxWeekly);
  check('Weekly ack Frequency Weekly', /Frequency: Weekly/.test(resultWeekly.content));
  check('Weekly create args frequency is 7', Number(lastCreateArgs && lastCreateArgs.frequency) === 7);
  check('Weekly ack not One-time', !/One-time/.test(resultWeekly.content));
  check('Weekly category Electronics', /Category: Electronics/.test(resultWeekly.content));
  check('Weekly skips Azure', azureCalls === 0);

  azureCalls = 0;
  createCount = 0;
  const ctxDupBatch = writeCtx(baseDraft(), {
    functionMap: { createTransaction: mockCreate },
    queryAzureOpenAI: async () => { azureCalls += 1; return { choices: [{ message: { content: 'already been added weekly' } }] }; },
  });
  const dupBatch = await T.executeToolCalls(messages, [createCall('d1'), createCall('d2')], ctxDupBatch);
  check('same-turn second create does not POST again', createCount === 1);
  check('same-turn duplicate uses current operation', /Test Expense/.test(dupBatch.content) && /Uncategorized/.test(dupBatch.content));
  check('same-turn duplicate is not Test 3', !/Test 3/.test(dupBatch.content));
  check('same-turn duplicate mode', dupBatch.writeResponseMode === 'duplicate_commit');
  check('same-turn duplicate skips Azure', azureCalls === 0);
  check('same-turn duplicate clears pending', ctxDupBatch.dialogueState.pendingConfirmation === false);
  check('same-turn duplicate clears draft', Object.keys(ctxDupBatch.dialogueState.draftTransaction || {}).length === 0);

  azureCalls = 0;
  createCount = 0;
  const ctxReplay = writeCtx(baseDraft(), {
    functionMap: { createTransaction: mockCreate },
    queryAzureOpenAI: async () => { azureCalls += 1; return { choices: [{ message: { content: 'already been added' } }] }; },
  });
  ctxReplay.dialogueState.lastCommitSignature = T.draftSignature(baseDraft());
  ctxReplay.dialogueState.recentWrites = [{
    action: 'create',
    title: 'Test Expense',
    amount: -800,
    start: '2026-08-21',
    frequency: 2,
    category: 'Test 3',
  }];
  const replay = await T.executeToolCalls(messages, [createCall('r1')], ctxReplay);
  check('cross-turn Redis signature does not block create', createCount === 1);
  check('cross-turn Redis signature is deterministic_commit', replay.writeResponseMode === 'deterministic_commit');
  check('cross-turn create uses current Uncategorized', /Uncategorized/.test(replay.content) && !/Test 3/.test(replay.content));
  check('cross-turn Redis signature skips Azure', azureCalls === 0);

  azureCalls = 0;
  createCount = 0;
  const ctxFail = writeCtx(baseDraft(), {
    functionMap: {
      createTransaction: async () => {
        createCount += 1;
        throw new Error('backend create failed');
      },
    },
    queryAzureOpenAI: async () => {
      azureCalls += 1;
      return { choices: [{ message: { content: 'I could not save that transaction.' } }] };
    },
  });
  const fail = await T.executeToolCalls(messages, [createCall('f1')], ctxFail);
  check('failed create still called tool', createCount === 1);
  check('failed create does not emit Added', !/^Added /.test(fail.content) && !/Added Test Expense/.test(fail.content));
  check('failed create still uses Azure to explain', azureCalls === 1);
  check('failed create writeResponseMode none', fail.writeResponseMode === 'none');

  section('Phase 2.8 second user yes after commit');
  const after = ctxOnce.dialogueState;
  const draftCompleteAfter = T.isDraftProposable(after.draftTransaction) && after.needsReconfirm !== true;
  check(
    'second yes is not write-allowed',
    T.isWriteAllowed(after.pendingConfirmation, draftCompleteAfter, true, false) === false
  );
  check('invitation absent after commit', after.pendingInvitation == null);
}

module.exports = { run };
