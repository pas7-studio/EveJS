'use strict';

/**
 * CommonJS module with no external dependencies.
 *
 * proveStationStock proves that a station physically holds enough stock of a
 * given type to satisfy a requested quantity. Availability comes ONLY from the
 * physical sum of warehouseItems whose stationID and typeID match. depotStatus
 * (e.g. "COMMITTED") is bookkeeping and never adds stock.
 */

// Stable set of status codes surfaced by proveStationStock.
var STOCK_CODE = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  ARRIVAL_RECEIPT_REQUIRED: 'ARRIVAL_RECEIPT_REQUIRED',
  NO_PHYSICAL_STOCK: 'NO_PHYSICAL_STOCK',
  STOCK_PROVEN: 'STOCK_PROVEN'
});

function proveStationStock(opts) {
  opts = opts || {};

  var stationID = opts.stationID;
  var typeID = opts.typeID;
  var quantity = opts.quantity;
  var arrival = opts.arrival;
  var warehouseItems = opts.warehouseItems;
  var depotStatus = opts.depotStatus;

  // 1. Validate the request.
  var stationIDOk =
    typeof stationID === 'string' && stationID.length > 0;
  var typeIDOk =
    typeof typeID === 'string' && typeID.length > 0;
  var quantityOk =
    typeof quantity === 'number' &&
    Number.isSafeInteger(quantity) &&
    quantity > 0;

  if (!stationIDOk || !typeIDOk || !quantityOk) {
    return { ok: false, code: STOCK_CODE.INVALID_REQUEST };
  }

  // 2. Validate the arrival receipt.
  var arrivalOk =
    typeof arrival === 'object' &&
    arrival !== null &&
    typeof arrival.receiptID === 'string' &&
    arrival.receiptID.length > 0;

  if (!arrivalOk) {
    return { ok: false, code: STOCK_CODE.ARRIVAL_RECEIPT_REQUIRED };
  }

  // 3. Compute the physical sum from matching warehouseItems.
  // depotStatus is intentionally ignored as a stock source.
  var available = 0;
  var itemIDs = [];

  if (Array.isArray(warehouseItems)) {
    for (var i = 0; i < warehouseItems.length; i++) {
      var entry = warehouseItems[i];
      if (
        entry &&
        entry.stationID === stationID &&
        entry.typeID === typeID
      ) {
        var entryQty = entry.quantity;
        if (typeof entryQty === 'number' && Number.isFinite(entryQty)) {
          available += entryQty;
          if (entryQty > 0) {
            itemIDs.push(entry.itemID);
          }
        }
      }
    }
  }

  // 4. Compare the physical sum against the requested quantity.
  if (available < quantity) {
    return {
      ok: false,
      code: STOCK_CODE.NO_PHYSICAL_STOCK,
      available: available
    };
  }

  // 5. Stock proven.
  itemIDs.sort(function (a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  });

  return {
    ok: true,
    code: STOCK_CODE.STOCK_PROVEN,
    available: available,
    itemIDs: itemIDs,
    unlocksRefinery: true
  };
}

module.exports = {
  proveStationStock: proveStationStock,
  STOCK_CODE: STOCK_CODE
};
