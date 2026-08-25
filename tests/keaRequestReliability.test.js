'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { check, section } = require('./harness');
const {
  parseEnvMs,
  azureChatTimeoutMs,
  macroTimeoutMs,
  chatBudgetMs,
  redisCommandTimeoutMs,
  cashflowHttpTimeoutMs,
  authDbTimeoutMs,
  responseWasCompleted,
  DEFAULT_AZURE_CHAT_TIMEOUT_MS,
  DEFAULT_MACRO_TIMEOUT_MS,
  DEFAULT_CHAT_BUDGET_MS,
  DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
  DEFAULT_AUTH_DB_TIMEOUT_MS,
  FRONTEND_ABORT_MS,
  classifyHttpFailure,
  classifyAzureFailure,
  classifyMacroFailure,
  createRequestLifecycle,
  trySendJson,
  canSendHttpResponse,
  shouldRetryAzure,
  shouldStartNewExpensiveWork,
} = require('../services/keaRequestBudget');
const { runChatAzureNarration, callAzureOnce } = require('../services/keaAzureChat');
const { buildMacroFallbackText } = require('../services/keaMacroFallback');
const { createKeaTelemetry } = require('../services/keaTelemetry');
const { routeCapability } = require('../services/keaCapabilityRouter');
const { resolveGroundingPolicy, isFailSoft, failSoftTextFor } = require('../services/keaGroundingPolicy');
const { prefetchGrounding, shouldForceDirectAnswer } = require('../services/keaGroundingPrefetch');
const { __testables: T } = require('../controllers/openaiController');

function timeoutErr(ms) {
  const err = new Error(`timeout of ${ms}ms exceeded`);
  err.code = 'ECONNABORTED';
  return err;
}

function hangingQuery(calls) {
  return async function queryFn(_messages, opts) {
    calls.push(opts);
    const wait = typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : 50;
    await new Promise((r) => setTimeout(r, wait));
    throw timeoutErr(wait);
  };
}

function mockReqRes({ aborted = false, writableEnded = false, destroyed = false } = {}) {
  const req = new EventEmitter();
  const res = new EventEmitter();
  req.aborted = aborted;
  req.destroyed = false;
  req.id = 'req-1';
  res.writableEnded = writableEnded;
  res.destroyed = destroyed;
  res.headersSent = false;
  res.statusCode = null;
  res.body = null;
  res.jsonCalls = 0;
  res.status = function status(code) {
    this.statusCode = code;
    return this;
  };
  res.json = function json(body) {
    this.jsonCalls += 1;
    this.body = body;
    this.headersSent = true;
    this.writableEnded = true;
    return this;
  };
  return { req, res };
}

function route(message) {
  return routeCapability({
    message,
    currentDate: '2026-08-16',
    dialogueState: T.emptyDialogueState(),
    accountId: '10',
  });
}

function sampleTrendResult() {
  return {
    status: 'ok',
    accountScope: 'selected_account',
    windowKind: 'matched_elapsed',
    metricScope: 'spending',
    periods: [
      { label: 'June 1–16, 2026', start: '2026-06-01', end: '2026-06-16', income: 5000, spending: 100, net: 4900 },
      { label: 'July 1–16, 2026', start: '2026-07-01', end: '2026-07-16', income: 5000, spending: 120, net: 4880 },
      { label: 'August 1–16, 2026', start: '2026-08-01', end: '2026-08-16', income: 5000, spending: 140, net: 4860 },
    ],
    trend: {
      income: { direction: 'unchanged', firstToLast: { absolute: 0, percent: 0, baselineZero: false } },
      spending: { direction: 'increasing', firstToLast: { absolute: 40, percent: 40, baselineZero: false } },
      net: { direction: 'decreasing', firstToLast: { absolute: -40, percent: -0.82, baselineZero: false } },
    },
    highest: { metric: 'spending', label: 'August 1–16, 2026', value: 140 },
    lowest: { metric: 'spending', label: 'June 1–16, 2026', value: 100 },
    observations: [{ code: 'spending_increasing' }],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
  };
}

