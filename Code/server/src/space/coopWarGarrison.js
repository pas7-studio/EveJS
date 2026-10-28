"use strict";
// FW-033: a front that cannot refill is not a war, it is a one-time event.
//
// Measured: after four real warship kills the battle system held only the
// surviving hulls of one side, and nothing ever put a navy back on the other
// side. The campaign stayed in ASSAULT with an empty garrison.
//
// This module refills a side of an active assault up to `garrisonSize` hulls by
// calling the SAME sanctioned path an operator uses - `spawn_war_fleet`, which
// validates a real doctrine row, spawns a real native ship and links a real free
// pilot identity. It never invents a hull, credits ISK, deals damage or skips the
// native proof: every attempt reports the native status it received.
const enabled = env => env.EVEJS_COOP_FACTION_WAR === "1" &&
  env.EVEJS_COOP_FACTION_WAR_FLEETS === "1" &&
  env.EVEJS_COOP_WAR_GARRISON === "1";
const pos = x => Number.isSafeInteger(x) && x > 0;
const pilot = x => typeof x === "string" && /^coop-pilot-[0-9]{3,}$/.test(x);

function createWarGarrison({
  readWarState,
  registry,
  listFreePilots,
  spawnFleet,
  isHullLive = null,
  clock = () => Date.now(),
  env = process.env,
  garrisonSize = 2,
  cooldownMs = 180000,
  maxSpawnsPerTick = 1,
} = {}) {
  if (
    [readWarState, listFreePilots, spawnFleet].some(x => typeof x !== "function") ||
    !registry || typeof registry.snapshot !== "function" ||
    typeof clock !== "function" ||
    (isHullLive !== null && typeof isHullLive !== "function") ||
    !Number.isInteger(garrisonSize) || garrisonSize < 1 || garrisonSize > 6 ||
    !Number.isSafeInteger(cooldownMs) || cooldownMs < 10000 ||
    !Number.isInteger(maxSpawnsPerTick) || maxSpawnsPerTick < 1 || maxSpawnsPerTick > 2
  ) throw Error("WAR_GARRISON_AUTHORITIES_REQUIRED");
  const nextAt = new Map();

  function tick() {
    if (!enabled(env)) return { status: "DISABLED", applied: [], skips: [] };
    let state, ships;
    try {
      state = readWarState();
      const snapshot = registry.snapshot();
      if (!snapshot || snapshot.status === "DISABLED") {
        return { status: "WAR_REGISTRY_DISABLED", applied: [], skips: [] };
      }
      ships = Object.values(snapshot.ships || {});
    } catch (_error) {
      return { status: "NATIVE_AUTHORITIES_UNAVAILABLE", applied: [], skips: [] };
    }
    if (state?.version !== 1 || !state.campaigns || !state.wars || !Array.isArray(ships)) {
      return { status: "INVALID_WAR_STATE", applied: [], skips: [] };
    }
    const now = clock();
    if (!pos(now)) return { status: "CLOCK_UNSAFE", applied: [], skips: [] };
    const campaigns = Object.values(state.campaigns).filter(c =>
      c && c.state === "ASSAULT" && state.wars[c.warID]?.state === "ACTIVE" &&
      pos(Number(c.targetSystemID))).slice(0, 4);
    if (!campaigns.length) return { status: "NO_ASSAULT", applied: [], skips: [] };
    let free = [];
    try { free = (listFreePilots() || []).filter(pilot); } catch (_error) { free = []; }
    const applied = [], skips = [];
    let spawned = 0;
    for (const campaign of campaigns) {
      const systemID = Number(campaign.targetSystemID);
      const war = state.wars[campaign.warID];
      const factions = [Number(war.attackerFactionID), Number(war.defenderFactionID)]
        .filter(pos);
      for (const factionID of factions) {
        if (spawned >= maxSpawnsPerTick) break;
        const key = systemID + "|" + factionID;
        // A registry row is custody, not a ship on the field. A hull that was
        // destroyed or despawned without a confirmed wreck keeps its row (custody
        // must not be released on absence alone), so counting rows made the
        // garrison believe a physically empty side was fully manned and it never
        // refilled. Count only hulls that are really in the scene.
        const live = (s) => {
          if (typeof isHullLive !== "function") return true;
          try { return isHullLive(systemID, Number(s.entityID)) === true; } catch (_error) { return false; }
        };
        const present = ships.filter(s => Number(s.systemID) === systemID &&
          Number(s.factionID) === factionID && live(s)).length;
        const missing = garrisonSize - present;
        if (missing <= 0) continue;
        if ((nextAt.get(key) || 0) > now) {
          skips.push({ campaignID: campaign.campaignID, systemID, factionID, reason: "GARRISON_COOLDOWN", missing });
          continue;
        }
        const commanderPilotID = free.shift();
        if (!commanderPilotID) {
          skips.push({ campaignID: campaign.campaignID, systemID, factionID, reason: "NO_FREE_PILOT_IDENTITY", missing });
          continue;
        }
        nextAt.set(key, now + cooldownMs);
        spawned += 1;
        let ack = null, threw = "";
        try {
          ack = spawnFleet({ factionID, systemID, commanderPilotID, merit: 0 });
        } catch (error) { threw = String(error?.message || error).slice(0, 120); }
        const ok = ack && ack.ok === true;
        applied.push({
          campaignID: campaign.campaignID,
          systemID,
          factionID,
          commanderPilotID,
          missing,
          fleetID: String(ack && ack.fleetID || ""),
          ships: Array.isArray(ack && ack.ships)
            ? ack.ships.map(s => Number(s.entityID) || 0).filter(pos) : [],
          status: ok ? "NATIVE_GARRISON_SPAWNED"
            : String(threw || ack && ack.error || "REFUSED").slice(0, 120),
        });
      }
    }
    return { status: applied.length ? "GARRISON_APPLIED" : "NO_CHANGE", applied, skips };
  }
  return Object.freeze({ tick });
}

module.exports = { createWarGarrison, enabled };
