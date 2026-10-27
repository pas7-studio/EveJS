"use strict";
// Which native spawn pool a virtual pilot becomes.
//
// Why this exists: the EVE client colours a bracket by the ship's real owner
// faction, and every virtual pilot used to spawn from `npc_hostiles` (Blood
// Raiders, faction 500012). Traders, miners and patrols therefore rendered
// hostile-red even though they had no aggression. Choosing the pool per role
// makes colour meaningful: red means a real pirate.
//
// Pools and fallbacks are real SDE rows, verified against
// tools/DatabaseCreator/staticTables/npcSpawnPools|npcProfiles:
//   npc_mining_ops            ORE mining ships (faction 500014, corp 1000129)
//   npc_mining_hauler_highsec ORE industrial haulers (same owner)
//   concord_police            CONCORD (faction 500006, corp 1000125)
//   npc_hostiles              pirate factions (Blood Raiders etc.)
const ROLE_POOLS = Object.freeze({
  miner: Object.freeze({ defaultPoolID: "npc_mining_ops", fallbackProfileID: "ore_mining_venture" }),
  hauler: Object.freeze({ defaultPoolID: "npc_mining_hauler_highsec", fallbackProfileID: "ore_mining_badger_hauler" }),
  trader: Object.freeze({ defaultPoolID: "npc_mining_hauler_highsec", fallbackProfileID: "ore_mining_badger_hauler" }),
  patrol: Object.freeze({ defaultPoolID: "concord_police", fallbackProfileID: "concord_police_cruiser" }),
  pirate: Object.freeze({ defaultPoolID: "npc_hostiles", fallbackProfileID: "generic_hostile" }),
});

// The pre-existing behaviour, kept for the OFF default.
const LEGACY_POOL = Object.freeze({ defaultPoolID: "npc_hostiles", fallbackProfileID: "generic_hostile" });

const ROLES = Object.freeze(Object.keys(ROLE_POOLS));

function spawnPoolForRole(role, { enabled = false } = {}) {
  if (!enabled) return { ...LEGACY_POOL };
  const entry = ROLE_POOLS[String(role || "")];
  if (!entry) return { ...LEGACY_POOL };
  return { ...entry };
}

// Native aggression policy per role. The SDE pools we use for civilians and
// guards inherit a profile that never auto-attacks a player, so a pirate that
// only differs by hull colour ignores a capsuleer sitting next to it. Pirates
// get the same explicit target classes the native gate-rats rule uses
// (`npcDefaultConcordRules` / dynamic gate rats: autoAggro + ["player"]), plus
// "npc" so the existing rival-combat director keeps working.
const PIRATE_AGGRESSION = Object.freeze({
  autoAggro: true,
  autoAggroTargetClasses: Object.freeze(["player", "npc"]),
  allowPodKill: false,
});
const CIVILIAN_CALM = Object.freeze({
  autoAggro: false,
  autoActivateWeapons: false,
  targetPreference: "none",
});

function behaviorOverridesForRole(role, { enabled = false } = {}) {
  if (!enabled) return {}; // legacy: the pool profile decides, as before
  if (isHostileRole(role)) {
    return {
      behaviorOverrides: {
        ...PIRATE_AGGRESSION,
        autoAggroTargetClasses: [...PIRATE_AGGRESSION.autoAggroTargetClasses],
      },
    };
  }
  return { behaviorOverrides: { ...CIVILIAN_CALM } };
}

function isHostileRole(role) {
  return String(role || "") === "pirate";
}

function isHostilePool(pool) {
  return String(pool || "") === "npc_hostiles";
}

module.exports = { ROLE_POOLS, LEGACY_POOL, ROLES, spawnPoolForRole, behaviorOverridesForRole, isHostileRole, isHostilePool };
