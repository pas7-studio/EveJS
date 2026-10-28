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

function note(failure, phase, error) {
  try {
    const observe = typeof failure.observe === "function" ? failure.observe : null;
    if (!observe) return;
    observe("living-coop-loop-phase-failed", null, null, {
      phase, reason: String((error && error.message) || error).slice(0, 90),
    });
  } catch (_error) { /* telemetry only */ }
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
  const wantsDistribution = String(env.EVEJS_COOP_DISTRIBUTION || "") === "1" &&
    String(env.EVEJS_COOP_NATIVE_GATE_TRANSFER || "") === "1";
  if (wantsDistribution && typeof options.transfer !== "function") {
    statuses.distribution = "TRANSFER_UNAVAILABLE";
  } else {
    run("distribution", wantsDistribution, () =>
      String(require("./coopNpcGateCrossing").tick({
        sceneForSystem: options.sceneForSystem, getGate: options.getGate,
        getController: options.getController, warpToGate: options.warpToGate,
        transfer: options.transfer, now: options.now, observe: options.observe,
      }).status || "UNKNOWN"));
  }
  return { status: failures.length ? "PARTIAL" : "OK", statuses, failures };
}

module.exports = { PHASES, tick };
