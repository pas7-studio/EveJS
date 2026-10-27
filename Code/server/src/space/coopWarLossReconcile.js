"use strict";
// FW-032: a confirmed native wreck must actually leave the war.
//
// Measured defect: after a real kill the casualty ledger recorded the wreck, but
// the hull stayed ALIVE in the war fleet roster and kept its exclusive slot in
// the war fleet registry. A side therefore looked fully mustered with a dead
// ship, could never be reinforced, and the killed pilot's identity stayed bound
// to a wreck - so the navy could never man a replacement.
//
// This module closes exactly that loop, using only sanctioned paths:
//  - `registry.execute(RELEASE)` with the real wreck as its proof (the native
//    release verifier already accepts a process-confirmed wreck),
//  - `roster.recordLoss(...)` with the real wreck id,
//  - `releaseIdentity(...)` so the surviving pilot can fly a new hull.
// It never spawns a ship, pays a bounty, assigns kill credit or declares defeat.
const enabled = env => env.EVEJS_COOP_FACTION_WAR === "1" &&
  env.EVEJS_COOP_FACTION_WAR_FLEETS === "1" &&
  env.EVEJS_COOP_WAR_LOSS_RECONCILE === "1";
const pos = x => Number.isSafeInteger(x) && x > 0;
const pilot = x => typeof x === "string" && /^coop-pilot-[0-9]{3,}$/.test(x);

function createWarLossReconcile({
  registry,
  roster,
  releaseIdentity,
  clock = () => Date.now(),
  env = process.env,
} = {}) {
  if (
    !registry || typeof registry.snapshot !== "function" || typeof registry.execute !== "function" ||
    !roster || typeof roster.snapshot !== "function" || typeof roster.recordLoss !== "function" ||
    typeof releaseIdentity !== "function" ||
    typeof clock !== "function"
  ) throw Error("WAR_LOSS_RECONCILE_AUTHORITIES_REQUIRED");

  function fleetOf(entityID) {
    let fleets;
    try { fleets = Object.values(roster.snapshot()?.fleets || {}); } catch (_error) { return ""; }
    for (const fleet of fleets) {
      if ((fleet.ships || []).some(s => Number(s.entityID) === entityID)) return String(fleet.fleetID || "");
    }
    return "";
  }

  function reconcile({ entityID, wreckID, pilotID } = {}) {
    if (!enabled(env)) return { status: "DISABLED" };
    if (!pos(Number(entityID)) || !pos(Number(wreckID)) || !pilot(pilotID)) {
      return { status: "BLOCKED", reason: "INVALID_WRECK_IDENTITY" };
    }
    const entity = Number(entityID), wreck = Number(wreckID);
    if (!pos(clock())) return { status: "BLOCKED", reason: "CLOCK_INVALID" };
    let snapshot;
    try { snapshot = registry.snapshot(); } catch (_error) {
      return { status: "BLOCKED", reason: "WAR_REGISTRY_UNAVAILABLE" };
    }
    if (!snapshot || snapshot.status === "DISABLED") {
      return { status: "BLOCKED", reason: "WAR_REGISTRY_DISABLED" };
    }
    const row = (snapshot.ships || {})[String(entity)] || null;
    let custody = "NOT_REGISTERED";
    if (row) {
      if (row.pilotID !== pilotID) {
        return { status: "BLOCKED", reason: "WRECK_PILOT_MISMATCH", entityID: entity };
      }
      let released = null;
      try {
        released = registry.execute({
          eventID: "wreck-release:" + wreck,
          type: "RELEASE",
          entityID: entity,
          pilotID,
          fleetID: row.fleetID,
          // The registry's own release verifier accepts a process-confirmed
          // native wreck; the id makes the event replay-safe.
          proofID: "native-wreck:" + wreck,
        });
      } catch (error) {
        return { status: "BLOCKED", reason: "CUSTODY_RELEASE_THREW:" + String(error?.message || error).slice(0, 80) };
      }
      custody = String(released?.status || "UNKNOWN");
      if (custody !== "APPLIED" && custody !== "DUPLICATE") {
        return {
          status: "BLOCKED",
          reason: "CUSTODY_RELEASE_" + custody,
          custodyReason: String(released?.reason || ""),
          entityID: entity,
        };
      }
    }
    const fleetID = fleetOf(entity);
    let rosterStatus = "NOT_IN_ROSTER";
    if (fleetID) {
      let loss = null;
      try {
        loss = roster.recordLoss({ fleetID, entityID: entity, wreckID: wreck, casualtyID: "wreck:" + wreck });
      } catch (error) {
        return { status: "BLOCKED", reason: "ROSTER_LOSS_THREW:" + String(error?.message || error).slice(0, 80) };
      }
      rosterStatus = String(loss?.status || "UNKNOWN");
      if (rosterStatus !== "RECORDED" && rosterStatus !== "DUPLICATE") {
        return { status: "BLOCKED", reason: "ROSTER_LOSS_" + rosterStatus, fleetID, entityID: entity };
      }
    }
    // The pilot survived the hull. Freeing the identity is what lets the same
    // navy man a replacement instead of permanently losing a pilot to a wreck.
    let identity = "UNKNOWN";
    try {
      identity = String(releaseIdentity({ pilotID, entityID: entity, reason: "NATIVE_WRECK" })?.status || "UNKNOWN");
    } catch (error) {
      identity = "THREW:" + String(error?.message || error).slice(0, 60);
    }
    return {
      status: "RECONCILED",
      entityID: entity,
      wreckID: wreck,
      pilotID,
      fleetID,
      custody,
      roster: rosterStatus,
      identity,
    };
  }

  return Object.freeze({ reconcile });
}

module.exports = { createWarLossReconcile, enabled };
