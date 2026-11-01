'use strict';

// IE-047: arrival at the destination and a partial unload. The sale is only possible while the hull is
// actually at the station, and whatever is not sold stays aboard with its owner and exact quantity - it is
// never silently dropped, rounded or reassigned.

const UNLOAD_CODE = {
  UNLOADED: 'UNLOADED',
  EMPTY_HULL: 'EMPTY_HULL',
  INVALID_CARGO: 'INVALID_CARGO',
  INVALID_ORDER: 'INVALID_ORDER',
  NOT_AT_STATION: 'NOT_AT_STATION',
  NATIVE_AUTHORITY_UNAVAILABLE: 'NATIVE_AUTHORITY_UNAVAILABLE',
  UNLOAD_UNKNOWN: 'UNLOAD_UNKNOWN',
};

const DEFAULT_DOCK_RANGE_METERS = 2500;

function isID(value) {
  return typeof value === 'string' && value.length > 0;
}

function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function unload(args) {
  const { cargo, station, orders, unloadPort } = args || {};

  if (!cargo || !isID(cargo.ownerID) || !isID(cargo.typeID) || !isCount(cargo.quantity)) {
    return { ok: false, code: UNLOAD_CODE.INVALID_CARGO };
  }
  if (cargo.quantity === 0) return { ok: false, code: UNLOAD_CODE.EMPTY_HULL };
  if (!station || !isID(station.stationID)) return { ok: false, code: UNLOAD_CODE.INVALID_CARGO };

  const range = Number.isSafeInteger(station.dockRangeMeters) ? station.dockRangeMeters : DEFAULT_DOCK_RANGE_METERS;
  const distance = typeof station.distanceMeters === 'number' ? station.distanceMeters : 0;
  if (distance > range) return { ok: false, code: UNLOAD_CODE.NOT_AT_STATION };

  if (!unloadPort || typeof unloadPort.deposit !== 'function') {
    return { ok: false, code: UNLOAD_CODE.NATIVE_AUTHORITY_UNAVAILABLE };
  }

  let demand = 0;
  let revenueCents = 0;
  let left = cargo.quantity;
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!order || !Number.isSafeInteger(order.priceCents) || !Number.isSafeInteger(order.quantity)) continue;
    if (order.priceCents <= 0 || order.quantity <= 0) continue;
    const take = Math.min(order.quantity, left);
    if (take <= 0) continue;
    // a line total that overflows a safe integer is not money: refuse the whole unload
    if (!Number.isSafeInteger(take * order.priceCents)) {
      return { ok: false, code: UNLOAD_CODE.INVALID_ORDER };
    }
    if (!Number.isSafeInteger(revenueCents + take * order.priceCents)) {
      return { ok: false, code: UNLOAD_CODE.INVALID_ORDER };
    }
    demand += take;
    revenueCents += take * order.priceCents;
    left -= take;
    if (left === 0) break;
  }

  if (demand === 0) {
    return {
      ok: true,
      code: UNLOAD_CODE.UNLOADED,
      depositReceiptID: null,
      sold: { quantity: 0, cents: 0 },
      remaining: { ownerID: cargo.ownerID, typeID: cargo.typeID, quantity: cargo.quantity },
    };
  }

  let receipt;
  try {
    receipt = unloadPort.deposit({
      stationID: station.stationID,
      ownerID: cargo.ownerID,
      typeID: cargo.typeID,
      quantity: demand,
    });
  } catch (error) {
    return { ok: false, code: UNLOAD_CODE.UNLOAD_UNKNOWN };
  }
  if (!receipt || !isID(receipt.receiptID)) return { ok: false, code: UNLOAD_CODE.UNLOAD_UNKNOWN };

  return {
    ok: true,
    code: UNLOAD_CODE.UNLOADED,
    depositReceiptID: receipt.receiptID,
    sold: { quantity: demand, cents: revenueCents },
    remaining: { ownerID: cargo.ownerID, typeID: cargo.typeID, quantity: cargo.quantity - demand },
  };
}

module.exports = { unload, UNLOAD_CODE };
