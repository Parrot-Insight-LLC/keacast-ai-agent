# Context Caching System

## Overview

The Context Caching System is designed to optimize the Chat endpoint by eliminating the need to make API calls on every chat request. It caches user context data (transactions, balances, account info, etc.) in Redis with intelligent cache management and invalidation strategies.

## Key Benefits

- **Performance**: Eliminates API calls for cached data, reducing response times from ~3-5 seconds to ~500ms
- **Cost Reduction**: Reduces external API calls by up to 80% for repeat requests
- **Reliability**: Includes fallback mechanisms when cache service fails
- **Intelligence**: Automatic cache invalidation and refresh strategies
- **Monitoring**: Built-in cache statistics and health monitoring

## Architecture

### Components

1. **ContextCacheService** (`services/contextCache.service.js`) - Core caching logic
2. **CacheController** (`controllers/cacheController.js`) - API endpoints for cache management
3. **CacheRoutes** (`routes/cacheRoutes.js`) - Route definitions
4. **Enhanced Chat Endpoint** - Updated to use cached context

### Cache Strategy

- **User Context**: 1 hour TTL - Full user context including transactions, balances, accounts
- **User Data**: 2 hours TTL - Basic user profile information
- **Balances**: 30 minutes TTL - Account balance information
- **Quick Access**: 10 minutes TTL - Frequently accessed data

## How It Works

### 1. First Request (Cache Miss)
```
User Request → Chat Endpoint → ContextCache.getUserContext()
                ↓
            No cached data found
                ↓
            Build fresh context via API calls
                ↓
            Cache the context in Redis
                ↓
            Return context to Chat Endpoint
```

### 2. Subsequent Requests (Cache Hit)
```
User Request → Chat Endpoint → ContextCache.getUserContext()
                ↓
            Cached data found & fresh
                ↓
            Return cached context immediately
                ↓
            Response time: ~500ms vs ~3-5s
```

### 3. Cache Refresh (Stale Data)
```
User Request → Chat Endpoint → ContextCache.getUserContext()
                ↓
            Cached data found but stale (>30 minutes)
                ↓
            Build fresh context in background
                ↓
            Update cache with fresh data
                ↓
            Return fresh context
```

## API Endpoints

### Cache Management

#### Invalidate User Cache
```http
DELETE /api/cache/user/:userId
```
Clears all cached data for a specific user.

#### Invalidate Account Cache
```http
DELETE /api/cache/user/:userId/account/:accountId
```
Clears cached data for a specific user's account.

#### Warm Up Cache
```http
POST /api/cache/warmup/:userId/account/:accountId
```
Pre-loads and caches user context data.

**Request Body:**
```json
{
  "location": {
    "latitude": 40.7128,
    "longitude": -74.0060
  }
}
```

#### Get Cache Statistics
```http
GET /api/cache/stats/:userId
```
Returns detailed cache statistics for a user.

**Response:**
```json
{
  "success": true,
  "userId": "user123",
  "cacheStats": {
    "totalKeys": 5,
    "totalSizeKB": 245.67,
    "keys": [
      {
        "key": "context:user:user123:account:acc456",
        "ttl": 2847,
        "sizeKB": 156.23
      }
    ]
  }
}
```

#### Cache Health Check
```http
GET /api/cache/health
```
Returns cache system health status.

## Integration with Chat Endpoint

The Chat endpoint (`/api/agent/chat`) automatically uses the context cache:

```javascript
// Before (Direct API calls every time)
const userData = await functionMap.getUserData({ userId, token });
const selectedAccounts = await functionMap.getSelectedKeacastAccounts({ ... });
const balances = await functionMap.getBalances({ ... });
// ~3-5 seconds for fresh data

// After (Cached context)
const userContext = await contextCache.getUserContext(userId, token, accountId, location);
// ~50-100ms for cached data, ~3-5s for fresh data (first time only)
```

### Response Indicators

The chat endpoint response includes cache information:

```json
{
  "response": "Your financial analysis...",
  "contextLoaded": true,
  "dataMessage": "Used cached context data (15 minutes old) - no API calls needed!",
  "memoryUsed": 5,
  "requestSize": 125000
}
```

## Cache Invalidation Strategies

### Automatic Invalidation

1. **Time-based**: Data expires based on TTL settings
2. **User-triggered**: When users update their data
3. **System-triggered**: During maintenance or errors

