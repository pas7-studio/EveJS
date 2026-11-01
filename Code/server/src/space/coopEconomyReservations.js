'use strict';
const { createJournal } = require("./coopEconomyJournal");

var util = require('util');

var CODES = {
  INVALID_QUANTITY: 'INVALID_QUANTITY',
  ALREADY_RESERVED: 'ALREADY_RESERVED',
  INSUFFICIENT_AVAILABLE: 'INSUFFICIENT_AVAILABLE',
  RESERVED: 'RESERVED',
};

function createReservations(options) {
  // a reservation is a promise: it must survive a restart
  var byKey = createJournal(options && options.journal);

  function reservedOn(key) {
    var m = byKey.get(key);
    if (!m) return 0;
    var total = 0;
    m.forEach(function (quantity) { total += quantity; });
    return total;
  }

  function reserve(key, operationID, quantity, onHand) {
    if (typeof key !== 'string' || key.length === 0) {
      return { ok: false, code: CODES.INVALID_QUANTITY };
    }
    if (typeof operationID !== 'string' || operationID.length === 0) {
      return { ok: false, code: CODES.INVALID_QUANTITY };
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0 || quantity > Number.MAX_SAFE_INTEGER) {
      return { ok: false, code: CODES.INVALID_QUANTITY };
    }
    if (typeof onHand !== 'number' || !Number.isInteger(onHand) || onHand < 0 || onHand > Number.MAX_SAFE_INTEGER) {
      return { ok: false, code: CODES.INVALID_QUANTITY };
    }

    var m = byKey.get(key);
    if (!m) {
      m = new Map();
      byKey.set(key, m);
    }
    if (m.has(operationID)) {
      return { ok: true, code: CODES.ALREADY_RESERVED, quantity: quantity };
    }
    if (reservedOn(key) + quantity > onHand) {
      return { ok: false, code: CODES.INSUFFICIENT_AVAILABLE };
    }
    m.set(operationID, quantity);
    return { ok: true, code: CODES.RESERVED, quantity: quantity };
  }

  function release(key, operationID) {
    var m = byKey.get(key);
    if (!m) return false;
    if (!m.has(operationID)) return false;
    m.delete(operationID);
    if (m.size === 0) {
      byKey.delete(key);
    }
    return true;
  }

  function reservedFor(key) {
    return reservedOn(key);
  }

  function releaseAll(operationID) {
    var removed = 0;
    byKey.forEach(function (m, key) {
      if (m.has(operationID)) {
        m.delete(operationID);
        if (m.size === 0) {
          byKey.delete(key);
        }
        removed++;
      }
    });
    return removed;
  }

  return {
    reserve: reserve,
    release: release,
    reservedFor: reservedFor,
    releaseAll: releaseAll,
  };
}

var RESERVATION_CODE = {
  INVALID_QUANTITY: CODES.INVALID_QUANTITY,
  ALREADY_RESERVED: CODES.ALREADY_RESERVED,
  INSUFFICIENT_AVAILABLE: CODES.INSUFFICIENT_AVAILABLE,
  RESERVED: CODES.RESERVED,
};

module.exports = {
  createReservations: createReservations,
  RESERVATION_CODE: RESERVATION_CODE,
};
