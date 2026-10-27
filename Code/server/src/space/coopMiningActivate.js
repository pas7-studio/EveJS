"use strict";
// One activation attempt for a native mining module, with the capacitor gate.
//
// The stock loop retries the activation on every tick. On a sessionless hull the
// retry keeps draining what little capacitor exists, so the ship never reaches the
// 23 GJ module cost and the fleet reports active modules with no ore (measured:
// hulls pinned at 0-2% while the recharge advance added its correct ~0.006/s).
// This module owns the whole decision: wait, activate, or report the failure.
const gate = require("./coopMiningCapacitorGate");

const MODULE_COST_GJ = 30;

function activate(deps = {}) {
  const {scene, pseudoSession, minerEntity, entry, targetEntity, fleetRecord} = deps;
  if (!scene || !entry || !entry.moduleItem) return skipped(deps, "no-module");
  if (gate.shouldWait(minerEntity, MODULE_COST_GJ)) {
    note(deps, "CAPACITOR_WAIT", gate.why(minerEntity, MODULE_COST_GJ));
    return {attempted: false, reason: "capacitor-wait"};
  }
  if (typeof scene.activateGenericModule !== "function") return skipped(deps, "no-scene-api");
  const result = scene.activateGenericModule(
    pseudoSession,
    entry.moduleItem,
    entry.effectRecord && entry.effectRecord.name,
    {targetID: targetEntity && targetEntity.itemID},
  );
  if (!result || result.success !== true) {
    noteFailure(deps, result);
    return {attempted: true, success: false};
  }
  // A successful activation is not proof that the module mines. Two different
  // failures hide behind "active modules, no ore": the effect can be missing from
  // the ship the fleet reads back (activation landed on another entity object),
  // or it can be present but not flagged as a mining effect, because the runtime
  // only sets that flag when resolveMiningActivation matched module and target.
  // Both are reported, so the next step is a fact instead of a guess.
  const moduleID = Number(entry.moduleItem.itemID) || 0;
  const readBack = readBackEffect(scene, minerEntity, entry);
  note(deps, "MODULE_ACTIVATED", {moduleID, present: readBack.present, miningEffect: readBack.miningEffect});
  return {attempted: true, success: true, miningEffect: readBack.miningEffect, effectPresent: readBack.present};
}

function skipped(deps, reason) {
  // The mining loop ignores this outcome, so a module that cannot even be tried
  // would otherwise look like a fleet that simply never activates anything.
  note(deps, "ACTIVATION_SKIPPED", {reason});
  return {attempted: false, reason};
}

function readBackEffect(scene, minerEntity, entry) {
  try {
    const entity = minerEntity && scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(minerEntity.itemID)
      : null;
    const effects = entity && entity.activeModuleEffects;
    if (!(effects instanceof Map)) return {present: null, miningEffect: null};
    const effect = effects.get(Number(entry.moduleItem.itemID)) || null;
    if (!effect) return {present: false, miningEffect: null};
    return {present: true, miningEffect: effect.miningEffect === true};
  } catch (_error) {
    return {present: null, miningEffect: null};
  }
}

function trace(deps) {
  if (deps.trace) return deps.trace;
  try {
    return require("./coopMiningTrace");
  } catch (_error) {
    return null;
  }
}

function note(deps, reason, payload) {
  const module_ = trace(deps);
  if (!module_ || typeof module_.note !== "function") return;
  module_.note(reason, {
    fleetID: Number(deps.fleetRecord && deps.fleetRecord.fleetID) || 0,
    systemID: Number(deps.scene && deps.scene.systemID) || 0,
    minerID: Number(deps.minerEntity && deps.minerEntity.itemID) || 0,
    ...payload,
  });
}

function noteFailure(deps, result) {
  const module_ = trace(deps);
  if (!module_ || typeof module_.noteActivationFailure !== "function") return;
  module_.noteActivationFailure(
    deps.fleetRecord,
    deps.scene,
    deps.minerEntity,
    deps.entry,
    result,
  );
}

module.exports = {activate, MODULE_COST_GJ};
