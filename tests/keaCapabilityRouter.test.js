'use strict';

const { check, section } = require('./harness');
const {
  routeCapability,
  applyContinuationPersistence,
  shouldPersistContinuation,
  parsePeriod,
  isWriteAmendmentOrSlotFill,
} = require('../services/keaCapabilityRouter');
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
    userAffirmative: extra.userAffirmative === true,
    dialogueState: extra.dialogueState || T.emptyDialogueState(),
    accountId: extra.accountId || '10',
  });
}

async function run() {
  section('capability routing — product / casual / lookup / forecast / afford');

  check(
    'What is reconciliation? → product_help',
    route('What is reconciliation?').capability === 'product_help'
  );
  check(
    'Hi Kea → casual_conversation',
    route('Hi Kea').capability === 'casual_conversation'
  );
  const balance = route("What's my account balance?");
  check('balance question → financial_lookup', balance.capability === 'financial_lookup');
  check('balance subject is account', balance.slots.subjectKind === 'account');

  const walmart = route('How much did I spend at Walmart last month?');
  check('Walmart last month → financial_lookup', walmart.capability === 'financial_lookup');
  check('Walmart subject merchant', walmart.slots.subjectKind === 'merchant');
  check('Walmart period last_month', walmart.slots.period && walmart.slots.period.label === 'last_month');
  check(
    'last month bounds July 2026',
    walmart.slots.period.start === '2026-07-01' && walmart.slots.period.end === '2026-07-31'
  );

  const restaurants = route('How much did I spend at restaurants last month?');
  check(
    'restaurants last month → financial_lookup',
    restaurants.capability === 'financial_lookup'
  );

  const neg = route('Will I go negative next month?');
  check('future-negative → cashflow_analysis', neg.capability === 'cashflow_analysis');
  check('future-negative period next_month', neg.slots.period && neg.slots.period.label === 'next_month');

  const afford = route('Can I afford $800 next month?');
  check('affordability → affordability_or_planning', afford.capability === 'affordability_or_planning');
  check('affordability amount 800', afford.slots.amount === 800);
  check('affordability period next_month', afford.slots.period && afford.slots.period.label === 'next_month');

  section('capability routing — writes / confirmation / simulation');

  const pendingYes = route('yes', { pendingWrite: true, userAffirmative: T.isAffirmativeMessage('yes') });
  check('pending transaction + yes → confirmation', pendingYes.capability === 'confirmation');
  check('pending + yes is not casual', pendingYes.capability !== 'casual_conversation');
  check('pending + yes is not unknown', pendingYes.capability !== 'unknown');
  check('sounds good confirms', route('sounds good', {
    pendingWrite: true,
    userAffirmative: T.isAffirmativeMessage('sounds good'),
  }).capability === 'confirmation');

  const pendingGoalYes = route('yes', {
    pendingGoalWrite: true,
    userAffirmative: T.isAffirmativeMessage('yes'),
  });
  check('pending goal + yes → confirmation', pendingGoalYes.capability === 'confirmation');
  check('pending goal confirmation pendingType goal', pendingGoalYes.pendingType === 'goal');

  const amend = route('make it $50 on Saturday', { pendingWrite: true, userAffirmative: false });
  check('pending write + amendment → transaction_write', amend.capability === 'transaction_write');

  const simWrite = route('Add a $40 grocery forecast Friday', { simulationMode: true });
  check('simulation + real-write request → simulation', simWrite.capability === 'simulation');

  const simYes = route('yes', {
    simulationMode: true,
    pendingWrite: true,
    userAffirmative: T.isAffirmativeMessage('yes'),
  });
  check('simulation + pending yes still confirmation (gate/sim omit still apply)', simYes.capability === 'confirmation');

  section('capability routing — continuation');

  const priorAfford = {
    lastCapability: 'affordability_or_planning',
    lastSubjectKind: 'amount',
    lastSubjectValue: '800',
    lastPeriod: parsePeriod('next month', '2026-08-16'),
    lastPurchaseDate: '2026-08-21',
    lastAccountId: '10',
  };
  const contAmount = route('What about $1,200?', { dialogueState: priorAfford, accountId: '10' });
  check('What about $1,200? → continuation', contAmount.capability === 'continuation');
  check('inherits affordability', contAmount.parentCapability === 'affordability_or_planning');
  check('continuation_used', contAmount.continuationUsed === true);
  check('amount replaced with 1200', contAmount.slots.amount === 1200);
  check('period retained next_month', contAmount.slots.period && contAmount.slots.period.label === 'next_month');
  check('purchase date inherited', contAmount.slots.purchaseDate === '2026-08-21');

  const priorLookup = {
    lastCapability: 'financial_lookup',
    lastSubjectKind: 'category',
    lastSubjectValue: 'restaurants',
    lastPeriod: parsePeriod('last month', '2026-08-16'),
    lastAccountId: '10',
  };
  const contPeriod = route('What about this month?', { dialogueState: priorLookup, accountId: '10' });
  check('What about this month? → continuation', contPeriod.capability === 'continuation');
  check('inherits lookup', contPeriod.parentCapability === 'financial_lookup');
  check('subject retained restaurants', contPeriod.slots.subjectValue === 'restaurants');
  check('period replaced this_month', contPeriod.slots.period && contPeriod.slots.period.label === 'this_month');

  const switched = route('What about $1,200?', {
    dialogueState: { ...priorAfford, lastAccountId: '10' },
    accountId: '99',
  });
  check('account change disables ambiguous continuation', switched.capability !== 'continuation');
  check('accountChanged true', switched.accountChanged === true);

  const pendingBeatsCont = route('What about $1,200?', {
    pendingWrite: true,
    userAffirmative: false,
    dialogueState: priorAfford,
  });
  check('pending write does not own unrelated continuation', pendingBeatsCont.capability === 'continuation');

  section('continuation persistence rules');

  const state = T.emptyDialogueState();
  applyContinuationPersistence(state, afford, { accountId: '10', failSoft: false });
  check('persists lastCapability from affordability', state.lastCapability === 'affordability_or_planning');
  check('persists lastAccountId', state.lastAccountId === '10');
  check('does not persist on fail-soft', shouldPersistContinuation(afford, { failSoft: true }) === false);
  check(
    'does not persist confirmation',
    shouldPersistContinuation(pendingYes, { failSoft: false }) === false
  );
  check(
    'does not persist casual',
    shouldPersistContinuation(route('Hi Kea'), { failSoft: false }) === false
  );
  check(
    'does not persist product help',
    shouldPersistContinuation(route('What is reconciliation?'), { failSoft: false }) === false
  );

  const keep = { lastCapability: 'financial_lookup', lastSubjectValue: 'walmart' };
  applyContinuationPersistence(keep, route('thanks'), { accountId: '10' });
  check('thanks does not overwrite financial continuation', keep.lastCapability === 'financial_lookup');

  section('pending-write amendment vs topic switch');

  const pendingDraft = { title: 'Coffee', type: 'expense', amount: 8, start: '2026-08-20', category: 'Dining' };
  const p = (message, extra = {}) => route(message, {
    pendingWrite: true,
    userAffirmative: extra.userAffirmative === true,
    pendingDraft,
    ...extra,
  });

  check('make it $50 → transaction_write', p('make it $50').capability === 'transaction_write');
  check('change it to Friday → transaction_write', p('change it to Friday').capability === 'transaction_write');
  check('actually use Groceries → transaction_write', p('actually use Groceries').capability === 'transaction_write');
  check('make that monthly → transaction_write', p('make that monthly').capability === 'transaction_write');
  check('use Dining instead → transaction_write', p('use Dining instead').capability === 'transaction_write');
  check('change the amount → transaction_write', p('change the amount').capability === 'transaction_write');
  check('Walmart last month → financial_lookup', p('How much did I spend at Walmart last month?').capability === 'financial_lookup');
  check('available balance → financial_lookup', p("What's my available balance?").capability === 'financial_lookup');
  check("What's my balance? → financial_lookup", route("What's my balance?").capability === 'financial_lookup');
  check('how much available right now → financial_lookup', route('How much money is available right now?').capability === 'financial_lookup');
  check('reconciliation → product_help', p('What is reconciliation?').capability === 'product_help');
  check('Hi Kea → casual', p('Hi Kea').capability === 'casual_conversation');
  check('pending + yes → confirmation', p('yes', { userAffirmative: T.isAffirmativeMessage('yes') }).capability === 'confirmation');
  const yesAfterSwitch = p('yes', {
    userAffirmative: T.isAffirmativeMessage('yes'),
    dialogueState: { ...T.emptyDialogueState(), needsReconfirm: true, draftTransaction: pendingDraft },
  });
  check('pending + yes after needsReconfirm is not confirmation', yesAfterSwitch.capability !== 'confirmation');

  check('amendment helper true for make it $50', isWriteAmendmentOrSlotFill('make it $50', pendingDraft) === true);
  check('amendment helper false for Walmart', isWriteAmendmentOrSlotFill('How much did I spend at Walmart last month?', pendingDraft) === false);

  section('simulation vs product-help');
  check('What is Simulation Mode? → product_help', route('What is Simulation Mode?').capability === 'product_help');
  check('How does Simulation Mode work? → product_help', route('How does Simulation Mode work?').capability === 'product_help');
  check('What if I add a $500 expense next month? → simulation', route('What if I add a $500 expense next month?').capability === 'simulation');
  check('Simulate a $500 expense next month. → simulation', route('Simulate a $500 expense next month.').capability === 'simulation');

  section('current vs forecast balance');
  check('available balance lookup', route("What's my available balance?").capability === 'financial_lookup');
  check('will I go negative next month analysis', route('Will I go negative next month?').capability === 'cashflow_analysis');
  check('what will my balance be next month forecast', route('What will my balance be next month?').capability === 'financial_forecast');

  section('topic-switch needsReconfirm lifecycle');
  const ds = T.emptyDialogueState();
  ds.draftTransaction = { ...pendingDraft };
  ds.pendingConfirmation = true;
  const walmartRoute = p('How much did I spend at Walmart last month?');
  const topicSwitched = T.applyPendingWriteTopicSwitch(ds, walmartRoute, {
    pendingArmedAtStart: true,
    userAffirmative: false,
  });
  check('topic switch reason', topicSwitched.reason === 'topic_switch' && topicSwitched.switched === true);
  check('pendingConfirmation cleared', ds.pendingConfirmation === false);
  check('needsReconfirm set', ds.needsReconfirm === true);
  check('draft slots preserved', ds.draftTransaction.amount === 8 && ds.draftTransaction.title === 'Coffee');
  check(
    'generic yes not armed after topic switch',
    T.isWriteAllowed(false, T.isDraftProposable(ds.draftTransaction) && ds.needsReconfirm !== true, true, false) === false
  );
  ds.pendingConfirmation = true;
  ds.needsReconfirm = false;
  check(
    're-propose then yes is armed',
    T.isWriteAllowed(true, T.isDraftProposable(ds.draftTransaction) && ds.needsReconfirm !== true, true, false) === true
  );

  const gds = T.emptyDialogueState();
  gds.draftGoal = { title: 'Vacation', target_amount: 1000, end_date: '2026-12-01', frequency: '30' };
  gds.pendingGoalConfirmation = true;
  const goalLookup = route('How much did I spend at Walmart last month?', {
    pendingGoalWrite: true,
    userAffirmative: false,
  });
  const gSwitch = T.applyPendingWriteTopicSwitch(gds, goalLookup, {
    pendingArmedAtStart: true,
    userAffirmative: false,
  });
  check('goal topic switch', gSwitch.reason === 'topic_switch');
  check('goal draft preserved', gds.draftGoal.title === 'Vacation');
  check('goalNeedsReconfirm set', gds.goalNeedsReconfirm === true);
  check('goal pendingConfirmation cleared', gds.pendingGoalConfirmation === false);

  const gp = (message, extra = {}) => route(message, {
    pendingGoalWrite: true,
    userAffirmative: extra.userAffirmative === true,
    pendingGoalDraft: { title: 'Vacation', target_amount: 1000, end_date: '2026-12-01', frequency: '30' },
    ...extra,
  });
  check('goal make it $50 → goal_write', gp('make it $50').capability === 'goal_write');
  check('goal Walmart → financial_lookup', gp('How much did I spend at Walmart last month?').capability === 'financial_lookup');
  check('goal available balance → financial_lookup', gp("What's my available balance?").capability === 'financial_lookup');
  check('goal Hi Kea → casual', gp('Hi Kea').capability === 'casual_conversation');
  check('goal + yes → confirmation', gp('yes', { userAffirmative: T.isAffirmativeMessage('yes') }).capability === 'confirmation');
  check(
    'goal + yes after needsReconfirm is not confirmation',
    gp('yes', {
      userAffirmative: T.isAffirmativeMessage('yes'),
      dialogueState: { ...T.emptyDialogueState(), goalNeedsReconfirm: true },
    }).capability !== 'confirmation'
  );
}

module.exports = { run };
