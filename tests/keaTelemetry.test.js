'use strict';

const { check, section } = require('./harness');
const { createKeaTelemetry } = require('../services/keaTelemetry');

async function run() {
  section('keaTelemetry');

  const t = createKeaTelemetry({ requestId: 'abc-123' });
  t.markStart('memory_load');
  t.markEnd('memory_load');
  t.recordAzureCall(12, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 5 } });
  t.recordTool('getUpcomingTransactions', 8);
  t.recordBlock('systemTotal', 4000);
  t.setResponseCharacterCount(250);
  t.recordWriteFlags({
    write_proposed: true,
    write_confirmation_detected: true,
    write_attempted: true,
    write_committed: false,
    write_blocked: true,
  });
  const payload = t.toPayload();

  check('requestId present', payload.requestId === 'abc-123');
  check('event name', payload.event === 'kea_chat_turn');
  check('memory_load_ms recorded', typeof payload.memory_load_ms === 'number');
  check('azure_round_count', payload.azure_round_count === 1);
  check('azure_round_1_ms', payload.azure_round_1_ms === 12);
  check('token usage summed', payload.input_tokens === 100 && payload.output_tokens === 20 && payload.total_tokens === 120);
  check('cached_input_tokens', payload.cached_input_tokens === 5);
  check('tool_call_count', payload.tool_call_count === 1);
  check('tool_getUpcomingTransactions_ms', payload.tool_getUpcomingTransactions_ms === 8);
  check('write flags', payload.write_proposed === true && payload.write_blocked === true && payload.write_committed === false);
  check('no message text field', payload.message === undefined && payload.token === undefined);
  check('grounding placeholders present', payload.grounding_performed === false && payload.grounding_strategy === null);
  check('response_character_count', payload.response_character_count === 250);
}

module.exports = { run };
