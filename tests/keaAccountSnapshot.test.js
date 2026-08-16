'use strict';

const { check, section } = require('./harness');
const {
  compactSelectedAccount,
  measurePayloadKeyBytes,
  utf8Bytes,
} = require('../services/keaAccountSnapshot');
const { __testables: T } = require('../controllers/openaiController');

function bulkyAccount() {
  const cfTransactions = [];
  for (let i = 0; i < 400; i += 1) {
    cfTransactions.push({
      transactionid: i,
      title: `Forecast ${i}`,
      amount: -12.34,
      start: '2026-01-01',
      logo: 'https://example.com/logo.png',
      category: 'Dining',
      description: 'x'.repeat(80),
    });
  }
  const plaidTransactions = [];
  for (let i = 0; i < 80; i += 1) {
    plaidTransactions.push({
      transaction_id: `p${i}`,
      name: `Merchant ${i}`,
      amount: -20,
      date: '2026-08-01',
      category: 'Dining',
      location: { city: 'Austin', region: 'TX', lat: 30, lon: -97 },
      personal_finance_category: { primary: 'FOOD', detailed: 'FOOD_AND_DRINK' },
    });
  }
  const forecasted = [];
  for (let i = 0; i < 200; i += 1) {
    forecasted.push({ date: '2026-09-01', amount: 100 + i, status: 'forecast' });
  }
  return {
    accountid: 22,
    accountname: 'Checking',
    bank_account_name: 'Checking',
    institution_name: 'Bank',
    account_type: 'depository',
    balance: 1500,
    available: 1400,
    credit_limit: 0,
    plaid_latest: '2026-08-15',
    access_token: 'secret-plaid-token',
    savings: {
      savingsPotential: 200,
      totalIncome: 3000,
      totalExpenses: 2500,
      netCashFlow: 500,
      savingsPercentage: 14,
    },
    upcomingExpenseTotal: 400,
    upcomingIncomeTotal: 2000,
    futureNegativeBalances: [
      { amount: -50, date: '2026-09-02', daysUntil: 'In 18 Days', extra: 'drop-me' },
    ],
    recents: [
      { merchant_name: 'Cafe', name: 'Cafe', amount: -12, date: '2026-08-14', category: 'Dining' },
      { merchant_name: 'Cafe', name: 'Cafe', amount: -8, date: '2026-08-13', category: 'Dining' },
      { merchant_name: 'Gas', name: 'Gas', amount: -40, date: '2026-08-12', category: 'Auto' },
    ],
    upcoming: [
      { name: 'Rent', amount: -1200, start: '2026-09-01', category: 'Housing' },
      { name: 'Paycheck', amount: 2000, start: '2026-08-20', category: 'Income' },
    ],
    categories: [{ name: 'Dining' }, { name: 'Auto' }, { name: 'Housing' }],
    goals: [{
      goalid: 9,
      title: 'Vacation',
      status: 'in_progress',
      target_amount: 1000,
      accumulated_amount: 400,
      end_date: '2026-12-01',
      contributions: [
        { start: '2026-01-01', amount: 100, status: 'Posted' },
        { start: '2026-08-01', amount: 100, status: 'Posted' },
        { start: '2027-01-01', amount: 100, status: 'Forecast' },
      ],
    }],
    cfTransactions,
    plaidTransactions,
    computedBalances: { posted: forecasted, forecasted },
    shopping_lists: [[{ list: [{ name: 'milk' }] }]],
    recurringTransactions: [{ items: cfTransactions.slice(0, 20) }],
    user: { firstname: 'Alex', email: 'hidden@example.com' },
  };
}

async function run() {
  section('keaAccountSnapshot compact');

  const full = bulkyAccount();
  const compact = compactSelectedAccount(full, '2026-08-15');
  const fullBytes = utf8Bytes(full);
  const compactBytes = utf8Bytes(compact);

  check('compact marked', compact._keaCompact === true);
  check('compact much smaller than full blob', compactBytes * 10 < fullBytes);
  check('omits cfTransactions', compact.cfTransactions === undefined);
  check('omits computedBalances', compact.computedBalances === undefined);
  check('omits access_token', compact.access_token === undefined);
  check('omits shopping_lists', compact.shopping_lists === undefined);
  check('omits plaidTransactions array', compact.plaidTransactions === undefined);
  check('keeps balance/available', compact.balance === 1500 && compact.available === 1400);
  check('keeps savings potential', compact.savings.savingsPotential === 200);
  check('recents capped at 10', compact.recents.length <= 10);
  check('upcoming capped at 10', compact.upcoming.length <= 10);
  check('negatives capped at 5', compact.futureNegativeBalances.length <= 5);
  check('category names preserved', compact.categories.some((c) => c.name === 'Dining'));
  check('goal expectedByNow precomputed', compact.goals[0].expectedByNow === 200);
  check('goal omits contribution rows', compact.goals[0].contributions === undefined);
  check('user firstname only', compact.user.firstname === 'Alex' && compact.user.email === undefined);
  check('already-compact is identity', compactSelectedAccount(compact, '2026-08-15') === compact);

  const hist = measurePayloadKeyBytes(full);
  check('histogram has cfTransactions bytes', typeof hist.cfTransactions === 'number' && hist.cfTransactions > 1000);
  check('histogram omits access_token', hist.access_token === undefined);
  check('histogram omits secret-like keys', Object.keys(hist).every((k) => !/token|password|secret|authorization/i.test(k)));
  check('histogram values are byte counts only', Object.values(hist).every((v) => typeof v === 'number' && Number.isFinite(v)));

  section('compact snapshot still feeds the chat brief');
  const cats = T.pickTopSpendingCategories(compact, 5);
  check('precomputed top categories used', cats.some((line) => line.includes('Dining')));
  const brief = T.buildChatAccountContext(compact, 'Alex', '2026-08-15');
  check('brief includes balance', brief.includes('balance $1500'));
  check('brief includes savings potential', brief.includes('$200'));
  check('brief includes upcoming totals', brief.includes('Next 14 days'));
  const goalsBlock = T.buildGoalsBlock(compact.goals, '2026-08-15');
  check('goals block uses compact expectedByNow', goalsBlock.includes('Vacation') && goalsBlock.includes('$400'));
}

module.exports = { run };