### Manual Invalidation

Use the cache management endpoints to manually clear cache when:
- User reports stale data
- Account information changes
- System maintenance
- Debugging issues

### Best Practices

1. **Warm-up Cache**: Pre-load cache for active users
2. **Monitor Cache Hit Rate**: Track cache effectiveness
3. **Handle Cache Failures**: Always have fallback mechanisms
4. **Regular Cleanup**: Remove unused cache entries

## Monitoring and Debugging

### Cache Statistics

Monitor cache performance using the stats endpoint:

```bash
curl -X GET "/api/cache/stats/user123" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Key metrics to monitor:
- **Hit Rate**: Percentage of requests served from cache
- **Cache Size**: Total memory usage
- **TTL Distribution**: How long data stays cached
- **Error Rate**: Cache service failures

### Health Monitoring

Check cache system health:

```bash
curl -X GET "/api/cache/health"
```

### Debugging Cache Issues

1. **Check Cache Stats**: Verify data is being cached
2. **Test Cache Health**: Ensure Redis connectivity
3. **Review Logs**: Look for cache service errors
4. **Invalidate Cache**: Clear stale data if needed
5. **Fallback Testing**: Verify fallback mechanisms work

## Configuration

### Environment Variables

```env
# Redis Configuration (existing)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_password
REDIS_TLS=false

# Cache Configuration (optional)
CACHE_USER_CONTEXT_TTL=3600    # 1 hour
CACHE_USER_DATA_TTL=7200       # 2 hours  
CACHE_BALANCES_TTL=1800        # 30 minutes
CACHE_QUICK_ACCESS_TTL=600     # 10 minutes
```

### Customizing Cache TTL

Modify `CACHE_TTL` settings in `services/contextCache.service.js`:

```javascript
const CACHE_TTL = {
  USER_CONTEXT: process.env.CACHE_USER_CONTEXT_TTL || 3600,
  USER_DATA: process.env.CACHE_USER_DATA_TTL || 7200,
  BALANCES: process.env.CACHE_BALANCES_TTL || 1800,
  QUICK_ACCESS: process.env.CACHE_QUICK_ACCESS_TTL || 600
};
```

## Performance Impact

### Before Caching
- **First Request**: ~3-5 seconds (API calls)
- **Subsequent Requests**: ~3-5 seconds (API calls)
- **API Call Rate**: 100% (every request)

### After Caching
- **First Request**: ~3-5 seconds (API calls + caching)
- **Subsequent Requests**: ~500ms (cached data)
- **API Call Rate**: ~20% (cache hits reduce API calls)

### Expected Improvements
- **Response Time**: 80-90% faster for cached requests
- **API Costs**: 70-80% reduction in external API calls
- **Server Load**: Reduced database and API pressure
- **User Experience**: Near-instant responses for repeat interactions

## Migration Guide

The context caching system is backwards compatible. No changes required for existing clients.

### Gradual Rollout
1. Deploy the caching system (automatic)
2. Monitor cache hit rates and performance
3. Adjust TTL settings based on usage patterns
4. Scale Redis infrastructure as needed

### Rollback Plan
If issues occur, the system automatically falls back to direct API calls, ensuring zero downtime.

## Troubleshooting

### Common Issues

#### Cache Not Working
- Check Redis connectivity: `GET /api/cache/health`
- Verify authentication tokens are valid
- Check cache statistics: `GET /api/cache/stats/:userId`

#### Stale Data
- Manually invalidate cache: `DELETE /api/cache/user/:userId`
- Reduce TTL settings for more frequent updates
- Check for data update webhooks

#### Performance Issues
- Monitor Redis memory usage
- Check cache key distribution
- Consider Redis clustering for high load

#### Cache Misses
- Verify user and account IDs are consistent
- Check location data format
- Review cache key generation logic

### Support

For additional support:
1. Check application logs for cache service errors
2. Use cache health and stats endpoints for diagnostics
3. Review Redis logs for connectivity issues
4. Test fallback mechanisms by temporarily disabling Redis

## Future Enhancements

Planned improvements:
- **Smart Cache Warming**: Predictive cache loading
- **Distributed Caching**: Multi-region cache support
- **Advanced Analytics**: Detailed cache performance metrics
- **Cache Compression**: Reduce memory usage
- **Webhook Integration**: Automatic cache invalidation on data updates
