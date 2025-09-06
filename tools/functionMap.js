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
const { getUserData, getSelectedKeacastAccounts, getBalances, createTransaction, deleteTransaction } = require('./keacast_tool_layer');

// Smart data loading strategy to prevent memory issues
const SMART_LIMITS = {
  transactions: 50,      // Load 50 transactions at a time
  forecasts: 25,         // Load 25 forecasts at a time
  upcoming: 30,          // Load 30 upcoming transactions at a time
  accounts: 20,          // Load 20 accounts at a time
  maxTransactions: 100,  // Maximum transactions to include in response
  maxDaysHistory: 90,    // Maximum days of historical data
  maxDaysFuture: 365     // Maximum days of future data
};

// Function to optimize account data size while preserving essential information
function optimizeAccountData(data) {
  if (!data || typeof data !== 'object') return data;
  
  const optimized = { ...data };
  
  // If data is an array (multiple accounts), optimize each account
  if (Array.isArray(data)) {
    return data.map(account => optimizeAccountData(account));
  }
  
  // Optimize transactions arrays
  if (optimized.cfTransactions && Array.isArray(optimized.cfTransactions)) {
    optimized.forecastedTransactions = optimizeTransactionArray(optimized.cfTransactions, 'cfTransactions');
  }
  
  if (optimized.plaidTransactions && Array.isArray(optimized.plaidTransactions)) {
    optimized.recentTransactions = optimizeTransactionArray(optimized.plaidTransactions, 'plaidTransactions');
  }
  
  if (optimized.upcoming && Array.isArray(optimized.upcoming)) {
    optimized.upcomingTransactions = optimizeTransactionArray(optimized.upcoming, 'upcoming');
  }
  
  if (optimized.recents && Array.isArray(optimized.recents)) {
    optimized.recents = [];
    // optimizeTransactionArray(optimized.recents, 'recents');
  }
  
  // Optimize balances array (keep last 6 months + next 12 months)
  if (optimized.balances && Array.isArray(optimized.balances)) {
    const now = new Date();
    const sixMonthsAgo = new Date(now.getTime() - (6 * 30 * 24 * 60 * 60 * 1000));
    const oneYearFromNow = new Date(now.getTime() + (365 * 24 * 60 * 60 * 1000));
    
    optimized.balances = [];
    // optimized.balances
    //   .filter(balance => {
    //     const balanceDate = new Date(balance.date);
    //     return balanceDate >= sixMonthsAgo && balanceDate <= oneYearFromNow;
    //   })
    //   .slice(0, 200) // Limit to 200 balance records max
    //   .map(balance => ({
    //     date: balance.date,
    //     amount: balance.amount,
    //     status: balance.status,
    //     // Remove less critical fields to save space
    //     ...(balance.type && { type: balance.type })
    //   }));
  }
  
  // Remove or limit other large arrays
  if (optimized.plaidRecurrings && Array.isArray(optimized.plaidRecurrings)) {
    optimized.potentialRecurringTransactions = optimized.plaidRecurrings.slice(0, 20); // Limit to 20 recurring patterns
  }
  
  return optimized;
}

// Function to optimize transaction arrays
function optimizeTransactionArray(transactions, arrayType) {
  if (!Array.isArray(transactions)) return transactions;
  
  const now = new Date();
  const maxHistoryDate = new Date(now.getTime() - (SMART_LIMITS.maxDaysHistory * 24 * 60 * 60 * 1000));
  const maxFutureDate = new Date(now.getTime() + (SMART_LIMITS.maxDaysFuture * 24 * 60 * 60 * 1000));
  
  return transactions
    .filter(transaction => {
      // Filter by date range if transaction has a date
      if (transaction.start) {
        const transactionDate = new Date(transaction.start);
        return transactionDate >= maxHistoryDate && transactionDate <= maxFutureDate;
      }
      if (transaction.date) {
        const transactionDate = new Date(transaction.date);
        return transactionDate >= maxHistoryDate && transactionDate <= maxFutureDate;
      }
      return true; // Keep transactions without dates
    })
    .slice(0, SMART_LIMITS.maxTransactions) // Limit total number
    .map(transaction => {
      // Keep only essential transaction fields
      const essential = {
        transactionid: transaction.transactionid || transaction.transaction_id || transaction.id,
        title: transaction.title || transaction.name,
        display_name: transaction.display_name,
        amount: transaction.adjusted_amount || transaction.amount,
        description: transaction.description,
        start: transaction.start || transaction.date,
        category: transaction.adjusted_category || transaction.category,
        status: transaction.status,
        forecast_type: transaction.forecast_type,
        frequency2: transaction.frequency2,
        merchant: transaction.merchant || transaction.merchant_name
      };
      
      // Remove undefined values to save space
      Object.keys(essential).forEach(key => {
        if (essential[key] === undefined || essential[key] === null) {
          delete essential[key];
        }
      });
      
      return essential;
    });
}

