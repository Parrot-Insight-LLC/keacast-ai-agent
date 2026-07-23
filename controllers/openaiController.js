// controllers/openaiController.js
const redis = require('../services/redisService');
const { queryAzureOpenAI, functionSchemas } = require('../services/openaiService'); // must support tools
const { functionMap } = require('../tools/functionMap'); // <-- use functionMap.js
const contextCache = require('../services/contextCache.service'); // <-- use context cache service
const moment = require('moment');
const momentTimezone = require('moment-timezone');
const crypto = require('crypto');
// Shared vendor/merchant normalization (alias map + brand-root folding), ported
// from the frontend's vendor-normalize.ts so categorization merges merchant
// variants ("AMZN Mktp" / "Amazon.com", "COSTCO GAS #421" / "Costco gas") the
// same way the Sankey / pivot views do — strengthening history matching.
const { mergeVendorName } = require('../utils/vendorNormalize');
const MEMORY_TTL = 604800; // 1 week
const MAX_MEMORY = 20; // verbatim conversation window (older turns are folded into a rolling summary)
const MAX_MESSAGE_LENGTH = 20000; // increased limit for individual message length
const SYSTEM_PROMPT_MAX_LENGTH = 15000; // separate limit for system prompts

// ─── Kea Assistant memory-upgrade constants ────────────────────────────────
// Dialogue state (in-progress "draft" transaction + slot-filling) lives in
// Redis keyed by userId with a short TTL — it is transient, per-conversation
// working state, not durable memory. Keep this TTL SHORT: the previous 24h
// value let an abandoned draft survive into a completely unrelated
// conversation the next day, where a casual "sounds good" could commit it
// (a stale carpet-replacement draft was created instead of a requested
// weekly gas forecast). One hour comfortably covers an active conversation.
const DIALOGUE_TTL = 3600;               // 1 hour
const DIALOGUE_STATE_MAX_CHARS = 900;    // hard cap on the injected dialogue block
// Rolling short-term summary: a compact "conversation so far" that captures
// turns older than the verbatim window so long chats stay coherent + lean.
const SUMMARY_TTL = 604800;              // 1 week (matches MEMORY_TTL)
const SUMMARY_MAX_CHARS = 1200;          // hard cap on the injected summary block
const SUMMARY_TRIGGER = 16;              // start summarizing once history exceeds this many turns
// Long-term durable facts (fetched from cashflow-backend-api) budget.
const FACTS_MAX_CHARS = 1200;            // hard cap on the injected long-term-facts block
const GOALS_BLOCK_MAX_CHARS = 1100;      // hard cap on the injected active-goals block
const FACTS_PRELOAD_LIMIT = 12;          // max facts pulled into context per turn
// Multi-round tool loop: how many read→refine→act cycles a single user turn
// may run before we force a final answer. Bounds latency + token cost.
const MAX_TOOL_ROUNDS = 4;
const MAX_DRAFT_UPDATES_PER_TURN = 4;    // stop the model looping on updateDraftTransaction
// Tools that WRITE real data. These are gated in code (not just the prompt):
// they require a prior proposal (dialogueState.pendingConfirmation) AND an
// affirmative user turn before they may execute.
const WRITE_TOOLS = new Set(['createTransaction', 'updateTransaction']);
// Goal write tools share the same propose→confirm contract but NOT the
// transaction draft-slot merge (goal fields are unrelated to the transaction
// draft, so merging it over goal args would corrupt them).
const GOAL_WRITE_TOOLS = new Set(['createGoal', 'updateGoal', 'deleteGoal']);
// Non-writing tool that stages/refines the draft transaction slots.
const DRAFT_TOOL = 'updateDraftTransaction';
// Non-writing tool the model calls when it judges the user's latest message to
// confirm the pending proposal. This is the PRIMARY confirmation signal for
// the write gate (the isAffirmativeMessage regex remains as a fallback).
const CONFIRM_TOOL = 'confirmTransaction';
// Simulation ("what-if") propose tools. These never write — each returns a
// structured simOp the frontend applies to its client-side simulation overlay.
const SIM_PROPOSE_TOOLS = new Set(['proposeSimulationAdd', 'proposeSimulationModify', 'proposeSimulationRemove']);
// Non-writing UI-action tools: ask the CLIENT to open/navigate panels.
// Handled inline in executeToolCalls — no functionMap executors; actions ride
// back to the client as uiActions.
const UI_SEARCH_TOOL = 'openTransactionSearch';
const UI_CALENDAR_DAY_TOOL = 'openCalendarDay';
const UI_HIGHLIGHT_TX_TOOL = 'highlightTransaction';
const UI_NAVIGATE_TOOL = 'navigateTo';
const UI_ACTION_TOOLS = new Set([
  UI_SEARCH_TOOL,
  UI_CALENDAR_DAY_TOOL,
  UI_HIGHLIGHT_TX_TOOL,
  UI_NAVIGATE_TOOL,
]);
const ALLOWED_UI_NAV_ROUTES = new Set([
  '/calendar',
  '/insights',
  '/profile',
  '/settings',
  '/financial-feed',
  '/feed',
  '/recurring',
]);
const UI_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// While the client is in Simulation Mode, ALL real writes are refused in code
// (deleteTransaction included — it isn't in WRITE_TOOLS' confirm gate but it
// still mutates real data). The model is redirected to the propose tools.
const SIM_BLOCKED_WRITE_TOOLS = new Set(['createTransaction', 'updateTransaction', 'deleteTransaction', 'createGoal', 'updateGoal', 'deleteGoal']);
// Short TTL: the cache key is now a hash of the exact prompt (see
// buildSummarizationCacheKeyFromContent), so identical inputs are the only way
// to hit the cache. A short TTL is a secondary safety net that bounds how long
// a summary can linger if the underlying data changes in a way the key somehow
// doesn't capture (and it also naturally expires stale "Today"/month framing).
const SUMMARIZATION_CACHE_TTL = 300; // 5 minutes in seconds
// Bump this whenever the prompt/label logic changes so previously-cached
// summaries built by an older prompt version don't get served.
const SUMMARIZATION_PROMPT_VERSION = 'v2';

function buildSessionKey(req) {
  // Check multiple sources for sessionId in order of preference
  const sessionId = req.body.sessionId || 
                   req.query.sessionId || 
                   req.headers['x-session-id'] ||
                   req.user?.id || 
                   'anonymous';
  return `session:${sessionId}`;
}

// Normalize an incoming accountId into a stable, redis-safe cache segment.
// Accepts numbers / numeric strings / null / undefined. Anything else falls back
// to the literal "none" bucket so legacy callers (no accountId on the request)
// still get a working — but clearly distinct — cache slot.
function normalizeAccountIdForCacheKey(accountId) {
  if (accountId === undefined || accountId === null || accountId === '') {
    return 'none';
  }
  // Coerce to string and strip anything that could break a redis key.
  const str = String(accountId).trim();
  if (!str) return 'none';
  // Only allow [A-Za-z0-9_-]; replace anything else with '_'. accountids in
  // Keacast are integers today, but this guards against unexpected payloads.
  return str.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function buildSummarizationCacheKey(sessionKey, accountId, plaidTransactions, forecastedTransactions, balances) {
  // Create a hash of the input data to ensure cache is invalidated when data changes
  const dataString = JSON.stringify({
    plaidTransactions: plaidTransactions || [],
    forecastedTransactions: forecastedTransactions || [],
    balances: balances || []
  });
  const dataHash = crypto.createHash('md5').update(dataString).digest('hex');
  const accountSegment = normalizeAccountIdForCacheKey(accountId);
  // Key shape: summarization:<sessionKey>:account:<accountId>:<dataHash>
  // The explicit "account:<id>" segment lets us:
  //   1. Guarantee that switching accounts NEVER reuses another account's summary,
  //      even when the data hashes happen to overlap.
  //   2. Wildcard-delete every cached summary for one account
  //      (`summarization:<sessionKey>:account:<id>:*`) when its data changes
  //      (e.g. after a reconcile / Plaid refresh) without nuking the other
  //      accounts' caches.
  return `summarization:${sessionKey}:account:${accountSegment}:${dataHash}`;
}

// ─── Summarization helpers ──────────────────────────────────────────────────
// These power the slim, server-side-fetched flow inside exports.summarization.
// They are intentionally tiny and side-effect-free so the prompt builder
// stays readable and so we can unit-test (or swap them out) easily.

const SELECTED_ACCOUNT_TOOL_TTL = 300;   // 5 min Redis cache for the tool-layer fetch
// /account/selected is heavy (live Plaid + multi-table joins + chart compute),
// routinely 8–15s on cold accounts. 25s gives us reasonable headroom while
// still surfacing a clear timeout instead of hanging forever.
const SELECTED_ACCOUNT_TOOL_TIMEOUT_MS = 25000;

function selectedAccountToolCacheKey(userId, accountId) {
  const u = normalizeAccountIdForCacheKey(userId);
  const a = normalizeAccountIdForCacheKey(accountId);
  return `summarization:tool:selectedaccount:${u}:${a}`;
}

// Build a cheap, stable fingerprint for the cache key when we have the
// fully-fetched account blob. We deliberately AVOID hashing whole transaction
// arrays — Plaid timestamps + balance refresh time are sufficient invalidation
// signals and keep the key construction O(1) instead of O(n).
function buildAccountFingerprint(account) {
  if (!account || typeof account !== 'object') return null;
  const len = (v) => (Array.isArray(v) ? v.length : 0);
  const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : v ?? '');
  return [
    account.accountid ?? '',
    round(account.balance),
    round(account.available),
    round(account.current),
    account.plaid_latest ?? '',
    account.updated_at ?? '',
    len(account.recents),
    len(account.upcoming),
    len(account.cfTransactions),
    len(account.plaidTransactions),
    len(account.futureNegativeBalances),
  ].join('|');
}

function buildSummarizationCacheKeyFromFingerprint(sessionKey, accountId, fingerprint) {
  const fp = typeof fingerprint === 'string' && fingerprint.length > 0
    ? fingerprint
    : 'no-fingerprint';
  const fpHash = crypto.createHash('md5').update(fp).digest('hex');
  const accountSegment = normalizeAccountIdForCacheKey(accountId);
  return `summarization:${sessionKey}:account:${accountSegment}:${fpHash}`;
}

// Content-addressed cache key: hash the EXACT text handed to the model
// (system + user prompt). This guarantees the cache is only reused when the
// generated summary would be byte-for-byte identical — any change in balances,
// transactions, totals, negative-balance days, the "Today" date, or the prompt
// wording produces a new key and therefore a fresh summary. This replaces the
// coarse, length-only account fingerprint that could serve stale summaries
// when contents changed without changing counts. The key shape keeps the
// explicit `account:<id>` segment so we can still wildcard-purge one account.
function buildSummarizationCacheKeyFromContent(sessionKey, accountId, promptText) {
  const text = typeof promptText === 'string' && promptText.length > 0 ? promptText : 'empty';
  const hash = crypto
    .createHash('md5')
    .update(`${SUMMARIZATION_PROMPT_VERSION}\n${text}`)
    .digest('hex');
  const accountSegment = normalizeAccountIdForCacheKey(accountId);
  return `summarization:${sessionKey}:account:${accountSegment}:${hash}`;
}

function coerceFirstName(userData, fallbackUser) {
  const candidates = [
    userData?.firstname,
    userData?.firstName,
    userData?.first_name,
    fallbackUser?.firstname,
    fallbackUser?.firstName,
    fallbackUser?.first_name,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim().split(/\s+/)[0];
  }
  return 'there';
}

function fmtMoney(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '$0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  // Round to whole dollars unless small (< $10) where cents matter.
  const formatted = abs < 10 ? abs.toFixed(2) : Math.round(abs).toString();
  return `${sign}$${formatted}`;
}

// Strip thousands-separator commas from $-amounts in model-generated prose so
// currency renders as $1000 instead of $1,000. Only touches numbers that are
// $-prefixed AND actually comma-grouped, so plain numbers, years, and lists are
// left untouched.
function stripCurrencyCommas(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\$-?\d{1,3}(?:,\d{3})+(?:\.\d+)?/g, (m) => m.replace(/,/g, ''));
}

function shortDate(value) {
  if (!value) return '';
  // Accept either Plaid `date` or Keacast `start` (both YYYY-MM-DD strings).
  const m = moment(value);
  return m.isValid() ? m.format('MMM D') : '';
}

// Compact one transaction into "Name|±$amt|Date" — ~30-50 chars per line.
function compactTxnLine(t) {
  if (!t || typeof t !== 'object') return null;
  const name = (t.merchant_name || t.name || t.category || 'Transaction').toString().slice(0, 28);
  const amt = typeof t.amount === 'number' ? t.amount : Number(t.amount);
  if (!Number.isFinite(amt)) return null;
  const date = shortDate(t.date || t.start || t.authorized_date);
  return `${name}|${fmtMoney(amt)}${date ? '|' + date : ''}`;
}

// Pull the most recent N flat transactions out of `recents` (which can be
// either a flat array OR a [{date, transactions:[...]}, ...] grouped-by-day
// array depending on which controller served the response) and/or
// plaidTransactions, sorted newest-first.
function pickRecentTransactions(account, limit = 6) {
  if (!account || typeof account !== 'object') return [];
  const flat = [];
  const recents = Array.isArray(account.recents) ? account.recents : [];
  for (const r of recents) {
    if (!r) continue;
    if (Array.isArray(r.transactions)) {
      for (const t of r.transactions) flat.push(t);
    } else if (typeof r === 'object') {
      flat.push(r);
    }
  }
  if (flat.length === 0 && Array.isArray(account.plaidTransactions)) {
    for (const t of account.plaidTransactions) flat.push(t);
  }
  flat.sort((a, b) => {
    const da = moment(a?.date || a?.start || a?.authorized_date || 0).valueOf();
    const db = moment(b?.date || b?.start || b?.authorized_date || 0).valueOf();
    return db - da;
  });
  return flat.slice(0, limit).map(compactTxnLine).filter(Boolean);
}

function pickUpcomingTransactions(account, limit = 5) {
  if (!account || typeof account !== 'object') return [];
  const upcoming = Array.isArray(account.upcoming) ? account.upcoming : [];
  // Already sorted by `start` ascending in the controller; trust it.
  return upcoming.slice(0, limit).map(compactTxnLine).filter(Boolean);
}

function pickNegativeBalancePreviews(account, limit = 2) {
  if (!account || typeof account !== 'object') return [];
  const arr = Array.isArray(account.futureNegativeBalances) ? account.futureNegativeBalances : [];
  return arr.slice(0, limit).map(b => {
    const amt = fmtMoney(typeof b?.amount === 'number' ? b.amount : Number(b?.amount));
    const when = b?.daysUntil || shortDate(b?.date) || '';
    return `${amt}${when ? ' ' + when : ''}`;
  }).filter(Boolean);
}

// ─── Server-side analytics for the summary ──────────────────────────────────
// These "do the math" so the LLM only has to phrase precomputed, labelled
// figures. Sign convention (consistent with compactTxnLine / the prompt's
// "leading - for negatives" rule): amount < 0 = expense/outflow,
// amount > 0 = income/inflow.

// Flatten `recents` (flat OR grouped-by-day) into a single transaction array,
// falling back to plaidTransactions. Mirrors pickRecentTransactions' flattening.
function flattenRecents(account) {
  const flat = [];
  const recents = Array.isArray(account?.recents) ? account.recents : [];
  for (const r of recents) {
    if (!r) continue;
    if (Array.isArray(r.transactions)) {
      for (const t of r.transactions) flat.push(t);
    } else if (typeof r === 'object') {
      flat.push(r);
    }
  }
  if (flat.length === 0 && Array.isArray(account?.plaidTransactions)) {
    for (const t of account.plaidTransactions) flat.push(t);
  }
  return flat;
}

function txnAmount(t) {
  const a = typeof t?.amount === 'number' ? t.amount : Number(t?.amount);
  return Number.isFinite(a) ? a : null;
}

// Largest single upcoming expense in the next window → "Name -$X on Mon D".
function pickLargestUpcomingExpense(account) {
  const upcoming = Array.isArray(account?.upcoming) ? account.upcoming : [];
  let worst = null;
  for (const t of upcoming) {
    const amt = txnAmount(t);
    if (amt === null || amt >= 0) continue; // expenses only
    if (!worst || amt < txnAmount(worst)) worst = t;
  }
  return worst ? compactTxnLine(worst) : null;
}

// Soonest upcoming income event → "Name $X on Mon D". `upcoming` is already
// sorted ascending by start date, so the first positive amount is the nearest.
function pickNextIncome(account) {
  const upcoming = Array.isArray(account?.upcoming) ? account.upcoming : [];
  for (const t of upcoming) {
    const amt = txnAmount(t);
    if (amt !== null && amt > 0) return compactTxnLine(t);
  }
  return null;
}

// Top spending merchants over the recent (~30 day) window, aggregated by name.
// Returns ["Merchant -$X", ...] highest-first, so the model can surface real
// behavioural patterns without inventing categories or totals.
function topSpendingMerchants(account, limit = 3) {
  const flat = flattenRecents(account);
  const totals = new Map();
  for (const t of flat) {
    const amt = txnAmount(t);
    if (amt === null || amt >= 0) continue; // expenses only (negative)
    const name = (t.merchant_name || t.name || t.category || 'Other').toString().slice(0, 28);
    totals.set(name, (totals.get(name) || 0) + Math.abs(amt));
  }
  return Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, sum]) => `${name} ${fmtMoney(-sum)}`);
}

// Build the compact, deterministic user-payload string handed to the LLM.
// Replaces the old `JSON.stringify(plaidTransactions)` dump (often 5-15 KB)
// with a ~600-1200 char structured brief built from precomputed signals on
// the account blob. This is the single biggest token-reduction lever.
//
// IMPORTANT: every dollar amount in this payload MUST carry an explicit time
// window so the LLM has zero room to confabulate one. A previous version
// surfaced raw `savings.totalExpenses` without a label — the model then
// invented "due by May 31" because that's the end of the current month, even
// though no specific date appeared in the data. Every label below now spells
// out its window verbatim.
function buildSummarizationUserContent(account, firstName, fallback, opts = {}) {
  const today = opts.today || moment().format('YYYY-MM-DD');
  const monthLabel = moment(today, 'YYYY-MM-DD').format('MMMM');
  const monthEnd = moment(today, 'YYYY-MM-DD').endOf('month').format('MMM D');

  const lines = [
    `Today: ${today}.`,
    `User first name: ${firstName}.`,
  ];

  if (account && typeof account === 'object') {
    const name = account.accountname || account.bank_account_name || account.institution_name || 'their account';
    const type = account.account_type || account.type || '';
    const balance = fmtMoney(typeof account.balance === 'number' ? account.balance : Number(account.balance));
    const available = fmtMoney(typeof account.available === 'number' ? account.available : Number(account.available));
    lines.push(`Account: ${name}${type ? ` (${type})` : ''} — current balance ${balance}, available ${available}.`);

    if (typeof account.credit_limit === 'number' && account.credit_limit > 0) {
      lines.push(`Credit limit ${fmtMoney(account.credit_limit)}.`);
    }

    // savings.totalIncome / totalExpenses are scoped to "all current-month
    // F/RF forecasts where match_id IS NULL". On accounts where the user is
    // behind on reconciliation, this can be a much larger number than what
    // they actually owe today (because already-spent-but-unreconciled
    // forecasts pile up). Empirically the LLM tends to wrap that figure in
    // urgent phrasing ("$X due by month-end") that misleads the user, so we
    // intentionally drop totalIncome / totalExpenses / netCashFlow and rely
    // on the cleaner "next 14 days" totals + the explicit transaction lists
    // below. We keep savingsPotential because it's unambiguous: it is the
    // minimum projected balance over the rest of the month given current
    // commitments.
    const sav = account.savings;
    if (sav && typeof sav === 'object') {
      const pot = typeof sav.savingsPotential === 'number' ? sav.savingsPotential : Number(sav.savingsPotential);
      const pct = typeof sav.savingsPercentage === 'number' ? sav.savingsPercentage : null;
      if (Number.isFinite(pot) && pot > 0) {
        lines.push(
          `Lowest projected balance through end of ${monthLabel} (${monthEnd}): ${fmtMoney(pot)}${pct !== null ? ` (${pct}% of available)` : ''}.`
        );
      }
    }

    // Next-14-day totals are precomputed by the controller and have an
    // unambiguous window. This is the primary short-horizon cash-flow signal.
    if (typeof account.upcomingExpenseTotal === 'number' || typeof account.upcomingIncomeTotal === 'number') {
      const incAbs = Math.abs(account.upcomingIncomeTotal || 0);
      const expAbs = Math.abs(account.upcomingExpenseTotal || 0);
      lines.push(`Next 14 days totals: income ${fmtMoney(incAbs)}, expenses ${fmtMoney(expAbs)}.`);
      // Net is derived server-side so the model never has to subtract (HARD
      // RULE #1 forbids it doing math). Labelled with the same explicit window.
      lines.push(`Next 14 days net cash flow: ${fmtMoney(incAbs - expAbs)}.`);
    }

    const negs = pickNegativeBalancePreviews(account);
    if (negs.length > 0) {
      lines.push(`Future days the projected balance goes negative: ${negs.join('; ')}.`);
    }

    // Nearest income event — "when money is coming in" — pairs naturally with
    // the negative-balance heads-up above.
    const nextIncome = pickNextIncome(account);
    if (nextIncome) {
      lines.push(`Next expected income: ${nextIncome}.`);
    }

    // Single biggest upcoming hit so the user sees the largest commitment.
    const bigExpense = pickLargestUpcomingExpense(account);
    if (bigExpense) {
      lines.push(`Largest upcoming expense (next 14 days): ${bigExpense}.`);
    }

    const recent = pickRecentTransactions(account, 6);
    if (recent.length > 0) {
      lines.push(`Recent posted (last ~30 days): ${recent.join('; ')}.`);
    }

    // Aggregated top merchants → behavioural insight, precomputed so the model
    // isn't tempted to sum transactions itself.
    const topSpend = topSpendingMerchants(account, 3);
    if (topSpend.length > 0) {
      lines.push(`Top spending (last ~30 days): ${topSpend.join('; ')}.`);
    }

    const upc = pickUpcomingTransactions(account, 5);
    if (upc.length > 0) {
      lines.push(`Upcoming forecasted (next 14 days): ${upc.join('; ')}.`);
    }
  } else if (fallback) {
    // Tool layer unavailable — fall back to whatever the frontend sent so we
    // still produce a summary instead of erroring out. Compact it heavily.
    const plaid = Array.isArray(fallback.plaidTransactions) ? fallback.plaidTransactions.slice(0, 6) : [];
    const fc = Array.isArray(fallback.forecastedTransactions) ? fallback.forecastedTransactions.slice(0, 5) : [];
    if (plaid.length) lines.push(`Recent posted: ${plaid.map(compactTxnLine).filter(Boolean).join('; ')}.`);
    if (fc.length) lines.push(`Upcoming forecasted: ${fc.map(compactTxnLine).filter(Boolean).join('; ')}.`);
    if (Array.isArray(fallback.balances) && fallback.balances.length > 0) {
      const last = fallback.balances[fallback.balances.length - 1];
      if (last && typeof last.amount !== 'undefined') {
        lines.push(`Latest projected balance: ${fmtMoney(Number(last.amount))} on ${shortDate(last.date)}.`);
      }
    }
  }

  lines.push('');
  lines.push('Write 4-7 short, casual sentences (≤600 chars). Use the labels above verbatim.');
  return lines.join('\n');
}

// Compact, token-minimal context block for the chat endpoint.
//
// The previous chat flow dumped up to 250 historical + 250 upcoming + 250
// forecasted transactions plus full balance arrays as pretty-printed JSON —
// routinely 50-100 KB (~15-25K tokens) on every single turn. This seeds only a
// high-signal brief (~1-2 KB) built from the precomputed fields on the
// getSelectedAccount blob. Anything more specific (a single transaction, a
// category, a merchant, a date range) is fetched on demand by the
// function-calling tools, so the model still has full reach without paying the
// upfront token cost.
function buildChatAccountContext(account, firstName, currentDate) {
  const today = currentDate || moment().format('YYYY-MM-DD');
  const monthLabel = moment(today, 'YYYY-MM-DD').format('MMMM');
  const monthEnd = moment(today, 'YYYY-MM-DD').endOf('month').format('MMM D');

  const name = account.accountname || account.bank_account_name || account.institution_name || 'their account';
  const type = account.account_type || account.type || '';
  const inst = account.institution_name || '';
  const balance = fmtMoney(typeof account.balance === 'number' ? account.balance : Number(account.balance));
  const available = fmtMoney(typeof account.available === 'number' ? account.available : Number(account.available));

  const lines = [
    `Today: ${today}. User first name: ${firstName}.`,
    `Account: ${name}${type ? ` (${type})` : ''}${inst ? ` @ ${inst}` : ''} — balance ${balance}, available ${available}.`,
  ];

  if (typeof account.credit_limit === 'number' && account.credit_limit > 0) {
    lines.push(`Credit limit ${fmtMoney(account.credit_limit)}.`);
  }
  if (account.plaid_latest) {
    lines.push(`Latest activity: ${shortDate(account.plaid_latest)}.`);
  }

  const sav = account.savings;
  if (sav && typeof sav === 'object') {
    const pot = typeof sav.savingsPotential === 'number' ? sav.savingsPotential : Number(sav.savingsPotential);
    if (Number.isFinite(pot)) {
      lines.push(`Lowest projected balance through end of ${monthLabel} (${monthEnd}): ${fmtMoney(pot)} — this is the month's safe-to-save amount (savings potential).`);
    }
    // Month-level forecast summary → the "forecasted disposable" number the
    // prompt style guide requires but nothing previously computed.
    const inc = Number(sav.totalIncome);
    const exp = Number(sav.totalExpenses);
    const net = Number(sav.netCashFlow);
    if (Number.isFinite(inc) && Number.isFinite(exp) && (inc !== 0 || exp !== 0)) {
      lines.push(`${monthLabel} forecast: income ${fmtMoney(inc)}, expenses ${fmtMoney(-Math.abs(exp))}, forecasted disposable (net cash flow) ${fmtMoney(net)}.`);
    }
  }
  if (typeof account.upcomingExpenseTotal === 'number' || typeof account.upcomingIncomeTotal === 'number') {
    lines.push(`Next 14 days: income ${fmtMoney(Math.abs(account.upcomingIncomeTotal || 0))}, expenses ${fmtMoney(Math.abs(account.upcomingExpenseTotal || 0))}.`);
  }

  const negs = pickNegativeBalancePreviews(account, 5);
  if (negs.length > 0) {
    lines.push(`Future negative projected balances within ~90 days (warn the user; any plan must avoid making these worse): ${negs.join('; ')}.`);
  } else {
    lines.push('No negative projected balances in the next ~90 days.');
  }

  const topCats = pickTopSpendingCategories(account, 5);
  if (topCats.length > 0) {
    lines.push(`Top recent spending categories (posted): ${topCats.join('; ')} — use these as concrete levers when suggesting where to free up cash.`);
  }

  const recent = pickRecentTransactions(account, 10);
  if (recent.length > 0) {
    lines.push(`Recent posted (Name|Amt|Date): ${recent.join('; ')}.`);
  }
  const upc = pickUpcomingTransactions(account, 10);
  if (upc.length > 0) {
    lines.push(`Upcoming forecasted (Name|Amt|Date): ${upc.join('; ')}.`);
  }

  lines.push('');
  lines.push(
    'This is a high-level brief. For anything not listed above (a specific transaction, category, merchant, or date range), call the available tools to fetch exact data instead of guessing. Use createTransaction to add forecasts, deleteTransaction to remove them, getGoals/previewGoalCadence/createGoal for savings goals.'
  );
  return lines.join('\n');
}

// Aggregate recent posted expenses by category (from account.breakdown when
// populated, else account.recents) so advice can name concrete, quantified
// levers ("Dining is your #2 category at $410/mo") instead of staying vague.
function pickTopSpendingCategories(account, limit = 5) {
  if (!account || typeof account !== 'object') return [];
  const rows = [];
  const pools = [account.breakdown, account.recents];
  for (const pool of pools) {
    if (!Array.isArray(pool) || pool.length === 0) continue;
    for (const r of pool) {
      if (!r) continue;
      if (Array.isArray(r.transactions)) rows.push(...r.transactions);
      else rows.push(r);
    }
    if (rows.length > 0) break; // prefer breakdown; fall back to recents
  }
  const totals = new Map();
  for (const t of rows) {
    const amt = Number(t?.amount);
    if (!Number.isFinite(amt) || amt >= 0) continue; // expenses only
    const cat = String(t?.category || '').trim();
    if (!cat) continue;
    totals.set(cat, (totals.get(cat) || 0) + Math.abs(amt));
  }
  return Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cat, total]) => `${cat} ${fmtMoney(total)}`);
}

