// controllers/openaiController.js
const redis = require('../services/redisService');
const { queryAzureOpenAI, functionSchemas } = require('../services/openaiService'); // must support tools
const { functionMap } = require('../tools/functionMap'); // <-- use functionMap.js
const moment = require('moment');
const MEMORY_TTL = 3600; // 1 hour
const MAX_MEMORY = 10; // reduce memory context size to prevent large requests
const MAX_MESSAGE_LENGTH = 13000; // increased limit for individual message length
const SYSTEM_PROMPT_MAX_LENGTH = 15000; // separate limit for system prompts

function buildSessionKey(req) {
  return `session:${req.body.sessionId || req.user?.id || 'anonymous'}`;
}

function truncateText(text, maxChars) {
  if (text === undefined || text === null) return '';
  const str = String(text).trim();
  if (str.length <= maxChars) return str;
  return str.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function truncateMessage(message, maxLength = MAX_MESSAGE_LENGTH) {
  if (!message || typeof message !== 'object') return message;
  
  const truncated = { ...message };
  if (truncated.content && typeof truncated.content === 'string') {
    // Use different limits for system messages vs other messages
    const limit = truncated.role === 'system' ? SYSTEM_PROMPT_MAX_LENGTH : maxLength;
    truncated.content = truncateText(truncated.content, limit);
  }
  
  return truncated;
}

function cleanToolResponses(messages) {
  return messages.map(msg => {
    // Clean up tool responses that might be very long
    if (msg.role === 'tool' && msg.content) {
      try {
        const content = JSON.parse(msg.content);
        // If tool response is too long, truncate it
        if (JSON.stringify(content).length > MAX_MESSAGE_LENGTH) {
          return {
            ...msg,
            content: JSON.stringify({
              ...content,
              _truncated: true,
              originalLength: JSON.stringify(content).length
            })
          };
        }
      } catch (e) {
        // If not JSON, truncate the string
        if (msg.content.length > MAX_MESSAGE_LENGTH) {
          return {
            ...msg,
            content: truncateText(msg.content, MAX_MESSAGE_LENGTH)
          };
        }
      }
    }
    return msg;
  });
}

function sanitizeMessageArray(messages) {
  if (!Array.isArray(messages)) return [];
  
  console.log('Sanitizing message array, original length:', messages.length);
  const sanitized = [];
  
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    
    // Always keep system, user, and assistant messages
    if (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant') {
      sanitized.push(msg);
      continue;
    }
    
    // For tool messages, only keep them if they have a valid tool_call_id
    // and there's a preceding assistant message with tool_calls
    if (msg.role === 'tool') {
      let shouldKeep = false;
      
      // Look backwards to find the preceding assistant message with tool_calls
      for (let j = i - 1; j >= 0; j--) {
        const prevMsg = messages[j];
        if (prevMsg.role === 'assistant' && prevMsg.tool_calls && prevMsg.tool_calls.length > 0) {
          // Check if this tool message corresponds to one of the tool_calls
          if (prevMsg.tool_calls.some(tc => tc.id === msg.tool_call_id)) {
            shouldKeep = true;
            break;
          }
        }
      }
      
      if (!shouldKeep) {
        console.log('Sanitizing: Removing orphaned tool message with tool_call_id:', msg.tool_call_id);
        continue;
      }
    }
    
    // Keep the message if we haven't filtered it out
    sanitized.push(msg);
  }
  
  console.log('Sanitizing complete, final length:', sanitized.length);
  return sanitized;
}

function extractAuthFromRequest(req) {
  const bearerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.split(' ')[1]
    : undefined;
  const headerToken = req.headers['x-auth-token'];
  const bodyToken = req.body?.token;
  const token = bearerToken || headerToken || bodyToken;

  const headerUserId = req.headers['x-user-id'];
  const bodyUserId = req.body?.sessionId;
  const jwtUserId = req.user?.id;
  const userId = bodyUserId || headerUserId || jwtUserId;

  return { token, userId, authHeader: req.headers.authorization };
}

function extractContextFromBody(req) {
  const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts : undefined;
  const categories = Array.isArray(req.body?.categories) ? req.body.categories : undefined;
  const shoppingList = Array.isArray(req.body?.shoppingList) ? req.body.shoppingList : undefined;
  const transactions = Array.isArray(req.body?.transactions) ? req.body.transactions : undefined;
  
  if (accounts || categories || shoppingList || transactions) {
    return {
      accounts: accounts || [],
      categories: categories || [],
      shoppingList: shoppingList || [],
      transactions: transactions || []
    };
  }
  return undefined;
}