// Function to create an AI-friendly response structure
function createAIFriendlyResponse(data) {
  if (!data || typeof data !== 'object') return data;
  
  // Handle array of accounts
  if (Array.isArray(data)) {
    return data.map(account => createAIFriendlyResponse(account));
  }
  
  // Structure the response in a clear, AI-readable format
  const structured = {
    success: true,
    accountInfo: {
      accountId: data.accountid || data.id,
      accountName: data.accountname || data.name,
      accountType: data.account_type || data.type,
      institutionName: data.institution_name,
      bankAccountName: data.bankaccount_name || data.bank_account_name
    },
    currentBalances: {
      available: data.available || 0,
      current: data.current || data.balance || 0,
      creditLimit: data.credit_limit || 0,
      forecasted: data.forecasted || 0
    },
    transactionData: {
      forecastedTransactions: data.forecastedTransactions || data.cfTransactions || [],
      recentTransactions: data.recentTransactions || data.plaidTransactions || [],
      upcomingTransactions: data.upcomingTransactions || data.upcoming || [],
      totalForecastedCount: (data.forecastedTransactions || data.cfTransactions || []).length,
      totalRecentCount: (data.recentTransactions || data.plaidTransactions || []).length,
      totalUpcomingCount: (data.upcomingTransactions || data.upcoming || []).length
    },
    balanceHistory: data.balances || [],
    categories: data.categories || [],
    potentialRecurringTransactions: data.potentialRecurringTransactions || data.plaidRecurrings || [],
    metadata: {
      dataRetrievedAt: new Date().toISOString(),
      optimized: true,
      originalDataSize: data._originalSize || 'unknown'
    }
  };
  
  // Add summary statistics
  const allTransactions = [
    ...(structured.transactionData.forecastedTransactions || []),
    ...(structured.transactionData.recentTransactions || []),
    ...(structured.transactionData.upcomingTransactions || [])
  ];
  
  structured.summary = {
    totalTransactions: allTransactions.length,
    totalIncome: allTransactions.filter(t => (t.amount || 0) > 0).reduce((sum, t) => sum + (t.amount || 0), 0),
    totalExpenses: allTransactions.filter(t => (t.amount || 0) < 0).reduce((sum, t) => sum + Math.abs(t.amount || 0), 0),
    categoriesCount: (structured.categories || []).length,
    balanceRecordsCount: (structured.balanceHistory || []).length,
    recurringPatternsCount: (structured.potentialRecurringTransactions || []).length
  };
  
  return structured;
}

