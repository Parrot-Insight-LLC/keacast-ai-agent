# Kea Chat phased program — Phase 0 through Phase 3C.4 Slice 9

**Repo:** `keacast-ai-agent` (`github.com/Parrot-Insight-LLC/keacast-ai-agent`, branch `master`)  
**Endpoint:** `POST /api/agent/chat`  
**Companion app:** Keacast PWA (`cashflow-frontend`) → `OpenaiService.chat()`  
**This document’s cutoff:** Phase 3C.4 Slice 9 (in progress / on hold)  
**HEAD at time of writing:** `7d4f97b75aea20a998358e4f90770a40ba3a45d6` (2026-08-28)

This file is a **completed-work record** for the Kea Chat phased program that started at Phase 0 (2026-08-15). Use it as the factual baseline when filling in **planned** work from Phase 3C.4 Slice 9 through Phase 8.

---

## How to use this document (for a later-phase fill-in)

1. Treat everything in this file as **implemented, frozen, or explicitly in-progress**. Do not rewrite it to match a later plan.
2. Fill **Phase 3C.4 Slice 9 → Phase 8** from other planning sources. Label that remainder as **planned / not yet implemented** unless a later commit proves otherwise.
3. Do **not** confuse this program with older comments in `openaiController.js` / `systemPromptBuilders.js` that say “Phase 4/5/6/7” for **summarization cache** internals. Those are a different, earlier numbering scheme.
4. Preserve the invariant below. Later phases must not reverse it.

---

## Core invariant (frozen)

```
KEACAST CALCULATES.
AZURE EXPLAINS.
THE VALIDATOR VERIFIES.
DIAGNOSTICS OBSERVE.
```

- Deterministic Keacast macros / snapshot / lookup compute financial facts.
- Azure narrates from a Prompt View of those facts.
- Phase 3C validates Azure `finalText` against the same-request Evidence Ledger / ResponseValidationContract.
- Diagnostics (including temporary trend-block telemetry) observe. They do not calculate, authorize, or repair.

---

## Status at cutoff

| Stage | Status |
|---|---|
| Phase 0 (incl. 0.5–0.7) | Implemented / frozen as baseline |
| Phase 1 (incl. 1.1–1.3) | Implemented / frozen |
| Phase 2 / 2A (2.1–2.6, 2.8–2.9; no 2.7 commit found) | Implemented / frozen |
| Phase 2B (comparison, trend, recurring, upcoming, income horizon) | Implemented / frozen |
| Phase 3A (Capsule 3A.1–3A.4) | Implemented / frozen |
| Phase 3B (Ledger → Prompt View, lookup + snapshot cutover, telemetry) | Implemented / frozen |
| Phase 3C.1 (extractor / contract / validator core) | Implemented (landed with 3C.2) / frozen |
| Phase 3C.2 (production shadow validation + binding hardening) | Implemented / frozen / **shadow ON in production** |
| Phase 3C.3 (enforcement) | Implemented / frozen / **enforcement ON in production** |
| Phase 3C.4 Slice 1 | Implemented / frozen (always-on validator period-scalar bind; no dedicated flag) |
| Phase 3C.4 Slices 2–8 | Implemented / frozen / **shadow flags ON in production** (Slice 8 restored ON after A/B) |
| Temporary trend-block diagnostic telemetry | Implemented, **flag default OFF**, live capture not completed from this environment |
| Phase 3C.4 Slice 9 | **HOLD / currently starting** — no implementation commit |
| Phase 3C.5, 3C.6, 3D, Phases 4–8 of *this* program | **Not implemented in this repo as of cutoff** |

`KEA_ARCHITECTURE.md` is the Phase 0 baseline write-up. It still says later phases are “not implemented”; that sentence is **stale**. Use this file for post–Phase 0 status.

---

## Production chat path (as of 3C.4)

```
USER
→ cashflow JWT auth (Phase 0)
→ compact selected-account context (Phase 0.6)
→ capability router (Phase 1 / 2 / 3A)
→ grounding policy + prefetch (Phase 1 / 2B macros)
→ Evidence Ledger (Phase 3B.1)
→ Prompt View to Azure (Phase 3B.3)
→ Azure finalText
→ stripCurrencyCommas
→ shadow validation (Phase 3C.2)
→ enforcement fallback if eligible INVALID (Phase 3C.3)
→ persist history / Capsule (Phase 3A)
→ kea_chat_turn telemetry
```

Azure is **not** retried to obtain a different financial answer when validation fails.

---

## Naming collisions to ignore when filling later phases

