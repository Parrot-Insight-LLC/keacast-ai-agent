/**
 * test-kea-memory.js  (ad-hoc, no server / no secrets required)
 * ─────────────────────────────────────────────────────────────
 * Exercises the deterministic guardrail helpers behind the Kea Assistant
 * memory upgrade: dialogue-state slot-filling, the code-enforced write gate,
 * write idempotency (dedup), and the hard-capped context blocks. It replays
 * the "carpet replacement" scenario at the helper level and checks the key
 * failure modes (no confirmation → blocked; duplicate → deduped).
 *
 * Run:  node test-kea-memory.js
 *
 * NOTE: This validates the pure logic. End-to-end behavior (Azure tool loop,
 * Redis persistence, backend assistant_memory) still requires a live manual run
 * of the carpet scenario against a running agent.
 */

const { __testables: T } = require('./controllers/openaiController');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

console.log('\n🧪 Kea Assistant memory guardrails\n=================================');

// ── 1. Affirmative detection (drives the write gate) ────────────────────────
console.log('\n1) Affirmative detection');
['yes', 'yes please', 'go ahead', 'do it', 'confirm', 'sounds good', 'add it',
 'please add this forecast', 'create it', 'log it', 'okay', 'looks good']
  .forEach((m) => check(`affirmative: "${m}"`, T.isAffirmativeMessage(m) === true));
['how much does carpet cost?', 'maybe later', 'not yet', 'what about next month?', 'tell me more', '']
  .forEach((m) => check(`non-affirmative: "${m}"`, T.isAffirmativeMessage(m) === false));

// ── 2. Carpet scenario slot-filling ─────────────────────────────────────────
console.log('\n2) Carpet slot-filling');
const state = T.emptyDialogueState();
// Early: only a partial idea → missing core slots, nothing to inject yet beyond intent.
state.intent = 'carpet replacement';
state.draftTransaction = { title: 'Carpet replacement', type: 'expense' };
let missing = T.computeDraftMissingFields(state.draftTransaction);
check('partial draft is missing amount + start', missing.includes('amount') && missing.includes('start'));

// After proposing a concrete transaction (single amount + date) + pendingConfirmation.
state.draftTransaction = { title: 'Carpet replacement', type: 'expense', amount: 1600, start: '2026-08-01' };
state.pendingConfirmation = true;
missing = T.computeDraftMissingFields(state.draftTransaction);
check('complete draft has no missing core slots', missing.length === 0);
const block = T.buildDialogueStateBlock(state);
check('dialogue block mentions the intent', block.includes('carpet replacement'));
check('dialogue block shows awaiting confirmation', /awaiting transaction confirmation: yes/.test(block));
check('dialogue block within cap', block.length <= T.constants.DIALOGUE_STATE_MAX_CHARS);

// ── 3. Code-enforced write gate ─────────────────────────────────────────────
console.log('\n3) Write gate (propose on turn N, confirm on turn N+1)');
// Proposal turn: nothing pending / no complete draft yet, user just described intent.
check('block write when nothing pending or drafted', T.isWriteAllowed(false, false, T.isAffirmativeMessage('add a carpet forecast')) === false);
// Confirmation turn via explicit flag.
check('allow write when flag armed + affirmative', T.isWriteAllowed(true, false, T.isAffirmativeMessage('yes please')) === true);
// Confirmation turn armed by a COMPLETE draft staged earlier (fix #1).
check('allow write when draft complete + affirmative', T.isWriteAllowed(false, true, T.isAffirmativeMessage('this definitely works for me')) === true);
// Armed but the user did NOT confirm.
check('block write when armed but not affirmative', T.isWriteAllowed(false, true, T.isAffirmativeMessage('actually, maybe later')) === false);

