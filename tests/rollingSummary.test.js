'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');
const { __testables: T } = require('../controllers/openaiController');
const { createKeaTelemetry } = require('../services/keaTelemetry');

function turns(n) {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `t${i}`,
  }));
}

function legacyNegativeSliceOverflow(fullTurn) {
  if (fullTurn.length > 16) {
    return fullTurn.slice(0, fullTurn.length - 20);
  }
  return [];
}

async function run() {
  section('rolling-summary overflow table (Phase 0.7)');
  const cases = [
    [15, 0],
    [16, 0],
    [17, 0],
    [18, 0],
    [19, 0],
    [20, 0],
    [21, 1],
    [22, 2],
  ];
  for (const [n, expected] of cases) {
    const overflow = T.computeRollingSummaryOverflow(turns(n), T.constants.MAX_MEMORY);
    check(`fullTurn ${n} → overflow ${expected}`, overflow.length === expected);
  }

  section('negative-slice regression');
  const mid = turns(17);
  check('legacy 17 overflow is 14 (the bug)', legacyNegativeSliceOverflow(mid).length === 14);
  check('corrected 17 overflow is 0', T.computeRollingSummaryOverflow(mid).length === 0);
  const nineteen = turns(19);
  check('legacy 19 overflow is 18 (the bug)', legacyNegativeSliceOverflow(nineteen).length === 18);
  check('corrected 19 overflow is 0', T.computeRollingSummaryOverflow(nineteen).length === 0);
  check('legacy 20 overflow is empty hole', legacyNegativeSliceOverflow(turns(20)).length === 0);
  check('MAX_MEMORY remains 20', T.constants.MAX_MEMORY === 20);

  section('history cap and overflowed raw message absent from saved window');
  const full21 = turns(21);
  const overflow21 = T.computeRollingSummaryOverflow(full21);
  const saved21 = T.capRecentHistory(full21);
  check('saved history capped to 20', saved21.length === 20);
  check('overflow is exactly 1 at 21', overflow21.length === 1);
  check('overflowed raw message is not in saved recent history', saved21.every((m) => m.content !== overflow21[0].content));
  check('saved window is the last 20 of fullTurn', saved21[0].content === full21[1].content && saved21[19].content === full21[20].content);

  section('client history still wins / caps at MAX_MEMORY');
  const longClient = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `c${i}` }));
  const normalized = T.normalizeClientHistory(longClient);
  check('normalizeClientHistory caps at 20', normalized.length === 20);
  check('normalizeClientHistory keeps the newest 20', normalized[0].content === 'c10' && normalized[19].content === 'c29');

  section('summary key replace');
  const sets = [];
  const redisClient = {
    set: async (key, val, ex, ttl) => {
      sets.push({ key, val, ex, ttl });
      return 'OK';
    },
  };
  const telemetryReplace = createKeaTelemetry({ requestId: 'sum-replace' });
  await T.refreshRollingSummary({
    userId: 7,
    overflow: [{ role: 'user', content: 'old-turn' }],
    rollingSummary: 'prior',
    telemetry: telemetryReplace,
    generate: async () => 'merged-summary',
    redisClient,
  });
  check('summary key replaced once', sets.length === 1);
  check('summary key uses summary: prefix', sets[0].key === T.buildSummaryKey(7));
  check('summary TTL unchanged (1 week)', sets[0].ttl === 604800);
  check('stored value is the new summary not appended', sets[0].val === 'merged-summary');
  check('summary_updated true', telemetryReplace.toPayload().summary_updated === true);
  check('summary_failed false on success', telemetryReplace.toPayload().summary_failed === false);

  section('clear chat still deletes summary');
  const controllerSrc = fs.readFileSync(path.join(__dirname, '../controllers/openaiController.js'), 'utf8');
  check(
    'clearHistory deletes summary key',
    /redis\.del\(buildSummaryKey\(clearUserId\)\)/.test(controllerSrc)
  );
  check(
    'clearHistory deletes dialogue key',
    /redis\.del\(buildDialogueKey\(clearUserId\)\)/.test(controllerSrc)
  );

  section('ordering: history → dialogue → HTTP response → rolling summary');
  const order = [];
  await T.persistAnswerThenRefreshSummary({
    saveHistory: async () => { order.push('history'); },
    saveDialogue: async () => { order.push('dialogue'); },
    sendResponse: () => { order.push('response'); },
    refreshSummary: async () => { order.push('summary'); },
  });
  check(
    'order is history, dialogue, response, summary',
    order.join(',') === 'history,dialogue,response,summary'
  );

  section('post-response summary failure does not send a second response');
  const failOrder = [];
  let jsonCount = 0;
  const failTelemetry = createKeaTelemetry({ requestId: 'sum-fail' });
  await T.persistAnswerThenRefreshSummary({
    saveHistory: async () => { failOrder.push('history'); },
    saveDialogue: async () => { failOrder.push('dialogue'); },
    sendResponse: () => {
      jsonCount += 1;
      failOrder.push('response');
      failTelemetry.markResponseSent();
    },
    refreshSummary: async () => {
      failOrder.push('summary');
      return T.refreshRollingSummary({
        userId: 7,
        overflow: [{ role: 'user', content: 'x' }],
        rollingSummary: '',
        telemetry: failTelemetry,
        generate: async () => { throw new Error('azure unavailable'); },
        redisClient: { set: async () => { throw new Error('should not persist'); } },
      });
    },
  });
  const failPayload = failTelemetry.toPayload();
  check('response sent once', jsonCount === 1);
  check('summary still after response', failOrder.join(',') === 'history,dialogue,response,summary');
  check('summary_failed true', failPayload.summary_failed === true);
  check('summary_updated true because overflow existed', failPayload.summary_updated === true);
  check('no second HTTP body attempted', jsonCount === 1);
  check('failure log path has no summary text field', failPayload.summary === undefined && failPayload.message === undefined);

  const noCallTelemetry = createKeaTelemetry({ requestId: 'sum-skip' });
  noCallTelemetry.setRollingSummaryMeta({
    fullTurnMessageCount: 18,
    overflowMessageCount: 0,
    rollingSummaryChars: 0,
  });
  await T.refreshRollingSummary({
    userId: 7,
    overflow: [],
    rollingSummary: '',
    telemetry: noCallTelemetry,
    generate: async () => { throw new Error('should not be called'); },
  });
  const skipPayload = noCallTelemetry.toPayload();
  check('mid-length 18 does not generate summary', skipPayload.summary_updated === false);
  check('mid-length overflow count 0', skipPayload.summary_overflow_message_count === 0);
}

module.exports = { run };