| Name in code | What it actually is |
|---|---|
| `openaiController.js` “Phase 4/6/7” around `/summarize` | Content-addressed summarization cache, **not** Kea Chat Phase 4/6/7 |
| `systemPromptBuilders.js` “Phase 5” | Modular system-prompt builders for chat, landed before this program’s Phase 5 |
| Git commits `phase 4` / `phase 6` from 2025 and earlier | Pre-program chat/cache work, **not** this Phase 0–8 sequence |
| `ba20cfb` / `4ca4aee` “phase 6” | Legacy; do not treat as Kea Chat Phase 6 |

The **Kea Chat program** numbering in this file starts at `2206c90` (2026-08-15) `phase 0 Security + telemetry + cache correctness`.

---

# Phase 0 — Security, identity, telemetry, selected-account context

**Window:** 2026-08-15 → 2026-08-16  
**Primary commits:** `2206c90`, `3d090ca` (0.5), `e465747` (0.6), `426f067` (0.6B), `390a35c` (0.6C), `dedaca9` (0.7)

### What it did

- Required cashflow-backend session JWT on chat and user cache routes (`CASHFLOW_JWT_SECRET` / `key_word`, claim `id`, optional `jti` revocation).
- Stopped treating `body.sessionId` / unverified `x-user-id` as identity.
- `assertAccountAccess`: owner **or** satellite (`satelite` spelling is canonical in Cashflow).
- Tool schemas no longer take model-supplied `token` / `userId`; `injectTrustedIdentity` injects trusted `ctx`.
- One sanitized `kea_chat_turn` JSON line: timings, token counts, write-gate flags, hashed `userKey`. No PII, amounts, JWT, or message text.
- Azure request logs reduced to counts.
- Frontend: AI 401/403 must not log the user out of Keacast.

### 0.6 compact selected-account Redis

- **0.6A:** Redis stores a compact Kea snapshot (`_keaCompact`, `schemaVersion: 1`), not the multi-MB `/account/selected` UI blob.
- **0.6B:** Cache miss calls Cashflow `POST /account/kea-context/:accid`. No fallback to `/account/selected`. Failure → `502 KEA_CONTEXT_UNAVAILABLE`.
- **0.6C:** Post-Azure lifecycle spans in telemetry (`summary_update_ms`, `history_save_ms`, `response_sent_ms`, rolling-summary meta).

### 0.7

Reliability / abort plumbing continued into Phase 2B (`keaRequestBudget`, 120s client abort). Phase 0.7 commit is `dedaca9`.

### Unchanged in Phase 0

Propose → confirm → write. No capability routing. No macros. No Capsule. No Ledger.

### Key files

`services/keaIdentity.js`, `keaAccountAccess.js`, `keaAccountSnapshot.js`, `keaAccountCache.js`, `keaSelectedAccountResolve.js`, `keaTelemetry.js`, `middleware` cashflow auth, `KEA_ARCHITECTURE.md`

---

# Phase 1 — Capability routing + grounding prefetch

**Window:** 2026-08-16  
**Primary commits:** `4fac64b` (Phase 1), `ea04973` (1.1), `506926d` (1.2), `2d37f07` (1.3)

### What it did

- Deterministic `routeCapability()` (`services/keaCapabilityRouter.js`).
- Grounding matrix (`services/keaGroundingPolicy.js`): financial reads **REQUIRED**, product/casual/nav **NONE**, writes **OPTIONAL**, `continuation` inherits.
- Prefetch (`services/keaGroundingPrefetch.js`) for lookup / snapshot-backed forecast questions so Azure is not the calculator.
- Capability-scoped tool bundles (`services/keaToolBundles.js`) so Azure does not see write tools on a read turn.
- Fail-soft copy when required evidence is missing (`FAIL_SOFT_TEXT` and limitation-specific messages).
- **1.2:** compound lookup parsing (multiple merchant/category clauses in one message).
- Telemetry: `conversation_intent`, `grounding_*`, `effective_capability`, `response_mode`.

Capabilities introduced here and extended later include: `financial_lookup`, `financial_forecast`, `product_help`, `casual_conversation`, `navigation_ui`, `transaction_write`, `goal_write`, `simulation`, `confirmation`, `continuation`, `unknown`.

---

# Phase 2 / 2A — Deterministic financial macros (analysis + affordability)

**Window:** 2026-08-16 → 2026-08-18  
**Primary commits:** `b7b1194` (Phase 2), `0cd6fbf`–`2446120` (2.1–2.9 except 2.7), `53933e7` (2A.4 follow-up)

