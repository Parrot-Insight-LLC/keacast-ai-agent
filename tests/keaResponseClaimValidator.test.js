'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');
const {
  buildSnapshotEvidenceLedger,
  buildUpcomingEvidenceLedger,
  buildComparisonEvidenceLedger,
  buildTrendEvidenceLedger,
  buildRecurringEvidenceLedger,
  buildIncomeHorizonEvidenceLedger,
} = require('../services/keaEvidenceLedgerBuilders');
const {
  VALIDATION_STATUS,
  SEVERITY,
  VIOLATION_CODE,
  LIST_COVERAGE,
  buildResponseValidationContract,
} = require('../services/keaResponseValidationContract');
const { extractResponseClaims } = require('../services/keaResponseClaimExtractor');
const {
  validateResponseAgainstContract,
  validateResponseClaims,
  summarizeValidationResult,
} = require('../services/keaResponseClaimValidator');
const {
  buildLookup,
  buildSnapshot,
  buildUpcomingMacro,
  buildEmptyUpcoming,
} = require('./keaResponseValidationContract.test');

const LIVE_C_TEXT = [
  'Your projected income for next month (September 2026) is $4626.36.',
  'Your projected expenses for next month are $3432.43.',
  'This results in a net positive cash flow of $1193.93.',
  'Your available balance is forecasted to be approximately $4846.97.',
  'Your balance is expected to increase by about $1194.',
].join(' ');

function codes(result) {
  return (result.violations || []).map((v) => v.code);
}

function hasCode(result, code) {
  return codes(result).indexOf(code) !== -1;
}

function lookupContract() {
  return buildResponseValidationContract(buildLookup()).contract;
}

function snapshotContract() {
  return buildResponseValidationContract(buildSnapshot()).contract;
}

function signedExpenseContract() {
  const ledger = buildSnapshotEvidenceLedger({
    capability: 'financial_forecast',
    evidence: {
      status: 'ok',
      source: ['kea_snapshot'],
      facts: {
        availableBalance: 4846.97,
        upcomingExpenseTotal: -162.24,
        upcomingIncomeTotal: 0,
        upcomingWindowDays: 15,
        upcoming: [{ name: 'Northwestern', amount: -162.24, start: '2026-08-21' }],
      },
      limitations: ['upcoming_window_15d'],
    },
    accountContext: { accountId: '10', accountLabel: 'Main Account' },
  }).ledger;
  return buildResponseValidationContract(ledger).contract;
}

const LIVE_E_TEXT = [
  'Next week, from August 23 to August 29, 2026:',
  '- Mira Pest Control: $79.99 on August 23',
  '- Weekly Gas: $120 on August 24',
  '- Google purchase: $19.99 on August 26',
  '- The Litt: $105 on August 26',
  '- Mercury Insurance: $267.32 on August 27',
  '- Daycare: $705 on August 28',
  'Total scheduled expenses for the week: $1297.30',
].join('\n');

const LIVE_A_TEXT = [
  'Here is what you have upcoming in the next 15 days.',
  'Total upcoming expenses are -$2558.47.',
  '- Services payment: -$162.24 on 2026-08-20',
  '- Apps subscription: -$63.90 on 2026-08-20',
  '- Child Care (Daycare): -$705 on 2026-08-21',
  '- Household (Pest Control): -$79.99 on 2026-08-23',
  '- Weekly Gas: -$120 on 2026-08-24',
  '- Google purchase: -$19.99 on 2026-08-26',
  '- The Litt: -$105 on 2026-08-26',
  '- Household (Mercury Insurance): -$267.32 on 2026-08-27',
  '- Child Care (Daycare): -$705 on 2026-08-28',
  '- Salary: +$4626.36 on 2026-08-31',
].join('\n');

