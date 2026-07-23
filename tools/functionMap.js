// tools/functionMap.js
const { 
  getAccountsByUserId, 
  getAccountsByUserIdPaginated,
  getAccountsByUserIdCount 
} = require('../services/accounts.service');
const {
  getTransactionsByUserAndAccount,
  getTransactionsByUserAndAccountPaginated,
  getTransactionsByUserAndAccountCount,
  getRecurringForecastsByAccount,
  getRecurringForecastsByAccountPaginated,
  getRecurringForecastsByAccountCount,
  getUpcomingByAccountAndRange,
  getUpcomingByAccountAndRangePaginated,
  getUpcomingByAccountAndRangeCount,
  getTransactionSummary
} = require('../services/transactions.service');
const { getUserData, getSelectedKeacastAccounts, getSelectedAccount, getBalances, createTransaction, deleteTransaction, deleteGroupTransactions, getTransactionById, updateTransaction, getGoals, getGoal, previewGoalCadence, createGoal, updateGoal, deleteGoal, rememberFact, recallFacts } = require('./keacast_tool_layer');
const moment = require('moment');

// Smart data loading strategy to prevent memory issues
const SMART_LIMITS = {
  transactions: 50,      // Load 50 transactions at a time
  forecasts: 25,         // Load 25 forecasts at a time
  upcoming: 30,          // Load 30 upcoming transactions at a time
  accounts: 20           // Load 20 accounts at a time
};

const FREQUENCY_ONCE = 2;

// Anchor a date to UTC midnight of its CALENDAR DATE. The backend derives the
// stored date via `start.split('T')[0]`, so only the date part of the ISO
// string matters — but building it with server-local moment() shifted the date
// across the midnight boundary on non-UTC hosts (proposed July 16, stored
// July 15). Take the literal YYYY-MM-DD prefix when present; otherwise parse
// and format, falling back to the provided moment.
function toDateAnchoredISO(value, fallbackMoment) {
  const s = String(value || '');
  const prefix = s.match(/^(\d{4}-\d{2}-\d{2})/);
  let dateStr;
  if (prefix && moment(prefix[1], 'YYYY-MM-DD', true).isValid()) {
    dateStr = prefix[1];
  } else if (value && moment(value).isValid()) {
    dateStr = moment(value).format('YYYY-MM-DD');
  } else {
    dateStr = fallbackMoment.format('YYYY-MM-DD');
  }
  return `${dateStr}T00:00:00.000Z`;
}

// Snap a model-chosen category to the user's real category list (from
// ctx.categoryNames) so we never persist an invented category. Case-insensitive
// exact match first, then a loose contains-match either direction. Returns
// null when nothing matches. (Kept local — requiring openaiController here
// would create a circular dependency.)
function snapCategoryToList(input, names) {
  const q = String(input || '').trim().toLowerCase();
  if (!q || !Array.isArray(names) || names.length === 0) return null;
  for (const n of names) if (String(n).trim().toLowerCase() === q) return n;
  for (const n of names) {
    const ln = String(n).trim().toLowerCase();
    if (ln && (ln.includes(q) || q.includes(ln))) return n;
  }
  return null;
}

