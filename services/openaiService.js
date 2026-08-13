// services/openaiService.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const functionSchemas = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../tools/keacast_functions_schemas.json'), 'utf8')
);

// Debug: Log the loaded schema
console.log('Loaded function schemas:', JSON.stringify(functionSchemas, null, 2));

// --- Resilience knobs (env-tunable; safe defaults) -------------------------
// A hung Azure call previously had no ceiling — it held the request open
// indefinitely. These bound every call and add capped retry for transient
// upstream failures (S4). All values can be overridden per environment.
const AOAI_DEFAULT_TIMEOUT_MS = Number(process.env.AZURE_OPENAI_TIMEOUT_MS) || 30000; // per-attempt
const AOAI_MAX_RETRIES = Number(process.env.AOAI_MAX_RETRIES) || 2;                    // extra attempts
const AOAI_TOTAL_BUDGET_MS = Number(process.env.AOAI_TOTAL_BUDGET_MS) || 45000;        // overall deadline

// Shared, provider-agnostic retry helper. Retries only transient failures
// (429 / HTTP 5xx / timeouts / connection errors) with exponential backoff +
// jitter, and stops early once the overall time budget would be exceeded so
// total added latency stays bounded regardless of attempt count.
const RETRYABLE_CODES = new Set([
  'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'
]);

function isRetryableError(error) {
  const status = error?.response?.status;
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  // No HTTP response (network/timeout) — retry known-transient codes.
  if (!error?.response && (RETRYABLE_CODES.has(error?.code) || /timeout/i.test(error?.message || ''))) return true;
  return false;
}

// Map a transient upstream failure to a gateway status the errorHandler
// honors, so a propagating caller yields 503/504 instead of a generic 500.
function normalizeUpstreamStatus(error) {
  if (!error?.response && (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT' || /timeout/i.test(error?.message || ''))) {
    return 504;
  }
  const status = error?.response?.status;
  if (status === 429 || (status >= 500 && status <= 599)) return 503;
  if (!error?.response) return 503; // connection-level failure
  return undefined; // 4xx (non-429) etc. — leave to the default handler
}

async function withRetry(attempt, { label, maxRetries, totalBudgetMs }) {
  const start = Date.now();
  let lastError;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      const canRetry = i < maxRetries && isRetryableError(error);
      // Exponential backoff (base 300ms, x2, cap 2s) with +/-20% jitter.
      const base = Math.min(300 * Math.pow(2, i), 2000);
      const jitter = base * (0.8 + Math.random() * 0.4);
      // Honor Retry-After on 429 (seconds), capped to the backoff cap.
      const retryAfterSec = Number(error?.response?.headers?.['retry-after']);
      const delay = Number.isFinite(retryAfterSec) ? Math.min(retryAfterSec * 1000, 2000) : jitter;
      const elapsed = Date.now() - start;
      if (!canRetry || elapsed + delay >= totalBudgetMs) break;
      console.warn(`${label}: transient failure (attempt ${i + 1}/${maxRetries + 1}, status=${error?.response?.status || error?.code || 'n/a'}); retrying in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // Override with the normalized gateway status: a genuine upstream 5xx/timeout
  // should surface as 503/504, not the raw provider status axios attaches.
  const status = normalizeUpstreamStatus(lastError);
  if (status && lastError) lastError.status = status;
  throw lastError;
}

// Build the Azure deployment URL on demand so callers can pick a different
// deployment (e.g. a cheaper / smaller model for low-stakes endpoints like
// auto-categorization) without changing the global env var. Falls back to
// AZURE_OPENAI_DEPLOYMENT when no per-call deployment is provided.
function buildBaseUrl(deployment) {
  const dep = deployment || process.env.AZURE_OPENAI_DEPLOYMENT;
  return `${process.env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '')}/openai/deployments/${dep}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION}`;
}

async function callAOAI(body, { deployment, timeout } = {}) {
  const url = buildBaseUrl(deployment);
  // A per-attempt timeout ALWAYS applies now: callers may pass one, otherwise
  // the sane default is used. Previously an absent timeout meant no ceiling.
  const perAttemptTimeout = (typeof timeout === 'number' && timeout > 0) ? timeout : AOAI_DEFAULT_TIMEOUT_MS;
  try {
    console.log('Azure OpenAI request URL:', url);
    console.log('Azure OpenAI request body:', JSON.stringify(body, null, 2));

    const res = await withRetry(
      () => axios.post(url, body, {
        headers: {
          'api-key': process.env.AZURE_OPENAI_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: perAttemptTimeout
      }),
      { label: 'Azure OpenAI', maxRetries: AOAI_MAX_RETRIES, totalBudgetMs: AOAI_TOTAL_BUDGET_MS }
    );

    console.log('Azure OpenAI response status:', res.status);
    return res.data;
  } catch (error) {
    console.error('Azure OpenAI API call failed:');
    console.error('Status:', error.response?.status);
    console.error('Response data:', error.response?.data);
    console.error('Error message:', error.message);
    throw error;
  }
}

async function queryAzureOpenAI(
  messages,
  {
    tools = functionSchemas,
    tool_choice = 'auto',
    temperature = 0.3,
    max_tokens = 5000,
    deployment,           // optional per-call Azure deployment override
    timeout,              // optional per-call axios timeout (ms)
    response_format,      // optional structured-output hint (Azure 2024-08-06+)
  } = {}
) {
  const body = { messages, temperature, tools, tool_choice, max_tokens };
  if (response_format) body.response_format = response_format;
  const data = await callAOAI(body, { deployment, timeout });
  // Return the full data so controller can inspect tool calls
  return data;
}

module.exports = { queryAzureOpenAI, functionSchemas };
