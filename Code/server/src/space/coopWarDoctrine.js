"use strict";
// FW-026 (doctrine fleet): real navy/pirate fleet doctrines, authored as real
// `npcLoadouts` rows.
//
// Why this exists: a faction war needs fleets that look and behave like fleets
// players fly - tackle, brawler, sniper, logistics, EWAR and a heavy line - not
// one hull with one gun. Every doctrine here names a REAL SDE profile (the hull
// the faction really flies in this build) and a REAL fitting: every module and
// every charge typeID is resolved through the item registry, every weapon must
// have a charge the native capability resolver accepts, and every module must
// declare a slot family the hull can really take. Nothing is invented: a
// doctrine that does not validate is refused with an exact reason.
//
// Measured hull reality in this build (do not dress it up): every navy and pirate
// combat profile points at a category-11 NPC *entity* hull, not a category-6
// player ship (278 Caldari/Gallente navy profiles: 0 on a player hull; only
// CONCORD and ORE fly real player hulls). An entity hull carries a real dogma
// record (65-86 attributes) but no slot attributes, so the native auto-fit uses
// its documented base flag list (`getSlotFlagsForFamily` falls back to it when
// the slot count is 0). The doctrine reports `hull.kind` and `hull.slotMode`
// instead of claiming slots the data does not have.
//
// The row is exposed to the native spawn path through the same single hook the
// pirate patrol row uses (`coopWarPatrolLoadoutRow.resolveRow`), so the L1
// loadout override fits it without a second patching mechanism.
const ID_PREFIX = "coop_war_doctrine";
const MIN_AMMO_DEPTH = 2;
const MAX_AMMO_DEPTH = 1000;
const MAX_MODULES = 32;
const WEAPON_FAMILIES = Object.freeze([
  "missileLauncher",
  "projectileTurret",
  "hybridTurret",
  "precursorTurret",
  "laserTurret",
]);
const WEAPON_FAMILY_SET = new Set(WEAPON_FAMILIES);
// FW-116: a destroyer role joins the six. It exists to kill the enemy's tackle, which is
// the one job a frigate-sized gang could not do before.
const ROLES = Object.freeze(["tackle", "anti-tackle", "brawler", "sniper", "logistics",
  "ewar", "heavy"]);
const SLOT_FAMILIES = new Set(["high", "med", "low"]);
// Category 6 = a real player ship, category 11 = a real NPC entity hull. Every
// navy/pirate combat profile in this build points at category 11 (measured:
// 278 Caldari/Gallente navy profiles, 0 of them on a player hull), so a doctrine
// accepts both and REPORTS which one it flies instead of pretending.
const HULL_CATEGORIES = new Set([6, 11]);

// Real module typeIDs, all present in this build's item registry (verified:
// group/category/slot family and charge compatibility against the live SDE).
const M = Object.freeze({
  warpDisruptor2: 3244,       // Warp Disruptor II          (med)
  warpScrambler2: 448,        // Warp Scrambler II          (med)
  stasisWeb2: 527,            // Stasis Webifier II         (med)
  sensorDampener2: 1969,      // Remote Sensor Dampener II  (med)
  trackingDisruptor2: 2109,   // Tracking Disruptor II      (med)
  remoteShield2: 3598,        // Medium Remote Shield Booster II (high)
  remoteShieldSmall2: 3588,   // Small Remote Shield Booster II  (high)
  remoteArmor1: 11357,        // Medium Remote Armor Repairer I  (high)
  remoteArmorSmall1: 11355,   // Small Remote Armor Repairer I   (high)
  damageControl2: 2048,       // Damage Control II          (low)
  lightNeutronBlaster1: 564,  // Light Neutron Blaster I    (high)
  heavyNeutronBlaster1: 568,  // Heavy Neutron Blaster I    (high)
  neutronBlasterCannon1: 572, // Neutron Blaster Cannon I   (high)
  lightElectronBlaster1: 562, // Light Electron Blaster I   (high)
  heavyElectronBlaster1: 566, // Heavy Electron Blaster I   (high)
  rail75: 561,                // 75mm Gatling Rail I        (high)
  rail250: 570,               // 250mm Railgun I            (high)
  rail425: 574,               // 425mm Railgun I            (high)
  lightMissile2: 2404,        // Light Missile Launcher II  (high)
  heavyMissile2: 2410,        // Heavy Missile Launcher II  (high)
  cruiseLauncher1: 13320,     // Cruise Missile Launcher I  (high)
  gatling125: 484,            // 125mm Gatling AutoCannon I (high)
  autoCannon200: 486,         // 200mm AutoCannon I         (high)
  autoCannon220: 490,         // 220mm Vulcan AutoCannon I  (high, medium charge)
  autoCannon425: 491,         // 425mm AutoCannon I         (high, medium charge)
});

