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
const MAX_DESTINATION_RETRIES = 3;

let lastReconcileAtMs = 0;
const reconciledSystemIDs = new Set();
const pendingDestinationSystemIDs = new Map();
let lastSummary = null;

function enabled(env = process.env) {
  return String(env.EVEJS_COOP_UNIVERSE_SITES || "1") !== "0";
}

// Deterministic RNG for the site allocator. The engine's random allocator falls back to Math.random,
// so every reconcile produced different definitions and REPLACED the live instances: materialised
// asteroid and NPC content was destroyed, and a client that had locked a rock got TARGET_NOT_FOUND
// from the mining laser (live 2026-10-30 19:47). Seeding by UTC day keeps the layout identical for
// the whole day and still rotates it daily.
function createSeededRng(seed) {
  let state = (Number(seed) >>> 0) || 0x9e3779b9;
  return function nextRandom() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function siteAllocationRng(nowMs, salt = "coop-universe-sites") {
  const day = Math.floor(Math.max(0, Number(nowMs) || 0) / 86400000);
  const mix = (hashToUnit(`${salt}:${day}`) * 4294967296) >>> 0;
  return createSeededRng(mix);
}

// A rotating, deterministic sample of the systems the world does not naturally visit, so a player who
// flies into null-sec or wormhole space meets sites there too (the engine materialises an instance the
// moment a scene is built, so seeding ahead of time is exactly right).
const SAMPLE_PER_BAND = 12;
let sampleCache = { day: 0, nullsec: [], wormhole: [] };

function isWormholeSystemID(systemID) {
  const numeric = Number(systemID) || 0;
  return numeric >= 31000000 && numeric <= 31999999;
}

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
    // J-space is identified by its id range (31xxxxxx), not by a column: `worldData` carries the
    // SDE solar-system rows, which only have `security`/`securityClass`. J-space systems report
    // security -1, so without this check they would be sampled as null-sec.
    if (isWormholeSystemID(systemID)) {
      wormhole.push({ systemID, rank: hashToUnit(`wh:${systemID}:${day}`) });
      continue;
    }
    // Special space (Pochven, 32xxxxxx) has no player stargate: seeding sites there would be invisible.
    if (systemID >= 31000000) continue;
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

function liveSceneSystemIDs() {
  const ids = [];
  try {
    const runtime = require("./runtime");
    if (runtime && runtime.scenes instanceof Map) {
      for (const key of runtime.scenes.keys()) {
        const numeric = Number(key);
        if (Number.isSafeInteger(numeric) && numeric > 0) ids.push(numeric);
      }
    }
  } catch (_error) {
    /* no scene registry yet: the world visited set is still enough */
  }
  return ids;
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
  const world = [...new Set([...systemIDsOf(visitedSystems), ...liveSceneSystemIDs()])]
    .sort((left, right) => left - right)
    .slice(0, MAX_SYSTEMS);
  const sample = sampleBands(nowMs);
  // Plan the known-space wormhole entrances BEFORE seeding, so the J-space systems those entrances
  // lead into get their sites in the same pass. Without that a player could scan a hole and land in a
  // completely empty system.
  let entrancePlan = { status: "SKIPPED", entrances: [] };
  try {
    entrancePlan = require("./coopWormholeEntrances").plan({ systemIDs: world, nowMs });
  } catch (_error) {
    entrancePlan = { status: "SKIPPED", entrances: [] };
  }
  const entranceJSystems = entrancePlan.entrances
    .map((entry) => Math.max(0, Number(entry.sourceSystemID) || 0))
    .filter((systemID) => systemID > 0);
  const systemIDs = [...new Set([
    ...world,
    ...sample.nullsec,
    ...sample.wormhole,
    ...entranceJSystems,
    ...pendingDestinationSystemIDs.keys(),
  ])].sort((left, right) => left - right);
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
      rng: siteAllocationRng(nowMs),
    });
    lastReconcileAtMs = nowMs;
    for (const id of systemIDs) reconciledSystemIDs.add(id);
    lastSummary = summary && typeof summary === "object" ? summary : null;
    // A scene that already exists does not see an instance created afterwards: the site service only
    // materialises on scene creation. Re-run it for the awake scenes of these systems (addStaticEntity
    // is idempotent, so nothing is spawned twice), then count what the scanner would list.
    const materialized = materializeAwakeScenes(systemIDs);
    // Known space never scanned the K162 side of any wormhole, so J-space was unreachable. Open the
    // planned entrances (or a real wandering pair where none exists).
    let wormholes = null;
    try {
      wormholes = require("./coopWormholeEntrances").apply(entrancePlan, { nowMs });
    } catch (_error) {
      wormholes = null;
    }
    // A newly opened hole may lead into a system that had no sites yet: seed that destination in the
    // same pass, otherwise the player scans a wormhole and lands in an empty system.
    let destinationSites = null;
    const destinations = (wormholes && Array.isArray(wormholes.destinationSystemIDs)
      ? wormholes.destinationSystemIDs
      : []).filter((systemID) => !systemIDs.includes(systemID));
    if (destinations.length > 0) {
      try {
        const destinationSummary = runtime.reconcileUniversePersistentSites({
          systemIDs: destinations,
          nowMs,
          progressLabel: "coop wormhole destinations",
          logProgress: false,
          rng: siteAllocationRng(nowMs, "coop-wormhole-destinations"),
        });
        const destinationMaterialized = materializeAwakeScenes(destinations);
        destinationSites = {
          systems: destinations.length,
          created: Number(destinationSummary && destinationSummary.createdInstances) || 0,
          anomalies: destinationMaterialized.anomalies,
        };
      } catch (_error) {
        destinationSites = null;
      }
    }
    // A destination that still has no instance is retried on the next pass (bounded), so a hole never
    // leads into an empty system just because one seeding call missed.
    settlePendingDestinations(destinations);
    return {
      status: "RECONCILED",
      systemIDs,
      created: Number(summary && summary.createdInstances) || 0,
      desired: Number(summary && summary.desiredSiteCount) || 0,
      materialized: materialized.spawned,
      anomalies: materialized.anomalies,
      wormholes,
      destinationSites,
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

function countInstancesForSystem(systemID) {
  try {
    const state = require("../services/dungeon/dungeonRuntimeState");
    const snapshot = state.getStateSnapshot();
    let count = 0;
    for (const row of Object.values(snapshot.instancesByID || {})) {
      if (Number(row && row.solarSystemID) === Number(systemID)) count += 1;
    }
    return count;
  } catch (_error) {
    return -1;
  }
}

function settlePendingDestinations(systemIDs) {
  for (const value of systemIDs || []) {
    const systemID = Math.max(0, Number(value) || 0);
    if (systemID <= 0) continue;
    if (countInstancesForSystem(systemID) > 0) {
      pendingDestinationSystemIDs.delete(systemID);
      continue;
    }
    const attempts = (pendingDestinationSystemIDs.get(systemID) || 0) + 1;
    if (attempts > MAX_DESTINATION_RETRIES) {
      pendingDestinationSystemIDs.delete(systemID);
      continue;
    }
    pendingDestinationSystemIDs.set(systemID, attempts);
  }
}

function reset() {
  lastReconcileAtMs = 0;
  reconciledSystemIDs.clear();
  pendingDestinationSystemIDs.clear();
  lastSummary = null;
}

module.exports = {
  MAX_SYSTEMS,
  SAMPLE_PER_BAND,
  sampleBands,
  isWormholeSystemID,
  liveSceneSystemIDs,
  RECONCILE_INTERVAL_MS,
  enabled,
  materializeAwakeScenes,
  reconcile,
  reset,
  systemIDsOf,
};
