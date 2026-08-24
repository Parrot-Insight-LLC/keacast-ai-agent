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

function isExpenseOutflowTotal(claim) {
  const role = claim.semanticRole || '';
  return role === 'upcoming_window_expense_total'
    || role === 'scheduled_expense_total';
}

function isScheduledOrUpcomingTotal(claim) {
  const role = claim.semanticRole || '';
  return role === 'scheduled_expense_total'
    || role === 'scheduled_income_total'
    || role === 'upcoming_window_expense_total'
    || role === 'upcoming_window_income_total'
    || role === 'upcoming_item_count';
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

const MONTH_INDEX = Object.freeze({
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
});

function claimRole(claim) {
  return (claim && (claim.semanticRole || claim.semanticRole)) || '';
}

function isSignedChangeAmountClaim(claim) {
  if (!isUsdClaim(claim)) return false;
  const role = claimRole(claim);
  const path = claim.path || '';
  return role === 'comparison_absolute' || /\.absolute$/.test(path);
}

function isSignedChangePercentClaim(claim) {
  if (!claim || claim.type !== 'PERCENT') return false;
  const role = claimRole(claim);
  const path = claim.path || '';
  return role === 'comparison_percent' || /\.percent$/.test(path);
}

function allowSignedChangeMagnitude(claim, hints) {
  if (hasHint(hints, 'balance')) return false;
  if (isIncomePath(claim)) return hasHint(hints, 'income') && !hasHint(hints, 'expense');
  if (isExpensePath(claim)) return hasHint(hints, 'expense') && !hasHint(hints, 'income');
  return hasHint(hints, 'expense') || hasHint(hints, 'income') || hasHint(hints, 'money');
}

function directionPolarity(token) {
  const t = String(token || '').toLowerCase();
  if (!t) return null;
  if (t === 'decrease' || t === 'decreased' || t === 'decreasing' || t === 'lower'
    || t === 'dropped' || t === 'falling' || t === 'downward' || t === 'fell' || t === 'less'
    || t === 'will decrease' || t === 'will fall' || t === 'expected to decrease') {
    return 'down';
  }
  if (t === 'increase' || t === 'increased' || t === 'increasing' || t === 'higher'
    || t === 'rose' || t === 'rising' || t === 'upward' || t === 'improved'
    || t === 'will increase' || t === 'will rise' || t === 'expected to increase') {
    return 'up';
  }
  return null;
}

function monthFromEntity(entity) {
  const key = String(entity || '').toLowerCase();
  return MONTH_INDEX[key] || null;
}

function itemMonth(item) {
  const parts = itemDateParts(item);
  if (parts) return parts.month;
  const label = labelOf(item);
  const names = Object.keys(MONTH_INDEX);
  for (let i = 0; i < names.length; i += 1) {
    if (label.indexOf(names[i]) !== -1) return MONTH_INDEX[names[i]];
  }
  return null;
}

function periodMonthMatches(hit, entity) {
  if (!hit || hit.listName !== 'periods') return true;
  const month = monthFromEntity(entity);
  if (!month) return true;
  const itemM = itemMonth(hit.item);
  if (itemM == null) return labelOf(hit.item).indexOf(String(entity).toLowerCase()) !== -1;
  return itemM === month;
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
  if (isExpenseOutflowTotal(claim) && c > 0 && !hasHint(hints, 'income')) {
    out.push(-c);
  }
  if (isSignedChangeAmountClaim(claim) && allowSignedChangeMagnitude(claim, hints)) {
    const flipped = -c;
    if (out.indexOf(flipped) === -1) out.push(flipped);
  }
  return out;
}

function itemAuthorizedDisplayCents(item, contract, hints) {
  const amountCents = toCents(typeof item.amount === 'number' ? item.amount : Number(item.amount));
  const out = [];
  if (amountCents != null) {
    out.push(amountCents);
    const signed = contract.signConvention === 'signed_ledger';
    if (signed && amountCents < 0 && !hasHint(hints, 'income')) {
      out.push(-amountCents);
    }
  }
  const monthlyCents = toCents(
    typeof item.monthlyEquivalent === 'number' ? item.monthlyEquivalent : Number(item.monthlyEquivalent)
  );
  if (monthlyCents != null && out.indexOf(monthlyCents) === -1) out.push(monthlyCents);
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

function hitKey(hit) {
  return String(hit.listName) + ':' + String(hit.item && hit.item.itemId);
}

function spanDistance(aStart, bStart) {
  if (bStart > aStart) return bStart - aStart;
  return aStart - bStart;
}

function extractedDateMonth(d) {
  if (d && d.month) return d.month;
  if (d && d.iso && /^\d{4}-\d{2}-\d{2}$/.test(d.iso)) return Number(d.iso.slice(5, 7));
  return null;
}

function pickClosestDateClaim(row, extracted) {
  const entityMonth = monthFromEntity(row && row.entity);
  const scored = [];
  for (let i = 0; i < extracted.length; i += 1) {
    const d = extracted[i];
    if (!d || d.kind !== CLAIM_KIND.DATE) continue;
    const dist = spanDistance(row.start || 0, d.start || 0);
    if (dist > 72) continue;
    scored.push({
      date: d,
      dist,
      preceding: (d.end || d.start || 0) <= (row.start || 0),
      month: extractedDateMonth(d),
    });
  }
  if (!scored.length) return null;
  function bestOf(rows) {
    let best = rows[0];
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i].dist < best.dist) best = rows[i];
      else if (rows[i].dist === best.dist && rows[i].preceding && !best.preceding) best = rows[i];
    }
    return best.date;
  }
  if (entityMonth) {
    const same = [];
    for (let i = 0; i < scored.length; i += 1) {
      if (scored[i].month === entityMonth) same.push(scored[i]);
    }
    if (same.length) return bestOf(same);
  }
  return bestOf(scored);
}

