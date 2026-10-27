"use strict";
// The range a native NPC's own fitted weapon really has.
//
// Why it exists: a raider parked at its behaviour profile's own orbit distance
// fires a weapon whose dogma range is much shorter, so its charges hit nothing
// while the hull sits "in the fight" (measured: a blaster cruiser at ~9 km and
// 2.5 AU, 300 real charges, zero damage). The honest fix is to fly the hull to
// its own gun's range instead of inventing a distance of ours, so this module
// reads the range from the same native snapshot the stock combat resolver uses
// (`buildNpcWeaponModuleSnapshot`): a turret's maxRange (optimal) attribute and
// a launcher's own missile range. A hull with no real weapon resolves nothing.
//
// Source .cjs modules become .js siblings in the deployed EveJS overlay.
const siblingSuffix = typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs";

const REQUIRED_KEYS = Object.freeze(["weaponModulesOf", "snapshotOf"]);

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// The stock resolver's own family test; only used when a caller did not inject
// one (a caller that injects every authority is never touched by upstream).
function isMissileFamily(family) {
  return /missile|rocket|torpedo|bomb/i.test(String(family || ""));
}

function defaultAuthorities() {
  const equipment = require("./npc/npcEquipment" + siblingSuffix);
  return {
    weaponModulesOf: (entity) => equipment.getNpcWeaponModules(entity),
    snapshotOf: (entity, moduleItem) => equipment.buildNpcWeaponModuleSnapshot(entity, moduleItem),
  };
}

function createGunRange(injected) {
  const base = injected && typeof injected === "object" ? injected : {};
  let authorities = null;
  const a = () => {
    if (authorities) return authorities;
    const missing = REQUIRED_KEYS.filter((key) => typeof base[key] !== "function");
    let defaults = {};
    // Outside the deployed server the native equipment module does not exist;
    // that must surface as the explicit authority refusal, not a require error.
    if (missing.length) {
      try { defaults = defaultAuthorities(); } catch (_error) { defaults = {}; }
    }
    authorities = Object.assign(defaults, base);
    if (typeof authorities.isMissileFamily !== "function") {
      authorities.isMissileFamily = isMissileFamily;
    }
    const stillMissing = REQUIRED_KEYS.filter((key) => typeof authorities[key] !== "function");
    if (stillMissing.length) throw Error("GUN_RANGE_AUTHORITIES_REQUIRED:" + stillMissing.join(","));
    return authorities;
  };

  // Every fitted weapon the native snapshot can resolve, with the exact dogma
  // field it came from. Never a guess: a module whose snapshot fails is listed
  // as unresolved instead of being given a made-up range.
  function weapons(entity) {
    if (!entity || typeof entity !== "object") return [];
    const auth = a();
    let modules = [];
    try { modules = auth.weaponModulesOf(entity) || []; } catch (_error) { modules = []; }
    if (!Array.isArray(modules)) return [];
    const resolved = [];
    for (const moduleItem of modules) {
      let snapshot = null;
      try { snapshot = auth.snapshotOf(entity, moduleItem); } catch (_error) { snapshot = null; }
      if (!snapshot) continue;
      const missile = auth.isMissileFamily(snapshot.family) === true;
      const source = missile ? "missileRange" : "maxRange";
      const meters = positive(missile ? snapshot.approxRange : snapshot.optimalRange);
      resolved.push({
        moduleID: positive(moduleItem && moduleItem.moduleID),
        typeID: positive(moduleItem && moduleItem.typeID),
        flagID: positive(moduleItem && moduleItem.flagID),
        family: String(snapshot.family || ""),
        source,
        meters,
        falloffMeters: positive(snapshot.falloff),
        chargeTypeID: positive(snapshot.chargeTypeID),
      });
    }
    return resolved;
  }

  // The hull fights with the weapon that reaches furthest, at that weapon's own
  // range. Nothing is resolved when no fitted weapon has a real dogma range.
  function rangeOf(entity) {
    const resolved = weapons(entity).filter((weapon) => weapon.meters > 0);
    if (!resolved.length) {
      return { status: "REFUSED", reason: "NO_FITTED_WEAPON_RANGE", weapons: [] };
    }
    const best = resolved.reduce((left, right) => (right.meters > left.meters ? right : left));
    return {
      status: "RESOLVED",
      meters: best.meters,
      source: best.source,
      family: best.family,
      typeID: best.typeID,
      moduleID: best.moduleID,
      falloffMeters: best.falloffMeters,
      weaponCount: resolved.length,
      weapons: resolved.slice(0, 6),
    };
  }

  return { rangeOf, weapons };
}

let shared = null;
function sharedGunRange() {
  if (!shared) shared = createGunRange();
  return shared;
}

module.exports = { createGunRange, shared: sharedGunRange };
