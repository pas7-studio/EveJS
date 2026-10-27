"use strict";
// Read-only: why a stock mining fleet is not at its belt, and why a loaded fleet
// never leaves for a station. Both failure modes are silent in the stock loop:
// a miner that cannot reach a rock is only ever told to "follow" it, and a fleet
// whose trip journal refuses to close sits in "loaded" forever while reporting a
// healthy state. This module only reads: no warp, no order, no cargo, no journal
// write. Every number it prints is measured on the live entity/scene record.
const fs = require("node:fs");
const path = require("node:path");
const pos = (value) => {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
};
const vec = (value) => (value && ["x", "y", "z"].every((k) => Number.isFinite(Number(value[k])))
  ? { x: Number(value.x), y: Number(value.y), z: Number(value.z) }
  : null);
const distance = (left, right) => (left && right
  ? Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)
  : null);
const meters = (value) => (Number.isFinite(value) ? Math.round(value) : null);
// Same 15 minute budget the trip journal enforces; a manifest older than this can
// never be resumed, so it must not be reported as a live route.
const ROUTE_DEADLINE_MS = 15 * 60 * 1000;
const DEFAULT_JOURNAL_ROOT = "/var/lib/evejs/coop-native-warehouse";
const MANIFEST_NAME = /^([1-9]\d*)-([1-9]\d*)-([1-9]\d*)\.json$/;