function closestDateForAmount(row, extracted) {
  const best = pickClosestDateClaim(row, extracted);
  if (best) {
    return {
      dateIso: best.iso || null,
      iso: best.iso || null,
      dateMonth: best.month,
      dateDay: best.day,
      month: best.month,
      day: best.day,
      kind: CLAIM_KIND.DATE,
    };
  }
  if (row.dateIso || (row.dateMonth && row.dateDay)) {
    return {
      dateIso: row.dateIso || null,
      iso: row.dateIso || null,
      dateMonth: row.dateMonth,
      dateDay: row.dateDay,
      month: row.dateMonth,
      day: row.dateDay,
      kind: CLAIM_KIND.DATE,
    };
  }
  return null;
}

function extractedHasDate(dateFields) {
  if (!dateFields) return false;
  if (dateFields.dateIso || dateFields.iso) return true;
  if (dateFields.dateMonth && dateFields.dateDay) return true;
  if (dateFields.month && dateFields.day) return true;
  return false;
}

function entityConflictsWithOtherItem(boundHit, entity, items) {
  if (!entity || !boundHit) return false;
  if (labelOf(boundHit.item) === entity) return false;
  for (let i = 0; i < items.length; i += 1) {
    if (hitKey(items[i]) === hitKey(boundHit)) continue;
    if (labelOf(items[i].item) === entity) return true;
  }
  return false;
}

