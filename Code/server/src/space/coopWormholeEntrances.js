"use strict";
// Wormhole entrances from known space.
//
// The engine seeds a static wormhole pair with a VISIBLE source (the J-space side, discovered) and an
// INVISIBLE destination (the K162 in known space). Nothing ever scans from J-space in this world, so
// the K162 side stayed invisible forever and a player in Jita/Perimeter could never find a way in:
// measured on the live stack, `wormholeSignatureProvider.listSignatureSites(30000142)` returned 0
// while 1193 active J-space -> known-space pairs existed for the whole map and 58 of them landed in
// The Forge. The three pairs that did land in Jita were already collapsed.
//
// This module plans and then opens ONE real entrance for each world system that has one: the system
// itself first, then its constellation, then its region. Opening means the runtime's own
// `revealOppositeEndpoint` (the same call a transit uses), so mass, lifetime, collapse and jump rules
// stay exactly native - this only stops an existing entrance from being permanently unscannable.
const MAX_PER_SYSTEM = 1;

function isWormholeSystemID(systemID) {
  const numeric = Number(systemID) || 0;
  return numeric >= 31000000 && numeric <= 31999999;
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function isVisible(endpoint) {
  return String(endpoint && endpoint.visibilityState || "").toLowerCase() === "visible";
}

function systemOf(endpoint) {
  return Math.max(0, toInt(endpoint && endpoint.systemID, 0));
}

function systemMeta(world, systemID) {
  try {
    const record = world && typeof world.getSolarSystemByID === "function"
      ? world.getSolarSystemByID(systemID)
      : null;
    return {
      regionID: Math.max(0, toInt(record && record.regionID, 0)),
      constellationID: Math.max(0, toInt(record && record.constellationID, 0)),
    };
  } catch (_error) {
    return { regionID: 0, constellationID: 0 };
  }
}

// Read-only: choose at most one entrance per target system. Nothing is mutated here, so the caller
// can add the chosen J-space systems to its site reconcile before the entrance is actually opened.
function plan(options = {}) {
  const targets = [...new Set(
    (Array.isArray(options.systemIDs) ? options.systemIDs : [])
      .map((entry) => Math.max(0, toInt(entry, 0)))
      .filter((systemID) => systemID > 0 && !isWormholeSystemID(systemID)),
  )].sort((left, right) => left - right);
  if (targets.length <= 0) return { status: "NO_SYSTEMS", entrances: [] };

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const maxPerSystem = Math.max(1, toInt(options.maxPerSystem, MAX_PER_SYSTEM));
  const maxScope = String(options.maxScope || "region").toLowerCase();
  const world = options.world || require("./worldData");

  let pairs = [];
  try {
    if (Array.isArray(options.pairs)) {
      pairs = options.pairs;
    } else {
      const state = require("../services/exploration/wormholes/wormholeRuntimeState");
      pairs = Object.values(state.getStateSnapshot().pairsByID || {});
    }
  } catch (error) {
    return { status: "FAILED", reason: String(error && error.message || error).slice(0, 160), entrances: [] };
  }

  const visibleCounts = new Map();
  const candidatesByDestination = new Map();
  for (const pair of pairs) {
    if (!pair || String(pair.state || "").toLowerCase() !== "active") continue;
    if (Math.max(0, toInt(pair.expiresAtMs, 0)) < nowMs) continue;
    const source = pair.source || {};
    const destination = pair.destination || {};
    const sourceSystemID = systemOf(source);
    const destinationSystemID = systemOf(destination);
    if (isVisible(source)) {
      visibleCounts.set(sourceSystemID, (visibleCounts.get(sourceSystemID) || 0) + 1);
    }
    if (isVisible(destination)) {
      visibleCounts.set(destinationSystemID, (visibleCounts.get(destinationSystemID) || 0) + 1);
      continue;
    }
    if (!isWormholeSystemID(sourceSystemID)) continue;
    if (isWormholeSystemID(destinationSystemID)) continue;
    if (!candidatesByDestination.has(destinationSystemID)) {
      candidatesByDestination.set(destinationSystemID, []);
    }
    candidatesByDestination.get(destinationSystemID).push({
      pairID: toInt(pair.pairID, 0),
      sourceEndpointID: toInt(source.endpointID, 0),
      sourceSystemID,
      destinationSystemID,
      expiresAtMs: toInt(pair.expiresAtMs, 0),
    });
  }

  const scopeRank = { direct: 0, constellation: 1, region: 2 };
  const targetMeta = new Map(targets.map((systemID) => [systemID, systemMeta(world, systemID)]));
  // One candidate list for the whole world set, ranked by how close its known-space end is to a world
  // system. A pair is used once: revealing the same pair for three systems would only ever open the one
  // system its destination actually lives in.
  const ranked = [];
  for (const [destinationSystemID, list] of candidatesByDestination.entries()) {
    const destinationMeta = systemMeta(world, destinationSystemID);
    let best = null;
    for (const systemID of targets) {
      const meta = targetMeta.get(systemID);
      const scope = destinationSystemID === systemID
        ? "direct"
        : (meta.constellationID > 0 && destinationMeta.constellationID === meta.constellationID
          ? "constellation"
          : (meta.regionID > 0 && destinationMeta.regionID === meta.regionID ? "region" : null));
      if (!scope) continue;
      if (maxScope === "direct" && scope !== "direct") continue;
      if (maxScope === "constellation" && scope === "region") continue;
      if (!best || scopeRank[scope] < scopeRank[best.scope]) best = { targetSystemID: systemID, scope };
    }
    if (!best) continue;
    const candidate = [...list].sort((left, right) => (
      right.expiresAtMs - left.expiresAtMs || left.pairID - right.pairID
    ))[0];
    if (!candidate) continue;
    ranked.push({
      ...candidate,
      targetSystemID: best.targetSystemID,
      scope: best.scope,
      scopeDistance: scopeRank[best.scope],
    });
  }
  ranked.sort((left, right) => (
    left.scopeDistance - right.scopeDistance ||
    right.expiresAtMs - left.expiresAtMs ||
    left.pairID - right.pairID
  ));

  const usedDestinations = new Set();
  const perTarget = new Map();
  const entrances = [];
  for (const entry of ranked) {
    if (entrances.length >= targets.length * maxPerSystem) break;
    if (usedDestinations.has(entry.destinationSystemID)) continue;
    const already = visibleCounts.get(entry.destinationSystemID) || 0;
    if (already >= maxPerSystem) continue;
    if ((perTarget.get(entry.targetSystemID) || 0) >= maxPerSystem) continue;
    usedDestinations.add(entry.destinationSystemID);
    perTarget.set(entry.targetSystemID, (perTarget.get(entry.targetSystemID) || 0) + 1);
    entrances.push(entry);
  }

  // Systems that still have no entrance of their own get a real wandering pair opened in them
  // (`spawnRandomPairs`): native code type, mass, lifetime and destination - the same call the engine
  // uses for wandering wormholes, only aimed at the systems this world plays in instead of a random
  // class sample.
  const spawnSystemIDs = [];
  if (options.spawnWhenMissing !== false) {
    // Only an entrance whose known-space end really is inside the target counts as "already has one".
    // A hole revealed in a neighbouring constellation system does not put a signature in front of the
    // player, so that system still gets a native wandering pair of its own.
    const assignedTargets = new Set(
      entrances
        .filter((entry) => toInt(entry.destinationSystemID, 0) === toInt(entry.targetSystemID, 0))
        .map((entry) => entry.targetSystemID),
    );
    for (const systemID of targets) {
      if (assignedTargets.has(systemID)) continue;
      if ((visibleCounts.get(systemID) || 0) >= maxPerSystem) continue;
      spawnSystemIDs.push(systemID);
    }
  }

  return {
    status: entrances.length > 0 || spawnSystemIDs.length > 0 ? "PLANNED" : "NO_CHANGE",
    entrances,
    spawnSystemIDs,
    alreadyVisible: Object.fromEntries(
      targets.map((systemID) => [systemID, visibleCounts.get(systemID) || 0]),
    ),
    scannedPairs: pairs.length,
  };
}

// Opens planned entrances (visibility only, through the runtime's own transit-time call) and spawns a
// real wandering pair in systems that still have none.
function apply(planned, options = {}) {
  const entrances = (planned && Array.isArray(planned.entrances)) ? planned.entrances : [];
  const spawnSystemIDs = (planned && Array.isArray(planned.spawnSystemIDs)) ? planned.spawnSystemIDs : [];
  let runtime = null;
  try {
    runtime = require("../services/exploration/wormholes/wormholeRuntime");
  } catch (error) {
    return { status: "UNAVAILABLE", reason: String(error && error.message || error).slice(0, 160), openedCount: 0, opened: [], failed: [] };
  }
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const opened = [];
  const spawned = [];
  const failed = [];
  if (typeof runtime.revealOppositeEndpoint === "function") {
    for (const entrance of entrances) {
      try {
        const result = runtime.revealOppositeEndpoint(entrance.sourceEndpointID, nowMs);
        if (result && result.success === false) {
          failed.push({ ...entrance, reason: "REVEAL_FAILED" });
          continue;
        }
        opened.push(entrance);
      } catch (error) {
        failed.push({ ...entrance, reason: String(error && error.message || error).slice(0, 120) });
      }
    }
  }
  if (typeof runtime.spawnRandomPairs === "function") {
    for (const systemID of spawnSystemIDs) {
      try {
        const pairs = runtime.spawnRandomPairs(systemID, 1, nowMs) || [];
        for (const pair of pairs) {
          spawned.push({
            targetSystemID: systemID,
            pairID: toInt(pair && pair.pairID, 0),
            destinationSystemID: systemOf(pair && pair.destination),
            sourceSystemID: systemOf(pair && pair.source),
            scope: "spawned",
          });
        }
        if (pairs.length <= 0) failed.push({ targetSystemID: systemID, reason: "SPAWN_RETURNED_NONE" });
      } catch (error) {
        failed.push({ targetSystemID: systemID, reason: String(error && error.message || error).slice(0, 120) });
      }
    }
  }
  const destinationSystemIDs = [...new Set(
    [...opened, ...spawned]
      .map((entry) => Math.max(0, toInt(
        entry && (entry.destinationSystemID || entry.sourceSystemID), 0,
      )))
      .filter((systemID) => systemID > 0),
  )].sort((left, right) => left - right);
  return {
    status: (opened.length + spawned.length) > 0 ? "OPENED" : "NO_CHANGE",
    opened,
    spawned,
    failed,
    destinationSystemIDs,
    openedCount: opened.length + spawned.length,
  };
}

function reveal(options = {}) {
  const planned = plan(options);
  const applied = apply(planned, options);
  return { ...planned, ...applied };
}

module.exports = {
  MAX_PER_SYSTEM,
  apply,
  isWormholeSystemID,
  plan,
  reveal,
};