function createContextSummary(userContext) {
  if (!userContext || Object.keys(userContext).length === 0) {
    return { hasData: false };
  }

  const summary = {
    hasData: true,
    userData: userContext.userData ? {
      hasUserData: true,
      // Include key user fields if they exist
      ...(userContext.userData.first_name && { first_name: userContext.userData.first_name }),
      ...(userContext.userData.last_name && { last_name: userContext.userData.last_name }),
      ...(userContext.userData.email && { email: userContext.userData.email })
    } : { hasUserData: false },
    selectedAccounts: userContext.selectedAccounts ? {
      count: userContext.selectedAccounts.length,
      // Include key account details
      accounts: userContext.selectedAccounts.map(acc => ({
        id: acc.id,
        name: acc.accountname,
        type: acc.account_type,
        balance: acc.balance,
        available: acc.available,
        current: acc.current,
        credit_limit: acc.credit_limit,
        forecasted: acc.forecasted,
        bank_account_name: acc.bankaccount_name,
        institution_name: acc.institution_name,
        institution_logo: acc.institution_logo,
      })).slice(0, 3) // Limit to first 3 accounts
    } : { count: 0 },
    dataCounts: {
      categories: userContext.categories ? userContext.categories.length : 0,
      shoppingList: userContext.shoppingList ? userContext.shoppingList.length : 0,
      transactions: userContext.cfTransactions ? userContext.cfTransactions.length : 0,
      upcomingTransactions: userContext.upcomingTransactions ? userContext.upcomingTransactions.length : 0,
      plaidTransactions: userContext.plaidTransactions ? userContext.plaidTransactions.length : 0,
      recentTransactions: userContext.recentTransactions ? userContext.recentTransactions.length : 0,
      breakdown: userContext.breakdown ? userContext.breakdown.length : 0
    },
    // Include a sample of recent transactions for context
    categories: userContext.categories,
    transactions: userContext.cfTransactions ? 
      userContext.cfTransactions.filter(t => t.forecast_type !== 'A').slice(0, 250).map(t => ({
        id: t.id,
        name: t.title,
        display_name: t.display_name,
        amount: t.amount,
        description: t.description,
        date: t.start,
        category: t.category,
        status: t.status,
        merchant_name: t.merchant,
        frequency: t.frequency2,
      })) : [],
    recentTransactions: userContext.recentTransactions ? 
      userContext.recentTransactions.slice(0, 250).map(t => ({
        id: t.id,
        amount: t.amount,
        description: t.description,
        date: t.date,
        category: t.category
      })) : [],
    upcomingTransactions: userContext.upcomingTransactions ? 
    userContext.upcomingTransactions.slice(0, 250).map(t => ({
        id: t.id,
        name: t.title,
        display_name: t.display_name,
        amount: t.amount,
        description: t.description,
        date: t.start,
        category: t.category,
        status: t.status,
        merchant_name: t.merchant,
        frequency: t.frequency2,
        daysUntil: t.daysUntil
      })) : [],
    plaidTransactions: userContext.plaidTransactions ? 
    userContext.plaidTransactions.slice(0, 250).map(t => ({
        transaction_id: t.transaction_id,
        amount: t.adjusted_amount,
        name: t.name,
        display_name: t.display_name,
        description: t.description,
        date: t.date,
        category: t.adjusted_category,
        status: t.status
      })) : [],
    breakdown: userContext.breakdown,
    balances: userContext.balances,
    available: userContext.available,
  };

  return summary;
}

/**
 * Execute tool calls and get final response:
 * - executes requested tools via functionMap[name](args, ctx)
 * - returns the final answer without corrupting the original message array
 */
