const { v4: uuidv4 } = require('uuid');

module.exports = function requestId(req, _res, next) {
  // honor existing trace IDs if present (from gateway, frontdoor, etc.)
  req.id = req.headers['x-request-id'] || uuidv4();
  next();
};
