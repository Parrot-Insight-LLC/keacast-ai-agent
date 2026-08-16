const pinoHttp = require('pino-http');

// Identity belongs on kea_chat_turn after cashflowAuth (authenticated + hashed
// userKey). Do not bind userId/sessionId here: this runs before body parse and
// JWT verify, which produced the misleading userId:"anon" / sessionId:null.
function buildPinoCustomProps(req) {
  return {
    requestId: req && req.id != null ? req.id : null,
  };
}

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
  customProps: (req) => buildPinoCustomProps(req),
  serializers: {
    // log only minimal request/response for signal
    req(req) { return { id: req.id, method: req.method, url: req.url }; },
    res(res) { return { statusCode: res.statusCode }; }
  }
});

logger.buildPinoCustomProps = buildPinoCustomProps;
module.exports = logger;