// Build a complete, valid createTransaction payload from whatever sparse
// fields the LLM supplied. The chat schema requires `amount` + `type`; the
// rest ("add $1200 rent on the 1st every month") is filled here so creation
// never 400s on a thin payload. Amount and type are hard requirements: a
// missing/zero amount or missing type is REJECTED (never silently defaulted)
// so the model re-proposes instead of writing a $0 row or flipping an expense
// into income.
function normalizeCreateTransactionInput(args = {}, ctx = {}) {
  const out = { ...args };

  // Strip server-injected identity fields if the model hallucinated them —
  // userId/accountId come from ctx (the URL path), never the body.
  delete out.userId;
  delete out.accountId;

  // type: must be explicit. The model always sends positive magnitudes, so
  // inferring type from sign would silently turn every typeless expense into
  // income — refuse instead and let the model re-propose.
  const type = String(out.type || '').toLowerCase();
  if (type !== 'income' && type !== 'expense') {
    throw new Error("type is required and must be 'expense' or 'income'. Re-propose the transaction with an explicit type.");
  }
  out.type = type;

  // amount: must be a concrete non-zero number. Persist signed (negative =
  // expense, positive = income) to match existing data conventions.
  const rawAmount = Number(out.amount);
  if (!Number.isFinite(rawAmount) || rawAmount === 0) {
    throw new Error('amount is required and must be a concrete non-zero number. Propose a single concrete amount to the user, get their confirmation, then call again with that amount.');
  }
  out.amount = type === 'expense' ? -Math.abs(rawAmount) : Math.abs(rawAmount);

  // frequency: default to a one-time entry unless recurrence was specified.
  let freq = Number(out.frequency);
  if (!Number.isFinite(freq) || freq <= 0) freq = FREQUENCY_ONCE;
  out.frequency = freq;

  // start: default to the user's localized "today" (ctx.currentDate), else now.
  // Dates are anchored to the literal calendar date (UTC midnight) so a
  // server-local toISOString() can never shift them across a day boundary.
  const today = ctx.currentDate && moment(ctx.currentDate).isValid()
    ? moment(ctx.currentDate)
    : moment();
  out.start = toDateAnchoredISO(out.start, today);
  const start = moment(out.start.slice(0, 10), 'YYYY-MM-DD');

  // end: one-time => same day; recurring => provided end or a 1-year horizon so
  // the backend generates a sensible series instead of a single row.
  if (freq === FREQUENCY_ONCE) {
    out.end = out.start;
  } else {
    out.end = toDateAnchoredISO(out.end, start.clone().add(1, 'year'));
  }

  // Human-facing text + misc fields: fill from context with safe fallbacks.
  const fallbackTitle = String(out.merchant_name || out.category || (type === 'income' ? 'Income' : 'Expense'));
  if (!out.title || !String(out.title).trim()) out.title = fallbackTitle;
  if (!out.display_name || !String(out.display_name).trim()) out.display_name = out.title;
  if (!out.description || !String(out.description).trim()) out.description = out.title;

  // category: snap whatever we have (model's pick, then the title, then a
  // type default) to the user's REAL category list so we never persist an
  // invented category. Falls back to the raw value when the user has no
  // matching category (backend accepts arbitrary strings).
  const categoryNames = Array.isArray(ctx.categoryNames) ? ctx.categoryNames : [];
  const rawCategory = (out.category && String(out.category).trim())
    ? String(out.category).trim()
    : (type === 'income' ? 'Income' : 'Uncategorized');
  out.category = snapCategoryToList(rawCategory, categoryNames)
    || snapCategoryToList(out.title, categoryNames)
    || rawCategory;

  if (!out.time || !String(out.time).trim()) out.time = '12:00';
  if (out.location == null) out.location = '';

  // forecast_type is ALWAYS 'F' here. 'RF' means Rollover Forecast — a
  // distinct accumulating-budget feature, NOT "recurring forecast" — and must
  // never be set by the LLM. Recurrence is expressed solely via `frequency`.
  out.forecast_type = 'F';

  return out;
}

// Goal cadence codes accepted by the backend (generateContributionDates).
const GOAL_FREQUENCIES = new Set(['1', '7', '14', '15', '16', '28', '29', '30', '31', '60', '91', '182', '365']);

