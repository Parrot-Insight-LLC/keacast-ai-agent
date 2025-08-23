// tools/functionMap.js
const { 
  getAccountsByUserId, 
  getAccountsByUserIdPaginated,
  getAccountsByUserIdCount 
} = require('../services/accounts.service');
const {
  getTransactionsByUserAndAccount,
  getTransactionsByUserAndAccountPaginated,
  getTransactionsByUserAndAccountCount,
  getRecurringForecastsByAccount,
  getRecurringForecastsByAccountPaginated,
  getRecurringForecastsByAccountCount,
  getUpcomingByAccountAndRange,
  getUpcomingByAccountAndRangePaginated,
  getUpcomingByAccountAndRangeCount,
  getTransactionSummary,
} = require('../services/transactions.service');
const { getSelectedKeacastAccounts, getBalances, createTransaction } = require('./keacast_tool_layer');

// Smart data loading strategy to prevent memory issues
const SMART_LIMITS = {
  transactions: 50,      // Load 50 transactions at a time
  forecasts: 25,         // Load 25 forecasts at a time
  upcoming: 30,          // Load 30 upcoming transactions at a time
  accounts: 20           // Load 20 accounts at a time
};

// Each tool gets (args, ctx), where ctx can include userId, auth, etc.
const functionMap = {
  async getUserAccounts(args, ctx) {
    // auth/ownership checks can go here: ensure ctx.userId === args.userId or allowed
    const { userId } = args;
    const page = args.page || 1;
    const limit = args.limit || SMART_LIMITS.accounts;
    
    try {
      // Try to get paginated results first
      const result = await getAccountsByUserIdPaginated(userId, page, limit);
      
      // If this is the first page and we have many accounts, suggest pagination
      if (page === 1 && result.pagination.total > limit) {
        return {
          ...result,
          message: `Retrieved ${result.accounts.length} of ${result.pagination.total} accounts. Use pagination for more accounts.`,
          pagination_info: result.pagination
        };
      }
      
      return result;
    } catch (error) {
      // Fallback to simple count if pagination fails
      if (error.message.includes('sort memory')) {
        const count = await getAccountsByUserIdCount(userId);
        return {
          accounts: [],
          message: `Database memory limit reached. Found ${count} accounts total. Please use smaller date ranges or contact support.`,
          total_count: count,
          error: 'Memory limit exceeded'
        };
      }
      throw error;
    }
  },

  async getUserAccountData(args, ctx) {
    const { userId, token, body } = args;
    const result = await getUserAccountData(userId, token, body);
    return result;
  },

  async getUserTransactions(args, ctx) {
    const { userId, accountId, startDate, endDate } = args;
    const page = args.page || 1;
    const limit = args.limit || SMART_LIMITS.transactions;
    
    try {
      // Try to get paginated results first
      const result = await getTransactionsByUserAndAccountPaginated(
        userId, accountId, 
        { startDate, endDate, page, limit }
      );
      
      // If this is the first page and we have many transactions, suggest pagination
      if (page === 1 && result.pagination.total > limit) {
        return {
          ...result,
          message: `Retrieved ${result.transactions.length} of ${result.pagination.total} transactions. Use pagination for more transactions.`,
          pagination_info: result.pagination
        };
      }
      
      return result;
    } catch (error) {
      // Fallback to summary if pagination fails
      if (error.message.includes('sort memory')) {
        const summary = await getTransactionSummary(userId, accountId, { startDate, endDate });
        return {
          transactions: [],
          message: `Database memory limit reached. Summary: ${summary.total_transactions} transactions found. Please use smaller date ranges.`,
          summary: summary,
          error: 'Memory limit exceeded'
        };
      }
      throw error;
    }
  },

  async getRecurringForecasts(args, ctx) {
    const { accountId } = args;
    const page = args.page || 1;
    const limit = args.limit || SMART_LIMITS.forecasts;
    
    try {
      // Try to get paginated results first
      const result = await getRecurringForecastsByAccountPaginated(accountId, page, limit);
      
      // If this is the first page and we have many forecasts, suggest pagination
      if (page === 1 && result.pagination.total > limit) {
        return {
          ...result,
          message: `Retrieved ${result.forecasts.length} of ${result.pagination.total} recurring forecasts. Use pagination for more forecasts.`,
          pagination_info: result.pagination
        };
      }
      
      return result;
    } catch (error) {
      // Fallback to count if pagination fails
      if (error.message.includes('sort memory')) {
        const count = await getRecurringForecastsByAccountCount(accountId);
        return {
          forecasts: [],
          message: `Database memory limit reached. Found ${count} recurring forecasts total. Please contact support.`,
          total_count: count,
          error: 'Memory limit exceeded'
        };
      }
      throw error;
    }
  },

  async getUpcomingTransactions(args, ctx) {
    const { accountId, startDate, endDate, forecastType='F' } = args;
    const page = args.page || 1;
    const limit = args.limit || SMART_LIMITS.upcoming;
    
    try {
      // Try to get paginated results first
      const result = await getUpcomingByAccountAndRangePaginated(
        accountId, startDate, endDate, forecastType, page, limit
      );
      
      // If this is the first page and we have many upcoming transactions, suggest pagination
      if (page === 1 && result.pagination.total > limit) {
        return {
          ...result,
          message: `Retrieved ${result.upcoming.length} of ${result.pagination.total} upcoming transactions. Use pagination for more transactions.`,
          pagination_info: result.pagination
        };
      }
      
      return result;
    } catch (error) {
      // Fallback to count if pagination fails
      if (error.message.includes('sort memory')) {
        const count = await getUpcomingByAccountAndRangeCount(accountId, startDate, endDate, forecastType);
        return {
          upcoming: [],
          message: `Database memory limit reached. Found ${count} upcoming transactions total. Please use smaller date ranges.`,
          total_count: count,
          error: 'Memory limit exceeded'
        };
      }
      throw error;
    }
  },

  // New function to get transaction summary without loading all data
  async getTransactionSummary(args, ctx) {
    const { userId, accountId, startDate, endDate } = args;
    
    try {
      const summary = await getTransactionSummary(userId, accountId, { startDate, endDate });
      return {
        summary,
        message: 'Transaction summary retrieved successfully without loading full data.',
        success: true
      };
    } catch (error) {
      return {
        summary: {},
        message: 'Failed to retrieve transaction summary.',
        error: error.message,
        success: false
      };
    }
  },

  // Add more: categories, shopping list, account details, etc.

  async getUserData(args, ctx) {
    const { userId, token } = args;
    const result = await getUserData({ userId, token });
    return result;
  },

  async getSelectedKeacastAccounts(args, ctx) {
    const { userId, token, body } = args;
    const result = await getSelectedKeacastAccounts({ userId, token, body });
    return result;
  },

  async getBalances(args, ctx) {
    const { accountId, userId, token, body } = args;
    const result = await getBalances({ accountId, userId, token, body });
    return result;
  },

  async createTransaction(args, ctx) {
    const { userId, token, accountId} = ctx;

    const result = await createTransaction({ userId, accountId, token, args });
    return result;
  }
};

module.exports = { functionMap };
