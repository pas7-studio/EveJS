"use strict";
// Opt-in, read-only trace for the native mining fleet. The stock loop silently
// `continue`s when a miner has no usable module, no snapshot, no reachable rock
// or a failed target lock, so a fleet can claim "mining" forever and produce
// nothing. One throttled event per fleet and reason makes that visible.
const lastAt = new Map();
const THROTTLE_MS = 120000;
function note(reason, payload = {}) {
  if (process.env.EVEJS_COOP_MINING_TRACE !== "1") return;
  const now = Date.now();
  const key = `${reason}:${payload.systemID || 0}:${payload.fleetID || 0}`;
  if (now - (lastAt.get(key) || 0) < THROTTLE_MS) return;
  lastAt.set(key, now);
  try {
    require("./coopRuntimeProbe").observe("living-mining-blocker", null,
      { spaceState: { systemID: Number(payload.systemID) || 0 } },
      { reason, ...payload, atMs: now });
  } catch (_error) { /* tracing must never break the native tick */ }
}
// A failed activation was reported inline with seventeen hand-built fields,
// which is how the trace drifted from the code it describes. The shape is owned
// here so the stock loop only passes what it already has.
function noteActivationFailure(fleetRecord, scene, minerEntity, entry, result) {
  const moduleItem = (entry && entry.moduleItem) || {};
  note("MODULE_ACTIVATE_FAILED", {
    fleetID: Number(fleetRecord && fleetRecord.fleetID) || 0,
    systemID: Number(scene && scene.systemID) || 0,
    minerID: Number(minerEntity && minerEntity.itemID) || 0,
    moduleID: Number(moduleItem.itemID) || 0,
    typeID: Number(moduleItem.typeID) || 0,
    locationID: Number(moduleItem.locationID) || 0,
    shipID: Number(minerEntity && minerEntity.itemID) || 0,
    cap: Number(minerEntity && minerEntity.capacitorCapacity) || 0,
    ratio: Number(minerEntity && minerEntity.capacitorChargeRatio),
    native: Boolean(minerEntity && minerEntity.nativeNpc === true),
    hasSession: Boolean(minerEntity && minerEntity.session),
    errorMsg: String((result && result.errorMsg) || "NONE"),
  });
}

// The same for the "one miner reached a rock" observation: it exists to explain
// why a fleet that claims to be mining produces nothing, so it carries the module
// and effect counts that make that visible.
function noteTargetSelected(fleetRecord, scene, minerEntity, targetEntity, miningModules, hooks) {
  note("MINER_TARGET", {
    fleetID: Number(fleetRecord && fleetRecord.fleetID) || 0,
    systemID: Number(scene && scene.systemID) || 0,
    minerID: Number(minerEntity && minerEntity.itemID) || 0,
    targetID: Number(targetEntity && targetEntity.itemID) || 0,
    modules: Array.isArray(miningModules) ? miningModules.length : 0,
    fitted:
      hooks && typeof hooks.getNpcFittedModuleItems === "function"
        ? hooks.getNpcFittedModuleItems(minerEntity).length
        : 0,
    activeEffects:
      minerEntity && minerEntity.activeModuleEffects instanceof Map
        ? minerEntity.activeModuleEffects.size
        : -1,
    distance:
      hooks && typeof hooks.getSurfaceDistance === "function"
        ? Math.round(hooks.getSurfaceDistance(minerEntity, targetEntity))
        : 0,
  });
}

// Per-fleet snapshot of what the ships actually are right now: mode, active
// module effects, capacitor state and whether a runtime controller exists. This
// is the line that showed mining "working" while nothing was produced, so its
// field shape belongs here and not in a 900-character hook.
function noteFleetPostTick(fleetRecord, scene) {
  const ships = Array.isArray(fleetRecord && fleetRecord.minerEntityIDs)
    ? fleetRecord.minerEntityIDs
    : [];
  let getController = null;
  try {
    getController = require("./npc/npcRegistry").getControllerByEntityID;
  } catch (_error) {
    getController = null;
  }
  note("FLEET_POST_TICK", {
    fleetID: Number(fleetRecord && fleetRecord.fleetID) || 0,
    systemID: Number(scene && scene.systemID) || 0,
    state: String((fleetRecord && fleetRecord.state) || ""),
    miners: ships.map((id) => {
      const entity = scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(id) : null;
      const effects =
        entity && entity.activeModuleEffects instanceof Map ? entity.activeModuleEffects.size : -1;
      let controller = -1;
      if (entity && getController) {
        try {
          controller = getController(id) ? 1 : 0;
        } catch (_error) {
          controller = -1;
        }
      }
      return [
        id,
        String((entity && entity.mode) || "none"),
        "act" + effects,
        "cap" + (entity ? Number(entity.capacitorChargeRatio) : "none"),
        "capmax" + (entity ? Number(entity.capacitorCapacity) : 0),
        "tau" + (entity ? Number(entity.capacitorRechargeRate) || 0 : 0),
        "reAt" + (entity ? Number(entity.capacitorRechargedAtMs) || 0 : 0),
        "tr" + (entity && entity.transient === true ? 1 : 0),
        "ctl" + controller,
        "st" + (entity && entity.conditionState ? Number(entity.conditionState.charge) : -1),
      ].join("|");
    }).join(" ; "),
  });
}