### What it did

Keacast **calculates** posted/forecast facts in-process (and via Cashflow tool-layer HTTP for some macros). Azure **narrates**. Macro tools are **omitted from Azure schemas**.

| Sub-phase | Commit | What landed |
|---|---|---|
| 2 / 2A | `b7b1194` | `cashflow_analysis` + `affordability_or_planning` routing, prefetch macros, fail-soft, telemetry `financial_macro` |
| 2.1 | `0cd6fbf` | Snapshot vs macro narration isolation (don’t mix compact-snapshot totals into analysis/affordability answers) |
| 2.2 | `bf10ad6` | Evidence pairing; missing ≠ zero; scope vs horizon |
| 2.3 | `7f33b7a` | Macro prompt profile (Azure sees structured evidence, not a license to recalculate) |
| 2.4 | `d83f85c` | Macro vs write-state isolation; historical Azure-facing balances |
| 2.5 | `08a17d4` | Invitation continuation (`invitation_continuation`, `bare_affirmative_unresolved`) |
| 2.6 | `9f92988` | Invitation continuation hardening |
| 2.7 | — | **No commit titled 2.7 found** |
| 2.8 | `6f3ac73` | Write commit ack (`keaWriteCommitAck`) so the UI reloads from structured result, not prose sniffing |
| 2.9 | `2446120` | Write identity (`keaWriteIdentity`) |
| 2A.4 | `53933e7` | Small continuation/resolver follow-up after 3A |

Also in this era: `keaAzureChat.js`, `keaMacroFallback.js`, `keaRequestBudget.js` (Azure timeout 25s, macro 15s, chat budget 60s, frontend abort 120s). Azure is not retried for a second financial invention when a macro already owns the turn.

Mixed “how am I doing **and** can I afford X” → `mixed_macro` (unsupported as one turn).

---

# Phase 2B — Comparison, trend, recurring, upcoming, income horizon

**Window:** 2026-08-16 → 2026-08-17  
**Primary commits:** `81fbf5e` / `79c3181` (2B.1 comparison), `dcb187e` (2b.2 trend), `1bcab68` (2b.3 recurring), temporal commits `7ce2fe4` / `4c3d5df` (upcoming), `049cfab` (2b.4 income horizon)

### Macros (deterministic)

| Capability | Prefetch | Typical question |
|---|---|---|
| `cashflow_comparison` | `prefetchCashflowComparisonMacro` | this month vs last month |
| `cashflow_trend` | `prefetchCashflowTrendMacro` → Cashflow `analyzePostedTrend` / `getKeaTrendAnalysis` | spending trend last 3 months |
| `cashflow_recurring` | `prefetchCashflowRecurringMacro` | scheduled recurring items |
| `cashflow_upcoming` | `prefetchCashflowUpcomingMacro` | this week / next 7 days scheduled |
| `cashflow_income_horizon` | `prefetchCashflowIncomeHorizonMacro` | days before next scheduled income |

Trend authority that later validation depends on:

- Window kinds include `matched_elapsed` vs `full_months`.
- Direction is **step-based** (`increasing` / `decreasing` / `mixed` / `unchanged` / `insufficient_data`), **not** first-to-last.
- First-to-last percent/absolute exist as separate facts. There is **no** step-to-step percent claim.

Cashflow-backend owns `analyzePostedTrend` (`cashflow-backend-api/services/keaTrendAnalysis.js`). The agent prefetches and projects; it does not re-sum transactions in the validator.

---

# Phase 3A — Conversation Capsule

**Window:** 2026-08-17  
**Frozen.**

| Slice | Commit | Module | Role |
|---|---|---|---|
| 3A.1 | `49064b4` | `keaConversationCapsule.js` | Derive-only Capsule V1: referents (thread, account, period, scope, category). **Not** financial evidence, writes, invitations, or Azure memory |
| 3A.2 | `57d9d85` | `keaConversationStateResolver.js` | Continuation vs fresh vs hard-switch vs clarify. No I/O |
| 3A.3 | `d39f0a2` | Capsule persistence hygiene | `projectConversationCapsule()`; persist `null` when no active thread; telemetry `capsule_*` |
| 3A.4 | `ce1bb68` | `keaConversationContinuation.js` + production load | `resolveCurrentConversationCapsule()` is production authority; discriminated continuation reducers |

Thread kinds: `comparison`, `trend`, `recurring`, `upcoming`, `income_horizon`, `lookup`, `analysis`, `forecast`, `affordability`.

Hard-switch (product help / navigation / narrow settings) clears the active thread. Soft “thanks” does not.

