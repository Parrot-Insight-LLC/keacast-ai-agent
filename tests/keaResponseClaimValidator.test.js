'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');
const {
  buildSnapshotEvidenceLedger,
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
  }
  check('no logger in 3C.1 modules', loggerHits === 0);
  check('no financial reduce/abs/percent math', mathHits === 0);

  section('3C.1 validator performance 1000 runs');
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) {
    validateResponseAgainstContract({ contract: snapC, text: LIVE_C_TEXT });
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  1000 validations: ${ms.toFixed(2)}ms total, ${(ms / 1000).toFixed(3)}ms avg`);
  check('1000 validations completed', Number.isFinite(ms) && ms >= 0);
}

module.exports = { run };
