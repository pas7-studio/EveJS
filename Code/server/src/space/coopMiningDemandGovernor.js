"use strict";
/**
 * Mining demand governor.
 *
 * The loop is mechanically complete: ore is mined, hauled, sold, refined, the
 * minerals are lifted back into a hull and sold again. What it cannot do on its
 * own is invent a buyer. Measured live: the corporation held ~4.0M units of
 * ore/minerals while the whole region still paid for ~35k units, so every further
 * cycle only grew a stock nobody can buy.
 *
 * This governor makes production follow real demand instead of outrunning it:
 *
 *   - stock  = what this corporation really holds in hangars right now;
 *   - demand = the seeded bids that still have volume on the very stations where
 *              that stock sits (a remote bid cannot buy it);
 *   - while stock is within `factor` x demand (plus a small floor), mining runs;
 *   - above that the fleet's mining tick is skipped, and at most one trickle
 *     window per `trickleMs` is let through so the world keeps a heartbeat.
 *
 * It never creates, moves or sells anything. Both numbers are measured; the only
 * decision is whether the next mining tick may run. Default OFF.
 */

const HANGAR = 4;
const pos = (value) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
const qtyOf = (row) =>
  Number(row && row.singleton) === 1 ? 1
    : pos(row && (row.quantity !== undefined ? row.quantity : row.stacksize));

// Stock that this corporation really owns in a hangar, grouped per station/type.
function stockRows(rows, {ownerID} = {}) {
  const owner = pos(ownerID);
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    if (owner && pos(row.ownerID) !== owner) continue;
    if (Number(row.flagID === undefined ? HANGAR : row.flagID) !== HANGAR) continue;
    const stationID = pos(row.locationID);
    const typeID = pos(row.typeID);
    const quantity = qtyOf(row);
    if (!stationID || !typeID || !quantity) continue;
    const key = stationID + ":" + typeID;
    const at = groups.get(key) || {stationID, typeID, quantity: 0};
    at.quantity += quantity;
    groups.set(key, at);
  }
  return [...groups.values()];
}

// Bids that can actually pay for this exact stock where it sits. Books are keyed
// "typeID:regionID"; a station in another region simply has no local buyer here.
function demandUnits(stock, books) {
  let total = 0;
  for (const row of Array.isArray(stock) ? stock : []) {
    const buys = (books && books[String(pos(row.typeID)) + ":" + String(pos(row.regionID))]) || [];
    for (const bid of Array.isArray(buys) ? buys : []) {
      if (!bid || String(bid.source || "").toLowerCase() !== "seed") continue;
      if (pos(bid.station_id) !== pos(row.stationID)) continue;
      if (pos(bid.type_id) !== pos(row.typeID)) continue;
      total += Math.max(0, Math.floor(num(bid.vol_remaining)));
    }
  }
  return total;
}

// The work stack runs the same world five times faster (EVEJS_COOP_TIME_SCALE=5).
// A policy interval has to follow that factor, or a "15 minute" trickle pause would
// become 75 accelerated minutes and the proof would crawl. Pure and tested.
function scaledTrickleMs(baseMs, {scale = 1} = {}) {
  const base = Math.max(1000, num(baseMs) || 0);
  const factor = Math.min(10, Math.max(1, num(scale) || 1));
  return Math.round(base / factor);
}

// Pure decision, so the policy can be tested without a server.
function decide({stock = 0, demand = 0, lastTrickleAt = 0, now = 0,
  factor = 1.5, floorUnits = 20000, trickleMs = 15 * 60 * 1000} = {}) {
  const held = Math.max(0, num(stock));
  const wanted = Math.max(0, num(demand));
  const allowance = Math.max(Math.max(0, num(floorUnits)), wanted * Math.max(0, num(factor)));
  if (held <= allowance) return {action: "ALLOW", reason: "WITHIN_DEMAND", held, wanted, allowance};
  const trickleAt = num(lastTrickleAt);
  if (!trickleAt || num(now) - trickleAt >= Math.max(1000, num(trickleMs)))
    return {action: "TRICKLE", reason: "OVERSTOCK_TRICKLE", held, wanted, allowance};
  return {action: "HOLD", reason: "OVERSTOCK", held, wanted, allowance};
}