// Compact ACTIVE GOALS block for the system prompt, derived from the goals
// already embedded in the selected-account blob (serializeGoal shape). Keeps
// goal progress permanently visible to the model without a tool round-trip.
function buildGoalsBlock(goals, currentDate) {
  if (!Array.isArray(goals) || goals.length === 0) return '';
  const today = currentDate && moment(currentDate).isValid() ? moment(currentDate) : moment();
  const lines = [];
  for (const g of goals) {
    if (!g || g.status === 'abandoned') continue;
    const target = Number(g.target_amount) || 0;
    const accumulated = Number(g.accumulated_amount) || 0;
    const pct = target > 0 ? Math.min(100, Math.round((accumulated / target) * 100)) : 0;
    // Expected-by-now from the contribution schedule → on-track signal.
    let expected = 0;
    for (const c of (Array.isArray(g.contributions) ? g.contributions : [])) {
      if (!c || c.status === 'Skipped') continue;
      const start = moment(c.start);
      if (start.isValid() && start.isSameOrBefore(today, 'day')) expected += Math.abs(Number(c.amount) || 0);
    }
    const end = g.end_date ? moment(g.end_date) : null;
    const daysLeft = end && end.isValid() ? Math.max(0, end.diff(today, 'days')) : null;
    const onTrack = accumulated >= expected - 0.01;
    lines.push(
      `- ${g.title || g.display_name || 'Goal'} (goalid ${g.goalid}): ${fmtMoney(accumulated)} of ${fmtMoney(target)} (${pct}%)` +
      `${daysLeft != null ? `, ${daysLeft} days left (by ${moment(g.end_date).format('MMM D, YYYY')})` : ''}` +
      `${g.status === 'in_progress' ? (onTrack ? ', on track' : `, BEHIND schedule (expected ${fmtMoney(expected)} by now)`) : `, ${g.status}`}`
    );
  }
  if (lines.length === 0) return '';
  return truncateText(
    `ACTIVE GOALS (the user's real savings goals on this account; use these exact numbers):\n${lines.join('\n')}\nUse getGoals for full details; reference goals by goalid when updating.`,
    GOALS_BLOCK_MAX_CHARS
  );
}

// No-account variant: keep it short and let the (already large) system prompt
// + FAQ carry the feature explanations.
function buildChatNoAccountContext(firstName) {
  return [
    `User first name: ${firstName}.`,
    'The user has NOT loaded any accounts yet.',
    'Explain Keacast\'s purpose and features (calendar-based cash-flow forecasting, reconciliation, recurring detection, scenario planning, category breakdowns) and how to connect accounts via Plaid, then add forecasted transactions and reconcile history.',
    'Use the FAQ in the system prompt. Encourage listing incomes first, then expenses, so the calendar can reveal cash flow over time.',
  ].join('\n');
}

function truncateText(text, maxChars) {
  if (text === undefined || text === null) return '';
  const str = String(text).trim();
  if (str.length <= maxChars) return str;
  return str.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function truncateMessage(message, maxLength = MAX_MESSAGE_LENGTH) {
  if (!message || typeof message !== 'object') return message;
  
  const truncated = { ...message };
  if (truncated.content && typeof truncated.content === 'string') {
    // Use different limits for system messages vs other messages
    const limit = truncated.role === 'system' ? SYSTEM_PROMPT_MAX_LENGTH : maxLength;
    truncated.content = truncateText(truncated.content, limit);
  }
  
  return truncated;
}

function cleanToolResponses(messages) {
  return messages.map(msg => {
    // Clean up tool responses that might be very long
    if (msg.role === 'tool' && msg.content) {
      try {
        const content = JSON.parse(msg.content);
        // If tool response is too long, truncate it
        if (JSON.stringify(content).length > MAX_MESSAGE_LENGTH) {
          return {
            ...msg,
            content: JSON.stringify({
              ...content,
              _truncated: true,
              originalLength: JSON.stringify(content).length
            })
          };
        }
      } catch (e) {
        // If not JSON, truncate the string
        if (msg.content.length > MAX_MESSAGE_LENGTH) {
          return {
            ...msg,
            content: truncateText(msg.content, MAX_MESSAGE_LENGTH)
          };
        }
      }
    }
    return msg;
  });
}

function sanitizeMessageArray(messages) {
  if (!Array.isArray(messages)) return [];
  
  console.log('Sanitizing message array, original length:', messages.length);
  const sanitized = [];
  
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    
    // Always keep system, user, and assistant messages
    if (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant') {
      sanitized.push(msg);
      continue;
    }
    
    // For tool messages, only keep them if they have a valid tool_call_id
    // and there's a preceding assistant message with tool_calls
    if (msg.role === 'tool') {
      let shouldKeep = false;
      
      // Look backwards to find the preceding assistant message with tool_calls
      for (let j = i - 1; j >= 0; j--) {
        const prevMsg = messages[j];
        if (prevMsg.role === 'assistant' && prevMsg.tool_calls && prevMsg.tool_calls.length > 0) {
          // Check if this tool message corresponds to one of the tool_calls
          if (prevMsg.tool_calls.some(tc => tc.id === msg.tool_call_id)) {
            shouldKeep = true;
            break;
          }
        }
      }
      
      if (!shouldKeep) {
        console.log('Sanitizing: Removing orphaned tool message with tool_call_id:', msg.tool_call_id);
        continue;
      }
    }
    
    // Keep the message if we haven't filtered it out
    sanitized.push(msg);
  }
  
  console.log('Sanitizing complete, final length:', sanitized.length);
  return sanitized;
}

// Normalize a client-sent chat transcript into [{role, content}] turns.
// Accepts both the backend shape ({role, content}) and the frontend chat-UI
// shape ({sender, text}). Keeps only non-empty user/assistant turns and caps
// to the most recent MAX_MEMORY so the request stays lean.
function normalizeClientHistory(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    let role = m.role;
    if (role !== 'user' && role !== 'assistant') {
      role = m.sender === 'assistant' ? 'assistant' : m.sender === 'user' ? 'user' : null;
    }
    const content = typeof m.content === 'string'
      ? m.content
      : (typeof m.text === 'string' ? m.text : '');
    if ((role === 'user' || role === 'assistant') && content && content.trim()) {
      out.push({ role, content: content.trim() });
    }
  }
  return out.slice(-MAX_MEMORY);
}

function extractAuthFromRequest(req) {
  const bearerToken = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.split(' ')[1]
    : undefined;
  const headerToken = req.headers['x-auth-token'];
  const bodyToken = req.body?.token;
  const token = bearerToken || headerToken || bodyToken;

  const headerUserId = req.headers['x-user-id'];
  const bodyUserId = req.body?.sessionId;
  const jwtUserId = req.user?.id;
  const userId = bodyUserId || headerUserId || jwtUserId;

  return { token, userId, authHeader: req.headers.authorization };
}

function extractContextFromBody(req) {
  const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts : undefined;
  const categories = Array.isArray(req.body?.categories) ? req.body.categories : undefined;
  const shoppingList = Array.isArray(req.body?.shoppingList) ? req.body.shoppingList : undefined;
  const transactions = Array.isArray(req.body?.transactions) ? req.body.transactions : undefined;
  
  if (accounts || categories || shoppingList || transactions) {
    return {
      accounts: accounts || [],
      categories: categories || [],
      shoppingList: shoppingList || [],
      transactions: transactions || []
    };
  }
  return undefined;
}

// Function to get timezone from coordinates using a simple approximation
function getTimezoneFromCoordinates(latitude, longitude) {
  // Simple timezone approximation based on longitude
  // This is a basic implementation - for production, consider using a proper timezone API
  const timezoneOffset = Math.round(longitude / 15);
  
  // Map common timezone offsets to timezone names
  const timezoneMap = {
    '-12': 'Pacific/Auckland', // UTC-12
    '-11': 'Pacific/Midway',   // UTC-11
    '-10': 'Pacific/Honolulu', // UTC-10
    '-9': 'America/Anchorage', // UTC-9
    '-8': 'America/Los_Angeles', // UTC-8
    '-7': 'America/Denver',    // UTC-7
    '-6': 'America/Chicago',   // UTC-6
    '-5': 'America/New_York',  // UTC-5
    '-4': 'America/Halifax',   // UTC-4
    '-3': 'America/Sao_Paulo', // UTC-3
    '-2': 'Atlantic/South_Georgia', // UTC-2
    '-1': 'Atlantic/Azores',   // UTC-1
    '0': 'Europe/London',      // UTC+0
    '1': 'Europe/Paris',       // UTC+1
    '2': 'Europe/Kiev',        // UTC+2
    '3': 'Europe/Moscow',      // UTC+3
    '4': 'Asia/Dubai',         // UTC+4
    '5': 'Asia/Tashkent',      // UTC+5
    '6': 'Asia/Almaty',        // UTC+6
    '7': 'Asia/Bangkok',       // UTC+7
    '8': 'Asia/Shanghai',      // UTC+8
    '9': 'Asia/Tokyo',         // UTC+9
    '10': 'Australia/Sydney',  // UTC+10
    '11': 'Pacific/Guadalcanal', // UTC+11
    '12': 'Pacific/Auckland'   // UTC+12
  };
  
  return timezoneMap[timezoneOffset.toString()] || 'UTC';
}

// Function to get current date in user's timezone
function getCurrentDateInTimezone(location) {
  if (!location || typeof location.latitude !== 'number' || typeof location.longitude !== 'number') {
    // Fallback to UTC if no valid location provided
    console.log('No valid location provided, using UTC');
    return moment().utc().format('YYYY-MM-DD');
  }
  
  try {
    const timezone = getTimezoneFromCoordinates(location.latitude, location.longitude);
    console.log(`Calculated timezone for coordinates (${location.latitude}, ${location.longitude}): ${timezone}`);
    
    const currentDate = momentTimezone.tz(timezone).format('YYYY-MM-DD');
    console.log(`Current date in ${timezone}: ${currentDate}`);
    
    return currentDate;
  } catch (error) {
    console.warn('Error calculating timezone, falling back to UTC:', error.message);
    return moment().utc().format('YYYY-MM-DD');
  }
}

function createContextSummary(userContext) {
  if (!userContext || Object.keys(userContext).length === 0) {
    return { hasData: false };
  }

  const summary = {
    hasData: true,
    userData: userContext.userData ? {
      hasUserData: true,
      // Include key user fields if they exist
      ...(userContext.userData.firstname && { firstname: userContext.userData.firstname }),
      ...(userContext.userData.lastname && { lastname: userContext.userData.lastname }),
      ...(userContext.userData.email && { email: userContext.userData.email })
    } : { hasUserData: false },
    selectedAccounts: userContext.selectedAccounts ? {
      count: userContext.selectedAccounts.length,
      // Include key account details
      accounts: userContext.selectedAccounts.map(acc => ({
        accountid: acc.accountid,
        name: acc.accountname,
        type: acc.account_type,
        balance: acc.balance,
        available: acc.available,
        current: acc.current,
        credit_limit: acc.credit_limit,
        forecasted: acc.forecasted,
        bank_account_name: acc.bankaccount_name,
        institution_name: acc.institution_name,
        institution_logo: acc.institution_logo,
        plaid_latest: acc.plaid_latest,
      })).slice(0, 3) // Limit to first 3 accounts
    } : { count: 0 },
    dataCounts: {
      categories: userContext.categories ? userContext.categories.length : 0,
      shoppingList: userContext.shoppingList ? userContext.shoppingList.length : 0,
      transactions: userContext.cfTransactions ? userContext.cfTransactions.length : 0,
      upcomingTransactions: userContext.upcomingTransactions ? userContext.upcomingTransactions.length : 0,
      plaidTransactions: userContext.plaidTransactions ? userContext.plaidTransactions.length : 0,
      recentTransactions: userContext.recentTransactions ? userContext.recentTransactions.length : 0,
      breakdown: userContext.breakdown ? userContext.breakdown.length : 0
    },
    // Include a sample of recent transactions for context
    categories: userContext.categories && Array.isArray(userContext.categories) ? userContext.categories : [],
    transactions: userContext.cfTransactions && Array.isArray(userContext.cfTransactions) ? 
      userContext.cfTransactions.filter(t => t.forecast_type !== 'A').slice(0, 250).map(t => ({
        transaction_id: t.transactionid,
        name: t.title,
        display_name: t.display_name,
        amount: t.amount,
        description: t.description,
        date: moment(t.start).format('MMM DD, YYYY'),
        category: t.category,
        status: t.status,
        merchant_name: t.merchant,
        frequency: t.frequency2,
      })) : [],
    // recentTransactions: userContext.recentTransactions && Array.isArray(userContext.recentTransactions) ? 
    //   userContext.recentTransactions.slice(0, 250).map(t => ({
    //     id: t.tid,
    //     amount: t.amount,
    //     description: t.description,
    //     date: moment(t.start).format('MMM DD, YYYY'),
    //     category: t.category
    //   })) : [],
    upcomingTransactions: userContext.upcomingTransactions && Array.isArray(userContext.upcomingTransactions) ? 
    userContext.upcomingTransactions.slice(0, 250).map(t => ({
        transaction_id: t.transactionid,
        name: t.title,
        display_name: t.display_name,
        amount: t.amount,
        description: t.description,
        date: moment(t.start).format('MMM DD, YYYY'),
        category: t.category,
        status: t.status,
        merchant_name: t.merchant,
        frequency: t.frequency2,
        daysUntil: t.daysUntil
      })) : [],
    plaidTransactions: userContext.plaidTransactions && Array.isArray(userContext.plaidTransactions) ? 
    userContext.plaidTransactions.slice(0, 250).map(t => ({
        transaction_id: t.transaction_id,
        amount: t.adjusted_amount,
        name: t.name,
        display_name: t.display_name,
        description: t.description,
        date: moment(t.date).format('MMM DD, YYYY'),
        category: t.adjusted_category,
        status: t.status
      })) : [],
    possibleRecurringTransactions: userContext.possibleRecurringTransactions ? 
    userContext.possibleRecurringTransactions : [],
    breakdown: userContext.breakdown && Array.isArray(userContext.breakdown) ? userContext.breakdown : [],
    balances: userContext.balances && Array.isArray(userContext.balances) ? userContext.balances : [],
    availableBalance: userContext.available && Array.isArray(userContext.available) ? userContext.available : [],
    forecastedBalance: userContext.balances.find((balance) => moment(balance.date, 'YYYY/MM/DD').format('YYYY-MM-DD') === moment(userContext.currentDate).format('YYYY-MM-DD')).amount
  };

  return summary;
}

/**
 * Execute tool calls and get final response:
 * - executes requested tools via functionMap[name](args, ctx)
 * - returns the final answer without corrupting the original message array
 */
// Build a user-facing fallback string from raw tool results. Only used when
// the follow-up LLM call fails, so the user still gets a confirmation/summary.
function buildToolFallbackResponse(toolResults) {
  const txn = toolResults.find(tr => tr.name === 'createTransaction');
  if (txn) {
    try {
      const content = JSON.parse(txn.content);
      if (content.error) return `## ⚠️ Transaction Not Created\n\n**${content.error}**`;
      if (content.message && content.message.includes('successfully created')) {
        let out = `## ✅ Transaction Created Successfully!\n\n**${content.message}**`;
        if (content.data?.id) out += `\n\n**Transaction ID:** ${content.data.id}`;
        if (content.data?.groupid) out += `\n\n**Recurring ID:** ${content.data.groupid}`;
        return out;
      }
      return `## Transaction Processed\n\n**${content.message || 'Transaction has been handled.'}**`;
    } catch {
      return '## ✅ Transaction Processed\n\n**I have successfully processed your transaction request.**';
    }
  }
  const parts = toolResults.map(tr => {
    try {
      const c = JSON.parse(tr.content);
      if (c && c.error) return `Error in ${tr.name}: ${c.error}`;
      if (Array.isArray(c)) return `Retrieved ${c.length} items from ${tr.name}`;
      if (c && Array.isArray(c.transactions)) return `Retrieved ${c.transactions.length} records from ${tr.name}`;
      if (c && Array.isArray(c.upcoming)) return `Retrieved ${c.upcoming.length} records from ${tr.name}`;
      return `Retrieved data from ${tr.name}`;
    } catch {
      return `Retrieved data from ${tr.name}`;
    }
  });
  return `## Action Completed\n\n**${parts.join('. ')}**`;
}

// ─── Kea Assistant: dialogue state (slot-filling) helpers ───────────────────
// Dialogue state tracks an in-progress "draft" transaction across turns so the
// assistant only needs minimal input to complete an action (and can ask for
// what's genuinely missing). It is background working-state, NOT the transcript
// — the client-sent history remains the source of truth for the conversation.

function buildDialogueKey(userId) {
  const u = normalizeAccountIdForCacheKey(userId);
  return `dialogue:${u}`;
}

function emptyDialogueState() {
  return {
    intent: null,
    draftTransaction: {},
    pendingConfirmation: false,
    committed: false,
    lastCommitSignature: null,
    // Rolling log of writes committed this session ({ action, transaction_id,
    // group_id, title, amount, category, start, frequency }). Persisted with
    // the dialogue state and surfaced to the model so "delete the expense you
    // just created" resolves to a real id without a lookup (tool results are
    // NOT kept in conversation history, so this is the only survivor).
    recentWrites: [],
    // Last on-screen focused entity (tx/day/feed/category). Survives popup
    // close so "delete it" / "how much is that?" can resolve after focus clears.
    // Only overwritten when the client sends a new focusedEntity — never cleared
    // just because the current turn's uiContext.focusedEntity is null.
    uiReferent: null,
    updatedAt: null,
  };
}

/**
 * Fail-soft: when the client sends a focusedEntity, mirror a tiny referent into
 * dialogue state. Do NOT clear an existing uiReferent when focusedEntity is null
 * (popup closed) — that is how closed-popup deixis ("delete it") works.
 */
function mirrorUiReferentFromUiContext(dialogueState, uiContext) {
  if (!dialogueState || typeof dialogueState !== 'object') return;
  const fe = uiContext && typeof uiContext === 'object' ? uiContext.focusedEntity : null;
  if (!fe || typeof fe !== 'object' || !fe.type) return;
  const amount = typeof fe.amount === 'number' && Number.isFinite(fe.amount) ? fe.amount : undefined;
  dialogueState.uiReferent = {
    type: String(fe.type).slice(0, 32),
    id: fe.id != null ? fe.id : undefined,
    label: fe.label != null ? String(fe.label).slice(0, 80) : undefined,
    amount,
    date: fe.date ? String(fe.date).slice(0, 10) : undefined,
    category: fe.category != null ? String(fe.category).slice(0, 40) : undefined,
    at: new Date().toISOString(),
  };
}

function formatUiReferentLine(ref) {
  if (!ref || typeof ref !== 'object' || !ref.type) return '';
  const label = ref.label ? ` "${String(ref.label).slice(0, 60)}"` : '';
  const amt = (typeof ref.amount === 'number' && Number.isFinite(ref.amount))
    ? ` ${ref.amount < 0 ? `-$${Math.abs(ref.amount)}` : `$${ref.amount}`}`
    : '';
  const date = ref.date ? ` on ${ref.date}` : '';
  const id = ref.id != null ? `:${ref.id}` : '';
  const cat = ref.category ? ` cat=${String(ref.category).slice(0, 40)}` : '';
  return `${ref.type}${id}${label}${amt}${date}${cat}`;
}

const MAX_RECENT_WRITES = 5;

function recordRecentWrite(state, entry) {
  if (!state || !entry) return;
  if (!Array.isArray(state.recentWrites)) state.recentWrites = [];
  state.recentWrites.push({ ...entry, at: new Date().toISOString() });
  if (state.recentWrites.length > MAX_RECENT_WRITES) {
    state.recentWrites = state.recentWrites.slice(-MAX_RECENT_WRITES);
  }
}

// Compact system-prompt block listing this session's committed writes so the
// model can target them for update/delete by real id.
function buildRecentWritesBlock(state) {
  const writes = Array.isArray(state?.recentWrites) ? state.recentWrites : [];
  if (writes.length === 0) return '';
  const lines = ['RECENT WRITES THIS SESSION (background — transactions/goals you already created, updated, or deleted for this user; use these ids directly when the user refers to them):'];
  for (const w of writes) {
    const parts = [`${w.action || 'write'}`];
    if (w.title) parts.push(`"${String(w.title).slice(0, 40)}"`);
    if (w.amount != null && Number.isFinite(Number(w.amount))) parts.push(`$${Math.abs(Number(w.amount))}`);
    if (w.frequency != null) parts.push(frequencyLabel(w.frequency));
    if (w.start) parts.push(`start ${String(w.start).slice(0, 10)}`);
    if (w.category) parts.push(String(w.category));
    if (w.transaction_id != null) parts.push(`transactionid=${w.transaction_id}`);
    if (w.group_id != null) parts.push(`groupid=${w.group_id}`);
    if (w.goal_id != null) parts.push(`goalid=${w.goal_id}`);
    lines.push(`- ${parts.join(', ')}`);
  }
  return truncateText(lines.join('\n'), 900);
}

// Fail-soft load: any Redis hiccup yields a fresh empty state so chat never breaks.
async function loadDialogueState(userId) {
  if (!userId) return emptyDialogueState();
  try {
    const raw = await redis.get(buildDialogueKey(userId));
    if (!raw) return emptyDialogueState();
    const parsed = JSON.parse(raw);
    return { ...emptyDialogueState(), ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch (e) {
    console.warn('Dialogue state load failed:', e.message);
    return emptyDialogueState();
  }
}

// Fail-soft persist. Never throws into the chat flow.
async function saveDialogueState(userId, state) {
  if (!userId || !state) return;
  try {
    const toSave = { ...state, updatedAt: new Date().toISOString() };
    await redis.set(buildDialogueKey(userId), JSON.stringify(toSave), 'EX', DIALOGUE_TTL);
  } catch (e) {
    console.warn('Dialogue state save failed:', e.message);
  }
}

// Slots we consider "core" for a proposable transaction. `title`/`amount`/
// `type` are the minimum needed to confirm; the rest are estimated downstream.
const DRAFT_CORE_SLOTS = ['title', 'type', 'amount', 'start'];

function computeDraftMissingFields(draft) {
  const missing = [];
  if (!draft || typeof draft !== 'object') return DRAFT_CORE_SLOTS.slice();
  for (const slot of DRAFT_CORE_SLOTS) {
    const v = draft[slot];
    if (v === undefined || v === null || String(v).trim() === '') missing.push(slot);
  }
  return missing;
}

// True when the draft has all core slots filled (i.e. it represents a complete,
// proposable transaction). Used to arm the write gate off draft state rather
// than relying solely on the model remembering to set pendingConfirmation.
function isDraftProposable(draft) {
  if (!draft || typeof draft !== 'object') return false;
  const hasSlots = Object.keys(draft).some(
    (k) => draft[k] !== undefined && draft[k] !== null && String(draft[k]).trim() !== ''
  );
  return hasSlots && computeDraftMissingFields(draft).length === 0;
}

// Stable signature for a draft/create payload so a multi-round loop (or a retry)
// can't create the same transaction twice within one turn.
function draftSignature(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const amt = Number(obj.amount);
  const parts = [
    String(obj.title || obj.merchant_name || '').trim().toLowerCase(),
    String(obj.type || '').trim().toLowerCase(),
    Number.isFinite(amt) ? Math.abs(Math.round(amt * 100) / 100) : '',
    obj.start ? moment(obj.start).isValid() ? moment(obj.start).format('YYYY-MM-DD') : String(obj.start) : '',
    obj.transactionid || obj.transaction_id || '',
  ];
  return parts.join('|');
}

// Extract the user's available category NAMES from the selected-account blob.
// Accepts category objects ({name|category|title}) or plain strings.
function extractCategoryNames(account) {
  if (!account || typeof account !== 'object') return [];
  const raw = Array.isArray(account.categories) ? account.categories : [];
  const names = [];
  for (const c of raw) {
    if (typeof c === 'string') { if (c.trim()) names.push(c.trim()); }
    else if (c && typeof c === 'object') {
      const n = c.name || c.category || c.title;
      if (n && String(n).trim()) names.push(String(n).trim());
    }
  }
  return Array.from(new Set(names));
}

// Snap a model-chosen category to the user's real category list so we never
// persist an invented category. Case-insensitive exact match first, then a
// loose contains-match either direction. Returns null when nothing matches
// (caller keeps the original value / backend default).
function snapCategory(input, names) {
  const q = String(input || '').trim().toLowerCase();
  if (!q || !Array.isArray(names) || names.length === 0) return null;
  for (const n of names) if (String(n).trim().toLowerCase() === q) return n;
  for (const n of names) {
    const ln = String(n).trim().toLowerCase();
    if (ln && (ln.includes(q) || q.includes(ln))) return n;
  }
  return null;
}

// Make the confirmed draft authoritative for a write: any filled draft slot
// overrides the model's arg (prevents drift of a value the user already
// confirmed), then snap the category to the user's real list.
function applyDraftAndCategory(args, draft, categoryNames) {
  const merged = { ...(args && typeof args === 'object' ? args : {}) };
  if (draft && typeof draft === 'object') {
    for (const [k, v] of Object.entries(draft)) {
      if (v !== undefined && v !== null && String(v).trim() !== '') merged[k] = v;
    }
  }
  if (merged.category) {
    const snapped = snapCategory(merged.category, categoryNames);
    if (snapped) merged.category = snapped;
  }
  return merged;
}

function normalizeTitleTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

// Staleness guard for the write gate. The draft-over-args merge exists to stop
// value drift on a CONFIRMED draft — but if the model's own args describe a
// materially DIFFERENT transaction (different title AND different amount), the
// stored draft is a leftover from an earlier/abandoned topic, and merging it
// would silently create the wrong transaction (observed: a stale "carpet
// replacement $1600" draft overwrote a freshly requested $40 weekly gas
// forecast). Only judges when both sides supply both title and amount; a model
// that omits them is deferring to the draft, which is the normal case.
function draftConflictsWithArgs(args, draft) {
  if (!draft || typeof draft !== 'object') return false;
  const draftTitle = String(draft.title || '').trim();
  const argsTitle = String(args?.title || args?.merchant_name || '').trim();
  const draftAmount = Number(draft.amount);
  const argsAmount = Number(args?.amount);
  if (!draftTitle || !argsTitle || !Number.isFinite(draftAmount) || !Number.isFinite(argsAmount)) return false;

  const draftTokens = new Set(normalizeTitleTokens(draftTitle));
  const argTokens = normalizeTitleTokens(argsTitle);
  const dl = draftTitle.toLowerCase();
  const al = argsTitle.toLowerCase();
  const titlesRelated = argTokens.some((t) => draftTokens.has(t)) || dl.includes(al) || al.includes(dl);

  // 10% (min $1) tolerance so rounding/sign differences and modest model
  // re-estimates on the confirm turn don't count as conflicts. A conflict now
  // requires BOTH an unrelated title AND a materially different amount — i.e.
  // a genuine topic switch.
  const tolerance = Math.max(1, Math.abs(argsAmount) * 0.10);
  const amountsMatch = Math.abs(Math.abs(draftAmount) - Math.abs(argsAmount)) <= tolerance;

  return !titlesRelated && !amountsMatch;
}

// Heuristic: did the user's current turn confirm the pending proposal? Kept in
// sync with the CONFIRMATION HANDLING language in the system prompt.
// `draft` (optional) is the currently staged draft transaction: a message that
// restates the draft's own amount still counts as a confirmation, but a message
// introducing NEW specifics (a different dollar amount, a recurrence schedule)
// is a new instruction — treating it as a "yes" was how a stale draft got
// created instead of the transaction the user was actually describing.
function isAffirmativeMessage(message, draft) {
  if (!message || typeof message !== 'string') return false;
  const m = message.trim().toLowerCase();
  if (!m) return false;

  const patterns = [
    /^y(es|ep|eah|up|es please|es pls)?\b/, /\bconfirm(ed)?\b/, /\bgo ahead\b/, /\bdo it\b/,
    /\bsounds good\b/, /\block it in\b/, /\bproceed\b/, /\bok(ay)?\b/, /\bsure\b/, /\babsolutely\b/,
    /\b(please )?add (it|that|this)\b/, /\badd this (forecast|transaction)\b/, /\bcreate it\b/,
    /\blog it\b/, /\bput (it|that) in\b/, /\bthat'?s? (right|correct)\b/, /\blooks good\b/,
    // Natural confirmations users actually type (added after observing the
    // carpet-replacement flow miss "this definitely works for me").
    /\bworks for me\b/, /\b(this|that|it) works\b/, /\bdefinitely\b/, /\bperfect\b/,
    /\bgreat\b/, /\bgo for it\b/, /\byes please\b/, /\bplease do\b/, /\bmake it so\b/,
    /\bthat'?s? (good|fine|perfect)\b/, /\bapprove(d)?\b/, /\bsave it\b/, /\bschedule it\b/,
  ];
  if (!patterns.some((re) => re.test(m))) return false;

  // A DIFFERENT dollar amount alongside the "yes" means the user is adjusting
  // the proposal, not plainly agreeing. The regex fallback stays conservative
  // here — the model handles adjustments properly via updateDraftTransaction
  // followed by confirmTransaction (the primary confirmation signal).
  const amountMatches = m.match(/\$\s*\d[\d,]*(\.\d+)?|\b\d[\d,]*(\.\d+)?\s*(dollars|bucks)\b/g) || [];
  if (amountMatches.length > 0) {
    const draftAmount = Number(draft?.amount);
    const mentionsOnlyDraftAmount = Number.isFinite(draftAmount) && amountMatches.every((raw) => {
      const n = Number(raw.replace(/[^0-9.]/g, ''));
      return Number.isFinite(n) && Math.abs(n - Math.abs(draftAmount)) < 0.01;
    });
    if (!mentionsOnlyDraftAmount) return false;
  }
  return true;
}

// Redis-eviction fallback for the write gate: did the LAST assistant turn in
// the (client-provided) transcript propose a concrete transaction and ask for
// confirmation? When the dialogue-state draft was evicted or never staged,
// this lets a valid confirmation still arm the gate — the model's own args
// then supply the values (the empty draft merge is a no-op).
function lastAssistantTurnText(history) {
  if (!Array.isArray(history) || history.length === 0) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === 'assistant') return String(history[i].content || '');
    if (history[i]?.role === 'user') break; // only the immediately-preceding assistant turn counts
  }
  return null;
}

