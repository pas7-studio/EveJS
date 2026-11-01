'use strict';

const REFINERY_CODE = {
  REFINED: 'REFINED',
  INVALID_QUOTE: 'INVALID_QUOTE',
  FACILITY_MISMATCH: 'FACILITY_MISMATCH',
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

  return {
    ok: true,
    code: REFINERY_CODE.REFINED,
    output: { typeID: quote.outputTypeID, quantity: quote.outputQuantity },
    feeCents: feeCents,
    debitReceiptID: debitReceiptID,
  };
}

module.exports = { runRefinery, REFINERY_CODE };