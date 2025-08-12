// services/accounts.service.js
const { query } = require('./db');

async function getAccountsByUserId(userId, page = 1, limit = 50) {
  // Add pagination and limit to prevent memory issues
  const offset = (page - 1) * limit;
  // Note: LIMIT and OFFSET cannot be parameters in MySQL prepared statements
  const sql = `SELECT * FROM accounts WHERE userid = ? ORDER BY account_order ASC LIMIT ${limit} OFFSET ${offset}`;
  return query(sql, [userId]);
}

async function getAccountsByUserIdCount(userId) {
  // Get total count for pagination
  const sql = `SELECT COUNT(*) as total FROM accounts WHERE userid = ?`;
  const result = await query(sql, [userId]);
  return result[0]?.total || 0;
}

async function getAccountById(accountId) {
  const sql = `SELECT * FROM accounts WHERE accountid = ? LIMIT 1`;
  const rows = await query(sql, [accountId]);
  return rows[0] || null;
}

// New function to get accounts with pagination info
async function getAccountsByUserIdPaginated(userId, page = 1, limit = 50) {
  const [accounts, total] = await Promise.all([
    getAccountsByUserId(userId, page, limit),
    getAccountsByUserIdCount(userId)
  ]);
  
  return {
    accounts,
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

module.exports = {
  getAccountsByUserId,
  getAccountsByUserIdCount,
  getAccountById,
  getAccountsByUserIdPaginated,
};
