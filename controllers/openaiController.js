const redis = require('../services/redisService');
const { queryAzureOpenAI } = require('../services/openaiService');
const {
  getUserAccounts,
  getUserCategories,
  getShoppingList
} = require('../tools/keacast_tool_layer');

const MEMORY_TTL = 3600; // 1 hour
const MAX_MEMORY = 20; // limit memory context size

function buildSessionKey(req) {
  return `session:${req.body.sessionId || req.user?.id || 'anonymous'}`;
}

// ----------------------------
// 🧠 Chat with memory
// ----------------------------
exports.chat = async (req, res) => {
    try {
      console.log('Chat endpoint called with body:', JSON.stringify(req.body, null, 2));
      
      const { message, systemPrompt } = req.body;
      if (!message) {
        console.log('Chat endpoint: Missing message in request body');
        return res.status(400).json({ error: 'Message is required' });
      }
  
      const sessionKey = buildSessionKey(req);
      const token = req.headers.authorization?.split(' ')[1];
      const userId = req.user?.id;
      
      console.log('Chat endpoint: Session key:', sessionKey, 'User ID:', userId);

      // Load prior conversation memory
      let history = [];
      try {
        const historyData = await redis.get(sessionKey);
        history = historyData ? JSON.parse(historyData) : [];
        console.log('Chat endpoint: Loaded history length:', history.length);
      } catch (redisError) {
        console.warn('Chat endpoint: Redis history load failed:', redisError.message);
        history = [];
      }
  
      // 🔌 Optional Tool Context (for better reasoning)
      let userContext = {};
      try {
        const [accounts, categories, shoppingList] = await Promise.all([
          getUserAccounts({ userId, token }),
          getUserCategories({ userId, token }),
          getShoppingList({ userId, token })
        ]);
  
        userContext = {
          accounts: accounts || [],
          categories: categories || [],
          shoppingList: shoppingList || []
        };
        console.log('Chat endpoint: Loaded user context with', Object.keys(userContext).length, 'contexts');
      } catch (err) {
        console.warn('Chat endpoint: Tool context failed to load:', err.message);
      }
  
      // 🧠 Compose the prompt with memory and context
      const formattedMessages = [
        {
          role: 'system',
          content: systemPrompt || `You are Kea, a smart and trustworthy financial assistant built into the Keacast platform. Your job is to help users understand, manage, and improve their financial well-being. You will not mention budget or budgeting. Always respond clearly, accurately, and professionally. Explain financial concepts simply and clearly, summarize income, spending, and forecasting patterns, identify financial risks, habits, and areas of improvement, offer practical, personalized advice for saving, spending, and planning, ask follow-up questions to gain deeper insight into the user's financial goals. Avoid giving legal or investment advice—focus on education and forecasting support. If the user's message is unclear, ask clarifying questions. Prioritize clarity, context, and trustworthiness in every response.\n\nHere is current context:\n\nAccounts: ${JSON.stringify(userContext.accounts)}\n\nCategories: ${JSON.stringify(userContext.categories)}\n\nShopping List: ${JSON.stringify(userContext.shoppingList)}`
        },
        ...history,
        { role: 'user', content: message }
      ];
  
      console.log('Chat endpoint: Calling OpenAI with', formattedMessages.length, 'messages');
      
      // 🎯 Call OpenAI
      const aiResponse = await queryAzureOpenAI(formattedMessages);
      console.log('Chat endpoint: Received OpenAI response, length:', aiResponse?.length || 0);
  
      const updatedHistory = [
        ...history,
        { role: 'user', content: message },
        { role: 'assistant', content: aiResponse }
      ].slice(-MAX_MEMORY);
  
      try {
        await redis.set(sessionKey, JSON.stringify(updatedHistory), 'EX', MEMORY_TTL);
        console.log('Chat endpoint: Saved updated history to Redis');
      } catch (redisError) {
        console.warn('Chat endpoint: Failed to save history to Redis:', redisError.message);
      }
  
      res.json({
        response: aiResponse,
        memoryUsed: updatedHistory.length,
        contextLoaded: !!Object.keys(userContext).length
      });
  
    } catch (error) {
      console.error('Chat endpoint error:', error);
      console.error('Error stack:', error.stack);
      
      // More specific error messages for debugging
      if (error.code === 'ECONNREFUSED') {
        return res.status(503).json({ error: 'Service temporarily unavailable - Redis connection failed' });
      }
      if (error.response?.status === 401) {
        return res.status(401).json({ error: 'Azure OpenAI authentication failed' });
      }
      if (error.response?.status === 429) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
      }
      
      res.status(500).json({ error: 'Error communicating with Azure OpenAI' });
    }
  };

