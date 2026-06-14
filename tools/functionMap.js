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
  getTransactionSummary
} = require('../services/transactions.service');
const { getUserData, getSelectedKeacastAccounts, getSelectedAccount, getBalances, createTransaction, deleteTransaction } = require('./keacast_tool_layer');
const moment = require('moment');

// Smart data loading strategy to prevent memory issues
const SMART_LIMITS = {
  transactions: 50,      // Load 50 transactions at a time
  forecasts: 25,         // Load 25 forecasts at a time
  upcoming: 30,          // Load 30 upcoming transactions at a time
  accounts: 20           // Load 20 accounts at a time
};

const FREQUENCY_ONCE = 2;

// Build a complete, valid createTransaction payload from whatever sparse
// fields the LLM supplied. The chat schema only requires `amount` + `type`, so
// the user can say "add $1200 rent on the 1st every month" and we still produce
// a fully-formed record. Defaults here mirror the backend's own fallbacks
// (TransactionsController.createTransaction) so creation never 400s on a thin
// payload and the user doesn't have to spell out every field.
function normalizeCreateTransactionInput(args = {}, ctx = {}) {
  const out = { ...args };

  // Strip server-injected identity fields if the model hallucinated them —
  // userId/accountId come from ctx (the URL path), never the body.
  delete out.userId;
  delete out.accountId;

  // type: trust the model, else infer from the sign, else default to expense.
  const rawAmount = Number(out.amount);
  let type = String(out.type || '').toLowerCase();
  if (type !== 'income' && type !== 'expense') {
    type = Number.isFinite(rawAmount) && rawAmount > 0 ? 'income' : 'expense';
  }
  out.type = type;

  // amount: persist signed (negative = expense, positive = income) so the LLM
  // can pass a plain magnitude and we still match existing data conventions.
  if (Number.isFinite(rawAmount)) {
    out.amount = type === 'expense' ? -Math.abs(rawAmount) : Math.abs(rawAmount);
  }

  // frequency: default to a one-time entry unless recurrence was specified.
  let freq = Number(out.frequency);
  if (!Number.isFinite(freq) || freq <= 0) freq = FREQUENCY_ONCE;
  out.frequency = freq;

  // start: default to the user's localized "today" (ctx.currentDate), else now.
  const today = ctx.currentDate && moment(ctx.currentDate).isValid()
    ? moment(ctx.currentDate)
    : moment();
  const start = out.start && moment(out.start).isValid() ? moment(out.start) : today.clone();
  out.start = start.toISOString();

  // end: one-time => same day; recurring => provided end or a 1-year horizon so
  // the backend generates a sensible series instead of a single row.
  if (freq === FREQUENCY_ONCE) {
    out.end = start.toISOString();
  } else {
    const end = out.end && moment(out.end).isValid() ? moment(out.end) : start.clone().add(1, 'year');
    out.end = end.toISOString();
  }

  // Human-facing text + misc fields: fill from context with safe fallbacks.
  const fallbackTitle = String(out.merchant_name || out.category || (type === 'income' ? 'Income' : 'Expense'));
  if (!out.title || !String(out.title).trim()) out.title = fallbackTitle;
  if (!out.display_name || !String(out.display_name).trim()) out.display_name = out.title;
  if (!out.description || !String(out.description).trim()) out.description = out.title;
  if (!out.category || !String(out.category).trim()) out.category = type === 'income' ? 'Income' : 'Uncategorized';
  if (!out.time || !String(out.time).trim()) out.time = '12:00';
  if (out.location == null) out.location = '';
  if (!out.forecast_type) out.forecast_type = 'F';

  return out;
}

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

  async getSelectedAccount(args, ctx) {
    const { userId, accountId, token, body, timeoutMs } = args;
    const result = await getSelectedAccount({ userId, accountId, token, body, timeoutMs });
    return result;
  },

  async getBalances(args, ctx) {
    const { accountId, userId, token, body } = args;
    const result = await getBalances({ accountId, userId, token, body });
    return result;
  },

  async createTransaction(args, ctx) {
    const { userId, token, accountId } = ctx;
    const body = normalizeCreateTransactionInput(args, ctx);
    const result = await createTransaction({ userId, accountId, token, body });
    return result;
  },

  async deleteTransaction(args, ctx) {
    const { userId, transaction_id, token, body } = args;
    const { id } = ctx;
    const transactionId = id || transaction_id;
    const result = await deleteTransaction({ userId, transactionId, token, body });
    return result;
  }
};

module.exports = { functionMap };
