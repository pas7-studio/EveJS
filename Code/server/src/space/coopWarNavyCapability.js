"use strict";
// FW-036: a war party must be able to field a real navy.
//
// Measured on the work stack 2026-10-28: `war:500011-500014` opened with
// 500014 = ORE as a party. Every ORE row that even carries charges is a mining
// hull (`ore_mining_*_strip_pair`, `ore_mining_*_dual_miner`), so the attacker
// could never reach ASSAULT, no defending wreck could ever exist, and because
// that campaign held the target system every other front answered
// `NO_OPENABLE_FRONT` - one un-fightable war starved the whole frontier.
//
// A campaign is therefore opened only when BOTH sides can really shoot: the
// capture rule (FW-035) needs a defending wreck, and a defender without a navy
// can never produce one. Nothing here invents a hull, a doctrine row, a charge
// or a faction: it reads the same composition the sanctioned spawn path uses.

const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

// Pure. `hulls` are already-resolved real rows from the doctrine composition:
// each one carries the loadout row the native spawn would fit. A hull is
// combat-capable only when that row really carries a module AND at least one
// charge, which is exactly what the native spawn enforces and the trap that made
// every SDE navy profile (`retail_empty_npc_entity_loadout`) spawn defenceless.
function evaluateNavy({ factionID, hulls = [], isWeapon = null } = {}) {
  const faction = Number(factionID);
  if (!pos(faction)) return { status: "INVALID_FACTION", factionID: 0, armedHulls: 0, hulls: [] };
  // A mining laser also carries "modules" and a charge, which is exactly how ORE
  // looked armed. Unless the module really resolves to a weapon family the hull
  // is not a navy, and an unknown resolver is never treated as a weapon.
  const weapon = (typeID) => {
    if (typeof isWeapon !== "function") return false;
    try { return isWeapon(Number(typeID)) === true; } catch (_error) { return false; }
  };
  const armed = [];
  for (const hull of Array.isArray(hulls) ? hulls : []) {
    const modules = Array.isArray(hull?.modules) ? hull.modules : [];
    const charges = Array.isArray(hull?.charges) ? hull.charges : [];
    if (!modules.length || !charges.length) continue;
    if (!modules.some((module) => weapon(module?.typeID))) continue;
    if (!charges.some((charge) => Number(charge?.quantityPerModule) >= 1)) continue;
    if (!pos(hull?.typeID) && !String(hull?.loadoutID || "").trim()) continue;
    armed.push({
      typeID: Number(hull?.typeID) || 0,
      loadoutID: String(hull?.loadoutID || ""),
      role: String(hull?.role || ""),
    });
  }
  if (!armed.length) return { status: "NO_NAVY", factionID: faction, armedHulls: 0, hulls: [] };
  return { status: "CAN_FIELD", factionID: faction, armedHulls: armed.length, hulls: armed };
}

// Pure dynamic decision for one border. Both sides must be able to fight, and an
// unknown capability is never treated as a yes.
function decideFront({ attacker, defender } = {}) {
  if (attacker?.status !== "CAN_FIELD")
    return { open: false, reason: "NO_NAVY_CAPABILITY:ATTACKER" };
  if (defender?.status !== "CAN_FIELD")
    return { open: false, reason: "NO_NAVY_CAPABILITY:DEFENDER" };
  return { open: true, reason: "BOTH_SIDES_CAN_FIELD_NAVY" };
}

// Adapter over real authorities: compose the faction's own doctrine and resolve
// every loadout row from the real static table. Refusals stay refusals.
function createNavyCapability({ compose, getLoadout, isWeapon } = {}) {
  if (typeof compose !== "function" || typeof getLoadout !== "function" ||
    typeof isWeapon !== "function")
    throw Error("WAR_NAVY_CAPABILITY_AUTHORITIES_REQUIRED");
  const cache = new Map();
  function faction(factionID) {
    const id = Number(factionID);
    if (!pos(id)) return { status: "INVALID_FACTION", factionID: 0, armedHulls: 0, hulls: [] };
    if (cache.has(id)) return cache.get(id);
    let plan = null;
    try { plan = compose({ factionID: id, merit: 0, rank: "" }); } catch (_error) { plan = null; }
    const ships = plan && plan.status === "COMPOSED" && Array.isArray(plan.ships) ? plan.ships : [];
    const hulls = [];
    for (const ship of ships) {
      let row = null;
      try { row = getLoadout(String(ship?.loadoutID || "")); } catch (_error) { row = null; }
      if (!row) continue;
      hulls.push({
        typeID: Number(ship?.hullTypeID) || 0,
        loadoutID: String(ship?.loadoutID || ""),
        role: String(ship?.role || ""),
        modules: Array.isArray(row.modules) ? row.modules : [],
        charges: Array.isArray(row.charges) ? row.charges : [],
      });
    }
    const evaluated = evaluateNavy({ factionID: id, hulls, isWeapon });
    cache.set(id, evaluated);
    return evaluated;
  }
  function decide({ attackerFactionID, defenderFactionID } = {}) {
    return decideFront({ attacker: faction(attackerFactionID), defender: faction(defenderFactionID) });
  }
  return Object.freeze({ faction, decide });
}

module.exports = { evaluateNavy, decideFront, createNavyCapability };
