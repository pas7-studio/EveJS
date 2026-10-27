"use strict";
// A native NPC has no capacitor manager: stock EveJS gives it a full capacitor when
// it spawns and never recharges it. Player-style modules do spend that capacitor, so
// a co-op mining hull starts one Strip Miner, drains the pool and then receives
// NOT_ENOUGH_CAPACITOR on every later activation - the fleet keeps reporting
// `state=mining` while nothing is extracted.
//
// Two entry points, both gated by EVEJS_COOP_NPC_CAPACITOR=1:
//  - refill(scene, controller) tops up an idle NPC at its behaviour think;
//  - topUp(entity) tops it up right before the mining loop starts a module, because a
//    headless fleet is driven by the mining tick and may not see a behaviour think.
// A real player's ship is never touched and no capacity is invented: the rule only
// restores the "full capacitor" state the engine assumes for an NPC between actions.
const FULL_RATIO = 0.999;

function enabled() {
  return process.env.EVEJS_COOP_NPC_CAPACITOR === "1";
}

function isIdle(entity) {
  const effects = entity && entity.activeModuleEffects;
  if (effects instanceof Map) return effects.size === 0;
  if (Array.isArray(effects)) return effects.length === 0;
  return !effects;
}

function topUp(entity) {
  if (!enabled()) return false;
  if (!entity || entity.kind !== "ship") return false;
  if (entity.session) return false;
  if (entity.nativeNpc !== true) return false;
  const capacity = Number(entity.capacitorCapacity);
  if (!Number.isFinite(capacity) || capacity <= 0) return false;
  const ratio = Number(entity.capacitorChargeRatio);
  if (Number.isFinite(ratio) && ratio >= FULL_RATIO) return false;
  entity.capacitorChargeRatio = 1;
  if (entity.conditionState && typeof entity.conditionState === "object") {
    entity.conditionState.charge = 1;
  }
  return true;
}

function refill(scene, controller) {
  if (!enabled() || !scene || !controller) return false;
  const entityID = Number(controller.entityID || controller.itemID || 0);
  if (!(entityID > 0)) return false;
  const entity = typeof scene.getEntityByID === "function" ? scene.getEntityByID(entityID) : null;
  if (!entity || !isIdle(entity)) return false;
  return topUp(entity);
}

module.exports = { refill, topUp, FULL_RATIO };
