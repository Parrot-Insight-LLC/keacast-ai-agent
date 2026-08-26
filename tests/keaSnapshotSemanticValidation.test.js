'use strict';

const { check, section } = require('./harness');
const {
  buildSnapshotEvidenceLedger,
  buildComparisonEvidenceLedger,
} = require('../services/keaEvidenceLedgerBuilders');
const {
  VALIDATION_STATUS,
  SEVERITY,
  VIOLATION_CODE,
  LIST_COVERAGE,
  buildResponseValidationContract,
} = require('../services/keaResponseValidationContract');
const { validateResponseAgainstContract } = require('../services/keaResponseClaimValidator');
const {
  SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY,
  SNAPSHOT_COVERAGE_VALIDATION_ENV_KEY,
  SNAPSHOT_SEMANTIC_REASON,
  isSnapshotSemanticValidationEnabled,
  isSnapshotCoverageValidationEnabled,
  tupleFromClaim,
} = require('../services/keaSnapshotSemanticValidation');
const {
  RESPONSE_VALIDATION_ENFORCEMENT_ENV_KEY,
  ENFORCEMENT_REASON,
  evaluateResponseEnforcement,
} = require('../services/keaResponseValidationEnforcement');
const {
  applyShadowResponseValidation,
} = require('../services/keaResponseValidationShadow');
const {
  buildSnapshot,
  buildLookup,
  buildUpcomingMacro,
} = require('./keaResponseValidationContract.test');

const SNAPSHOT_NEGATIVE_MINIMUM_COVERAGE_RESIDUAL = 'OPEN';

function withFlag(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

function withShadow(value, fn) {
  return withFlag(SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY, value, fn);
}

function withCoverage(value, fn) {
  return withFlag(SNAPSHOT_COVERAGE_VALIDATION_ENV_KEY, value, fn);
}

function codes(result) {
  return (result.violations || []).map((v) => v.code);
}

function hasCode(result, code) {
  return codes(result).indexOf(code) !== -1;
}

function semanticHit(result, reason) {
  return (result.violations || []).some((v) => v.code === VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH
    && (reason == null || v.reasonCode === reason)
    && v.severity === SEVERITY.HIGH);
}

function contractOf(ledger) {
  return buildResponseValidationContract(ledger).contract;
}

function buildFactsLedger(facts, period) {
  return buildSnapshotEvidenceLedger({
    capability: 'financial_forecast',
    evidence: {
      status: 'ok',
      source: ['kea_snapshot'],
      facts: Object.assign({ upcomingWindowDays: 15 }, facts),
      period: period || { start: '2026-08-01', end: '2026-08-31', label: 'August 2026' },
      limitations: ['upcoming_window_15d'],
    },
    accountContext: { accountId: '10', accountLabel: 'Main Account' },
  }).ledger;
}

function roleLedger() {
  return buildFactsLedger({
    availableBalance: 100,
    currentBalance: 200,
    reconciledBalance: 300,
    monthExpenses: 400,
    monthIncome: 500,
    monthNet: 100,
    upcomingExpenseTotal: 600,
    upcomingIncomeTotal: 700,
    futureNegativeBalances: [{ amount: -80, date: '2026-11-08', daysUntil: 84 }],
  });
}

function sameCentsLedger() {
  return buildFactsLedger({
    availableBalance: 100,
    currentBalance: 100,
    upcomingExpenseTotal: 100,
    upcomingIncomeTotal: 100,
  });
}

function collisionLedger() {
  return buildFactsLedger({
    availableBalance: 100,
    upcomingExpenseTotal: 200,
  });
}

function coverageLedger() {
  return buildFactsLedger({
    availableBalance: 2207.75,
    currentBalance: 2500,
    reconciledBalance: 2600,
    upcomingExpenseTotal: 5627.40,
    upcomingIncomeTotal: 4100,
    upcoming: [
      { name: 'Mortgage', amount: -2824.83, start: '2026-08-28' },
      { name: 'Daycare', amount: -705, start: '2026-08-22' },
      { name: 'AT&T', amount: -240, start: '2026-08-25' },
    ],
  });
}

function sameCentsCoverageLedger() {
  return buildFactsLedger({
    availableBalance: 50,
    upcomingExpenseTotal: 100,
    upcomingIncomeTotal: 200,
    upcoming: [
      { name: 'Mortgage', amount: -100, start: '2026-08-28' },
    ],
  });
}

function residualEventLedger() {
  return buildFactsLedger({
    availableBalance: 50,
    futureNegativeBalances: [{ amount: -80, date: '2026-09-15', daysUntil: 20 }],
  });
}

function comparisonJuneJuly() {
  return buildComparisonEvidenceLedger({
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
          income: { absolute: 0, percent: 0, baselineZero: false },
          spending: { absolute: -2093.47, percent: -13.95, direction: 'decreased', baselineZero: false },
          net: { absolute: 2093.47, percent: 13.95, direction: 'improved', baselineZero: false },
        },
      },
      observations: [{ code: 'spending_decreased' }, { code: 'net_improved' }],
      limitations: [],
    },
    accountContext: { accountId: '10', accountLabel: 'Checking' },
  }).ledger;
}

function validate(ledger, text) {
  return validateResponseAgainstContract({
    contract: contractOf(ledger),
    text,
  });
}