function createMiningFleetDiagnose({
  getFleets,
  getScene,
  getController,
  waypoints,
  getNativeEntity,
  orderDiagnose,
  journalRoot,
  io = fs,
  now = () => Date.now(),
} = {}) {
  for (const [name, fn] of [["getFleets", getFleets], ["getScene", getScene], ["waypoints", waypoints]]) {
    if (typeof fn !== "function") throw Error("MINING_DIAGNOSE_DEPENDENCY_REQUIRED:" + name);
  }
  const root = typeof journalRoot === "string" && journalRoot ? journalRoot : DEFAULT_JOURNAL_ROOT;
  const controllerOf = (entityID) => {
    if (typeof getController !== "function") return null;
    try { return getController(entityID) || null; } catch (_error) { return null; }
  };
  const nativeOf = (entityID) => {
    if (typeof getNativeEntity !== "function") return null;
    try { return getNativeEntity(entityID) || null; } catch (_error) { return null; }
  };
  const orderOf = (entityID, systemID) => {
    if (typeof orderDiagnose !== "function") return null;
    try { return orderDiagnose({ entityID, systemID, owner: "RAID" }) || null; } catch (error) {
      return { status: "BLOCKED", reason: "DIAGNOSE_FAILED", details: String(error?.message || error).slice(0, 120) };
    }
  };
  // The closest real belt is the only honest "distance to the rock": a miner at an
  // off-grid warp origin is AU-scale away from every one of them.
  function nearestBelt(scene, position) {
    const points = waypoints(scene) || [];
    let best = null;
    for (const point of points) {
      if (String(point?.kind) !== "asteroidBelt") continue;
      const gap = distance(position, vec(point.position));
      if (gap === null) continue;
      if (!best || gap < best.distanceMeters) best = { id: pos(point.id), distanceMeters: gap };
    }
    return best ? { id: best.id, distanceMeters: meters(best.distanceMeters) } : null;
  }
  function warpOf(entity) {
    const ingress = vec(entity?.sessionlessWarpIngress?.targetPoint) ? entity.sessionlessWarpIngress : null;
    const state = entity?.warpState && typeof entity.warpState === "object" ? entity.warpState : null;
    const source = ingress || state;
    if (!source) return null;
    const completeAtMs = Number(source.completeAtMs ?? source.travelCompleteAtMs);
    const current = now();
    return {
      fromIngress: Boolean(ingress),
      origin: vec(source.origin),
      targetPoint: vec(source.targetPoint),
      startTimeMs: Number(source.startTimeMs) || 0,
      travelCompleteAtMs: Number(source.travelCompleteAtMs) || 0,
      completeAtMs: Number.isFinite(completeAtMs) ? completeAtMs : 0,
      elapsedMs: Number(source.startTimeMs) ? Math.max(0, current - Number(source.startTimeMs)) : null,
      remainingMs: Number.isFinite(completeAtMs) ? Math.max(0, completeAtMs - current) : null,
      overdue: Number.isFinite(completeAtMs) ? current >= completeAtMs : null,
    };
  }
  function describeShip(scene, systemID, entityID, trip) {
    const entity = typeof scene?.getEntityByID === "function" ? scene.getEntityByID(entityID) : null;
    const native = nativeOf(entityID);
    const controller = controllerOf(entityID);
    const position = vec(entity?.position);
    const station = trip ? vec(trip.stationPosition) : null;
    const effects = entity?.activeModuleEffects instanceof Map ? entity.activeModuleEffects.size : -1;
    const gap = position && station
      ? Math.max(0, distance(position, station) - Math.max(0, Number(entity?.radius) || 0) -
        Math.max(0, Number(trip.stationRadius) || 0))
      : null;
    return {
      entityID,
      inScene: Boolean(entity),
      transient: entity?.transient === true || native?.transient === true,
      mode: String(entity?.mode || ""),
      pendingWarp: Boolean(entity?.pendingWarp),
      warp: warpOf(entity),
      position,
      targetPoint: vec(entity?.targetPoint),
      nearestBelt: position ? nearestBelt(scene, position) : null,
      distanceToOriginAnchorMeters: position && vec(trip?.originAnchorPosition)
        ? meters(distance(position, vec(trip.originAnchorPosition))) : null,
      distanceToStationMeters: position && station ? meters(distance(position, station)) : null,
      // The station-arrival gate accepts a hull only inside 2 500 m of surface, so
      // the gap it measures is reported here instead of being guessed.
      surfaceGapToStationMeters: meters(gap),
      stationRadiusMeters: trip ? Number(trip.stationRadius) || 0 : null,
      shipRadiusMeters: Number(entity?.radius) || 0,
      tripArrivedAtMs: trip && trip.arrivals ? Number(trip.arrivals[entityID]) || 0 : null,
      activeModuleEffects: effects,
      controller: controller ? {
        currentTargetID: pos(controller.currentTargetID),
        manualType: String(controller.manualOrder?.type || ""),
        manualTargetID: pos(controller.manualOrder?.targetID),
        allowWeapons: controller.manualOrder?.allowWeapons !== false,
      } : null,
      order: orderOf(entityID, systemID),
    };
  }
  // The journal is the reason a loaded fleet can never mine again, so its exact
  // state (latest manifest, departure ack, expiry) is reported with the fleet.
  function journal(systemID, fleetID) {
    const dir = path.join(root, "trip-manifests");
    let names = [];
    try {
      names = io.readdirSync(dir).filter((name) => typeof name === "string" && MANIFEST_NAME.test(name));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return { status: "NO_JOURNAL_DIRECTORY", root, manifests: 0 };
    }
    if (names.length > 5000) throw Error("MINING_DIAGNOSE_MANIFEST_DIRECTORY_TOO_LARGE");
    const prefix = String(systemID) + "-" + String(fleetID) + "-";
    const mine = names.filter((name) => name.startsWith(prefix))
      .map((name) => ({ name, key: name.slice(0, -5), startedAt: Number(name.slice(prefix.length, -5)) }))
      .sort((left, right) => right.startedAt - left.startedAt);
    if (!mine.length) return { status: "NO_MANIFEST", root, manifests: 0 };
    const latest = mine[0];
    const exists = (file) => {
      try { io.statSync(path.join(root, file)); return true; } catch (_error) { return false; }
    };
    let cargoRows = -1;
    let manifestStartedAt = latest.startedAt;
    try {
      const raw = io.readFileSync(path.join(dir, latest.name), "utf8");
      const record = JSON.parse(raw);
      cargoRows = Array.isArray(record?.cargo) ? record.cargo.length : -1;
      manifestStartedAt = Number(record?.startedAt) || manifestStartedAt;
    } catch (_error) { cargoRows = -1; }
    const ageMs = Math.max(0, now() - manifestStartedAt);
    return {
      status: "MANIFEST_PRESENT",
      root,
      manifests: mine.length,
      latestManifestKey: latest.key,
      startedAt: manifestStartedAt,
      ageMs,
      overdue: ageMs > ROUTE_DEADLINE_MS,
      cargoRows,
      departureAck: exists(path.join("trip-departure-acks", latest.key + ".json")),
      expired: exists(path.join("trip-departure-acks", latest.key + ".expired.json")),
    };
  }
  function describe(fleet) {
    if (!fleet) return null;
    const systemID = pos(fleet.systemID);
    let scene = null;
    let sceneError = null;
    try { scene = getScene(systemID) || null; } catch (error) {
      sceneError = String(error?.message || error).slice(0, 120);
    }
    const raw = fleet.coopStationArrival && typeof fleet.coopStationArrival === "object"
      ? fleet.coopStationArrival : null;
    let trip = null;
    if (raw) {
      const station = scene
        ? (Array.isArray(scene.staticEntities) ? scene.staticEntities : [])
          .find((entry) => entry?.kind === "station" && pos(entry.itemID) === pos(raw.stationID))
        : null;
      trip = {
        stationID: pos(raw.stationID),
        corporationID: pos(raw.corporationID),
        manifestID: String(raw.manifestID || ""),
        startedAt: Number(raw.startedAt) || 0,
        ageMs: Number(raw.startedAt) ? Math.max(0, now() - Number(raw.startedAt)) : null,
        haulerCount: raw.haulers && typeof raw.haulers === "object" ? Object.keys(raw.haulers).length : 0,
        expectedCargoIDs: Array.isArray(raw.expectedCargoIDs) ? raw.expectedCargoIDs.length : 0,
        needsOperatorRepair: raw.coopStationTripNeedsOperatorRepair === true ||
          fleet.coopStationTripNeedsOperatorRepair === true,
        stationPosition: vec(station?.position),
        stationRadius: Math.max(0, Number(station?.radius) || 0),
        // When each hauler's dwell clock started, so a stuck arrival is visible.
        arrivals: raw.haulers && typeof raw.haulers === "object"
          ? Object.fromEntries(Object.entries(raw.haulers)
            .map(([id, record]) => [pos(id), Number(record && record.arrivedAt) || 0]))
          : {},
      };
    }
    const anchor = fleet.originAnchor && typeof fleet.originAnchor === "object" ? fleet.originAnchor : null;
    const minerIDs = Array.isArray(fleet.minerEntityIDs) ? fleet.minerEntityIDs.map(pos).filter(Boolean) : [];
    const haulerIDs = Array.isArray(fleet.haulerEntityIDs) ? fleet.haulerEntityIDs.map(pos).filter(Boolean) : [];
    const originAnchorPosition = vec(anchor?.position);
    const tripForShips = trip ? { ...trip, originAnchorPosition } : { originAnchorPosition };
    const context = {
      fleetID: pos(fleet.fleetID),
      systemID,
      startupKey: String(fleet.startupKey || ""),
      state: String(fleet.state || ""),
      activeAsteroidID: pos(fleet.activeAsteroidID),
      sceneInMemory: Boolean(scene),
      sceneError,
      originAnchor: anchor ? {
        distanceMeters: Number(anchor.distanceMeters) || 0,
        clearanceSatisfied: anchor.clearanceSatisfied === true,
        position: originAnchorPosition,
      } : null,
      nextThinkInMs: Math.max(0, (Number(fleet.nextThinkAtMs) || 0) - now()),
      loadedUntilInMs: Number(fleet.loadedUntilMs) ? Math.max(0, Number(fleet.loadedUntilMs) - now()) : 0,
      haulerNextArrivalInMs: Number(fleet.haulerNextArrivalAtMs)
        ? Math.max(0, Number(fleet.haulerNextArrivalAtMs) - now()) : 0,
      noCargo: fleet.coopStationNoCargo === true,
      // Why an aggressed fleet never returns to mining: the stock resume needs
      // now >= resumeAtMs AND no surviving response wing. Both are reported.
      resumeInMs: Number(fleet.resumeAtMs) ? Math.max(0, Number(fleet.resumeAtMs) - now()) : 0,
      resumeOverdue: Number(fleet.resumeAtMs) > 0 && now() >= Number(fleet.resumeAtMs),
      lastAggressedAtMs: Number(fleet.lastAggressedAtMs) || 0,
      responseWing: Array.isArray(fleet.responseEntityIDs) ? fleet.responseEntityIDs.length : 0,
      trip,
      journal: journal(systemID, pos(fleet.fleetID)),
    };
    return {
      ...context,
      miners: scene ? minerIDs.map((id) => describeShip(scene, systemID, id, tripForShips)) : [],
      haulers: scene ? haulerIDs.map((id) => describeShip(scene, systemID, id, tripForShips)) : [],
    };
  }
  function run({ systemIDs } = {}) {
    // A fleet record only exists per system (the native map is keyed that way), so
    // the caller names the systems it wants instead of guessing them.
    const systems = (Array.isArray(systemIDs) ? systemIDs : [systemIDs]).map(pos).filter(Boolean);
    if (!systems.length) throw Error("MINING_DIAGNOSE_SYSTEM_REQUIRED");
    const fleets = [];
    for (const systemID of systems) {
      const found = getFleets(systemID) || [];
      for (const fleet of found) fleets.push(describe(fleet));
    }
    return fleets;
  }
  return Object.freeze({ run, describe, journal });
}

module.exports = { createMiningFleetDiagnose };
