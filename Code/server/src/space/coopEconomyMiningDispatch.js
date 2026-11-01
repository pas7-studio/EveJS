'use strict';

function dispatchMining(opts) {
  opts = opts || {};
  var need = opts.need || {};
  var fleet = opts.fleet || [];
  var miningPort = opts.miningPort || null;

  var typeID = need.typeID;
  var quantity = need.quantity;

  // Rule 1: invalid need or no candidate hull -> NO_HULL (no invented ship).
  if (!need || typeof need !== 'object' || !typeID || !Number.isSafeInteger(quantity) || quantity <= 0) {
    return { ok: false, code: 'NO_HULL' };
  }

  // Rule 3: a candidate is a hull with busy !== true and capacity >= quantity;
  // choose the first by hullID sort.
  var candidate = null;
  for (var i = 0; i < fleet.length; i++) {
    var hull = fleet[i];
    if (hull && hull.hullID && hull.capacity >= quantity && hull.busy !== true) {
      if (candidate === null || hull.hullID < candidate.hullID) {
        candidate = hull;
      }
    }
  }
  if (candidate === null) {
    return { ok: false, code: 'NO_HULL' };
  }

  var operationID = opts.operationID || ('mine:' + candidate.hullID + ':' + typeID + ':' + quantity);

  // Rule 2: miningPort.dispatch is not a function -> NATIVE_AUTHORITY_UNAVAILABLE.
  if (typeof miningPort !== 'object' || miningPort === null || typeof miningPort.dispatch !== 'function') {
    return { ok: false, code: 'NATIVE_AUTHORITY_UNAVAILABLE' };
  }

  // Rule 4: call miningPort.dispatch exactly once; a throw -> NATIVE_OPERATION_UNKNOWN.
  var dispatchResult;
  try {
    dispatchResult = miningPort.dispatch({
      operationID: operationID,
      hullID: candidate.hullID,
      typeID: typeID,
      quantity: quantity
    });
  } catch (e) {
    return { ok: false, code: 'NATIVE_OPERATION_UNKNOWN', operationID: operationID };
  }

  // Rule 5: non-empty string receiptID -> DISPATCHED; anything else -> NATIVE_OPERATION_UNKNOWN.
  var receiptID = dispatchResult && dispatchResult.receiptID;
  if (receiptID && typeof receiptID === 'string' && receiptID.length > 0) {
    return { ok: true, code: 'DISPATCHED', operationID: operationID, receiptID: receiptID };
  }
  return { ok: false, code: 'NATIVE_OPERATION_UNKNOWN', operationID: operationID };
}

module.exports = { dispatchMining: dispatchMining };