async function executeToolCalls(originalMessages, toolCalls, ctx) {
  // Execute requested tools and collect results
  const toolResults = [];
  
  for (const toolCall of toolCalls) {
    const { name, arguments: argsJson } = toolCall.function || {};
    let args = {};
    try { args = argsJson ? JSON.parse(argsJson) : {}; } catch { args = {}; }

    const toolFn = functionMap[name];
    if (!toolFn) {
      toolResults.push({ name, error: `Unknown tool: ${name}` });
      continue;
    }

    try {
      const result = await toolFn(args, ctx);
      
      // Truncate tool responses to prevent massive message growth
      let toolContent = JSON.stringify(result ?? {});
      if (toolContent.length > 13000) { // Increased limit to 13KB for tool responses
        toolContent = toolContent.substring(0, 13000) + '..."_truncated":true}';
        console.log('Tool response truncated from', JSON.stringify(result ?? {}).length, 'to', toolContent.length, 'bytes');
      }
      
      toolResults.push({ name, result: result, content: toolContent });
    } catch (err) {
      toolResults.push({ name, error: err?.message || 'Tool execution failed' });
    }
  }

  // Create a clean message array for the final response
  const cleanMessages = [...originalMessages];
  
  // Add a summary of tool results as a user message
  const toolSummary = toolResults.map(tr => {
    if (tr.error) return `Error in ${tr.name}: ${tr.error}`;
    try {
      const content = JSON.parse(tr.content);
      if (content.error) return `Error in ${tr.name}: ${content.error}`;
      if (Array.isArray(content) && content.length > 0) {
        return `Retrieved ${content.length} items from ${tr.name}`;
      }
      return `Successfully retrieved data from ${tr.name}`;
    } catch {
      return `Successfully retrieved data from ${tr.name}`;
    }
  });
  
  cleanMessages.push({
    role: 'user',
    content: `I have executed the following tools: ${toolSummary.join('. ')}. Please provide a comprehensive answer based on this data.`
  });
  
  // Get final response from Azure OpenAI
  try {
    const finalResponse = await queryAzureOpenAI(cleanMessages, { tools: functionSchemas, tool_choice: 'none' });
    const choice = finalResponse?.choices?.[0];
    return { content: choice?.message?.content || '', raw: finalResponse };
  } catch (error) {
    console.log('Final response with tool results failed:', error.message);
    // Return a summary of what we found from the tools
    const summary = toolResults.map(tr => {
      if (tr.error) return `Error in ${tr.name}: ${tr.error}`;
      try {
        const content = JSON.parse(tr.content);
        if (content.error) return `Error in ${tr.name}: ${content.error}`;
        if (Array.isArray(content) && content.length > 0) {
          return `Found ${content.length} items from ${tr.name}`;
        }
        return `Successfully retrieved data from ${tr.name}`;
      } catch {
        return `Successfully retrieved data from ${tr.name}`;
      }
    });
    return { 
      content: `I executed the requested tools with the following results: ${summary.join('. ')}. However, I encountered an issue generating the final response. Please try asking your question again.`, 
      raw: null 
    };
  }
}

