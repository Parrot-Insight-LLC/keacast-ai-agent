const redis = require('../services/redisService');
const { queryAzureOpenAI } = require('../services/openaiService');
const {
  getUserAccounts,
  getUserCategories,
  getShoppingList
} = require('../tools/keacast_tool_layer');

const MEMORY_TTL = 3600; // 1 hour
const MAX_MEMORY = 20; // limit memory context size

function buildSessionKey(prefix, req) {
  return `${prefix}:${req.body.sessionId || req.user?.id || 'anonymous'}`;
}

// ----------------------------
// 🧠 Chat with memory
// ----------------------------
exports.chat = async (req, res) => {
    try {
      const { message, systemPrompt } = req.body;
      if (!message) return res.status(400).json({ error: 'Message is required' });
  
      const sessionKey = buildSessionKey('chat', req);
      const token = req.headers.authorization?.split(' ')[1];
      const userId = req.user?.id;
  
      // Load prior conversation memory
      let history = await redis.get(sessionKey);
      history = history ? JSON.parse(history) : [];
  
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
      } catch (err) {
        console.warn('Tool context failed to load:', err.message);
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
  
      // 🎯 Call OpenAI
      const aiResponse = await queryAzureOpenAI(formattedMessages);
  
      const updatedHistory = [
        ...history,
        { role: 'user', content: message },
        { role: 'assistant', content: aiResponse }
      ].slice(-MAX_MEMORY);
  
      await redis.set(sessionKey, JSON.stringify(updatedHistory), 'EX', MEMORY_TTL);
  
      res.json({
        response: aiResponse,
        memoryUsed: updatedHistory.length,
        contextLoaded: !!Object.keys(userContext).length
      });
  
    } catch (error) {
      console.error(error.response?.data || error.message);
      res.status(500).json({ error: 'Error communicating with Azure OpenAI' });
    }
  };

// ----------------------------
// 📊 Summarize with context memory
// ----------------------------
exports.analyzeTransactions = async (req, res) => {
  try {
    const { transactions } = req.body;
    const sessionKey = buildSessionKey('summary', req);

    let history = await redis.get(sessionKey);
    history = history ? JSON.parse(history) : [];

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

    const aiResponse = await queryAzureOpenAI(formattedMessages);

    const updatedHistory = [
      ...history,
      { role: 'user', content: `Here are the latest transactions:\n${JSON.stringify(transactions)}` },
      { role: 'assistant', content: aiResponse }
    ].slice(-MAX_MEMORY);

    await redis.set(sessionKey, JSON.stringify(updatedHistory), 'EX', MEMORY_TTL);

    res.json({ insights: aiResponse });

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Error communicating with Azure OpenAI' });
  }
};

exports.redisTest = async (req, res) => {
    try {
      await redis.set('test-key', 'Hello from Keacast Redis!', 'EX', 60);
      const value = await redis.get('test-key');
      res.json({ success: true, value });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Redis connection failed' });
    }
  };
  
