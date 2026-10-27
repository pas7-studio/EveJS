"use strict";
// A stock mining hull that is out of range of its rock is only ever told to
// FOLLOW it, i.e. to cover the distance at subwarp speed. After a retreat (or a
// restart that restores the fleet at its off-grid warp origin) every miner sits
// 2-4 AU from the belt, so that follow order can never arrive: measured live
// TARGET_OUT_OF_RANGE 448 793 611 732 m against an 11 500 m engagement range,
// unchanged for hours while the fleet still reported "mining" and produced
// nothing. A raider therefore had no prey at the belt at all.
//
// This module issues the real native warp the fleet already uses for its own
// warp-in and haul legs. It never moves a hull itself, never mines, never touches
// cargo or the journal: it only asks the native runtime to fly the ship to a
// point next to the rock it already chose. Default OFF.
const DEFAULT_WARP_ABOVE_METERS = 100_000; // a subwarp approach is fine below this
const DEFAULT_MIN_WARP_METERS = 5_000; // native WARP_DISTANCE_TOO_CLOSE guard
const DEFAULT_RETRY_MS = 30_000;
const DEFAULT_INGRESS_MS = 2_500;
const lastWarp = new Map();
const noted = new Map();
const NOTE_THROTTLE_MS = 60_000;

function vec(value) {
  return value && ["x", "y", "z"].every((k) => Number.isFinite(Number(value[k])))
    ? { x: Number(value.x), y: Number(value.y), z: Number(value.z) }
    : null;
}
function distance(left, right) {
  return left && right
    ? Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)
    : Number.POSITIVE_INFINITY;
}
function number(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}
// A warp lands ON the target point, so the point is placed one orbit-radius plus
// the rock's own radius away from its centre: the surface distance after landing
// is exactly the orbit distance the fleet already asks for.
function landingPoint(shipPosition, target) {
  const rock = vec(target && target.position);
  if (!rock) return null;
  const orbit = Math.max(500, number(target && target.orbitDistanceMeters, 1_000));
  const hold = Math.max(DEFAULT_MIN_WARP_METERS, number(target && target.radius, 0) + orbit);
  const delta = vec(shipPosition)
    ? { x: shipPosition.x - rock.x, y: shipPosition.y - rock.y, z: shipPosition.z - rock.z }
    : { x: 1, y: 0, z: 0 };
  const length = Math.hypot(delta.x, delta.y, delta.z);
  const unit = length > 1e-6
    ? { x: delta.x / length, y: delta.y / length, z: delta.z / length }
    : { x: 1, y: 0, z: 0 };
  return { x: rock.x + unit.x * hold, y: rock.y + unit.y * hold, z: rock.z + unit.z * hold };
}
function note(reason, payload) {
  const now = Date.now();
  const key = reason + ":" + String(payload.shipID || 0);
  if (now - (noted.get(key) || 0) < NOTE_THROTTLE_MS) return;
  noted.set(key, now);
  try {
    require("./coopRuntimeProbe").observe("living-mining-belt-warp", null,
      { spaceState: { systemID: Number(payload.systemID) || 0 } }, { reason, ...payload });
  } catch (_error) { /* telemetry must never break movement */ }
}

// Returns true only when a real warp was issued, so the caller can skip the
// subwarp follow order for this tick instead of cancelling its own warp.
function ensure(scene, fleetRecord, entity, targetEntity, options = {}) {
  if (process.env.EVEJS_COOP_MINING_BELT_RETURN !== "1") return false;
  if (!scene || !entity || !targetEntity) return false;
  if (typeof options.warp !== "function") return false;
  const entityID = Number(entity.itemID) || 0;
  const targetID = Number(targetEntity.itemID) || 0;
  if (!(entityID > 0) || !(targetID > 0)) return false;
  // A hull that is already flying a warp must finish it; a hull with a queued
  // warp is not ours to re-target.
  if (entity.mode === "WARP" || entity.pendingWarp === true ||
    entity.sessionlessWarpIngress || entity.warpState) return false;
  const position = vec(entity.position);
  const rock = vec(targetEntity.position);
  if (!position || !rock) return false;
  const radius = Math.max(0, number(entity.radius, 0)) + Math.max(0, number(targetEntity.radius, 0));
  const surface = Math.max(0, distance(position, rock) - radius);
  const threshold = Math.max(DEFAULT_MIN_WARP_METERS,
    number(process.env.EVEJS_COOP_MINING_BELT_RETURN_METERS, DEFAULT_WARP_ABOVE_METERS));
  if (!(surface > threshold)) return false;
  const now = number(options.now, Date.now());
  const prior = lastWarp.get(entityID);
  if (prior && prior.targetID === targetID && now - prior.at < DEFAULT_RETRY_MS) return false;
  const point = landingPoint(position, {
    position: rock,
    radius: Math.max(0, number(targetEntity.radius, 0)),
    orbitDistanceMeters: number(options.orbitDistanceMeters, 1_000),
  });
  if (!point) return false;
  if (!(distance(position, point) >= DEFAULT_MIN_WARP_METERS)) return false;
  lastWarp.set(entityID, { targetID, at: now });
  let ack = null;
  try {
    ack = options.warp(entityID, point, {
      forceImmediateStart: true,
      broadcastWarpStartToVisibleSessions: true,
      visibilitySuppressMs: 250,
      ingressDurationMs: Math.max(250, number(options.ingressDurationMs, DEFAULT_INGRESS_MS)),
    });
  } catch (error) {
    ack = { success: false, errorMsg: String(error && error.message || error).slice(0, 120) };
  }
  const accepted = ack === true || (ack && ack.success === true);
  if (!accepted) {
    note("WARP_REJECTED", {
      systemID: Number(scene.systemID) || 0,
      fleetID: Number(fleetRecord && fleetRecord.fleetID) || 0,
      shipID: entityID,
      targetID,
      distanceMeters: Math.round(surface),
      errorMsg: String((ack && (ack.errorMsg || ack.error)) || "UNKNOWN").slice(0, 120),
    });
    return false;
  }
  note("WARP_ISSUED", {
    systemID: Number(scene.systemID) || 0,
    fleetID: Number(fleetRecord && fleetRecord.fleetID) || 0,
    shipID: entityID,
    targetID,
    distanceMeters: Math.round(surface),
    thresholdMeters: Math.round(threshold),
    landing: point,
  });
  return true;
}
function reset() {
  lastWarp.clear();
  noted.clear();
}
module.exports = { ensure, reset, landingPoint, DEFAULT_WARP_ABOVE_METERS };