function exactEntityHits(hits, entity) {
  const out = [];
  if (!entity) return out;
  for (let i = 0; i < hits.length; i += 1) {
    if (labelOf(hits[i].item) === entity) out.push(hits[i]);
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
      const roleDelta = hasHint(hints, 'delta');
      const rolePeriodValue = hasHint(hints, 'period_value') && !roleDelta;
      let matches = [];
      for (let c = 0; c < usdClaims.length; c += 1) {
        const claim = usdClaims[c];
        const options = authorizedDisplayCents(claim, contract, hints);
        if (options.indexOf(cents) !== -1) matches.push(claim);
      }

      const amountCandidates = [];
      for (let k = 0; k < items.length; k += 1) {
        const item = items[k].item;
        const options = itemAuthorizedDisplayCents(item, contract, hints);
        if (options.indexOf(cents) !== -1) amountCandidates.push(items[k]);
      }

      if (roleDelta) {
        const deltaMatches = [];
        for (let c = 0; c < matches.length; c += 1) {
          if (isSignedChangeAmountClaim(matches[c])) deltaMatches.push(matches[c]);
        }
        matches = deltaMatches;
        amountCandidates.length = 0;
      } else if (rolePeriodValue) {
        const periodMatches = [];
        for (let c = 0; c < matches.length; c += 1) {
          if (!isSignedChangeAmountClaim(matches[c])) periodMatches.push(matches[c]);
        }
        matches = periodMatches;
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

      const dateFields = closestDateForAmount(row, extracted);
      const hasDate = extractedHasDate(dateFields);
      if (hasDate) dateCheck = dateCheck === 'skipped' ? 'valid' : dateCheck;

      let listDecision = null;
      let boundHit = null;
      if (amountCandidates.length === 0) {
        listDecision = null;
      } else if (hasDate) {
        const tupleCandidates = [];
        for (let t = 0; t < amountCandidates.length; t += 1) {
          if (dateMatches(amountCandidates[t].item, dateFields)) tupleCandidates.push(amountCandidates[t]);
        }
        if (tupleCandidates.length === 1) {
          if (entityConflictsWithOtherItem(tupleCandidates[0], entity, items)) {
            listDecision = 'mismatch';
          } else {
            listDecision = 'match';
            boundHit = tupleCandidates[0];
          }
        } else if (tupleCandidates.length > 1) {
          const entHits = exactEntityHits(tupleCandidates, entity);
          if (entHits.length === 1) {
            listDecision = 'match';
            boundHit = entHits[0];
          } else {
            listDecision = 'indeterminate';
          }
        } else {
          listDecision = 'mismatch';
        }
      } else if (amountCandidates.length === 1) {
        if (entityConflictsWithOtherItem(amountCandidates[0], entity, items)
          || !periodMonthMatches(amountCandidates[0], entity)) {
          listDecision = 'mismatch';
        } else {
          listDecision = 'match';
          boundHit = amountCandidates[0];
        }
      } else {
        const entHits = exactEntityHits(amountCandidates, entity)
          .filter((hit) => periodMonthMatches(hit, entity));
        if (entHits.length === 1) {
          listDecision = 'match';
          boundHit = entHits[0];
        } else if (monthFromEntity(entity) && amountCandidates.some((hit) => hit.listName === 'periods')) {
          listDecision = 'mismatch';
        } else {
          listDecision = 'indeterminate';
        }
      }

      const listBound = listDecision === 'match' && boundHit != null;

      let periodIdentityFailed = false;
      if (monthFromEntity(entity) && items.some((hit) => hit.listName === 'periods')) {
        if (listBound && !periodMonthMatches(boundHit, entity)) periodIdentityFailed = true;
        if (!listBound) {
          const monthHits = amountCandidates.filter((hit) => periodMonthMatches(hit, entity));
          if (monthHits.length === 0 && amountCandidates.some((hit) => hit.listName === 'periods')) {
            periodIdentityFailed = true;
          }
        }
      }
      if (periodIdentityFailed) {
        addViolation(
          VIOLATION_CODE.LIST_ITEM_MISMATCH,
          SEVERITY.HIGH,
          row,
          null,
          'period_identity_mismatch'
        );
        bindingCheck = 'invalid';
        continue;
      }

      if (listDecision === 'mismatch' && matches.length === 0) {
        addViolation(
          VIOLATION_CODE.LIST_ITEM_MISMATCH,
          SEVERITY.HIGH,
          row,
          null,
          hasDate ? 'tuple_unmatched' : 'entity_conflict'
        );
        bindingCheck = 'invalid';
        continue;
      }

      if (listDecision === 'indeterminate' && matches.length === 0) {
        addIndeterminate(VIOLATION_CODE.LIST_ITEM_MISMATCH, row, MATCH_RESULT.AMBIGUOUS);
        amountCheck = amountCheck === 'invalid' ? 'invalid' : 'indeterminate';
        bindingCheck = bindingCheck === 'invalid' ? 'invalid' : 'indeterminate';
        continue;
      }

      const authorized = matches.length > 0 || listBound;

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
      const skipFutureForScheduled = listBound
        || (matches.length > 0 && matches.every(isScheduledOrUpcomingTotal));
      if (future && matches.length && !skipFutureForScheduled) {
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
      if (future && !matches.length && !listBound) {
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
    } else if (row.kind === CLAIM_KIND.PERCENT) {
      const hints = row.semanticHints || [];
      const extractedPct = Number(row.normalizedValue);
      const percentClaims = (contract.allowedClaims || []).filter((c) => c.type === 'PERCENT'
        && (c.unit === 'percent' || c.unit == null));
      let percentMatched = false;
      for (let p = 0; p < percentClaims.length; p += 1) {
        const claim = percentClaims[p];
        const authorizedPct = Number(claim.value);
        if (!Number.isFinite(extractedPct) || !Number.isFinite(authorizedPct)) continue;
        if (authorizedPct === extractedPct) {
          percentMatched = true;
          break;
        }
        if (isSignedChangePercentClaim(claim)
          && allowSignedChangeMagnitude(claim, hints)
          && authorizedPct === -extractedPct) {
          percentMatched = true;
          break;
        }
      }
      if (!percentMatched) {
        addViolation(
          VIOLATION_CODE.UNSUPPORTED_COMPARISON,
          SEVERITY.CRITICAL,
          row,
          null,
          'percent_not_in_ledger'
        );
        amountCheck = 'invalid';
      }
    } else if (row.kind === CLAIM_KIND.UNKNOWN_NUMERIC) {
      addIndeterminate('AMBIGUOUS_NUMERIC', row, 'insufficient_money_context');
    } else if (row.kind === CLAIM_KIND.DIRECTION) {
      const dirClaims = (contract.allowedClaims || []).filter((c) => c.type === 'DIRECTION');
      if (!dirClaims.length) {
        addIndeterminate(VIOLATION_CODE.UNAUTHORIZED_DIRECTION, row, 'no_direction_claim');
      } else {
        const hints = row.semanticHints || [];
        const extractedPol = directionPolarity(row.token || row.rawSpan);
        if (!extractedPol) {
          addIndeterminate(VIOLATION_CODE.UNAUTHORIZED_DIRECTION, row, 'unparsed_direction');
        } else {
          let candidates = dirClaims;
          if (hasHint(hints, 'expense') && !hasHint(hints, 'income')) {
            const exp = dirClaims.filter(isExpensePath);
            if (exp.length) candidates = exp;
          } else if (hasHint(hints, 'income') && !hasHint(hints, 'expense')) {
            const inc = dirClaims.filter(isIncomePath);
            if (inc.length) candidates = inc;
          }
          const polarMatch = candidates.some((c) => directionPolarity(c.value) === extractedPol);
          if (!polarMatch) {
            addViolation(
              VIOLATION_CODE.UNAUTHORIZED_DIRECTION,
              SEVERITY.HIGH,
              row,
              null,
              'direction_polarity_mismatch'
            );
            bindingCheck = 'invalid';
          }
        }
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
