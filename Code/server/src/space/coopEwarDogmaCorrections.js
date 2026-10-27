"use strict";
// These are corrections to native EveJS outputs. No alternative Dogma state,
// capacitor bank, HP store, module timer or effect scheduler is created here.
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}
function positive(value) {
  const n = finite(value);
  return n > 0 ? n : NaN;
}
function clamp01(value) { return Math.max(0, Math.min(1, value)); }
function round6(value) { return Math.round(value * 1e6) / 1e6; }

// Standard NOS eligibility uses capacitor *fraction*, not absolute GJ.
// The pinned native function already handles the Dogma nosOverride before
// reaching this guard. Never allow a transfer with unknown capacitor values.
function nosTransferAllowed(sourceEntity, targetEntity, callbacks = {}) {
  if (!sourceEntity || !targetEntity ||
      typeof callbacks.getEntityCapacitorAmount !== "function") return false;
  const sourceCapacity = positive(sourceEntity.capacitorCapacity);
  const targetCapacity = positive(targetEntity.capacitorCapacity);
  if (!Number.isFinite(sourceCapacity) || !Number.isFinite(targetCapacity)) return false;
  let sourceEnergy, targetEnergy;
  try {
    sourceEnergy = finite(callbacks.getEntityCapacitorAmount(sourceEntity));
    targetEnergy = finite(callbacks.getEntityCapacitorAmount(targetEntity));
  } catch { return false; }
  if (!Number.isFinite(sourceEnergy) || !Number.isFinite(targetEnergy) ||
      sourceEnergy < 0 || targetEnergy < 0 ||
      sourceEnergy > sourceCapacity + 1e-6 ||
      targetEnergy > targetCapacity + 1e-6) return false;
  return clamp01(sourceEnergy / sourceCapacity) + 1e-9 <
    clamp01(targetEnergy / targetCapacity);
}

// Native module cycle has *already* updated the real target conditionState.
// Only report the actual clamped delta, not requested repair points; no HP
// is credited here. The ratio definitions are native: shieldCharge is full
// at 1, armorDamage/damage are empty at 0.
function actualRemoteRepairAmount(family, previousConditionState, targetEntity) {
  if (!previousConditionState || !targetEntity || !targetEntity.conditionState)
    return 0;
  const fields = {
    remoteShield: ["shieldCharge", "shieldCapacity", 1],
    remoteArmor: ["armorDamage", "armorHP", -1],
    remoteHull: ["damage", "structureHP", -1],
  };
  const spec = Object.hasOwn(fields, family) ? fields[family] : null;
  if (!spec) return 0;
  const [field, capacityField, direction] = spec;
  const capacity = positive(targetEntity[capacityField]);
  const before = finite(previousConditionState[field]);
  const after = finite(targetEntity.conditionState[field]);
  if (!Number.isFinite(capacity) || !Number.isFinite(before) ||
      !Number.isFinite(after) || before < 0 || before > 1 ||
      after < 0 || after > 1) return 0;
  return round6(Math.max(0, Math.min(capacity,
    direction * (after - before) * capacity)));
}
module.exports = { nosTransferAllowed, actualRemoteRepairAmount };
