// services/contextCache.service.js
const redis = require('./redisService');
const { functionMap } = require('../tools/functionMap');
const moment = require('moment');
const momentTimezone = require('moment-timezone');

// Cache TTL settings
const CACHE_TTL = {
  USER_CONTEXT: 3600, // 1 hour for full user context
  USER_DATA: 7200,    // 2 hours for basic user data
  BALANCES: 1800,     // 30 minutes for account balances
  TRANSACTIONS: 1800, // 30 minutes for transaction data
  QUICK_ACCESS: 600   // 10 minutes for frequently accessed data
};

// Cache key generators
const CACHE_KEYS = {
  userContext: (userId, accountId) => `context:user:${userId}:account:${accountId}`,
  userData: (userId) => `userdata:${userId}`,
  balances: (accountId, userId) => `balances:${accountId}:${userId}`,
  transactions: (userId, accountId, dateRange) => `transactions:${userId}:${accountId}:${dateRange}`,
  selectedAccounts: (userId) => `accounts:selected:${userId}`,
  lastUpdated: (userId) => `lastupdated:${userId}`
};

class ContextCacheService {
  
  /**
   * Get cached user context or build and cache it
   */
  async getUserContext(userId, token, accountId, location = null) {
    const cacheKey = CACHE_KEYS.userContext(userId, accountId);
    const lastUpdatedKey = CACHE_KEYS.lastUpdated(userId);
    
    try {
      // Check if we have cached context
      const cachedContext = await redis.get(cacheKey);
      const lastUpdated = await redis.get(lastUpdatedKey);
      
      // If cached and recent, return it
      if (cachedContext && lastUpdated) {
        const lastUpdatedTime = new Date(lastUpdated);
        const now = new Date();
        const ageMinutes = (now - lastUpdatedTime) / (1000 * 60);
        
        // Return cached data if it's less than 30 minutes old
        if (ageMinutes < 30) {
          console.log('ContextCache: Using cached user context (age:', Math.round(ageMinutes), 'minutes)');
          return {
            ...JSON.parse(cachedContext),
            _cached: true,
            _cacheAge: Math.round(ageMinutes)
          };
        }
      }
      
      // Build fresh context
      console.log('ContextCache: Building fresh user context');
      const freshContext = await this.buildUserContext(userId, token, accountId, location);
      
      // Cache the fresh context
      await this.cacheUserContext(userId, accountId, freshContext);
      
      return {
        ...freshContext,
        _cached: false,
        _freshlyBuilt: true
      };
      
    } catch (error) {
      console.error('ContextCache: Error getting user context:', error);
      // Fall back to building fresh context without caching
      return await this.buildUserContext(userId, token, accountId, location);
    }
  }
  
  /**
   * Build user context from scratch
   */
  async buildUserContext(userId, token, accountId, location = null) {
    const ctx = { userId, authHeader: `Bearer ${token}` };
    
    // Calculate current date based on user's timezone
    const currentDate = this.getCurrentDateInTimezone(location);
    console.log('ContextCache: Using current date:', currentDate);
    
    try {
      // Get user data (cached separately for longer TTL)
      const userData = await this.getUserDataCached(userId, token);
      
      // Calculate date ranges
      const upcomingEnd = moment(currentDate).add(14, 'days').format('YYYY-MM-DD');
      const recentStart = moment(currentDate).subtract(3, 'months').format('YYYY-MM-DD');
      const recentEnd = moment(currentDate).add(1, 'days').format('YYYY-MM-DD');
      
      // Get selected accounts with all transaction data
      const selectedAccounts = await functionMap.getSelectedKeacastAccounts({ 
        userId, 
        token, 
        body: {
          "currentDate": currentDate,
          "forecastType": "F",
          "recentStart": recentStart,
          "recentEnd": recentEnd,
          "page": "layout",
          "position": 0,
          selectedAccounts: [accountId],
          upcomingEnd: upcomingEnd,
          user: userData
        } 
      }, ctx);
      
      // Get account balances
      const balances = await this.getBalancesCached(accountId, userId, token);
      const filteredBalances = balances ? balances.forecasted.filter(balance => 
        moment(balance.date).isBetween(moment().subtract(6, 'months'), moment().add(12, 'months'))
      ) : [];
      
      // Build comprehensive context
      const userContext = {
        userData: userData || {},
        selectedAccounts: selectedAccounts || [],
        accounts: [], // keep for backward compatibility
        categories: selectedAccounts[0]?.categories || [],
        shoppingList: selectedAccounts[0]?.shoppingList || [],
        cfTransactions: selectedAccounts[0]?.cfTransactions || [],
        upcomingTransactions: selectedAccounts[0]?.upcoming || [],
        possibleRecurringTransactions: selectedAccounts[0]?.plaidRecurrings || [],
        plaidTransactions: selectedAccounts[0]?.plaidTransactions || [],
        recentTransactions: selectedAccounts[0]?.recents || [],
        breakdown: selectedAccounts[0]?.breakdown || [],
        balances: filteredBalances,
        available: selectedAccounts[0]?.available || [],
        currentDate: currentDate,
        _buildTime: new Date().toISOString(),
        _accountId: accountId
      };
      
      console.log('ContextCache: Built fresh context with', 
        userContext.cfTransactions?.length || 0, 'transactions,',
        userContext.upcomingTransactions?.length || 0, 'upcoming,',
        userContext.balances?.length || 0, 'balance records'
      );
      
      return userContext;
      
    } catch (error) {
      console.error('ContextCache: Error building user context:', error);
      throw error;
    }
  }
  