function transcriptShowsPendingProposal(history) {
  const lastAssistant = lastAssistantTurnText(history);
  if (!lastAssistant) return false;
  const t = lastAssistant.toLowerCase();
  const hasAmount = /(^|[^\w])\$\s*\d/.test(lastAssistant) || /\b\d[\d,]*(\.\d+)?\s*(dollars|bucks)\b/.test(t);
  const asksToConfirm =
    /\b(confirm|shall i|should i|would you like|want me to|do you want|sound good|look good|looks right|is (this|that) (right|correct|ok|okay)|ready to (add|create)|go ahead)\b/.test(t);
  return hasAmount && asksToConfirm;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// Backend frequency codes (see cashflow-backend-api TRANSACTION_API_CONCISE.md):
// 1=daily, 2=once, 7=weekly, 14=biweekly, 15/16=semi-monthly, 28-31=monthly,
// 60=bimonthly, 91=quarterly, 182=semi-annually, 365=annually.
// Order matters: compound cadences ("bi-weekly", "semi-annually", "every other
// month") must be tested before the plain word they contain.
const RECURRENCE_PATTERNS = [
  [/\b(bi-?weekly|every\s+(2|two|other)\s+weeks?)\b/i, 14],
  [/\b(semi-?monthly|twice\s+a\s+month)\b/i, 15],
  [/\b(bi-?monthly|every\s+(2|two|other)\s+months?)\b/i, 60],
  [/\b(semi-?annually|twice\s+a\s+year|every\s+(6|six)\s+months)\b/i, 182],
  [/\b(quarterly|every\s+(3|three)\s+months)\b/i, 91],
  [/\b(annually|yearly|every\s+year|each\s+year|per\s+year)\b/i, 365],
  [/\b(weekly|every\s+week|each\s+week|per\s+week)\b/i, 7],
  [/\b(monthly|every\s+month|each\s+month|per\s+month)\b/i, 30],
  [/\b(daily|every\s+day|each\s+day)\b/i, 1],
  [/\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/i, 7],
  [/\bon\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s\b/i, 7], // plural weekday = weekly
  [/\bone[-\s]?time\b/i, 2],
];

function frequencyLabel(freq) {
  const f = Number(freq);
  if (f === 1) return 'daily';
  if (f === 7) return 'weekly';
  if (f === 14) return 'bi-weekly';
  if (f === 15 || f === 16) return 'semi-monthly';
  if (f >= 28 && f <= 31) return 'monthly';
  if (f === 60) return 'bi-monthly';
  if (f === 91) return 'quarterly';
  if (f === 182 || f === 183) return 'semi-annually';
  if (f === 365 || f === 366) return 'annually';
  return 'one-time';
}

// Next occurrence of `weekdayIdx` (0=Sunday) ON OR AFTER `fromMoment`.
function nextWeekdayOnOrAfter(fromMoment, weekdayIdx) {
  const m = fromMoment.clone();
  const diff = (weekdayIdx - m.day() + 7) % 7;
  return m.add(diff, 'days');
}

// Resolve the concrete date a proposal message refers to, relative to the
// user's localized `today`. Handles the formats the assistant actually writes:
// ISO (2026-07-22), month-name ("July 22nd, 2026" / "July 22"), "today",
// "tomorrow", and weekday references ("next Wednesday", "this Friday",
// "on Wednesdays"). Returns 'YYYY-MM-DD' or null.
function extractDateFromText(text, today) {
  const t = String(text || '');

  const iso = t.match(/\b20\d{2}-\d{2}-\d{2}\b/);
  if (iso && moment(iso[0], 'YYYY-MM-DD', true).isValid()) return iso[0];

  const monthRe = new RegExp(`\\b(${MONTH_NAMES.join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, 'i');
  const md = t.match(monthRe);
  if (md) {
    const monthIdx = MONTH_NAMES.indexOf(md[1].toLowerCase());
    const day = Number(md[2]);
    let candidate = moment({ year: md[3] ? Number(md[3]) : today.year(), month: monthIdx, date: day });
    if (candidate.isValid()) {
      // No explicit year and the date already passed => the user means next year.
      if (!md[3] && candidate.isBefore(today, 'day')) candidate = candidate.add(1, 'year');
      return candidate.format('YYYY-MM-DD');
    }
  }

  if (/\btomorrow\b/i.test(t)) return today.clone().add(1, 'day').format('YYYY-MM-DD');
  if (/\b(today|tonight|this evening)\b/i.test(t)) return today.format('YYYY-MM-DD');

  const wd = t.match(new RegExp(`\\b(?:next|this|on|starting)\\s+(${WEEKDAY_NAMES.join('|')})s?\\b`, 'i'));
  if (wd) {
    const idx = WEEKDAY_NAMES.indexOf(wd[1].toLowerCase());
    let candidate = nextWeekdayOnOrAfter(today, idx);
    // "next Wednesday" when today IS Wednesday means a week out.
    if (/^next$/i.test(wd[0].split(/\s+/)[0]) && candidate.isSame(today, 'day')) {
      candidate = candidate.add(7, 'days');
    }
    return candidate.format('YYYY-MM-DD');
  }

  return null;
}

// Conservative title extraction from a proposal sentence: an explicit
// `titled "X"`, else a capitalized merchant/item after "at"/"from"/"for"
// ("at Racetrac", "from Netflix", "for Food and Beverage"). Weekday/month
// words and generic type words are rejected so "for Wednesdays" or "for July
// 22nd" never becomes a title.
function extractTitleFromText(text) {
  const t = String(text || '');
  const banned = new Set([...WEEKDAY_NAMES, ...MONTH_NAMES, 'expense', 'income', 'transaction', 'forecast']);
  const clean = (s) => {
    const out = String(s || '').trim().replace(/["'.,;:]+$/g, '').trim();
    if (!out || out.length < 2 || out.length > 40) return null;
    const words = out.toLowerCase().split(/\s+/);
    if (words.every((w) => banned.has(w.replace(/s$/, '')))) return null;
    return out;
  };

  const quoted = t.match(/\btitled\s+["']([^"']{2,40})["']/i) || t.match(/["']([^"']{2,40})["']\s+(?:expense|income|transaction)/i);
  if (quoted) { const v = clean(quoted[1]); if (v) return v; }

  // Capitalized run (1-4 words, allowing "and"/"of"/"the" connectors) after a
  // merchant-ish preposition.
  const cap = "[A-Z][\\w&'’.-]*";
  const run = `${cap}(?:\\s+(?:and|of|the|${cap}))*`;
  const prep = t.match(new RegExp(`\\b(?:at|from|for)\\s+(${run})`));
  if (prep) { const v = clean(prep[1]); if (v && v.split(/\s+/).length <= 5) return v; }

  return null;
}

// Best-effort extraction of the concrete values the assistant proposed in its
// LAST message. This closes the "proposed $16 Racetrac, created $50 Expense"
// failure: when the model proposed in prose without staging a draft, the
// confirmation-turn write otherwise ships whatever the model re-estimates, and
// the normalizer's defaults fill the rest. The transcript proposal is what the
// user actually saw and confirmed, so it is authoritative over the model's
// re-estimated args (but never over an explicitly staged draft).
// `currentDate` (the user's localized YYYY-MM-DD) anchors relative dates
// ("tomorrow", "next Wednesday"). Returns null when there's nothing extractable.
function extractProposalFromMessage(text, categoryNames, currentDate) {
  const t = String(text || '');
  if (!t.trim()) return null;
  const out = { amounts: [] };
  const today = currentDate && moment(currentDate, 'YYYY-MM-DD', true).isValid()
    ? moment(currentDate, 'YYYY-MM-DD')
    : moment();

  // Distinct dollar amounts mentioned in the proposal ($16, $1,250.50, ...).
  const amountMatches = t.match(/\$\s*\d[\d,]*(\.\d+)?/g) || [];
  out.amounts = Array.from(new Set(
    amountMatches.map((m) => Number(m.replace(/[^0-9.]/g, ''))).filter((n) => Number.isFinite(n) && n > 0)
  ));
  // Only when exactly ONE amount was mentioned is it unambiguous enough to
  // adopt directly (a message mixing balances and the proposal has several).
  if (out.amounts.length === 1) out.amount = out.amounts[0];

  // Recurrence: proposal wording like "weekly", "every month", "on Wednesdays".
  for (const [re, code] of RECURRENCE_PATTERNS) {
    if (re.test(t)) { out.frequency = code; break; }
  }

  // Date: ISO, month-name ("July 22nd, 2026"), or relative ("tomorrow",
  // "next Wednesday") resolved against the user's localized today.
  const date = extractDateFromText(t, today);
  if (date) out.start = date;

  // Weekday snap for recurring proposals: "weekly on Wednesdays" must start
  // on a Wednesday. If the resolved/omitted start doesn't land on the named
  // weekday, move it forward to the next occurrence.
  const wdMention = t.match(new RegExp(`\\b(${WEEKDAY_NAMES.join('|')})s?\\b`, 'i'));
  if (out.frequency === 7 && wdMention) {
    const idx = WEEKDAY_NAMES.indexOf(wdMention[1].toLowerCase());
    const base = out.start ? moment(out.start, 'YYYY-MM-DD') : today.clone();
    out.start = nextWeekdayOnOrAfter(base, idx).format('YYYY-MM-DD');
  }

  // Title: explicit `titled "X"` or a capitalized merchant/item after
  // at/from/for ("at Racetrac"). Conservative — null when unsure.
  const title = extractTitleFromText(t);
  if (title) out.title = title;

  // Category: adopt only when exactly one of the user's REAL categories is
  // mentioned, so we never guess between two. Lookarounds instead of \b so
  // names ending in non-word chars ("Fees (misc)") still match; generic
  // type-words ("Expense" as a category name) lose to a specific match since
  // "expense" appears in nearly every proposal sentence.
  if (Array.isArray(categoryNames) && categoryNames.length > 0) {
    const mentions = (n) => new RegExp(`(?<!\\w)${escapeRegExp(String(n).trim())}(?!\\w)`, 'i').test(t);
    let found = categoryNames.filter((n) => n && String(n).trim() && mentions(n));
    if (found.length > 1) {
      const specific = found.filter((n) => !/^(expense|income|transaction)s?$/i.test(String(n).trim()));
      if (specific.length > 0) found = specific;
    }
    if (found.length === 1) out.category = found[0];
  }

  // Type: unambiguous expense/income wording only.
  const saysExpense = /\bexpense\b/i.test(t);
  const saysIncome = /\b(income|deposit|paycheck)\b/i.test(t);
  if (saysExpense && !saysIncome) out.type = 'Expense';
  else if (saysIncome && !saysExpense) out.type = 'Income';

  const hasSignal = out.amounts.length > 0 || out.start || out.category || out.type
    || out.frequency !== undefined || out.title;
  return hasSignal ? out : null;
}

// Precomputed calendar facts for the system prompt. LLMs are unreliable at
// date arithmetic ("next Wednesday" from a bare today-string), which produced
// wrong-date transactions — so every date the model might need is spelled out.
function buildDateReferenceBlock(currentDate) {
  const today = currentDate && moment(currentDate, 'YYYY-MM-DD', true).isValid()
    ? moment(currentDate, 'YYYY-MM-DD')
    : moment();
  const lines = [
    'DATE REFERENCE (precomputed in the user\'s timezone — use these EXACT dates, never do calendar math yourself):',
    `- today: ${today.format('dddd')} ${today.format('YYYY-MM-DD')}`,
    `- tomorrow: ${today.clone().add(1, 'day').format('dddd')} ${today.clone().add(1, 'day').format('YYYY-MM-DD')}`,
  ];
  for (let idx = 0; idx < 7; idx++) {
    const d = nextWeekdayOnOrAfter(today.clone().add(1, 'day'), idx);
    lines.push(`- next ${WEEKDAY_NAMES[idx][0].toUpperCase()}${WEEKDAY_NAMES[idx].slice(1)}: ${d.format('YYYY-MM-DD')}`);
  }
  lines.push('When proposing a transaction, ALWAYS state its date in YYYY-MM-DD form (e.g. "on 2026-07-22"), and state the recurrence explicitly ("weekly", "monthly", or "one-time").');
  return lines.join('\n');
}

// Compact ON-SCREEN CONTEXT block from the client's uiContext snapshot.
// Hard-capped so a buggy publisher cannot bloat the system prompt.
const UI_CONTEXT_BLOCK_MAX_CHARS = 2200;

function buildUiContextBlock(uiContext) {
  if (!uiContext || typeof uiContext !== 'object') return '';

  const parts = [];
  if (uiContext.route) parts.push(`route=${String(uiContext.route)}`);
  if (uiContext.view) parts.push(`view=${String(uiContext.view)}`);
  if (uiContext.selectedAccountId != null && uiContext.selectedAccountId !== '') {
    parts.push(`selectedAccountId=${uiContext.selectedAccountId}`);
  }
  if (uiContext.focusedDate) parts.push(`focusedDate=${String(uiContext.focusedDate)}`);

  if (uiContext.visibleDateRange && typeof uiContext.visibleDateRange === 'object') {
    const { start, end } = uiContext.visibleDateRange;
    if (start || end) parts.push(`visibleRange=${start || '?'}:${end || '?'}`);
  }

  const fe = uiContext.focusedEntity;
  if (fe && typeof fe === 'object' && fe.type) {
    const label = fe.label ? ` "${String(fe.label).slice(0, 60)}"` : '';
    const amt = (typeof fe.amount === 'number' && Number.isFinite(fe.amount))
      ? ` ${fe.amount < 0 ? `-$${Math.abs(fe.amount)}` : `$${fe.amount}`}`
      : '';
    const date = fe.date ? ` on ${fe.date}` : '';
    const id = fe.id != null ? `:${fe.id}` : '';
    const cat = fe.category ? ` cat=${String(fe.category).slice(0, 40)}` : '';
    parts.push(`focusedEntity=${fe.type}${id}${label}${amt}${date}${cat}`);
  }

  if (Array.isArray(uiContext.openDialogs) && uiContext.openDialogs.length) {
    parts.push(`openDialogs=${uiContext.openDialogs.slice(0, 6).map(String).join(',')}`);
  }

  if (uiContext.filters && typeof uiContext.filters === 'object') {
    const f = [];
    if (uiContext.filters.searchTerm) f.push(`search=${String(uiContext.filters.searchTerm).slice(0, 60)}`);
    if (uiContext.filters.category) f.push(`category=${String(uiContext.filters.category).slice(0, 40)}`);
    if (uiContext.filters.forecastType) f.push(`forecastType=${uiContext.filters.forecastType}`);
    if (f.length) parts.push(`filters=${f.join(';')}`);
  }

  const vs = uiContext.visibleSummary;
  if (vs && typeof vs === 'object') {
    if (typeof vs.dayBalance === 'number' && Number.isFinite(vs.dayBalance)) {
      parts.push(`dayBalance=${vs.dayBalance}`);
    }
    if (typeof vs.dayTxCount === 'number' && Number.isFinite(vs.dayTxCount)) {
      parts.push(`dayTxCount=${vs.dayTxCount}`);
    }
    if (Array.isArray(vs.topVisibleTx) && vs.topVisibleTx.length) {
      parts.push(`topVisibleTx=${vs.topVisibleTx.slice(0, 5).map((t) => String(t).slice(0, 48)).join(' | ')}`);
    }
    if (vs.chart) parts.push(`chart=${String(vs.chart).slice(0, 80)}`);
    if (vs.note) parts.push(`note=${String(vs.note).slice(0, 120)}`);
  }

  if (uiContext.interactionMode) parts.push(`interactionMode=${uiContext.interactionMode}`);
  if (uiContext.companionActive === true) parts.push('companionActive=true');
  if (uiContext.companionActive === false) parts.push('companionActive=false');

  if (parts.length === 0) return '';

  const voiceHint =
    uiContext.interactionMode === 'voice' || uiContext.companionActive === true
      ? 'VOICE/COMPANION MODE: Keep the entire reply ≤ ~600 characters. No markdown tables. Lead with the answer, then at most 2 short supporting bullets. Full chat (text mode) may be richer.'
      : '';

  const body = [
    'ON-SCREEN CONTEXT (trusted client snapshot of what the user can see NOW.',
    'Use this to resolve deixis: "this", "that", "here", "today on my calendar",',
    '"this charge", "what I\'m looking at". Do NOT invent UI state beyond this block.',
    'Deixis order: (1) focusedEntity in this block, (2) focusedDate,',
    '(3) last uiReferent in DIALOGUE STATE, (4) ask one short clarifying question.',
    'Never invent an unrelated paycheck/merchant when deixis is ambiguous.',
    'If a needed detail is missing, ask one short clarifying question or call a read tool.',
    'Prefer focusedEntity / focusedDate over generic account context when answering.)',
    parts.join('; '),
    voiceHint,
  ].filter(Boolean).join('\n');

  return truncateText(body, UI_CONTEXT_BLOCK_MAX_CHARS);
}

// Compact, hard-capped block describing the in-progress action for the system
// prompt. Returns '' when there's nothing worth injecting.
function buildDialogueStateBlock(state) {
  if (!state || typeof state !== 'object') return '';
  const draft = state.draftTransaction || {};
  const hasDraft = draft && Object.keys(draft).some(
    (k) => draft[k] !== undefined && draft[k] !== null && String(draft[k]).trim() !== ''
  );
  const uiRefLine = formatUiReferentLine(state.uiReferent);
  if (!state.intent && !hasDraft && !uiRefLine) return '';

  const lines = ['DIALOGUE STATE (background — an in-progress action / last UI referent, NOT a message from the user):'];
  if (state.intent) lines.push(`- intent: ${state.intent}`);
  if (hasDraft) {
    const slotStr = ['title', 'type', 'amount', 'category', 'start', 'frequency']
      .filter((k) => draft[k] !== undefined && draft[k] !== null && String(draft[k]).trim() !== '')
      .map((k) => `${k}=${draft[k]}`)
      .join(', ');
    lines.push(`- draft transaction: ${slotStr || '(no slots yet)'}`);
    const missing = computeDraftMissingFields(draft);
    if (missing.length) lines.push(`- missing/uncertain: ${missing.join(', ')}`);
  }
  if (uiRefLine) {
    lines.push(`- last uiReferent (use for "that"/"it"/"this" when ON-SCREEN focusedEntity is empty): ${uiRefLine}`);
  }
  lines.push(`- awaiting user confirmation: ${state.pendingConfirmation ? 'yes' : 'no'}`);
  lines.push(
    'Guidance: refine slots with updateDraftTransaction as details emerge. Propose a SINGLE concrete amount and ask the user to confirm. Only after the user confirms on a later turn should you call createTransaction with the draft values. Ask only for genuinely missing info. For deixis, prefer current ON-SCREEN focusedEntity over last uiReferent.'
  );
  return truncateText(lines.join('\n'), DIALOGUE_STATE_MAX_CHARS);
}

// ─── Kea Assistant: rolling short-term summary helpers ──────────────────────

function buildSummaryKey(userId) {
  return `summary:${normalizeAccountIdForCacheKey(userId)}`;
}

function buildSummaryBlock(summary) {
  const s = (summary || '').trim();
  if (!s) return '';
  return truncateText(`CONVERSATION SUMMARY SO FAR (background — earlier turns condensed):\n${s}`, SUMMARY_MAX_CHARS);
}

// Merge the prior summary with the turns that fell out of the verbatim window
// into an updated compact summary. Fail-soft: returns the prior summary on error.
async function generateRollingSummary(prevSummary, overflowTurns) {
  if (!Array.isArray(overflowTurns) || overflowTurns.length === 0) return prevSummary || '';
  try {
    const convoText = overflowTurns
      .map((m) => `${m.role}: ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 500)}`)
      .join('\n');
    const sys = 'You maintain a compact running memory of a personal-finance chat between a user and the Kea Assistant. Merge the PRIOR SUMMARY with the NEW TURNS into a single updated summary under 900 characters. Preserve durable, actionable facts: goals, planned purchases and their estimated amounts/dates, decisions, stated preferences, and any transaction that was proposed or created. Drop pleasantries and small talk. Write terse notes, not prose.';
    const usr = `PRIOR SUMMARY:\n${prevSummary || '(none)'}\n\nNEW TURNS:\n${convoText}\n\nUpdated summary:`;
    const resp = await queryAzureOpenAI(
      [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      { tool_choice: 'none', temperature: 0.2, max_tokens: 320 }
    );
    const out = resp?.choices?.[0]?.message?.content || '';
    return truncateText(out.trim(), SUMMARY_MAX_CHARS) || (prevSummary || '');
  } catch (e) {
    console.warn('Rolling summary generation failed (fail-soft):', e.message);
    return prevSummary || '';
  }
}

// ─── Kea Assistant: long-term memory (durable facts) helpers ────────────────
// Facts live in cashflow-backend-api (assistant_memory table). All calls are
// fail-soft so chat keeps working if the backend endpoint is unavailable.

async function recallLongTermFacts({ userId, accountId, token }) {
  if (!userId || !token) return [];
  try {
    const res = await functionMap.recallFacts(
      { userId, accountId, limit: FACTS_PRELOAD_LIMIT },
      { userId, token, accountId }
    );
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.facts)) return res.facts;
    if (Array.isArray(res?.data)) return res.data;
    return [];
  } catch (e) {
    console.warn('Long-term facts recall failed (fail-soft):', e.message);
    return [];
  }
}

function buildFactsBlock(facts) {
  if (!Array.isArray(facts) || facts.length === 0) return '';
  const lines = ['LONG-TERM MEMORY (durable facts you previously saved about this user; background context):'];
  for (const f of facts) {
    const key = String(f?.mem_key || f?.key || '').trim();
    const val = String(f?.mem_value || f?.value || '').trim();
    if (!val) continue;
    lines.push(`- ${key ? key + ': ' : ''}${val}`);
  }
  if (lines.length === 1) return '';
  return truncateText(lines.join('\n'), FACTS_MAX_CHARS);
}

// Redact sensitive fields (token, raw message/PII) before logging a chat body.
function redactChatBodyForLog(body) {
  if (!body || typeof body !== 'object') return {};
  const ui = body.uiContext && typeof body.uiContext === 'object' ? body.uiContext : null;
  return {
    hasToken: !!body.token,
    sessionId: body.sessionId,
    accountid: body.accountid,
    messageLength: typeof body.message === 'string' ? body.message.length : 0,
    historyLength: Array.isArray(body.history) ? body.history.length : 0,
    hasAccountSnapshot: !!body.accountSnapshot,
    hasFaq: !!body.faq,
    hasLocation: !!body.location,
    mode: body.mode,
    hasSimContext: !!body.simContext,
    hasSimSnapshot: !!body.simSnapshot,
    // uiContext: keep only coarse navigation fields — never log focused labels/amounts.
    uiContext: ui
      ? {
          route: ui.route,
          view: ui.view,
          focusedDate: ui.focusedDate,
          interactionMode: ui.interactionMode,
          companionActive: ui.companionActive,
          hasFocusedEntity: !!(ui.focusedEntity && ui.focusedEntity.type),
        }
      : null,
  };
}

async function executeToolCalls(originalMessages, toolCalls, ctx) {
  // Multi-round loop: the model may read data, refine the draft, then act within
  // a single user turn. Bounded by MAX_TOOL_ROUNDS to keep latency/tokens sane.
  const state = ctx.dialogueState || (ctx.dialogueState = emptyDialogueState());
  let draftUpdates = 0;
  // Structured simulation operations proposed this turn (via the
  // proposeSimulation* tools). Returned to the client alongside the prose so
  // the frontend can apply them to its simulation overlay.
  const proposedSimOps = [];
  // Committed real writes this turn ({ action, transaction_id, group_id, start }).
  // Surfaced to the client as transactionResult so the UI reloads account data
  // off a structured signal instead of sniffing the prose.
  const committedWrites = [];
  // Writes the gate refused this turn ({ tool, reason }) — lets the client know
  // a proposal/confirmation is pending rather than guessing from prose.
  const blockedWrites = [];
  // Client-side UI actions requested this turn (e.g. open the transaction
  // search panel). Returned alongside the prose for the frontend to execute.
  const uiActions = [];

  // Execute one batch of tool calls, applying dialogue-state handling + the
  // code-enforced write gate. Returns matching assistant/tool protocol messages.
  const runBatch = async (batch) => {
    const toolResults = [];
    for (const toolCall of batch) {
      const { name, arguments: argsJson } = toolCall.function || {};
      let args = {};
      try { args = argsJson ? JSON.parse(argsJson) : {}; } catch { args = {}; }

      // ── Non-writing draft tool: merge slots into dialogue state ──────────
      if (name === DRAFT_TOOL) {
        draftUpdates++;
        if (draftUpdates > MAX_DRAFT_UPDATES_PER_TURN) {
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({ error: 'Draft already refined several times this turn; proceed to propose/confirm or ask the user.' }) });
          continue;
        }
        const incoming = { ...args };
        const intent = incoming.intent; delete incoming.intent;
        const proposed = incoming.pendingConfirmation === true; delete incoming.pendingConfirmation;
        delete incoming.userId; delete incoming.accountId; // identity comes from ctx
        // Snap a proposed category to the user's real category list so the
        // stored draft (and the confirmation the user sees) uses a valid one.
        if (incoming.category) {
          const snapped = snapCategory(incoming.category, ctx.categoryNames);
          if (snapped) incoming.category = snapped;
        }
        for (const [k, v] of Object.entries(incoming)) {
          if (v !== undefined && v !== null && String(v).trim() !== '') state.draftTransaction[k] = v;
        }
        if (intent && String(intent).trim()) state.intent = String(intent).trim();
        if (proposed) state.pendingConfirmation = true;
        const missing = computeDraftMissingFields(state.draftTransaction);
        toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
          ok: true,
          draft: state.draftTransaction,
          intent: state.intent,
          missingFields: missing,
          pendingConfirmation: state.pendingConfirmation,
          note: missing.length
            ? 'Draft saved. Estimate the missing/uncertain fields and propose a single concrete value, or ask the user only for what you truly cannot infer.'
            : 'Draft is complete. Propose the concrete transaction and ask the user to confirm before creating.'
        }) });
        continue;
      }

      // ── Non-writing confirmation signal: the model judged the user's latest
      // message to confirm the pending proposal. This is the PRIMARY way the
      // write gate is armed — far more robust than the regex fallback, which
      // can't cover every natural phrasing ("yeah let's do that", emoji, etc.).
      if (name === CONFIRM_TOOL) {
        const proposalExists =
          ctx.pendingConfirmationAtStart === true ||
          ctx.draftCompleteAtStart === true ||
          ctx.proposalInTranscript === true;
        // The confirmation must resolve to concrete values from SOMEWHERE the
        // user actually saw: the staged draft, or values extractable from the
        // proposal message itself. Without either, a follow-up write would run
        // on re-estimated args + normalizer defaults — stage the draft first.
        const draftObj = state.draftTransaction || {};
        const draftHasSlots = ['title', 'type', 'amount', 'category', 'start'].some(
          (k) => draftObj[k] !== undefined && draftObj[k] !== null && String(draftObj[k]).trim() !== ''
        );
        const transcriptHasValues = !!(ctx.transcriptProposal && (ctx.transcriptProposal.amount !== undefined || ctx.transcriptProposal.amounts?.length));
        if (proposalExists && (draftHasSlots || transcriptHasValues)) {
          ctx.userAffirmative = true;
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
            ok: true,
            confirmed: true,
            message: 'Confirmation registered. Now call createTransaction (or updateTransaction) with the EXACT values you proposed to the user — same amount, same date, same category, same title. Do NOT re-estimate anything, and do not re-ask the user.'
          }) });
        } else if (proposalExists) {
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
            ok: false,
            confirmed: false,
            message: 'The proposed values were never staged and could not be recovered from the conversation. Call updateDraftTransaction NOW with the exact values you proposed (title, type, amount, category, start), then call confirmTransaction again in the same turn.'
          }) });
        } else {
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
            ok: false,
            confirmed: false,
            message: 'No pending proposal found to confirm. Propose the full transaction first (updateDraftTransaction with a SINGLE concrete amount, then ask the user to confirm on their next message).'
          }) });
        }
        continue;
      }

      // ── Non-writing UI actions: open/navigate client panels ──
      if (name === UI_SEARCH_TOOL) {
        const term = typeof args.search_term === 'string' ? args.search_term.trim() : '';
        uiActions.push({ type: 'open_search', search_term: term || null });
        toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
          ok: true,
          opened: 'transaction_search',
          search_term: term || null,
          note: `The transaction search panel is opening on the user's screen${term ? ` pre-filled with "${term}"` : ''}. Briefly tell the user it is opening — do NOT invent result counts or amounts.`
        }) });
        continue;
      }

      if (name === UI_CALENDAR_DAY_TOOL) {
        const date = typeof args.date === 'string' ? args.date.trim() : '';
        if (!UI_DATE_RE.test(date)) {
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
            ok: false,
            error: 'date_required',
            message: 'openCalendarDay requires date as YYYY-MM-DD.',
          }) });
          continue;
        }
        uiActions.push({ type: 'open_calendar_day', date });
        toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
          ok: true,
          opened: 'calendar_day',
          date,
          note: `The calendar day ${date} is opening on the user's screen. Briefly tell them it is opening — do NOT invent balances or transactions.`
        }) });
        continue;
      }

      if (name === UI_HIGHLIGHT_TX_TOOL) {
        const transactionId = args.transactionId != null ? args.transactionId
          : (args.transactionid != null ? args.transactionid : null);
        const dateRaw = typeof args.date === 'string' ? args.date.trim() : '';
        const date = UI_DATE_RE.test(dateRaw) ? dateRaw : null;
        if (transactionId == null || String(transactionId).trim() === '') {
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
            ok: false,
            error: 'transactionId_required',
            message: 'highlightTransaction requires transactionId.',
          }) });
          continue;
        }
        uiActions.push({
          type: 'highlight_transaction',
          transactionId,
          date,
        });
        toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
          ok: true,
          opened: 'highlight_transaction',
          transactionId,
          date,
          note: `The app is opening the calendar to highlight transaction ${transactionId}${date ? ` on ${date}` : ''}. Briefly tell the user it is opening — do NOT invent amounts.`
        }) });
        continue;
      }

      if (name === UI_NAVIGATE_TOOL) {
        let route = typeof args.route === 'string' ? args.route.trim() : '';
        if (!route.startsWith('/')) route = `/${route}`;
        if (!ALLOWED_UI_NAV_ROUTES.has(route)) {
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
            ok: false,
            error: 'route_not_allowed',
            message: `navigateTo only allows: ${[...ALLOWED_UI_NAV_ROUTES].join(', ')}`,
          }) });
          continue;
        }
        uiActions.push({ type: 'navigate_to', route });
        toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
          ok: true,
          opened: 'navigate',
          route,
          note: `Navigating the user to ${route}. Briefly tell them you are taking them there — do NOT invent what is on that page.`
        }) });
        continue;
      }

      const toolFn = functionMap[name];
      if (!toolFn) {
        toolResults.push({ id: toolCall.id, name, content: JSON.stringify({ error: `Unknown tool: ${name}` }) });
        continue;
      }

      // ── Simulation Mode: refuse ALL real writes; redirect to propose tools ──
      if (ctx.simulationMode === true && SIM_BLOCKED_WRITE_TOOLS.has(name)) {
        toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
          blocked: true,
          reason: 'simulation_mode_active',
          message: 'The user is in Simulation Mode — do NOT write real data. Stage this change with the matching simulation tool instead: proposeSimulationAdd for a new transaction, proposeSimulationModify to change an existing forecast, or proposeSimulationRemove to drop one. No confirmation turn is needed for simulation proposals.'
        }) });
        continue;
      }

      // ── Code-enforced write gate (createTransaction / updateTransaction) ──
      if (WRITE_TOOLS.has(name)) {
        // Arm off an explicit pendingConfirmation flag, a complete draft staged
        // on a prior turn, OR a proposal visible in the client transcript (the
        // Redis-eviction fallback). Confirmation itself comes from the model's
        // confirmTransaction call (primary) or the regex fallback — both land
        // in ctx.userAffirmative.
        const proposedEarlier =
          ctx.pendingConfirmationAtStart === true ||
          ctx.draftCompleteAtStart === true ||
          ctx.proposalInTranscript === true;
        const confirmed = proposedEarlier && ctx.userAffirmative === true;
        if (!confirmed) {
          blockedWrites.push({ tool: name, reason: 'confirmation_required' });
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
            blocked: true,
            reason: 'confirmation_required',
            message: 'Do NOT write yet. First show the user the full proposed transaction (title, type, a SINGLE concrete amount, start date, category from their available categories, and frequency if recurring) and wait for them to explicitly confirm on their next message. Use updateDraftTransaction to stage the proposal.'
          }) });
          continue;
        }

        // Staleness guard: if the model's args describe a materially different
        // transaction than the stored draft, the draft belongs to an earlier
        // topic. Discard it and force a fresh propose→confirm cycle instead of
        // letting the merge below overwrite the user's actual request.
        if (draftConflictsWithArgs(args, state.draftTransaction)) {
          console.warn(`[write-audit] STALE DRAFT DISCARDED user=${ctx.userId} tool=${name} draft=${JSON.stringify(state.draftTransaction)} modelArgs=${JSON.stringify(args)}`);
          state.draftTransaction = {};
          state.intent = null;
          state.pendingConfirmation = false;
          blockedWrites.push({ tool: name, reason: 'stale_draft_mismatch' });
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
            blocked: true,
            reason: 'stale_draft_mismatch',
            message: 'A leftover draft from an earlier topic did not match this request, so it was discarded. Re-propose THIS transaction to the user (updateDraftTransaction with a SINGLE concrete amount) and wait for them to explicitly confirm on their next message before creating it.'
          }) });
          continue;
        }

        // The user confirmed the DRAFT, so the draft is authoritative: merge its
        // filled slots OVER the model's args so a re-estimate can't silently
        // drift a confirmed value (e.g. November -> August). Then snap the
        // category to the user's real category list.
        const effectiveArgs = applyDraftAndCategory(args, state.draftTransaction, ctx.categoryNames);

        // When the proposal only lives in the transcript (model proposed in
        // prose without staging a draft), the extracted proposal values are
        // authoritative for any slot the draft didn't fill — the user confirmed
        // THOSE values, not whatever the model re-estimates this turn.
        // `frequency` is included so "weekly on Wednesdays" can't collapse
        // into a one-time entry when the model omits it on the confirm turn.
        if (ctx.transcriptProposal) {
          const draft = state.draftTransaction || {};
          const draftHas = (k) => draft[k] !== undefined && draft[k] !== null && String(draft[k]).trim() !== '';
          for (const k of ['amount', 'start', 'category', 'type', 'frequency']) {
            const v = ctx.transcriptProposal[k];
            if (v !== undefined && v !== null && !draftHas(k)) effectiveArgs[k] = v;
          }
          // Title: adopt the extracted merchant/item when the model's own title
          // is missing or generic; else fall back to the category ("Gas") which
          // reads better than "Expense".
          const argTitleGeneric = !effectiveArgs.title || /^(expense|income|transaction|planned purchase)$/i.test(String(effectiveArgs.title).trim());
          if (!draftHas('title') && argTitleGeneric) {
            if (ctx.transcriptProposal.title) effectiveArgs.title = ctx.transcriptProposal.title;
            else if (ctx.transcriptProposal.category) effectiveArgs.title = ctx.transcriptProposal.category;
          }
        }

        // Cross-check: on a confirmation turn the final amount must be one the
        // user actually saw in the proposal. A mismatch means the model
        // re-estimated (the "$16 proposed, $50 created" bug) — block and force
        // a fresh propose→confirm cycle instead of writing the wrong number.
        const proposedAmounts = ctx.transcriptProposal?.amounts || [];
        const finalAmount = Number(effectiveArgs.amount);
        if (proposedAmounts.length > 0 && Number.isFinite(finalAmount) && finalAmount !== 0) {
          const matchesProposal = proposedAmounts.some(
            (p) => Math.abs(p - Math.abs(finalAmount)) <= Math.max(1, p * 0.05)
          );
          if (!matchesProposal) {
            console.warn(`[write-audit] AMOUNT MISMATCH BLOCKED user=${ctx.userId} tool=${name} finalAmount=${finalAmount} proposedAmounts=${JSON.stringify(proposedAmounts)}`);
            blockedWrites.push({ tool: name, reason: 'amount_mismatch_with_proposal' });
            toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
              blocked: true,
              reason: 'amount_mismatch_with_proposal',
              message: `The amount you passed (${finalAmount}) does not match any amount from your own proposal (${proposedAmounts.map((p) => '$' + p).join(', ')}). Never re-estimate on the confirmation turn. Call ${name} again using the EXACT amount, date, and category from your previous proposal message.`
            }) });
            continue;
          }
        }

        // Forensic audit trail for every real write: what the draft held, what
        // the model asked for, and what we actually sent to the backend.
        console.log(`[write-audit] tool=${name} user=${ctx.userId} account=${ctx.accountId} draft=${JSON.stringify(state.draftTransaction)} modelArgs=${JSON.stringify(args)} effectiveArgs=${JSON.stringify(effectiveArgs)}`);

        // Idempotency: refuse a duplicate write within the same turn/session.
        const sig = draftSignature(effectiveArgs);
        if (sig && state.lastCommitSignature && sig === state.lastCommitSignature) {
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
            duplicate: true,
            message: 'That transaction was just created; not creating it again.'
          }) });
          continue;
        }
        try {
          const result = await toolFn(effectiveArgs, ctx);
          // Ground the model's confirmation message in what was ACTUALLY
          // written: restating anything else (a stale draft, a re-estimate)
          // produced "$45 Planned Purchase" messages for a $25 write.
          const wroteTitle = result?.title ?? effectiveArgs.title ?? null;
          const wroteAmount = result?.amount ?? effectiveArgs.amount ?? null;
          const wroteStart = String(result?.start ?? effectiveArgs.start ?? '').slice(0, 10);
          const wroteFreq = result?.frequency ?? effectiveArgs.frequency ?? null;
          const wroteCategory = result?.category ?? effectiveArgs.category ?? null;
          const grounded = {
            ...(result ?? {}),
            note: `WRITE COMMITTED. Your reply MUST restate EXACTLY these values and no others: "${wroteTitle}", $${Math.abs(Number(wroteAmount)) || wroteAmount}, ${frequencyLabel(wroteFreq)}${wroteStart ? `, starting ${wroteStart}` : ''}${wroteCategory ? `, category ${wroteCategory}` : ''} (transaction_id ${result?.transaction_id ?? 'n/a'}${result?.group_id != null ? `, recurring_id ${result.group_id}` : ''}). Do NOT mention any other amount, title, or date as the created transaction.`
          };
          let toolContent = JSON.stringify(grounded);
          if (toolContent.length > 13000) toolContent = toolContent.substring(0, 13000) + '..."_truncated":true}';
          // Mark committed + clear the draft so a re-called round can't refire.
          state.lastCommitSignature = sig;
          state.committed = true;
          state.pendingConfirmation = false;
          state.draftTransaction = {};
          state.intent = null;
          // Structured write record for the client (functionMap normalizes the
          // backend response into { action, transaction_id, group_id, ... }).
          const writeRecord = {
            action: result?.action || (name === 'updateTransaction' ? 'update' : 'create'),
            transaction_id: result?.transaction_id ?? null,
            group_id: result?.group_id ?? null,
            title: wroteTitle,
            amount: wroteAmount,
            category: wroteCategory,
            frequency: wroteFreq,
            start: result?.start ?? effectiveArgs.start ?? null,
          };
          committedWrites.push(writeRecord);
          // Session memory so later turns can update/delete this by real id.
          recordRecentWrite(state, writeRecord);
          toolResults.push({ id: toolCall.id, name, content: toolContent });
        } catch (err) {
          blockedWrites.push({ tool: name, reason: 'execution_failed' });
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({ error: err?.message || 'Tool execution failed' }) });
        }
        continue;
      }

      // ── Goal write gate (createGoal / updateGoal / deleteGoal) ───────────
      // Same propose→confirm contract as transactions, but WITHOUT the
      // transaction-draft merge (goal fields are unrelated to the draft slots).
      if (GOAL_WRITE_TOOLS.has(name)) {
        if (ctx.goalsAvailable === false) {
          blockedWrites.push({ tool: name, reason: 'goals_not_available' });
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
            blocked: true,
            reason: 'goals_not_available',
            message: 'This user\'s plan does not include Goals (or their goal quota is reached). Do not offer to create/update/delete goals. Instead, lay out the savings plan in prose (per-period amount and timeline) and suggest they can track it manually or upgrade to use Goals.'
          }) });
          continue;
        }
        const proposedEarlier =
          ctx.pendingConfirmationAtStart === true ||
          ctx.draftCompleteAtStart === true ||
          ctx.proposalInTranscript === true;
        const confirmed = proposedEarlier && ctx.userAffirmative === true;
        if (!confirmed) {
          blockedWrites.push({ tool: name, reason: 'confirmation_required' });
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
            blocked: true,
            reason: 'confirmation_required',
            message: 'Do NOT write yet. First show the user the full proposed goal (title, target amount, deadline, cadence, and the per-contribution amount from previewGoalCadence) and wait for them to explicitly confirm on their next message.'
          }) });
          continue;
        }
        // Idempotency within the turn/session (mirrors the transaction guard).
        const goalSig = ['goal', name, String(args.goalid || ''), String(args.title || '').trim().toLowerCase(), String(args.target_amount || ''), String(args.end_date || '')].join('|');
        if (state.lastCommitSignature && goalSig === state.lastCommitSignature) {
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
            duplicate: true,
            message: 'That goal change was just made; not repeating it.'
          }) });
          continue;
        }
        console.log(`[write-audit] tool=${name} user=${ctx.userId} account=${ctx.accountId} goalArgs=${JSON.stringify(args)}`);
        try {
          const result = await toolFn(args, ctx);
          state.lastCommitSignature = goalSig;
          state.committed = true;
          state.pendingConfirmation = false;
          const goalRecord = {
            action: result?.action || 'goal_write',
            transaction_id: null,
            group_id: null,
            goal_id: result?.goal_id ?? args.goalid ?? null,
            title: result?.title ?? args.title ?? null,
            start: result?.start_date ?? null,
          };
          committedWrites.push(goalRecord);
          recordRecentWrite(state, goalRecord);
          let toolContent = JSON.stringify(result ?? {});
          if (toolContent.length > 13000) toolContent = toolContent.substring(0, 13000) + '..."_truncated":true}';
          toolResults.push({ id: toolCall.id, name, content: toolContent });
        } catch (err) {
          blockedWrites.push({ tool: name, reason: 'execution_failed' });
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({ error: err?.message || err?.response?.data?.message || 'Goal tool execution failed' }) });
        }
        continue;
      }

      // ── Delete gate (deleteTransaction) ──────────────────────────────────
      // Deletion is the most destructive write, so it uses the same
      // propose→confirm contract enforced in code: the model must first show
      // the user WHICH transaction it found (title, amount, date — and for
      // recurring ones, ask single occurrence vs whole series), then delete
      // only after the confirmation is registered.
      if (name === 'deleteTransaction') {
        const proposedEarlier =
          ctx.pendingConfirmationAtStart === true ||
          ctx.draftCompleteAtStart === true ||
          ctx.proposalInTranscript === true;
        const confirmed = proposedEarlier && ctx.userAffirmative === true;
        if (!confirmed) {
          blockedWrites.push({ tool: name, reason: 'confirmation_required' });
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
            blocked: true,
            reason: 'confirmation_required',
            message: 'Do NOT delete yet. First identify the exact transaction (check RECENT WRITES THIS SESSION, or look it up via getUpcomingTransactions/getRecurringForecasts), show the user its title, amount, and date — and if it is recurring, ask whether to delete just that occurrence or the entire series — then wait for them to explicitly confirm on their next message.'
          }) });
          continue;
        }
        const delSig = ['delete', String(args.scope || 'single'), String(args.transactionid || args.transaction_id || ''), String(args.groupid || args.group_id || '')].join('|');
        if (state.lastCommitSignature && delSig === state.lastCommitSignature) {
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
            duplicate: true,
            message: 'That transaction was just deleted; not deleting again.'
          }) });
          continue;
        }
        console.log(`[write-audit] tool=${name} user=${ctx.userId} account=${ctx.accountId} deleteArgs=${JSON.stringify(args)}`);
        try {
          const result = await toolFn(args, ctx);
          state.lastCommitSignature = delSig;
          state.committed = true;
          state.pendingConfirmation = false;
          const delRecord = {
            action: 'delete',
            transaction_id: result?.transaction_id ?? null,
            group_id: result?.group_id ?? null,
            title: args.title ?? null,
            start: null,
            scope: result?.scope ?? (args.scope || 'single'),
          };
          committedWrites.push(delRecord);
          recordRecentWrite(state, delRecord);
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({
            ...(result ?? {}),
            note: 'DELETE COMMITTED. Confirm to the user exactly what was deleted (the transaction/series you proposed) — do not describe any other transaction.'
          }) });
        } catch (err) {
          blockedWrites.push({ tool: name, reason: 'execution_failed' });
          toolResults.push({ id: toolCall.id, name, content: JSON.stringify({ error: err?.message || err?.response?.data?.message || 'Delete failed' }) });
        }
        continue;
      }

      // ── Read / other tools ───────────────────────────────────────────────
      try {
        const result = await toolFn(args, ctx);
        // Collect simulation proposals so they ride back to the client
        // alongside the final prose (the frontend applies them to the overlay).
        if (SIM_PROPOSE_TOOLS.has(name) && result && result.simOp) {
          proposedSimOps.push(result.simOp);
        }
        let toolContent = JSON.stringify(result ?? {});
        if (toolContent.length > 13000) {
          toolContent = toolContent.substring(0, 13000) + '..."_truncated":true}';
          console.log('Tool response truncated from', JSON.stringify(result ?? {}).length, 'to', toolContent.length, 'bytes');
        }
        toolResults.push({ id: toolCall.id, name, content: toolContent });
      } catch (err) {
        toolResults.push({ id: toolCall.id, name, content: JSON.stringify({ error: err?.message || 'Tool execution failed' }) });
      }
    }

    const assistantToolMessage = { role: 'assistant', content: null, tool_calls: batch };
    const toolMessages = toolResults.map(tr => ({ role: 'tool', tool_call_id: tr.id, content: tr.content }));
    return { assistantToolMessage, toolMessages, toolResults };
  };

  // Keep the array valid + within Azure's size limit. Naive slicing would orphan
  // `tool` messages from their parent assistant tool_calls (Azure 400s), so when
  // oversized we rebuild a minimal but VALID array: system + last user + this
  // round's assistant tool_calls + tool results.
  const enforceSize = (messages, assistantToolMessage, toolMessages) => {
    const size = JSON.stringify(messages).length;
    console.log('Message array size after tool round:', size, 'bytes');
    if (size <= 750000) return messages;
    console.log('Tool-result message array too large, rebuilding a minimal valid array');
    const systemMsg = originalMessages.find(m => m.role === 'system');
    let lastUserMsg = null;
    for (let i = originalMessages.length - 1; i >= 0; i--) {
      if (originalMessages[i].role === 'user') { lastUserMsg = originalMessages[i]; break; }
    }
    const rebuilt = [
      ...(systemMsg ? [systemMsg] : []),
      ...(lastUserMsg ? [lastUserMsg] : []),
      assistantToolMessage,
      ...toolMessages,
    ];
    console.log('Rebuilt minimal message array size:', JSON.stringify(rebuilt).length, 'bytes');
    return rebuilt;
  };

  // Nudge only used on the final forced round to push a clean text answer.
  const finalNudge = {
    role: 'user',
    content: 'Using the tool results above, answer my previous message directly. If a transaction was created, confirm it with its name, amount, dates and (if recurring) frequency. If a write was blocked pending confirmation, show the proposed transaction and ask me to confirm. Respond in markdown and do not mention tools.'
  };

  let messages = [...originalMessages];
  let batch = toolCalls;
  let lastToolResults = [];

  for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
    const { assistantToolMessage, toolMessages, toolResults } = await runBatch(batch);
    lastToolResults = toolResults;
    messages = enforceSize([...messages, assistantToolMessage, ...toolMessages], assistantToolMessage, toolMessages);

    const isLastRound = round === MAX_TOOL_ROUNDS;
    const convo = isLastRound ? [...messages, finalNudge] : messages;

    let response;
    try {
      console.log(`Tool loop round ${round}/${MAX_TOOL_ROUNDS}: calling model with`, convo.length, 'messages (tool_choice:', isLastRound ? 'none' : 'auto', ')');
      response = await queryAzureOpenAI(convo, { tools: functionSchemas, tool_choice: isLastRound ? 'none' : 'auto' });
    } catch (error) {
      console.log('Tool loop model call failed:', error.message);
      console.log('Error details:', error.response?.data || error);
      return { content: buildToolFallbackResponse(lastToolResults), raw: null, simOps: proposedSimOps, uiActions, writes: committedWrites, blocked: blockedWrites };
    }

    const msg = response?.choices?.[0]?.message;
    if (!isLastRound && msg?.tool_calls && msg.tool_calls.length > 0) {
      console.log('Tool loop: model requested', msg.tool_calls.length, 'more tool call(s); continuing.');
      batch = msg.tool_calls;
      continue;
    }
    console.log('Tool loop: final response received, content length:', msg?.content?.length || 0);
    return { content: msg?.content || '', raw: response, simOps: proposedSimOps, uiActions, writes: committedWrites, blocked: blockedWrites };
  }

  return { content: buildToolFallbackResponse(lastToolResults), raw: null, simOps: proposedSimOps, uiActions, writes: committedWrites, blocked: blockedWrites };
}