// ── 3a. Goal write gate is independent of transaction draft ─────────────────
console.log('\n3a) Goal write gate (not armed by tx draft)');
const goalDraft = { title: 'Emergency fund', target_amount: 3000, end_date: '2026-12-01', frequency: '14' };
check('complete goal draft is proposable', T.isGoalDraftProposable(goalDraft) === true);
check('partial goal draft is not proposable', T.isGoalDraftProposable({ title: 'Emergency fund' }) === false);
check('goal write blocked when only tx draft is complete', T.isGoalWriteAllowed(false, false, true, false) === false);
check('goal write allowed when goal draft complete + affirmative', T.isGoalWriteAllowed(false, true, true, false) === true);
check('tx write still allowed with tx pending (goal flags irrelevant)', T.isWriteAllowed(true, false, true, false) === true);
const goalState = T.emptyDialogueState();
goalState.draftGoal = goalDraft;
goalState.pendingGoalConfirmation = true;
goalState.draftTransaction = { title: 'Carpet', type: 'expense', amount: 100, start: '2026-08-01' };
goalState.pendingConfirmation = false;
const goalBlock = T.buildDialogueStateBlock(goalState);
check('dialogue block shows awaiting goal confirmation', /awaiting goal confirmation: yes/.test(goalBlock));
check('dialogue block shows draft goal', /draft goal:/.test(goalBlock));
check('goal transcript detector matches goal propose', T.transcriptShowsPendingGoalProposal([
  { role: 'assistant', content: 'Shall I create a savings goal for $3000 by December? Confirm if that looks right.' }
]) === true);
check('tx transcript detector ignores pure goal propose', T.transcriptShowsPendingProposal([
  { role: 'assistant', content: 'Shall I create a savings goal for $3000 by December? Confirm if that looks right.' }
]) === false);

// ── 3b. Draft-authoritative merge prevents drift (fix #3) ───────────────────
console.log('\n3b) Draft-authoritative merge (no Nov -> Aug drift)');
const confirmedDraft = { title: 'Carpet replacement', type: 'expense', amount: 1600, category: 'Home Improvement', start: '2026-11-01' };
// Model re-estimates a drifted date/amount at create time; draft must win.
const drifted = { title: 'Carpet replacement', type: 'expense', amount: 1700, category: 'misc', start: '2026-08-01' };
const eff = T.applyDraftAndCategory(drifted, confirmedDraft, ['Home Improvement', 'Groceries', 'Income']);
check('confirmed start date wins over drifted args', eff.start === '2026-11-01');
check('confirmed amount wins over drifted args', Number(eff.amount) === 1600);
check('category snapped to a real user category', eff.category === 'Home Improvement');

// ── 3c. Category snapping ───────────────────────────────────────────────────
console.log('\n3c) Category snapping to user list');
const cats = ['Home Improvement', 'Groceries', 'Dining Out', 'Income'];
check('exact match (case-insensitive)', T.snapCategory('home improvement', cats) === 'Home Improvement');
check('loose contains match', T.snapCategory('improvement', cats) === 'Home Improvement');
check('no match returns null', T.snapCategory('cryptocurrency', cats) === null);
check('extractCategoryNames handles objects + strings',
  JSON.stringify(T.extractCategoryNames({ categories: [{ name: 'Groceries' }, 'Income', { category: 'Rent' }] })) === JSON.stringify(['Groceries', 'Income', 'Rent']));

// ── 3d. Draft proposable gate helper ────────────────────────────────────────
console.log('\n3d) isDraftProposable');
check('complete draft is proposable', T.isDraftProposable(confirmedDraft) === true);
check('partial draft is not proposable', T.isDraftProposable({ title: 'Carpet', type: 'expense' }) === false);
check('empty draft is not proposable', T.isDraftProposable({}) === false);

// ── 4. Idempotency / dedup ──────────────────────────────────────────────────
console.log('\n4) Write dedup via signature');
const createArgs = { title: 'Carpet replacement', type: 'expense', amount: 1600, start: '2026-08-01T12:00:00Z' };
const sigA = T.draftSignature(createArgs);
const sigB = T.draftSignature({ ...createArgs, start: '2026-08-01' }); // same day, diff format
check('signature is stable across date formats', sigA === sigB);
check('a re-called identical create is detected as duplicate', sigA === sigB && sigA === T.draftSignature(createArgs));
const sigDiff = T.draftSignature({ ...createArgs, amount: 1700 });
check('a different amount yields a different signature', sigDiff !== sigA);

