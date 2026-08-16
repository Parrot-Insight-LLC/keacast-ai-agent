'use strict';

const crypto = require('crypto');

/**
 * Per-turn Kea chat telemetry. One JSON line, no PII / amounts / JWT / message text.
 * Phase 1 grounding fields are recorded via recordGrounding. Defaults stay
 * false/null until the chat turn fills them. Never log evidence values, amounts,
 * merchants, or message text.
 */

function hashKeyedId(prefix, id) {
  if (id == null || id === '') return null;
  const secret = process.env.CASHFLOW_JWT_SECRET || process.env.key_word;
  const material = `${prefix}:${String(id)}`;
  const digest = secret
    ? crypto.createHmac('sha256', secret).update(material).digest('hex')
    : crypto.createHash('sha256').update(material).digest('hex');
  return digest.slice(0, 16);
}

function hashUserKey(userId) {
  return hashKeyedId('kea-user-key', userId);
}

function hashAccountKey(accountId) {
  return hashKeyedId('kea-account-key', accountId);
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
  let summary_updated = false;
  let summary_failed = false;
  let full_turn_message_count = null;
  let summary_overflow_message_count = 0;
  let rolling_summary_chars = 0;
  let response_sent_ms = null;
  const grounding = {
    grounding_required: false,
    grounding_performed: false,
    grounding_strategy: null,
    conversation_intent: null,
    response_mode: 'unspecified',
    grounding_source_count: 0,
    grounding_prefetch_ms: 0,
    capability_confidence_bucket: null,
    continuation_used: false,
    effective_capability: null,
    pending_write_routing_reason: 'none',
    grounding_evidence_status: null,
    historical_prefetch_page_count: null,
    historical_prefetch_row_count: null,
    historical_match_count: null,
    historical_lookup_count: null,
    historical_period_read_count: null,
    ui_action_count: null,
    financial_macro: 'none',
    macro_performed: false,
    macro_status: 'skipped',
    macro_ms: 0,
    macro_input_kind: 'none',
    macro_horizon_days: null,
    macro_source_count: 0,
  };

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

  function recordGrounding(flags) {
    if (!flags || typeof flags !== 'object') return;
    if (flags.grounding_required === true || flags.grounding_required === false) {
      grounding.grounding_required = flags.grounding_required;
    }
    if (flags.grounding_performed === true || flags.grounding_performed === false) {
      grounding.grounding_performed = flags.grounding_performed;
    }
    if (flags.grounding_strategy === null || typeof flags.grounding_strategy === 'string') {
      grounding.grounding_strategy = flags.grounding_strategy;
    }
    if (flags.conversation_intent === null || typeof flags.conversation_intent === 'string') {
      grounding.conversation_intent = flags.conversation_intent;
    }
    if (typeof flags.response_mode === 'string') {
      grounding.response_mode = flags.response_mode;
    }
    if (flags.grounding_source_count != null) {
      grounding.grounding_source_count = Number(flags.grounding_source_count) || 0;
    }
    if (flags.grounding_prefetch_ms != null) {
      grounding.grounding_prefetch_ms = Number(flags.grounding_prefetch_ms) || 0;
    }
    if (flags.capability_confidence_bucket === null || typeof flags.capability_confidence_bucket === 'string') {
      grounding.capability_confidence_bucket = flags.capability_confidence_bucket;
    }
    if (flags.continuation_used === true || flags.continuation_used === false) {
      grounding.continuation_used = flags.continuation_used;
    }
    if (flags.effective_capability === null || typeof flags.effective_capability === 'string') {
      grounding.effective_capability = flags.effective_capability;
    }
    if (typeof flags.pending_write_routing_reason === 'string') {
      grounding.pending_write_routing_reason = flags.pending_write_routing_reason;
    }
    if (flags.grounding_evidence_status === null || typeof flags.grounding_evidence_status === 'string') {
      grounding.grounding_evidence_status = flags.grounding_evidence_status;
    }
    if (flags.historical_prefetch_page_count != null) {
      grounding.historical_prefetch_page_count = Number(flags.historical_prefetch_page_count) || 0;
    }
    if (flags.historical_prefetch_row_count != null) {
      grounding.historical_prefetch_row_count = Number(flags.historical_prefetch_row_count) || 0;
    }
    if (flags.historical_match_count != null) {
      grounding.historical_match_count = Number(flags.historical_match_count) || 0;
    }
    if (flags.historical_lookup_count != null) {
      grounding.historical_lookup_count = Number(flags.historical_lookup_count) || 0;
    }
    if (flags.historical_period_read_count != null) {
      grounding.historical_period_read_count = Number(flags.historical_period_read_count) || 0;
    }
    if (flags.ui_action_count != null) {
      grounding.ui_action_count = Number(flags.ui_action_count) || 0;
    }
    if (flags.financial_macro === null || typeof flags.financial_macro === 'string') {
      grounding.financial_macro = flags.financial_macro || 'none';
    }
    if (flags.macro_performed === true || flags.macro_performed === false) {
      grounding.macro_performed = flags.macro_performed;
    }
    if (flags.macro_status === null || typeof flags.macro_status === 'string') {
      grounding.macro_status = flags.macro_status || 'skipped';
    }
    if (flags.macro_ms != null) {
      grounding.macro_ms = Number(flags.macro_ms) || 0;
    }
    if (flags.macro_input_kind === null || typeof flags.macro_input_kind === 'string') {
      grounding.macro_input_kind = flags.macro_input_kind || 'none';
    }
    if (flags.macro_horizon_days != null) {
      grounding.macro_horizon_days = Number(flags.macro_horizon_days) || 0;
    }
    if (flags.macro_source_count != null) {
      grounding.macro_source_count = Number(flags.macro_source_count) || 0;
    }
  }

  function setResponseCharacterCount(n) {
    response_character_count = Number(n) || 0;
  }

  function setIdentity(identity) {
    authenticated = !!(identity && identity.authenticated);
    userKey = identity && identity.userKey ? String(identity.userKey) : null;
  }

  function setSummaryUpdated(ran) {
    summary_updated = !!ran;
  }

  function setSummaryFailed(failed) {
    summary_failed = !!failed;
  }

  function markResponseSent() {
    response_sent_ms = Date.now() - startedAt;
  }

  function setRollingSummaryMeta({
    fullTurnMessageCount,
    overflowMessageCount,
    rollingSummaryChars,
  } = {}) {
    if (fullTurnMessageCount != null) {
      full_turn_message_count = Number(fullTurnMessageCount) || 0;
    }
    if (overflowMessageCount != null) {
      summary_overflow_message_count = Number(overflowMessageCount) || 0;
    }
    if (rollingSummaryChars != null) {
      rolling_summary_chars = Number(rollingSummaryChars) || 0;
    }
  }

  async function measureSpan(name, fn) {
    markStart(name);
    try {
      return await fn();
    } finally {
      markEnd(name);
    }
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
      selected_account_compact_ms: marks.selected_account_compact?.ms ?? null,
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
      response_sent_ms,
      summary_updated: !!summary_updated,
      summary_failed: !!summary_failed,
      summary_update_ms: marks.summary_update?.ms ?? 0,
      history_save_ms: marks.history_save?.ms ?? 0,
      dialogue_state_save_ms: marks.dialogue_state_save?.ms ?? 0,
      full_turn_message_count,
      summary_overflow_message_count,
      rolling_summary_chars,
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
      grounding_required: !!grounding.grounding_required,
      grounding_performed: !!grounding.grounding_performed,
      grounding_strategy: grounding.grounding_strategy,
      conversation_intent: grounding.conversation_intent,
      response_mode: grounding.response_mode,
      grounding_source_count: grounding.grounding_source_count,
      grounding_prefetch_ms: grounding.grounding_prefetch_ms,
      capability_confidence_bucket: grounding.capability_confidence_bucket,
      continuation_used: !!grounding.continuation_used,
      effective_capability: grounding.effective_capability,
      pending_write_routing_reason: grounding.pending_write_routing_reason || 'none',
      grounding_evidence_status: grounding.grounding_evidence_status,
      historical_prefetch_page_count: grounding.historical_prefetch_page_count,
      historical_prefetch_row_count: grounding.historical_prefetch_row_count,
      historical_match_count: grounding.historical_match_count,
      historical_lookup_count: grounding.historical_lookup_count,
      historical_period_read_count: grounding.historical_period_read_count,
      ui_action_count: grounding.ui_action_count,
      financial_macro: grounding.financial_macro || 'none',
      macro_performed: !!grounding.macro_performed,
      macro_status: grounding.macro_status || 'skipped',
      macro_ms: grounding.macro_ms || 0,
      macro_input_kind: grounding.macro_input_kind || 'none',
      macro_horizon_days: grounding.macro_horizon_days,
      macro_source_count: grounding.macro_source_count || 0,
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
    recordGrounding,
    setResponseCharacterCount,
    setIdentity,
    setSelectedAccountMeta,
    setSummaryUpdated,
    setSummaryFailed,
    setRollingSummaryMeta,
    markResponseSent,
    measureSpan,
    toPayload,
    emit,
  };
}

module.exports = {
  createKeaTelemetry,
  hashUserKey,
  hashAccountKey,
  identityFromCashflowAuth,
};
