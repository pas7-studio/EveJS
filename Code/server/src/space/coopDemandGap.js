"use strict";
// What the corporation could sell but cannot build.
//
// Measured 2026-10-30: the freight hulls fill their holds (310 000 - 543 000 units a trip) and
// the corporation owns three buildable blueprints, while the buyer system carries 4 144 products
// of real demand worth 170 060 631 095 ISK that nobody here can make. Logistics stopped being the
// constraint; production became it. A ceiling nobody names looks exactly like a healthy loop, so
// the manufacturer reports it in its own event.
//
// Pure data in, pure answer out: no market calls, no writes.
const pos = (x) => (Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : 0);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

// Categories a real industry can produce in this world: ships, modules, charges, drones,
// subsystems. Blueprints, crates and PLEX live outside them.
const PRODUCIBLE = new Set([6, 7, 8, 18, 32]);

/**
 * @param {object} input
 * @param {object} input.db            read-only market handle (seed_buy_orders)
 * @param {Array}  input.systemIDs     systems the corporation can reach
 * @param {Array}  input.blueprints    blueprint typeIDs the corporation owns
 * @param {Function} input.recipeOf    (blueprintTypeID) -> {status, productTypeID} | null
 * @param {Function} input.resolveType (typeID) -> {name, categoryID}
 * @param {number} input.limit         how many gap products to name
 * @param {number} input.maxPrice      ignore seeded artifacts above this price
 */
function gap({ db, systemIDs = [], blueprints = [], recipeOf = null, resolveType = null,
  limit = 5, maxPrice = 50000000 } = {}) {
  const systems = [...new Set((Array.isArray(systemIDs) ? systemIDs : []).map(pos).filter(Boolean))];
  const owned = [...new Set((Array.isArray(blueprints) ? blueprints : []).map(pos).filter(Boolean))];
  const buildable = new Map();
  for (const blueprintTypeID of owned) {
    let plan = null;
    try { plan = typeof recipeOf === "function" ? recipeOf(blueprintTypeID) : null; }
    catch (_error) { plan = null; }
    if (plan && plan.status === "READY") buildable.set(pos(plan.productTypeID), blueprintTypeID);
  }
  const answer = {ownedBlueprints: owned.length, buildable: buildable.size, gap: [],
    gapValue: 0, systems};
  if (!db || !systems.length) return {...answer, status: "NO_BOOK"};
  let rows = [];
  const placeholders = systems.map(() => "?").join(",");
  try {
    rows = db.prepare("select type_id, sum(quantity) as volume, max(price) as price " +
      "from seed_buy_orders where solar_system_id in (" + placeholders + ") and quantity>0 " +
      "group by type_id").all(...systems);
  } catch (_error) { return {...answer, status: "BOOK_UNREADABLE"}; }
  const ranked = [];
  for (const row of rows) {
    const typeID = pos(row.type_id);
    const price = num(row.price);
    const volume = num(row.volume);
    if (!typeID || volume <= 0 || price <= 0 || price > num(maxPrice)) continue;
    if (buildable.has(typeID)) continue;
    const meta = typeof resolveType === "function" ? (resolveType(typeID) || {}) : {};
    if (!PRODUCIBLE.has(Number(meta.categoryID))) continue;
    ranked.push({typeID, name: String(meta.name || typeID), volume, price,
      value: Math.round(volume * price)});
  }
  ranked.sort((left, right) => right.value - left.value);
  answer.gap = ranked.slice(0, Math.max(1, num(limit) || 5));
  answer.gapValue = ranked.reduce((sum, row) => sum + row.value, 0);
  answer.status = ranked.length ? "GAP" : "NO_GAP";
  return answer;
}

module.exports = {gap, PRODUCIBLE};
