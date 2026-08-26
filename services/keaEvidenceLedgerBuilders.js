'use strict';

/**
 * Evidence Ledger V1 builders (Phase 3B.1)
 *
 * Pure functions over the existing Agent prefetch evidence object.
 * Copy / classify / label / index. Do not calculate financial values.
 */

const {
  LEDGER_STATUS,
  CLAIM_UNITS,
  SIGN_CONVENTION,
  SCENARIO,
  SOURCE_KIND,
  cloneJson,
  deepFreeze,
  copyPeriod,
  firstSourceKind,
  sourceDescriptionFor,
  sourceDefinitionFor,
  copyLimitations,
  copyObservations,
  copyAssumptions,
  hasLimitation,
  findObservation,
  indexList,
  emptyScope,
  ClaimIndex,
  narration,
  statusFromEvidence,
  isCompletedHistoricalPeriod,
  completedHistoricalClientDate,
  baseLedger,
  isNoLedgerCapability,
  validateEvidenceLedgerV1,
} = require('./keaEvidenceLedger');

const BUILDERS = Object.freeze({
  cashflow_upcoming: buildUpcomingEvidenceLedger,
  cashflow_recurring: buildRecurringEvidenceLedger,
  cashflow_income_horizon: buildIncomeHorizonEvidenceLedger,
  cashflow_comparison: buildComparisonEvidenceLedger,
  cashflow_trend: buildTrendEvidenceLedger,
  cashflow_analysis: buildCashflowEvidenceLedger,
  affordability_or_planning: buildAffordabilityEvidenceLedger,
  financial_lookup: buildLookupEvidenceLedger,
  financial_forecast: buildSnapshotEvidenceLedger,
});

function resolveCapability({ capability, route, evidence } = {}) {
  if (capability && capability !== 'continuation') return capability;
  if (route && route.parentCapability) return route.parentCapability;
  const kind = firstSourceKind(evidence);
  if (kind === SOURCE_KIND.CASHFLOW_UPCOMING) return 'cashflow_upcoming';
  if (kind === SOURCE_KIND.CASHFLOW_RECURRING) return 'cashflow_recurring';
  if (kind === SOURCE_KIND.CASHFLOW_INCOME_HORIZON) return 'cashflow_income_horizon';
  if (kind === SOURCE_KIND.CASHFLOW_PERIOD_COMPARISON) return 'cashflow_comparison';
  if (kind === SOURCE_KIND.CASHFLOW_TREND) return 'cashflow_trend';
  if (kind === SOURCE_KIND.CASHFLOW_ANALYSIS) return 'cashflow_analysis';
  if (kind === SOURCE_KIND.AFFORDABILITY_ANALYSIS) return 'affordability_or_planning';
  if (kind === SOURCE_KIND.USER_TRANSACTIONS) return 'financial_lookup';
  if (kind === SOURCE_KIND.KEA_SNAPSHOT) return 'financial_forecast';
  return capability || (route && route.capability) || null;
}

function accountLabelFrom(accountContext) {
  if (!accountContext || typeof accountContext !== 'object') return null;
  const label = accountContext.accountLabel || accountContext.accountName || null;
  return label ? String(label) : null;
}

function accountIdFrom(accountContext) {
  if (!accountContext || accountContext.accountId == null || accountContext.accountId === '') {
    return null;
  }
  return String(accountContext.accountId);
}

function responseModeFrom({ responseMode, route } = {}) {
  if (responseMode) return responseMode;
  if (route && route.responseMode) return route.responseMode;
  const slots = route && route.slots;
  if (slots && slots.rankingMode === 'largest') return 'largest';
  return null;
}

function copyDefined(source, keys) {
  const out = {};
  const src = source && typeof source === 'object' ? source : {};
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (src[key] !== undefined) out[key] = cloneJson(src[key]);
  }
  return out;
}

function periodFromEvidence(evidence) {
  return copyPeriod((evidence && evidence.period)
    || (evidence && evidence.facts && evidence.facts.period)
    || null);
}

function internalFrom(evidence, accountContext, builder) {
  return {
    accountId: accountIdFrom(accountContext),
    observations: copyObservations(evidence),
    prefetchMeta: evidence && evidence.prefetchMeta ? cloneJson(evidence.prefetchMeta) : null,
    builder,
  };
}

function finish(ledger) {
  const validated = validateEvidenceLedgerV1(ledger);
  if (!validated.ok) {
    return { ok: false, reason: 'validation_failed', errors: validated.errors };
  }
  return { ok: true, ledger: deepFreeze(ledger) };
}

function unavailableLedger({ capability, responseMode, evidence, accountContext, builder }) {
  const limitations = copyLimitations(evidence);
  const kind = firstSourceKind(evidence);
  const status = statusFromEvidence(evidence);
  const scope = emptyScope();
  scope.accountScope = (evidence && evidence.accountScope) || 'selected_account';
  scope.accountLabel = accountLabelFrom(accountContext);
  scope.period = periodFromEvidence(evidence);
  const ledger = baseLedger({
    status,
    capability,
    responseMode,
    source: {
      kind,
      definition: kind,
      description: sourceDescriptionFor(kind, null),
    },
    scope,
    facts: {},
    claims: [],
    lists: {},
    limitations,
    assumptions: copyAssumptions(evidence),
    allowedNarration: [],
    prohibitedNarration: [],
    internal: internalFrom(evidence, accountContext, builder),
  });
  return finish(ledger);
}

function upcomingEmptyAllowed(metricScope, period) {
  const start = period && period.start;
  const end = period && period.end;
  const range = start && end ? ` for ${start}–${end}` : ' for the selected period';
  const metric = metricScope === 'income'
    ? 'income'
    : metricScope === 'expense'
      ? 'expenses'
      : 'items';
  return narration(
    'scheduled_empty',
    `No scheduled ${metric} exists in this Keacast forecast${range}.`
  );
}

