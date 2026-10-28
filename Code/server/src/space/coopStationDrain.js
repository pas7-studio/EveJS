"use strict";
// Drain a station's refined surplus while the demand governor holds mining.
//
// Measured 2026-10-28 on the work stack: after ~14 h in which every sale was
// refused (a market journal was stuck at RPC_CALLING), the corporation owned
// 705 484 units - 442 350 ore and 263 134 minerals - against a demand of 82 502
// and a floor of 200 000. The governor therefore held mining, the miners never
// filled, no haul ever started, and since a sale only happens on a station
// arrival, the surplus could never fall: the throttle froze the very drain it
// depends on.
//
// This module performs that drain with the machinery that already exists: an
// idle hauler flies to the station whose hangar holds the most refined minerals,
// the proven arrival sale lifts that stock into its real native cargo hold and
// sells it against the seeded bids of that station, and the hauler returns to
// the fleet. Nothing is invented: no order, no fill and no ISK is created here,
// and every refusal is reported by the sale path itself.
//
// OFF unless EVEJS_COOP_STATION_DRAIN=1.
const ENABLED = () => String(process.env.EVEJS_COOP_STATION_DRAIN || "") === "1";
const PHASE = "coopDrain";
const MINERAL_CATEGORY = 4; // Tritanium, Pyerite, ... (refinery output)
const ARRIVAL_METERS = 10000; // the market's own station-range for a sale
const CALL_SPACING_MS = 14000; // the lift is async; a second visit sells what it loaded
const MAX_CALLS = 3;

function intervalMs() {
  const value = Number(process.env.EVEJS_COOP_STATION_DRAIN_INTERVAL_MS || 15 * 60 * 1000);
  return Number.isFinite(value) && value >= 60000 ? value : 15 * 60 * 1000;
}

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const pos = (x) => (Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : null);
const dist = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity);

// Which station really holds the most refined minerals for this corporation.
// Pure: takes the ownership rows and the mineral type test so it is testable.
function chooseStation(rows, { corpID = 0, isMineral = () => false } = {}) {
  const totals = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (Number(row?.ownerID) !== Number(corpID)) continue;
    const station = pos(row?.stationID || row?.locationID);
    const quantity = Math.max(0, num(row?.quantity));
    if (!station || quantity <= 0) continue;
    if (!isMineral(Number(row?.typeID))) continue;
    totals.set(station, (totals.get(station) || 0) + quantity);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  return ranked.length ? { stationID: ranked[0][0], units: ranked[0][1], ranked } : null;
}

function note(reason, fleetRecord, payload = {}) {
  try {
    require("./coopRuntimeProbe").observe("living-station-drain", null,
      { spaceState: { systemID: num(fleetRecord && fleetRecord.systemID) } },
      { fleetID: num(fleetRecord && fleetRecord.fleetID), reason, ...payload });
  } catch (_error) { /* telemetry must never stop the drain */ }
}

function stockRows(corpID) {
  const items = require("../services/inventory/itemStore");
  const answer = items.listOwnedItems(corpID, { locationID: undefined });
  const rows = Array.isArray(answer) ? answer : (Array.isArray(answer && answer.data) ? answer.data : []);
  return rows;
}

function isMineralType(typeID) {
  try {
    const type = require("../services/inventory/itemTypeRegistry").resolveItemByTypeID(Number(typeID));
    return Number(type && type.categoryID) === MINERAL_CATEGORY;
  } catch (_error) {
    return false;
  }
}

function stationPoint(scene, stationID) {
  const list = Array.isArray(scene && scene.staticEntities) ? scene.staticEntities : [];
  const station = list.find((x) => x && x.kind === "station" && Number(x.itemID) === Number(stationID));
  return station && station.position ? station.position : null;
}

function active(fleetRecord) {
  const phase = fleetRecord && fleetRecord[PHASE];
  return Boolean(phase && phase.step && phase.step !== "done");
}

