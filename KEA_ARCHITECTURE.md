# Kea architecture — Phase 0

This document is the Phase 0 baseline for Kea Chat (`POST /api/agent/chat` in `keacast-ai-agent`). Later phases (grounding, capability routing, macro-tools, Conversation Capsule, prompt/context optimization, streaming) are **not implemented**. This file records what Phase 0 changed, the inspected cashflow JWT contract, security before/after, telemetry, and deferred items.

## Lifecycle (unchanged except identity + telemetry)

1. PWA `chat-interface` → `OpenaiService.chat()` → `POST {aiEndpoint}/chat`.
2. `cashflowAuth` verifies the cashflow-backend session JWT (`Authorization: Bearer`, `x-auth-token`, or `body.token`).
3. `exports.chat` builds context (selected-account blob, memory layers, system prompt) and calls Azure OpenAI with tools.
4. `executeToolCalls` runs bounded tool rounds. Identity on tools comes from trusted `ctx` (JWT `id` + request `accountid` + forwarded token). Write tools remain **propose → confirm → write**.
5. Response JSON remains `{ response, simOps, uiActions, transactionResult }` plus `requestId`.

Propose → confirm → write, grounding behavior, prompt size/history/product-knowledge, Azure temperature/`max_tokens`, and the tool list (no macro-tools) are unchanged.

## Inspected cashflow JWT contract (do not guess)

Source: `cashflow-backend-api`.

| Piece | Location | Fact |
|---|---|---|
| Secret | `config.js` `config.keyword = process.env.key_word` | Session tokens are signed with `key_word`, **not** the agent's `JWT_SECRET`. |
| Mint | `services/loginSecurity.js` `signUserToken` | Payload `{ username, id: user.idusers }` plus `jti` when a session row is created. `expiresIn` from `user.token_expiration` (`1h`/`12h`/`24h`/`48h`/`never`). |
| Verify | `middlewares/authMiddleware.js` `authenticateToken` | `jwt.verify(token, config.keyword)`. Identity claim is **`id`**, not `userid`. |
| `jti` | same + `loginSecurity.isSessionActive` | If `jti` is present, require `user_sessions` row `id = jti AND user_id = id AND revoked_at IS NULL`. Legacy tokens without `jti` are accepted until expiry. |
| Other JWTs | setup / sharelink / various `generateJWT` | `{ setup: true, id }`, `{ share: 'sharelink' }`. Chat auth rejects these. |

Agent configuration: set `CASHFLOW_JWT_SECRET` to the **same value** as cashflow `key_word`. `key_word` is accepted as a fallback env name. **Never** verify cashflow tokens with `JWT_SECRET` (that secret is only for unused `/api/auth/login`).

## Satellite account authorization

Cashflow table/columns are misspelled `satelite`. Canonical queries are in `AccountController` (`SELECT * FROM satelite WHERE satelite_user_id = ?` then `SELECT * FROM accounts WHERE satelite_id = ?`, plus owner `accounts.userid = ?`).

Phase 0 `assertAccountAccess(userId, accountId)` allows:

- owner: `accounts.userid` equals the JWT `id`
- satellite: `accounts.satelite_id` matches a `satelite` row with `satelite_user_id` equal to the JWT `id`

Owner-only checks would break shared calendars.

## Security before / after

| Area | Before | After |
|---|---|---|
| Chat auth | No JWT verify. Identity from `body.sessionId` / `x-user-id` / `body.token` (unverified). | Cashflow session JWT required. `req.cashflowUser.id` from claim `id`. `body.sessionId` is not identity. |
| Azure logs | Full request body (messages, tools, user text) logged. | Counts only: `requestId`, `messageCount`, `toolCount`, `tool_choice`. |
| Tool identity | Schemas required model-supplied `token` / `userId`. MySQL reads trusted those args. | Schemas have no `token`/`userId`. `injectTrustedIdentity` strips them; `ctx` supplies identity. |
| Account reads | `getUserTransactions` et al. queried MySQL by `accountId` with no ownership check. | `assertAccountAccess` (owner or satellite) before those reads. |
| Cache invalidate | Compared `params.userId` to unverified `body.sessionId`. Wrong frontend URL (`/api/agent/api/cache/...`). Did not delete `summarization:tool:selectedaccount:*`. | Cashflow JWT required. URL is `{aiHost}/api/cache/user/:id/account/:accountId`. Selected-account tool-cache keys are deleted. |
| Frontend 401/403 | Interceptor logged the user out of Keacast on **any** 401/403, including AI. | AI/cache 401/403 do not log the user out. |

