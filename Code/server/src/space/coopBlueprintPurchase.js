"use strict";
// Buying a blueprint: the only way the co-op economy can grow new products.
//
// Measured 2026-10-31: the corporation owned 4 blueprints (3 buildable, 1 static-data artifact),
// so its production could never become varied no matter how good the freight was. The seeded
// world DOES have a sell side - seed_stock carries 2 772 blueprints across Jita and New Caldari
// at 10 500-20 000 ISK - and the native trader already supports side:"buy" against seeded asks.
//
// This module is the DECISION, pure: which blueprint to buy, from which station, at what price,
// and why not the others. It never places an order and never moves ISK.
const pos = (x) => (Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : 0);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

const DEFAULT_PRICE_CAP = 500000;
const DEFAULT_BUDGET = 50000000;

/**
 * @param {object} input
 * @param {Array}  input.asks     [{typeID, name, stationID, price, quantity}] blueprints on offer
 * @param {Array}  input.owned    blueprint typeIDs the corporation already owns
 * @param {object} input.demand   {productTypeID: {volume, price}} where the goods really sell
 * @param {object} input.productOf  {blueprintTypeID: productTypeID} recipe map (ready recipes only)
 * @param {number} input.budget   ISK the corporation is willing to spend now
 * @param {number} input.priceCap biggest single price worth paying
 * @param {number} input.maxOwned stop buying once this many extra blueprints were bought
 */
function choose({asks = [], owned = [], demand = {}, productOf = {}, budget = DEFAULT_BUDGET,
  priceCap = DEFAULT_PRICE_CAP, alreadyBought = 0, maxOwned = 3} = {}) {
  const have = new Set((Array.isArray(owned) ? owned : []).map(pos).filter(Boolean));
  const refusals = [];
  if (num(alreadyBought) >= num(maxOwned)) {
    return {status: "ENOUGH", reason: "BLUEPRINT_BUDGET_REACHED", blueprint: null, refusals};
  }
  const candidates = [];
  for (const ask of Array.isArray(asks) ? asks : []) {
    const typeID = pos(ask && ask.typeID);
    const stationID = pos(ask && ask.stationID);
    const price = num(ask && ask.price);
    const quantity = num(ask && ask.quantity);
    if (!typeID || !stationID || price <= 0 || quantity <= 0) continue;
    if (have.has(typeID)) { refusals.push({typeID, reason: "ALREADY_OWNED"}); continue; }
    if (price > num(priceCap)) { refusals.push({typeID, price, reason: "ABOVE_PRICE_CAP"}); continue; }
    if (price > num(budget)) { refusals.push({typeID, price, reason: "ABOVE_BUDGET"}); continue; }
    const productTypeID = pos(productOf[typeID] || productOf[String(typeID)]);
    if (!productTypeID) { refusals.push({typeID, reason: "NO_KNOWN_RECIPE"}); continue; }
    const where = demand[productTypeID] || demand[String(productTypeID)] || null;
    const volume = num(where && where.volume);
    const sellPrice = num(where && where.price);
    if (!(volume > 0) || !(sellPrice > 0)) {
      refusals.push({typeID, productTypeID, reason: "NO_BUYER_FOR_ITS_PRODUCT"});
      continue;
    }
    // Value the blueprint by what its product can earn from the demand that really exists,
    // against the price of the blueprint itself. A cheap blueprint for unsold goods is a loss.
    candidates.push({typeID, stationID, price, quantity,
      name: String((ask && ask.name) || typeID), productTypeID, demandVolume: volume,
      demandPrice: sellPrice, potential: Math.round(volume * sellPrice),
      value: Math.round((volume * sellPrice) / Math.max(1, price) * 100) / 100});
  }
  if (!candidates.length) return {status: "NO_BLUEPRINT_WORTH_BUYING", blueprint: null, refusals};
  candidates.sort((left, right) => right.value - left.value ||
    right.potential - left.potential || left.price - right.price);
  return {status: "BUY", blueprint: candidates[0], alternatives: candidates.slice(1, 3), refusals};
}

module.exports = {choose, DEFAULT_PRICE_CAP, DEFAULT_BUDGET};
