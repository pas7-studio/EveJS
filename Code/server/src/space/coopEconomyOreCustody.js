'use strict';

/**
 * Ore Custody registry.
 *
 * Tracks private cargo entries of the shape:
 *   { ownerID, holderID, typeID, quantity }
 *
 * The ownerID (the miner's title) is immutable; only custody (holderID) moves.
 */

var CUSTODY_CODE = {
  INVALID_CARGO: 'INVALID_CARGO',
  DUPLICATE_CARGO_ID: 'DUPLICATE_CARGO_ID',
  LOADED: 'LOADED',
  UNKNOWN_CARGO: 'UNKNOWN_CARGO',
  CUSTODY_MOVED: 'CUSTODY_MOVED'
};

function createCustody() {
  var cargo = Object.create(null);

  function load(entry) {
    var cargoID = entry && entry.cargoID;
    var ownerID = entry && entry.ownerID;
    var holderID = entry && entry.holderID;
    var typeID = entry && entry.typeID;
    var quantity = entry && entry.quantity;

    if (
      typeof cargoID !== 'string' || cargoID.length === 0 ||
      typeof ownerID !== 'string' || ownerID.length === 0 ||
      typeof holderID !== 'string' || holderID.length === 0 ||
      typeof typeID !== 'string' || typeID.length === 0
    ) {
      return { ok: false, code: CUSTODY_CODE.INVALID_CARGO };
    }

    if (
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      quantity > Number.MAX_SAFE_INTEGER
    ) {
      return { ok: false, code: CUSTODY_CODE.INVALID_CARGO };
    }

    if (cargo[cargoID] !== undefined) {
      return { ok: false, code: CUSTODY_CODE.DUPLICATE_CARGO_ID };
    }

    cargo[cargoID] = {
      ownerID: ownerID,
      holderID: holderID,
      typeID: typeID,
      quantity: quantity
    };

    return { ok: true, code: CUSTODY_CODE.LOADED, cargoID: cargoID };
  }

  function transfer(entry) {
    var cargoID = entry && entry.cargoID;
    var toHolderID = entry && entry.toHolderID;

    if (typeof cargoID !== 'string' || cargoID.length === 0 ||
        typeof toHolderID !== 'string' || toHolderID.length === 0) {
      return { ok: false, code: CUSTODY_CODE.UNKNOWN_CARGO };
    }

    var entryObj = cargo[cargoID];
    if (!entryObj) {
      return { ok: false, code: CUSTODY_CODE.UNKNOWN_CARGO };
    }

    entryObj.holderID = toHolderID;

    return {
      ok: true,
      code: CUSTODY_CODE.CUSTODY_MOVED,
      cargoID: cargoID,
      ownerID: entryObj.ownerID,
      holderID: toHolderID,
      quantity: entryObj.quantity
    };
  }

  function cargo(cargoID) {
    var entryObj = cargo[cargoID];
    if (!entryObj) {
      return null;
    }
    return {
      ownerID: entryObj.ownerID,
      holderID: entryObj.holderID,
      typeID: entryObj.typeID,
      quantity: entryObj.quantity
    };
  }

  function totalQuantity() {
    var sum = 0;
    for (var id in cargo) {
      if (Object.prototype.hasOwnProperty.call(cargo, id)) {
        sum += cargo[id].quantity;
      }
    }
    return sum;
  }

  function ownerTotal(ownerID) {
    var sum = 0;
    for (var id in cargo) {
      if (Object.prototype.hasOwnProperty.call(cargo, id)) {
        if (cargo[id].ownerID === ownerID) {
          sum += cargo[id].quantity;
        }
      }
    }
    return sum;
  }

  return {
    load: load,
    transfer: transfer,
    cargo: cargo,
    totalQuantity: totalQuantity,
    ownerTotal: ownerTotal
  };
}

module.exports = {
  createCustody: createCustody,
  CUSTODY_CODE: CUSTODY_CODE
};
