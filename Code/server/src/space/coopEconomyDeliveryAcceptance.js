'use strict';
const { createJournal } = require("./coopEconomyJournal");

/**
 * coopEconomyDeliveryAcceptance.js
 *
 * Accepts delivery receipts against a contract. The client payload is never
 * trusted on its own: the native item store (itemStore.read) is the source of
 * truth for typeID, stationID and quantity.
 *
 * CommonJS, no external dependencies.
 */

/**
 * createAcceptance() returns an object exposing accept().
 *
 * @returns {{ accept: Function }}
 */
function createAcceptance(options) {
  // Private ledger: receiptID -> accepted delivery record.
  // a replay after a restart must still see this record: pass {journal} to persist it
  const accepted = createJournal(options && options.journal);

  /**
   * accept({ contract, delivery, itemStore })
   *
   * @param {{ contract: Object, delivery: Object, itemStore: Object }}
   * @returns {{ ok: boolean, code: string, [field]: string|number }}
   */
  function accept({ contract, delivery, itemStore } = {}) {
    // A missing delivery payload cannot be an item write.
    if (!delivery || typeof delivery !== 'object') {
      return { ok: false, code: 'CLIENT_FLAG_ONLY' };
    }

    // 1. A client flag (deliveredFlag) without a receiptID or itemID is not an
    //    item write; it is only a flag and must be rejected.
    if (delivery.deliveredFlag) {
      const hasReceipt = delivery.receiptID !== undefined && delivery.receiptID !== null;
      const hasItem = delivery.itemID !== undefined && delivery.itemID !== null;
      if (!hasReceipt || !hasItem) {
        return { ok: false, code: 'CLIENT_FLAG_ONLY' };
      }
    }

    // 2. The delivery must match the contract on typeID, stationID and ownerID.
    const { typeID, stationID, ownerID } = delivery;
    const {
      typeID: cType,
      stationID: cStation,
      ownerID: cOwner,
      supplierID: cSupplier,
    } = contract || {};
    // IE-052: the item must come from the contracted supplier (a contract may name it ownerID or
    // supplierID, and both must agree when both are present).
    const expectedOwner = cOwner !== undefined ? cOwner : cSupplier;
    if (cOwner !== undefined && cSupplier !== undefined && cOwner !== cSupplier) {
      return { ok: false, code: 'MISMATCH', field: 'ownerID' };
    }
    if (typeID !== cType) {
      return { ok: false, code: 'MISMATCH', field: 'typeID' };
    }
    if (stationID !== cStation) {
      return { ok: false, code: 'MISMATCH', field: 'stationID' };
    }
    if (ownerID !== expectedOwner) {
      return { ok: false, code: 'MISMATCH', field: 'ownerID' };
    }

    // 3. Quantity must be positive.
    if (!(delivery.quantity > 0)) {
      return { ok: false, code: 'INVALID_DELIVERY' };
    }

    // 4. One receipt, one credit: an already-accepted receiptID is a no-op success.
    if (accepted.has(delivery.receiptID)) {
      // report the quantity that was really credited; a replayed payload may claim anything
      const stored = accepted.get(delivery.receiptID);
      return { ok: true, code: 'ALREADY_ACCEPTED', quantity: stored.quantity, itemID: stored.itemID };
    }

    // 5. The native authority must be present.
    if (typeof itemStore.read !== 'function') {
      return { ok: false, code: 'NATIVE_AUTHORITY_UNAVAILABLE' };
    }

    // 6. The native item store is the source of truth. It must return the same
    //    typeID and stationID and at least the delivered quantity.
    const stored = itemStore.read({ itemID: delivery.itemID });
    if (
      !stored ||
      stored.typeID !== typeID ||
      stored.stationID !== stationID ||
      stored.quantity < delivery.quantity
    ) {
      return { ok: false, code: 'ITEM_NOT_FOUND' };
    }

    // 7. Success: record the receipt and credit it.
    accepted.set(delivery.receiptID, {
      contractID: contract.contractID,
      itemID: delivery.itemID,
      typeID,
      stationID,
      ownerID,
      quantity: delivery.quantity,
      deliveredFlag: delivery.deliveredFlag,
    });

    return {
      ok: true,
      code: 'ACCEPTED',
      receiptID: delivery.receiptID,
      itemID: delivery.itemID,
      quantity: delivery.quantity,
    };
  }

  return { accept };
}

/**
 * ACCEPTANCE_CODE maps every status code to its string value.
 */
const ACCEPTANCE_CODE = {
  CLIENT_FLAG_ONLY: 'CLIENT_FLAG_ONLY',
  MISMATCH: 'MISMATCH',
  INVALID_DELIVERY: 'INVALID_DELIVERY',
  ALREADY_ACCEPTED: 'ALREADY_ACCEPTED',
  NATIVE_AUTHORITY_UNAVAILABLE: 'NATIVE_AUTHORITY_UNAVAILABLE',
  ITEM_NOT_FOUND: 'ITEM_NOT_FOUND',
  ACCEPTED: 'ACCEPTED',
};

module.exports = { createAcceptance, ACCEPTANCE_CODE };
