"use strict";
// ALIFE-21. What one distribution hull should carry, from where, to where - decided from the
// real hangar rows, the real seeded buy orders and a real reciprocal gate.
//
// The pure decision lives in coopNpcDistribution.js; this module only gathers the facts it
// needs and refuses anything it cannot prove:
//   - the origin must be a station in the hull's own system that really holds the stock;
//   - the destination must be one reciprocal gate away, with a seeded bid for the product at
//     a station in that system (the seeded book is the station's own demand, not our orders);
//   - the trip must pay more than it costs to sit still (the pure planner's own rule).
//
// It reads the market database READ-ONLY: the market daemon is a separate process and its RPC
// timed out live on 2026-10-29, which must never turn a decision into a stall.
const { plan } = require("./coopNpcDistribution");

const pos = (x) => (Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : 0);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

// The stations of a system, taken from the SCENE first: it is the physical truth, and the
// static station table answered zero rows live on 2026-10-30 (measured with listStations()).
function stationRowsOfSystem(worldData, systemID, scene = null) {
  const out = new Map();
  const rows = scene && Array.isArray(scene.staticEntities) ? scene.staticEntities : [];
  for (const row of rows) {
    if (String(row.kind) !== "station") continue;
    const stationID = pos(row.itemID);
    if (!stationID) continue;
    out.set(stationID, row);
  }
  try {
    const all = typeof worldData.listStations === "function" ? worldData.listStations() : [];
    for (const row of all) {
      if (Number(row.solarSystemID) !== Number(systemID)) continue;
      const stationID = pos(row.stationID || row.itemID);
      if (stationID && !out.has(stationID)) out.set(stationID, row);
    }
  } catch (_error) { /* the scene is enough when it has them */ }
  return [...out.entries()].map(([stationID, station]) => ({ stationID, station }));
}

function gateNeighbours(scene, worldData) {
  const out = [];
  const rows = scene && Array.isArray(scene.staticEntities) ? scene.staticEntities : [];
  for (const row of rows) {
    if (String(row.kind) !== "stargate") continue;
    const gate = typeof worldData.getStargateByID === "function"
      ? worldData.getStargateByID(row.itemID) : null;
    const destinationSystemID = pos(gate && gate.destinationSolarSystemID);
    if (!destinationSystemID) continue;
    out.push({ sourceGateID: pos(row.itemID), destinationSystemID,
      destinationGateID: pos(gate && gate.destinationID) });
  }
  return out;
}

/** Every seeded buy order in these systems, grouped by station and type. */
function seededBids(db, systemIDs) {
  const out = new Map();
  if (!db || !Array.isArray(systemIDs) || !systemIDs.length) return out;
  const placeholders = systemIDs.map(() => "?").join(",");
  let rows = [];
  try {
    rows = db.prepare("select solar_system_id, station_id, type_id, price, quantity " +
      "from seed_buy_orders where solar_system_id in (" + placeholders + ") and quantity>0")
      .all(...systemIDs);
  } catch (_error) { return out; }
  for (const row of rows) {
    const stationID = pos(row.station_id);
    const typeID = pos(row.type_id);
    if (!stationID || !typeID) continue;
    const key = stationID;
    if (!out.has(key)) out.set(key, {});
    const books = out.get(key);
    const current = books[typeID] || { price: 0, volume: 0 };
    if (num(row.price) > current.price) current.price = num(row.price);
    current.volume += num(row.quantity);
    books[typeID] = current;
  }
  return out;
}

/**
 * Choose one trip for a hull that is standing somewhere with freight around it.
 * Returns {status:"OK", trip} or {status, reason} - never a trip it cannot pay for.
 */