function buildUpcomingEvidenceLedger(input) {
  const { evidence, accountContext } = input;
  const factsIn = (evidence && evidence.facts) || {};
  const itemsIn = Array.isArray(factsIn.items) ? factsIn.items : [];
  const totals = factsIn.totals && typeof factsIn.totals === 'object' ? factsIn.totals : {};
  const metricScope = factsIn.metricScope || null;
  const period = periodFromEvidence(evidence);
  const limitations = copyLimitations(evidence);
  const observations = copyObservations(evidence);
  const emptyObservation = findObservation(observations, 'no_upcoming_in_period');
  const itemCount = evidence && evidence.prefetchMeta && evidence.prefetchMeta.itemCount != null
    ? evidence.prefetchMeta.itemCount
    : (factsIn.itemCount != null ? factsIn.itemCount : itemsIn.length);
  const empty = itemsIn.length === 0
    && (emptyObservation != null
      || itemCount === 0
      || totals.scheduledIncomeTotal === 0
      || totals.scheduledExpenseTotal === 0);
  const indexed = indexList(itemsIn, {
    truncated: hasLimitation(limitations, 'list_capped'),
    totalCount: itemCount,
    cap: hasLimitation(limitations, 'list_capped') ? itemsIn.length : null,
  });
  const claims = new ClaimIndex();
  if (period && period.start && period.end) {
    claims.add('DATE_RANGE', 'scope.period', { start: period.start, end: period.end }, CLAIM_UNITS.DATE);
  }
  if (metricScope != null) claims.add('LABEL', 'facts.metricScope', metricScope, CLAIM_UNITS.NONE);
  claims.add('COUNT', 'facts.itemCount', itemCount, CLAIM_UNITS.COUNT);
  if (totals.scheduledExpenseTotal !== undefined) {
    claims.add('TOTAL', 'facts.totals.scheduledExpenseTotal', totals.scheduledExpenseTotal, CLAIM_UNITS.USD);
  }
  if (totals.scheduledIncomeTotal !== undefined) {
    claims.add('TOTAL', 'facts.totals.scheduledIncomeTotal', totals.scheduledIncomeTotal, CLAIM_UNITS.USD);
  }
  if (totals.scheduledNet !== undefined) {
    claims.add('TOTAL', 'facts.totals.scheduledNet', totals.scheduledNet, CLAIM_UNITS.USD);
  }

  const allowedNarration = [];
  const prohibitedNarration = [
    narration('do_not_generalize_no_income', 'Do not claim the user has no income or no incoming funds from any source.'),
    narration('do_not_widen_period', 'Do not widen, shift, or relabel the supplied period.'),
    narration('do_not_recalculate', 'Do not recalculate totals, counts, or dates.'),
  ];
  if (empty) allowedNarration.push(upcomingEmptyAllowed(metricScope, period));

  const facts = {
    signConvention: SIGN_CONVENTION.MAGNITUDE,
    metricScope,
    period: factsIn.period ? copyPeriod(factsIn.period) : period,
    items: indexed.items,
    totals: cloneJson(totals),
    itemCount,
    accountScope: factsIn.accountScope || evidence.accountScope || 'selected_account',
  };

  const scope = emptyScope();
  scope.accountScope = facts.accountScope;
  scope.accountLabel = accountLabelFrom(accountContext);
  scope.period = period;
  scope.metricScope = metricScope;

  return finish(baseLedger({
    status: statusFromEvidence(evidence, { empty }),
    capability: 'cashflow_upcoming',
    responseMode: responseModeFrom(input),
    source: {
      kind: SOURCE_KIND.CASHFLOW_UPCOMING,
      definition: SOURCE_KIND.CASHFLOW_UPCOMING,
      description: sourceDescriptionFor(SOURCE_KIND.CASHFLOW_UPCOMING, metricScope),
    },
    scope,
    facts,
    claims: claims.claims,
    lists: { items: indexed.meta },
    limitations,
    assumptions: copyAssumptions(evidence),
    allowedNarration,
    prohibitedNarration,
    internal: internalFrom(evidence, accountContext, 'upcoming'),
  }));
}

function streamByLabel(list, label) {
  if (!Array.isArray(list) || !label) return null;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] && list[i].label === label) return list[i];
  }
  return null;
}

const LARGEST_STREAM_KEYS = Object.freeze([
  'itemId',
  'label',
  'amount',
  'monthlyEquivalent',
  'nextDate',
  'frequency',
  'frequencyLabel',
  'category',
  'variableAmount',
]);

function copyLargestStream(provided, observation, indexedItems) {
  if (provided && typeof provided === 'object' && !Array.isArray(provided)) {
    return copyDefined(provided, LARGEST_STREAM_KEYS);
  }
  if (!observation) return null;
  const fromList = streamByLabel(indexedItems, observation.label);
  if (fromList) return copyDefined(fromList, LARGEST_STREAM_KEYS);
  return null;
}

