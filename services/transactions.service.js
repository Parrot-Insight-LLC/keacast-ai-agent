// services/transactions.service.js
const { query } = require('./db');
const moment = require('moment');

const frequencyMapping = {
  "2":"Once","1":"Daily","7":"Weekly","14":"Bi-Weekly","15":"Semi-Monthly","16":"Semi-Monthly",
  "30":"Monthly","31":"Monthly","29":"Monthly","28":"Monthly","59":"Bi-Monthly","60":"Bi-Monthly",
  "61":"Bi-Monthly","62":"Bi-Monthly","91":"Quarterly","182":"Semi-Annually","183":"Semi-Annually",
  "365":"Annually","366":"Annually"
};

function hydrate(tx) {
  const start = moment(tx.start, 'YYYY/MM/DD');
  const end = moment(tx.end, 'YYYY/MM/DD');
  return {
    ...tx,
    start: start.format('YYYY-MM-DD'),
    end: end.format('YYYY-MM-DD'),
    start2: start.format('MMM DD, YYYY'),
    end2: end.format('MMM DD, YYYY'),
    frequency2: frequencyMapping[tx.frequency] || 'Unknown',
    status: tx.match_id ? (tx.forecast_type === 'A' ? 'Posted' : 'Pending') : 'Forecast',
  };
}

async function getTransactionsByUserAndAccount(userId, accountId, opts={}) {
  const now = moment().subtract(1,'days');
  const start = opts.startDate || now.clone().subtract(1,'years').format('YYYY-MM-DD');
  const end = opts.endDate || now.clone().add(2,'years').format('YYYY-MM-DD');
  const page = opts.page || 1;
  const limit = opts.limit || 100; // Reduced from unlimited to prevent memory issues
  const offset = (page - 1) * limit;

  // join to categories for logos (user-scoped) with pagination
  // Note: LIMIT and OFFSET cannot be parameters in MySQL prepared statements
  const sql = `
    SELECT t.*, c.logo
    FROM transactions t
    LEFT JOIN categories c
      ON t.category COLLATE utf8mb4_unicode_ci = c.name COLLATE utf8mb4_unicode_ci
     AND c.user_id = ?
    WHERE t.accountid = ?
      AND t.start BETWEEN ? AND ?
    ORDER BY t.start DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const rows = await query(sql, [userId, accountId, start, end]);
  return rows.map(hydrate);
}

async function getTransactionsByUserAndAccountCount(userId, accountId, opts={}) {
  const now = moment().subtract(1,'days');
  const start = opts.startDate || now.clone().subtract(1,'years').format('YYYY-MM-DD');
  const end = opts.endDate || now.clone().add(2,'years').format('YYYY-MM-DD');

  // Get total count for pagination
  const sql = `
    SELECT COUNT(*) as total
    FROM transactions t
    WHERE t.accountid = ?
      AND t.start BETWEEN ? AND ?
  `;
  const result = await query(sql, [accountId, start, end]);
  return result[0]?.total || 0;
}

async function getTransactionsByUserAndAccountPaginated(userId, accountId, opts={}) {
  const [transactions, total] = await Promise.all([
    getTransactionsByUserAndAccount(userId, accountId, opts),
    getTransactionsByUserAndAccountCount(userId, accountId, opts)
  ]);
  
  const page = opts.page || 1;
  const limit = opts.limit || 100;
  
  return {
    transactions,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1
    }
  };
}

async function getRecurringForecastsByAccount(accountId, page = 1, limit = 50) {
  // Add pagination to prevent memory issues
  const offset = (page - 1) * limit;
  // Note: LIMIT and OFFSET cannot be parameters in MySQL prepared statements
  const sql = `SELECT * FROM transactions WHERE accountid = ? AND forecast_type IN ('RF','F') ORDER BY start ASC LIMIT ${limit} OFFSET ${offset}`;
  const rows = await query(sql, [accountId]);
  return rows.map(hydrate);
}

async function getRecurringForecastsByAccountCount(accountId) {
  const sql = `SELECT COUNT(*) as total FROM transactions WHERE accountid = ? AND forecast_type IN ('RF','F')`;
  const result = await query(sql, [accountId]);
  return result[0]?.total || 0;
}

async function getRecurringForecastsByAccountPaginated(accountId, page = 1, limit = 50) {
  const [forecasts, total] = await Promise.all([
    getRecurringForecastsByAccount(accountId, page, limit),
    getRecurringForecastsByAccountCount(accountId)
  ]);
  
  return {
    forecasts,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1
    }
  };
}

async function getUpcomingByAccountAndRange(accountId, startDate, endDate, forecastType='F', page = 1, limit = 50) {
  // Add pagination to prevent memory issues
  const offset = (page - 1) * limit;
  // Note: LIMIT and OFFSET cannot be parameters in MySQL prepared statements
  const sql = `
    SELECT * FROM transactions
    WHERE accountid = ?
      AND forecast_type = ?
      AND start BETWEEN ? AND ?
    ORDER BY start ASC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const rows = await query(sql, [accountId, forecastType, startDate, endDate]);
  return rows.map(hydrate);
}

async function getUpcomingByAccountAndRangeCount(accountId, startDate, endDate, forecastType='F') {
  const sql = `
    SELECT COUNT(*) as total FROM transactions
    WHERE accountid = ?
      AND forecast_type = ?
      AND start BETWEEN ? AND ?
  `;
  const result = await query(sql, [accountId, forecastType, startDate, endDate]);
  return result[0]?.total || 0;
}

async function getUpcomingByAccountAndRangePaginated(accountId, startDate, endDate, forecastType='F', page = 1, limit = 50) {
  const [upcoming, total] = await Promise.all([
    getUpcomingByAccountAndRange(accountId, startDate, endDate, forecastType, page, limit),
    getUpcomingByAccountAndRangeCount(accountId, startDate, endDate, forecastType)
  ]);
  
  return {
    upcoming,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1
    }
  };
}

// New function to get summary data without loading all transactions
async function getTransactionSummary(userId, accountId, opts={}) {
  const now = moment().subtract(1,'days');
  const start = opts.startDate || now.clone().subtract(1,'years').format('YYYY-MM-DD');
  const end = opts.endDate || now.clone().add(2,'years').format('YYYY-MM-DD');

  // Get summary statistics instead of full data
  const sql = `
    SELECT 
      COUNT(*) as total_transactions,
      SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as total_income,
      SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as total_expenses,
      AVG(amount) as average_amount,
      MIN(start) as earliest_date,
      MAX(start) as latest_date
    FROM transactions
    WHERE accountid = ?
      AND start BETWEEN ? AND ?
  `;
  
  const result = await query(sql, [accountId, start, end]);
  return result[0] || {};
}

module.exports = {
  getTransactionsByUserAndAccount,
  getTransactionsByUserAndAccountCount,
  getTransactionsByUserAndAccountPaginated,
  getRecurringForecastsByAccount,
  getRecurringForecastsByAccountCount,
  getRecurringForecastsByAccountPaginated,
  getUpcomingByAccountAndRange,
  getUpcomingByAccountAndRangeCount,
  getUpcomingByAccountAndRangePaginated,
  getTransactionSummary,
};
