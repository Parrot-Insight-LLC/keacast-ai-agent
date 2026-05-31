// routes/cacheRoutes.js
const express = require('express');
const router = express.Router();
const cacheController = require('../controllers/cacheController');

// Cache invalidation routes (per-user / per-account)
router.delete('/user/:userId', cacheController.invalidateUserCache);
router.delete('/user/:userId/account/:accountId', cacheController.invalidateAccountCache);

// Admin-gated global flush routes — wipe LLM caches across EVERY user.
// Require `x-admin-key: <ADMIN_CACHE_FLUSH_KEY>` header in production.
router.delete('/flush/summarization', cacheController.flushSummarizationCache);
router.delete('/flush/autocategorize', cacheController.flushAutoCategorizeCache);
router.delete('/flush/all', cacheController.flushLLMCache);

// Cache warm-up routes
router.post('/warmup/:userId/account/:accountId', cacheController.warmUpCache);

// Cache monitoring routes
router.get('/stats/:userId', cacheController.getCacheStats);
router.get('/health', cacheController.getCacheHealth);

module.exports = router;
