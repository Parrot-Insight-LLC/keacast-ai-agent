// controllers/openaiController.js
const redis = require('../services/redisService');
const { queryAzureOpenAI, functionSchemas } = require('../services/openaiService'); // must support tools
const { functionMap } = require('../tools/functionMap'); // <-- use functionMap.js
const contextCache = require('../services/contextCache.service'); // <-- use context cache service
const moment = require('moment');
const momentTimezone = require('moment-timezone');
const crypto = require('crypto');
const MEMORY_TTL = 604800; // 1 week
const MAX_MEMORY = 10; // reduce memory context size to prevent large requests
const MAX_MESSAGE_LENGTH = 20000; // increased limit for individual message length
const SYSTEM_PROMPT_MAX_LENGTH = 15000; // separate limit for system prompts
const SUMMARIZATION_CACHE_TTL = 1800; // 30 minutes in seconds

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
      const upInc = fmtMoney(Math.abs(account.upcomingIncomeTotal || 0));
      const upExp = fmtMoney(Math.abs(account.upcomingExpenseTotal || 0));
      lines.push(`Next 14 days totals: income ${upInc}, expenses ${upExp}.`);
    }

    const negs = pickNegativeBalancePreviews(account);
    if (negs.length > 0) {
      lines.push(`Future days the projected balance goes negative: ${negs.join('; ')}.`);
    }

    const recent = pickRecentTransactions(account, 6);
    if (recent.length > 0) {
      lines.push(`Recent posted (last ~30 days): ${recent.join('; ')}.`);
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
      lines.push(`Lowest projected balance through end of ${monthLabel} (${monthEnd}): ${fmtMoney(pot)}.`);
    }
  }
  if (typeof account.upcomingExpenseTotal === 'number' || typeof account.upcomingIncomeTotal === 'number') {
    lines.push(`Next 14 days: income ${fmtMoney(Math.abs(account.upcomingIncomeTotal || 0))}, expenses ${fmtMoney(Math.abs(account.upcomingExpenseTotal || 0))}.`);
  }

  const negs = pickNegativeBalancePreviews(account, 3);
  if (negs.length > 0) {
    lines.push(`Future negative projected balances: ${negs.join('; ')}.`);
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
    'This is a high-level brief. For anything not listed above (a specific transaction, category, merchant, or date range), call the available tools to fetch exact data instead of guessing. Use createTransaction to add forecasts and deleteTransaction to remove them.'
  );
  return lines.join('\n');
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

