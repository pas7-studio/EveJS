"use strict";
// M003-L2. The activation adapter: turn one validated shipment into ONE run journal that the
// existing freight engine (coopDistributionRun) already knows how to fly.
//
// This file adds no transport of its own. It reads the world (hull, station, gate, seeded book),
// refuses anything it cannot prove, and hands the record to the engine's own writer. Without
// --apply it writes nothing at all.
//
// Why it is needed: coopDistributionRun only ever advances a run that an operator journaled
// (PLAN -> PLAN_REQUIRED), and nothing validated that journal before it existed.

const INVALID_ARGUMENT = "INVALID_ARGUMENT";
const HULL_UNKNOWN = "HULL_UNKNOWN";
const HULL_NOT_CORP = "HULL_NOT_CORP";
const CAPACITY_UNKNOWN = "CAPACITY_UNKNOWN";
const CARGO_VOLUME_UNKNOWN = "CARGO_VOLUME_UNKNOWN";
const CARGO_UNREADABLE = "CARGO_UNREADABLE";
const OVER_CAPACITY = "OVER_CAPACITY";
const HULL_NOT_IN_ORIGIN_SYSTEM = "HULL_NOT_IN_ORIGIN_SYSTEM";
const ORIGIN_UNKNOWN = "ORIGIN_UNKNOWN";
const DESTINATION_UNKNOWN = "DESTINATION_UNKNOWN";
const NO_ROUTE = "NO_ROUTE";
const NO_BID = "NO_BID";
const PRICE_TOO_LOW = "PRICE_TOO_LOW";
const RUN_EXISTS = "RUN_EXISTS";
const RUN_ACTIVE = "RUN_ACTIVE";
const ENGINE_REFUSED = "ENGINE_REFUSED";

const SHIPMENT_CODE = Object.freeze({
  INVALID_ARGUMENT, HULL_UNKNOWN, HULL_NOT_CORP, CAPACITY_UNKNOWN, CARGO_VOLUME_UNKNOWN,
  CARGO_UNREADABLE, OVER_CAPACITY, HULL_NOT_IN_ORIGIN_SYSTEM, ORIGIN_UNKNOWN, DESTINATION_UNKNOWN,
  NO_ROUTE, NO_BID, PRICE_TOO_LOW, RUN_EXISTS, RUN_ACTIVE, ENGINE_REFUSED,
});

const isPos = (value) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isNum = (value) => typeof value === "number" && Number.isFinite(value);
const isPlain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const round = (value, places) => {
  const factor = Math.pow(10, places);
  return Math.round(value * factor) / factor;
};
const fail = (code, reason) => ({ ok: false, code, reason });

/**
 * Issue one shipment run. Pure apart from the injected `deps.apply`.
 * Every fact is handed in: nothing here opens a file or a database.
 */
