require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const requestId = require('./middleware/requestId');
const logging = require('./middleware/logging');
const securityHeaders = require('./middleware/securityHeaders');
// Pick ONE: simple (dev) or redis (prod)
const { globalLimiter, sensitiveLimiter } = require('./middleware/rateLimit.redis'); 
// const { globalLimiter, sensitiveLimiter } = require('./middleware/rateLimit.simple');

const openaiRoutes = require('./routes/openaiRoutes');
const authRoutes = require('./routes/authRoutes');
const cacheRoutes = require('./routes/cacheRoutes');

const app = express();

app.set('trust proxy', 1);

// Middleware
app.use(requestId);
app.use(logging);
app.use(securityHeaders);
app.use(globalLimiter);
app.use(sensitiveLimiter);

// Enhanced CORS configuration for production
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.ALLOWED_ORIGINS?.split(',') || ['keacast-ai-e9cndfc4ethmgphf.eastus2-01.azurewebsites.net']
    : true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

app.use(cors(corsOptions));

// Body parsing with limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Health check endpoint for load balancers
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Routes
// Apply stricter limit on LLM-intensive endpoints
app.use('/api/agent/chat', sensitiveLimiter);
app.use('/api/agent/summarize', sensitiveLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/agent', openaiRoutes);
app.use('/api/cache', cacheRoutes);

// Add a root route to handle the base URL
app.get('/', (req, res) => {
  res.json({
    message: 'Keacast AI Agent API is running',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    features: {
      unifiedHistory: 'Chat and summarize endpoints now share the same conversation history',
      sessionBased: 'Conversations are maintained per sessionId or user ID'
    },
    endpoints: {
      health: 'GET /health',
      auth: {
        login: 'POST /api/auth/login',
        profile: 'GET /api/auth/profile'
      },
      agent: {
        summarize: 'POST /api/agent/summarize',
        chat: 'POST /api/agent/chat',
        clearHistory: 'DELETE /api/agent/clear-history',
        testRedis: 'GET /api/agent/test-redis'
      },
      cache: {
        invalidateUser: 'DELETE /api/cache/user/:userId',
        invalidateAccount: 'DELETE /api/cache/user/:userId/account/:accountId',
        warmUp: 'POST /api/cache/warmup/:userId/account/:accountId',
        stats: 'GET /api/cache/stats/:userId',
        health: 'GET /api/cache/health'
      }
    }
  });
});


// 404 helper
app.use((req, res) => res.status(404).json({ error: 'Not found', requestId: req.id }));

// Error handler LAST
const errorHandler = require('./middleware/errorHandler');
app.use(errorHandler);

// Global error handler - only handle unhandled errors
app.use((err, req, res, next) => {
  // If response has already been sent, don't override it
  if (res.headersSent) {
    return next(err);
  }
  
  console.error('Global error handler:', err);
  
  // Don't leak error details in production
  const errorMessage = process.env.NODE_ENV === 'production' 
    ? 'Internal server error' 
    : err.message;
  
  res.status(err.status || 500).json({ 
    error: errorMessage,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
});

module.exports = app;