// ── 5. Context blocks are hard-capped ───────────────────────────────────────
console.log('\n5) Context block caps');
const bigFacts = Array.from({ length: 200 }, (_, i) => ({ mem_key: `k${i}`, mem_value: 'x'.repeat(50) }));
const factsBlock = T.buildFactsBlock(bigFacts);
check('facts block within cap', factsBlock.length <= T.constants.FACTS_MAX_CHARS);
check('empty facts → empty block', T.buildFactsBlock([]) === '');
const summaryBlock = T.buildSummaryBlock('y'.repeat(5000));
check('summary block within cap', summaryBlock.length <= T.constants.SUMMARY_MAX_CHARS);
check('empty summary → empty block', T.buildSummaryBlock('') === '');

// ── 6. Log redaction ────────────────────────────────────────────────────────
console.log('\n6) Log redaction');
const redacted = T.redactChatBodyForLog({ token: 'super-secret-jwt', message: 'private financial details', sessionId: 42, accountid: 7 });
const asStr = JSON.stringify(redacted);
check('redacted log omits the raw token', !asStr.includes('super-secret-jwt') && redacted.hasToken === true);
check('redacted log omits the raw message', !asStr.includes('private financial details') && redacted.messageLength > 0);

// ── 7. Tool schema filtering (simulation / goals) ───────────────────────────
console.log('\n7) filterFunctionSchemas');
const { filterFunctionSchemas, functionSchemas } = require('./services/openaiService');
const names = (list) => new Set(list.map((t) => t?.function?.name).filter(Boolean));
const simFiltered = names(filterFunctionSchemas(functionSchemas, { simulationMode: true, goalsAvailable: true, simulationAvailable: true }));
check('sim mode omits createTransaction', !simFiltered.has('createTransaction'));
check('sim mode omits createGoal', !simFiltered.has('createGoal'));
check('sim mode keeps proposeSimulationAdd', simFiltered.has('proposeSimulationAdd'));
check('sim mode keeps getGoals', simFiltered.has('getGoals'));
const noGoals = names(filterFunctionSchemas(functionSchemas, { simulationMode: false, goalsAvailable: false, simulationAvailable: true }));
check('goals unavailable omits createGoal', !noGoals.has('createGoal'));
check('goals unavailable omits updateDraftGoal', !noGoals.has('updateDraftGoal'));
check('goals unavailable keeps createTransaction', noGoals.has('createTransaction'));
check('goals unavailable keeps previewGoalCadence', noGoals.has('previewGoalCadence'));
const noSim = names(filterFunctionSchemas(functionSchemas, { simulationMode: false, goalsAvailable: true, simulationAvailable: false }));
check('sim unavailable omits proposeSimulationAdd', !noSim.has('proposeSimulationAdd'));
check('sim unavailable keeps createTransaction', noSim.has('createTransaction'));

// ── 8. Compact tool outcomes block ──────────────────────────────────────────
console.log('\n8) recentToolOutcomes');
const outcomeState = T.emptyDialogueState();
T.recordRecentToolOutcome(outcomeState, T.compactToolOutcome('getUpcomingTransactions', JSON.stringify({
  transactions: [{ title: 'Rent', amount: 1200 }],
  transaction_id: 99,
  title: 'Rent',
  amount: 1200,
})));
const outcomesBlock = T.buildRecentToolOutcomesBlock(outcomeState);
check('tool outcomes block mentions tool name', outcomesBlock.includes('getUpcomingTransactions'));
check('tool outcomes block mentions title', outcomesBlock.includes('Rent'));

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n=================================\nPassed: ${passed}  Failed: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
