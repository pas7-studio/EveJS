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
  const systemIDs = systemIDsOf(visitedSystems);
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
    return {
      status: "RECONCILED",
      systemIDs,
      created: Number(summary && summary.createdInstances) || 0,
      desired: Number(summary && summary.desiredSiteCount) || 0,
    };
  } catch (error) {
    return { status: "FAILED", reason: String(error && error.message || error).slice(0, 160) };
  }
}

function reset() {
  lastReconcileAtMs = 0;
  reconciledSystemIDs.clear();
  lastSummary = null;
}

module.exports = { MAX_SYSTEMS, RECONCILE_INTERVAL_MS, enabled, reconcile, reset, systemIDsOf };
