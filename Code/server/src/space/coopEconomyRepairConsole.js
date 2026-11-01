'use strict';

var SAFE_CHOICES = ["RECONCILE", "QUARANTINE", "RETRY_AFTER_READBACK"];
var CONSOLE_CODE = "REPAIR_CONSOLE";

function hasReceipt(journal) {
  return Array.isArray(journal) &&
    journal.length > 0 &&
    journal.some(function (entry) {
      return entry && entry.receiptID;
    });
}

function view(params) {
  var operation = params && params.operation;
  var journal = params && params.journal;
  if (!operation || !Array.isArray(journal) || journal.length === 0 || !hasReceipt(journal)) {
    return { ok: false, code: "UNKNOWN_JOURNAL", healthy: false };
  }
  return {
    ok: true,
    code: "VIEW",
    healthy: operation.state === "COMPLETED",
    blocked: operation.state !== "COMPLETED",
    receipts: journal.map(function (entry) {
      return { step: entry.step, receiptID: entry.receiptID };
    }),
    choices: SAFE_CHOICES
  };
}

function act(params) {
  var choice = params && params.choice;
  var operationID = params && params.operationID;
  var evidence = params && params.evidence;
  if (SAFE_CHOICES.indexOf(choice) === -1) {
    return { ok: false, code: "UNSAFE_CHOICE" };
  }
  if ((choice === "RECONCILE" || choice === "RETRY_AFTER_READBACK") &&
      !(typeof evidence === "string" && evidence.length > 0)) {
    return { ok: false, code: "EVIDENCE_REQUIRED" };
  }
  return { ok: true, code: "ACCEPTED", choice: choice, operationID: operationID };
}

function isHealthy(params) {
  var journal = params && params.journal;
  return hasReceipt(journal);
}

module.exports = {
  view: view,
  act: act,
  isHealthy: isHealthy,
  SAFE_CHOICES: SAFE_CHOICES,
  CONSOLE_CODE: CONSOLE_CODE
};
