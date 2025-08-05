const { queryAzureOpenAI } = require('../services/openaiService');

exports.analyzeTransactions = async (req, res) => {
  try {
    const { transactions } = req.body;

    const formattedMessages = [
      { role: 'system', content: 'You are a financial assistant. Summarize key insights from a list of transactions.' },
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
        content: systemPrompt || 'You are a helpful AI assistant. Provide clear, accurate, and helpful responses.' 
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