// Why a miner that reached the belt still has nothing to shoot: no rock, or every
// rock is already claimed.
function noteNoMineableTarget(fleetRecord, scene, minerEntity, availableTargetEntries, claimCounts) {
  note("NO_MINEABLE_TARGET", {
    fleetID: Number(fleetRecord && fleetRecord.fleetID) || 0,
    systemID: Number(scene && scene.systemID) || 0,
    minerID: Number(minerEntity && minerEntity.itemID) || 0,
    rocks: Array.isArray(availableTargetEntries) ? availableTargetEntries.length : -1,
    claims: claimCounts instanceof Map ? claimCounts.size : -1,
    activeAsteroidID: Number(fleetRecord && fleetRecord.activeAsteroidID) || 0,
  });
}

// A module that is stopped because the fleet picked a different rock and then
// restarted on the next tick pays the activation cost forever and never reaches a
// cycle boundary: the fleet shows active modules and produces no ore. Both ids are
// reported so the mismatch is a fact instead of a suspicion.
function noteTargetMismatch(fleetRecord, scene, minerEntity, entry, activeEffect, targetEntity) {
  note("MODULE_TARGET_MISMATCH", {
    fleetID: Number(fleetRecord && fleetRecord.fleetID) || 0,
    systemID: Number(scene && scene.systemID) || 0,
    minerID: Number(minerEntity && minerEntity.itemID) || 0,
    moduleID: Number(entry && entry.moduleItem && entry.moduleItem.itemID) || 0,
    effectTargetID: Number(activeEffect && activeEffect.targetID) || 0,
    fleetTargetID: Number(targetEntity && targetEntity.itemID) || 0,
  });
}

// A mining module that activates and is stopped again inside the same tick looks
// exactly like "no ore": the snapshot at tick end shows no effects and the next
// tick pays the activation cost again. This records who stopped it, with the
// reason string the caller passed and whether it was a mining effect.
function noteModuleStop(scene, entity, moduleID, reason, via) {
  if (!entity || entity.nativeNpc !== true) return;
  const effects = entity.activeModuleEffects;
  const effect = effects instanceof Map ? effects.get(Number(moduleID) || 0) : null;
  if (!effect) return;
  note("MODULE_STOP_" + String(via || "unknown").toUpperCase(), {
    systemID: Number(scene && scene.systemID) || 0,
    fleetID: 0,
    shipID: Number(entity.itemID) || 0,
    moduleID: Number(moduleID) || 0,
    stopReason: String(reason || ""),
    mining: effect.miningEffect === true,
    entityError: String(entity.coopMiningCargoLastError || ""),
    ageMs: Math.round(Date.now() - (Number(effect.startedAtMs) || 0)),
  });
}

// Why a mining cycle refused to yield. The runtime stops the module with the
// reason the mining runtime returned ("target", "range", "module"), which says
// nothing about which of the four target checks failed. This notes the state the
// checks read: the rock, its remaining ore, whether the ship really holds a lock
// and how many locks are still pending.
function noteCycleAttempt(scene, entity, effectState, info, boundaryMs) {
  if (!entity || entity.nativeNpc !== true) return;
  const pending = entity.pendingTargetLocks instanceof Map ? entity.pendingTargetLocks.size : -1;
  note("MINING_CYCLE_ATTEMPT", {
    systemID: Number(scene && scene.systemID) || 0,
    fleetID: 0,
    shipID: Number(entity.itemID) || 0,
    moduleID: Number(effectState && effectState.moduleID) || 0,
    targetID: Number(info && info.targetID) || 0,
    rockFound: Boolean(info && info.found),
    oreLeft: Number(info && info.remaining) || 0,
    locked: Boolean(info && info.locked),
    pendingLocks: pending,
    cycleMs: Math.round(Number(boundaryMs) || 0),
  });
}

// One snapshot per fleet think. The think interval is minutes, so this is the only
// place that reliably describes every ship: mode, active module effects, capacitor
// and whether a runtime controller exists. Emitting it from the module-assignment
// path (as before) missed almost every tick.
function noteTick(fleetRecord, scene, now, thinkIntervalMs) {
  note("TICK_" + String((fleetRecord && fleetRecord.state) || "unknown"), {
    fleetID: Number(fleetRecord && fleetRecord.fleetID) || 0,
    systemID: Number(scene && scene.systemID) || 0,
    activeAsteroidID: Number(fleetRecord && fleetRecord.activeAsteroidID) || 0,
    nextThinkInMs: Number(thinkIntervalMs) || 0,
  });
  noteFleetPostTick(fleetRecord, scene);
}

module.exports = {
  note,
  noteTick,
  noteModuleStop,
  noteCycleAttempt,
  noteActivationFailure,
  noteTargetSelected,
  noteTargetMismatch,
  noteFleetPostTick,
  noteNoMineableTarget,
};