function planTrip({ haulerID, store, items, inventory, db, worldData, connectedGates,
  scene = null, corpID = 1000129, minIsk = 200000, maxSystems = 6 } = {}) {
  const id = pos(haulerID);
  if (!id) return { status: "INVALID_ARGUMENT" };
  const native = store && typeof store.getNativeEntity === "function" ? store.getNativeEntity(id) : null;
  if (!native) return { status: "HULL_NOT_DURABLE" };
  const systemID = pos(native.systemID);
  if (!systemID) return { status: "HULL_SYSTEM_UNKNOWN" };
  const type = inventory && typeof inventory.resolveItemByTypeID === "function"
    ? inventory.resolveItemByTypeID(pos(native.shipTypeID || native.typeID)) : null;
  const capacityM3 = Math.max(0, num(type && type.capacity));
  if (!capacityM3) return { status: "HOLD_CAPACITY_UNKNOWN" };
  // What is already aboard is not available for the next load: measured 2026-10-30 a hull
  // went back out with 35 629 units still in the hold and planned a full-size trip anyway.
  let usedM3 = 0;
  try {
    for (const row of store.listNativeCargoForEntity(id) || []) {
      const meta = inventory.resolveItemByTypeID(pos(row.typeID)) || {};
      usedM3 += num(row.quantity) * num(meta.volume);
    }
  } catch (_error) { usedM3 = 0; }
  const freeM3 = Math.max(0, capacityM3 - usedM3);
  if (freeM3 < 1) return { status: "HOLD_ALREADY_FULL", systemID };

  // The corporation's real hangar rows, grouped by the station that holds them.
  let owned = [];
  try {
    const answer = items.listOwnedItems(corpID, { locationID: undefined });
    owned = Array.isArray(answer) ? answer : (Array.isArray(answer && answer.data) ? answer.data : []);
  } catch (_error) { return { status: "HANGAR_UNREADABLE" }; }
  const stations = new Map(stationRowsOfSystem(worldData, systemID, scene)
    .map((row) => [row.stationID, row.station]));
  const stacks = [];
  for (const row of owned) {
    const stationID = pos(row.locationID);
    if (!stationID || !stations.has(stationID)) continue;
    if (Number(row.flagID) !== 4 || !(num(row.quantity) > 0)) continue;
    const typeID = pos(row.typeID);
    const meta = inventory.resolveItemByTypeID(typeID) || {};
    stacks.push({ stationID, typeID, quantity: num(row.quantity),
      m3PerUnit: num(meta.volume) });
  }
  if (!stacks.length) return { status: "NO_STOCK_IN_SYSTEM", systemID };

  const neighbours = gateNeighbours(scene, worldData)
    .filter((row) => row.destinationSystemID && row.destinationSystemID !== systemID);
  if (!neighbours.length) return { status: "NO_GATE_OUT", systemID };
  const targetSystems = [...new Set(neighbours.map((row) => row.destinationSystemID))]
    .slice(0, Math.max(1, num(maxSystems)));
  const bidsByStation = seededBids(db, targetSystems);
  if (!bidsByStation.size) return { status: "NO_BUYER_ONE_GATE_AWAY", systemID };

  let best = null;
  const refusals = [];
  for (const [stationID, bids] of bidsByStation) {
    const stationRow = typeof worldData.getStationByID === "function"
      ? worldData.getStationByID(stationID) : null;
    const destinationSystemID = pos(stationRow && stationRow.solarSystemID);
    if (!destinationSystemID || !targetSystems.includes(destinationSystemID)) continue;
    const gate = typeof connectedGates === "function"
      ? connectedGates({ sourceSystemID: systemID, targetSystemID: destinationSystemID })
      : null;
    if (!gate) { refusals.push({ stationID, reason: "NO_RECIPROCAL_GATE" }); continue; }
    const answer = plan({
      stacks,
      destination: { systemID: destinationSystemID, stationID, bids },
      local: { stationID: 0, bids: {} },
      capacityM3: freeM3, minIsk,
    });
    if (answer && answer.trip) {
      const total = num(answer.trip.quantity) * num(answer.trip.price);
      if (!best || total > best.expectedIsk) {
        const typeID = pos(answer.trip.typeID);
        // What the DESTINATION really bids for the chosen product: the lift serves that,
        // not a local bid that does not exist. Measured 2026-10-30: without this the lift
        // answered NO_LOCAL_BID at a station that bids for none of its own goods.
        best = { ...answer.trip, expectedIsk: total, fromSystemID: systemID,
          fromStationID: pos(answer.trip.stationID),
          demand: { [typeID]: { price: num(answer.trip.price),
            volume: num((bids[typeID] || {}).volume) } },
          toStationID: pos(answer.trip.destinationStationID),
          toSystemID: destinationSystemID, gate: {
            sourceGateID: pos(gate.sourceGateID), destinationGateID: pos(gate.destinationGateID),
            sourceSystemID: systemID, destinationSystemID,
          } };
      }
    } else if (answer && Array.isArray(answer.refusals)) {
      refusals.push(...answer.refusals.slice(0, 3));
    }
  }
  if (!best) return { status: "NO_TRIP_WORTH_TAKING", systemID, refusals: refusals.slice(0, 6) };
  return { status: "OK", trip: best };
}


/**
 * Where the corporation actually holds hangar stock, by system - the answer to "where does this
 * hull have to go to find freight?". Measured 2026-10-30: a distribution hull parked in Jita has
 * nothing to load and the run could only report NO_STOCK_IN_SYSTEM.
 */
function stockSystems({ items, worldData, corpID = 1000129 } = {}) {
  const totals = new Map();
  let owned = [];
  try {
    const answer = items.listOwnedItems(corpID, { locationID: undefined });
    owned = Array.isArray(answer) ? answer : (Array.isArray(answer && answer.data) ? answer.data : []);
  } catch (_error) { return []; }
  for (const row of owned) {
    const stationID = pos(row.locationID);
    if (!stationID || Number(row.flagID) !== 4 || !(num(row.quantity) > 0)) continue;
    const station = worldData.getStationByID(stationID);
    const systemID = pos(station && station.solarSystemID);
    if (!systemID) continue;
    const current = totals.get(systemID) || { systemID, units: 0, stations: 0 };
    current.units += num(row.quantity);
    current.stations += 1;
    totals.set(systemID, current);
  }
  return [...totals.values()].sort((a, b) => b.units - a.units);
}

module.exports = { stockSystems, planTrip, gateNeighbours, seededBids, stationRowsOfSystem };
