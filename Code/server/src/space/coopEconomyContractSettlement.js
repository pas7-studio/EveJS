'use strict';
const { createJournal } = require("./coopEconomyJournal");

/**
 * A non-negative safe integer is a finite number within the safe integer
 * range that is greater than or equal to zero.
 */
function isNonNegativeSafeInteger(n) {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Creates a contract settlement ledger. Each contractID maps to a private
 * entry { state, netCents }. The map is kept private via closure so callers
 * cannot tamper with settlement state.
 */
function createContractSettlement(options) {
  // a paid contract must not be paid again after a restart
  const ledger = createJournal(options && options.journal);

  function settle(input) {
    const {
      contractID,
      playerID,
      deliveredQuantity,
      contractQuantity,
      unitPriceCents,
      feeCents,
      capCents,
      walletPort,
    } = input || {};

    // 1. Validate identifiers are non-empty and every number is a
    //    non-negative safe integer; the contract must have a positive
    //    quantity * price so a settlement is meaningful.
    if (
      typeof contractID !== 'string' || contractID.length === 0 ||
      typeof playerID !== 'string' || playerID.length === 0 ||
      !isNonNegativeSafeInteger(deliveredQuantity) ||
      !isNonNegativeSafeInteger(contractQuantity) ||
      !isNonNegativeSafeInteger(unitPriceCents) ||
      !isNonNegativeSafeInteger(feeCents) ||
      !isNonNegativeSafeInteger(capCents) ||
      !(contractQuantity + unitPriceCents > 0)
    ) {
      return { ok: false, code: 'INVALID_SETTLEMENT' };
    }

    // 2. Already settled -> an ACK lost replay cannot pay twice.
    const entry = ledger.get(contractID);
    if (entry && entry.state === 'SETTLED') {
      return { ok: true, code: 'ALREADY_SETTLED', netCents: entry.netCents };
    }

    // 3. Unknown -> sticky, no retry.
    if (entry && entry.state === 'UNKNOWN') {
      return { ok: false, code: 'SETTLEMENT_UNKNOWN' };
    }

    // 4. Compute the payout. Only the delivered portion of the contract is
    //    honoured; fees are subtracted but never below zero, and the payout
    //    is capped by the funded liability.
    const paidQuantity = Math.min(deliveredQuantity, contractQuantity);
    const gross = paidQuantity * unitPriceCents;
    let net = Math.max(gross - feeCents, 0);
    net = Math.min(net, capCents);
    const refundCents = (contractQuantity - paidQuantity) * unitPriceCents;

    // 5. The native authority must expose a callable credit function.
    if (typeof walletPort !== 'object' || typeof walletPort.credit !== 'function') {
      return { ok: false, code: 'NATIVE_AUTHORITY_UNAVAILABLE' };
    }

    // 6. Call credit exactly once. A throw or a missing receiptID means the
    //    settlement failed and must be retried, so it is marked UNKNOWN.
    let creditReceiptID;
    try {
      const receipt = walletPort.credit({ playerID, cents: net, contractID });
      creditReceiptID = receipt && receipt.receiptID;
    } catch (err) {
      ledger.set(contractID, { state: 'UNKNOWN', netCents: net });
      return { ok: false, code: 'SETTLEMENT_UNKNOWN' };
    }

    if (creditReceiptID == null) {
      ledger.set(contractID, { state: 'UNKNOWN', netCents: net });
      return { ok: false, code: 'SETTLEMENT_UNKNOWN' };
    }

    // 7. Success -> mark SETTLED and return the full receipt.
    ledger.set(contractID, { state: 'SETTLED', netCents: net });
    return {
      ok: true,
      code: 'SETTLED',
      netCents: net,
      refundCents: refundCents,
      paidQuantity: paidQuantity,
      creditReceiptID: creditReceiptID,
    };
  }

  return { settle };
}

const CONTRACT_SETTLE_CODE = 'SETTLED';

module.exports = {
  createContractSettlement,
  CONTRACT_SETTLE_CODE,
};
