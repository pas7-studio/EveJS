'use strict';

var RECEIPT_ERROR = {
  DUPLICATE: 'DUPLICATE',
  CONFLICT: 'CONFLICT',
  INVALID: 'INVALID'
};

function isValidReceipt(receipt) {
  if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) {
    return false;
  }

  var required = ['id', 'typeID', 'stationID', 'kind'];
  for (var i = 0; i < required.length; i++) {
    var field = required[i];
    if (typeof receipt[field] !== 'string' || receipt[field].length === 0) {
      return false;
    }
  }

  if (typeof receipt.quantity !== 'number' || !Number.isSafeInteger(receipt.quantity) || receipt.quantity <= 0) {
    return false;
  }

  return true;
}

function dedupeReceipts(receipts) {
  var unique = [];
  var duplicates = [];
  var conflicting = [];
  var invalid = [];

  var seen = {};

  for (var i = 0; i < receipts.length; i++) {
    var receipt = receipts[i];

    if (!isValidReceipt(receipt)) {
      invalid.push(i);
      continue;
    }

    var id = receipt.id;

    if (!Object.prototype.hasOwnProperty.call(seen, id)) {
      seen[id] = {
        typeID: receipt.typeID,
        stationID: receipt.stationID,
        kind: receipt.kind,
        quantity: receipt.quantity
      };
      unique.push(receipt);
      continue;
    }

    var first = seen[id];
    var isDuplicate =
      receipt.typeID === first.typeID &&
      receipt.stationID === first.stationID &&
      receipt.kind === first.kind &&
      receipt.quantity === first.quantity;

    duplicates.push({
      id: id,
      error: isDuplicate ? RECEIPT_ERROR.DUPLICATE : RECEIPT_ERROR.CONFLICT,
      index: i
    });

    if (!isDuplicate) {
      conflicting.push(id);
    }
  }

  return {
    unique: unique,
    duplicates: duplicates,
    conflicting: conflicting,
    invalid: invalid
  };
}

module.exports = {
  dedupeReceipts: dedupeReceipts,
  RECEIPT_ERROR: RECEIPT_ERROR
};
