'use strict';

/**
 * Phase 3C.1 — bind extracted assistant claims to a ResponseValidationContract.
 *
 * Compare / normalize only. No financial math. No network. No logging.
 * Not wired into production chat.
 */

const {
  VALIDATION_STATUS,
  SEVERITY,
  VIOLATION_CODE,
  MATCH_RESULT,
  LIST_COVERAGE,
} = require('./keaResponseValidationContract');
const { CLAIM_KIND, extractResponseClaims } = require('./keaResponseClaimExtractor');

function toCents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function isUsdClaim(claim) {
  if (!claim) return false;
  if (claim.unit !== 'USD') return false;
  return claim.type === 'AMOUNT' || claim.type === 'TOTAL';
}

function isCountClaim(claim) {
  return claim && claim.type === 'COUNT' && (claim.unit === 'count' || claim.unit == null);
}

function isExpensePath(claim) {
  const role = claim.semanticRole || '';
  const path = claim.path || '';
  return role === 'expense'
    || role === 'upcoming_window_expense_total'
    || role === 'lookup_spent_total'
    || role === 'lookup_expense_total'
    || role === 'scheduled_expense_total'
    || /Expense|expense|spending|spentTotal/.test(path);
}

function isIncomePath(claim) {
  const role = claim.semanticRole || '';
  const path = claim.path || '';
  return role === 'income'
    || role === 'upcoming_window_income_total'
    || role === 'lookup_income_total'
    || role === 'scheduled_income_total'
    || role === 'current_month_income'
    || /Income|income/.test(path);
}

function isCurrentBalancePath(claim) {
  const role = claim.semanticRole || '';
  return role === 'current_available_balance'
    || role === 'current_balance'
    || role === 'current_reconciled_balance';
}

function isMonthScalarPath(claim) {
  const role = claim.semanticRole || '';
  return role === 'current_month_income'
    || role === 'current_month_expenses'
    || role === 'current_month_net';
}

function hasHint(hints, name) {
  return Array.isArray(hints) && hints.indexOf(name) !== -1;
}

function authorizedDisplayCents(claim, contract, hints) {
  const c = toCents(typeof claim.value === 'number' ? claim.value : Number(claim.value));
  if (c == null) return [];
  const out = [c];
  const signed = contract.signConvention === 'signed_ledger';
  if (signed && c < 0 && isExpensePath(claim) && hasHint(hints, 'expense') && !hasHint(hints, 'income')) {
    out.push(-c);
  }
  return out;
}

function itemAuthorizedDisplayCents(item, contract, hints, entityBound) {
  const c = toCents(typeof item.amount === 'number' ? item.amount : Number(item.amount));
  if (c == null) return [];
  const out = [c];
  const signed = contract.signConvention === 'signed_ledger';
  if (signed && c < 0 && !hasHint(hints, 'income') && (hasHint(hints, 'expense') || entityBound)) {
    out.push(-c);
  }
  return out;
}

function labelOf(item) {
  return String(item.label || item.merchant || item.subjectValue || '').trim().toLowerCase();
}

function itemDateParts(item) {
  const iso = String(item.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  return {
    iso,
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10)),
  };
}

function dateMatches(item, extracted) {
  const parts = itemDateParts(item);
  if (!parts) return false;
  if (extracted.dateIso && extracted.dateIso === parts.iso) return true;
  if (extracted.iso && extracted.iso === parts.iso) return true;
  if (extracted.dateMonth && extracted.dateDay) {
    return parts.month === extracted.dateMonth && parts.day === extracted.dateDay;
  }
  if (extracted.month && extracted.day && extracted.kind === CLAIM_KIND.DATE) {
    return parts.month === extracted.month && parts.day === extracted.day;
  }
  return false;
}

function flattenItems(contract) {
  const out = [];
  const lists = contract.allowedListItems || {};
  const names = Object.keys(lists);
  for (let i = 0; i < names.length; i += 1) {
    const rows = lists[names[i]] || [];
    for (let j = 0; j < rows.length; j += 1) {
      out.push({ listName: names[i], item: rows[j] });
    }
  }
  return out;
}

function sortViolations(rows) {
  return rows.slice().sort((a, b) => {
    const pa = a.position != null ? a.position : 0;
    const pb = b.position != null ? b.position : 0;
    if (pa !== pb) return pa - pb;
    return String(a.code).localeCompare(String(b.code));
  });
}

