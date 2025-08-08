const fs = require('fs');
const path = require('path');
const axios = require('axios');

let functionSchemas = [];
try {
  const schemaPath = path.join(__dirname, '../tools/kecast_functions_schemas.json');
  console.log('Loading schema from:', schemaPath);
  
  if (fs.existsSync(schemaPath)) {
    const schemaContent = fs.readFileSync(schemaPath, 'utf8');
    functionSchemas = JSON.parse(schemaContent);
    console.log(`Loaded ${functionSchemas.length} function schemas`);
  } else {
    console.warn('Schema file not found:', schemaPath);
  }
} catch (error) {
  console.warn('Tool context failed to load:', error.message);
  functionSchemas = [];
}

async function queryAzureOpenAI(messages) {
  const url = `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION}`;

  const headers = {
    'api-key': process.env.AZURE_OPENAI_API_KEY,
    'Content-Type': 'application/json',
  };

  const body = {
    messages,
    temperature: 0.7,
    max_tokens: 800
  };

  // Only add tools if functionSchemas is not empty
  if (functionSchemas && functionSchemas.length > 0) {
    body.tools = functionSchemas.map(schema => ({
      type: "function",
      function: schema
    }));
    console.log(`Added ${body.tools.length} tools to request`);
  } else {
    console.log('No tools added to request');
  }

  console.log('Sending request to Azure OpenAI with body:', JSON.stringify(body, null, 2));
  const response = await axios.post(url, body, { headers });
  
  // Check if response has content
  const message = response.data.choices[0].message;
  if (!message || !message.content) {
    console.warn('No content in response:', response.data);
    return 'I apologize, but I received an empty response. Please try again.';
  }
  
  return message.content;
}

module.exports = { queryAzureOpenAI };
