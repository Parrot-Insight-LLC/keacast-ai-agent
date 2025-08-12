const express = require('express');
const router = express.Router();
const { analyzeTransactions, chat, clearHistory, checkHistorySize, clearSessionById, repairSession } = require('../controllers/openaiController');
const {redisTest} = require('../controllers/openaiController');

router.post('/summarize', analyzeTransactions);
router.post('/chat', chat);
router.delete('/clear-history', clearHistory);
router.get('/test-redis', redisTest);
router.get('/check-history-size', checkHistorySize);
router.delete('/clear-session/:sessionId', clearSessionById);
router.post('/repair-session', repairSession);


  

module.exports = router;