// Called at the top of the mining tick while a drain is in flight, so mining work
// and the drain never fight over the same hauler.
function tick(scene, fleetRecord, now) {
  if (!ENABLED() || !scene || !fleetRecord) return false;
  const state = fleetRecord[PHASE];
  if (!state || !state.step) return false;
  const hauler = scene.getEntityByID ? scene.getEntityByID(num(state.haulerID)) : null;
  if (!hauler) {
    fleetRecord[PHASE] = null;
    note("HAULER_MISSING", fleetRecord, { haulerID: num(state.haulerID) });
    return false;
  }
  if (state.step === "travel") {
    const point = stationPoint(scene, state.stationID);
    if (!point) {
      fleetRecord[PHASE] = null;
      note("STATION_NOT_PHYSICAL", fleetRecord, { stationID: num(state.stationID) });
      return false;
    }
    const warping = String(hauler.mode || "").toUpperCase() === "WARP" || hauler.pendingWarp || hauler.warpState;
    if (warping) return true;
    if (dist(hauler.position, point) > ARRIVAL_METERS) {
      // Re-fly a stalled trip, but never restart a warp that is already running.
      if (now - num(state.warpIssuedAtMs) > 120000) {
        state.warpIssuedAtMs = now;
        try {
          require("./npc/npcRuntime").warpToPoint(num(state.haulerID), point,
            { forceImmediateStart: true, broadcastWarpStartToVisibleSessions: true });
        } catch (_error) { /* the next retry reports again */ }
      }
      return true;
    }
    state.step = "visit";
    state.calls = 0;
    state.nextCallAtMs = now;
    note("ARRIVED", fleetRecord, { haulerID: num(state.haulerID), stationID: num(state.stationID) });
    return true;
  }
  if (state.step === "visit") {
    if (now < num(state.nextCallAtMs)) return true;
    if (state.calls >= MAX_CALLS) {
      state.step = "back";
      state.warpIssuedAtMs = 0;
      return true;
    }
    state.calls += 1;
    state.nextCallAtMs = now + CALL_SPACING_MS;
    // The proven arrival sale: it lifts the station's refined minerals into this
    // hauler's real native hold and fills them against the seeded bids.
    try {
      const result = require("./coopVirtualWorldRuntime").sellOnArrival({
        systemID: num(scene.systemID),
        stationID: num(state.stationID),
        haulerID: num(state.haulerID),
        types: [],
        scene,
      });
      note("SALE_CALLED", fleetRecord, { call: state.calls,
        status: String((result && (result.status || result.reason)) || "PENDING") });
    } catch (error) {
      note("SALE_THREW", fleetRecord, { call: state.calls,
        reason: String((error && error.message) || error).slice(0, 80) });
    }
    return true;
  }
  if (state.step === "back") {
    const anchor = fleetRecord.originAnchor && fleetRecord.originAnchor.position;
    const warping = String(hauler.mode || "").toUpperCase() === "WARP" || hauler.pendingWarp || hauler.warpState;
    if (warping) return true;
    if (anchor && dist(hauler.position, anchor) > 100000) {
      if (now - num(state.warpIssuedAtMs) > 120000) {
        state.warpIssuedAtMs = now;
        try {
          require("./npc/npcRuntime").warpToPoint(num(state.haulerID), anchor,
            { forceImmediateStart: true, broadcastWarpStartToVisibleSessions: true });
        } catch (_error) { /* retried above */ }
      }
      return true;
    }
    fleetRecord[PHASE] = null;
    fleetRecord.coopDrainNextAtMs = now + intervalMs();
    note("COMPLETE", fleetRecord, { haulerID: num(state.haulerID), stationID: num(state.stationID) });
    return false;
  }
  fleetRecord[PHASE] = null;
  return false;
}

// Start a drain trip if one is due. Returns true when the fleet is now busy with
// it, so the caller can skip the held mining work for this tick.
function start(scene, fleetRecord, now) {
  if (!ENABLED() || !scene || !fleetRecord) return false;
  if (String(fleetRecord.state || "") !== "mining") return false;
  if (active(fleetRecord)) return true;
  if (now < num(fleetRecord.coopDrainNextAtMs)) return false;
  // Drain only what is really overstocked. The governor's own measurement is used
  // (stock the corporation owns, against the same floor), and an unreadable demand
  // falls back to the floor - never to "nothing to do": measured 2026-10-28 the
  // governor reported DEMAND_UNKNOWN with 739 492 units held, so a HOLD-driven
  // trigger never fired at all.
  let decision = null;
  try {
    const governor = require("./coopMiningDemandGovernor").serverGovernor();
    const measured = governor.measure(now) || {};
    const floorUnits = Math.max(0, num(process.env.EVEJS_COOP_MINING_DEMAND_FLOOR) || 20000);
    decision = governor.decide({ stock: num(measured.stockUnits), demand: num(measured.demand),
      floorUnits, now });
  } catch (_error) { return false; }
  if (!decision || decision.action !== "HOLD") {
    // Within demand (or a trickle window): nothing to drain, and a trickle must be
    // allowed to become a haul instead of being spent on a trip to the station.
    fleetRecord.coopDrainNextAtMs = now + intervalMs();
    return false;
  }
  const haulerID = pos((fleetRecord.haulerEntityIDs || [])[0]);
  if (!haulerID) return false;
  const hauler = scene.getEntityByID ? scene.getEntityByID(haulerID) : null;
  if (!hauler) return false;
  if (String(hauler.mode || "").toUpperCase() === "WARP" || hauler.pendingWarp || hauler.warpState) return false;
  const corpID = Math.max(1, num(process.env.EVEJS_COOP_FACTORY_CORP_ID) || 1000129);
  let rows = [];
  try { rows = stockRows(corpID); } catch (_error) { return false; }
  const chosen = chooseStation(rows, { corpID, isMineral: isMineralType });
  if (!chosen) return false;
  const point = stationPoint(scene, chosen.stationID);
  if (!point) return false;
  fleetRecord[PHASE] = { step: "travel", haulerID, stationID: chosen.stationID,
    units: chosen.units, startedAtMs: now, warpIssuedAtMs: 0, calls: 0, nextCallAtMs: 0,
    held: decision.held, allowance: decision.allowance };
  note("STARTED", fleetRecord, { haulerID, stationID: chosen.stationID, units: chosen.units,
    held: decision.held, allowance: decision.allowance });
  try {
    require("./npc/npcRuntime").warpToPoint(haulerID, point,
      { forceImmediateStart: true, broadcastWarpStartToVisibleSessions: true });
    fleetRecord[PHASE].warpIssuedAtMs = now;
  } catch (_error) { /* retried by tick() */ }
  return true;
}

module.exports = { active, start, tick, chooseStation, intervalMs, ENABLED, PHASE };