Dialogue state remains **user-scoped** (no `conversationId`). Multi-tab sharing is an existing limitation.

---

# Phase 3B — Evidence Ledger → Prompt View

**Window:** 2026-08-18  
**Frozen.**

| Slice | Commit | What |
|---|---|---|
| 3B.1 | `e230456` | `EvidenceLedgerV1` + builders. Copy/normalize/classify. **Builders must not calculate new finances.** |
| 3B.2 | (with 3B.3A) | Prompt View: narratable, lossy projection. **3C must validate against the Ledger, not Prompt View.** |
| 3B.3A | `f715095` | Production cutover: approved macros serialize Prompt View to Azure. Flag `USE_EVIDENCE_LEDGER_PROMPT` (unset → **ON**) |
| 3B.3B.1 | lookup shadow module | Request-local lookup Ledger vs `azureFacingEvidence` parity |
| 3B.3B.2 | `289f0d4` | Lookup Prompt View cutover. Flag `USE_LOOKUP_EVIDENCE_LEDGER_PROMPT` (unset → **ON**) |
| 3B.3B.3 | `5cda7d3` | Snapshot evidence adapter |
| 3B.3B.4 | `1e9682c` | Snapshot Ledger/Prompt View shadow parity |
| 3B.3B.5 | `1e85588` | Snapshot Prompt View cutover (`financial_forecast` + `kea_snapshot`, snapshot-backed lookup). Flag `USE_SNAPSHOT_EVIDENCE_LEDGER_PROMPT` (unset → **ON**) |
| 3B.4 | `c1a18f7` | Sanitized evidence telemetry on `kea_chat_turn` (`evidence_*` buckets/enums only) |

Approved macro capabilities for 3B.3A:

`cashflow_upcoming`, `cashflow_recurring`, `cashflow_income_horizon`, `cashflow_comparison`, `cashflow_trend`, `cashflow_analysis`, `affordability_or_planning`

Ledger builders: upcoming, recurring, income horizon, comparison, trend, affordability, lookup, snapshot.

Rollback of a Prompt View flag returns that lane to legacy `azureFacingEvidence` only; it does not disable other lanes.

---

# Phase 3C — Response validation

## 3C.1 — Contract, extractor, validator (core)

**Landed inside** `dfd367c` (2026-08-18) together with 3C.2 production wiring. Treat as frozen.

| Module | Job |
|---|---|
| `keaResponseValidationContract.js` | Thin projection of the Ledger for validation. No financial math |
| `keaResponseClaimExtractor.js` | Deterministic claims from assistant text: amounts, counts, dates, percents, direction tokens. No Ledger. No new direction vocabulary in later diagnostic work |
| `keaResponseClaimValidator.js` | Bind extracted claims to the contract. Compare/normalize only |

Important **existing** validator behaviors (do not “fix” inside a later slice unless that slice is explicitly a remediation):

- **Percent:** match `authorizedPct === extractedPct` **or** signed magnitude `authorizedPct === -extractedPct` **only if** expense/income locality hints allow it. Failure code: `UNSUPPORTED_COMPARISON` / `percent_not_in_ledger` / **CRITICAL**. Shared comparison code is used even for trend.
- **Direction:** extractor polarity `up`/`down`. Contract direction `mixed` / `unchanged` have **null** polarity. Mismatch → `UNAUTHORIZED_DIRECTION` / `direction_polarity_mismatch` / **HIGH**.
- Primary violation: **CRITICAL before HIGH**.

## 3C.2 — Production shadow validation

**Frozen. Production: ON** (`USE_RESPONSE_VALIDATION_SHADOW`; unset → ON).

**Commit:** `dfd367c` plus binding hardenings `782127b` … `a7fc48e` (list-item auth, comparison/trend/recurring date and role binding, direction authority projection).

`applyShadowResponseValidation`:

- Runs **once** per turn on Azure `finalText`.
- Returns `{ finalText, telemetry, validation, contract, extractedClaims }`.
- **Never** changes the user-visible response, history, Capsule, Azure, or tools.
- Eligible capabilities include the approved macros plus `financial_lookup` and `financial_forecast`.

Follow-on 3C.2 commits (not new phases): comparison `to` vs `by`, period-month dates, recurring same-bullet next-due, trend from-to / range-before-amount, comparison absolute-change role, comparison direction projection.

## 3C.3 — Enforcement

**Frozen. Production: ON** (`USE_RESPONSE_VALIDATION_ENFORCEMENT=true`; **unset/empty defaults OFF**, so production must set true explicitly).

