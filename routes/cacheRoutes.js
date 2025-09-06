// routes/cacheRoutes.js
const express = require('express');
const router = express.Router();
const cacheController = require('../controllers/cacheController');

// Cache invalidation routes
router.delete('/user/:userId', cacheController.invalidateUserCache);
router.delete('/user/:userId/account/:accountId', cacheController.invalidateAccountCache);

// Cache warm-up routes
router.post('/warmup/:userId/account/:accountId', cacheController.warmUpCache);

// Cache monitoring routes
router.get('/stats/:userId', cacheController.getCacheStats);
router.get('/health', cacheController.getCacheHealth);

module.exports = router;
