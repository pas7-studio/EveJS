"use strict";
// FW-003C (loadout seam): which authored loadout row a co-op war patrol really
// flies when it is spawned.
//
// Why this exists: every pirate *subcapital* profile points at
// `retail_empty_npc_entity_loadout` (retail keeps NPC combat stats on the type
// dogma record), so a native spawn of such a profile fits zero modules and can
// never pass coopWarMusterReadiness. The same static table already carries the
// profile's own `<profileID>_loadout` row with a real turret and its compatible
// charge. The L1 patch `0007-npc-loadout-override` lets a caller name that row
// at spawn time; this module decides which row may be named.
//
// Nothing is invented: the row must exist in the real npcLoadouts table, every
// module must resolve to a real fitted item, at least one must be a real weapon
// of a supported family, and every weapon must have a charge the native
// capability resolver says is compatible with it. A profile that already flies
// a valid authored loadout is never overridden.
const WEAPON_FAMILIES = Object.freeze([
  "missileLauncher",
  "projectileTurret",
  "hybridTurret",
  "precursorTurret",
  "laserTurret",
]);
const WEAPON_FAMILY_SET = new Set(WEAPON_FAMILIES);
const RETAIL_EMPTY_LOADOUT_ID = "retail_empty_npc_entity_loadout";
const MAX_ENTRIES = 32;

const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const refuse = (reason, extra) => Object.assign({ status: "REFUSED", reason, override: false }, extra || {});