// ----------------------------
// 🧠 Chat with memory + tools (functionMap.js)
// ----------------------------
exports.chat = async (req, res) => {
  try {
    // Redacted request log: never emit `token` or the full message/PII to logs.
    console.log('Chat endpoint called:', JSON.stringify(redactChatBodyForLog(req.body)));
    const { message, systemPrompt } = req.body;
    if (!message) {
      console.log('Chat endpoint: Missing message in request body');
      return res.status(400).json({ error: 'Message is required' });
    }

    const sessionKey = buildSessionKey(req);
    const accountid = req.body.accountid;
    // Simulation ("what-if") mode: the client flags an active simulation with
    // mode:'simulation' and may attach a summary of the sim (simContext) plus
    // the current projected-impact numbers (simSnapshot). In this mode real
    // writes are refused in code and the model is steered to the
    // proposeSimulation* tools, whose simOps ride back on the response.
    const simulationMode = req.body?.mode === 'simulation';
    const simContext = req.body?.simContext && typeof req.body.simContext === 'object' ? req.body.simContext : null;
    const simSnapshot = req.body?.simSnapshot && typeof req.body.simSnapshot === 'object' ? req.body.simSnapshot : null;
    // The client sets simulationAvailable when the account's tier includes the
    // simulation feature — we only advertise the what-if tools when the client
    // can actually render the resulting overlay.
    const simulationAvailable = simulationMode || req.body?.simulationAvailable === true;
    // Goals availability (tier 2+ / quota). Defaults OPEN when the client
    // doesn't send the flag (older clients) — the backend's tier gate on the
    // goals routes remains the authoritative enforcement.
    const goalsAvailable = req.body?.goalsAvailable !== false;
    let faq;
    if (req.body.faq) {
      faq = JSON.parse(req.body.faq);
    }
    const { token, userId, authHeader } = extractAuthFromRequest(req);
    console.log('Chat endpoint: Session key:', sessionKey, 'User ID:', userId);

    // When no session identifier was provided, buildSessionKey falls back to
    // 'session:anonymous' — a single Redis bucket SHARED by every such caller.
    // Reading/writing it would leak one user's conversation (and any drafted
    // transactions in it) into another user's context, so we skip Redis history
    // persistence entirely and rely on the client-provided transcript instead.
    const hasScopedSession = sessionKey !== 'session:anonymous';
    if (!hasScopedSession) {
      console.warn('Chat endpoint: no sessionId provided — skipping shared anonymous history persistence');
    }

    // Load prior conversation memory
    let history = [];
    if (hasScopedSession) {
      try {
        const historyData = await redis.get(sessionKey);
        history = historyData ? JSON.parse(historyData) : [];
        console.log('Chat endpoint: Loaded history length:', history.length);
      } catch (redisError) {
        console.warn('Chat endpoint: Redis history load failed:', redisError.message);
        history = [];
      }
    }

    // ── Kea Assistant memory layers (all fail-soft) ──────────────────────────
    // 1) Dialogue state: in-progress draft transaction + slot-filling.
    const dialogueState = await loadDialogueState(userId);
    const pendingConfirmationAtStart = dialogueState.pendingConfirmation === true;
    // A complete draft persisted from a prior turn also arms the write gate,
    // so confirmations work even when the model proposed in prose.
    const draftCompleteAtStart = isDraftProposable(dialogueState.draftTransaction);
    const userAffirmative = isAffirmativeMessage(message, dialogueState.draftTransaction);
    // Reset the one-shot "committed" flag at the start of each new turn.
    dialogueState.committed = false;

    // Mirror current on-screen focus into dialogueState.uiReferent (fail-soft).
    // Only overwrites when the client sends a focusedEntity; never clears on null.
    const uiContextRaw =
      req.body?.uiContext && typeof req.body.uiContext === 'object' ? req.body.uiContext : null;
    try {
      mirrorUiReferentFromUiContext(dialogueState, uiContextRaw);
    } catch (e) {
      console.warn('Chat endpoint: uiReferent mirror failed (fail-soft):', e.message);
    }
    // 2) Rolling short-term summary of older turns (loaded here, refreshed after the turn).
    let rollingSummary = '';
    try {
      rollingSummary = (await redis.get(buildSummaryKey(userId))) || '';
    } catch (e) {
      console.warn('Chat endpoint: rolling summary load failed:', e.message);
    }
    // 3) Long-term durable facts from cashflow-backend-api (per user + account).
    const longTermFacts = await recallLongTermFacts({ userId, accountId: accountid, token });

    // Prefer the client-sent transcript when provided. It's the exact
    // conversation the user is looking at, so it can't drift from the UI even
    // if Redis memory was evicted or unavailable — that drift was causing the
    // assistant to "forget" what was just discussed (e.g. a proposed carpet
    // transaction) on the very next (confirmation) turn.
    const clientHistory = normalizeClientHistory(req.body?.history);
    if (clientHistory && clientHistory.length > 0) {
      history = clientHistory;
      console.log('Chat endpoint: Using client-provided history of', history.length, 'messages');
    }

    // Dedup: the frontend transcript usually already ends with the message
    // we're about to process, and we append `message` separately below. Drop a
    // trailing user echo so the model doesn't see the current question twice.
    if (
      history.length &&
      history[history.length - 1].role === 'user' &&
      String(history[history.length - 1].content || '').trim() === String(message || '').trim()
    ) {
      history = history.slice(0, -1);
    }

    let dataMessage;

    // Extract location data from request body
    const location = req.body?.location;
    console.log('Location data received:', location);

    // The user's "today": prefer the date the client computed in its own real
    // timezone (clientDate) — the coordinate-based approximation divides
    // longitude by 15 and is wrong often enough to shift "today"/"tomorrow"
    // by a day near midnight. Coordinates remain the fallback.
    const clientDate = req.body?.clientDate;
    const currentDate = (clientDate && moment(clientDate, 'YYYY-MM-DD', true).isValid())
      ? clientDate
      : getCurrentDateInTimezone(location);
    console.log('Using current date:', currentDate, clientDate ? '(from clientDate)' : '(from coordinates)');

    // ── Resolve the selected-account blob via the tool layer ──────────────
    // Mirrors exports.summarization: prefer a client-sent accountSnapshot,
    // otherwise fetch the slim, fully-enriched single-account blob through
    // functionMap.getSelectedAccount (Redis-cached 5 min). This replaces the
    // old contextCache / getSelectedKeacastAccounts preload and the multi-KB
    // JSON dump — specifics are now fetched on demand by the tools below.
    const accountSnapshot = req.body?.accountSnapshot;
    let selectedAccount = null;
    let selectedAccountSource = 'none';

    if (
      accountSnapshot &&
      typeof accountSnapshot === 'object' &&
      (accountSnapshot.accountid !== undefined || typeof accountSnapshot.balance === 'number')
    ) {
      selectedAccount = accountSnapshot;
      selectedAccountSource = 'snapshot';
    }

    if (!selectedAccount && userId && token && accountid) {
      const toolCacheKey = selectedAccountToolCacheKey(userId, accountid);
      try {
        const cached = await redis.get(toolCacheKey);
        if (cached) {
          selectedAccount = JSON.parse(cached);
          selectedAccountSource = 'tool-cache';
          console.log('Chat endpoint: Using cached selected-account blob for account', accountid);
        }
      } catch (e) {
        console.warn('Chat endpoint: tool-layer cache read failed:', e.message);
      }

      if (!selectedAccount) {
        try {
          const t0 = Date.now();
          selectedAccount = await functionMap.getSelectedAccount({
            userId,
            accountId: accountid,
            token,
            body: { clientDate: currentDate },
            timeoutMs: SELECTED_ACCOUNT_TOOL_TIMEOUT_MS,
          }, { userId, token, accountId: accountid });
          console.log('Chat endpoint: tool-layer fetch completed in', Date.now() - t0, 'ms');
          selectedAccountSource = 'tool-fresh';
          if (selectedAccount && typeof selectedAccount === 'object') {
            try {
              await redis.set(toolCacheKey, JSON.stringify(selectedAccount), 'EX', SELECTED_ACCOUNT_TOOL_TTL);
            } catch (e) {
              console.warn('Chat endpoint: tool-layer cache write failed:', e.message);
            }
          }
        } catch (toolErr) {
          console.warn(
            'Chat endpoint: tool-layer fetch failed —',
            'status:', toolErr?.response?.status,
            'message:', toolErr?.message
          );
          selectedAccount = null;
        }
      }
    } else if (!userId || !token || !accountid) {
      console.log('Chat endpoint: Skipping account preload (missing userId, token, or accountid)');
    }

    const hasAccount = !!(
      selectedAccount &&
      typeof selectedAccount === 'object' &&
      (selectedAccount.accountid !== undefined || typeof selectedAccount.balance === 'number')
    );
    dataMessage = hasAccount
      ? `Loaded account context via ${selectedAccountSource}`
      : 'No account context (missing account or tool-layer unavailable)';

    // ── Build a compact, token-minimal context block ─────────────────────
    // Specific lookups (a single transaction, a category, a date range) are
    // handled on demand by the function-calling tools below, so we only seed a
    // small high-signal brief instead of dumping hundreds of rows of JSON.
    const firstName = coerceFirstName(req.body?.userData, selectedAccount?.user || null);
    const completeContext = hasAccount
      ? buildChatAccountContext(selectedAccount, firstName, currentDate)
      : buildChatNoAccountContext(firstName);
    console.log('Chat endpoint: context block size:', completeContext.length, 'chars (source:', selectedAccountSource + ')');

    // The user's real category names — used to (a) tell the model to pick a
    // category from this list, and (b) snap any chosen category server-side.
    const categoryNames = extractCategoryNames(selectedAccount);

    const baseSystem = `You are the Keacast (pronunciation: kee-uh-cast) Assistant, a knowledgeable and proactive personal finance forecasting tool developed by Parrot Insight LLC. Keacast is designed to help users manage their finances with foresight and clarity, going beyond traditional budgeting. You can refer to yourself as the Kea (pronunciation: kee-uh) assistant. Keacast is based on the Kea Parrot and it's predictive intelligence combined with a calendar-based forecasting system hince Keacast. Always respond with markdown formatting. Write dollar amounts WITHOUT thousands separators — e.g. $1000, not $1,000. If the user has not loaded any accounts yet, highlight Keacast's features, purpose, and benefits for a user or small business owner, and use the FAQ items to help them understand how to use it. When referencing the FAQ, don't quote answers word for word — use the questions and answers to craft a response relevant to the user's question.  
    If the user has loaded accounts, then you should use the context provided to answer the user's question.

    Core purpose:
    - Forecast future cash flow and account balances day-by-day, week-by-week, or month-by-month, so users can anticipate upcoming financial scenarios.
    - Track both cleared and uncleared transactions, helping users understand their true available balance—not just what appears on paper.
    - Pay close attention to transaction and balance dates, and the user's available balance to provide accurate and helpful responses, look at future balances and always warn of negative balances or not having enough money to cover upcoming transactions.
    - User's will check with you to see if they have enough money to cover upcoming transactions, ask if they can afford to do something, I want you to be proactive and making them aware of future negative forecasted balances. We don't want the user to think they have enough money to do something just to fall short in the coming days, weeks, or months.
    - Present intuitive visualizations—such as calendar-based forecasts and category-based breakdowns (e.g., waterfall charts)—to reveal spending patterns, upcoming obligations, and opportunities to optimize.
    - Empower users to plan with confidence, avoid surprises like overdrafts, and make informed decisions rooted in real-time data.
    - Provide clarity, structure, and peace of mind without requiring complicated spreadsheets or manual updates.
    - Provide proactive planning and suggestions to help the user save money, invest, pay off debt, plan for a vacation, retirement, etc.
    - Act as a financial advisor and financial planner to help the user make informed decisions, provide advice, and guide them towards a financially secure future.
    - We want to lead the user to clear financial decisions and actions, not just provide information.
    - When planning for the future, be sure to not recommend actions that won't allow the user to cover their upcoming transactions in the coming days, weeks, months, or years.
    - If the user asks about a specific transaction, be sure to provide the transaction details and the date of the transaction. 
    - If the user asks about a specific balance, be sure to provide date, amount and the relevant transactions on that particular day.
    - If the user asks about a specific category, be sure to provide the category details and the relevant transactions for that category (upcoming, forecasted, and historical).
    - If the user asks about a specific merchant, be sure to provide the merchant details and the relevant transactions.
    - If the user asks about a specific date, be sure to provide the date details and the relevant transactions on that particular day.
    - If the user asks about a specific date range, be sure to provide the date range details and the relevant transactions on that particular day.
    - Future planning consist of things like saving for a vacation, saving for a down payment on a house, saving for retirement, etc. Future planning is NOT advice to spend money on things that will negatively impact the user's financial situation.
    - We are not in the business of telling the user what they can and cannot do, we are in the business of helping them make informed decisions and guide them towards a financially secure future.
    - Always use dollar amounts when providing financial information.
    - Always use the word "disposable" when referring to disposable income.
    - Always use the word "forecasted" when referring to forecasted income and spending.    
    - if referring to an expense or expense transaction always use the word "expense" and not "transaction".
    - if referring to an income or income transaction always use the word "income" and not "transaction".
    - if referring to an expense always use (-) to symbolize negative amounts.
    - Only use ($) when displaying amounts ex: $100, -$100, $1000.00, -$500.00, etc.
    - Only use (-) for negative amounts ex: -$100, -$1000.00, -$500.00, etc., dont use (-) for any other purpose.
    - Use bullet points, numbered lists, bold text, italic text, and other markdown elements when listing transactions, suggestions, balances, etc.
    - Use tables in a properly formatted way when asked to compare data. Use lists when asked to list data.
    - If the user has not loaded any accounts yet, then you should highlight the features and capabilities of Keacast as well as its purposed and benefits for a user or a small business owner and use the FAQ items to help the user understand how to use Keacast.
    - Use the FAQ questions and answers to help the user understand Keacast and how it can help them, application specific questions and answers should be included.
    - Here are the FAQ question and answers:
    ${JSON.stringify(faq, null, 2)}

    Things to consider:
    - Today's date is ${currentDate}.
    - Users may feel stress, uncertainty, or guilt around money - the assistant should always respond with reassurance and clarity, never judgement.
    - Recognize  when users are in different life situations (paycheck-to-paycheck, high-income with irregular cash flow, debt payoff, planning for a vacation, retirement, etc.) and tailor advice accordingly.
    - Highlight that forecasting is forward-looking and always frame answers around "what's ahead" and "what's possible" and not just "what's happened".
    - Always explain why something matters, encourage habit-building: logging in daily, reviewing tomorrow's cash flow, planning out scenarios, etc.
    - Always connect insights back to action.
    - Highlight unique features of keacast, transaction netting, scenario planning, recurring transaction detection, insights graphs, and calendar-based forecasting.
    - Summarize numbers in digestible soundbites.
    - Proactively ask gentle follow-up questions that lead users toward deeper understanding and engagement.
    - If users add big one-time transactions, help them see scenarios to understand the impact on their financial situation.
    - When analyzing a user's possible recurring transactions, compare them with the users forecasted transactions and let them know if they have already forecasted for them. We would like the user to add recurring transactions to their forecasts that have not already been added.
    - Also use the possible recurring transactions to help the user understand their financial situation and help them make informed decisions.
    - Creating a transaction should feel effortless. The user does NOT have to provide a title, amount, type, category, date, or frequency. ESTIMATE every field you weren't given from this conversation, the account context, and the user's similar/recurring/recent transactions (e.g. estimate a Netflix expense at their typical streaming amount, a paycheck from their recurring income). Never make the user fill in details just to satisfy the tool.
    - VERIFY BEFORE CREATING: createTransaction writes real data, so you MUST NOT call it until you have shown the user the full proposed transaction and they have agreed. When you propose, ALWAYS state a SINGLE concrete amount — if your estimate is a range, pick one reasonable figure (such as the midpoint of the range), state it plainly, and ask them to confirm or adjust. Never leave the amount as a range going into the confirmation. On the turn the user first expresses intent, do NOT call the tool — propose the concrete details and ask them to confirm or adjust. EVERY TIME you propose a transaction in prose you MUST also call updateDraftTransaction in that same turn with those exact values — title, type, amount, category, start (YYYY-MM-DD from the DATE REFERENCE block), and frequency if recurring — with pendingConfirmation:true. A proposal that was never staged is the #1 cause of the wrong transaction being created later, and an unstaged frequency is how "weekly" collapses into a one-time entry. Only call createTransaction after they agree. If they tweak a value, restate the updated proposal and confirm again.
    - CONFIRMATION HANDLING: Treat the user's reply as confirmation to create the transaction you just proposed whenever it is affirmative OR an add/create instruction — e.g. "yes", "yes please", "go ahead", "do it", "confirm", "sounds good", "please add this", "please add this forecast", "add it", "add that", "create it", "log it", "put it in my forecast", or any natural equivalent. When you get any of these and your previous message proposed (or discussed) exactly one transaction, FIRST call confirmTransaction (this registers the confirmation), THEN immediately call createTransaction, copying the EXACT values from your previous proposal message — the same amount, the same date, the same category, the same title. NEVER re-estimate, round, or substitute a value on the confirmation turn: if you proposed "$16 at Racetrac tomorrow" you must create exactly $16, Racetrac, tomorrow's date (a mismatched amount will be refused by the server). If the user confirmed but adjusted a value ("yes, but make it $45"), call updateDraftTransaction with the adjusted value BEFORE confirmTransaction. Do NOT start over and do NOT re-ask for details you already proposed.
    - NEVER reply with "which forecast/transaction would you like to add?" when your own previous turn already identified exactly one thing (e.g. you just asked "would you like to create a transaction for the item we discussed?"). "This forecast"/"this transaction" unambiguously refers to that item — create it. The ONLY time you may ask a clarifying question is if you genuinely proposed two or more clearly different transactions in the same breath. Also note: in Keacast "add this as a forecast" / "add this forecast" means CREATE a new forecasted transaction for the item just discussed — it does NOT mean look up an existing forecast, so do NOT call read tools (getRecurringForecasts/getUpcomingTransactions) to "find" it.
    - STAY ON TOPIC: The transaction you create must be the one that was actually being DISCUSSED with the user (the item you just proposed in this conversation). NEVER substitute an unrelated item that merely appears in the account context or the "Recent posted"/"Upcoming forecasted" lists (e.g. a paycheck). The CURRENT CONTEXT block is reference data only — it is never the thing to create unless the user explicitly asked for it.
    - Use the full chat history above as memory: remember the amounts, dates, merchants, goals, and any transaction you already proposed earlier in this conversation, and reuse them so the user never has to repeat themselves (the confirmation turn relies on this).
    - Carry conversation TOPICS into transactions. When the user asks to "add a transaction" (or "add that", "log it", "put that in my forecast") without naming what it's for, scan back through the recent messages for the most relevant purchase/expense/income topic that was being discussed and treat THAT as the subject. Example: if you were just discussing a specific purchase and the user then says "add a transaction", understand it refers to that purchase — set the title/description/category accordingly and estimate the amount from any figure mentioned in that discussion (or a reasonable estimate for that item). Briefly state which topic you linked it to in your confirmation prompt so the user can correct you if you guessed wrong.
    - When creating transactions, always provide clear confirmation to the user that their transaction has been successfully created. Include details like the transaction name, amount, frequency (if recurring), and any relevant dates. Make the user feel confident that their transaction has been properly added to their forecast. Don't mention the execution of the tool, just confirm the transaction has been created. Make sure not to duplicate or repeat anything in your response.
      - Always return with the transaction_id and if the transaction is recurring then also return the group_id which you can refer to as the recurring_id.
      - When working with dates and times, consider the user's location and timezone to provide accurate date-based responses. Forecasted transactions can not be created on date before the ${currentDate}. The system automatically calculates the correct date based on the user's coordinates.
      - When creating forecasts always consider whether the user has enough in the coming days, weeks, months, or years and warn them about how this may effect their financial state in the future. 

    ADVISOR MEMORY & TOOLS (use these to be a stateful, context-aware advisor):
    - SLOT-FILLING with updateDraftTransaction: As a plan for a transaction takes shape across the conversation (the user researches a purchase, you estimate its cost, they mention a target date), call updateDraftTransaction to record/refine the known fields (title, type, amount, category, start, frequency, and a short intent label describing the item). ONLY record values that came from THIS conversation — never invent a draft for something the user has not discussed. This is a NON-writing scratchpad — it never creates anything. Set pendingConfirmation:true on it ONLY when you have just proposed a complete, concrete transaction and are asking the user to confirm. The DIALOGUE STATE block reflects the current draft; reuse it so the user never repeats themselves. Ask only for fields you genuinely cannot infer.
    - LOCK CONFIRMED VALUES — NO DRIFT: Once you have proposed specific values (a specific start date and amount), those values are LOCKED. Do NOT re-estimate or change an already-proposed field on later turns (a common bug was a November date silently becoming August). When the user confirms, call createTransaction with the EXACT values from the DIALOGUE STATE draft — same date, same amount, same category. Only change a value if the user explicitly asks to; then update the draft first via updateDraftTransaction and re-confirm.
    - CATEGORY MUST BE REAL: Always choose the category from the user's AVAILABLE CATEGORIES list shown in context — pick the closest existing match for the item being created. Never invent a category that isn't in that list. If none fits well, pick the nearest general one from the list.
    - The confirm-before-write rule is enforced in code: createTransaction/updateTransaction will be REFUSED unless you proposed a complete transaction on a prior turn and the confirmation was registered. So the flow is exactly TWO turns: (1) propose with a single concrete amount + a real category (stage it via updateDraftTransaction with pendingConfirmation:true), (2) when the user's next message confirms it, call confirmTransaction and then IMMEDIATELY createTransaction with the locked draft values — do NOT re-propose or ask for confirmation a second/third time. Only if a write is genuinely refused should you show the proposal again.
    - UPDATING & DELETING EXISTING TRANSACTIONS (updateTransaction / deleteTransaction — both confirm-gated in code):
      1. FIND THE ID FIRST. Check the RECENT WRITES THIS SESSION block — if the user refers to something you just created ("delete the expense you just added"), its transactionid/groupid is right there; use it directly. Otherwise look it up: call getUpcomingTransactions with a date window bracketing the date the user mentioned (a few days on each side) or getRecurringForecasts for recurring items, and match on title/category/amount. NEVER claim a transaction doesn't exist until a lookup with a correct date window came back empty.
      2. If the lookup returns MULTIPLE plausible matches, list them briefly (title, amount, date) and ask which one — never guess.
      3. PROPOSE, THEN CONFIRM: state exactly what you found and what will change ("Delete 'Food and Beverage', $35 weekly starting 2026-07-22?"). For a RECURRING transaction being deleted, ask whether to remove just that occurrence or the entire series. Wait for the user's confirmation on their next message, then call confirmTransaction followed by the write tool.
      4. deleteTransaction scope: pass scope:'single' with transactionid for one occurrence, or scope:'group' with groupid to remove the whole recurring series.
    - OPEN THE APP'S SEARCH (openTransactionSearch): When the user asks you to open search or to find/pull up/show transactions IN THE APP ("search for my Uber transactions", "show me my Netflix charges", "open search"), call openTransactionSearch with an optional search_term — the app minimizes the chat and opens its search panel front and center with the results. This tool returns NO data to you; when you need transaction data to ANSWER a question yourself, use the read tools instead. After calling it, just tell the user the search is opening — never invent counts or amounts.
    - OPEN / NAVIGATE THE APP UI (openCalendarDay / highlightTransaction / navigateTo): When the user asks to show a calendar day, open a specific charge, or go to a screen IN THE APP, call the matching UI tool. Prefer focusedEntity / last uiReferent for "that"/"it". These return NO data — briefly say the panel/page is opening; never invent balances, lists, or page contents.
    - LONG-TERM MEMORY: The LONG-TERM MEMORY block lists durable facts you saved before. When the user states something durable and useful for future advice (a savings goal, a planned project and its estimated cost, income cadence, risk tolerance, a stated preference), call rememberFact to persist it (a short mem_key like "goal:emergency_fund" or "plan:home_repair" and a concise mem_value; set importance 1-10). Only save facts the user actually stated or clearly implied — never guesses. Do not save transient chit-chat. You may call recallFacts if you need more of the user's saved facts than are shown.

    FINANCIAL PLANNING PLAYBOOK (follow this structure whenever the user states or implies a goal, asks "can I afford X", asks how to save/pay off/plan for something, or asks how to improve their cash flow):
    1. STATE THE TARGET: name the goal, the dollar target, and the timeline. If the user gave no timeline, propose a realistic one from their numbers and say why.
    2. QUANTIFY THE GAP with real numbers — never estimate what you can fetch or what is already in context: the ACTIVE GOALS block for existing goals, getGoals for details, previewGoalCadence to compute exact per-period contributions ("$125 per paycheck for 12 paychecks"), and the CURRENT CONTEXT forecast figures (forecasted disposable, savings potential, top spending categories).
    3. GIVE 1-3 CONCRETE LEVERS, each quantified and tied to their actual data: e.g. trim a named top spending category by a specific amount, redirect part of the monthly forecasted disposable, or move/reduce a specific recurring expense. Show how each lever changes the timeline or the per-period amount.
    4. STRESS-TEST THE PLAN: check it against the future negative projected balances in context (or fetch upcoming transactions). NEVER recommend a plan whose contributions would push a projected balance negative — say so and offer a smaller amount or a longer timeline instead.
    5. MAKE IT REAL: offer ONE clear next action — create a goal (propose it with the exact cadence numbers, then confirm), stage a what-if simulation so they can SEE the impact (when simulations are available), or save the intent with rememberFact if they're not ready. Lead them to a decision, not just information.
    - When simulations are available, prefer SHOWING impact over describing it: propose the change with proposeSimulationAdd/Modify so the user sees projected balances on their calendar.
    - Money already scheduled toward ACTIVE GOALS is committed — never double-count it as available disposable income, and flag goals that are BEHIND schedule with a concrete catch-up option.

    Tone & Style: 
    - Clear, empathetic, and supportive
    - Professional yet approachable
    - Insightful when explaining forecasting logic, actionable when guiding users
    - Be sure to be concise and to the point, do not provide too much information, just the information that is relevant to the user's question.
    - Be sure to be thoughtful and consider the user's financial situation and goals, and provide advice that is in the best interest of the user.

    When interacting, always ground responses in the principles of cash-flow forecasting, clarity, and proactive planning. RESPONSE LENGTH IS TIERED: for quick lookups and simple questions (a balance, a transaction, a date) stay under ~600 characters; for financial-planning, goal, affordability, or "how do I..." questions you may use up to ~1500 characters with headers and bullets to deliver the full playbook structure — but never pad; every sentence must carry a number or a decision. If the user asks about short-term or long-term financial planning tasks, explain how Keacast can help, referencing forecasting, goals, simulations, reconciliation, and visualization where relevant.
    
    IMPORTANT: Always respond with markdown formatting.
    
    Review the app here: https://keacast.app/ for more context and information.`;

    // Attach the compact context block as BACKGROUND inside the system message
    // rather than as a per-turn user message. Injecting it as a `user` turn
    // between the history and the real user message used to derail multi-turn
    // flows: on a confirmation turn the model saw [assistant: "...confirm?"],
    // then a system-authored "user" context dump, then "yes please" — and
    // treated the context dump as a topic change, restarting the conversation.
    let systemContent = completeContext
      ? `${baseSystem}\n\n---\nCURRENT CONTEXT (background — NOT a message from the user):\n${completeContext}`
      : baseSystem;

    // Append the Kea Assistant memory layers as BACKGROUND context (each hard-
    // capped). Order: long-term facts, then rolling summary, then the live
    // dialogue state (most immediately actionable last).
    const factsBlock = buildFactsBlock(longTermFacts);
    const summaryBlock = buildSummaryBlock(rollingSummary);
    const dialogueBlock = buildDialogueStateBlock(dialogueState);
    const dateRefBlock = buildDateReferenceBlock(currentDate);
    const uiContextBlock = buildUiContextBlock(uiContextRaw);
    const recentWritesBlock = buildRecentWritesBlock(dialogueState);
    // Active savings goals ride along in the selected-account blob — surface
    // them permanently so planning advice always accounts for money already
    // earmarked toward goals (no tool round-trip needed).
    const goalsBlock = hasAccount ? buildGoalsBlock(selectedAccount.goals, currentDate) : '';
    const categoriesBlock = categoryNames.length
      ? truncateText(
          `AVAILABLE CATEGORIES (choose transaction categories ONLY from this list — pick the closest match, never invent one):\n${categoryNames.join(', ')}`,
          1200
        )
      : '';
    systemContent += `\n\n---\n${dateRefBlock}`;
    if (uiContextBlock) systemContent += `\n\n---\n${uiContextBlock}`;
    if (categoriesBlock) systemContent += `\n\n---\n${categoriesBlock}`;
    if (goalsBlock) systemContent += `\n\n---\n${goalsBlock}`;
    if (factsBlock) systemContent += `\n\n---\n${factsBlock}`;
    if (summaryBlock) systemContent += `\n\n---\n${summaryBlock}`;
    if (recentWritesBlock) systemContent += `\n\n---\n${recentWritesBlock}`;
    if (dialogueBlock) systemContent += `\n\n---\n${dialogueBlock}`;
    // Goals feature availability steers whether the model may offer goal writes.
    if (goalsAvailable) {
      systemContent += `\n\n---\nGOALS ARE AVAILABLE: You may use getGoals, previewGoalCadence, and (after propose+confirm) createGoal/updateGoal/deleteGoal.`;
    } else {
      systemContent += `\n\n---\nGOALS ARE NOT AVAILABLE on this user's plan. Do NOT offer to create, update, or delete goals (those tools are refused in code). You may still lay out savings plans in prose and mention that the Goals feature is available on upgraded plans.`;
    }

    // ── Simulation ("what-if") instructions ────────────────────────────────
    // The proposeSimulation* tools stage hypothetical changes on the client's
    // simulation overlay — they never write. When the user's calendar is in
    // Simulation Mode we route ALL transaction changes through them (real
    // writes are also refused in code); outside it they still serve "what if"
    // questions, which auto-start a simulation on the client.
    if (simulationMode) {
      let simBlock = `SIMULATION MODE IS ACTIVE. The user is exploring hypothetical "what-if" changes on their calendar. RULES:
- Use proposeSimulationAdd to stage a new hypothetical income/expense, proposeSimulationModify to change an existing forecasted transaction (find its transactionid via the read tools if needed), and proposeSimulationRemove to drop one. Map intent: "add / what if I had" => add; "change / raise / lower / move" => modify; "cancel / remove / drop / without" => remove.
- For recurring forecasts set scope: 'group' for every occurrence, 'groupfrom' for this-and-future, 'single' (default) for one occurrence.
- These tools do NOT write data and need NO confirmation turn — propose immediately with your best estimates, exactly one tool call per distinct change.
- NEVER call createTransaction, updateTransaction, or deleteTransaction while Simulation Mode is active (they are refused in code). The user commits or discards the simulation from the banner on their calendar.
- After proposing, briefly narrate the change and its projected impact on the user's balances.`;
      if (simContext && Number(simContext.opCount) > 0) {
        simBlock += `\nThe simulation currently holds ${Number(simContext.opCount)} staged change(s).`;
      }
      if (simSnapshot) {
        const parts = [];
        if (simSnapshot.simLow && simSnapshot.simLow.amount != null) {
          parts.push(`projected lowest balance ${Number(simSnapshot.simLow.amount)} on ${simSnapshot.simLow.date}`);
        }
        if (simSnapshot.baselineLow && simSnapshot.baselineLow.amount != null) {
          parts.push(`baseline (no simulation) lowest balance ${Number(simSnapshot.baselineLow.amount)} on ${simSnapshot.baselineLow.date}`);
        }
        if (simSnapshot.firstNegativeDate) {
          parts.push(`the simulated balance first goes NEGATIVE on ${simSnapshot.firstNegativeDate}`);
        }
        if (simSnapshot.horizonEndDiff != null) {
          parts.push(`net effect at the forecast horizon ${Number(simSnapshot.horizonEndDiff)}`);
        }
        if (parts.length) {
          simBlock += `\nCURRENT SIMULATION IMPACT (use these exact numbers when narrating impact; format them as dollar amounts): ${parts.join('; ')}.`;
        }
      }
      systemContent += `\n\n---\n${simBlock}`;
    } else if (simulationAvailable) {
      systemContent += `\n\n---\nWHAT-IF SIMULATIONS: When the user asks a hypothetical "what if" question about adding, changing, or removing a transaction (rather than asking you to actually do it), use the proposeSimulation* tools (proposeSimulationAdd / proposeSimulationModify / proposeSimulationRemove). They stage the change on the user's calendar as a reviewable simulation without writing data and need no confirmation turn. Only use createTransaction/updateTransaction/deleteTransaction when the user wants the REAL change made.`;
    } else {
      systemContent += `\n\n---\nDo not use the proposeSimulation* tools — this user's plan does not include Simulation Mode. For hypothetical questions, explain the impact in prose instead.`;
    }
    console.log('Chat endpoint: memory layers ->',
      'facts:', longTermFacts.length,
      'summaryChars:', (rollingSummary || '').length,
      'draftSlots:', Object.keys(dialogueState.draftTransaction || {}).length,
      'categories:', categoryNames.length,
      'pendingConfirm:', pendingConfirmationAtStart,
      'draftCompleteAtStart:', draftCompleteAtStart,
      'affirmative:', userAffirmative);

    // Build message array with memory and clean up long messages
    const messages = [
      { role: 'system', content: systemContent },
      ...sanitizeMessageArray(history.map(truncateMessage))
    ];
    console.log('Chat endpoint: system+context size:', systemContent.length, 'chars; history msgs:', messages.length - 1);
    // Diagnostic: surface the tail of the conversation actually sent to the
    // model so we can verify multi-turn context (e.g. a just-proposed carpet
    // transaction) is present on the confirmation turn rather than "forgotten".
    try {
      const tail = history.slice(-4).map(m => `${m.role}: ${String(m.content || '').slice(0, 120).replace(/\s+/g, ' ')}`);
      console.log('Chat endpoint: history tail ->\n' + tail.join('\n'));
      console.log('Chat endpoint: current user message ->', String(message).slice(0, 160));
    } catch (e) { /* logging only */ }

    // Add the actual user message
    messages.push({ role: 'user', content: message });

    console.log('Chat endpoint: Calling OpenAI (tools enabled) with', messages.length, 'messages');

    // Check request size before sending to prevent rate limiting
    const requestSize = JSON.stringify(messages).length;
    console.log('Chat endpoint: Request size:', requestSize, 'bytes');
    
    if (requestSize > 750000) { // Increased to 750KB limit to allow more context
      console.warn('Chat endpoint: Request too large, removing oldest messages one by one');
      
      // Remove oldest messages one by one until we're under the limit
      let attempts = 0;
      const maxAttempts = 20; // Prevent infinite loops
      
      while (requestSize > 750000 && attempts < maxAttempts && history.length > 2) {
        // Remove the oldest message (skip system message at index 0)
        history.shift(); // Remove first (oldest) message
        
        // Rebuild messages array
        messages.splice(1, messages.length - 2); // Keep only system and current user message
        messages.splice(1, 0, ...history.map(truncateMessage));
        
        // Recalculate size
        const newSize = JSON.stringify(messages).length;
        console.log(`Chat endpoint: Removed oldest message, new size: ${newSize} bytes (attempt ${attempts + 1})`);
        
        if (newSize <= 750000) {
          console.log('Chat endpoint: Successfully reduced size below limit');
          break;
        }
        
        attempts++;
      }
      
      if (attempts >= maxAttempts) {
        console.warn('Chat endpoint: Could not reduce size below limit after', maxAttempts, 'attempts');
      }
    }

    // Function-calling loop (uses functionMap.js). currentDate flows through so
    // createTransaction can default `start` to the user's localized today.
    // dialogueState (+ gate flags) let executeToolCalls slot-fill the draft and
    // enforce the confirm-before-write rule in code, not just the prompt.
    // Redis-eviction fallback: a proposal visible in the client transcript can
    // arm the write gate even when the dialogue-state draft is gone/incomplete.
    const proposalInTranscript = transcriptShowsPendingProposal(history);
    // Concrete values from the last assistant proposal — the authoritative
    // payload on the confirmation turn when no draft was staged (or the draft
    // is missing slots). Prevents the model's re-estimated args + normalizer
    // defaults from creating a different transaction than the one proposed.
    const transcriptProposal = proposalInTranscript
      ? extractProposalFromMessage(lastAssistantTurnText(history), categoryNames, currentDate)
      : null;

    const ctx = {
      userId,
      token,
      accountId: accountid,
      currentDate,
      dialogueState,
      pendingConfirmationAtStart,
      draftCompleteAtStart,
      userAffirmative,
      proposalInTranscript,
      transcriptProposal,
      categoryNames,
      simulationMode,
      goalsAvailable,
    };
    
    // Always try with tools first for data requests, but handle tool calls properly
    let result;
    let error;
    try {
      console.log('Attempting to get response with tools...');
      const responseWithTools = await queryAzureOpenAI(messages, { tools: functionSchemas, tool_choice: 'auto' });
      const choice = responseWithTools?.choices?.[0];
      const msg = choice?.message;
      
      console.log('Response message structure:', {
        hasContent: !!msg?.content,
        hasToolCalls: !!msg?.tool_calls,
        toolCallsLength: msg?.tool_calls?.length || 0,
        contentLength: msg?.content?.length || 0
      });
      
      // If the model wants to call tools, execute them
      if (msg?.tool_calls && msg.tool_calls.length > 0) {
        console.log('Model requested tool calls, executing...');
        result = await executeToolCalls(messages, msg.tool_calls, ctx);
      } else {
        // No tool calls needed, use the response directly
        result = { content: msg?.content || '', raw: responseWithTools };
      }
    } catch (error) {
      console.log('Tool-based response failed, trying direct response...');
      try {
        const directResponse = await queryAzureOpenAI(messages, { tools: functionSchemas, tool_choice: 'none' });
        const choice = directResponse?.choices?.[0];
        result = { content: choice?.message?.content || '', raw: directResponse };
      } catch (directError) {
        console.log('All attempts failed, returning error message');
        result = { content: '## ❌ Error\n\n**I apologize, but I encountered an error while processing your request. Please try again.**', raw: null, error: directError };
      }
    }

    console.log('Final result structure:', {
      hasContent: !!result?.content,
      contentLength: result?.content?.length || 0,
      hasError: !!result?.error
    });
    
    const finalText = stripCurrencyCommas(result.content || '## ❌ No Response\n\n**Sorry, no response generated.**');
    // Full turn transcript BEFORE trimming — used to decide what overflows into
    // the rolling summary.
    const fullTurn = [
      ...sanitizeMessageArray(history),
      { role: 'user', content: message },
      { role: 'assistant', content: finalText }
    ];
    const updatedHistory = fullTurn.slice(-MAX_MEMORY);

    if (hasScopedSession) {
      try {
        await redis.set(sessionKey, JSON.stringify(updatedHistory), 'EX', MEMORY_TTL);
        console.log('Chat endpoint: Saved updated history to Redis');
      } catch (redisError) {
        console.warn('Chat endpoint: Failed to save history to Redis:', redisError.message);
      }
    }

    // Persist dialogue state (mutated in-place by executeToolCalls). Fail-soft.
    await saveDialogueState(userId, ctx.dialogueState || dialogueState);

    // Refresh the rolling summary once the conversation grows past the trigger:
    // fold the turns that fell OUT of the verbatim window into the summary so
    // long chats stay coherent without unbounded token growth. Fail-soft.
    try {
      if (userId && fullTurn.length > SUMMARY_TRIGGER) {
        const overflow = fullTurn.slice(0, fullTurn.length - MAX_MEMORY);
        if (overflow.length > 0) {
          const newSummary = await generateRollingSummary(rollingSummary, overflow);
          if (newSummary && newSummary !== rollingSummary) {
            await redis.set(buildSummaryKey(userId), newSummary, 'EX', SUMMARY_TTL);
            console.log('Chat endpoint: rolling summary refreshed (', newSummary.length, 'chars )');
          }
        }
      }
    } catch (e) {
      console.warn('Chat endpoint: rolling summary refresh failed (fail-soft):', e.message);
    }

    // Structured outcome of any real writes this turn. The UI keys off
    // reloadSelectedAccount to refresh account data (instead of sniffing the
    // prose for "success"/"created"), and can use `focus` to navigate to a
    // newly created transaction.
    const writes = Array.isArray(result?.writes) ? result.writes : [];
    const blocked = Array.isArray(result?.blocked) ? result.blocked : [];
    const firstCreate = writes.find((w) => w.action === 'create' && w.transaction_id != null) || null;
    const transactionResult = {
      reloadSelectedAccount: writes.length > 0,
      writes,
      blocked,
      focus: firstCreate
        ? { transaction_id: firstCreate.transaction_id, group_id: firstCreate.group_id, date: firstCreate.start }
        : null,
    };

    res.json({
      response: finalText,
      memoryUsed: updatedHistory.length,
      contextLoaded: hasAccount,
      dataMessage: dataMessage,
      requestSize: requestSize,
      // Structured simulation proposals from the proposeSimulation* tools.
      // The frontend applies these to its client-side simulation overlay.
      simOps: Array.isArray(result?.simOps) ? result.simOps : [],
      // Client UI actions requested via tools (e.g. open the transaction
      // search panel, optionally pre-filled with a search term).
      uiActions: Array.isArray(result?.uiActions) ? result.uiActions : [],
      transactionResult,
      error: result?.error,
    });

  } catch (error) {
    console.error('Chat endpoint error:', error);
    console.error('Error stack:', error.stack);
    
    // Handle specific error types
    if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'Service temporarily unavailable - Redis connection failed' });
    }
    if (error.response?.status === 401) {
      return res.status(401).json({ error: 'Azure OpenAI authentication failed' });
    }
    if (error.response?.status === 400) {
      return res.status(400).json({ 
        error: 'Azure OpenAI request failed', 
        details: error.response?.data?.error?.message || 'Invalid request format',
        suggestion: 'Check API configuration and request format'
      });
    }
    if (error.response?.status === 429) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    
    // Generic error for other cases
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message || 'Unknown error occurred'
    });
  }
};

