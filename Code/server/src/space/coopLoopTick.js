"use strict";
// One tick for every co-op loop phase the engine calls from its mining think.
//
// The stock file used to carry one hook line per phase (refinery, then the manufacturer),
// and each new phase cost stock characters that are frozen by the extraction gate. This
// module keeps ONE hook line in the stock file and fans out here, so adding a phase costs
// nothing in the engine and a broken phase cannot stop the others.
//
// Nothing is invented: every phase keeps its own env flag and its own durable journals, so
// this is a dispatcher, not a new authority. A throwing phase is reported and skipped.
const PHASES = ["refinery", "manufacture", "distribution", "distributionRun"];
let distributionRunInFlight = false;
let lastDistributionRunStatus = null;
let lastDistributionStatus = null;

function note(failure, phase, error) {
  try {
    // A phase that fails without a report is indistinguishable from a phase that never ran,
    // so the probe is the default observer rather than an optional one.
    const observe = typeof failure.observe === "function" ? failure.observe
      : require("./coopRuntimeProbe").observe;
    const detail = typeof error === "object" && error !== null
      ? {status: String(error.status || ""), reason: String(error.reason || "")}
      : {status: "THREW", reason: String((error && error.message) || error)};
    observe("living-coop-loop-phase-failed", null, null, {phase, ...detail});
  } catch (_error) { /* telemetry only */ }
}

