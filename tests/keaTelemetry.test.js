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
  check('capsule_present defaults false', pDefault.capsule_present === false);
  check('capsule_kind defaults none', pDefault.capsule_kind === 'none');
  check('capsule_version defaults null', pDefault.capsule_version === null);
  check('capsule_account_match defaults null', pDefault.capsule_account_match === null);

  tG.recordGrounding({
    capsule_present: true,
    capsule_kind: 'upcoming',
    capsule_version: 1,
    capsule_account_match: true,
    capsule_transition: 'continued',
  });
  const pCap = tG.toPayload();
  check('capsule_present recorded', pCap.capsule_present === true);
  check('capsule_kind recorded', pCap.capsule_kind === 'upcoming');
  check('capsule_version recorded', pCap.capsule_version === 1);
  check('capsule_account_match recorded', pCap.capsule_account_match === true);
  check('continuation_used unchanged by capsule telemetry', pCap.continuation_used === true);
  check('capsule telemetry has no account id', pCap.accountId === undefined && pCap.lastAccountId === undefined);
  check('capsule_transition defaults none', pDefault.capsule_transition === 'none');
  check('capsule_transition recorded', pCap.capsule_transition === 'continued');

  section('keaTelemetry 3B.4 evidence defaults');
  check('evidence_ledger_present defaults false', pDefault.evidence_ledger_present === false);
  check('evidence_prompt_mode defaults none', pDefault.evidence_prompt_mode === 'none');
  check('evidence_source_kind defaults none', pDefault.evidence_source_kind === 'none');
  check('evidence_status defaults none', pDefault.evidence_status === 'none');
  check('evidence_projection_status defaults not_applicable', pDefault.evidence_projection_status === 'not_applicable');
  check('evidence_promptable defaults false', pDefault.evidence_promptable === false);
  check('evidence_claim_count_bucket defaults 0', pDefault.evidence_claim_count_bucket === '0');
  check('evidence_list_truncated defaults false', pDefault.evidence_list_truncated === false);
  check('evidence_prompt_chars_bucket defaults 0', pDefault.evidence_prompt_chars_bucket === '0');
  check('evidence_ledger_chars_bucket defaults 0', pDefault.evidence_ledger_chars_bucket === '0');
  check('evidence_internal_stripped defaults false', pDefault.evidence_internal_stripped === false);
  check('evidence_rollback_active defaults false', pDefault.evidence_rollback_active === false);
  check('evidence_projection_failure_reason defaults none', pDefault.evidence_projection_failure_reason === 'none');

  const tEv = createKeaTelemetry({ requestId: 'req-evidence' });
  tEv.recordEvidence({
    evidence_ledger_present: true,
    evidence_prompt_mode: 'ledger_v1',
    evidence_source_kind: 'cashflow_upcoming',
    evidence_status: 'complete_empty',
    evidence_projection_status: 'ok',
    evidence_promptable: true,
    evidence_claim_count_bucket: '4-7',
    evidence_list_truncated: false,
    evidence_prompt_chars_bucket: '1025-2048',
    evidence_ledger_chars_bucket: '2049-4096',
    evidence_internal_stripped: true,
    evidence_rollback_active: false,
    evidence_projection_failure_reason: 'none',
    amount: 705,
    merchant: 'Daycare',
    ledger: { secrets: true },
  });
  const pEv = tEv.toPayload();
  check('evidence mode recorded', pEv.evidence_prompt_mode === 'ledger_v1');
  check('complete_empty status recorded', pEv.evidence_status === 'complete_empty');
  check('internal_stripped recorded', pEv.evidence_internal_stripped === true);
  check('arbitrary amount rejected', pEv.amount === undefined);
  check('merchant rejected', pEv.merchant === undefined);
  check('raw ledger rejected', pEv.ledger === undefined);
  check('no observation code field', pEv.observations === undefined && pEv.evidence_observation_code === undefined);

  tEv.recordEvidence({ evidence_prompt_mode: 'not-a-mode', evidence_source_kind: 'http://evil.example' });
  const pBad = tEv.toPayload();
  check('invalid mode falls back', pBad.evidence_prompt_mode === 'none');
  check('arbitrary source kind unknown', pBad.evidence_source_kind === 'unknown');

  const threw = createKeaTelemetry({ requestId: 'req-ev-throw' });
  threw.recordEvidence(undefined);
  check('recordEvidence null is safe', threw.toPayload().evidence_prompt_mode === 'none');

  section('keaTelemetry response validation shadow defaults');
  check('response_validation_performed defaults false', pDefault.response_validation_performed === false);
  check('response_validation_status defaults not_applicable', pDefault.response_validation_status === 'not_applicable');
  check('response_validation_contract_status defaults not_applicable', pDefault.response_validation_contract_status === 'not_applicable');
  check('response_validation_primary_violation defaults none', pDefault.response_validation_primary_violation === 'none');
  check('response_validation_ms defaults 0', pDefault.response_validation_ms === 0);
  check('response_validation_exception_reason defaults none', pDefault.response_validation_exception_reason === 'none');

  const tRv = createKeaTelemetry({ requestId: 'req-rv' });
  tRv.recordResponseValidation({
    response_validation_performed: true,
    response_validation_shadow: true,
    response_validation_status: 'invalid',
    response_validation_contract_status: 'ok',
    response_validation_primary_violation: 'UNSUPPORTED_AMOUNT',
    response_validation_primary_severity: 'critical',
    response_validation_violation_count_bucket: '1',
    response_validation_indeterminate_count_bucket: '0',
    response_validation_material_claim_count_bucket: '2-3',
    response_validation_ms: 1,
    response_validation_exception_reason: 'none',
    response_validation_flag_enabled: true,
    amount: 279.58,
    merchant: 'Target',
    text: 'You spent $280 at Target.',
  });
  const pRv = tRv.toPayload();
  check('response validation recorded', pRv.response_validation_status === 'invalid' && pRv.response_validation_shadow === true);
  check('response validation amount rejected', pRv.amount === undefined);
  check('response validation merchant rejected', pRv.merchant === undefined);
  check('response validation text rejected', pRv.text === undefined && pRv.response === undefined);
  const rvBlob = JSON.stringify(pRv);
  check('response validation json has no $ or Target', rvBlob.indexOf('$') === -1 && rvBlob.indexOf('Target') === -1);

  const rvThrew = createKeaTelemetry({ requestId: 'req-rv-throw' });
  rvThrew.recordResponseValidation(undefined);
  check('recordResponseValidation null is safe', rvThrew.toPayload().response_validation_status === 'not_applicable');

  section('keaTelemetry response enforcement defaults');
  check('enforcement eligible defaults false', pDefault.response_enforcement_eligible === false);
  check('enforcement blocked defaults false', pDefault.response_enforcement_blocked === false);
  check('enforcement reason defaults none', pDefault.response_enforcement_reason === 'none');
  check('enforcement capability defaults none', pDefault.response_enforcement_capability === 'none');
  check('enforcement fallback defaults false', pDefault.response_enforcement_fallback_used === false);

  const tEnf = createKeaTelemetry({ requestId: 'req-enf' });
  tEnf.recordResponseEnforcement({
    response_enforcement_eligible: true,
    response_enforcement_enabled: true,
    response_enforcement_blocked: true,
    response_enforcement_reason: 'eligible_invalid_blocked',
    response_enforcement_capability: 'financial_forecast',
    response_enforcement_severity: 'critical',
    response_enforcement_fallback_used: true,
    amount: 1193.93,
    merchant: 'Target',
    text: 'Your projected balance is $4846.97',
  });
  const pEnf = tEnf.toPayload();
  check('enforcement blocked recorded', pEnf.response_enforcement_blocked === true);
  check('enforcement reason recorded', pEnf.response_enforcement_reason === 'eligible_invalid_blocked');
  check('enforcement amount rejected', pEnf.amount === undefined);
  check('enforcement merchant rejected', pEnf.merchant === undefined);
  check('enforcement text rejected', pEnf.text === undefined);
  const enfBlob = JSON.stringify(pEnf);
  check('enforcement json has no $ or Target', enfBlob.indexOf('$') === -1 && enfBlob.indexOf('Target') === -1);

  const enfThrew = createKeaTelemetry({ requestId: 'req-enf-throw' });
  enfThrew.recordResponseEnforcement(undefined);
  check('recordResponseEnforcement null is safe', enfThrew.toPayload().response_enforcement_blocked === false);

  section('keaTelemetry trend blocked diagnostic defaults');
  check('trend_diag_performed omitted by default', pDefault.trend_diag_performed === undefined);
  check('no trend_diag keys by default',
    Object.keys(pDefault).filter((k) => k.indexOf('trend_diag_') === 0).length === 0);
  const tDiag = createKeaTelemetry({ requestId: 'req-diag' });
  tDiag.recordTrendBlockedDiagnostic({
    trend_diag_performed: true,
    trend_diag_reason: 'captured',
    trend_diag_authorized_direction: 'decreasing',
    trend_diag_primary_failure: 'unsupported_comparison',
    trend_diag_has_percent_failure: true,
    trend_diag_has_direction_failure: false,
    amount: 13.71,
    text: 'a 13.71% decrease',
    path: 'facts.trend.spending.firstToLast.percent',
  });
  const pDiag = tDiag.toPayload();
  check('trend diag recorded when performed', pDiag.trend_diag_performed === true);
  check('trend diag amount rejected', pDiag.amount === undefined);
  check('trend diag text rejected', pDiag.text === undefined);
  check('trend diag path rejected', pDiag.path === undefined);
  check('trend diag json has no 13.71', JSON.stringify(pDiag).indexOf('13.71') === -1);

  if (prevSecret === undefined) delete process.env.CASHFLOW_JWT_SECRET;
  else process.env.CASHFLOW_JWT_SECRET = prevSecret;
}

module.exports = { run };
