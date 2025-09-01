// services/openaiService.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const functionSchemas = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../tools/keacast_functions_schemas.json'), 'utf8')
);

// Debug: Log the loaded schema
console.log('Loaded function schemas:', JSON.stringify(functionSchemas, null, 2));

const BASE_URL = `${process.env.AZURE_OPENAI_ENDPOINT.replace(/\/$/, '')}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION}`;

async function callAOAI(body) {
  try {
    console.log('Azure OpenAI request URL:', BASE_URL);
    console.log('Azure OpenAI request body:', JSON.stringify(body, null, 2));
    
    const res = await axios.post(BASE_URL, body, {
      headers: {
        'api-key': process.env.AZURE_OPENAI_API_KEY,
        'Content-Type': 'application/json'
      }
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

async function queryAzureOpenAI(messages, { tools = functionSchemas, tool_choice = 'auto', temperature = 0.3, max_tokens = 5000 } = {}) {
  const body = { messages, temperature, tools, tool_choice, max_tokens };
  const data = await callAOAI(body);
  // Return the full data so controller can inspect tool calls
  return data;
}

module.exports = { queryAzureOpenAI, functionSchemas };