**Commit:** `2eea1c4`

- If shadow status is eligible **INVALID** at CRITICAL/HIGH and the capability/family is enforceable → replace Azure text with a **non-financial** fallback.
- Never retries Azure. Never mutates the validation verdict. Fail-open on validation **exception**.
- Enforceable: `cashflow_trend`, `cashflow_recurring`, `cashflow_upcoming`, `cashflow_income_horizon`, `cashflow_comparison`, `financial_lookup`, `financial_forecast`.
- Excluded: `affordability_or_planning`, `cashflow_analysis`.
- Comparison additionally limits some families (`COMPARISON_ENFORCED_FAMILIES`); **trend is fully eligible** (both `UNSUPPORTED_COMPARISON` and `UNAUTHORIZED_DIRECTION` can block).

`CORE_ENFORCEABLE_CODES` (3C.3 core only; later Slice 2–8 codes are **not** in this list):

`UNSUPPORTED_AMOUNT`, `UNSUPPORTED_COUNT`, `UNSUPPORTED_DATE`, `UNSUPPORTED_PERIOD_ATTRIBUTION`, `UNSUPPORTED_ENTITY`, `UNSUPPORTED_COMPARISON`, `UNSUPPORTED_DERIVATION`, `UNSUPPORTED_FORECAST`, `LIST_ITEM_MISMATCH`, `UNAUTHORIZED_DIRECTION`

Fallback (no dollars, no validator internals):

> I couldn't verify that answer against your Keacast data, so I don't want to give you an inaccurate financial result. Please try again.

---

# Phase 3C.4 — Semantic identity slices (shadow)

Pattern for Slices 2–8:

- Dedicated helper + env flag.
- Unset/empty → **OFF** (pre-slice validator behavior).
- New violation code is **HIGH**, **not** in `CORE_ENFORCEABLE_CODES` → Slice-only findings **do not block**.
- Independent of 3C.3. Turning a slice off must not disable enforcement of core codes.
- No extractor vocabulary expansion, no new Ledger facts, no Prompt View rewrite, no Azure retry.

### Slice 1 — Comparison period-scalar identity (always on)

**Commit:** `b65919f` (2026-08-25)  
**No dedicated flag.** Bound in `keaResponseClaimValidator.js`.

Defect class: an authorized amount spoken with the **wrong period identity** (June’s total attributed to July).

Frozen. Later slices must not regress Slice 1 June/July/August binding.

### Slice 2 — Snapshot horizon + list-role identity

**Commits:** `4238574`, follow-up `daaa2aa` (available-balance false-positive)  
**Flag:** `USE_SNAPSHOT_SEMANTIC_VALIDATION_SHADOW`  
**Code:** `SNAPSHOT_SEMANTIC_MISMATCH`  
**Helper:** `keaSnapshotSemanticValidation.js`

Reasons include `window_horizon_mismatch`, `semantic_role_mismatch`, `current_future_role_mismatch`, `list_role_mismatch`, `coverage_role_mismatch` (coverage reasons also used by Slice 3).

### Slice 3 — Preview vs full-window coverage identity

**Commit:** `3241f0a`  
**Flag:** `USE_SNAPSHOT_COVERAGE_VALIDATION_SHADOW`  
**Same helper file as Slice 2.** Independent of Slice 2 horizon/role rules.

### Slice 4 — Comparison A/B period-relation identity

**Commit:** `6209111`  
**Flag:** `USE_COMPARISON_RELATION_VALIDATION_SHADOW`  
**Code:** `COMPARISON_RELATION_MISMATCH`  
**Helper:** `keaComparisonSemanticValidation.js`

Reasons: `period_relation_reversed`, `baseline_target_mismatch`, `direction_relation_mismatch`.  
Does not derive direction from amounts.

### Slice 5 — Trend matched-elapsed vs full-month coverage

**Commit:** `c662b17`  
**Flag:** `USE_TREND_COVERAGE_VALIDATION_SHADOW`  
**Code:** `TREND_COVERAGE_MISMATCH`  
**Helper:** `keaTrendSemanticValidation.js`

Reason: `matched_elapsed_as_full_month`.  
Does **not** derive step percents, first-to-last direction, or completeness from dates.

Open residuals recorded in tests: `TREND_GENERIC_TOTAL_COVERAGE_AMBIGUITY`, `TREND_RELATIVE_COVERAGE_LANGUAGE_BACKLOG`.

### Slice 6 — Lookup merchant + period attribution

