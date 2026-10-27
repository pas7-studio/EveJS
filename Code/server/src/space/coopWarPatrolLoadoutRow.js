"use strict";
// FW-003C (ammo depth): the authored war-patrol loadout row.
//
// Why it exists: every real `npcLoadouts` row in the static tables carries
// `charges: [{typeID, quantityPerModule: 1}]`, so a native spawn fits ONE charge
// per turret. The native ammo bank debits exactly one unit per cycle
// (`coopNpcAmmoBankAtomic.consume`: `remaining = qty - 1`), so such a hull fires
// exactly one volley and is dry forever: 24.87 measured HP against a 640 HP
// frigate can never become a kill, wreck, loot or casualty.
//
// This module authors a loadout row that is the real static row plus an ammo
// depth. Nothing is invented:
//   * the base row must exist in the real `npcLoadouts` static table;
//   * every module and every charge typeID is copied from that row unchanged;
//   * every module must resolve in the real item registry (category 7);
//   * at least one must be a real weapon of a supported dogma family;
//   * every weapon must have a charge the native capability resolver says is
//     compatible with it.
// Only `quantityPerModule` differs, which is the one field nativeNpcService
// already honours when it builds the native cargo stack
// (`server/src/space/npc/nativeNpcService.js`, `buildNativeCargoRecords`).
// Anything that does not validate is refused, never guessed.
const WEAPON_FAMILIES = Object.freeze([
  "missileLauncher",
  "projectileTurret",
  "hybridTurret",
  "precursorTurret",
  "laserTurret",
]);
const WEAPON_FAMILY_SET = new Set(WEAPON_FAMILIES);
const LOADOUT_TABLE = "npcLoadouts";
const ROW_KEY = "loadouts";
const ID_PREFIX = "coop_war_patrol_ammo";
const MIN_AMMO_DEPTH = 2;
const MAX_AMMO_DEPTH = 1000;
const MAX_ENTRIES = 32;

const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const refuse = (reason, extra) => Object.assign({ status: "REFUSED", reason }, extra || {});
const clone = (value) => JSON.parse(JSON.stringify(value));

// `coop_war_patrol_ammo<depth>_<baseLoadoutID>` -> {ammoDepth, baseLoadoutID}.
function parseAuthoredID(loadoutID) {
  const id = String(loadoutID || "").trim();
  if (!id.startsWith(ID_PREFIX)) return null;
  const rest = id.slice(ID_PREFIX.length);
  const cut = rest.indexOf("_");
  if (cut <= 0) return null;
  const depth = Number(rest.slice(0, cut));
  const baseLoadoutID = rest.slice(cut + 1).trim();
  if (!Number.isSafeInteger(depth) || depth < MIN_AMMO_DEPTH || depth > MAX_AMMO_DEPTH) return null;
  if (!baseLoadoutID || baseLoadoutID.startsWith(ID_PREFIX)) return null;
  return { ammoDepth: depth, baseLoadoutID };
}

function authoredIDFor(baseLoadoutID, ammoDepth) {
  const base = String(baseLoadoutID || "").trim();
  const depth = Number(ammoDepth);
  if (!base || base.startsWith(ID_PREFIX)) return "";
  if (!Number.isSafeInteger(depth) || depth < MIN_AMMO_DEPTH || depth > MAX_AMMO_DEPTH) return "";
  return ID_PREFIX + String(depth) + "_" + base;
}

function defaultAuthorities() {
  // Lazy: this module is also loaded by unit tests with injected authorities,
  // and by the static-table resolver inside npcData, where the SDE services may
  // not be reachable yet.
  const database = require("../gameStore");
  const registry = require("../services/inventory/itemTypeRegistry");
  const dogma = require("./combat/weaponDogma");
  const capability = require("./npc/npcCapabilityResolver");
  return {
    readStaticRows: () => {
      const result = database.read(LOADOUT_TABLE, "/");
      const rows = result && result.success && result.data ? result.data[ROW_KEY] : null;
      return Array.isArray(rows) ? rows : null;
    },
    resolveItemByTypeID: registry.resolveItemByTypeID,
    resolveWeaponFamily: (item) => dogma.resolveWeaponFamily(item),
    isCompatibleCharge: (module, chargeTypeID) =>
      capability.isNpcChargeCompatibleWithModule(module, chargeTypeID),
  };
}

