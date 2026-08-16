'use strict';

const { check, section } = require('./harness');
const {
  createKeaTelemetry,
  hashUserKey,
  hashAccountKey,
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
  check('write_response_mode defaults none', payload.write_response_mode === 'none');
  t.recordWriteFlags({ write_response_mode: 'deterministic_commit' });
  check('write_response_mode recorded', t.toPayload().write_response_mode === 'deterministic_commit');
  check('write_gate_armed_at_start aliases write_proposed', payload.write_gate_armed_at_start === true && payload.write_proposed === true);
  check('no message text field', payload.message === undefined && payload.token === undefined);
  check('grounding placeholders present', payload.grounding_performed === false && payload.grounding_strategy === null);
  check('grounding_source_count defaults 0', payload.grounding_source_count === 0);
  check('grounding_prefetch_ms defaults 0', payload.grounding_prefetch_ms === 0);
  check('continuation_used defaults false', payload.continuation_used === false);
  check('affirmative_resolution defaults none', payload.affirmative_resolution === 'none');
  check('capability_confidence_bucket defaults null', payload.capability_confidence_bucket === null);
  check('response_character_count', payload.response_character_count === 250);
  check('summary_updated defaults false', payload.summary_updated === false);
  check('summary_update_ms is 0 when no summary call', payload.summary_update_ms === 0);
  check('history_save_ms defaults 0', payload.history_save_ms === 0);
  check('dialogue_state_save_ms defaults 0', payload.dialogue_state_save_ms === 0);
  check('summary_failed defaults false', payload.summary_failed === false);
  check('response_sent_ms null until marked', payload.response_sent_ms === null);
  check('full_turn_message_count null until set', payload.full_turn_message_count === null);
  check('summary_overflow_message_count defaults 0', payload.summary_overflow_message_count === 0);
  check('rolling_summary_chars defaults 0', payload.rolling_summary_chars === 0);
  check('no summary content field', payload.summary === undefined && payload.rolling_summary === undefined && payload.summary_text === undefined);

  section('keaTelemetry selected-account fields omitted when unused');
  check('source null until set', payload.selected_account_source === null);
  check('cache_hit null when lookup did not run', payload.selected_account_cache_hit === null);
  check('lookup_ms null when unused', payload.selected_account_cache_lookup_ms === null);
  check('http_ms null when unused', payload.selected_account_http_ms === null);
  check('parse_ms null when unused', payload.selected_account_parse_ms === null);
  check('stringify_ms null when unused', payload.selected_account_stringify_ms === null);
  check('compact_ms null when unused', payload.selected_account_compact_ms === null);
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
  check('full_payload_bytes still recordable when explicitly set', p2.selected_account_full_payload_bytes === 4_000_000);
  check('payload_key_bytes histogram present when explicitly set', p2.selected_account_payload_key_bytes.cfTransactions === 3_000_000);

  const tCompact = createKeaTelemetry({ requestId: 'req-compact' });
  tCompact.markStart('selected_account_compact');
  tCompact.markEnd('selected_account_compact');
  tCompact.setSelectedAccountMeta({
    source: 'tool-fresh',
    cacheHit: false,
    payloadBytes: 5145,
    fullPayloadBytes: null,
    payloadKeyBytes: null,
  });
  const pCompact = tCompact.toPayload();
  check('compact_ms number when marked', typeof pCompact.selected_account_compact_ms === 'number');
  check('fresh miss leaves full_payload_bytes null', pCompact.selected_account_full_payload_bytes === null);
  check('fresh miss leaves histogram null', pCompact.selected_account_payload_key_bytes === null);

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
  check('hashAccountKey is not raw account id', hashAccountKey(22) !== '22' && hashAccountKey(22) !== 22);
  check('hashAccountKey is 16-char hex', /^[a-f0-9]{16}$/.test(hashAccountKey(22)));
  check('user and account hashes differ', hashUserKey(22) !== hashAccountKey(22));
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

  section('keaTelemetry post-Azure lifecycle spans (Phase 0.6C)');
  const tPost = createKeaTelemetry({ requestId: 'req-post-azure' });
  tPost.setSummaryUpdated(false);
  await tPost.measureSpan('history_save', async () => {
    await new Promise((r) => setTimeout(r, 12));
  });
  await tPost.measureSpan('dialogue_state_save', async () => {
    await new Promise((r) => setTimeout(r, 12));
  });
  const pNoSummary = tPost.toPayload();
  check('summary_updated false when call did not run', pNoSummary.summary_updated === false);
  check('summary_update_ms is 0 when call did not run', pNoSummary.summary_update_ms === 0);
  check('history_save_ms populated', typeof pNoSummary.history_save_ms === 'number' && pNoSummary.history_save_ms >= 10);
  check('dialogue_state_save_ms populated', typeof pNoSummary.dialogue_state_save_ms === 'number' && pNoSummary.dialogue_state_save_ms >= 10);
  check('post-azure payload has no summary text', pNoSummary.summary === undefined && pNoSummary.messages === undefined);

  const tSummary = createKeaTelemetry({ requestId: 'req-summary' });
  tSummary.setSummaryUpdated(true);
  await tSummary.measureSpan('summary_update', async () => {
    await new Promise((r) => setTimeout(r, 18));
  });
  const pSummary = tSummary.toPayload();
  check('summary_updated true when call ran', pSummary.summary_updated === true);
  check('summary_update_ms measures the call', typeof pSummary.summary_update_ms === 'number' && pSummary.summary_update_ms >= 15);
  check('summary_update_ms is not mixed into azure_round_1', pSummary.azure_round_1_ms === undefined);
  check('summary_updated true still has no summary content', pSummary.summary === undefined && pSummary.rolling_summary === undefined);

  const tResp = createKeaTelemetry({ requestId: 'req-response-sent' });
  tResp.markResponseSent();
  tResp.setRollingSummaryMeta({
    fullTurnMessageCount: 21,
    overflowMessageCount: 1,
    rollingSummaryChars: 80,
  });
  tResp.setSummaryFailed(true);
  const pResp = tResp.toPayload();
  check('response_sent_ms is a number after mark', typeof pResp.response_sent_ms === 'number' && pResp.response_sent_ms >= 0);
  check('full_turn_message_count recorded', pResp.full_turn_message_count === 21);
  check('summary_overflow_message_count recorded', pResp.summary_overflow_message_count === 1);
  check('rolling_summary_chars recorded', pResp.rolling_summary_chars === 80);
  check('summary_failed true when set', pResp.summary_failed === true);
  check('response_sent payload has no message text', pResp.message === undefined && pResp.summary === undefined);
  check('request_total_ms still present', typeof pResp.request_total_ms === 'number');

  section('keaTelemetry Phase 1 grounding fields');
  const tG = createKeaTelemetry({ requestId: 'req-grounding' });
  tG.recordGrounding({
    conversation_intent: 'financial_lookup',
    grounding_required: true,
    grounding_performed: true,
    grounding_strategy: 'prefetch_read',
    response_mode: 'grounded',
    grounding_source_count: 1,
    grounding_prefetch_ms: 42,
    capability_confidence_bucket: 'high',
    continuation_used: true,
    effective_capability: 'financial_lookup',
    pending_write_routing_reason: 'topic_switch',
    affirmative_resolution: 'invitation_clarify',
    grounding_evidence_status: 'ok',
    historical_prefetch_page_count: 3,
    historical_prefetch_row_count: 120,
    historical_match_count: 40,
    historical_lookup_count: 4,
    historical_period_read_count: 2,
    ui_action_count: 1,
  });
  const pG = tG.toPayload();
  check('conversation_intent recorded', pG.conversation_intent === 'financial_lookup');
  check('grounding_required true', pG.grounding_required === true);
  check('grounding_performed true', pG.grounding_performed === true);
  check('grounding_strategy prefetch_read', pG.grounding_strategy === 'prefetch_read');
  check('response_mode grounded', pG.response_mode === 'grounded');
  check('grounding_source_count', pG.grounding_source_count === 1);
  check('grounding_prefetch_ms', pG.grounding_prefetch_ms === 42);
  check('capability_confidence_bucket', pG.capability_confidence_bucket === 'high');
  check('continuation_used true', pG.continuation_used === true);
  check('effective_capability recorded', pG.effective_capability === 'financial_lookup');
  check('pending_write_routing_reason topic_switch', pG.pending_write_routing_reason === 'topic_switch');
  check('affirmative_resolution recorded', pG.affirmative_resolution === 'invitation_clarify');
  check('grounding_evidence_status ok', pG.grounding_evidence_status === 'ok');
  check('historical_prefetch_page_count', pG.historical_prefetch_page_count === 3);
  check('historical_prefetch_row_count', pG.historical_prefetch_row_count === 120);
  check('historical_match_count', pG.historical_match_count === 40);
  check('historical_lookup_count', pG.historical_lookup_count === 4);
  check('historical_period_read_count', pG.historical_period_read_count === 2);
  check('ui_action_count', pG.ui_action_count === 1);
  check('grounding payload has no evidence', pG.evidence === undefined && pG.facts === undefined);
  check('grounding payload has no merchant', pG.merchant === undefined && pG.lastSubjectValue === undefined);
  check('grounding payload has no amounts', pG.amount === undefined && pG.expenseTotal === undefined
    && pG.spentTotal === undefined);
  check('default financial_macro none on unused recorder', pG.financial_macro === 'none');
  check('grounding payload has no search account filter flag', pG.search_account_filter_applied === undefined);
  check('grounding payload has no message', pG.message === undefined && pG.prompt === undefined);

  const tDefault = createKeaTelemetry({ requestId: 'req-grounding-default' });
  const pDefault = tDefault.toPayload();
  check('pending_write_routing_reason defaults none', pDefault.pending_write_routing_reason === 'none');
  check('effective_capability defaults null', pDefault.effective_capability === null);

  if (prevSecret === undefined) delete process.env.CASHFLOW_JWT_SECRET;
  else process.env.CASHFLOW_JWT_SECRET = prevSecret;
}

module.exports = { run };
