'use strict';
const { createJournal } = require("./coopEconomyJournal");

/**
 * Fleet resupply authority.
 *
 * createResupply() returns an object exposing resupply(), which issues a
 * delivery against a hull, a warehouse and a native authority "fit" function.
 * Issued deliveries are tracked in a private Map keyed by deliveryID.
 */
function createResupply(options) {
  // one delivery, one issue: a restart must not resupply the same cargo twice
  const issued = createJournal(options && options.journal);

  function resupply({ deliveryID, item, hull, warehouse, equipmentPort } = {}) {
    // 1. Validate the delivery identity and the requested quantity.
    if (
      typeof deliveryID !== 'string' ||
      deliveryID.length === 0 ||
      !item ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity <= 0
    ) {
      return { ok: false, code: 'INVALID_DELIVERY' };
    }

    // 2. A deliveryID that was already issued is never issued a second time.
    if (issued.has(deliveryID)) {
      const existing = issued.get(deliveryID);
      return { ok: true, code: 'ALREADY_ISSUED', receiptID: existing.receiptID };
    }

    // 3. The hull must be docked and physically present at the station.
    if (hull.docked !== true || hull.stationID !== item.stationID) {
      return { ok: false, code: 'HULL_UNAVAILABLE' };
    }

    // 4. The warehouse must be at the same station and hold enough stock.
    if (warehouse.stationID !== item.stationID || warehouse.quantity < item.quantity) {
      return { ok: false, code: 'STOCK_SHORT' };
    }

    // 5. The native authority must expose a fit function.
    if (typeof equipmentPort.fit !== 'function') {
      return { ok: false, code: 'NATIVE_AUTHORITY_UNAVAILABLE' };
    }

    // 6. Call fit exactly once.
    let fitResult;
    try {
      fitResult = equipmentPort.fit({
        hullID: hull.hullID,
        typeID: item.typeID,
        quantity: item.quantity,
      });
    } catch (err) {
      return { ok: false, code: 'FIT_UNKNOWN' };
    }

    if (
      !fitResult ||
      typeof fitResult.receiptID !== 'string' ||
      fitResult.receiptID.length === 0
    ) {
      return { ok: false, code: 'FIT_UNKNOWN' };
    }

    const receiptID = fitResult.receiptID;

    // 7. Store the issued delivery and report the remaining stock.
    issued.set(deliveryID, {
      hullID: hull.hullID,
      typeID: item.typeID,
      quantity: item.quantity,
      receiptID: receiptID,
    });

    return {
      ok: true,
      code: 'RESUPPLIED',
      receiptID: receiptID,
      warehouseRemaining: warehouse.quantity - item.quantity,
    };
  }

  return { resupply };
}

const RESUPPLY_CODE = 'RESUPPLY';

module.exports = { createResupply, RESUPPLY_CODE };