function buildRecurringEvidenceLedger(input) {
  const { evidence, accountContext } = input;
  const factsIn = (evidence && evidence.facts) || {};
  const limitations = copyLimitations(evidence);
  const observations = copyObservations(evidence);
  const expensesIn = Array.isArray(factsIn.expenses) ? factsIn.expenses : [];
  const incomeIn = Array.isArray(factsIn.income) ? factsIn.income : [];
  const truncated = hasLimitation(limitations, 'list_capped');
  const expenses = indexList(expensesIn, {
    truncated,
    totalCount: expensesIn.length,
    cap: truncated ? expensesIn.length : null,
  });
  const income = indexList(incomeIn, {
    truncated,
    totalCount: incomeIn.length,
    cap: truncated ? incomeIn.length : null,
  });
  const empty = findObservation(observations, 'no_scheduled_recurring') != null
    && expensesIn.length === 0
    && incomeIn.length === 0;
  const metricScope = factsIn.metricScope || 'all';
  const rankingMode = factsIn.rankingMode === 'largest' ? 'largest' : null;
  const totals = factsIn.totals && typeof factsIn.totals === 'object' ? cloneJson(factsIn.totals) : {};
  const definition = factsIn.recurringDefinition || sourceDefinitionFor(SOURCE_KIND.CASHFLOW_RECURRING, factsIn);

  const claims = new ClaimIndex();
  claims.add('DEFINITION', 'facts.recurringDefinition', definition, CLAIM_UNITS.NONE);
  claims.add('LABEL', 'facts.metricScope', metricScope, CLAIM_UNITS.NONE);
  if (rankingMode) claims.add('LABEL', 'facts.rankingMode', rankingMode, CLAIM_UNITS.NONE);
  claims.add('COUNT', 'facts.expenseCount', expensesIn.length, CLAIM_UNITS.COUNT);
  claims.add('COUNT', 'facts.incomeCount', incomeIn.length, CLAIM_UNITS.COUNT);
  if (totals.recurringExpenseMonthlyEquivalent !== undefined) {
    claims.add('TOTAL', 'facts.totals.recurringExpenseMonthlyEquivalent', totals.recurringExpenseMonthlyEquivalent, CLAIM_UNITS.USD);
  }
  if (totals.recurringIncomeMonthlyEquivalent !== undefined) {
    claims.add('TOTAL', 'facts.totals.recurringIncomeMonthlyEquivalent', totals.recurringIncomeMonthlyEquivalent, CLAIM_UNITS.USD);
  }
  if (totals.nextOccurrenceExpenseSum !== undefined) {
    claims.add('TOTAL', 'facts.totals.nextOccurrenceExpenseSum', totals.nextOccurrenceExpenseSum, CLAIM_UNITS.USD);
  }

  const largestExpObs = findObservation(observations, 'largest_recurring_expense');
  const largestIncObs = findObservation(observations, 'largest_recurring_income');
  const largestExp = copyLargestStream(factsIn.largestExpense, largestExpObs, expenses.items);
  const largestInc = copyLargestStream(factsIn.largestIncome, largestIncObs, income.items);
  if (largestExp) {
    claims.add('LABEL', 'facts.largestExpense.label', largestExp.label, CLAIM_UNITS.NONE);
    if (largestExp.amount !== undefined) {
      claims.add('AMOUNT', 'facts.largestExpense.amount', largestExp.amount, CLAIM_UNITS.USD);
    }
    if (largestExp.monthlyEquivalent !== undefined) {
      claims.add('AMOUNT', 'facts.largestExpense.monthlyEquivalent', largestExp.monthlyEquivalent, CLAIM_UNITS.USD);
    }
    if (largestExp.nextDate !== undefined) {
      claims.add('DATE', 'facts.largestExpense.nextDate', largestExp.nextDate, CLAIM_UNITS.DATE);
    }
  } else if (largestExpObs) {
    if (largestExpObs.label !== undefined) {
      claims.add('LABEL', 'facts.largestExpense.label', largestExpObs.label, CLAIM_UNITS.NONE);
    }
    if (largestExpObs.monthlyEquivalent !== undefined) {
      claims.add('AMOUNT', 'facts.largestExpense.monthlyEquivalent', largestExpObs.monthlyEquivalent, CLAIM_UNITS.USD);
    }
  }
  if (largestInc) {
    claims.add('LABEL', 'facts.largestIncome.label', largestInc.label, CLAIM_UNITS.NONE);
    if (largestInc.amount !== undefined) {
      claims.add('AMOUNT', 'facts.largestIncome.amount', largestInc.amount, CLAIM_UNITS.USD);
    }
    if (largestInc.monthlyEquivalent !== undefined) {
      claims.add('AMOUNT', 'facts.largestIncome.monthlyEquivalent', largestInc.monthlyEquivalent, CLAIM_UNITS.USD);
    }
    if (largestInc.nextDate !== undefined) {
      claims.add('DATE', 'facts.largestIncome.nextDate', largestInc.nextDate, CLAIM_UNITS.DATE);
    }
  }

  const facts = {
    signConvention: SIGN_CONVENTION.MAGNITUDE,
    accountScope: factsIn.accountScope || evidence.accountScope || 'selected_account',
    recurringDefinition: definition,
    sourceKinds: Array.isArray(factsIn.sourceKinds) ? cloneJson(factsIn.sourceKinds) : [definition],
    metricScope,
    rankingMode,
    monthlyEquivalentIsNormalized: factsIn.monthlyEquivalentIsNormalized === true,
    expenses: expenses.items,
    income: income.items,
    totals,
    expenseCount: expensesIn.length,
    incomeCount: incomeIn.length,
  };
  if (factsIn.namedFilter !== undefined) facts.namedFilter = factsIn.namedFilter;
  if (largestExp) facts.largestExpense = copyDefined(largestExp, LARGEST_STREAM_KEYS);
  if (largestInc) facts.largestIncome = copyDefined(largestInc, LARGEST_STREAM_KEYS);

  const allowedNarration = [];
  if (empty) {
    allowedNarration.push(narration(
      'no_scheduled_recurring',
      'No scheduled recurring items exist in this Keacast forecast for the selected account.'
    ));
  }

  const scope = emptyScope();
  scope.accountScope = facts.accountScope;
  scope.accountLabel = accountLabelFrom(accountContext);
  scope.metricScope = metricScope;

  return finish(baseLedger({
    status: statusFromEvidence(evidence, { empty }),
    capability: 'cashflow_recurring',
    responseMode: rankingMode || responseModeFrom(input),
    source: {
      kind: SOURCE_KIND.CASHFLOW_RECURRING,
      definition,
      description: sourceDescriptionFor(SOURCE_KIND.CASHFLOW_RECURRING),
    },
    scope,
    facts,
    claims: claims.claims,
    lists: { expenses: expenses.meta, income: income.meta },
    limitations,
    assumptions: copyAssumptions(evidence),
    allowedNarration,
    prohibitedNarration: [
      narration('do_not_imply_plaid_recurring', 'Do not imply bank-detected, Plaid, or subscription detection unless the source says so.'),
      narration('do_not_call_paycheck', 'Do not call scheduled recurring income a confirmed paycheck or employer payroll.'),
      narration('do_not_recalculate', 'Do not recalculate monthly equivalents, ranks, or totals.'),
    ],
    internal: internalFrom(evidence, accountContext, 'recurring'),
  }));
}