function sampleComparisonResult() {
  return {
    status: 'ok',
    accountScope: 'selected_account',
    windowKind: 'matched_elapsed',
    periodA: {
      label: 'July 1–16, 2026', start: '2026-07-01', end: '2026-07-16',
      income: 5000, spending: 4200, net: 800,
    },
    periodB: {
      label: 'August 1–16, 2026', start: '2026-08-01', end: '2026-08-16',
      income: 5600, spending: 3780, net: 1820,
    },
    changes: {
      income: { absolute: 600, percent: 12, baselineZero: false, direction: 'increased' },
      spending: { absolute: -420, percent: -10, baselineZero: false, direction: 'decreased' },
      net: { absolute: 1020, percent: 127.5, baselineZero: false, direction: 'improved' },
    },
    observations: [{ code: 'spending_decreased' }, { code: 'net_improved' }],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
  };
}

function sampleAnalysisResult() {
  return {
    status: 'ok',
    period: { start: '2026-08-01', end: '2026-08-16', label: 'current_month_to_date' },
    postedIncome: 3000,
    postedSpending: 200,
    postedNet: 2800,
    remainingForecastSpending: 400,
    savingsPotential: 900,
    observations: [{ code: 'posted_net_positive' }],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
  };
}

function sampleAffordabilityResult() {
  return {
    status: 'ok',
    requested: { amount: 800, purchaseDate: '2026-08-21' },
    baseline: { projectedOnDate: 3047, projectedOnDateAt: '2026-08-21' },
    hypothetical: {
      projectedOnDate: 2247,
      projectedOnDateAt: '2026-08-21',
      lowestAfterDate: 410,
      lowestAfterDateOn: '2026-09-13',
    },
    delta: { newNegativeIntroduced: false },
    observations: [{ code: 'no_new_negative' }],
    limitations: [],
    dataAsOf: '2026-08-16T12:00:00.000Z',
  };
}

function writeCtx(extras = {}) {
  const draft = {
    title: 'Test Expense',
    amount: 800,
    type: 'expense',
    start: '2026-08-21',
    frequency: 2,
    category: 'Uncategorized',
  };
  const state = T.emptyDialogueState();
  state.draftTransaction = { ...draft };
  state.pendingConfirmation = true;
  return {
    userId: 5,
    token: 'trusted',
    accountId: 22,
    accountName: 'Main Account',
    currentDate: '2026-08-16',
    dialogueState: state,
    pendingConfirmationAtStart: true,
    draftCompleteAtStart: true,
    userAffirmative: true,
    proposalInTranscript: false,
    categoryNames: ['Uncategorized'],
    skipCacheInvalidate: true,
    functionMap: extras.functionMap,
    queryAzureOpenAI: extras.queryAzureOpenAI,
    lifecycle: extras.lifecycle,
    telemetry: extras.telemetry,
  };
}