// ----------------------------
// 📊 Summarize with context memory (+ optional tools)
// ----------------------------
exports.analyzeTransactions = async (req, res) => {
  try {
    console.log('Analyze transactions endpoint called');
    const { transactions, userData } = req.body;
    // if (!transactions || !Array.isArray(transactions)) {
    //   console.log('Analyze transactions: Missing or invalid transactions array');
    //   return res.status(400).json({ error: 'Transactions array is required' });
    // }

    console.log('Analyze transactions: Processing', transactions.length, 'transactions');
    const sessionKey = buildSessionKey(req);

    let history = [];
    try {
      const historyData = await redis.get(sessionKey);
      history = historyData ? JSON.parse(historyData) : [];
      console.log('Analyze transactions: Loaded history length:', history.length);
    } catch (redisError) {
      console.warn('Analyze transactions: Redis history load failed:', redisError.message);
      history = [];
    }

    const { token, userId, authHeader } = extractAuthFromRequest(req);
    let userContext = extractContextFromBody(req) || {};

    // (Optional) Preload via functionMap if missing
    if (!userContext || Object.keys(userContext).length === 0) {
      if (userId && token) {
        // try {
        //   const ctx = { userId, authHeader };
        //   const accounts = await functionMap.getUserAccounts({ userId }, ctx);
        //   userContext = { accounts: accounts || [], categories: [], shoppingList: [] };
        // } catch (err) {
        //   console.warn('Analyze transactions: Preload via functionMap failed:', err?.message);
        // }
      }
    }

    const systemPrompt = `You are the Keacast Assistant, a knowledgeable and proactive personal finance forecasting tool developed by Parrot Insight LLC. Your purpose is to help users gain clarity, confidence, and foresight into their cash flow habits. You combine real-time transactions with forecasting to help users plan ahead, avoid surprises, and make better financial decisions. If the user has not provided any transactions, then you should highlight the features and capabilities of Keacast as well as its purposed and benefits for a user or a small business owner. Focus on teaching the user how to use Keacast and how it can help them.

    Give a warm welcome to the user and provide a space for the user to ask financial and Keacast related questions.

    When given a list of transactions, generate a concise, digestible summary (no more than 325 characters). The summary must include:
    - Total income and total spending
    - Forecasted income and spending
    - Forecasted disposable income for the next 30 days
    - Any high-value or unusual transactions
    - Behavioral patterns or habits
    - Actionable suggestions for improvement
    - Always use dollar amounts when providing financial information.
    - Always use the word "disposable" when referring to disposable income.
    - Always use the word "forecasted" when referring to forecasted income and spending.  
    - if referring to an expense or expense transaction always use the word "expense" and not "transaction".
    - if referring to an income or income transaction always use the word "income" and not "transaction".
    - if referring to an expense always use (-) to symbolize negative amounts.  
    - Only use ($) when displaying amounts ex: $100, -$100, $1000.00, -$500.00, etc.
    - Only use (-) for negative amounts ex: -$100, -$1000.00, -$500.00, etc., dont use (-) for any other purpose.
    - Use bullet points, numbered lists, bold text, italic text, and other markdown elements when listing transactions, suggestions, balances, etc.
    - Use tables when displaying data in a structured way.

    If there are no transactions, return a message that is nice and welcoming, and provides a space for the user to ask financial and Keacast related questions.

    Tone: clear, empathetic, professional, supportive, and future-focused. Always frame insights around Keacast's strengths: forecasting, reconciliation, and visualization.

    At the end of the summary, include relevant follow-up questions that guide the user toward improving their financial wellness through Keacast's forecasting features. Avoid unnecessary formatting, symbols, or filler (such as "...").

    IMPORTANT: Always respond with markdown formatting. Use headers, bullet points, bold text, and other markdown elements to make your responses clear and well-structured.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...sanitizeMessageArray(history),
      { role: 'user', content: `Here is my user's first name:
      ${JSON.stringify(userData.firstname, null, 2)}
      Here is my user's last name:
      ${JSON.stringify(userData.lastname, null, 2)}
      Here is my user's email:
      ${JSON.stringify(userData.email, null, 2)}
      
      Here are the latest transactions:\n${JSON.stringify(transactions)}` }
    ];

    console.log('Analyze transactions: Calling OpenAI (tools enabled) with', messages.length, 'messages');

    // Use the new executeToolCalls function for tool execution
    const ctx = { userId, authHeader };
    let result;
    try {
      // Try to get a response with tools first
      const responseWithTools = await queryAzureOpenAI(messages, { tools: functionSchemas, tool_choice: 'auto' });
      const choice = responseWithTools?.choices?.[0];
      const msg = choice?.message;
      
      // If the model wants to call tools, execute them
      // if (msg?.tool_calls && msg.tool_calls.length > 0) {
      //   console.log('Model requested tool calls, executing...');
      //   result = await executeToolCalls(messages, msg.tool_calls, ctx);
      // } else {
      //   // No tool calls needed, use the response directly
      //   result = { content: msg?.content || '', raw: responseWithTools };
      // }
      result = { content: msg?.content || '## Welcome to Keacast! 👋\n\n**How can I help? Ask Keacast anything about your finances or to perform a task.**', raw: responseWithTools };
    } catch (error) {
      console.log('Tool-based response failed, trying direct response...');
      try {
        const directResponse = await queryAzureOpenAI(messages, { tools: functionSchemas, tool_choice: 'none' });
        const choice = directResponse?.choices?.[0];
        result = { content: choice?.message?.content || '', raw: directResponse };
      } catch (directError) {
        console.log('All attempts failed, returning error message');
        result = { content: '## ❌ Error\n\n**I apologize, but I encountered an error while processing your request. Please try again.**', raw: null, error: directError };
      }
    }

    const finalText = stripCurrencyCommas(result.content || '');
    const rawText = result.raw;
    const updatedHistory = [
      ...sanitizeMessageArray(history),
      { role: 'user', content: `Here is my user's data:\n${JSON.stringify(userData)}\n 
      
      Here are the latest transactions each transactions has a unique id, date, amount, and description:\n${JSON.stringify(transactions)}` },
      { role: 'assistant', content: finalText }
    ].slice(-MAX_MEMORY);

    try {
      await redis.set(sessionKey, JSON.stringify(updatedHistory), 'EX', MEMORY_TTL);
      console.log('Analyze transactions: Saved updated history to Redis');
    } catch (redisError) {
      console.warn('Analyze transactions: Failed to save history to Redis:', redisError.message);
    }

    // Enforce response length limit of 300 characters (API contract)
    const limitedInsights = truncateText(finalText, 300);
    res.json({ insights: finalText, raw: rawText, error: result?.error });

  } catch (error) {
    console.error('Analyze transactions error:', error);
    console.error('Error stack:', error.stack);
    
    // Handle specific error types
    if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'Service temporarily unavailable - Redis connection failed' });
    }
    if (error.response?.status === 401) {
      return res.status(401).json({ error: 'Azure OpenAI authentication failed' });
    }
    if (error.response?.status === 400) {
      return res.status(400).json({ 
        error: 'Azure OpenAI request failed', 
        details: error.response?.data?.error?.message || 'Invalid request format',
        suggestion: 'Check API configuration and request format'
      });
    }
    if (error.response?.status === 429) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    
    // Generic error for other cases
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message || 'Unknown error occurred'
    });
  }
};

// ----------------------------
// 📊 Summarization endpoint (read-only, does not update history)
// ----------------------------
exports.summarization = async (req, res) => {
  try {
    console.log('Summarization endpoint called');

    // ── Phase 1: Parse identity + optional fallback payload ───────────────
    // The frontend sends `accountId` (camelCase) — see profile.component.ts ->
    // openaiService.summarization(...). We also accept lowercase `accountid`
    // to stay consistent with the chat endpoint above, just in case any other
    // caller follows that convention. The bulky transaction/balance arrays
    // remain accepted purely as a graceful fallback for older clients (the
    // backend now self-serves them via the keacast tool layer).
    const accountId = req.body?.accountId ?? req.body?.accountid ?? null;
    const userDataFromBody = req.body?.userData;
    const clientDate = req.body?.clientDate || moment().format('YYYY-MM-DD');
    const accountSnapshot = req.body?.accountSnapshot;
    const fallbackBody = {
      plaidTransactions: req.body?.plaidTransactions,
      forecastedTransactions: req.body?.forecastedTransactions,
      balances: req.body?.balances,
    };
    
    const sessionKey = buildSessionKey(req);
    const { token, userId, authHeader } = extractAuthFromRequest(req);

    // ── Phase 2: Resolve the account blob ────────────────────────────────
    // Resolution order (fastest → slowest):
    //   1. accountSnapshot in the request body — the frontend already
    //      rendered the dashboard so it has every precomputed field
    //      (balance/available/savings/futureNegativeBalances/recents/etc.).
    //      Sending a 1–2 KB snapshot is ~50× faster than re-fetching.
    //   2. Tool-layer fetch — for callers (older clients, server-to-server
    //      jobs) that don't pre-populate a snapshot. /account/selected is
    //      heavy so we cache the response for 5 minutes.
    //   3. Legacy req.body arrays — last-resort minimum-viable context.
    let selectedAccount = null;
    let selectedAccountSource = 'none';

    if (
      accountSnapshot &&
      typeof accountSnapshot === 'object' &&
      (accountSnapshot.accountid !== undefined || typeof accountSnapshot.balance === 'number')
    ) {
      selectedAccount = accountSnapshot;
      selectedAccountSource = 'snapshot';
      console.log(
        'Summarization: Using accountSnapshot from request body — recents:',
        Array.isArray(accountSnapshot.recents) ? accountSnapshot.recents.length : 0,
        'upcoming:',
        Array.isArray(accountSnapshot.upcoming) ? accountSnapshot.upcoming.length : 0,
        'savings:', !!accountSnapshot.savings
      );
    }

    if (!selectedAccount && userId && token && accountId) {
      const toolCacheKey = selectedAccountToolCacheKey(userId, accountId);
      try {
        const cached = await redis.get(toolCacheKey);
        if (cached) {
          selectedAccount = JSON.parse(cached);
          selectedAccountSource = 'tool-cache';
          console.log('Summarization: Using cached selected-account blob (5min TTL) for account', accountId);
        }
      } catch (e) {
        console.warn('Summarization: Tool-layer cache read failed:', e.message);
      }

      if (!selectedAccount) {
        try {
          console.log('Summarization: Fetching selected account via tool layer for', userId, accountId);
          const t0 = Date.now();
          selectedAccount = await functionMap.getSelectedAccount({
            userId,
            accountId,
            token,
            body: { clientDate },
            timeoutMs: SELECTED_ACCOUNT_TOOL_TIMEOUT_MS,
          });
          console.log('Summarization: Tool-layer fetch completed in', Date.now() - t0, 'ms');
          selectedAccountSource = 'tool-fresh';
          if (selectedAccount && typeof selectedAccount === 'object') {
            try {
              await redis.set(toolCacheKey, JSON.stringify(selectedAccount), 'EX', SELECTED_ACCOUNT_TOOL_TTL);
            } catch (e) {
              console.warn('Summarization: Tool-layer cache write failed:', e.message);
            }
          }
        } catch (toolErr) {
          // Surface enough detail to actually diagnose this in production logs:
          // status code, response body snippet, and whether axios timed out.
          const status = toolErr?.response?.status;
          const data = toolErr?.response?.data;
          console.warn(
            'Summarization: Tool-layer fetch failed —',
            'code:', toolErr?.code,
            'status:', status,
            'message:', toolErr?.message,
            'body:', typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data || {}).slice(0, 200)
          );
          selectedAccount = null;
        }
      }
    }

    if (!selectedAccount) {
      console.log(
        'Summarization: No accountSnapshot or tool-layer data — falling back to legacy req.body arrays.',
        'plaid:', Array.isArray(fallbackBody.plaidTransactions) ? fallbackBody.plaidTransactions.length : 0,
        'forecast:', Array.isArray(fallbackBody.forecastedTransactions) ? fallbackBody.forecastedTransactions.length : 0,
        'balances:', Array.isArray(fallbackBody.balances) ? fallbackBody.balances.length : 0
      );
    }

    // ── Phase 3: Build the prompt from precomputed signals ───────────────
    // Built BEFORE the cache key so the key can be a hash of the exact prompt
    // text (see Phase 4). The user content hands the model fully-formatted,
    // labelled numbers (including server-computed net cash flow, next income,
    // largest upcoming expense, and top spending) so its only job is wording.
    const firstName = coerceFirstName(userDataFromBody, selectedAccount?.user || null);
    const userContent = buildSummarizationUserContent(selectedAccount, firstName, fallbackBody, { today: clientDate });

    const systemPrompt = `You are Kea, the Keacast assistant — a casual, supportive financial buddy.
Write 5-8 short sentences (≤900 chars total) addressing the user by FIRST NAME.
Goal: help them feel informed, clear on what's coming, and slightly excited to plan ahead.

HARD RULES — the user already saw this data, they will catch any drift:
1. Every dollar amount you mention must appear verbatim in the data block. Do not add, subtract, average, or aggregate amounts — every figure you'd need (including "net cash flow") is already computed and labelled for you.
2. Every date or time window you mention must appear verbatim in the data block. NEVER infer "by month-end", "by Friday", "this weekend", or any deadline that isn't explicitly written. If you mention timing, copy a label from the data word-for-word ("next 14 days", "today", "Jun 12", "end of May", "last 30 days").
3. Pair each amount with the same label it has in the data. Do NOT translate "Next 14 days totals: expenses $X" into "$X due by [some date]". Do NOT translate "Lowest projected balance through end of May" into a deadline.
4. Only call something "no income" if the relevant labelled income figure literally shows $0. Otherwise stay neutral on income.
5. If "Future days the projected balance goes negative" is present, lead with the soonest entry verbatim — that is the strongest heads-up signal — and, when present, pair it with "Next expected income" so they know when relief arrives.

WHAT TO COVER (only when the matching label is present — skip silently otherwise):
- The short-term outlook: current/available balance and the "Next 14 days" income, expenses, and net cash flow.
- Any upcoming negative-balance day (soonest first) and the next expected income.
- The largest upcoming expense so they can brace for it.
- One brief, grounded observation about "Top spending (last ~30 days)" if present.
- End with ONE concrete, encouraging next step that references a labelled amount/date verbatim (e.g. staying above the lowest projected balance, or covering the largest upcoming expense before it hits).

STYLE:
- Casual, warm, forward-looking. Plain prose. No headings, no bullets, no markdown beyond light emphasis.
- Use $ for amounts, leading "-" for negatives. Round to whole dollars unless < $10.
- Always include at least one concrete amount + one verbatim date or window from the data.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      // NOTE: history intentionally NOT injected. This endpoint is documented
      // as read-only / non-mutating, so polluting the prompt with prior chat
      // turns wastes tokens AND can derail the strict format above.
      { role: 'user', content: userContent }
    ];

    console.log('Summarization: prompt sizes — system:', systemPrompt.length, 'chars, user:', userContent.length, 'chars');

    // ── Phase 4: Content-addressed cache key + check ─────────────────────
    // The key hashes the EXACT prompt (system + user), so the cache is reused
    // only when the generated summary would be identical. Any change in the
    // data, the "Today" date, or the prompt wording yields a new key — this is
    // what eliminates the stale-summary problem the old length-only account
    // fingerprint caused.
    const cacheKey = buildSummarizationCacheKeyFromContent(
      sessionKey,
      accountId,
      `${systemPrompt}\n---\n${userContent}`
    );
    console.log('Summarization: cache key:', cacheKey, '(accountId:', accountId, ', source:', selectedAccountSource, ')');

    try {
      const cachedResult = await redis.get(cacheKey);
      if (cachedResult) {
        console.log('Summarization: Returning cached result for account', accountId);
        const cachedData = JSON.parse(cachedResult);
        return res.json({
          summary: cachedData.summary,
          raw: cachedData.raw,
          cached: true,
          note: 'This summary was retrieved from cache (5 minute TTL, content-addressed)'
        });
      }
    } catch (cacheError) {
      console.warn('Summarization: Cache read failed, proceeding with fresh generation:', cacheError.message);
    }

    // ── Phase 6: LLM call ────────────────────────────────────────────────
    // - tool_choice 'none' + tools: [] keeps the request body lean (no
    //   function schemas attached, ~2-4KB saved per request).
    // - AZURE_OPENAI_DEPLOYMENT_LIGHT lets ops point this endpoint at a
    //   smaller/cheaper model; falls back to the global deployment.
    let result;
    try {
      const directResponse = await queryAzureOpenAI(messages, { 
        tools: [],
        tool_choice: 'none',
        // Lower temperature than typical chat: we want the model to stick
        // closely to the labels in the data block rather than improvise
        // creative phrasings like "due by May 31" out of a generic figure.
        temperature: 0.25,
        // ~900 char budget → allow headroom for the richer 5-8 sentence brief.
        max_tokens: 320,
        timeout: 15000,
        deployment: process.env.AZURE_OPENAI_DEPLOYMENT_LIGHT || undefined,
      });
      const choice = directResponse?.choices?.[0];
      result = { content: choice?.message?.content || '', raw: directResponse };
    } catch (directError) {
      console.log('Summarization: LLM call failed, returning error message:', directError?.message);
      result = {
        content: `Hey ${firstName}, I couldn't pull together a fresh summary right now — give it another shot in a minute.`,
        raw: null,
        error: directError
      };
    }

    const finalText = stripCurrencyCommas(result.content || '');
    const rawText = result.raw;

    // ── Phase 7: Cache the result ────────────────────────────────────────
    if (!result?.error && finalText) {
      try {
        const cacheData = {
          summary: finalText,
          raw: rawText,
          timestamp: new Date().toISOString()
        };
        await redis.set(cacheKey, JSON.stringify(cacheData), 'EX', SUMMARIZATION_CACHE_TTL);
        console.log('Summarization: Cached result for', SUMMARIZATION_CACHE_TTL, 'seconds (account:', accountId, ')');
      } catch (cacheError) {
        console.warn('Summarization: Failed to cache result:', cacheError.message);
        // Continue even if caching fails
      }
    }

    // NOTE: This function does NOT update the message history in Redis.
    // It is read-only and only provides a summary without affecting conversation state.

    res.json({ 
      summary: finalText, 
      raw: rawText, 
      error: result?.error,
      cached: false,
      note: `Summary generated (source: ${selectedAccountSource})`
    });

  } catch (error) {
    console.error('Summarization error:', error);
    console.error('Error stack:', error.stack);
    
    // Handle specific error types
    if (error.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'Service temporarily unavailable - Redis connection failed' });
    }
    if (error.response?.status === 401) {
      return res.status(401).json({ error: 'Azure OpenAI authentication failed' });
    }
    if (error.response?.status === 400) {
      return res.status(400).json({ 
        error: 'Azure OpenAI request failed', 
        details: error.response?.data?.error?.message || 'Invalid request format',
        suggestion: 'Check API configuration and request format'
      });
    }
    if (error.response?.status === 429) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    
    // Generic error for other cases
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message || 'Unknown error occurred'
    });
  }
};