function createWarPatrolLoadoutRow(injected) {
  const base = injected && typeof injected === "object" ? injected : {};
  let authorities = null;
  const authoritiesFor = () => {
    if (authorities) return authorities;
    // Injected authorities are used as given; the deployed overlay resolves the
    // SDE services lazily, because this module is also loaded by unit tests and
    // from inside the static-table resolver where those services may not exist.
    const provided = {};
    for (const key of ["readStaticRows", "resolveItemByTypeID", "resolveWeaponFamily", "isCompatibleCharge"]) {
      if (base[key] !== undefined) provided[key] = base[key];
    }
    authorities = Object.keys(provided).length === 4
      ? provided
      : Object.assign(defaultAuthorities(), provided);
    if (typeof authorities.readStaticRows !== "function" ||
      typeof authorities.resolveItemByTypeID !== "function" ||
      typeof authorities.resolveWeaponFamily !== "function" ||
      typeof authorities.isCompatibleCharge !== "function") {
      throw Error("WAR_PATROL_LOADOUT_ROW_AUTHORITIES_REQUIRED");
    }
    return authorities;
  };

  function staticRow(loadoutID) {
    const a = authoritiesFor();
    let rows = null;
    try {
      rows = a.readStaticRows();
    } catch (_error) {
      return null;
    }
    if (!Array.isArray(rows)) return null;
    const wanted = String(loadoutID || "").trim();
    return rows.find((row) => String(row && row.loadoutID || "").trim() === wanted) || null;
  }

  // The authored row: the real base row with a real ammo depth on its charges.
  function author({ baseLoadoutID, ammoDepth = 0 } = {}) {
    const parsed = parseAuthoredID(baseLoadoutID);
    const baseID = parsed ? parsed.baseLoadoutID : String(baseLoadoutID || "").trim();
    const depth = parsed ? parsed.ammoDepth : Number(ammoDepth);
    if (!baseID) return refuse("BASE_LOADOUT_REQUIRED");
    if (!Number.isSafeInteger(depth) || depth < MIN_AMMO_DEPTH || depth > MAX_AMMO_DEPTH) {
      return refuse("AMMO_DEPTH_OUT_OF_RANGE", { ammoDepth: depth });
    }
    const row = staticRow(baseID);
    if (!row) return refuse("BASE_LOADOUT_ROW_MISSING", { baseLoadoutID: baseID });
    const modules = Array.isArray(row.modules) ? row.modules : [];
    const charges = Array.isArray(row.charges) ? row.charges : [];
    if (!modules.length) return refuse("BASE_LOADOUT_HAS_NO_MODULES", { baseLoadoutID: baseID });
    if (!charges.length) return refuse("BASE_LOADOUT_HAS_NO_CHARGES", { baseLoadoutID: baseID });
    if (modules.length > MAX_ENTRIES || charges.length > MAX_ENTRIES) {
      return refuse("BASE_LOADOUT_TOO_LARGE", {
        baseLoadoutID: baseID, modules: modules.length, charges: charges.length,
      });
    }
    const a = authoritiesFor();
    const weapons = [];
    for (const entry of modules) {
      const typeID = Number(entry && entry.typeID);
      if (!pos(typeID)) return refuse("BASE_MODULE_INVALID", { baseLoadoutID: baseID });
      let item = null;
      try {
        item = a.resolveItemByTypeID(typeID);
      } catch (_error) {
        item = null;
      }
      if (!item || Number(item.typeID) !== typeID || Number(item.categoryID) !== 7) {
        return refuse("BASE_MODULE_UNVERIFIED", { baseLoadoutID: baseID, typeID });
      }
      let family = "";
      try {
        family = String(a.resolveWeaponFamily({ ...entry, typeID }) || "");
      } catch (_error) {
        family = "";
      }
      if (!WEAPON_FAMILY_SET.has(family)) continue;
      weapons.push({ typeID, family });
    }
    if (!weapons.length) return refuse("NO_REAL_WEAPON_MODULE", { baseLoadoutID: baseID });
    const loadoutID = authoredIDFor(baseID, depth);
    if (!loadoutID) return refuse("AUTHORED_ID_INVALID", { baseLoadoutID: baseID });
    const authoredCharges = [];
    for (const weapon of weapons) {
      const loaded = charges.filter((entry) => {
        const chargeTypeID = Number(entry && entry.typeID);
        if (!pos(chargeTypeID)) return false;
        let chargeItem = null;
        try {
          chargeItem = a.resolveItemByTypeID(chargeTypeID);
        } catch (_error) {
          return false;
        }
        if (!chargeItem || Number(chargeItem.categoryID) !== 8) return false;
        try {
          return a.isCompatibleCharge({ ...weapon, moduleID: 1, flagID: 92 }, chargeTypeID) === true;
        } catch (_error) {
          return false;
        }
      });
      if (!loaded.length) {
        return refuse("NO_COMPATIBLE_CHARGE", { baseLoadoutID: baseID, weaponTypeID: weapon.typeID });
      }
      const chargeTypeID = Number(loaded[0].typeID);
      if (authoredCharges.some((entry) => entry.typeID === chargeTypeID)) continue;
      authoredCharges.push({
        typeID: chargeTypeID,
        quantityPerModule: depth,
        ...(loaded[0].singleton === true ? { singleton: true } : {}),
      });
    }
    if (!authoredCharges.length) return refuse("NO_AUTHORED_CHARGE", { baseLoadoutID: baseID });
    const authored = {
      loadoutID,
      name: String(row.name || baseID) + " (coop war patrol, " + depth + " charges)",
      description: "Authored co-op war-patrol row: the real static row " + baseID +
        " with a real ammo depth of " + depth + " charges per fitted weapon.",
      modules: modules.map((entry) => clone(entry)),
      charges: authoredCharges,
      coopAuthored: true,
      baseLoadoutID: baseID,
      ammoDepth: depth,
    };
    return {
      status: "AUTHORED",
      loadoutID,
      baseLoadoutID: baseID,
      ammoDepth: depth,
      moduleCount: authored.modules.length,
      weaponCount: weapons.length,
      chargeTypeIDs: authoredCharges.map((entry) => entry.typeID),
      row: authored,
    };
  }

  // The row a named spawn asks for: either a real static row or an authored one.
  function resolveRow(loadoutID) {
    const id = String(loadoutID || "").trim();
    if (!id) return null;
    const parsed = parseAuthoredID(id);
    if (!parsed) return null;
    const authored = author({ baseLoadoutID: id });
    return authored.status === "AUTHORED" ? authored.row : null;
  }

  return Object.freeze({ author, resolveRow, parseAuthoredID, authoredIDFor });
}

let singleton = null;

module.exports = {
  createWarPatrolLoadoutRow,
  // The deployed overlay is required from the static-table resolver inside
  // npcData, which only needs this one synchronous read-only entry point.
  resolveRow: (loadoutID) => {
    if (!singleton) singleton = createWarPatrolLoadoutRow();
    const own = singleton.resolveRow(loadoutID);
    if (own) return own;
    // FW-026: a doctrine row (`coop_war_doctrine_<faction>_<role>`) is authored by
    // coopWarDoctrine and served through this same single native hook, so the
    // deployed overlay still has exactly one loadout resolver.
    try {
      return require("./coopWarDoctrine" + (__filename.endsWith(".js") ? "" : ".cjs"))
        .resolveRow(loadoutID) || null;
    } catch (_error) {
      return null;
    }
  },
  authoredIDFor,
  parseAuthoredID,
  WEAPON_FAMILIES,
  ID_PREFIX,
  MIN_AMMO_DEPTH,
  MAX_AMMO_DEPTH,
  LOADOUT_TABLE,
  ROW_KEY,
};
