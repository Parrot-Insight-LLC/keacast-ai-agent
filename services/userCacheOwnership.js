'use strict';
const { id } = require('./legacyReadAuthorization');

// Only disposable cache namespaces belong here. Conversation/session state is
// deliberately excluded. Owner positions differ (notably balances).
function ownership(userId) {
  const owner = id(userId);
  if (!owner) throw new Error('Invalid cache owner');
  const patterns = [
    `context:user:${owner}:account:*`, `userdata:${owner}`,
    `balances:*:${owner}`, `transactions:${owner}:*`,
    `accounts:selected:${owner}`, `lastupdated:${owner}`,
    `summarization:session:${owner}:account:*`, `autocat:u${owner}:a*`,
  ];
  const rules = [
    new RegExp(`^context:user:${owner}:account:[^:]+$`),
    new RegExp(`^userdata:${owner}$`),
    new RegExp(`^balances:[^:]+:${owner}$`),
    new RegExp(`^transactions:${owner}:[^:]+:.+$`),
    new RegExp(`^accounts:selected:${owner}$`),
    new RegExp(`^lastupdated:${owner}$`),
    new RegExp(`^summarization:session:${owner}:account:[^:]+:.+$`),
    new RegExp(`^autocat:u${owner}:a[^:]+:m.*:p.*$`),
  ];
  return { patterns, owns: key => typeof key === 'string' && rules.some(rule => rule.test(key)) };
}

async function userCacheKeys(redis, userId) {
  const { patterns, owns } = ownership(userId);
  const keys = new Set();
  // Enumerate completely before deleting. SCAN may repeat entries; distrust
  // returned keys as well as MATCH and recheck the full owner/key shape.
  for (const pattern of patterns) {
    let cursor = '0';
    do {
      const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = String(result[0]);
      for (const key of result[1]) if (owns(key)) keys.add(key);
    } while (cursor !== '0');
  }
  return [...keys];
}

async function invalidateUserCache(redis, userId) {
  const keys = await userCacheKeys(redis, userId);
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 200) {
    const batch = keys.slice(i, i + 200);
    try { deleted += await redis.unlink(...batch); }
    catch (error) {
      if (!/unknown command.*unlink/i.test(error.message || '')) throw error;
      deleted += await redis.del(...batch);
    }
  }
  return deleted;
}
module.exports = { ownership, userCacheKeys, invalidateUserCache };
