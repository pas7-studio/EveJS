"use strict";
// ALIFE-21. One real distribution trip, end to end.
//
// The pieces already existed and were proven separately: the lift moves a hangar stack into a
// hauler's native hold (journal + receipt), the gate crossing moves that same durable hull to
// another system (SAME_NATIVE_SHIP_ARRIVED), and the arrival sale fills the seeded bids. What
// was missing is the RUN: nothing ever loaded a hull, so a "distribution" flight carried air.
//
// This module owns exactly one trip per hull, durably:
//   PLAN -> TO_ORIGIN -> LOAD -> CROSS -> TO_DEST -> SELL -> DONE
// and it stops with a reason the moment the world disagrees, because a trip that invents a
// step is worse than a trip that reports why it could not take it.
//
// Every step is somebody else's authority: the lift is coopNpcMineralLift, the crossing is
// coopNpcGateCrossing (and behind it the native transfer), the sale is sellOnArrival. This
// module only decides the order and remembers where the run is.
const fs = require("fs");
const path = require("path");

const PHASE = Object.freeze({
  PLAN: "PLAN", TO_ORIGIN: "TO_ORIGIN", LOAD: "LOAD", CROSS: "CROSS",
  TO_DEST: "TO_DEST", SELL: "SELL", DONE: "DONE", BLOCKED: "BLOCKED",
});
// How close a hull must really be before a station lift or sale is allowed to act.
const STATION_RANGE_M = 15000;
// One sale call fills at most the market's own per-order limit, so a loaded hold may need
// several; the count is bounded so a silent market cannot become an endless loop.
const MAX_SELL_CALLS = 6;

function num(x) { return Number.isFinite(Number(x)) ? Number(x) : 0; }
const phase2 = (value) => String(value || PHASE.TO_ORIGIN);
function pos(x) { const v = num(x); return Number.isSafeInteger(v) && v > 0 ? v : 0; }

