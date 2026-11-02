'use strict';
const { createJournal } = require("./coopEconomyJournal");

// IE-046: one persistent distribution run, attached to the existing PLAN -> LOAD -> CROSS -> SELL stages.
// The run is keyed by runID and holds the real hull and cargo identity, so a restart or a crash reattaches
// to the same hull instead of cloning it. Transport itself is never reimplemented here: the caller advances
// stages with the receipt of the native gate crossing or the native sale.

const RUN_CODE = {
  STARTED: 'STARTED',
  ALREADY_STARTED: 'ALREADY_STARTED',
  ADVANCED: 'ADVANCED',
  INVALID_RUN: 'INVALID_RUN',
  UNKNOWN_RUN: 'UNKNOWN_RUN',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  RECEIPT_REQUIRED: 'RECEIPT_REQUIRED',
};

const STAGES = ['PLAN', 'LOAD', 'CROSS', 'SELL', 'DONE'];
const NEXT = new Map([
  ['PLAN', 'LOAD'],
  ['LOAD', 'CROSS'],
  ['CROSS', 'SELL'],
  ['SELL', 'DONE'],
]);
// these moves change physical custody or location, so they need a native receipt
const NEEDS_RECEIPT = new Set(['CROSS', 'SELL', 'DONE']);

function isID(value) {
  return typeof value === 'string' && value.length > 0;
}

function createDistributor(options) {
  // an in-flight run must survive a restart, or the hull is free while the cargo is gone
  const runs = createJournal(options && options.journal);

  function start(args) {
    const { runID, hullID, cargoID, quantity } = args || {};
    if (
      !isID(runID) ||
      !isID(hullID) ||
      !isID(cargoID) ||
      !Number.isSafeInteger(quantity) ||
      quantity <= 0
    ) {
      return { ok: false, code: RUN_CODE.INVALID_RUN };
    }
    const existing = runs.get(runID);
    if (existing) {
      return { ok: true, code: RUN_CODE.ALREADY_STARTED, stage: existing.stage, hullID: existing.hullID };
    }
    runs.set(runID, { runID, hullID, cargoID, quantity, stage: 'PLAN', receipts: [] });
    return { ok: true, code: RUN_CODE.STARTED, stage: 'PLAN', hullID };
  }

  function advance(args) {
    const { runID, to, receiptID } = args || {};
    const run = runs.get(runID);
    if (!run) return { ok: false, code: RUN_CODE.UNKNOWN_RUN };
    if (NEXT.get(run.stage) !== to) {
      return { ok: false, code: RUN_CODE.INVALID_TRANSITION, stage: run.stage };
    }
    if (NEEDS_RECEIPT.has(to) && !isID(receiptID)) {
      return { ok: false, code: RUN_CODE.RECEIPT_REQUIRED, stage: run.stage };
    }
    run.stage = to;
    if (isID(receiptID)) run.receipts.push({ stage: to, receiptID });
    return { ok: true, code: RUN_CODE.ADVANCED, stage: to };
  }

  function snapshot(runID) {
    const run = runs.get(runID);
    return run ? { ...run, receipts: run.receipts.map((r) => ({ ...r })) } : null;
  }

  function resume(runID) {
    const run = runs.get(runID);
    if (!run) return { ok: false, code: RUN_CODE.UNKNOWN_RUN };
    return { ok: true, code: RUN_CODE.ALREADY_STARTED, stage: run.stage, hullID: run.hullID, cargoID: run.cargoID, quantity: run.quantity };
  }

  return { start, advance, snapshot, resume, STAGES };
}

module.exports = { createDistributor, RUN_CODE, RUN_STAGES: STAGES };
