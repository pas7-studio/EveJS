"use strict";
// FW-031: a war hull must be allowed to fight where the campaign is.
//
// Two measured native facts blocked every shot even after the fleets met:
//
//  1. `isBeyondLeash` uses the behaviour profile's leash (measured: 90 km). The
//     war hull is spawned at a belt anchor, then warps to the enemy; once it is
//     past 90 km from its home position the native loop runs clearNpcCombatState
//     on every think, which drops `currentTargetID` back to 0 and sends the hull
//     home. An accepted attack order therefore never became a target.
//  2. The profile's orbit distance keeps the hull outside its own gun range
//     (measured: 750 m optimal, 2 500 m falloff on the doctrine autocannons), so
//     even a valid target would not be hit.
//
// This module applies two *existing* native behaviour overrides to a registered
// war ship standing in an active assault system: no leash (0 = the native check
// returns false) and a gun-range orbit. It adds no spawn, damage, kill or loot,
// keeps every other override the hull already has, and is idempotent: the same
// values are never re-applied.
const enabled = env => env.EVEJS_COOP_WAR_ENGAGEMENT_POSTURE === "1";
const pos = x => Number.isSafeInteger(x) && x > 0;

function createWarEngagementPosture({
  readWarState,
  registry,
  getController,
  setBehaviorOverrides,
  clock = () => Date.now(),
  env = process.env,
  leashRangeMeters = 0,
  orbitDistanceMeters = 500,
  movementMode = "orbit",
  cooldownMs = 30000,
} = {}) {
  if (
    [readWarState, getController, setBehaviorOverrides].some(x => typeof x !== "function") ||
    !registry || typeof registry.snapshot !== "function" ||
    typeof clock !== "function" ||
    !Number.isSafeInteger(leashRangeMeters) || leashRangeMeters < 0 ||
    !Number.isSafeInteger(orbitDistanceMeters) || orbitDistanceMeters < 100 ||
    !["orbit", "follow", "hold", "stop"].includes(String(movementMode)) ||
    !Number.isSafeInteger(cooldownMs) || cooldownMs < 1000
  ) throw Error("WAR_ENGAGEMENT_POSTURE_AUTHORITIES_REQUIRED");
  const nextAt = new Map();

  function tick() {
    if (!enabled(env)) return { status: "DISABLED", applied: [], skips: [] };
    let state, ships;
    try {
      state = readWarState();
      ships = Object.values(registry.snapshot()?.ships || {});
    } catch (_error) {
      return { status: "NATIVE_AUTHORITIES_UNAVAILABLE", applied: [], skips: [] };
    }
    if (state?.version !== 1 || !state.campaigns || !state.wars || !Array.isArray(ships)) {
      return { status: "INVALID_WAR_STATE", applied: [], skips: [] };
    }
    const now = clock();
    if (!pos(now)) return { status: "CLOCK_UNSAFE", applied: [], skips: [] };
    const systems = new Set(Object.values(state.campaigns)
      .filter(c => c && c.state === "ASSAULT" && state.wars[c.warID]?.state === "ACTIVE")
      .map(c => Number(c.targetSystemID))
      .filter(pos));
    if (!systems.size) return { status: "NO_ASSAULT", applied: [], skips: [] };
    const applied = [], skips = [];
    for (const ship of ships) {
      const id = Number(ship.entityID);
      const systemID = Number(ship.systemID);
      if (!pos(id) || !systems.has(systemID)) continue;
      if ((nextAt.get(id) || 0) > now) continue;
      let controller = null;
      try { controller = getController(id); } catch (_error) { controller = null; }
      if (!controller || controller.entityID !== id || Number(controller.systemID) !== systemID) {
        skips.push({ entityID: id, reason: "NO_NATIVE_CONTROLLER" });
        continue;
      }
      const current = controller.behaviorOverrides || {};
      if (current.leashRangeMeters === leashRangeMeters &&
        current.orbitDistanceMeters === orbitDistanceMeters &&
        current.movementMode === movementMode) continue;
      nextAt.set(id, now + cooldownMs);
      let ack = null, threw = "";
      try {
        ack = setBehaviorOverrides(id, {
          ...current,
          movementMode,
          leashRangeMeters,
          orbitDistanceMeters,
        });
      } catch (error) { threw = String(error?.message || error).slice(0, 120); }
      applied.push({
        entityID: id,
        systemID,
        factionID: Number(ship.factionID),
        campaignID: String(ship.campaignID || ""),
        movementMode,
        leashRangeMeters,
        orbitDistanceMeters,
        status: ack?.success === true ? "NATIVE_POSTURE_APPLIED"
          : String(threw || ack?.errorMsg || "REFUSED").slice(0, 120),
      });
    }
    return { status: applied.length ? "POSTURE_APPLIED" : "NO_CHANGE", applied, skips };
  }
  return Object.freeze({ tick });
}

module.exports = { createWarEngagementPosture, enabled };
