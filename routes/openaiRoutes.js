const express = require('express');
const router = express.Router();
const { analyzeTransactions, chat, clearHistory, checkHistorySize, clearSessionById, repairSession, getChatHistory, autoCategorizeTransaction, invalidateAutoCategorizationKey, summarization } = require('../controllers/openaiController');
const {redisTest} = require('../controllers/openaiController');

// Chat and analysis endpoints
router.post('/chat', chat);
router.post('/summarize', analyzeTransactions);
router.post('/auto-categorize', autoCategorizeTransaction);
// Evicts the Redis cache for a single transaction — call when a user overrides
// the suggested category so the next call for that merchant gets a fresh answer.
router.post('/auto-categorize/invalidate', invalidateAutoCategorizationKey);

// History management endpoints
router.post('/chat-history', getChatHistory);
router.delete('/clear-history', clearHistory);
router.get('/check-history-size', checkHistorySize);
router.delete('/clear-session/:sessionId', clearSessionById);
router.post('/repair-session', repairSession);

// New paginated data endpoints for memory-efficient queries
router.get('/accounts/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 20 } = req.query;
    
    const { getAccountsByUserIdPaginated } = require('../services/accounts.service');
    const result = await getAccountsByUserIdPaginated(userId, parseInt(page), parseInt(limit));
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error fetching paginated accounts:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to fetch accounts'
    });
  }
});

router.get('/transactions/:userId/:accountId', async (req, res) => {
  try {
    const { userId, accountId } = req.params;
    const { page = 1, limit = 50, startDate, endDate } = req.query;
    
    const { getTransactionsByUserAndAccountPaginated } = require('../services/transactions.service');
    const result = await getTransactionsByUserAndAccountPaginated(
      userId, 
      accountId, 
      { 
        startDate, 
        endDate, 
        page: parseInt(page), 
        limit: parseInt(limit) 
      }
    );
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error fetching paginated transactions:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to fetch transactions'
    });
  }
});

router.get('/forecasts/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params;
    const { page = 1, limit = 25 } = req.query;
    
    const { getRecurringForecastsByAccountPaginated } = require('../services/transactions.service');
    const result = await getRecurringForecastsByAccountPaginated(accountId, parseInt(page), parseInt(limit));
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error fetching paginated forecasts:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to fetch forecasts'
    });
  }
});

router.get('/summary/:userId/:accountId', async (req, res) => {
  try {
    const { userId, accountId } = req.params;
    const { startDate, endDate } = req.query;
    
    const { getTransactionSummary } = require('../services/transactions.service');
    const result = await getTransactionSummary(userId, accountId, { startDate, endDate });
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error fetching transaction summary:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to fetch transaction summary'
    });
  }
});

router.post('/summarization', summarization);

// Smart Price Assist — direct (non-chat) entry point used by the cashflow
// backend's shopping-list suggestions proxy. Propose-only: returns options,
// normalization, and taxability hints; nothing is persisted here (the proxy
// persists to shopping_list_item_suggestions). Redis-cached per item+region.
router.post('/shopping/suggest-item', async (req, res) => {
  try {
    const { itemName, quantity, region, userEstimate, excludeOptions } = req.body || {};
    if (!itemName || !String(itemName).trim()) {
      return res.status(400).json({ success: false, message: 'itemName is required' });
    }
    const { suggestItemOptions } = require('../services/shoppingSuggest.service');
    const result = await suggestItemOptions({ itemName, quantity, region, userEstimate, excludeOptions });
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error in shopping suggest-item:', error.message);
    res.status(500).json({ success: false, message: 'Failed to generate suggestions' });
  }
});

module.exports = router;