// Each tool gets (args, ctx), where ctx can include userId, auth, etc.
const functionMap = {
  async getUserAccounts(args, ctx) {
    // auth/ownership checks can go here: ensure ctx.userId === args.userId or allowed
    const { userId } = ctx;
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
    const { userId, token } = ctx;
    const { body } = args;
    const result = await getUserAccountData(userId, token, body);
    return result;
  },

  async getUserTransactions(args, ctx) {
    const { userId, accountId: contextAccountId } = ctx;
    const { accountId: argsAccountId, startDate, endDate } = args;
    const accountId = argsAccountId || contextAccountId;
    const page = args.page || 1;
    const limit = args.limit || SMART_LIMITS.transactions;
    
    console.log('getUserTransactions called with:', { 
      argsAccountId, 
      contextAccountId, 
      finalAccountId: accountId,
      userId,
      startDate,
      endDate 
    });
    
    if (!accountId) {
      console.log('getUserTransactions: No accountId available in args or context');
      return {
        transactions: [],
        error: 'Account ID is required but not provided in arguments or context',
        message: 'Please specify an accountId parameter or ensure it is available in the session context'
      };
    }
    
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
    const { accountId: contextAccountId } = ctx;
    const { accountId: argsAccountId } = args;
    const accountId = argsAccountId || contextAccountId;
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
    const { accountId: contextAccountId } = ctx;
    const { accountId: argsAccountId, startDate, endDate, forecastType='F' } = args;
    const accountId = argsAccountId || contextAccountId;
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
    const { userId, accountId: contextAccountId } = ctx;
    const { accountId: argsAccountId, startDate, endDate } = args;
    const accountId = argsAccountId || contextAccountId;
    
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
    const { userId, token } = ctx;
    const result = await getUserData({ userId, token });
    return result;
  },

  async getSelectedKeacastAccounts(args, ctx) {
    const { userId, token, accountId } = ctx;
    const { body } = args || {};
    
    // Get current date and calculate default date ranges
    const moment = require('moment');
    const currentDate = moment().format('YYYY-MM-DD');
    const upcomingEnd = moment().add(14, 'days').format('YYYY-MM-DD');
    const recentStart = moment().subtract(3, 'months').format('YYYY-MM-DD');
    const recentEnd = moment().add(1, 'days').format('YYYY-MM-DD');
    
    if (!accountId) {
      return {
        error: 'Account ID is required but not provided in context',
        message: 'Please ensure accountId is available in the session context'
      };
    }
    
    // Build the body with defaults if not provided
    const requestBody = {
      currentDate: body?.currentDate || currentDate,
      forecastType: body?.forecastType || 'F',
      recentStart: body?.recentStart || recentStart,
      recentEnd: body?.recentEnd || recentEnd,
      page: body?.page || 'layout',
      position: body?.position || 0,
      selectedAccounts: body?.selectedAccounts || [accountId],
      upcomingEnd: body?.upcomingEnd || upcomingEnd,
      user: body?.user || { id: userId }
    };
    
    console.log('getSelectedKeacastAccounts called with:', {
      originalBody: body,
      finalBody: requestBody,
      contextAccountId: accountId
    });
    
    try {
      const result = await getSelectedKeacastAccounts({ userId, token, body: requestBody });
      
      console.log('getSelectedKeacastAccounts API response received:', {
        hasData: !!result,
        isArray: Array.isArray(result),
        isObject: typeof result === 'object',
        keys: result && typeof result === 'object' ? Object.keys(result).slice(0, 10) : []
      });
      
      // Handle different response structures
      if (!result) {
        return {
          success: false,
          error: 'No data returned from API',
          accountInfo: null,
          transactionData: { forecastedTransactions: [], recentTransactions: [], upcomingTransactions: [] },
          summary: { totalTransactions: 0, totalIncome: 0, totalExpenses: 0 }
        };
      }
      
      // Apply smart data filtering to reduce size and structure for AI
      if (result && typeof result === 'object') {
        const optimizedResult = optimizeAccountData(result);
        const structuredResult = createAIFriendlyResponse(optimizedResult);
        console.log('getSelectedKeacastAccounts: Original size:', JSON.stringify(result).length, 'bytes, Optimized size:', JSON.stringify(optimizedResult).length, 'bytes, Structured size:', JSON.stringify(structuredResult).length, 'bytes');
        
        // Log what data we're actually returning to the AI
        console.log('getSelectedKeacastAccounts: Returning to AI:', {
          hasAccountInfo: !!structuredResult.accountInfo,
          hasBalances: !!structuredResult.currentBalances,
          transactionCounts: {
            forecasted: structuredResult.transactionData?.totalForecastedCount || 0,
            recent: structuredResult.transactionData?.totalRecentCount || 0,
            upcoming: structuredResult.transactionData?.totalUpcomingCount || 0
          },
          summaryStats: structuredResult.summary
        });
        
        return JSON.stringify(structuredResult);
      }
      
      return result;
    } catch (error) {
      console.error('getSelectedKeacastAccounts error:', error.message);
      return {
        success: false,
        error: `API call failed: ${error.message}`,
        accountInfo: null,
        transactionData: { forecastedTransactions: [], recentTransactions: [], upcomingTransactions: [] },
        summary: { totalTransactions: 0, totalIncome: 0, totalExpenses: 0 }
      };
    }
  },

  async getBalances(args, ctx) {
    const { userId, token, accountId: contextAccountId } = ctx;
    const { accountId: argsAccountId } = args;
    const accountId = argsAccountId || contextAccountId;
    
    console.log('getBalances called with:', { 
      argsAccountId, 
      contextAccountId, 
      finalAccountId: accountId,
      userId 
    });
    
    if (!accountId) {
      console.log('getBalances: No accountId available in args or context');
      return {
        error: 'Account ID is required but not provided in arguments or context',
        message: 'Please specify an accountId parameter or ensure it is available in the session context'
      };
    }
    
    const result = await getBalances({ accountId, userId, token });
    return result;
  },

  async createTransaction(args, ctx) {
    const { userId, token, accountId } = ctx;
    const result = await createTransaction({ userId, accountId, token, body: args });
    return result;
  },

  async deleteTransaction(args, ctx) {
    const { userId, token } = ctx;
    const { transactionid } = args;
    const result = await deleteTransaction({ userId, transactionId: transactionid, token, body: {} });
    return result;
  }
};

module.exports = { functionMap };
