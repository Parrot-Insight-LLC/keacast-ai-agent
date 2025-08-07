# Deployment Troubleshooting Guide

## Common Issues and Solutions

### 1. POST Endpoints Not Working in Production

**Symptoms:**
- GET endpoints work but POST endpoints return 404 or 500 errors
- Endpoints work locally but fail when deployed

**Common Causes & Solutions:**

#### A. CORS Issues
```bash
# Check if CORS is blocking requests
curl -X POST https://your-api.com/api/agent/chat \
  -H "Content-Type: application/json" \
  -H "Origin: https://yourdomain.com" \
  -d '{"message": "test"}'
```

**Solution:** Update `ALLOWED_ORIGINS` in your environment variables:
```env
ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
```

#### B. Body Parser Issues
**Solution:** The app now includes proper body parsing limits:
```javascript
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
```

#### C. Environment Variables Missing
**Check these required variables:**
```bash
# Required for Azure OpenAI
AZURE_OPENAI_ENDPOINT
AZURE_OPENAI_DEPLOYMENT
AZURE_OPENAI_API_KEY
AZURE_OPENAI_API_VERSION

# Required for Redis
REDIS_HOST
REDIS_PORT
REDIS_PASSWORD (if using authentication)
REDIS_TLS (set to 'true' for production Redis)

# Required for JWT
JWT_SECRET
```

### 2. Redis Connection Issues

**Test Redis connection:**
```bash
curl https://your-api.com/api/agent/test-redis
```

**Common Redis issues:**
- Wrong host/port
- Missing password
- TLS not enabled for production Redis
- Firewall blocking connection

**Solution:** Update Redis configuration:
```env
REDIS_HOST=your-redis-host.com
REDIS_PORT=6379
REDIS_PASSWORD=your-password
REDIS_TLS=true
```

### 3. Azure OpenAI Issues

**Test Azure OpenAI:**
```bash
curl -X POST https://your-api.com/api/agent/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello"}'
```

**Common issues:**
- Invalid API key
- Wrong endpoint URL
- Wrong deployment name
- Rate limiting

### 4. Load Balancer/Proxy Issues

**Health check endpoint:**
```bash
curl https://your-api.com/health
```

**Expected response:**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "environment": "production"
}
```

### 5. Request Size Limits

**If you're getting 413 errors:**
- The app now supports up to 10MB requests
- Check if your load balancer has lower limits

## Debugging Steps

### 1. Check Logs
Look for these log messages in your deployment logs:
```
Chat endpoint called with body: {...}
Chat endpoint: Session key: chat:anonymous User ID: undefined
Chat endpoint: Loaded history length: 0
Chat endpoint: Calling OpenAI with 2 messages
Chat endpoint: Received OpenAI response, length: 150
```

### 2. Test Each Component

**Test basic connectivity:**
```bash
curl https://your-api.com/
```

**Test health endpoint:**
```bash
curl https://your-api.com/health
```

**Test Redis:**
```bash
curl https://your-api.com/api/agent/test-redis
```

**Test POST endpoints:**
```bash
# Test chat endpoint
curl -X POST https://your-api.com/api/agent/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, can you help me?"}'

# Test summarize endpoint
curl -X POST https://your-api.com/api/agent/summarize \
  -H "Content-Type: application/json" \
  -d '{"transactions": [{"amount": 100, "description": "Test"}]}'

# Test clear history endpoint
curl -X DELETE https://your-api.com/api/agent/clear-history \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "your-session-id"}'
```

### 4. Unified Conversation History

**New Feature:** Chat and summarize endpoints now share the same conversation history using a unified session key.

**Testing unified history:**
```bash
# 1. Start a chat conversation
curl -X POST https://your-api.com/api/agent/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "test-session", "message": "Hello"}'

# 2. Send transaction data for analysis
curl -X POST https://your-api.com/api/agent/summarize \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "test-session", "transactions": [{"amount": 100, "description": "Test"}]}'

# 3. Ask follow-up questions (AI will remember the transaction analysis)
curl -X POST https://your-api.com/api/agent/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "test-session", "message": "Tell me more about those transactions"}'
```

**Session Management:**
- Use the same `sessionId` across both endpoints to maintain conversation continuity
- History is automatically limited to 20 messages to prevent context overflow
- Sessions expire after 1 hour of inactivity
- Use the clear-history endpoint to reset conversation state

### 3. Environment Variable Checklist

Before deploying, ensure these are set:

```env
# Required
NODE_ENV=production
PORT=5001
AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=your-deployment-name
AZURE_OPENAI_API_VERSION=2024-02-15-preview
AZURE_OPENAI_API_KEY=your-api-key
REDIS_HOST=your-redis-host
REDIS_PORT=6379
REDIS_PASSWORD=your-redis-password
REDIS_TLS=true
JWT_SECRET=your-jwt-secret

# Optional but recommended
ALLOWED_ORIGINS=https://yourdomain.com
```

### 4. Common Error Codes

- **400**: Bad Request - Check request body format
- **401**: Unauthorized - Check JWT token or Azure OpenAI API key
- **404**: Not Found - Check endpoint URL
- **413**: Payload Too Large - Request body too big
- **429**: Too Many Requests - Rate limiting
- **500**: Internal Server Error - Check logs for details
- **503**: Service Unavailable - Redis or Azure OpenAI connection issues

## Deployment Platforms

### Heroku
```bash
# Set environment variables
heroku config:set NODE_ENV=production
heroku config:set AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
# ... set all other variables

# Deploy
git push heroku main
```

### Railway
```bash
# Set environment variables in Railway dashboard
# Deploy automatically on git push
```

### DigitalOcean App Platform
```bash
# Set environment variables in App Platform dashboard
# Deploy automatically on git push
```

### AWS/Google Cloud/Azure
```bash
# Use their respective CLI tools to set environment variables
# Deploy using their container or serverless services
```

## Monitoring

### Health Checks
The app includes a health check endpoint at `/health` that returns:
- Application status
- Timestamp
- Environment

### Logging
The app now includes comprehensive logging for debugging:
- Request/response logging
- Error details
- Redis connection status
- OpenAI API calls

### Metrics to Monitor
- Response times
- Error rates
- Redis connection status
- Azure OpenAI API usage
- Memory usage 