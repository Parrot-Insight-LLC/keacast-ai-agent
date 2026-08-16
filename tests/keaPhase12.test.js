'use strict';

const { check, section } = require('./harness');
const {
  routeCapability,
  applyContinuationPersistenceFromEvidence,
  detectWantsUiAction,
  buildOpenSearchAction,
  mergeOpenSearchUiActions,
} = require('../services/keaCapabilityRouter');
const { resolveGroundingPolicy } = require('../services/keaGroundingPolicy');
const {
  prefetchGrounding,
  buildEvidenceSystemSection,
  shouldForceDirectAnswer,
} = require('../services/keaGroundingPrefetch');
const { allowedToolsFor } = require('../services/keaToolBundles');
const { __testables: T } = require('../controllers/openaiController');

const KNOWN = ['Restaurants', 'Groceries'];
const FOUR_Q = [
  'How much did I spend at Walmart last month?',
  '',
  'How much did I spend at restaurants last month?',
  '',
  'How much did I spend on groceries in July?',
  '',
  'What did I spend at Amazon in June?',
].join('\n');

function route(message, extra = {}) {
  return routeCapability({
    message,
    currentDate: extra.currentDate || '2026-08-16',
    simulationMode: extra.simulationMode === true,
    dialogueState: extra.dialogueState || T.emptyDialogueState(),
    accountId: extra.accountId || '10',
    knownCategories: extra.knownCategories || KNOWN,
  });
}

function datedFetch(byPeriod, pageSize = 100) {
  const calls = [];
  const fetchPage = async ({ userId, accountId, page, limit, startDate, endDate }) => {
    calls.push({ userId, accountId, page, limit, startDate, endDate });
    const allRows = byPeriod[`${startDate}|${endDate}`] || [];
    const size = limit || pageSize;
    const start = (page - 1) * size;
    return {
      transactions: allRows.slice(start, start + size),
      pagination: {
        page,
        limit: size,
        total: allRows.length,
        pages: Math.ceil(allRows.length / size) || 1,
        hasNext: page * size < allRows.length,
      },
    };
  };
  return { fetchPage, calls };
}

const SNAPSHOT = {
  _keaCompact: true,
  schemaVersion: 1,
  accountid: 10,
  balance: 1200,
  reconciledBalance: 1200,
  current: 1150,
  available: 1100,
};

