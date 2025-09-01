# Rate Limiting Fixes for 429 Errors

## Problem Summary
Your AI chatbot was experiencing frequent 429 (Rate Limit Exceeded) errors from Azure OpenAI due to:
1. **Large Request Sizes**: Sending massive amounts of transaction data in every request
2. **No Rate Limiting**: No application-level rate limiting to prevent overwhelming Azure OpenAI
3. **Context Overload**: Including 250+ transactions, categories, and account data in every context
4. **Memory Accumulation**: Conversation history growing without size limits

## Solutions Implemented

### 1. Application-Level Rate Limiting
- **Rate Limit Window**: 1 minute (60 seconds)
- **Max Requests**: 10 requests per minute per session
- **Storage**: In-memory Map with automatic cleanup every 5 minutes
- **Endpoints Protected**: `/chat` and `/summarize` endpoints

```javascript
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10; // Max requests per minute per session
```

### 2. Request Size Optimization
- **Reduced Limit**: From 750KB to 400KB to stay well under Azure limits
- **Context Limits**: 
  - Transactions: 100 (was 250)
  - Categories: 50 (was unlimited)
  - Recurring transactions: 25 (was unlimited)
  - Balances: 30 (was unlimited)
  - Available balance: 10 (was unlimited)

```javascript
const REQUEST_SIZE_LIMIT = 400000; // 400KB instead of 750KB
const CONTEXT_TRANSACTION_LIMIT = 100; // Limit transactions in context
const CONTEXT_CATEGORY_LIMIT = 50; // Limit categories in context
```

### 3. Smart Context Truncation
- **Automatic Truncation**: Removes oldest messages when request size exceeds limits
- **Force Truncation**: If still too large, forces context truncation to 50KB
- **Transaction Filtering**: Only includes most relevant transaction data

### 4. Retry Logic with Exponential Backoff
- **Max Retries**: 3 attempts for rate limiting
- **Smart Delays**: Respects Azure's `retry-after` header
- **Exponential Backoff**: For server errors (5xx)

```javascript
// Handle rate limiting with retry logic
if (error.response?.status === 429 && retryCount < MAX_RETRIES) {
  const retryAfter = error.response.headers['retry-after'] || RETRY_DELAY;
  await sleep(retryAfter);
  return callAOAI(body, retryCount + 1);
}
```

### 5. New Monitoring Endpoints
- **Rate Limit Status**: `/rate-limit-status` - Check current rate limit status
- **History Size Check**: `/check-history-size` - Monitor conversation size
- **Session Management**: Clear history, repair sessions, etc.

## How to Use the New Features

### Check Rate Limit Status
```bash
GET /api/openai/rate-limit-status
```

Response:
```json
{
  "success": true,
  "sessionKey": "session:user123",
  "rateLimited": false,
  "requestsInWindow": 3,
  "maxRequestsPerWindow": 10,
  "windowSizeSeconds": 60,
  "timeUntilReset": 0,
  "message": "7 requests remaining in this window"
}
```

### Clear Conversation History
```bash
DELETE /api/openai/clear-history
```

### Check History Size
```bash
GET /api/openai/check-history-size
```

## Best Practices for Frontend

### 1. Handle Rate Limiting Gracefully
```javascript
if (response.status === 429) {
  const data = await response.json();
  const retryAfter = data.retryAfter || 60;
  
  // Show user-friendly message
  showMessage(`Rate limit reached. Please wait ${retryAfter} seconds.`);
  
  // Disable chat input temporarily
  disableChatInput(retryAfter * 1000);
}
```

### 2. Monitor Request Sizes
```javascript
// Check rate limit status before sending large requests
const rateLimitStatus = await fetch('/api/openai/rate-limit-status');
const status = await rateLimitStatus.json();

if (status.rateLimited) {
  showMessage(`Please wait ${status.timeUntilReset} seconds before trying again.`);
  return;
}
```

### 3. Implement Progressive Loading
```javascript
// Load only essential data first, then enhance with more context
const essentialData = await loadEssentialData();
const enhancedData = await loadEnhancedData(); // Only if needed
```

## Expected Results

After implementing these fixes:

1. **429 Errors Reduced**: From frequent to rare occurrences
2. **Better Performance**: Smaller requests = faster responses
3. **User Experience**: Clear feedback when rate limits are hit
4. **Resource Efficiency**: Less memory usage, better scalability
5. **Monitoring**: Better visibility into rate limiting and request sizes

## Monitoring and Maintenance

### Check Logs For:
- Rate limit violations: `"Rate limit exceeded for session:"`
- Request size warnings: `"Request too large, removing oldest messages"`
- Context truncation: `"Forced context truncation to prevent 429 error"`

### Regular Maintenance:
- Monitor rate limit store size in logs
- Check for sessions with consistently large request sizes
- Consider adjusting limits based on usage patterns

## Troubleshooting

### If 429 Errors Still Occur:
1. Check if request size is still exceeding 400KB
2. Verify rate limiting is working (check `/rate-limit-status`)
3. Clear conversation history for problematic sessions
4. Check Azure OpenAI service status and quotas

### Performance Issues:
1. Reduce `CONTEXT_TRANSACTION_LIMIT` from 100 to 50
2. Reduce `MAX_REQUESTS_PER_WINDOW` from 10 to 5
3. Implement client-side request batching
4. Add request caching for repeated queries

## Configuration Options

You can adjust these constants in `controllers/openaiController.js`:

```javascript
const RATE_LIMIT_WINDOW = 60000; // Adjust window size
const MAX_REQUESTS_PER_WINDOW = 10; // Adjust request limit
const REQUEST_SIZE_LIMIT = 400000; // Adjust size limit
const CONTEXT_TRANSACTION_LIMIT = 100; // Adjust context limits
```

These changes should significantly reduce your 429 errors while maintaining a good user experience.
