// routes/cacheRoutes.js
const express = require('express');
const router = express.Router();
const cacheController = require('../controllers/cacheController');
const { cashflowAuth } = require('../middleware/cashflowAuth');

const requireCashflowUser = cashflowAuth();
const requireActiveCacheSession = cashflowAuth({ requireActiveSession: true });

// Cache invalidation routes (per-user / per-account)
router.delete('/user/:userId', requireActiveCacheSession, cacheController.invalidateUserCache);
router.delete('/user/:userId/account/:accountId', requireActiveCacheSession, cacheController.invalidateAccountCache);

// Admin-gated global flush routes — wipe LLM caches across EVERY user.
// Require `x-admin-key: <ADMIN_CACHE_FLUSH_KEY>` header in production.
router.delete('/flush/summarization', cacheController.flushSummarizationCache);
router.delete('/flush/autocategorize', cacheController.flushAutoCategorizeCache);
router.delete('/flush/all', cacheController.flushLLMCache);

// Cache warm-up routes
router.post('/warmup/:userId/account/:accountId', requireCashflowUser, cacheController.warmUpCache);

// Cache monitoring routes
router.get('/stats/:userId', requireCashflowUser, cacheController.getCacheStats);
router.get('/health', cacheController.getCacheHealth);

module.exports = router;