// ----------------------------
// 🧠 Chat with memory + tools (functionMap.js)
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
    const accountid = req.body.accountid;
    const { token, userId, authHeader } = extractAuthFromRequest(req);
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

    let dataMessage;
    // Prefer explicit context sent in body
    let userContext = extractContextFromBody(req) || {};

    // If no explicit context or we need to preload additional data, we can preload some via tools (direct calls through functionMap)
    if (!userContext || Object.keys(userContext).length === 0 || !userContext.selectedAccounts) {
      if (userId && token) {
        try {
          const ctx = { userId, authHeader };
          
          // First get user data
          const userData = await functionMap.getUserData({ userId, token }, ctx);
          console.log('User data retrieved:', userData);

          const upcomingEnd = moment().add(14, 'days').format('YYYY-MM-DD');
          const currentDate = moment(moment().format('YYYY-MM-DD') + 'T00:00:00').format('YYYY-MM-DD');
          const recentStart = moment().subtract(3, 'months').format('YYYY-MM-DD');
          const recentEnd = moment().add(1, 'days').format('YYYY-MM-DD');
          
          // Then use user data to get selected accounts
          const selectedAccounts = await functionMap.getSelectedKeacastAccounts({ 
            userId, 
            token, 
            body: {
              "currentDate": currentDate,
              "forecastType": "F",
              "recentStart": recentStart,
              "recentEnd": recentEnd,
              "page": "layout",
              "position": 0,
              selectedAccounts: [accountid],
              upcomingEnd: upcomingEnd,
              user: userData
            } 
          }, ctx);
          console.log('Selected accounts retrieved:', selectedAccounts);

                     // Merge transactions from both sources (request body and selected accounts)
           const bodyTransactions = userContext.transactions || [];
           const accountTransactions = selectedAccounts[0]?.cfTransactions || [];
           const allTransactions = [...bodyTransactions, ...accountTransactions];
           
           console.log('Chat endpoint: Merged transactions - Body:', bodyTransactions.length, 'Account:', accountTransactions.length, 'Total:', allTransactions.length);
           
           userContext = {
             userData: userData || {},
             selectedAccounts: selectedAccounts || [],
             accounts: [], // keep for backward compatibility
             categories: selectedAccounts[0]?.categories || userContext.categories || [], // fill if you expose a categories tool in functionMap
             shoppingList: selectedAccounts[0]?.shoppingList || userContext.shoppingList || [], // fill if you expose a shoppingList tool in functionMap
             cfTransactions: allTransactions,
             upcomingTransactions: selectedAccounts[0]?.upcoming || [],
             plaidTransactions: selectedAccounts[0]?.plaidTransactions || [],
             recentTransactions: selectedAccounts[0]?.recents || [],
             breakdown: selectedAccounts[0]?.breakdown || [],
             balances: selectedAccounts[0]?.balances || [],
             available: selectedAccounts[0]?.available || [],
           };
          console.log('Chat endpoint: Preloaded user context via functionMap.');
          dataMessage = 'Chat endpoint: Preloaded user context via functionMap.';
        } catch (err) {
          console.warn('Chat endpoint: Preload via functionMap failed:', err?.message);
          dataMessage = err?.message;
        }
      } else {
        console.log('Chat endpoint: Skipping preload (missing userId or token)');
        dataMessage = 'Chat endpoint: Skipping preload (missing userId or token)';
      }
    }

    // Create a more intelligent context summary
    const contextSummary = createContextSummary(userContext);

    // const plaidContext = `Here is my transaction history: ${JSON.stringify(contextSummary.plaidTransactions, null, 2)}`;
    // const upcomingContext = `Here is my upcoming transactions: ${JSON.stringify(contextSummary.upcomingTransactions, null, 2)}`;
    // const forecastedContext = `Here is my forecasted transactions: ${JSON.stringify(contextSummary.transactions, null, 2)}`;
    const completeContext = `
        Use this context to answer the user's question.
        Here are my account transactions split by historical, upcoming, and forecasted context:
        ${JSON.stringify(contextSummary.transactions, null, 2)}
        ${JSON.stringify(contextSummary.upcomingTransactions, null, 2)}
        ${JSON.stringify(contextSummary.forecastedTransactions, null, 2)}
        Here are my account balances:
        ${JSON.stringify(contextSummary.balances, null, 2)}
        Here is my account available balance:
        ${JSON.stringify(contextSummary.available, null, 2)}
        Here is my user's first name:
        ${JSON.stringify(contextSummary.userData.first_name, null, 2)}
        Here is my user's last name:
        ${JSON.stringify(contextSummary.userData.last_name, null, 2)}
        Here is my user's email:
        ${JSON.stringify(contextSummary.userData.email, null, 2)}
        Here is my user's selected accounts with relevant account details like name, account type, balance, available, current, credit limit, forecasted, bank account name, and institution name:
        ${JSON.stringify(contextSummary.selectedAccounts, null, 2)}
    `
    // const recentContext = `Here is my recent transactions: ${JSON.stringify(contextSummary.recentTransactions, null, 2)}`;
    // const breakdownContext = `Here is my category spending breakdown: ${JSON.stringify(contextSummary.breakdown, null, 2)}`;
    const contextArray = [completeContext];

    const baseSystem = `You are the Keacast Assistant, a knowledgeable and proactive personal finance forecasting tool developed by Parrot Insight LLC. Keacast is designed to help users manage their finances with foresight and clarity, going beyond traditional budgeting.

    Core purpose:
    - Forecast future cash flow and account balances day-by-day, week-by-week, or month-by-month, so users can anticipate upcoming financial scenarios.
    - Track both cleared and uncleared transactions, helping users understand their true available balance—not just what appears on paper.
    - Present intuitive visualizations—such as calendar-based forecasts and category-based breakdowns (e.g., waterfall charts)—to reveal spending patterns, upcoming obligations, and opportunities to optimize.
    - Empower users to plan with confidence, avoid surprises like overdrafts, and make informed decisions rooted in real-time data.
    - Provide clarity, structure, and peace of mind without requiring complicated spreadsheets or manual updates.

    Tone & Style:
    - Clear, empathetic, and supportive
    - Professional yet approachable
    - Insightful when explaining forecasting logic, actionable when guiding users

    When interacting, always ground responses in the principles of cash-flow forecasting, clarity, and proactive planning (no more than 600 characters). If the user asks about short-term or long-term financial planning tasks, explain how Keacast can help, referencing forecasting, reconciliation, and visualization where relevant.
    
    Review the app here: https://keacast.app/ for more context and information.`;

    // Build message array with memory and clean up long messages
    const messages = [
      { role: 'system', content: baseSystem },
      ...sanitizeMessageArray(history.map(truncateMessage))
    ];

    // Add detailed context as a separate message if we have significant data
    if (userContext && Object.keys(userContext).length > 0) {
      for (let i = 0; i < contextArray.length; i++) {
        if (contextArray[i]) {
          messages.push({
            role: 'user',
            content: contextArray[i]
          });
          console.log('Chat endpoint: Added context message with size:', JSON.stringify(contextArray[i]).length, 'bytes');
          console.log('Chat endpoint: Context includes transactions:', userContext.transactions ? userContext.transactions.length : 0, 'transactions');
        }
      }
    }

    // Add the actual user message
    messages.push({ role: 'user', content: message });

    console.log('Chat endpoint: Calling OpenAI (tools enabled) with', messages.length, 'messages');

    // Check request size before sending to prevent rate limiting
    const requestSize = JSON.stringify(messages).length;
    console.log('Chat endpoint: Request size:', requestSize, 'bytes');
    
    if (requestSize > 500000) { // Increased to 500KB limit to allow more context
      console.warn('Chat endpoint: Request too large, clearing old history');
      // Clear old history to reduce size
      history = history.slice(-15); // Keep only last 15 messages
      messages.splice(1, messages.length - 2); // Keep only system and current user message
      messages.splice(1, 0, ...history.map(truncateMessage));
      
      // Recalculate size after cleanup
      const newSize = JSON.stringify(messages).length;
      console.log('Chat endpoint: After cleanup, new size:', newSize, 'bytes');
    }

    // Function-calling loop (uses functionMap.js)
    const ctx = { userId, authHeader };
    
    // Always try with tools first for data requests, but handle tool calls properly
    let result;
    let error;
    try {
      console.log('Attempting to get response with tools...');
      const responseWithTools = await queryAzureOpenAI(messages, { tools: functionSchemas, tool_choice: 'auto' });
      const choice = responseWithTools?.choices?.[0];
      const msg = choice?.message;
      
      // // If the model wants to call tools, execute them
      // if (msg?.tool_calls && msg.tool_calls.length > 0) {
      //   console.log('Model requested tool calls, executing...');
      //   result = await executeToolCalls(messages, msg.tool_calls, ctx);
      // } else {
      //   // No tool calls needed, use the response directly
      //   result = { content: msg?.content || '', raw: responseWithTools };
      // }
      result = { content: msg?.content || '', raw: responseWithTools };
    } catch (error) {
      console.log('Tool-based response failed, trying direct response...');
      try {
        const directResponse = await queryAzureOpenAI(messages, { tools: functionSchemas, tool_choice: 'none' });
        const choice = directResponse?.choices?.[0];
        result = { content: choice?.message?.content || '', raw: directResponse };
      } catch (directError) {
        console.log('All attempts failed, returning error message');
        result = { content: 'I apologize, but I encountered an error while processing your request. Please try again.', raw: null, error: directError };
      }
    }

    const finalText = result.content || 'Sorry, no response generated.';
    const updatedHistory = [
      ...sanitizeMessageArray(history),
      { role: 'user', content: message },
      { role: 'assistant', content: finalText }
    ].slice(-MAX_MEMORY);

    try {
      await redis.set(sessionKey, JSON.stringify(updatedHistory), 'EX', MEMORY_TTL);
      console.log('Chat endpoint: Saved updated history to Redis');
    } catch (redisError) {
      console.warn('Chat endpoint: Failed to save history to Redis:', redisError.message);
    }

    res.json({
      response: finalText,
      memoryUsed: updatedHistory.length,
      contextLoaded: !!Object.keys(userContext || {}).length,
      dataMessage: dataMessage,
      requestSize: requestSize,
      error: result?.error
    });

  } catch (error) {
    console.error('Chat endpoint error:', error);
    console.error('Error stack:', error.stack);
    
    // Handle specific error types
    if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'Service temporarily unavailable - Redis connection failed' });
    }
    if (error.response?.status === 401) {
      return res.status(401).json({ error: 'Azure OpenAI authentication failed' });
    }
    if (error.response?.status === 400) {
      return res.status(400).json({ 
        error: 'Azure OpenAI request failed', 
        details: error.response?.data?.error?.message || 'Invalid request format',
        suggestion: 'Check API configuration and request format'
      });
    }
    if (error.response?.status === 429) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    
    // Generic error for other cases
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message || 'Unknown error occurred'
    });
  }
};