// ----------------------------
// 📊 Summarize with context memory
// ----------------------------
exports.analyzeTransactions = async (req, res) => {
  try {
    console.log('Analyze transactions endpoint called');
    
    const { transactions } = req.body;
    if (!transactions || !Array.isArray(transactions)) {
      console.log('Analyze transactions: Missing or invalid transactions array');
      return res.status(400).json({ error: 'Transactions array is required' });
    }
    
    console.log('Analyze transactions: Processing', transactions.length, 'transactions');
    
    const sessionKey = buildSessionKey(req);

    let history = [];
    try {
      const historyData = await redis.get(sessionKey);
      history = historyData ? JSON.parse(historyData) : [];
      console.log('Analyze transactions: Loaded history length:', history.length);
    } catch (redisError) {
      console.warn('Analyze transactions: Redis history load failed:', redisError.message);
      history = [];
    }

    const formattedMessages = [
      {
        role: 'system',
        content: `You are a financial assistant that helps users understand their financial habits. When given a list of transactions, summarize key insights, including:
        - Total income and spending
        - Top spending categories
        - Spending vs. income balance
        - Notable recurring expenses
        - High-value or unusual transactions
        - Behavioral patterns
        - Actionable suggestions
        Include relevant follow-up questions to guide users toward improving financial wellness.`
      },
      ...history,
      { role: 'user', content: `Here are the latest transactions:\n${JSON.stringify(transactions)}` }
    ];

    console.log('Analyze transactions: Calling OpenAI with', formattedMessages.length, 'messages');
    const aiResponse = await queryAzureOpenAI(formattedMessages);
    console.log('Analyze transactions: Received OpenAI response, length:', aiResponse?.length || 0);

    const updatedHistory = [
      ...history,
      { role: 'user', content: `Here are the latest transactions:\n${JSON.stringify(transactions)}` },
      { role: 'assistant', content: aiResponse }
    ].slice(-MAX_MEMORY);

    try {
      await redis.set(sessionKey, JSON.stringify(updatedHistory), 'EX', MEMORY_TTL);
      console.log('Analyze transactions: Saved updated history to Redis');
    } catch (redisError) {
      console.warn('Analyze transactions: Failed to save history to Redis:', redisError.message);
    }

    res.json({ insights: aiResponse });

  } catch (error) {
    console.error('Analyze transactions error:', error);
    console.error('Error stack:', error.stack);
    
    // More specific error messages for debugging
    if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'Service temporarily unavailable - Redis connection failed' });
    }
    if (error.response?.status === 401) {
      return res.status(401).json({ error: 'Azure OpenAI authentication failed' });
    }
    if (error.response?.status === 429) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    
    res.status(500).json({ error: 'Error communicating with Azure OpenAI' });
  }
};

exports.redisTest = async (req, res) => {
    try {
      console.log('Redis test endpoint called');
      await redis.set('test-key', 'Hello from Keacast Redis!', 'EX', 60);
      const value = await redis.get('test-key');
      console.log('Redis test: Successfully set and retrieved test value');
      res.json({ 
        success: true, 
        value,
        note: 'Redis connection working. Chat and summarize endpoints now share unified conversation history.'
      });
    } catch (error) {
      console.error('Redis test error:', error);
      res.status(500).json({ error: 'Redis connection failed', details: error.message });
    }
  };

// ----------------------------
// 🗑️ Clear conversation history
// ----------------------------
exports.clearHistory = async (req, res) => {
  try {
    console.log('Clear history endpoint called');
    
    const sessionKey = buildSessionKey(req);
    console.log('Clear history: Session key:', sessionKey);
    
    try {
      await redis.del(sessionKey);
      console.log('Clear history: Successfully cleared session history');
      res.json({ 
        success: true, 
        message: 'Conversation history cleared successfully',
        sessionKey: sessionKey
      });
    } catch (redisError) {
      console.warn('Clear history: Redis delete failed:', redisError.message);
      res.status(500).json({ error: 'Failed to clear history', details: redisError.message });
    }
    
  } catch (error) {
    console.error('Clear history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
  