// One doctrine = one real hull class + one real fitting. `chargePattern` picks a
// real charge the native resolver says is compatible; the first compatible
// charge whose name matches wins, so a doctrine never carries invented ammo.
const DOCTRINES = Object.freeze({
  500001: Object.freeze({ // Caldari State - shield / hybrid / missile navy
    // FW-116: a destroyer that exists to kill the enemy's tackle. Real SDE hull and
    // real small hybrid guns: high tracking, short range, one web to hold what it catches.
    "anti-tackle": {
      role: "anti-tackle", hullClass: "destroyer",
      profileID: "parity_mission_caldari_state_45462_caldari_ca_destroyer",
      weapons: [{ typeID: M.rail75, quantity: 4 }],
      utility: [{ typeID: M.stasisWeb2, quantity: 1 }],
      chargePattern: "^Antimatter Charge S$", ammoDepth: 60,
    },
    tackle: {
      role: "tackle", hullClass: "frigate",
      profileID: "parity_mission_caldari_state_14359_caldari_navy_condor",
      weapons: [{ typeID: M.lightNeutronBlaster1, quantity: 2 }],
      utility: [{ typeID: M.warpDisruptor2, quantity: 1 }],
      chargePattern: "^Antimatter Charge S$", ammoDepth: 60,
    },
    brawler: {
      role: "brawler", hullClass: "cruiser",
      profileID: "parity_mission_caldari_state_15320_caldari_navy_moa",
      weapons: [{ typeID: M.heavyNeutronBlaster1, quantity: 4 }],
      utility: [{ typeID: M.stasisWeb2, quantity: 1 }, { typeID: M.damageControl2, quantity: 1 }],
      chargePattern: "^Antimatter Charge M$", ammoDepth: 60,
    },
    sniper: {
      role: "sniper", hullClass: "battleship",
      profileID: "parity_mission_caldari_state_15326_caldari_navy_scorpion",
      weapons: [{ typeID: M.rail425, quantity: 4 }],
      utility: [{ typeID: M.sensorDampener2, quantity: 1 }],
      chargePattern: "^Thorium Charge L$", ammoDepth: 40,
    },
    logistics: {
      role: "logistics", hullClass: "frigate",
      profileID: "parity_mission_caldari_state_15972_caldari_navy_delta_ii_support_frigate",
      weapons: [{ typeID: M.lightMissile2, quantity: 1 }],
      utility: [{ typeID: M.remoteShieldSmall2, quantity: 2 }],
      chargePattern: "^Scourge Light Missile$", ammoDepth: 40,
    },
    ewar: {
      role: "ewar", hullClass: "cruiser",
      profileID: "parity_mission_caldari_state_12394_caldari_navy_blackbird",
      weapons: [{ typeID: M.heavyMissile2, quantity: 2 }],
      utility: [{ typeID: M.sensorDampener2, quantity: 2 }],
      chargePattern: "^Scourge Heavy Missile$", ammoDepth: 40,
    },
    heavy: {
      role: "heavy", hullClass: "battleship",
      profileID: "parity_mission_caldari_state_12391_caldari_navy_raven",
      weapons: [{ typeID: M.cruiseLauncher1, quantity: 4 }],
      utility: [{ typeID: M.damageControl2, quantity: 1 }],
      chargePattern: "^Scourge Cruise Missile$", ammoDepth: 40,
    },
  }),
  500004: Object.freeze({ // Gallente Federation - armour / hybrid / dampeners
    // FW-116: the Gallente answer to enemy tackle - a blaster destroyer with a web.
    "anti-tackle": {
      role: "anti-tackle", hullClass: "destroyer",
      profileID: "parity_mission_gallente_federation_25127_federation_arcus",
      weapons: [{ typeID: M.lightNeutronBlaster1, quantity: 4 }],
      utility: [{ typeID: M.stasisWeb2, quantity: 1 }],
      chargePattern: "^Antimatter Charge S$", ammoDepth: 60,
    },
    tackle: {
      role: "tackle", hullClass: "frigate",
      profileID: "parity_mission_gallente_federation_14361_federation_navy_atron",
      weapons: [{ typeID: M.lightElectronBlaster1, quantity: 2 }],
      utility: [{ typeID: M.warpScrambler2, quantity: 1 }],
      chargePattern: "^Antimatter Charge S$", ammoDepth: 60,
    },
    brawler: {
      role: "brawler", hullClass: "cruiser",
      profileID: "parity_mission_gallente_federation_12440_federation_navy_vexor",
      weapons: [{ typeID: M.heavyElectronBlaster1, quantity: 4 }],
      utility: [{ typeID: M.stasisWeb2, quantity: 1 }, { typeID: M.damageControl2, quantity: 1 }],
      chargePattern: "^Antimatter Charge M$", ammoDepth: 60,
    },
    sniper: {
      role: "sniper", hullClass: "battleship",
      profileID: "parity_mission_gallente_federation_12390_federation_navy_megathron",
      weapons: [{ typeID: M.rail425, quantity: 4 }],
      utility: [{ typeID: M.sensorDampener2, quantity: 1 }],
      chargePattern: "^Thorium Charge L$", ammoDepth: 40,
    },
    logistics: {
      role: "logistics", hullClass: "frigate",
      profileID: "parity_mission_gallente_federation_15989_federation_navy_delta_ii_support_frigate",
      weapons: [{ typeID: M.lightElectronBlaster1, quantity: 1 }],
      utility: [{ typeID: M.remoteArmorSmall1, quantity: 2 }],
      chargePattern: "^Antimatter Charge S$", ammoDepth: 40,
    },
    ewar: {
      role: "ewar", hullClass: "frigate",
      profileID: "parity_mission_gallente_federation_14481_federation_navy_maulus",
      weapons: [{ typeID: M.lightElectronBlaster1, quantity: 1 }],
      utility: [{ typeID: M.sensorDampener2, quantity: 2 }],
      chargePattern: "^Antimatter Charge S$", ammoDepth: 40,
    },
    heavy: {
      role: "heavy", hullClass: "battleship",
      profileID: "parity_mission_gallente_federation_15330_federation_navy_dominix",
      weapons: [{ typeID: M.neutronBlasterCannon1, quantity: 4 }],
      utility: [{ typeID: M.damageControl2, quantity: 1 }],
      chargePattern: "^Antimatter Charge L$", ammoDepth: 40,
    },
  }),
  500011: Object.freeze({ // Angel Cartel - projectile, fast
    // FW-116: Angel anti-tackle (autocannon destroyer), plus the two roles the Cartel
    // never had - a remote-armour support cruiser and a tracking-disruptor cruiser,
    // which is exactly what an Angel gang brings to a fight.
    "anti-tackle": {
      role: "anti-tackle", hullClass: "destroyer",
      profileID: "parity_angel_autocannon_destroyer",
      weapons: [{ typeID: M.gatling125, quantity: 4 }],
      utility: [{ typeID: M.stasisWeb2, quantity: 1 }],
      chargePattern: "^EMP S$", ammoDepth: 60,
    },
    logistics: {
      role: "logistics", hullClass: "cruiser",
      profileID: "parity_angel_breaker",
      weapons: [{ typeID: M.autoCannon220, quantity: 1 }],
      utility: [{ typeID: M.remoteArmor1, quantity: 2 }],
      chargePattern: "^EMP M$", ammoDepth: 40,
    },
    ewar: {
      role: "ewar", hullClass: "cruiser",
      profileID: "parity_angel_artillery_cruiser",
      weapons: [{ typeID: M.autoCannon220, quantity: 2 }],
      utility: [{ typeID: M.trackingDisruptor2, quantity: 2 }],
      chargePattern: "^EMP M$", ammoDepth: 40,
    },
    tackle: {
      role: "tackle", hullClass: "frigate",
      profileID: "parity_angel_autocannon_frigate",
      weapons: [{ typeID: M.gatling125, quantity: 2 }],
      utility: [{ typeID: M.warpDisruptor2, quantity: 1 }],
      chargePattern: "^EMP S$", ammoDepth: 60,
    },
    brawler: {
      role: "brawler", hullClass: "cruiser",
      profileID: "parity_angel_autocannon_cruiser",
      weapons: [{ typeID: M.autoCannon220, quantity: 4 }],
      utility: [{ typeID: M.stasisWeb2, quantity: 1 }],
      chargePattern: "^EMP M$", ammoDepth: 60,
    },
    heavy: {
      role: "heavy", hullClass: "battleship",
      profileID: "parity_angel_autocannon_battleship",
      weapons: [{ typeID: M.autoCannon425, quantity: 4 }],
      utility: [{ typeID: M.warpDisruptor2, quantity: 1 }],
      chargePattern: "^EMP M$", ammoDepth: 60,
    },
  }),
  500020: Object.freeze({ // Serpentis - blasters, dampeners
    // FW-116: Serpentis anti-tackle (rail destroyer), a remote-armour support cruiser, a
    // blaster battleship and a rail battleship - the Cartel now has every role but the
    // pure long-range sniper hull it never fielded.
    "anti-tackle": {
      role: "anti-tackle", hullClass: "destroyer",
      profileID: "parity_serpentis_rail_destroyer",
      weapons: [{ typeID: M.rail75, quantity: 4 }],
      utility: [{ typeID: M.stasisWeb2, quantity: 1 }],
      chargePattern: "^Antimatter Charge S$", ammoDepth: 60,
    },
    logistics: {
      role: "logistics", hullClass: "cruiser",
      profileID: "parity_serpentis_blaster_cruiser",
      weapons: [{ typeID: M.heavyElectronBlaster1, quantity: 1 }],
      utility: [{ typeID: M.remoteArmor1, quantity: 2 }],
      chargePattern: "^Antimatter Charge M$", ammoDepth: 40,
    },
    heavy: {
      role: "heavy", hullClass: "battleship",
      profileID: "parity_serpentis_blaster_battleship",
      weapons: [{ typeID: M.neutronBlasterCannon1, quantity: 4 }],
      utility: [{ typeID: M.damageControl2, quantity: 1 }],
      chargePattern: "^Antimatter Charge L$", ammoDepth: 40,
    },
    sniper: {
      role: "sniper", hullClass: "battleship",
      profileID: "parity_serpentis_rail_battleship",
      weapons: [{ typeID: M.rail425, quantity: 4 }],
      utility: [{ typeID: M.sensorDampener2, quantity: 1 }],
      chargePattern: "^Thorium Charge L$", ammoDepth: 40,
    },
    tackle: {
      role: "tackle", hullClass: "frigate",
      profileID: "parity_serpentis_blaster_frigate",
      weapons: [{ typeID: M.lightNeutronBlaster1, quantity: 2 }],
      utility: [{ typeID: M.warpDisruptor2, quantity: 1 }],
      chargePattern: "^Antimatter Charge S$", ammoDepth: 60,
    },
    brawler: {
      role: "brawler", hullClass: "cruiser",
      profileID: "parity_serpentis_blaster_cruiser",
      weapons: [{ typeID: M.heavyNeutronBlaster1, quantity: 4 }],
      utility: [{ typeID: M.sensorDampener2, quantity: 1 }],
      chargePattern: "^Antimatter Charge M$", ammoDepth: 60,
    },
    ewar: {
      role: "ewar", hullClass: "cruiser",
      profileID: "parity_serpentis_blaster_cruiser",
      weapons: [{ typeID: M.heavyNeutronBlaster1, quantity: 2 }],
      utility: [{ typeID: M.sensorDampener2, quantity: 2 }],
      chargePattern: "^Antimatter Charge M$", ammoDepth: 40,
    },
  }),
});

