'use strict';

const DEFAULT_AZURE_CHAT_TIMEOUT_MS = 25000;
const DEFAULT_MACRO_TIMEOUT_MS = 15000;
const DEFAULT_CHAT_BUDGET_MS = 60000;
const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 8000;
const DEFAULT_AUTH_DB_TIMEOUT_MS = 5000;
const FRONTEND_ABORT_MS = 120000;

const STAGES = Object.freeze([
  'request_received',
  'context_started',
  'context_ready',
  'route_resolved',
  'grounding_started',
  'grounding_finished',
  'azure_started',
  'azure_finished',
  'persist_started',
  'response_sent',
]);

function parseEnvMs(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return Math.round(n);
}

function azureChatTimeoutMs() {
  return parseEnvMs('KEA_CHAT_AZURE_TIMEOUT_MS', DEFAULT_AZURE_CHAT_TIMEOUT_MS, 5000, 60000);
}

function macroTimeoutMs() {
  return parseEnvMs('KEA_MACRO_TIMEOUT_MS', DEFAULT_MACRO_TIMEOUT_MS, 3000, 30000);
}

function chatBudgetMs() {
  const n = parseEnvMs('KEA_CHAT_BUDGET_MS', DEFAULT_CHAT_BUDGET_MS, 15000, 110000);
  return Math.min(n, FRONTEND_ABORT_MS - 10000);
}

function redisCommandTimeoutMs() {
  return parseEnvMs('KEA_REDIS_COMMAND_TIMEOUT_MS', DEFAULT_REDIS_COMMAND_TIMEOUT_MS, 5000, 10000);
}

function cashflowHttpTimeoutMs() {
  return macroTimeoutMs();
}

function authDbTimeoutMs() {
  return parseEnvMs('KEA_AUTH_DB_TIMEOUT_MS', DEFAULT_AUTH_DB_TIMEOUT_MS, 1000, 15000);
}

function responseWasCompleted(res, lifecycle) {
  if (lifecycle && lifecycle.responseStarted) return true;
  if (res && res.headersSent === true && res.writableEnded === true) return true;
  return false;
}

function classifyHttpFailure(err) {
  if (!err) return 'other';
  const code = err.code || (err.cause && err.cause.code) || '';
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
  if (typeof err.message === 'string' && /timeout/i.test(err.message)) return 'timeout';
  const status = err.response && err.response.status;
  if (status === 401) return 'http_401';
  if (status === 403) return 'http_403';
  if (status === 404) return 'http_404';
  if (status === 429) return 'http_429';
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return 'http_4xx';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'EAI_AGAIN') {
    return 'network';
  }
  return 'other';
}

function classifyAzureFailure(err) {
  const reason = classifyHttpFailure(err);
  if (reason === 'http_429') return 'http_429';
  if (reason === 'http_401' || reason === 'http_403' || reason === 'http_404') return 'http_4xx';
  return reason;
}

function classifyMacroFailure(err) {
  const reason = classifyHttpFailure(err);
  if (reason === 'http_429') return 'http_5xx';
  return reason;
}

function limitationForMacroFailure(reason) {
  if (reason === 'http_401' || reason === 'http_403') return 'access_unverified';
  if (reason === 'timeout') return 'macro_timeout';
  if (reason === 'http_404') return 'macro_error';
  return 'macro_error';
}

function canSendHttpResponse(req, res, lifecycle) {
  if (lifecycle && lifecycle.clientAborted) return false;
  if (!res) return false;
  if (res.writableEnded || res.destroyed) return false;
  if (res.writable === false) return false;
  // Do not treat req.destroyed as client-gone: after express.json() reads the
  // POST body, Node 18+ IncomingMessage auto-destroy sets req.destroyed while
  // the response is still writable.
  if (req && (req.aborted === true || req.readableAborted === true)) return false;
  return true;
}

function trySendJson(req, res, lifecycle, status, body) {
  if (!canSendHttpResponse(req, res, lifecycle)) return false;
  if (status) res.status(status).json(body);
  else res.json(body);
  return true;
}

function elapsedMs(startedAt) {
  return Date.now() - startedAt;
}

