'use strict';
const { createJournal } = require("./coopEconomyJournal");

const PURCHASE_CODE = 'PURCHASED';

function isValidAsk(ask) {
  if (!ask || typeof ask !== 'object') return false;
  const { askID, sellerCorpID, typeID, quantity, priceCents } = ask;
  for (const id of [askID, sellerCorpID, typeID]) {
    if (typeof id !== 'string' || id.length === 0) return false;
  }
  if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0) return false;
  if (typeof priceCents !== 'number' || !Number.isSafeInteger(priceCents) || priceCents <= 0) return false;
  return true;
}

function createBuyer(options) {
  // a replay after a restart must still see this record: pass {journal} to persist it
  const records = createJournal(options && options.journal);

  function purchase({ operationID, buyerCorpID, ask, walletCents, settlementPort, itemPort } = {}) {
    if (!isValidAsk(ask)) {
      return { ok: false, code: 'INVALID_ASK' };
    }

    if (buyerCorpID === ask.sellerCorpID) {
      return { ok: false, code: 'SELF_TRADE' };
    }

    const existing = records.get(operationID);
    if (existing) {
      return { ok: true, code: 'ALREADY_PURCHASED', fill: existing.fill, debitReceiptID: existing.debitReceiptID };
    }

    const totalCents = ask.priceCents * ask.quantity;
    if (totalCents > walletCents) {
      return { ok: false, code: 'INSUFFICIENT_FUNDS' };
    }

    if (typeof settlementPort.debit !== 'function' || typeof itemPort.transfer !== 'function') {
      return { ok: false, code: 'NATIVE_AUTHORITY_UNAVAILABLE' };
    }

    let debitReceiptID;
    try {
      const receipt = settlementPort.debit({ operationID, corpID: buyerCorpID, cents: totalCents, askID: ask.askID });
      if (!receipt || !receipt.receiptID) {
        return { ok: false, code: 'SETTLEMENT_UNKNOWN' };
      }
      debitReceiptID = receipt.receiptID;
    } catch (e) {
      return { ok: false, code: 'SETTLEMENT_UNKNOWN' };
    }

    let transferReceiptID;
    try {
      const receipt = itemPort.transfer({ askID: ask.askID, toCorpID: buyerCorpID, typeID: ask.typeID, quantity: ask.quantity });
      if (!receipt || !receipt.receiptID) {
        return { ok: false, code: 'TRANSFER_UNKNOWN', debitReceiptID };
      }
      transferReceiptID = receipt.receiptID;
    } catch (e) {
      return { ok: false, code: 'TRANSFER_UNKNOWN', debitReceiptID };
    }

    const fill = { askID: ask.askID, typeID: ask.typeID, quantity: ask.quantity };
    records.set(operationID, { askID: ask.askID, totalCents, fill, debitReceiptID, transferReceiptID });

    return { ok: true, code: 'PURCHASED', fill, totalCents, debitReceiptID, transferReceiptID };
  }

  return { purchase };
}

module.exports = { createBuyer, PURCHASE_CODE };