function root(env = process.env) {
  return path.join(String(env.EVEJS_COOP_NPC_MARKET_ROOT || env.EVEJS_COOP_NPC_MARKET_DIR ||
    "/var/lib/evejs/coop-native-market"), "distribution-run");
}
function fileFor(haulerID, env = process.env) {
  return path.join(root(env), String(pos(haulerID)) + ".json");
}
function read(haulerID, env = process.env) {
  try { return JSON.parse(fs.readFileSync(fileFor(haulerID, env), "utf8")); }
  catch (_error) { return null; }
}
function write(state, env = process.env) {
  const file = fileFor(state.haulerID, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(state, null, 1), "utf8");
  const fd = fs.openSync(temp, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  return state;
}
function list(env = process.env) {
  try {
    return fs.readdirSync(root(env)).filter((n) => /\.json$/.test(n))
      .map((n) => { try { return JSON.parse(fs.readFileSync(path.join(root(env), n), "utf8")); }
        catch (_error) { return null; } }).filter(Boolean);
  } catch (_error) { return []; }
}

/**
 * The next thing this run may do. Pure: every fact is handed in, nothing is inferred.
 * A run never advances on hope - a missing fact is a WAIT, an impossible one is BLOCKED.
 */
function decide(state, facts = {}) {
  if (!state) return { action: "PLAN" };
  const phase = String(state.phase || PHASE.PLAN);
  if (phase === PHASE.DONE) return { action: "IDLE", reason: "DONE" };
  if (phase === PHASE.BLOCKED) return { action: "IDLE", reason: state.lastReason || "BLOCKED" };
  if (phase === PHASE.PLAN) return { action: "PLAN" };
  if (phase === PHASE.TO_ORIGIN) {
    const d = facts.distanceToOriginM;
    if (Number.isFinite(d) && d <= STATION_RANGE_M) return { action: "LIFT" };
    return { action: "GO_ORIGIN" };
  }
  if (phase === PHASE.LOAD) return { action: "LIFT" };
  if (phase === PHASE.CROSS) {
    const crossed = String(facts.crossingPhase || "");
    if (crossed === "ARRIVED") return { action: "TO_DEST" };
    if (crossed === "BLOCKED" || crossed === "ABANDONED")
      return { action: "BLOCK", reason: "CROSSING_" + crossed };
    return { action: "WAIT", reason: "CROSSING_" + (crossed || "UNPLANNED") };
  }
  if (phase === PHASE.TO_DEST) {
    const d = facts.distanceToDestinationM;
    if (Number.isFinite(d) && d <= STATION_RANGE_M) return { action: "SELL" };
    return { action: "GO_DEST" };
  }
  if (phase === PHASE.SELL) return { action: "SELL" };
  return { action: "BLOCK", reason: "UNKNOWN_PHASE:" + phase };
}

/** A trip is worth taking only when the destination really pays more than the origin. */
function worthIt(trip, minIsk = 200000) {
  const revenue = num(trip && trip.expectedIsk);
  return revenue >= Math.max(0, num(minIsk));
}

function note(observe, event, state, extra = {}) {
  try {
    if (typeof observe === "function") observe(event, null, null, {
      haulerID: pos(state && state.haulerID), phase: String((state && state.phase) || ""),
      ...extra,
    });
  } catch (_error) { /* telemetry only */ }
}

// How often the same order may be re-issued while a hull flies to a station.
const ORDER_SPACING_MS = 45000;

/**
 * Advance one run by at most one step. Never throws, never guesses: an authority that is
 * missing is a WAIT, and a step that failed is written down with its reason.
 */
async function tick(haulerID, authorities = {}, env = process.env) {
  const id = pos(haulerID);
  if (!id) return { status: "INVALID_ARGUMENT" };
  const now = num(authorities.now) || Date.now();
  const observe = authorities.observe || null;
  let state = read(id, env);
  const planned = decide(state, {});
  if (!state) {
    // Nothing planned yet: planning is the authority's job and it must be real.
    if (typeof authorities.planTrip !== "function") return { status: "NO_PLANNER" };
    let trip = null;
    try { trip = authorities.planTrip({ haulerID: id }); }
    catch (error) { trip = { status: "PLAN_THREW", reason: String((error && error.message) || error).slice(0, 80) }; }
    if (!trip || trip.status !== "OK" || !trip.trip) {
      return { status: String((trip && (trip.status || trip.reason)) || "NO_TRIP"), planned: planned.action };
    }
    const row = trip.trip;
    if (!worthIt(row, authorities.minIsk) && authorities.allowSmallTrips !== true) {
      const refused = { version: 1, haulerID: id, phase: PHASE.BLOCKED,
        lastReason: "TRIP_DOES_NOT_PAY:" + num(row.expectedIsk), updatedAt: now,
        trip: row };
      write(refused, env);
      note(observe, "living-distribution-run", refused, { reason: refused.lastReason });
      return { status: "BLOCKED", reason: refused.lastReason };
    }
    state = write({ version: 1, haulerID: id, phase: PHASE.TO_ORIGIN, trip: row,
      // The pure planner calls the origin simply stationID; one name, one meaning.
      fromStationID: pos(row.fromStationID) || pos(row.stationID),
      fromSystemID: pos(row.fromSystemID),
      toStationID: pos(row.toStationID), toSystemID: pos(row.toSystemID),
      typeID: pos(row.typeID), quantity: num(row.quantity), expectedIsk: num(row.expectedIsk),
      gate: row.gate || null, sellCalls: 0, isk: 0, lastReason: "PLANNED", updatedAt: now }, env);
    note(observe, "living-distribution-run", state, { reason: state.lastReason });
    return { status: "PLANNED", state };
  }

  // A durable hull can outlive its scene (a restart rebuilds it). Bringing the same ship
  // back from its own record is the narrow road; anything else stays undispatched.
  if (typeof authorities.ensureLive === "function") {
    let live = false;
    try { live = authorities.ensureLive(id) === true; } catch (_error) { live = false; }
    if (!live) {
      const misses = num(state.liveMisses) + 1;
      const phase = misses >= 5 ? PHASE.BLOCKED : phase2(state.phase);
      const next = write({ ...state, liveMisses: misses, phase,
        lastReason: misses >= 5 ? "HULL_NOT_LIVE" : "WAITING_FOR_HULL",
        updatedAt: now }, env);
      note(observe, "living-distribution-run", next, { reason: next.lastReason });
      return { status: next.lastReason, state: next };
    }
    if (num(state.liveMisses) > 0) state = write({ ...state, liveMisses: 0 }, env);
  }
  const facts = {
    distanceToOriginM: typeof authorities.distanceTo === "function"
      ? authorities.distanceTo(state.fromStationID, state.fromSystemID, id) : null,
    distanceToDestinationM: typeof authorities.distanceTo === "function"
      ? authorities.distanceTo(state.toStationID, state.toSystemID, id) : null,
    crossingPhase: typeof authorities.crossingPhase === "function"
      ? authorities.crossingPhase(id) : null,
  };
  const step = decide(state, facts);
  const finish = (phase, reason, extra = {}) => {
    const next = write({ ...state, ...extra, phase, lastReason: reason, updatedAt: now }, env);
    note(observe, "living-distribution-run", next, { reason });
    return { status: phase, reason, state: next };
  };

  if (step.action === "BLOCK") return finish(PHASE.BLOCKED, String(step.reason || "BLOCKED"));
  if (step.action === "WAIT") return { status: "WAITING", reason: step.reason, state };
  if (step.action === "PLAN") return { status: "PLAN_REQUIRED" };

  if (step.action === "GO_ORIGIN" || step.action === "GO_DEST") {
    const stationID = step.action === "GO_ORIGIN" ? state.fromStationID : state.toStationID;
    if (now - num(state.orderAt) < ORDER_SPACING_MS) return { status: "FLYING", state };
    let issued = false;
    try { issued = typeof authorities.goTo === "function" && authorities.goTo(stationID, id) === true; }
    catch (_error) { issued = false; }
    const reason = issued ? (step.action === "GO_ORIGIN" ? "FLYING_TO_ORIGIN" : "FLYING_TO_DESTINATION")
      : "ORDER_REFUSED";
    const next = write({ ...state, orderAt: now, lastReason: reason, updatedAt: now }, env);
    note(observe, "living-distribution-run", next, { reason });
    return { status: issued ? "ORDERED" : "ORDER_REFUSED", reason, state: next };
  }

  if (step.action === "LIFT") {
    if (typeof authorities.lift !== "function") return { status: "NO_LIFT" };
    let answer = null;
    try { answer = await authorities.lift({ haulerID: id, stationID: state.fromStationID,
      systemID: state.fromSystemID, demand: state.demand || null,
      cap: state.quantity || authorities.capacityM3 || 1e6 }); }
    catch (error) { answer = { status: "LIFT_THREW", reason: String((error && error.message) || error).slice(0, 80) }; }
    const status = String((answer && answer.status) || "LIFT_UNKNOWN");
    if (status !== "LIFTED") return finish(PHASE.BLOCKED, status);
    const lifted = Array.isArray(answer.lifted) ? answer.lifted : [];
    const quantity = lifted.reduce((sum, row) => sum + num(row.quantity), 0);
    // The crossing is planned by the loop's own gate machinery, not by this module.
    let crossing = null;
    try {
      crossing = typeof authorities.planCrossing === "function"
        ? authorities.planCrossing({ haulerID: id, gate: state.gate }) : null;
    } catch (error) { crossing = { status: "CROSSING_PLAN_THREW" }; }
    const plannedOk = Boolean(crossing && (crossing.status === "PLANNED" ||
      crossing.status === "ALREADY_PENDING"));
    if (!plannedOk) {
      return finish(PHASE.BLOCKED, "CROSSING_" + String((crossing && (crossing.status || crossing.reason)) || "UNPLANNED"),
        { lifted, quantity });
    }
    return finish(PHASE.CROSS, "LOADED", { lifted, quantity,
      loadedAt: now, cargoUnits: quantity });
  }

  if (step.action === "TO_DEST") return finish(PHASE.TO_DEST, "CROSSED");

  if (step.action === "SELL") {
    if (typeof authorities.sell !== "function") return { status: "NO_SELL" };
    // The bound is on REAL calls: at most this many, then the run reports what it got.
    if (num(state.sellCalls) >= MAX_SELL_CALLS)
      return finish(PHASE.BLOCKED, "SALE_STOPPED:CALL_LIMIT", { sellCalls: num(state.sellCalls) });
    let answer = null;
    try { answer = await authorities.sell({ haulerID: id, stationID: state.toStationID,
      systemID: state.toSystemID }); }
    catch (error) { answer = { status: "SALE_THREW", reason: String((error && error.message) || error).slice(0, 80) }; }
    const status = String((answer && answer.status) || "SALE_UNKNOWN");
    const isk = num(answer && answer.isk);
    const calls = num(state.sellCalls) + 1;
    if (status === "SOLD") {
      return finish(PHASE.DONE, "SOLD", { isk: num(state.isk) + isk, sellCalls: calls,
        soldAt: now });
    }
    if (status === "PENDING" && calls <= MAX_SELL_CALLS) {
      const next = write({ ...state, sellCalls: calls, isk: num(state.isk) + isk,
        lastReason: "SALE_PENDING", updatedAt: now }, env);
      return { status: "SALE_PENDING", state: next };
    }
    if (status === "NOT_SOLD" && calls <= MAX_SELL_CALLS) {
      // The market refused this visit: retry only while the bound allows it, honestly.
      const next = write({ ...state, sellCalls: calls, isk: num(state.isk) + isk,
        lastReason: "SALE_NOT_SOLD:" + String((answer && answer.reason) || "").slice(0, 40),
        updatedAt: now }, env);
      return { status: "SALE_NOT_SOLD", state: next };
    }
    return finish(PHASE.BLOCKED, status === "SOLD" ? "SOLD"
      : "SALE_STOPPED:" + String((answer && (answer.reason || answer.lastStatus)) || status).slice(0, 50),
      { sellCalls: calls, isk: num(state.isk) + isk });
  }

  return { status: "IDLE", reason: step.reason || null, state };
}


/** Advance every distribution hull the world has. One hull, one trip, one truth. */
async function tickAll(authorities = {}, env = process.env) {
  const hulls = typeof authorities.hulls === "function" ? authorities.hulls() : [];
  const results = [];
  for (const haulerID of Array.isArray(hulls) ? hulls : []) {
    try { results.push({ haulerID, ...(await tick(haulerID, authorities, env)) }); }
    catch (error) { results.push({ haulerID, status: "THREW",
      reason: String((error && error.message) || error).slice(0, 90) }); }
  }
  return results;
}
module.exports = { PHASE, STATION_RANGE_M, MAX_SELL_CALLS, ORDER_SPACING_MS, root, fileFor,
  read, write, list, decide, worthIt, note, tick, tickAll };
