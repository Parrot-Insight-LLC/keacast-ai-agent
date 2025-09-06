// controllers/openaiController.js
const redis = require('../services/redisService');
const { queryAzureOpenAI, functionSchemas } = require('../services/openaiService'); // must support tools
const { functionMap } = require('../tools/functionMap'); // <-- use functionMap.js
const moment = require('moment');
const momentTimezone = require('moment-timezone');
const MEMORY_TTL = 604800; // 1 week
const MAX_MEMORY = 10; // reduce memory context size to prevent large requests
const MAX_MESSAGE_LENGTH = 20000; // increased limit for individual message length
const SYSTEM_PROMPT_MAX_LENGTH = 15000; // separate limit for system prompts

function buildSessionKey(req) {
  // Check multiple sources for sessionId in order of preference
  const sessionId = req.body.sessionId || 
                   req.query.sessionId || 
                   req.headers['x-session-id'] ||
                   req.user?.id || 
                   'anonymous';
  return `session:${sessionId}`;
}

function truncateText(text, maxChars) {
  if (text === undefined || text === null) return '';
  const str = String(text).trim();
  if (str.length <= maxChars) return str;
  return str.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function createIntelligentTruncation(data, maxSize) {
  if (!data || typeof data !== 'object') {
    const str = JSON.stringify(data);
    return str.length > maxSize ? str.substring(0, maxSize - 50) + '..."_truncated":true}' : str;
  }
  
  const truncated = { ...data };
  
  // Priority: Keep essential account info, limit transaction arrays
  const essentialFields = ['accountid', 'accountname', 'account_type', 'balance', 'available', 'current', 'credit_limit', 'forecasted'];
  const transactionFields = ['cfTransactions', 'plaidTransactions', 'upcoming', 'recents'];
  
  // Always preserve essential fields
  const essential = {};
  essentialFields.forEach(field => {
    if (data[field] !== undefined) {
      essential[field] = data[field];
    }
  });
  
  // Add limited transaction data
  transactionFields.forEach(field => {
    if (data[field] && Array.isArray(data[field])) {
      // Keep only the most recent/important transactions
      essential[field] = data[field].slice(0, 20).map(t => ({
        transactionid: t.transactionid || t.transaction_id,
        title: t.title || t.name,
        amount: t.amount,
        start: t.start || t.date,
        category: t.category,
        status: t.status
      }));
    }
  });
  
  // Add balance data (limited)
  if (data.balances && Array.isArray(data.balances)) {
    essential.balances = data.balances.slice(0, 30).map(b => ({
      date: b.date,
      amount: b.amount,
      status: b.status
    }));
  }
  
  // Add categories if available
  if (data.categories) {
    essential.categories = data.categories;
  }
  
  essential._truncated = true;
  essential._originalSize = JSON.stringify(data).length;
  
  let result = JSON.stringify(essential);
  
  // If still too large, further reduce transaction counts
  if (result.length > maxSize) {
    transactionFields.forEach(field => {
      if (essential[field]) {
        essential[field] = essential[field].slice(0, 10);
      }
    });
    if (essential.balances) {
      essential.balances = essential.balances.slice(0, 15);
    }
    result = JSON.stringify(essential);
  }
  
  // Final fallback - simple truncation
  if (result.length > maxSize) {
    result = result.substring(0, maxSize - 50) + '..."_truncated":true}';
  }
  
  return result;
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

// Function to get timezone from coordinates using a simple approximation
function getTimezoneFromCoordinates(latitude, longitude) {
  // Simple timezone approximation based on longitude
  // This is a basic implementation - for production, consider using a proper timezone API
  const timezoneOffset = Math.round(longitude / 15);
  
  // Map common timezone offsets to timezone names
  const timezoneMap = {
    '-12': 'Pacific/Auckland', // UTC-12
    '-11': 'Pacific/Midway',   // UTC-11
    '-10': 'Pacific/Honolulu', // UTC-10
    '-9': 'America/Anchorage', // UTC-9
    '-8': 'America/Los_Angeles', // UTC-8
    '-7': 'America/Denver',    // UTC-7
    '-6': 'America/Chicago',   // UTC-6
    '-5': 'America/New_York',  // UTC-5
    '-4': 'America/Halifax',   // UTC-4
    '-3': 'America/Sao_Paulo', // UTC-3
    '-2': 'Atlantic/South_Georgia', // UTC-2
    '-1': 'Atlantic/Azores',   // UTC-1
    '0': 'Europe/London',      // UTC+0
    '1': 'Europe/Paris',       // UTC+1
    '2': 'Europe/Kiev',        // UTC+2
    '3': 'Europe/Moscow',      // UTC+3
    '4': 'Asia/Dubai',         // UTC+4
    '5': 'Asia/Tashkent',      // UTC+5
    '6': 'Asia/Almaty',        // UTC+6
    '7': 'Asia/Bangkok',       // UTC+7
    '8': 'Asia/Shanghai',      // UTC+8
    '9': 'Asia/Tokyo',         // UTC+9
    '10': 'Australia/Sydney',  // UTC+10
    '11': 'Pacific/Guadalcanal', // UTC+11
    '12': 'Pacific/Auckland'   // UTC+12
  };
  
  return timezoneMap[timezoneOffset.toString()] || 'UTC';
}

// Function to get current date in user's timezone
function getCurrentDateInTimezone(location) {
  if (!location || typeof location.latitude !== 'number' || typeof location.longitude !== 'number') {
    // Fallback to UTC if no valid location provided
    console.log('No valid location provided, using UTC');
    return moment().utc().format('YYYY-MM-DD');
  }
  
  try {
    const timezone = getTimezoneFromCoordinates(location.latitude, location.longitude);
    console.log(`Calculated timezone for coordinates (${location.latitude}, ${location.longitude}): ${timezone}`);
    
    const currentDate = momentTimezone.tz(timezone).format('YYYY-MM-DD');
    console.log(`Current date in ${timezone}: ${currentDate}`);
    
    return currentDate;
  } catch (error) {
    console.warn('Error calculating timezone, falling back to UTC:', error.message);
    return moment().utc().format('YYYY-MM-DD');
  }
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
      ...(userContext.userData.firstname && { firstname: userContext.userData.firstname }),
      ...(userContext.userData.lastname && { lastname: userContext.userData.lastname }),
      ...(userContext.userData.email && { email: userContext.userData.email })
    } : { hasUserData: false },
    selectedAccounts: userContext.selectedAccounts ? {
      count: userContext.selectedAccounts.length,
      // Include key account details
      accounts: userContext.selectedAccounts.map(acc => ({
        accountid: acc.accountid,
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
    categories: userContext.categories && Array.isArray(userContext.categories) ? userContext.categories : [],
    transactions: userContext.cfTransactions && Array.isArray(userContext.cfTransactions) ? 
      userContext.cfTransactions.filter(t => t.forecast_type !== 'A').slice(0, 250).map(t => ({
        transaction_id: t.transactionid,
        name: t.title,
        display_name: t.display_name,
        amount: t.amount,
        description: t.description,
        date: moment(t.start).format('MMM DD, YYYY'),
        category: t.category,
        status: t.status,
        merchant_name: t.merchant,
        frequency: t.frequency2,
      })) : [],
    // recentTransactions: userContext.recentTransactions && Array.isArray(userContext.recentTransactions) ? 
    //   userContext.recentTransactions.slice(0, 250).map(t => ({
    //     id: t.tid,
    //     amount: t.amount,
    //     description: t.description,
    //     date: moment(t.start).format('MMM DD, YYYY'),
    //     category: t.category
    //   })) : [],
    upcomingTransactions: userContext.upcomingTransactions && Array.isArray(userContext.upcomingTransactions) ? 
    userContext.upcomingTransactions.slice(0, 250).map(t => ({
        transaction_id: t.transactionid,
        name: t.title,
        display_name: t.display_name,
        amount: t.amount,
        description: t.description,
        date: moment(t.start).format('MMM DD, YYYY'),
        category: t.category,
        status: t.status,
        merchant_name: t.merchant,
        frequency: t.frequency2,
        daysUntil: t.daysUntil
      })) : [],
    plaidTransactions: userContext.plaidTransactions && Array.isArray(userContext.plaidTransactions) ? 
    userContext.plaidTransactions.slice(0, 250).map(t => ({
        transaction_id: t.transaction_id,
        amount: t.adjusted_amount,
        name: t.name,
        display_name: t.display_name,
        description: t.description,
        date: moment(t.date).format('MMM DD, YYYY'),
        category: t.adjusted_category,
        status: t.status
      })) : [],
    possibleRecurringTransactions: userContext.possibleRecurringTransactions ? 
    userContext.possibleRecurringTransactions : [],
    breakdown: userContext.breakdown && Array.isArray(userContext.breakdown) ? userContext.breakdown : [],
    balances: userContext.balances && Array.isArray(userContext.balances) ? userContext.balances : [],
    availableBalance: userContext.available && Array.isArray(userContext.available) ? userContext.available : [],
    forecastedBalance: userContext.balances.find((balance) => moment(balance.date, 'YYYY/MM/DD').format('YYYY-MM-DD') === moment(userContext.currentDate).format('YYYY-MM-DD')).amount
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
      if (toolContent.length > 10000) { // Reduced limit to 10KB for tool responses
        // Try to create a more intelligent truncation
        toolContent = createIntelligentTruncation(result, 10000);
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
      
      // Special handling for createTransaction
      if (tr.name === 'createTransaction') {
        if (content.message && content.message.includes('successfully created')) {
          return `Successfully created transaction: ${content.data?.id ? `ID ${content.data.id}` : 'Transaction created'}. ${content.message}`;
        } else if (content.error) {
          return `Failed to create transaction: ${content.error}`;
        } else {
          return `Transaction creation completed: ${content.message || 'Transaction processed'}`;
        }
      }
      
      // Handle other tools
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
    content: `I have executed the following tools: ${toolSummary.join('. ')}. Please provide a comprehensive answer based on this data. If any transactions were created, make sure to clearly confirm the creation to the user with relevant details. IMPORTANT: Always respond with markdown formatting.`
  });
  
  // Get final response from Azure OpenAI
  try {
    console.log('Getting final response after tool execution with', cleanMessages.length, 'messages');
    
    // Check message size to prevent rate limiting
    const messageSize = JSON.stringify(cleanMessages).length;
    console.log('Message array size:', messageSize, 'bytes');
    
    if (messageSize > 750000) {
      console.log('Message array too large, truncating for final response');
      // Keep only the most recent messages for the final response
      const truncatedMessages = cleanMessages.slice(-5); // Keep last 5 messages
      console.log('Truncated to', truncatedMessages.length, 'messages');
      const finalResponse = await queryAzureOpenAI(truncatedMessages, { tools: functionSchemas, tool_choice: 'none' });
      const choice = finalResponse?.choices?.[0];
      console.log('Final response received:', !!choice?.message?.content, 'Content length:', choice?.message?.content?.length || 0);
      return { content: choice?.message?.content || '', raw: finalResponse };
    } else {
      const finalResponse = await queryAzureOpenAI(cleanMessages, { tools: functionSchemas, tool_choice: 'none' });
      const choice = finalResponse?.choices?.[0];
      console.log('Final response received:', !!choice?.message?.content, 'Content length:', choice?.message?.content?.length || 0);
      return { content: choice?.message?.content || '', raw: finalResponse };
    }
  } catch (error) {
    console.log('Final response with tool results failed:', error.message);
    console.log('Error details:', error.response?.data || error);
    // Return a summary of what we found from the tools
    const summary = toolResults.map(tr => {
      if (tr.error) return `Error in ${tr.name}: ${tr.error}`;
      try {
        const content = JSON.parse(tr.content);
        if (content.error) return `Error in ${tr.name}: ${content.error}`;
        
        // Special handling for createTransaction
        if (tr.name === 'createTransaction') {
          if (content.message && content.message.includes('successfully created')) {
            return `Successfully created transaction: ${content.data?.id ? `ID ${content.data.id}` : 'Transaction created'}. ${content.message}`;
          } else if (content.error) {
            return `Failed to create transaction: ${content.error}`;
          } else {
            return `Transaction creation completed: ${content.message || 'Transaction processed'}`;
          }
        }
        
        // Handle other tools
        if (Array.isArray(content) && content.length > 0) {
          return `Found ${content.length} items from ${tr.name}`;
        }
        return `Successfully retrieved data from ${tr.name}`;
      } catch {
        return `Successfully retrieved data from ${tr.name}`;
      }
    });
    // Create a more user-friendly response based on the tool results
    let userFriendlyResponse = '';
    
    // Check if we have transaction creation results
    const transactionResults = toolResults.filter(tr => tr.name === 'createTransaction');
    if (transactionResults.length > 0) {
      const transactionResult = transactionResults[0];
      try {
        const content = JSON.parse(transactionResult.content);
        if (content.message && content.message.includes('successfully created')) {
          userFriendlyResponse = `## ✅ Transaction Created Successfully!\n\n**${content.message}**`;
          if (content.data?.id) {
            userFriendlyResponse += `\n\n**Transaction ID:** ${content.data.id}`;
          }
        } else {
          userFriendlyResponse = `## Transaction Processed\n\n**${content.message || 'Transaction has been handled.'}**`;
        }
      } catch {
        userFriendlyResponse = '## ✅ Transaction Processed\n\n**I have successfully processed your transaction request.**';
      }
    } else {
      // For other tools, provide a generic success message
      userFriendlyResponse = `## Action Completed\n\n**${summary.join('. ')}**`;
    }
    
    return { 
      content: userFriendlyResponse, 
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
    // Extract location data from request body
    const location = req.body?.location;
    console.log('Location data received:', location);

    // Calculate current date based on user's timezone
    const currentDate = getCurrentDateInTimezone(location);
    console.log('Using current date:', currentDate);
    const upcomingEnd = moment(currentDate).add(14, 'days').format('YYYY-MM-DD');
    const recentStart = moment(currentDate).subtract(3, 'months').format('YYYY-MM-DD');
    const recentEnd = moment(currentDate).add(1, 'days').format('YYYY-MM-DD');
    const { token, userId, authHeader } = extractAuthFromRequest(req);
    console.log('Chat endpoint: Session key:', sessionKey, 'User ID:', userId, 'Account ID:', accountid);

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

    // Use context from request body if provided
    if (!userContext || Object.keys(userContext).length === 0) {
      console.log('Chat endpoint: No explicit context provided in request body');
      dataMessage = 'Chat endpoint: No explicit context provided - AI will use tools as needed';
    } else {
      console.log('Chat endpoint: Using explicit context from request body');
      dataMessage = 'Chat endpoint: Using explicit context from request body';
    }

    // Create a more intelligent context summary
    const contextSummary = createContextSummary(userContext);

    // Create context message based on available data or provide guidance for tool usage
    let contextMessage = '';
    
    if (userContext && Object.keys(userContext).length > 0 && contextSummary.hasData) {
      // If we have explicit context data, provide it to the AI
      contextMessage = `
        Here is the user's financial context data to help answer their questions:
        
        User Information:
        - First Name: ${contextSummary.userData?.firstname || 'Not provided'}
        - Last Name: ${contextSummary.userData?.lastname || 'Not provided'}
        - Email: ${contextSummary.userData?.email || 'Not provided'}
        
        Account Information:
        - Selected Accounts: ${contextSummary.selectedAccounts?.count || 0} accounts
        - Available Balance: ${JSON.stringify(contextSummary.availableBalance || [])}
        - Forecasted Balance: ${contextSummary.forecastedBalance || 'Not available'}
        
        Transaction Data:
        - Historical Transactions: ${contextSummary.dataCounts?.transactions || 0} transactions
        - Upcoming Transactions: ${contextSummary.dataCounts?.upcomingTransactions || 0} transactions
        - Plaid Transactions: ${contextSummary.dataCounts?.plaidTransactions || 0} transactions
        
        Categories: ${contextSummary.categories?.length || 0} categories available
        Account Balances: ${contextSummary.balances?.length || 0} balance records
        
        Use this information to provide personalized financial advice and insights. Always warn users about potential negative balances and help them make informed financial decisions.
      `;
    } else {
      // If no context data, provide guidance on using tools
      contextMessage = `
        IMPORTANT: You have access to financial tools and session context that allows you to help users without asking for additional information:
        
        CURRENT SESSION CONTEXT:
        - User ID: ${userId || 'Not available'}
        - Account ID: ${accountid || 'Not available'}
        - Authentication: ${token ? 'Available' : 'Not available'}
        - Location: ${location || 'Not available'}
        - currentDate: ${currentDate || 'Not available'}
        - upcomingEnd: ${upcomingEnd || 'Not available'}
        - recentStart: ${recentStart || 'Not available'}
        - recentEnd: ${recentEnd || 'Not available'}
        
        CRITICAL: When users ask about "their" transactions, balances, or account information, you should immediately use the available tools with the session context. DO NOT ask the user which account they want - use the default account ID from the session context.
        
        Available Tools (most can use session account automatically):
        - getUserData: Get user profile information
        - getSelectedKeacastAccounts: Get comprehensive account data including transactions, balances, and account details. Data is automatically optimized for performance (max 100 transactions per category, 6 months history + 12 months future balances).
        - getBalances: Get account balance information (automatically uses session account if accountId not specified)
        - createTransaction: Create new financial forecasts or transactions (uses session account)
        
        USAGE EXAMPLES:
        - User asks "What's my balance?" → Call getBalances() immediately accountId is needed
        - User asks "Show my recent transactions" → Call getSelectedKeacastAccounts() immediately accountId, currentDate, upcomingEnd, recentStart, recentEnd needed
        - User asks "What transactions do I have coming up?" → getSelectedKeacastAccounts() immediately accountId, currentDate, upcomingEnd, recentStart, recentEnd needed
        - User ask "What is my forecasted balance?" → getSelectedKeacastAccounts() immediately accountId, currentDate, upcomingEnd, recentStart, recentEnd needed
        - User asks "What is my account details?" → getSelectedKeacastAccounts() immediately accountId, currentDate, upcomingEnd, recentStart, recentEnd needed
        - User asks "Can I add a new transaction?" → createTransaction() immediately accountId needed
        - User asks "Can I spend money on something?" → getSelectedKeacastAccounts() immediately accountId, currentDate, upcomingEnd, recentStart, recentEnd needed
        
        Always use tools proactively to get the data needed to answer user questions. Focus on:
        - Cash flow forecasting and balance predictions
        - Transaction analysis and categorization  
        - Budgeting and financial planning
        - Warning about potential negative balances
        - Helping create financial forecasts
        - Helping the user make informed decisions and guide them towards a financially secure future.
      `;
    }
    
    const contextArray = contextMessage.trim() ? [contextMessage] : [];

    const baseSystem = `You are the Keacast (pronunciation: kee-cast) Assistant, a knowledgeable and proactive personal finance forecasting tool developed by Parrot Insight LLC. Keacast is designed to help users manage their finances with foresight and clarity, going beyond traditional budgeting. You can refer to yourself as the Kea (pronunciation: kee) assistant. Keacast is based on the Kea Parrot and it's predictive intelligence combined with a calendar-based forecasting system hince Keacast. Always respond with markdown formatting.

    CRITICAL INSTRUCTION: You have access to financial tools that can automatically use the user's session context (including their account ID). When users ask about "their" financial information (transactions, balances, etc.), immediately use the appropriate tools WITHOUT asking which account they want. The session context provides the default account ID automatically.

    Core purpose:
    - Forecast future cash flow and account balances day-by-day, week-by-week, or month-by-month, so users can anticipate upcoming financial scenarios.
    - Track both cleared and uncleared transactions, helping users understand their true available balance—not just what appears on paper.
    - Pay close attention to transaction and balance dates, and the user's available balance to provide accurate and helpful responses, look at future balances and always warn of negative balances or not having enough money to cover upcoming transactions.
    - User's will check with you to see if they have enough money to cover upcoming transactions, ask if they can afford to do something, I want you to be proactive and making them aware of future negative forecasted balances. We don't want the user to think they have enough money to do something just to fall short in the coming days, weeks, or months.
    - Present intuitive visualizations—such as calendar-based forecasts and category-based breakdowns (e.g., waterfall charts)—to reveal spending patterns, upcoming obligations, and opportunities to optimize.
    - Empower users to plan with confidence, avoid surprises like overdrafts, and make informed decisions rooted in real-time data.
    - Provide clarity, structure, and peace of mind without requiring complicated spreadsheets or manual updates.
    - Provide proactive planning and suggestions to help the user save money, invest, pay off debt, plan for a vacation, retirement, etc.
    - Act as a financial advisor and financial planner to help the user make informed decisions, provide advice, and guide them towards a financially secure future.
    - We want to lead the user to clear financial decisions and actions, not just provide information.
    - When planning for the future, be sure to not recommend actions that won't allow the user to cover their upcoming transactions in the coming days, weeks, months, or years.
    - If the user asks about a specific transaction, be sure to provide the transaction details and the date of the transaction. 
    - If the user asks about a specific balance, be sure to provide date, amount and the relevant transactions on that particular day.
    - If the user asks about a specific category, be sure to provide the category details and the relevant transactions for that category (upcoming, forecasted, and historical).
    - If the user asks about a specific merchant, be sure to provide the merchant details and the relevant transactions.
    - If the user asks about a specific date, be sure to provide the date details and the relevant transactions on that particular day.
    - If the user asks about a specific date range, be sure to provide the date range details and the relevant transactions on that particular day.
    - Future planning consist of things like saving for a vacation, saving for a down payment on a house, saving for retirement, etc. Future planning is NOT advice to spend money on things that will negatively impact the user's financial situation.
    - We are not in the business of telling the user what they can and cannot do, we are in the business of helping them make informed decisions and guide them towards a financially secure future.
    - Always use dollar amounts when providing financial information.
    - Always use the word "disposable" when referring to disposable income.
    - Always use the word "forecasted" when referring to forecasted income and spending.    
    - if referring to an expense or expense transaction always use the word "expense" and not "transaction".
    - if referring to an income or income transaction always use the word "income" and not "transaction".
    - if referring to an expense always use (-) to symbolize negative amounts.
    - Only use ($) when displaying amounts ex: $100, -$100, $1000.00, -$500.00, etc.
    - Only use (-) for negative amounts ex: -$100, -$1000.00, -$500.00, etc., dont use (-) for any other purpose.
    - Use bullet points, numbered lists, bold text, italic text, and other markdown elements when listing transactions, suggestions, balances, etc.
    - Use tables when displaying data in a structured way.

    Things to consider:
    - Today's date is ${currentDate}.
    - Users may feel stress, uncertainty, or guilt around money - the assistant should always respond with reassurance and clarity, never judgement.
    - Recognize  when users are in different life situations (paycheck-to-paycheck, high-income with irregular cash flow, debt payoff, planning for a vacation, retirement, etc.) and tailor advice accordingly.
    - Highlight that forecasting is forward-looking and always frame answers around "what's ahead" and "what's possible" and not just "what's happened".
    - Always explain why something matters, encourage habit-building: logging in daily, reviewing tomorrow's cash flow, planning out scenarios, etc.
    - Always connect insights back to action.
    - Highlight unique features of keacast, transaction netting, scenario planning, recurring transaction detection, insights graphs, and calendar-based forecasting.
    - Summarize numbers in digestible soundbites.
    - Proactively ask gentle follow-up questions that lead users toward deeper understanding and engagement.
    - If users add big one-time transactions, help them see scenarios to understand the impact on their financial situation.
    - When analyzing a user's possible recurring transactions, compare them with the users forecasted transactions and let them know if they have already forecasted for them. We would like the user to add recurring transactions to their forecasts that have not already been added.
    - Also use the possible recurring transactions to help the user understand their financial situation and help them make informed decisions.
    - When creating transactions using the createTransaction tool, always provide clear confirmation to the user that their transaction has been successfully created. Include details like the transaction name, amount, frequency (if recurring), and any relevant dates. Make the user feel confident that their transaction has been properly added to their forecast. Don't mention the execution of the tool, just confirm the transaction has been created. Make sure not to duplicate or repeat anything in your response.
      - Always return with the transaction_id and if the transaction is recurring then also return the group_id which you can refer to as the recurring_id.
      - When working with dates and times, consider the user's location and timezone to provide accurate date-based responses. Forecasted transactions can not be created on date before the ${currentDate}. The system automatically calculates the correct date based on the user's coordinates.
      - When creating forecasts always consider whether the user has enough in the coming days, weeks, months, or years and warn them about how this may effect their financial state in the future. 

    Tone & Style: 
    - Clear, empathetic, and supportive
    - Professional yet approachable
    - Insightful when explaining forecasting logic, actionable when guiding users
    - Be sure to be concise and to the point, do not provide too much information, just the information that is relevant to the user's question.
    - Be sure to be thoughtful and consider the user's financial situation and goals, and provide advice that is in the best interest of the user.

    When interacting, always ground responses in the principles of cash-flow forecasting, clarity, and proactive planning (no more than 600 characters). If the user asks about short-term or long-term financial planning tasks, explain how Keacast can help, referencing forecasting, reconciliation, and visualization where relevant.
    
    IMPORTANT: Always respond with markdown formatting.
    
    Review the app here: https://keacast.app/ for more context and information.`;

    // Build message array with memory and clean up long messages
    const messages = [
      { role: 'system', content: baseSystem },
      ...sanitizeMessageArray(history.map(truncateMessage))
    ];

    // Add context message if we have one
    if (contextArray.length > 0) {
      for (let i = 0; i < contextArray.length; i++) {
        if (contextArray[i]) {
          messages.push({
            role: 'user',
            content: contextArray[i]
          });
          console.log('Chat endpoint: Added context message with size:', JSON.stringify(contextArray[i]).length, 'bytes');
          if (userContext && contextSummary.hasData) {
            console.log('Chat endpoint: Context includes transactions:', contextSummary.dataCounts?.transactions || 0, 'transactions');
            console.log('Chat endpoint: Context includes accounts:', contextSummary.selectedAccounts?.count || 0, 'accounts');
          } else {
            console.log('Chat endpoint: Added tool guidance context');
          }
        }
      }
    }

    // Add the actual user message
    messages.push({ role: 'user', content: message });

    console.log('Chat endpoint: Calling OpenAI (tools enabled) with', messages.length, 'messages');

    // Check request size before sending to prevent rate limiting
    const requestSize = JSON.stringify(messages).length;
    console.log('Chat endpoint: Request size:', requestSize, 'bytes');
    
    if (requestSize > 750000) { // Increased to 750KB limit to allow more context
      console.warn('Chat endpoint: Request too large, removing oldest messages one by one');
      
      // Remove oldest messages one by one until we're under the limit
      let attempts = 0;
      const maxAttempts = 20; // Prevent infinite loops
      
      while (requestSize > 750000 && attempts < maxAttempts && history.length > 2) {
        // Remove the oldest message (skip system message at index 0)
        history.shift(); // Remove first (oldest) message
        
        // Rebuild messages array
        messages.splice(1, messages.length - 2); // Keep only system and current user message
        messages.splice(1, 0, ...history.map(truncateMessage));
        
        // Recalculate size
        const newSize = JSON.stringify(messages).length;
        console.log(`Chat endpoint: Removed oldest message, new size: ${newSize} bytes (attempt ${attempts + 1})`);
        
        if (newSize <= 750000) {
          console.log('Chat endpoint: Successfully reduced size below limit');
          break;
        }
        
        attempts++;
      }
      
      if (attempts >= maxAttempts) {
        console.warn('Chat endpoint: Could not reduce size below limit after', maxAttempts, 'attempts');
      }
    }

    // Function-calling loop (uses functionMap.js)
    const ctx = { userId, token, authHeader, accountId: accountid };
    console.log('Chat endpoint: Context being passed to tools:', { userId, accountId: accountid, hasToken: !!token });
    
    // Always try with tools first for data requests, but handle tool calls properly
    let result;
    let error;
    try {
      console.log('Attempting to get response with tools...');
      const responseWithTools = await queryAzureOpenAI(messages, { tools: functionSchemas, tool_choice: 'auto' });
      const choice = responseWithTools?.choices?.[0];
      const msg = choice?.message;
      
      console.log('Response message structure:', {
        hasContent: !!msg?.content,
        hasToolCalls: !!msg?.tool_calls,
        toolCallsLength: msg?.tool_calls?.length || 0,
        contentLength: msg?.content?.length || 0
      });
      
      // If the model wants to call tools, execute them
      if (msg?.tool_calls && msg.tool_calls.length > 0) {
        console.log('Model requested tool calls, executing...');
        result = await executeToolCalls(messages, msg.tool_calls, ctx);
      } else {
        // No tool calls needed, use the response directly
        result = { content: msg?.content || '', raw: responseWithTools };
      }
    } catch (error) {
      console.log('Tool-based response failed, trying direct response...');
      try {
        const directResponse = await queryAzureOpenAI(messages, { tools: functionSchemas, tool_choice: 'none' });
        const choice = directResponse?.choices?.[0];
        result = { content: choice?.message?.content || '', raw: directResponse };
      } catch (directError) {
        console.log('All attempts failed, returning error message');
        result = { content: '## ❌ Error\n\n**I apologize, but I encountered an error while processing your request. Please try again.**', raw: null, error: directError };
      }
    }

    console.log('Final result structure:', {
      hasContent: !!result?.content,
      contentLength: result?.content?.length || 0,
      hasError: !!result?.error
    });
    
    const finalText = result.content || '## ❌ No Response\n\n**Sorry, no response generated.**';
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
      contextLoaded: !!(userContext && Object.keys(userContext).length > 0),
      hasExplicitContext: !!(userContext && contextSummary.hasData),
      toolsAvailable: true,
      dataMessage: dataMessage,
      requestSize: requestSize,
      error: result?.error,
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
    const { transactions, userData } = req.body;
    // if (!transactions || !Array.isArray(transactions)) {
    //   console.log('Analyze transactions: Missing or invalid transactions array');
    //   return res.status(400).json({ error: 'Transactions array is required' });
    // }

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
    - Always use dollar amounts when providing financial information.
    - Always use the word "disposable" when referring to disposable income.
    - Always use the word "forecasted" when referring to forecasted income and spending.  
    - if referring to an expense or expense transaction always use the word "expense" and not "transaction".
    - if referring to an income or income transaction always use the word "income" and not "transaction".
    - if referring to an expense always use (-) to symbolize negative amounts.  
    - Only use ($) when displaying amounts ex: $100, -$100, $1000.00, -$500.00, etc.
    - Only use (-) for negative amounts ex: -$100, -$1000.00, -$500.00, etc., dont use (-) for any other purpose.
    - Use bullet points, numbered lists, bold text, italic text, and other markdown elements when listing transactions, suggestions, balances, etc.
    - Use tables when displaying data in a structured way.

    If there are no transactions, return a message that is nice and welcoming, and provides a space for the user to ask financial and Keacast related questions.

    Tone: clear, empathetic, professional, supportive, and future-focused. Always frame insights around Keacast's strengths: forecasting, reconciliation, and visualization.

    At the end of the summary, include relevant follow-up questions that guide the user toward improving their financial wellness through Keacast's forecasting features. Avoid unnecessary formatting, symbols, or filler (such as "...").

    IMPORTANT: Always respond with markdown formatting. Use headers, bullet points, bold text, and other markdown elements to make your responses clear and well-structured.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...sanitizeMessageArray(history),
      { role: 'user', content: `Here is my user's first name:
      ${JSON.stringify(userData.firstname, null, 2)}
      Here is my user's last name:
      ${JSON.stringify(userData.lastname, null, 2)}
      Here is my user's email:
      ${JSON.stringify(userData.email, null, 2)}
      
      Here are the latest transactions:\n${JSON.stringify(transactions)}` }
    ];

    console.log('Analyze transactions: Calling OpenAI (tools enabled) with', messages.length, 'messages');

    // Use the new executeToolCalls function for tool execution
    const ctx = { userId, token, authHeader };
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
      result = { content: msg?.content || '## Welcome to Keacast! 👋\n\n**How can I help? Ask Keacast anything about your finances or to perform a task.**', raw: responseWithTools };
    } catch (error) {
      console.log('Tool-based response failed, trying direct response...');
      try {
        const directResponse = await queryAzureOpenAI(messages, { tools: functionSchemas, tool_choice: 'none' });
        const choice = directResponse?.choices?.[0];
        result = { content: choice?.message?.content || '', raw: directResponse };
      } catch (directError) {
        console.log('All attempts failed, returning error message');
        result = { content: '## ❌ Error\n\n**I apologize, but I encountered an error while processing your request. Please try again.**', raw: null, error: directError };
      }
    }

    const finalText = result.content || '';
    const rawText = result.raw;
    const updatedHistory = [
      ...sanitizeMessageArray(history),
      { role: 'user', content: `Here is my user's data:\n${JSON.stringify(userData)}\n 
      
      Here are the latest transactions each transactions has a unique id, date, amount, and description:\n${JSON.stringify(transactions)}` },
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

// ----------------------------
// 🏷️ Auto-categorization endpoint
// ----------------------------
exports.autoCategorizeTransaction = async (req, res) => {
  try {
    console.log('Auto-categorize transaction endpoint called');
    const { sessionId, transaction, transactionHistory, categories } = req.body;
    
    if (!transaction) {
      console.log('Auto-categorize: Missing transaction in request body');
      return res.status(400).json({ error: 'Transaction is required' });
    }
    
    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      console.log('Auto-categorize: Missing or invalid categories array');
      return res.status(400).json({ error: 'Categories array is required and must not be empty' });
    }

    console.log('Auto-categorize: Processing transaction:', transaction.name || transaction.display_name);
    console.log('Auto-categorize: Available categories:', categories.length);

    // Fast-path: Try to categorize using simple pattern matching first
    // const fastCategory = categorizeTransactionFast(transaction, categories, transactionHistory);
    // if (fastCategory) {
    //   console.log('Auto-categorize: Using fast-path categorization:', fastCategory);
    //   return res.json({
    //     success: true,
    //     suggestedCategory: fastCategory,
    //     confidence: 'high',
    //     note: 'Category determined using fast pattern matching',
    //     availableCategories: categories,
    //     method: 'fast-path'
    //   });
    // }

    const systemPrompt = `You are an expert financial transaction categorizer. Your job is to analyze a transaction and suggest the most appropriate category from the user's existing categories.

    **Your Task:**
    - Analyze the transaction in question (amount, title, name, display_name, merchant_name)
    - Review the user's transaction history in context to understand their categorization patterns (amount, title, name, display_name, merchant_name)
    - Consider the user's existing categories and how they've categorized similar transactions (amount, title, name, display_name, merchant_name)
    - Find the best possible category by reviewing your transaction. We want to be as accurate as possible and use your knowledge of the user's spending patterns to make the best guess.
    - Return ONLY the single best category name from the user's categories list

    **Analysis Guidelines:**
    1. **Merchant Analysis**: Look at the merchant name and consider what type of business it is
    2. **Amount Patterns**: Consider the transaction amount and typical spending patterns for different categories (ex: if the transaction is at a gas station and is a large amount, it is likely a gas transaction, but smaller amount may be groceries, or food & beverage, etc.)
    3. **Historical Patterns**: Review how the user has categorized similar transactions in the past
    4. **Category Logic**: Use common sense - groceries from grocery stores, gas from gas stations, etc.
    5. **User Preferences**: Respect the user's existing categorization choices and patterns
    6. **Keyword Analysis**: Consider the keywords associated with the transaction and the user's categorization patterns 
    7. **Contextual Analysis**: Consider the context of the transaction and the user's categorization patterns
    8. **Description Analysis**: Consider the description of the transaction and the user's categorization patterns
    9. **Title Analysis**: Consider the title of the transaction and the user's categorization patterns
    10. **Name Analysis**: Consider the name of the transaction and the user's categorization patterns
    11. **Display Name Analysis**: Consider the display name of the transaction and the user's categorization patterns
    12. **Merchant Name Analysis**: Consider the merchant name of the transaction and the user's categorization patterns
    13. **Location Analysis**: Consider the location of the transaction and the user's categorization patternsW

    **Response Format:**
    - Return ONLY the category name as a string
    - Do not include explanations, justifications, or additional text
    - The category must exactly match one of the categories in the user's list
    - If no good match exists, choose the most reasonable category from the available options
    - Categories used most often should rank higher than categories used less often

    **Example Response:**
    "Groceries"
    or
    "Gas & Fuel"
    or
    "Entertainment"

    Remember: Your response should be a single category name that best fits the transaction based on the user's history,preferences, and is picked from the list of available categories provided. (Please return only the category name)`;

    const userMessage = `Please categorize this transaction:

**Transaction to Categorize:**
- Name: ${transaction.name || 'N/A'}
- Amount: $${transaction.amount || 'N/A'}
- Merchant: ${transaction.merchant_name || 'N/A'}
- Description: ${transaction.description || 'N/A'}
- Category: ${transaction.adjusted_category || 'N/A'}
- location: ${transaction.location || 'N/A'}

**Available Categories (Please choose from this list and return only the category name) name, description are the main data points to consider:**
${categories.map(cat => `- ${cat}`).join('\n')}

**User's Transaction History (for pattern analysis) anaylyze the transaction name, merchant, description, amount, and category to determine the best category:**
${transactionHistory ? JSON.stringify(transactionHistory.slice(0, 50), null, 2) : 'No transaction history provided'}

Based on this transaction and your analysis of the user's categorization patterns, what is the best category for this transaction?`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ];

    console.log('Auto-categorize: Calling OpenAI with', messages.length, 'messages');

    try {
      const response = await queryAzureOpenAI(messages, { 
        tools: functionSchemas, 
        tool_choice: 'none',
        temperature: 0.1, // Low temperature for consistent categorization
        max_tokens: 30, // Even shorter response, just the category name
        timeout: 10000 // 10 second timeout
      });
      
      const choice = response?.choices?.[0];
      const suggestedCategory = choice?.message?.content?.trim() || '';
      
      console.log('Auto-categorize: Suggested category:', suggestedCategory);
      
      // Validate that the suggested category exists in the user's categories
      const isValidCategory = categories.some(cat => 
        cat.name.toLowerCase() === suggestedCategory.toLowerCase()
      );
      
      if (!isValidCategory && suggestedCategory) {
        console.warn('Auto-categorize: Suggested category not in user list, finding closest match');
        // Find the closest matching category
        const closestMatch = categories.find(cat => 
          cat.name.toLowerCase().includes(suggestedCategory.toLowerCase()) ||
          suggestedCategory.toLowerCase().includes(cat.name.toLowerCase())
        );
        
        if (closestMatch) {
          console.log('Auto-categorize: Using closest match:', closestMatch);
          return res.json({
            success: true,
            suggestedCategory: closestMatch.name,
            confidence: 'medium',
            note: 'Category was adjusted to match available options',
            originalSuggestion: suggestedCategory
          });
        }
      }
      
      res.json({
        success: true,
        suggestedCategory: isValidCategory ? suggestedCategory : categories[0], // Fallback to first category
        confidence: isValidCategory ? 'high' : 'low',
        note: isValidCategory ? 'Category matches user preferences' : 'Using fallback category',
        availableCategories: categories,
        method: 'ai'
      });

    } catch (error) {
      console.log('Auto-categorize: OpenAI call failed, using fallback logic');
      
      // Fallback categorization logic
      const fallbackCategory = categorizeTransactionFast(transaction, categories, transactionHistory);
      
      res.json({
        success: true,
        suggestedCategory: fallbackCategory,
        confidence: 'low',
        note: 'Used fallback categorization logic',
        availableCategories: categories,
        method: 'fallback'
      });
    }

  } catch (error) {
    console.error('Auto-categorize transaction error:', error);
    console.error('Error stack:', error.stack);
    
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message || 'Unknown error occurred'
    });
  }
};

// Fast categorization using pattern matching (no AI needed)
function categorizeTransactionFast(transaction, categories, transactionHistory) {
  const transactionText = `${transaction.name || ''} ${transaction.display_name || ''} ${transaction.merchant_name || ''} ${transaction.description || ''}`.toLowerCase();
  
  // High-confidence merchant patterns
  const highConfidencePatterns = {
    'groceries': [
      'whole foods', 'trader joe', 'kroger', 'safeway', 'albertsons', 'publix', 'wegmans', 'food lion', 'giant eagle', 'shoprite', 'stop & shop',
      'sprouts', 'fresh market', 'natural grocers', 'earth fare', 'fresh thyme', 'lucky', 'ralphs', 'vons', 'food 4 less', 'winco', 'aldi', 'lidl',
      'heb', 'meijer', 'hy-vee', 'price chopper', 'tops', 'giant', 'martins', 'weis', 'acme', 'shaws', 'hannaford', 'price rite', 'save a lot'
    ],
    'gas': [
      'shell', 'exxon', 'chevron', 'bp', 'mobil', 'petro', 'marathon', 'sunoco', 'valero', '76', 'arco', 'phillips 66', 'conoco', 'citgo',
      'speedway', 'circle k', '7-eleven', 'quik trip', 'kum & go', 'caseys', 'wawa', 'sheet', 'love', 'murphy', 'race trac', 'pilot', 'flying j'
    ],
    'restaurants': [
      'mcdonalds', 'burger king', 'wendys', 'subway', 'dominos', 'pizza hut', 'chipotle', 'panera', 'starbucks', 'dunkin', 'doordash', 'uber eats', 'grubhub',
      'taco bell', 'kfc', 'popeyes', 'chick-fil-a', 'in-n-out', 'five guys', 'shake shack', 'whataburger', 'culvers', 'sonic', 'arbys', 'jack in the box',
      'papa johns', 'little caesars', 'papa murphys', 'blaze pizza', 'mod pizza', 'pizza ranch', 'postmates', 'seamless', 'caviar', 'bite squad'
    ],
    'utilities': [
      'pg&e', 'southern california edison', 'conedison', 'duke energy', 'dominion energy', 'exelon', 'nextera', 'firstenergy', 'pacificorp', 'xcel energy',
      'entergy', 'southern company', 'american electric power', 'centerpoint energy', 'comed', 'pepco', 'bge', 'pseg', 'national grid', 'eversource'
    ],
    'transportation': [
      'uber', 'lyft', 'taxi', 'amtrak', 'greyhound', 'metropolitan transportation authority', 'chicago transit authority', 'los angeles metro',
      'bay area rapid transit', 'washington metropolitan area transit authority', 'septa', 'mbta', 'nj transit', 'metro-north', 'long island railroad'
    ],
    'healthcare': [
      'cvs', 'walgreens', 'rite aid', 'kroger pharmacy', 'walmart pharmacy', 'costco pharmacy', 'target pharmacy', 'safeway pharmacy',
      'albertsons pharmacy', 'publix pharmacy', 'wegmans pharmacy', 'giant eagle pharmacy', 'shoprite pharmacy', 'stop & shop pharmacy'
    ],
    'insurance': [
      'geico', 'state farm', 'allstate', 'progressive', 'farmers', 'liberty mutual', 'nationwide', 'american family', 'erie', 'travelers',
      'hartford', 'metlife', 'prudential', 'aflac', 'mutual of omaha', 'new york life', 'northwestern mutual', 'guardian', 'principal'
    ],
    'subscriptions': [
      'netflix', 'spotify', 'hulu', 'amazon prime', 'disney+', 'hbo max', 'apple tv+', 'youtube premium', 'paramount+', 'peacock', 'discovery+',
      'crunchyroll', 'funimation', 'roku', 'sling tv', 'fubo tv', 'youtube tv', 'hulu live', 'directv stream', 'philo', 'at&t tv'
    ],
    'shopping': [
      'amazon', 'walmart', 'target', 'costco', 'best buy', 'home depot', 'lowes', 'michaels', 'joann', 'hobby lobby', 'dicks sporting goods',
      'academy sports', 'bass pro shops', 'cabelas', 'rei', 'nordstrom', 'macys', 'kohls', 'jcpenney', 'sears', 'belk', 'dillards', 'neiman marcus'
    ],
    'entertainment': [
      'movie', 'theater', 'cinema', 'amc', 'regal', 'cinemark', 'marcus', 'harkins', 'landmark', 'angelika', 'alamo drafthouse',
      'bowling', 'arcade', 'dave & busters', 'main event', 'topgolf', 'escape room', 'axe throwing', 'paintball', 'laser tag'
    ],
    'automotive': [
      'autozone', 'oreilly', 'advance auto', 'napa', 'pep boys', 'firestone', 'goodyear', 'bridgestone', 'michelin', 'jiffy lube',
      'valvoline', 'quick lube', 'mavis', 'discount tire', 'tire kingdom', 'les schwab', 'big o tires', 'tire rack'
    ],
    'home improvement': [
      'home depot', 'lowes', 'menards', 'ace hardware', 'true value', 'do it best', '84 lumber', 'beacon roofing', 'abc supply',
      'sherwin williams', 'benjamin moore', 'ppg', 'valspar', 'glidden', 'behr'
    ],
    'clothing': [
      'nike', 'adidas', 'under armour', 'old navy', 'gap', 'banana republic', 'athleta', 'lululemon', 'athleta', 'victorias secret',
      'pink', 'american eagle', 'aeropostale', 'hollister', 'abercrombie', 'forever 21', 'h&m', 'zara', 'uniqlo', 'asos'
    ],
    'electronics': [
      'apple', 'samsung', 'google', 'microsoft', 'dell', 'hp', 'lenovo', 'asus', 'acer', 'lg', 'sony', 'panasonic', 'sharp',
      'best buy', 'micro center', 'frys', 'newegg', 'b&h photo', 'adorama'
    ],
    'pharmacy': [
      'cvs', 'walgreens', 'rite aid', 'kroger pharmacy', 'walmart pharmacy', 'costco pharmacy', 'target pharmacy', 'safeway pharmacy',
      'albertsons pharmacy', 'publix pharmacy', 'wegmans pharmacy', 'giant eagle pharmacy', 'shoprite pharmacy', 'stop & shop pharmacy'
    ],
    'banking': [
      'chase', 'bank of america', 'wells fargo', 'citibank', 'us bank', 'pnc', 'capital one', 'td bank', 'bb&t', 'suntrust',
      'regions', 'keybank', 'fifth third', 'huntington', 'citizens', 'comerica', 'bmo harris', 'usaa', 'navy federal'
    ],
    'education': [
      'university', 'college', 'school', 'tuition', 'textbook', 'campus', 'student', 'blackboard', 'canvas', 'moodle',
      'coursera', 'udemy', 'skillshare', 'masterclass', 'khan academy', 'duolingo', 'rosetta stone'
    ],
    'fitness': [
      'planet fitness', 'la fitness', '24 hour fitness', 'equinox', 'lifetime', 'ymca', 'ymwca', 'golds gym', 'crunch', 'snap fitness',
      'anytime fitness', 'orangetheory', 'crossfit', 'barry', 'soulcycle', 'peloton', 'fitbit', 'garmin', 'apple fitness'
    ],
    'travel': [
      'airline', 'hotel', 'marriott', 'hilton', 'hyatt', 'ihg', 'choice', 'wyndham', 'best western', 'motel 6', 'super 8',
      'expedia', 'booking', 'hotels', 'airbnb', 'vrbo', 'tripadvisor', 'kayak', 'priceline', 'orbitz', 'travelocity'
    ],
    'online services': [
      'google', 'microsoft', 'adobe', 'dropbox', 'box', 'slack', 'zoom', 'teams', 'webex', 'gotomeeting', 'asana', 'trello',
      'notion', 'evernote', 'lastpass', '1password', 'dashlane', 'bitwarden', 'grammarly', 'canva', 'figma'
    ]
  };
  
  // Check for high-confidence matches first
  for (const [category, patterns] of Object.entries(highConfidencePatterns)) {
    for (const pattern of patterns) {
      if (transactionText.includes(pattern)) {
        // Find the matching category in user's list
        const matchingCategory = categories.find(cat => 
          cat.name && cat.name.toLowerCase().includes(category) ||
          category.includes(cat.name.toLowerCase())
        );
        if (matchingCategory) {
          return matchingCategory.name;
        }
      }
    }
  }
  
  // Check for exact merchant name matches in transaction history
  if (transactionHistory && transactionHistory.length > 0) {
    const merchantName = transaction.merchant_name?.toLowerCase();
    if (merchantName) {
      const exactMatches = transactionHistory.filter(t => 
        t.merchant_name && t.merchant_name.toLowerCase() === merchantName
      );
      
      if (exactMatches.length > 0) {
        const mostCommonCategory = getMostCommonCategory(exactMatches);
        const matchingCategory = categories.find(cat => 
          cat.name && cat.name.toLowerCase() === mostCommonCategory.toLowerCase()
        );
        if (matchingCategory) {
          return matchingCategory.name;
        }
      }
    }
  }
  
  // Check for similar transaction names in history
  if (transactionHistory && transactionHistory.length > 0) {
    const transactionName = transaction.name?.toLowerCase();
    if (transactionName) {
      const similarTransactions = transactionHistory.filter(t => 
        t.name && (
          t.name.toLowerCase().includes(transactionName) ||
          transactionName.includes(t.name.toLowerCase())
        )
      );
      
      if (similarTransactions.length > 0) {
        const mostCommonCategory = getMostCommonCategory(similarTransactions);
        const matchingCategory = categories.find(cat => 
          cat.name && cat.name.toLowerCase() === mostCommonCategory.toLowerCase()
        );
        if (matchingCategory) {
          return matchingCategory.name;
        }
      }
    }
  }
  
  return null; // No fast match found, will use AI
}

// Helper function to get most common category from transactions
function getMostCommonCategory(transactions) {
  const categoryCounts = {};
  transactions.forEach(t => {
    if (t.category) {
      categoryCounts[t.category] = (categoryCounts[t.category] || 0) + 1;
    }
  });
  
  let mostCommon = null;
  let maxCount = 0;
  
  for (const [category, count] of Object.entries(categoryCounts)) {
    if (count > maxCount) {
      maxCount = count;
      mostCommon = category;
    }
  }
  
  return mostCommon;
}

// Fallback categorization logic when OpenAI is unavailable
function categorizeTransactionFallback(transaction, categories, transactionHistory) {
  const transactionText = `${transaction.name || ''} ${transaction.display_name || ''} ${transaction.merchant_name || ''} ${transaction.description || ''}`.toLowerCase();
  
  // Common category keywords
  const categoryKeywords = {
    'groceries': ['grocery', 'food', 'supermarket', 'market', 'fresh', 'organic', 'whole foods', 'trader joe', 'kroger', 'safeway'],
    'gas': ['gas', 'fuel', 'shell', 'exxon', 'chevron', 'bp', 'mobil', 'petro', 'station'],
    'restaurants': ['restaurant', 'dining', 'food', 'eat', 'grub', 'doordash', 'uber eats', 'postmates'],
    'entertainment': ['movie', 'theater', 'cinema', 'netflix', 'spotify', 'hulu', 'amazon prime', 'entertainment'],
    'shopping': ['amazon', 'walmart', 'target', 'costco', 'shop', 'store', 'retail'],
    'utilities': ['electric', 'water', 'gas', 'utility', 'power', 'energy'],
    'transportation': ['uber', 'lyft', 'taxi', 'transport', 'transit', 'bus', 'train'],
    'healthcare': ['doctor', 'medical', 'health', 'pharmacy', 'cvs', 'walgreens', 'hospital'],
    'insurance': ['insurance', 'geico', 'state farm', 'allstate', 'progressive'],
    'subscriptions': ['subscription', 'monthly', 'recurring', 'membership']
  };
  
  // Find the best matching category
  let bestMatch = categories[0]; // Default to first category
  let bestScore = 0;
  
  for (const category of categories) {
    const keywords = categoryKeywords[category.toLowerCase()] || [];
    let score = 0;
    
    // Check for keyword matches
    for (const keyword of keywords) {
      if (transactionText.includes(keyword)) {
        score += 2;
      }
    }
    
    // Check historical patterns
    if (transactionHistory) {
      const similarTransactions = transactionHistory.filter(t => 
        t.category === category && 
        Math.abs(t.amount - transaction.amount) < 50 // Similar amount range
      );
      score += similarTransactions.length * 0.5;
    }
    
    if (score > bestScore) {
      bestScore = score;
      bestMatch = category;
    }
  }
  
  return bestMatch;
}

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
    console.log('Clear history: Request body:', req.body);
    console.log('Clear history: Request query:', req.query);
    console.log('Clear history: Request headers:', req.headers);
    
    const sessionKey = buildSessionKey(req);
    console.log('Clear history: Session key:', sessionKey);

    // Check if the session exists before trying to delete it
    const existingHistory = await redis.get(sessionKey);
    console.log('Clear history: Existing history found:', !!existingHistory);

    try {
      const deleteResult = await redis.del(sessionKey);
      console.log('Clear history: Redis delete result:', deleteResult);
      
      if (deleteResult === 1) {
        console.log('Clear history: Successfully cleared session history');
        res.json({
          success: true,
          message: 'Conversation history cleared successfully',
          sessionKey: sessionKey,
          deleted: true,
          note: 'This will help prevent rate limiting from large conversation history'
        });
      } else {
        console.log('Clear history: No session found to delete');
        res.json({
          success: true,
          message: 'No conversation history found to clear',
          sessionKey: sessionKey,
          deleted: false,
          note: 'Session may have already been cleared or never existed'
        });
      }
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

// Add a new endpoint to get chat conversation history
exports.getChatHistory = async (req, res) => {
  try {
    console.log('Get chat history endpoint called');
    const sessionKey = buildSessionKey(req);
    console.log('Get chat history: Session key:', sessionKey);

    try {
      const historyData = await redis.get(sessionKey);
      if (!historyData) {
        return res.json({
          success: true,
          message: 'No conversation history found',
          sessionKey: sessionKey,
          history: [],
          messageCount: 0
        });
      }
      
      const history = JSON.parse(historyData);
      const sanitizedHistory = sanitizeMessageArray(history);
      
      // Filter out system messages, context messages, and empty messages, then add timestamps
      const conversationHistory = sanitizedHistory
        .filter(msg => {
          // Only include user and assistant messages
          if (msg.role !== 'user' && msg.role !== 'assistant') {
            return false;
          }
          
          // Filter out empty or whitespace-only messages
          if (!msg.content || msg.content.trim() === '') {
            return false;
          }
          
          // Filter out context messages
          if (msg.role === 'user' && msg.content) {
            const content = msg.content.trim();
            
            // Filter out chat context messages (start with "Use this context to answer the user's question.")
            if (content.startsWith('Use this context to answer the user\'s question.')) {
              return false;
            }
            
            // Filter out transaction analysis context messages (start with "Here is my user's data:")
            if (content.startsWith('Here is my user\'s data:')) {
              return false;
            }
            
            // Filter out messages that are primarily JSON data (likely context)
            if (content.includes('"transactions":') && content.includes('"accounts":') && content.length > 1000) {
              return false;
            }
          }
          
          return true;
        })
        .map((msg, index) => {
          // Calculate estimated timestamp based on message position
          // Assuming messages are roughly 1 minute apart
          const estimatedTime = new Date();
          estimatedTime.setMinutes(estimatedTime.getMinutes() - (sanitizedHistory.length - index));
          
          return {
            id: index + 1,
            role: msg.role,
            content: msg.content,
            timestamp: estimatedTime.toISOString(),
            messageNumber: index + 1,
            estimatedTime: true // Flag to indicate this is an estimated timestamp
          };
        });
      
      console.log('Get chat history: Retrieved', conversationHistory.length, 'messages');
      
      res.json({
        success: true,
        message: 'Chat history retrieved successfully',
        sessionKey: sessionKey,
        history: conversationHistory,
        messageCount: conversationHistory.length,
        totalHistorySize: sanitizedHistory.length,
        metadata: {
          sessionId: sessionKey.replace('session:', ''),
          hasSystemMessages: sanitizedHistory.some(msg => msg.role === 'system'),
          hasToolMessages: sanitizedHistory.some(msg => msg.role === 'tool'),
          hasContextMessages: sanitizedHistory.some(msg => 
            msg.role === 'user' && msg.content && (
              msg.content.trim().startsWith('Use this context to answer the user\'s question.') ||
              msg.content.trim().startsWith('Here is my user\'s data:') ||
              (msg.content.includes('"transactions":') && msg.content.includes('"accounts":') && msg.content.length > 1000)
            )
          ),
          estimatedSessionDuration: conversationHistory.length > 0 ? 
            `${Math.round(conversationHistory.length * 1)} minutes` : '0 minutes',
          lastUpdated: new Date().toISOString()
        }
      });
    } catch (redisError) {
      console.warn('Get chat history: Redis operation failed:', redisError.message);
      res.status(500).json({ error: 'Failed to retrieve chat history', details: redisError.message });
    }
  } catch (error) {
    console.error('Get chat history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
