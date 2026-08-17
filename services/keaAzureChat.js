'use strict';

const {
  azureChatTimeoutMs,
  classifyAzureFailure,
  shouldRetryAzure,
  shouldStartNewExpensiveWork,
} = require('./keaRequestBudget');
const { buildMacroFallbackText } = require('./keaMacroFallback');
const { failSoftTextFor, FAIL_SOFT_TEXT } = require('./keaGroundingPolicy');

const NON_MACRO_AZURE_ERROR =
  '## ❌ Error\n\n**I apologize, but I encountered an error while processing your request. Please try again.**';

async function callAzureOnce({
  queryFn,
  messages,
  tools,
  toolChoice,
  requestId,
  timeoutMs,
  telemetry,
  lifecycle,
} = {}) {
  if (!shouldStartNewExpensiveWork(lifecycle)) {
    return { skipped: true, reason: 'client_aborted' };
  }
  if (lifecycle && typeof lifecycle.hasBudgetFor === 'function' && !lifecycle.hasBudgetFor(timeoutMs)) {
    return { skipped: true, reason: 'budget_exhausted' };
  }
  if (lifecycle && typeof lifecycle.setStage === 'function') lifecycle.setStage('azure_started');
  const t0 = Date.now();
  try {
    const data = await queryFn(messages, {
      tools,
      tool_choice: toolChoice,
      requestId,
      timeout: timeoutMs,
    });
    if (telemetry && typeof telemetry.recordAzureCall === 'function') {
      telemetry.recordAzureCall(Date.now() - t0, data && data.usage);
    }
    if (lifecycle && typeof lifecycle.setStage === 'function') lifecycle.setStage('azure_finished');
    return { ok: true, data };
  } catch (err) {
    const reason = classifyAzureFailure(err);
    if (telemetry && typeof telemetry.setAzureFailureReason === 'function') {
      telemetry.setAzureFailureReason(reason);
    }
    return { ok: false, error: err, reason };
  }
}

function groundedMacroFallback(evidence, accountName) {
  const text = buildMacroFallbackText(evidence, { accountName });
  if (text) return { ok: true, fallback: true, content: text };
  return {
    ok: true,
    failSoft: true,
    content: failSoftTextFor(evidence) || FAIL_SOFT_TEXT,
  };
}

async function runChatAzureNarration({
  queryFn,
  messages,
  tools,
  primaryToolChoice,
  requestId,
  telemetry,
  lifecycle,
  macroOwnsTurn,
  evidence,
  accountName,
  timeoutMs,
} = {}) {
  const azureTimeout = timeoutMs != null ? timeoutMs : azureChatTimeoutMs();
  const first = await callAzureOnce({
    queryFn,
    messages,
    tools,
    toolChoice: primaryToolChoice,
    requestId,
    timeoutMs: azureTimeout,
    telemetry,
    lifecycle,
  });
  if (first.skipped) return first;
  if (first.ok) return first;

  if (macroOwnsTurn) {
    const out = groundedMacroFallback(evidence, accountName);
    out.azureFailureReason = first.reason;
    return out;
  }

  if (!shouldRetryAzure({ lifecycle, timeoutMs: azureTimeout, macroOwnsTurn: false })) {
    return { ok: false, reason: first.reason, error: first.error, content: NON_MACRO_AZURE_ERROR };
  }

  const retry = await callAzureOnce({
    queryFn,
    messages,
    tools,
    toolChoice: 'none',
    requestId,
    timeoutMs: azureTimeout,
    telemetry,
    lifecycle,
  });
  if (retry.skipped) {
    return { ok: false, reason: retry.reason, error: first.error, content: NON_MACRO_AZURE_ERROR };
  }
  if (!retry.ok) {
    return { ok: false, reason: retry.reason || first.reason, error: retry.error, content: NON_MACRO_AZURE_ERROR };
  }
  return retry;
}

module.exports = {
  callAzureOnce,
  runChatAzureNarration,
  groundedMacroFallback,
  NON_MACRO_AZURE_ERROR,
};