function createWarPatrolLoadout({
  getProfile,
  getLoadout,
  resolveItemByTypeID,
  resolveWeaponFamily,
  isCompatibleCharge,
  // Optional: the authored multi-charge row for a real base row. It is an
  // authority like the others, so a caller that cannot author one (or a row
  // that does not validate) is refused instead of guessed at.
  getAuthoredRow = null,
  ammoDepth = 0,
} = {}) {
  if ([getProfile, getLoadout, resolveItemByTypeID, resolveWeaponFamily, isCompatibleCharge]
    .some((fn) => typeof fn !== "function")) {
    throw Error("WAR_PATROL_LOADOUT_AUTHORITIES_REQUIRED");
  }
  if (getAuthoredRow !== null && typeof getAuthoredRow !== "function") {
    throw Error("WAR_PATROL_LOADOUT_AUTHORITIES_REQUIRED");
  }

  // One loadout row -> the real weapon modules it fits and their charges.
  function inspectRow(loadoutID) {
    let row = null;
    try {
      row = getLoadout(loadoutID);
    } catch (_error) {
      return refuse("LOADOUT_LOOKUP_FAILED", { loadoutID });
    }
    if (!row || String(row.loadoutID || "").trim() !== String(loadoutID).trim()) {
      return refuse("LOADOUT_ROW_MISSING", { loadoutID });
    }
    const modules = Array.isArray(row.modules) ? row.modules : [];
    const charges = Array.isArray(row.charges) ? row.charges : [];
    if (modules.length > MAX_ENTRIES || charges.length > MAX_ENTRIES) {
      return refuse("LOADOUT_TOO_LARGE", { loadoutID, modules: modules.length, charges: charges.length });
    }
    const weapons = [];
    for (const entry of modules) {
      const typeID = Number(entry && entry.typeID);
      if (!pos(typeID)) return refuse("LOADOUT_MODULE_INVALID", { loadoutID });
      let item = null;
      try {
        item = resolveItemByTypeID(typeID);
      } catch (_error) {
        return refuse("LOADOUT_MODULE_UNVERIFIED", { loadoutID, typeID });
      }
      if (!item || Number(item.typeID) !== typeID || !pos(item.categoryID)) {
        return refuse("LOADOUT_MODULE_UNVERIFIED", { loadoutID, typeID });
      }
      let family = "";
      try {
        family = String(resolveWeaponFamily({ ...entry, typeID }) || "");
      } catch (_error) {
        family = "";
      }
      if (!WEAPON_FAMILY_SET.has(family)) continue;
      weapons.push({ typeID, quantity: Math.max(1, Number(entry.quantity) || 1), family });
    }
    if (!weapons.length) return refuse("NO_REAL_WEAPON_MODULE", { loadoutID });
    for (const weapon of weapons) {
      const loaded = charges.filter((entry) => {
        const chargeTypeID = Number(entry && entry.typeID);
        if (!pos(chargeTypeID)) return false;
        let chargeItem = null;
        try {
          chargeItem = resolveItemByTypeID(chargeTypeID);
        } catch (_error) {
          return false;
        }
        if (!chargeItem || Number(chargeItem.categoryID) !== 8) return false;
        try {
          return isCompatibleCharge({ ...weapon, moduleID: 1, flagID: 92 }, chargeTypeID) === true;
        } catch (_error) {
          return false;
        }
      });
      if (!loaded.length) {
        return refuse("NO_COMPATIBLE_CHARGE", { loadoutID, weaponTypeID: weapon.typeID });
      }
      weapon.chargeTypeID = Number(loaded[0].typeID);
      // The native ammo bank debits exactly one unit per cycle, so the fitted
      // stack size IS the number of volleys this weapon can really fire.
      weapon.chargeDepth = Math.max(1, Number(loaded[0].quantityPerModule) || 1);
    }
    const chargeDepth = weapons.reduce(
      (lowest, weapon) => Math.min(lowest, weapon.chargeDepth), Number.MAX_SAFE_INTEGER);
    return {
      status: "ARMED",
      loadoutID: String(row.loadoutID),
      loadoutName: String(row.name || ""),
      weapons,
      moduleTypeID: weapons[0].typeID,
      chargeTypeID: weapons[0].chargeTypeID,
      moduleFamily: weapons[0].family,
      chargeDepth,
    };
  }

  // The real base row plus a real ammo depth is preferred whenever the base row
  // itself would fit a single charge per weapon: one volley cannot kill anything.
  function withAuthoredDepth(inspected, depth) {
    if (inspected.status !== "ARMED") return inspected;
    if (typeof getAuthoredRow !== "function") return inspected;
    const wanted = Number(depth) > 0 ? Number(depth) : Number(ammoDepth);
    if (!Number.isSafeInteger(wanted) || wanted < 2) return inspected;
    let authoredID = "";
    try {
      authoredID = String(getAuthoredRow(inspected.loadoutID, wanted) || "").trim();
    } catch (_error) {
      authoredID = "";
    }
    if (!authoredID || authoredID === inspected.loadoutID) return inspected;
    const authored = inspectRow(authoredID);
    if (authored.status !== "ARMED") {
      return Object.assign({}, inspected, { authoredRefusal: String(authored.reason || "UNKNOWN") });
    }
    if (!(authored.chargeDepth > inspected.chargeDepth)) {
      return Object.assign({}, inspected, { authoredRefusal: "AUTHORED_DEPTH_NOT_DEEPER" });
    }
    return Object.assign({}, authored, { baseLoadoutID: inspected.loadoutID });
  }

  // The loadout row a spawn must name for this profile ("" = keep the profile's
  // own row, which is already valid).
  function resolve({ profileID, loadoutID = "", depth = 0, requireAmmoDepth = false } = {}) {
    const id = String(profileID || "").trim();
    if (!id) return refuse("PROFILE_REQUIRED");
    let profile = null;
    try {
      profile = getProfile(id);
    } catch (_error) {
      return refuse("PROFILE_LOOKUP_FAILED", { profileID: id });
    }
    if (!profile || String(profile.profileID || "").trim() !== id) {
      return refuse("PROFILE_NOT_FOUND", { profileID: id });
    }
    const explicit = String(loadoutID || "").trim();
    const ownLoadoutID = String(profile.loadoutID || "").trim();
    // An already armed authored loadout is never replaced: the override exists
    // for profiles that stock left on the retail empty row. It is still deepened
    // when its own row would fit a single charge per weapon.
    if (!explicit && ownLoadoutID && ownLoadoutID !== RETAIL_EMPTY_LOADOUT_ID) {
      const own = withAuthoredDepth(inspectRow(ownLoadoutID), depth);
      if (own.status === "ARMED") {
        if (requireAmmoDepth === true && !(own.chargeDepth > 1)) {
          return refuse("NO_MULTI_CHARGE_ROW", {
            profileID: id,
            ownLoadoutID,
            loadoutID: own.loadoutID,
            chargeDepth: own.chargeDepth,
            authoredRefusal: String(own.authoredRefusal || ""),
          });
        }
        return {
          status: "ALREADY_ARMED",
          reason: own.loadoutID !== ownLoadoutID
            ? "PROFILE_LOADOUT_ALREADY_ARMED_DEEPENED"
            : "PROFILE_LOADOUT_ALREADY_ARMED",
          override: own.loadoutID !== ownLoadoutID,
          profileID: id,
          loadoutID: own.loadoutID,
          moduleTypeID: own.moduleTypeID,
          chargeTypeID: own.chargeTypeID,
          moduleFamily: own.moduleFamily,
          chargeDepth: own.chargeDepth,
        };
      }
    }
    const candidateID = explicit || `${id}_loadout`;
    if (candidateID === RETAIL_EMPTY_LOADOUT_ID) {
      return refuse("RETAIL_EMPTY_LOADOUT", { profileID: id, loadoutID: candidateID });
    }
    const inspected = withAuthoredDepth(inspectRow(candidateID), depth);
    if (inspected.status !== "ARMED") {
      return Object.assign({}, inspected, { profileID: id, ownLoadoutID });
    }
    const deepened = inspected.loadoutID !== candidateID;
    if (requireAmmoDepth === true && !(inspected.chargeDepth > 1)) {
      // A single fitted charge is one volley: refuse instead of pretending that
      // a hull which cannot fire twice is a war patrol.
      return refuse("NO_MULTI_CHARGE_ROW", {
        profileID: id,
        ownLoadoutID,
        loadoutID: inspected.loadoutID,
        chargeDepth: inspected.chargeDepth,
        authoredRefusal: String(inspected.authoredRefusal || ""),
      });
    }
    return {
      status: "RESOLVED",
      reason: deepened ? "AUTHORED_MULTI_CHARGE_ROW" : "AUTHORED_LOADOUT_ROW",
      override: true,
      profileID: id,
      ownLoadoutID,
      loadoutID: inspected.loadoutID,
      loadoutName: inspected.loadoutName,
      moduleTypeID: inspected.moduleTypeID,
      chargeTypeID: inspected.chargeTypeID,
      moduleFamily: inspected.moduleFamily,
      weaponCount: inspected.weapons.length,
      chargeDepth: inspected.chargeDepth,
    };
  }

  return Object.freeze({ resolve });
}

module.exports = {
  createWarPatrolLoadout,
  WEAPON_FAMILIES,
  RETAIL_EMPTY_LOADOUT_ID,
};
