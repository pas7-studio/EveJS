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
  TO_DEST: "TO_DEST", SELL: "SELL", RETURN: "RETURN", DONE: "DONE",
  BLOCKED: "BLOCKED",
});
// How close a hull must really be before a station lift or sale is allowed to act. The
// native market refuses a sale beyond 10 km from the PHYSICAL station, so a laxer number here
// only produces NOT_AT_NATIVE_STATION (measured 2026-10-30).
const STATION_RANGE_M = 8000;
// One sale call fills at most the market's own per-order limit, so a loaded hold may need
// several; the count is bounded so a silent market cannot become an endless loop.
const MAX_SELL_CALLS = 6;
// A slow market daemon is not a failed sale: the wait is bounded by time.
const SALE_SETTLE_TIMEOUT_MS = 15 * 60 * 1000;
// How often one beat asks again while the market is still thinking, and how long it waits
// for the answer: the settled result lives for about five seconds.
const SALE_POLL_MS = 2500;
const MAX_POLLS_PER_BEAT = 4;
// Refusals that mean "not yet" rather than "no": the run waits, bounded, instead of stopping.
const SALE_RETRYABLE = new Set(["NOT_AT_NATIVE_STATION", "SALE_TIMEOUT", "MARKET_UNAVAILABLE",
  "COOLDOWN"]);

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
  if (phase === PHASE.RETURN) {
    // Home again: the journal is reset and a fresh trip is planned from the real world.
    if (facts.hullSystemID && facts.hullSystemID === state.returnToSystemID)
      return { action: "REPLAN" };
    const crossed = String(facts.crossingPhase || "");
    if (crossed === "BLOCKED" || crossed === "ABANDONED")
      return { action: "BLOCK", reason: "RETURN_CROSSING_" + crossed };
    // A completed journal from the trip OUT is not a crossing home: only the durable record
    // saying the hull is back home is proof. Measured 2026-10-30: a stale ARRIVED kept the run
    // reporting RETURNED while the hull sat in the buyer system.
    return { action: "RETURN_CROSS", crossingPhase: crossed === "ARRIVED" ? null : (crossed || null) };
  }
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
// How many loads one hull may carry before the run reports and stops. A cycle that never
// ends is indistinguishable from one that is stuck.
const MAX_TRIPS = 5;

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
  // A run in PLAN (a fresh one, or one that just came home) is planned here, once per beat.
  if (!state || String(state.phase || PHASE.PLAN) === PHASE.PLAN) {
    // Nothing planned yet: planning is the authority's job and it must be real.
    if (typeof authorities.planTrip !== "function") return { status: "NO_PLANNER" };
    let trip = null;
    try { trip = authorities.planTrip({ haulerID: id }); }
    catch (error) { trip = { status: "PLAN_THREW", reason: String((error && error.message) || error).slice(0, 80) }; }
    if (!trip || trip.status !== "OK" || !trip.trip) {
      const why = String((trip && (trip.status || trip.reason)) || "NO_TRIP");
      // A second cycle that finds nothing worth shipping is the honest end of the run:
      // leaving it in PLAN would re-ask the market every beat for ever.
      if (num(state && state.trips) > 0 || authorities.recycle === true) {
        const done = { version: 1, haulerID: id, phase: PHASE.DONE, lastReason: why,
          updatedAt: now, trips: num(state && state.trips), isk: num(state && state.isk) };
        write(done, env);
        note(observe, "living-distribution-run", done, { reason: why });
        return { status: "DONE", reason: why };
      }
      return { status: why, planned: planned.action };
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
    hullSystemID: typeof authorities.hullSystemOf === "function"
      ? Number(authorities.hullSystemOf(id)) || 0 : 0,
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
    // "Never ordered" is not "ordered just now": a run starts with no timestamp at all.
    if (num(state.orderAt) > 0 && now - num(state.orderAt) < ORDER_SPACING_MS)
      return { status: "FLYING", state };
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
      systemID: state.fromSystemID,
      // The trip carries the destination bid it was planned for; that is what the lift serves.
      demand: state.demand || (state.trip && state.trip.demand) || null,
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
    // The settled answer is only readable for about five seconds after it lands (the drain
    // polls every 3 s for exactly this reason), so a run that asks once a minute can never
    // see it. Measured 2026-10-30: six calls in an hour, every one PENDING, cargo untouched.
    const wait = typeof authorities.wait === "function" ? authorities.wait
      : (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
    // A hull that drifted away (or was rebuilt out of its scene) cannot sell: measured
    // 2026-10-30 the market answered NOT_AT_NATIVE_STATION while the run believed the hull
    // was at the station because the phase said so. Fly again instead of asking.
    const atStation = typeof authorities.distanceTo === "function"
      ? authorities.distanceTo(state.toStationID, state.toSystemID, id) : null;
    if (Number.isFinite(atStation) && atStation > STATION_RANGE_M) {
      return finish(PHASE.TO_DEST, "NOT_AT_STATION");
    }
    let calls = num(state.sellCalls);
    let isk = num(state.isk);
    let settled = null;
    let lastReason = "PENDING";
    // A hold that is empty is the strongest proof there is: the goods really left the ship.
    const cargoNow = typeof authorities.cargoUnits === "function" ? authorities.cargoUnits(id) : null;
    if (Number.isFinite(cargoNow) && cargoNow === 0 && num(state.quantity) > 0) {
      return finish(PHASE.DONE, "SOLD_VERIFIED_BY_HOLD", { soldAt: now, sellCalls: calls });
    }
    for (let attempt = 0; attempt < MAX_POLLS_PER_BEAT && !settled && calls < MAX_SELL_CALLS;
      attempt += 1) {
      let answer = null;
      try {
        answer = await authorities.sell({ haulerID: id, stationID: state.toStationID,
          systemID: state.toSystemID });
      } catch (error) {
        answer = { status: "SALE_THREW", reason: String((error && error.message) || error).slice(0, 80) };
      }
      const status = String((answer && answer.status) || "SALE_UNKNOWN");
      calls += 1;
      if (status === "SOLD") {
        settled = { status: "SOLD", isk: num(answer && answer.isk) };
        break;
      }
      if (status === "NOT_SOLD") {
        settled = { status: "NOT_SOLD", reason: String((answer && answer.reason) || "") };
        break;
      }
      if (status === "SALE_THREW") { lastReason = String((answer && answer.reason) || status); break; }
      // PENDING: the job is running. Give it a moment and read the settlement directly.
      await wait(SALE_POLL_MS);
      const proof = typeof authorities.saleSettlement === "function"
        ? authorities.saleSettlement(id, state.toStationID) : null;
      if (proof && proof.status) settled = proof;
      else lastReason = "SALE_PENDING";
    }
    if (settled && settled.status === "SOLD") {
      const paid = isk + num(settled.isk);
      const trips = num(state.trips) + 1;
      const settlement = { quantity: num(settled.quantity), isk: num(settled.isk) };
      // A hull that sits in the buyer system with an empty hold is dead freight: it goes home
      // and takes another load, bounded by a trip count so a cycle cannot run for ever.
      if (authorities.recycle !== true || trips >= MAX_TRIPS) {
        return finish(PHASE.DONE, "SOLD", { isk: paid, sellCalls: calls, soldAt: now,
          trips, settlement });
      }
      return finish(PHASE.RETURN, "SOLD_RETURNING", { isk: paid, sellCalls: 0, trips,
        settlement, soldAt: now, pendingSince: 0, crossAt: 0,
        returnToSystemID: pos(state.fromSystemID), returnStationID: pos(state.fromStationID) });
    }
    if (settled && settled.status === "NOT_SOLD") {
      const why = String(settled.reason || "").slice(0, 50);
      // A refusal that only says "not yet" is not an answer: the hull is being rebuilt,
      // the market daemon is away, or the visit timed out. Those retry; a real refusal stops.
      const retryable = SALE_RETRYABLE.has(String(settled.reason || ""));
      if (!retryable) {
        return finish(PHASE.BLOCKED, "SALE_NOT_SOLD:" + why, { sellCalls: calls, isk });
      }
      const since = num(state.pendingSince) || now;
      if (now - since > SALE_SETTLE_TIMEOUT_MS) {
        return finish(PHASE.BLOCKED, "SALE_NOT_SOLD:" + why, { sellCalls: calls, isk });
      }
      const next = write({ ...state, phase: PHASE.SELL, pendingSince: since,
        sellCalls: calls, isk, lastReason: "WAITING_FOR_SALE:" + why, updatedAt: now }, env);
      return { status: "WAITING_FOR_SALE", reason: why, state: next };
    }
    if (calls >= MAX_SELL_CALLS) {
      return finish(PHASE.BLOCKED, "SALE_STOPPED:CALL_LIMIT", { sellCalls: calls, isk });
    }
    const since = num(state.pendingSince) || now;
    if (now - since > SALE_SETTLE_TIMEOUT_MS) {
      return finish(PHASE.BLOCKED, "SALE_SETTLE_TIMEOUT", { pendingSince: since, sellCalls: calls });
    }
    const next = write({ ...state, phase: PHASE.SELL, pendingSince: since,
      sellCalls: calls, isk, lastReason, updatedAt: now }, env);
    note(observe, "living-distribution-run", next, { reason: lastReason });
    return { status: "SALE_PENDING", reason: lastReason, state: next };
  }

  if (step.action === "REPLAN") {
    // The next beat plans a new trip; only the identity of the run survives.
    const fresh = { version: 1, haulerID: id, phase: PHASE.PLAN, updatedAt: now,
      trips: num(state.trips), isk: num(state.isk), lastReason: "HOME_AGAIN" };
    write(fresh, env);
    note(observe, "living-distribution-run", fresh, { reason: "HOME_AGAIN" });
    return { status: "REPLANNING", state: fresh };
  }
  if (step.action === "RETURN_CROSS") {
    if (num(state.crossAt) > 0 && now - num(state.crossAt) < ORDER_SPACING_MS)
      return { status: "RETURNING", state };
    let plannedCrossing = null;
    try {
      plannedCrossing = typeof authorities.planCrossingTo === "function"
        ? authorities.planCrossingTo({haulerID: id, targetSystemID: state.returnToSystemID,
          operatorKind: authorities.operatorKind}) : null;
    } catch (_error) { plannedCrossing = null; }
    const plannedOk = Boolean(plannedCrossing && (plannedCrossing.status === "PLANNED" ||
      plannedCrossing.status === "ALREADY_PENDING"));
    const reason = plannedOk ? "RETURN_CROSSING_PLANNED"
      : "RETURN_NO_GATE:" + String((plannedCrossing && (plannedCrossing.status || plannedCrossing.reason)) || "UNPLANNED");
    const next = write({ ...state, crossAt: now, lastReason: reason, updatedAt: now }, env);
    note(observe, "living-distribution-run", next, { reason });
    return { status: plannedOk ? "RETURN_CROSSING" : "RETURN_NO_GATE", reason, state: next };
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
module.exports = { PHASE, MAX_TRIPS, STATION_RANGE_M, MAX_SELL_CALLS, SALE_SETTLE_TIMEOUT_MS,
  SALE_POLL_MS, MAX_POLLS_PER_BEAT, SALE_RETRYABLE, ORDER_SPACING_MS, root, fileFor,
  read, write, list, decide, worthIt, note, tick, tickAll };
