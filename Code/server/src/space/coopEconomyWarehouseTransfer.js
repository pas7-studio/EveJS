'use strict';
const { createJournal } = require("./coopEconomyJournal");

const TRANSFER_CODE = 'TRANSFER';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function createTransfer(options) {
  // a replay after a restart must still see this record: pass {journal} to persist it
  const transferred = createJournal(options && options.journal);

  function transfer({
    cargoID,
    sellerCorpID,
    buyerCorpID,
    typeID,
    quantity,
    priceCents,
    buyerWalletCents,
    transferPort
  } = {}) {
    // 1. Validate inputs.
    if (
      !isNonEmptyString(cargoID) ||
      !isNonEmptyString(sellerCorpID) ||
      !isNonEmptyString(buyerCorpID) ||
      !isNonEmptyString(typeID) ||
      !isPositiveSafeInteger(quantity) ||
      !isPositiveSafeInteger(priceCents) ||
      !isNonNegativeSafeInteger(buyerWalletCents)
    ) {
      return { ok: false, code: 'INVALID_TRANSFER' };
    }

    // 2. Self trade.
    if (sellerCorpID === buyerCorpID) {
      return { ok: false, code: 'SELF_TRADE' };
    }

    // 3. Already transferred.
    const existing = transferred.get(cargoID);
    if (existing) {
      return { ok: true, code: 'ALREADY_TRANSFERRED', goodsReceiptID: existing.goodsReceiptID, paymentReceiptID: existing.paymentReceiptID };
    }

    // 4. Insufficient funds.
    const totalCents = priceCents * quantity;
    if (totalCents > buyerWalletCents) {
      return { ok: false, code: 'INSUFFICIENT_FUNDS' };
    }

    // 5. Native authority unavailable.
    if (typeof transferPort.transferGoodsAndFunds !== 'function') {
      return { ok: false, code: 'NATIVE_AUTHORITY_UNAVAILABLE' };
    }

    // 6. Authoritative call.
    let result;
    try {
      result = transferPort.transferGoodsAndFunds({
        cargoID,
        sellerCorpID,
        buyerCorpID,
        typeID,
        quantity,
        totalCents
      });
    } catch (err) {
      return { ok: false, code: 'TRANSFER_UNKNOWN' };
    }

    const goodsReceiptID = result && result.goodsReceiptID;
    const paymentReceiptID = result && result.paymentReceiptID;
    if (!goodsReceiptID || !paymentReceiptID) {
      return { ok: false, code: 'PARTIAL_TRANSFER', goodsReceiptID, paymentReceiptID };
    }

    // 7. Success.
    transferred.set(cargoID, { goodsReceiptID, paymentReceiptID });
    return { ok: true, code: 'TRANSFERRED', goodsReceiptID, paymentReceiptID, totalCents };
  }

  return { transfer };
}

module.exports = { createTransfer, TRANSFER_CODE };
