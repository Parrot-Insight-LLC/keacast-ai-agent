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

  // join to categories for logos (user-scoped)
  const sql = `
    SELECT t.*, c.logo
    FROM transactions t
    LEFT JOIN categories c
      ON t.category COLLATE utf8mb4_unicode_ci = c.name COLLATE utf8mb4_unicode_ci
     AND c.user_id = ?
    WHERE t.accountid = ?
      AND t.start BETWEEN ? AND ?
    ORDER BY t.start DESC
  `;
  const rows = await query(sql, [userId, accountId, start, end]);
  return rows.map(hydrate);
}

async function getRecurringForecastsByAccount(accountId) {
  const sql = `SELECT * FROM transactions WHERE accountid = ? AND forecast_type IN ('RF','F') ORDER BY start ASC`;
  const rows = await query(sql, [accountId]);
  return rows.map(hydrate);
}

async function getUpcomingByAccountAndRange(accountId, startDate, endDate, forecastType='F') {
  const sql = `
    SELECT * FROM transactions
    WHERE accountid = ?
      AND forecast_type = ?
      AND start BETWEEN ? AND ?
    ORDER BY start ASC
  `;
  const rows = await query(sql, [accountId, forecastType, startDate, endDate]);
  return rows.map(hydrate);
}

module.exports = {
  getTransactionsByUserAndAccount,
  getRecurringForecastsByAccount,
  getUpcomingByAccountAndRange,
};