// Compact a serialized goal (parent + contributions[]) into a model-friendly
// summary with derived progress signal, so the LLM never has to do the
// arithmetic itself (and can't get it wrong).
function summarizeGoalForModel(goal, currentDate) {
  if (!goal || typeof goal !== 'object') return null;
  const today = currentDate && moment(currentDate).isValid() ? moment(currentDate) : moment();
  const target = Number(goal.target_amount) || 0;
  const accumulated = Number(goal.accumulated_amount) || 0;
  const contributions = Array.isArray(goal.contributions) ? goal.contributions : [];

  // Expected-by-now: the sum the cadence says should have been set aside by
  // today. Compared against accumulated to derive on_track.
  let expectedByNow = 0;
  let nextContribution = null;
  for (const c of contributions) {
    if (!c || c.status === 'Skipped') continue;
    const amt = Math.abs(Number(c.amount) || 0);
    const start = moment(c.start);
    if (!start.isValid()) continue;
    if (start.isSameOrBefore(today, 'day')) {
      expectedByNow += amt;
    } else if (!nextContribution || start.isBefore(moment(nextContribution.date))) {
      nextContribution = { date: start.format('YYYY-MM-DD'), amount: amt };
    }
  }

  const endDate = goal.end_date ? moment(goal.end_date) : null;
  return {
    goalid: goal.goalid,
    title: goal.title || goal.display_name,
    category: goal.category,
    status: goal.status,
    completion_state: goal.completion_state,
    target_amount: target,
    accumulated_amount: accumulated,
    remaining_amount: Math.max(0, Number((target - accumulated).toFixed(2))),
    progress_pct: target > 0 ? Math.min(100, Math.round((accumulated / target) * 100)) : 0,
    start_date: goal.start_date,
    end_date: goal.end_date,
    days_remaining: endDate && endDate.isValid() ? Math.max(0, endDate.diff(today, 'days')) : null,
    frequency: goal.frequency,
    contribution_count: contributions.length,
    next_contribution: nextContribution,
    expected_by_now: Number(expectedByNow.toFixed(2)),
    on_track: accumulated >= expectedByNow - 0.01,
  };
}

// Validate + normalize the LLM's createGoal args into the backend payload.
// Goals are savings-style ('expense' type only — enforced by the backend too).
function normalizeCreateGoalInput(args = {}, ctx = {}) {
  const title = String(args.title || args.display_name || '').trim();
  if (!title) throw new Error('title is required — name the goal (e.g. "Vacation fund").');

  const target = Number(args.target_amount);
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error('target_amount is required and must be a positive number. Propose a concrete target to the user and confirm it first.');
  }

  const today = ctx.currentDate && moment(ctx.currentDate).isValid() ? moment(ctx.currentDate) : moment();
  const start = args.start_date && moment(args.start_date).isValid() ? moment(args.start_date) : today.clone();
  const end = args.end_date && moment(args.end_date).isValid() ? moment(args.end_date) : null;
  if (!end) throw new Error('end_date is required — the date the user wants to reach the target by.');
  if (end.isBefore(start, 'day')) throw new Error('end_date must be on or after start_date.');

  const frequency = String(args.frequency || '');
  if (!GOAL_FREQUENCIES.has(frequency)) {
    throw new Error("frequency is required and must be one of: '1' daily, '7' weekly, '14' bi-weekly, '15' semi-monthly, '28'-'31' monthly, '60' bi-monthly, '91' quarterly, '182' semi-annual, '365' annual.");
  }

  return {
    title,
    display_name: String(args.display_name || title),
    category: String(args.category || 'Savings'),
    type: 'expense', // income-typed goals are rejected by the backend
    description: args.description || null,
    notes: args.notes || null,
    target_amount: target,
    frequency,
    start_date: start.format('YYYY-MM-DD'),
    end_date: end.format('YYYY-MM-DD'),
  };
}

// Best-effort read of a single existing transaction row. Returns {} when the
// lookup fails so callers can proceed with the fields they have.
async function fetchTransactionRow(transactionId, token) {
  try {
    const rows = await getTransactionById({ transactionId, token });
    if (Array.isArray(rows) && rows.length) return rows[0] || {};
    if (rows && typeof rows === 'object') return rows;
  } catch (e) {
    console.warn('fetchTransactionRow: failed to read existing row, proceeding best-effort:', e.message);
  }
  return {};
}

