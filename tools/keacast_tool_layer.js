// keacast_tool_layer.js
// This file allows CrewAI, LangChain, or any LLM to call Keacast's API as executable tools

const axios = require('axios');
const moment = require('moment');

// Normalize base URL to avoid double slashes when composing paths
const RAW_BASE_URL = process.env.KEACAST_API_BASE_URL || 'https://cashflow-backend-production.herokuapp.com';
const BASE_URL = RAW_BASE_URL.replace(/\/+$/, '');

// --- Resilience knobs (env-tunable; safe defaults) -------------------------
// The external Keacast API runs on Heroku (variable latency, dyno cold-starts).
// Every call now has a default timeout, and idempotent READS get capped retry.
// State-changing calls (createTransaction/deleteTransaction) are NEVER retried.
const KEACAST_API_TIMEOUT_MS = Number(process.env.KEACAST_API_TIMEOUT_MS) || 15000;      // per-attempt
const KEACAST_API_MAX_RETRIES = Number(process.env.KEACAST_API_MAX_RETRIES) || 2;        // extra attempts
const KEACAST_API_TOTAL_BUDGET_MS = Number(process.env.KEACAST_API_TOTAL_BUDGET_MS) || 25000; // overall deadline

// Shared axios instance so a default timeout applies to EVERY call. A per-call
// `timeout` in a request config still overrides this instance default.
const client = axios.create({ timeout: KEACAST_API_TIMEOUT_MS });

const RETRYABLE_CODES = new Set([
  'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'
]);

function isRetryableError(error) {
  const status = error?.response?.status;
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  if (!error?.response && (RETRYABLE_CODES.has(error?.code) || /timeout/i.test(error?.message || ''))) return true;
  return false;
}

function normalizeUpstreamStatus(error) {
  if (!error?.response && (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT' || /timeout/i.test(error?.message || ''))) {
    return 504;
  }
  const status = error?.response?.status;
  if (status === 429 || (status >= 500 && status <= 599)) return 503;
  if (!error?.response) return 503;
  return undefined;
}

// Capped retry + backoff for IDEMPOTENT reads only. Bounded by an overall time
// budget so total added latency stays predictable regardless of attempt count.
async function withReadRetry(attempt, label) {
  const start = Date.now();
  let lastError;
  for (let i = 0; i <= KEACAST_API_MAX_RETRIES; i++) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      const canRetry = i < KEACAST_API_MAX_RETRIES && isRetryableError(error);
      const base = Math.min(300 * Math.pow(2, i), 2000);
      const jitter = base * (0.8 + Math.random() * 0.4);
      const retryAfterSec = Number(error?.response?.headers?.['retry-after']);
      const delay = Number.isFinite(retryAfterSec) ? Math.min(retryAfterSec * 1000, 2000) : jitter;
      const elapsed = Date.now() - start;
      if (!canRetry || elapsed + delay >= KEACAST_API_TOTAL_BUDGET_MS) break;
      console.warn(`Keacast API ${label}: transient failure (attempt ${i + 1}/${KEACAST_API_MAX_RETRIES + 1}, status=${error?.response?.status || error?.code || 'n/a'}); retrying in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Override with the normalized gateway status: a genuine upstream 5xx/timeout
  // should surface as 503/504, not the raw provider status axios attaches.
  const status = normalizeUpstreamStatus(lastError);
  if (status && lastError) lastError.status = status;
  throw lastError;
}

// Tag a state-changing call's failure with a gateway status WITHOUT retrying.
async function callNoRetry(attempt) {
  try {
    return await attempt();
  } catch (error) {
    const status = normalizeUpstreamStatus(error);
    if (status) error.status = status;
    throw error;
  }
}

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
  const response = await withReadRetry(() => client.get(url, AUTH_HEADER(token)), 'getUserAccounts');
  return response.data;
}

async function getUserTransactions({ userId, accountId, token }) {
  const url = `${BASE_URL}/transaction/getall/${userId}/${accountId}`;
  const response = await withReadRetry(() => client.get(url, AUTH_HEADER(token)), 'getUserTransactions');
  return response.data;
}

async function getRecurringForecasts({ accountId, token }) {
  const url = `${BASE_URL}/transaction/recurring/forecasts/${accountId}`;
  const response = await withReadRetry(() => client.get(url, AUTH_HEADER(token)), 'getRecurringForecasts');
  return response.data;
}

async function getUpcomingTransactions({ accountId, startDate, endDate, forecastType, currentDate, token }) {
  const url = `${BASE_URL}/transaction/upcoming/${accountId}/${startDate}/${endDate}/${forecastType}/${currentDate}`;
  const response = await withReadRetry(() => client.get(url, AUTH_HEADER(token)), 'getUpcomingTransactions');
  return response.data;
}

async function getUserCategories({ userId, token }) {
  const url = `${BASE_URL}/api/categories/${userId}`;
  const response = await withReadRetry(() => client.get(url, AUTH_HEADER(token)), 'getUserCategories');
  return response.data;
}

async function getShoppingList({ userId, token }) {
  const url = `${BASE_URL}/list/get/${userId}`;
  const response = await withReadRetry(() => client.get(url, AUTH_HEADER(token)), 'getShoppingList');
  return response.data;
}

async function getUserData({ userId, token }) {
  const url = `${BASE_URL}/user/${userId}`;
  const response = await withReadRetry(() => client.get(url, AUTH_HEADER(token)), 'getUserData');
  return response.data;
}

async function getSelectedKeacastAccounts({ userId, token, body }) {
  const url = `${BASE_URL}/account/getselectedkeacastaccountsnew/${userId}`;
  // Read-via-POST — idempotent, safe to retry.
  const response = await withReadRetry(() => client.post(url, body, AUTH_HEADER(token)), 'getSelectedKeacastAccounts');
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
  // Per-call override still honored; otherwise the client's default timeout applies.
  if (Number.isFinite(timeoutMs)) config.timeout = timeoutMs;
  // Read-via-POST — idempotent, safe to retry.
  const response = await withReadRetry(() => client.post(url, body || {}, config), 'getSelectedAccount');
  return response.data;
}

async function getBalances({ accountId, userId, token, body }) {
  const url = `${BASE_URL}/balances/getall/${accountId}/${moment().format('YYYY-MM-DD')}`;
  const response = await withReadRetry(() => client.get(url, AUTH_HEADER(token)), 'getBalances');
  return response.data;
}

async function createTransaction({ userId, accountId, token, body }) {
  const url = `${BASE_URL}/transaction/create/${userId}/${accountId}`;
  // State-changing — timeout via the shared client, but NEVER retried.
  const response = await callNoRetry(() => client.post(url, body, AUTH_HEADER(token)));
  return response.data;
}

async function deleteTransaction({ userId, transactionId, token, body }) {
  const url = `${BASE_URL}/transaction/delete/${userId}/${transactionId}`;
  // State-changing — timeout via the shared client, but NEVER retried.
  // NOTE: the (url, body, config) arg shape is a pre-existing bug (axios.delete
  // takes (url, config)) — left untouched here; out of S4 scope (see S10).
  const response = await callNoRetry(() => client.delete(url, body, AUTH_HEADER(token)));
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
