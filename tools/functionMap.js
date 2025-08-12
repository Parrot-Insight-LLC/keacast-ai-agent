// tools/functionMap.js
const { getAccountsByUserId } = require('../services/accounts.service');
const {
  getTransactionsByUserAndAccount,
  getRecurringForecastsByAccount,
  getUpcomingByAccountAndRange,
} = require('../services/transactions.service');

// Each tool gets (args, ctx), where ctx can include userId, auth, etc.
const functionMap = {
  async getUserAccounts(args, ctx) {
    // auth/ownership checks can go here: ensure ctx.userId === args.userId or allowed
    return getAccountsByUserId(args.userId);
  },

  async getUserTransactions(args, ctx) {
    const { userId, accountId, startDate, endDate } = args;
    return getTransactionsByUserAndAccount(userId, accountId, { startDate, endDate });
  },

  async getRecurringForecasts(args, ctx) {
    const { accountId } = args;
    return getRecurringForecastsByAccount(accountId);
  },

  async getUpcomingTransactions(args, ctx) {
    const { accountId, startDate, endDate, forecastType='F' } = args;
    return getUpcomingByAccountAndRange(accountId, startDate, endDate, forecastType);
  },

  // Add more: categories, shopping list, account details, etc.
};

module.exports = { functionMap };