// ----------------------------
// 🏷️ Auto-categorization endpoint
// ----------------------------

// How long to keep an LLM-derived suggestion in Redis. Auto-categorization is
// merchant + Plaid-signal driven, so a 7-day cache is plenty conservative —
// the same merchant repeats constantly during reconcile sessions and we don't
// need to round-trip OpenAI for every duplicate.
// Fast-path results (pure deterministic logic — cheap to recompute) expire in
// 24 h so that user corrections propagate within a day without an explicit
// cache flush. LLM results (expensive) keep the 7-day TTL.
const AUTOCATEGORIZE_CACHE_TTL_FAST = 60 * 60 * 24;        // 24 hours
const AUTOCATEGORIZE_CACHE_TTL      = 60 * 60 * 24 * 7;    // 7 days
// Total cap on items handed to the LLM after pickRelevantHistory ranks by
// merchant > Plaid PFC > user category. Bumped from 12 → 100 to give the
// model richer context for ambiguous merchants. Each item is compacted
// (description trimmed to 80 chars) so 100 items lands in the ballpark of
// ~3–4K prompt tokens — well within the deployment's context budget.
const AUTOCATEGORIZE_HISTORY_LIMIT = 100;
const AUTOCATEGORIZE_TIMEOUT_MS = 10000;

// Always returns a non-empty string. Used at every site that produces
// `suggestedCategory` so the frontend (which assigns directly into
// plaid.category and then does .includes(...)) can never receive null,
// undefined, or an object.
function coerceToString(value, fallback = 'Uncategorized') {
  if (value === undefined || value === null) return String(fallback);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // For category-shaped objects we surface .name; for everything else fall back.
  if (typeof value === 'object' && typeof value.name === 'string' && value.name.trim()) {
    return value.name;
  }
  return String(fallback);
}

// User category items can arrive as either DB rows ({ name, description, ... })
// or as plain strings. Normalize to a single shape with a guaranteed string name.
function extractCategoryName(cat) {
  if (!cat) return '';
  if (typeof cat === 'string') return cat.trim();
  if (typeof cat.name === 'string') return cat.name.trim();
  if (typeof cat.display_name === 'string') return cat.display_name.trim();
  return '';
}

// Strip wrapping quotes/backticks/whitespace that low-temperature models
// frequently add (often because the prompt's example shows `"Groceries"`).
function stripWrappingQuotes(str) {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();
}

// Lowercased, alphanumeric-only merchant key. Stable across whitespace,
// punctuation, and common Plaid noise like trailing store numbers.
//
// Runs the raw name through the shared vendor normalizer FIRST (alias map +
// brand-root folding) so brand variants collapse to one key before we strip to
// alphanumerics. e.g. "AMZN Mktp US*2T4...", "Amazon.com", "AMAZON PRIME" all
// resolve to `amazon`; "COSTCO GAS #421" and "Costco gas" both to `costco`.
// This is what makes the merchant-history bucket (summarizeMerchantHistory,
// pickRelevantHistory) and the per-merchant cache slot far stronger.
function normalizeMerchantName(name) {
  if (!name || typeof name !== 'string') return '';
  const merged = mergeVendorName(name);
  const key = (merged || name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 64);
  return key;
}

// Plaid sends `personal_finance_category` as `{ primary, detailed, confidence_level }`.
// This is the highest-quality categorization signal Plaid offers; surface it
// safely (Plaid sometimes sends `{}` for legacy items).
function pickPfcSignals(transaction) {
  const pfc = transaction?.personal_finance_category;
  if (!pfc || typeof pfc !== 'object') return { primary: '', detailed: '', confidence: '' };
  return {
    primary: typeof pfc.primary === 'string' ? pfc.primary : '',
    detailed: typeof pfc.detailed === 'string' ? pfc.detailed : '',
    confidence: typeof pfc.confidence_level === 'string' ? pfc.confidence_level : ''
  };
}

// Cache-key shape: autocat:u<userId>:a<accountId>:m<merchant>:p<pfc.detailed-or-legacy-cat>
// Including userId+accountId scopes invalidation; including PFC means a
// merchant that legitimately spans categories (e.g. Walmart for groceries vs
// Walmart for electronics) gets distinct cache slots.
function buildAutoCategorizationCacheKey({ userId, accountId, transaction }) {
  const u = userId !== undefined && userId !== null && userId !== '' ? String(userId) : 'anon';
  const a = accountId !== undefined && accountId !== null && accountId !== '' ? String(accountId) : 'noacct';
  const merchant = normalizeMerchantName(
    transaction?.merchant_name || transaction?.counterparties?.[0]?.name || transaction?.name
  ) || 'nomerchant';
  const pfc = pickPfcSignals(transaction);
  const legacyCat = Array.isArray(transaction?.category) ? transaction.category[0] : transaction?.category;
  const pfcSeg = (pfc.detailed || pfc.primary || legacyCat || 'nopfc')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .slice(0, 64);
  return `autocat:u${u}:a${a}:m${merchant}:p${pfcSeg}`;
}

