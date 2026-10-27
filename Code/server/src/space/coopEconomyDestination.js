"use strict";
// Fleets choose their own delivery station: the one whose real seed BUY orders
// pay the most for the ore actually loaded, capped by the live remaining
// volume. Nothing is pinned here - no station ID, no ore type, no region and no
// destination order. Every number comes from the market book of the region that
// owns the fleet's solar system, and from the ore the system really has.
//
// The ranking is pure so it can be tested without a market or a socket; the
// oracle only adds a small cache in front of the real market daemon.
// Telemetry must never change gameplay: one guarded entry point, same shape.
const load = (name) => {
  try { return require("./" + name); } catch (_error) { return require("./" + name + ".cjs"); }
};
const { observe } = load("coopObserve");
const positive = value => {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 && Number.isSafeInteger(numeric) ? numeric : 0;
};
const money = value => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
};
const bookOf = (books, typeID) => {
  if (!books) return null;
  if (books instanceof Map) return books.get(typeID) || books.get(String(typeID)) || null;
  return books[typeID] || books[String(typeID)] || null;
};

// Total units per ore type in the loaded cargo; module stacks are not ore.
function cargoTotals(cargo = []) {
  const totals = new Map();
  for (const row of cargo || []) {
    if (Number(row?.moduleID || 0) !== 0) continue;
    const typeID = positive(row?.typeID);
    const quantity = positive(row?.quantity);
    if (!typeID || !quantity) continue;
    totals.set(typeID, (totals.get(typeID) || 0) + quantity);
  }
  return totals;
}

// Best real buyer of one type at one station. A huge price with no remaining
// volume cannot win, because only `vol_remaining` can actually be filled.
function bestBuyAt(book, stationID) {
  let best = null;
  for (const order of (book && book.buys) || []) {
    if (positive(order?.station_id) !== stationID) continue;
    const price = money(order?.price);
    const fillable = positive(order?.vol_remaining);
    if (!price || !fillable) continue;
    if (!best || price > best.price || (price === best.price && fillable > best.fillable)) {
      best = {
        price,
        fillable,
        orderID: String(order?.order_id || ""),
        systemID: positive(order?.solar_system_id),
      };
    }
  }
  return best;
}

// Pure ranking of candidate stations by expected ISK for this exact cargo.
function rankStations({ cargo = [], candidates = [], books = {} } = {}) {
  const totals = cargoTotals(cargo);
  const totalQuantity = [...totals.values()].reduce((sum, quantity) => sum + quantity, 0);
  const ranked = [];
  for (const candidate of candidates || []) {
    const stationID = positive(candidate?.stationID);
    if (!stationID) continue;
    let revenue = 0;
    let filled = 0;
    let unpriced = 0;
    const types = [];
    for (const [typeID, wanted] of totals) {
      const best = bestBuyAt(bookOf(books, typeID), stationID);
      if (!best) {
        unpriced += wanted;
        continue;
      }
      const take = Math.min(wanted, best.fillable);
      revenue += take * best.price;
      filled += take;
      unpriced += wanted - take;
      types.push({ typeID, price: best.price, taken: take, orderID: best.orderID });
    }
    ranked.push({
      stationID,
      systemID: positive(candidate?.systemID),
      revenue: Math.round(revenue * 100) / 100,
      filled,
      unfilled: totalQuantity - filled,
      unpriced,
      distanceMeters: Number.isFinite(candidate?.distanceMeters) ? candidate.distanceMeters : null,
      types,
    });
  }
  ranked.sort((left, right) =>
    right.revenue - left.revenue ||
    right.filled - left.filled ||
    (left.distanceMeters ?? Number.POSITIVE_INFINITY) - (right.distanceMeters ?? Number.POSITIVE_INFINITY) ||
    left.stationID - right.stationID);
  return { ranked, best: ranked[0] || null, totalQuantity };
}

// Which ore is worth mining here: only types a real buyer pays for, best unit
// price first, then the deepest book. An ore without a buyer is never advised.
function rankOreTypes({ typeIDs = [], books = {} } = {}) {
  const ranked = [];
  for (const typeID of new Set((typeIDs || []).map(positive))) {
    if (!typeID) continue;
    const book = bookOf(books, typeID);
    let best = null;
    for (const order of (book && book.buys) || []) {
      const stationID = positive(order?.station_id);
      const price = money(order?.price);
      const fillable = positive(order?.vol_remaining);
      if (!stationID || !price || !fillable) continue;
      if (!best || price > best.price || (price === best.price && fillable > best.fillable)) {
        best = { price, fillable, stationID, systemID: positive(order?.solar_system_id), orderID: String(order?.order_id || "") };
      }
    }
    if (best) ranked.push({ typeID, ...best });
  }
  ranked.sort((left, right) =>
    right.price - left.price ||
    right.fillable - left.fillable ||
    left.typeID - right.typeID);
  return { ranked, best: ranked[0] || null };
}

// A decision keeps the honest cases apart: CHOSEN (a real buyer pays), HOLD
// (nobody pays for this cargo anywhere in the region) and WARMING (the book is
// not known yet, so no route may claim to be profitable).
function decideDestination({ cargo = [], candidates = [], books = {} } = {}) {
  const totals = cargoTotals(cargo);
  if (!totals.size) return { status: "NO_CARGO", ranked: [], totalQuantity: 0, cargoTypes: [] };
  const ranking = rankStations({ cargo, candidates, books });
  const cargoTypes = [...totals.entries()].map(([typeID, quantity]) => ({ typeID, quantity }));
  if (!ranking.ranked.length) return { status: "NO_NATIVE_NPC_STATION", ...ranking, cargoTypes };
  if (ranking.best.revenue <= 0) return { status: "HOLD_NO_BUYER", ...ranking, cargoTypes };
  return {
    status: "CHOSEN",
    stationID: ranking.best.stationID,
    corporationID: 0,
    revenue: ranking.best.revenue,
    filled: ranking.best.filled,
    unfilled: ranking.best.unfilled,
    ranked: ranking.ranked,
    totalQuantity: ranking.totalQuantity,
    cargoTypes,
  };
}

