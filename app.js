require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const openaiRoutes = require('./routes/openaiRoutes');
const authRoutes = require('./routes/authRoutes');

const app = express();

// Enhanced CORS configuration for production
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.ALLOWED_ORIGINS?.split(',') || ['https://yourdomain.com']
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
app.use('/api/auth', authRoutes);
app.use('/api/agent', openaiRoutes);

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
      }
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method
  });
});

// Global error handler
app.use((err, req, res, next) => {
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