  /**
   * Cache user context with appropriate TTL
   */
  async cacheUserContext(userId, accountId, context) {
    const cacheKey = CACHE_KEYS.userContext(userId, accountId);
    const lastUpdatedKey = CACHE_KEYS.lastUpdated(userId);
    
    try {
      // Cache the full context
      await redis.set(cacheKey, JSON.stringify(context), 'EX', CACHE_TTL.USER_CONTEXT);
      
      // Update last updated timestamp
      await redis.set(lastUpdatedKey, new Date().toISOString(), 'EX', CACHE_TTL.USER_CONTEXT);
      
      console.log('ContextCache: Cached user context for', userId, 'account', accountId);
    } catch (error) {
      console.error('ContextCache: Error caching user context:', error);
    }
  }
  
  /**
   * Get cached user data or fetch and cache it
   */
  async getUserDataCached(userId, token) {
    const cacheKey = CACHE_KEYS.userData(userId);
    
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log('ContextCache: Using cached user data');
        return JSON.parse(cached);
      }
      
      // Fetch fresh data
      const userData = await functionMap.getUserData({ userId, token }, { userId });
      
      // Cache it
      await redis.set(cacheKey, JSON.stringify(userData), 'EX', CACHE_TTL.USER_DATA);
      console.log('ContextCache: Cached fresh user data');
      
