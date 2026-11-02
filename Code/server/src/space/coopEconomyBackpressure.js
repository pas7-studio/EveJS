'use strict';

/*
 * coopEconomyBackpressure
 * -----------------------
 * A tiny backpressure controller for cooperative-economy operations.
 * CommonJS, zero dependencies.
 *
 * createBackpressure() returns an object that keeps private counters and a
 * Map(operationID -> state) where state is one of:
 *   "ACTIVE" | "QUEUED" | "BLOCKED" | "REJECTED"
 */

var BACKPRESSURE_CODE = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  ALREADY_KNOWN: 'ALREADY_KNOWN',
  FACILITY_UNAVAILABLE: 'FACILITY_UNAVAILABLE',
  WAREHOUSE_FULL: 'WAREHOUSE_FULL',
  ADMITTED: 'ADMITTED',
  QUEUED: 'QUEUED',
  QUEUE_FULL: 'QUEUE_FULL',
  COMPLETED: 'COMPLETED',
  UNKNOWN_OPERATION: 'UNKNOWN_OPERATION'
};

function createBackpressure(opts) {
  opts = opts || {};

  var maxActive = opts.maxActive === undefined ? 4 : opts.maxActive;
  var maxQueued = opts.maxQueued === undefined ? 8 : opts.maxQueued;

  function isPositiveSafeInteger(n) {
    return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
  }

  function isValidRequest(operationID) {
    return operationID !== undefined &&
      operationID !== null &&
      operationID !== '' &&
      isPositiveSafeInteger(maxActive) &&
      isPositiveSafeInteger(maxQueued);
  }

  var activeCount = 0;
  var queuedCount = 0;
  var operations = Object.create(null);

  function recomputeCounts() {
    var a = 0;
    var q = 0;
    for (var key in operations) {
      if (Object.prototype.hasOwnProperty.call(operations, key)) {
        if (operations[key] === 'ACTIVE') { a += 1; }
        else if (operations[key] === 'QUEUED') { q += 1; }
      }
    }
    return { active: a, queued: q };
  }

  function admit(req) {
    // The counters were incremented on admit and never touched by complete(), so a finished job
    // kept its slot for ever and the pool reported itself full after a few operations. The map is
    // the authority (counts() already recomputes from it); derive the limits from it here too.
    var live = recomputeCounts();
    activeCount = live.active;
    queuedCount = live.queued;

    if (!isValidRequest(req.operationID)) {
      return { ok: false, code: 'INVALID_REQUEST', state: undefined };
    }

    var id = req.operationID;

    // The same operationID again -> never a second active job.
    if (operations[id] !== undefined) {
      return { ok: true, code: 'ALREADY_KNOWN', state: operations[id] };
    }

    // Facility must be available.
    var facility = req.facility;
    if (facility !== undefined && facility.available !== true) {
      operations[id] = 'BLOCKED';
      return { ok: false, code: 'FACILITY_UNAVAILABLE', state: 'BLOCKED' };
    }

    // Warehouse must have spare capacity. Nothing is ever deleted to make room.
    var warehouse = req.warehouse;
    if (warehouse !== undefined && warehouse.usedUnits >= warehouse.capacityUnits) {
      operations[id] = 'BLOCKED';
      return {
        ok: false,
        code: 'WAREHOUSE_FULL',
        state: 'BLOCKED',
        keptUnits: warehouse.usedUnits
      };
    }

    // Activate if there is room.
    if (activeCount < maxActive) {
      operations[id] = 'ACTIVE';
      activeCount += 1;
      return { ok: true, code: 'ADMITTED', state: 'ACTIVE' };
    }

    // Otherwise queue if there is room.
    if (queuedCount < maxQueued) {
      operations[id] = 'QUEUED';
      queuedCount += 1;
      return { ok: true, code: 'QUEUED', state: 'QUEUED' };
    }

    // Queue is full.
    operations[id] = 'REJECTED';
    return { ok: false, code: 'QUEUE_FULL', state: 'REJECTED' };
  }

  function complete(req) {
    var id = req.operationID;
    if (operations[id] === 'ACTIVE' || operations[id] === 'QUEUED') {
      delete operations[id];
      return { ok: true, code: 'COMPLETED' };
    }
    return { ok: false, code: 'UNKNOWN_OPERATION' };
  }

  function counts() {
    return recomputeCounts();
  }

  return {
    admit: admit,
    complete: complete,
    counts: counts
  };
}

module.exports = {
  createBackpressure: createBackpressure,
  BACKPRESSURE_CODE: BACKPRESSURE_CODE
};