function buildIncomeHorizonEvidenceLedger(input) {
  const { evidence, accountContext } = input;
  const factsIn = (evidence && evidence.facts) || {};
  const limitations = copyLimitations(evidence);
  const nextIncomeIn = Array.isArray(factsIn.nextIncome) ? factsIn.nextIncome : [];
  const expensesIn = factsIn.expensesBeforeIncome && Array.isArray(factsIn.expensesBeforeIncome.items)
    ? factsIn.expensesBeforeIncome.items
    : [];
  const nextIncome = indexList(nextIncomeIn, { totalCount: nextIncomeIn.length });
  const expenses = indexList(expensesIn, { totalCount: expensesIn.length });
  const forecast = factsIn.forecast && typeof factsIn.forecast === 'object' ? cloneJson(factsIn.forecast) : {};
  const window = copyPeriod(factsIn.window);
  const definition = factsIn.incomeHorizonDefinition
    || sourceDefinitionFor(SOURCE_KIND.CASHFLOW_INCOME_HORIZON, factsIn);

  const claims = new ClaimIndex();
  claims.add('DEFINITION', 'facts.incomeHorizonDefinition', definition, CLAIM_UNITS.NONE);
  if (factsIn.combinedScheduledIncomeAmount !== undefined) {
    claims.add('TOTAL', 'facts.combinedScheduledIncomeAmount', factsIn.combinedScheduledIncomeAmount, CLAIM_UNITS.USD);
  }
  if (nextIncome.items[0]) {
    if (nextIncome.items[0].date !== undefined) {
      claims.add('DATE', 'facts.nextIncome[0].date', nextIncome.items[0].date, CLAIM_UNITS.DATE);
    }
    if (nextIncome.items[0].amount !== undefined) {
      claims.add('AMOUNT', 'facts.nextIncome[0].amount', nextIncome.items[0].amount, CLAIM_UNITS.USD);
    }
    if (nextIncome.items[0].label !== undefined) {
      claims.add('LABEL', 'facts.nextIncome[0].label', nextIncome.items[0].label, CLAIM_UNITS.NONE);
    }
  }
  if (window && window.start && window.end) {
    claims.add('DATE_RANGE', 'facts.window', { start: window.start, end: window.end }, CLAIM_UNITS.DATE);
  }
  if (factsIn.expensesBeforeIncome && factsIn.expensesBeforeIncome.total !== undefined) {
    claims.add('TOTAL', 'facts.expensesBeforeIncome.total', factsIn.expensesBeforeIncome.total, CLAIM_UNITS.USD);
  }
  if (factsIn.expensesBeforeIncome && factsIn.expensesBeforeIncome.count !== undefined) {
    claims.add('COUNT', 'facts.expensesBeforeIncome.count', factsIn.expensesBeforeIncome.count, CLAIM_UNITS.COUNT);
  }
  if (forecast.lowestBalanceBeforeIncome !== undefined) {
    claims.add('AMOUNT', 'facts.forecast.lowestBalanceBeforeIncome', forecast.lowestBalanceBeforeIncome, CLAIM_UNITS.USD);
  }
  if (forecast.lowestBalanceDate !== undefined) {
    claims.add('DATE', 'facts.forecast.lowestBalanceDate', forecast.lowestBalanceDate, CLAIM_UNITS.DATE);
  }
  if (forecast.firstNegativeDate !== undefined) {
    claims.add('DATE', 'facts.forecast.firstNegativeDate', forecast.firstNegativeDate, CLAIM_UNITS.DATE);
  }
  if (forecast.projectedShortfallBeforeIncome !== undefined) {
    claims.add('AMOUNT', 'facts.forecast.projectedShortfallBeforeIncome', forecast.projectedShortfallBeforeIncome, CLAIM_UNITS.USD);
  }
  if (forecast.daysUntilNextIncome !== undefined) {
    claims.add('COUNT', 'facts.forecast.daysUntilNextIncome', forecast.daysUntilNextIncome, CLAIM_UNITS.DAYS);
  }
  if (forecast.startingAvailable !== undefined) {
    claims.add('AMOUNT', 'facts.forecast.startingAvailable', forecast.startingAvailable, CLAIM_UNITS.USD);
  }
  if (forecast.firstNegativeDate !== undefined) {
    claims.add('BOOLEAN', 'facts.negativeBeforeIncome', forecast.firstNegativeDate != null, CLAIM_UNITS.NONE);
  }

  const sameDay = hasLimitation(limitations, 'same_day_order_unknown')
    || findObservation(copyObservations(evidence), 'same_day_order_unknown') != null;

  const facts = {
    signConvention: SIGN_CONVENTION.MAGNITUDE,
    accountScope: factsIn.accountScope || evidence.accountScope || 'selected_account',
    incomeHorizonDefinition: definition,
    nextIncome: nextIncome.items,
    combinedScheduledIncomeAmount: factsIn.combinedScheduledIncomeAmount,
    window,
    expensesBeforeIncome: factsIn.expensesBeforeIncome
      ? {
        count: factsIn.expensesBeforeIncome.count,
        total: factsIn.expensesBeforeIncome.total,
        items: expenses.items,
      }
      : undefined,
    forecast,
  };
  if (forecast.firstNegativeDate !== undefined) {
    facts.negativeBeforeIncome = forecast.firstNegativeDate != null;
  }

  const scope = emptyScope();
  scope.accountScope = facts.accountScope;
  scope.accountLabel = accountLabelFrom(accountContext);
  scope.period = window;

  const allowedNarration = [];
  if (sameDay) {
    allowedNarration.push(narration(
      'same_day_order_unknown',
      'Same-day order of income and expenses is not established.'
    ));
  }

  return finish(baseLedger({
    status: statusFromEvidence(evidence, { empty: nextIncomeIn.length === 0 }),
    capability: 'cashflow_income_horizon',
    responseMode: responseModeFrom(input),
    source: {
      kind: SOURCE_KIND.CASHFLOW_INCOME_HORIZON,
      definition,
      description: sourceDescriptionFor(SOURCE_KIND.CASHFLOW_INCOME_HORIZON),
    },
    scope,
    facts,
    claims: claims.claims,
    lists: { nextIncome: nextIncome.meta, expensesBeforeIncome: expenses.meta },
    limitations,
    assumptions: copyAssumptions(evidence),
    allowedNarration,
    prohibitedNarration: [
      narration('do_not_call_paycheck', 'Do not call this a paycheck, payday, salary deposit, or employer-confirmed payroll.'),
      narration('do_not_say_safe', 'Do not say the user is safe, comfortable, or can afford spending before this income.'),
      narration('do_not_recalculate', 'Do not recalculate shortfall, lowest balance, or days until income.'),
    ],
    internal: internalFrom(evidence, accountContext, 'income_horizon'),
  }));
}

function addChangeClaims(claims, prefix, change) {
  if (!change || typeof change !== 'object') return;
  if (change.absolute !== undefined) {
    claims.add('AMOUNT', `${prefix}.absolute`, change.absolute, CLAIM_UNITS.USD);
  }
  if (change.percent !== undefined) {
    claims.add('PERCENT', `${prefix}.percent`, change.percent, CLAIM_UNITS.PERCENT);
  }
  if (change.baselineZero !== undefined) {
    claims.add('BOOLEAN', `${prefix}.baselineZero`, change.baselineZero, CLAIM_UNITS.NONE);
  }
  if (change.crossedZero !== undefined) {
    claims.add('BOOLEAN', `${prefix}.crossedZero`, change.crossedZero, CLAIM_UNITS.NONE);
  }
  if (change.direction !== undefined) {
    claims.add('DIRECTION', `${prefix}.direction`, change.direction, CLAIM_UNITS.NONE);
  }
}

