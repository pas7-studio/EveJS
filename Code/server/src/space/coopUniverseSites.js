"use strict";
// Universe site seeding for the systems this world actually plays in.
//
// The dungeon seeder exists and works, but it is only ever fed the AWAKE system list, so a system that
// the player visits without a scene holding a site gets nothing and never rotates. Measured on the
// owner's stack: 27 persistent instances in 16 systems, and zero in Jita / Perimeter / New Caldari.
//
// This module reconciles the visited systems through the real persistent-site seeder
// (dungeonUniverseRuntime.reconcileUniversePersistentSites), which builds the desired definitions for
// exactly those systems from the dungeon authority's own spawn profiles (23 families, band slots) and
// creates only what is missing. The 24-hour lifetime and the expire/rotate tick stay exactly as they
// are - sites appear, expire and move on their own; this only makes sure our systems take part.
//
// Rate limited on purpose: a full reconcile builds definitions for every band, so it runs when a new
// system is visited or when RECONCILE_INTERVAL_MS has passed, never on every tick.
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
const MAX_SYSTEMS = 12;

let lastReconcileAtMs = 0;
const reconciledSystemIDs = new Set();
let lastSummary = null;

function enabled(env = process.env) {
  return String(env.EVEJS_COOP_UNIVERSE_SITES || "1") !== "0";
}

// A rotating, deterministic sample of the systems the world does not naturally visit, so a player who
// flies into null-sec or wormhole space meets sites there too (the engine materialises an instance the
// moment a scene is built, so seeding ahead of time is exactly right).
const SAMPLE_PER_BAND = 12;
let sampleCache = { day: 0, nullsec: [], wormhole: [] };

function hashToUnit(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash / 4294967296;
}

function sampleBands(nowMs) {
  const day = Math.floor(nowMs / 86400000);
  if (sampleCache.day === day) return sampleCache;
  let rows = [];
  try {
    rows = require("./worldData").getSolarSystems() || [];
  } catch (_error) {
    rows = [];
  }
  const nullsec = [];
  const wormhole = [];
  for (const row of rows) {
    const systemID = Number(row && (row.solarSystemID || row.itemID)) || 0;
    if (systemID <= 0) continue;
    const wormholeClassID = Number(row && (row.wormholeClassID || row.wormholeClassId)) || 0;
    if (wormholeClassID > 0) {
      wormhole.push({ systemID, rank: hashToUnit(`wh:${systemID}:${day}`) });
      continue;
    }
    const security = Number(row && (row.securityStatus ?? row.security));
    if (Number.isFinite(security) && security < 0) {
      nullsec.push({ systemID, rank: hashToUnit(`ns:${systemID}:${day}`) });
    }
  }
  const take = (list) => list.sort((left, right) => left.rank - right.rank)
    .slice(0, SAMPLE_PER_BAND)
    .map((entry) => entry.systemID);
  sampleCache = { day, nullsec: take(nullsec), wormhole: take(wormhole) };
  return sampleCache;
}

function systemIDsOf(visitedSystems) {
  const ids = [];
  for (const value of visitedSystems || []) {
    const numeric = Number(value);
    if (Number.isSafeInteger(numeric) && numeric > 0) ids.push(numeric);
  }
  return [...new Set(ids)].sort((left, right) => left - right).slice(0, MAX_SYSTEMS);
}

function reconcile({ visitedSystems, nowMs = Date.now(), force = false, env = process.env } = {}) {
  if (!enabled(env)) return { status: "DISABLED" };
  const visited = systemIDsOf(visitedSystems);
  const sample = sampleBands(nowMs);
  const systemIDs = [...new Set([...visited, ...sample.nullsec, ...sample.wormhole])]
    .sort((left, right) => left - right)
    .slice(0, MAX_SYSTEMS + SAMPLE_PER_BAND * 2);
  if (systemIDs.length === 0) return { status: "NO_SYSTEMS" };
  const pending = systemIDs.filter((id) => !reconciledSystemIDs.has(id));
  const dueByTime = nowMs - lastReconcileAtMs >= RECONCILE_INTERVAL_MS;
  if (!force && pending.length === 0 && !dueByTime) {
    return { status: "NOT_DUE", summary: lastSummary };
  }

  let runtime = null;
  try {
    runtime = require("../services/dungeon/dungeonUniverseRuntime");
  } catch (error) {
    return { status: "UNAVAILABLE", reason: String(error && error.message || error) };
  }
  if (typeof runtime.reconcileUniversePersistentSites !== "function") {
    return { status: "UNAVAILABLE", reason: "reconcileUniversePersistentSites missing" };
  }

  try {
    const summary = runtime.reconcileUniversePersistentSites({
      systemIDs,
      nowMs,
      progressLabel: "coop world systems",
      logProgress: false,
    });
    lastReconcileAtMs = nowMs;
    for (const id of systemIDs) reconciledSystemIDs.add(id);
    lastSummary = summary && typeof summary === "object" ? summary : null;
    // A scene that already exists does not see an instance created afterwards: the site service only
    // materialises on scene creation. Re-run it for the awake scenes of these systems (addStaticEntity
    // is idempotent, so nothing is spawned twice), then count what the scanner would list.
    const materialized = materializeAwakeScenes(systemIDs);
    return {
      status: "RECONCILED",
      systemIDs,
      created: Number(summary && summary.createdInstances) || 0,
      desired: Number(summary && summary.desiredSiteCount) || 0,
      materialized: materialized.spawned,
      anomalies: materialized.anomalies,
    };
  } catch (error) {
    return { status: "FAILED", reason: String(error && error.message || error).slice(0, 160) };
  }
}

function materializeAwakeScenes(systemIDs) {
  let spawned = 0;
  const anomalies = {};
  try {
    const runtime = require("./runtime");
    const siteService = require("../services/dungeon/dungeonUniverseSiteService");
    const signatures = require("../services/exploration/signatures/signatureRuntime");
    const scenes = runtime && runtime.scenes instanceof Map ? runtime.scenes : null;
    if (!scenes) return { spawned, anomalies };
    for (const systemID of systemIDs) {
      const scene = scenes.get(Number(systemID));
      if (!scene) continue;
      try {
        const result = siteService.handleSceneCreated(scene, { force: true });
        spawned += (result && result.data && Array.isArray(result.data.spawned))
          ? result.data.spawned.length
          : 0;
      } catch (_error) {
        /* one bad scene must not stop the others */
      }
      try {
        anomalies[systemID] = signatures.buildSignalTrackerAnomalyEntries(systemID).length;
      } catch (_error) {
        anomalies[systemID] = -1;
      }
    }
  } catch (_error) {
    return { spawned, anomalies };
  }
  return { spawned, anomalies };
}

function reset() {
  lastReconcileAtMs = 0;
  reconciledSystemIDs.clear();
  lastSummary = null;
}

module.exports = {
  MAX_SYSTEMS,
  SAMPLE_PER_BAND,
  sampleBands,
  RECONCILE_INTERVAL_MS,
  enabled,
  materializeAwakeScenes,
  reconcile,
  reset,
  systemIDsOf,
};