async function run() {
  section('Frontend 120s timeout unchanged');
  const interceptorPath = path.join(
    __dirname,
    '..',
    '..',
    'cashflow-frontend',
    'src',
    'app',
    'inteceptors',
    'network-error.interceptor.ts'
  );
  if (fs.existsSync(interceptorPath)) {
    const src = fs.readFileSync(interceptorPath, 'utf8');
    check('REQUEST_TIMEOUT_MS = 120000', /const REQUEST_TIMEOUT_MS = 120000/.test(src));
  } else {
    console.log('  skip REQUEST_TIMEOUT_MS (frontend not in checkout)');
  }

  section('Frontend chat has no automatic retry');
  const openaiPath = path.join(
    __dirname,
    '..',
    '..',
    'cashflow-frontend',
    'src',
    'app',
    'services',
    'openai.service.ts'
  );
  const chatUiPath = path.join(
    __dirname,
    '..',
    '..',
    'cashflow-frontend',
    'src',
    'app',
    'chat-interface',
    'chat-interface.component.ts'
  );
  if (fs.existsSync(openaiPath)) {
    const src = fs.readFileSync(openaiPath, 'utf8');
    const chatFn = src.slice(src.indexOf('chat(data)'), src.indexOf('summarize(data)'));
    check('OpenaiService.chat has no retry()', !/\.retry\(/.test(chatFn) && /http\.post\(/.test(chatFn));
  } else {
    console.log('  skip OpenaiService.chat retry assert (frontend not in checkout)');
  }
  if (fs.existsSync(chatUiPath)) {
    const src = fs.readFileSync(chatUiPath, 'utf8');
    check('chat-interface does not retry chat POST', !/openaiService\.chat\([^)]*\)[\s\S]{0,400}\.retry\(/.test(src));
  } else {
    console.log('  skip chat-interface retry assert (frontend not in checkout)');
  }

  section('Timeout config defaults and parsing');
  check('azure default 25000', azureChatTimeoutMs() === DEFAULT_AZURE_CHAT_TIMEOUT_MS);
  check('macro default 15000', macroTimeoutMs() === DEFAULT_MACRO_TIMEOUT_MS);
  check('chat budget default 60000', chatBudgetMs() === DEFAULT_CHAT_BUDGET_MS);
  check('redis command timeout default 8000', redisCommandTimeoutMs() === DEFAULT_REDIS_COMMAND_TIMEOUT_MS);
  check('redis command timeout under frontend', redisCommandTimeoutMs() <= 10000 && redisCommandTimeoutMs() >= 5000);
  check('redis command timeout cannot reach 120s', redisCommandTimeoutMs() * 2 < FRONTEND_ABORT_MS);
  check('cashflow HTTP timeout is macro timeout', cashflowHttpTimeoutMs() === macroTimeoutMs());
  check('auth db timeout default 5000', authDbTimeoutMs() === DEFAULT_AUTH_DB_TIMEOUT_MS);
  check('auth db timeout under frontend', authDbTimeoutMs() < FRONTEND_ABORT_MS);
  check('azure default under frontend', DEFAULT_AZURE_CHAT_TIMEOUT_MS < FRONTEND_ABORT_MS);
  check('worst-case Azure under frontend', DEFAULT_AZURE_CHAT_TIMEOUT_MS * 2 < FRONTEND_ABORT_MS);
  check('worst-case Azure under budget', DEFAULT_AZURE_CHAT_TIMEOUT_MS * 2 < DEFAULT_CHAT_BUDGET_MS);
  check('macro under azure', DEFAULT_MACRO_TIMEOUT_MS < DEFAULT_AZURE_CHAT_TIMEOUT_MS);
  check('parseEnvMs invalid falls back', parseEnvMs('KEA_TEST_BAD', 15000, 3000, 30000) === 15000);
  const prev = process.env.KEA_CHAT_AZURE_TIMEOUT_MS;
  process.env.KEA_CHAT_AZURE_TIMEOUT_MS = '-1';
  check('negative azure env falls back', azureChatTimeoutMs() === DEFAULT_AZURE_CHAT_TIMEOUT_MS);
  process.env.KEA_CHAT_AZURE_TIMEOUT_MS = 'not-a-number';
  check('non-numeric azure env falls back', azureChatTimeoutMs() === DEFAULT_AZURE_CHAT_TIMEOUT_MS);
  process.env.KEA_CHAT_AZURE_TIMEOUT_MS = '999999';
  check('unreasonable azure env falls back', azureChatTimeoutMs() === DEFAULT_AZURE_CHAT_TIMEOUT_MS);
  process.env.KEA_CHAT_AZURE_TIMEOUT_MS = '20000';
  check('valid azure env accepted', azureChatTimeoutMs() === 20000);
  if (prev == null) delete process.env.KEA_CHAT_AZURE_TIMEOUT_MS;
  else process.env.KEA_CHAT_AZURE_TIMEOUT_MS = prev;

  section('Failure classification');
  check('timeout ECONNABORTED', classifyHttpFailure({ code: 'ECONNABORTED' }) === 'timeout');
  check('timeout message', classifyHttpFailure({ message: 'timeout of 25000ms exceeded' }) === 'timeout');
  check('http_401', classifyMacroFailure({ response: { status: 401 } }) === 'http_401');
  check('http_403', classifyMacroFailure({ response: { status: 403 } }) === 'http_403');
  check('http_404', classifyMacroFailure({ response: { status: 404 } }) === 'http_404');
  check('http_5xx', classifyMacroFailure({ response: { status: 502 } }) === 'http_5xx');
  check('network', classifyMacroFailure({ code: 'ECONNRESET' }) === 'network');
  check('azure 429', classifyAzureFailure({ response: { status: 429 } }) === 'http_429');
  check('azure 401 is http_4xx', classifyAzureFailure({ response: { status: 401 } }) === 'http_4xx');

  section('Azure chat timeout and retry budget');
  const azureCalls = [];
  const azureHang = await runChatAzureNarration({
    queryFn: hangingQuery(azureCalls),
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    primaryToolChoice: 'none',
    timeoutMs: 40,
    macroOwnsTurn: false,
    lifecycle: { clientAborted: false, hasBudgetFor: () => true, setStage() {} },
  });
  check('hanging Azure terminates', azureHang.ok === false && azureHang.reason === 'timeout');
  check('non-macro retries once', azureCalls.length === 2);
  check('retry uses tool_choice none', azureCalls[1].tool_choice === 'none');
  check('each Azure call has timeout', azureCalls.every((c) => c.timeout === 40));
  check('configured exposure under 120s', 40 * 2 < FRONTEND_ABORT_MS);

  const skipCalls = [];
  let budgetChecks = 0;
  const skippedRetry = await runChatAzureNarration({
    queryFn: hangingQuery(skipCalls),
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    primaryToolChoice: 'auto',
    timeoutMs: 40,
    macroOwnsTurn: false,
    lifecycle: {
      clientAborted: false,
      hasBudgetFor: () => {
        budgetChecks += 1;
        return budgetChecks === 1;
      },
      setStage() {},
    },
  });
  check('retry skipped when budget remaining is insufficient', skipCalls.length === 1);
  check('skipped retry still fails controlled', skippedRetry.ok === false);
  check('macroOwnsTurn never retries', shouldRetryAzure({
    lifecycle: { clientAborted: false, hasBudgetFor: () => true },
    timeoutMs: 25000,
    macroOwnsTurn: true,
  }) === false);

  section('Macro Cashflow timeout fail-soft');
  const macros = [
    { name: 'trend', message: 'Am I spending more lately?', key: 'fetchTrendAnalysis' },
    { name: 'comparison', message: 'How does this month compare with last month?', key: 'fetchPeriodComparison' },
    { name: 'analysis', message: 'How am I doing this month?', key: 'fetchCashflowAnalysis' },
    { name: 'affordability', message: 'Can I afford $800 next Friday?', key: 'fetchAffordabilityAnalysis' },
    { name: 'upcoming', message: 'What bills are due next week?', key: 'fetchUpcomingAnalysis' },
    { name: 'incomeHorizon', message: 'When is my next paycheck?', key: 'fetchIncomeHorizonAnalysis' },
  ];
  for (const row of macros) {
    const r = route(row.message);
    let seenTimeout = null;
    const fetchers = {
      [row.key]: async ({ timeoutMs }) => {
        seenTimeout = timeoutMs;
        throw timeoutErr(timeoutMs);
      },
    };
    const ev = await prefetchGrounding({
      trustedUserId: 5,
      accountId: 10,
      currentDate: '2026-08-16',
      policy: resolveGroundingPolicy(r, { message: row.message }),
      route: r,
      token: 'jwt',
      ...fetchers,
    });
    check(`${row.name} passes macro timeoutMs`, seenTimeout === macroTimeoutMs());
    check(`${row.name} timeout unavailable`, ev.status === 'unavailable');
    check(`${row.name} timeout limitation`, (ev.limitations || []).includes('macro_timeout'));
    check(`${row.name} timeout reason`, ev.macroFailureReason === 'timeout');
    check(`${row.name} is fail-soft`, isFailSoft(resolveGroundingPolicy(r, { message: row.message }), ev) === true);
    check(
      `${row.name} does not force Azure`,
      shouldForceDirectAnswer({
        route: r,
        policy: resolveGroundingPolicy(r, { message: row.message }),
        evidence: ev,
      }) === false
    );
    check(`${row.name} fail-soft text`, typeof failSoftTextFor(ev) === 'string' && failSoftTextFor(ev).length > 0);
  }

  section('Grounded macro Azure timeout uses deterministic fallback');
  const trendRoute = route('Am I spending more lately?');
  const trendEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(trendRoute, { message: 'Am I spending more lately?' }),
    route: trendRoute,
    token: 'jwt',
    fetchTrendAnalysis: async () => sampleTrendResult(),
  });
  check('trend grounding ok', trendEv.status === 'ok' && trendEv.source[0] === 'cashflow_trend');
  const trendAzureCalls = [];
  const trendAzure = await runChatAzureNarration({
    queryFn: hangingQuery(trendAzureCalls),
    messages: [{ role: 'user', content: 'Am I spending more lately?' }],
    tools: [],
    primaryToolChoice: 'none',
    timeoutMs: 30,
    macroOwnsTurn: true,
    evidence: trendEv,
    accountName: 'Main Account',
    lifecycle: { clientAborted: false, hasBudgetFor: () => true, setStage() {} },
  });
  check('trend Azure not retried', trendAzureCalls.length === 1);
  check('trend fallback used', trendAzure.fallback === true);
  check('trend fallback uses supplied direction', /increasing/.test(trendAzure.content));
  check('trend fallback uses period labels', /June 1–16/.test(trendAzure.content) && /August 1–16/.test(trendAzure.content));
  check('trend fallback does not invent safe/comfortable', !/safe|comfortable|good idea|bad idea/i.test(trendAzure.content));

  const cmpRoute = route('How does this month compare with last month?');
  const cmpEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(cmpRoute, { message: 'How does this month compare with last month?' }),
    route: cmpRoute,
    token: 'jwt',
    fetchPeriodComparison: async () => sampleComparisonResult(),
  });
  const cmpAzureCalls = [];
  const cmpAzure = await runChatAzureNarration({
    queryFn: hangingQuery(cmpAzureCalls),
    messages: [{ role: 'user', content: 'How does this month compare with last month?' }],
    tools: [],
    primaryToolChoice: 'none',
    timeoutMs: 30,
    macroOwnsTurn: true,
    evidence: cmpEv,
    accountName: 'Main Account',
    lifecycle: { clientAborted: false, hasBudgetFor: () => true, setStage() {} },
  });
  check('comparison Azure not retried', cmpAzureCalls.length === 1);
  check('comparison fallback used', cmpAzure.fallback === true);
  check('comparison fallback has spending change', /Spending decreased/.test(cmpAzure.content));
  check('comparison fallback has net direction', /Net cash flow improved/.test(cmpAzure.content));
  check('comparison fallback no hallucination words', !/because|likely|probably/i.test(cmpAzure.content));

  const analysisRoute = route('How am I doing this month?');
  const analysisEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(analysisRoute, { message: 'How am I doing this month?' }),
    route: analysisRoute,
    token: 'jwt',
    fetchCashflowAnalysis: async () => sampleAnalysisResult(),
  });
  const analysisFallback = buildMacroFallbackText(analysisEv);
  check('analysis fallback uses posted income', /Posted income: \$3000/.test(analysisFallback));
  check('analysis fallback uses posted spending', /Posted spending: \$200/.test(analysisFallback));

  const affordRoute = route('Can I afford $800 next Friday?');
  const affordEv = await prefetchGrounding({
    trustedUserId: 5,
    accountId: 10,
    currentDate: '2026-08-16',
    policy: resolveGroundingPolicy(affordRoute, { message: 'Can I afford $800 next Friday?' }),
    route: affordRoute,
    token: 'jwt',
    fetchAffordabilityAnalysis: async () => sampleAffordabilityResult(),
  });
  const affordFallback = buildMacroFallbackText(affordEv);
  check('affordability fallback has amount and date', /\$800/.test(affordFallback) && /2026-08-21/.test(affordFallback));
  check('affordability fallback has baseline/hypo', /Baseline projected/.test(affordFallback) && /Hypothetical projected/.test(affordFallback));
  check('affordability fallback has no subjective advice', !/safe|comfortable|good idea|bad idea/i.test(affordFallback));

  section('Abort telemetry');
  const abortLogs = [];
  const telemetry = createKeaTelemetry({ requestId: 'abc-abort' });
  telemetry.recordGrounding({ effective_capability: 'cashflow_trend', financial_macro: 'trend_periods' });
  const { req, res } = mockReqRes();
  req.log = { info: (payload, msg) => abortLogs.push({ payload, msg }) };
  const lifecycle = createRequestLifecycle({ req, res, telemetry, requestId: 'abc-abort' });
  lifecycle.setStage('grounding_finished');
  lifecycle.attachListeners();
  req.aborted = true;
  req.emit('aborted');
  res.emit('close');
  check('one kea_chat_aborted', abortLogs.filter((e) => e.payload && e.payload.event === 'kea_chat_aborted').length === 1);
  const abortPayload = abortLogs[0].payload;
  check('abort has requestId', abortPayload.requestId === 'abc-abort');
  check('abort has elapsed_ms', typeof abortPayload.elapsed_ms === 'number');
  check('abort last_stage', abortPayload.last_stage === 'grounding_finished');
  check('abort client_aborted', abortPayload.client_aborted === true);
  check('abort has capability', abortPayload.effective_capability === 'cashflow_trend');
  check('abort has no message/body/account', abortPayload.message === undefined && abortPayload.token === undefined && abortPayload.accountId === undefined);

  section('Normal close does not abort');
  const okLogs = [];
  const okTel = createKeaTelemetry({ requestId: 'abc-ok' });
  const okPair = mockReqRes();
  okPair.req.log = { info: (payload) => okLogs.push(payload) };
  const okLife = createRequestLifecycle({ req: okPair.req, res: okPair.res, telemetry: okTel, requestId: 'abc-ok' });
  okLife.attachListeners();
  okPair.res.json({ response: 'ok' });
  okPair.res.emit('close');
  check('normal finish has no kea_chat_aborted', okLogs.every((p) => p.event !== 'kea_chat_aborted'));
  check('completed response with headersSent+ended', responseWasCompleted(okPair.res, okLife) === true);

  section('Abnormal close still emits abort');
  const ghostLogs = [];
  const ghostTel = createKeaTelemetry({ requestId: 'abc-ghost' });
  const ghost = mockReqRes();
  ghost.res.writableEnded = true;
  ghost.res.headersSent = false;
  ghost.res.statusCode = null;
  ghost.req.log = { info: (payload) => ghostLogs.push(payload) };
  const ghostLife = createRequestLifecycle({ req: ghost.req, res: ghost.res, telemetry: ghostTel, requestId: 'abc-ghost' });
  ghostLife.attachListeners();
  ghost.res.emit('close');
  check('writableEnded without headersSent emits abort', ghostLogs.some((p) => p.event === 'kea_chat_aborted'));

  section('Early abort middleware');
  const { attachChatAbortLifecycle, isChatPost } = require('../middleware/chatAbortLifecycle');
  check('isChatPost true for chat POST', isChatPost({ method: 'POST', originalUrl: '/api/agent/chat' }) === true);
  check('isChatPost false for GET', isChatPost({ method: 'GET', originalUrl: '/api/agent/chat' }) === false);
  const earlyReq = new EventEmitter();
  const earlyRes = new EventEmitter();
  earlyReq.method = 'POST';
  earlyReq.originalUrl = '/api/agent/chat';
  earlyReq.id = 'early-1';
  earlyReq.log = { info: (payload) => { earlyReq._abort = payload; } };
  earlyRes.writableEnded = false;
  earlyRes.headersSent = false;
  let earlyNext = false;
  attachChatAbortLifecycle(earlyReq, earlyRes, () => { earlyNext = true; });
  check('early middleware attaches lifecycle', earlyNext && !!earlyReq.keaLifecycle && !!earlyReq.keaTelemetry);
  earlyRes.emit('close');
  check('abort before handler emits kea_chat_aborted', earlyReq._abort && earlyReq._abort.event === 'kea_chat_aborted');

  const redis = require('../services/redisService');
  check('shared redis has commandTimeout', redis.options.commandTimeout === redisCommandTimeoutMs());
  const { withTimeout } = require('../middleware/cashflowAuth');
  const hangStarted = Date.now();
  let hangRejected = false;
  try {
    await withTimeout(new Promise(() => {}), 40, 'hung redis GET');
  } catch (err) {
    hangRejected = err && err.code === 'ETIMEDOUT';
  }
  check('hung Redis-style GET rejects inside bound', hangRejected && Date.now() - hangStarted < 500);
  check('Redis commandTimeout cannot reach frontend 120s', redisCommandTimeoutMs() < FRONTEND_ABORT_MS);

  const toolSrc = fs.readFileSync(path.join(__dirname, '../tools/keacast_tool_layer.js'), 'utf8');
  check('AUTH_HEADER sets timeout', /timeout:\s*cashflowHttpTimeoutMs\(\)/.test(toolSrc));
  check('recallFacts uses AUTH_HEADER', /async function recallFacts[\s\S]{0,600}AUTH_HEADER\(token\)/.test(toolSrc));
  check('buildSelectedAccountAxiosConfig always sets timeout', /config\.timeout = Number\.isFinite\(timeoutMs\) \? timeoutMs : cashflowHttpTimeoutMs\(\)/.test(toolSrc));

  section('No write to destroyed socket');
  const dead = mockReqRes({ aborted: true });
  dead.req.aborted = true;
  const deadLife = createRequestLifecycle({ req: dead.req, res: dead.res, requestId: 'dead' });
  deadLife.markClientAborted();
  const sentAborted = trySendJson(dead.req, dead.res, deadLife, 200, { response: 'nope' });
  check('aborted req does not json', sentAborted === false && dead.res.jsonCalls === 0);

  const destroyed = mockReqRes({ destroyed: true });
  const destLife = createRequestLifecycle({ req: destroyed.req, res: destroyed.res, requestId: 'dest' });
  const sentDestroyed = trySendJson(destroyed.req, destroyed.res, destLife, null, { response: 'nope' });
  check('destroyed res does not json', sentDestroyed === false && destroyed.res.jsonCalls === 0);
  check('canSendHttpResponse false when writableEnded', canSendHttpResponse(
    mockReqRes().req,
    Object.assign(mockReqRes().res, { writableEnded: true })
  ) === false);

  const bodyConsumed = mockReqRes();
  bodyConsumed.req.destroyed = true;
  bodyConsumed.req.aborted = false;
  const consumedLife = createRequestLifecycle({
    req: bodyConsumed.req,
    res: bodyConsumed.res,
    requestId: 'body-consumed',
  });
  const sentAfterBody = trySendJson(
    bodyConsumed.req,
    bodyConsumed.res,
    consumedLife,
    null,
    { response: 'trend-ok' }
  );
  check('req.destroyed after body read still jsons', sentAfterBody === true && bodyConsumed.res.jsonCalls === 1);

  section('Abort before Azure skips the call');
  const preAzureCalls = [];
  const skipped = await callAzureOnce({
    queryFn: hangingQuery(preAzureCalls),
    messages: [],
    tools: [],
    toolChoice: 'none',
    timeoutMs: 40,
    lifecycle: { clientAborted: true, hasBudgetFor: () => true, setStage() {} },
  });
  check('abort before Azure skips', skipped.skipped === true && skipped.reason === 'client_aborted');
  check('Azure not started after abort', preAzureCalls.length === 0);
  check('shouldStartNewExpensiveWork false when aborted', shouldStartNewExpensiveWork({ clientAborted: true }) === false);

  section('Write already started is not cancelled on abort');
  let writeStarted = false;
  let writeFinished = false;
  const { req: writeReq, res: writeRes } = mockReqRes();
  const writeTel = createKeaTelemetry({ requestId: 'write-abort' });
  const writeLife = createRequestLifecycle({
    req: writeReq,
    res: writeRes,
    telemetry: writeTel,
    requestId: 'write-abort',
  });
  writeLife.attachListeners();
  const writePromise = T.executeToolCalls([], [{
    id: 'c1',
    function: {
      name: 'createTransaction',
      arguments: JSON.stringify({
        title: 'Test Expense',
        amount: 800,
        type: 'expense',
        start: '2026-08-21',
        frequency: 2,
        category: 'Uncategorized',
      }),
    },
  }], writeCtx({
    lifecycle: writeLife,
    telemetry: writeTel,
    queryAzureOpenAI: async () => {
      throw new Error('Azure must not run after committed write');
    },
    functionMap: {
      createTransaction: async () => {
        writeStarted = true;
        writeReq.aborted = true;
        writeReq.emit('aborted');
        await new Promise((r) => setTimeout(r, 30));
        writeFinished = true;
        return {
          transaction_id: 99,
          title: 'Test Expense',
          amount: 800,
          start: '2026-08-21',
          frequency: 2,
        };
      },
    },
  }));
  const writeOut = await writePromise;
  check('write started', writeStarted === true);
  check('write finished after client abort', writeFinished === true);
  check('write commit receipt exists server-side', /Test Expense/.test(writeOut.content) && writeOut.writeResponseMode === 'deterministic_commit');
  const noSend = trySendJson(writeReq, writeRes, writeLife, null, { response: writeOut.content });
  check('no HTTP receipt on destroyed/aborted socket', noSend === false && writeRes.jsonCalls === 0);
  const turn = writeTel.toPayload();
  check('write_attempted recorded', turn.write_attempted === true);
  check('client_aborted on turn telemetry', turn.client_aborted === true);

  section('kea_chat_turn carries failure/stage fields');
  const t = createKeaTelemetry({ requestId: 'fields' });
  const payload = t.toPayload();
  check('last_stage default null', payload.last_stage === null);
  check('client_aborted default false', payload.client_aborted === false);
  check('azure_failure_reason default null', payload.azure_failure_reason === null);
  check('macro_failure_reason default null', payload.macro_failure_reason === null);
}

module.exports = { run };
