'use strict';

// Settlement lifecycle state values stored per fillID in the private map.
const STATE_SETTLED = 'SETTLED';
const STATE_UNKNOWN = 'UNKNOWN';

// SETTLEMENT_CODE: reference table describing every settlement outcome code.
const SETTLEMENT_CODE = {
    SETTLED: 'SETTLED',
    ALREADY_SETTLED: 'ALREADY_SETTLED',
    SETTLEMENT_UNKNOWN: 'SETTLEMENT_UNKNOWN',
    INVALID_SETTLEMENT: 'INVALID_SETTLEMENT',
    NATIVE_AUTHORITY_UNAVAILABLE: 'NATIVE_AUTHORITY_UNAVAILABLE',
};

function createSettlement(options) {
  const journal = options && options.journal;
    // Private map keyed by fillID -> { state, netCents, creditReceiptID }.
    const ledger = new Map();
  // every state change goes through put(), which mirrors it into the durable journal when one is
  // supplied; every lookup consults the journal first, so a restart cannot forget a settled fill
  const put = (id, entry) => {
    ledger.set(id, entry);
    if (journal && typeof journal.set === "function") journal.set(id, entry);
  };

    function isNonEmptyString(v) {
        return typeof v === 'string' && v.length > 0;
    }

    function isNonNegativeSafeInteger(v) {
        return typeof v === 'number'
            && Number.isInteger(v)
            && Number.isSafeInteger(v)
            && v >= 0;
    }

    function settle(input) {
        const { fillID, ownerCorpID, grossCents, taxCents, feeCents, walletPort } = input || {};

        // 1. Validate identifiers and cent fields.
        if (!isNonEmptyString(fillID)
            || !isNonEmptyString(ownerCorpID)
            || !isNonNegativeSafeInteger(grossCents)
            || !isNonNegativeSafeInteger(taxCents)
            || !isNonNegativeSafeInteger(feeCents)) {
            return { ok: false, code: 'INVALID_SETTLEMENT' };
        }

        // 2. Replay check: a durable record wins over the in-memory ledger.
        // A journal that cannot be read is not an empty journal: refuse instead of paying again.
        let existing;
        try {
            existing = (journal && typeof journal.get === "function" && journal.get(fillID)) || ledger.get(fillID);
        } catch (err) {
            return { ok: false, code: 'JOURNAL_UNREADABLE' };
        }
        if (existing && existing.state === STATE_SETTLED) {
            return { ok: true, code: 'ALREADY_SETTLED', netCents: existing.netCents };
        }

        // 3. Previously marked UNKNOWN -> no retry, no credit.
        if (existing && existing.state === STATE_UNKNOWN) {
            return { ok: false, code: 'SETTLEMENT_UNKNOWN' };
        }

        // 4. net = gross - tax - fee must be non-negative.
        const netCents = grossCents - taxCents - feeCents;
        if (netCents < 0) {
            return { ok: false, code: 'INVALID_SETTLEMENT' };
        }

        // 5. Native authority must expose a credit function.
        if (typeof walletPort !== 'object' || walletPort === null || typeof walletPort.credit !== 'function') {
            return { ok: false, code: 'NATIVE_AUTHORITY_UNAVAILABLE' };
        }

        // 6. If the journal already holds PENDING for this fill, an earlier attempt may have paid
        //    already; return without calling the wallet port to avoid paying twice.
        if (existing && existing.state === 'PENDING') {
            return { ok: false, code: 'SETTLEMENT_UNKNOWN' };
        }

        // 7. Write-ahead: persist the PENDING intent BEFORE any money moves. If this write throws,
        //    the durable record of the payment does not exist, so no money moved and we never credit.
        try {
            put(fillID, { state: 'PENDING', netCents, creditReceiptID: null });
        } catch (err) {
            return { ok: false, code: 'JOURNAL_WRITE_FAILED' };
        }

        // 8. Credit exactly once.
        let creditReceiptID;
        try {
            const receipt = walletPort.credit({ corpID: ownerCorpID, cents: netCents, fillID });
            creditReceiptID = receipt && receipt.receiptID;
        } catch (err) {
            put(fillID, { state: STATE_UNKNOWN, netCents, creditReceiptID: null });
            return { ok: false, code: 'SETTLEMENT_UNKNOWN' };
        }

        if (!creditReceiptID) {
            put(fillID, { state: STATE_UNKNOWN, netCents, creditReceiptID: null });
            return { ok: false, code: 'SETTLEMENT_UNKNOWN' };
        }

        // 9. Success -> write the durable outcome. If this write throws, the payment is real but its
        //    durable record is missing, so never report ok:true; return the receipt for reconciliation.
        try {
            put(fillID, { state: STATE_SETTLED, netCents, creditReceiptID });
        } catch (err) {
            return { ok: false, code: 'JOURNAL_WRITE_FAILED', fillID, creditReceiptID };
        }

        return { ok: true, code: 'SETTLED', fillID, netCents, creditReceiptID };
    }

    return { settle };
}

module.exports = { createSettlement, SETTLEMENT_CODE };
