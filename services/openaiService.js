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

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callAOAI(body, retryCount = 0) {
  try {
    console.log('Azure OpenAI request URL:', BASE_URL);
    console.log('Azure OpenAI request body:', JSON.stringify(body, null, 2));
    
    const res = await axios.post(BASE_URL, body, {
      headers: {
        'api-key': process.env.AZURE_OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 second timeout
    });
    
    console.log('Azure OpenAI response status:', res.status);
    return res.data;
  } catch (error) {
    console.error('Azure OpenAI API call failed:');
    console.error('Status:', error.response?.status);
    console.error('Response data:', error.response?.data);
    console.error('Error message:', error.message);
    
    // Handle rate limiting with retry logic
    if (error.response?.status === 429 && retryCount < MAX_RETRIES) {
      const retryAfter = error.response.headers['retry-after'] || RETRY_DELAY;
      console.log(`Rate limited (429). Retrying in ${retryAfter}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      
      await sleep(retryAfter);
      return callAOAI(body, retryCount + 1);
    }
    
    // Handle other transient errors with exponential backoff
    if (error.response?.status >= 500 && retryCount < MAX_RETRIES) {
      const delay = RETRY_DELAY * Math.pow(2, retryCount);
      console.log(`Server error (${error.response.status}). Retrying in ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      
      await sleep(delay);
      return callAOAI(body, retryCount + 1);
    }
    
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