function compatibleAmountMatches(matches) {
  if (matches.length <= 1) return true;
  if (matches.every(isExpensePath)) return true;
  if (matches.every(isIncomePath)) return true;
  if (matches.every(isCurrentBalancePath)) return true;
  if (matches.every((c) => c.path === matches[0].path)) return true;
  return false;
}

function previewUpcoming(contract) {
  return contract.listCoverage && contract.listCoverage.upcoming === LIST_COVERAGE.PREVIEW;
}

function validateResponseClaims({ contract, extractedClaims } = {}) {
  if (!contract || typeof contract !== 'object') {
    return {
      version: 1,
      status: VALIDATION_STATUS.INVALID,
      checks: { amounts: 'invalid', counts: 'skipped', dates: 'skipped', bindings: 'invalid' },
      violations: [{
        code: VIOLATION_CODE.INVALID_CONTRACT,
        severity: SEVERITY.CRITICAL,
        reasonCode: 'missing_contract',
        position: 0,
      }],
      indeterminate: [],
    };
  }

  const extracted = Array.isArray(extractedClaims) ? extractedClaims : [];
  const usdClaims = (contract.allowedClaims || []).filter(isUsdClaim);
  const countClaims = (contract.allowedClaims || []).filter(isCountClaim);
  const hasDirectionClaim = (contract.allowedClaims || []).some((c) => c.type === 'DIRECTION');
  const hasRankingClaim = (contract.allowedClaims || []).some((c) => c.semanticRole === 'ranking');
  const items = flattenItems(contract);

  const violations = [];
  const indeterminate = [];
  let amountCheck = 'skipped';
  let countCheck = 'skipped';
  let dateCheck = 'skipped';
  let bindingCheck = 'skipped';

  function addViolation(code, severity, extractedClaim, evidenceClaimId, reasonCode) {
    violations.push({
      code,
      severity,
      extractedClaimId: extractedClaim ? extractedClaim.id : undefined,
      evidenceClaimId: evidenceClaimId || undefined,
      reasonCode,
      position: extractedClaim && extractedClaim.position != null ? extractedClaim.position : 0,
    });
  }

  function addIndeterminate(code, extractedClaim, reasonCode) {
    indeterminate.push({
      code,
      extractedClaimId: extractedClaim ? extractedClaim.id : undefined,
      reasonCode,
      position: extractedClaim && extractedClaim.position != null ? extractedClaim.position : 0,
    });
  }

  for (let i = 0; i < extracted.length; i += 1) {
    const row = extracted[i];
    if (row.kind === CLAIM_KIND.AMOUNT
      || row.kind === CLAIM_KIND.ENTITY_AMOUNT
      || row.kind === CLAIM_KIND.ENTITY_AMOUNT_DATE) {
      amountCheck = amountCheck === 'skipped' ? 'valid' : amountCheck;
      bindingCheck = bindingCheck === 'skipped' ? 'valid' : bindingCheck;
      const cents = toCents(row.normalizedValue);
      if (cents == null) {
        addIndeterminate('AMBIGUOUS_AMOUNT', row, 'unparsed_amount');
        amountCheck = 'indeterminate';
        continue;
      }
      const hints = row.semanticHints || [];
      const entity = row.entity ? String(row.entity).toLowerCase() : null;
      const matches = [];
      for (let c = 0; c < usdClaims.length; c += 1) {
        const claim = usdClaims[c];
        const options = authorizedDisplayCents(claim, contract, hints);
        if (options.indexOf(cents) !== -1) matches.push(claim);
      }

      const listAmountHits = [];
      const listDateHits = [];
      for (let k = 0; k < items.length; k += 1) {
        const item = items[k].item;
        const entityBound = entity && labelOf(item) === entity;
        const options = itemAuthorizedDisplayCents(item, contract, hints, !!entityBound);
        if (options.indexOf(cents) !== -1 && (!entity || entityBound)) {
          listAmountHits.push(items[k]);
        }
        if (dateMatches(item, row)) listDateHits.push(items[k]);
      }

      if (hasHint(hints, 'income') && !hasHint(hints, 'expense') && matches.length) {
        const incomeMatches = matches.filter(isIncomePath);
        const expenseOnly = matches.length && incomeMatches.length === 0 && matches.every(isExpensePath);
        if (expenseOnly) {
          addViolation(
            VIOLATION_CODE.UNSUPPORTED_AMOUNT,
            SEVERITY.CRITICAL,
            row,
            matches[0].claimId,
            'wrong_sign_semantics'
          );
          amountCheck = 'invalid';
          continue;
        }
      }

      const authorized = matches.length > 0 || (entity && listAmountHits.length > 0);

      if (hasHint(hints, 'derivation') && !authorized) {
        addViolation(
          VIOLATION_CODE.UNSUPPORTED_DERIVATION,
          SEVERITY.CRITICAL,
          row,
          null,
          'unauthorized_derived_amount'
        );
        amountCheck = 'invalid';
        continue;
      }

      if (!authorized) {
        addViolation(
          VIOLATION_CODE.UNSUPPORTED_AMOUNT,
          SEVERITY.CRITICAL,
          row,
          null,
          'amount_not_in_ledger'
        );
        amountCheck = 'invalid';
        continue;
      }

      const future = hasHint(hints, 'future') || hasHint(hints, 'named_future_month');
      if (future && matches.length) {
        const balanceHit = matches.some(isCurrentBalancePath);
        const monthHit = matches.some(isMonthScalarPath);
        if (balanceHit) {
          addViolation(
            VIOLATION_CODE.UNSUPPORTED_FORECAST,
            SEVERITY.CRITICAL,
            row,
            matches[0].claimId,
            MATCH_RESULT.WRONG_SEMANTIC_BINDING
          );
          amountCheck = 'invalid';
          continue;
        }
        if (monthHit || hasHint(hints, 'named_future_month')) {
          addViolation(
            VIOLATION_CODE.UNSUPPORTED_PERIOD_ATTRIBUTION,
            SEVERITY.CRITICAL,
            row,
            matches[0].claimId,
            MATCH_RESULT.WRONG_SEMANTIC_BINDING
          );
          amountCheck = 'invalid';
          continue;
        }
        addIndeterminate(VIOLATION_CODE.UNSUPPORTED_FORECAST, row, 'future_attribution_uncertain');
        amountCheck = amountCheck === 'invalid' ? 'invalid' : 'indeterminate';
        continue;
      }
      if (future && !matches.length) {
        addIndeterminate(VIOLATION_CODE.UNSUPPORTED_FORECAST, row, 'future_attribution_uncertain');
        amountCheck = amountCheck === 'invalid' ? 'invalid' : 'indeterminate';
        continue;
      }

      if (hasHint(hints, 'preview_total') && previewUpcoming(contract)) {
        const windowTotal = matches.some((c) => c.semanticRole === 'upcoming_window_expense_total'
          || c.semanticRole === 'upcoming_window_income_total');
        if (windowTotal) {
          addViolation(
            VIOLATION_CODE.PREVIEW_TOTAL_MISATTRIBUTION,
            SEVERITY.HIGH,
            row,
            matches[0].claimId,
            'preview_list_does_not_establish_total'
          );
          amountCheck = 'invalid';
          continue;
        }
      }

      if (row.kind === CLAIM_KIND.ENTITY_AMOUNT_DATE && entity) {
        dateCheck = dateCheck === 'skipped' ? 'valid' : dateCheck;
        const amountHits = listAmountHits.filter((hit) => labelOf(hit.item) === entity);
        const sameLabelDateHits = listDateHits.filter((hit) => labelOf(hit.item) === entity);
        const both = amountHits.filter((hit) => sameLabelDateHits.some((d) => d.item.itemId === hit.item.itemId));
        if (both.length >= 1) {
          // item identity + amount + date bind; duplicate same-label rows stay distinct
        } else if (amountHits.length && listDateHits.length) {
          addViolation(
            VIOLATION_CODE.LIST_ITEM_MISMATCH,
            SEVERITY.HIGH,
            row,
            null,
            'cross_item_mix'
          );
          bindingCheck = 'invalid';
          continue;
        } else if (row.dateIso || row.dateMonth) {
          addViolation(
            VIOLATION_CODE.LIST_ITEM_MISMATCH,
            SEVERITY.HIGH,
            row,
            null,
            'tuple_unmatched'
          );
          bindingCheck = 'invalid';
          continue;
        }
      }

      if (matches.length > 1 && !hints.length && !compatibleAmountMatches(matches)) {
        addIndeterminate('AMBIGUOUS_PATH', row, MATCH_RESULT.AMBIGUOUS);
        bindingCheck = bindingCheck === 'invalid' ? 'invalid' : 'indeterminate';
      }
    } else if (row.kind === CLAIM_KIND.COUNT) {
      countCheck = countCheck === 'skipped' ? 'valid' : countCheck;
      if (!countClaims.length) {
        addIndeterminate('UNBOUND_COUNT', row, 'no_count_claims');
        countCheck = countCheck === 'invalid' ? 'invalid' : 'indeterminate';
        continue;
      }
      const hit = countClaims.some((c) => Number(c.value) === Number(row.normalizedValue));
      if (!hit) {
        addViolation(
          VIOLATION_CODE.UNSUPPORTED_COUNT,
          SEVERITY.CRITICAL,
          row,
          null,
          'count_mismatch'
        );
        countCheck = 'invalid';
      }
    } else if (row.kind === CLAIM_KIND.UNKNOWN_NUMERIC) {
      addIndeterminate('AMBIGUOUS_NUMERIC', row, 'insufficient_money_context');
    } else if (row.kind === CLAIM_KIND.DIRECTION) {
      if (!hasDirectionClaim) {
        addIndeterminate(VIOLATION_CODE.UNAUTHORIZED_DIRECTION, row, 'no_direction_claim');
      }
    } else if (row.kind === CLAIM_KIND.RANKING_CANDIDATE) {
      if (!hasRankingClaim) {
        addIndeterminate(VIOLATION_CODE.UNSUPPORTED_RANKING, row, 'no_ranking_claim');
      }
    }
  }

  const sortedV = sortViolations(violations);
  const sortedI = sortViolations(indeterminate);
  let status = VALIDATION_STATUS.VALID;
  if (sortedV.length) status = VALIDATION_STATUS.INVALID;
  else if (sortedI.length) status = VALIDATION_STATUS.INDETERMINATE;

  return {
    version: 1,
    status,
    checks: {
      amounts: amountCheck,
      counts: countCheck,
      dates: dateCheck,
      bindings: bindingCheck,
    },
    violations: sortedV.map((v) => ({
      code: v.code,
      severity: v.severity,
      extractedClaimId: v.extractedClaimId,
      evidenceClaimId: v.evidenceClaimId,
      reasonCode: v.reasonCode,
    })),
    indeterminate: sortedI.map((v) => ({
      code: v.code,
      extractedClaimId: v.extractedClaimId,
      reasonCode: v.reasonCode,
    })),
  };
}

