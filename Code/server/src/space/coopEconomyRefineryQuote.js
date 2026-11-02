'use strict';

const REFINERY_CODE = {
  REFINED: 'REFINED',
  INVALID_QUOTE: 'INVALID_QUOTE',
  FACILITY_MISMATCH: 'FACILITY_MISMATCH',
  ALREADY_REFINED: 'ALREADY_REFINED',
  FEE_PAYMENT_UNSUPPORTED: 'FEE_PAYMENT_UNSUPPORTED',
  INPUT_SHORT: 'INPUT_SHORT',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  FEE_OUTCOME_UNKNOWN: 'FEE_OUTCOME_UNKNOWN',
};

function fail(code) {
  return { ok: false, code: code };
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isPositiveInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function isNonNegativeInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

// IE-030: a refinery run debits the real input and pays a real fee, or it does nothing at all.
// The fee path is the dangerous one: a fee that cannot be paid natively must block the run instead of
// producing output "on credit".
// The fee is money: a retry of the same operation must not debit again. The key is the operation
// identity AND the request itself, because a call without an operationID has no retry identity at
// all and a caller that reuses an id for a different request is making a new request, not a retry.
let REFINED = new Map();
const MAX_REFINED = 1000;
function refinedKey(operationID, quote, inputs, walletCents) {
  if (typeof operationID !== "string" || operationID.length === 0) return null;
  let body;
  try {
    body = JSON.stringify([quote, inputs, walletCents]);
  } catch (error) {
    return null;
  }
  return operationID + "|" + body;
}
function rememberRefined(key, value) {
  if (key === null) return;
  REFINED.set(key, value);
  if (REFINED.size > MAX_REFINED) REFINED.delete(REFINED.keys().next().value);
}

function runRefinery(args) {
  const { operationID, quote, inputs, walletCents, facility, paymentPort } = args || {};

  if (
    !quote ||
    !isNonEmptyString(quote.inputTypeID) ||
    !isNonEmptyString(quote.outputTypeID) ||
    !isNonEmptyString(quote.facilityID) ||
    !isPositiveInt(quote.inputQuantity) ||
    !isPositiveInt(quote.outputQuantity) ||
    !isNonNegativeInt(quote.feeCents)
  ) {
    return fail(REFINERY_CODE.INVALID_QUOTE);
  }
  if (!facility || facility.facilityID !== quote.facilityID) {
    return fail(REFINERY_CODE.FACILITY_MISMATCH);
  }
  const feeCents = quote.feeCents;
  // A completed operation is never charged twice; the retry reports the first outcome.
  const refinedKeyValue = refinedKey(operationID, quote, inputs, walletCents);
  const already = refinedKeyValue === null ? null : REFINED.get(refinedKeyValue);
  // A retry goes through the SAME payment authority. A different port is a different request even
  // when it reuses the operation id, so it must not inherit the earlier outcome.
  if (already && already.port === paymentPort) {
    return { ok: true, code: REFINERY_CODE.ALREADY_REFINED, output: already.result.output,
      feeCents: already.result.feeCents, debitReceiptID: already.result.debitReceiptID };
  }

  const debit = paymentPort && paymentPort.debit;
  if (feeCents > 0 && (facility.supportsFeePayment !== true || typeof debit !== 'function')) {
    return fail(REFINERY_CODE.FEE_PAYMENT_UNSUPPORTED);
  }

  let have = 0;
  for (const entry of Array.isArray(inputs) ? inputs : []) {
    if (entry && entry.typeID === quote.inputTypeID && isPositiveInt(entry.quantity)) {
      have += entry.quantity;
    }
  }
  if (have < quote.inputQuantity) return fail(REFINERY_CODE.INPUT_SHORT);

  const wallet = isNonNegativeInt(walletCents) ? walletCents : 0;
  if (feeCents > wallet) return fail(REFINERY_CODE.INSUFFICIENT_FUNDS);

  let debitReceiptID = null;
  if (feeCents > 0) {
    let receipt;
    try {
      receipt = debit({ operationID, cents: feeCents });
    } catch (e) {
      return fail(REFINERY_CODE.FEE_OUTCOME_UNKNOWN);
    }
    if (!receipt || !isNonEmptyString(receipt.receiptID)) {
      return fail(REFINERY_CODE.FEE_OUTCOME_UNKNOWN);
    }
    debitReceiptID = receipt.receiptID;
  }

  const result = {
    ok: true,
    code: REFINERY_CODE.REFINED,
    output: { typeID: quote.outputTypeID, quantity: quote.outputQuantity },
    feeCents: feeCents,
    debitReceiptID: debitReceiptID,
  };
  rememberRefined(refinedKeyValue, { port: paymentPort, result });
  return result;
}

// Attach a durable journal {get,set,has?,delete?,entries?} so the module's records survive a
// restart. Called once at boot by the host; without it the behaviour is unchanged.
function useJournal(journal) {
  const next = require("./coopEconomyJournal").createJournal(journal);
  for (const entry of REFINED) next.set(entry[0], entry[1]);
  REFINED = next;
  return REFINED.durable !== null;
}

module.exports = { runRefinery, REFINERY_CODE, useJournal };