// Single source of truth for "what merchant is this transaction?" — the
// frontend / Plaid both populate these fields inconsistently across providers
// (Plaid sets `merchant_name`, MX often only sets `name`, manual entries
// sometimes only set `display_name`). Resolving in this order means a
// hand-entered "Costco gas" still pulls the same history bucket as the
// Plaid-named "COSTCO GAS #421".
function getMerchantKey(item) {
  if (!item || typeof item !== 'object') return '';
  return normalizeMerchantName(
    item.merchant_name || item.display_name || item.name
  );
}

function getLegacyCategory(item) {
  if (!item || typeof item !== 'object') return '';
  const cat = Array.isArray(item.category) ? item.category[0] : item.category;
  return cat ? String(cat) : '';
}

// Returns the user's actual assigned category for a transaction history item.
// Prefers `adjusted_category` (set by the app after reconciliation / mapping)
// over `user_category` (explicit rename) over the raw `category` field.
//
// This is the field to use whenever you want to learn "what did the user
// decide this transaction belongs to?" — NOT the raw Plaid legacy category
// (which is what getLegacyCategory returns and is used only as a Plaid signal).
function getUserCategory(item) {
  if (!item || typeof item !== 'object') return '';
  const uc = item.adjusted_category || item.user_category;
  if (uc && typeof uc === 'string' && uc.trim()) return uc.trim();
  // Fallback: if no explicit user-assigned field, use the stored category
  // string (which for DB-backed transactions IS the user-assigned name).
  return getLegacyCategory(item);
}

function getNumericAmount(item) {
  const n = typeof item?.amount === 'number' ? item.amount : Number(item?.amount);
  return Number.isFinite(n) ? n : null;
}

// "Did the user pay roughly the same dollar amount?" — used as a strong
// matching signal alongside merchant. Tolerance is generous (±25%) plus a
// $5 floor so $9.99 vs $11.49 still matches. Sign must match (we never want
// to confuse a refund for a charge or vice versa).
function amountWithinBucket(target, candidate, pct = 0.25, floor = 5) {
  if (!Number.isFinite(target) || !Number.isFinite(candidate)) return false;
  if (Math.sign(target) !== Math.sign(candidate)) return false;
  const tol = Math.max(Math.abs(target) * pct, floor);
  return Math.abs(target - candidate) <= tol;
}

// Build a tiny, high-signal summary of how the user has historically
// categorized transactions from the SAME merchant. This is the single most
// useful hint for the LLM — far more compact than dumping a dozen history
// rows and far more directly answers the question "what does this user
// usually do here?".
//
// Returns null when there's no merchant or no history matches.
function summarizeMerchantHistory(transaction, history) {
  const target = getMerchantKey(transaction);
  if (!target || !Array.isArray(history) || history.length === 0) return null;

  const matches = history.filter((it) => getMerchantKey(it) === target);
  if (matches.length === 0) return null;

  // Tally categories with O(n) scan.
  // getUserCategory prefers the user's assigned category (adjusted_category)
  // over the raw Plaid legacy field so the summary reflects what the user
  // actually chose, not what Plaid labelled.
  const counts = new Map();
  const amounts = [];
  for (const m of matches) {
    const cat = getUserCategory(m);
    if (cat) counts.set(cat, (counts.get(cat) || 0) + 1);
    const amt = getNumericAmount(m);
    if (amt !== null) amounts.push(amt);
  }

  let topCategory = '';
  let topCount = 0;
  for (const [cat, count] of counts.entries()) {
    if (count > topCount) {
      topCount = count;
      topCategory = cat;
    }
  }

  // Sort amounts and grab a few for the LLM to see typical price points.
  amounts.sort((a, b) => a - b);
  const sampleAmounts = amounts.length <= 3
    ? amounts
    : [amounts[0], amounts[Math.floor(amounts.length / 2)], amounts[amounts.length - 1]];

  const targetAmt = getNumericAmount(transaction);
  const inTypicalRange = targetAmt !== null && amounts.length > 0
    ? amounts.some((a) => amountWithinBucket(targetAmt, a))
    : null;

  return {
    merchant_key: target,
    total_seen: matches.length,
    top_category: topCategory || null,
    top_category_count: topCount || 0,
    unanimous: !!topCategory && topCount === matches.length,
    sample_amounts: sampleAmounts,
    target_amount_in_typical_range: inTypicalRange,
  };
}