async function run() {
  section('Phase 1.2 — compound parsing');

  const one = route('How much did I spend at Walmart last month?');
  check('one merchant question → lookupRequests length 1', one.lookupRequests.length === 1);
  check('single lookup is Walmart merchant', one.lookupRequests[0].subjectKind === 'merchant'
    && one.lookupRequests[0].subjectValue === 'walmart');
  check('single lookup last month July 2026', one.lookupRequests[0].period.start === '2026-07-01'
    && one.lookupRequests[0].period.end === '2026-07-31');
  check('analytical how-much does not want UI', one.wantsUiAction === false);

  const four = route(FOUR_Q);
  check('four explicit questions → lookupRequests length 4', four.lookupRequests.length === 4);
  check('Walmart merchant July', four.lookupRequests[0].subjectKind === 'merchant'
    && four.lookupRequests[0].subjectValue === 'walmart'
    && four.lookupRequests[0].period.start === '2026-07-01'
    && four.lookupRequests[0].period.end === '2026-07-31');
  check('restaurants category July', four.lookupRequests[1].subjectKind === 'category'
    && four.lookupRequests[1].subjectValue === 'restaurants'
    && four.lookupRequests[1].period.start === '2026-07-01');
  check('groceries category July', four.lookupRequests[2].subjectKind === 'category'
    && four.lookupRequests[2].subjectValue === 'groceries'
    && four.lookupRequests[2].period.start === '2026-07-01'
    && four.lookupRequests[2].period.end === '2026-07-31');
  check('Amazon merchant June', four.lookupRequests[3].subjectKind === 'merchant'
    && four.lookupRequests[3].subjectValue === 'amazon'
    && four.lookupRequests[3].period.start === '2026-06-01'
    && four.lookupRequests[3].period.end === '2026-06-30');
  check('four-question turn is not capped', four.compoundLookupCapped === false);

  const many = [];
  for (let i = 1; i <= 7; i += 1) {
    many.push(`How much did I spend at Store${i} last month?`);
  }
  const capped = route(many.join('\n'));
  check('>6 explicit clauses keeps first 6', capped.lookupRequests.length === 6);
  check('extra clauses set compound_lookup_capped', capped.compoundLookupCapped === true);
  check('first clause Store1', capped.lookupRequests[0].subjectValue === 'store1');
  check('sixth clause Store6', capped.lookupRequests[5].subjectValue === 'store6');

  const genericAnd = route('How much did I spend at Walmart last month and was it more than usual?');
  check('generic conjunction is not split', genericAnd.lookupRequests.length === 1);
  check('generic and still Walmart', genericAnd.lookupRequests[0].subjectValue === 'walmart');

  section('Phase 1.2 — category vs merchant');

  check('at Walmart → merchant', route('How much did I spend at Walmart last month?').slots.subjectKind === 'merchant');
  check('at Restaurants → category', route('How much did I spend at Restaurants last month?').slots.subjectKind === 'category');
  check('on Groceries → category', route('How much did I spend on groceries in July?').slots.subjectKind === 'category');
  check('at Amazon → merchant', route('What did I spend at Amazon in June?').slots.subjectKind === 'merchant');
  const fuzzy = route('How much did I spend at Rest last month?');
  check('no fuzzy category match for Rest', fuzzy.slots.subjectKind === 'merchant' && fuzzy.slots.subjectValue === 'rest');

  section('Phase 1.2 — grouped prefetch + evidence');

  const julyRows = [
    { name: 'Walmart', merchant_name: 'Walmart', amount: -20, start: '2026-07-05', forecast_type: 'A' },
    { name: 'Chipotle', category: 'Restaurants', amount: -15, start: '2026-07-08', forecast_type: 'A' },
    { name: 'Kroger', category: 'Groceries', amount: -40, start: '2026-07-12', forecast_type: 'A' },
    { name: 'Walmart', merchant_name: 'Walmart', amount: -10, start: '2026-07-20', forecast_type: 'F' },
  ];
  const juneRows = [
    { name: 'Amazon', merchant_name: 'Amazon.com', amount: -30, start: '2026-06-11', forecast_type: 'A' },
    { name: 'Amazon', merchant_name: 'Amazon', amount: -12, start: '2026-06-18', duplicate: 1, forecast_type: 'A' },
  ];
  const { fetchPage, calls } = datedFetch({
    '2026-07-01|2026-07-31': julyRows,
    '2026-06-01|2026-06-30': juneRows,
  }, 100);
  let assertCount = 0;
  const fourEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(four, { message: FOUR_Q }),
    route: four,
    message: FOUR_Q,
    fetchPage,
    assertFn: async () => {
      assertCount += 1;
      return { access: 'owner' };
    },
  });
  const julyCalls = calls.filter((c) => c.startDate === '2026-07-01' && c.page === 1);
  const juneCalls = calls.filter((c) => c.startDate === '2026-06-01' && c.page === 1);
  check('July fetched once', julyCalls.length === 1);
  check('June fetched once', juneCalls.length === 1);
  check('authorized once before grouped reads', assertCount === 1);
  check('four aggregates produced', Array.isArray(fourEv.lookups) && fourEv.lookups.length === 4);
  check('historical_lookup_count = 4', fourEv.prefetchMeta.lookupCount === 4);
  check('historical_period_read_count = 2', fourEv.prefetchMeta.periodReadCount === 2);
  check('Walmart July posted total 20', fourEv.lookups[0].expenseTotal === 20 && fourEv.lookups[0].status === 'ok');
  check('Restaurants July total 15', fourEv.lookups[1].expenseTotal === 15 && fourEv.lookups[1].subjectKind === 'category');
  check('Groceries July total 40', fourEv.lookups[2].expenseTotal === 40);
  check('Amazon June excludes duplicate', fourEv.lookups[3].expenseTotal === 30 && fourEv.lookups[3].status === 'ok');
  check('every successful lookup spentTotal >= 0', fourEv.lookups.every((l) => l.status !== 'ok'
    || (l.spentTotal >= 0 && l.spentTotal === l.expenseTotal && !Object.is(l.spentTotal, -0))));
  check('Walmart spentTotal 20', fourEv.lookups[0].spentTotal === 20);
  check('Restaurants spentTotal 15', fourEv.lookups[1].spentTotal === 15);
  check('Groceries spentTotal 40', fourEv.lookups[2].spentTotal === 40);
  check('Amazon spentTotal 30', fourEv.lookups[3].spentTotal === 30);
  check('overall evidence ok', fourEv.status === 'ok');
  check('no raw transaction arrays', fourEv.lookups.every((l) => l.transactions === undefined) && fourEv.facts.transactions === undefined);
  check('fetch identity is trusted user 5', calls.every((c) => c.userId === 5 && c.accountId === 10));

  const block = buildEvidenceSystemSection(fourEv);
  check('evidence lists all four lookups', /"walmart"/.test(block) && /"restaurants"/.test(block)
    && /"groceries"/.test(block) && /"amazon"/.test(block));
  check('evidence instructs answering every lookup', /Answer every requested lookup/.test(block));
  check('evidence JSON omits prefetchMeta', !/"prefetchMeta"/.test(block));
  check('evidence JSON has no transactions array', !/"transactions"\s*:/.test(block));
  check('compound evidence includes spending glossary', /positive posted-spending magnitude/.test(block));
  check('compound evidence prefers spentTotal', /Prefer spentTotal/.test(block));

  section('Phase 1.2 — period failure isolation');

  const oversizeJuly = new Array(1201).fill(0).map(() => ({ name: 'Walmart', amount: -1, start: '2026-07-01' }));
  const { fetchPage: isoFetch, calls: isoCalls } = datedFetch({
    '2026-07-01|2026-07-31': oversizeJuly,
    '2026-06-01|2026-06-30': juneRows,
  }, 100);
  const isoEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(four, { message: FOUR_Q }),
    route: four,
    message: FOUR_Q,
    fetchPage: isoFetch,
    assertFn: async () => ({ access: 'owner' }),
  });
  check('overall evidence partial when one period exceeds cap', isoEv.status === 'partial');
  check('July Walmart unavailable', isoEv.lookups[0].status === 'unavailable' && isoEv.lookups[0].expenseTotal === undefined);
  check('July restaurants unavailable', isoEv.lookups[1].status === 'unavailable');
  check('July groceries unavailable', isoEv.lookups[2].status === 'unavailable');
  check('Amazon June still ok', isoEv.lookups[3].status === 'ok' && isoEv.lookups[3].expenseTotal === 30
    && isoEv.lookups[3].spentTotal === 30);
  check('no invented July totals', isoEv.lookups[0].expenseTotal === undefined && isoEv.lookups[1].expenseTotal === undefined);
  check('both periods still read', isoEv.prefetchMeta.periodReadCount === 2);
  check('July oversize stopped after first page', isoCalls.filter((c) => c.startDate === '2026-07-01').length === 1);
  const isoBlock = buildEvidenceSystemSection(isoEv);
  check('partial instructs not to invent missing total', /could not be fully verified/.test(isoBlock)
    && /Do not invent a missing total/.test(isoBlock));

  section('Phase 1.2 — direct answer vs navigation');

  const walmartMsg = 'How much did I spend at Walmart last month?';
  const walmartRoute = route(walmartMsg);
  const { fetchPage: wFetch } = datedFetch({
    '2026-07-01|2026-07-31': [{ name: 'Walmart', amount: -20, start: '2026-07-05', forecast_type: 'A' }],
  }, 100);
  const walmartEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    snapshot: SNAPSHOT,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(walmartRoute, { message: walmartMsg }),
    route: walmartRoute,
    message: walmartMsg,
    fetchPage: wFetch,
    assertFn: async () => ({ access: 'owner' }),
  });
  const walmartPolicy = resolveGroundingPolicy(walmartRoute, { message: walmartMsg });
  check('analytical does not expose Search', !allowedToolsFor('financial_lookup').has('openTransactionSearch'));
  check('complete evidence forces one Azure answer', shouldForceDirectAnswer({
    route: walmartRoute,
    policy: walmartPolicy,
    evidence: walmartEv,
  }) === true);
  check('analytical wantsUiAction false', walmartRoute.wantsUiAction === false);
  check('how-much is not a UI action', detectWantsUiAction(walmartMsg) === false);

  const navMsg = 'Show me Walmart transactions last month.';
  const nav = route(navMsg);
  check('show transactions → wantsUiAction', nav.wantsUiAction === true);
  check('show transactions → navigation_ui', nav.capability === 'navigation_ui');
  const action = buildOpenSearchAction(nav);
  check('open_search term Walmart', action && action.type === 'open_search' && action.search_term === 'Walmart');
  check('open_search July 1 start', action.startDate === '2026-07-01');
  check('open_search July 31 end', action.endDate === '2026-07-31');
  check('no account id on search action', action.accountId === undefined
    && action.accountName === undefined && action.selectedAccount === undefined);
  check('navigation keeps Search tool', allowedToolsFor('navigation_ui').has('openTransactionSearch'));
  check('lookup can opt back into Search', allowedToolsFor('financial_lookup', { includeOpenTransactionSearch: true }).has('openTransactionSearch'));
  check('direct-answer helper ignores navigation', shouldForceDirectAnswer({
    route: nav,
    policy: walmartPolicy,
    evidence: walmartEv,
  }) === false);
  const merged = mergeOpenSearchUiActions([], nav);
  check('server injects open_search when model omits it', merged.length === 1 && merged[0].startDate === '2026-07-01');

  section('Phase 1.2 — continuation last successful lookup');

  const ds = T.emptyDialogueState();
  applyContinuationPersistenceFromEvidence(ds, four, fourEv, { accountId: '10', failSoft: false });
  check('persists Amazon not Walmart', ds.lastSubjectValue === 'amazon' && ds.lastSubjectKind === 'merchant');
  check('persists June period', ds.lastPeriod && ds.lastPeriod.start === '2026-06-01' && ds.lastPeriod.end === '2026-06-30');
  const cont = route('What about this month?', { dialogueState: ds, accountId: '10' });
  check('this month inherits Amazon', cont.capability === 'continuation' && cont.slots.subjectValue === 'amazon');
  check('this month replaces period', cont.slots.period && cont.slots.period.label === 'this_month'
    && cont.slots.period.start === '2026-08-01');
  check('continuation lookupRequests length 1', cont.lookupRequests.length === 1);

  const isoState = T.emptyDialogueState();
  applyContinuationPersistenceFromEvidence(isoState, four, isoEv, { accountId: '10', failSoft: false });
  check('partial compound still persists last ok Amazon', isoState.lastSubjectValue === 'amazon');
}

module.exports = { run };
