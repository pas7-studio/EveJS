"use strict";
// FW-034: the client's faction-warfare "advantages" panel has two native
// surfaces, and both were empty for our war:
//
//   fwVictoryPointMgr.GetAllVictoryPointStates / GetLocalVictoryPointState
//     -> { solarSystemID: { score, threshold } }  (the system progress bar)
//   fw-advantage gateway eve_public.faction.activity.GetSolarSystemScores
//     -> { solar_system, scores: [{ faction, contribution, floor }] }
//
// Stock serves both from a state source nobody fills, so the client either
// errors or spins forever. This module derives BOTH from evidence we already
// hold - the real war state, the real war fleet registry and the real casualty
// ledger - and invents nothing:
//
//   contribution(faction) = 1000 * wrecks that faction took from the enemy in
//                           this system  +  100 * its hulls present here
//   score                 = the larger side's contribution
//   threshold             = the stock 75 000 victory-point threshold
//
// A side with no kills and no hulls scores zero, which is the truth.
const fs = require("node:fs");
const path = require("node:path");
const suffix = typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs";
const warStore = require("./coopFactionWarStore" + suffix);
const fleetStore = require("./coopWarFleetRegistry" + suffix);
const casualtyLedger = require("./coopWarCasualtyLedger" + suffix);
const { readRow } = require("./coopNativeRowPath" + suffix);
const pos = x => Number.isSafeInteger(x) && x > 0;
const DEFAULT_THRESHOLD = 75000;
// factionwarfare/advantageState.py turns points into fractions of MAX_ACTIVITY_POINTS
// and REFUSES anything outside it: contribution > 1.0, floor > 1.0 or their sum > 1.0
// raises ValueError, and the advantages tab silently falls back to no data. The
// projection is clamped into that domain instead of handing the client a number it
// cannot represent.
const MAX_CLIENT_POINTS = 100000;
const LOSS_WEIGHT = 1000;
const HULL_WEIGHT = 100;