**Commit:** `2105112`  
**Flag:** `USE_LOOKUP_ATTRIBUTION_VALIDATION_SHADOW`  
**Code:** `LOOKUP_ATTRIBUTION_MISMATCH`  
**Helper:** `keaLookupSemanticValidation.js`

Reasons: `merchant_identity_mismatch`, `period_identity_mismatch`.  
Does not rerun search or fuzzy-match merchants.

### Slice 7 — Snapshot negative event vs minimum/ranking

**Commit:** `0533de8`  
**Flag:** `USE_SNAPSHOT_NEGATIVE_MINIMUM_VALIDATION_SHADOW`  
**Code:** `SNAPSHOT_NEGATIVE_MINIMUM_MISMATCH`  
**Helper:** `keaSnapshotNegativeBalanceSemanticValidation.js`

Reason: `negative_event_as_minimum`.  
Does not calculate minima or rank events.

### Slice 8 — Comparison period-scalar **metric** identity

**Commit:** `44ad6e9`  
**Flag:** `USE_COMPARISON_METRIC_VALIDATION_SHADOW`  
**Code:** `COMPARISON_METRIC_MISMATCH`  
**Helper:** `keaComparisonMetricSemanticValidation.js`

Defect: same-period authorized amount attached to the **wrong metric** (e.g. June **spending** narrated as June **income** when income owns that dollars figure).

Reason: `metric_identity_mismatch`.  
Cannot run on `cashflow_trend` (requires comparison `periodA`/`periodB` spending|income|net).

Live A/B with Slice 8 ON and OFF both still failed **trend** validation → Slice 8 is **causally excluded** from the live trend block.

Open residuals in tests: comparison delta metric scope, multi-metric coreference, ambiguous metric language, plus earlier comparison/trend/lookup/snapshot/income-horizon language backlogs still `OPEN`.

**Slice 8 production:** after deploy-with-flag-OFF, human restored `USE_COMPARISON_METRIC_VALIDATION_SHADOW=true`. Keep it ON unless a later task says otherwise.

---

# Live trend-block investigation (between Slice 8 and Slice 9)

This is **not** Slice 9 and **not** a validator fix.

Healthy upstream on blocked live trend turns:

- `conversation_intent` / `effective_capability` / `grounding_strategy` = `cashflow_trend`
- `financial_macro` = `trend_periods`, `macro_status` = `ok`, `trend_status` = `ok`
- `trend_period_count` = 3, `trend_window_kind` = `matched_elapsed`
- evidence complete / promptable

Live validation still produced:

- `UNSUPPORTED_COMPARISON` / critical / blocked
- and/or `UNAUTHORIZED_DIRECTION` / high / blocked

Two **offline-proven** failure classes (Azure `finalText` was not retained, so live class was unconfirmed):

**A. Percent binding / locality false-invalid**  
Authorized `facts.trend.spending.firstToLast.percent` exists, but narration like “a 13.71% decrease” lacks a nearby expense/spending hint → signed-magnitude branch refused → `percent_not_in_ledger`.

**B. Direction polarity mismatch**  
Extracted `up`/`down` vs authorized `decreasing`/`increasing`, **or** authorized `mixed`/`unchanged` (non-polar) vs spoken decrease/increase.

Historical good canary shape (still VALID with all shadow flags on): matched-elapsed three periods + “Spending decreased by 13.71%.” Date rollover of matched-elapsed (day-of-month window) can change labels, percent, and even step-based direction to `mixed`.

---

# Temporary diagnostic capture (pre–Slice 9)

**Commit:** `7d4f97b` (2026-08-28)  
**Not a trend fix. Not Slice 9.**

| Item | Value |
|---|---|
| Flag | `USE_TREND_BLOCK_DIAGNOSTIC_TELEMETRY` (unset/empty/false → **OFF**) |
| Helper | `services/keaTrendBlockedDiagnosticTelemetry.js` |
| Event | existing `kea_chat_turn` only (`trend_diag_*`) |
| Inputs | contract, extractedClaims, validationResult, enforcementDecision — **never** `finalText` or user text |
| Activation | flag ON + `cashflow_trend` + source `cashflow_trend` + validation performed + `invalid` + enforcement **blocked** |
| Removal backlog | `TREND_BLOCK_DIAGNOSTIC_TELEMETRY_REMOVAL` = `OPEN` until a later trend remediation is live + verified |

Fields are fixed enums / booleans / buckets only (authorized direction class, token-count buckets, polarity, match status, percent numeric relation `exact` | `signed_magnitude` | `unmatched`, expense-hint present/absent, primary failure mapped from **existing** primary — diagnostics do not re-pick primary).