// ----------------------------
// 📊 Summarize with context memory (+ optional tools)
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

    const { token, userId, authHeader } = extractAuthFromRequest(req);
    let userContext = extractContextFromBody(req) || {};

    // (Optional) Preload via functionMap if missing
    if (!userContext || Object.keys(userContext).length === 0) {
      if (userId && token) {
        // try {
        //   const ctx = { userId, authHeader };
        //   const accounts = await functionMap.getUserAccounts({ userId }, ctx);
        //   userContext = { accounts: accounts || [], categories: [], shoppingList: [] };
        // } catch (err) {
        //   console.warn('Analyze transactions: Preload via functionMap failed:', err?.message);
        // }
      }
    }

    const systemPrompt = `You are the Keacast Assistant, a knowledgeable and proactive personal finance forecasting tool developed by Parrot Insight LLC. Your purpose is to help users gain clarity, confidence, and foresight into their cash flow habits. You combine real-time transactions with forecasting to help users plan ahead, avoid surprises, and make better financial decisions.

    Give a warm welcome to the user and provide a space for the user to ask financial and Keacast related questions.

    When given a list of transactions, generate a concise, digestible summary (no more than 325 characters). The summary must include:
    - Total income and total spending
    - Forecasted income and spending
    - Forecasted disposable income for the next 30 days
    - Any high-value or unusual transactions
    - Behavioral patterns or habits
    - Actionable suggestions for improvement

    if there are no transactions, return a message that is nice and welcoming, and provides a space for the user to ask financial and Keacast related questions.

    Tone: clear, empathetic, professional, supportive, and future-focused. Always frame insights around Keacast’s strengths: forecasting, reconciliation, and visualization.

    At the end of the summary, include relevant follow-up questions that guide the user toward improving their financial wellness through Keacast’s forecasting features. Avoid unnecessary formatting, symbols, or filler (such as “...”).`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...sanitizeMessageArray(history),
      { role: 'user', content: `Here are the latest transactions:\n${JSON.stringify(transactions)}` }
    ];

    console.log('Analyze transactions: Calling OpenAI (tools enabled) with', messages.length, 'messages');

    // Use the new executeToolCalls function for tool execution
    const ctx = { userId, authHeader };
    let result;
    try {
      // Try to get a response with tools first
      const responseWithTools = await queryAzureOpenAI(messages, { tools: functionSchemas, tool_choice: 'auto' });
      const choice = responseWithTools?.choices?.[0];
      const msg = choice?.message;
      
      // If the model wants to call tools, execute them
      // if (msg?.tool_calls && msg.tool_calls.length > 0) {
      //   console.log('Model requested tool calls, executing...');
      //   result = await executeToolCalls(messages, msg.tool_calls, ctx);
      // } else {
      //   // No tool calls needed, use the response directly
      //   result = { content: msg?.content || '', raw: responseWithTools };
      // }
      result = { content: msg?.content || '', raw: responseWithTools };
    } catch (error) {
      console.log('Tool-based response failed, trying direct response...');
      try {
        const directResponse = await queryAzureOpenAI(messages, { tools: functionSchemas, tool_choice: 'none' });
        const choice = directResponse?.choices?.[0];
        result = { content: choice?.message?.content || '', raw: directResponse };
      } catch (directError) {
        console.log('All attempts failed, returning error message');
        result = { content: 'I apologize, but I encountered an error while processing your request. Please try again.', raw: null, error: directError };
      }
    }

    const finalText = result.content || '';
    const rawText = result.raw;
    const updatedHistory = [
      ...sanitizeMessageArray(history),
      { role: 'user', content: `Here is my user's data:\n${JSON.stringify(userData)}\n 
      
      Here are the latest transactions:\n${JSON.stringify(transactions)}` },
      { role: 'assistant', content: finalText }
    ].slice(-MAX_MEMORY);

    try {
      await redis.set(sessionKey, JSON.stringify(updatedHistory), 'EX', MEMORY_TTL);
      console.log('Analyze transactions: Saved updated history to Redis');
    } catch (redisError) {
      console.warn('Analyze transactions: Failed to save history to Redis:', redisError.message);
    }

    // Enforce response length limit of 300 characters (API contract)
    const limitedInsights = truncateText(finalText, 300);
    res.json({ insights: finalText, raw: rawText, error: result?.error });

  } catch (error) {
    console.error('Analyze transactions error:', error);
    console.error('Error stack:', error.stack);
    
    // Handle specific error types
    if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'Service temporarily unavailable - Redis connection failed' });
    }
    if (error.response?.status === 401) {
      return res.status(401).json({ error: 'Azure OpenAI authentication failed' });
    }
    if (error.response?.status === 400) {
      return res.status(400).json({ 
        error: 'Azure OpenAI request failed', 
        details: error.response?.data?.error?.message || 'Invalid request format',
        suggestion: 'Check API configuration and request format'
      });
    }
    if (error.response?.status === 429) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    
    // Generic error for other cases
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message || 'Unknown error occurred'
    });
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
        sessionKey: sessionKey,
        note: 'This will help prevent rate limiting from large conversation history'
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