function createWarAdvantage({
  gameStore,
  clock = () => Date.now(),
  env = process.env,
  threshold = DEFAULT_THRESHOLD,
} = {}) {
  if (typeof gameStore?.read !== "function" || typeof clock !== "function" ||
    !pos(threshold)) throw Error("WAR_ADVANTAGE_AUTHORITIES_REQUIRED");
  const enabled = () => env.EVEJS_COOP_FACTION_WAR === "1" &&
    env.EVEJS_COOP_WAR_ADVANTAGE === "1";

  function readAll() {
    const war = readRow(gameStore, warStore.TABLE, warStore.KEY);
    if (!war || war.version !== 1) return null;
    let fleet = null, casualties = null;
    try { fleet = readRow(gameStore, fleetStore.TABLE, fleetStore.KEY); } catch (_error) { fleet = null; }
    try { casualties = readRow(gameStore, casualtyLedger.TABLE, casualtyLedger.KEY); } catch (_error) { casualties = null; }
    return {
      war,
      ships: Object.values((fleet && fleet.ships) || {}),
      wrecks: Object.values((casualties && casualties.byWreck) || {}),
    };
  }

  // Every system our war really touches: registered territories plus campaign
  // targets. Nothing outside the war state can appear here.
  function systemIDsOf(war) {
    const ids = new Set();
    for (const territory of Object.values(war.territories || {})) {
      if (pos(Number(territory.systemID))) ids.add(Number(territory.systemID));
    }
    for (const campaign of Object.values(war.campaigns || {})) {
      if (campaign && pos(Number(campaign.targetSystemID))) ids.add(Number(campaign.targetSystemID));
    }
    return [...ids].sort((a, b) => a - b);
  }

  function factionsOf(war) {
    const factions = new Set();
    for (const row of Object.values(war.wars || {})) {
      if (row?.state !== "ACTIVE") continue;
      if (pos(Number(row.attackerFactionID))) factions.add(Number(row.attackerFactionID));
      if (pos(Number(row.defenderFactionID))) factions.add(Number(row.defenderFactionID));
    }
    return [...factions].sort((a, b) => a - b);
  }

  function snapshot() {
    if (!enabled()) return { status: "DISABLED", systems: {} };
    const state = readAll();
    if (!state) return { status: "WAR_STATE_UNAVAILABLE", systems: {} };
    const factions = factionsOf(state.war);
    if (!factions.length) return { status: "NO_ACTIVE_WAR", systems: {} };
    const systems = {};
    for (const systemID of systemIDsOf(state.war)) {
      const wrecksHere = state.wrecks.filter(w => Number(w.systemID) === systemID);
      const hullsHere = state.ships.filter(s => Number(s.systemID) === systemID);
      const scores = factions.map(factionID => {
        const taken = wrecksHere.filter(w => Number(w.victimFactionID) !== factionID).length;
        const present = hullsHere.filter(s => Number(s.factionID) === factionID).length;
        return { factionID, contribution: taken * LOSS_WEIGHT + present * HULL_WEIGHT, lossesTaken: wrecksHere.filter(w => Number(w.victimFactionID) === factionID).length, hulls: present };
      });
      const territory = (state.war.territories || {})[String(systemID)] || null;
      const best = scores.reduce((a, b) => (b.contribution > a.contribution ? b : a), scores[0]);
      systems[systemID] = {
        systemID,
        scores,
        score: best ? best.contribution : 0,
        threshold,
        ownerID: Number(territory?.originalOwnerFactionID) || 0,
        occupierID: Number(territory?.militaryControllerFactionID) || 0,
        contested: String(territory?.state || "") === "CONTESTED",
      };
    }
    return { status: "OBSERVED", systems };
  }

  function clientPoints(value) {
    const points = Number(value);
    if (!Number.isFinite(points) || points <= 0) return 0;
    return Math.min(Math.round(points), MAX_CLIENT_POINTS);
  }

  // The warzone occupation payload is built from the same war record, but in
  // EVEJS_COOP_FW_ALL_SYSTEMS=1 mode it lists every static warzone system. The client
  // dereferences `victoryPointsState.contestedFraction` for each listed system
  // (warzoneStats.py), so a system without an entry is an AttributeError rather than an
  // empty bar. Cover exactly the systems the other payload lists, with an honest zero.
  function warzoneFactionIDs(war) {
    const factions = new Set();
    for (const row of Object.values((war && war.wars) || {})) {
      if (!row || row.state !== "ACTIVE") continue;
      for (const id of [row.attackerFactionID, row.defenderFactionID]) {
        const factionID = Number(id);
        if (factionID >= 500001 && factionID <= 500004) factions.add(factionID);
      }
    }
    return factions;
  }

  function victoryPointStates() {
    const view = snapshot();
    const out = {};
    for (const [systemID, entry] of Object.entries(view.systems)) {
      out[systemID] = { score: clientPoints(entry.score), threshold: entry.threshold };
    }
    if (Number(env.EVEJS_COOP_FW_ALL_SYSTEMS || 0) !== 1) return out;
    try {
      const state = readAll();
      if (!state) return out;
      const factions = warzoneFactionIDs(state.war);
      if (!factions.size) return out;
      const clientView = require("./coopWarClientView" + suffix);
      for (const system of clientView.staticWarzoneSystems()) {
        const systemID = Number(system && system.solarSystemID);
        if (!pos(systemID) || out[systemID]) continue;
        if (!factions.has(Number(system.factionID))) continue;
        out[systemID] = { score: 0, threshold };
      }
    } catch (_error) { /* the small set is still valid; never break the answer */ }
    return out;
  }

  function scoresFor(solarSystemID) {
    const view = snapshot();
    const entry = view.systems[String(Number(solarSystemID) || 0)];
    if (!entry) return [];
    return entry.scores.map(s => ({
      factionID: s.factionID, contribution: clientPoints(s.contribution), floor: 0,
    }));
  }

  return Object.freeze({ snapshot, victoryPointStates, scoresFor, clientPoints, enabled });
}

let singleton = null;
function shared() {
  if (!singleton) {
    singleton = createWarAdvantage({ gameStore: require("../gameStore") });
  }
  return singleton;
}

module.exports = { createWarAdvantage, shared, DEFAULT_THRESHOLD, LOSS_WEIGHT, HULL_WEIGHT };

// fwAdvantageGatewayService answered with a gRPC envelope it built inline; the shape
// belongs here. null = no score for this system, so the caller keeps its stock answer.
// The three payload helpers stay in the gateway because they are stock exports there.
function scoresResponse(solarSystemID, { buildEncodedPayload, response, buildPayload }) {
  const scores = shared().scoresFor(solarSystemID);
  if (!scores.length) return null;
  return {
    statusCode: 200,
    statusMessage: "",
    responseTypeName: "eve_public.faction.activity.GetSolarSystemScoresResponse",
    responsePayloadBuffer: buildEncodedPayload(response, buildPayload(solarSystemID, scores)),
  };
}

module.exports.scoresResponse = scoresResponse;