async function executeToolCalls(originalMessages, toolCalls, ctx) {
  // Execute each requested tool and keep one result per tool_call (tagged with
  // its id) so we can echo a matching `tool` role message back to the model.
  const toolResults = [];

  for (const toolCall of toolCalls) {
    const { name, arguments: argsJson } = toolCall.function || {};
    let args = {};
    try { args = argsJson ? JSON.parse(argsJson) : {}; } catch { args = {}; }

    const toolFn = functionMap[name];
    if (!toolFn) {
      toolResults.push({ id: toolCall.id, name, content: JSON.stringify({ error: `Unknown tool: ${name}` }) });
      continue;
    }

    try {
      const result = await toolFn(args, ctx);

      // Truncate large payloads so a single fetch can't blow up the context
      // window (read tools are already paginated upstream).
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

  // Standard tool-calling protocol: echo the assistant message that requested
  // the tools, then one `tool` message per call carrying the ACTUAL result
  // data. This lets the model answer detailed lookups (specific transactions,
  // balances, categories) from real data instead of a one-line count summary.
  const assistantToolMessage = { role: 'assistant', content: null, tool_calls: toolCalls };
  const toolMessages = toolResults.map(tr => ({
    role: 'tool',
    tool_call_id: tr.id,
    content: tr.content
  }));

  // Small fixed nudge (kept tiny for token economy).
  const finalNudge = {
    role: 'user',
    content: 'Using the tool results above, answer my previous message directly. If a transaction was created, confirm it with its name, amount, dates and (if recurring) frequency. Respond in markdown and do not mention tools.'
  };

  let cleanMessages = [...originalMessages, assistantToolMessage, ...toolMessages, finalNudge];

  // Size guard. Naive slicing would orphan `tool` messages from their parent
  // assistant tool_calls message (Azure 400s on that), so when oversized we
  // rebuild a minimal but VALID array: system + last user + assistant
  // tool_calls + tool results + nudge (chat history dropped).
  let messageSize = JSON.stringify(cleanMessages).length;
  console.log('Message array size after tool execution:', messageSize, 'bytes');
  if (messageSize > 750000) {
    console.log('Tool-result message array too large, rebuilding a minimal valid array');
    const systemMsg = originalMessages.find(m => m.role === 'system');
    let lastUserMsg = null;
    for (let i = originalMessages.length - 1; i >= 0; i--) {
      if (originalMessages[i].role === 'user') { lastUserMsg = originalMessages[i]; break; }
    }
    cleanMessages = [
      ...(systemMsg ? [systemMsg] : []),
      ...(lastUserMsg ? [lastUserMsg] : []),
      assistantToolMessage,
      ...toolMessages,
      finalNudge
    ];
    messageSize = JSON.stringify(cleanMessages).length;
    console.log('Rebuilt minimal message array size:', messageSize, 'bytes');
  }

  // Final response. tool_choice 'none' => no further tool calls; a single round
  // keeps latency + tokens predictable.
  try {
    console.log('Getting final response after tool execution with', cleanMessages.length, 'messages');
    const finalResponse = await queryAzureOpenAI(cleanMessages, { tools: functionSchemas, tool_choice: 'none' });
    const choice = finalResponse?.choices?.[0];
    console.log('Final response received:', !!choice?.message?.content, 'Content length:', choice?.message?.content?.length || 0);
    return { content: choice?.message?.content || '', raw: finalResponse };
  } catch (error) {
    console.log('Final response with tool results failed:', error.message);
    console.log('Error details:', error.response?.data || error);
    return { content: buildToolFallbackResponse(toolResults), raw: null };
  }
}

// ----------------------------
// 🧠 Chat with memory + tools (functionMap.js)
// ----------------------------
exports.chat = async (req, res) => {
  try {
    console.log('Chat endpoint called with body:', JSON.stringify(req.body, null, 2));
    const { message, systemPrompt } = req.body;
    if (!message) {
      console.log('Chat endpoint: Missing message in request body');
      return res.status(400).json({ error: 'Message is required' });
    }

    const sessionKey = buildSessionKey(req);
    const accountid = req.body.accountid;
    let faq;
    if (req.body.faq) {
      faq = JSON.parse(req.body.faq);
    }
    const { token, userId, authHeader } = extractAuthFromRequest(req);
    console.log('Chat endpoint: Session key:', sessionKey, 'User ID:', userId);

    // Load prior conversation memory
    let history = [];
    try {
      const historyData = await redis.get(sessionKey);
      history = historyData ? JSON.parse(historyData) : [];
      console.log('Chat endpoint: Loaded history length:', history.length);
    } catch (redisError) {
      console.warn('Chat endpoint: Redis history load failed:', redisError.message);
      history = [];
    }

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

    // Calculate current date based on user's timezone
    const currentDate = getCurrentDateInTimezone(location);
    console.log('Using current date:', currentDate);

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

    const baseSystem = `You are the Keacast (pronunciation: kee-uh-cast) Assistant, a knowledgeable and proactive personal finance forecasting tool developed by Parrot Insight LLC. Keacast is designed to help users manage their finances with foresight and clarity, going beyond traditional budgeting. You can refer to yourself as the Kea (pronunciation: kee-uh) assistant. Keacast is based on the Kea Parrot and it's predictive intelligence combined with a calendar-based forecasting system hince Keacast. Always respond with markdown formatting. If the user has not loaded any accounts yet, then you should highlight the features and capabilities of Keacast as well as its purposed and benefits for a user or a small business owner, use the FAQ items to help the user understand how to use Keacast. Always use the FAQ items to help the user understand Keacast and how it can help them, application specific questions and answers should be included.  
    When referencing the FAQ items, don't use the answers word for word, use the questions and answers and create a response that is relevant to the user's question.  
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
    - VERIFY BEFORE CREATING: createTransaction writes real data, so you MUST NOT call it until you have shown the user the full proposed transaction and they have agreed. When you propose, ALWAYS state a SINGLE concrete amount — if your estimate is a range (e.g. carpet replacement is $750–$2,500), pick one reasonable figure (e.g. the midpoint, ~$1,600), state it plainly, and ask them to confirm or adjust. Never leave the amount as a range going into the confirmation. On the turn the user first expresses intent, do NOT call the tool — propose the concrete details and ask them to confirm or adjust. Only call createTransaction after they agree. If they tweak a value, restate the updated proposal and confirm again.
    - CONFIRMATION HANDLING: Treat the user's reply as confirmation to create the transaction you just proposed whenever it is affirmative OR an add/create instruction — e.g. "yes", "yes please", "go ahead", "do it", "confirm", "sounds good", "please add this", "please add this forecast", "add it", "add that", "create it", "log it", "put it in my forecast". When you get any of these and your previous message proposed (or discussed) exactly one transaction, immediately call createTransaction using those proposed values (read them from your previous message in the history). Do NOT start over and do NOT re-ask for details you already proposed.
    - NEVER reply with "which forecast/transaction would you like to add?" when your own previous turn already identified exactly one thing (e.g. you just asked "would you like to create a transaction for the carpet replacement?"). "This forecast"/"this transaction" unambiguously refers to that item — create it. The ONLY time you may ask a clarifying question is if you genuinely proposed two or more clearly different transactions in the same breath. Also note: in Keacast "add this as a forecast" / "add this forecast" means CREATE a new forecasted transaction for the item just discussed — it does NOT mean look up an existing forecast, so do NOT call read tools (getRecurringForecasts/getUpcomingTransactions) to "find" it.
    - STAY ON TOPIC: The transaction you create must be the one that was actually being DISCUSSED with the user (e.g. the carpet replacement you just proposed). NEVER substitute an unrelated item that merely appears in the account context or the "Recent posted"/"Upcoming forecasted" lists (e.g. a paycheck). The CURRENT CONTEXT block is reference data only — it is never the thing to create unless the user explicitly asked for it.
    - Use the full chat history above as memory: remember the amounts, dates, merchants, goals, and any transaction you already proposed earlier in this conversation, and reuse them so the user never has to repeat themselves (the confirmation turn relies on this).
    - Carry conversation TOPICS into transactions. When the user asks to "add a transaction" (or "add that", "log it", "put that in my forecast") without naming what it's for, scan back through the recent messages for the most relevant purchase/expense/income topic that was being discussed and treat THAT as the subject. Example: if you were just discussing a carpet replacement and the user then says "add a transaction", understand it's the carpet replacement — set the title/description/category accordingly and estimate the amount from any figure mentioned in that discussion (or a reasonable estimate for that item). Briefly state which topic you linked it to in your confirmation prompt so the user can correct you if you guessed wrong.
    - When creating transactions, always provide clear confirmation to the user that their transaction has been successfully created. Include details like the transaction name, amount, frequency (if recurring), and any relevant dates. Make the user feel confident that their transaction has been properly added to their forecast. Don't mention the execution of the tool, just confirm the transaction has been created. Make sure not to duplicate or repeat anything in your response.
      - Always return with the transaction_id and if the transaction is recurring then also return the group_id which you can refer to as the recurring_id.
      - When working with dates and times, consider the user's location and timezone to provide accurate date-based responses. Forecasted transactions can not be created on date before the ${currentDate}. The system automatically calculates the correct date based on the user's coordinates.
      - When creating forecasts always consider whether the user has enough in the coming days, weeks, months, or years and warn them about how this may effect their financial state in the future. 

    Tone & Style: 
    - Clear, empathetic, and supportive
    - Professional yet approachable
    - Insightful when explaining forecasting logic, actionable when guiding users
    - Be sure to be concise and to the point, do not provide too much information, just the information that is relevant to the user's question.
    - Be sure to be thoughtful and consider the user's financial situation and goals, and provide advice that is in the best interest of the user.

    When interacting, always ground responses in the principles of cash-flow forecasting, clarity, and proactive planning (no more than 600 characters). If the user asks about short-term or long-term financial planning tasks, explain how Keacast can help, referencing forecasting, reconciliation, and visualization where relevant.
    
    IMPORTANT: Always respond with markdown formatting.
    
    Review the app here: https://keacast.app/ for more context and information.`;

    // Attach the compact context block as BACKGROUND inside the system message
    // rather than as a per-turn user message. Injecting it as a `user` turn
    // between the history and the real user message used to derail multi-turn
    // flows: on a confirmation turn the model saw [assistant: "...confirm?"],
    // then a system-authored "user" context dump, then "yes please" — and
    // treated the context dump as a topic change, restarting the conversation.
    const systemContent = completeContext
      ? `${baseSystem}\n\n---\nCURRENT CONTEXT (background — NOT a message from the user):\n${completeContext}`
      : baseSystem;

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
    const ctx = { userId, token, accountId: accountid, currentDate };
    
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
    
    const finalText = result.content || '## ❌ No Response\n\n**Sorry, no response generated.**';
    const updatedHistory = [
      ...sanitizeMessageArray(history),
      { role: 'user', content: message },
      { role: 'assistant', content: finalText }
    ].slice(-MAX_MEMORY);

    try {
      await redis.set(sessionKey, JSON.stringify(updatedHistory), 'EX', MEMORY_TTL);
      console.log('Chat endpoint: Saved updated history to Redis');
    } catch (redisError) {
      console.warn('Chat endpoint: Failed to save history to Redis:', redisError.message);
    }

    res.json({
      response: finalText,
      memoryUsed: updatedHistory.length,
      contextLoaded: hasAccount,
      dataMessage: dataMessage,
      requestSize: requestSize,
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

    const finalText = result.content || '';
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

    // ── Phase 3: Build cache key from a stable account fingerprint ────────
    // When we have a real account blob, the fingerprint is O(1) (no array
    // hashing). When we don't, fall back to the legacy data-hash shape so
    // older clients that ship the arrays still get a stable cache slot.
    const fingerprint = selectedAccount
      ? buildAccountFingerprint(selectedAccount)
      : null;
    const cacheKey = fingerprint
      ? buildSummarizationCacheKeyFromFingerprint(sessionKey, accountId, fingerprint)
      : buildSummarizationCacheKey(
          sessionKey,
          accountId,
          fallbackBody.plaidTransactions,
          fallbackBody.forecastedTransactions,
          fallbackBody.balances
        );
    console.log('Summarization: cache key:', cacheKey, '(accountId:', accountId, ', fingerprint:', fingerprint ? 'server' : 'legacy', ')');

    // ── Phase 4: Cache check ──────────────────────────────────────────────
    try {
      const cachedResult = await redis.get(cacheKey);
      if (cachedResult) {
        console.log('Summarization: Returning cached result for account', accountId);
        const cachedData = JSON.parse(cachedResult);
        return res.json({ 
          summary: cachedData.summary, 
          raw: cachedData.raw, 
          cached: true,
          note: 'This summary was retrieved from cache (30 minute TTL)'
        });
      }
    } catch (cacheError) {
      console.warn('Summarization: Cache read failed, proceeding with fresh generation:', cacheError.message);
    }

    // ── Phase 5: Build a tight prompt from precomputed signals ───────────
    // System prompt is ~1/3 the size of the prior version. We removed the
    // bullet-list of guidance and inline examples — the user content already
    // hands the model fully-formatted numbers, so its only job is wording.
    const firstName = coerceFirstName(userDataFromBody, selectedAccount?.user || null);
    const userContent = buildSummarizationUserContent(selectedAccount, firstName, fallbackBody, { today: clientDate });

    const systemPrompt = `You are Kea, the Keacast assistant — a casual, supportive financial buddy.
Write 4-7 short sentences (≤600 chars total) addressing the user by FIRST NAME.
Goal: help them feel informed and slightly excited to plan ahead.

HARD RULES — the user already saw this data, they will catch any drift:
1. Every dollar amount you mention must appear verbatim in the data block. Do not add, subtract, average, or aggregate amounts.
2. Every date or time window you mention must appear verbatim in the data block. NEVER infer "by month-end", "by Friday", "this weekend", or any deadline that isn't explicitly written. If you mention timing, copy a label from the data word-for-word ("next 14 days", "today", "Jun 12", "end of May", "last 30 days").
3. Pair each amount with the same label it has in the data. Do NOT translate "Next 14 days totals: expenses $X" into "$X due by [some date]". Do NOT translate "Lowest projected balance through end of May" into a deadline.
4. Only call something "no income" if the relevant labelled income figure literally shows $0. Otherwise stay neutral on income.
5. If "Future days the projected balance goes negative" is present, mention the soonest entry verbatim — that is the strongest heads-up signal.

STYLE:
- Casual, warm, forward-looking. Plain prose. No headings, no bullets, no markdown beyond light emphasis.
- Use $ for amounts, leading "-" for negatives. Round to whole dollars unless < $10.
- Always include at least one concrete amount + one verbatim date or window from the data.
- If you can't convey the message in 3 sentences, its okay to do it in 4-7 sentences.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      // NOTE: history intentionally NOT injected. This endpoint is documented
      // as read-only / non-mutating, so polluting the prompt with prior chat
      // turns wastes tokens AND can derail the strict format above.
      { role: 'user', content: userContent }
    ];

    console.log('Summarization: prompt sizes — system:', systemPrompt.length, 'chars, user:', userContent.length, 'chars');

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
        max_tokens: 180,
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

    const finalText = result.content || '';
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
        console.log('Summarization: Cached result for 30 minutes (account:', accountId, ')');
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
const AUTOCATEGORIZE_CACHE_TTL = 60 * 60 * 24 * 7; // 7 days
// Total cap on items handed to the LLM after pickRelevantHistory ranks by
// merchant > Plaid PFC > legacy category. Bumped from 12 → 100 to give the
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
function normalizeMerchantName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 64);
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
  const counts = new Map();
  const amounts = [];
  for (const m of matches) {
    const cat = getLegacyCategory(m);
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
//   4. Same legacy category
// Each pass runs against the same dedup `seen` set so we never count an item
// twice and the order in `out` reflects the ranking — that's what the LLM
// reads top-down.
function pickRelevantHistory(transaction, history) {
  if (!Array.isArray(history) || history.length === 0) return [];

  const targetMerchant = getMerchantKey(transaction);
  const targetPfcDetailed = pickPfcSignals(transaction).detailed;
  const targetLegacy = getLegacyCategory(transaction);
  const targetAmount = getNumericAmount(transaction);

  const seen = new Set();
  const out = [];
  const push = (item, matchedOn) => {
    const key = `${getMerchantKey(item)}|${item?.amount}|${getLegacyCategory(item)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name: item?.name || item?.display_name || '',
      display_name: item?.display_name || undefined,
      merchant: item?.merchant_name || '',
      amount: getNumericAmount(item),
      category: getLegacyCategory(item) || undefined,
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

  // 4. Same legacy category.
  if (targetLegacy) {
    for (const item of history) {
      if (out.length >= AUTOCATEGORIZE_HISTORY_LIMIT) break;
      if (getLegacyCategory(item) === targetLegacy) push(item, 'category');
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
          await redis.set(
            cacheKey,
            JSON.stringify({ suggestedCategory: resolved, confidence: 'high', via: 'fast-path' }),
            'EX',
            AUTOCATEGORIZE_CACHE_TTL
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
      `2. relevant_history matched_on = "merchant+amount" — same merchant + similar amount ` +
      `is a near-certain repeat of the same transaction type; use that category.\n` +
      `3. relevant_history matched_on = "merchant" — same merchant any amount; use the ` +
      `most frequent category seen across those rows.\n` +
      `4. plaid_personal_finance_category (detailed > primary) when confidence is HIGH ` +
      `and the history gives no clear signal.\n` +
      `5. relevant_history matched_on = "pfc" or "category" as weak tiebreakers.\n` +
      `Only fall back to general world knowledge when steps 1–5 give nothing useful.\n\n` +
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

// Map Plaid `personal_finance_category.detailed` (and `.primary`) codes to the
// internal pattern-bucket names used in `highConfidencePatterns`. When Plaid
// classifies a transaction with HIGH confidence, this short-circuits the
// pattern walk and delivers a far stronger signal than merchant string-matching.
const PLAID_PFC_TO_BUCKET = {
  TRANSPORTATION_GAS: 'gas',
  TRANSPORTATION_PUBLIC_TRANSIT: 'transportation',
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: 'transportation',
  FOOD_AND_DRINK_GROCERIES: 'groceries',
  FOOD_AND_DRINK_RESTAURANT: 'restaurants',
  FOOD_AND_DRINK_FAST_FOOD: 'restaurants',
  FOOD_AND_DRINK_COFFEE: 'restaurants',
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES: 'shopping',
  GENERAL_MERCHANDISE_DEPARTMENT_STORES: 'shopping',
  GENERAL_MERCHANDISE_ELECTRONICS: 'electronics',
  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: 'clothing',
  GENERAL_SERVICES_INSURANCE: 'insurance',
  HOME_IMPROVEMENT_HARDWARE: 'home improvement',
  HOME_IMPROVEMENT_FURNITURE: 'home improvement',
  ENTERTAINMENT_TV_AND_MOVIES: 'subscriptions',
  ENTERTAINMENT_MUSIC_AND_AUDIO: 'subscriptions',
  ENTERTAINMENT_VIDEO_GAMES: 'entertainment',
  ENTERTAINMENT_CASINOS_AND_GAMBLING: 'entertainment',
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: 'fitness',
  PERSONAL_CARE_HAIR_AND_BEAUTY: 'shopping',
  PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING: 'shopping',
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS: 'pharmacy',
  MEDICAL_PRIMARY_CARE: 'healthcare',
  MEDICAL_DENTAL_CARE: 'healthcare',
  MEDICAL_EYE_CARE: 'healthcare',
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: 'utilities',
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: 'utilities',
  RENT_AND_UTILITIES_TELEPHONE: 'utilities',
  RENT_AND_UTILITIES_WATER: 'utilities',
  RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT: 'utilities',
  TRAVEL_FLIGHTS: 'travel',
  TRAVEL_LODGING: 'travel',
  TRAVEL_RENTAL_CARS: 'travel',
  // Plaid `primary` fallbacks
  TRANSPORTATION: 'transportation',
  FOOD_AND_DRINK: 'restaurants',
  GENERAL_MERCHANDISE: 'shopping',
  HOME_IMPROVEMENT: 'home improvement',
  PERSONAL_CARE: 'shopping',
  MEDICAL: 'healthcare',
  RENT_AND_UTILITIES: 'utilities',
  TRAVEL: 'travel',
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
  
  // High-confidence merchant patterns
  const highConfidencePatterns = {
    'groceries': [
      'whole foods', 'trader joe', 'kroger', 'safeway', 'albertsons', 'publix', 'wegmans', 'food lion', 'giant eagle', 'shoprite', 'stop & shop',
      'sprouts', 'fresh market', 'natural grocers', 'earth fare', 'fresh thyme', 'lucky', 'ralphs', 'vons', 'food 4 less', 'winco', 'aldi', 'lidl',
      'heb', 'meijer', 'hy-vee', 'price chopper', 'tops', 'giant', 'martins', 'weis', 'acme', 'shaws', 'hannaford', 'price rite', 'save a lot'
    ],
    'gas': [
      'shell', 'exxon', 'chevron', 'bp', 'mobil', 'petro', 'marathon', 'sunoco', 'valero', '76', 'arco', 'phillips 66', 'conoco', 'citgo',
      'speedway', 'circle k', '7-eleven', 'quik trip', 'kum & go', 'caseys', 'wawa', 'sheet', 'love', 'murphy', 'race trac', 'pilot', 'flying j'
    ],
    'restaurants': [
      'mcdonalds', 'burger king', 'wendys', 'subway', 'dominos', 'pizza hut', 'chipotle', 'panera', 'starbucks', 'dunkin', 'doordash', 'uber eats', 'grubhub',
      'taco bell', 'kfc', 'popeyes', 'chick-fil-a', 'in-n-out', 'five guys', 'shake shack', 'whataburger', 'culvers', 'sonic', 'arbys', 'jack in the box',
      'papa johns', 'little caesars', 'papa murphys', 'blaze pizza', 'mod pizza', 'pizza ranch', 'postmates', 'seamless', 'caviar', 'bite squad'
    ],
    'utilities': [
      'pg&e', 'southern california edison', 'conedison', 'duke energy', 'dominion energy', 'exelon', 'nextera', 'firstenergy', 'pacificorp', 'xcel energy',
      'entergy', 'southern company', 'american electric power', 'centerpoint energy', 'comed', 'pepco', 'bge', 'pseg', 'national grid', 'eversource'
    ],
    'transportation': [
      'uber', 'lyft', 'taxi', 'amtrak', 'greyhound', 'metropolitan transportation authority', 'chicago transit authority', 'los angeles metro',
      'bay area rapid transit', 'washington metropolitan area transit authority', 'septa', 'mbta', 'nj transit', 'metro-north', 'long island railroad'
    ],
    'healthcare': [
      'cvs', 'walgreens', 'rite aid', 'kroger pharmacy', 'walmart pharmacy', 'costco pharmacy', 'target pharmacy', 'safeway pharmacy',
      'albertsons pharmacy', 'publix pharmacy', 'wegmans pharmacy', 'giant eagle pharmacy', 'shoprite pharmacy', 'stop & shop pharmacy'
    ],
    'insurance': [
      'geico', 'state farm', 'allstate', 'progressive', 'farmers', 'liberty mutual', 'nationwide', 'american family', 'erie', 'travelers',
      'hartford', 'metlife', 'prudential', 'aflac', 'mutual of omaha', 'new york life', 'northwestern mutual', 'guardian', 'principal'
    ],
    'subscriptions': [
      'netflix', 'spotify', 'hulu', 'amazon prime', 'disney+', 'hbo max', 'apple tv+', 'youtube premium', 'paramount+', 'peacock', 'discovery+',
      'crunchyroll', 'funimation', 'roku', 'sling tv', 'fubo tv', 'youtube tv', 'hulu live', 'directv stream', 'philo', 'at&t tv'
    ],
    'shopping': [
      'amazon', 'walmart', 'target', 'costco', 'best buy', 'home depot', 'lowes', 'michaels', 'joann', 'hobby lobby', 'dicks sporting goods',
      'academy sports', 'bass pro shops', 'cabelas', 'rei', 'nordstrom', 'macys', 'kohls', 'jcpenney', 'sears', 'belk', 'dillards', 'neiman marcus'
    ],
    'entertainment': [
      'movie', 'theater', 'cinema', 'amc', 'regal', 'cinemark', 'marcus', 'harkins', 'landmark', 'angelika', 'alamo drafthouse',
      'bowling', 'arcade', 'dave & busters', 'main event', 'topgolf', 'escape room', 'axe throwing', 'paintball', 'laser tag'
    ],
    'automotive': [
      'autozone', 'oreilly', 'advance auto', 'napa', 'pep boys', 'firestone', 'goodyear', 'bridgestone', 'michelin', 'jiffy lube',
      'valvoline', 'quick lube', 'mavis', 'discount tire', 'tire kingdom', 'les schwab', 'big o tires', 'tire rack'
    ],
    'home improvement': [
      'home depot', 'lowes', 'menards', 'ace hardware', 'true value', 'do it best', '84 lumber', 'beacon roofing', 'abc supply',
      'sherwin williams', 'benjamin moore', 'ppg', 'valspar', 'glidden', 'behr'
    ],
    'clothing': [
      'nike', 'adidas', 'under armour', 'old navy', 'gap', 'banana republic', 'athleta', 'lululemon', 'athleta', 'victorias secret',
      'pink', 'american eagle', 'aeropostale', 'hollister', 'abercrombie', 'forever 21', 'h&m', 'zara', 'uniqlo', 'asos'
    ],
    'electronics': [
      'apple', 'samsung', 'google', 'microsoft', 'dell', 'hp', 'lenovo', 'asus', 'acer', 'lg', 'sony', 'panasonic', 'sharp',
      'best buy', 'micro center', 'frys', 'newegg', 'b&h photo', 'adorama'
    ],
    'pharmacy': [
      'cvs', 'walgreens', 'rite aid', 'kroger pharmacy', 'walmart pharmacy', 'costco pharmacy', 'target pharmacy', 'safeway pharmacy',
      'albertsons pharmacy', 'publix pharmacy', 'wegmans pharmacy', 'giant eagle pharmacy', 'shoprite pharmacy', 'stop & shop pharmacy'
    ],
    'banking': [
      'chase', 'bank of america', 'wells fargo', 'citibank', 'us bank', 'pnc', 'capital one', 'td bank', 'bb&t', 'suntrust',
      'regions', 'keybank', 'fifth third', 'huntington', 'citizens', 'comerica', 'bmo harris', 'usaa', 'navy federal'
    ],
    'education': [
      'university', 'college', 'school', 'tuition', 'textbook', 'campus', 'student', 'blackboard', 'canvas', 'moodle',
      'coursera', 'udemy', 'skillshare', 'masterclass', 'khan academy', 'duolingo', 'rosetta stone'
    ],
    'fitness': [
      'planet fitness', 'la fitness', '24 hour fitness', 'equinox', 'lifetime', 'ymca', 'ymwca', 'golds gym', 'crunch', 'snap fitness',
      'anytime fitness', 'orangetheory', 'crossfit', 'barry', 'soulcycle', 'peloton', 'fitbit', 'garmin', 'apple fitness'
    ],
    'travel': [
      'airline', 'hotel', 'marriott', 'hilton', 'hyatt', 'ihg', 'choice', 'wyndham', 'best western', 'motel 6', 'super 8',
      'expedia', 'booking', 'hotels', 'airbnb', 'vrbo', 'tripadvisor', 'kayak', 'priceline', 'orbitz', 'travelocity'
    ],
    'online services': [
      'google', 'microsoft', 'adobe', 'dropbox', 'box', 'slack', 'zoom', 'teams', 'webex', 'gotomeeting', 'asana', 'trello',
      'notion', 'evernote', 'lastpass', '1password', 'dashlane', 'bitwarden', 'grammarly', 'canva', 'figma'
    ]
  };
  
  // Helper: find a user category whose name fuzzy-matches a bucket label.
  // ALWAYS guards `cat.name` (DB rows can have null names for legacy/global rows).
  const findCategoryForBucket = (bucketLabel) => {
    if (!bucketLabel) return null;
    const label = String(bucketLabel).toLowerCase();
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

  // 2. Exact merchant name match in transaction history.
  if (Array.isArray(transactionHistory) && transactionHistory.length > 0) {
    const merchantName = typeof transaction.merchant_name === 'string'
      ? transaction.merchant_name.toLowerCase()
      : '';
    if (merchantName) {
      const exactMatches = transactionHistory.filter((t) =>
        typeof t?.merchant_name === 'string' &&
        t.merchant_name.toLowerCase() === merchantName
      );
      
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

// Helper function to get most common category from transactions
function getMostCommonCategory(transactions) {
  const categoryCounts = {};
  transactions.forEach(t => {
    if (t.category) {
      categoryCounts[t.category] = (categoryCounts[t.category] || 0) + 1;
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
