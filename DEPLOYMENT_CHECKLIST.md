# Deployment Checklist

## Pre-Deployment Checklist

### ✅ Environment Variables
- [ ] `NODE_ENV=production`
- [ ] `PORT` (usually set by platform)
- [ ] `AZURE_OPENAI_ENDPOINT`
- [ ] `AZURE_OPENAI_DEPLOYMENT`
- [ ] `AZURE_OPENAI_API_VERSION`
- [ ] `AZURE_OPENAI_API_KEY`
- [ ] `REDIS_HOST`
- [ ] `REDIS_PORT`
- [ ] `REDIS_PASSWORD` (if required)
- [ ] `REDIS_TLS=true` (for production Redis)
- [ ] `JWT_SECRET`
- [ ] `ALLOWED_ORIGINS` (comma-separated list)

### ✅ Infrastructure
- [ ] Redis instance is running and accessible
- [ ] Azure OpenAI service is configured and accessible
- [ ] Domain/SSL certificate is configured (if using custom domain)
- [ ] Load balancer/proxy is configured correctly

### ✅ Code Changes
- [ ] All environment variables are properly referenced
- [ ] CORS is configured for production domains
- [ ] Error handling is in place
- [ ] Logging is configured for production
- [ ] Health check endpoint is working

## Post-Deployment Testing

### ✅ Basic Connectivity
```bash
curl https://your-api.com/
# Should return API info
```

### ✅ Health Check
```bash
curl https://your-api.com/health
# Should return {"status": "healthy", ...}
```

### ✅ Redis Connection
```bash
curl https://your-api.com/api/agent/test-redis
# Should return {"success": true, "value": "Hello from Keacast Redis!"}
```

### ✅ POST Endpoints
```bash
# Test chat endpoint
curl -X POST https://your-api.com/api/agent/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello"}'

# Test summarize endpoint
curl -X POST https://your-api.com/api/agent/summarize \
  -H "Content-Type: application/json" \
  -d '{"transactions": [{"amount": 100, "description": "Test"}]}'
```

### ✅ CORS (from frontend)
- [ ] Frontend can make requests to the API
- [ ] No CORS errors in browser console
- [ ] Preflight requests work correctly

## Common Issues to Check

### ❌ 404 Errors
- Check if routes are properly configured
- Verify the base URL path
- Check if the deployment platform is serving the correct files

### ❌ 500 Errors
- Check application logs
- Verify all environment variables are set
- Check Redis and Azure OpenAI connectivity

### ❌ CORS Errors
- Verify `ALLOWED_ORIGINS` includes your frontend domain
- Check if the frontend is making requests to the correct URL
- Ensure the API is accessible from the frontend domain

### ❌ Timeout Errors
- Check if Redis is responding quickly
- Verify Azure OpenAI API response times
- Consider increasing timeout limits if needed

## Monitoring Setup

### ✅ Logs
- [ ] Application logs are being captured
- [ ] Error logs are being monitored
- [ ] Performance metrics are being tracked

### ✅ Alerts
- [ ] Set up alerts for 5xx errors
- [ ] Monitor Redis connection status
- [ ] Track Azure OpenAI API usage and errors

### ✅ Health Checks
- [ ] Load balancer is using `/health` endpoint
- [ ] Health checks are passing consistently
- [ ] Automated monitoring is in place

## Rollback Plan

### ✅ Version Control
- [ ] All changes are committed to git
- [ ] Deployment is tagged with version
- [ ] Rollback procedure is documented

### ✅ Database/State
- [ ] Redis data can be preserved if needed
- [ ] No breaking changes to data structures
- [ ] Migration scripts are ready if needed

## Security Checklist

### ✅ Environment Variables
- [ ] All secrets are properly encrypted
- [ ] No hardcoded credentials in code
- [ ] Environment variables are not logged

### ✅ API Security
- [ ] CORS is properly configured
- [ ] Rate limiting is in place (if needed)
- [ ] Input validation is working

### ✅ Infrastructure
- [ ] SSL/TLS is enabled
- [ ] Firewall rules are appropriate
- [ ] Access controls are in place 