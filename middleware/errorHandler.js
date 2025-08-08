module.exports = function errorHandler(err, req, res, _next) {
    req.log?.error({ err, requestId: req.id }, 'Unhandled error');
    const status = err.status || 500;
    res.status(status).json({
      error: status >= 500 ? 'Internal server error' : err.message,
      requestId: req.id
    });
  };
  