// Rather than dumping 50–200 random recent transactions into the prompt, pick
// only the items that ACTUALLY help. Ranking order (highest signal first):
//   1. Same merchant + amount-within-bucket  ← the user's strongest pattern
//   2. Same merchant (any amount)
//   3. Same Plaid PFC detailed code
//   4. Same user-assigned category (getUserCategory — the user's actual choice)
// Each pass runs against the same dedup `seen` set so we never count an item
// twice and the order in `out` reflects the ranking — that's what the LLM
// reads top-down.
function pickRelevantHistory(transaction, history) {
  if (!Array.isArray(history) || history.length === 0) return [];

  const targetMerchant = getMerchantKey(transaction);
  const targetPfcDetailed = pickPfcSignals(transaction).detailed;
  const targetUserCategory = getUserCategory(transaction);
  const targetAmount = getNumericAmount(transaction);

  const seen = new Set();
  const out = [];
  const push = (item, matchedOn) => {
    // Dedup key includes user-assigned category so two rows from the same
    // merchant/amount that the user categorised differently are both kept —
    // they carry independent signals about category ambiguity.
    const key = `${getMerchantKey(item)}|${item?.amount}|${getUserCategory(item)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: item?.name || item?.display_name || '',
      display_name: item?.display_name || undefined,
      merchant: item?.merchant_name || '',
      amount: getNumericAmount(item),
      // user_category is what the user actually chose — primary learning signal.
      user_category: getUserCategory(item) || undefined,
      // plaid_category is the raw Plaid legacy field — kept as a Plaid signal.
      plaid_category: getLegacyCategory(item) || undefined,
      pfc_detailed: pickPfcSignals(item).detailed || undefined,
      // Trim description aggressively — most of the value is in the first 80 chars.
      description: typeof item?.description === 'string' ? item.description.slice(0, 80) : undefined,
      matched_on: matchedOn,
    });
  };

  // 1. Same merchant + amount-within-bucket — the highest-signal combination.
  //    Capped at ~30% of the total budget so we don't drown out other passes.
  if (targetMerchant && targetAmount !== null) {
    const cap = Math.max(3, Math.ceil(AUTOCATEGORIZE_HISTORY_LIMIT * 0.3));
    for (const item of history) {
      if (out.length >= cap) break;
      if (
        getMerchantKey(item) === targetMerchant &&
        amountWithinBucket(targetAmount, getNumericAmount(item))
      ) {
        push(item, 'merchant+amount');
      }
    }
  }

  // 2. Same merchant (any amount) — still strong, take up to half the budget.
  if (targetMerchant) {
    const cap = Math.max(out.length + 3, Math.ceil(AUTOCATEGORIZE_HISTORY_LIMIT * 0.5));
    for (const item of history) {
      if (out.length >= cap) break;
      if (getMerchantKey(item) === targetMerchant) push(item, 'merchant');
    }
  }

  // 3. Same Plaid PFC detailed code.
  if (targetPfcDetailed) {
    for (const item of history) {
      if (out.length >= AUTOCATEGORIZE_HISTORY_LIMIT) break;
      const itemPfc = pickPfcSignals(item).detailed;
      if (itemPfc && itemPfc === targetPfcDetailed) push(item, 'pfc');
    }
  }

  // 4. Same user-assigned category. Uses getUserCategory on both sides so
  //    this reflects what the user deliberately chose, not the Plaid legacy
  //    label (which differs from the user's taxonomy and made this pass a no-op).
  if (targetUserCategory) {
    for (const item of history) {
      if (out.length >= AUTOCATEGORIZE_HISTORY_LIMIT) break;
      if (getUserCategory(item) === targetUserCategory) push(item, 'user_category');
    }
  }

  return out;
}

exports.autoCategorizeTransaction = async (req, res) => {
  try {
    console.log('Auto-categorize transaction endpoint called');
    const { transaction, transactionHistory, categories } = req.body;
    const userId = req.body?.userId ?? req.body?.sessionId ?? req.user?.id ?? null;
    const accountId = req.body?.accountId ?? req.body?.accountid ?? null;
    
    if (!transaction) {
      console.log('Auto-categorize: Missing transaction in request body');
      return res.status(400).json({ error: 'Transaction is required' });
    }
    
    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      console.log('Auto-categorize: Missing or invalid categories array');
      return res.status(400).json({ error: 'Categories array is required and must not be empty' });
    }

    // Normalize categories ONCE so the rest of the handler operates on
    // guaranteed-string names. This is the single biggest accuracy fix: the
    // old prompt did `categories.map(cat => `- ${cat}`)` which produced
    // `- [object Object]` lines — the model literally couldn't see the
    // user's taxonomy.
    const categoryNames = categories
      .map(extractCategoryName)
      .filter((n) => n && typeof n === 'string');
    const uniqueCategoryNames = Array.from(new Set(categoryNames));
    if (uniqueCategoryNames.length === 0) {
      return res.status(400).json({ error: 'Categories array did not contain any usable names' });
    }
    const firstCategoryName = uniqueCategoryNames[0];

    // Build a quick { lowername -> originalCasedName } lookup for the fast/cache paths.
    const nameByLower = new Map();
    for (const n of uniqueCategoryNames) nameByLower.set(n.toLowerCase(), n);

    // Single source of truth for the response shape. Whatever code path we end
    // up in, we go through this to guarantee `suggestedCategory` is always a
    // non-empty STRING — never an object, null, or undefined.
    const respond = (payload) => {
      const safe = {
        success: true,
        suggestedCategory: coerceToString(payload?.suggestedCategory, firstCategoryName),
        confidence: payload?.confidence || 'low',
        note: payload?.note || '',
        method: payload?.method || 'ai',
      };
      if (payload?.originalSuggestion !== undefined) safe.originalSuggestion = String(payload.originalSuggestion);
      if (payload?.cached) safe.cached = true;
      return res.json(safe);
    };

    console.log(
      'Auto-categorize: Processing transaction:',
      transaction.name || transaction.display_name,
      '| user:', userId, '| account:', accountId,
      '| categories:', uniqueCategoryNames.length
    );

    const cacheKey = buildAutoCategorizationCacheKey({ userId, accountId, transaction });

    // ── 1. Cache check ────────────────────────────────────────────────────
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        const cachedName = coerceToString(parsed?.suggestedCategory, '');
        // The cached value MUST still be valid for THIS user's current
        // category list — categories can be deleted/renamed between calls.
        const cachedLower = cachedName.toLowerCase();
        if (nameByLower.has(cachedLower)) {
          console.log('Auto-categorize: cache hit', cacheKey, '->', cachedName);
          return respond({
            suggestedCategory: nameByLower.get(cachedLower),
            confidence: parsed?.confidence || 'high',
            note: 'Cache hit (autocategorize)',
            method: 'cache',
            cached: true,
          });
        }
        console.log('Auto-categorize: cache hit but value no longer in user categories — refetching');
      }
    } catch (cacheErr) {
      console.warn('Auto-categorize: Redis read failed:', cacheErr.message);
    }

    // ── 2. Fast-path: deterministic merchant/keyword lookup ───────────────
    // Re-enabled. Skips OpenAI entirely when we have a confident answer
    // (~40-60% of real-world transactions in our data).
    try {
      const fastName = categorizeTransactionFast(transaction, categories, transactionHistory);
      if (fastName && nameByLower.has(String(fastName).toLowerCase())) {
        const resolved = nameByLower.get(String(fastName).toLowerCase());
        try {
          // Fast-path results use the shorter TTL (24 h) so user corrections
          // propagate within a day rather than being stuck for a full week.
          await redis.set(
            cacheKey,
            JSON.stringify({ suggestedCategory: resolved, confidence: 'high', via: 'fast-path' }),
            'EX',
            AUTOCATEGORIZE_CACHE_TTL_FAST
          );
        } catch (e) { /* cache failure is non-fatal */ }
        console.log('Auto-categorize: fast-path hit ->', resolved);
        return respond({
          suggestedCategory: resolved,
          confidence: 'high',
          note: 'Category determined using fast pattern matching',
          method: 'fast-path',
        });
      }
    } catch (e) {
      console.warn('Auto-categorize: fast-path threw, ignoring:', e.message);
    }

    // ── 3. LLM with structured tool-call output ───────────────────────────
    // The single tool ensures the model can ONLY return a value from the
    // user's category list — Azure validates the enum before delivering the
    // tool call to us. That eliminates the historical "model wrapped the
    // answer in quotes / hallucinated a category" failure modes entirely.
    const pfc = pickPfcSignals(transaction);
    const counterparty = transaction?.counterparties?.[0] || null;
    const relevantHistory = pickRelevantHistory(transaction, transactionHistory);

    // Build a category list with optional descriptions so the model has
    // semantic context for ambiguous category names (e.g. "Misc" vs "Other").
    const categoryListText = categories
      .map((c) => {
        const name = extractCategoryName(c);
        if (!name) return null;
        const desc = (typeof c === 'object' && typeof c?.description === 'string') ? c.description.trim() : '';
        return desc ? `- ${name} — ${desc}` : `- ${name}`;
      })
      .filter(Boolean)
      .join('\n');

    const merchantSummary = summarizeMerchantHistory(transaction, transactionHistory);

    const systemPrompt =
      `You are a categorization assistant whose primary job is to mirror this user's ` +
      `own habits — not to impose a "correct" category, but to stay consistent with ` +
      `how they have already been categorizing their transactions.\n\n` +
      `STEP 1 — Compare the transaction to the user's history:\n` +
      `Before choosing anything, scan relevant_history and merchant_history_summary to ` +
      `find previously categorized transactions that resemble the current one. ` +
      `Compare across four dimensions in this order:\n` +
      `  a. TITLE — compare transaction.name and transaction.display_name against the ` +
      `name/display_name fields in relevant_history. Exact or near-exact title matches ` +
      `(e.g. "NETFLIX.COM" vs "NETFLIX") are the strongest individual signal. ` +
      `Note that minor title variants from the same merchant (e.g. "AMAZON PRIME" vs ` +
      `"AMAZON MKTP US") can legitimately map to different categories — look for the ` +
      `closest title match, not just the closest merchant match.\n` +
      `  b. AMOUNT — compare transaction.amount to the amounts in relevant_history and ` +
      `merchant_history_summary.sample_amounts. A transaction whose amount falls in the ` +
      `user's typical range for this merchant (target_amount_in_typical_range = true) ` +
      `is very likely the same recurring charge.\n` +
      `  c. FREQUENCY — if merchant_history_summary.total_seen is large (≥ 5) and the ` +
      `amounts are clustered tightly (small variance in sample_amounts), this is a ` +
      `recurring/subscription transaction. Subscriptions and recurring bills have ` +
      `category patterns the user has deliberately set; honour them even when Plaid's ` +
      `PFC suggests something different. A single irregular large amount is more likely ` +
      `a one-off purchase and Plaid's PFC becomes a stronger fallback.\n` +
      `  d. MERCHANT — use merchant_name / merchant_key as a tiebreaker when title and ` +
      `amount don't narrow it down.\n\n` +
      `STEP 2 — Apply signals in strict priority order:\n` +
      `1. merchant_history_summary — if total_seen ≥ 3 and top_category dominates (≥ 70%) ` +
      `and target_amount_in_typical_range is true or null, use top_category. ` +
      `The user has already established their convention for this merchant; follow it.\n` +
      `2. relevant_history matched_on = "merchant+amount" — read the user_category field ` +
      `(the user's confirmed choice) on those rows; same merchant + similar amount is a ` +
      `near-certain repeat, so mirror that user_category directly.\n` +
      `3. relevant_history matched_on = "merchant" — same merchant any amount; use the ` +
      `most frequent user_category seen across those rows.\n` +
      `4. plaid_personal_finance_category (detailed > primary) when confidence is HIGH ` +
      `and the history gives no clear signal.\n` +
      `5. relevant_history matched_on = "pfc" or "user_category" as weak tiebreakers.\n` +
      `Only fall back to general world knowledge when steps 1–5 give nothing useful.\n\n` +
      `IMPORTANT: each relevant_history item has a user_category field — that is what ` +
      `the user actually chose for that transaction and is your primary learning signal. ` +
      `The plaid_category field on history items is Plaid's raw label and may differ ` +
      `from the user's taxonomy; treat it as a weak corroborating signal only.\n\n` +
      `You MUST respond by calling the selectCategory tool — never reply in plain text.`;

    const userPayload = {
      transaction: {
        name: transaction.name || null,
        display_name: transaction.display_name || null,
        amount: transaction.amount ?? null,
        merchant_name: transaction.merchant_name || null,
        description: typeof transaction.description === 'string' ? transaction.description.slice(0, 120) : null,
        location: transaction.location || null,
        payment_channel: transaction.payment_channel || null,
        pending: transaction.pending ?? null,
        legacy_category: transaction.category ?? null,
        plaid_personal_finance_category: pfc.detailed || pfc.primary
          ? { primary: pfc.primary, detailed: pfc.detailed, confidence: pfc.confidence }
          : null,
        plaid_counterparty: counterparty
          ? { name: counterparty.name, type: counterparty.type, confidence: counterparty.confidence_level }
          : null,
      },
      // High-signal precomputed digest of how this user has historically
      // categorized this exact merchant. The model should treat this as
      // near-authoritative when total_seen ≥ 3 and the top category dominates.
      merchant_history_summary: merchantSummary,
      relevant_history: relevantHistory,
    };

    // Compact JSON (no indentation) — the prompt is purely for the model
    // to read, so pretty-printing is a 25-30% pure token tax.
    const userMessage =
      `Categorize this transaction. Choose one category by calling selectCategory.\n\n` +
      `Available categories:\n${categoryListText}\n\n` +
      `Transaction + filtered relevant history (JSON):\n${JSON.stringify(userPayload)}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ];

    const selectCategoryTool = {
      type: 'function',
      function: {
        name: 'selectCategory',
        description:
          'Select exactly one category for this transaction from the provided list. ' +
          'The category MUST be one of the user\'s active categories.',
        parameters: {
          type: 'object',
          properties: {
            category: {
              type: 'string',
              enum: uniqueCategoryNames,
              description: 'The chosen category name. Must match one of the user\'s categories exactly.'
            },
            confidence: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
              description: 'How confident you are in this categorization.'
            },
            reason: {
              type: 'string',
              description: 'A short (<=120 chars) reason for the choice.'
            }
          },
          required: ['category', 'confidence']
        }
      }
    };

    console.log('Auto-categorize: Calling OpenAI with structured tool-call (1 tool, enum:', uniqueCategoryNames.length, 'categories)');

    let toolArgs = null;
    let suggestedCategory = '';
    let suggestedConfidence = 'low';
    let suggestedReason = '';
    let method = 'ai';

    try {
      const response = await queryAzureOpenAI(messages, { 
        // Only ship the single, scoped tool — DO NOT fall back to the global
        // functionSchemas which adds thousands of input tokens for nothing
        // (`tool_choice: 'none'` previously hid them but Azure still bills
        // them as input).
        tools: [selectCategoryTool],
        tool_choice: { type: 'function', function: { name: 'selectCategory' } },
        temperature: 0.1,
        max_tokens: 80,
        timeout: AUTOCATEGORIZE_TIMEOUT_MS,
        // Optional: opt this endpoint into a smaller deployment if the
        // operator has set AZURE_OPENAI_DEPLOYMENT_LIGHT in the env. Falls
        // back to the main deployment otherwise.
        deployment: process.env.AZURE_OPENAI_DEPLOYMENT_LIGHT || undefined,
      });
      
      const choice = response?.choices?.[0];
      const toolCall = choice?.message?.tool_calls?.[0];
      if (toolCall?.function?.arguments) {
        try {
          toolArgs = JSON.parse(toolCall.function.arguments);
        } catch (parseErr) {
          console.warn('Auto-categorize: Tool args JSON parse failed:', parseErr.message);
        }
      }
      if (toolArgs && typeof toolArgs.category === 'string') {
        suggestedCategory = stripWrappingQuotes(toolArgs.category);
        suggestedConfidence = ['high', 'medium', 'low'].includes(toolArgs.confidence)
          ? toolArgs.confidence
          : 'medium';
        suggestedReason = typeof toolArgs.reason === 'string' ? toolArgs.reason.slice(0, 200) : '';
      } else {
        // Older models / older API versions may answer in plain text even
        // when tool_choice is forced. Salvage the content as a best-effort.
        const raw = stripWrappingQuotes(choice?.message?.content || '');
        if (raw && nameByLower.has(raw.toLowerCase())) {
          suggestedCategory = raw;
          suggestedConfidence = 'medium';
          suggestedReason = 'Recovered from plain-text response';
        }
      }
    } catch (llmError) {
      console.log('Auto-categorize: OpenAI call failed, falling back:', llmError?.message);
    }

    // ── 4. Validate / repair the model's choice (always-string) ───────────
    let resolvedName = '';
    if (suggestedCategory) {
      const lower = suggestedCategory.toLowerCase();
      if (nameByLower.has(lower)) {
        resolvedName = nameByLower.get(lower);
      } else {
        // Best-effort closest match: contains-either-way, then return the
        // user's actual cased name (NOT the model's variant).
        const closest = uniqueCategoryNames.find((n) => {
          const nl = n.toLowerCase();
          return nl.includes(lower) || lower.includes(nl);
        });
        if (closest) {
          resolvedName = closest;
          method = 'ai-closest-match';
        }
      }
    }

    // ── 5. Final fallback: deterministic categorizer, then first category ─
    if (!resolvedName) {
      try {
        const fastName = categorizeTransactionFast(transaction, categories, transactionHistory);
        if (fastName && nameByLower.has(String(fastName).toLowerCase())) {
          resolvedName = nameByLower.get(String(fastName).toLowerCase());
          method = 'fallback-fast-path';
          suggestedConfidence = 'low';
        }
      } catch (e) { /* ignore */ }
    }
    if (!resolvedName) {
      resolvedName = firstCategoryName;
      method = 'fallback-default';
      suggestedConfidence = 'low';
    }

    // ── 6. Cache the resolved answer ──────────────────────────────────────
    try {
      await redis.set(
        cacheKey,
        JSON.stringify({
          suggestedCategory: resolvedName,
          confidence: suggestedConfidence,
          via: method,
          reason: suggestedReason,
        }),
        'EX',
        AUTOCATEGORIZE_CACHE_TTL
      );
    } catch (e) { /* cache failure non-fatal */ }

    return respond({
      suggestedCategory: resolvedName,
      confidence: suggestedConfidence,
      note: suggestedReason || (method === 'ai' ? 'Categorized by LLM' : `Resolved via ${method}`),
      method,
      originalSuggestion: suggestedCategory && suggestedCategory.toLowerCase() !== resolvedName.toLowerCase()
        ? suggestedCategory
        : undefined,
    });

  } catch (error) {
    console.error('Auto-categorize transaction error:', error);
    console.error('Error stack:', error.stack);

    // Even on a hard error try to return a usable string so the frontend
    // doesn't crash assigning `result.suggestedCategory` into plaid.category.
    const safeFirst = (() => {
      const arr = req?.body?.categories;
      if (Array.isArray(arr)) {
        for (const c of arr) {
          const n = extractCategoryName(c);
          if (n) return n;
        }
      }
      return 'Uncategorized';
    })();
    
    res.status(500).json({ 
      success: false,
      error: 'Internal server error',
      details: error.message || 'Unknown error occurred',
      suggestedCategory: coerceToString(safeFirst, 'Uncategorized'),
      confidence: 'low',
      method: 'error-fallback',
    });
  }
};

// POST /auto-categorize/invalidate
//
// Evicts the specific Redis cache slot for a single transaction. Call this
// from the frontend whenever the user explicitly overrides the suggested
// category so the next reconcile for the same merchant gets a fresh answer
// rather than serving the stale cached suggestion for up to 7 days.
//
// Body: same shape as /auto-categorize — { transaction, userId, accountId }
exports.invalidateAutoCategorizationKey = async (req, res) => {
  try {
    const { transaction } = req.body;
    const userId    = req.body?.userId ?? req.body?.sessionId ?? req.user?.id ?? null;
    const accountId = req.body?.accountId ?? req.body?.accountid ?? null;

    if (!transaction) {
      return res.status(400).json({ error: 'transaction is required' });
    }

    const cacheKey = buildAutoCategorizationCacheKey({ userId, accountId, transaction });
    const deleted  = await redis.del(cacheKey);

    console.log('Auto-categorize: invalidated cache key', cacheKey, '— deleted:', deleted);
    return res.json({ success: true, invalidated: deleted > 0, key: cacheKey });
  } catch (err) {
    console.error('Auto-categorize invalidate error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// Maps Plaid `personal_finance_category.detailed` (and `.primary`) codes
// directly to the application's seeded category names. Values must match
// the user's taxonomy exactly (case-insensitive) so findCategoryForBucket
// can do an exact lookup rather than a fragile fuzzy-includes search.
//
// Previously these values used generic English labels ('groceries',
// 'healthcare', 'shopping') that did NOT match the seeded names ('Groceries',
// 'Health', 'Retail'), causing the PFC fast-path to return null for a large
// fraction of transactions even when Plaid had a perfect HIGH-confidence signal.
const PLAID_PFC_TO_BUCKET = {
  // ── Food & Drink ────────────────────────────────────────────────────────
  FOOD_AND_DRINK_GROCERIES:                      'Groceries',
  FOOD_AND_DRINK_RESTAURANTS:                    'Restaurants',
  FOOD_AND_DRINK_RESTAURANT:                     'Restaurants',   // older Plaid enum variant
  FOOD_AND_DRINK_FAST_FOOD:                      'Restaurants',
  FOOD_AND_DRINK_COFFEE:                         'Restaurants',
  FOOD_AND_DRINK_BEER_WINE_LIQUOR:               'Food and Beverage',
  FOOD_AND_DRINK:                                'Food and Beverage',

  // ── General Merchandise ─────────────────────────────────────────────────
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES:  'Clothing',
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES:       'Online',
  GENERAL_MERCHANDISE_PET_SUPPLIES:              'Pets',
  GENERAL_MERCHANDISE_ELECTRONICS:              'Retail',
  GENERAL_MERCHANDISE_DEPARTMENT_STORES:         'Retail',
  GENERAL_MERCHANDISE_DISCOUNT_STORES:           'Retail',
  GENERAL_MERCHANDISE:                           'Retail',

  // ── General Services ────────────────────────────────────────────────────
  GENERAL_SERVICES_INSURANCE:                    'Insurance',
  GENERAL_SERVICES_SUBSCRIPTION:                 'Subscriptions',
  GENERAL_SERVICES_CHILDCARE:                    'Childcare',
  GENERAL_SERVICES:                              'Services',

  // ── Home Improvement / Rent & Utilities ─────────────────────────────────
  HOME_IMPROVEMENT_HARDWARE:                     'Household',
  HOME_IMPROVEMENT_FURNITURE:                    'Household',
  HOME_IMPROVEMENT:                              'Household',
  RENT_AND_UTILITIES_RENT:                       'Household',
  RENT_AND_UTILITIES_TELEPHONE_SERVICE:          'Phone',
  RENT_AND_UTILITIES_TELEPHONE:                  'Phone',
  RENT_AND_UTILITIES_INTERNET_AND_CABLE:         'Online',
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY:        'Utilities',
  RENT_AND_UTILITIES_WATER:                      'Utilities',
  RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT:'Utilities',
  RENT_AND_UTILITIES:                            'Utilities',

  // ── Entertainment ───────────────────────────────────────────────────────
  ENTERTAINMENT_TV_AND_MOVIES:                   'Subscriptions',
  ENTERTAINMENT_MUSIC_AND_AUDIO:                 'Subscriptions',
  ENTERTAINMENT_GYMS_AND_FITNESS_CENTERS:        'Health',
  ENTERTAINMENT_VIDEO_GAMES:                     'Entertainment',
  ENTERTAINMENT_CASINOS_AND_GAMBLING:            'Entertainment',
  ENTERTAINMENT_SPORTING_EVENTS:                 'Entertainment',
  ENTERTAINMENT:                                 'Entertainment',

  // ── Personal Care ───────────────────────────────────────────────────────
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS:        'Health',
  PERSONAL_CARE_HAIR_AND_BEAUTY:                 'Personal Care',
  PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING:        'Personal Care',
  PERSONAL_CARE:                                 'Personal Care',

  // ── Medical ─────────────────────────────────────────────────────────────
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS:            'Health',
  MEDICAL_PRIMARY_CARE:                          'Health',
  MEDICAL_DENTAL_CARE:                           'Health',
  MEDICAL_EYE_CARE:                              'Health',
  MEDICAL_MENTAL_HEALTH:                         'Health',
  MEDICAL:                                       'Health',

  // ── Transportation ──────────────────────────────────────────────────────
  TRANSPORTATION_GAS_STATION:                    'Automotive',
  TRANSPORTATION_GAS:                            'Automotive',   // older variant
  TRANSPORTATION_PUBLIC_TRANSIT:                 'Transportation',
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES:          'Transportation',
  TRANSPORTATION_PARKING:                        'Transportation',
  TRANSPORTATION:                                'Transportation',

  // ── Travel ──────────────────────────────────────────────────────────────
  TRAVEL_FLIGHTS:                                'Travel',
  TRAVEL_LODGING:                                'Travel',
  TRAVEL_RENTAL_CARS:                            'Travel',
  TRAVEL:                                        'Travel',

  // ── Education ───────────────────────────────────────────────────────────
  EDUCATION:                                     'Education',

  // ── Bank Fees / Tax / Government ────────────────────────────────────────
  BANK_FEES:                                     'Bank Fees',
  TAX:                                           'Taxes',
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT:         'Taxes',
  GOVERNMENT_AND_NON_PROFIT_DONATIONS:           'Charity',

  // ── Loan Payments ───────────────────────────────────────────────────────
  LOAN_PAYMENTS_MORTGAGE_PAYMENT:                'Mortgage',
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT:             'Transfer-Out',
  LOAN_PAYMENTS:                                 'Loan',

  // ── Transfers ───────────────────────────────────────────────────────────
  TRANSFER_OUT_SAVINGS:                          'Savings',
  TRANSFER_OUT_ACCOUNT_TRANSFER:                 'Transfer-Out',
  TRANSFER_OUT:                                  'Transfer-Out',
  TRANSFER_IN_ACCOUNT_TRANSFER:                  'Transfer-In',
  TRANSFER_IN:                                   'Transfer-In',

  // ── Income ──────────────────────────────────────────────────────────────
  INCOME_WAGES:                                  'Salary',
  INCOME_DIVIDENDS:                              'Dividend',
  INCOME_INTEREST_EARNED:                        'Interest',
  INCOME_TAX_REFUND:                             'Reimbursement',
  INCOME:                                        'Income',
};

// Fast categorization using pattern matching (no AI needed). Always returns
// either a non-empty string OR null (the AI path uses null as the signal to
// continue). The autoCategorizeTransaction handler converts null/empty
// results into a stable string before responding to the client.
function categorizeTransactionFast(transaction, categories, transactionHistory) {
  // Defensive guards so the function never throws on a malformed payload.
  if (!transaction || !Array.isArray(categories) || categories.length === 0) return null;

  const transactionText = `${transaction.name || ''} ${transaction.display_name || ''} ${transaction.merchant_name || ''} ${transaction.description || ''}`.toLowerCase();
  
  // Helper: find a user category by case-insensitive name match.
  const findUserCategoryByName = (name) => {
    if (!name) return null;
    const target = String(name).toLowerCase();
    return categories.find((cat) => extractCategoryName(cat).toLowerCase() === target) || null;
  };

  // -1. Authoritative user-history short-circuit. If the user has categorized
  //     this same merchant 3+ times AND ≥70% of those rows agree on a single
  //     category AND the target amount is in the typical range for that
  //     merchant, we trust the user's prior choice. This is the strongest
  //     possible signal — it directly mirrors what the user already does.
  const merchantSummary = summarizeMerchantHistory(transaction, transactionHistory);
  if (
    merchantSummary &&
    merchantSummary.total_seen >= 3 &&
    merchantSummary.top_category &&
    merchantSummary.top_category_count >= 3 &&
    merchantSummary.top_category_count / merchantSummary.total_seen >= 0.7 &&
    // amount_in_typical_range is `null` when target amount is missing — treat
    // null as "no objection" rather than "fail" so we don't punish manual
    // entries lacking a clean numeric amount.
    merchantSummary.target_amount_in_typical_range !== false
  ) {
    const matched = findUserCategoryByName(merchantSummary.top_category);
    if (matched) return extractCategoryName(matched);
  }

  // 0. Plaid PFC short-circuit. Highest-quality signal Plaid offers.
  const pfc = pickPfcSignals(transaction);
  const pfcBucketHint =
    PLAID_PFC_TO_BUCKET[pfc.detailed] ||
    PLAID_PFC_TO_BUCKET[pfc.primary] ||
    null;
  
  // High-confidence merchant string patterns. Keys must be seeded category
  // names (case-insensitive match) so findCategoryForBucket can do an exact
  // lookup. Previously these used generic English bucket names ('gas',
  // 'healthcare', 'shopping') that didn't match the seeded taxonomy ('Automotive',
  // 'Health', 'Retail'), causing the merchant fast-path to silently miss matches.
  const highConfidencePatterns = {
    'Groceries': [
      'whole foods', 'trader joe', 'kroger', 'safeway', 'albertsons', 'publix', 'wegmans', 'food lion', 'giant eagle', 'shoprite', 'stop & shop',
      'sprouts', 'fresh market', 'natural grocers', 'earth fare', 'fresh thyme', 'lucky', 'ralphs', 'vons', 'food 4 less', 'winco', 'aldi', 'lidl',
      'heb', 'meijer', 'hy-vee', 'price chopper', 'tops', 'giant', 'martins', 'weis', 'acme', 'shaws', 'hannaford', 'price rite', 'save a lot'
    ],
    'Automotive': [
      'shell', 'exxon', 'chevron', 'bp', 'mobil', 'petro', 'marathon', 'sunoco', 'valero', '76', 'arco', 'phillips 66', 'conoco', 'citgo',
      'speedway', 'circle k', '7-eleven', 'quik trip', 'kum & go', 'caseys', 'wawa', 'sheet', 'love', 'murphy', 'race trac', 'pilot', 'flying j',
      'autozone', 'oreilly', 'advance auto', 'napa', 'pep boys', 'firestone', 'goodyear', 'bridgestone', 'michelin', 'jiffy lube',
      'valvoline', 'quick lube', 'mavis', 'discount tire', 'tire kingdom', 'les schwab', 'big o tires', 'tire rack'
    ],
    'Restaurants': [
      'mcdonalds', 'burger king', 'wendys', 'subway', 'dominos', 'pizza hut', 'chipotle', 'panera', 'starbucks', 'dunkin', 'doordash', 'uber eats', 'grubhub',
      'taco bell', 'kfc', 'popeyes', 'chick-fil-a', 'in-n-out', 'five guys', 'shake shack', 'whataburger', 'culvers', 'sonic', 'arbys', 'jack in the box',
      'papa johns', 'little caesars', 'papa murphys', 'blaze pizza', 'mod pizza', 'pizza ranch', 'postmates', 'seamless', 'caviar', 'bite squad'
    ],
    'Utilities': [
      'pg&e', 'southern california edison', 'conedison', 'duke energy', 'dominion energy', 'exelon', 'nextera', 'firstenergy', 'pacificorp', 'xcel energy',
      'entergy', 'southern company', 'american electric power', 'centerpoint energy', 'comed', 'pepco', 'bge', 'pseg', 'national grid', 'eversource'
    ],
    'Transportation': [
      'uber', 'lyft', 'taxi', 'amtrak', 'greyhound', 'metropolitan transportation authority', 'chicago transit authority', 'los angeles metro',
      'bay area rapid transit', 'washington metropolitan area transit authority', 'septa', 'mbta', 'nj transit', 'metro-north', 'long island railroad'
    ],
    'Health': [
      'cvs', 'walgreens', 'rite aid', 'kroger pharmacy', 'walmart pharmacy', 'costco pharmacy', 'target pharmacy', 'safeway pharmacy',
      'albertsons pharmacy', 'publix pharmacy', 'wegmans pharmacy', 'giant eagle pharmacy', 'shoprite pharmacy', 'stop & shop pharmacy',
      'planet fitness', 'la fitness', '24 hour fitness', 'equinox', 'lifetime fitness', 'ymca', 'ymwca', 'golds gym', 'crunch', 'snap fitness',
      'anytime fitness', 'orangetheory', 'crossfit', 'soulcycle', 'peloton'
    ],
    'Insurance': [
      'geico', 'state farm', 'allstate', 'progressive', 'farmers', 'liberty mutual', 'nationwide', 'american family', 'erie', 'travelers',
      'hartford', 'metlife', 'prudential', 'aflac', 'mutual of omaha', 'new york life', 'northwestern mutual', 'guardian', 'principal'
    ],
    'Subscriptions': [
      'netflix', 'spotify', 'hulu', 'amazon prime', 'disney+', 'hbo max', 'apple tv+', 'youtube premium', 'paramount+', 'peacock', 'discovery+',
      'crunchyroll', 'funimation', 'roku', 'sling tv', 'fubo tv', 'youtube tv', 'hulu live', 'directv stream', 'philo', 'at&t tv'
    ],
    'Retail': [
      'amazon', 'walmart', 'target', 'costco', 'best buy', 'michaels', 'joann', 'hobby lobby', 'dicks sporting goods',
      'academy sports', 'bass pro shops', 'cabelas', 'rei', 'nordstrom', 'macys', 'kohls', 'jcpenney', 'sears', 'belk', 'dillards', 'neiman marcus',
      'apple store', 'samsung', 'dell', 'hp', 'lenovo', 'micro center', 'newegg', 'b&h photo', 'adorama'
    ],
    'Entertainment': [
      'movie', 'theater', 'cinema', 'amc', 'regal', 'cinemark', 'marcus', 'harkins', 'landmark', 'angelika', 'alamo drafthouse',
      'bowling', 'arcade', 'dave & busters', 'main event', 'topgolf', 'escape room', 'axe throwing', 'paintball', 'laser tag'
    ],
    'Household': [
      'home depot', 'lowes', 'menards', 'ace hardware', 'true value', 'do it best', '84 lumber', 'beacon roofing', 'abc supply',
      'sherwin williams', 'benjamin moore', 'ppg', 'valspar', 'glidden', 'behr'
    ],
    'Clothing': [
      'nike', 'adidas', 'under armour', 'old navy', 'gap', 'banana republic', 'athleta', 'lululemon', 'victorias secret',
      'pink', 'american eagle', 'aeropostale', 'hollister', 'abercrombie', 'forever 21', 'h&m', 'zara', 'uniqlo', 'asos'
    ],
    'Bank Fees': [
      'chase', 'bank of america', 'wells fargo', 'citibank', 'us bank', 'pnc', 'capital one', 'td bank', 'bb&t', 'suntrust',
      'regions', 'keybank', 'fifth third', 'huntington', 'citizens', 'comerica', 'bmo harris', 'usaa', 'navy federal'
    ],
    'Education': [
      'university', 'college', 'tuition', 'textbook', 'campus', 'blackboard', 'canvas lms', 'moodle',
      'coursera', 'udemy', 'skillshare', 'masterclass', 'khan academy', 'duolingo', 'rosetta stone'
    ],
    'Travel': [
      'airline', 'marriott', 'hilton', 'hyatt', 'ihg', 'wyndham', 'best western', 'motel 6', 'super 8',
      'expedia', 'booking.com', 'hotels.com', 'airbnb', 'vrbo', 'tripadvisor', 'kayak', 'priceline', 'orbitz', 'travelocity'
    ],
    'Online': [
      'adobe', 'dropbox', 'box.com', 'slack', 'zoom', 'webex', 'gotomeeting', 'asana', 'trello',
      'notion', 'evernote', 'lastpass', '1password', 'dashlane', 'bitwarden', 'grammarly', 'canva', 'figma'
    ],
    'Personal Care': [
      'great clips', 'sport clips', 'supercuts', 'fantastic sams', 'regis', 'ulta', 'sephora', 'sally beauty'
    ]
  };
  
  // Helper: find a user category whose name matches a bucket label.
  // First tries an exact case-insensitive match (works when bucket names are
  // seeded category names), then falls back to includes-either-way for users
  // who have custom category names that contain the bucket label.
  const findCategoryForBucket = (bucketLabel) => {
    if (!bucketLabel) return null;
    const label = String(bucketLabel).toLowerCase();
    // Exact match — the primary path now that bucket labels equal seeded names.
    const exact = categories.find((cat) => {
      const n = extractCategoryName(cat).toLowerCase();
      return n && n === label;
    });
    if (exact) return exact;
    // Fuzzy fallback for custom-named categories.
    return categories.find((cat) => {
      const n = extractCategoryName(cat).toLowerCase();
      return n && (n.includes(label) || label.includes(n));
    }) || null;
  };

  // 0. Plaid PFC short-circuit (highest priority).
  if (pfcBucketHint) {
    const fromPfc = findCategoryForBucket(pfcBucketHint);
    if (fromPfc) return extractCategoryName(fromPfc);
  }

  // 1. Check for high-confidence merchant string patterns.
  for (const [category, patterns] of Object.entries(highConfidencePatterns)) {
    for (const pattern of patterns) {
      if (transactionText.includes(pattern)) {
        const matchingCategory = findCategoryForBucket(category);
        if (matchingCategory) return extractCategoryName(matchingCategory);
      }
    }
  }

  // 2. Canonical merchant match in transaction history. Uses getMerchantKey
  //    (alias + brand-root folded) on BOTH sides so brand variants line up —
  //    "AMZN Mktp" matches a history row named "Amazon.com", and a hand-typed
  //    "Costco gas" matches "COSTCO GAS #421".
  if (Array.isArray(transactionHistory) && transactionHistory.length > 0) {
    const merchantKey = getMerchantKey(transaction);
    if (merchantKey) {
      const exactMatches = transactionHistory.filter((t) => getMerchantKey(t) === merchantKey);
      
      if (exactMatches.length > 0) {
        const mostCommonCategory = getMostCommonCategory(exactMatches);
        if (mostCommonCategory) {
          const matchingCategory = categories.find((cat) => {
            const n = extractCategoryName(cat).toLowerCase();
            return n && n === String(mostCommonCategory).toLowerCase();
          });
          if (matchingCategory) return extractCategoryName(matchingCategory);
        }
      }
    }
  }

  // 3. Fuzzy-name match against transaction history.
  if (Array.isArray(transactionHistory) && transactionHistory.length > 0) {
    const transactionName = typeof transaction.name === 'string'
      ? transaction.name.toLowerCase()
      : '';
    if (transactionName) {
      const similarTransactions = transactionHistory.filter((t) => {
        if (typeof t?.name !== 'string') return false;
        const tl = t.name.toLowerCase();
        return tl.includes(transactionName) || transactionName.includes(tl);
      });
      
      if (similarTransactions.length > 0) {
        const mostCommonCategory = getMostCommonCategory(similarTransactions);
        if (mostCommonCategory) {
          const matchingCategory = categories.find((cat) => {
            const n = extractCategoryName(cat).toLowerCase();
            return n && n === String(mostCommonCategory).toLowerCase();
          });
          if (matchingCategory) return extractCategoryName(matchingCategory);
        }
      }
    }
  }

  return null; // No fast match found — caller decides how to fall back.
}

// Returns the most frequently occurring user-assigned category from a list
// of transaction history items. Uses getUserCategory so it prefers the user's
// explicit choice (adjusted_category) over the raw Plaid legacy field — this
// is what makes steps 2 and 3 of categorizeTransactionFast return names that
// actually exist in the user's category list.
function getMostCommonCategory(transactions) {
  const categoryCounts = {};
  transactions.forEach(t => {
    const cat = getUserCategory(t);
    // Guard: skip empty or array-derived strings that stringify as "a,b,c"
    if (cat && !cat.includes(',')) {
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }
  });
  
  let mostCommon = null;
  let maxCount = 0;
  
  for (const [category, count] of Object.entries(categoryCounts)) {
    if (count > maxCount) {
      maxCount = count;
      mostCommon = category;
    }
  }
  
  return mostCommon;
}

// Fallback categorization logic when OpenAI is unavailable
function categorizeTransactionFallback(transaction, categories, transactionHistory) {
  const transactionText = `${transaction.name || ''} ${transaction.display_name || ''} ${transaction.merchant_name || ''} ${transaction.description || ''}`.toLowerCase();
  
  // Common category keywords
  const categoryKeywords = {
    'groceries': ['grocery', 'food', 'supermarket', 'market', 'fresh', 'organic', 'whole foods', 'trader joe', 'kroger', 'safeway'],
    'gas': ['gas', 'fuel', 'shell', 'exxon', 'chevron', 'bp', 'mobil', 'petro', 'station'],
    'restaurants': ['restaurant', 'dining', 'food', 'eat', 'grub', 'doordash', 'uber eats', 'postmates'],
    'entertainment': ['movie', 'theater', 'cinema', 'netflix', 'spotify', 'hulu', 'amazon prime', 'entertainment'],
    'shopping': ['amazon', 'walmart', 'target', 'costco', 'shop', 'store', 'retail'],
    'utilities': ['electric', 'water', 'gas', 'utility', 'power', 'energy'],
    'transportation': ['uber', 'lyft', 'taxi', 'transport', 'transit', 'bus', 'train'],
    'healthcare': ['doctor', 'medical', 'health', 'pharmacy', 'cvs', 'walgreens', 'hospital'],
    'insurance': ['insurance', 'geico', 'state farm', 'allstate', 'progressive'],
    'subscriptions': ['subscription', 'monthly', 'recurring', 'membership']
  };
  
  // Find the best matching category
  let bestMatch = categories[0]; // Default to first category
  let bestScore = 0;
  
  for (const category of categories) {
    const keywords = categoryKeywords[category.toLowerCase()] || [];
    let score = 0;
    
    // Check for keyword matches
    for (const keyword of keywords) {
      if (transactionText.includes(keyword)) {
        score += 2;
      }
    }
    
    // Check historical patterns
    if (transactionHistory) {
      const similarTransactions = transactionHistory.filter(t => 
        t.category === category && 
        Math.abs(t.amount - transaction.amount) < 50 // Similar amount range
      );
      score += similarTransactions.length * 0.5;
    }
    
    if (score > bestScore) {
      bestScore = score;
      bestMatch = category;
    }
  }
  
  return bestMatch;
}

exports.redisTest = async (req, res) => {
  try {
    console.log('Redis test endpoint called');
    await redis.set('test-key', 'Hello from Keacast Redis!', 'EX', 60);
    const value = await redis.get('test-key');
    console.log('Redis test: Successfully set and retrieved test value');
    res.json({
      success: true,
      value,
      note: 'Redis connection working. Chat and summarize endpoints now share unified conversation history.'
    });
  } catch (error) {
    console.error('Redis test error:', error);
    res.status(500).json({ error: 'Redis connection failed', details: error.message });
  }
};

// ----------------------------
// 🗑️ Clear conversation history
// ----------------------------
exports.clearHistory = async (req, res) => {
  try {
    console.log('Clear history endpoint called');
    console.log('Clear history: Request body:', req.body);
    console.log('Clear history: Request query:', req.query);
    console.log('Clear history: Request headers:', req.headers);
    
    const sessionKey = buildSessionKey(req);
    console.log('Clear history: Session key:', sessionKey);

    // Check if the session exists before trying to delete it
    const existingHistory = await redis.get(sessionKey);
    console.log('Clear history: Existing history found:', !!existingHistory);

    // Also wipe the transient conversation working-state (dialogue draft +
    // rolling summary) for this user. Durable long-term facts are intentionally
    // PRESERVED — they're only removed via DELETE /assistant-memory. Fail-soft.
    try {
      const { userId: clearUserId } = extractAuthFromRequest(req);
      if (clearUserId) {
        await redis.del(buildDialogueKey(clearUserId));
        await redis.del(buildSummaryKey(clearUserId));
        console.log('Clear history: cleared dialogue state + rolling summary for user', clearUserId);
      }
    } catch (e) {
      console.warn('Clear history: failed to clear dialogue/summary (non-fatal):', e.message);
    }

    try {
      const deleteResult = await redis.del(sessionKey);
      console.log('Clear history: Redis delete result:', deleteResult);
      
      if (deleteResult === 1) {
        console.log('Clear history: Successfully cleared session history');
        res.json({
          success: true,
          message: 'Conversation history cleared successfully',
          sessionKey: sessionKey,
          deleted: true,
          note: 'This will help prevent rate limiting from large conversation history'
        });
      } else {
        console.log('Clear history: No session found to delete');
        res.json({
          success: true,
          message: 'No conversation history found to clear',
          sessionKey: sessionKey,
          deleted: false,
          note: 'Session may have already been cleared or never existed'
        });
      }
    } catch (redisError) {
      console.warn('Clear history: Redis delete failed:', redisError.message);
      res.status(500).json({ error: 'Failed to clear history', details: redisError.message });
    }
  } catch (error) {
    console.error('Clear history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Add a new endpoint to check conversation size
exports.checkHistorySize = async (req, res) => {
  try {
    const sessionKey = buildSessionKey(req);
    const historyData = await redis.get(sessionKey);
    const history = historyData ? JSON.parse(historyData) : [];
    
    const totalSize = JSON.stringify(history).length;
    const messageCount = history.length;
    
    res.json({
      sessionKey,
      messageCount,
      totalSizeBytes: totalSize,
      totalSizeKB: Math.round(totalSize / 1024 * 100) / 100,
      isLarge: totalSize > 500000,
      recommendation: totalSize > 500000 ? 'Consider clearing history to prevent rate limiting' : 'Size is acceptable'
    });
  } catch (error) {
    console.error('Check history size error:', error);
    res.status(500).json({ error: 'Failed to check history size' });
  }
};

// Add a new endpoint to clear specific session by sessionId
exports.clearSessionById = async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' });
    }
    
    const sessionKey = `session:${sessionId}`;
    console.log('Clear session by ID: Clearing session key:', sessionKey);
    
    try {
      await redis.del(sessionKey);
      console.log('Clear session by ID: Successfully cleared session:', sessionId);
      res.json({
        success: true,
        message: `Session ${sessionId} cleared successfully`,
        sessionKey: sessionKey,
        note: 'This will resolve Azure OpenAI message format errors'
      });
    } catch (redisError) {
      console.warn('Clear session by ID: Redis delete failed:', redisError.message);
      res.status(500).json({ error: 'Failed to clear session', details: redisError.message });
    }
  } catch (error) {
    console.error('Clear session by ID error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Add a new endpoint to repair corrupted sessions
exports.repairSession = async (req, res) => {
  try {
    const sessionKey = buildSessionKey(req);
    console.log('Repair session: Attempting to repair session key:', sessionKey);
    
    try {
      const historyData = await redis.get(sessionKey);
      if (!historyData) {
        return res.json({
          success: true,
          message: 'Session is already clean (no history)',
          sessionKey: sessionKey
        });
      }
      
      const history = JSON.parse(historyData);
      const originalLength = history.length;
      const sanitizedHistory = sanitizeMessageArray(history);
      const newLength = sanitizedHistory.length;
      
      if (originalLength !== newLength) {
        // Save the sanitized history
        await redis.set(sessionKey, JSON.stringify(sanitizedHistory), 'EX', MEMORY_TTL);
        console.log('Repair session: Repaired session, removed', originalLength - newLength, 'corrupted messages');
        
        res.json({
          success: true,
          message: `Session repaired successfully`,
          sessionKey: sessionKey,
          originalMessageCount: originalLength,
          newMessageCount: newLength,
          removedCorruptedMessages: originalLength - newLength
        });
      } else {
        res.json({
          success: true,
          message: 'Session is already clean',
          sessionKey: sessionKey,
          messageCount: newLength
        });
      }
    } catch (redisError) {
      console.warn('Repair session: Redis operation failed:', redisError.message);
      res.status(500).json({ error: 'Failed to repair session', details: redisError.message });
    }
  } catch (error) {
    console.error('Repair session error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Add a new endpoint to get chat conversation history
exports.getChatHistory = async (req, res) => {
  try {
    console.log('Get chat history endpoint called');
    const sessionKey = buildSessionKey(req);
    console.log('Get chat history: Session key:', sessionKey);

    try {
      const historyData = await redis.get(sessionKey);
      if (!historyData) {
        return res.json({
          success: true,
          message: 'No conversation history found',
          sessionKey: sessionKey,
          history: [],
          messageCount: 0
        });
      }
      
      const history = JSON.parse(historyData);
      const sanitizedHistory = sanitizeMessageArray(history);
      
      // Filter out system messages, context messages, and empty messages, then add timestamps
      const conversationHistory = sanitizedHistory
        .filter(msg => {
          // Only include user and assistant messages
          if (msg.role !== 'user' && msg.role !== 'assistant') {
            return false;
          }
          
          // Filter out empty or whitespace-only messages
          if (!msg.content || msg.content.trim() === '') {
            return false;
          }
          
          // Filter out context messages
          if (msg.role === 'user' && msg.content) {
            const content = msg.content.trim();
            
            // Filter out chat context messages (start with "Use this context to answer the user's question.")
            if (content.startsWith('Use this context to answer the user\'s question.')) {
              return false;
            }
            
            // Filter out transaction analysis context messages (start with "Here is my user's data:")
            if (content.startsWith('Here is my user\'s data:')) {
              return false;
            }
            
            // Filter out messages that are primarily JSON data (likely context)
            if (content.includes('"transactions":') && content.includes('"accounts":') && content.length > 1000) {
              return false;
            }
          }
          
          return true;
        })
        .map((msg, index) => {
          // Calculate estimated timestamp based on message position
          // Assuming messages are roughly 1 minute apart
          const estimatedTime = new Date();
          estimatedTime.setMinutes(estimatedTime.getMinutes() - (sanitizedHistory.length - index));
          
          return {
            id: index + 1,
            role: msg.role,
            content: msg.content,
            timestamp: estimatedTime.toISOString(),
            messageNumber: index + 1,
            estimatedTime: true // Flag to indicate this is an estimated timestamp
          };
        });
      
      console.log('Get chat history: Retrieved', conversationHistory.length, 'messages');
      
      res.json({
        success: true,
        message: 'Chat history retrieved successfully',
        sessionKey: sessionKey,
        history: conversationHistory,
        messageCount: conversationHistory.length,
        totalHistorySize: sanitizedHistory.length,
        metadata: {
          sessionId: sessionKey.replace('session:', ''),
          hasSystemMessages: sanitizedHistory.some(msg => msg.role === 'system'),
          hasToolMessages: sanitizedHistory.some(msg => msg.role === 'tool'),
          hasContextMessages: sanitizedHistory.some(msg => 
            msg.role === 'user' && msg.content && (
              msg.content.trim().startsWith('Use this context to answer the user\'s question.') ||
              msg.content.trim().startsWith('Here is my user\'s data:') ||
              (msg.content.includes('"transactions":') && msg.content.includes('"accounts":') && msg.content.length > 1000)
            )
          ),
          estimatedSessionDuration: conversationHistory.length > 0 ? 
            `${Math.round(conversationHistory.length * 1)} minutes` : '0 minutes',
          lastUpdated: new Date().toISOString()
        }
      });
    } catch (redisError) {
      console.warn('Get chat history: Redis operation failed:', redisError.message);
      res.status(500).json({ error: 'Failed to retrieve chat history', details: redisError.message });
    }
  } catch (error) {
    console.error('Get chat history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Pure, side-effect-free helpers exposed for the ad-hoc memory test script
// (test-kea-memory.js). Not part of the HTTP surface.
exports.__testables = {
  emptyDialogueState,
  isAffirmativeMessage,
  transcriptShowsPendingProposal,
  lastAssistantTurnText,
  extractProposalFromMessage,
  extractDateFromText,
  extractTitleFromText,
  frequencyLabel,
  nextWeekdayOnOrAfter,
  buildDateReferenceBlock,
  buildUiContextBlock,
  buildRecentWritesBlock,
  recordRecentWrite,
  draftSignature,
  computeDraftMissingFields,
  isDraftProposable,
  extractCategoryNames,
  snapCategory,
  applyDraftAndCategory,
  draftConflictsWithArgs,
  buildDialogueStateBlock,
  mirrorUiReferentFromUiContext,
  formatUiReferentLine,
  buildFactsBlock,
  buildSummaryBlock,
  buildGoalsBlock,
  pickTopSpendingCategories,
  redactChatBodyForLog,
  // Mirrors the write-gate condition enforced inside executeToolCalls: armed by
  // an explicit pendingConfirmation flag, a complete draft staged earlier, OR a
  // proposal visible in the client transcript, AND a confirmation (the model's
  // confirmTransaction call or the affirmative-regex fallback).
  isWriteAllowed: (pendingConfirmationAtStart, draftCompleteAtStart, userAffirmative, proposalInTranscript) =>
    (pendingConfirmationAtStart === true || draftCompleteAtStart === true || proposalInTranscript === true) &&
    userAffirmative === true,
  constants: {
    MAX_MEMORY,
    MAX_TOOL_ROUNDS,
    SUMMARY_TRIGGER,
    DIALOGUE_STATE_MAX_CHARS,
    SUMMARY_MAX_CHARS,
    FACTS_MAX_CHARS,
    WRITE_TOOLS: Array.from(WRITE_TOOLS),
  },
};
