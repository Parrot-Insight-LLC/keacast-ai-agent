'use strict';

const moment = require('moment');

const COMPACT_RECENTS = 10;
const COMPACT_UPCOMING = 10;
const COMPACT_NEGATIVES = 5;
const COMPACT_TOP_CATS = 5;
const COMPACT_TOP_MERCHANTS = 3;
const SECRET_KEY = /token|password|secret|authorization/i;

function utf8Bytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (e) {
    return 0;
  }
}

function measurePayloadKeyBytes(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const keys = {};
  for (const k of Object.keys(obj)) {
    if (SECRET_KEY.test(k)) continue;
    keys[k] = utf8Bytes(obj[k]);
  }
  return keys;
}

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

function slimTxn(t) {
  if (!t || typeof t !== 'object') return null;
  const amount = typeof t.amount === 'number' ? t.amount : Number(t.amount);
  const out = {};
  if (t.merchant_name) out.merchant_name = String(t.merchant_name).slice(0, 64);
  if (t.name) out.name = String(t.name).slice(0, 64);
  if (Number.isFinite(amount)) out.amount = amount;
  if (t.date) out.date = t.date;
  if (t.start) out.start = t.start;
  if (t.authorized_date) out.authorized_date = t.authorized_date;
  if (t.category) out.category = String(t.category).slice(0, 64);
  return out.amount != null || out.name || out.merchant_name ? out : null;
}

function txnTime(t) {
  return moment(t?.date || t?.start || t?.authorized_date || 0).valueOf();
}

function aggregateTopCategories(account, limit) {
  const rows = [];
  const pools = [account.breakdown, account.recents];
  for (const pool of pools) {
    if (!Array.isArray(pool) || pool.length === 0) continue;
    for (const r of pool) {
      if (!r) continue;
      if (Array.isArray(r.transactions)) rows.push(...r.transactions);
      else rows.push(r);
    }
    if (rows.length > 0) break;
  }
  const totals = new Map();
  for (const t of rows) {
    const amt = Number(t?.amount);
    if (!Number.isFinite(amt) || amt >= 0) continue;
    const cat = String(t?.category || '').trim();
    if (!cat) continue;
    totals.set(cat, (totals.get(cat) || 0) + Math.abs(amt));
  }
  return Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([category, total]) => ({ category, total }));
}

function aggregateTopMerchants(account, limit) {
  const totals = new Map();
  for (const t of flattenRecents(account)) {
    const amt = typeof t?.amount === 'number' ? t.amount : Number(t?.amount);
    if (!Number.isFinite(amt) || amt >= 0) continue;
    const name = (t.merchant_name || t.name || t.category || 'Other').toString().slice(0, 28);
    totals.set(name, (totals.get(name) || 0) + Math.abs(amt));
  }
  return Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, total]) => ({ name, total }));
}

function categoryNames(account) {
  const raw = Array.isArray(account?.categories) ? account.categories : [];
  const names = [];
  for (const c of raw) {
    if (typeof c === 'string') {
      if (c.trim()) names.push(c.trim());
    } else if (c && typeof c === 'object') {
      const n = c.name || c.category || c.title;
      if (n && String(n).trim()) names.push(String(n).trim());
    }
  }
  return Array.from(new Set(names));
}

function compactGoals(goals, currentDate) {
  if (!Array.isArray(goals) || goals.length === 0) return [];
  const today = currentDate && moment(currentDate).isValid() ? moment(currentDate) : moment();
  const out = [];
  for (const g of goals) {
    if (!g || g.status === 'abandoned') continue;
    let expectedByNow = Number(g.expectedByNow);
    if (!Number.isFinite(expectedByNow)) {
      expectedByNow = 0;
      for (const c of (Array.isArray(g.contributions) ? g.contributions : [])) {
        if (!c || c.status === 'Skipped') continue;
        const start = moment(c.start);
        if (start.isValid() && start.isSameOrBefore(today, 'day')) {
          expectedByNow += Math.abs(Number(c.amount) || 0);
        }
      }
    }
    out.push({
      goalid: g.goalid,
      title: g.title || null,
      display_name: g.display_name || null,
      status: g.status || null,
      target_amount: Number(g.target_amount) || 0,
      accumulated_amount: Number(g.accumulated_amount) || 0,
      end_date: g.end_date || null,
      expectedByNow,
    });
  }
  return out;
}

function compactSavings(sav) {
  if (!sav || typeof sav !== 'object') return null;
  const num = (v) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    savingsPotential: num(sav.savingsPotential),
    totalIncome: num(sav.totalIncome),
    totalExpenses: num(sav.totalExpenses),
    netCashFlow: num(sav.netCashFlow),
    savingsPercentage: num(sav.savingsPercentage),
  };
}

function compactSelectedAccount(account, currentDate) {
  if (!account || typeof account !== 'object') return null;
  if (account._keaCompact === true) return account;

  const recents = flattenRecents(account)
    .sort((a, b) => txnTime(b) - txnTime(a))
    .slice(0, COMPACT_RECENTS)
    .map(slimTxn)
    .filter(Boolean);

  const upcoming = (Array.isArray(account.upcoming) ? account.upcoming : [])
    .slice(0, COMPACT_UPCOMING)
    .map(slimTxn)
    .filter(Boolean);

  const negatives = (Array.isArray(account.futureNegativeBalances) ? account.futureNegativeBalances : [])
    .slice(0, COMPACT_NEGATIVES)
    .map((b) => {
      const amount = typeof b?.amount === 'number' ? b.amount : Number(b?.amount);
      return {
        amount: Number.isFinite(amount) ? amount : undefined,
        date: b?.date || null,
        daysUntil: b?.daysUntil || null,
      };
    });

  const firstName =
    account.user?.firstname || account.user?.firstName || account.user?.first_name || null;

  return {
    _keaCompact: true,
    accountid: account.accountid,
    accountname: account.accountname || null,
    bank_account_name: account.bank_account_name || null,
    institution_name: account.institution_name || null,
    account_type: account.account_type || account.type || null,
    balance: typeof account.balance === 'number' ? account.balance : Number(account.balance),
    available: typeof account.available === 'number' ? account.available : Number(account.available),
    credit_limit: typeof account.credit_limit === 'number' ? account.credit_limit : Number(account.credit_limit) || undefined,
    plaid_latest: account.plaid_latest || null,
    savings: compactSavings(account.savings),
    upcomingExpenseTotal: typeof account.upcomingExpenseTotal === 'number' ? account.upcomingExpenseTotal : undefined,
    upcomingIncomeTotal: typeof account.upcomingIncomeTotal === 'number' ? account.upcomingIncomeTotal : undefined,
    futureNegativeBalances: negatives,
    recents,
    upcoming,
    categories: categoryNames(account).map((name) => ({ name })),
    goals: compactGoals(account.goals, currentDate),
    topSpendingCategories: aggregateTopCategories(account, COMPACT_TOP_CATS),
    topSpendingMerchants: aggregateTopMerchants(account, COMPACT_TOP_MERCHANTS),
    user: firstName ? { firstname: String(firstName).trim().split(/\s+/)[0] } : undefined,
  };
}

module.exports = {
  compactSelectedAccount,
  measurePayloadKeyBytes,
  utf8Bytes,
};
