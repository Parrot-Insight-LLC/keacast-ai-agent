require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const openaiRoutes = require('./routes/openaiRoutes');
const authRoutes = require('./routes/authRoutes');

const app = express();
app.use(express.json());
app.use(cors());
app.use(morgan('dev'));

app.use('/api/auth', authRoutes);
app.use('/api/agent', openaiRoutes);

// Add a root route to handle the base URL
app.get('/', (req, res) => {
  res.json({
    message: 'Keacast AI Agent API is running',
    version: '1.0.0',
    endpoints: {
      auth: {
        login: 'POST /api/auth/login',
        profile: 'GET /api/auth/profile'
      },
      agent: {
        summarize: 'POST /api/agent/summarize',
        chat: 'POST /api/agent/chat'
      }
    }
  });
});

module.exports = app;
