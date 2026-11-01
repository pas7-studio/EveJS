"use strict";
const { createJournal } = require("./coopEconomyJournal");

/**
 * Hauler reservation pool.
 *
 * createHaulerPool() returns an object that carries the two private
 * collections (hulls and runs) plus the public methods that operate on them.
 *
 * CommonJS, no external dependencies.
 */

const HAULER_CODE = {
  REGISTERED: "REGISTERED",
  INVALID_HULL: "INVALID_HULL",
  ALREADY_RESERVED: "ALREADY_RESERVED",
  UNKNOWN_HULL: "UNKNOWN_HULL",
  HULL_FROZEN: "HULL_FROZEN",
  HULL_RESERVED: "HULL_RESERVED",
  INSUFFICIENT_CAPACITY: "INSUFFICIENT_CAPACITY",
  CARGO_ALREADY_LOADED: "CARGO_ALREADY_LOADED",
  RESERVED: "RESERVED",
  FROZEN: "FROZEN",
  EVIDENCE_REQUIRED: "EVIDENCE_REQUIRED",
  RECONCILED: "RECONCILED"
};

function createHaulerPool(options) {
  const durable = options && options.journal;
  const namespaced = (prefix) => {
    if (!durable) return undefined;
    return {
      get: (k) => durable.get(prefix + k),
      set: (k, v) => durable.set(prefix + k, v),
      has: (k) => (typeof durable.has === "function" ? durable.has(prefix + k) : durable.get(prefix + k) !== undefined),
      delete: (k) => (typeof durable.delete === "function" ? durable.delete(prefix + k) : undefined),
      entries: () => (typeof durable.entries === "function"
        ? [...durable.entries()].filter((e) => String(e[0]).startsWith(prefix))
            .map((e) => [String(e[0]).slice(prefix.length), e[1]])
        : []),
    };
  };
  const hulls = createJournal(namespaced("hull:")); // hullID -> { capacityM3, frozen, reason }
  const runs = createJournal(namespaced("run:")); // runID -> { hullID, volumeM3, cargoIDs }

  function register(input) {
    const { hullID, capacityM3 } = input || {};

    if (typeof hullID !== "string" || hullID.length === 0) {
      return { ok: false, code: HAULER_CODE.INVALID_HULL };
    }
    if (typeof capacityM3 !== "number" || !isFinite(capacityM3) || capacityM3 <= 0) {
      return { ok: false, code: HAULER_CODE.INVALID_HULL };
    }

    hulls.set(hullID, { capacityM3, frozen: false, reason: null });
    return { ok: true, code: HAULER_CODE.REGISTERED };
  }

  function reserve(input) {
    const { runID, hullID, volumeM3, cargoIDs } = input || {};

    // One reservation per run: reusing the same runID is a no-op confirmation.
    if (runID != null && runs.has(runID)) {
      return { ok: true, code: HAULER_CODE.ALREADY_RESERVED, hullID };
    }

    // The hull must exist.
    if (!hulls.has(hullID)) {
      return { ok: false, code: HAULER_CODE.UNKNOWN_HULL };
    }

    // A lost or disconnected hull is never reassigned.
    if (hulls.get(hullID).frozen) {
      return { ok: false, code: HAULER_CODE.HULL_FROZEN };
    }

    // Another run already holds that hull.
    for (const run of runs.values()) {
      if (run.hullID === hullID) {
        return { ok: false, code: HAULER_CODE.HULL_RESERVED };
      }
    }

    // The volume must fit inside the hull capacity.
    const capacityM3 = hulls.get(hullID).capacityM3;
    if (typeof volumeM3 !== "number" || !isFinite(volumeM3) || volumeM3 <= 0 || volumeM3 > capacityM3) {
      return { ok: false, code: HAULER_CODE.INSUFFICIENT_CAPACITY };
    }

    // No cargoID may be loaded by more than one run.
    const cargoIDsArr = Array.isArray(cargoIDs) ? cargoIDs : [];
    for (const cid of cargoIDsArr) {
      for (const run of runs.values()) {
        if (run.cargoIDs && run.cargoIDs.indexOf(cid) !== -1) {
          return { ok: false, code: HAULER_CODE.CARGO_ALREADY_LOADED };
        }
      }
    }

    runs.set(runID, { hullID, volumeM3, cargoIDs: cargoIDsArr });
    return { ok: true, code: HAULER_CODE.RESERVED, hullID };
  }

  function freeze(input) {
    const { hullID, reason } = input || {};

    if (!hulls.has(hullID)) {
      return { ok: false, code: HAULER_CODE.UNKNOWN_HULL };
    }

    const hull = hulls.get(hullID);
    hull.frozen = true;
    hull.reason = reason || null;
    return { ok: true, code: HAULER_CODE.FROZEN };
  }

  function reconcile(input) {
    const { hullID, evidence } = input || {};

    if (typeof evidence !== "string" || evidence.length === 0) {
      return { ok: false, code: HAULER_CODE.EVIDENCE_REQUIRED };
    }

    if (hulls.has(hullID)) {
      const hull = hulls.get(hullID);
      hull.frozen = false;
      hull.reason = null;
    }
    return { ok: true, code: HAULER_CODE.RECONCILED };
  }

  function release(runID) {
    if (!runs.has(runID)) {
      return false;
    }

    const run = runs.get(runID);
    runs.delete(runID);

    // Freeing the run also frees its hull back into service.
    if (run.hullID != null && hulls.has(run.hullID)) {
      const hull = hulls.get(run.hullID);
      hull.frozen = false;
      hull.reason = null;
    }
    return true;
  }

  function hullOf(runID) {
    const run = runs.get(runID);
    return run ? run.hullID : null;
  }

  return {
    hulls,
    runs,
    register,
    reserve,
    freeze,
    reconcile,
    release,
    hullOf
  };
}

module.exports = {
  createHaulerPool,
  HAULER_CODE
};
