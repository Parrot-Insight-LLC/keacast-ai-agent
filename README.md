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

# 4. Retrieve conversation history
curl -X GET /api/agent/chat-history \
  -H 'Content-Type: application/json' \
  -d '{"sessionId": "user123"}'
```

## 📡 API Endpoints

### Chat Endpoint
- **POST** `/api/agent/chat`
- Maintains conversation history and provides contextual responses

### Summarize Endpoint  
- **POST** `/api/agent/summarize`
- Analyzes transaction data and adds insights to conversation history

### Chat History Endpoint
- **GET** `/api/agent/chat-history`
- Retrieves conversation history for a specific session with timestamps
- **Note**: Excludes system messages and context messages (transaction data, account information, etc.)

**Request Body:**
```json
{
  "sessionId": "user123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Chat history retrieved successfully",
  "sessionKey": "session:user123",
  "history": [
    {
      "id": 1,
      "role": "user",
      "content": "Hello!",
      "timestamp": "2024-01-15T10:30:00.000Z",
      "messageNumber": 1,
      "estimatedTime": true
    },
    {
      "id": 2,
      "role": "assistant",
      "content": "Hello! How can I help you with your finances today?",
      "timestamp": "2024-01-15T10:31:00.000Z",
      "messageNumber": 2,
      "estimatedTime": true
    }
  ],
  "messageCount": 2,
  "totalHistorySize": 4,
  "metadata": {
    "sessionId": "user123",
    "hasSystemMessages": true,
    "hasToolMessages": false,
    "hasContextMessages": true,
    "estimatedSessionDuration": "2 minutes",
    "lastUpdated": "2024-01-15T10:35:00.000Z"
  }
}
```

### Clear History Endpoint
- **DELETE** `/api/agent/clear-history`
- Clears conversation history for a specific session

**Request Options:**
```bash
# Option 1: Using query parameter
curl -X DELETE /api/agent/clear-history?sessionId=user123

# Option 2: Using header
curl -X DELETE /api/agent/clear-history \
  -H 'x-session-id: user123'

# Option 3: Using request body (if supported by your client)
curl -X DELETE /api/agent/clear-history \
  -H 'Content-Type: application/json' \
  -d '{"sessionId": "user123"}'
```

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

