# Keacast AI Agent API

A smart financial assistant API built with Azure OpenAI integration, featuring unified conversation history across chat and transaction analysis endpoints.

## 🚀 Features

- **Unified Conversation History**: Chat and transaction analysis endpoints share the same conversation context
- **Session-Based Memory**: Conversations are maintained per sessionId or user ID
- **Azure OpenAI Integration**: Powered by Azure's OpenAI services
- **Redis Caching**: Fast conversation history storage with automatic expiration
- **Financial Analysis**: Transaction summarization and insights
- **Contextual Responses**: AI remembers previous interactions and transaction data

## 🔄 Unified Conversation History

The API now maintains a single conversation history across both `/chat` and `/summarize` endpoints. This means:

1. **Shared Context**: When you send transaction data to `/summarize`, the AI remembers it in subsequent `/chat` conversations
2. **Follow-up Questions**: You can ask follow-up questions about analyzed transactions in chat
3. **Session Continuity**: Use the same `sessionId` across both endpoints to maintain conversation flow

### Example Workflow

```bash
# 1. Start a conversation
curl -X POST /api/agent/chat \
  -d '{"sessionId": "user123", "message": "Hello!"}'

# 2. Analyze transactions
curl -X POST /api/agent/summarize \
  -d '{"sessionId": "user123", "transactions": [...]}'

# 3. Ask follow-up questions (AI remembers the transaction analysis)
curl -X POST /api/agent/chat \
  -d '{"sessionId": "user123", "message": "Tell me more about those transactions"}'
```

## 📡 API Endpoints

### Chat Endpoint
- **POST** `/api/agent/chat`
- Maintains conversation history and provides contextual responses

### Summarize Endpoint  
- **POST** `/api/agent/summarize`
- Analyzes transaction data and adds insights to conversation history

### Clear History Endpoint
- **DELETE** `/api/agent/clear-history`
- Clears conversation history for a specific session

### Health Check
- **GET** `/health`
- Returns API status and environment information

## 🛠️ Installation & Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Copy `deployment.env.example` to `.env` and configure your environment variables
4. Start the server: `npm run dev`

## 🧪 Testing

Run the unified history test:
```bash
npm run test:history
```

This will demonstrate how the conversation history works across both endpoints.

## 📚 Documentation

- [Deployment Guide](DEPLOYMENT_TROUBLESHOOTING.md)
- [Deployment Checklist](DEPLOYMENT_CHECKLIST.md)

## 🔧 Environment Variables

Required environment variables:
- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_DEPLOYMENT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_API_VERSION`
- `REDIS_HOST`
- `REDIS_PORT`
- `REDIS_PASSWORD` (if required)
- `REDIS_TLS=true` (for production)
- `JWT_SECRET`

