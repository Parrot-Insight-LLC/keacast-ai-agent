const axios = require('axios');

async function queryAzureOpenAI(messages) {
  const url = `${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${process.env.AZURE_OPENAI_API_VERSION}`;

  const headers = {
    'api-key': process.env.AZURE_OPENAI_API_KEY,
    'Content-Type': 'application/json',
  };

  const body = {
    messages,
    temperature: 0.7,
    max_tokens: 500,
  };

  const response = await axios.post(url, body, { headers });
  return response.data.choices[0].message.content;
}

module.exports = { queryAzureOpenAI };
