// services/openaiService.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const functionSchemas = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../tools/keacast_functions_schemas.json'), 'utf8')
);

// Debug: Log the loaded schema
console.log('Loaded function schemas:', JSON.stringify(functionSchemas, null, 2));

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
  try {
    console.log('Azure OpenAI request URL:', url);
    console.log('Azure OpenAI request body:', JSON.stringify(body, null, 2));

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
  } = {}
) {
  const body = { messages, temperature, tools, tool_choice, max_tokens };
  if (response_format) body.response_format = response_format;
  const data = await callAOAI(body, { deployment, timeout });
  // Return the full data so controller can inspect tool calls
  return data;
}

module.exports = { queryAzureOpenAI, functionSchemas };