function issueShipment(args = {}, deps = {}) {
  const hullID = Number(args.hullID);
  const typeID = Number(args.typeID);
  const quantity = Number(args.quantity);
  const fromStationID = Number(args.fromStationID);
  const toStationID = Number(args.toStationID);
  const price = Number(args.price);
  const corpID = args.corpID === undefined ? 1000129 : Number(args.corpID);
  if (!isPos(hullID) || !isPos(typeID) || !isPos(quantity) || !isPos(fromStationID) ||
    !isPos(toStationID) || !isNum(price) || price <= 0 || !isPos(corpID))
    return fail(INVALID_ARGUMENT, "hullID, typeID, quantity, fromStationID, toStationID, corpID and a positive price are required");
  if (fromStationID === toStationID)
    return fail(INVALID_ARGUMENT, "destination station must differ from the origin");

  // The hull must be a real native entity this corporation really owns.
  const hull = typeof deps.hullOf === "function" ? deps.hullOf(hullID) : null;
  if (!isPlain(hull)) return fail(HULL_UNKNOWN, "no native entity " + hullID);
  if (Number(hull.ownerID) !== corpID)
    return fail(HULL_NOT_CORP, "hull " + hullID + " belongs to " + Number(hull.ownerID) +
      ", not to corporation " + corpID);

  const rawCapacity = typeof deps.capacityOf === "function" ? deps.capacityOf(hull.typeID) : null;
  const capacity = isNum(rawCapacity) ? rawCapacity : NaN;  if (!isNum(capacity) || capacity <= 0)
    return fail(CAPACITY_UNKNOWN, "hull type " + Number(hull.typeID) + " has no known hold");
  const rawVolume = typeof deps.volumeOf === "function" ? deps.volumeOf(typeID) : null;
  const m3PerUnit = isNum(rawVolume) ? rawVolume : NaN;
  if (!isNum(m3PerUnit) || m3PerUnit < 0)
    return fail(CARGO_VOLUME_UNKNOWN, "type " + typeID + " has no known volume");

  let usedM3 = 0;
  const cargoRows = typeof deps.cargoOf === "function" ? deps.cargoOf(hullID) : null;
  if (cargoRows !== null && cargoRows !== undefined && !Array.isArray(cargoRows))
    return fail(CARGO_UNREADABLE, "cargoOf(" + hullID + ") returned " + typeof cargoRows);
  for (const row of cargoRows || []) {
    const unit = Number(typeof deps.volumeOf === "function" ? deps.volumeOf(Number(row.typeID)) : 0);
    usedM3 += Math.max(0, Number(row.quantity) || 0) * (isNum(unit) ? Math.max(0, unit) : 0);
  }
  const loadM3 = round(quantity * m3PerUnit, 3);
  if (usedM3 + loadM3 > capacity)
    return fail(OVER_CAPACITY, "load " + loadM3 + " m3 plus " + round(usedM3, 3) +
      " m3 already aboard exceeds the " + capacity + " m3 hold");

  const origin = typeof deps.stationOf === "function" ? deps.stationOf(fromStationID) : null;
  if (!isPlain(origin) || !isPos(Number(origin.solarSystemID)))
    return fail(ORIGIN_UNKNOWN, "no station " + fromStationID);
  const destination = typeof deps.stationOf === "function" ? deps.stationOf(toStationID) : null;
  if (!isPlain(destination) || !isPos(Number(destination.solarSystemID)))
    return fail(DESTINATION_UNKNOWN, "no station " + toStationID);
  const originSystem = Number(origin.solarSystemID);
  const destinationSystem = Number(destination.solarSystemID);

  if (Number(hull.systemID) !== originSystem)
    return fail(HULL_NOT_IN_ORIGIN_SYSTEM, "hull is in system " + Number(hull.systemID) +
      ", the origin station is in " + originSystem);

  const gate = typeof deps.gateBetween === "function"
    ? deps.gateBetween(originSystem, destinationSystem) : null;
  if (!isPlain(gate)) return fail(NO_ROUTE,
    "no reciprocal gate " + originSystem + " -> " + destinationSystem);

  const bid = typeof deps.bestBid === "function"
    ? deps.bestBid({ stationID: toStationID, typeID }) : null;
  if (!isPlain(bid) || !isNum(Number(bid.volume)) || Number(bid.volume) < quantity ||
    !isNum(Number(bid.price)) || Number(bid.price) <= 0)
    return fail(NO_BID, "no seeded bid at " + toStationID + " for " + quantity + " x " + typeID);
  if (Number(bid.price) < price)
    return fail(PRICE_TOO_LOW, "asked " + price + " but the book bids " + Number(bid.price));

  // One hull, one run: an existing journal is a real trip, not a duplicate slot.
  const existing = typeof deps.readRun === "function" ? deps.readRun(hullID) : null;
  if (existing) {
    if (args.replace !== true)
      return fail(RUN_EXISTS, "hull " + hullID + " already has a run in phase " +
        String(existing.phase));
    if (!["BLOCKED", "DONE"].includes(String(existing.phase)))
      return fail(RUN_ACTIVE, "hull " + hullID + " has an active run in phase " +
        String(existing.phase));
  }

  const now = isNum(Number(args.now)) ? Number(args.now)
    : (typeof deps.now === "function" ? Number(deps.now()) : 0);
  const isk = round(quantity * price, 2);
  const item = { stationID: fromStationID, typeID, quantity, price, m3PerUnit, m3: loadM3, isk };
  const trip = {
    typeID,
    stationID: fromStationID,
    quantity,
    price,
    m3PerUnit,
    m3: loadM3,
    isk,
    items: [item],
    demand: { [String(typeID)]: { price: Number(bid.price), volume: Number(bid.volume) } },
    expectedIsk: isk,
    fromSystemID: originSystem,
    fromStationID,
    toStationID,
    toSystemID: destinationSystem,
    gate,
  };
  const record = {
    version: 1,
    haulerID: hullID,
    phase: "TO_ORIGIN",
    trip,
    cycles: 0,
    trips: 0,
    stops: [{ stationID: fromStationID, items: [{ typeID, quantity }] }],
    stopIndex: 0,
    loadedStops: [],
    fromStationID,
    fromSystemID: originSystem,
    toStationID,
    toSystemID: destinationSystem,
    typeID,
    quantity,
    expectedIsk: isk,
    gate,
    sellCalls: 0,
    isk: 0,
    lastReason: "ISSUED:" + hullID,
    updatedAt: now,
    stopWaits: 0,
    orderAt: 0,
  };

  // No writer injected means DRY RUN: the record is returned and nothing is written anywhere.
  if (typeof deps.apply !== "function") return { ok: true, code: "ISSUED", record, dryRun: true };
  const applied = deps.apply(record);
  if (applied !== true) return fail(ENGINE_REFUSED, "the run engine did not accept the journal");
  return { ok: true, code: "ISSUED", record, dryRun: false };
}

