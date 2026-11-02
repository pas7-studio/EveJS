'use strict';

/**
 * Classify the outcome of a cooperative-economy write attempt.
 *
 * A "valid receipt" is an object that carries a non-empty string receiptID,
 * which proves that a commit was attempted.
 *
 * UNKNOWN is never treated as failure and never authorises a retry: the
 * caller must reconcile before doing anything else.
 */
function isValidReceipt(receipt) {
  return (
    !!receipt &&
    typeof receipt === 'object' &&
    typeof receipt.receiptID === 'string' &&
    receipt.receiptID.length > 0
  );
}

function classifyOutcome({ threw, errorCode, receipt, readBack } = {}) {
  // 1. Valid receipt, no read-back -> the commit is confirmed.
  if (isValidReceipt(receipt) && readBack === undefined) {
    return { outcome: 'COMMITTED', code: 'OK', receiptID: receipt.receiptID };
  }

  // 2. Valid receipt and read-back echoes the same receiptID -> COMMITTED.
  if (isValidReceipt(receipt) && readBack && typeof readBack === 'object') {
    if (readBack.receiptID === receipt.receiptID) {
      return { outcome: 'COMMITTED', code: 'OK', receiptID: receipt.receiptID };
    }
    // 3. Valid receipt but read-back shows a different receiptID -> UNKNOWN.
    return { outcome: 'UNKNOWN', code: 'RECEIPT_MISMATCH' };
  }

  // 4. No receipt, threw, and a pre-write refusal reason -> NOT_STARTED.
  if (!isValidReceipt(receipt) && threw === true &&
      ['REFUSED', 'INVALID', 'NOT_STARTED'].indexOf(errorCode) !== -1) {
    return { outcome: 'NOT_STARTED', code: 'PRE_WRITE_REFUSAL' };
  }

  // 5. No receipt, threw, and any other reason -> ACK_LOST.
  if (!isValidReceipt(receipt) && threw === true) {
    return { outcome: 'UNKNOWN', code: 'ACK_LOST' };
  }

  // 6. No receipt and no throw -> NOT_STARTED.
  return { outcome: 'NOT_STARTED', code: 'NO_RECEIPT' };
}

module.exports = { classifyOutcome };
