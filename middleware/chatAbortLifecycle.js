'use strict';

const { createKeaTelemetry } = require('../services/keaTelemetry');
const { createRequestLifecycle } = require('../services/keaRequestBudget');

function isChatPost(req) {
  if (!req || req.method !== 'POST') return false;
  const url = String(req.originalUrl || req.url || '').split('?')[0];
  return url === '/api/agent/chat' || url.endsWith('/api/agent/chat');
}

function attachChatAbortLifecycle(req, res, next) {
  if (!isChatPost(req)) return next();
  if (req.keaLifecycle) return next();
  const telemetry = createKeaTelemetry({ requestId: req.id });
  const lifecycle = createRequestLifecycle({ req, res, telemetry, requestId: req.id });
  lifecycle.setStage('request_received');
  lifecycle.attachListeners();
  req.keaTelemetry = telemetry;
  req.keaLifecycle = lifecycle;
  return next();
}

module.exports = {
  attachChatAbortLifecycle,
  isChatPost,
};
