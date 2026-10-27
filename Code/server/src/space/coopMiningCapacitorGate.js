"use strict";
// A native miner whose capacitor is below the module cost must wait, not retry.
//
// Measured on the headless world: hulls sat at 1-2% capacitor while the recharge
// advance added its correct ~0.006/s. Retrying the activation drains what little
// charge there is and restarts nothing, so the ship can never climb back to the
// level the module needs and the fleet reports active modules with no ore. This
// gate makes the fleet wait for the capacitor it is missing instead of grinding
// it down; it only applies to native NPC miners, never to a player ship.
const DEFAULT_MIN_AMOUNT_GJ = 30;

function capacitorAmountGj(entity) {
  const capacity = Number(entity && entity.capacitorCapacity);
  const ratio = Number(entity && entity.capacitorChargeRatio);
  if (!Number.isFinite(capacity) || capacity <= 0) return 0;
  if (!Number.isFinite(ratio)) return 0;
  return Math.max(0, capacity * Math.min(1, Math.max(0, ratio)));
}

function shouldWait(entity, minAmountGj = DEFAULT_MIN_AMOUNT_GJ) {
  if (!entity || entity.kind !== "ship" || entity.session) return false;
  if (entity.nativeNpc !== true) return false;
  const required = Number(minAmountGj);
  const need = Number.isFinite(required) && required > 0 ? required : DEFAULT_MIN_AMOUNT_GJ;
  return capacitorAmountGj(entity) < need;
}

function why(entity, minAmountGj = DEFAULT_MIN_AMOUNT_GJ) {
  return {
    entityID: Number(entity && entity.itemID) || 0,
    capacityGj: Number((Number(entity && entity.capacitorCapacity) || 0).toFixed(1)),
    ratio: Number((Number(entity && entity.capacitorChargeRatio) || 0).toFixed(4)),
    amountGj: Number(capacitorAmountGj(entity).toFixed(1)),
    requiredGj: Number(minAmountGj) || DEFAULT_MIN_AMOUNT_GJ,
  };
}

module.exports = { capacitorAmountGj, shouldWait, why, DEFAULT_MIN_AMOUNT_GJ };
