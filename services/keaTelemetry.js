'use strict';

const crypto = require('crypto');

/**
 * Per-turn Kea chat telemetry. One JSON line, no PII / amounts / JWT / message text.
 * Phase 1 grounding fields are present as null/false placeholders so the schema
 * is stable before grounding is implemented.
 */

function hashUserKey(userId) {
  if (userId == null || userId === '') return null;
  const secret = process.env.CASHFLOW_JWT_SECRET || process.env.key_word;
  const material = `kea-user-key:${String(userId)}`;
  const digest = secret
    ? crypto.createHmac('sha256', secret).update(material).digest('hex')
    : crypto.createHash('sha256').update(material).digest('hex');
  return digest.slice(0, 16);
}

/**
 * Identity for kea_chat_turn. Reads only cashflowAuth's trusted user, never
 * body.sessionId / req.user (those produced userId:"anon" / sessionId:null).
 */
function identityFromCashflowAuth(req) {
  const id = req && req.cashflowUser && req.cashflowUser.id;
  if (id == null || id === '') {
    return { authenticated: false, userKey: null };
  }
  return { authenticated: true, userKey: hashUserKey(id) };
}

function createKeaTelemetry({ requestId } = {}) {
  const startedAt = Date.now();
  const marks = Object.create(null);
  const azureRounds = [];
  const tools = [];
  const blocks = Object.create(null);
  const write = {
    write_proposed: false,
    write_gate_armed_at_start: false,
    write_confirmation_detected: false,
    write_attempted: false,
    write_committed: false,
    write_blocked: false,
  };
  let input_tokens = 0;
  let cached_input_tokens = 0;
  let output_tokens = 0;
  let total_tokens = 0;
  let response_character_count = 0;
  let azure_round_count = 0;
  let authenticated = false;
  let userKey = null;
  let selected_account_source = null;
  let selected_account_cache_hit = null;
  let selected_account_payload_bytes = null;
  let selected_account_full_payload_bytes = null;
  let selected_account_payload_key_bytes = null;

  function markStart(name) {
    marks[name] = { t0: Date.now() };
  }

  function markEnd(name) {
    const m = marks[name];
    if (!m) return 0;
    m.ms = Date.now() - m.t0;
    return m.ms;
  }

  function recordAzureCall(ms, usage) {
    azure_round_count += 1;
    azureRounds.push({ round: azure_round_count, ms: Number(ms) || 0 });
    if (usage && typeof usage === 'object') {
      input_tokens += Number(usage.prompt_tokens) || 0;
      output_tokens += Number(usage.completion_tokens) || 0;
      total_tokens += Number(usage.total_tokens) || 0;
      const cached = usage.prompt_tokens_details?.cached_tokens
        ?? usage.prompt_tokens_details?.cached
        ?? usage.cached_tokens
        ?? 0;
      cached_input_tokens += Number(cached) || 0;
    }
  }

  function recordTool(name, ms) {
    tools.push({ name: String(name || 'unknown'), ms: Number(ms) || 0 });
  }

  function recordBlock(name, chars) {
    blocks[name] = Number(chars) || 0;
  }

  function recordWriteFlags(flags) {
    Object.assign(write, flags || {});
  }

  function setResponseCharacterCount(n) {
    response_character_count = Number(n) || 0;
  }

  function setIdentity(identity) {
    authenticated = !!(identity && identity.authenticated);
    userKey = identity && identity.userKey ? String(identity.userKey) : null;
  }

  function setSelectedAccountMeta({
    source,
    cacheHit,
    payloadBytes,
    fullPayloadBytes,
    payloadKeyBytes,
  } = {}) {
    selected_account_source = source == null ? null : String(source);
    if (cacheHit === true || cacheHit === false) {
      selected_account_cache_hit = cacheHit;
    } else {
      selected_account_cache_hit = null;
    }
    if (payloadBytes == null) selected_account_payload_bytes = null;
    else selected_account_payload_bytes = Number(payloadBytes) || 0;
    if (fullPayloadBytes == null) selected_account_full_payload_bytes = null;
    else selected_account_full_payload_bytes = Number(fullPayloadBytes) || 0;
    selected_account_payload_key_bytes =
      payloadKeyBytes && typeof payloadKeyBytes === 'object' ? payloadKeyBytes : null;
  }

  function toPayload() {
    const writeArmed = !!(write.write_gate_armed_at_start || write.write_proposed);
    const payload = {
      event: 'kea_chat_turn',
      requestId: requestId || null,
      authenticated,
      userKey,
      request_total_ms: Date.now() - startedAt,
      context_build_ms: marks.context_build?.ms ?? null,
      selected_account_fetch_ms: marks.selected_account_fetch?.ms ?? null,
      selected_account_source,
      selected_account_cache_hit,
      selected_account_cache_lookup_ms: marks.selected_account_cache_lookup?.ms ?? null,
      selected_account_http_ms: marks.selected_account_http?.ms ?? null,
      selected_account_parse_ms: marks.selected_account_parse?.ms ?? null,
      selected_account_stringify_ms: marks.selected_account_stringify?.ms ?? null,
      selected_account_redis_set_ms: marks.selected_account_redis_set?.ms ?? null,
      selected_account_redis_ping_ms: marks.selected_account_redis_ping?.ms ?? null,
      selected_account_cache_write_ms: (
        marks.selected_account_stringify?.ms != null || marks.selected_account_redis_set?.ms != null
      )
        ? (marks.selected_account_stringify?.ms || 0) + (marks.selected_account_redis_set?.ms || 0)
        : (marks.selected_account_cache_write?.ms ?? null),
      selected_account_payload_bytes,
      selected_account_full_payload_bytes,
      selected_account_payload_key_bytes,
      memory_load_ms: marks.memory_load?.ms ?? null,
      azure_round_count,
      tool_call_count: tools.length,
      tool_execution_total_ms: tools.reduce((sum, t) => sum + t.ms, 0),
      input_tokens,
      cached_input_tokens,
      output_tokens,
      total_tokens,
      response_character_count,
      write_gate_armed_at_start: writeArmed,
      write_proposed: writeArmed,
      write_confirmation_detected: !!write.write_confirmation_detected,
      write_attempted: !!write.write_attempted,
      write_committed: !!write.write_committed,
      write_blocked: !!write.write_blocked,
      grounding_required: false,
      grounding_performed: false,
      grounding_strategy: null,
      conversation_intent: null,
      response_mode: 'unspecified',
      estimated_block_chars: blocks,
    };
    for (const r of azureRounds) {
      payload[`azure_round_${r.round}_ms`] = r.ms;
    }
    for (const t of tools) {
      const key = `tool_${String(t.name).replace(/[^A-Za-z0-9_]/g, '_')}_ms`;
      payload[key] = (payload[key] || 0) + t.ms;
    }
    return payload;
  }

  function emit(log) {
    const payload = toPayload();
    try {
      if (log && typeof log.info === 'function') {
        log.info(payload, 'kea_chat_turn');
      } else {
        console.log(JSON.stringify(payload));
      }
    } catch (e) {
      console.warn('kea telemetry emit failed:', e.message);
    }
    return payload;
  }

  return {
    markStart,
    markEnd,
    recordAzureCall,
    recordTool,
    recordBlock,
    recordWriteFlags,
    setResponseCharacterCount,
    setIdentity,
    setSelectedAccountMeta,
    toPayload,
    emit,
  };
}

module.exports = {
  createKeaTelemetry,
  hashUserKey,
  identityFromCashflowAuth,
};
