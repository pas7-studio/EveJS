"use strict";
// An idle native NPC controller treats "no hostile target" as "stand down" and
// clears every outgoing target lock on each think:
//   tickController -> clearNpcCombatState -> clearNpcTargetLocks -> scene.clearTargets
//   -> clearOutgoingTargetLocks -> stopTargetedModuleEffects(reason "target")
// which stops any active generic module aimed at that target. A mining module
// therefore died between activation and its first 15-45 s cycle: measured
// MODULE_STOP_NOSESSION stopReason=target with zero MINING_CYCLE_ATTEMPT events,
// a drained capacitor and no ore, every single think.
//
// A ship that is actively mining is not an idle combat hull: keep its locks and
// let the mining loop own them. Real aggression still goes through the fleet
// aggro path, and a mining module whose rock is gone or out of range stops
// itself in the mining runtime.
const GATE = "EVEJS_COOP_MINING_LOCK_GUARD";

function activeMiningModuleID(entity) {
  const effects = entity && entity.activeModuleEffects;
  if (!(effects instanceof Map)) return 0;
  for (const effect of effects.values()) {
    if (effect && effect.miningEffect === true) return Number(effect.moduleID) || 0;
  }
  return 0;
}

function keepTargetLock(entity) {
  if (process.env[GATE] !== "1") return false;
  return activeMiningModuleID(entity) > 0;
}

module.exports = {GATE, activeMiningModuleID, keepTargetLock};
