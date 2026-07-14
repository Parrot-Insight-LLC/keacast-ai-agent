// services/shoppingSuggest.service.js
//
// Smart Price Assist — generates purchase options for a shopping-list item
// (store / brand / product / size / estimated price / confidence) plus item
// normalization, category + taxability suggestion, and an unrealistic-price
// flag. Backed by Azure OpenAI with a strict JSON response contract and a
// Redis cache so repeated lookups ("Milk" in the same region) are free.
//
// PROPOSE-ONLY: output is advisory. The caller (cashflow backend / frontend)
// persists suggestions separately and the user's manual estimate remains the
// source of truth until they explicitly accept an option.

const { queryAzureOpenAI } = require('./openaiService');
const redis = require('./redisService');

const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24h — price estimates go stale slowly
const CACHE_PREFIX = 'shopping:suggest:';

function normalizeName(itemName) {
  return String(itemName || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function cacheKey(itemName, region) {
  const r = region || {};
  return `${CACHE_PREFIX}${normalizeName(itemName)}:${(r.state || '').toUpperCase()}:${r.zip || ''}`;
}

const SYSTEM_PROMPT = `You are a US retail pricing assistant inside a personal-finance app.
Given a shopping list item, return realistic purchase options a shopper would find at major
retailers (Walmart, Target, Kroger, Publix, Costco, Aldi, etc.). Prices are ESTIMATES based on
typical US retail pricing — never claim they are live prices.

Respond ONLY with JSON matching this shape:
{
  "normalizedName": string,          // cleaned-up item name, e.g. "milk" -> "Milk (1 gallon)"
  "category": string,                // one of: general, grocery, medicine, clothing, electronics, household, other
  "isTaxable": boolean,              // typical US treatment (groceries often reduced/exempt)
  "userPriceFlag": string|null,      // if userEstimate provided and clearly unrealistic, one short sentence; else null
  "options": [                       // 3-5 options, best value first
    {
      "store": string,
      "brand": string,
      "product": string,
      "size": string,
      "estimatedPrice": number,      // unit price in USD
      "confidence": number           // 0-1, how typical/reliable this estimate is
    }
  ]
}`;

/**
 * @param {object} params
 * @param {string} params.itemName        item title as the user typed it
 * @param {number} [params.quantity]
 * @param {object} [params.region]        { state?, zip?, city? }
 * @param {number} [params.userEstimate]  the user's current unit-price estimate
 * @returns {Promise<object>} { normalizedName, category, isTaxable, userPriceFlag, options, cached }
 */
async function suggestItemOptions({ itemName, quantity, region, userEstimate }) {
  if (!itemName || !String(itemName).trim()) {
    throw new Error('itemName is required');
  }

  const key = cacheKey(itemName, region);

  // Cache first (region-scoped). userEstimate is intentionally NOT part of the
  // key — the options are the same; only the flag depends on it, so recompute
  // that cheaply against the cached options.
  try {
    const cached = await redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached);
      // Ignore degenerate entries cached before the empty-result guard below
      // existed — fall through and regenerate instead of serving "no
      // options" for the rest of the TTL.
      if (Array.isArray(parsed.options) && parsed.options.length > 0) {
        parsed.cached = true;
        parsed.userPriceFlag = computePriceFlag(parsed.options, userEstimate);
        return parsed;
      }
    }
  } catch (e) {
    console.warn('[shoppingSuggest] cache read failed:', e.message);
  }

  const userParts = [`Item: ${String(itemName).trim()}`];
  if (quantity) userParts.push(`Quantity: ${quantity}`);
  if (region && (region.state || region.zip || region.city)) {
    userParts.push(`Shopper region: ${[region.city, region.state, region.zip].filter(Boolean).join(', ')}`);
  }
  if (userEstimate != null && Number(userEstimate) > 0) {
    userParts.push(`User's own unit-price estimate: $${Number(userEstimate).toFixed(2)}`);
  }

  const data = await queryAzureOpenAI(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userParts.join('\n') }
    ],
    {
      // null (not undefined) — undefined would fall through to the
      // destructuring default in queryAzureOpenAI and attach the full
      // Keacast function-calling layer, letting the model answer with
      // tool_calls (null content) instead of the JSON contract above.
      tools: null,
      tool_choice: undefined,
      temperature: 0.2,
      max_tokens: 900,
      timeout: 20000,
      response_format: { type: 'json_object' }
    }
  );

  const raw = data?.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('Model returned malformed suggestion JSON');
  }

  const result = {
    normalizedName: parsed.normalizedName || String(itemName).trim(),
    category: parsed.category || 'general',
    isTaxable: parsed.isTaxable !== false,
    options: Array.isArray(parsed.options)
      ? parsed.options
          .filter(o => o && Number(o.estimatedPrice) > 0)
          .slice(0, 5)
          .map(o => ({
            store: String(o.store || ''),
            brand: String(o.brand || ''),
            product: String(o.product || ''),
            size: String(o.size || ''),
            estimatedPrice: Math.round(Number(o.estimatedPrice) * 100) / 100,
            confidence: Math.min(1, Math.max(0, Number(o.confidence) || 0.5)),
            source: 'llm'
          }))
      : [],
    cached: false
  };
  result.userPriceFlag = parsed.userPriceFlag || computePriceFlag(result.options, userEstimate);

  // Only cache useful results. Caching an empty option set would pin the
  // degenerate answer to this item+region for the full TTL, making one bad
  // model response look like a permanently broken feature.
  if (result.options.length > 0) {
    try {
      await redis.set(key, JSON.stringify({ ...result, userPriceFlag: null }), 'EX', CACHE_TTL_SECONDS);
    } catch (e) {
      console.warn('[shoppingSuggest] cache write failed:', e.message);
    }
  }

  return result;
}

// Deterministic outlier check: flag when the user's estimate is more than 3x
// (or under a third of) the median suggested price.
function computePriceFlag(options, userEstimate) {
  const est = Number(userEstimate);
  if (!Array.isArray(options) || options.length === 0 || !Number.isFinite(est) || est <= 0) return null;
  const prices = options.map(o => Number(o.estimatedPrice)).filter(p => p > 0).sort((a, b) => a - b);
  if (!prices.length) return null;
  const median = prices[Math.floor(prices.length / 2)];
  if (est > median * 3) {
    return `Your estimate ($${est.toFixed(2)}) looks high — typical prices are around $${median.toFixed(2)}.`;
  }
  if (est < median / 3) {
    return `Your estimate ($${est.toFixed(2)}) looks low — typical prices are around $${median.toFixed(2)}.`;
  }
  return null;
}

module.exports = { suggestItemOptions };