function enforcementOf(validation, extra) {
  return evaluateResponseEnforcement(Object.assign({
    flagEnabled: true,
    capability: 'financial_forecast',
    responseSource: 'azure',
    writeResponseMode: 'none',
    shadow: {
      telemetry: {
        response_validation_performed: true,
        response_validation_status: validation.status,
        response_validation_contract_status: 'ok',
      },
      validation,
    },
  }, extra || {}));
}

async function run() {
  section('3C.4 Slice 2 flag defaults');
  withShadow(undefined, () => {
    check('unset defaults OFF', isSnapshotSemanticValidationEnabled() === false);
  });
  withShadow('', () => {
    check('empty defaults OFF', isSnapshotSemanticValidationEnabled() === false);
  });
  withShadow('false', () => {
    check('false OFF', isSnapshotSemanticValidationEnabled() === false);
  });
  withShadow('true', () => {
    check('true ON', isSnapshotSemanticValidationEnabled() === true);
  });
  check('flag name', SNAPSHOT_SEMANTIC_VALIDATION_ENV_KEY === 'USE_SNAPSHOT_SEMANTIC_VALIDATION_SHADOW');

  const snap = buildSnapshot();
  const snapC = contractOf(snap);
  const roles = roleLedger();
  const sameCents = sameCentsLedger();
  const collision = collisionLedger();

  section('3C.4 Slice 2A shadow isolation');
  withShadow('true', () => {
    const onlySemantic = {
      status: VALIDATION_STATUS.INVALID,
      violations: [{
        code: VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH,
        severity: SEVERITY.CRITICAL,
        reasonCode: SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH,
      }],
    };
    const isolated = enforcementOf(onlySemantic);
    check('Slice 2-only critical does not block', isolated.block === false);
    check('Slice 2-only reason not eligible family',
      isolated.reason === ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY);
    check('Slice 2-only remains eligible', isolated.eligible === true);

    const mixed = {
      status: VALIDATION_STATUS.INVALID,
      violations: [
        {
          code: VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH,
          severity: SEVERITY.HIGH,
          reasonCode: SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH,
        },
        {
          code: VIOLATION_CODE.UNSUPPORTED_DERIVATION,
          severity: SEVERITY.CRITICAL,
          reasonCode: 'unauthorized_derived_amount',
        },
      ],
    };
    const mixedEnf = enforcementOf(mixed);
    check('mixed old+new still blocks', mixedEnf.block === true);
    check('mixed reason eligible blocked', mixedEnf.reason === ENFORCEMENT_REASON.ELIGIBLE_INVALID_BLOCKED);
  });

  section('3C.4 Slice 2 flag-OFF rollback');
  withShadow('false', () => {
    const sept = validateResponseAgainstContract({
      contract: snapC,
      text: 'Your September expenses will total $1134.56.',
    });
    check('flag OFF September 15-day remains VALID', sept.status === VALIDATION_STATUS.VALID);
    check('flag OFF no SNAPSHOT_SEMANTIC_MISMATCH', !hasCode(sept, VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH));
    const lowest = validateResponseAgainstContract({
      contract: snapC,
      text: 'The lowest balance next month will be -$220.85.',
    });
    check('flag OFF next-month event remains VALID', lowest.status === VALIDATION_STATUS.VALID);
    const role = validate(roles, 'Your available balance is $300.');
    check('flag OFF role collision remains VALID', role.status === VALIDATION_STATUS.VALID);
  });
  withShadow(undefined, () => {
    const sept = validateResponseAgainstContract({
      contract: snapC,
      text: 'Your September expenses will total $1134.56.',
    });
    check('unset flag September remains VALID', sept.status === VALIDATION_STATUS.VALID);
  });

  withShadow('true', () => {
    section('3C.4 Slice 2 horizon matrix');
    const a = validateResponseAgainstContract({
      contract: snapC,
      text: 'Upcoming expenses over the next 15 days total $1134.56.',
    });
    check('A 15-day expense wording VALID', a.status === VALIDATION_STATUS.VALID);

    const b = validateResponseAgainstContract({
      contract: snapC,
      text: 'Upcoming expenses are $1134.56.',
    });
    check('B generic upcoming expense VALID', b.status === VALIDATION_STATUS.VALID);

    const c = validateResponseAgainstContract({
      contract: snapC,
      text: 'September expenses will total $1134.56.',
    });
    check('C named-month expense INVALID', c.status === VALIDATION_STATUS.INVALID);
    check('C SNAPSHOT_SEMANTIC_MISMATCH', semanticHit(c, SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH));
    check('C not UNSUPPORTED_AMOUNT', !hasCode(c, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
    const cEnf = enforcementOf(c);
    check('C Slice 2-only not blocked', cEnf.block === false
      && cEnf.reason === ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY);

    const d = validateResponseAgainstContract({
      contract: snapC,
      text: "Next month's expenses will total $1134.56.",
    });
    check('D next-month expense INVALID', d.status === VALIDATION_STATUS.INVALID);
    check('D window or current-future', semanticHit(d, SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH)
      || semanticHit(d, SNAPSHOT_SEMANTIC_REASON.CURRENT_FUTURE_ROLE_MISMATCH));

    const e = validateResponseAgainstContract({
      contract: snapC,
      text: 'Expenses over the next 7 days total $1134.56.',
    });
    check('E next-7-days INVALID', e.status === VALIDATION_STATUS.INVALID && semanticHit(e));

    const f = validateResponseAgainstContract({
      contract: snapC,
      text: 'Bills next week total $1134.56.',
    });
    check('F next-week INVALID', f.status === VALIDATION_STATUS.INVALID && semanticHit(f));

    const g = validateResponseAgainstContract({
      contract: snapC,
      text: 'Upcoming income over the next 15 days is $4626.36.',
    });
    check('G 15-day income VALID', g.status === VALIDATION_STATUS.VALID);

    const h = validateResponseAgainstContract({
      contract: snapC,
      text: 'September income is $4626.36.',
    });
    check('H named-month income INVALID', h.status === VALIDATION_STATUS.INVALID
      && semanticHit(h, SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH));

    const i = validateResponseAgainstContract({
      contract: snapC,
      text: "Next month's income is $4626.36.",
    });
    check('I next-month income INVALID', i.status === VALIDATION_STATUS.INVALID && semanticHit(i));

    section('3C.4 Slice 2 current-month scalars');
    const u = validate(roles, 'Your expenses this month are $400.');
    check('U this-month expenses VALID', u.status === VALIDATION_STATUS.VALID);

    const v = validate(roles, 'Your income this month is $500.');
    check('V this-month income VALID', v.status === VALIDATION_STATUS.VALID);

    const w = validate(roles, 'Your net this month is $100.');
    check('W this-month net VALID', w.status === VALIDATION_STATUS.VALID);

    const x = validate(roles, "Next month's expenses are $400.");
    check('X next-month expenses INVALID', x.status === VALIDATION_STATUS.INVALID);
    check('X period/forecast preserved or semantic', hasCode(x, VIOLATION_CODE.UNSUPPORTED_PERIOD_ATTRIBUTION)
      || hasCode(x, VIOLATION_CODE.UNSUPPORTED_FORECAST)
      || semanticHit(x));

    const y = validate(roles, "Next month's income is $500.");
    check('Y next-month income INVALID', y.status === VALIDATION_STATUS.INVALID);
    check('Y period/forecast preserved or semantic', hasCode(y, VIOLATION_CODE.UNSUPPORTED_PERIOD_ATTRIBUTION)
      || hasCode(y, VIOLATION_CODE.UNSUPPORTED_FORECAST)
      || semanticHit(y));

    const z = validate(roles, "Next month's net is $100.");
    check('Z next-month net INVALID', z.status === VALIDATION_STATUS.INVALID);
    check('Z period/forecast preserved or semantic', hasCode(z, VIOLATION_CODE.UNSUPPORTED_PERIOD_ATTRIBUTION)
      || hasCode(z, VIOLATION_CODE.UNSUPPORTED_FORECAST)
      || semanticHit(z));

    section('3C.4 Slice 2 balance role identity');
    check('O available VALID', validate(roles, 'Your available balance is $100.').status === VALIDATION_STATUS.VALID);
    check('P current VALID', validate(roles, 'Your current balance is $200.').status === VALIDATION_STATUS.VALID);
    check('Q reconciled VALID', validate(roles, 'Your reconciled balance is $300.').status === VALIDATION_STATUS.VALID);
    check('available right now VALID',
      validate(roles, 'Your available balance is $100 right now.').status === VALIDATION_STATUS.VALID);
    check('currently have available VALID',
      validate(roles, 'You currently have an available balance of $100.').status === VALIDATION_STATUS.VALID);
    check('available plus spending explanation VALID', validate(roles, [
      'Your available balance is $100.',
      'This is the amount currently accessible for spending or withdrawal.',
    ].join(' ')).status === VALIDATION_STATUS.VALID);

    const liveAvailLedger = buildFactsLedger({
      availableBalance: 2207.75,
      currentBalance: 2500,
      reconciledBalance: 2600,
      upcomingExpenseTotal: 600,
      upcomingIncomeTotal: 700,
    });
    const liveAvailText = [
      'Your available balance in the Main Account at Wells Fargo is $2207.75.',
      '',
      'This is the amount currently accessible for spending or withdrawal.',
    ].join('\n');
    const liveAvail = validate(liveAvailLedger, liveAvailText);
    check('live available + spending explanation VALID', liveAvail.status === VALIDATION_STATUS.VALID);
    check('live available no SNAPSHOT_SEMANTIC_MISMATCH',
      !hasCode(liveAvail, VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH));
    check('minimal available 2207.75 VALID',
      validate(liveAvailLedger, 'Your available balance is $2207.75.').status === VALIDATION_STATUS.VALID);

    const r = validate(roles, 'Your available balance is $300.');
    check('R reconciled as available INVALID', r.status === VALIDATION_STATUS.INVALID
      && semanticHit(r, SNAPSHOT_SEMANTIC_REASON.SEMANTIC_ROLE_MISMATCH));

    const s = validate(roles, 'Your current balance is $100.');
    check('S available as current INVALID', s.status === VALIDATION_STATUS.INVALID
      && semanticHit(s, SNAPSHOT_SEMANTIC_REASON.SEMANTIC_ROLE_MISMATCH));

    const t = validate(roles, 'Your balance next month will be $100.');
    check('T current as future still INVALID', t.status !== VALIDATION_STATUS.VALID);
    check('T existing forecast preserved', hasCode(t, VIOLATION_CODE.UNSUPPORTED_FORECAST)
      || hasCode(t, VIOLATION_CODE.UNSUPPORTED_PERIOD_ATTRIBUTION)
      || hasCode(t, VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH));

    section('3C.4 Slice 2 upcoming metric role');
    check('upcoming expenses 600 VALID', validate(roles, 'Upcoming expenses are $600.').status === VALIDATION_STATUS.VALID);
    check('upcoming income 700 VALID', validate(roles, 'Upcoming income is $700.').status === VALIDATION_STATUS.VALID);
    const expAsInc = validate(roles, 'Upcoming expenses are $700.');
    check('income spoken as expense INVALID', expAsInc.status === VALIDATION_STATUS.INVALID && semanticHit(expAsInc));
    const incAsExp = validate(roles, 'Upcoming income is $600.');
    check('expense spoken as income INVALID', incAsExp.status === VALIDATION_STATUS.INVALID && semanticHit(incAsExp));

    section('3C.4 Slice 2 same-cents vs collision');
    check('same-cents available VALID', validate(sameCents, 'Available balance is $100.').status === VALIDATION_STATUS.VALID);
    check('same-cents current VALID', validate(sameCents, 'Current balance is $100.').status === VALIDATION_STATUS.VALID);
    check('same-cents upcoming expense VALID', validate(sameCents, 'Upcoming expenses are $100.').status === VALIDATION_STATUS.VALID);
    check('same-cents upcoming income VALID', validate(sameCents, 'Upcoming income is $100.').status === VALIDATION_STATUS.VALID);
    const coll = validate(collision, 'Upcoming expenses are $100.');
    check('non-target role collision INVALID', coll.status === VALIDATION_STATUS.INVALID && semanticHit(coll));

    section('3C.4 Slice 2 negative event identity');
    const j = validate(roles, 'A forecasted negative balance of -$80 occurs on November 8, 2026.');
    check('J exact event date VALID', j.status === VALIDATION_STATUS.VALID);

    const n = validate(roles, 'There is a future negative balance of -$80.');
    check('N generic future event VALID', n.status === VALIDATION_STATUS.VALID);

    const k = validate(roles, 'A forecasted negative balance of -$80 occurs on September 15, 2026.');
    check('K wrong exact date INVALID', k.status === VALIDATION_STATUS.INVALID);
    check('K existing list mismatch or semantic', hasCode(k, VIOLATION_CODE.LIST_ITEM_MISMATCH)
      || hasCode(k, VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH));

    const l = validate(roles, 'The lowest balance in September will be -$80.');
    check('L wrong named month INVALID', l.status === VALIDATION_STATUS.INVALID
      && semanticHit(l, SNAPSHOT_SEMANTIC_REASON.WINDOW_HORIZON_MISMATCH));

    const m = validate(roles, 'The lowest balance next month will be -$80.');
    check('M wrong next-month INVALID', m.status === VALIDATION_STATUS.INVALID && semanticHit(m));

    const residual = validate(residualEventLedger(), 'The lowest balance in September will be -$80.');
    check('lowest matching-month not ranking-rejected', residual.status === VALIDATION_STATUS.VALID);
    check('SNAPSHOT_NEGATIVE_MINIMUM_COVERAGE_RESIDUAL OPEN',
      SNAPSHOT_NEGATIVE_MINIMUM_COVERAGE_RESIDUAL === 'OPEN');

    section('3C.4 Slice 2 wrong-value control');
    const wrong = validate(roles, 'Your available balance is $9999.99.');
    check('arbitrary amount UNSUPPORTED_AMOUNT', hasCode(wrong, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
    check('arbitrary amount not semantic', !hasCode(wrong, VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH));

    section('3C.4 Slice 2 mixed old+new e2e');
    const mixedText = 'September expenses will total $600. Your net cash flow is $1193.93.';
    const mixedRes = validate(roles, mixedText);
    check('mixed has semantic mismatch', hasCode(mixedRes, VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH));
    check('mixed has derivation', hasCode(mixedRes, VIOLATION_CODE.UNSUPPORTED_DERIVATION)
      || hasCode(mixedRes, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
    const mixedEnf = enforcementOf(mixedRes);
    check('mixed e2e still blocks', mixedEnf.block === true);

    section('3C.4 Slice 2 false-positive freeze gates');
    check('correct available remains VALID',
      validateResponseAgainstContract({ contract: snapC, text: 'Your available balance is $4846.97.' }).status
      === VALIDATION_STATUS.VALID);
    check('correct current remains VALID',
      validateResponseAgainstContract({ contract: snapC, text: 'Your current balance is $5010.5.' }).status
      === VALIDATION_STATUS.VALID);
    check('Daycare exact tuple remains VALID',
      validateResponseAgainstContract({ contract: snapC, text: 'Daycare $705 on August 22' }).status
      === VALIDATION_STATUS.VALID);

    const upcomingMacro = validateResponseAgainstContract({
      contract: contractOf(buildUpcomingMacro()),
      text: 'Bills due next week total $1297.30.',
    });
    check('upcoming macro unaffected', upcomingMacro.status === VALIDATION_STATUS.VALID);

    const target = validateResponseAgainstContract({
      contract: contractOf(buildLookup()),
      text: 'In July 2026, you made 3 transactions at Target totaling $279.58.',
    });
    check('Target lookup unaffected', target.status === VALIDATION_STATUS.VALID);

    const cmpLedger = comparisonJuneJuly();
    const june = validateResponseAgainstContract({
      contract: contractOf(cmpLedger),
      text: 'In June 2026, spending was $15010.46.',
    });
    const july = validateResponseAgainstContract({
      contract: contractOf(cmpLedger),
      text: 'In July 2026, spending was $12916.99.',
    });
    const wrongMonth = validateResponseAgainstContract({
      contract: contractOf(cmpLedger),
      text: 'In July 2026, spending was $15010.46.',
    });
    check('Slice 1 June VALID', june.status === VALIDATION_STATUS.VALID);
    check('Slice 1 July VALID', july.status === VALIDATION_STATUS.VALID);
    check('Slice 1 wrong-month INVALID', wrongMonth.status === VALIDATION_STATUS.INVALID
      && hasCode(wrongMonth, VIOLATION_CODE.UNSUPPORTED_PERIOD_ATTRIBUTION));

    const tuples = [
      ['facts.availableBalance', 'current_available_balance', 'available', 'current'],
      ['facts.currentBalance', 'current_balance', 'current', 'current'],
      ['facts.reconciledBalance', 'current_reconciled_balance', 'reconciled', 'current'],
      ['facts.monthIncome', 'current_month_income', null, 'current_month'],
      ['facts.monthExpenses', 'current_month_expenses', null, 'current_month'],
      ['facts.monthNet', 'current_month_net', null, 'current_month'],
      ['facts.upcomingExpenseTotal', 'upcoming_window_expense_total', null, 'next_15_days'],
      ['facts.upcomingIncomeTotal', 'upcoming_window_income_total', null, 'next_15_days'],
    ];
    for (let i = 0; i < tuples.length; i += 1) {
      const t = tupleFromClaim({ path: tuples[i][0], semanticRole: tuples[i][1] });
      check(`tuple ${tuples[i][0]} temporal`, t.temporalRole === tuples[i][3]);
      if (tuples[i][2]) check(`tuple ${tuples[i][0]} balanceRole`, t.balanceRole === tuples[i][2]);
    }

    section('3C.4 Slice 2 performance');
    const tRole = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) validate(roles, 'Your available balance is $100.');
    const roleMs = Number(process.hrtime.bigint() - tRole) / 1e6;
    console.log(`  1000 valid role checks: ${roleMs.toFixed(2)}ms total, ${(roleMs / 1000).toFixed(3)}ms avg`);

    const tHor = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) {
      validateResponseAgainstContract({
        contract: snapC,
        text: 'September expenses will total $1134.56.',
      });
    }
    const horMs = Number(process.hrtime.bigint() - tHor) / 1e6;
    console.log(`  1000 horizon mismatches: ${horMs.toFixed(2)}ms total, ${(horMs / 1000).toFixed(3)}ms avg`);

    const semanticInvalid = validateResponseAgainstContract({
      contract: snapC,
      text: 'September expenses will total $1134.56.',
    });
    const tEnf = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) enforcementOf(semanticInvalid);
    const enfMs = Number(process.hrtime.bigint() - tEnf) / 1e6;
    console.log(`  1000 shadow-only INVALID enforcement: ${enfMs.toFixed(2)}ms total, ${(enfMs / 1000).toFixed(3)}ms avg`);

    const derived = validateResponseAgainstContract({
      contract: snapC,
      text: 'Your net cash flow is $1193.93.',
    });
    const tBlk = process.hrtime.bigint();
    for (let i = 0; i < 1000; i += 1) enforcementOf(derived);
    const blkMs = Number(process.hrtime.bigint() - tBlk) / 1e6;
    console.log(`  1000 existing forecast blocking: ${blkMs.toFixed(2)}ms total, ${(blkMs / 1000).toFixed(3)}ms avg`);
    check('performance measured',
      Number.isFinite(roleMs) && Number.isFinite(horMs) && Number.isFinite(enfMs) && Number.isFinite(blkMs));
  });

  section('3C.4 Slice 2 rollback does not disable 3C.3');
  withShadow('false', () => {
    withFlag(RESPONSE_VALIDATION_ENFORCEMENT_ENV_KEY, 'true', () => {
      const derived = validateResponseAgainstContract({
        contract: snapC,
        text: 'Your net cash flow is $1193.93.',
      });
      const blocked = enforcementOf(derived);
      check('flag OFF still blocks derivation', blocked.block === true);
    });
  });

  section('3C.4 Slice 2 both flags: 3C.3 forecast still blocks');
  withShadow('true', () => {
    withFlag(RESPONSE_VALIDATION_ENFORCEMENT_ENV_KEY, 'true', () => {
      const liveC = applyShadowResponseValidation({
        text: [
          'Your projected income for next month (September 2026) is $4626.36.',
          'Your projected expenses for next month are $3432.43.',
          'This results in a net positive cash flow of $1193.93.',
          'Your available balance is forecasted to be approximately $4846.97.',
          'Your balance is expected to increase by about $1194.',
        ].join(' '),
        ledger: snap,
        capability: 'financial_forecast',
        responseSource: 'azure',
      });
      const blocked = evaluateResponseEnforcement({
        flagEnabled: true,
        capability: 'financial_forecast',
        responseSource: 'azure',
        writeResponseMode: 'none',
        shadow: liveC,
      });
      check('LIVE_C still invalid', liveC.telemetry.response_validation_status === 'invalid');
      check('LIVE_C still blocked', blocked.block === true);
      check('one validation pass', liveC.telemetry.response_validation_performed === true);
    });
  });

  section('3C.4 Slice 3 coverage flag defaults');
  withCoverage(undefined, () => {
    check('coverage unset defaults OFF', isSnapshotCoverageValidationEnabled() === false);
  });
  withCoverage('', () => {
    check('coverage empty defaults OFF', isSnapshotCoverageValidationEnabled() === false);
  });
  withCoverage('false', () => {
    check('coverage false OFF', isSnapshotCoverageValidationEnabled() === false);
  });
  withCoverage('true', () => {
    check('coverage true ON', isSnapshotCoverageValidationEnabled() === true);
  });
  check('coverage flag name',
    SNAPSHOT_COVERAGE_VALIDATION_ENV_KEY === 'USE_SNAPSHOT_COVERAGE_VALIDATION_SHADOW');

  const cov = coverageLedger();
  const covC = contractOf(cov);
  const sameCov = sameCentsCoverageLedger();
  check('snapshot upcoming coverage is preview',
    covC.listCoverage.upcoming === LIST_COVERAGE.PREVIEW);

  section('3C.4 Slice 3 rollback preserves Slice 2');
  withShadow('true', () => {
    withCoverage(undefined, () => {
      check('coverage unset listed total still VALID',
        validate(cov, 'These listed upcoming expenses total $5627.40.').status
        === VALIDATION_STATUS.VALID);
      check('Slice 2 September still INVALID',
        validateResponseAgainstContract({
          contract: snapC,
          text: 'September expenses will total $1134.56.',
        }).status === VALIDATION_STATUS.INVALID);
    });
    withCoverage('false', () => {
      check('coverage false listed total VALID',
        validate(cov, 'These listed upcoming expenses total $5627.40.').status
        === VALIDATION_STATUS.VALID);
    });
  });

  withShadow('true', () => {
    withCoverage('true', () => {
      withFlag(RESPONSE_VALIDATION_ENFORCEMENT_ENV_KEY, 'true', () => {
        section('3C.4 Slice 3 positive full-window totals');
        check('generic upcoming expense total VALID',
          validate(cov, 'Upcoming expenses total $5627.40.').status === VALIDATION_STATUS.VALID);
        check('explicit 15-day total VALID',
          validate(cov, 'You have $5627.40 in upcoming expenses over the next 15 days.').status
          === VALIDATION_STATUS.VALID);
        check('over next 15 days wording VALID',
          validate(cov, 'Over the next 15 days, upcoming expenses total $5627.40.').status
          === VALIDATION_STATUS.VALID);
        check('upcoming expense total is VALID',
          validate(cov, 'Your upcoming expense total is $5627.40.').status
          === VALIDATION_STATUS.VALID);
        check('Keacast shows upcoming VALID',
          validate(cov, 'Keacast shows $5627.40 of upcoming expenses in the next 15 days.').status
          === VALIDATION_STATUS.VALID);
        check('generic upcoming income VALID',
          validate(cov, 'Upcoming income over the next 15 days is $4100.').status
          === VALIDATION_STATUS.VALID
          || validate(cov, 'Upcoming income over the next 15 days is $4100.00.').status
          === VALIDATION_STATUS.VALID);

        section('3C.4 Slice 3 preview item mentions remain VALID');
        check('preview includes Mortgage VALID',
          validate(cov, 'The preview includes Mortgage for $2824.83.').status
          === VALIDATION_STATUS.VALID);
        check('one listed Daycare VALID',
          validate(cov, 'One listed upcoming item is Daycare for $705.').status
          === VALIDATION_STATUS.VALID);
        check('AT&T upcoming item VALID',
          validate(cov, 'One of the upcoming items is AT&T for $240.').status
          === VALIDATION_STATUS.VALID);

        section('3C.4 Slice 3 available-balance regressions');
        check('available 2207.75 VALID',
          validate(cov, 'Your available balance is $2207.75.').status === VALIDATION_STATUS.VALID);
        check('live pending/holds narration VALID', validate(cov, [
          'Your available balance in the Main Account at Wells Fargo is $2207.75.',
          'This reflects the funds you can currently use, considering pending transactions and holds.',
        ].join('\n')).status === VALIDATION_STATUS.VALID);
        check('available spending explanation VALID', validate(cov, [
          'Your available balance in the Main Account at Wells Fargo is $2207.75.',
          '',
          'This is the amount currently accessible for spending or withdrawal.',
        ].join('\n')).status === VALIDATION_STATUS.VALID);

        section('3C.4 Slice 3 negative coverage goldens');
        function coverageInvalid(text) {
          const result = validate(cov, text);
          return result.status === VALIDATION_STATUS.INVALID
            && semanticHit(result, SNAPSHOT_SEMANTIC_REASON.COVERAGE_ROLE_MISMATCH);
        }
        check('these listed expenses INVALID',
          coverageInvalid('These listed upcoming expenses total $5627.40.'));
        check('complete upcoming expense list INVALID',
          coverageInvalid('Your complete upcoming expense list totals $5627.40.'));
        check('preview shows INVALID',
          coverageInvalid('The preview shows $5627.40 of expenses.'));
        check('items in this preview INVALID',
          coverageInvalid('The items in this preview total $5627.40.'));
        const shownAbove = validate(cov, 'The expenses shown above total $5627.40.');
        check('shown above INVALID', shownAbove.status === VALIDATION_STATUS.INVALID
          && (hasCode(shownAbove, VIOLATION_CODE.PREVIEW_TOTAL_MISATTRIBUTION)
            || semanticHit(shownAbove, SNAPSHOT_SEMANTIC_REASON.COVERAGE_ROLE_MISMATCH)));
        const listedAbove = validate(cov, 'The transactions listed above total $5627.40.');
        check('transactions listed above INVALID', listedAbove.status === VALIDATION_STATUS.INVALID
          && (hasCode(listedAbove, VIOLATION_CODE.PREVIEW_TOTAL_MISATTRIBUTION)
            || semanticHit(listedAbove, SNAPSHOT_SEMANTIC_REASON.COVERAGE_ROLE_MISMATCH)));
        check('all items listed INVALID',
          coverageInvalid('All the items listed total $5627.40.'));
        check('these items add up INVALID',
          coverageInvalid('These items add up to $5627.40.'));
        check('listed items add up INVALID',
          coverageInvalid('The listed items add up to $5627.40.'));
        check('listed upcoming income INVALID',
          coverageInvalid('The listed upcoming income items total $4100.00.')
          || coverageInvalid('The listed upcoming income items total $4100.'));

        section('3C.4 Slice 3 multi-claim and mixed coverage');
        const multiOk = validate(cov, [
          'Upcoming expenses total $5627.40 over the next 15 days.',
          'The preview includes Mortgage for $2824.83.',
        ].join(' '));
        check('full total + preview item VALID', multiOk.status === VALIDATION_STATUS.VALID);

        const mixedCov = validate(cov, [
          'Upcoming expenses total $5627.40 over the next 15 days.',
          'These listed items total $5627.40.',
        ].join(' '));
        check('mixed full-window + listed total INVALID', mixedCov.status === VALIDATION_STATUS.INVALID);
        check('mixed has coverage mismatch',
          semanticHit(mixedCov, SNAPSHOT_SEMANTIC_REASON.COVERAGE_ROLE_MISMATCH));

        const wrongListed = validate(cov, 'These listed items total $99999.');
        check('wrong listed amount UNSUPPORTED_AMOUNT',
          hasCode(wrongListed, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
        check('wrong listed amount not coverage',
          !hasCode(wrongListed, VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH));

        section('3C.4 Slice 3 locality');
        const previewElsewhere = validate(cov, [
          'The preview is shown below.',
          'Your upcoming expenses total $5627.40 over the next 15 days.',
        ].join(' '));
        check('preview word elsewhere does not contaminate',
          previewElsewhere.status === VALIDATION_STATUS.VALID);

        const listedElsewhere = validate(cov, [
          'Upcoming expenses total $5627.40.',
          'The listed items include Daycare for $705.',
        ].join(' '));
        check('listed item + full total independently VALID',
          listedElsewhere.status === VALIDATION_STATUS.VALID);

        check('same-cents upcoming total VALID',
          validate(sameCov, 'Upcoming expenses total $100.').status === VALIDATION_STATUS.VALID);
        check('same-cents listed total INVALID',
          validate(sameCov, 'The listed items total $100.').status === VALIDATION_STATUS.INVALID
          && semanticHit(validate(sameCov, 'The listed items total $100.'),
            SNAPSHOT_SEMANTIC_REASON.COVERAGE_ROLE_MISMATCH));
        check('same-cents Mortgage item VALID',
          validate(sameCov, 'Mortgage is $100.').status === VALIDATION_STATUS.VALID);

        section('3C.4 Slice 3 Slice 2 regressions');
        check('correct available role',
          validate(roles, 'Your available balance is $100.').status === VALIDATION_STATUS.VALID);
        check('reconciled as available still INVALID',
          validate(roles, 'Your available balance is $300.').status === VALIDATION_STATUS.INVALID
          && semanticHit(validate(roles, 'Your available balance is $300.'),
            SNAPSHOT_SEMANTIC_REASON.SEMANTIC_ROLE_MISMATCH));
        check('available as current still INVALID',
          validate(roles, 'Your current balance is $100.').status === VALIDATION_STATUS.INVALID);
        check('15-day wording VALID',
          validateResponseAgainstContract({
            contract: snapC,
            text: 'Upcoming expenses total $1134.56.',
          }).status === VALIDATION_STATUS.VALID);
        check('15-day as September still INVALID',
          validateResponseAgainstContract({
            contract: snapC,
            text: 'September expenses will total $1134.56.',
          }).status === VALIDATION_STATUS.INVALID);
        check('15-day as next week still INVALID',
          validateResponseAgainstContract({
            contract: snapC,
            text: 'Bills next week total $1134.56.',
          }).status === VALIDATION_STATUS.INVALID);
        check('upcoming income as expense still INVALID',
          validate(roles, 'Upcoming expenses are $700.').status === VALIDATION_STATUS.INVALID);
        check('exact negative event still VALID',
          validate(roles, 'A forecasted negative balance of -$80 occurs on November 8, 2026.').status
          === VALIDATION_STATUS.VALID);
        check('wrong negative month still INVALID',
          validate(roles, 'The lowest balance in September will be -$80.').status
          === VALIDATION_STATUS.INVALID);

        section('3C.4 Slice 3 Slice 1 / non-snapshot regressions');
        const june = validateResponseAgainstContract({
          contract: contractOf(comparisonJuneJuly()),
          text: 'In June 2026, spending was $15010.46.',
        });
        const july = validateResponseAgainstContract({
          contract: contractOf(comparisonJuneJuly()),
          text: 'In July 2026, spending was $12916.99.',
        });
        const wrongMonth = validateResponseAgainstContract({
          contract: contractOf(comparisonJuneJuly()),
          text: 'In July 2026, spending was $15010.46.',
        });
        check('Slice 1 June still VALID', june.status === VALIDATION_STATUS.VALID);
        check('Slice 1 July still VALID', july.status === VALIDATION_STATUS.VALID);
        check('Slice 1 wrong-month still INVALID', wrongMonth.status === VALIDATION_STATUS.INVALID
          && hasCode(wrongMonth, VIOLATION_CODE.UNSUPPORTED_PERIOD_ATTRIBUTION));
        check('upcoming macro still VALID',
          validateResponseAgainstContract({
            contract: contractOf(buildUpcomingMacro()),
            text: 'Bills due next week total $1297.30.',
          }).status === VALIDATION_STATUS.VALID);
        check('upcoming macro listed total not snapshot-rejected',
          validateResponseAgainstContract({
            contract: contractOf(buildUpcomingMacro()),
            text: 'These listed items total $1297.30.',
          }).status !== VALIDATION_STATUS.INVALID
          || !semanticHit(validateResponseAgainstContract({
            contract: contractOf(buildUpcomingMacro()),
            text: 'These listed items total $1297.30.',
          }), SNAPSHOT_SEMANTIC_REASON.COVERAGE_ROLE_MISMATCH));
        check('Target lookup still VALID',
          validateResponseAgainstContract({
            contract: contractOf(buildLookup()),
            text: 'In July 2026, you made 3 transactions at Target totaling $279.58.',
          }).status === VALIDATION_STATUS.VALID);

        section('3C.4 Slice 3 enforcement isolation');
        const listedOnly = validate(cov, 'These listed upcoming expenses total $5627.40.');
        const listedEnf = enforcementOf(listedOnly);
        check('Slice 3-only INVALID', listedOnly.status === VALIDATION_STATUS.INVALID
          && semanticHit(listedOnly, SNAPSHOT_SEMANTIC_REASON.COVERAGE_ROLE_MISMATCH));
        check('Slice 3-only not blocked', listedEnf.block === false);
        check('Slice 3-only not_eligible_claim_family',
          listedEnf.reason === ENFORCEMENT_REASON.NOT_ELIGIBLE_CLAIM_FAMILY);

        const derived = validateResponseAgainstContract({
          contract: snapC,
          text: 'Your net cash flow is $1193.93.',
        });
        check('existing forecast still blocks', enforcementOf(derived).block === true);

        const mixedEnf = validate(roles, [
          'These listed upcoming expenses total $600.',
          'Your net cash flow is $1193.93.',
        ].join(' '));
        check('mixed coverage+derivation has coverage',
          hasCode(mixedEnf, VIOLATION_CODE.SNAPSHOT_SEMANTIC_MISMATCH));
        check('mixed coverage+derivation has derivation',
          hasCode(mixedEnf, VIOLATION_CODE.UNSUPPORTED_DERIVATION)
          || hasCode(mixedEnf, VIOLATION_CODE.UNSUPPORTED_AMOUNT));
        check('mixed coverage+derivation still blocks', enforcementOf(mixedEnf).block === true);

        const liveC2 = applyShadowResponseValidation({
          text: [
            'Your projected income for next month (September 2026) is $4626.36.',
            'Your projected expenses for next month are $3432.43.',
            'This results in a net positive cash flow of $1193.93.',
            'Your available balance is forecasted to be approximately $4846.97.',
            'Your balance is expected to increase by about $1194.',
          ].join(' '),
          ledger: snap,
          capability: 'financial_forecast',
          responseSource: 'azure',
        });
        const blocked2 = evaluateResponseEnforcement({
          flagEnabled: true,
          capability: 'financial_forecast',
          responseSource: 'azure',
          writeResponseMode: 'none',
          shadow: liveC2,
        });
        check('LIVE_C still blocked with Slice 3 ON', blocked2.block === true);
        check('one validation pass Slice 3', liveC2.telemetry.response_validation_performed === true);

        section('3C.4 Slice 3 performance');
        const tWin = process.hrtime.bigint();
        for (let i = 0; i < 1000; i += 1) validate(cov, 'Upcoming expenses total $5627.40.');
        const winMs = Number(process.hrtime.bigint() - tWin) / 1e6;
        console.log(`  1000 valid full-window totals: ${winMs.toFixed(2)}ms total, ${(winMs / 1000).toFixed(3)}ms avg`);

        const tCov = process.hrtime.bigint();
        for (let i = 0; i < 1000; i += 1) {
          validate(cov, 'These listed upcoming expenses total $5627.40.');
        }
        const covMs = Number(process.hrtime.bigint() - tCov) / 1e6;
        console.log(`  1000 coverage mismatches: ${covMs.toFixed(2)}ms total, ${(covMs / 1000).toFixed(3)}ms avg`);

        const tItem = process.hrtime.bigint();
        for (let i = 0; i < 1000; i += 1) {
          validate(cov, 'The preview includes Mortgage for $2824.83.');
        }
        const itemMs = Number(process.hrtime.bigint() - tItem) / 1e6;
        console.log(`  1000 valid preview items: ${itemMs.toFixed(2)}ms total, ${(itemMs / 1000).toFixed(3)}ms avg`);

        const tEnf3 = process.hrtime.bigint();
        for (let i = 0; i < 1000; i += 1) enforcementOf(listedOnly);
        const enf3Ms = Number(process.hrtime.bigint() - tEnf3) / 1e6;
        console.log(`  1000 Slice 3 shadow enforcement: ${enf3Ms.toFixed(2)}ms total, ${(enf3Ms / 1000).toFixed(3)}ms avg`);
        check('Slice 3 performance measured',
          Number.isFinite(winMs) && Number.isFinite(covMs)
          && Number.isFinite(itemMs) && Number.isFinite(enf3Ms));
      });
    });
  });
}

module.exports = { run, SNAPSHOT_NEGATIVE_MINIMUM_COVERAGE_RESIDUAL };
