const bcrypt = require('bcryptjs');
const { generateToken } = require('../utils/tokenUtils');

// For demo purposes, we'll use a simple user object
// In production, you'd want to use a database
const demoUser = {
  id: 1,
  username: 'demo',
  email: 'demo@example.com',
  // Password: 'password123' (hashed)
  password: '$2b$10$nRHDsv.t4cfdDrTnGdN0uehvxrkv6O5JAAmgph672l7LYh.CdUDwW'
};

const login = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ 
        message: 'Username and password are required' 
      });
    }

    // Check if user exists (in demo, we only have one user)
    if (username !== demoUser.username) {
      return res.status(401).json({ 
        message: 'Invalid credentials' 
      });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, demoUser.password);
    if (!isValidPassword) {
      return res.status(401).json({ 
        message: 'Invalid credentials' 
      });
    }

    // Generate JWT token
    const token = generateToken({
      id: demoUser.id,
      username: demoUser.username,
      email: demoUser.email
    });

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: demoUser.id,
        username: demoUser.username,
        email: demoUser.email
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ 
      message: 'Internal server error' 
    });
  }
};

const getProfile = (req, res) => {
  res.json({
    message: 'Profile retrieved successfully',
    user: req.user
  });
};

module.exports = {
  login,
  getProfile
}; 