function validateResponseAgainstContract({ contract, text } = {}) {
  const extractedClaims = extractResponseClaims(text || '');
  return validateResponseClaims({ contract, extractedClaims });
}

function summarizeValidationResult(result) {
  const violations = (result && Array.isArray(result.violations)) ? result.violations : [];
  const indeterminate = (result && Array.isArray(result.indeterminate)) ? result.indeterminate : [];
  const severityCounts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  const violationCodes = [];
  for (let i = 0; i < violations.length; i += 1) {
    const code = violations[i].code;
    if (violationCodes.indexOf(code) === -1) violationCodes.push(code);
    const sev = violations[i].severity;
    if (severityCounts[sev] != null) severityCounts[sev] += 1;
  }
  violationCodes.sort();
  const indeterminateCodes = [];
  for (let i = 0; i < indeterminate.length; i += 1) {
    const code = indeterminate[i].code;
    if (indeterminateCodes.indexOf(code) === -1) indeterminateCodes.push(code);
  }
  indeterminateCodes.sort();
  return {
    version: 1,
    status: result && result.status ? result.status : VALIDATION_STATUS.INDETERMINATE,
    violationCount: violations.length,
    violationCodes,
    severityCounts,
    indeterminateCount: indeterminate.length,
    indeterminateCodes,
    checks: result && result.checks ? {
      amounts: result.checks.amounts,
      counts: result.checks.counts,
      dates: result.checks.dates,
      bindings: result.checks.bindings,
    } : null,
  };
}

module.exports = {
  validateResponseClaims,
  validateResponseAgainstContract,
  summarizeValidationResult,
};