// Build a COMPLETE update payload by merging the LLM's partial edits over the
// existing transaction row. The backend UPDATE overwrites every column, so we
// must preserve unspecified fields (fetched via getTransactionById) to avoid
// nulling data. Recomputes the signed amount from the final type.
// `preloadedExisting` lets callers that already fetched the row skip a
// duplicate lookup (the simulation propose tools).
async function buildUpdateTransactionInput(args = {}, ctx = {}, preloadedExisting = null) {
  const transactionId = args.transactionid || args.transaction_id || ctx.id;
  if (!transactionId) throw new Error('transactionid is required to update a transaction');

  const existing = preloadedExisting && typeof preloadedExisting === 'object'
    ? preloadedExisting
    : await fetchTransactionRow(transactionId, ctx.token);

  const merged = { ...existing };

  const passThrough = ['title', 'category', 'description', 'location', 'display_name', 'merchant_name', 'time'];
  for (const k of passThrough) {
    if (args[k] !== undefined && args[k] !== null && String(args[k]).trim() !== '') merged[k] = args[k];
  }

  // Resolve final type (provided → existing → infer from existing sign).
  let type = String(args.type || existing.type || '').toLowerCase();
  if (type !== 'income' && type !== 'expense') {
    type = Number(existing.amount) >= 0 ? 'income' : 'expense';
  }
  merged.type = type;

  // Amount: if provided, re-sign by type; else keep the existing signed amount.
  if (args.amount !== undefined && Number.isFinite(Number(args.amount))) {
    const mag = Math.abs(Number(args.amount));
    merged.amount = type === 'expense' ? -mag : mag;
  }

  if (args.start && moment(args.start).isValid()) merged.start = toDateAnchoredISO(args.start, moment(args.start));
  if (args.end && moment(args.end).isValid()) merged.end = toDateAnchoredISO(args.end, moment(args.end));

  if (args.frequency !== undefined && Number.isFinite(Number(args.frequency))) {
    // Recurrence lives ONLY in `frequency`. Never touch forecast_type here:
    // 'RF' means Rollover Forecast (a distinct accumulating-budget feature),
    // and deriving it from frequency was silently converting ordinary
    // recurring forecasts into rollover budgets on every edit. The existing
    // row's forecast_type (already in `merged`) is preserved as-is.
    merged.frequency = Number(args.frequency);
  }

  if (!merged.display_name || !String(merged.display_name).trim()) merged.display_name = merged.title;
  merged.transactionid = transactionId;
  return merged;
}

