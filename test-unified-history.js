const axios = require('axios');

// Configuration
const BASE_URL = process.env.API_URL || 'http://localhost:5001';
const SESSION_ID = 'test-session-' + Date.now();

console.log('🧪 Testing Unified Conversation History');
console.log('=====================================');
console.log(`API URL: ${BASE_URL}`);
console.log(`Session ID: ${SESSION_ID}`);
console.log('');

async function testUnifiedHistory() {
  try {
    // Test 1: Send a chat message
    console.log('1️⃣ Sending chat message...');
    const chatResponse = await axios.post(`${BASE_URL}/api/agent/chat`, {
      sessionId: SESSION_ID,
      message: "Hello! I'm testing the unified conversation history."
    });
    console.log('✅ Chat response received');
    console.log(`Response: ${chatResponse.data.response.substring(0, 100)}...`);
    console.log(`Memory used: ${chatResponse.data.memoryUsed} messages`);
    console.log('');

    // Test 2: Send a summarize request
    console.log('2️⃣ Sending summarize request...');
    const summarizeResponse = await axios.post(`${BASE_URL}/api/agent/summarize`, {
      sessionId: SESSION_ID,
      transactions: [
        { amount: 100, description: "Coffee shop", category: "Food & Dining" },
        { amount: 50, description: "Gas station", category: "Transportation" },
        { amount: 200, description: "Grocery store", category: "Food & Dining" }
      ]
    });
    console.log('✅ Summarize response received');
    console.log(`Insights: ${summarizeResponse.data.insights.substring(0, 100)}...`);
    console.log('');

    // Test 3: Send another chat message (should have context from summarize)
    console.log('3️⃣ Sending follow-up chat message...');
    const followUpResponse = await axios.post(`${BASE_URL}/api/agent/chat`, {
      sessionId: SESSION_ID,
      message: "Can you tell me more about the spending patterns you just analyzed?"
    });
    console.log('✅ Follow-up response received');
    console.log(`Response: ${followUpResponse.data.response.substring(0, 100)}...`);
    console.log(`Memory used: ${followUpResponse.data.memoryUsed} messages`);
    console.log('');

    // Test 4: Check if the AI remembers the previous context
    console.log('4️⃣ Testing memory retention...');
    const memoryTestResponse = await axios.post(`${BASE_URL}/api/agent/chat`, {
      sessionId: SESSION_ID,
      message: "What was the total amount of the transactions you analyzed earlier?"
    });
    console.log('✅ Memory test response received');
    console.log(`Response: ${memoryTestResponse.data.response.substring(0, 100)}...`);
    console.log(`Memory used: ${memoryTestResponse.data.memoryUsed} messages`);
    console.log('');

    console.log('🎉 Unified history test completed successfully!');
    console.log('The AI should now remember both the chat conversation and the transaction analysis.');

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

// Run the test
testUnifiedHistory(); 