**Deploy:** Actions run [33190373199](https://github.com/Parrot-Insight-LLC/keacast-ai-agent/actions/runs/33190373199) succeeded; health was green. Flag was **left OFF** on Azure from the implementing environment (`az` CLI was not available). **One live canary after enabling the flag is still required** before classifying production as A/B/combined/other.

Live canary question (only, after flag ON):

> What is my spending trend over the last 3 months?

Block/fallback on that turn is **expected**. Do not treat fallback as diagnostic failure. Do not patch the validator from the diagnostic task.

---

# Phase 3C.4 Slice 9 — current work (HOLD)

**Status: HOLD. No implementation commit.**

Intended next work (from the frozen-program prompts, **not yet coded**):

- A **separate, narrowly scoped trend-validator remediation**, only after live `trend_diag_*` classifies the production failure.
- Candidate classes from the diagnostic brief:
  - `AUTHORIZED_PERCENT_LOCALITY_FALSE_INVALID`
  - `UNAUTHORIZED_PERCENT_NARRATION`
  - `MULTIPLE_PERCENT_CLAIM_MIX`
  - `DIRECTION_POLARITY_MISMATCH`
  - `MIXED_OR_UNCHANGED_DIRECTION_NARRATION_MISMATCH`
  - `PERCENT_AND_DIRECTION_COMBINED`
  - `OTHER` / `INSUFFICIENT_DIAGNOSTIC_EVIDENCE`
- Slice 9 must **not** start while live class is unconfirmed.
- Slice 9 must **not** add percent tolerance/rounding, authorize step percents, map `mixed`→`decreasing`, weaken `CORE_ENFORCEABLE_CODES`, change extractor vocabulary, or disable trend enforcement — unless a later written Slice 9 prompt explicitly says so.

Until live diagnostic fields exist, the correct Slice 9 stance remains: **observe, do not patch**.

---

# Feature flags (Kea Chat program)

Defaults below are **code defaults**. Production may set them differently.

| Flag | Default if unset | Production (last known) | Controls |
|---|---|---|---|
| `USE_EVIDENCE_LEDGER_PROMPT` | ON | ON | Macro Prompt View |
| `USE_LOOKUP_EVIDENCE_LEDGER_PROMPT` | ON | ON | Lookup Prompt View |
| `USE_SNAPSHOT_EVIDENCE_LEDGER_PROMPT` | ON | ON | Snapshot Prompt View |
| `USE_RESPONSE_VALIDATION_SHADOW` | ON | ON | 3C.2 observe-only validation |
| `USE_RESPONSE_VALIDATION_ENFORCEMENT` | **OFF** | **ON** (`true`) | 3C.3 block + fallback |
| `USE_SNAPSHOT_SEMANTIC_VALIDATION_SHADOW` | OFF | ON | Slice 2 |
| `USE_SNAPSHOT_COVERAGE_VALIDATION_SHADOW` | OFF | ON | Slice 3 |
| `USE_COMPARISON_RELATION_VALIDATION_SHADOW` | OFF | ON | Slice 4 |
| `USE_TREND_COVERAGE_VALIDATION_SHADOW` | OFF | ON | Slice 5 |
| `USE_LOOKUP_ATTRIBUTION_VALIDATION_SHADOW` | OFF | ON | Slice 6 |
| `USE_SNAPSHOT_NEGATIVE_MINIMUM_VALIDATION_SHADOW` | OFF | ON | Slice 7 |
| `USE_COMPARISON_METRIC_VALIDATION_SHADOW` | OFF | ON (restored after Slice 8 A/B) | Slice 8 |
| `USE_TREND_BLOCK_DIAGNOSTIC_TELEMETRY` | OFF | OFF until explicitly enabled | Temporary trend_diag fields |

Reliability knobs (optional): `KEA_CHAT_AZURE_TIMEOUT_MS`, `KEA_MACRO_TIMEOUT_MS`, `KEA_CHAT_BUDGET_MS`, `KEA_REDIS_COMMAND_TIMEOUT_MS`, `KEA_AUTH_DB_TIMEOUT_MS`.

---

# Tests

`npm test` → `tests/run.js` (labeled “Phase 0+1 suite” historically; it now includes through 3C.4 + diagnostic tests) + `test-kea-memory.js`.

There is **no Jest `npm test` suite beyond this harness**. Do not claim a separate Jest run.

At diagnostic commit: **5371** harness checks passed, memory passed.

---

# What later-phase fill-in must not assume is already done

As of cutoff, this repo has **no** commits or modules for:

- Phase 3C.4 Slice 9 implementation
- Phase 3C.5 / 3C.6
- Phase 3D
- Phases 4–8 **of this Kea Chat program**

If another document describes those stages, treat them as **plan**, not as shipped behavior.

Likely themes in later planning (unverified here — for the fill-in model to confirm from *its* sources, not from this repo):

- Promoting selected 3C.4 shadow codes into enforcement, or not
- Trend percent/direction binding remediation (only after live class)
- Removing `USE_TREND_BLOCK_DIAGNOSTIC_TELEMETRY`
- Streaming, further prompt/context optimization, additional Capsule features, write-gate changes, new macros

Do not invent that any of those have shipped.

---

# Key production files (map)

| Area | Files |
|---|---|
| Chat orchestration | `controllers/openaiController.js` |
| Auth / account | `keaIdentity.js`, `keaAccountAccess.js`, `keaSelectedAccountResolve.js` |
| Routing | `keaCapabilityRouter.js`, `keaToolBundles.js` |
| Grounding | `keaGroundingPolicy.js`, `keaGroundingPrefetch.js` |
| Capsule | `keaConversationCapsule.js`, `keaConversationStateResolver.js`, `keaConversationContinuation.js` |
| Ledger / prompt | `keaEvidenceLedger.js`, `keaEvidenceLedgerBuilders.js`, `keaEvidencePromptView.js`, `keaEvidencePromptCutover.js` |
| Lookup/snapshot evidence | `keaLookupEvidenceShadow.js`, `keaSnapshotEvidenceAdapter.js`, `keaSnapshotEvidenceShadow.js` |
| Validation | `keaResponseValidationContract.js`, `keaResponseClaimExtractor.js`, `keaResponseClaimValidator.js`, `keaResponseValidationShadow.js` |
| Enforcement | `keaResponseValidationEnforcement.js` |
| 3C.4 helpers | `keaSnapshotSemanticValidation.js`, `keaComparisonSemanticValidation.js`, `keaTrendSemanticValidation.js`, `keaLookupSemanticValidation.js`, `keaSnapshotNegativeBalanceSemanticValidation.js`, `keaComparisonMetricSemanticValidation.js` |
| Temporary diagnostics | `keaTrendBlockedDiagnosticTelemetry.js` |
| Telemetry | `keaTelemetry.js`, `keaEvidenceTelemetry.js` |
| Flags documented | `deployment.env.example` |

Cashflow-backend (not this repo, but on the trend path): `POST /account/kea-trend/:accountId` → `analyzePostedTrend`.

---

# Commit index (Kea Chat program only)

```
2206c90  2026-08-15  phase 0 Security + telemetry + cache correctness
3d090ca  2026-08-15  phase 0.5 pass
e465747  2026-08-15  phase 0.6 pass
426f067  2026-08-15  phase 0.6B pass
390a35c  2026-08-15  phase 06.C pass
dedaca9  2026-08-16  phase 0.7 pass
4fac64b  2026-08-16  phase 1 pass
ea04973  2026-08-16  phase 1.1 fixes
506926d  2026-08-16  phase 1.2 implementation
2d37f07  2026-08-16  phase 1.3 fixes
b7b1194  2026-08-16  phase 2 implementation
0cd6fbf … 2446120    phase 2.1–2.9 (no 2.7 title)
81fbf5e / 79c3181    phase 2B.1 comparison
dcb187e              phase 2b.2 trend
1bcab68              phase 2b.3 recurring
7ce2fe4 / 4c3d5df    temporal / upcoming
049cfab              phase 2b.4 income horizon
49064b4 … ce1bb68    phase 3A.1–3A.4
e230456 … 1e85588    phase 3B.1–3B.3B.5 + 3B.4
dfd367c … a7fc48e    phase 3C.2 (+ 3C.1 modules) and binding hardenings
2eea1c4              phase 3C.3 enforcement
b65919f              3C.4 Slice 1 period-scalar
4238574 / daaa2aa    3C.4 Slice 2
3241f0a              3C.4 Slice 3
6209111              3C.4 Slice 4
c662b17              3C.4 Slice 5
2105112              3C.4 Slice 6
0533de8              3C.4 Slice 7
44ad6e9              3C.4 Slice 8
7d4f97b              temporary trend blocked-response diagnostic telemetry
                     3C.4 Slice 9 — not committed
```

Blank-change commits between slices are deploy/health no-ops, not feature work.

---

*End of implemented record. Continue from Phase 3C.4 Slice 9 as planning, not as shipped code.*
