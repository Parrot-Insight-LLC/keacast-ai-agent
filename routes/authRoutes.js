const express = require('express');
const router = express.Router();
const { login, getProfile } = require('../controllers/authController');
const auth = require('../middleware/authMiddleware');

// Public route - no authentication required
router.post('/login', login);

// Protected route - requires authentication
router.get('/profile', auth, getProfile);

module.exports = router; 