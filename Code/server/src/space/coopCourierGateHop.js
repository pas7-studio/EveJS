"use strict";
// Real native stargate hops for a server-driven courier.
//
// One hop is: warp to the reciprocal source gate, issue the stock
// `jumpSessionViaStargate`, then VERIFY the same ship item is in the
// destination scene and gone from the source scene. Nothing here invents a
// system, a position or a jump: a hop that cannot be verified fails.
const EXT = (typeof __filename === "string" && __filename.endsWith(".js")) ? "" : ".cjs";
const motion = require("./coopNativeAgentMotion" + EXT);

// Stock EveJS requires <= 2500 m SURFACE separation for a gate jump.
const GATE_RANGE_M = 2500;
const MAX_HOPS = 4;
const JUMP_VERIFY_MS = 60000;
const REWARP_MS = 60000;

const num = (value) => Number(value) || 0;
const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

function vector(point) {
  return !!point && ["x", "y", "z"].every((key) => Number.isFinite(Number(point[key])));
}

function distance(a, b) {
  return Math.hypot(num(a.x) - num(b.x), num(a.y) - num(b.y), num(a.z) - num(b.z));
}

function surfaceGap(entity, gate) {
  const raw = distance(entity && entity.position, gate && gate.position);
  return Math.max(0, raw - Math.max(0, num(entity && entity.radius)) - Math.max(0, num(gate && gate.radius)));
}

// Reciprocal-gate BFS. A gate pair only counts when both directions really
// point at each other, which is what the stock jump validates too.
function planRoute({ fromSystemID, toSystemID, getStargatesForSystem, getGate, maxHops }) {
  const from = num(fromSystemID);
  const to = num(toSystemID);
  const limit = positive(maxHops) ? num(maxHops) : MAX_HOPS;
  if (!(from > 0) || !(to > 0) || typeof getStargatesForSystem !== "function" || typeof getGate !== "function") return null;
  if (from === to) return [];
  const queue = [{ systemID: from, hops: [] }];
  const seen = new Set([from]);
  while (queue.length) {
    const node = queue.shift();
    if (node.hops.length >= limit) continue;
    for (const gate of getStargatesForSystem(node.systemID) || []) {
      const gateID = num(gate && gate.itemID);
      const destinationGateID = num(gate && gate.destinationID);
      if (!(gateID > 0) || !(destinationGateID > 0)) continue;
      const back = getGate(destinationGateID);
      const destinationSystemID = num(gate && gate.destinationSolarSystemID) || num(back && back.solarSystemID);
      if (!(destinationSystemID > 0) || !back) continue;
      if (num(back.solarSystemID) !== destinationSystemID || num(back.destinationID) !== gateID) continue;
      const hop = { fromGateID: gateID, toGateID: destinationGateID, fromSystemID: node.systemID, toSystemID: destinationSystemID };
      if (destinationSystemID === to) return node.hops.concat(hop);
      if (seen.has(destinationSystemID)) continue;
      seen.add(destinationSystemID);
      queue.push({ systemID: destinationSystemID, hops: node.hops.concat(hop) });
    }
  }
  return null;
}

function shipEntity(sceneFor, systemID, shipItemID) {
  const scene = typeof sceneFor === "function" ? sceneFor(num(systemID)) : null;
  if (!scene || typeof scene.getEntityByID !== "function") return { scene: null, entity: null };
  return { scene, entity: scene.getEntityByID(num(shipItemID)) || null };
}