module.exports = { issueShipment, SHIPMENT_CODE };

// ---------------------------------------------------------------------------------------------
// Operator CLI. Everything above is testable without it; the requires below only exist here.
// ---------------------------------------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (name, fallback) => {
    const index = argv.indexOf("--" + name);
    return index === -1 ? fallback : argv[index + 1];
  };
  const apply = argv.includes("--apply");

  try {
    const store = require("../src/space/npc/nativeNpcStore");
    const inventory = require("../src/services/inventory/itemTypeRegistry");
    const worldData = require("../src/space/worldData");
    const runs = require("../src/space/coopDistributionRun");
    const env = process.env;
    const Better = require("better-sqlite3");
    const db = new Better(env.EVEJS_MARKET_DB || "/var/lib/evejs/market/market.sqlite",
      { readonly: true, fileMustExist: true });

    const hullID = Number(arg("hull", 0));
    const stationOf = (stationID) => {
      const row = worldData.getStationByID(Number(stationID));
      return row ? { stationID: Number(row.stationID), solarSystemID: Number(row.solarSystemID),
        stationName: String(row.stationName || "") } : null;
    };
    const deps = {
      hullOf: (id) => {
        const native = store.getNativeEntity(id);
        if (!native) return null;
        return { entityID: Number(native.entityID), typeID: Number(native.shipTypeID || native.typeID),
          ownerID: Number(native.ownerID), systemID: Number(native.systemID),
          itemName: String(native.itemName || "") };
      },
      capacityOf: (typeID) => {
        const type = inventory.resolveItemByTypeID(Number(typeID));
        return type ? Number(type.capacity) : null;
      },
      volumeOf: (typeID) => {
        const type = inventory.resolveItemByTypeID(Number(typeID));
        return type ? Number(type.volume) : null;
      },
      cargoOf: (id) => (store.listNativeCargoForEntity(id) || [])
        .map((row) => ({ typeID: Number(row.typeID), quantity: Number(row.quantity) || 0 })),
      stationOf,
      gateBetween: (fromSystemID, toSystemID) => {
        for (const gate of worldData.getStargatesForSystem(Number(fromSystemID)) || []) {
          if (Number(gate.destinationSolarSystemID) !== Number(toSystemID)) continue;
          return { sourceGateID: Number(gate.itemID), destinationGateID: Number(gate.destinationID),
            sourceSystemID: Number(fromSystemID), destinationSystemID: Number(toSystemID) };
        }
        return null;
      },
      bestBid: ({ stationID, typeID }) => {
        const row = db.prepare("select price, quantity, station_id from seed_buy_orders " +
          "where station_id=? and type_id=? and quantity>0 order by price desc limit 1")
          .get(Number(stationID), Number(typeID));
        return row ? { price: Number(row.price), volume: Number(row.quantity), orderID: null } : null;
      },
      runs: () => runs.list(env),
      readRun: (id) => runs.read(id, env),
      apply: apply ? (record) => runs.write(record, env) && true : undefined,
      now: () => Date.now(),
    };

    const verdict = issueShipment({ hullID, typeID: Number(arg("type", 0)),
      quantity: Number(arg("qty", 0)), fromStationID: Number(arg("from", 0)),
      toStationID: Number(arg("to", 0)), price: Number(arg("price", 0)),
      now: Date.now() }, deps);
    console.log(JSON.stringify({ ...verdict, dryRun: !apply }));
    process.exitCode = verdict.ok ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: "CLI_FAILED",
      reason: String((error && error.message) || error).slice(0, 200), dryRun: !apply }));
    process.exitCode = 1;
  }
}
