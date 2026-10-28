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
const PHASES = ["refinery", "manufacture", "distribution"];
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
    if (!transfer) {
      const owner = require("./coopVirtualWorldRuntime");
      const shared = typeof owner.nativeGateTransferAdapter === "function"
        ? owner.nativeGateTransferAdapter() : null;
      if (shared) transfer = shared.transfer.bind(shared);
      else {
        // The engine keeps its registry private and may not have created one in a given
        // boot, so the durable file is read fresh for this transfer: the same file, the same
        // existence rule, no second long-lived writer.
        let registry = typeof owner.identityRegistryAdapter === "function"
          ? owner.identityRegistryAdapter() : null;
        if (!registry) {
          registry = require("./coopIdentityRegistry").createRegistry({
            file: (options.env || process.env).EVEJS_COOP_IDENTITY_FILE ||
              "/var/lib/evejs/coop-npc-links.json",
            exists: (system, id) => {
              try {
                const scene = runtime.ensureScene(system, { refreshStargates: false });
                const ship = scene && scene.getEntityByID ? scene.getEntityByID(id) : null;
                return Boolean(ship && ship.kind === "ship");
              } catch (_error) { return false; }
            },
          });
        }
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
      }
    }
    return {
      status: "OK",
      sceneForSystem,
      getGate,
      getController: options.getController || ((id) => controllers.getControllerByEntityID(id)),
      warpToGate: options.warpToGate || ((id, gateID) => {
        const answer = npc.warpToEntity(id, gateID, {});
        return !(answer && answer.success === false);
      }),
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
        ((scene, id) => require("./npc/nativeNpcService").materializeStoredNativeController(scene, id)),    };
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

module.exports = { PHASES, tick, advanceDistribution };
