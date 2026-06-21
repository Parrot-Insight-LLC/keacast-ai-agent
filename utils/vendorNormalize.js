// utils/vendorNormalize.js
//
// Shared vendor/merchant name normalization. This is a CommonJS port of the
// frontend's cashflow-frontend/src/app/tracing-breakdown/vendor-normalize.ts so
// the AI categorizer folds "alike" merchants exactly the way the Sankey /
// pivot views do. Keep the two in sync when either changes.
//
// Pipeline (each step condenses more aggressively than the last):
//   1. base normalize – strip processor prefixes, store/location numbers,
//                        domains, corporate suffixes, and punctuation.
//   2. alias map        – fold known merchant variants into a canonical brand
//                        (AMZN / Amazon.com -> "Amazon", Wal-Mart -> "Walmart").
//   3. brand-root        – otherwise group by the leading distinctive word so
//                        "Starbucks Reserve" / "Starbucks Store 9" both collapse
//                        to "Starbucks". Guarded so short/generic leading words
//                        keep two words and don't over-merge unrelated names.

/** Strips noise to a stable lowercase key (no brand folding yet). */
function baseNormalize(raw) {
  let s = (raw || '').toLowerCase().trim();
  // Strip leading processor tokens (may be chained, e.g. "sq *tst* ...").
  const prefix = /^(sq\s*\*|tst\*|pp\*|py\s*\*|pypl\s*\*?|paypal\s*\*?|ck\s*\*|cke\*|pos\s+|ach\s+|debit\s+|credit\s+|purchase\s+|pmt\s+|payment\s+)/;
  let prev = '';
  while (s !== prev) { prev = s; s = s.replace(prefix, '').trim(); }
  s = s
    .replace(/https?:\/\/\S+/g, ' ')        // urls
    .replace(/www\./g, ' ')
    .replace(/\.(com|net|org|co|io|gov)\b/g, ' ')
    .replace(/#\s*\d+/g, ' ')                // store numbers (#1234)
    .replace(/\bstore\s*\d+/g, ' ')          // "store 9"
    .replace(/\b\d{2,}\b/g, ' ')             // long numeric tokens / ids
    .replace(/\b(llc|inc|incorporated|corp|company|ltd)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')            // punctuation
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

/**
 * Curated brand alias map. The first entry whose pattern matches the
 * base-normalized string wins, folding all its variants into one canonical
 * display name. Extend freely as new merchant spellings show up — order
 * matters only when patterns could overlap (more specific first).
 */
const VENDOR_ALIASES = [
  { canonical: 'Amazon',        match: /\b(amazon|amzn|amz)\b/ },
  { canonical: 'Walmart',       match: /\b(wal\s*mart|walmart|wm super\w*)\b/ },
  { canonical: 'Target',        match: /\btarget\b/ },
  { canonical: 'Costco',        match: /\bcostco\b/ },
  { canonical: 'Starbucks',     match: /\b(starbucks|sbux)\b/ },
  { canonical: "McDonald's",    match: /\b(mcdonald\w*|mcdonald s|mcd)\b/ },
  { canonical: 'Chick-fil-A',   match: /\b(chick\s*fil\s*a|chickfila)\b/ },
  { canonical: 'DoorDash',      match: /\b(door\s*dash|doordash)\b/ },
  { canonical: 'Uber Eats',     match: /\buber\s*eats\b/ },
  { canonical: 'Uber',          match: /\buber\b/ },
  { canonical: 'Lyft',          match: /\blyft\b/ },
  { canonical: 'Instacart',     match: /\binstacart\b/ },
  { canonical: 'Netflix',       match: /\bnetflix\b/ },
  { canonical: 'Spotify',       match: /\bspotify\b/ },
  { canonical: 'Hulu',          match: /\bhulu\b/ },
  { canonical: 'Disney+',       match: /\b(disney\s*plus|disneyplus|disney\+)\b/ },
  { canonical: 'Apple',         match: /\b(apple|itunes|appl)\b/ },
  { canonical: 'Google',        match: /\b(google|googl)\b/ },
  { canonical: 'Microsoft',     match: /\b(microsoft|msft|msbill)\b/ },
  { canonical: 'PayPal',        match: /\bpaypal\b/ },
  { canonical: 'Venmo',         match: /\bvenmo\b/ },
  { canonical: 'Cash App',      match: /\b(cash\s*app|cashapp|sq cash)\b/ },
  { canonical: 'Zelle',         match: /\bzelle\b/ },
  { canonical: 'Home Depot',    match: /\b(home\s*depot|homedepot)\b/ },
  { canonical: "Lowe's",        match: /\b(lowes|lowe s)\b/ },
  { canonical: 'CVS',           match: /\bcvs\b/ },
  { canonical: 'Walgreens',     match: /\bwalgreens\b/ },
  { canonical: 'Kroger',        match: /\bkroger\b/ },
  { canonical: 'Publix',        match: /\bpublix\b/ },
  { canonical: 'Whole Foods',   match: /\bwhole\s*foods\b/ },
  { canonical: "Trader Joe's",  match: /\b(trader\s*joe\w*|trader joe s)\b/ },
  { canonical: 'Chipotle',      match: /\bchipotle\b/ },
  { canonical: 'Shell',         match: /\bshell\b/ },
  { canonical: 'Chevron',       match: /\bchevron\b/ },
  { canonical: 'ExxonMobil',    match: /\b(exxon\w*|mobil)\b/ },
  { canonical: 'Costco Gas',    match: /\bcostco gas\b/ },
];

/**
 * Leading words too short/generic to collapse on by themselves — if a name
 * starts with one of these we keep the first two words so e.g. "First National
 * Bank" and "First Watch" stay distinct.
 */
const GENERIC_FIRST_TOKENS = new Set([
  'first', 'national', 'american', 'america', 'united', 'general', 'family',
  'state', 'home', 'best', 'super', 'quick', 'fast', 'north', 'south', 'east',
  'west', 'central', 'bank', 'store', 'shop', 'premier', 'prime', 'royal',
  'golden', 'blue', 'green', 'star', 'gold', 'city', 'town', 'main', 'new',
  'great', 'big', 'good', 'happy', 'sunny', 'true', 'pro', 'the',
]);

/** Collapses a base-normalized string to its leading brand root. */
function brandRoot(base) {
  const tokens = base.split(' ').filter(Boolean);
  if (tokens.length <= 1) { return base; }
  const first = tokens[0];
  // A distinctive (long, non-generic) first word is treated as the brand;
  // otherwise keep two words for context.
  if (first.length >= 4 && !GENERIC_FIRST_TOKENS.has(first)) {
    return first;
  }
  return tokens.slice(0, 2).join(' ');
}

function titleCase(s) {
  return s
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Raw transaction description -> merged, display-ready merchant name. */
function mergeVendorName(raw) {
  const base = baseNormalize(raw);
  if (!base) { return (raw || 'Unknown').trim() || 'Unknown'; }
  for (const alias of VENDOR_ALIASES) {
    if (alias.match.test(base)) { return alias.canonical; }
  }
  return titleCase(brandRoot(base));
}

/**
 * Raw description -> stable, comparison-friendly merchant key (lowercased,
 * alphanumeric-only) derived from the merged brand. Two variants of the same
 * merchant produce the same key, which is exactly what the categorizer's
 * history-matching/cache-key logic wants.
 */
function merchantMatchKey(raw) {
  return mergeVendorName(raw).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

module.exports = { mergeVendorName, merchantMatchKey };
