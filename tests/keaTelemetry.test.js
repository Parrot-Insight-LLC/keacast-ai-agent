'use strict';

const { check, section } = require('./harness');
const {
  createKeaTelemetry,
  hashUserKey,
  identityFromCashflowAuth,
} = require('../services/keaTelemetry');

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
  check('write_gate_armed_at_start aliases write_proposed', payload.write_gate_armed_at_start === true && payload.write_proposed === true);
  check('no message text field', payload.message === undefined && payload.token === undefined);
  check('grounding placeholders present', payload.grounding_performed === false && payload.grounding_strategy === null);
  check('response_character_count', payload.response_character_count === 250);

  section('keaTelemetry selected-account fields omitted when unused');
  check('source null until set', payload.selected_account_source === null);
  check('cache_hit null when lookup did not run', payload.selected_account_cache_hit === null);
  check('lookup_ms null when unused', payload.selected_account_cache_lookup_ms === null);
  check('http_ms null when unused', payload.selected_account_http_ms === null);
  check('parse_ms null when unused', payload.selected_account_parse_ms === null);
  check('stringify_ms null when unused', payload.selected_account_stringify_ms === null);
  check('redis_set_ms null when unused', payload.selected_account_redis_set_ms === null);
  check('redis_ping_ms null when unused', payload.selected_account_redis_ping_ms === null);
  check('payload_bytes null when unused', payload.selected_account_payload_bytes === null);
  check('full_payload_bytes null when unused', payload.selected_account_full_payload_bytes === null);
  check('payload_key_bytes null when unused', payload.selected_account_payload_key_bytes === null);
  check('write_ms null when unused', payload.selected_account_cache_write_ms === null);
  check('no raw userId on payload', payload.userId === undefined);
  check('no sessionId on payload', payload.sessionId === undefined);
  check('default unauthenticated', payload.authenticated === false && payload.userKey === null);

  section('keaTelemetry selected-account fields when phases run');
  const t2 = createKeaTelemetry({ requestId: 'req-2' });
  t2.setSelectedAccountMeta({ source: 'tool-fresh', cacheHit: false });
  t2.markStart('selected_account_cache_lookup');
  t2.markEnd('selected_account_cache_lookup');
  t2.markStart('selected_account_http');
  t2.markEnd('selected_account_http');
  t2.markStart('selected_account_stringify');
  t2.markEnd('selected_account_stringify');
  t2.markStart('selected_account_redis_set');
  t2.markEnd('selected_account_redis_set');
  t2.setSelectedAccountMeta({
    source: 'tool-fresh',
    cacheHit: false,
    payloadBytes: 2048,
    fullPayloadBytes: 4_000_000,
    payloadKeyBytes: { cfTransactions: 3_000_000 },
  });
  const p2 = t2.toPayload();
  check('source tool-fresh', p2.selected_account_source === 'tool-fresh');
  check('cache_hit false on miss', p2.selected_account_cache_hit === false);
  check('lookup_ms number on miss path', typeof p2.selected_account_cache_lookup_ms === 'number');
  check('http_ms number on miss path', typeof p2.selected_account_http_ms === 'number');
  check('parse_ms still null (axios already parsed)', p2.selected_account_parse_ms === null);
  check('stringify_ms number on miss path', typeof p2.selected_account_stringify_ms === 'number');
  check('redis_set_ms number on miss path', typeof p2.selected_account_redis_set_ms === 'number');
  check('cache_write_ms is stringify+set', p2.selected_account_cache_write_ms === p2.selected_account_stringify_ms + p2.selected_account_redis_set_ms);
  check('payload_bytes compact size', p2.selected_account_payload_bytes === 2048);
  check('full_payload_bytes recorded on miss', p2.selected_account_full_payload_bytes === 4_000_000);
  check('payload_key_bytes histogram present', p2.selected_account_payload_key_bytes.cfTransactions === 3_000_000);

  const t3 = createKeaTelemetry({ requestId: 'req-3' });
  t3.setSelectedAccountMeta({ source: 'tool-cache', cacheHit: true });
  t3.markStart('selected_account_cache_lookup');
  t3.markEnd('selected_account_cache_lookup');
  t3.markStart('selected_account_parse');
  t3.markEnd('selected_account_parse');
  const p3 = t3.toPayload();
  check('source tool-cache', p3.selected_account_source === 'tool-cache');
  check('cache_hit true', p3.selected_account_cache_hit === true);
  check('http_ms null on cache hit', p3.selected_account_http_ms === null);
  check('write_ms null on cache hit', p3.selected_account_cache_write_ms === null);
  check('parse_ms number on cache hit', typeof p3.selected_account_parse_ms === 'number');

  const tSnap = createKeaTelemetry({ requestId: 'req-snap' });
  tSnap.setSelectedAccountMeta({ source: 'snapshot' });
  const pSnap = tSnap.toPayload();
  check('snapshot source', pSnap.selected_account_source === 'snapshot');
  check('snapshot does not invent cache_hit', pSnap.selected_account_cache_hit === null);

  section('keaTelemetry identity');
  const prevSecret = process.env.CASHFLOW_JWT_SECRET;
  process.env.CASHFLOW_JWT_SECRET = 'phase05-telemetry-secret';
  const id = identityFromCashflowAuth({ cashflowUser: { id: 7 }, body: { sessionId: 99 } });
  check('authenticated after cashflowAuth', id.authenticated === true);
  check('userKey is not raw id', id.userKey !== '7' && id.userKey !== 7);
  check('userKey is 16-char hex', /^[a-f0-9]{16}$/.test(id.userKey));
  check('hashUserKey matches identity', id.userKey === hashUserKey(7));
  check('ignores body.sessionId without cashflowUser', identityFromCashflowAuth({ body: { sessionId: 99 } }).authenticated === false);
  check('anon identity has null userKey', identityFromCashflowAuth({}).userKey === null);

  const tAuth = createKeaTelemetry({ requestId: 'req-auth' });
  tAuth.setIdentity(id);
  const pAuth = tAuth.toPayload();
  check('payload authenticated true', pAuth.authenticated === true);
  check('payload userKey hashed', pAuth.userKey === id.userKey);
  check('payload still has no userId', pAuth.userId === undefined);

  const tWrite = createKeaTelemetry({ requestId: 'req-write' });
  tWrite.recordWriteFlags({ write_gate_armed_at_start: true });
  const pWrite = tWrite.toPayload();
  check('write_gate_armed_at_start sets write_proposed alias', pWrite.write_gate_armed_at_start === true && pWrite.write_proposed === true);

  if (prevSecret === undefined) delete process.env.CASHFLOW_JWT_SECRET;
  else process.env.CASHFLOW_JWT_SECRET = prevSecret;
}

module.exports = { run };