function remainingBudget(startedAt, budgetMs) {
  return Math.max(0, budgetMs - elapsedMs(startedAt));
}

function hasBudgetFor(startedAt, budgetMs, neededMs) {
  return remainingBudget(startedAt, budgetMs) >= neededMs;
}

function shouldRetryAzure({ lifecycle, timeoutMs, macroOwnsTurn }) {
  if (macroOwnsTurn) return false;
  if (lifecycle && lifecycle.clientAborted) return false;
  if (lifecycle && !lifecycle.hasBudgetFor(timeoutMs)) return false;
  return true;
}

function shouldStartNewExpensiveWork(lifecycle) {
  if (!lifecycle) return true;
  if (lifecycle.clientAborted) return false;
  return true;
}

function createRequestLifecycle({ req, res, telemetry, requestId } = {}) {
  const startedAt = Date.now();
  const budgetMs = chatBudgetMs();
  let lastStage = null;
  let clientAborted = false;
  let abortEmitted = false;
  let responseStarted = false;
  let listenersAttached = false;

  function setStage(stage) {
    if (typeof stage === 'string' && stage) lastStage = stage;
    if (telemetry && typeof telemetry.setLastStage === 'function') {
      telemetry.setLastStage(lastStage);
    }
  }

  function markClientAborted() {
    if (clientAborted) return;
    clientAborted = true;
    if (telemetry && typeof telemetry.setClientAborted === 'function') {
      telemetry.setClientAborted(true);
    }
  }

  function emitAbortIfNeeded() {
    if (abortEmitted) return false;
    if (responseWasCompleted(res, { responseStarted })) return false;
    abortEmitted = true;
    markClientAborted();
    if (telemetry && typeof telemetry.emitAbort === 'function') {
      telemetry.emitAbort(req && req.log, {
        requestId: requestId || (req && req.id) || null,
        elapsed_ms: elapsedMs(startedAt),
        last_stage: lastStage,
        client_aborted: true,
        response_started: responseStarted,
      });
    }
    return true;
  }

  function attachListeners() {
    if (listenersAttached || !req || !res) return;
    listenersAttached = true;
    const onAbort = () => {
      if (responseWasCompleted(res, { responseStarted })) return;
      emitAbortIfNeeded();
    };
    req.on('aborted', onAbort);
    res.on('close', onAbort);
  }

  function markResponseStarted() {
    responseStarted = true;
  }

  return {
    startedAt,
    budgetMs,
    get lastStage() { return lastStage; },
    get clientAborted() { return clientAborted || !!(req && req.aborted); },
    get responseStarted() { return responseStarted; },
    setStage,
    markClientAborted,
    markResponseStarted,
    emitAbortIfNeeded,
    attachListeners,
    get listenersAttached() { return listenersAttached; },
    remainingBudget: () => remainingBudget(startedAt, budgetMs),
    hasBudgetFor: (neededMs) => hasBudgetFor(startedAt, budgetMs, neededMs),
    canSendResponse: () => canSendHttpResponse(req, res, {
      get clientAborted() { return clientAborted || !!(req && req.aborted); },
    }),
  };
}

module.exports = {
  DEFAULT_AZURE_CHAT_TIMEOUT_MS,
  DEFAULT_MACRO_TIMEOUT_MS,
  DEFAULT_CHAT_BUDGET_MS,
  DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
  DEFAULT_AUTH_DB_TIMEOUT_MS,
  FRONTEND_ABORT_MS,
  STAGES,
  parseEnvMs,
  azureChatTimeoutMs,
  macroTimeoutMs,
  chatBudgetMs,
  redisCommandTimeoutMs,
  cashflowHttpTimeoutMs,
  authDbTimeoutMs,
  responseWasCompleted,
  classifyHttpFailure,
  classifyAzureFailure,
  classifyMacroFailure,
  limitationForMacroFailure,
  canSendHttpResponse,
  trySendJson,
  remainingBudget,
  hasBudgetFor,
  shouldRetryAzure,
  shouldStartNewExpensiveWork,
  createRequestLifecycle,
};
