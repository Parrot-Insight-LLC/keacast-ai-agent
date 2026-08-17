'use strict';

// Canonical Keacast cadence labels. 2 = Once. Keep this the only mapping.
function frequencyLabel(freq) {
  const f = Number(freq);
  if (f === 1) return 'daily';
  if (f === 7) return 'weekly';
  if (f === 14) return 'bi-weekly';
  if (f === 15 || f === 16) return 'semi-monthly';
  if (f >= 28 && f <= 31) return 'monthly';
  if (f >= 59 && f <= 62) return 'bi-monthly';
  if (f === 91) return 'quarterly';
  if (f === 182 || f === 183) return 'semi-annually';
  if (f === 365 || f === 366) return 'annually';
  return 'one-time';
}

module.exports = { frequencyLabel };