const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const refuse = (reason, extra) => Object.assign({ status: "REFUSED", reason }, extra || {});
const clone = (value) => JSON.parse(JSON.stringify(value));

function doctrineIDFor(factionID, role) {
  const f = Number(factionID);
  const r = String(role || "").trim();
  if (!pos(f) || !ROLES.includes(r)) return "";
  return ID_PREFIX + "_" + f + "_" + r;
}

function parseDoctrineID(loadoutID) {
  const id = String(loadoutID || "").trim();
  if (!id.startsWith(ID_PREFIX + "_")) return null;
  const rest = id.slice(ID_PREFIX.length + 1);
  const cut = rest.indexOf("_");
  if (cut <= 0) return null;
  const factionID = Number(rest.slice(0, cut));
  const role = rest.slice(cut + 1).trim();
  if (!pos(factionID) || !ROLES.includes(role)) return null;
  if (doctrineIDFor(factionID, role) !== id) return null;
  return { factionID, role };
}

function defaultAuthorities() {
  const database = require("../gameStore");
  const registry = require("../services/inventory/itemTypeRegistry");
  const dogma = require("./combat/weaponDogma");
  const capability = require("./npc/npcCapabilityResolver");
  const fitting = require("../services/fitting/liveFittingState");
  return {
    getProfile: (profileID) => {
      const rows = database.read("npcProfiles", "/");
      const list = rows && rows.success && rows.data && Array.isArray(rows.data.profiles)
        ? rows.data.profiles : [];
      return list.find((row) => String(row && row.profileID || "") === String(profileID)) || null;
    },
    resolveItemByTypeID: registry.resolveItemByTypeID,
    resolveWeaponFamily: (item) => dogma.resolveWeaponFamily(item),
    isCompatibleCharge: (module, chargeTypeID) =>
      capability.isNpcChargeCompatibleWithModule(module, chargeTypeID),
    listCharges: () => {
      const rows = database.read("itemTypes", "/");
      const list = rows && rows.success && rows.data && Array.isArray(rows.data.types)
        ? rows.data.types : [];
      return list.filter((row) => Number(row.categoryID) === 8)
        .map((row) => ({ typeID: Number(row.typeID), name: String(row.name || "") }));
    },
    slotFamilyFor: (typeID) => fitting.getRequiredSlotFamily(typeID),
    hullSlotsFor: (typeID) => fitting.getShipSlotCounts(typeID),
    dogmaAttributeCountFor: (typeID) => Object.keys(fitting.getTypeDogmaAttributes(typeID) || {}).length,
  };
}