// Each tool gets (args, ctx), where ctx can include userId, auth, etc.
const functionMap = {
  async getUserAccounts(args, ctx) {
    // auth/ownership checks can go here: ensure ctx.userId === args.userId or allowed
    const { userId } = args;
    const page = args.page || 1;
    const limit = args.limit || SMART_LIMITS.accounts;
    
    try {
      // Try to get paginated results first
      const result = await getAccountsByUserIdPaginated(userId, page, limit);
      
      // If this is the first page and we have many accounts, suggest pagination
      if (page === 1 && result.pagination.total > limit) {
        return {
          ...result,
          message: `Retrieved ${result.accounts.length} of ${result.pagination.total} accounts. Use pagination for more accounts.`,
          pagination_info: result.pagination
        };
      }
      
      return result;
    } catch (error) {
      // Fallback to simple count if pagination fails
      if (error.message.includes('sort memory')) {
        const count = await getAccountsByUserIdCount(userId);
        return {
          accounts: [],
          message: `Database memory limit reached. Found ${count} accounts total. Please use smaller date ranges or contact support.`,
          total_count: count,
          error: 'Memory limit exceeded'
        };
      }
      throw error;
    }
  },

  async getUserAccountData(args, ctx) {
    const { userId, token, body } = args;
    const result = await getUserAccountData(userId, token, body);
    return result;
  },

  async getUserTransactions(args, ctx) {
    const { userId, accountId, startDate, endDate } = args;
    const page = args.page || 1;
    const limit = args.limit || SMART_LIMITS.transactions;
    
    try {
      // Try to get paginated results first
      const result = await getTransactionsByUserAndAccountPaginated(
        userId, accountId, 
        { startDate, endDate, page, limit }
      );
      
      // If this is the first page and we have many transactions, suggest pagination
      if (page === 1 && result.pagination.total > limit) {
        return {
          ...result,
          message: `Retrieved ${result.transactions.length} of ${result.pagination.total} transactions. Use pagination for more transactions.`,
          pagination_info: result.pagination
        };
      }
      
      return result;
    } catch (error) {
      // Fallback to summary if pagination fails
      if (error.message.includes('sort memory')) {
        const summary = await getTransactionSummary(userId, accountId, { startDate, endDate });
        return {
          transactions: [],
          message: `Database memory limit reached. Summary: ${summary.total_transactions} transactions found. Please use smaller date ranges.`,
          summary: summary,
          error: 'Memory limit exceeded'
        };
      }
      throw error;
    }
  },

  async getRecurringForecasts(args, ctx) {
    const { accountId } = args;
    const page = args.page || 1;
    const limit = args.limit || SMART_LIMITS.forecasts;
    
    try {
      // Try to get paginated results first
      const result = await getRecurringForecastsByAccountPaginated(accountId, page, limit);
      
      // If this is the first page and we have many forecasts, suggest pagination
      if (page === 1 && result.pagination.total > limit) {
        return {
          ...result,
          message: `Retrieved ${result.forecasts.length} of ${result.pagination.total} recurring forecasts. Use pagination for more forecasts.`,
          pagination_info: result.pagination
        };
      }
      
      return result;
    } catch (error) {
      // Fallback to count if pagination fails
      if (error.message.includes('sort memory')) {
        const count = await getRecurringForecastsByAccountCount(accountId);
        return {
          forecasts: [],
          message: `Database memory limit reached. Found ${count} recurring forecasts total. Please contact support.`,
          total_count: count,
          error: 'Memory limit exceeded'
        };
      }
      throw error;
    }
  },

  async getUpcomingTransactions(args, ctx) {
    const { accountId, startDate, endDate, forecastType='F' } = args;
    const page = args.page || 1;
    const limit = args.limit || SMART_LIMITS.upcoming;
    
    try {
      // Try to get paginated results first
      const result = await getUpcomingByAccountAndRangePaginated(
        accountId, startDate, endDate, forecastType, page, limit
      );
      
      // If this is the first page and we have many upcoming transactions, suggest pagination
      if (page === 1 && result.pagination.total > limit) {
        return {
          ...result,
          message: `Retrieved ${result.upcoming.length} of ${result.pagination.total} upcoming transactions. Use pagination for more transactions.`,
          pagination_info: result.pagination
        };
      }
      
      return result;
    } catch (error) {
      // Fallback to count if pagination fails
      if (error.message.includes('sort memory')) {
        const count = await getUpcomingByAccountAndRangeCount(accountId, startDate, endDate, forecastType);
        return {
          upcoming: [],
          message: `Database memory limit reached. Found ${count} upcoming transactions total. Please use smaller date ranges.`,
          total_count: count,
          error: 'Memory limit exceeded'
        };
      }
      throw error;
    }
  },

  // New function to get transaction summary without loading all data
  async getTransactionSummary(args, ctx) {
    const { userId, accountId, startDate, endDate } = args;
    
    try {
      const summary = await getTransactionSummary(userId, accountId, { startDate, endDate });
      return {
        summary,
        message: 'Transaction summary retrieved successfully without loading full data.',
        success: true
      };
    } catch (error) {
      return {
        summary: {},
        message: 'Failed to retrieve transaction summary.',
        error: error.message,
        success: false
      };
    }
  },

  // Add more: categories, shopping list, account details, etc.

  async getUserData(args, ctx) {
    const { userId, token } = args;
    const result = await getUserData({ userId, token });
    return result;
  },

  async getSelectedKeacastAccounts(args, ctx) {
    const { userId, token, body } = args;
    const result = await getSelectedKeacastAccounts({ userId, token, body });
    return result;
  },

  async getSelectedAccount(args, ctx) {
    const { userId, accountId, token, body, timeoutMs } = args;
    const result = await getSelectedAccount({ userId, accountId, token, body, timeoutMs });
    return result;
  },

  async getBalances(args, ctx) {
    const { accountId, userId, token, body } = args;
    const result = await getBalances({ accountId, userId, token, body });
    return result;
  },

  async createTransaction(args, ctx) {
    const { userId, token, accountId } = ctx;
    const body = normalizeCreateTransactionInput(args, ctx);
    const result = await createTransaction({ userId, accountId, token, body });
    // Normalize the backend response ({ message, data: { id, groupid, ... } })
    // into a stable shape so confirmations always carry the ids and the
    // controller can emit a structured transactionResult to the client.
    const data = result && typeof result === 'object' ? (result.data || {}) : {};
    return {
      success: true,
      action: 'create',
      transaction_id: data.id ?? null,
      group_id: data.groupid ?? null,
      title: body.title,
      amount: body.amount,
      type: body.type,
      category: body.category,
      start: body.start,
      frequency: body.frequency,
      message: (result && result.message) || 'Transaction has been successfully created.',
    };
  },

  async deleteTransaction(args, ctx) {
    // Identity comes from ctx; the schema sends `transactionid` (older model
    // outputs may use transaction_id). scope='group' deletes EVERY occurrence
    // of a recurring series via its groupid; default deletes one occurrence.
    const { userId, token } = ctx;
    const scope = String(args.scope || 'single').toLowerCase();
    if (scope === 'group') {
      const groupId = args.groupid || args.group_id;
      if (!groupId) throw new Error('groupid is required to delete a recurring series (scope=group). Find it via getRecurringForecasts/getUpcomingTransactions or the RECENT WRITES block, or delete a single occurrence by transactionid instead.');
      const result = await deleteGroupTransactions({ userId, groupId, token });
      return {
        success: true,
        action: 'delete',
        scope: 'group',
        transaction_id: null,
        group_id: groupId,
        message: (result && result.message) || 'Recurring transaction series has been deleted.',
      };
    }
    const transactionId = args.transactionid || args.transaction_id || ctx.id;
    if (!transactionId) throw new Error('transactionid is required to delete a transaction');
    const result = await deleteTransaction({ userId, transactionId, token });
    return {
      success: true,
      action: 'delete',
      scope: 'single',
      transaction_id: transactionId,
      group_id: args.groupid || args.group_id || null,
      message: (result && result.message) || 'Transaction has been deleted.',
    };
  },

  // Update an existing forecasted transaction. Identity (userId/token) comes
  // from ctx; the payload is merged over the existing row so partial edits are
  // safe. The confirm-before-write gate is enforced upstream in executeToolCalls.
  async updateTransaction(args, ctx) {
    const { userId, token } = ctx;
    const body = await buildUpdateTransactionInput(args, ctx);
    const result = await updateTransaction({ userId, transactionId: body.transactionid, token, body });
    return {
      success: true,
      action: 'update',
      transaction_id: body.transactionid,
      group_id: body.groupid ?? null,
      title: body.title,
      amount: body.amount,
      type: body.type,
      category: body.category,
      start: body.start,
      frequency: body.frequency,
      message: (result && result.message) || 'Transaction has been successfully updated.',
    };
  },

  // ── Goals (savings targets) ────────────────────────────────────────────────
  // Read tools return compact summaries with derived progress (progress_pct,
  // remaining_amount, on_track) so the model reports real numbers. Write tools
  // are confirm-gated upstream in executeToolCalls, exactly like transactions.

  async getGoals(args, ctx) {
    const { userId, token, accountId } = ctx;
    if (!accountId) return { goals: [], message: 'No account selected.' };
    const raw = await getGoals({ userId, accountId, token });
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.goals) ? raw.goals : []);
    const goals = list
      .map((g) => summarizeGoalForModel(g, ctx.currentDate))
      .filter(Boolean);
    const active = goals.filter((g) => g.status === 'in_progress');
    return {
      goals,
      active_count: active.length,
      message: goals.length
        ? 'Derived fields: remaining_amount, progress_pct, days_remaining, expected_by_now, and on_track (accumulated vs. what the cadence expects by today). Use these numbers as-is.'
        : 'The user has no goals on this account yet.'
    };
  },

  async previewGoalCadence(args, ctx) {
    const target = Number(args.target_amount);
    if (!Number.isFinite(target) || target <= 0) return { error: 'target_amount must be a positive number.' };
    const today = ctx.currentDate && moment(ctx.currentDate).isValid() ? moment(ctx.currentDate) : moment();
    const start = args.start_date && moment(args.start_date).isValid() ? moment(args.start_date) : today.clone();
    const end = args.end_date && moment(args.end_date).isValid() ? moment(args.end_date) : null;
    if (!end) return { error: 'end_date is required (the date the user wants to reach the target by).' };
    const frequency = String(args.frequency || '');
    if (!GOAL_FREQUENCIES.has(frequency)) {
      return { error: "frequency must be one of: '1' daily, '7' weekly, '14' bi-weekly, '15' semi-monthly, '28'-'31' monthly, '60' bi-monthly, '91' quarterly, '182' semi-annual, '365' annual." };
    }
    const result = await previewGoalCadence({
      token: ctx.token,
      body: {
        target_amount: target,
        start_date: start.format('YYYY-MM-DD'),
        end_date: end.format('YYYY-MM-DD'),
        frequency,
        type: 'expense',
      },
    });
    return {
      ...result,
      note: 'This is a pure preview — nothing was created. amount_per_row is the per-contribution amount (negative = money set aside). Present it to the user (e.g. "$X per week for N weeks") and check it against their upcoming forecasted balances before recommending it.'
    };
  },

  async createGoal(args, ctx) {
    const { userId, token, accountId } = ctx;
    if (!accountId) throw new Error('No account selected — a goal must belong to an account.');
    const body = normalizeCreateGoalInput(args, ctx);
    const result = await createGoal({ userId, accountId, token, body });
    const summary = summarizeGoalForModel(result, ctx.currentDate) || {};
    return {
      success: true,
      action: 'create_goal',
      goal_id: result?.goalid ?? null,
      title: body.title,
      target_amount: body.target_amount,
      start_date: body.start_date,
      end_date: body.end_date,
      frequency: body.frequency,
      contribution_count: summary.contribution_count ?? null,
      next_contribution: summary.next_contribution ?? null,
      message: 'Goal created. Its scheduled contributions now appear on the user\'s calendar as forecasted set-asides.',
    };
  },

  async updateGoal(args, ctx) {
    const { userId, token } = ctx;
    const goalId = args.goalid || args.goal_id;
    if (!goalId) throw new Error('goalid is required to update a goal — find it via getGoals first.');
    // The backend enforces optimistic concurrency; read the current row to
    // supply expectedUpdatedAt (and to preserve unspecified fields).
    const existing = await getGoal({ goalId, token });
    if (!existing || !existing.goalid) throw new Error('Goal not found.');
    const body = { expectedUpdatedAt: existing.updatedAt };
    for (const k of ['title', 'display_name', 'category', 'description', 'notes', 'target_amount', 'frequency', 'start_date', 'end_date']) {
      if (args[k] !== undefined && args[k] !== null && String(args[k]).trim() !== '') body[k] = args[k];
    }
    if (body.frequency !== undefined) body.frequency = String(body.frequency);
    const result = await updateGoal({ userId, goalId, token, body });
    return {
      success: true,
      action: 'update_goal',
      goal_id: goalId,
      title: result?.title ?? body.title ?? existing.title,
      target_amount: result?.target_amount ?? body.target_amount ?? existing.target_amount,
      end_date: result?.end_date ?? body.end_date ?? existing.end_date,
      message: 'Goal updated. Unlocked future contributions were redistributed to match the new plan.',
    };
  },

  async deleteGoal(args, ctx) {
    const { userId, token } = ctx;
    const goalId = args.goalid || args.goal_id;
    if (!goalId) throw new Error('goalid is required to delete a goal — find it via getGoals first.');
    const result = await deleteGoal({ userId, goalId, token });
    return {
      success: true,
      action: 'delete_goal',
      goal_id: goalId,
      message: (result && result.message) || 'Goal deleted.',
    };
  },

  // ── Simulation ("what-if") propose tools ──────────────────────────────────
  // NONE of these write to the database. Each returns a structured `simOp`
  // that the frontend applies to its client-side simulation overlay, where the
  // user reviews the change on the calendar and commits or discards it.

  async proposeSimulationAdd(args, ctx) {
    const payload = normalizeCreateTransactionInput(args, ctx);
    return {
      ok: true,
      simulated: true,
      simOp: {
        kind: 'add',
        payload,
        tempId: `simadd_${Date.now().toString(36)}`
      },
      note: 'Hypothetical transaction staged in the user\'s simulation overlay. Nothing was written to the database. Describe the change and its projected impact; the user commits or discards from the simulation banner.'
    };
  },

  async proposeSimulationModify(args, ctx) {
    const transactionId = args.transactionid || args.transaction_id;
    if (!transactionId) return { error: 'transactionid is required to simulate a change to an existing transaction.' };

    const existing = await fetchTransactionRow(transactionId, ctx.token);
    if (String(existing.forecast_type || '').toUpperCase() === 'A') {
      return { error: 'Actual (posted) transactions cannot be simulated — only forecasted transactions can be changed in a simulation.' };
    }

    const payload = await buildUpdateTransactionInput(args, ctx, existing);
    const scope = ['single', 'group', 'groupfrom'].includes(String(args.scope || '').toLowerCase())
      ? String(args.scope).toLowerCase()
      : 'single';
    const anchorRaw = existing.start || existing.date;
    return {
      ok: true,
      simulated: true,
      simOp: {
        kind: 'modify',
        payload,
        targetTransactionId: transactionId,
        targetGroupId: args.groupid || existing.groupid || undefined,
        scope,
        anchorDate: anchorRaw && moment(anchorRaw).isValid() ? moment(anchorRaw).format('YYYY/MM/DD') : undefined,
        originalFrequency: existing.frequency,
        originalEnd: existing.end
      },
      note: 'Hypothetical change staged in the user\'s simulation overlay. Nothing was written to the database. Describe the change and its projected impact; the user commits or discards from the simulation banner.'
    };
  },

  async proposeSimulationRemove(args, ctx) {
    const transactionId = args.transactionid || args.transaction_id;
    if (!transactionId) return { error: 'transactionid is required to simulate removing an existing transaction.' };

    const existing = await fetchTransactionRow(transactionId, ctx.token);
    if (String(existing.forecast_type || '').toUpperCase() === 'A') {
      return { error: 'Actual (posted) transactions cannot be simulated — only forecasted transactions can be removed in a simulation.' };
    }

    const scope = ['single', 'group', 'groupfrom'].includes(String(args.scope || '').toLowerCase())
      ? String(args.scope).toLowerCase()
      : 'single';
    const anchorRaw = existing.start || existing.date;
    return {
      ok: true,
      simulated: true,
      simOp: {
        kind: 'remove',
        targetTransactionId: transactionId,
        targetGroupId: args.groupid || existing.groupid || undefined,
        scope,
        anchorDate: anchorRaw && moment(anchorRaw).isValid() ? moment(anchorRaw).format('YYYY/MM/DD') : undefined
      },
      note: 'Hypothetical removal staged in the user\'s simulation overlay. Nothing was deleted from the database. Describe the change and its projected impact; the user commits or discards from the simulation banner.'
    };
  },

  // ── Shopping list: Smart Price Assist (propose-only) ──────────────────────
  // Returns advisory purchase options + normalization/category hints for one
  // item. Never writes anything; the user applies an option explicitly in the
  // shopping list UI (or via the cashflow backend's suggestions proxy).
  async suggestShoppingItemOptions(args, _ctx) {
    const { suggestItemOptions } = require('../services/shoppingSuggest.service');
    try {
      const result = await suggestItemOptions({
        itemName: args.itemName,
        quantity: args.quantity,
        region: args.region,
        userEstimate: args.userEstimate
      });
      return {
        ok: true,
        ...result,
        note: 'These are ESTIMATES of typical retail prices, not live prices. Present the options with their stores and confidence, mention the price flag if present, and remind the user their own estimate stays unless they pick one.'
      };
    } catch (e) {
      console.error('suggestShoppingItemOptions failed:', e.message);
      return { error: 'Price suggestions are unavailable right now. The user\'s manual estimate still works.' };
    }
  },

  // Persist a durable fact about the user. accountScoped=true ties it to the
  // currently selected account; otherwise it's a user-level fact.
  async rememberFact(args, ctx) {
    const { userId, token, accountId } = ctx;
    const accountid = args.accountScoped ? accountId : null;
    const result = await rememberFact({
      userId,
      token,
      mem_key: args.mem_key,
      mem_value: args.mem_value,
      kind: args.kind || 'fact',
      importance: args.importance,
      accountid,
    });
    return result;
  },

  // Retrieve durable facts (account-scoped + user-level) for the current user.
  async recallFacts(args, ctx) {
    const { userId, token, accountId } = ctx;
    const result = await recallFacts({ userId, token, accountId, limit: args.limit });
    return result;
  }
};

module.exports = { functionMap, __testables: { normalizeCreateTransactionInput, toDateAnchoredISO } };
