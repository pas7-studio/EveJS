'use strict';
const { createJournal } = require("./coopEconomyJournal");

var FUNDS_STATUS = {
  QUOTED: 'QUOTED',
  FUNDED: 'FUNDED',
  REFUSED: 'REFUSED',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS'
};

function isPositiveSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isValidOperationID(operationID) {
  return typeof operationID === 'string' && operationID.length > 0;
}

function createGateway(options) {
  // a replay after a restart must still see this record: pass {journal} to persist it
  var store = createJournal(options && options.journal);

  function commit(params) {
    var operationID = params && params.operationID;
    var cents = params && params.cents;
    var walletCents = params && params.walletCents;
    var escrowProof = params && params.escrowProof;

    if (!isValidOperationID(operationID) || !isPositiveSafeInteger(cents)) {
      return { ok: false, status: FUNDS_STATUS.REFUSED, reason: 'INVALID_COMMIT' };
    }

    if (store.has(operationID)) {
      return { ok: true, status: store.get(operationID).status, duplicate: true };
    }

    var recordedTotal = 0;
    store.forEach(function (entry) {
      recordedTotal += entry.cents;
    });

    if (recordedTotal + cents > walletCents) {
      return { ok: false, status: FUNDS_STATUS.INSUFFICIENT_FUNDS };
    }

    var status = escrowProof === true ? FUNDS_STATUS.FUNDED : FUNDS_STATUS.QUOTED;

    store.set(operationID, { cents: cents, status: status });

    return { ok: true, status: status, duplicate: false };
  }

  function committedCents() {
    var total = 0;
    store.forEach(function (entry) {
      total += entry.cents;
    });
    return total;
  }

  function fundedCents() {
    var total = 0;
    store.forEach(function (entry) {
      if (entry.status === FUNDS_STATUS.FUNDED) {
        total += entry.cents;
      }
    });
    return total;
  }

  function release(operationID) {
    return store.delete(operationID);
  }

  function statusOf(operationID) {
    if (!store.has(operationID)) {
      return null;
    }
    return store.get(operationID).status;
  }

  return {
    commit: commit,
    committedCents: committedCents,
    fundedCents: fundedCents,
    release: release,
    statusOf: statusOf
  };
}

module.exports = {
  createGateway: createGateway,
  FUNDS_STATUS: FUNDS_STATUS
};
