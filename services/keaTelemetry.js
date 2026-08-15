'use strict';

/**
 * Per-turn Kea chat telemetry. One JSON line, no PII / amounts / JWT / message text.
 * Phase 1 grounding fields are present as null/false placeholders so the schema
 * is stable before grounding is implemented.
 */
function createKeaTelemetry({ requestId } = {}) {
  const startedAt = Date.now();
  const marks = Object.create(null);
  const azureRounds = [];
  const tools = [];
  const blocks = Object.create(null);
  const write = {
    write_proposed: false,
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

  function toPayload() {
    const payload = {
      event: 'kea_chat_turn',
      requestId: requestId || null,
      request_total_ms: Date.now() - startedAt,
      context_build_ms: marks.context_build?.ms ?? null,
      selected_account_fetch_ms: marks.selected_account_fetch?.ms ?? null,
      memory_load_ms: marks.memory_load?.ms ?? null,
      azure_round_count,
      tool_call_count: tools.length,
      tool_execution_total_ms: tools.reduce((sum, t) => sum + t.ms, 0),
      input_tokens,
      cached_input_tokens,
      output_tokens,
      total_tokens,
      response_character_count,
      write_proposed: !!write.write_proposed,
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
    toPayload,
    emit,
  };
}

module.exports = { createKeaTelemetry };