// Add a new endpoint to check conversation size
exports.checkHistorySize = async (req, res) => {
  try {
    const sessionKey = buildSessionKey(req);
    const historyData = await redis.get(sessionKey);
    const history = historyData ? JSON.parse(historyData) : [];
    
    const totalSize = JSON.stringify(history).length;
    const messageCount = history.length;
    
    res.json({
      sessionKey,
      messageCount,
      totalSizeBytes: totalSize,
      totalSizeKB: Math.round(totalSize / 1024 * 100) / 100,
      isLarge: totalSize > 500000,
      recommendation: totalSize > 500000 ? 'Consider clearing history to prevent rate limiting' : 'Size is acceptable'
    });
  } catch (error) {
    console.error('Check history size error:', error);
    res.status(500).json({ error: 'Failed to check history size' });
  }
};

// Add a new endpoint to clear specific session by sessionId
exports.clearSessionById = async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    
    const sessionKey = `session:${sessionId}`;
    console.log('Clear session by ID: Clearing session key:', sessionKey);
    
    try {
      await redis.del(sessionKey);
      console.log('Clear session by ID: Successfully cleared session:', sessionId);
      res.json({
        success: true,
        message: `Session ${sessionId} cleared successfully`,
        sessionKey: sessionKey,
        note: 'This will resolve Azure OpenAI message format errors'
      });
    } catch (redisError) {
      console.warn('Clear session by ID: Redis delete failed:', redisError.message);
      res.status(500).json({ error: 'Failed to clear session', details: redisError.message });
    }
  } catch (error) {
    console.error('Clear session by ID error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Add a new endpoint to repair corrupted sessions
exports.repairSession = async (req, res) => {
  try {
    const sessionKey = buildSessionKey(req);
    console.log('Repair session: Attempting to repair session key:', sessionKey);
    
    try {
      const historyData = await redis.get(sessionKey);
      if (!historyData) {
        return res.json({
          success: true,
          message: 'Session is already clean (no history)',
          sessionKey: sessionKey
        });
      }
      
      const history = JSON.parse(historyData);
      const originalLength = history.length;
      const sanitizedHistory = sanitizeMessageArray(history);
      const newLength = sanitizedHistory.length;
      
      if (originalLength !== newLength) {
        // Save the sanitized history
        await redis.set(sessionKey, JSON.stringify(sanitizedHistory), 'EX', MEMORY_TTL);
        console.log('Repair session: Repaired session, removed', originalLength - newLength, 'corrupted messages');
        
        res.json({
          success: true,
          message: `Session repaired successfully`,
          sessionKey: sessionKey,
          originalMessageCount: originalLength,
          newMessageCount: newLength,
          removedCorruptedMessages: originalLength - newLength
        });
      } else {
        res.json({
          success: true,
          message: 'Session is already clean',
          sessionKey: sessionKey,
          messageCount: newLength
        });
      }
    } catch (redisError) {
      console.warn('Repair session: Redis operation failed:', redisError.message);
      res.status(500).json({ error: 'Failed to repair session', details: redisError.message });
    }
  } catch (error) {
    console.error('Repair session error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
