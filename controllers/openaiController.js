const { queryAzureOpenAI } = require('../services/openaiService');

exports.analyzeTransactions = async (req, res) => {
  try {
    const { transactions } = req.body;

    const formattedMessages = [
      { role: 'system', content: 'You are a financial assistant that helps users understand their financial habits. When given a list of transactions, summarize the key insights, including: Total income and total spending Top spending categories and their amounts Spending vs. income balance Notable recurring expenses or subscriptions Unusual or high-value purchases Suggestions for improving financial health Behavioral patterns or habits (e.g., frequent dining out, impulsive spending) Conclude with a short list of actionable recommendations the user can consider to improve their financial wellness or inquire about further insights.' },
      { role: 'user', content: `Here are the transactions:\n${JSON.stringify(transactions)}` }
    ];

    const aiResponse = await queryAzureOpenAI(formattedMessages);

    res.json({ insights: aiResponse });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Error communicating with Azure OpenAI' });
  }
};

exports.chat = async (req, res) => {
  try {
    const { message, systemPrompt } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const formattedMessages = [
      { 
        role: 'system', 
        content: systemPrompt || `You are Kea, a smart and trustworthy financial assistant built into the Keacast platform. Your job is to help users understand, manage, and improve their financial well-being. You will not mention budget or budgeting. Always respond clearly, accurately, and professionally.Explain financial concepts simply and clearly, Summarize income, spending, and forecasting patterns, Identify financial risks, habits, and areas of improvement, Offer practical, personalized advice for saving, spending, and planning, Ask follow-up questions to gain deeper insight into the user's financial goals Avoid giving legal or investment advice—focus on education and forecasting support. If the user's message is unclear, ask clarifying questions. Prioritize clarity, context, and trustworthiness in every response.` 
      },
      { role: 'user', content: message }
    ];

    const aiResponse = await queryAzureOpenAI(formattedMessages);

    res.json({ 
      response: aiResponse,
      message: message,
      systemPrompt: systemPrompt || 'Default assistant'
    });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: 'Error communicating with Azure OpenAI' });
  }
};
