"use strict";
// Flight driver for an NPC courier: the courier-specific intent around the
// shared native motion primitives in `coopNativeAgentMotion`.
//
// The primitives (identity object, undock, warp, dock) are generic and are
// reused by any server-driven character; this file only decides *what* the
// courier should do next and refuses to guess. Every action is one native call,
// and any doubt returns AMBIGUOUS without a retry: a second undock or dock can
// duplicate real state.
const EXT = (typeof __filename === "string" && __filename.endsWith(".js")) ? "" : ".cjs";
const motion = require("./coopNativeAgentMotion" + EXT);

const OK = motion.OK;
const FAILED = motion.FAILED;
const AMBIGUOUS = motion.AMBIGUOUS;

const buildCourierSession = motion.createAgentSession;
const preflight = motion.preflight;

function result(state, extra) {
  return Object.assign({}, extra || {}, { status: state });
}

function undock(ctx, flight) {
  const ready = preflight(ctx);
  if (ready.status !== "READY") return result("NOT_READY", { missing: ready.missing });
  const characterStationID = Number(ctx.character && ctx.character.stationID) || 0;
  // A reposition is "go to the contract origin from wherever the courier really is", so it must undock
  // from the CURRENT station. Refusing it unless the courier was already at the origin stranded a
  // courier that a previous leg had docked elsewhere (live: undock REFUSED + FLIGHT_TIMEOUT).
  const undockFrom = flight.reposition === true
    ? characterStationID
    : Number(flight.originStationID) || 0;
  if (!(undockFrom > 0)) {
    return result("REFUSED", {
      reason: flight.reposition === true
        ? "courier is not docked"
        : "courier is not docked at the contract origin",
      characterStationID,
      originStationID: Number(flight.originStationID) || 0,
    });
  }
  if (flight.reposition !== true && characterStationID !== undockFrom) {
    return result("REFUSED", {
      reason: "courier is not docked at the contract origin",
      characterStationID,
      originStationID: Number(flight.originStationID) || 0,
    });
  }
  return motion.undockAgent(ctx, undockFrom);
}

// One native warp to the destination station position. The station position is
// supplied by the caller from real station data, never invented here.
function warp(ctx, flight, stationPosition) {
  if (!stationPosition || !Number.isFinite(Number(stationPosition.x))) {
    return result("REFUSED", { reason: "destination station position is required" });
  }
  return motion.warpAgent(ctx, {
    entityID: Number(flight.entityID) || 0,
    systemID: Number(flight.systemID) || 0,
    point: stationPosition,
    ingressMs: Number(ctx.warpIngressMs) || 30000,
  });
}

function dock(ctx, flight) {
  return motion.dockAgent(ctx, flight.destinationStationID);
}

// Executes exactly one flight step. The caller persists the flight record and
// advances it only on OK.
function runStep(ctx, flight, stationPosition) {
  if (!flight || !flight.step) return result("REFUSED", { reason: "no flight" });
  if (flight.step === "undock") return undock(ctx, flight);
  if (flight.step === "warp") return warp(ctx, flight, stationPosition);
  if (flight.step === "arrive") {
    // Arrival is never assumed: the caller must supply real evidence that the
    // ship is at the destination before the flight is allowed to dock.
    return ctx && ctx.arrivalConfirmed === true
      ? result(OK)
      : result("REFUSED", { reason: "arrival is not confirmed by the scene" });
  }
  if (flight.step === "dock") return dock(ctx, flight);
  if (flight.step === "done") return result("DONE");
  return result("REFUSED", { reason: "unknown flight step: " + flight.step });
}

module.exports = { OK, FAILED, AMBIGUOUS, buildCourierSession, preflight, undock, warp, dock, runStep };