// Drives the hop forward by one observation. Returns
//   OK      - the ship is in the destination system, in docking range
//   PENDING - real progress (or a real wait); keep the flight on this step
//   FAILED  - the hop cannot be completed; never guess a jump
function advance(options) {
  const {
    flight, ctx, session, transitions, sceneFor, stationPosition,
    nowMs, getStargatesForSystem, getGate, dockingRangeM,
  } = options || {};
  const at = num(nowMs);
  const shipItemID = num(flight && flight.shipItemID);
  const toSystemID = num(options && options.toSystemID);
  if (!(shipItemID > 0) || !(toSystemID > 0)) return { status: "FAILED", reason: "HOP_CONTEXT_INCOMPLETE" };
  const ready = motion.preflight(ctx);
  if (ready.status !== "READY") return { status: "FAILED", reason: "HOP_NOT_READY:" + ready.missing.join(",") };

  let state = flight && flight.hop;
  if (!state || !Array.isArray(state.hops) || !state.hops.length) {
    const hops = planRoute({
      fromSystemID: options.fromSystemID,
      toSystemID,
      getStargatesForSystem,
      getGate,
    });
    if (!hops || !hops.length) return { status: "FAILED", reason: "NO_NATIVE_GATE_ROUTE" };
    state = { hops, index: 0, phase: "warp-gate", lastWarpAtMs: 0, issuedAtMs: 0 };
  }
  const hop = state.hops[state.index] || null;

  if (state.phase === "warp-gate") {
    if (!hop) return { status: "FAILED", reason: "HOP_INDEX_INVALID" };
    const { entity } = shipEntity(sceneFor, hop.fromSystemID, shipItemID);
    if (!entity) return { status: "PENDING", reason: "SHIP_NOT_IN_SCENE", state };
    const gate = getGate(hop.fromGateID);
    if (!gate || !vector(gate.position)) return { status: "FAILED", reason: "GATE_POSITION_MISSING" };
    if (surfaceGap(entity, gate) <= GATE_RANGE_M) {
      return { status: "PENDING", reason: "AT_REAL_GATE", state: Object.assign({}, state, { phase: "jump" }) };
    }
    if (!(num(state.lastWarpAtMs) > 0) || at - num(state.lastWarpAtMs) > REWARP_MS) {
      const warped = motion.warpAgent(ctx, {
        entityID: shipItemID,
        systemID: hop.fromSystemID,
        point: gate.position,
        ingressMs: num(ctx && ctx.warpIngressMs) || 30000,
      });
      if (warped.status === motion.FAILED) {
        return { status: "FAILED", reason: "WARP_TO_GATE_FAILED:" + String(warped.reason || "") };
      }
      return {
        status: "PENDING",
        reason: "WARP_TO_GATE",
        state: Object.assign({}, state, { lastWarpAtMs: at }),
      };
    }
    return { status: "PENDING", reason: "WARPING_TO_GATE", state };
  }

  if (state.phase === "jump") {
    if (!hop) return { status: "FAILED", reason: "HOP_INDEX_INVALID" };
    if (typeof transitions.jumpSessionViaStargate !== "function") return { status: "FAILED", reason: "NO_NATIVE_STARGATE_JUMP" };
    let outcome;
    try {
      outcome = transitions.jumpSessionViaStargate(session, hop.fromGateID, hop.toGateID);
    } catch (error) {
      return { status: "FAILED", reason: "JUMP_THREW:" + String(error && error.message || error) };
    }
    if (!outcome || outcome.success !== true) {
      const reason = String(outcome && outcome.errorMsg || "JUMP_REFUSED");
      if (reason === "STARGATE_JUMP_IN_PROGRESS") {
        return { status: "PENDING", reason, state: Object.assign({}, state, { phase: "verify-jump", issuedAtMs: at }) };
      }
      return { status: "FAILED", reason: "JUMP_" + reason };
    }
    return {
      status: "PENDING",
      reason: "JUMP_ISSUED",
      state: Object.assign({}, state, { phase: "verify-jump", issuedAtMs: at }),
    };
  }

  if (state.phase === "verify-jump") {
    if (!hop) return { status: "FAILED", reason: "HOP_INDEX_INVALID" };
    const destination = shipEntity(sceneFor, hop.toSystemID, shipItemID);
    const source = shipEntity(sceneFor, hop.fromSystemID, shipItemID);
    if (destination.entity && !source.entity) {
      const index = num(state.index) + 1;
      const phase = index >= state.hops.length ? "warp-station" : "warp-gate";
      return {
        status: "PENDING",
        reason: "JUMP_VERIFIED",
        verified: { fromSystemID: hop.fromSystemID, toSystemID: hop.toSystemID, entityID: shipItemID },
        state: Object.assign({}, state, { index, phase, lastWarpAtMs: 0, issuedAtMs: 0 }),
      };
    }
    if (num(state.issuedAtMs) > 0 && at - num(state.issuedAtMs) > JUMP_VERIFY_MS) {
      return { status: "FAILED", reason: "JUMP_NOT_VERIFIED" };
    }
    return { status: "PENDING", reason: "AWAITING_JUMP_COMPLETION", state };
  }

  if (state.phase === "warp-station") {
    const { entity } = shipEntity(sceneFor, toSystemID, shipItemID);
    if (!entity) return { status: "PENDING", reason: "SHIP_NOT_IN_SCENE", state };
    if (!vector(stationPosition)) return { status: "FAILED", reason: "STATION_POSITION_MISSING" };
    const range = positive(dockingRangeM) ? num(dockingRangeM) : 5000;
    if (distance(entity.position, stationPosition) <= range) {
      return { status: "OK", reason: "ARRIVED_AFTER_GATE", state, systemID: toSystemID, entityID: shipItemID };
    }
    if (!(num(state.lastWarpAtMs) > 0) || at - num(state.lastWarpAtMs) > REWARP_MS) {
      const warped = motion.warpAgent(ctx, {
        entityID: shipItemID,
        systemID: toSystemID,
        point: stationPosition,
        ingressMs: num(ctx && ctx.warpIngressMs) || 30000,
      });
      if (warped.status === motion.FAILED) {
        return { status: "FAILED", reason: "WARP_TO_STATION_FAILED:" + String(warped.reason || "") };
      }
      return {
        status: "PENDING",
        reason: "WARP_TO_STATION",
        state: Object.assign({}, state, { lastWarpAtMs: at }),
      };
    }
    return { status: "PENDING", reason: "WARPING_TO_STATION", state };
  }

  return { status: "FAILED", reason: "HOP_PHASE_UNKNOWN:" + String(state.phase) };
}

module.exports = { GATE_RANGE_M, MAX_HOPS, planRoute, advance };