function buildComparisonEvidenceLedger(input) {
  const { evidence, accountContext, route } = input;
  const factsIn = (evidence && evidence.facts) || {};
  const observations = copyObservations(evidence);
  const empty = findObservation(observations, 'both_periods_empty') != null;
  const periodA = factsIn.periodA ? cloneJson(factsIn.periodA) : null;
  const periodB = factsIn.periodB ? cloneJson(factsIn.periodB) : null;
  const changes = factsIn.changes ? cloneJson(factsIn.changes) : {};
  const categoryFilter = factsIn.categoryFilter
    || (route && route.slots && route.slots.subjectKind === 'category' && route.slots.subjectValue)
    || null;
  const facts = {
    signConvention: SIGN_CONVENTION.MAGNITUDE,
    accountScope: factsIn.accountScope || evidence.accountScope || 'selected_account',
    windowKind: factsIn.windowKind || evidence.windowKind || null,
    periodA,
    periodB,
    changes,
    categoryFilter,
  };
  if (categoryFilter && factsIn.categoryChanges) {
    facts.categoryChanges = cloneJson(factsIn.categoryChanges);
  }

  const claims = new ClaimIndex();
  if (facts.windowKind) claims.add('LABEL', 'facts.windowKind', facts.windowKind, CLAIM_UNITS.NONE);
  if (periodA) {
    if (periodA.start && periodA.end) {
      claims.add('DATE_RANGE', 'facts.periodA', { start: periodA.start, end: periodA.end }, CLAIM_UNITS.DATE);
    }
    if (periodA.income !== undefined) claims.add('TOTAL', 'facts.periodA.income', periodA.income, CLAIM_UNITS.USD);
    if (periodA.spending !== undefined) claims.add('TOTAL', 'facts.periodA.spending', periodA.spending, CLAIM_UNITS.USD);
    if (periodA.net !== undefined) claims.add('TOTAL', 'facts.periodA.net', periodA.net, CLAIM_UNITS.USD);
  }
  if (periodB) {
    if (periodB.start && periodB.end) {
      claims.add('DATE_RANGE', 'facts.periodB', { start: periodB.start, end: periodB.end }, CLAIM_UNITS.DATE);
    }
    if (periodB.income !== undefined) claims.add('TOTAL', 'facts.periodB.income', periodB.income, CLAIM_UNITS.USD);
    if (periodB.spending !== undefined) claims.add('TOTAL', 'facts.periodB.spending', periodB.spending, CLAIM_UNITS.USD);
    if (periodB.net !== undefined) claims.add('TOTAL', 'facts.periodB.net', periodB.net, CLAIM_UNITS.USD);
  }
  addChangeClaims(claims, 'facts.changes.income', changes.income);
  addChangeClaims(claims, 'facts.changes.spending', changes.spending);
  addChangeClaims(claims, 'facts.changes.net', changes.net);

  const scope = emptyScope();
  scope.accountScope = facts.accountScope;
  scope.accountLabel = accountLabelFrom(accountContext);
  scope.windowKind = facts.windowKind;
  scope.category = categoryFilter;
  scope.period = periodB ? copyPeriod(periodB) : copyPeriod(periodA);

  return finish(baseLedger({
    status: statusFromEvidence(evidence, { empty }),
    capability: 'cashflow_comparison',
    responseMode: responseModeFrom(input),
    source: {
      kind: SOURCE_KIND.CASHFLOW_PERIOD_COMPARISON,
      definition: SOURCE_KIND.CASHFLOW_PERIOD_COMPARISON,
      description: sourceDescriptionFor(SOURCE_KIND.CASHFLOW_PERIOD_COMPARISON),
    },
    scope,
    facts,
    claims: claims.claims,
    lists: {},
    limitations: copyLimitations(evidence),
    assumptions: copyAssumptions(evidence),
    allowedNarration: [],
    prohibitedNarration: [
      narration('do_not_recalculate', 'Do not recalculate absolute or percent change.'),
      narration('do_not_treat_null_percent', 'Do not invent a percent when percent is null.'),
    ],
    internal: internalFrom(evidence, accountContext, 'comparison'),
  }));
}

function buildTrendEvidenceLedger(input) {
  const { evidence, accountContext } = input;
  const factsIn = (evidence && evidence.facts) || {};
  const observations = copyObservations(evidence);
  const empty = findObservation(observations, 'all_periods_empty') != null;
  const metricScope = factsIn.metricScope || null;
  const categoryFilter = factsIn.categoryFilter || null;
  let periodsIn = Array.isArray(factsIn.periods) ? cloneJson(factsIn.periods) : [];
  if ((metricScope === 'category' || categoryFilter) && periodsIn.length) {
    periodsIn = periodsIn.map((period) => {
      if (!period || typeof period !== 'object') return period;
      return {
        label: period.label,
        start: period.start,
        end: period.end,
        spending: period.spending,
        transactionCount: period.transactionCount,
      };
    });
  }
  const indexed = indexList(periodsIn, { totalCount: periodsIn.length });
  const trend = factsIn.trend ? cloneJson(factsIn.trend) : {};
  const highest = factsIn.highest !== undefined ? cloneJson(factsIn.highest) : undefined;
  const lowest = factsIn.lowest !== undefined ? cloneJson(factsIn.lowest) : undefined;

  const claims = new ClaimIndex();
  if (metricScope) claims.add('LABEL', 'facts.metricScope', metricScope, CLAIM_UNITS.NONE);
  if (factsIn.windowKind) claims.add('LABEL', 'facts.windowKind', factsIn.windowKind, CLAIM_UNITS.NONE);
  claims.add('COUNT', 'facts.periodCount', periodsIn.length, CLAIM_UNITS.COUNT);
  const focused = metricScope && trend[metricScope] ? trend[metricScope] : trend.spending;
  if (focused && focused.direction !== undefined) {
    claims.add('DIRECTION', `facts.trend.${metricScope || 'spending'}.direction`, focused.direction, CLAIM_UNITS.NONE);
  }
  if (focused && focused.firstToLast) {
    if (focused.firstToLast.absolute !== undefined) {
      claims.add('AMOUNT', `facts.trend.${metricScope || 'spending'}.firstToLast.absolute`, focused.firstToLast.absolute, CLAIM_UNITS.USD);
    }
    if (focused.firstToLast.percent !== undefined) {
      claims.add('PERCENT', `facts.trend.${metricScope || 'spending'}.firstToLast.percent`, focused.firstToLast.percent, CLAIM_UNITS.PERCENT);
    }
  }
  if (highest && highest.value !== undefined) {
    claims.add('AMOUNT', 'facts.highest.value', highest.value, CLAIM_UNITS.USD);
  }
  if (lowest && lowest.value !== undefined) {
    claims.add('AMOUNT', 'facts.lowest.value', lowest.value, CLAIM_UNITS.USD);
  }

  const facts = {
    signConvention: SIGN_CONVENTION.MAGNITUDE,
    accountScope: factsIn.accountScope || evidence.accountScope || 'selected_account',
    windowKind: factsIn.windowKind || evidence.windowKind || null,
    metricScope,
    categoryFilter,
    periods: indexed.items,
    periodCount: periodsIn.length,
    trend,
  };
  if (highest !== undefined) facts.highest = highest;
  if (lowest !== undefined) facts.lowest = lowest;

  const scope = emptyScope();
  scope.accountScope = facts.accountScope;
  scope.accountLabel = accountLabelFrom(accountContext);
  scope.metricScope = metricScope;
  scope.windowKind = facts.windowKind;
  scope.category = categoryFilter;
  if (periodsIn[0] && periodsIn[periodsIn.length - 1]) {
    scope.period = {
      start: periodsIn[0].start || null,
      end: periodsIn[periodsIn.length - 1].end || null,
    };
  }

  return finish(baseLedger({
    status: statusFromEvidence(evidence, { empty }),
    capability: 'cashflow_trend',
    responseMode: responseModeFrom(input),
    source: {
      kind: SOURCE_KIND.CASHFLOW_TREND,
      definition: SOURCE_KIND.CASHFLOW_TREND,
      description: sourceDescriptionFor(SOURCE_KIND.CASHFLOW_TREND),
    },
    scope,
    facts,
    claims: claims.claims,
    lists: { periods: indexed.meta },
    limitations: copyLimitations(evidence),
    assumptions: copyAssumptions(evidence),
    allowedNarration: [],
    prohibitedNarration: [
      narration('do_not_recalculate', 'Do not recalculate direction, first-to-last change, or percent.'),
    ],
    internal: internalFrom(evidence, accountContext, 'trend'),
  }));
}

