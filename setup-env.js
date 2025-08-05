const fs = require('fs');

const azureConfig = `
# Azure OpenAI Configuration
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=your-deployment-name
AZURE_OPENAI_API_VERSION=2024-02-15-preview
AZURE_OPENAI_API_KEY=your-api-key-here
`;

fs.appendFileSync('.env', azureConfig);
console.log('Azure OpenAI configuration added to .env file');
console.log('Please update the values with your actual Azure OpenAI credentials'); 