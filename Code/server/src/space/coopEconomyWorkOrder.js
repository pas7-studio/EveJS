"use strict";

const STATES = {
  NEED_IDENTIFIED: "NEED_IDENTIFIED",
  PLANNED: "PLANNED",
  RESERVED: "RESERVED",
  EXECUTING: "EXECUTING",
  VERIFYING: "VERIFYING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  BLOCKED: "BLOCKED",
  OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
  RECONCILIATION_REQUIRED: "RECONCILIATION_REQUIRED",
};

const ALLOWED = {
  NEED_IDENTIFIED: ["PLANNED", "CANCELLED", "BLOCKED"],
  PLANNED: ["RESERVED", "CANCELLED", "BLOCKED"],
  RESERVED: ["EXECUTING", "CANCELLED", "BLOCKED"],
  EXECUTING: ["VERIFYING", "OUTCOME_UNKNOWN", "BLOCKED"],
  VERIFYING: ["COMPLETED", "OUTCOME_UNKNOWN", "RECONCILIATION_REQUIRED"],
  OUTCOME_UNKNOWN: ["RECONCILIATION_REQUIRED", "COMPLETED", "BLOCKED"],
  RECONCILIATION_REQUIRED: ["COMPLETED", "BLOCKED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
  BLOCKED: [],
};

function validateWorkOrder(wo) {
  const errors = new Set();

  if (typeof wo.operationID !== "string" || wo.operationID.length === 0) {
    errors.add("MISSING_OPERATION_ID");
  }

  if (!Object.prototype.hasOwnProperty.call(STATES, wo.phase)) {
    errors.add("UNKNOWN_PHASE");
  }

  if (!Number.isSafeInteger(wo.quantity) || wo.quantity <= 0) {
    errors.add("NEGATIVE_QUANTITY");
  }

  if (typeof wo.corpID !== "string" || wo.corpID.length === 0) {
    errors.add("MISSING_CORP");
  }

  if (
    !Array.isArray(wo.resourceKeys) ||
    wo.resourceKeys.length === 0 ||
    !wo.resourceKeys.every((k) => typeof k === "string")
  ) {
    errors.add("MISSING_RESOURCE_KEY");
  }

  return { ok: errors.size === 0, errors: Array.from(errors).sort() };
}

function canTransition(from, to) {
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, from)) {
    return false;
  }
  return ALLOWED[from].indexOf(to) !== -1;
}

function transition(wo, to) {
  const from = wo.phase;
  if (!canTransition(from, to)) {
    throw new TypeError("illegal transition: " + from + "->" + to);
  }
  return Object.freeze({ ...wo, phase: to, updatedAt: wo.updatedAt });
}

module.exports = { STATES, ALLOWED, validateWorkOrder, canTransition, transition };