function createGovernor({items, market, getStation, corpID,
  clock = () => Date.now(), cacheMs = 5 * 60 * 1000, factor = 1.5,
  floorUnits = 20000, trickleMs = 15 * 60 * 1000, typesCap = 60,
  probe = null, prefetch = null} = {}) {
  let cache = null;
  const trickles = new Map();
  const notes = new Map();

  function note(reason, detail) {
    const now = clock();
    if (now - (notes.get(reason) || 0) < 5 * 60 * 1000) return;
    notes.set(reason, now);
    try {
      // The probe signature is (event, session, ship, extra): the system has to
      // travel as a ship-like record or the event ends up with systemID:null.
      probe?.observe("living-mining-demand-governor", null,
        {spaceState: {systemID: pos(detail && detail.systemID)}},
        {...(detail || {}), status: reason});
    } catch (_error) { /* telemetry never decides */ }
  }

  function measure(now) {
    if (cache && now - cache.at < cacheMs) return cache;
    let stock = [];
    try {
      const answer = items.listOwnedItems(corpID, {locationID: undefined});
      const rows = Array.isArray(answer) ? answer : (Array.isArray(answer && answer.data) ? answer.data : []);
      stock = stockRows(rows, {ownerID: corpID}).map((row) => {
        const station = getStation(pos(row.stationID)) || {};
        return {...row, regionID: pos(station.regionID)};
      });
    } catch (_error) {
      cache = {at: now, error: "STOCK_UNREADABLE", stock: [], stockUnits: 0, demand: null};
      return cache;
    }
    // Books are supplied by the caller (a promise-based market needs prefetching).
    // No book yet means demand is UNKNOWN, not zero - an unread book must never
    // stop the world's mining. The same holds for a PARTIAL book: deciding on the
    // types that happen to be loaded understates demand and throttles a healthy
    // economy (measured: HOLD on the work stack while 25k/90k bids existed).
    const books = typeof market?.books === "function" ? market.books() : {};
    const known = new Set(Object.keys(books || {})
      .filter((key) => books[key] !== undefined));
    const keys = new Set(stock.map((row) => String(row.typeID) + ":" + String(row.regionID)));
    const totalUnits = stock.reduce((sum, row) => sum + pos(row.quantity), 0);
    const knownUnits = stock
      .filter((row) => known.has(String(row.typeID) + ":" + String(row.regionID)))
      .reduce((sum, row) => sum + pos(row.quantity), 0);
    const coverage = totalUnits > 0 ? knownUnits / totalUnits : 1;
    const have = totalUnits === 0
      ? known.size > 0
      : coverage >= 0.9;
    cache = {at: have ? now : now - Math.max(0, cacheMs - 15000), stock,
      stockUnits: totalUnits,
      demand: have ? demandUnits(stock, books) : null,
      coverage: Math.round(coverage * 100) / 100,
      booksKnown: [...keys].filter((key) => known.has(key)).length,
      booksWanted: keys.size};
    return cache;
  }

  // Called at the very top of the native mining tick. `true` means: skip it.
  function hold(scene, fleet) {
    const now = clock();
    try { prefetch?.(); } catch (_error) { /* prefetch is best effort */ }
    let measured;
    try {
      measured = measure(now);
    } catch (_error) {
      return false; // an unmeasurable economy never stops stock mining
    }
    const where = {systemID: pos(scene && scene.systemID), fleetID: pos(fleet && fleet.fleetID)};
    if (measured.error) {
      note(measured.error, where);
      return false;
    }
    if (measured.demand === null) {
      note("DEMAND_UNKNOWN", {...where, held: measured.stockUnits});
      return false;
    }
    const key = String(where.systemID) + ":" + String(where.fleetID);
    const decision = decide({stock: measured.stockUnits, demand: measured.demand,
      lastTrickleAt: trickles.get(key) || 0, now, factor, floorUnits, trickleMs});
    if (decision.action === "ALLOW") return false;
    if (decision.action === "TRICKLE") {
      trickles.set(key, now);
      note("TRICKLE_ALLOWED", {...where, held: decision.held, wanted: decision.wanted});
      return false;
    }
    note("HOLD", {...where, held: decision.held, wanted: decision.wanted,
      allowance: decision.allowance});
    return true;
  }

  return {hold, measure, decide, get cache() { return cache; }};
}

// One governor for the whole server process. The market client is a promise-based
// daemon, so the books are fetched in the background and read synchronously here.
let singleton = null;
function serverGovernor() {
  if (singleton) return singleton;
  const items = require("../services/inventory/itemStore");
  const worldData = require("../space/worldData");
  const client = require("../services/market/marketDaemonClient").marketDaemonClient;
  const corpID = Math.max(1, Number(process.env.EVEJS_COOP_FACTORY_CORP_ID || 1000129));
  const refreshMs = Math.max(60000, Number(process.env.EVEJS_COOP_MINING_DEMAND_REFRESH_MS || 5 * 60 * 1000));
  const books = new Map();
  let lastFetchAt = 0, fetching = false;

  const prefetch = () => {
    const now = Date.now();
    if (fetching || now - lastFetchAt < refreshMs) return;
    fetching = true;
    lastFetchAt = now;
    (async () => {
      try {
        let stock = [];
        try {
          const answer = items.listOwnedItems(corpID, {locationID: undefined});
          const rows = Array.isArray(answer) ? answer : (Array.isArray(answer && answer.data) ? answer.data : []);
          stock = stockRows(rows, {ownerID: corpID});
        } catch (_error) { return; }
        const wanted = new Map();
        for (const row of stock) {
          const station = worldData.getStationByID(pos(row.stationID)) || {};
          const regionID = pos(station.regionID);
          if (!regionID) continue;
          wanted.set(String(row.typeID) + ":" + String(regionID), {typeID: pos(row.typeID), regionID});
        }
        for (const [key, pair] of [...wanted].slice(0, 60)) {
          try {
            const book = await client.call("GetOrders", {region_id: pair.regionID, type_id: pair.typeID});
            books.set(key, Array.isArray(book && book.buys) ? book.buys : []);
          } catch (_error) { /* unreadable book stays unknown, never invented */ }
        }
      } finally {
        fetching = false;
      }
    })();
  };

  singleton = createGovernor({
    items, getStation: (id) => worldData.getStationByID(id), corpID,
    factor: Math.max(0, Number(process.env.EVEJS_COOP_MINING_DEMAND_FACTOR || 1.5)),
    floorUnits: Math.max(0, Number(process.env.EVEJS_COOP_MINING_DEMAND_FLOOR || 20000)),
    trickleMs: Math.max(60000, scaledTrickleMs(
      Number(process.env.EVEJS_COOP_MINING_DEMAND_TRICKLE_MS || 900000),
      {scale: Number(process.env.EVEJS_COOP_TIME_SCALE || 1)})),
    cacheMs: refreshMs,
    probe: require("./coopRuntimeProbe"),
    market: {books: () => Object.fromEntries(books)},
    prefetch,
  });
  return singleton;
}

module.exports = {HANGAR, stockRows, demandUnits, scaledTrickleMs, decide, createGovernor,
  serverGovernor};
