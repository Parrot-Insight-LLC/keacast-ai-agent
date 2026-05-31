// keacast_tool_layer.js
// This file allows CrewAI, LangChain, or any LLM to call Keacast's API as executable tools

const axios = require('axios');
const moment = require('moment');

// Normalize base URL to avoid double slashes when composing paths
const RAW_BASE_URL = process.env.KEACAST_API_BASE_URL || 'https://cashflow-backend-production.herokuapp.com';
const BASE_URL = RAW_BASE_URL.replace(/\/+$/, '');

// Only attach Authorization header when token is provided
const AUTH_HEADER = (token) => (
  token
    ? { headers: { Authorization: `Bearer ${token}` } }
    : { headers: {} }
);

// --------------------------------------
// Tool Functions
// --------------------------------------
async function getUserAccounts({ userId, token }) {
  const url = `${BASE_URL}/account/getall/${userId}`;
  const response = await axios.get(url, AUTH_HEADER(token));
  return response.data;
}

async function getUserTransactions({ userId, accountId, token }) {
  const url = `${BASE_URL}/transaction/getall/${userId}/${accountId}`;
  const response = await axios.get(url, AUTH_HEADER(token));
  return response.data;
}

async function getRecurringForecasts({ accountId, token }) {
  const url = `${BASE_URL}/transaction/recurring/forecasts/${accountId}`;
  const response = await axios.get(url, AUTH_HEADER(token));
  return response.data;
}

async function getUpcomingTransactions({ accountId, startDate, endDate, forecastType, currentDate, token }) {
  const url = `${BASE_URL}/transaction/upcoming/${accountId}/${startDate}/${endDate}/${forecastType}/${currentDate}`;
  const response = await axios.get(url, AUTH_HEADER(token));
  return response.data;
}

async function getUserCategories({ userId, token }) {
  const url = `${BASE_URL}/api/categories/${userId}`;
  const response = await axios.get(url, AUTH_HEADER(token));
  return response.data;
}

async function getShoppingList({ userId, token }) {
  const url = `${BASE_URL}/list/get/${userId}`;
  const response = await axios.get(url, AUTH_HEADER(token));
  return response.data;
}

async function getUserData({ userId, token }) {
  const url = `${BASE_URL}/user/${userId}`;
  const response = await axios.get(url, AUTH_HEADER(token));
  return response.data;
}

async function getSelectedKeacastAccounts({ userId, token, body }) {
  const url = `${BASE_URL}/account/getselectedkeacastaccountsnew/${userId}`;
  const response = await axios.post(url, body, AUTH_HEADER(token));
  return response.data;
}

// Single-account, fully-enriched fetch (returns the same blob the frontend
// uses for the dashboard: balance/available, savings (precomputed),
// futureNegativeBalances (precomputed), categories, balances, upcoming,
// recents, breakdown, plaidTransactions, plaidRecurrings, computedBalances...).
//
// Use this when an LLM endpoint needs ground-truth context for ONE selected
// account without paying the multi-account cost of getSelectedKeacastAccounts.
async function getSelectedAccount({ userId, accountId, token, body, timeoutMs }) {
  const url = `${BASE_URL}/account/selected/${userId}/${accountId}`;
  const config = AUTH_HEADER(token);
  if (Number.isFinite(timeoutMs)) config.timeout = timeoutMs;
  const response = await axios.post(url, body || {}, config);
  return response.data;
}

async function getBalances({ accountId, userId, token, body }) {
  const url = `${BASE_URL}/balances/getall/${accountId}/${moment().format('YYYY-MM-DD')}`;
  const response = await axios.get(url, AUTH_HEADER(token));
  return response.data;
}

async function createTransaction({ userId, accountId, token, body }) {
  const url = `${BASE_URL}/transaction/create/${userId}/${accountId}`;
  const response = await axios.post(url, body, AUTH_HEADER(token));
  return response.data;
}

async function deleteTransaction({ userId, transactionId, token, body }) {
  const url = `${BASE_URL}/transaction/delete/${userId}/${transactionId}`;
  const response = await axios.delete(url, body, AUTH_HEADER(token));
  return response.data;
}

// --------------------------------------
// Function Map for Tool Execution
// --------------------------------------
const functionMap = {
  getUserAccounts,
  getUserTransactions,
  getRecurringForecasts,
  getUpcomingTransactions,
  getUserCategories,
  getShoppingList,
  getUserData,
  getSelectedKeacastAccounts,
  getSelectedAccount,
  getBalances,
  createTransaction,
  deleteTransaction
};

module.exports = {
  getUserAccounts,
  getUserTransactions,
  getRecurringForecasts,
  getUpcomingTransactions,
  getUserCategories,
  getShoppingList,
  getUserData,
  getSelectedKeacastAccounts,
  getSelectedAccount,
  getBalances,
  createTransaction,
  deleteTransaction,
  functionMap // 👈 Exported for OpenAI tool handler integration
};
