// services/openaiService.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const functionSchemas = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../tools/keacast_functions_schemas.json'), 'utf8')
);

// Debug: Log the loaded schema
console.log('Loaded function schemas:', JSON.stringify(functionSchemas, null, 2));

// Tools that mutate real data — omitted from the model while Simulation Mode is active.
const SIM_MODE_OMIT_TOOLS = new Set([
  'createTransaction',
  'updateTransaction',
  'deleteTransaction',
  'createGoal',
  'updateGoal',
  'deleteGoal',
  'confirmTransaction',
  'updateDraftTransaction',
  'updateDraftGoal',
]);
// Goal write / draft tools — omitted when the client's plan has no Goals.
const GOAL_UNAVAILABLE_OMIT_TOOLS = new Set([
  'createGoal',
  'updateGoal',
  'deleteGoal',
  'updateDraftGoal',
]);
const SIM_PROPOSE_TOOL_NAMES = new Set([
  'proposeSimulationAdd',
  'proposeSimulationModify',
  'proposeSimulationRemove',
]);

/**
 * Return a filtered copy of functionSchemas for the current chat turn.
 * Runtime refuse-in-code remains the safety net; this only reduces wasted tool rounds.
 */
function filterFunctionSchemas(
  schemas = functionSchemas,
  { simulationMode = false, goalsAvailable = true, simulationAvailable = true } = {}
) {
  const list = Array.isArray(schemas) ? schemas : [];
  return list.filter((item) => {
    const name = item?.function?.name;
    if (!name) return true;
    if (simulationMode && SIM_MODE_OMIT_TOOLS.has(name)) return false;
    if (!simulationAvailable && SIM_PROPOSE_TOOL_NAMES.has(name)) return false;
    if (goalsAvailable === false && GOAL_UNAVAILABLE_OMIT_TOOLS.has(name)) return false;
    return true;
  });
}

// Build the Azure deployment URL on demand so callers can pick a different
// deployment (e.g. a cheaper / smaller model for low-stakes endpoints like
// auto-categorization) without changing the global env var. Falls back to
// AZURE_OPENAI_DEPLOYMENT when no per-call deployment is provided.
function buildBaseUrl(deployment) {
  const dep = deployment || process.env.AZURE_OPENAI_DEPLOYMENT;
  return `${process.env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '')}/openai/deployments/${dep}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION}`;
}

async function callAOAI(body, { deployment, timeout, requestId } = {}) {
  const url = buildBaseUrl(deployment);
  try {
    const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
    const messageCount = Array.isArray(body.messages) ? body.messages.length : 0;
    console.log('Azure OpenAI request:', JSON.stringify({
      requestId: requestId || null,
      messageCount,
      toolCount,
      tool_choice: body.tool_choice || null,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
    }));

    const res = await axios.post(url, body, {
      headers: {
        'api-key': process.env.AZURE_OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      // axios honors `timeout` (ms). Without this, callers passing
      // `timeout: 10000` were silently ignored — the value just got
      // spread into the request body and Azure dropped it.
      ...(typeof timeout === 'number' && timeout > 0 ? { timeout } : {})
    });

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
    requestId,            // correlation id for logs (never log the full body)
  } = {}
) {
  const body = { messages, temperature, max_tokens };
  // Only attach the function-calling layer when there are real tools to
  // offer. Callers can opt out by passing `tools: null` (or `[]`) — note
  // `tools: undefined` does NOT opt out, because destructuring defaults
  // above replace undefined with functionSchemas. Omitting the keys
  // entirely (rather than sending tools: null) keeps Azure from rejecting
  // the body, and prevents the model from answering with tool_calls (null
  // content) on plain-completion endpoints like Smart Price Assist.
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = tool_choice;
  }
  if (response_format) body.response_format = response_format;
  const data = await callAOAI(body, { deployment, timeout, requestId });
  // Return the full data so controller can inspect tool calls
  return data;
}

module.exports = { queryAzureOpenAI, functionSchemas, filterFunctionSchemas };
