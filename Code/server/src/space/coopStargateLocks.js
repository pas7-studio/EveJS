"use strict";
// eve_public.stargate.lock.*: real stargate restrictions.
//
// The client already renders a locked stargate (a lock badge and a refusal when you try
// to activate it) and it asks two things: "is there a lock for me right now" and, for
// the admin side, "apply / delete / list". Stock answered an empty default, so no gate
// was ever restricted and the feature simply did not exist.
//
// A lock here is a real, persisted restriction on one stargate of one solar system with
// an expiry, and space/runtime.startStargateJump refuses a jump through a locked gate.
// Nothing is random and nothing is global: a lock expires on its own timestamp, and a
// delete removes the locks of exactly one solar system, as the client's request says.
const KEY = "coop-stargate-locks\u001fv1";
const TABLE = "corporationRuntime";
const SEP = "\u001f";
const VERSION = 1;
const MAX_LOCKS = 512;

function pos(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function nowMsOf(clock) {
  const value = Number(clock());
  return Number.isFinite(value) ? Math.trunc(value) : Date.now();
}

function empty() {
  return { version: VERSION, locks: {} };
}

function validate(state) {
  if (!state || state.version !== VERSION || !state.locks ||
    typeof state.locks !== "object" || Array.isArray(state.locks)) {
    throw Error("STARGATE_LOCKS_INVALID");
  }
  const keys = Object.keys(state.locks);
  if (keys.length > MAX_LOCKS) throw Error("STARGATE_LOCKS_TOO_LARGE");
  for (const key of keys) {
    const lock = state.locks[key];
    if (!lock || !pos(Number(key))) throw Error("STARGATE_LOCKS_KEY_INVALID");
    if (!pos(Number(lock.systemID)) || !pos(Number(lock.gateID)) ||
      !pos(Number(lock.expiresAtMs))) {
      throw Error("STARGATE_LOCKS_ROW_INVALID");
    }
  }
  return state;
}

function createStargateLocks({ gameStore, clock = () => Date.now(), env = process.env } = {}) {
  if (typeof gameStore?.read !== "function" || typeof gameStore?.write !== "function") {
    throw Error("STARGATE_LOCKS_STORE_REQUIRED");
  }
  const enabled = () => env.EVEJS_COOP_STARGATE_LOCKS === "1";

  function readState() {
    for (const pth of ["/" + KEY.split(SEP).join("/"), "/" + KEY]) {
      const read = gameStore.read(TABLE, pth);
      if (read?.success === true && read.data && typeof read.data === "object") {
        return validate(read.data);
      }
    }
    return empty();
  }

  function writeState(state) {
    const written = gameStore.write(TABLE, "/" + KEY.split(SEP).join("/"), validate(state));
    if (!written || written.success !== true) {
      throw Error("STARGATE_LOCKS_WRITE_FAILED");
    }
    return state;
  }

  // Expired rows are dropped on every read so a lock can never outlive its timestamp.
  function liveLocks(nowMs) {
    const state = readState();
    const now = Number(nowMs) || nowMsOf(clock);
    let changed = false;
    for (const [key, lock] of Object.entries(state.locks)) {
      if (Number(lock.expiresAtMs) <= now) {
        delete state.locks[key];
        changed = true;
      }
    }
    if (changed) {
      try {
        writeState(state);
      } catch (_error) { /* a stale row must not break the read */ }
    }
    return state.locks;
  }

  function apply({ systemID, gateID, expiresAtMs, byCharacterID = 0 } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const system = Number(systemID);
    const gate = Number(gateID);
    const expires = Number(expiresAtMs);
    if (!pos(system)) return { status: "SYSTEM_REQUIRED" };
    if (!pos(gate)) return { status: "GATE_REQUIRED" };
    if (!pos(expires)) return { status: "EXPIRY_REQUIRED" };
    if (expires <= nowMsOf(clock)) return { status: "ALREADY_EXPIRED" };
    const state = readState();
    if (!state.locks[String(gate)] && Object.keys(state.locks).length >= MAX_LOCKS) {
      return { status: "TOO_MANY_LOCKS" };
    }
    state.locks[String(gate)] = {
      systemID: system,
      gateID: gate,
      expiresAtMs: expires,
      byCharacterID: pos(Number(byCharacterID)) ? Number(byCharacterID) : 0,
      appliedAtMs: nowMsOf(clock),
    };
    try {
      writeState(state);
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
    return { status: "APPLIED", gateID: gate, systemID: system, expiresAtMs: expires };
  }

  function deleteForSystem(systemID) {
    if (!enabled()) return { status: "DISABLED" };
    const system = Number(systemID);
    if (!pos(system)) return { status: "SYSTEM_REQUIRED" };
    const state = readState();
    let removed = 0;
    for (const [key, lock] of Object.entries(state.locks)) {
      if (Number(lock.systemID) === system) {
        delete state.locks[key];
        removed += 1;
      }
    }
    if (!removed) return { status: "NOT_FOUND" };
    try {
      writeState(state);
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
    return { status: "DELETED", removed };
  }

  function list(nowMs = clock()) {
    return Object.values(liveLocks(nowMs))
      .sort((left, right) => left.gateID - right.gateID)
      .map((lock) => ({
        systemID: Number(lock.systemID),
        gateID: Number(lock.gateID),
        expiresAtMs: Number(lock.expiresAtMs),
      }));
  }

  function lockedSystemIDs(nowMs = clock()) {
    return [...new Set(list(nowMs).map((lock) => lock.systemID))].sort((a, b) => a - b);
  }

  // The gate a character is standing at, if it is locked: the client's public Get asks
  // exactly this and nothing else.
  function lockForGate(gateID, nowMs = clock()) {
    const lock = liveLocks(nowMs)[String(Number(gateID))];
    return lock
      ? {
        systemID: Number(lock.systemID),
        gateID: Number(lock.gateID),
        expiresAtMs: Number(lock.expiresAtMs),
      }
      : null;
  }

  return Object.freeze({
    enabled,
    apply,
    deleteForSystem,
    list,
    lockedSystemIDs,
    lockForGate,
    isLocked: (gateID, nowMs) => Boolean(lockForGate(gateID, nowMs)),
  });
}

let singleton = null;
function shared() {
  if (!singleton) {
    singleton = createStargateLocks({ gameStore: require("../gameStore") });
  }
  return singleton;
}

module.exports = {
  KEY,
  TABLE,
  apply: (...args) => shared().apply(...args),
  createStargateLocks,
  empty,
  shared,
  validate,
};
