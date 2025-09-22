# Enhanced Conversation Context for Keacast AI Agent

## Overview

The Keacast AI Agent now includes enhanced conversation context management to provide more natural, continuous, and contextually aware conversations. This enhancement maintains all existing functionality while adding intelligent conversation management features.

## Key Features

### 1. **Conversation Summarization**
- Automatically summarizes long conversations (>20 messages) to maintain context
- Preserves recent conversation context while compressing older messages
- Maintains conversation continuity and topic awareness
- Reduces context window size to prevent rate limiting

### 2. **Topic Tracking & Continuity**
- Automatically identifies conversation topics (budgeting, transactions, forecasting, etc.)
- Maintains topic awareness across conversation turns
- Provides natural topic transitions and references
- Tracks up to 5 recent conversation topics

### 3. **Intelligent Context Management**
- Smart context window management (750KB limit)
- Prioritizes recent messages and important context
- Removes less critical context messages when needed
- Maintains conversation flow and continuity

### 4. **Enhanced Memory Management**
- Increased memory context size (15 messages vs 10)
- Better message sanitization and cleanup
- Improved conversation history storage
- Automatic conversation repair capabilities

## API Endpoints

### Enhanced Chat Endpoint
**POST** `/api/openai/chat`

The existing chat endpoint now returns additional conversation context information:

```json
{
  "response": "AI response text",
  "memoryUsed": 8,
  "contextLoaded": true,
  "dataMessage": "Context loaded successfully",
  "requestSize": 125000,
  "conversationContext": {
    "topics": ["budgeting", "transactions", "forecasting"],
    "hasSummary": false,
    "summaryInfo": null,
    "enhancedContext": true
  }
}
```

### New Endpoints

#### Get Conversation Insights
**GET** `/api/openai/conversation-insights`

Returns detailed insights about the current conversation:

```json
{
  "success": true,
  "insights": {
    "messageCount": 12,
    "userMessageCount": 6,
    "assistantMessageCount": 6,
    "topics": ["budgeting", "transactions"],
    "conversationLength": "18 minutes",
    "hasSummary": false,
    "contextQuality": "Good",
    "avgUserMessageLength": 45,
    "avgAssistantMessageLength": 120,
    "needsSummarization": false,
    "topicDiversity": 2,
    "conversationFlow": "Focused"
  },
  "recommendations": {
    "shouldSummarize": false,
    "contextOptimization": "Context is optimal",
    "topicContinuity": "Continue discussing: budgeting, transactions"
  }
}
```

#### Summarize Conversation
**POST** `/api/openai/summarize-conversation`

Manually triggers conversation summarization:

```json
{
  "success": true,
  "summary": {
    "content": "Conversation summary text...",
    "originalMessageCount": 25,
    "summarizedMessageCount": 20,
    "keptRecentCount": 5,
    "newHistoryLength": 6
  },
  "benefits": [
    "Reduced context window size",
    "Maintained conversation continuity",
    "Preserved recent conversation context",
    "Improved response quality for long conversations"
  ]
}
```

## Configuration Constants

```javascript
const MAX_MEMORY = 15; // Increased memory context size
const CONVERSATION_SUMMARY_THRESHOLD = 20; // Summarize after 20 messages
const CONTEXT_WINDOW_SIZE = 750000; // 750KB context limit
const CONVERSATION_TOPIC_MEMORY = 5; // Track 5 recent topics
```

## Topic Detection

The system automatically detects conversation topics based on keywords:

- **budgeting**: budget, spending, expenses, income, cash flow
- **transactions**: transaction, payment, purchase, expense, income
- **forecasting**: forecast, future, upcoming, planning, projection
- **accounts**: account, balance, bank, credit, debt
- **categories**: category, categorize, spending category
- **savings**: save, savings, invest, investment, retirement
- **debt**: debt, loan, credit card, pay off, debt payoff
- **goals**: goal, target, plan, objective, milestone
- **analysis**: analyze, review, summary, insight, pattern

## Benefits

### For Users
- **More Natural Conversations**: The AI remembers context and topics from earlier in the conversation
- **Better Continuity**: References to previous topics and decisions are maintained
- **Improved Responses**: Context-aware responses that build on previous exchanges
- **Longer Conversations**: Ability to have extended conversations without losing context

### For Developers
- **Automatic Management**: No manual intervention needed for conversation management
- **Rate Limit Prevention**: Intelligent context management prevents API rate limiting
- **Scalable**: Handles conversations of any length efficiently
- **Backward Compatible**: All existing functionality preserved

## Usage Examples

### Basic Conversation Flow
```javascript
// 1. Start conversation
const response1 = await chat({
  message: "I want to create a budget",
  sessionId: "user123"
});

// 2. Continue with topic awareness
const response2 = await chat({
  message: "What categories should I include?",
  sessionId: "user123" // AI remembers budget context
});

// 3. Reference previous topics
const response3 = await chat({
  message: "Can you remind me what we discussed about budgeting?",
  sessionId: "user123" // AI references previous budget discussion
});
```

### Getting Conversation Insights
```javascript
const insights = await getConversationInsights({
  sessionId: "user123"
});

console.log("Current topics:", insights.topics);
console.log("Conversation length:", insights.conversationLength);
console.log("Needs summarization:", insights.needsSummarization);
```

### Manual Summarization
```javascript
const summary = await summarizeConversation({
  sessionId: "user123",
  location: { latitude: 40.7128, longitude: -74.0060 }
});

console.log("Summary created:", summary.summary.content);
console.log("Messages reduced from", summary.originalMessageCount, "to", summary.newHistoryLength);
```

## Testing

Run the test script to verify enhanced conversation functionality:

```bash
node test-enhanced-conversation.js
```

The test script will:
1. Start a conversation
2. Test topic tracking
3. Verify conversation continuity
4. Check conversation insights
5. Test summarization (if applicable)
6. Validate history management

## Migration Notes

- **No Breaking Changes**: All existing API calls continue to work unchanged
- **Enhanced Responses**: Chat responses now include additional `conversationContext` information
- **New Endpoints**: Additional endpoints available for conversation management
- **Automatic Features**: Enhanced context management works automatically

## Performance Considerations

- **Memory Usage**: Slightly increased memory usage for better context management
- **API Calls**: Summarization requires additional API calls for long conversations
- **Response Time**: Minimal impact on response time for normal conversations
- **Storage**: Conversation summaries stored in Redis with same TTL as regular history

## Future Enhancements

Potential future improvements:
- Conversation sentiment analysis
- User preference learning
- Conversation branching and threading
- Advanced topic modeling
- Conversation quality scoring
- Multi-session topic continuity