function stripHistoricalCashflowFacts(facts, evidence) {
  const period = (evidence && evidence.period) || (facts && facts.period) || null;
  const clientDate = completedHistoricalClientDate(evidence);
  if (!isCompletedHistoricalPeriod(period, clientDate)) return facts;
  const next = { ...facts };
  delete next.availableBalance;
  delete next.currentBalance;
  delete next.reconciledBalance;
  delete next.remainingForecastIncome;
  delete next.remainingForecastSpending;
  delete next.savingsPotential;
  delete next.negativeBalanceRisk;
  return next;
}

function stripHorizonDays(facts) {
  if (!facts) return facts;
  const next = { ...facts };
  delete next.horizonDays;
  if (next.negativeBalanceRisk && typeof next.negativeBalanceRisk === 'object') {
    const risk = { ...next.negativeBalanceRisk };
    delete risk.horizonDays;
    next.negativeBalanceRisk = risk;
  }
  return next;
}

function buildCashflowEvidenceLedger(input) {
  const { evidence, accountContext } = input;
  const factsIn = stripHorizonDays(stripHistoricalCashflowFacts(
    copyDefined((evidence && evidence.facts) || {}, [
      'postedIncome', 'postedSpending', 'postedNet',
      'remainingForecastIncome', 'remainingForecastSpending', 'savingsPotential',
      'availableBalance', 'currentBalance', 'reconciledBalance',
      'largestCategories', 'largestMerchants', 'negativeBalanceRisk',
    ]),
    evidence
  ));
  factsIn.signConvention = SIGN_CONVENTION.MAGNITUDE;
  factsIn.accountScope = (evidence && evidence.accountScope) || 'selected_account';
  const cats = indexList(factsIn.largestCategories, {
    totalCount: Array.isArray(factsIn.largestCategories) ? factsIn.largestCategories.length : 0,
  });
  const merchants = indexList(factsIn.largestMerchants, {
    totalCount: Array.isArray(factsIn.largestMerchants) ? factsIn.largestMerchants.length : 0,
  });
  if (factsIn.largestCategories) factsIn.largestCategories = cats.items;
  if (factsIn.largestMerchants) factsIn.largestMerchants = merchants.items;

  const risk = factsIn.negativeBalanceRisk;
  const claims = new ClaimIndex();
  if (factsIn.postedIncome !== undefined) claims.add('TOTAL', 'facts.postedIncome', factsIn.postedIncome, CLAIM_UNITS.USD);
  if (factsIn.postedSpending !== undefined) claims.add('TOTAL', 'facts.postedSpending', factsIn.postedSpending, CLAIM_UNITS.USD);
  if (factsIn.postedNet !== undefined) claims.add('TOTAL', 'facts.postedNet', factsIn.postedNet, CLAIM_UNITS.USD);
  if (factsIn.availableBalance !== undefined) {
    claims.add('AMOUNT', 'facts.availableBalance', factsIn.availableBalance, CLAIM_UNITS.USD);
  }
  if (factsIn.currentBalance !== undefined) {
    claims.add('AMOUNT', 'facts.currentBalance', factsIn.currentBalance, CLAIM_UNITS.USD);
  }
  if (factsIn.reconciledBalance !== undefined) {
    claims.add('AMOUNT', 'facts.reconciledBalance', factsIn.reconciledBalance, CLAIM_UNITS.USD);
  }
  if (factsIn.remainingForecastIncome !== undefined) {
    claims.add('TOTAL', 'facts.remainingForecastIncome', factsIn.remainingForecastIncome, CLAIM_UNITS.USD);
  }
  if (factsIn.remainingForecastSpending !== undefined) {
    claims.add('TOTAL', 'facts.remainingForecastSpending', factsIn.remainingForecastSpending, CLAIM_UNITS.USD);
  }
  if (risk && risk.hasNegativeInScope !== undefined) {
    claims.add('BOOLEAN', 'facts.negativeBalanceRisk.hasNegativeInScope', risk.hasNegativeInScope, CLAIM_UNITS.NONE);
  }
  if (risk && risk.firstNegativeDate !== undefined) {
    claims.add('DATE', 'facts.negativeBalanceRisk.firstNegativeDate', risk.firstNegativeDate, CLAIM_UNITS.DATE);
  }
  if (risk && risk.lowestProjectedAmount !== undefined) {
    claims.add('AMOUNT', 'facts.negativeBalanceRisk.lowestProjectedAmount', risk.lowestProjectedAmount, CLAIM_UNITS.USD);
  }
  if (risk && risk.lowestProjectedDate !== undefined) {
    claims.add('DATE', 'facts.negativeBalanceRisk.lowestProjectedDate', risk.lowestProjectedDate, CLAIM_UNITS.DATE);
  }

  const period = periodFromEvidence(evidence);
  const scope = emptyScope();
  scope.accountScope = factsIn.accountScope;
  scope.accountLabel = accountLabelFrom(accountContext);
  scope.period = period;

  return finish(baseLedger({
    status: statusFromEvidence(evidence),
    capability: 'cashflow_analysis',
    responseMode: responseModeFrom(input),
    source: {
      kind: SOURCE_KIND.CASHFLOW_ANALYSIS,
      definition: SOURCE_KIND.CASHFLOW_ANALYSIS,
      description: sourceDescriptionFor(SOURCE_KIND.CASHFLOW_ANALYSIS),
    },
    scope,
    facts: factsIn,
    claims: claims.claims,
    lists: {
      largestCategories: cats.meta,
      largestMerchants: merchants.meta,
    },
    limitations: copyLimitations(evidence),
    assumptions: copyAssumptions(evidence),
    allowedNarration: [],
    prohibitedNarration: [
      narration('do_not_say_comfortable', 'Do not say comfortable, healthy, safe, enough, or affordable.'),
      narration('do_not_invent_score', 'Do not invent an affordability or safety score.'),
      narration('do_not_recalculate', 'Do not recalculate posted totals or projected balances.'),
    ],
    internal: internalFrom(evidence, accountContext, 'cashflow'),
  }));
}

