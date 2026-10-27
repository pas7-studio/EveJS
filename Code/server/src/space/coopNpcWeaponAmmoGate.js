"use strict";
// Strict NPC weapon activation gate: read authoritative native hull, fitted
// modules and bound charge stacks. No inventory or damage mutations occur here.
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0
  ? Number(value) : null;
const requiring = new Set([
  "missileLauncher", "projectileTurret", "hybridTurret",
  "precursorTurret", "laserTurret",
]);

function createAmmoGate({ store, dogma, capability, env = process.env,
  isWarHull = null } = {}) {
  function check({ entity, moduleItem, bankModuleIDs = [] } = {}) {
    const allowed = (status, details = {}) => ({ allowed: true, status, ...details });
    const refused = (status, details = {}) => ({ allowed: false, status, ...details });
    if (env.EVEJS_COOP_NPC_STRICT_AMMO !== "1" ||
        entity?.nativeNpc !== true || entity?.kind !== "ship") {
      return allowed("DEFAULT_UNMODIFIED");
    }

    // EveJS synthetic hull weapons are not fitted items and have no charge
    // stacks. Do not pretend that they fired a normal ammo-consuming module.
    if (moduleItem?.npcSyntheticHullWeapon === true) {
      // Warship fire MUST use genuine fitted modules and physical charges.
      // An NPC synthetic hull weapon is deliberately exempt in legacy PvE,
      // but cannot silently fire free ammunition in native faction war.
      if (env.EVEJS_COOP_FACTION_WAR_COMBAT === "1" &&
          env.EVEJS_COOP_FACTION_WAR === "1" &&
          env.EVEJS_COOP_FACTION_WAR_FLEETS === "1") {
        let fleet = "UNKNOWN";
        try { fleet = isWarHull?.(entity?.itemID) ?? "UNKNOWN"; } catch (_error) {}
        if (fleet !== "UNASSIGNED")
          return refused("WAR_SYNTHETIC_WEAPON_FORBIDDEN");
      }
      return allowed("SYNTHETIC_HULL_WEAPON");
    }

    const entityID = positive(entity?.itemID);
    const moduleID = positive(moduleItem?.itemID);
    if (!entityID || !moduleID) return refused("INVALID_NATIVE_WEAPON");

    const selected = Array.isArray(bankModuleIDs) && bankModuleIDs.length
      ? bankModuleIDs.map(positive) : [moduleID];
    // Duplicate or malformed bank members cannot conceal a missing weapon.
    if (selected.length > 16 || selected.some(id => !id) ||
        new Set(selected).size !== selected.length ||
        !selected.includes(moduleID)) {
      return refused("NATIVE_BANK_MEMBERSHIP_INVALID");
    }

    try {
      const native = store.getNativeEntity(entityID);
      if (!native || Number(native.entityID) !== entityID ||
          !positive(native.ownerID) || Number(native.ownerID) !== Number(entity.ownerID) ||
          !positive(native.systemID) ||
          (positive(entity.systemID) && Number(native.systemID) !== Number(entity.systemID))) {
        return refused("NATIVE_SHIP_CUSTODY_MISSING");
      }
      const ownerID = Number(native.ownerID);
      const moduleRows = store.listNativeModulesForEntity(entityID);
      const cargo = store.listNativeCargoForEntity(entityID);
      if (!Array.isArray(moduleRows) || !Array.isArray(cargo)) {
        return refused("NATIVE_MODULE_CARGO_UNAVAILABLE");
      }

      let charged = 0;
      let chargeOptional = 0;
      for (const memberID of selected) {
        const fitted = moduleRows.filter(row =>
          Number(row?.moduleID) === memberID &&
          Number(row?.entityID) === entityID &&
          Number(row?.ownerID) === ownerID &&
          Number(row?.categoryID) === 7 && positive(row?.typeID) &&
          positive(row?.flagID) &&
          row?.moduleState?.online !== false &&
          row?.moduleState?.isOnline !== false);
        if (fitted.length !== 1) {
          return refused("NATIVE_WEAPON_MODULE_NOT_VERIFIED", { memberID });
        }
        const row = fitted[0];
        if (memberID === moduleID &&
            (positive(moduleItem.typeID) !== positive(row.typeID) ||
             positive(moduleItem.flagID) !== positive(row.flagID) ||
             (positive(moduleItem.ownerID) && positive(moduleItem.ownerID) !== ownerID))) {
          return refused("NATIVE_WEAPON_MODULE_IDENTITY_MISMATCH", { memberID });
        }

        // Resolve charge policy for EACH independently fitted barrel. A
        // charge-optional lead module must never exempt other bank members.
        const member = memberID === moduleID ? moduleItem : {
          ...row, itemID: row.moduleID,
        };
        const family = dogma.resolveWeaponFamily(member);
        if (!requiring.has(family)) {
          return refused("UNKNOWN_NATIVE_WEAPON_FAMILY", { memberID });
        }
        const isOptional = dogma.isChargeOptionalTurretWeapon(member) === true;
        if (isOptional) {
          if (family === "missileLauncher") {
            return refused("NATIVE_OPTIONAL_MISSILE_UNSUPPORTED", { memberID });
          }
          chargeOptional += 1;
          continue;
        }

        const charges = cargo.filter(charge => Number(charge?.moduleID) === memberID);
        const valid = charges.filter(charge =>
          Number(charge?.entityID) === entityID &&
          Number(charge?.ownerID) === ownerID &&
          Number(charge?.categoryID) === 8 &&
          positive(charge?.cargoID) && positive(charge?.typeID) &&
          Number.isSafeInteger(Number(charge.quantity)) && Number(charge.quantity) > 0 &&
          capability.isNpcChargeCompatibleWithModule(row, Number(charge.typeID)) === true);
        if (charges.length !== 1 || valid.length !== 1) {
          return refused("NATIVE_AMMO_EMPTY_OR_AMBIGUOUS", { memberID });
        }
        charged += 1;
      }
      return charged === 0
        ? allowed("CHARGE_OPTIONAL_WEAPON", { modules: selected.length })
        : allowed("NATIVE_LOADED_AMMO_VERIFIED", {
            modules: selected.length, charged, chargeOptional,
          });
    } catch (_error) {
      return refused("NATIVE_AMMO_PROOF_UNAVAILABLE");
    }
  }
  return { check };
}

function check(args = {}) {
  if (process.env.EVEJS_COOP_NPC_STRICT_AMMO !== "1" ||
      args?.entity?.nativeNpc !== true || args?.entity?.kind !== "ship") {
    return { allowed: true, status: "DEFAULT_UNMODIFIED" };
  }
  try {
    return createAmmoGate({
      store: require("./npc/nativeNpcStore"),
      dogma: require("./combat/weaponDogma"),
      capability: require("./npc/npcCapabilityResolver"),
      isWarHull: entityID => {
        const { TABLE, KEY } = require("./coopWarFleetRegistry");
        // War rows live in the atomic-rows keyspace (nested JSON cache path).
        const data = require("./coopNativeRowPath").readRow(
          require("../gameStore"), TABLE, KEY);
        if (data?.version !== 1 ||
            !data.ships || typeof data.ships !== "object")
          return "UNKNOWN";
        return Object.prototype.hasOwnProperty.call(data.ships,String(entityID))?
          "ASSIGNED":"UNASSIGNED";
      },
    }).check(args);
  } catch (_error) {
    return { allowed: false, status: "NATIVE_AMMO_PROOF_UNAVAILABLE" };
  }
}

module.exports = { check, createAmmoGate };
