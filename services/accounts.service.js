// services/accounts.service.js
const { query } = require('./db');

async function getAccountsByUserId(userId) {
  const sql = `SELECT * FROM accounts WHERE userid = ? ORDER BY account_order ASC`;
  return query(sql, [userId]);
}

async function getAccountById(accountId) {
  const sql = `SELECT * FROM accounts WHERE accountid = ?`;
  const rows = await query(sql, [accountId]);
  return rows[0] || null;
}

module.exports = {
  getAccountsByUserId,
  getAccountById,
};