      return userData;
    } catch (error) {
      console.error('ContextCache: Error with user data cache:', error);
      // Fallback to direct call
      return await functionMap.getUserData({ userId, token }, { userId });
    }
  }
  
  /**
   * Get cached balances or fetch and cache them
   */
  async getBalancesCached(accountId, userId, token) {
    const cacheKey = CACHE_KEYS.balances(accountId, userId);
    
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        console.log('ContextCache: Using cached balances');
        return JSON.parse(cached);
      }
      
      // Fetch fresh balances
      const balances = await functionMap.getBalances({ accountId, userId, token }, { userId });
      
      // Cache them
      await redis.set(cacheKey, JSON.stringify(balances), 'EX', CACHE_TTL.BALANCES);
      console.log('ContextCache: Cached fresh balances');
      
      return balances;
    } catch (error) {
      console.error('ContextCache: Error with balances cache:', error);
      // Fallback to direct call
      return await functionMap.getBalances({ accountId, userId, token }, { userId });
    }
  }
  
  /**
   * Invalidate all cached data for a user
   */
  async invalidateUserCache(userId) {
    try {
      const pattern = `*${userId}*`;
      const keys = await redis.keys(pattern);
      
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log('ContextCache: Invalidated', keys.length, 'cache entries for user', userId);
      }
      
      return keys.length;
    } catch (error) {
      console.error('ContextCache: Error invalidating user cache:', error);
      return 0;
    }
  }
  
  /**
   * Invalidate context cache for specific account
   */
  async invalidateAccountCache(userId, accountId) {
    try {
      const contextKey = CACHE_KEYS.userContext(userId, accountId);
      const balancesKey = CACHE_KEYS.balances(accountId, userId);
      const lastUpdatedKey = CACHE_KEYS.lastUpdated(userId);
      
      await redis.del(contextKey, balancesKey, lastUpdatedKey);
      console.log('ContextCache: Invalidated account cache for user', userId, 'account', accountId);
    } catch (error) {
      console.error('ContextCache: Error invalidating account cache:', error);
    }
  }
  
  /**
   * Warm up cache for a user (pre-load data)
   */
  async warmUpCache(userId, token, accountId, location = null) {
    try {
      console.log('ContextCache: Warming up cache for user', userId, 'account', accountId);
      
      // This will build and cache the context
      await this.getUserContext(userId, token, accountId, location);
      
      console.log('ContextCache: Cache warm-up completed');
      return true;
    } catch (error) {
      console.error('ContextCache: Error warming up cache:', error);
      return false;
    }
  }
  
  /**
   * Get cache statistics
   */
  async getCacheStats(userId) {
    try {
      const pattern = `*${userId}*`;
      const keys = await redis.keys(pattern);
      
      const stats = {
        totalKeys: keys.length,
        keys: [],
        totalSize: 0
      };
      
      for (const key of keys) {
        const ttl = await redis.ttl(key);
        const value = await redis.get(key);
        const size = value ? Buffer.byteLength(value, 'utf8') : 0;
        
        stats.keys.push({
          key,
          ttl: ttl > 0 ? ttl : 'no expiration',
          size: size,
          sizeKB: Math.round(size / 1024 * 100) / 100
        });
        
        stats.totalSize += size;
      }
      
      stats.totalSizeKB = Math.round(stats.totalSize / 1024 * 100) / 100;
      stats.totalSizeMB = Math.round(stats.totalSize / (1024 * 1024) * 100) / 100;
      
      return stats;
    } catch (error) {
      console.error('ContextCache: Error getting cache stats:', error);
      return { error: error.message };
    }
  }
  
  /**
   * Get current date in user's timezone (helper method)
   */
  getCurrentDateInTimezone(location) {
    if (!location || typeof location.latitude !== 'number' || typeof location.longitude !== 'number') {
      console.log('ContextCache: No valid location provided, using UTC');
      return moment().utc().format('YYYY-MM-DD');
    }
    
    try {
      const timezone = this.getTimezoneFromCoordinates(location.latitude, location.longitude);
      console.log(`ContextCache: Calculated timezone for coordinates (${location.latitude}, ${location.longitude}): ${timezone}`);
      
      const currentDate = moment.tz(timezone).format('YYYY-MM-DD');
      console.log(`ContextCache: Current date in ${timezone}: ${currentDate}`);
      
      return currentDate;
    } catch (error) {
      console.warn('ContextCache: Error calculating timezone, falling back to UTC:', error.message);
      return moment().utc().format('YYYY-MM-DD');
    }
  }
  
  /**
   * Get timezone from coordinates (helper method)
   */
  getTimezoneFromCoordinates(latitude, longitude) {
    // Simple timezone approximation based on longitude
    const timezoneOffset = Math.round(longitude / 15);
    
    // Map common timezone offsets to timezone names
    const timezoneMap = {
      '-12': 'Pacific/Auckland', '-11': 'Pacific/Midway', '-10': 'Pacific/Honolulu',
      '-9': 'America/Anchorage', '-8': 'America/Los_Angeles', '-7': 'America/Denver',
      '-6': 'America/Chicago', '-5': 'America/New_York', '-4': 'America/Halifax',
      '-3': 'America/Sao_Paulo', '-2': 'Atlantic/South_Georgia', '-1': 'Atlantic/Azores',
      '0': 'Europe/London', '1': 'Europe/Paris', '2': 'Europe/Kiev',
      '3': 'Europe/Moscow', '4': 'Asia/Dubai', '5': 'Asia/Tashkent',
      '6': 'Asia/Almaty', '7': 'Asia/Bangkok', '8': 'Asia/Shanghai',
      '9': 'Asia/Tokyo', '10': 'Australia/Sydney', '11': 'Pacific/Guadalcanal',
      '12': 'Pacific/Auckland'
    };
    
    return timezoneMap[timezoneOffset.toString()] || 'UTC';
  }
}

// Export singleton instance
module.exports = new ContextCacheService();
