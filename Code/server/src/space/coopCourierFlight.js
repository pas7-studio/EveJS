"use strict";
// Pure flight state machine for an NPC courier: docked(origin) -> undock ->
// warp -> arrive -> dock(destination) -> done. No scene, wallet or inventory
// calls happen here; the native driver executes one action per step.
//
// Design constraints that keep this cheap:
//   - one native warp call per leg (ingress duration), not a per-tick path,
//   - a bounded number of concurrent flights (see selectActiveFlights),
//   - a flight only exists while a real contract is accepted for it.
const STEPS = Object.freeze(["undock", "warp", "arrive", "dock", "done"]);

const DEFAULT_FLIGHT_POLICY = Object.freeze({
  maxConcurrentFlights: 3,
  undockTimeoutMs: 30000,
  warpTimeoutMs: 180000,
  dockTimeoutMs: 60000,
});

function status(name, extra) {
  return Object.assign({ status: name }, extra || {});
}

function positive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

// Flight record. originStationID/destinationStationID come from the contract,
// shipItemID and characterID from the seeded courier identity.
function createFlight({ contract, identity, nowMs }) {
  const station = Number(contract && contract.startStationID) || 0;
  const destination = Number(contract && contract.endStationID) || 0;
  const characterID = Number(identity && identity.character && identity.character.characterID) || 0;
  const shipItemID = Number(identity && identity.ship && identity.ship.itemID) || 0;
  const contractID = Number(contract && contract.contractID) || 0;
  if (!positive(station) || !positive(destination) || !positive(characterID) || !positive(shipItemID) || !positive(contractID)) {
    return status("NO_FLIGHT", { reason: "contract or identity incomplete" });
  }
  if (station === destination) {
    return status("NO_FLIGHT", { reason: "origin and destination are the same station" });
  }
  return status("FLIGHT_PLANNED", {
    contractID,
    characterID,
    shipItemID,
    originStationID: station,
    destinationStationID: destination,
    step: "undock",
    stepStartedAtMs: Number(nowMs) || 0,
  });
}

function stepTimeoutMs(step, policy) {
  const rules = Object.assign({}, DEFAULT_FLIGHT_POLICY, policy || {});
  if (step === "undock") return Number(rules.undockTimeoutMs);
  if (step === "warp") return Number(rules.warpTimeoutMs);
  if (step === "dock") return Number(rules.dockTimeoutMs);
  return 0;
}

// One action per call. The caller performs it natively and then calls
// advanceFlight() with the observed result.
function nextAction(flight, nowMs, policy) {
  if (!flight || !STEPS.includes(flight.step)) {
    return status("NO_ACTION", { reason: "unknown flight step" });
  }
  const rules = Object.assign({}, DEFAULT_FLIGHT_POLICY, policy || {});
  // A step that was never stamped must not look infinitely old: without this,
  // a caller that forgets nowMs gets an instant FLIGHT_TIMEOUT.
  const startedAt = Number(flight.stepStartedAtMs) || 0;
  const elapsed = startedAt > 0 ? (Number(nowMs) || 0) - startedAt : 0;
  const timeout = stepTimeoutMs(flight.step, rules);
  if (timeout > 0 && elapsed > timeout) {
    return status("FLIGHT_TIMEOUT", { step: flight.step, elapsedMs: elapsed, timeoutMs: timeout });
  }
  if (flight.step === "done") return status("FLIGHT_DONE", { contractID: flight.contractID });
  return status("ACTION", {
    action: flight.step,
    contractID: flight.contractID,
    characterID: flight.characterID,
    shipItemID: flight.shipItemID,
    fromStationID: flight.originStationID,
    toStationID: flight.destinationStationID,
  });
}

// Advance only on a confirmed native outcome. An unconfirmed outcome leaves the
// flight where it is, so nothing is retried blindly.
// stepToken is `${step}:${stepStartedAtMs}` from the action that was executed.
// Without it a duplicated OK would advance two steps and silently skip the
// warp, so a mismatched token advances nothing.
function stepToken(flight) {
  return `${String(flight && flight.step || "")}:${Number(flight && flight.stepStartedAtMs) || 0}`;
}

function advanceFlight(flight, observed, nowMs, token) {
  const at = Number(nowMs) || 0;
  const current = String(flight && flight.step || "");
  if (token !== undefined && token !== null && String(token) !== stepToken(flight)) {
    return Object.assign({}, flight, { lastRejectedToken: String(token), lastObservedAtMs: at });
  }
  if (observed === "FAILED") {
    return Object.assign({}, flight, { step: "failed", stepStartedAtMs: at });
  }
  if (observed !== "OK") {
    return Object.assign({}, flight, { lastObserved: String(observed || ""), lastObservedAtMs: at });
  }
  const index = STEPS.indexOf(current);
  if (index < 0 || index === STEPS.length - 1) {
    return Object.assign({}, flight, { lastObserved: "OK", lastObservedAtMs: at });
  }
  return Object.assign({}, flight, { step: STEPS[index + 1], stepStartedAtMs: at, lastObserved: "OK" });
}

// Bounded concurrency: only flights that are actually flying count, and the cap
// keeps the per-tick cost flat no matter how many contracts exist.
function selectActiveFlights(flights, policy) {
  const rules = Object.assign({}, DEFAULT_FLIGHT_POLICY, policy || {});
  const limit = Math.max(0, Number(rules.maxConcurrentFlights) || 0);
  const active = (Array.isArray(flights) ? flights : [])
    .filter((flight) => flight && flight.step !== "done" && flight.step !== "failed");
  return {
    activeCount: active.length,
    admitted: active.slice(0, limit).map((flight) => flight.contractID),
    deferred: active.slice(limit).map((flight) => flight.contractID),
  };
}

module.exports = {
  STEPS,
  stepToken,
  DEFAULT_FLIGHT_POLICY,
  createFlight,
  nextAction,
  advanceFlight,
  selectActiveFlights,
};
