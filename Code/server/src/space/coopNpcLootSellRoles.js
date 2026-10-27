"use strict";
// FW-005C: who may liquidate recovered native loot at a real seeded bid.
//
// Why it exists: the loot chain (native wreck claim -> source-first cargo
// transfer -> station delivery -> seeded-market fill) was only ever offered to
// the `pirate` role. The factions that really fight a war field `patrol` hulls,
// so the very hulls that earn a wreck could never sell what they recovered, and
// their earned-ISK ledger stayed at zero forever (NO_REAL_FACTION_INCOME).
//
// This module answers one question and nothing else: may this named native NPC
// role sell looted cargo right now? It never moves cargo, never touches the
// market and never credits ISK. The default list is exactly the historical
// behaviour (`pirate`), so the switch is OFF unless the profile names a role.
const ROLES = Object.freeze(["pirate", "patrol", "trader", "hauler", "miner"]);
const DEFAULT_ROLES = Object.freeze(["pirate"]);

function lootSellRoles(env = {}) {
  const raw = env && typeof env.EVEJS_COOP_NPC_LOOT_SELL_ROLES === "string"
    ? env.EVEJS_COOP_NPC_LOOT_SELL_ROLES : "";
  if (!raw.trim()) return [...DEFAULT_ROLES];
  const out = [];
  for (const token of raw.split(",")) {
    const role = token.trim().toLowerCase();
    if (!ROLES.includes(role) || out.includes(role)) continue;
    out.push(role);
  }
  return out;
}

// A sale needs all three real facts: the loot commerce authority exists, both
// opt-in switches are on, and this role is allowed to carry loot to market.
function maySellLoot({role, env = {}, hasCommerce = false} = {}) {
  if (!env || env.EVEJS_COOP_NPC_LOOT_COMMERCE !== "1" ||
      env.EVEJS_COOP_NPC_WRECK_TRANSFER !== "1" || hasCommerce !== true)
    return false;
  const name = typeof role === "string" ? role.trim().toLowerCase() : "";
  if (!name) return false;
  return lootSellRoles(env).includes(name);
}

module.exports = {ROLES, DEFAULT_ROLES, lootSellRoles, maySellLoot};