function observeLoop(event, detail) {
  try { require("./coopRuntimeProbe").observe(event, null, null, detail); }
  catch (_error) { /* telemetry only */ }
}
// Everything a freight run needs, built from the world itself: a real hull marker, the real
// hangars, the real seeded book (read-only), real stations and a real reciprocal gate.
function distributionRunAuthorities(options = {}) {
  const env = options.env || process.env;
  try {
    const store = require("./npc/nativeNpcStore");
    const items = require("../services/inventory/itemStore");
    const inventory = require("../services/inventory/itemTypeRegistry");
    const worldData = require("./worldData");
    const runtime = require("./runtime");
    const npc = require("./npc/npcRuntime");
    const sceneFor = options.sceneForSystem ||
      ((id) => runtime.ensureScene(id, {refreshStargates: false}));
    let db = null;
    const openDb = () => {
      if (db !== null) return db || null;
      try {
        const Better = require("better-sqlite3");
        db = new Better(env.EVEJS_MARKET_DB || "/var/lib/evejs/market/market.sqlite",
          {readonly: true, fileMustExist: true});
      } catch (_error) { db = false; }
      return db || null;
    };
    const hulls = () => (store.listNativeEntities() || [])
      .filter((row) => /^coop-distribution-[0-9]+-hauler$/.test(String(row.operatorKind || "")))
      .map((row) => Number(row.entityID)).filter(Boolean);
    const distanceTo = (stationID, systemID, haulerID) => {
      try {
        const scene = sceneFor(systemID);
        const ship = scene && scene.getEntityByID ? scene.getEntityByID(haulerID) : null;
        const station = worldData.getStationByID(stationID);
        if (!ship || !ship.position || !station || !station.position) return null;
        const dx = ship.position.x - station.position.x;
        const dy = ship.position.y - station.position.y;
        const dz = ship.position.z - station.position.z;
        return Math.max(0, Math.hypot(dx, dy, dz) - (Number(ship.radius) || 0) -
          (Number(station.radius) || 0));
      } catch (_error) { return null; }
    };
    // The same durable ship, brought back into its scene from its own record.
    const ensureLive = (haulerID) => {
      try {
        const native = store.getNativeEntity(haulerID);
        if (!native) return false;
        const scene = sceneFor(Number(native.systemID) || 0);
        if (!scene) return false;
        const ship = typeof scene.getEntityByID === "function" ? scene.getEntityByID(haulerID) : null;
        if (ship) return true;
        const answer = require("./npc/nativeNpcService")
          .materializeStoredNativeController(scene, haulerID);
        return Boolean(answer && answer.success === true);
      } catch (_error) { return false; }
    };
    const goTo = (stationID, haulerID) => {
      // The manual order needs a live controller; a restored hull may have its ship back
      // without one, so the scene follow - the same call the station arrival uses - is the
      // fallback. Measured 2026-10-30: the order answered NOT_FOUND while the ship was
      // already sitting at its station.
      try {
        const answer = require("./npc/npcService").issueManualOrder(haulerID, {
          type: "follow", targetID: stationID, followRangeMeters: 2000, allowWeapons: false,
        });
        if (answer && answer.success === true) return true;
      } catch (_error) { /* fall through to the scene order */ }
      try {
        const native = store.getNativeEntity(haulerID);
        const scene = sceneFor(Number(native && native.systemID) || 0);
        const ship = scene && scene.getEntityByID ? scene.getEntityByID(haulerID) : null;
        if (!ship || typeof scene.followShipEntity !== "function") return false;
        return scene.followShipEntity(ship, stationID, 2000, {allowWeapons: false}) !== false;
      } catch (_error) { return false; }
    };
    return {
      env, hulls, distanceTo, goTo, ensureLive,
      planTrip: ({haulerID}) => {
        const native = store.getNativeEntity(haulerID);
        const systemID = Number(native && native.systemID) || 0;
        return require("./coopDistributionPlan").planTrip({
          haulerID, store, items, inventory, db: openDb(), worldData, scene: sceneFor(systemID),
          connectedGates: ({sourceSystemID, targetSystemID}) => {
            const pair = require("./coopNpcGateTravel").connectedGates({
              sourceSystemID, targetSystemID, sourceScene: sceneFor(sourceSystemID),
              getGate: (id) => worldData.getStargateByID(id),
            });
            return pair && pair[0] ? pair[0] : null;
          },
        });
      },
      lift: async ({haulerID, stationID, systemID, demand}) => {
        const lift = require("./coopNpcMineralLift").createMineralLift({
          store, items, getStation: (id) => worldData.getStationByID(id),
          resolveType: (id) => inventory.resolveItemByTypeID(id),
          corpID: Number(env.EVEJS_COOP_FACTORY_CORP_ID || 1000129),
          call: (method, params) => require("../services/market/marketDaemonClient")
            .marketDaemonClient.call(method, params),
          root: env.EVEJS_COOP_NPC_MARKET_ROOT || "/var/lib/evejs/coop-native-market",
          probe: require("./coopRuntimeProbe"),
        });
        return lift.lift({systemID, stationID, haulerID, cap: 1e6, demand});
      },
      planCrossing: ({haulerID, gate}) => {
        const native = store.getNativeEntity(haulerID);
        // The hull needs an identity the registry will accept: the one already bound to it,
        // or the lowest free name (the crossing itself links it from the durable record).
        let pilotID = null;
        try {
          const links = JSON.parse(require("fs").readFileSync(
            env.EVEJS_COOP_IDENTITY_FILE || "/var/lib/evejs/coop-npc-links.json", "utf8")).links || {};
          const bound = Object.values(links).find((row) =>
            Number(row && row.entityID) === Number(haulerID));
          if (bound) pilotID = String(bound.pilotID);
          else {
            for (let n = 1; n <= 9999; n += 1) {
              const candidate = "coop-pilot-" + String(n).padStart(3, "0");
              if (!links[candidate]) { pilotID = candidate; break; }
            }
          }
        } catch (_error) { pilotID = null; }
        return require("./coopNpcGateCrossing").plan({
          entityID: haulerID, pilotID,
          operatorKind: String(native && native.operatorKind || ""), gate, now: Date.now(),
        });
      },
      crossingPhase: (haulerID) => {
        const row = (require("./coopNpcGateCrossing").read() || [])
          .find((entry) => Number(entry.entityID) === Number(haulerID));
        return row ? String(row.phase) : null;
      },
      sell: ({haulerID, stationID, systemID}) => {
        try {
          return require("./coopVirtualWorldRuntime").sellOnArrival({systemID, stationID,
            haulerID, types: [], scene: sceneFor(systemID)});
        } catch (error) {
          return {status: "SALE_THREW", reason: String((error && error.message) || error)};
        }
      },
      observe: require("./coopRuntimeProbe").observe,
      minIsk: Number(env.EVEJS_COOP_DISTRIBUTION_MIN_ISK || 200000),
    };
  } catch (error) {
    return {hulls: () => [], planTrip: () => ({status: "AUTHORITY_UNAVAILABLE",
      reason: String((error && error.message) || error).slice(0, 90)})};
  }
}
// The crossing needs real scenes, real gates, the live identity registry and the verified
// native transfer - never a stub. Eager requirements are lazy so a world without them still
// boots; a missing authority is reported, not guessed.
function distributionAuthorities(options = {}) {
  try {
    const runtime = require("./runtime");
    const worldData = require("./worldData");
    const controllers = require("./npc/npcRegistry");
    const npc = require("./npc/npcRuntime");
    const sceneForSystem = options.sceneForSystem ||
      ((id) => runtime.ensureScene(id, {refreshStargates: false}));
    const getGate = options.getGate || ((id) => worldData.getStargateByID(id));
    let transfer = options.transfer || null;
    let sharedIdentity = null;
    if (!transfer) {
      // NOT the shared war adapter: measured 2026-10-30, it carries the identity registry
      // built at boot, so a hull linked afterwards is invisible to its preflight and every
      // attempt is refused SOURCE_IDENTITY_MISMATCH. The co-op builds its own transfer from a
      // FRESH read of the durable identity file - the same file, one record owner per
      // journey, and no second long-lived writer.
      const registry = require("./coopIdentityRegistry").createRegistry({
        file: (options.env || process.env).EVEJS_COOP_IDENTITY_FILE ||
          "/var/lib/evejs/coop-npc-links.json",
        exists: (system, id) => {
          try {
            const scene = runtime.ensureScene(system, {refreshStargates: false});
            const ship = scene && scene.getEntityByID ? scene.getEntityByID(id) : null;
            return Boolean(ship && ship.kind === "ship");
          } catch (_error) { return false; }
        },
      });
      const prepared = require("./coopNativeGateTransfer").createNativeGateTransfer({
        sceneForSystem, getGate,
        store: require("./npc/nativeNpcStore"),
        service: require("./npc/nativeNpcService"),
        getController: (id) => controllers.getControllerByEntityID(id),
        registry,
        isScrambled: (ship) =>
          require("./modules/hostileModuleRuntime").isEntityWarpScrambled(ship),
      });
      // A co-op adapter owns its own interrupted crossings first, exactly as the war
      // instance does at boot; an unreadable journal must stop it, not be ignored.
      const recovered = typeof prepared.recoverPending === "function"
        ? prepared.recoverPending() : {status: "NONE"};
      if (recovered && recovered.status === "NEEDS_OPERATOR_REPAIR")
        return {status: "CROSSING_REPAIR_REQUIRED"};
      transfer = prepared.transfer.bind(prepared);
      // The same durable record answers both questions: who the hull is, and where it is.
      sharedIdentity = registry;
    }
    return {
      status: "OK",
      sceneForSystem,
      getGate,
      getController: options.getController || ((id) => controllers.getControllerByEntityID(id)),
      // The answer is returned whole, so a refusal can report its own reason.
      warpToGate: options.warpToGate || ((id, gateID) => npc.warpToEntity(id, gateID, {})),
      // The durable final approach the gate travel module proves: a manual follow order,
      // because a warp refuses a target that is already a few kilometres away.
      followGate: options.followGate || ((id, gateID) => {
        try {
          const answer = require("./npc/npcService").issueManualOrder(id, {
            type: "follow", targetID: gateID, followRangeMeters: 1000, allowWeapons: false,
          });
          return answer && answer.success === true;
        } catch (_error) { return false; }
      }),
      transfer,
      // A crossing may re-establish a pruned identity link from the durable record.
      identity: options.identity || sharedIdentity,
      hullSystemOf: options.hullSystemOf || ((id) => {
        try { return Number(require("./npc/nativeNpcStore").getNativeEntity(id)?.systemID || 0); }
        catch (_error) { return 0; }
      }),
      // The adapter refuses a scrambled hull, so the diagnostic asks the same question.
      isScrambled: options.isScrambled || ((ship) => {
        try { return require("./modules/hostileModuleRuntime").isEntityWarpScrambled(ship) === true; }
        catch (_error) { return false; }
      }),
      // A hull that keeps re-locking is stood down with the native order type the behaviour
      // loop itself honours, never by writing currentTargetID.
      standDown: options.standDown || ((id) => {
        try {
          const answer = require("./npc/npcService").issueManualOrder(id, { type: "stop" });
          return answer && answer.success === true;
        } catch (_error) { return false; }
      }),
      // A durable ship whose scene was rebuilt is re-materialized from its own record.
      materialize: options.materialize ||
        ((scene, id) => require("./npc/nativeNpcService").materializeStoredNativeController(scene, id)),
    };
  } catch (error) {
    return {status: "AUTHORITY_UNAVAILABLE", reason: String((error && error.message) || error).slice(0, 90)};
  }
}
/**
 * Run every enabled phase once. Returns {statuses, failures} - never throws.
 */
