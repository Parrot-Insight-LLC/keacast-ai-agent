const express = require('express');
const router = express.Router();
const { analyzeTransactions, chat, clearHistory } = require('../controllers/openaiController');
const {redisTest} = require('../controllers/openaiController');

router.post('/summarize', analyzeTransactions);
router.post('/chat', chat);
router.delete('/clear-history', clearHistory);
router.get('/test-redis', redisTest);


  

module.exports = router;
