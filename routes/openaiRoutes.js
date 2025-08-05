const express = require('express');
const router = express.Router();
const { analyzeTransactions, chat } = require('../controllers/openaiController');

router.post('/summarize', analyzeTransactions);
router.post('/chat', chat);

module.exports = router;
