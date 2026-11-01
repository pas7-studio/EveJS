'use strict';

/**
 * Output delivery controller.
 *
 * Tracks, per jobID, the single item that has been issued for a job.
 * Exactly one product is ever issued per job.
 */

var DELIVERY_CODE = {
  INVALID_JOB: 'INVALID_JOB',
  ALREADY_DELIVERED: 'ALREADY_DELIVERED',
  NOT_READY: 'NOT_READY',
  NATIVE_AUTHORITY_UNAVAILABLE: 'NATIVE_AUTHORITY_UNAVAILABLE',
  ISSUE_UNKNOWN: 'ISSUE_UNKNOWN',
  DELIVERED: 'DELIVERED'
};

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function createOutputDelivery() {
  var delivered = Object.create(null);

  function deliver(input) {
    var job = input && input.job;
    var readback = input && input.readback;
    var itemStore = input && input.itemStore;

    // 1. Validate the job contract.
    if (!job || !isNonEmptyString(job.jobID) || !isPositiveSafeInteger(job.quantity)) {
      return { ok: false, code: DELIVERY_CODE.INVALID_JOB };
    }

    var jobID = job.jobID;

    // 2. Exactly one product is ever issued per job.
    if (delivered[jobID]) {
      return { ok: true, code: DELIVERY_CODE.ALREADY_DELIVERED, itemID: delivered[jobID].itemID };
    }

    // 3. Readback readiness is the only evidence of readiness, and it must be this job's readback:
    //    a completed readback for another job says nothing about this one.
    if (readback && readback.jobID !== undefined && readback.jobID !== jobID) {
      return { ok: false, code: DELIVERY_CODE.NOT_READY };
    }
    if (readback && readback.completed === true && readback.readyAt !== undefined && readback.readyAt !== null) {
      // fall through to issue
    } else {
      return { ok: false, code: DELIVERY_CODE.NOT_READY };
    }

    // 4. The native authority must be callable.
    if (typeof itemStore.issue !== 'function') {
      return { ok: false, code: DELIVERY_CODE.NATIVE_AUTHORITY_UNAVAILABLE };
    }

    // 5. Issue exactly once.
    var issueResult;
    try {
      issueResult = itemStore.issue({
        jobID: jobID,
        typeID: job.productTypeID,
        quantity: job.quantity
      });
    } catch (err) {
      return { ok: false, code: DELIVERY_CODE.ISSUE_UNKNOWN };
    }

    var itemID = issueResult && issueResult.itemID;
    if (!isNonEmptyString(itemID)) {
      return { ok: false, code: DELIVERY_CODE.ISSUE_UNKNOWN };
    }

    // 6. Record and report success.
    delivered[jobID] = { itemID: itemID, quantity: job.quantity };
    return {
      ok: true,
      code: DELIVERY_CODE.DELIVERED,
      itemID: itemID,
      typeID: job.productTypeID,
      quantity: job.quantity
    };
  }

  return { deliver: deliver };
}

module.exports = {
  createOutputDelivery: createOutputDelivery,
  DELIVERY_CODE: DELIVERY_CODE
};
