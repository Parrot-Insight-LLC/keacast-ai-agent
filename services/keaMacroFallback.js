'use strict';

function fmtMoney(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const formatted = abs < 10 ? abs.toFixed(2) : String(Math.round(abs));
  return `${sign}$${formatted}`;
}

function accountClause(accountName) {
  const name = accountName ? String(accountName).trim() : '';
  return name ? ` These figures use posted transactions for ${name}.` : ' These figures use posted transactions for the selected account.';
}

function changeLine(label, change) {
  if (!change || typeof change.absolute !== 'number' || !Number.isFinite(change.absolute)) return null;
  const abs = fmtMoney(Math.abs(change.absolute));
  if (!abs) return null;
  let direction = 'changed by';
  if (change.absolute > 0) direction = 'increased by';
  if (change.absolute < 0) direction = 'decreased by';
  let line = `${label} ${direction} ${abs}`;
  if (typeof change.percent === 'number' && Number.isFinite(change.percent)) {
    line += ` (${Math.abs(Math.round(change.percent))}%)`;
  }
  return `${line}.`;
}

function buildComparisonFallback(evidence, accountName) {
  const facts = evidence && evidence.facts;
  if (!facts || !facts.periodA || !facts.periodB || !facts.changes) return null;
  const a = facts.periodA.label || [facts.periodA.start, facts.periodA.end].filter(Boolean).join('–');
  const b = facts.periodB.label || [facts.periodB.start, facts.periodB.end].filter(Boolean).join('–');
  if (!a || !b) return null;
  const lines = [`From ${b} compared with ${a}:`];
  const spending = changeLine('Spending', facts.changes.spending);
  const income = changeLine('Income', facts.changes.income);
  const net = facts.changes.net;
  if (spending) lines.push(`- ${spending}`);
  if (income) lines.push(`- ${income}`);
  if (net && typeof net.absolute === 'number' && Number.isFinite(net.absolute)) {
    const abs = fmtMoney(Math.abs(net.absolute));
    if (abs) {
      const verb = net.absolute > 0 ? 'improved' : net.absolute < 0 ? 'worsened' : 'was unchanged';
      lines.push(`- Net cash flow ${verb} by ${abs}.`);
    }
  }
  if (lines.length < 2) return null;
  const cats = facts.categoryChanges || {};
  const inc = Array.isArray(cats.topIncreases) ? cats.topIncreases[0] : null;
  const dec = Array.isArray(cats.topDecreases) ? cats.topDecreases[0] : null;
  if (inc && inc.category && typeof inc.absolute === 'number' && Number.isFinite(inc.absolute)) {
    const amt = fmtMoney(Math.abs(inc.absolute));
    if (amt) lines.push(`- ${inc.category} spending increased by ${amt}.`);
  }
  if (dec && dec.category && typeof dec.absolute === 'number' && Number.isFinite(dec.absolute)) {
    const amt = fmtMoney(Math.abs(dec.absolute));
    if (amt) lines.push(`- ${dec.category} spending decreased by ${amt}.`);
  }
  return `${lines.join('\n')}${accountClause(accountName)}`;
}

function buildTrendFallback(evidence, accountName) {
  const facts = evidence && evidence.facts;
  if (!facts || !Array.isArray(facts.periods) || facts.periods.length !== 3 || !facts.trend) return null;
  const labels = facts.periods.map((p) => p && (p.label || [p.start, p.end].filter(Boolean).join('–')));
  if (labels.some((l) => !l)) return null;
  const scope = facts.metricScope === 'income' ? 'income' : facts.metricScope === 'net' ? 'net cash flow' : 'spending';
  const focused = facts.metricScope === 'income'
    ? facts.trend.income
    : facts.metricScope === 'net'
      ? facts.trend.net
      : facts.trend.spending;
  const direction = focused && focused.direction ? focused.direction : null;
  if (!direction) return null;
  const first = facts.periods[0];
  const last = facts.periods[2];
  const field = facts.metricScope === 'income' ? 'income' : facts.metricScope === 'net' ? 'net' : 'spending';
  const firstAmt = fmtMoney(first[field]);
  const lastAmt = fmtMoney(last[field]);
  let text = `Across ${labels[0]}, ${labels[1]}, and ${labels[2]}, your ${scope} trend was ${direction}.`;
  if (firstAmt && lastAmt) {
    text += ` ${scope.charAt(0).toUpperCase()}${scope.slice(1)} changed from ${firstAmt} in the first period to ${lastAmt} in the most recent period.`;
  }
  if (facts.highest && facts.highest.label && typeof facts.highest.value === 'number') {
    const high = fmtMoney(facts.highest.value);
    if (high) text += ` Highest ${scope} was ${high} (${facts.highest.label}).`;
  }
  return `${text}${accountClause(accountName)}`;
}