function buildLiveEMacro() {
  return buildUpcomingEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_upcoming'],
      facts: {
        metricScope: 'expense',
        accountScope: 'selected_account',
        period: { start: '2026-08-23', end: '2026-08-29', relation: 'next_week' },
        items: [
          { label: 'Mira Pest Control', date: '2026-08-23', amount: 79.99 },
          { label: 'Weekly Gas', date: '2026-08-24', amount: 120 },
          { label: 'Google purchase', date: '2026-08-26', amount: 19.99 },
          { label: 'The Litt', date: '2026-08-26', amount: 105 },
          { label: 'Mercury Insurance', date: '2026-08-27', amount: 267.32 },
          { label: 'Daycare', date: '2026-08-28', amount: 705 },
        ],
        totals: { scheduledExpenseTotal: 1297.30 },
        itemCount: 6,
      },
      period: { start: '2026-08-23', end: '2026-08-29', relation: 'next_week', label: 'next_week' },
      observations: [],
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function buildLiveASnapshot() {
  return buildSnapshotEvidenceLedger({
    capability: 'financial_forecast',
    evidence: {
      status: 'ok',
      source: ['kea_snapshot'],
      facts: {
        availableBalance: 3739.38,
        currentBalance: 3739.38,
        reconciledBalance: 3739.38,
        monthIncome: 4626.36,
        monthExpenses: 3432.43,
        upcomingExpenseTotal: 2558.47,
        upcomingIncomeTotal: 4626.36,
        upcomingWindowDays: 15,
        recents: [],
        upcoming: [
          { name: 'Northwestern', amount: -162.24, start: '2026-08-20' },
          { name: 'Spotify', amount: -63.90, start: '2026-08-20' },
          { name: 'Daycare', amount: -705, start: '2026-08-21' },
          { name: 'Mira Pest Control', amount: -79.99, start: '2026-08-23' },
          { name: 'Weekly Gas', amount: -120, start: '2026-08-24' },
          { name: 'Google purchase', amount: -19.99, start: '2026-08-26' },
          { name: 'The Litt', amount: -105, start: '2026-08-26' },
          { name: 'Mercury Insurance', amount: -267.32, start: '2026-08-27' },
          { name: 'Daycare', amount: -705, start: '2026-08-28' },
          { name: 'MERIDIAN', amount: 4626.36, start: '2026-08-31' },
        ],
      },
      limitations: ['upcoming_window_15d'],
    },
    accountContext: { accountId: '10', accountLabel: 'Main Account' },
  }).ledger;
}

function buildAmbiguousDuplicateMacro() {
  return buildUpcomingEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_upcoming'],
      facts: {
        metricScope: 'expense',
        accountScope: 'selected_account',
        period: { start: '2026-08-23', end: '2026-08-29', relation: 'next_week' },
        items: [
          { label: 'Alpha Bill', date: '2026-08-23', amount: 50 },
          { label: 'Beta Bill', date: '2026-08-28', amount: 50 },
        ],
        totals: { scheduledExpenseTotal: 100 },
        itemCount: 2,
      },
      period: { start: '2026-08-23', end: '2026-08-29', relation: 'next_week' },
      observations: [],
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function liveEContract() {
  return buildResponseValidationContract(buildLiveEMacro()).contract;
}

function liveAContract() {
  return buildResponseValidationContract(buildLiveASnapshot()).contract;
}

async function run() {
  section('3C.1 validator Target goldens');
  const lookupC = lookupContract();
  const targetValid = validateResponseAgainstContract({
    contract: lookupC,
    text: 'In July 2026, you made 3 transactions at Target totaling $279.58.',
  });
  check('Target 279.58 VALID', targetValid.status === VALIDATION_STATUS.VALID);
  check('Target 279.58 no amount violation', !hasCode(targetValid, VIOLATION_CODE.UNSUPPORTED_AMOUNT));

  const repeated = validateResponseAgainstContract({
    contract: lookupC,
    text: 'You spent $279.58 at Target. That $279.58 is the July total.',
  });
  check('repeated authorized amount still VALID', repeated.status === VALIDATION_STATUS.VALID);

  const wrongAmt = validateResponseAgainstContract({
    contract: lookupC,
    text: 'You made 3 transactions at Target totaling $280.',
  });
  check('Target 280 INVALID', wrongAmt.status === VALIDATION_STATUS.INVALID);
  check('Target 280 UNSUPPORTED_AMOUNT', hasCode(wrongAmt, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
  check('Target 280 CRITICAL', wrongAmt.violations.some((v) => v.code === VIOLATION_CODE.UNSUPPORTED_AMOUNT
    && v.severity === SEVERITY.CRITICAL));

  const roundedApprox = validateResponseAgainstContract({
    contract: lookupC,
    text: 'You spent about $280 at Target.',
  });
  check('about $280 INVALID despite approx', roundedApprox.status === VALIDATION_STATUS.INVALID);

  const exactApprox = validateResponseAgainstContract({
    contract: lookupC,
    text: 'You spent approximately $279.58.',
  });
  check('approximately exact amount VALID', exactApprox.status === VALIDATION_STATUS.VALID);

  const countOk = validateResponseAgainstContract({
    contract: lookupC,
    text: 'You made 3 transactions at Target totaling $279.58.',
  });
  check('Target count 3 VALID', countOk.status === VALIDATION_STATUS.VALID);

  const countBad = validateResponseAgainstContract({
    contract: lookupC,
    text: 'You made 4 Target transactions totaling $279.58.',
  });
  check('Target count 4 INVALID', countBad.status === VALIDATION_STATUS.INVALID);
  check('Target count 4 UNSUPPORTED_COUNT', hasCode(countBad, VIOLATION_CODE.UNSUPPORTED_COUNT));

  section('3C.1 validator signed / magnitude / derivation');
  const signedC = signedExpenseContract();
  const signedOk = validateResponseAgainstContract({
    contract: signedC,
    text: 'Services expense of $162.24',
  });
  check('signed -162.24 as $162.24 expense VALID', signedOk.status === VALIDATION_STATUS.VALID);

  const signedIncome = validateResponseAgainstContract({
    contract: signedC,
    text: 'Income of $162.24',
  });
  check('signed expense as income never VALID', signedIncome.status !== VALIDATION_STATUS.VALID);

  const macroC = buildResponseValidationContract(buildUpcomingMacro()).contract;
  const magOk = validateResponseAgainstContract({
    contract: macroC,
    text: 'Total scheduled expenses are $1297.30.',
  });
  check('macro 1297.30 VALID', magOk.status === VALIDATION_STATUS.VALID);
  const magRound = validateResponseAgainstContract({
    contract: macroC,
    text: 'Total scheduled expenses are $1297.',
  });
  check('rounded 1297 INVALID', magRound.status === VALIDATION_STATUS.INVALID);

  const snapC = snapshotContract();
  const derived = validateResponseAgainstContract({
    contract: snapC,
    text: 'Your net cash flow is $1193.93.',
  });
  check('derived 1193.93 INVALID', derived.status === VALIDATION_STATUS.INVALID);
  check('derived uses amount or derivation code', hasCode(derived, VIOLATION_CODE.UNSUPPORTED_DERIVATION)
    || hasCode(derived, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
  check('validator did not authorize 1193.93', !snapC.allowedClaims.some((c) => c.value === 1193.93));

  section('3C.1 validator snapshot balance goldens');
  const balOk = validateResponseAgainstContract({
    contract: snapC,
    text: 'Your available balance is $4846.97.',
  });
  check('availableBalance 4846.97 VALID', balOk.status === VALIDATION_STATUS.VALID);

  const balRound = validateResponseAgainstContract({
    contract: snapC,
    text: 'Your available balance is $4847.',
  });
  check('rounded 4847 INVALID', balRound.status === VALIDATION_STATUS.INVALID);

  const nextMonth = validateResponseAgainstContract({
    contract: snapC,
    text: 'Your balance at the end of next month will be $4846.97.',
  });
  check('next-month same-value never VALID', nextMonth.status !== VALIDATION_STATUS.VALID);
  check('next-month forecast or period code', hasCode(nextMonth, VIOLATION_CODE.UNSUPPORTED_FORECAST)
    || hasCode(nextMonth, VIOLATION_CODE.UNSUPPORTED_PERIOD_ATTRIBUTION)
    || nextMonth.status === VALIDATION_STATUS.INDETERMINATE);

  section('3C.1 validator live-C fixture');
  const liveC = validateResponseAgainstContract({ contract: snapC, text: LIVE_C_TEXT });
  check('live-C overall not VALID', liveC.status !== VALIDATION_STATUS.VALID);
  check('live-C $1193.93 invalid', hasCode(liveC, VIOLATION_CODE.UNSUPPORTED_DERIVATION)
    || hasCode(liveC, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
  check('live-C $1194 invalid', liveC.violations.length >= 2);
  const extractedLive = extractResponseClaims(LIVE_C_TEXT);
  const liveAmounts = extractedLive.filter((r) => r.normalizedValue === 4846.97);
  check('live-C extracted 4846.97', liveAmounts.length >= 1);
  check('live-C 4846.97 not accepted as current-only valid', hasCode(liveC, VIOLATION_CODE.UNSUPPORTED_FORECAST)
    || liveC.status === VALIDATION_STATUS.INDETERMINATE
    || liveC.status === VALIDATION_STATUS.INVALID);
  console.log(`  live-C status=${liveC.status} violations=${codes(liveC).join(',') || '(none)'} indeterminate=${(liveC.indeterminate || []).map((r) => r.code).join(',') || '(none)'}`);

  section('3C.1 validator list tuples');
  const daycareOk = validateResponseAgainstContract({
    contract: snapC,
    text: 'Daycare $705 on August 22',
  });
  check('Daycare 705 August 22 VALID', daycareOk.status === VALIDATION_STATUS.VALID);

  const daycareDup = validateResponseAgainstContract({
    contract: snapC,
    text: 'Daycare $705 on August 29',
  });
  check('second Daycare date binds distinctly', daycareDup.status === VALIDATION_STATUS.VALID);

  const cross = validateResponseAgainstContract({
    contract: snapC,
    text: 'Daycare $705 on August 24',
  });
  check('cross-item mix INVALID', cross.status === VALIDATION_STATUS.INVALID);
  check('cross-item LIST_ITEM_MISMATCH', hasCode(cross, VIOLATION_CODE.LIST_ITEM_MISMATCH));

  section('3C.2 list-item authorization hardening goldens');
  const liveE = liveEContract();
  const liveEResult = validateResponseAgainstContract({ contract: liveE, text: LIVE_E_TEXT });
  console.log(`  live-E status=${liveEResult.status} violations=${codes(liveEResult).join(',') || '(none)'} indeterminate=${(liveEResult.indeterminate || []).map((r) => r.code).join(',') || '(none)'}`);
  check('live-E VALID', liveEResult.status === VALIDATION_STATUS.VALID);
  check('live-E no UNSUPPORTED_AMOUNT', !hasCode(liveEResult, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
  check('live-E no UNSUPPORTED_FORECAST', !hasCode(liveEResult, VIOLATION_CODE.UNSUPPORTED_FORECAST));
  check('live-E no forecast indeterminate', !(liveEResult.indeterminate || []).some((r) => r.code === VIOLATION_CODE.UNSUPPORTED_FORECAST));

  const liveA = liveAContract();
  const liveAResult = validateResponseAgainstContract({ contract: liveA, text: LIVE_A_TEXT });
  console.log(`  live-A status=${liveAResult.status} violations=${codes(liveAResult).join(',') || '(none)'} indeterminate=${(liveAResult.indeterminate || []).map((r) => r.code).join(',') || '(none)'}`);
  check('live-A VALID', liveAResult.status === VALIDATION_STATUS.VALID);
  check('live-A no UNSUPPORTED_AMOUNT', !hasCode(liveAResult, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
  check('live-A no LIST_ITEM_MISMATCH', !hasCode(liveAResult, VIOLATION_CODE.LIST_ITEM_MISMATCH));

  const expenseTotal = validateResponseAgainstContract({
    contract: liveA,
    text: 'Total upcoming expenses are -$2558.47.',
  });
  check('signed expense-total -$2558.47 VALID', expenseTotal.status === VALIDATION_STATUS.VALID);

  const signedRow = validateResponseAgainstContract({
    contract: liveA,
    text: 'Services payment: -$162.24 on 2026-08-20',
  });
  check('signed row exact cents VALID', signedRow.status === VALIDATION_STATUS.VALID);

  const parenthetical = validateResponseAgainstContract({
    contract: liveA,
    text: 'Child Care (Daycare): -$705 on 2026-08-21',
  });
  check('parenthetical Daycare VALID', parenthetical.status === VALIDATION_STATUS.VALID);

  const duplicateDaycare = validateResponseAgainstContract({
    contract: liveA,
    text: 'Child Care (Daycare): -$705 on 2026-08-21 and Child Care (Daycare): -$705 on 2026-08-28',
  });
  check('duplicate Daycare distinct dates VALID', duplicateDaycare.status === VALIDATION_STATUS.VALID);

  const wrongDaycareDate = validateResponseAgainstContract({
    contract: liveA,
    text: 'Daycare: -$705 on Aug 24',
  });
  check('wrong Daycare date INVALID', wrongDaycareDate.status === VALIDATION_STATUS.INVALID);
  check('wrong Daycare date LIST_ITEM_MISMATCH', hasCode(wrongDaycareDate, VIOLATION_CODE.LIST_ITEM_MISMATCH));
  check('wrong Daycare date not UNSUPPORTED_AMOUNT', !hasCode(wrongDaycareDate, VIOLATION_CODE.UNSUPPORTED_AMOUNT));

  const ambiguousC = buildResponseValidationContract(buildAmbiguousDuplicateMacro()).contract;
  const ambiguous = validateResponseAgainstContract({
    contract: ambiguousC,
    text: 'There is a $50.00 charge upcoming.',
  });
  check('ambiguous duplicate no-date INDETERMINATE', ambiguous.status === VALIDATION_STATUS.INDETERMINATE);
  check('ambiguous not VALID', ambiguous.status !== VALIDATION_STATUS.VALID);
  check('ambiguous not UNSUPPORTED_AMOUNT', !hasCode(ambiguous, VIOLATION_CODE.UNSUPPORTED_AMOUNT));

  const targetGood = validateResponseAgainstContract({
    contract: lookupC,
    text: 'You spent $279.58 at Target.',
  });
  check('regression Target 279.58 VALID', targetGood.status === VALIDATION_STATUS.VALID);
  const targetWrong = validateResponseAgainstContract({
    contract: lookupC,
    text: 'You spent $280 at Target.',
  });
  check('regression Target $280 INVALID', targetWrong.status === VALIDATION_STATUS.INVALID);
  check('regression Target $280 UNSUPPORTED_AMOUNT CRITICAL', targetWrong.violations.some((v) => v.code === VIOLATION_CODE.UNSUPPORTED_AMOUNT
    && v.severity === SEVERITY.CRITICAL));

  const balGood = validateResponseAgainstContract({
    contract: liveA,
    text: 'Your available balance is $3739.38.',
  });
  check('regression balance 3739.38 VALID', balGood.status === VALIDATION_STATUS.VALID);
  const balRounded = validateResponseAgainstContract({
    contract: liveA,
    text: 'Your available balance is $3739.',
  });
  check('regression rounded balance INVALID', balRounded.status === VALIDATION_STATUS.INVALID);
  const balRoundedZero = validateResponseAgainstContract({
    contract: liveA,
    text: 'Your available balance is $3739.00.',
  });
  check('regression 3739.00 INVALID', balRoundedZero.status === VALIDATION_STATUS.INVALID);

  const derivedLiveA = validateResponseAgainstContract({
    contract: liveA,
    text: 'Your net cash flow is $1193.93.',
  });
  check('regression derived 1193.93 INVALID', derivedLiveA.status === VALIDATION_STATUS.INVALID);

  const nextMonthBal = validateResponseAgainstContract({
    contract: liveA,
    text: 'Your balance next month will be $3739.38.',
  });
  check('regression next-month current balance INVALID', nextMonthBal.status === VALIDATION_STATUS.INVALID);
  check('regression next-month forecast or period', hasCode(nextMonthBal, VIOLATION_CODE.UNSUPPORTED_FORECAST)
    || hasCode(nextMonthBal, VIOLATION_CODE.UNSUPPORTED_PERIOD_ATTRIBUTION));

  const macroTotal = validateResponseAgainstContract({
    contract: liveE,
    text: 'Total scheduled expenses are $1297.30.',
  });
  check('regression macro 1297.30 VALID', macroTotal.status === VALIDATION_STATUS.VALID);
  const macroWrong = validateResponseAgainstContract({
    contract: liveE,
    text: 'Total scheduled expenses are $1298.30.',
  });
  check('regression macro 1298.30 INVALID', macroWrong.status === VALIDATION_STATUS.INVALID);
  check('regression macro 1298.30 UNSUPPORTED_AMOUNT', hasCode(macroWrong, VIOLATION_CODE.UNSUPPORTED_AMOUNT));

  const incomeWrongSign = validateResponseAgainstContract({
    contract: liveA,
    text: 'Upcoming income is -$4626.36 income.',
  });
  check('income wrong sign INVALID', incomeWrongSign.status === VALIDATION_STATUS.INVALID);

  const balanceWrongSign = validateResponseAgainstContract({
    contract: liveA,
    text: 'Your available balance is -$3739.38.',
  });
  check('balance wrong sign INVALID', balanceWrongSign.status === VALIDATION_STATUS.INVALID);

  const mercuryRow = validateResponseAgainstContract({
    contract: liveA,
    text: 'Mercury Insurance $267.32 on Aug 27',
  });
  check('forecast scheduled row VALID', mercuryRow.status === VALIDATION_STATUS.VALID);

  const firstTokenMira = validateResponseAgainstContract({
    contract: liveE,
    text: 'Mira Pest Control: $79.99 on August 23',
  });
  check('first-token Mira still VALID', firstTokenMira.status === VALIDATION_STATUS.VALID);

  const absentAmount = validateResponseAgainstContract({
    contract: lookupC,
    text: 'You spent $280 at Target.',
  });
  check('value absent UNSUPPORTED_AMOUNT', hasCode(absentAmount, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
  check('incompatible tuple LIST_ITEM_MISMATCH', hasCode(wrongDaycareDate, VIOLATION_CODE.LIST_ITEM_MISMATCH));
  check('unresolved candidates INDETERMINATE', ambiguous.status === VALIDATION_STATUS.INDETERMINATE);

  section('3C.1 validator preview coverage + wording');
  check('snapshot upcoming listCoverage preview', snapC.listCoverage.upcoming === LIST_COVERAGE.PREVIEW);
  const windowOk = validateResponseAgainstContract({
    contract: snapC,
    text: 'Your total scheduled expenses for the 15-day window are $1134.56.',
  });
  check('window total amount VALID', windowOk.status === VALIDATION_STATUS.VALID
    || (windowOk.status === VALIDATION_STATUS.INDETERMINATE && !hasCode(windowOk, VIOLATION_CODE.UNSUPPORTED_AMOUNT)));

  const previewWording = validateResponseAgainstContract({
    contract: snapC,
    text: 'The transactions listed above total $1134.56.',
  });
  check('preview-total fixture present', previewWording.status === VALIDATION_STATUS.INVALID
    || previewWording.status === VALIDATION_STATUS.INDETERMINATE);
  if (previewWording.status === VALIDATION_STATUS.INVALID) {
    check('preview-total PREVIEW_TOTAL_MISATTRIBUTION', hasCode(previewWording, VIOLATION_CODE.PREVIEW_TOTAL_MISATTRIBUTION));
  } else {
    check('preview-total TODO 3C.4 indeterminate', (previewWording.indeterminate || [])
      .some((row) => row.code === VIOLATION_CODE.PREVIEW_TOTAL_MISATTRIBUTION));
  }

  section('3C.1 validator empty / no material claims / direction');
  const emptyC = buildResponseValidationContract(buildEmptyUpcoming()).contract;
  const emptyText = validateResponseAgainstContract({
    contract: emptyC,
    text: 'No scheduled recurring income was found for this period.',
  });
  check('empty narration not INVALID', emptyText.status !== VALIDATION_STATUS.INVALID);
  check('empty contract retains complete_empty', emptyC.status === 'complete_empty');

  const noClaims = validateResponseAgainstContract({
    contract: lookupC,
    text: 'Here’s what I found.',
  });
  check('no material claims VALID', noClaims.status === VALIDATION_STATUS.VALID);

  const direction = validateResponseAgainstContract({
    contract: snapC,
    text: 'Your balance will increase next month.',
  });
  check('unauthorized direction not globally VALID', direction.status !== VALIDATION_STATUS.VALID);

  section('3C.1 privacy-safe summary');
  const leakSource = validateResponseAgainstContract({
    contract: lookupC,
    text: 'In July 2026, you spent $280 at Target on Main Account totaling 279.58.',
  });
  const summary = summarizeValidationResult(leakSource);
  const blob = JSON.stringify(summary);
  check('summary has status and codes only', typeof summary.status === 'string'
    && Array.isArray(summary.violationCodes)
    && typeof summary.violationCount === 'number');
  check('summary does not leak Target', blob.indexOf('Target') === -1);
  check('summary does not leak 279.58', blob.indexOf('279.58') === -1);
  check('summary does not leak 280', blob.indexOf('280') === -1);
  check('summary does not leak July 2026', blob.indexOf('July 2026') === -1);
  check('summary does not leak Main Account', blob.indexOf('Main Account') === -1);
  check('summary does not leak raw sentence', blob.indexOf('you spent') === -1);

  section('3C.1 validator immutability');
  const contractClone = lookupC;
  const before = JSON.stringify(contractClone);
  validateResponseAgainstContract({ contract: contractClone, text: 'You spent $280 at Target.' });
  check('validation does not mutate contract', JSON.stringify(contractClone) === before);

  const opts = { keep: true };
  const extracted = extractResponseClaims('You spent $279.58.', opts);
  const beforeExtracted = JSON.stringify(extracted);
  validateResponseClaims({ contract: lookupC, extractedClaims: extracted });
  check('validation does not mutate extracted claims', JSON.stringify(extracted) === beforeExtracted);

  section('3C.1 invalid contract result');
  const missing = validateResponseClaims({ contract: null, extractedClaims: [] });
  check('missing contract INVALID_CONTRACT', missing.status === VALIDATION_STATUS.INVALID
    && hasCode(missing, VIOLATION_CODE.INVALID_CONTRACT));

  section('3C.1 chat-hook guard');
  const controller = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'openaiController.js'), 'utf8');
  const azure = fs.readFileSync(path.join(__dirname, '..', 'services', 'keaAzureChat.js'), 'utf8');
  const openai = fs.readFileSync(path.join(__dirname, '..', 'services', 'openaiService.js'), 'utf8');
  check('no chat/azure/openaiService 3C.1 hook',
    controller.indexOf('validateResponseAgainstContract') === -1
    && controller.indexOf('keaResponseClaimExtractor') === -1
    && controller.indexOf('keaResponseClaimValidator') === -1
    && controller.indexOf('keaResponseValidationContract') === -1
    && azure.indexOf('keaResponseClaim') === -1
    && openai.indexOf('keaResponseClaim') === -1);

  section('3C.1 no logger / no math in 3C.1 modules');
  const files = [
    'keaResponseValidationContract.js',
    'keaResponseClaimExtractor.js',
    'keaResponseClaimValidator.js',
  ];
  let loggerHits = 0;
  let mathHits = 0;
  for (let i = 0; i < files.length; i += 1) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', files[i]), 'utf8');
    if (/console\.(log|info|warn|error)|logger\./.test(src)) loggerHits += 1;
    if (/\.reduce\(/.test(src)) mathHits += 1;
    if (files[i] === 'keaResponseClaimValidator.js' && /Math\.abs\(/.test(src)) mathHits += 1;
  }
  check('no logger in 3C.1 modules', loggerHits === 0);
  check('no financial reduce/abs/percent math', mathHits === 0);

  section('3C.2 comparison signed-delta goldens');
  const comparisonLedger = buildComparisonEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_period_comparison'],
      facts: {
        accountScope: 'selected_account',
        windowKind: 'matched_elapsed',
        periodA: {
          label: 'June 2026',
          start: '2026-06-01',
          end: '2026-06-30',
          income: 0,
          spending: 15010.46,
          net: -15010.46,
        },
        periodB: {
          label: 'July 2026',
          start: '2026-07-01',
          end: '2026-07-31',
          income: 0,
          spending: 12916.99,
          net: -12916.99,
        },
        changes: {
          income: { absolute: 0, percent: 0, direction: 'unchanged', baselineZero: false },
          spending: { absolute: -2093.47, percent: -13.95, direction: 'decreased', baselineZero: false },
          net: { absolute: 2093.47, percent: 13.95, direction: 'improved', baselineZero: false },
        },
      },
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
  const comparisonC = buildResponseValidationContract(comparisonLedger).contract;
  const comparisonGood = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'In July 2026, spending was $12916.99, compared with $15010.46 in June 2026. Spending decreased by $2093.47, or 13.95%.',
  });
  check('comparison spoken magnitude and percent VALID', comparisonGood.status === VALIDATION_STATUS.VALID);

  const comparisonWrongDelta = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending decreased by $2094.47.',
  });
  check('comparison wrong delta INVALID', comparisonWrongDelta.status === VALIDATION_STATUS.INVALID);

  const comparisonWrongPct = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending decreased by 14%.',
  });
  check('comparison wrong percent INVALID', comparisonWrongPct.status === VALIDATION_STATUS.INVALID
    && hasCode(comparisonWrongPct, VIOLATION_CODE.UNSUPPORTED_COMPARISON));

  const comparisonWrongDir = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending increased by $2093.47.',
  });
  check('comparison wrong direction not VALID', comparisonWrongDir.status !== VALIDATION_STATUS.VALID);

  section('3C.2 comparison absolute-change role goldens');
  const PROD_CMP_TEXT = [
    '- Your spending decreased by 13.95% in July 2026 compared to June 2026.',
    '- In June, spending was $15010.46.',
    '- In July, spending was $12916.99.',
    '- The absolute decrease in spending was $2093.47.',
    '',
    'This shows you spent less in July than in June by nearly 14%.',
  ].join('\n');
  const PROD_CMP_NO_14_TEXT = [
    '- Your spending decreased by 13.95% in July 2026 compared to June 2026.',
    '- In June, spending was $15010.46.',
    '- In July, spending was $12916.99.',
    '- The absolute decrease in spending was $2093.47.',
  ].join('\n');
  const PROD_CMP_COMBINED_TEXT = [
    'In June, spending was $15010.46.',
    'In July, spending was $12916.99.',
    'The absolute decrease in spending was $2093.47.',
    'That is a 13.95% decrease.',
  ].join('\n');

  const prodCmpExtracted = extractResponseClaims(PROD_CMP_TEXT);
  const prodCmp = validateResponseClaims({
    contract: comparisonC,
    extractedClaims: prodCmpExtracted,
  });
  const prodPct1395 = prodCmpExtracted.find((r) => r.kind === 'percent' && r.normalizedValue === 13.95);
  const prodPct14 = prodCmpExtracted.find((r) => r.kind === 'percent' && r.normalizedValue === 14);
  const prodAmt2093 = prodCmpExtracted.find((r) => (
    r.kind === 'amount' || r.kind === 'entity_amount' || r.kind === 'entity_amount_date'
  ) && r.normalizedValue === 2093.47);
  const prodAmtJune = prodCmpExtracted.find((r) => (
    r.kind === 'amount' || r.kind === 'entity_amount' || r.kind === 'entity_amount_date'
  ) && r.normalizedValue === 15010.46);
  const prodAmtJuly = prodCmpExtracted.find((r) => (
    r.kind === 'amount' || r.kind === 'entity_amount' || r.kind === 'entity_amount_date'
  ) && r.normalizedValue === 12916.99);
  check('exact production comparison INVALID', prodCmp.status === VALIDATION_STATUS.INVALID);
  check('exact production comparison UNSUPPORTED_COMPARISON', hasCode(prodCmp, VIOLATION_CODE.UNSUPPORTED_COMPARISON));
  check('exact production comparison no UNSUPPORTED_AMOUNT', !hasCode(prodCmp, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
  check('exact production comparison 14% extracted', !!prodPct14);
  check('exact production comparison 14% rejected', (prodCmp.violations || []).some((v) => v.extractedClaimId === (prodPct14 && prodPct14.id)));
  check('exact production comparison 13.95 binds', !!prodPct1395
    && !(prodCmp.violations || []).some((v) => v.extractedClaimId === prodPct1395.id));
  check('exact production comparison 2093.47 is delta', prodAmt2093
    && (prodAmt2093.semanticHints || []).indexOf('delta') !== -1
    && (prodAmt2093.semanticHints || []).indexOf('period_value') === -1);
  check('exact production comparison 2093.47 binds', !!prodAmt2093
    && !(prodCmp.violations || []).some((v) => v.extractedClaimId === prodAmt2093.id));
  check('exact production comparison June amount binds', !!prodAmtJune
    && !(prodCmp.violations || []).some((v) => v.extractedClaimId === prodAmtJune.id));
  check('exact production comparison July amount binds', !!prodAmtJuly
    && !(prodCmp.violations || []).some((v) => v.extractedClaimId === prodAmtJuly.id));
  check('exact production comparison 0 indeterminate', (prodCmp.indeterminate || []).length === 0);
  check('exact production comparison only 14% violation', (prodCmp.violations || []).length === 1
    && prodCmp.violations[0].extractedClaimId === (prodPct14 && prodPct14.id));

  const prodCmpNo14 = validateResponseAgainstContract({
    contract: comparisonC,
    text: PROD_CMP_NO_14_TEXT,
  });
  check('production comparison without 14% VALID', prodCmpNo14.status === VALIDATION_STATUS.VALID);
  check('production comparison without 14% 0 violations', (prodCmpNo14.violations || []).length === 0);
  check('production comparison without 14% 0 indeterminate', (prodCmpNo14.indeterminate || []).length === 0);

  const absDecWas = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'The absolute decrease in spending was $2093.47.',
  });
  check('absolute decrease was $X VALID', absDecWas.status === VALIDATION_STATUS.VALID
    && (absDecWas.violations || []).length === 0
    && (absDecWas.indeterminate || []).length === 0);

  const comparisonIncreaseLedger = buildComparisonEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_period_comparison'],
      facts: {
        accountScope: 'selected_account',
        windowKind: 'matched_elapsed',
        periodA: {
          label: 'June 2026',
          start: '2026-06-01',
          end: '2026-06-30',
          income: 0,
          spending: 15010.46,
          net: -15010.46,
        },
        periodB: {
          label: 'July 2026',
          start: '2026-07-01',
          end: '2026-07-31',
          income: 0,
          spending: 12916.99,
          net: -12916.99,
        },
        changes: {
          income: { absolute: 0, percent: 0, direction: 'unchanged', baselineZero: false },
          spending: { absolute: 2093.47, percent: 13.95, direction: 'increased', baselineZero: false },
          net: { absolute: 2093.47, percent: 13.95, direction: 'improved', baselineZero: false },
        },
      },
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
  const comparisonIncreaseC = buildResponseValidationContract(comparisonIncreaseLedger).contract;
  const absIncWas = validateResponseAgainstContract({
    contract: comparisonIncreaseC,
    text: 'The absolute increase in spending was $2093.47.',
  });
  check('absolute increase was $X VALID', absIncWas.status === VALIDATION_STATUS.VALID
    && (absIncWas.violations || []).length === 0
    && (absIncWas.indeterminate || []).length === 0);

  const changeWasAmt = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'The change in spending was $2093.47.',
  });
  check('change in spending was $X binds magnitude', changeWasAmt.status === VALIDATION_STATUS.VALID
    && (changeWasAmt.violations || []).length === 0);

  const juneSpendWasValid = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'In June, spending was $15010.46.',
  });
  check('June spending was $X VALID', juneSpendWasValid.status === VALIDATION_STATUS.VALID);
  const julySpendWasValid = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'In July, spending was $12916.99.',
  });
  check('July spending was $X VALID', julySpendWasValid.status === VALIDATION_STATUS.VALID);
  const juneLabelSpendWas = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'June spending was $15010.46.',
  });
  check('June spending was $X label VALID', juneLabelSpendWas.status === VALIDATION_STATUS.VALID);
  const decreasedToValid = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending decreased to $12916.99.',
  });
  check('decreased to $X remains VALID', decreasedToValid.status === VALIDATION_STATUS.VALID);
  const decreasedByValid = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending decreased by $2093.47.',
  });
  check('decreased by $X remains VALID', decreasedByValid.status === VALIDATION_STATUS.VALID);

  const combinedAbsChange = validateResponseAgainstContract({
    contract: comparisonC,
    text: PROD_CMP_COMBINED_TEXT,
  });
  check('combined period and absolute-change VALID', combinedAbsChange.status === VALIDATION_STATUS.VALID);
  check('combined period and absolute-change 0 violations', (combinedAbsChange.violations || []).length === 0);
  check('combined period and absolute-change 0 indeterminate', (combinedAbsChange.indeterminate || []).length === 0);

  const wrongAbsDelta = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'The absolute decrease in spending was $2094.47.',
  });
  check('wrong absolute-change amount INVALID', wrongAbsDelta.status === VALIDATION_STATUS.INVALID
    && hasCode(wrongAbsDelta, VIOLATION_CODE.UNSUPPORTED_AMOUNT));

  const julyWrongPeriodExtracted = extractResponseClaims('In July, spending was $15010.46.');
  const julyWrongPeriodAmt = julyWrongPeriodExtracted.find((r) => (
    r.kind === 'amount' || r.kind === 'entity_amount' || r.kind === 'entity_amount_date'
  ) && r.normalizedValue === 15010.46);
  check('July period with June amount remains period_value', !!julyWrongPeriodAmt
    && (julyWrongPeriodAmt.semanticHints || []).indexOf('period_value') !== -1
    && (julyWrongPeriodAmt.semanticHints || []).indexOf('delta') === -1);

  const comparisonDeltaAsPeriod = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'In June, spending was $2093.47.',
  });
  check('delta amount used as period value INVALID', comparisonDeltaAsPeriod.status === VALIDATION_STATUS.INVALID);

  const comparisonPeriodAsDelta = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'The absolute decrease in spending was $12916.99.',
  });
  check('period amount used as delta INVALID', comparisonPeriodAsDelta.status === VALIDATION_STATUS.INVALID);

  const absIncWrongDir = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'The absolute increase in spending was $2093.47.',
  });
  check('absolute increase vs decreased contract not VALID', absIncWrongDir.status !== VALIDATION_STATUS.VALID);

  const absDecWrongDir = validateResponseAgainstContract({
    contract: comparisonIncreaseC,
    text: 'The absolute decrease in spending was $2093.47.',
  });
  check('absolute decrease vs increased contract not VALID', absDecWrongDir.status !== VALIDATION_STATUS.VALID);

  section('3C.2 trend period and first-to-last goldens');
  const trendLedger = buildTrendEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_trend'],
      facts: {
        accountScope: 'selected_account',
        windowKind: 'matched_elapsed',
        metricScope: 'spending',
        periods: [
          { label: 'June 1–23, 2026', start: '2026-06-01', end: '2026-06-23', spending: 12815.73 },
          { label: 'July 1–23, 2026', start: '2026-07-01', end: '2026-07-23', spending: 11784.96 },
          { label: 'August 1–23, 2026', start: '2026-08-01', end: '2026-08-23', spending: 10380.54 },
        ],
        trend: {
          spending: {
            direction: 'decreasing',
            firstToLast: { absolute: -2435.19, percent: -19, baselineZero: false },
          },
        },
        highest: { metric: 'spending', label: 'June 1–23, 2026', value: 12815.73 },
        lowest: { metric: 'spending', label: 'August 1–23, 2026', value: 10380.54 },
      },
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
  const trendC = buildResponseValidationContract(trendLedger).contract;
  const trendPeriods = validateResponseAgainstContract({
    contract: trendC,
    text: 'June: $12815.73. July: $11784.96. August: $10380.54.',
  });
  check('trend three-period spending VALID', trendPeriods.status === VALIDATION_STATUS.VALID);

  const trendWrongMiddle = validateResponseAgainstContract({
    contract: trendC,
    text: 'July: $11785.96',
  });
  check('trend wrong middle amount INVALID', trendWrongMiddle.status === VALIDATION_STATUS.INVALID);

  const trendCross = validateResponseAgainstContract({
    contract: trendC,
    text: 'July: $12815.73',
  });
  check('trend June amount as July INVALID', trendCross.status === VALIDATION_STATUS.INVALID);

  const trendDelta = validateResponseAgainstContract({
    contract: trendC,
    text: 'Spending decreased by $2435.19.',
  });
  check('trend first-to-last spoken magnitude VALID', trendDelta.status === VALIDATION_STATUS.VALID);

  const trendPct = validateResponseAgainstContract({
    contract: trendC,
    text: 'Spending decreased by 19%.',
  });
  check('trend first-to-last percent VALID', trendPct.status === VALIDATION_STATUS.VALID);

  const trendWrongPct = validateResponseAgainstContract({
    contract: trendC,
    text: 'Spending decreased by 20%.',
  });
  check('trend wrong percent INVALID', trendWrongPct.status === VALIDATION_STATUS.INVALID);

  const trendDir = validateResponseAgainstContract({
    contract: trendC,
    text: 'Spending decreased and is trending downward.',
  });
  check('trend direction decreased/downward VALID', trendDir.status === VALIDATION_STATUS.VALID);

  section('3C.2 live comparison/trend semantic-binding goldens');
  const LIVE_CMP_A_TEXT = [
    '- In July 2026, your spending was $12916.99.',
    '- In June 2026, your spending was $15010.46.',
    '- Your spending decreased by $2093.47 from June to July.',
    '- This is a 13.95% reduction in spending month-over-month.',
    '',
    'So, you spent less in July compared to June by nearly 14%.',
    'Would you like to review specific spending categories?',
  ].join('\n');
  const LIVE_CMP_B_TEXT = [
    '- Your spending in June 2026 was $15010.46.',
    '- Your spending in July 2026 was $12916.99.',
    '- The spending decreased by $2093.47 from June to July.',
    '- This represents a 13.95% decrease in spending from June to July.',
    '',
    'So, your spending dropped by 13.95% last month compared with the month before.',
  ].join('\n');
  const LIVE_TREND_D_TEXT = [
    '- Your spending has decreased over the last three months.',
    '- In June 1–24, 2026, spending was $13002.53.',
    '- In July 1–24, 2026, spending decreased to $11924.02.',
    '- In August 1–24, 2026, spending further decreased to $10374.82.',
    '- Overall, spending dropped by $2627.71, a 20.21% decrease from June to August.',
    '',
    'This shows a clear downward trend in your spending during this period.',
  ].join('\n');
  const LIVE_TREND_FROM_TO_TEXT = [
    '- Your spending has decreased over the last three months.',
    '- Specifically, spending dropped from $13002.53 in June 1–24 to $10374.82 in August 1–24.',
    '- This is a decrease of $2627.71, or about 20.21%.',
    '- The trend shows a consistent reduction in spending month over month during this period.',
    '',
    'Your spending is trending downward, indicating you are spending less each month.',
  ].join('\n');
  const LIVE_TREND_RANGE_TEXT = [
    '- From June 1 to June 24, 2026, you spent $13002.53.',
    '- From July 1 to July 24, 2026, you spent $11924.02.',
    '- From August 1 to August 24, 2026, you spent $10374.82.',
    '',
    'Your spending has decreased over these three periods.',
  ].join('\n');

  const liveCmpAExtracted = extractResponseClaims(LIVE_CMP_A_TEXT);
  const liveCmpA = validateResponseClaims({
    contract: comparisonC,
    extractedClaims: liveCmpAExtracted,
  });
  const pct1395 = liveCmpAExtracted.find((r) => r.kind === 'percent' && r.normalizedValue === 13.95);
  const pct14 = liveCmpAExtracted.find((r) => r.kind === 'percent' && r.normalizedValue === 14);
  const amt2093 = liveCmpAExtracted.find((r) => (
    r.kind === 'amount' || r.kind === 'entity_amount' || r.kind === 'entity_amount_date'
  ) && r.normalizedValue === 2093.47);
  check('live Case A INVALID', liveCmpA.status === VALIDATION_STATUS.INVALID);
  check('live Case A UNSUPPORTED_COMPARISON', hasCode(liveCmpA, VIOLATION_CODE.UNSUPPORTED_COMPARISON));
  check('live Case A extracted 14%', !!pct14);
  check('live Case A 14% is rejected', (liveCmpA.violations || []).some((v) => v.extractedClaimId === (pct14 && pct14.id)));
  check('live Case A exact 13.95 binds', !!pct1395
    && !(liveCmpA.violations || []).some((v) => v.extractedClaimId === pct1395.id));
  check('live Case A exact 2093.47 binds', !!amt2093
    && !(liveCmpA.violations || []).some((v) => v.extractedClaimId === amt2093.id));

  const exactPct = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending decreased 13.95%.',
  });
  check('exact 13.95% VALID', exactPct.status === VALIDATION_STATUS.VALID
    && (exactPct.violations || []).length === 0
    && (exactPct.indeterminate || []).length === 0);

  const nearly14 = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending decreased nearly 14%.',
  });
  check('nearly 14% INVALID', nearly14.status === VALIDATION_STATUS.INVALID
    && hasCode(nearly14, VIOLATION_CODE.UNSUPPORTED_COMPARISON));

  const exact14 = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending decreased 14%.',
  });
  check('exact unauthorized 14% INVALID', exact14.status === VALIDATION_STATUS.INVALID
    && hasCode(exact14, VIOLATION_CODE.UNSUPPORTED_COMPARISON));

  const liveCmpB = validateResponseAgainstContract({
    contract: comparisonC,
    text: LIVE_CMP_B_TEXT,
  });
  check('live Case B VALID', liveCmpB.status === VALIDATION_STATUS.VALID);
  check('live Case B 0 violations', (liveCmpB.violations || []).length === 0);
  check('live Case B 0 indeterminate', (liveCmpB.indeterminate || []).length === 0);

  const dirDecreased = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending decreased.',
  });
  check('direction synonym decreased VALID', dirDecreased.status === VALIDATION_STATUS.VALID);
  const dirLower = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending was lower.',
  });
  check('direction synonym lower VALID', dirLower.status === VALIDATION_STATUS.VALID);
  const dirDropped = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending dropped.',
  });
  check('direction synonym dropped VALID', dirDropped.status === VALIDATION_STATUS.VALID);
  const dirIncreased = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending increased.',
  });
  check('wrong direction increased not VALID', dirIncreased.status !== VALIDATION_STATUS.VALID);
  const dirHigher = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending was higher.',
  });
  check('wrong direction higher not VALID', dirHigher.status !== VALIDATION_STATUS.VALID);
  const dirRose = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending rose.',
  });
  check('wrong direction rose not VALID', dirRose.status !== VALIDATION_STATUS.VALID);

  const liveTrendLedger = buildTrendEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_trend'],
      facts: {
        accountScope: 'selected_account',
        windowKind: 'matched_elapsed',
        metricScope: 'spending',
        periods: [
          { label: 'June 1–24, 2026', start: '2026-06-01', end: '2026-06-24', spending: 13002.53 },
          { label: 'July 1–24, 2026', start: '2026-07-01', end: '2026-07-24', spending: 11924.02 },
          { label: 'August 1–24, 2026', start: '2026-08-01', end: '2026-08-24', spending: 10374.82 },
        ],
        trend: {
          spending: {
            direction: 'decreasing',
            firstToLast: { absolute: -2627.71, percent: -20.21, baselineZero: false },
          },
        },
        highest: { metric: 'spending', label: 'June 1–24, 2026', value: 13002.53 },
        lowest: { metric: 'spending', label: 'August 1–24, 2026', value: 10374.82 },
      },
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
  const liveTrendC = buildResponseValidationContract(liveTrendLedger).contract;
  const rangeTrendLedger = buildTrendEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_trend'],
      facts: {
        accountScope: 'selected_account',
        windowKind: 'matched_elapsed',
        metricScope: 'spending',
        periods: [
          { label: 'June 1–24, 2026', start: '2026-06-01', end: '2026-06-24', spending: 13002.53 },
          { label: 'July 1–24, 2026', start: '2026-07-01', end: '2026-07-24', spending: 11924.02 },
          { label: 'August 1–24, 2026', start: '2026-08-01', end: '2026-08-24', spending: 10374.82 },
        ],
        trend: {
          spending: {
            direction: 'decreasing',
            firstToLast: { absolute: -2627.71, percent: -20.21, baselineZero: false },
          },
        },
      },
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
  const rangeTrendC = buildResponseValidationContract(rangeTrendLedger).contract;

  const liveTrendD = validateResponseAgainstContract({
    contract: liveTrendC,
    text: LIVE_TREND_D_TEXT,
  });
  check('live Case D VALID', liveTrendD.status === VALIDATION_STATUS.VALID);
  check('live Case D 0 violations', (liveTrendD.violations || []).length === 0);
  check('live Case D 0 indeterminate', (liveTrendD.indeterminate || []).length === 0);

  const controlC = validateResponseAgainstContract({
    contract: liveTrendC,
    text: 'June: $13002.53. July: $11924.02. August: $10374.82.',
  });
  check('control each-of-last-3-months VALID', controlC.status === VALIDATION_STATUS.VALID
    && (controlC.violations || []).length === 0
    && (controlC.indeterminate || []).length === 0);

  const controlE = validateResponseAgainstContract({
    contract: liveTrendC,
    text: 'Spending dropped by $2627.71, a 20.21% decrease, showing a downward trend.',
  });
  check('control percent-over-last-3-months VALID', controlE.status === VALIDATION_STATUS.VALID
    && (controlE.violations || []).length === 0
    && (controlE.indeterminate || []).length === 0);

  const toJuly = validateResponseAgainstContract({
    contract: liveTrendC,
    text: 'July spending decreased to $11924.02.',
  });
  check('decreased to binds July period VALID', toJuly.status === VALIDATION_STATUS.VALID);
  const toAugust = validateResponseAgainstContract({
    contract: liveTrendC,
    text: 'August spending fell to $10374.82.',
  });
  check('fell to binds August period VALID', toAugust.status === VALIDATION_STATUS.VALID);

  const byDelta = validateResponseAgainstContract({
    contract: liveTrendC,
    text: 'Overall spending decreased by $2627.71.',
  });
  check('decreased by binds firstToLast VALID', byDelta.status === VALIDATION_STATUS.VALID);
  const droppedBy = validateResponseAgainstContract({
    contract: liveTrendC,
    text: 'Overall spending dropped by $2627.71.',
  });
  check('dropped by binds firstToLast VALID', droppedBy.status === VALIDATION_STATUS.VALID);

  const wrongPeriod = validateResponseAgainstContract({
    contract: liveTrendC,
    text: 'In July, spending was $10374.82.',
  });
  check('wrong period amount LIST_ITEM_MISMATCH', wrongPeriod.status === VALIDATION_STATUS.INVALID
    && hasCode(wrongPeriod, VIOLATION_CODE.LIST_ITEM_MISMATCH));

  const wrongTrendDelta = validateResponseAgainstContract({
    contract: liveTrendC,
    text: 'Overall spending dropped by $2628.71.',
  });
  check('wrong trend delta INVALID', wrongTrendDelta.status === VALIDATION_STATUS.INVALID);

  const wrongTrendPct = validateResponseAgainstContract({
    contract: liveTrendC,
    text: 'Overall spending dropped 21%.',
  });
  check('wrong trend percent INVALID', wrongTrendPct.status === VALIDATION_STATUS.INVALID);

  const deltaAsPeriod = validateResponseAgainstContract({
    contract: liveTrendC,
    text: 'In July, spending decreased to $2627.71.',
  });
  check('delta used as July period INVALID', deltaAsPeriod.status === VALIDATION_STATUS.INVALID);

  const periodAsDelta = validateResponseAgainstContract({
    contract: liveTrendC,
    text: 'Overall spending decreased by $11924.02.',
  });
  check('July period used as overall delta INVALID', periodAsDelta.status === VALIDATION_STATUS.INVALID);

  section('3C.2 trend from-to following-period goldens');
  const fromToSentence = 'Spending dropped from $13002.53 in June 1–24 to $10374.82 in August 1–24.';
  const fromToExtracted = extractResponseClaims(fromToSentence);
  const fromToJune = fromToExtracted.find((r) => (
    r.kind === 'amount' || r.kind === 'entity_amount' || r.kind === 'entity_amount_date'
  ) && r.normalizedValue === 13002.53);
  const fromToAugust = fromToExtracted.find((r) => (
    r.kind === 'amount' || r.kind === 'entity_amount' || r.kind === 'entity_amount_date'
  ) && r.normalizedValue === 10374.82);
  check('from-to first amount entity June', fromToJune && fromToJune.entity === 'June');
  check('from-to second amount entity August', fromToAugust && fromToAugust.entity === 'August');
  check('from-to second amount not June', fromToAugust && fromToAugust.entity !== 'June');
  const fromToValid = validateResponseClaims({
    contract: liveTrendC,
    extractedClaims: fromToExtracted,
  });
  check('from-to sentence VALID', fromToValid.status === VALIDATION_STATUS.VALID
    && (fromToValid.violations || []).length === 0
    && (fromToValid.indeterminate || []).length === 0);

  const prodFromToExtracted = extractResponseClaims(LIVE_TREND_FROM_TO_TEXT);
  const prodFromTo = validateResponseClaims({
    contract: liveTrendC,
    extractedClaims: prodFromToExtracted,
  });
  const prodFromJune = prodFromToExtracted.find((r) => (
    r.kind === 'amount' || r.kind === 'entity_amount' || r.kind === 'entity_amount_date'
  ) && r.normalizedValue === 13002.53);
  const prodToAugust = prodFromToExtracted.find((r) => (
    r.kind === 'amount' || r.kind === 'entity_amount' || r.kind === 'entity_amount_date'
  ) && r.normalizedValue === 10374.82);
  const prodDelta2627 = prodFromToExtracted.find((r) => (
    r.kind === 'amount' || r.kind === 'entity_amount' || r.kind === 'entity_amount_date'
  ) && r.normalizedValue === 2627.71);
  const prodPct2021 = prodFromToExtracted.find((r) => r.kind === 'percent' && r.normalizedValue === 20.21);
  check('exact production from-to VALID', prodFromTo.status === VALIDATION_STATUS.VALID);
  check('exact production from-to 0 violations', (prodFromTo.violations || []).length === 0);
  check('exact production from-to 0 indeterminate', (prodFromTo.indeterminate || []).length === 0);
  check('exact production from-to June amount binds', !!prodFromJune
    && !(prodFromTo.violations || []).some((v) => v.extractedClaimId === prodFromJune.id));
  check('exact production from-to August amount binds', !!prodToAugust
    && prodToAugust.entity === 'August'
    && !(prodFromTo.violations || []).some((v) => v.extractedClaimId === prodToAugust.id));
  check('exact production from-to delta binds', !!prodDelta2627
    && !(prodFromTo.violations || []).some((v) => v.extractedClaimId === prodDelta2627.id));
  check('exact production from-to 20.21 binds', !!prodPct2021
    && !(prodFromTo.violations || []).some((v) => v.extractedClaimId === prodPct2021.id));
  check('exact production from-to no LIST_ITEM_MISMATCH', !hasCode(prodFromTo, VIOLATION_CODE.LIST_ITEM_MISMATCH));

  const wrongSecondPeriod = validateResponseAgainstContract({
    contract: liveTrendC,
    text: 'Spending dropped from $13002.53 in June 1–24 to $10374.82 in June 1–24.',
  });
  check('wrong second period INVALID', wrongSecondPeriod.status === VALIDATION_STATUS.INVALID
    && hasCode(wrongSecondPeriod, VIOLATION_CODE.LIST_ITEM_MISMATCH));

  const wrongSecondAmount = validateResponseAgainstContract({
    contract: liveTrendC,
    text: 'Spending dropped from $13002.53 in June 1–24 to $11924.02 in August 1–24.',
  });
  check('wrong second amount INVALID', wrongSecondAmount.status === VALIDATION_STATUS.INVALID
    && hasCode(wrongSecondAmount, VIOLATION_CODE.LIST_ITEM_MISMATCH));

  const swappedFromTo = validateResponseAgainstContract({
    contract: liveTrendC,
    text: 'Spending dropped from $10374.82 in June 1–24 to $13002.53 in August 1–24.',
  });
  check('swapped from-to amounts INVALID', swappedFromTo.status === VALIDATION_STATUS.INVALID);

  const fromToCmpAbs = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'The absolute decrease in spending was $2093.47.',
  });
  check('comparison absolute-change regression VALID', fromToCmpAbs.status === VALIDATION_STATUS.VALID);
  const fromToCmpJune = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'In June, spending was $15010.46.',
  });
  check('comparison June spending was regression VALID', fromToCmpJune.status === VALIDATION_STATUS.VALID);
  const fromToCmpPct = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending decreased by 13.95%.',
  });
  check('comparison exact 13.95 regression VALID', fromToCmpPct.status === VALIDATION_STATUS.VALID);
  const fromToCmpNearly14 = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending decreased by nearly 14%.',
  });
  check('comparison nearly 14 regression INVALID', fromToCmpNearly14.status === VALIDATION_STATUS.INVALID
    && hasCode(fromToCmpNearly14, VIOLATION_CODE.UNSUPPORTED_COMPARISON));

  section('3C.2 recurring monthlyEquivalent goldens');
  const recurringLedger = buildRecurringEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_recurring'],
      facts: {
        metricScope: 'all',
        recurringDefinition: 'kea_scheduled_series',
        expenses: [
          { label: 'Daycare', amount: 705, monthlyEquivalent: 3055, nextDate: '2026-08-28', category: 'Child Care' },
          { label: 'Freedom Mortgage', amount: 2824.83, monthlyEquivalent: 2824.83, nextDate: '2026-09-01', category: 'Housing' },
          { label: 'Honda', amount: 934.65, monthlyEquivalent: 934.65, nextDate: '2026-08-25', category: 'Auto' },
          { label: 'Car Note', amount: 934, monthlyEquivalent: 934, nextDate: '2026-08-26', category: 'Auto' },
          { label: 'Weekly Gas', amount: 120, monthlyEquivalent: 520, nextDate: '2026-08-24', category: 'Gas' },
          { label: 'Mercury', amount: 229.50, monthlyEquivalent: 229.50, nextDate: '2026-08-27', category: 'Insurance' },
          { label: 'Cobb', amount: 203, monthlyEquivalent: 203, nextDate: '2026-09-02', category: 'Utilities' },
          { label: 'Northwestern Mutual', amount: 168.37, monthlyEquivalent: 168.37, nextDate: '2026-09-03', category: 'Insurance' },
          { label: 'Water', amount: 140.23, monthlyEquivalent: 140.23, nextDate: '2026-09-04', category: 'Utilities' },
          { label: 'Little Gym', amount: 119, monthlyEquivalent: 105, nextDate: '2026-08-26', category: 'Child Care' },
          { label: 'Mira', amount: 79.99, monthlyEquivalent: 79.99, nextDate: '2026-08-23', category: 'Services' },
          { label: 'Banfield', amount: 76.90, monthlyEquivalent: 76.90, nextDate: '2026-09-05', category: 'Pets' },
          { label: 'ADT', amount: 66.99, monthlyEquivalent: 66.99, nextDate: '2026-09-06', category: 'Home' },
          { label: 'Zelle', amount: 45, monthlyEquivalent: 45, nextDate: '2026-08-30', category: 'Transfers' },
        ],
        income: [
          {
            label: 'Paycheck',
            amount: 4626.37,
            monthlyEquivalent: 9252.74,
            nextDate: '2026-09-01',
            category: 'Income',
          },
        ],
        totals: {
          recurringExpenseMonthlyEquivalent: 9670.39,
          recurringIncomeMonthlyEquivalent: 9252.74,
        },
      },
      observations: [
        { code: 'largest_recurring_expense', label: 'Daycare', monthlyEquivalent: 3055 },
      ],
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
  const recurringC = buildResponseValidationContract(recurringLedger).contract;

  const weeklyGas = validateResponseAgainstContract({
    contract: recurringC,
    text: 'Weekly Gas is $120 weekly, with a monthly equivalent of $520.',
  });
  check('Weekly Gas amount and monthlyEquivalent VALID', weeklyGas.status === VALIDATION_STATUS.VALID);

  const weeklyGasWrong = validateResponseAgainstContract({
    contract: recurringC,
    text: 'Weekly Gas has a monthly equivalent of $521.',
  });
  check('Weekly Gas wrong monthlyEquivalent INVALID', weeklyGasWrong.status === VALIDATION_STATUS.INVALID);

  const daycareMonthly = validateResponseAgainstContract({
    contract: recurringC,
    text: 'Daycare has a monthly equivalent of $3055.',
  });
  check('Daycare monthlyEquivalent 3055 VALID', daycareMonthly.status === VALIDATION_STATUS.VALID);

  const recurringTotal = validateResponseAgainstContract({
    contract: recurringC,
    text: 'Recurring expense monthly equivalent totals $9670.39.',
  });
  check('recurring total 9670.39 VALID', recurringTotal.status === VALIDATION_STATUS.VALID);

  const recurringBroad = validateResponseAgainstContract({
    contract: recurringC,
    text: [
      'Daycare $705 monthly equivalent $3055.',
      'Freedom Mortgage $2824.83.',
      'Honda $934.65.',
      'Car Note $934.',
      'Weekly Gas $120 monthly equivalent $520.',
      'Mercury $229.50.',
      'Cobb $203.',
      'Northwestern Mutual $168.37.',
      'Water $140.23.',
      'Little Gym $119 and $105.',
      'Mira $79.99.',
      'Banfield $76.90.',
      'ADT $66.99.',
      'Zelle $45.',
      'Total monthly equivalent $9670.39.',
    ].join(' '),
  });
  check('recurring broad live-shape VALID', recurringBroad.status === VALIDATION_STATUS.VALID);

  const incomeControl = validateResponseAgainstContract({
    contract: recurringC,
    text: 'Next recurring income is $4626.37 on 2026-09-01, monthly equivalent $9252.74.',
  });
  check('recurring income amount and monthlyEquivalent VALID', incomeControl.status === VALIDATION_STATUS.VALID);

  const scheduledSource = validateResponseAgainstContract({
    contract: recurringC,
    text: 'These recurring expenses come from Keacast scheduled recurring items. Weekly Gas is $120.',
  });
  check('kea scheduled source wording still VALID', scheduledSource.status === VALIDATION_STATUS.VALID);

  section('3C.2 recurring same-item next-due goldens');
  const LIVE_CASE_F_TEXT = [
    'Your Main Account has the following recurring expenses scheduled:',
    '',
    '- Daycare: $705 weekly, equivalent to $3055 monthly, next due 2026-08-28',
    '- Mortgage: $2824.83 monthly, next due 2026-09-02',
    '- Car Note: $934 monthly, next due 2026-09-18',
    '- Weekly Gas: $120 weekly, equivalent to $520 monthly, next due 2026-08-24',
    '- Savings transfer: $400 monthly, next due 2026-09-15 (variable amount)',
    '- Mercury Insurance: $267.32 monthly, next due 2026-08-27',
    '- AT&T Utilities: $240 monthly, next due 2026-09-04',
    '- Aqua Tots Education: $238 monthly, next due 2026-10-01',
    '- Cobb EMC Power Bill: $230 monthly, next due 2026-10-09',
    '- Northwestern MU ISA Payment: $162.24 monthly, next due 2026-09-20',
    '- The Litt (Child Care): $119 monthly, next due 2026-09-04',
    '- The Litt (Child Care): $105 monthly, next due 2026-08-26',
    '- Mira Pest Control: $79.99 monthly, next due 2026-09-23',
    '- Water Bill: $70 monthly, next due 2026-09-01',
    '- ADT Services: $66.99 monthly, next due 2026-09-05',
    '',
    'The total monthly equivalent of these recurring expenses is approximately $9741.54.',
  ].join('\n');
  const caseFLedger = buildRecurringEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_recurring'],
      facts: {
        metricScope: 'expense',
        recurringDefinition: 'kea_scheduled_series',
        expenses: [
          { label: 'Daycare', amount: 705, monthlyEquivalent: 3055, nextDate: '2026-08-28', category: 'Child Care' },
          { label: 'Mortgage', amount: 2824.83, monthlyEquivalent: 2824.83, nextDate: '2026-09-02', category: 'Housing' },
          { label: 'Car Note', amount: 934, monthlyEquivalent: 934, nextDate: '2026-09-18', category: 'Auto' },
          { label: 'Weekly Gas', amount: 120, monthlyEquivalent: 520, nextDate: '2026-08-24', category: 'Gas' },
          { label: 'Savings transfer', amount: 400, monthlyEquivalent: 400, nextDate: '2026-09-15', category: 'Transfers' },
          { label: 'Mercury Insurance', amount: 267.32, monthlyEquivalent: 267.32, nextDate: '2026-08-27', category: 'Insurance' },
          { label: 'AT&T Utilities', amount: 240, monthlyEquivalent: 240, nextDate: '2026-09-04', category: 'Utilities' },
          { label: 'Aqua Tots Education', amount: 238, monthlyEquivalent: 238, nextDate: '2026-10-01', category: 'Education' },
          { label: 'Cobb EMC Power Bill', amount: 230, monthlyEquivalent: 230, nextDate: '2026-10-09', category: 'Utilities' },
          { label: 'Northwestern MU ISA Payment', amount: 162.24, monthlyEquivalent: 162.24, nextDate: '2026-09-20', category: 'Insurance' },
          { label: 'The Litt (Child Care)', amount: 119, monthlyEquivalent: 119, nextDate: '2026-09-04', category: 'Child Care' },
          { label: 'The Litt (Child Care)', amount: 105, monthlyEquivalent: 105, nextDate: '2026-08-26', category: 'Child Care' },
          { label: 'Mira Pest Control', amount: 79.99, monthlyEquivalent: 79.99, nextDate: '2026-09-23', category: 'Services' },
          { label: 'Water Bill', amount: 70, monthlyEquivalent: 70, nextDate: '2026-09-01', category: 'Utilities' },
          { label: 'ADT Services', amount: 66.99, monthlyEquivalent: 66.99, nextDate: '2026-09-05', category: 'Home' },
        ],
        totals: { recurringExpenseMonthlyEquivalent: 9741.54 },
      },
      observations: [],
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Main Account' },
  }).ledger;
  const caseFC = buildResponseValidationContract(caseFLedger).contract;

  const caseF = validateResponseAgainstContract({ contract: caseFC, text: LIVE_CASE_F_TEXT });
  check('Case F rich next-due VALID', caseF.status === VALIDATION_STATUS.VALID);
  check('Case F 0 violations', (caseF.violations || []).length === 0);
  check('Case F 0 indeterminate', (caseF.indeterminate || []).length === 0);

  const wrongMortgageDate = validateResponseAgainstContract({
    contract: caseFC,
    text: 'Mortgage: $2824.83 monthly, next due 2026-08-28',
  });
  check('wrong recurring next date INVALID', wrongMortgageDate.status === VALIDATION_STATUS.INVALID
    && hasCode(wrongMortgageDate, VIOLATION_CODE.LIST_ITEM_MISMATCH));

  const crossItemDate = validateResponseAgainstContract({
    contract: caseFC,
    text: 'Mortgage: $2824.83 monthly, next due 2026-08-28',
  });
  check('cross-item Daycare date on Mortgage INVALID', crossItemDate.status === VALIDATION_STATUS.INVALID
    && hasCode(crossItemDate, VIOLATION_CODE.LIST_ITEM_MISMATCH));

  const monthlyAsOccurrenceOther = validateResponseAgainstContract({
    contract: caseFC,
    text: 'Car Note: $520 weekly, next due 2026-09-18',
  });
  check('monthlyEquivalent cannot replace another item occurrence', monthlyAsOccurrenceOther.status === VALIDATION_STATUS.INVALID);

  const weeklyEqSameStream = validateResponseAgainstContract({
    contract: caseFC,
    text: 'Weekly Gas: $120 weekly, equivalent to $520 monthly, next due 2026-08-24',
  });
  check('Weekly Gas occurrence and monthlyEquivalent next-due VALID', weeklyEqSameStream.status === VALIDATION_STATUS.VALID);

  const littIsolation = validateResponseAgainstContract({
    contract: caseFC,
    text: [
      '- The Litt (Child Care): $119 monthly, next due 2026-09-04',
      '- The Litt (Child Care): $105 monthly, next due 2026-08-26',
    ].join('\n'),
  });
  check('duplicate The Litt dates stay isolated VALID', littIsolation.status === VALIDATION_STATUS.VALID
    && (littIsolation.violations || []).length === 0);

  const littCross = validateResponseAgainstContract({
    contract: caseFC,
    text: '- The Litt (Child Care): $119 monthly, next due 2026-08-26',
  });
  check('The Litt $119 cannot take $105 date', littCross.status === VALIDATION_STATUS.INVALID
    && hasCode(littCross, VIOLATION_CODE.LIST_ITEM_MISMATCH));

  const upcomingOnDate = validateResponseAgainstContract({
    contract: liveE,
    text: 'Weekly Gas: $120 on August 24',
  });
  check('upcoming $X on DATE VALID', upcomingOnDate.status === VALIDATION_STATUS.VALID);
  const upcomingBareOn = validateResponseAgainstContract({
    contract: liveE,
    text: '$120 on August 24',
  });
  check('upcoming bare $X on DATE VALID', upcomingBareOn.status === VALIDATION_STATUS.VALID);
  const upcomingPrecedingDate = validateResponseAgainstContract({
    contract: liveE,
    text: 'August 24: $120',
  });
  check('upcoming DATE: $X VALID', upcomingPrecedingDate.status === VALIDATION_STATUS.VALID);

  section('3C.2 trend range-before-amount start date');
  function rangeAmount(rows, value) {
    return rows.find((r) => (
      r.kind === 'amount' || r.kind === 'entity_amount' || r.kind === 'entity_amount_date'
    ) && r.normalizedValue === value);
  }
  function rangePeriod(contract, iso) {
    const rows = (contract.allowedListItems && contract.allowedListItems.periods) || [];
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].date === iso) return rows[i];
    }
    return null;
  }
  function rangeClean(result, row) {
    return !!row && !(result.violations || []).some((v) => v.extractedClaimId === row.id);
  }
  check('rangeTrendC has no highest/lowest scalar claims',
    !(rangeTrendC.allowedClaims || []).some((c) => (
      c.path === 'facts.highest.value' || c.path === 'facts.lowest.value'
    )));

  const rangeProdExtracted = extractResponseClaims(LIVE_TREND_RANGE_TEXT);
  const rangeProd = validateResponseClaims({
    contract: rangeTrendC,
    extractedClaims: rangeProdExtracted,
  });
  const rangeJuneAmt = rangeAmount(rangeProdExtracted, 13002.53);
  const rangeJulyAmt = rangeAmount(rangeProdExtracted, 11924.02);
  const rangeAugustAmt = rangeAmount(rangeProdExtracted, 10374.82);
  const junePeriod = rangePeriod(rangeTrendC, '2026-06-01');
  const julyPeriod = rangePeriod(rangeTrendC, '2026-07-01');
  const augustPeriod = rangePeriod(rangeTrendC, '2026-08-01');
  check('exact production range-before-amount VALID', rangeProd.status === VALIDATION_STATUS.VALID);
  check('exact production range-before-amount 0 violations', (rangeProd.violations || []).length === 0);
  check('exact production range-before-amount 0 indeterminate', (rangeProd.indeterminate || []).length === 0);
  check('production June extracted date is June 1', rangeJuneAmt
    && rangeJuneAmt.entity === 'June'
    && rangeJuneAmt.dateMonth === 6
    && rangeJuneAmt.dateDay === 1);
  check('production June date is not June 24', rangeJuneAmt && rangeJuneAmt.dateDay !== 24);
  check('production June binds June period tuple', rangeClean(rangeProd, rangeJuneAmt)
    && junePeriod
    && junePeriod.amount === 13002.53
    && junePeriod.date === '2026-06-01');
  check('production July extracted date is July 1', rangeJulyAmt
    && rangeJulyAmt.entity === 'July'
    && rangeJulyAmt.dateMonth === 7
    && rangeJulyAmt.dateDay === 1);
  check('production July date is not July 24', rangeJulyAmt && rangeJulyAmt.dateDay !== 24);
  check('production July binds July period tuple', rangeClean(rangeProd, rangeJulyAmt)
    && julyPeriod
    && julyPeriod.amount === 11924.02
    && julyPeriod.date === '2026-07-01');
  check('production August extracted date is August 1', rangeAugustAmt
    && rangeAugustAmt.entity === 'August'
    && rangeAugustAmt.dateMonth === 8
    && rangeAugustAmt.dateDay === 1);
  check('production August date is not August 24', rangeAugustAmt && rangeAugustAmt.dateDay !== 24);
  check('production August binds August period tuple', rangeClean(rangeProd, rangeAugustAmt)
    && augustPeriod
    && augustPeriod.amount === 10374.82
    && augustPeriod.date === '2026-08-01');
  check('production range-before-amount no LIST_ITEM_MISMATCH',
    !hasCode(rangeProd, VIOLATION_CODE.LIST_ITEM_MISMATCH));

  const juneIsoText = 'From June 1 to June 24, 2026, you spent $13002.53.';
  const juneIsoExtracted = extractResponseClaims(juneIsoText);
  const juneIso = validateResponseClaims({
    contract: rangeTrendC,
    extractedClaims: juneIsoExtracted,
  });
  const juneIsoAmt = rangeAmount(juneIsoExtracted, 13002.53);
  check('isolated June range-before-amount VALID', juneIso.status === VALIDATION_STATUS.VALID
    && (juneIso.violations || []).length === 0
    && (juneIso.indeterminate || []).length === 0);
  check('isolated June amount date is June 1', juneIsoAmt
    && juneIsoAmt.dateMonth === 6
    && juneIsoAmt.dateDay === 1);
  check('isolated June binds June period identity', rangeClean(juneIso, juneIsoAmt)
    && junePeriod && junePeriod.date === '2026-06-01');

  const julyIsoText = 'From July 1 to July 24, 2026, you spent $11924.02.';
  const julyIsoExtracted = extractResponseClaims(julyIsoText);
  const julyIso = validateResponseClaims({
    contract: rangeTrendC,
    extractedClaims: julyIsoExtracted,
  });
  const julyIsoAmt = rangeAmount(julyIsoExtracted, 11924.02);
  check('isolated July range-before-amount VALID', julyIso.status === VALIDATION_STATUS.VALID
    && (julyIso.violations || []).length === 0
    && (julyIso.indeterminate || []).length === 0);
  check('isolated July amount date is July 1', julyIsoAmt
    && julyIsoAmt.dateMonth === 7
    && julyIsoAmt.dateDay === 1);
  check('isolated July binds July period identity', rangeClean(julyIso, julyIsoAmt)
    && julyPeriod && julyPeriod.date === '2026-07-01');

  const augustIsoText = 'From August 1 to August 24, 2026, you spent $10374.82.';
  const augustIsoExtracted = extractResponseClaims(augustIsoText);
  const augustIso = validateResponseClaims({
    contract: rangeTrendC,
    extractedClaims: augustIsoExtracted,
  });
  const augustIsoAmt = rangeAmount(augustIsoExtracted, 10374.82);
  check('isolated August range-before-amount VALID', augustIso.status === VALIDATION_STATUS.VALID
    && (augustIso.violations || []).length === 0
    && (augustIso.indeterminate || []).length === 0);
  check('isolated August amount date is August 1', augustIsoAmt
    && augustIsoAmt.dateMonth === 8
    && augustIsoAmt.dateDay === 1);
  check('isolated August binds August period identity', rangeClean(augustIso, augustIsoAmt)
    && augustPeriod && augustPeriod.date === '2026-08-01');

  const compactRangeText = [
    '- June 1–24, 2026: $13002.53',
    '- July 1–24, 2026: $11924.02',
    '- August 1–24, 2026: $10374.82',
  ].join('\n');
  const compactRange = validateResponseAgainstContract({
    contract: rangeTrendC,
    text: compactRangeText,
  });
  check('compact June 1–24 VALID', compactRange.status === VALIDATION_STATUS.VALID);
  check('compact July 1–24 VALID', compactRange.status === VALIDATION_STATUS.VALID);
  check('compact August 1–24 VALID', compactRange.status === VALIDATION_STATUS.VALID
    && (compactRange.violations || []).length === 0
    && (compactRange.indeterminate || []).length === 0);

  const fromToRangeReg = validateResponseAgainstContract({
    contract: liveTrendC,
    text: LIVE_TREND_FROM_TO_TEXT,
  });
  check('previous from-to trend remains VALID', fromToRangeReg.status === VALIDATION_STATUS.VALID
    && (fromToRangeReg.violations || []).length === 0
    && (fromToRangeReg.indeterminate || []).length === 0);

  const caseDRangeReg = validateResponseAgainstContract({
    contract: liveTrendC,
    text: LIVE_TREND_D_TEXT,
  });
  check('Case D decreased-to/decreased-by remains VALID', caseDRangeReg.status === VALIDATION_STATUS.VALID
    && (caseDRangeReg.violations || []).length === 0
    && (caseDRangeReg.indeterminate || []).length === 0);

  const wrongRangeMonth = validateResponseAgainstContract({
    contract: rangeTrendC,
    text: 'From June 1 to June 24, 2026, you spent $11924.02.',
  });
  check('wrong range month INVALID', wrongRangeMonth.status === VALIDATION_STATUS.INVALID
    && hasCode(wrongRangeMonth, VIOLATION_CODE.LIST_ITEM_MISMATCH));

  const wrongRangeAmount = validateResponseAgainstContract({
    contract: rangeTrendC,
    text: 'From July 1 to July 24, 2026, you spent $10374.82.',
  });
  check('wrong amount for range INVALID', wrongRangeAmount.status === VALIDATION_STATUS.INVALID
    && hasCode(wrongRangeAmount, VIOLATION_CODE.LIST_ITEM_MISMATCH));

  const wrongRangeCents = validateResponseAgainstContract({
    contract: rangeTrendC,
    text: 'From July 1 to July 24, 2026, you spent $11925.02.',
  });
  check('wrong cents INVALID', wrongRangeCents.status === VALIDATION_STATUS.INVALID);

  const explicitJuly24 = validateResponseAgainstContract({
    contract: rangeTrendC,
    text: 'On July 24, spending was $11924.02.',
  });
  check('explicit July 24 outside range INVALID', explicitJuly24.status === VALIDATION_STATUS.INVALID
    && hasCode(explicitJuly24, VIOLATION_CODE.LIST_ITEM_MISMATCH));

  const reversedRangeVal = validateResponseAgainstContract({
    contract: rangeTrendC,
    text: 'From July 24 to July 1, 2026, you spent $11924.02.',
  });
  check('malformed reversed range not authorized', reversedRangeVal.status === VALIDATION_STATUS.INVALID);

  const rangeUpcomingOn = validateResponseAgainstContract({
    contract: liveE,
    text: '$120 on August 24',
  });
  check('range-before upcoming $X on DATE regression VALID', rangeUpcomingOn.status === VALIDATION_STATUS.VALID);
  const rangeUpcomingColon = validateResponseAgainstContract({
    contract: liveE,
    text: 'August 24: $120',
  });
  check('range-before upcoming DATE: $X regression VALID', rangeUpcomingColon.status === VALIDATION_STATUS.VALID);

  const rangeRecurring = validateResponseAgainstContract({
    contract: caseFC,
    text: LIVE_CASE_F_TEXT,
  });
  check('range-before recurring Case F remains VALID', rangeRecurring.status === VALIDATION_STATUS.VALID
    && (rangeRecurring.violations || []).length === 0
    && (rangeRecurring.indeterminate || []).length === 0);

  const rangeCmpAbs = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'The spending decreased by $2093.47.',
  });
  check('range-before comparison absolute-change VALID', rangeCmpAbs.status === VALIDATION_STATUS.VALID);
  const rangeCmpNearly14 = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending decreased by nearly 14%.',
  });
  check('range-before comparison 14% negative INVALID', rangeCmpNearly14.status === VALIDATION_STATUS.INVALID
    && hasCode(rangeCmpNearly14, VIOLATION_CODE.UNSUPPORTED_COMPARISON));

  const rangeBalance = validateResponseAgainstContract({
    contract: snapC,
    text: 'Your available balance is $4846.97.',
  });
  check('range-before available-balance regression VALID', rangeBalance.status === VALIDATION_STATUS.VALID);
  const rangeTarget = validateResponseAgainstContract({
    contract: lookupC,
    text: 'You spent $279.58 at Target.',
  });
  check('range-before Target exact regression VALID', rangeTarget.status === VALIDATION_STATUS.VALID);
  const rangeTargetWrong = validateResponseAgainstContract({
    contract: lookupC,
    text: 'You spent $280 at Target.',
  });
  check('range-before Target wrong-value INVALID', rangeTargetWrong.status === VALIDATION_STATUS.INVALID);
  const rangeForecast = validateResponseAgainstContract({
    contract: snapC,
    text: LIVE_C_TEXT,
  });
  check('range-before forecast unsupported-derivation remains INVALID', rangeForecast.status === VALIDATION_STATUS.INVALID
    && (hasCode(rangeForecast, VIOLATION_CODE.UNSUPPORTED_DERIVATION)
      || hasCode(rangeForecast, VIOLATION_CODE.UNSUPPORTED_FORECAST)));

  const trendToReg = validateResponseAgainstContract({
    contract: liveTrendC,
    text: 'In July 1–24, 2026, spending decreased to $11924.02.',
  });
  check('trend decreased to regression VALID', trendToReg.status === VALIDATION_STATUS.VALID);
  const trendByReg = validateResponseAgainstContract({
    contract: liveTrendC,
    text: 'Overall spending dropped by $2627.71.',
  });
  check('trend decreased by regression VALID', trendByReg.status === VALIDATION_STATUS.VALID);

  const cmpPctReg = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Your spending in July 2026 decreased by 13.95% compared to June 2026.',
  });
  check('compact exact 13.95% comparison VALID', cmpPctReg.status === VALIDATION_STATUS.VALID
    && (cmpPctReg.violations || []).length === 0
    && (cmpPctReg.indeterminate || []).length === 0);
  const nearly14Reg = validateResponseAgainstContract({
    contract: comparisonC,
    text: 'Spending decreased nearly 14%.',
  });
  check('nearly 14% still INVALID', nearly14Reg.status === VALIDATION_STATUS.INVALID
    && hasCode(nearly14Reg, VIOLATION_CODE.UNSUPPORTED_COMPARISON));

  const horizonLedger = buildIncomeHorizonEvidenceLedger({
    evidence: {
      status: 'ok',
      source: ['cashflow_income_horizon'],
      facts: {
        incomeHorizonDefinition: 'kea_scheduled_recurring_income',
        nextIncome: [{ label: 'Direct Deposit', date: '2026-08-31', amount: 4626.36 }],
        combinedScheduledIncomeAmount: 4626.36,
      },
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
  const horizonC = buildResponseValidationContract(horizonLedger).contract;
  const horizonOk = validateResponseAgainstContract({
    contract: horizonC,
    text: 'Your next scheduled income is $4626.36 on 2026-08-31.',
  });
  check('income horizon next income VALID', horizonOk.status === VALIDATION_STATUS.VALID);

  section('3C.2 comparison / trend / recurring performance');
  const tCmp = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    extractResponseClaims('Spending decreased by $2093.47, or 13.95%.');
    validateResponseAgainstContract({
      contract: comparisonC,
      text: 'In July 2026, spending was $12916.99, compared with $15010.46 in June 2026. Spending decreased by $2093.47, or 13.95%.',
    });
  }
  const cmpMs = Number(process.hrtime.bigint() - tCmp) / 1e6;
  console.log(`  1000 comparison extract+validate: ${cmpMs.toFixed(2)}ms total, ${(cmpMs / 1000).toFixed(3)}ms avg`);

  const tTr = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    extractResponseClaims('June: $12815.73. July: $11784.96. August: $10380.54. Spending decreased by $2435.19, or 19%.');
    validateResponseAgainstContract({
      contract: trendC,
      text: 'June: $12815.73. July: $11784.96. August: $10380.54. Spending decreased by $2435.19, or 19%.',
    });
  }
  const trMs = Number(process.hrtime.bigint() - tTr) / 1e6;
  console.log(`  1000 trend extract+validate: ${trMs.toFixed(2)}ms total, ${(trMs / 1000).toFixed(3)}ms avg`);

  const tRec = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    extractResponseClaims('Weekly Gas is $120 weekly, with a monthly equivalent of $520. Total $9670.39.');
    validateResponseAgainstContract({
      contract: recurringC,
      text: 'Weekly Gas is $120 weekly, with a monthly equivalent of $520. Total $9670.39.',
    });
  }
  const recMs = Number(process.hrtime.bigint() - tRec) / 1e6;
  console.log(`  1000 recurring extract+validate: ${recMs.toFixed(2)}ms total, ${(recMs / 1000).toFixed(3)}ms avg`);
  check('3C.2 1000-run benchmarks completed', Number.isFinite(cmpMs) && Number.isFinite(trMs) && Number.isFinite(recMs));

  const tCaseF = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    extractResponseClaims(LIVE_CASE_F_TEXT);
    validateResponseAgainstContract({ contract: caseFC, text: LIVE_CASE_F_TEXT });
  }
  const caseFMs = Number(process.hrtime.bigint() - tCaseF) / 1e6;
  console.log(`  1000 Case F extract+validate: ${caseFMs.toFixed(2)}ms total, ${(caseFMs / 1000).toFixed(3)}ms avg`);

  const tUpcoming = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    extractResponseClaims(LIVE_E_TEXT);
    validateResponseAgainstContract({ contract: liveE, text: LIVE_E_TEXT });
  }
  const upcomingMs = Number(process.hrtime.bigint() - tUpcoming) / 1e6;
  console.log(`  1000 upcoming-list extract+validate: ${upcomingMs.toFixed(2)}ms total, ${(upcomingMs / 1000).toFixed(3)}ms avg`);
  check('Case F / upcoming 1000-run benchmarks completed', Number.isFinite(caseFMs) && Number.isFinite(upcomingMs));

  const tLiveA = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    extractResponseClaims(LIVE_CMP_A_TEXT);
    validateResponseAgainstContract({ contract: comparisonC, text: LIVE_CMP_A_TEXT });
  }
  const liveCmpAMs = Number(process.hrtime.bigint() - tLiveA) / 1e6;
  console.log(`  1000 Case A extract+validate: ${liveCmpAMs.toFixed(2)}ms total, ${(liveCmpAMs / 1000).toFixed(3)}ms avg`);

  const tLiveB = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    extractResponseClaims(LIVE_CMP_B_TEXT);
    validateResponseAgainstContract({ contract: comparisonC, text: LIVE_CMP_B_TEXT });
  }
  const liveCmpBMs = Number(process.hrtime.bigint() - tLiveB) / 1e6;
  console.log(`  1000 Case B extract+validate: ${liveCmpBMs.toFixed(2)}ms total, ${(liveCmpBMs / 1000).toFixed(3)}ms avg`);

  const tLiveD = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    extractResponseClaims(LIVE_TREND_D_TEXT);
    validateResponseAgainstContract({ contract: liveTrendC, text: LIVE_TREND_D_TEXT });
  }
  const liveTrendDMs = Number(process.hrtime.bigint() - tLiveD) / 1e6;
  console.log(`  1000 Case D extract+validate: ${liveTrendDMs.toFixed(2)}ms total, ${(liveTrendDMs / 1000).toFixed(3)}ms avg`);
  check('Case A/B/D 1000-run benchmarks completed', Number.isFinite(liveCmpAMs)
    && Number.isFinite(liveCmpBMs)
    && Number.isFinite(liveTrendDMs));

  const tProdCmp = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    extractResponseClaims(PROD_CMP_TEXT);
    validateResponseAgainstContract({ contract: comparisonC, text: PROD_CMP_TEXT });
  }
  const prodCmpMs = Number(process.hrtime.bigint() - tProdCmp) / 1e6;
  console.log(`  1000 exact production comparison extract+validate: ${prodCmpMs.toFixed(2)}ms total, ${(prodCmpMs / 1000).toFixed(3)}ms avg`);

  const tProdCmpNo14 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    extractResponseClaims(PROD_CMP_NO_14_TEXT);
    validateResponseAgainstContract({ contract: comparisonC, text: PROD_CMP_NO_14_TEXT });
  }
  const prodCmpNo14Ms = Number(process.hrtime.bigint() - tProdCmpNo14) / 1e6;
  console.log(`  1000 no-14 comparison extract+validate: ${prodCmpNo14Ms.toFixed(2)}ms total, ${(prodCmpNo14Ms / 1000).toFixed(3)}ms avg`);
  check('production comparison 1000-run benchmarks completed', Number.isFinite(prodCmpMs)
    && Number.isFinite(prodCmpNo14Ms));

  const tProdTrend = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    extractResponseClaims(LIVE_TREND_FROM_TO_TEXT);
    validateResponseAgainstContract({ contract: liveTrendC, text: LIVE_TREND_FROM_TO_TEXT });
  }
  const prodTrendMs = Number(process.hrtime.bigint() - tProdTrend) / 1e6;
  console.log(`  1000 exact production trend extract+validate: ${prodTrendMs.toFixed(2)}ms total, ${(prodTrendMs / 1000).toFixed(3)}ms avg`);

  const tCaseDBench = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    extractResponseClaims(LIVE_TREND_D_TEXT);
    validateResponseAgainstContract({ contract: liveTrendC, text: LIVE_TREND_D_TEXT });
  }
  const caseDBenchMs = Number(process.hrtime.bigint() - tCaseDBench) / 1e6;
  console.log(`  1000 Case D trend extract+validate: ${caseDBenchMs.toFixed(2)}ms total, ${(caseDBenchMs / 1000).toFixed(3)}ms avg`);

  const upcomingControlText = '$120 on August 24';
  const tUpcomingOn = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    extractResponseClaims(upcomingControlText);
    validateResponseAgainstContract({ contract: liveE, text: upcomingControlText });
  }
  const upcomingOnMs = Number(process.hrtime.bigint() - tUpcomingOn) / 1e6;
  console.log(`  1000 upcoming $X on DATE extract+validate: ${upcomingOnMs.toFixed(2)}ms total, ${(upcomingOnMs / 1000).toFixed(3)}ms avg`);

  const tRangeBefore = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    extractResponseClaims(LIVE_TREND_RANGE_TEXT);
    validateResponseAgainstContract({ contract: rangeTrendC, text: LIVE_TREND_RANGE_TEXT });
  }
  const rangeBeforeMs = Number(process.hrtime.bigint() - tRangeBefore) / 1e6;
  console.log(`  1000 exact production range-before-amount extract+validate: ${rangeBeforeMs.toFixed(2)}ms total, ${(rangeBeforeMs / 1000).toFixed(3)}ms avg`);
  check('production trend / Case D / upcoming / range-before 1000-run benchmarks completed', Number.isFinite(prodTrendMs)
    && Number.isFinite(caseDBenchMs)
    && Number.isFinite(upcomingOnMs)
    && Number.isFinite(rangeBeforeMs));

  section('3C.1 validator performance 1000 runs');
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    validateResponseAgainstContract({ contract: snapC, text: LIVE_C_TEXT });
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  1000 validations: ${ms.toFixed(2)}ms total, ${(ms / 1000).toFixed(3)}ms avg`);
  check('1000 validations completed', Number.isFinite(ms) && ms >= 0);

  section('3C.2 live-A / live-E performance');
  const liveALedger = buildLiveASnapshot();
  const tBuild = process.hrtime.bigint();
  const liveABuilt = buildResponseValidationContract(liveALedger);
  const liveABuildMs = Number(process.hrtime.bigint() - tBuild) / 1e6;
  console.log(`  live-A contract build: ${liveABuildMs.toFixed(3)}ms`);

  const tExtract = process.hrtime.bigint();
  const liveAExtracted = extractResponseClaims(LIVE_A_TEXT);
  const liveAExtractMs = Number(process.hrtime.bigint() - tExtract) / 1e6;
  console.log(`  live-A extraction: ${liveAExtractMs.toFixed(3)}ms`);

  const tVal = process.hrtime.bigint();
  const liveAValidated = validateResponseClaims({
    contract: liveABuilt.contract,
    extractedClaims: liveAExtracted,
  });
  const liveAValMs = Number(process.hrtime.bigint() - tVal) / 1e6;
  console.log(`  live-A validation: ${liveAValMs.toFixed(3)}ms`);

  const tSum = process.hrtime.bigint();
  summarizeValidationResult(liveAValidated);
  const liveASumMs = Number(process.hrtime.bigint() - tSum) / 1e6;
  console.log(`  live-A summary: ${liveASumMs.toFixed(3)}ms`);

  const tE = process.hrtime.bigint();
  validateResponseAgainstContract({ contract: liveE, text: LIVE_E_TEXT });
  const liveEValMs = Number(process.hrtime.bigint() - tE) / 1e6;
  console.log(`  live-E validation: ${liveEValMs.toFixed(3)}ms`);

  const t1000 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    validateResponseAgainstContract({ contract: liveA, text: LIVE_A_TEXT });
  }
  const liveA1000Ms = Number(process.hrtime.bigint() - t1000) / 1e6;
  console.log(`  1000 live-A validations: ${liveA1000Ms.toFixed(2)}ms total, ${(liveA1000Ms / 1000).toFixed(3)}ms avg`);
  check('live-A/E performance measured', Number.isFinite(liveABuildMs)
    && Number.isFinite(liveAExtractMs)
    && Number.isFinite(liveAValMs)
    && Number.isFinite(liveASumMs)
    && Number.isFinite(liveEValMs)
    && Number.isFinite(liveA1000Ms));
}

module.exports = {
  run,
  buildLiveEMacro,
  buildLiveASnapshot,
  LIVE_E_TEXT,
  LIVE_A_TEXT,
};
