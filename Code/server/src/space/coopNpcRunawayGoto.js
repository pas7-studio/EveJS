"use strict";
// A native NPC must never fly a straight line for ever.
//
// Measured 2026-10-27 on the work stack (read-only admin bridge, mining_fleet_diagnose):
// a durable mining fleet's miner AND hauler both sat in mode GOTO with targetPoint
// ~1.0e16 m from the system origin while their own belt was 28-54 km away. That point is
// the "fly straight for ever" form the native speed/undock commands write
// (position + direction * 1.0e16), and `advanceGotoMovement` only ever flies along
// `entity.direction` - it never looks at targetPoint, so nothing could ever stop them.
// The hauler therefore could not stay within the 2 500 m transfer range of its miner,
// `living-hauler-loaded` never fired and no ore ever moved.
//
// A hull of a solar system is at most a few 1e12 m across (1 AU = 1.5e11 m), so a
// destination 1e13 m away is not a destination. Only native NPC hulls are affected:
// a player's own "fly in this direction" command is left exactly as the client sent it.
const COMMENT = "coop-npc-runaway-goto";
const FAR_AWAY_METERS = 1e13;
const ENABLED = () => String(process.env.EVEJS_COOP_NPC_RUNAWAY_GOTO || "") !== "0";

function gapToTarget(entity) {
  const target = entity && entity.targetPoint;
  const position = entity && entity.position;
  if (!target || !position) return null;
  const values = [target.x, target.y, target.z, position.x, position.y, position.z];
  if (!values.every((value) => Number.isFinite(Number(value)))) return null;
  return Math.hypot(
    Number(target.x) - Number(position.x),
    Number(target.y) - Number(position.y),
    Number(target.z) - Number(position.z),
  );
}

// Returns true only when this call really stopped the hull, so the caller can skip its
// normal movement step for this tick instead of moving a ship that was just parked.
function apply(entity) {
  if (!ENABLED()) return false;
  if (!entity || entity.nativeNpc !== true || entity.mode !== "GOTO") return false;
  const gap = gapToTarget(entity);
  if (gap === null || gap <= FAR_AWAY_METERS) return false;
  entity.mode = "STOP";
  entity.speedFraction = 0;
  entity.velocity = { x: 0, y: 0, z: 0 };
  entity.targetPoint = { ...entity.position };
  entity.targetEntityID = null;
  entity.followRange = 0;
  entity.orbitDistance = 0;
  entity.lastCoopRunawayGotoStopAtMs = Date.now();
  entity.lastCoopRunawayGotoStopReason = COMMENT;
  return true;
}

module.exports = { apply, gapToTarget, FAR_AWAY_METERS, ENABLED };
