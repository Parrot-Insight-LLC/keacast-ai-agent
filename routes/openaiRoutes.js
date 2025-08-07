const express = require('express');
const router = express.Router();
const { analyzeTransactions, chat } = require('../controllers/openaiController');
const {redisTest} = require('../controllers/openaiController');

router.post('/summarize', analyzeTransactions);
router.post('/chat', chat);
router.get('/test-redis', redisTest);


  

module.exports = router;
