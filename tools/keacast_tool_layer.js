// keacast_tool_layer.js
// This file allows CrewAI, LangChain, or any LLM to call Keacast's API as executable tools

const axios = require('axios');

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
  getSelectedKeacastAccounts
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
  functionMap // 👈 Exported for OpenAI tool handler integration
};
