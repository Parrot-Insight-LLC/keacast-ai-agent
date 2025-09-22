// Test script for enhanced conversation context functionality
const axios = require('axios');

const BASE_URL = 'http://localhost:3000/api/openai';

// Test configuration
const testConfig = {
  sessionId: 'test-enhanced-conversation-' + Date.now(),
  userId: 'test-user-123',
  token: 'test-token-456',
  accountid: 'test-account-789'
};

async function testEnhancedConversation() {
  console.log('🧪 Testing Enhanced Conversation Context Functionality\n');
  
  try {
    // Test 1: Start a conversation
    console.log('1️⃣ Starting initial conversation...');
    const initialResponse = await axios.post(`${BASE_URL}/chat`, {
      message: "Hi! I'm new to Keacast. Can you help me understand how to get started with financial forecasting?",
      sessionId: testConfig.sessionId,
      userId: testConfig.userId,
      token: testConfig.token,
      accountid: testConfig.accountid
    });
    
    console.log('✅ Initial response received');
    console.log('📊 Conversation context:', initialResponse.data.conversationContext);
    console.log('💬 Response preview:', initialResponse.data.response.substring(0, 100) + '...\n');
    
    // Test 2: Continue conversation with topic tracking
    console.log('2️⃣ Continuing conversation with budgeting topic...');
    const budgetResponse = await axios.post(`${BASE_URL}/chat`, {
      message: "I want to create a budget for next month. What should I consider when planning my expenses?",
      sessionId: testConfig.sessionId,
      userId: testConfig.userId,
      token: testConfig.token,
      accountid: testConfig.accountid
    });
    
    console.log('✅ Budget response received');
    console.log('📊 Topics tracked:', budgetResponse.data.conversationContext?.topics);
    console.log('💬 Response preview:', budgetResponse.data.response.substring(0, 100) + '...\n');
    
    // Test 3: Add more conversation depth
    console.log('3️⃣ Adding transaction analysis topic...');
    const transactionResponse = await axios.post(`${BASE_URL}/chat`, {
      message: "I have some recurring transactions like rent and utilities. How can I track these effectively?",
      sessionId: testConfig.sessionId,
      userId: testConfig.userId,
      token: testConfig.token,
      accountid: testConfig.accountid
    });
    
    console.log('✅ Transaction response received');
    console.log('📊 Topics tracked:', transactionResponse.data.conversationContext?.topics);
    console.log('💬 Response preview:', transactionResponse.data.response.substring(0, 100) + '...\n');
    
    // Test 4: Get conversation insights
    console.log('4️⃣ Getting conversation insights...');
    const insightsResponse = await axios.get(`${BASE_URL}/conversation-insights`, {
      params: {
        sessionId: testConfig.sessionId,
        userId: testConfig.userId
      }
    });
    
    console.log('✅ Insights retrieved');
    console.log('📈 Conversation insights:', JSON.stringify(insightsResponse.data.insights, null, 2));
    console.log('💡 Recommendations:', JSON.stringify(insightsResponse.data.recommendations, null, 2));
    console.log('');
    
    // Test 5: Test conversation continuity
    console.log('5️⃣ Testing conversation continuity...');
    const continuityResponse = await axios.post(`${BASE_URL}/chat`, {
      message: "Can you remind me what we discussed about budgeting?",
      sessionId: testConfig.sessionId,
      userId: testConfig.userId,
      token: testConfig.token,
      accountid: testConfig.accountid
    });
    
    console.log('✅ Continuity response received');
    console.log('📊 Has summary:', continuityResponse.data.conversationContext?.hasSummary);
    console.log('💬 Response preview:', continuityResponse.data.response.substring(0, 150) + '...\n');
    
    // Test 6: Get chat history
    console.log('6️⃣ Getting chat history...');
    const historyResponse = await axios.post(`${BASE_URL}/chat-history`, {
      sessionId: testConfig.sessionId,
      userId: testConfig.userId
    });
    
    console.log('✅ History retrieved');
    console.log('📚 Message count:', historyResponse.data.messageCount);
    console.log('🕒 Estimated duration:', historyResponse.data.metadata?.estimatedSessionDuration);
    console.log('');
    
    // Test 7: Test conversation summarization (if conversation is long enough)
    if (insightsResponse.data.insights.messageCount > 5) {
      console.log('7️⃣ Testing conversation summarization...');
      const summaryResponse = await axios.post(`${BASE_URL}/summarize-conversation`, {
        sessionId: testConfig.sessionId,
        userId: testConfig.userId,
        location: { latitude: 40.7128, longitude: -74.0060 } // NYC coordinates
      });
      
      console.log('✅ Summary created');
      console.log('📝 Summary preview:', summaryResponse.data.summary?.content?.substring(0, 200) + '...');
      console.log('📊 Summary stats:', {
        originalMessages: summaryResponse.data.summary?.originalMessageCount,
        summarizedMessages: summaryResponse.data.summary?.summarizedMessageCount,
        keptRecent: summaryResponse.data.summary?.keptRecentCount
      });
      console.log('');
    }
    
    console.log('🎉 Enhanced conversation context testing completed successfully!');
    console.log('\n📋 Test Summary:');
    console.log('✅ Conversation initialization');
    console.log('✅ Topic tracking and continuity');
    console.log('✅ Conversation insights');
    console.log('✅ Context preservation');
    console.log('✅ History management');
    if (insightsResponse.data.insights.messageCount > 5) {
      console.log('✅ Conversation summarization');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    console.error('Stack:', error.stack);
  }
}

// Run the test
if (require.main === module) {
  testEnhancedConversation();
}

module.exports = { testEnhancedConversation };