function createWarDoctrine(injected) {
  const base = injected && typeof injected === "object" ? injected : {};
  const KEYS = ["getProfile", "resolveItemByTypeID", "resolveWeaponFamily",
    "isCompatibleCharge", "listCharges", "slotFamilyFor", "hullSlotsFor",
    "dogmaAttributeCountFor"];
  let authorities = null;
  const authoritiesFor = () => {
    if (authorities) return authorities;
    const provided = {};
    for (const key of KEYS) if (base[key] !== undefined) provided[key] = base[key];
    authorities = Object.keys(provided).length === KEYS.length
      ? provided
      : Object.assign(defaultAuthorities(), provided);
    for (const key of KEYS) {
      if (typeof authorities[key] !== "function") {
        throw Error("WAR_DOCTRINE_AUTHORITIES_REQUIRED");
      }
    }
    return authorities;
  };

  function pickCharge(weaponTypeID, pattern) {
    const a = authoritiesFor();
    let re = null;
    try {
      re = new RegExp(String(pattern || ""));
    } catch (_error) {
      return refuse("CHARGE_PATTERN_INVALID", { weaponTypeID, pattern: String(pattern || "") });
    }
    let charges = [];
    try {
      charges = a.listCharges();
    } catch (_error) {
      return refuse("CHARGE_REGISTRY_UNAVAILABLE", { weaponTypeID });
    }
    const compatible = [];
    for (const charge of charges) {
      if (!pos(charge && charge.typeID)) continue;
      let ok = false;
      try {
        ok = a.isCompatibleCharge({ typeID: weaponTypeID, moduleID: 1, flagID: 92 }, charge.typeID) === true;
      } catch (_error) {
        ok = false;
      }
      if (ok) compatible.push(charge);
    }
    if (!compatible.length) return refuse("NO_COMPATIBLE_CHARGE", { weaponTypeID });
    const chosen = compatible.find((charge) => re.test(String(charge.name || ""))) || null;
    if (!chosen) {
      return refuse("CHARGE_NOT_FOUND", {
        weaponTypeID, pattern: String(pattern || ""),
        compatibleCount: compatible.length,
      });
    }
    return { status: "RESOLVED", typeID: chosen.typeID, name: String(chosen.name || "") };
  }

  // One doctrine -> a fully validated fitting (never a partial one).
  function resolve({ factionID, role } = {}) {
    const f = Number(factionID);
    const r = String(role || "").trim();
    if (!pos(f)) return refuse("FACTION_REQUIRED");
    const table = DOCTRINES[f];
    if (!table) return refuse("FACTION_UNSUPPORTED", { factionID: f });
    if (!ROLES.includes(r)) return refuse("ROLE_UNKNOWN", { role: r, roles: ROLES.slice() });
    const spec = table[r];
    if (!spec) return refuse("DOCTRINE_UNSUPPORTED", { factionID: f, role: r });
    const a = authoritiesFor();
    let profile = null;
    try {
      profile = a.getProfile(spec.profileID);
    } catch (_error) {
      return refuse("PROFILE_LOOKUP_FAILED", { profileID: spec.profileID });
    }
    if (!profile || String(profile.profileID || "") !== spec.profileID) {
      return refuse("PROFILE_MISSING", { profileID: spec.profileID });
    }
    const hullTypeID = Number(profile.shipTypeID || profile.typeID);
    if (!pos(hullTypeID)) return refuse("HULL_TYPE_MISSING", { profileID: spec.profileID });
    let hull = null;
    try {
      hull = a.resolveItemByTypeID(hullTypeID);
    } catch (_error) {
      hull = null;
    }
    if (!hull || Number(hull.typeID) !== hullTypeID || !HULL_CATEGORIES.has(Number(hull.categoryID))) {
      return refuse("HULL_UNVERIFIED", {
        profileID: spec.profileID, hullTypeID,
        categoryID: hull ? Number(hull.categoryID) || 0 : 0,
      });
    }
    let dogmaAttributes = 0;
    try {
      dogmaAttributes = Number(a.dogmaAttributeCountFor(hullTypeID)) || 0;
    } catch (_error) {
      dogmaAttributes = 0;
    }
    if (!(dogmaAttributes > 0)) {
      return refuse("HULL_DOGMA_MISSING", { profileID: spec.profileID, hullTypeID });
    }
    const hullKind = Number(hull.categoryID) === 6 ? "SHIP_HULL" : "ENTITY_HULL";
    let hullSlots = null;
    try {
      hullSlots = a.hullSlotsFor(hullTypeID);
    } catch (_error) {
      hullSlots = null;
    }
    const declaredSlots = hullSlots
      ? ["high", "med", "low"].reduce((sum, key) => sum + (Number(hullSlots[key]) || 0), 0)
      : 0;
    // Real slots: when the hull declares them, the fitting must fit. Navy NPC
    // entity hulls carry a real dogma record but no slot attributes, and the
    // native auto-fit then uses its documented base flag list
    // (`getSlotFlagsForFamily` falls back to it when the count is 0).
    const slotMode = declaredSlots > 0 ? "HULL_SLOTS" : "NATIVE_AUTOFIT_FALLBACK";
    const modules = [];
    const charges = [];
    const used = { high: 0, med: 0, low: 0 };
    const entries = [
      ...(Array.isArray(spec.weapons) ? spec.weapons : []).map((entry) => ({ ...entry, weapon: true })),
      ...(Array.isArray(spec.utility) ? spec.utility : []).map((entry) => ({ ...entry, weapon: false })),
    ];
    if (!entries.length) return refuse("FITTING_EMPTY", { doctrineID: doctrineIDFor(f, r) });
    if (entries.length > MAX_MODULES) return refuse("FITTING_TOO_LARGE", { modules: entries.length });
    for (const entry of entries) {
      const typeID = Number(entry && entry.typeID);
      const quantity = Math.max(1, Number(entry && entry.quantity) || 1);
      if (!pos(typeID)) return refuse("MODULE_INVALID", { doctrineID: doctrineIDFor(f, r) });
      let item = null;
      try {
        item = a.resolveItemByTypeID(typeID);
      } catch (_error) {
        item = null;
      }
      if (!item || Number(item.typeID) !== typeID || Number(item.categoryID) !== 7) {
        return refuse("MODULE_UNVERIFIED", { typeID });
      }
      let slotFamily = "";
      try {
        slotFamily = String(a.slotFamilyFor(typeID) || "");
      } catch (_error) {
        slotFamily = "";
      }
      if (!SLOT_FAMILIES.has(slotFamily)) {
        return refuse("MODULE_SLOT_UNVERIFIED", { typeID, name: String(item.name || ""), slotFamily });
      }
      let family = "";
      try {
        family = String(a.resolveWeaponFamily({ typeID }) || "");
      } catch (_error) {
        family = "";
      }
      if (entry.weapon === true && !WEAPON_FAMILY_SET.has(family)) {
        return refuse("WEAPON_FAMILY_UNVERIFIED", { typeID, name: String(item.name || ""), family });
      }
      if (entry.weapon !== true && WEAPON_FAMILY_SET.has(family)) {
        return refuse("UTILITY_IS_WEAPON", { typeID, name: String(item.name || ""), family });
      }
      used[slotFamily] += quantity;
      modules.push({ typeID, quantity, slotFamily, ...(family ? { family } : {}) });
      if (entry.weapon === true) {
        const charge = pickCharge(typeID, spec.chargePattern);
        if (charge.status !== "RESOLVED") return charge;
        if (!charges.some((existing) => existing.typeID === charge.typeID)) {
          charges.push({ typeID: charge.typeID, quantityPerModule: 0, name: charge.name });
        }
      }
    }
    if (!modules.some((module) => module.family)) return refuse("NO_REAL_WEAPON_MODULE");
    const depth = Number(spec.ammoDepth);
    if (!Number.isSafeInteger(depth) || depth < MIN_AMMO_DEPTH || depth > MAX_AMMO_DEPTH) {
      return refuse("AMMO_DEPTH_OUT_OF_RANGE", { ammoDepth: spec.ammoDepth });
    }
    for (const charge of charges) charge.quantityPerModule = depth;
    if (slotMode === "HULL_SLOTS") {
      for (const key of ["high", "med", "low"]) {
        if (used[key] > (Number(hullSlots[key]) || 0)) {
          return refuse("HULL_SLOT_SHORT", {
            hullTypeID, slot: key, needed: used[key], available: Number(hullSlots[key]) || 0,
          });
        }
      }
    }
    const loadoutID = doctrineIDFor(f, r);
    const row = {
      loadoutID,
      name: String(hull.name || spec.profileID) + " - " + r + " doctrine (coop war fleet)",
      description: "Authored co-op war-fleet doctrine: real SDE profile " + spec.profileID +
        " fitted with real modules and real charges at ammo depth " + depth + ".",
      modules: modules.map((module) => ({ typeID: module.typeID, quantity: module.quantity })),
      charges: charges.map((charge) => ({ typeID: charge.typeID, quantityPerModule: depth })),
      coopAuthored: true,
      doctrineID: loadoutID,
      factionID: f,
      role: r,
      ammoDepth: depth,
    };
    return {
      status: "RESOLVED",
      doctrineID: loadoutID,
      loadoutID,
      factionID: f,
      role: r,
      hullClass: String(spec.hullClass || ""),
      profileID: spec.profileID,
      hull: {
        typeID: hullTypeID,
        name: String(hull.name || ""),
        groupName: String(hull.groupName || ""),
        categoryID: Number(hull.categoryID) || 0,
        kind: hullKind,
        dogmaAttributes,
        slots: hullSlots || null,
        slotMode,
      },
      modules,
      charges,
      slotUse: used,
      ammoDepth: depth,
      row,
    };
  }

  function resolveRow(loadoutID) {
    const parsed = parseDoctrineID(loadoutID);
    if (!parsed) return null;
    const resolved = resolve(parsed);
    return resolved.status === "RESOLVED" ? resolved.row : null;
  }

  function catalog({ factionID } = {}) {
    const f = Number(factionID);
    const table = DOCTRINES[f];
    if (!table) return { status: "REFUSED", reason: "FACTION_UNSUPPORTED", factionID: f, doctrines: [] };
    const doctrines = ROLES.filter((role) => table[role]).map((role) => {
      const resolved = resolve({ factionID: f, role });
      return resolved.status === "RESOLVED"
        ? {
          role, doctrineID: resolved.doctrineID, loadoutID: resolved.loadoutID,
          profileID: resolved.profileID, hull: resolved.hull,
          modules: resolved.modules, charges: resolved.charges,
        }
        : { role, status: "REFUSED", reason: resolved.reason };
    });
    const refused = doctrines.filter((entry) => entry.status === "REFUSED");
    return {
      status: refused.length ? "PARTIAL" : "OK",
      factionID: f,
      doctrines,
      refused: refused.length,
    };
  }

  return Object.freeze({ resolve, resolveRow, catalog, parseDoctrineID, doctrineIDFor });
}

let singleton = null;

module.exports = {
  createWarDoctrine,
  // The deployed overlay is required from the static-table resolver inside
  // npcData through coopWarPatrolLoadoutRow, which forwards an unknown authored
  // id here. Read-only, synchronous, one row, no side effects.
  resolveRow: (loadoutID) => {
    if (!singleton) singleton = createWarDoctrine();
    return singleton.resolveRow(loadoutID);
  },
  DOCTRINES,
  ROLES,
  MODULES: M,
  WEAPON_FAMILIES,
  ID_PREFIX,
  MIN_AMMO_DEPTH,
  MAX_AMMO_DEPTH,
  doctrineIDFor,
  parseDoctrineID,
};