Write-gate conditions in `executeToolCalls` were not changed.

## Telemetry fields (one `kea_chat_turn` JSON line)

No PII, amounts, JWT, or message text.

- `requestId`
- `authenticated` (`true` after cashflowAuth) / `userKey` (HMAC-SHA256 prefix of JWT `id`; never the raw user id)
- `request_total_ms`
- `context_build_ms`
- `selected_account_fetch_ms` (whole selected-account span)
- `selected_account_source` (`snapshot` | `tool-cache` | `tool-fresh` | `none`)
- `selected_account_cache_hit` (`true`/`false` when Redis was consulted; `null` if that phase did not run)
- `selected_account_cache_lookup_ms` / `selected_account_http_ms` / `selected_account_parse_ms` / `selected_account_stringify_ms` / `selected_account_compact_ms` / `selected_account_redis_set_ms` / `selected_account_redis_ping_ms` (`null` if that phase did not run)
- `selected_account_cache_write_ms` (stringify + SET when those phases ran)
- `selected_account_payload_bytes` (compact snapshot UTF-8 size)
- `selected_account_full_payload_bytes` (null on the compact Kea-context path; leftover full Redis values only if `KEA_PAYLOAD_HISTOGRAM=1`)
- `selected_account_payload_key_bytes` (debug-only full-blob histogram; disabled in production unless `KEA_PAYLOAD_HISTOGRAM=1`)
- `memory_load_ms`
- `azure_round_count`
- `azure_round_<n>_ms`
- `tool_call_count`
- `tool_execution_total_ms`
- `tool_<name>_ms`
- `input_tokens` / `cached_input_tokens` / `output_tokens` / `total_tokens` (from Azure `usage` when present)
- `estimated_block_chars`
- `write_gate_armed_at_start` (proposal/write-gate state present at **turn start**; not “this turn created a proposal”). `write_proposed` is kept as an identical alias.
- `write_confirmation_detected` / `write_attempted` / `write_committed` / `write_blocked`
- `response_character_count`
- Phase 1 placeholders: `grounding_required` (false), `grounding_performed` (false), `grounding_strategy` (null), `conversation_intent` (null), `response_mode` (`unspecified`)

Clients may send `x-request-id`; the agent echoes `X-Request-Id` and includes `requestId` on the chat JSON. On a compact-context cache miss, the same id is forwarded as `X-Request-Id` on `POST /account/kea-context/:accid`.

## Phase 0.6 — compact selected-account Redis value

The chat brief (`buildChatAccountContext`) is ~1–2 KB. Redis previously stored the full Cashflow `/account/selected` UI blob (multi-MB), so a cache **hit** still paid a bulk GET + blocking `JSON.parse`.

**0.6A:** after a miss (or a leftover full-blob hit), Kea stores a compact snapshot (`_keaCompact: true`, now `schemaVersion: 1`) — scalars, savings, 14-day totals, ≤5 negatives, ≤10 recents, ≤10 upcoming, category names, compact goals. Same key (`summarization:tool:selectedaccount:{userId}:{accountId}`), same TTL (300), same invalidation hook. `access_token` and other chart/UI arrays are not stored.

## Phase 0.6B — authoritative Cashflow Kea-context (miss source)

Cache **miss** no longer calls `POST /account/selected/:userid/:accid` (live Plaid/MX + ~20y chart + multi-MB UI blob). Miss path:

