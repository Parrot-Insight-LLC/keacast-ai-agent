'use strict';

const { check, section } = require('./harness');
const { CLAIM_KIND, extractResponseClaims } = require('../services/keaResponseClaimExtractor');

function byKind(rows, kind) {
  return rows.filter((row) => row.kind === kind);
}

function amounts(rows) {
  return rows.filter((row) => row.kind === CLAIM_KIND.AMOUNT
    || row.kind === CLAIM_KIND.ENTITY_AMOUNT
    || row.kind === CLAIM_KIND.ENTITY_AMOUNT_DATE);
}

async function run() {
  section('3C.1 extractor amounts');
  const a = extractResponseClaims('You spent $279.58 at Target.');
  check('$279.58 extracted', amounts(a).some((r) => r.normalizedValue === 279.58 && r.currency === 'USD'));

  const grouped = extractResponseClaims('Total scheduled expenses are $1,297.30.');
  check('$1,297.30 normalized', amounts(grouped).some((r) => r.normalizedValue === 1297.30));

  const plain = extractResponseClaims('Total scheduled expenses are $1297.30.');
  check('$1297.30 extracted', amounts(plain).some((r) => r.normalizedValue === 1297.30));
  check('comma and plain cents equal', amounts(grouped)[0].normalizedValue === amounts(plain)[0].normalizedValue);

  const signed = extractResponseClaims('The ledger shows -$162.24.');
  check('-$162.24 extracted negative', amounts(signed).some((r) => r.normalizedValue === -162.24
    && r.sign === 'negative'));

  const expense = extractResponseClaims('Services expense of $162.24');
  check('$162.24 expense extracted', amounts(expense)
    .some((r) => r.normalizedValue === 162.24 && (r.semanticHints || []).indexOf('expense') !== -1));

  const words = extractResponseClaims('That comes to 1297.30 dollars.');
  check('dollar-word amount', amounts(words).some((r) => r.normalizedValue === 1297.30));

  const approx = extractResponseClaims('You spent approximately $279.58.');
  check('approximately $279.58 still exact amount', amounts(approx).some((r) => r.normalizedValue === 279.58
    && (r.semanticHints || []).indexOf('approximate') !== -1));

  const about = extractResponseClaims('You spent about $280 at Target.');
  check('about $280 extracted as 280', amounts(about).some((r) => r.normalizedValue === 280));

  const multi = extractResponseClaims('Income $4626.36 and expenses $3432.43.');
  check('multiple amounts', amounts(multi).length >= 2);

  section('3C.1 extractor counts dates periods');
  const count = extractResponseClaims('You made 3 transactions at Target.');
  check('3 transactions is count', byKind(count, CLAIM_KIND.COUNT).some((r) => r.normalizedValue === 3));
  check('3 is not money', byKind(count, CLAIM_KIND.AMOUNT).length === 0);

  const duration = extractResponseClaims('Look at the next 15 days.');
  check('15 days is duration', byKind(duration, CLAIM_KIND.DURATION).some((r) => r.normalizedValue === 15
    && r.unit === 'days'));
  check('15 is not money', byKind(duration, CLAIM_KIND.AMOUNT).length === 0);

  const year = extractResponseClaims('The year is 2026.');
  check('2026 is year', byKind(year, CLAIM_KIND.YEAR).some((r) => r.year === 2026));
  check('2026 is not count or money', byKind(year, CLAIM_KIND.COUNT).length === 0
    && byKind(year, CLAIM_KIND.AMOUNT).length === 0);

  const iso = extractResponseClaims('Posted on 2026-08-23.');
  check('ISO date', byKind(iso, CLAIM_KIND.DATE).some((r) => r.iso === '2026-08-23'));

  const monthDay = extractResponseClaims('Due August 23.');
  check('August 23 date', byKind(monthDay, CLAIM_KIND.DATE).some((r) => r.month === 8 && r.day === 23));
  check('23 is not amount', byKind(monthDay, CLAIM_KIND.AMOUNT).length === 0);

  const monthDayYear = extractResponseClaims('Posted August 23, 2026.');
  check('August 23, 2026', byKind(monthDayYear, CLAIM_KIND.DATE).some((r) => r.iso === '2026-08-23'));

  const period = extractResponseClaims('In July 2026 spending was lower.');
  check('July 2026 period', byKind(period, CLAIM_KIND.PERIOD).some((r) => r.month === 7 && r.year === 2026));

  const relative = extractResponseClaims('Your balance at the end of next month will change.');
  check('relative next month token', byKind(relative, CLAIM_KIND.RELATIVE_PERIOD).some((r) => r.token === 'next_month'));

  section('3C.1 extractor false positives and ambiguity');
  const rankingPhrase = extractResponseClaims('That item is at the top of the list.');
  check('top of the list is not ranking', byKind(rankingPhrase, CLAIM_KIND.RANKING_CANDIDATE).length === 0);

  const moreTime = extractResponseClaims('You may need more time.');
  check('more time is not comparison amount', moreTime.every((r) => r.kind !== CLAIM_KIND.AMOUNT));

  const ambiguous = extractResponseClaims('The code is 279.58.');
  check('bare decimal without money context is unknown_numeric',
    byKind(ambiguous, CLAIM_KIND.UNKNOWN_NUMERIC).some((r) => r.normalizedValue === 279.58));
  check('bare decimal is not auto USD', byKind(ambiguous, CLAIM_KIND.AMOUNT).length === 0);

  section('3C.2 extractor percents and direction');
  const decPct = extractResponseClaims('The percentage decrease in spending was 13.95%.');
  check('13.95% is percent', byKind(decPct, CLAIM_KIND.PERCENT).some((r) => r.normalizedValue === 13.95
    && r.unit === 'percent'));
  check('13.95% is not USD amount', amounts(decPct).every((r) => r.normalizedValue !== 13.95));

  const intPct = extractResponseClaims('Spending dropped by 19%.');
  check('19% integer percent', byKind(intPct, CLAIM_KIND.PERCENT).some((r) => r.normalizedValue === 19));

  const signedPct = extractResponseClaims('The change was -13.95%.');
  check('signed -13.95%', byKind(signedPct, CLAIM_KIND.PERCENT).some((r) => r.normalizedValue === -13.95));

  const plusPct = extractResponseClaims('Spending changed +13.95%.');
  check('signed +13.95%', byKind(plusPct, CLAIM_KIND.PERCENT).some((r) => r.normalizedValue === 13.95));

  const wordPct = extractResponseClaims('The decrease was 13.95 percent.');
  check('13.95 percent word', byKind(wordPct, CLAIM_KIND.PERCENT).some((r) => r.normalizedValue === 13.95));

  const wordInt = extractResponseClaims('Spending fell 19 percent.');
  check('19 percent word', byKind(wordInt, CLAIM_KIND.PERCENT).some((r) => r.normalizedValue === 19));

  const dirPast = extractResponseClaims('Spending decreased and was lower, with a downward trend.');
  const dirTokens = byKind(dirPast, CLAIM_KIND.DIRECTION).map((r) => r.token);
  check('past-tense decreased extracted', dirTokens.indexOf('decreased') !== -1);
  check('lower extracted', dirTokens.indexOf('lower') !== -1);
  check('downward extracted', dirTokens.indexOf('downward') !== -1);

  const dirLess = extractResponseClaims('You spent less in July.');
  check('less extracted as direction', byKind(dirLess, CLAIM_KIND.DIRECTION).some((r) => r.token === 'less'));

  const toAmt = extractResponseClaims('In July 1–24, 2026, spending decreased to $11924.02. In August 1–24, 2026, spending further decreased to $10374.82.');
  const julyTo = amounts(toAmt).find((r) => r.normalizedValue === 11924.02);
  const augustTo = amounts(toAmt).find((r) => r.normalizedValue === 10374.82);
  check('decreased to is period_value', julyTo && (julyTo.semanticHints || []).indexOf('period_value') !== -1);
  check('further decreased to is period_value', augustTo && (augustTo.semanticHints || []).indexOf('period_value') !== -1);
  check('July to-amount keeps July date month', julyTo && julyTo.dateMonth === 7);
  check('July to-amount is not August', julyTo && julyTo.dateMonth !== 8);
  check('August to-amount keeps August date month', augustTo && augustTo.dateMonth === 8);

  const byAmt = extractResponseClaims('Overall, spending dropped by $2627.71.');
  const dropped = amounts(byAmt).find((r) => r.normalizedValue === 2627.71);
  check('dropped by is delta', dropped && (dropped.semanticHints || []).indexOf('delta') !== -1);
  check('dropped by is not period_value', dropped && (dropped.semanticHints || []).indexOf('period_value') === -1);

  const spelled = extractResponseClaims('You spent twelve hundred dollars.');
  check('spelled-out numbers unsupported', byKind(spelled, CLAIM_KIND.AMOUNT).length === 0);

  const none = extractResponseClaims('Here’s what I found.');
  check('no financial claims', none.filter((r) => r.kind === CLAIM_KIND.AMOUNT
    || r.kind === CLAIM_KIND.COUNT
    || r.kind === CLAIM_KIND.ENTITY_AMOUNT).length === 0);

  const negated = extractResponseClaims('Your balance is not $5000.');
  check('negation still extracts amount', amounts(negated).some((r) => r.normalizedValue === 5000));

  section('3C.2 extractor same-item recurring next-due');
  const mortgageLine = extractResponseClaims('- Mortgage: $2824.83 monthly, next due 2026-09-02');
  const mortgageAmt = amounts(mortgageLine).find((r) => r.normalizedValue === 2824.83);
  check('Mortgage amount date is 2026-09-02', mortgageAmt && mortgageAmt.dateIso === '2026-09-02');
  check('Mortgage next-due hint', mortgageAmt && (mortgageAmt.semanticHints || []).indexOf('recurring_next_due') !== -1);

  const carNoteLine = extractResponseClaims('- Car Note: $934 monthly, next due 2026-09-18');
  const carNoteAmt = amounts(carNoteLine).find((r) => r.normalizedValue === 934);
  check('Car Note amount date is 2026-09-18', carNoteAmt && carNoteAmt.dateIso === '2026-09-18');

  const weeklyGasLine = extractResponseClaims('- Weekly Gas: $120 weekly, equivalent to $520 monthly, next due 2026-08-24');
  const weeklyOcc = amounts(weeklyGasLine).find((r) => r.normalizedValue === 120);
  const weeklyEq = amounts(weeklyGasLine).find((r) => r.normalizedValue === 520);
  check('Weekly Gas occurrence date is 2026-08-24', weeklyOcc && weeklyOcc.dateIso === '2026-08-24');
  check('Weekly Gas monthlyEquivalent stays same item date', weeklyEq && weeklyEq.dateIso === '2026-08-24');
  check('Weekly Gas does not split streams', weeklyOcc && weeklyEq && weeklyOcc.entity === weeklyEq.entity);

  const daycareLine = extractResponseClaims('- Daycare: $705 weekly, equivalent to $3055 monthly, next due 2026-08-28');
  const daycareOcc = amounts(daycareLine).find((r) => r.normalizedValue === 705);
  const daycareEq = amounts(daycareLine).find((r) => r.normalizedValue === 3055);
  check('Daycare occurrence date is 2026-08-28', daycareOcc && daycareOcc.dateIso === '2026-08-28');
  check('Daycare monthlyEquivalent date is 2026-08-28', daycareEq && daycareEq.dateIso === '2026-08-28');

  const prevBullet = extractResponseClaims([
    '- Daycare: $705 weekly, equivalent to $3055 monthly, next due 2026-08-28',
    '- Mortgage: $2824.83 monthly, next due 2026-09-02',
  ].join('\n'));
  const prevMortgage = amounts(prevBullet).find((r) => r.normalizedValue === 2824.83);
  check('previous-bullet ISO is not attached to Mortgage', prevMortgage && prevMortgage.dateIso === '2026-09-02');
  check('Mortgage does not use Daycare 2026-08-28', prevMortgage && prevMortgage.dateIso !== '2026-08-28');

  const nextBullet = extractResponseClaims([
    '- Mortgage: $2824.83 monthly, next due 2026-09-02',
    '- Car Note: $934 monthly, next due 2026-09-18',
  ].join('\n'));
  const nextMortgage = amounts(nextBullet).find((r) => r.normalizedValue === 2824.83);
  const nextCar = amounts(nextBullet).find((r) => r.normalizedValue === 934);
  check('Mortgage isolated from next bullet', nextMortgage && nextMortgage.dateIso === '2026-09-02');
  check('Car Note isolated from previous bullet', nextCar && nextCar.dateIso === '2026-09-18');

  const littDup = extractResponseClaims([
    '- The Litt (Child Care): $119 monthly, next due 2026-09-04',
    '- The Litt (Child Care): $105 monthly, next due 2026-08-26',
  ].join('\n'));
  const litt119 = amounts(littDup).find((r) => r.normalizedValue === 119);
  const litt105 = amounts(littDup).find((r) => r.normalizedValue === 105);
  check('The Litt $119 keeps 2026-09-04', litt119 && litt119.dateIso === '2026-09-04');
  check('The Litt $105 keeps 2026-08-26', litt105 && litt105.dateIso === '2026-08-26');

  const plainNextDue = extractResponseClaims('Mortgage is $2824.83 monthly, next due 2026-09-02.');
  const plainMortgage = amounts(plainNextDue).find((r) => r.normalizedValue === 2824.83);
  check('plain-sentence next-due date is 2026-09-02', plainMortgage && plainMortgage.dateIso === '2026-09-02');

  const upcomingOnDate = extractResponseClaims('Weekly Gas: $120 on August 31');
  const upcomingAmt = amounts(upcomingOnDate).find((r) => r.normalizedValue === 120);
  check('upcoming $X on DATE is not recurring_next_due', upcomingAmt
    && (upcomingAmt.semanticHints || []).indexOf('recurring_next_due') === -1);
  check('upcoming $X on DATE keeps August 31', upcomingAmt && upcomingAmt.dateMonth === 8 && upcomingAmt.dateDay === 31);

  const upcomingBareOn = extractResponseClaims('$120 on August 31');
  const upcomingBare = amounts(upcomingBareOn).find((r) => r.normalizedValue === 120);
  check('bare $X on DATE is not recurring_next_due', upcomingBare
    && (upcomingBare.semanticHints || []).indexOf('recurring_next_due') === -1);

  const upcomingPreceding = extractResponseClaims('August 31: $120');
  const upcomingPre = amounts(upcomingPreceding).find((r) => r.normalizedValue === 120);
  check('preceding DATE: $X is not recurring_next_due', upcomingPre
    && (upcomingPre.semanticHints || []).indexOf('recurring_next_due') === -1);

  const compactPct = extractResponseClaims(
    'Your spending in July 2026 decreased by 13.95% compared to June 2026.'
  );
  check('compact 13.95% still percent', byKind(compactPct, CLAIM_KIND.PERCENT)
    .some((r) => r.normalizedValue === 13.95 && r.unit === 'percent'));
  check('compact 13.95% is not USD', amounts(compactPct).every((r) => r.normalizedValue !== 13.95));
  check('decreased by 13.95% is not monetary delta', byKind(compactPct, CLAIM_KIND.PERCENT)
    .some((r) => r.normalizedValue === 13.95 && (r.semanticHints || []).indexOf('delta') === -1));

  section('3C.1 extractor immutability');
  const options = { foo: 1 };
  const frozenOpts = JSON.stringify(options);
  const src = 'You spent $279.58.';
  extractResponseClaims(src, options);
  check('options not mutated', JSON.stringify(options) === frozenOpts);
  check('source string unchanged', src === 'You spent $279.58.');

  section('3C.1 extractor performance 1000 runs');
  const sample = 'In July 2026, you made 3 transactions at Target totaling $279.58. Next 15 days look fine.';
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i += 1) extractResponseClaims(sample);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`  1000 extractions: ${ms.toFixed(2)}ms total, ${(ms / 1000).toFixed(3)}ms avg`);
  check('1000 extractions completed', Number.isFinite(ms) && ms >= 0);
}

module.exports = { run };