function buildAffordabilityEvidenceLedger(input) {
  const { evidence, accountContext } = input;
  const factsIn = copyDefined((evidence && evidence.facts) || {}, [
    'assumption', 'requested', 'horizonDays',
    'availableBalance', 'currentBalance', 'reconciledBalance',
    'baseline', 'hypothetical', 'delta',
  ]);
  factsIn.signConvention = SIGN_CONVENTION.MAGNITUDE;
  factsIn.accountScope = (evidence && evidence.accountScope) || 'selected_account';

  const requested = factsIn.requested || {};
  const baseline = factsIn.baseline || {};
  const hypothetical = factsIn.hypothetical || {};
  const delta = factsIn.delta || {};
  const claims = new ClaimIndex();
  if (requested.amount !== undefined) {
    claims.add('AMOUNT', 'facts.requested.amount', requested.amount, CLAIM_UNITS.USD);
  }
  if (requested.purchaseDate !== undefined) {
    claims.add('DATE', 'facts.requested.purchaseDate', requested.purchaseDate, CLAIM_UNITS.DATE);
  }
  if (baseline.projectedOnDate !== undefined) {
    claims.add('AMOUNT', 'facts.baseline.projectedOnDate', baseline.projectedOnDate, CLAIM_UNITS.USD);
  }
  if (hypothetical.lowestAfterDate !== undefined) {
    claims.add('AMOUNT', 'facts.hypothetical.lowestAfterDate', hypothetical.lowestAfterDate, CLAIM_UNITS.USD);
  }
  if (hypothetical.projectedOnDate !== undefined) {
    claims.add('AMOUNT', 'facts.hypothetical.projectedOnDate', hypothetical.projectedOnDate, CLAIM_UNITS.USD);
  }
  if (delta.newNegativeIntroduced !== undefined) {
    claims.add('BOOLEAN', 'facts.delta.newNegativeIntroduced', delta.newNegativeIntroduced, CLAIM_UNITS.NONE);
  }
  if (delta.negativeStartsEarlier !== undefined) {
    claims.add('BOOLEAN', 'facts.delta.negativeStartsEarlier', delta.negativeStartsEarlier, CLAIM_UNITS.NONE);
  }
  if (delta.negativeWorsenedBy !== undefined) {
    claims.add('AMOUNT', 'facts.delta.negativeWorsenedBy', delta.negativeWorsenedBy, CLAIM_UNITS.USD);
  }

  const scope = emptyScope();
  scope.accountScope = factsIn.accountScope;
  scope.accountLabel = accountLabelFrom(accountContext);
  scope.scenario = SCENARIO.AFFORDABILITY_HYPOTHETICAL;
  if (requested.purchaseDate) {
    scope.period = { start: requested.purchaseDate, end: requested.purchaseDate };
  }

  return finish(baseLedger({
    status: statusFromEvidence(evidence),
    capability: 'affordability_or_planning',
    responseMode: responseModeFrom(input),
    source: {
      kind: SOURCE_KIND.AFFORDABILITY_ANALYSIS,
      definition: SOURCE_KIND.AFFORDABILITY_ANALYSIS,
      description: sourceDescriptionFor(SOURCE_KIND.AFFORDABILITY_ANALYSIS),
    },
    scope,
    facts: factsIn,
    claims: claims.claims,
    lists: {},
    limitations: copyLimitations(evidence),
    assumptions: copyAssumptions(evidence),
    allowedNarration: [],
    prohibitedNarration: [
      narration('do_not_classify_affordability', 'Do not say affordable, safe, comfortable, or that the user can or cannot afford the purchase.'),
      narration('do_not_authorize_write', 'Do not treat this analysis as authorization to add a transaction.'),
      narration('do_not_recalculate', 'Do not recalculate hypothetical balances or delta values.'),
    ],
    internal: internalFrom(evidence, accountContext, 'affordability'),
  }));
}

function buildLookupEvidenceLedger(input) {
  const { evidence, accountContext, route } = input;
  const factsIn = copyDefined((evidence && evidence.facts) || {}, [
    'transactionCount', 'spentTotal', 'expenseTotal', 'incomeTotal', 'matchedCompactItem',
  ]);
  factsIn.signConvention = SIGN_CONVENTION.MAGNITUDE;
  const lookupsIn = Array.isArray(evidence && evidence.lookups) ? cloneJson(evidence.lookups) : [];
  const lookups = indexList(lookupsIn, { totalCount: lookupsIn.length });
  factsIn.lookups = lookups.items;
  const empty = factsIn.transactionCount === 0
    || (lookupsIn.length > 0 && lookupsIn.every((row) => row && row.transactionCount === 0));
  const slots = route && route.slots ? route.slots : {};
  const claims = new ClaimIndex();
  if (factsIn.transactionCount !== undefined) {
    claims.add('COUNT', 'facts.transactionCount', factsIn.transactionCount, CLAIM_UNITS.COUNT);
  }
  if (factsIn.spentTotal !== undefined) {
    claims.add('TOTAL', 'facts.spentTotal', factsIn.spentTotal, CLAIM_UNITS.USD);
  }
  if (factsIn.expenseTotal !== undefined) {
    claims.add('TOTAL', 'facts.expenseTotal', factsIn.expenseTotal, CLAIM_UNITS.USD);
  }
  if (factsIn.incomeTotal !== undefined) {
    claims.add('TOTAL', 'facts.incomeTotal', factsIn.incomeTotal, CLAIM_UNITS.USD);
  }

  const period = periodFromEvidence(evidence);
  const scope = emptyScope();
  scope.accountScope = 'selected_account';
  scope.accountLabel = accountLabelFrom(accountContext);
  scope.period = period;
  scope.category = slots.subjectKind === 'category' ? (slots.subjectValue || null) : null;
  scope.merchant = slots.subjectKind === 'merchant' ? (slots.subjectValue || null) : null;

  return finish(baseLedger({
    status: statusFromEvidence(evidence, { empty }),
    capability: 'financial_lookup',
    responseMode: responseModeFrom(input),
    source: {
      kind: SOURCE_KIND.USER_TRANSACTIONS,
      definition: SOURCE_KIND.USER_TRANSACTIONS,
      description: sourceDescriptionFor(SOURCE_KIND.USER_TRANSACTIONS),
    },
    scope,
    facts: factsIn,
    claims: claims.claims,
    lists: { lookups: lookups.meta },
    limitations: copyLimitations(evidence),
    assumptions: copyAssumptions(evidence),
    allowedNarration: empty ? [narration('lookup_empty', 'No matching posted transactions exist for the selected period.')] : [],
    prohibitedNarration: [
      narration('do_not_recalculate', 'Do not recalculate spent totals or counts.'),
    ],
    internal: internalFrom(evidence, accountContext, 'lookup'),
  }));
}