function createDestinationOracle({ call, getOreTypes, getSystemRegion, clock = () => Date.now(),
  ttlMs = 60000, probe = null, warn = null } = {}) {
  if (typeof call !== "function") throw Error("DESTINATION_ORACLE_CALL_REQUIRED");
  const cache = new Map();
  const inflight = new Set();
  const keyOf = (regionID, typeID) => `${regionID}:${typeID}`;
  const fresh = key => {
    const hit = cache.get(key);
    return hit && !hit.error && clock() - hit.at < ttlMs ? hit : null;
  };
  function booksFor(regionID, typeIDs) {
    const books = new Map();
    const missing = [];
    for (const typeID of new Set((typeIDs || []).map(positive))) {
      if (!typeID) continue;
      const hit = fresh(keyOf(regionID, typeID));
      if (hit) books.set(typeID, hit.book);
      else missing.push(typeID);
    }
    return { books, missing };
  }
  // Refresh is deliberately asynchronous: native fleet code is synchronous and
  // must never await a socket. Until the first reply arrives a route is WARMING.
  function refresh(regionID, typeIDs) {
    const jobs = [];
    for (const typeID of new Set((typeIDs || []).map(positive))) {
      if (!typeID) continue;
      const key = keyOf(regionID, typeID);
      if (fresh(key) || inflight.has(key)) continue;
      inflight.add(key);
      jobs.push(Promise.resolve()
        .then(() => call("GetOrders", { region_id: regionID, type_id: typeID }))
        .then(book => {
          cache.set(key, { at: clock(), book: { buys: Array.isArray(book?.buys) ? book.buys : [] } });
          return true;
        })
        .catch(error => {
          const message = String(error?.message || error).slice(0, 80);
          cache.set(key, { at: clock(), book: null, error: message });
          if (typeof warn === "function") warn(`[CoopEconomyDestination] book ${typeID}@${regionID}: ${message}`);
          return false;
        })
        .finally(() => inflight.delete(key)));
    }
    return Promise.all(jobs);
  }
  function regionFor(systemID) {
    if (typeof getSystemRegion !== "function") return 0;
    try {
      const solar = getSystemRegion(systemID);
      return positive(solar?.regionID);
    } catch {
      return 0;
    }
  }
  function decide({ cargo = [], candidates = [], systemID, regionID = null } = {}) {
    const totals = cargoTotals(cargo);
    if (!totals.size) return { status: "NO_CARGO", ranked: [], totalQuantity: 0, cargoTypes: [] };
    const region = positive(regionID) || regionFor(systemID);
    if (!region) return { status: "NO_REGION", ranked: [], totalQuantity: 0,
      cargoTypes: [...totals.keys()].map(typeID => ({ typeID, quantity: totals.get(typeID) })) };
    const { books, missing } = booksFor(region, [...totals.keys()]);
    if (missing.length) {
      void refresh(region, missing);
      return { status: "WARMING", regionID: region, missing,
        ranked: [], totalQuantity: [...totals.values()].reduce((sum, quantity) => sum + quantity, 0),
        cargoTypes: [...totals.entries()].map(([typeID, quantity]) => ({ typeID, quantity })) };
    }
    const decision = decideDestination({ cargo, candidates, books });
    return { ...decision, regionID: region };
  }
  // The ore this system should prefer: real belt ore crossed with real buyers.
  function preferredOre({ systemID, regionID = null } = {}) {
    const region = positive(regionID) || regionFor(systemID);
    if (!region || typeof getOreTypes !== "function") return { status: "UNAVAILABLE", ranked: [] };
    let typeIDs = [];
    try {
      typeIDs = (getOreTypes(systemID) || [])
        .map(row => positive(row?.typeID ?? row?.oreTypeID ?? row))
        .filter(Boolean);
    } catch {
      return { status: "ORE_INDEX_UNAVAILABLE", ranked: [], regionID: region };
    }
    if (!typeIDs.length) return { status: "NO_SYSTEM_ORE", ranked: [], regionID: region };
    const { books, missing } = booksFor(region, typeIDs);
    if (missing.length) {
      void refresh(region, missing);
      return { status: "WARMING", regionID: region, missing, ranked: [] };
    }
    const ranked = rankOreTypes({ typeIDs, books });
    return { ...ranked, status: ranked.ranked.length ? "RANKED" : "NO_BUYER", regionID: region };
  }
  function observePreferredOre({ systemID, reason = "periodic" } = {}) {
    if (typeof probe?.observe !== "function") return null;
    const ore = preferredOre({ systemID });
    if (ore.status === "WARMING") return ore;
    const best = ore.best || null;
    observe(probe, "living-economy-ore", { systemID }, {
      reason,
      status: ore.status,
      systemID,
      regionID: ore.regionID || 0,
      preferredOreTypeID: best?.typeID || 0,
      price: best?.price || 0,
      fillable: best?.fillable || 0,
      stationID: best?.stationID || 0,
      ranked: ore.ranked.slice(0, 4),
    });
    return ore;
  }
  return { decide, preferredOre, observePreferredOre, refresh, regionFor, cache };
}

module.exports = {
  bestBuyAt,
  cargoTotals,
  createDestinationOracle,
  decideDestination,
  rankOreTypes,
  rankStations,
};