1. Redis compact snapshot MISS
2. `POST /account/kea-context/:accid` (Cashflow JWT `req.user.id`; owner **or** satellite)
3. Validate `_keaCompact === true` and `schemaVersion === 1`
4. Cache that object directly (TTL 300)
5. Use it for chat/summarization context

There is **no fallback** to `/account/selected`. If the dedicated endpoint fails, chat/summarization return `502 KEA_CONTEXT_UNAVAILABLE`.

Cashflow builds the compact snapshot from persisted Keacast state (bounded transactions, `computeBalanceChartData` at 90 days, shared `computeMonthSavings`). Upcoming includes **F and RF**. `providerRefreshed` is always `false`. Full-payload `JSON.stringify` / per-key histograms are not run on the production miss path (`KEA_PAYLOAD_HISTOGRAM=1` is debug-only).

**Deploy order:** Cashflow endpoint first, verify in the target environment, then deploy the AI-agent switch. Deploying the agent first will 502 until Cashflow has `/account/kea-context`.

Optional invalidation telemetry (`kea_snapshot_invalidated`) logs `reason` + hashed user/account keys only. Invalidation **policy** is unchanged.

**Still unchanged:** write tools still propose → confirm → write. Redis TTL 300. Client `accountSnapshot` is not a write/grounding source. Calendar `getSelectedAccount` is unchanged. Phase 1 grounding is not started.

## Environment / configuration required

On the Azure App Service for `keacast-ai-agent`:

```
CASHFLOW_JWT_SECRET=<same value as cashflow-backend-api key_word>
```

Optional alias: `key_word` (same value). Existing `JWT_SECRET` is **not** used for chat.

If `CASHFLOW_JWT_SECRET` / `key_word` is missing, chat and user cache routes return **503** `CASHFLOW_JWT_SECRET_MISSING` (not 401, so a missing config does not look like a logged-out user).

## Tests

```
npm test          # tests/run.js + legacy test-kea-memory.js
npm run test:memory
```

Coverage added in Phase 0: cashflow JWT (valid / forged / setup / share / revoked jti), satellite vs owner vs denied account access, schema identity strip, `args.token` ignored, telemetry shape, write-gate regressions. Phase 0.6A adds compact-snapshot size/field tests. Phase 0.6B adds Kea-context miss/hit/TTL tests and Cashflow `POST /account/kea-context` fixtures (owner, satellite, F+RF, no provider).

## Deferred (not Phase 0)

- **jti hard-fail when agent DB cannot query `user_sessions`.** Signature is always verified. If `jti` is present and the session query **returns empty**, the request is rejected (`SESSION_REVOKED`). If the query **throws** (table missing / DB down), the check is fail-soft and the JWT is accepted. Matching cashflow’s hard-fail when the agent DB is down would 401 all chat whenever MySQL blips; left as a follow-up.
- **Auth on `/api/agent/summarize`, `/chat-history`, `/clear-history`, paginated `/accounts`/`/transactions` GET dumps, auto-categorize, shopping suggest.** Those are server-to-server or unused-by-PWA in part; mounting cashflowAuth without caller updates would break them.
- **Phase 1+** grounding, capability routing, macro-tools, Conversation Capsule, prompt/history/product-knowledge size, Azure model config, streaming.
- **Kea snapshot invalidation policy** (calendar reload / undo / recon / SSE `account_updated` still do not delete the compact key; account-switch churn is unchanged).
- **`/recurring` navigateTo** is allowlisted but there is no Angular `path: 'recurring'` (wildcard → home).
- **`getUpcomingTransactions` default `forecastType='F'`** still omits rollover `RF` unless passed.
- **Agent `getUserAccounts` MySQL path still returns owned accounts only** (no satellite join). Chat selected-account access for a shared calendar is covered by `assertAccountAccess` + cashflow HTTP tools.

## Stop

Phase 0.6B ends here. Do not start Phase 1 from this document without a new implementation request.
