'use strict';

var PNL_CODE = 'OK';

var VALID_KINDS = ['SALE', 'PURCHASE', 'PRODUCTION', 'WAREHOUSE_MOVE'];

function isNonNegSafeInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function isPosSafeInt(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function computePnl(input) {
  var transactions = input && input.transactions;
  var stock = input && input.stock;

  if (!Array.isArray(transactions)) {
    return { ok: false, code: 'INVALID_TRANSACTION' };
  }
  if (!Array.isArray(stock)) {
    return { ok: false, code: 'INVALID_TRANSACTION' };
  }

  var revenueCents = 0;
  var costOfGoodsCents = 0;
  var committedCents = 0;

  for (var i = 0; i < transactions.length; i++) {
    var t = transactions[i];
    if (!t || typeof t !== 'object') {
      return { ok: false, code: 'INVALID_TRANSACTION' };
    }

    var kind = t.kind;
    if (typeof kind !== 'string' || VALID_KINDS.indexOf(kind) === -1) {
      return { ok: false, code: 'INVALID_TRANSACTION' };
    }

    if (!isNonNegSafeInt(t.cents) || !isNonNegSafeInt(t.costCents)) {
      return { ok: false, code: 'INVALID_TRANSACTION' };
    }

    switch (kind) {
      case 'SALE':
        revenueCents += t.cents;
        costOfGoodsCents += t.costCents;
        break;
      case 'PURCHASE':
      case 'PRODUCTION':
        committedCents += t.cents;
        break;
      case 'WAREHOUSE_MOVE':
        // custody change only: no effect on revenue, cost, committed or realized
        break;
    }
  }

  var stockValueCents = 0;
  for (var j = 0; j < stock.length; j++) {
    var s = stock[j];
    if (!s || typeof s !== 'object') {
      return { ok: false, code: 'INVALID_TRANSACTION' };
    }
    if (!isPosSafeInt(s.quantity) || !isPosSafeInt(s.unitCostCents)) {
      return { ok: false, code: 'INVALID_TRANSACTION' };
    }
    stockValueCents += s.quantity * s.unitCostCents;
  }

  var realizedCents = revenueCents - costOfGoodsCents;
  var cashCents = revenueCents - committedCents;
  var reconciled =
    (revenueCents - committedCents === cashCents) &&
    (realizedCents + costOfGoodsCents === revenueCents);

  return {
    ok: true,
    code: PNL_CODE,
    revenueCents: revenueCents,
    costOfGoodsCents: costOfGoodsCents,
    committedCents: committedCents,
    realizedCents: realizedCents,
    stockValueCents: stockValueCents,
    cashCents: cashCents,
    reconciled: reconciled
  };
}

module.exports = { computePnl: computePnl, PNL_CODE: PNL_CODE };