function buildAffordabilityFallback(evidence) {
  const facts = evidence && evidence.facts;
  if (!facts || !facts.requested || !facts.baseline || !facts.hypothetical) return null;
  const amount = fmtMoney(facts.requested.amount);
  const date = facts.requested.purchaseDate;
  if (!amount || !date) return null;
  const baseline = fmtMoney(facts.baseline.projectedOnDate);
  const hypo = fmtMoney(facts.hypothetical.projectedOnDate);
  const low = fmtMoney(facts.hypothetical.lowestAfterDate);
  const lines = [`Based on the current Keacast forecast, adding a ${amount} expense on ${date}:`];
  if (baseline) lines.push(`- Baseline projected balance on that date: ${baseline}.`);
  if (hypo) lines.push(`- Hypothetical projected balance on that date: ${hypo}.`);
  if (low) {
    const on = facts.hypothetical.lowestAfterDateOn ? ` on ${facts.hypothetical.lowestAfterDateOn}` : '';
    lines.push(`- Lowest projected balance after the purchase: ${low}${on}.`);
  }
  const delta = facts.delta || {};
  if (delta.newNegativeIntroduced === true) {
    lines.push('- Adding this expense would introduce a negative projected balance in the evaluation horizon.');
  } else if (delta.newNegativeIntroduced === false) {
    lines.push('- Adding this expense would not introduce a new negative projected balance in the evaluation horizon.');
  }
  if (facts.hypothetical.firstNegativeDate) {
    lines.push(`- First negative projected date: ${facts.hypothetical.firstNegativeDate}.`);
  }
  if (lines.length < 2) return null;
  return lines.join('\n');
}

function buildCashflowFallback(evidence) {
  const facts = evidence && evidence.facts;
  if (!facts) return null;
  const income = fmtMoney(facts.postedIncome);
  const spending = fmtMoney(facts.postedSpending);
  const net = fmtMoney(facts.postedNet);
  if (!income && !spending && !net) return null;
  const period = evidence.period && (evidence.period.label || [evidence.period.start, evidence.period.end].filter(Boolean).join('–'));
  const head = period ? `For ${period}:` : 'For the requested period:';
  const lines = [head];
  if (income) lines.push(`- Posted income: ${income}.`);
  if (spending) lines.push(`- Posted spending: ${spending}.`);
  if (net) lines.push(`- Posted net: ${net}.`);
  if (typeof facts.remainingForecastSpending === 'number') {
    const rem = fmtMoney(facts.remainingForecastSpending);
    if (rem) lines.push(`- Remaining forecast spending this month: ${rem}.`);
  }
  if (typeof facts.savingsPotential === 'number') {
    const low = fmtMoney(facts.savingsPotential);
    if (low) lines.push(`- Lowest projected balance through the current month: ${low}.`);
  }
  const risk = facts.negativeBalanceRisk;
  if (risk && risk.hasNegativeInScope === false && risk.scope) {
    lines.push('- The current Keacast forecast does not show a negative balance in the requested scope.');
  } else if (risk && risk.hasNegativeInScope === true && risk.lowestProjectedAmount != null && risk.lowestProjectedDate) {
    const low = fmtMoney(risk.lowestProjectedAmount);
    if (low) lines.push(`- Lowest projected balance in scope: ${low} on ${risk.lowestProjectedDate}.`);
  }
  return lines.join('\n');
}

function buildMacroFallbackText(evidence, { accountName } = {}) {
  if (!evidence || evidence.status !== 'ok' || !Array.isArray(evidence.source) || !evidence.source.length) {
    return null;
  }
  if (evidence.source.includes('cashflow_period_comparison')) {
    return buildComparisonFallback(evidence, accountName);
  }
  if (evidence.source.includes('cashflow_trend')) {
    return buildTrendFallback(evidence, accountName);
  }
  if (evidence.source.includes('affordability_analysis')) {
    return buildAffordabilityFallback(evidence);
  }
  if (evidence.source.includes('cashflow_analysis')) {
    return buildCashflowFallback(evidence);
  }
  if (evidence.source.includes('cashflow_upcoming')) {
    return buildUpcomingFallback(evidence);
  }
  return null;
}

function buildUpcomingFallback(evidence) {
  const facts = evidence && evidence.facts;
  const period = (facts && facts.period) || (evidence && evidence.period) || {};
  const start = period.start;
  const end = period.end;
  if (!start || !end) return null;
  const items = facts && Array.isArray(facts.items) ? facts.items : [];
  const totals = (facts && facts.totals) || {};
  if (!items.length) {
    return `I don't see any scheduled items in your Keacast forecast for ${start}–${end}.`;
  }
  const lines = [`Scheduled items in your Keacast forecast for ${start}–${end}:`];
  for (const item of items.slice(0, 20)) {
    if (!item || !item.label || !item.date) continue;
    const amt = fmtMoney(item.amount);
    lines.push(`- ${item.label} on ${item.date}${amt ? `: ${amt}` : ''}.`);
  }
  if (typeof totals.scheduledExpenseTotal === 'number') {
    const total = fmtMoney(totals.scheduledExpenseTotal);
    if (total) lines.push(`- Scheduled expense total: ${total}.`);
  } else if (typeof totals.scheduledIncomeTotal === 'number') {
    const total = fmtMoney(totals.scheduledIncomeTotal);
    if (total) lines.push(`- Scheduled income total: ${total}.`);
  }
  return lines.length > 1 ? lines.join('\n') : null;
}

module.exports = {
  buildMacroFallbackText,
  buildComparisonFallback,
  buildTrendFallback,
  buildAffordabilityFallback,
  buildCashflowFallback,
};
