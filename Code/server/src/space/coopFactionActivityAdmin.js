"use strict";
// eve_public.faction.activity.admin.{Increment,Set}ContributionScore - the
// customer-support knobs behind the /advantage slash command.
//
// Until now the gateway answered both with a default-encoded empty 200 while the
// read side (GetSolarSystemScores and the victory-point bar) kept answering the
// score derived from wrecks and hulls, so an admin change was silently lost.
//
// This module is the write side of that SAME score. It stores, per system and
// faction, an optional replacement ("set") and an accumulated delta
// ("increment"); coopWarAdvantage applies them on top of the derived
// contribution, so both client surfaces agree. Values are clamped into the
// 0..100000 domain the client can represent: factionwarfare/advantageState.py
// raises ValueError for a contribution fraction outside it and the advantages
// tab then falls back to no data at all.
//
// Nothing here invents a system or a faction: the caller must already have
// proven that the pair belongs to the current war (that is the service's job),
// and an increment for a pair that is not in the war is refused rather than
// stored as a no-op.
const MAX_POINTS = 100000;
const VERSION = 1;
const TABLE = "corporationRuntime";
const KEY = "coop-faction-war\u001factivity-adjustments-v1";
const SEP = "\u001f";
const MAX_SYSTEMS = 512;
const MAX_FACTIONS_PER_SYSTEM = 16;

function pos(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function clampPoints(value) {
  const points = Math.trunc(Number(value));
  if (!Number.isFinite(points) || points <= 0) return 0;
  return Math.min(points, MAX_POINTS);
}

function empty() {
  return { version: VERSION, bySystem: {} };
}

function validate(state) {
  if (!state || state.version !== VERSION || !state.bySystem ||
    typeof state.bySystem !== "object" || Array.isArray(state.bySystem)) {
    throw Error("FACTION_ACTIVITY_ADJUSTMENTS_INVALID");
  }
  const systems = Object.keys(state.bySystem);
  if (systems.length > MAX_SYSTEMS) throw Error("FACTION_ACTIVITY_ADJUSTMENTS_TOO_LARGE");
  for (const systemID of systems) {
    if (!pos(Number(systemID)) || String(Number(systemID)) !== systemID) {
      throw Error("FACTION_ACTIVITY_ADJUSTMENTS_SYSTEM_INVALID");
    }
    const byFaction = state.bySystem[systemID];
    if (!byFaction || typeof byFaction !== "object" || Array.isArray(byFaction)) {
      throw Error("FACTION_ACTIVITY_ADJUSTMENTS_SYSTEM_INVALID");
    }
    const factions = Object.keys(byFaction);
    if (factions.length > MAX_FACTIONS_PER_SYSTEM) {
      throw Error("FACTION_ACTIVITY_ADJUSTMENTS_TOO_LARGE");
    }
    for (const factionID of factions) {
      const row = byFaction[factionID];
      if (!pos(Number(factionID)) || String(Number(factionID)) !== factionID) {
        throw Error("FACTION_ACTIVITY_ADJUSTMENTS_FACTION_INVALID");
      }
      if (!row || typeof row !== "object") {
        throw Error("FACTION_ACTIVITY_ADJUSTMENTS_ROW_INVALID");
      }
      const override = row.override === null || row.override === undefined ? null : Number(row.override);
      const delta = Number(row.delta || 0);
      if (override !== null && (!Number.isFinite(override) || override < 0)) {
        throw Error("FACTION_ACTIVITY_ADJUSTMENTS_OVERRIDE_INVALID");
      }
      if (!Number.isFinite(delta)) throw Error("FACTION_ACTIVITY_ADJUSTMENTS_DELTA_INVALID");
    }
  }
  return state;
}

function createFactionActivityAdmin({ gameStore } = {}) {
  if (typeof gameStore?.read !== "function" || typeof gameStore?.write !== "function") {
    throw Error("FACTION_ACTIVITY_ADMIN_STORE_REQUIRED");
  }

  function readState() {
    // The war rows use the "\u001f" durable key, which the GameStore cache nests
    // at the same separator; both shapes are tried, as everywhere else.
    for (const pth of ["/" + KEY.split(SEP).join("/"), "/" + KEY]) {
      const read = gameStore.read(TABLE, pth);
      if (read?.success === true && read.data && typeof read.data === "object") {
        return validate(read.data);
      }
    }
    return empty();
  }

  function writeState(state) {
    const written = gameStore.write(
      TABLE,
      "/" + KEY.split(SEP).join("/"),
      validate(state),
    );
    if (!written || written.success !== true) {
      throw Error("FACTION_ACTIVITY_ADJUSTMENTS_WRITE_FAILED");
    }
    return state;
  }

  function rowOf(state, systemID, factionID) {
    const bySystem = state.bySystem[String(systemID)] || {};
    return bySystem[String(factionID)] || null;
  }

  function effective(systemID, factionID, derived) {
    const row = rowOf(readState(), systemID, factionID);
    if (!row) return clampPoints(derived);
    const base = row.override === null || row.override === undefined
      ? derived
      : Number(row.override);
    return clampPoints(Number(base || 0) + Number(row.delta || 0));
  }

  function mutate(systemID, factionID, change) {
    if (!pos(Number(systemID))) throw Error("FACTION_ACTIVITY_ADMIN_SYSTEM_REQUIRED");
    if (!pos(Number(factionID))) throw Error("FACTION_ACTIVITY_ADMIN_FACTION_REQUIRED");
    const state = readState();
    const bySystem = state.bySystem[String(systemID)] || {};
    const current = bySystem[String(factionID)] || { override: null, delta: 0 };
    bySystem[String(factionID)] = change(current);
    state.bySystem[String(systemID)] = bySystem;
    writeState(state);
    return bySystem[String(factionID)];
  }

  return Object.freeze({
    readState,
    effective,
    // "add this many points on top of whatever the war derives"
    increment({ systemID, factionID, adjustment, derived = 0 } = {}) {
      const row = mutate(systemID, factionID, (current) => ({
        override: current.override === undefined ? null : current.override,
        delta: Number(current.delta || 0) + Math.trunc(Number(adjustment) || 0),
      }));
      return {
        status: "APPLIED",
        override: row.override === undefined ? null : row.override,
        delta: row.delta,
        contribution: effective(systemID, factionID, derived),
      };
    },
    // "the score is exactly this from now on, plus later increments"
    setOverride({ systemID, factionID, override } = {}) {
      const row = mutate(systemID, factionID, () => ({
        override: clampPoints(override),
        delta: 0,
      }));
      return {
        status: "APPLIED",
        override: row.override,
        delta: row.delta,
        contribution: effective(systemID, factionID, 0),
      };
    },
    applyScores(systemID, scores) {
      if (!Array.isArray(scores) || !scores.length) return scores;
      const state = readState();
      const bySystem = state.bySystem[String(Number(systemID) || 0)];
      if (!bySystem) return scores;
      return scores.map((score) => {
        const row = bySystem[String(score.factionID)];
        if (!row) return score;
        const base = row.override === null || row.override === undefined
          ? Number(score.contribution || 0)
          : Number(row.override);
        return {
          ...score,
          contribution: clampPoints(base + Number(row.delta || 0)),
        };
      });
    },
  });
}

let singleton = null;
function shared() {
  if (!singleton) {
    singleton = createFactionActivityAdmin({ gameStore: require("../gameStore") });
  }
  return singleton;
}

module.exports = {
  KEY,
  MAX_POINTS,
  TABLE,
  clampPoints,
  createFactionActivityAdmin,
  empty,
  shared,
  validate,
};
