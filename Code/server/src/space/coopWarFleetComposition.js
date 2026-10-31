"use strict";
// FW-026 (doctrine fleet): the composition of a faction war fleet.
//
// Why this exists: a fleet is not "N hulls". It is a role-complete formation whose
// SIZE follows the real command cap the faction war merit ledger grants that
// commander (`coopFactionWarMerit.command`: recruit 1, pilot 2, wingman 3,
// squad-lead 5, wing-lead 8, front-commander 14, admiral 25), and whose MIX is
// built from the real doctrines that faction can actually fly
// (`coopWarDoctrine`). A rank that cannot field a doctrine is refused, never
// padded with a hull the faction does not have.
//
// Role completeness (owner requirement):
//   * always at least one tackle;
//   * from wingman (cap >= 3) at least one EWAR;
//   * from squad-lead (cap >= 5) at least one logistics;
//   * from wing-lead (cap >= 8) at least one heavy line ship.
const ROLES = Object.freeze(["tackle", "anti-tackle", "brawler", "sniper", "logistics",
  "ewar", "heavy"]);
const REQUIREMENTS = Object.freeze([
  { minCap: 1, role: "tackle" },
  // FW-116: from two hulls, one of them hunts the enemy's tackle instead of adding
  // a second identical brawler.
  { minCap: 2, role: "anti-tackle" },
  { minCap: 3, role: "ewar" },
  { minCap: 5, role: "logistics" },
  { minCap: 8, role: "heavy" },
]);

// Deterministic fill order: the first slots are the ones a small gang needs.
const FILL_ORDER = Object.freeze(["tackle", "anti-tackle", "brawler", "brawler", "ewar",
  "logistics", "heavy", "sniper"]);

const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const refuse = (reason, extra) => Object.assign({ status: "REFUSED", reason }, extra || {});

function requirementsFor(cap) {
  return REQUIREMENTS.filter((entry) => Number(cap) >= entry.minCap).map((entry) => entry.role);
}

function defaultCommandCap({ merit = 0, rank = "" } = {}) {
  const suffix = __filename.endsWith(".js") ? "" : ".cjs";
  const core = require("./coopFactionWarMerit" + suffix);
  if (rank) {
    const entry = core.RANK_BY_NAME[String(rank)];
    if (entry) return entry.command;
  }
  return core.commandCapFor({ merit: Number(merit) || 0 });
}

function createWarFleetComposition(injected) {
  const base = injected && typeof injected === "object" ? injected : {};
  const commandCapFor = typeof base.commandCapFor === "function"
    ? base.commandCapFor
    : (record) => defaultCommandCap(record);
  // `resolveDoctrine({factionID, role})` returns {status, loadoutID, ...}; the
  // real one is coopWarDoctrine.resolve. Injected in tests.
  const resolveDoctrine = base.resolveDoctrine;
  if (typeof resolveDoctrine !== "function") {
    throw Error("WAR_FLEET_COMPOSITION_DOCTRINE_AUTHORITY_REQUIRED");
  }

  // cap ships, role-complete, every slot backed by a doctrine that really
  // resolves for this faction.
  function compose({ factionID, merit = 0, rank = "", cap = 0 } = {}) {
    const f = Number(factionID);
    if (!pos(f)) return refuse("FACTION_REQUIRED");
    let commandCap = Number(cap) || 0;
    if (!(commandCap > 0)) {
      try {
        commandCap = Number(commandCapFor({ merit: Number(merit) || 0, rank })) || 0;
      } catch (error) {
        return refuse("COMMAND_CAP_UNAVAILABLE:" + String(error && error.message || error));
      }
    }
    if (!(commandCap > 0)) return refuse("COMMAND_CAP_UNAVAILABLE", { factionID: f });
    const required = requirementsFor(commandCap);
    const slots = [];
    for (let index = 0; index < commandCap; index += 1) {
      slots.push(FILL_ORDER[index % FILL_ORDER.length]);
    }
    // A requirement the fill order did not place yet replaces the last non
    // required slot, so a squad-lead always gets a logi instead of a second
    // brawler.
    for (const role of required) {
      if (slots.includes(role)) continue;
      let target = -1;
      for (let index = slots.length - 1; index >= 0; index -= 1) {
        if (!required.includes(slots[index])) { target = index; break; }
      }
      if (target < 0) return refuse("ROLE_COMPLETENESS_IMPOSSIBLE", { commandCap, role, slots: slots.slice() });
      slots[target] = role;
    }
    const ships = [];
    for (const role of slots) {
      let resolved = null;
      try {
        resolved = resolveDoctrine({ factionID: f, role });
      } catch (error) {
        resolved = { status: "REFUSED", reason: "DOCTRINE_THREW:" + String(error && error.message || error) };
      }
      if (!resolved || resolved.status !== "RESOLVED") {
        return refuse("DOCTRINE_UNAVAILABLE", {
          factionID: f, role,
          doctrineReason: String((resolved && resolved.reason) || "UNKNOWN"),
        });
      }
      ships.push({
        slot: ships.length,
        role,
        doctrineID: String(resolved.doctrineID || resolved.loadoutID || ""),
        loadoutID: String(resolved.loadoutID || ""),
        profileID: String(resolved.profileID || ""),
        hullClass: String(resolved.hullClass || ""),
        hullTypeID: Number(resolved.hull && resolved.hull.typeID) || 0,
        hullName: String(resolved.hull && resolved.hull.name || ""),
        ammoDepth: Number(resolved.ammoDepth) || 0,
        moduleCount: Array.isArray(resolved.modules) ? resolved.modules.length : 0,
        chargeCount: Array.isArray(resolved.charges) ? resolved.charges.length : 0,
      });
    }
    const counts = {};
    for (const ship of ships) counts[ship.role] = (counts[ship.role] || 0) + 1;
    return {
      status: "COMPOSED",
      factionID: f,
      commandCap,
      rank: String(rank || ""),
      merit: Number(merit) || 0,
      size: ships.length,
      counts,
      required,
      ships,
    };
  }

  // The role-completeness gate a spawn must pass before it fields a fleet.
  function verify(plan) {
    if (!plan || plan.status !== "COMPOSED" || !Array.isArray(plan.ships)) {
      return { ok: false, missing: ROLES.slice(), reason: "PLAN_NOT_COMPOSED" };
    }
    const counts = {};
    for (const ship of plan.ships) counts[String(ship && ship.role || "")] =
      (counts[String(ship && ship.role || "")] || 0) + 1;
    const required = Array.isArray(plan.required) && plan.required.length
      ? plan.required : requirementsFor(plan.commandCap);
    const missing = required.filter((role) => !(counts[role] > 0));
    return {
      ok: missing.length === 0 && plan.ships.length === Number(plan.commandCap),
      missing,
      size: plan.ships.length,
      commandCap: Number(plan.commandCap) || 0,
      counts,
    };
  }

  return Object.freeze({ compose, verify, requirementsFor });
}

module.exports = {
  createWarFleetComposition,
  ROLES,
  REQUIREMENTS,
  FILL_ORDER,
  requirementsFor,
};