function buildSnapshotEvidenceLedger(input) {
  const { evidence, accountContext } = input;
  const factsIn = copyDefined((evidence && evidence.facts) || {}, [
    'reconciledBalance', 'currentBalance', 'availableBalance', 'credit_limit',
    'monthIncome', 'monthExpenses', 'monthNet', 'savingsPotential',
    'upcomingExpenseTotal', 'upcomingIncomeTotal', 'upcomingWindowDays',
    'negativePreviewCount', 'hasNegativePreview',
    'negativesInRequestedPeriodCount', 'hasNegativeInRequestedPeriod',
    'matchedCompactItem', 'goalCount', 'requestedAmount', 'requestedPeriod',
    'recents', 'upcoming', 'futureNegativeBalances',
  ]);
  factsIn.signConvention = SIGN_CONVENTION.SIGNED_LEDGER;
  const claims = new ClaimIndex();
  if (factsIn.reconciledBalance !== undefined) {
    claims.add('AMOUNT', 'facts.reconciledBalance', factsIn.reconciledBalance, CLAIM_UNITS.USD);
  }
  if (factsIn.currentBalance !== undefined) {
    claims.add('AMOUNT', 'facts.currentBalance', factsIn.currentBalance, CLAIM_UNITS.USD);
  }
  if (factsIn.availableBalance !== undefined) {
    claims.add('AMOUNT', 'facts.availableBalance', factsIn.availableBalance, CLAIM_UNITS.USD);
  }
  if (factsIn.upcomingExpenseTotal !== undefined) {
    claims.add('TOTAL', 'facts.upcomingExpenseTotal', factsIn.upcomingExpenseTotal, CLAIM_UNITS.USD);
  }
  if (factsIn.upcomingIncomeTotal !== undefined) {
    claims.add('TOTAL', 'facts.upcomingIncomeTotal', factsIn.upcomingIncomeTotal, CLAIM_UNITS.USD);
  }
  if (factsIn.upcomingWindowDays !== undefined) {
    claims.add('COUNT', 'facts.upcomingWindowDays', factsIn.upcomingWindowDays, CLAIM_UNITS.DAYS);
  }
  if (factsIn.hasNegativePreview !== undefined) {
    claims.add('BOOLEAN', 'facts.hasNegativePreview', factsIn.hasNegativePreview, CLAIM_UNITS.NONE);
  }
  if (factsIn.monthIncome !== undefined) {
    claims.add('TOTAL', 'facts.monthIncome', factsIn.monthIncome, CLAIM_UNITS.USD);
  }
  if (factsIn.monthExpenses !== undefined) {
    claims.add('TOTAL', 'facts.monthExpenses', factsIn.monthExpenses, CLAIM_UNITS.USD);
  }
  if (factsIn.monthNet !== undefined) {
    claims.add('TOTAL', 'facts.monthNet', factsIn.monthNet, CLAIM_UNITS.USD);
  }

  // Compact snapshot caps (keaAccountSnapshot). Index only; do not recap or sort.
  const lists = {};
  if (Array.isArray(factsIn.recents)) {
    const indexed = indexList(factsIn.recents, { totalCount: factsIn.recents.length, cap: 10 });
    factsIn.recents = indexed.items;
    lists.recents = indexed.meta;
  }
  if (Array.isArray(factsIn.upcoming)) {
    const indexed = indexList(factsIn.upcoming, { totalCount: factsIn.upcoming.length, cap: 10 });
    factsIn.upcoming = indexed.items;
    lists.upcoming = indexed.meta;
  }
  if (Array.isArray(factsIn.futureNegativeBalances)) {
    const indexed = indexList(factsIn.futureNegativeBalances, {
      totalCount: factsIn.futureNegativeBalances.length,
      cap: 5,
    });
    factsIn.futureNegativeBalances = indexed.items;
    lists.futureNegativeBalances = indexed.meta;
  }

  const scope = emptyScope();
  scope.accountScope = 'selected_account';
  scope.accountLabel = accountLabelFrom(accountContext);
  scope.period = periodFromEvidence(evidence);

  return finish(baseLedger({
    status: statusFromEvidence(evidence),
    capability: input.capability === 'financial_lookup' ? 'financial_lookup' : 'financial_forecast',
    responseMode: responseModeFrom(input),
    source: {
      kind: SOURCE_KIND.KEA_SNAPSHOT,
      definition: SOURCE_KIND.KEA_SNAPSHOT,
      description: sourceDescriptionFor(SOURCE_KIND.KEA_SNAPSHOT),
    },
    scope,
    facts: factsIn,
    claims: claims.claims,
    lists,
    limitations: copyLimitations(evidence),
    assumptions: copyAssumptions(evidence),
    allowedNarration: [],
    prohibitedNarration: [
      narration('do_not_call_next_week', 'Do not label the snapshot upcoming window as next week.'),
      narration('do_not_widen_snapshot_window', 'Do not treat snapshot upcoming totals as a calendar-week upcoming list.'),
      narration('do_not_say_comfortable', 'Do not say comfortable, healthy, safe, enough, or affordable.'),
    ],
    internal: internalFrom(evidence, accountContext, 'snapshot'),
  }));
}

function buildEvidenceLedger(input = {}) {
  if (!input || typeof input !== 'object') {
    return { ok: false, reason: 'invalid_input' };
  }
  const capability = resolveCapability(input);
  if (isNoLedgerCapability(capability)) {
    return { ok: true, ledger: null };
  }
  const evidence = input.evidence;
  if (!evidence || typeof evidence !== 'object') {
    return { ok: false, reason: 'missing_evidence' };
  }

  const builderInput = {
    capability,
    responseMode: input.responseMode || null,
    evidence,
    route: input.route || null,
    accountContext: input.accountContext || null,
  };

  const status = evidence.status;
  const kind = firstSourceKind(evidence);
  if (status === 'unavailable' || !kind) {
    return unavailableLedger({
      capability,
      responseMode: builderInput.responseMode,
      evidence,
      accountContext: builderInput.accountContext,
      builder: 'unavailable',
    });
  }

  if (kind === SOURCE_KIND.KEA_SNAPSHOT && (capability === 'financial_forecast' || capability === 'financial_lookup' || capability === 'unknown')) {
    return buildSnapshotEvidenceLedger(builderInput);
  }
  if (kind === SOURCE_KIND.USER_TRANSACTIONS) {
    return buildLookupEvidenceLedger(builderInput);
  }

  const builder = BUILDERS[capability];
  if (!builder) {
    return { ok: false, reason: 'unsupported_capability' };
  }
  return builder(builderInput);
}

module.exports = {
  buildEvidenceLedger,
  buildUpcomingEvidenceLedger,
  buildRecurringEvidenceLedger,
  buildIncomeHorizonEvidenceLedger,
  buildComparisonEvidenceLedger,
  buildTrendEvidenceLedger,
  buildCashflowEvidenceLedger,
  buildAffordabilityEvidenceLedger,
  buildLookupEvidenceLedger,
  buildSnapshotEvidenceLedger,
};
