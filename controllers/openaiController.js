const redis = require('../services/redisService');
const { queryAzureOpenAI } = require('../services/openaiService');

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

    // Load memory from Redis
    let history = await redis.get(sessionKey);
    history = history ? JSON.parse(history) : [];

    const formattedMessages = [
      {
        role: 'system',
        content: systemPrompt || `You are Kea, a smart and trustworthy financial assistant built into the Keacast platform. Your job is to help users understand, manage, and improve their financial well-being. You will not mention budget or budgeting. Always respond clearly, accurately, and professionally.Explain financial concepts simply and clearly, Summarize income, spending, and forecasting patterns, Identify financial risks, habits, and areas of improvement, Offer practical, personalized advice for saving, spending, and planning, Ask follow-up questions to gain deeper insight into the user's financial goals Avoid giving legal or investment advice—focus on education and forecasting support. If the user's message is unclear, ask clarifying questions. Prioritize clarity, context, and trustworthiness in every response.`,
      },
      ...history,
      { role: 'user', content: message }
    ];

    // Call Azure OpenAI
    const aiResponse = await queryAzureOpenAI(formattedMessages);

    // Update memory (truncate to last N messages)
    const updatedHistory = [
      ...history,
      { role: 'user', content: message },
      { role: 'assistant', content: aiResponse },
    ].slice(-MAX_MEMORY);

    await redis.set(sessionKey, JSON.stringify(updatedHistory), 'EX', MEMORY_TTL);

    res.json({
      response: aiResponse,
      message,
      systemPrompt: systemPrompt || 'Default assistant',
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
  