function tick(options = {}) {
  const env = options.env || process.env;
  const statuses = {};
  const failures = [];
  const run = (phase, enabled, call) => {
    if (!enabled) { statuses[phase] = "DISABLED"; return; }
    try { statuses[phase] = call(); }
    catch (error) {
      statuses[phase] = "THREW";
      failures.push({ phase, reason: String((error && error.message) || error).slice(0, 90) });
      note(options, phase, error);
    }
  };
  run("refinery", String(env.EVEJS_COOP_NPC_REFINERY || "") === "1", () =>
    String(require("./coopNpcRefineryTick").tick({
      systemID: options.systemID, stationID: options.stationID, fleetID: options.fleetID,
      gameStore: options.gameStore, marketRoot: options.marketRoot, now: options.now,
    }).status || "UNKNOWN"));
  run("manufacture", String(env.EVEJS_COOP_NPC_MANUFACTURE || "") === "1", () =>
    String(require("./coopNpcManufactureTick").tick({
      systemID: options.systemID, now: options.now,
    }).status || "UNKNOWN"));
  // The distribution crossing only ever advances a run an operator already journaled; it
  // never plans or starts one on its own (cross-system transfer is opt-in, see the docs).
  // It also needs a native transfer adapter, which the caller must supply: without one the
  // phase reports TRANSFER_UNAVAILABLE instead of pretending a hull could cross.
  // One real freight trip: lift at the origin station, cross the gate, sell at the
  // destination. It is DISPATCHED rather than awaited here because the lift and the sale
  // are journaled async work; a second beat while one is in flight would half-do a trip.
  const wantsRun = String(env.EVEJS_COOP_DISTRIBUTION_RUN || "") === "1";
  if (!wantsRun) statuses.distributionRun = "DISABLED";
  else if (distributionRunInFlight) statuses.distributionRun = "IN_FLIGHT";
  else {
    distributionRunInFlight = true;
    Promise.resolve()
      .then(() => require("./coopDistributionRun").tickAll(distributionRunAuthorities(options)))
      .then((rows) => {
        const summary = (rows || []).map((row) => String(row.status || "")).join(",");
        if (summary !== lastDistributionRunStatus) {
          lastDistributionRunStatus = summary;
          observeLoop("living-coop-loop-distribution-run", null, null, { status: summary || "EMPTY" });
        }
      })
      .catch((error) => observeLoop("living-coop-loop-distribution-run-failed", null, null,
        { reason: String((error && error.message) || error).slice(0, 90) }))
      .finally(() => { distributionRunInFlight = false; });
    statuses.distributionRun = "DISPATCHED";
  }
  const wantsDistribution = String(env.EVEJS_COOP_DISTRIBUTION || "") === "1";
  if (!wantsDistribution) statuses.distribution = "DISABLED";
  else {
    run("distribution", true, () => {
      const authorities = distributionAuthorities(options);
      if (authorities.status !== "OK") {
        // A phase that quietly declines to run looks exactly like a phase that works and
        // has nothing to do; the reason is reported once per change.
        if (lastDistributionStatus !== authorities.status) {
          lastDistributionStatus = authorities.status;
          note(options, "distribution",
            {status: authorities.status, reason: authorities.reason || null});
        }
        return authorities.status;
      }
      return String(require("./coopNpcGateCrossing").tick({
        ...authorities, now: options.now,
        observe: options.observe || require("./coopRuntimeProbe").observe,
      }).status || "UNKNOWN");
    });
  }
  return { status: failures.length ? "PARTIAL" : "OK", statuses, failures };
}

// Advance any operator-journaled crossing. Exported so more than one periodic phase can
// drive it: the crossing is durable, so driving it twice in the same minute is harmless.
function advanceDistribution(options = {}) {
  const env = options.env || process.env;
  if (String(env.EVEJS_COOP_DISTRIBUTION || "") !== "1") return {status: "DISABLED"};
  const authorities = distributionAuthorities(options);
  if (authorities.status !== "OK") return authorities;
  return require("./coopNpcGateCrossing").tick({
    ...authorities, now: options.now,
    observe: options.observe || require("./coopRuntimeProbe").observe,
  });
}

module.exports = { PHASES, tick, advanceDistribution, distributionAuthorities, distributionRunAuthorities };
