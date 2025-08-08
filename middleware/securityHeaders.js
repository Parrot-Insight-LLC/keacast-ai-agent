const pinoHttp = require('pino-http');

const logger = pinoHttp({
  // redact secrets in logs
  redact: {
    paths: ['req.headers.authorization', 'req.body.password', 'req.body.token', 'req.body.access_token'],
    remove: true
  },
  customLogLevel: (req, res, err) => {
    if (err) return 'error';
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customProps: (req) => ({
    requestId: req.id,
    userId: req.user?.id || 'anon',
    sessionId: req.body?.sessionId || null
  }),
  serializers: {
    // log only minimal request/response for signal
    req(req) { return { id: req.id, method: req.method, url: req.url }; },
    res(res) { return { statusCode: res.statusCode }; }
  }
});

module.exports = logger;
