"use strict";
// One owner per record. A mining fleet retreat (a real pirate attack, a depleted
// belt, an operator order) warps EVERY hull back to the fleet's off-grid warp
// origin, 2-4 AU from the belt. A hauler that is flying an acknowledged station
// trip is not the retreat's to move: pulling it home destroys a route that already
// has a durable departure ack, so the arrival gate can never pass and the fleet
// sits in "loaded" until the deadline and never mines again. Measured live: fleet
// 960004609's haulers were 190 173 736 005 m from their own trip's station while
// the trip was still live.
//
// The trip's own logic re-flies such a hull with the same native warp, so the
// retreat simply leaves it alone. Default OFF.
const noted = new Map();
const NOTE_THROTTLE_MS = 120_000;

function inLiveTrip(fleetRecord, entityID) {
  const trip = fleetRecord && fleetRecord.coopStationArrival;
  const id = Number(entityID) || 0;
  if (!trip || !trip.haulers || typeof trip.haulers !== "object" || !(id > 0)) return false;
  if (!Object.prototype.hasOwnProperty.call(trip.haulers, String(id))) return false;
  // A trip without its durable departure witness is not live: it is exactly the
  // state the journal now closes, so the retreat may move that hull.
  return trip.manifestID ? true : false;
}
function skip(fleetRecord, entityID) {
  if (process.env.EVEJS_COOP_MINING_TRIP_RETREAT_GUARD !== "1") return false;
  if (!inLiveTrip(fleetRecord, entityID)) return false;
  const now = Date.now();
  const key = String(Number(fleetRecord && fleetRecord.fleetID) || 0) + ":" + String(Number(entityID) || 0);
  if (now - (noted.get(key) || 0) >= NOTE_THROTTLE_MS) {
    noted.set(key, now);
    try {
      require("./coopRuntimeProbe").observe("living-mining-retreat-skip", null,
        { spaceState: { systemID: Number(fleetRecord && fleetRecord.systemID) || 0 } },
        {
          fleetID: Number(fleetRecord && fleetRecord.fleetID) || 0,
          haulerID: Number(entityID) || 0,
          manifestID: String(fleetRecord.coopStationArrival.manifestID || ""),
          reason: "ACTIVE_STATION_TRIP_OWNS_THIS_HULL",
        });
    } catch (_error) { /* telemetry must never block a retreat */ }
  }
  return true;
}
function reset() { noted.clear(); }

// The stock retreat ignores its own warp result, so a fleet whose hulls are
// really held by a warp point looked exactly like a fleet that retreated. The
// returned refusal is published (throttled) so "the prey could not leave" is a
// measured fact, not an assumption. Never decides anything: observation only.
function noteWarp(fleetRecord, entityID, result) {
  if (!result || result.success === true) return false;
  const reason = String(result.errorMsg || "WARP_REFUSED").slice(0, 40);
  const fleetID = Number(fleetRecord && fleetRecord.fleetID) || 0;
  const hullID = Number(entityID) || 0;
  const now = Date.now();
  const key = fleetID + ":" + hullID + ":" + reason;
  if (now - (noted.get(key) || 0) < NOTE_THROTTLE_MS) return false;
  noted.set(key, now);
  try {
    require("./coopRuntimeProbe").observe("living-mining-retreat-refused", null,
      { spaceState: { systemID: Number(fleetRecord && fleetRecord.systemID) || 0 } },
      { status: "REFUSED", reason, fleetID, hullID });
  } catch (_error) { /* telemetry must never block a retreat */ }
  return true;
}

// The stock retreat discards its own warp result, so a fleet whose hulls are
// really held by a warp point looked exactly like a fleet that retreated. This
// reads the same gate the stock warp uses (`isEntityWarpScrambled`) for every
// hull in the retreat and publishes the verdict (throttled). Observation only:
// it never moves, orders or decides anything.
function noteRetreatHeld(fleetRecord, scene, entityIDs, authorities = null) {
  if (!scene || typeof scene.getEntityByID !== "function") return false;
  const injected = authorities && typeof authorities === "object" ? authorities : {};
  let scrambled = injected.hostile || null;
  if (!scrambled) {
    try { scrambled = require("./modules/hostileModuleRuntime"); } catch (_error) { return false; }
  }
  const held = [];
  for (const rawID of Array.isArray(entityIDs) ? entityIDs : []) {
    const entity = scene.getEntityByID(Number(rawID) || 0);
    if (!entity) continue;
    let verdict = false;
    try { verdict = scrambled.isEntityWarpScrambled(entity) === true; } catch (_error) { verdict = false; }
    if (!verdict) continue;
    let status = 0;
    try { status = Number(scrambled.getEntityWarpScrambleStatus(entity)) || 0; } catch (_error) { status = 0; }
    held.push({ hullID: Number(rawID) || 0, status });
  }
  if (!held.length) return false;
  const fleetID = Number(fleetRecord && fleetRecord.fleetID) || 0;
  const now = Date.now();
  const key = fleetID + ":held:" + held.length;
  if (now - (noted.get(key) || 0) < NOTE_THROTTLE_MS) return false;
  noted.set(key, now);
  const probe = injected.probe || null;
  const detail = {
    status: "HELD_BY_WARP_POINT", fleetID, heldCount: held.length, hulls: held.slice(0, 4),
  };
  const scope = { spaceState: { systemID: Number(fleetRecord && fleetRecord.systemID) || 0 } };
  try {
    if (probe && typeof probe.observe === "function") probe.observe("living-mining-retreat-held", null, scope, detail);
    else require("./coopRuntimeProbe").observe("living-mining-retreat-held", null, scope, detail);
  } catch (_error) { /* telemetry must never block a retreat */ }
  return true;
}

module.exports = { skip, inLiveTrip, noteWarp, noteRetreatHeld, reset };
