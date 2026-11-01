'use strict';

// IE-036: the first full closed loop, expressed as one pure composition over injected native ports.
// Mine -> haul custody -> station arrival -> refine -> job admission -> output delivery -> fleet resupply
// -> real consumption -> new shortage. Nothing here invents state: every step must return a native
// receipt id, and a port flagged manual/mock, or a receipt without an id, ends the loop as NOT_LIVE_PROOF.

const Mining = require('./coopEconomyMiningDispatch');
const Custody = require('./coopEconomyOreCustody');
const Stock = require('./coopEconomyStationStockProof');
const Refinery = require('./coopEconomyRefineryQuote');
const Admission = require('./coopEconomyJobAdmission');
const Delivery = require('./coopEconomyOutputDelivery');
const Resupply = require('./coopEconomyFleetResupply');
const Feedback = require('./coopEconomyConsumptionFeedback');

const LOOP_CODE = {
  LOOP_CLOSED: 'LOOP_CLOSED',
  NOT_LIVE_PROOF: 'NOT_LIVE_PROOF',
  INVALID_DEMAND: 'INVALID_DEMAND',
  CONSERVATION_VIOLATION: 'CONSERVATION_VIOLATION',
  SHORTAGE_UNRESOLVED: 'SHORTAGE_UNRESOLVED',
  STEP_FAILED: 'STEP_FAILED',
};

const REQUIRED_PORTS = ['mining', 'warehouse', 'payment', 'install', 'itemStore', 'equipment', 'consumption'];

function isPortLive(port) {
  return !!port && port.manual !== true && port.mock !== true && port.simulated !== true;
}

function receiptOf(value) {
  return value && typeof value.receiptID === 'string' && value.receiptID.length > 0 ? value.receiptID : null;
}

function runClosedLoop({ demand, ports } = {}) {
  const d = demand || {};
  const required = ['oreTypeID', 'materialTypeID', 'productTypeID', 'stationID', 'hullID', 'blueprintID'];
  for (const key of required) {
    if (typeof d[key] !== 'string' || d[key].length === 0) {
      return { ok: false, code: LOOP_CODE.INVALID_DEMAND, reason: 'missing ' + key };
    }
  }
  for (const key of ['oreQuantity', 'materialQuantity', 'productQuantity', 'runs', 'feeCents', 'walletCents']) {
    if (!Number.isSafeInteger(d[key]) || d[key] < 0) {
      return { ok: false, code: LOOP_CODE.INVALID_DEMAND, reason: 'missing ' + key };
    }
  }
  if (d.oreQuantity === 0 || d.materialQuantity === 0 || d.productQuantity === 0 || d.runs === 0) {
    return { ok: false, code: LOOP_CODE.INVALID_DEMAND, reason: 'zero quantity' };
  }

  const p = ports || {};
  for (const name of REQUIRED_PORTS) {
    if (!isPortLive(p[name])) {
      return { ok: false, code: LOOP_CODE.NOT_LIVE_PROOF, step: name, reason: 'port is manual, mock or missing' };
    }
  }

  const receipts = [];
  const ledger = new Map();
  const add = (typeID, delta) => {
    const next = (ledger.get(typeID) || 0) + delta;
    if (next < 0) return false;
    ledger.set(typeID, next);
    return true;
  };
  const snapshot = () => {
    const out = {};
    for (const [typeID, quantity] of [...ledger.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      out[typeID] = quantity;
    }
    return out;
  };

  // 1. mine the ore physically
  add(d.oreTypeID, d.oreQuantity);
  const mined = Mining.dispatchMining({
    need: { typeID: d.oreTypeID, quantity: d.oreQuantity },
    fleet: [{ hullID: d.hullID, systemID: d.stationID, capacity: d.oreQuantity, busy: false }],
    miningPort: p.mining,
  });
  if (!mined.ok) return { ok: false, code: LOOP_CODE.STEP_FAILED, step: 'mine', detail: mined };
  receipts.push({ step: 'mine', receiptID: mined.receiptID });

  // 2. custody moves from the miner to the hauler without changing the owner
  const custody = Custody.createCustody();
  const cargoID = 'cargo:' + mined.operationID;
  const loaded = custody.load({
    cargoID,
    ownerID: d.corpID || 'corp',
    holderID: d.hullID,
    typeID: d.oreTypeID,
    quantity: d.oreQuantity,
  });
  if (!loaded.ok) return { ok: false, code: LOOP_CODE.STEP_FAILED, step: 'custody', detail: loaded };
  const moved = custody.transfer({ cargoID, toHolderID: d.hullID });
  if (!moved.ok) return { ok: false, code: LOOP_CODE.STEP_FAILED, step: 'custody', detail: moved };

  // 3. the station receives the ore as a real warehouse item; the arrival receipt is the proof
  let received;
  try {
    received = p.warehouse.receive({
      stationID: d.stationID,
      typeID: d.oreTypeID,
      quantity: d.oreQuantity,
      deliveryID: cargoID,
    });
  } catch (error) {
    return { ok: false, code: LOOP_CODE.STEP_FAILED, step: 'warehouse', detail: String(error && error.message) };
  }
  const arrivalID = receiptOf(received);
  if (!arrivalID || typeof received.itemID !== 'string' || received.itemID.length === 0) {
    return { ok: false, code: LOOP_CODE.NOT_LIVE_PROOF, step: 'warehouse', reason: 'no arrival receipt or item' };
  }
  receipts.push({ step: 'warehouse', receiptID: arrivalID, itemID: received.itemID });

  const proof = Stock.proveStationStock({
    stationID: d.stationID,
    typeID: d.oreTypeID,
    quantity: d.oreQuantity,
    arrival: { receiptID: arrivalID },
    warehouseItems: [
      { stationID: d.stationID, typeID: d.oreTypeID, itemID: received.itemID, quantity: d.oreQuantity },
    ],
    depotStatus: received.depotStatus,
  });
  if (!proof.ok) return { ok: false, code: LOOP_CODE.STEP_FAILED, step: 'station-proof', detail: proof };

  // 4. refine: real input debit, real fee, exact output
  const refined = Refinery.runRefinery({
    operationID: 'refine:' + cargoID,
    quote: {
      inputTypeID: d.oreTypeID,
      inputQuantity: d.oreQuantity,
      outputTypeID: d.materialTypeID,
      outputQuantity: d.materialQuantity,
      facilityID: d.facilityID || d.stationID,
      feeCents: d.feeCents,
    },
    inputs: [{ typeID: d.oreTypeID, quantity: d.oreQuantity }],
    walletCents: d.walletCents,
    facility: {
      facilityID: d.facilityID || d.stationID,
      stationID: d.stationID,
      supportsFeePayment: d.feeCents > 0 ? true : false,
    },
    paymentPort: p.payment,
  });
  if (!refined.ok) return { ok: false, code: LOOP_CODE.STEP_FAILED, step: 'refine', detail: refined };
  receipts.push({ step: 'refine', receiptID: refined.debitReceiptID || 'fee-free' });
  if (!add(d.oreTypeID, -d.oreQuantity) || !add(d.materialTypeID, d.materialQuantity)) {
    return { ok: false, code: LOOP_CODE.CONSERVATION_VIOLATION, step: 'refine', ledger: snapshot() };
  }

  // 5. admit exactly one native job and debit its materials
  const admission = Admission.createJobAdmission();
  const admitted = admission.admit({
    operationID: 'job:' + cargoID,
    quote: {
      blueprintID: d.blueprintID,
      productTypeID: d.productTypeID,
      runs: d.runs,
      materialCostCents: d.materialCostCents || 0,
      needs: [{ typeID: d.materialTypeID, quantity: d.materialQuantity }],
    },
    materials: [{ typeID: d.materialTypeID, quantity: d.materialQuantity }],
    walletCents: d.walletCents,
    installPort: p.install,
  });
  if (!admitted.ok) return { ok: false, code: LOOP_CODE.STEP_FAILED, step: 'admit', detail: admitted };
  // a duplicate invocation must not create a second job
  const again = admission.admit({
    operationID: 'job:' + cargoID,
    quote: {
      blueprintID: d.blueprintID,
      productTypeID: d.productTypeID,
      runs: d.runs,
      materialCostCents: d.materialCostCents || 0,
      needs: [{ typeID: d.materialTypeID, quantity: d.materialQuantity }],
    },
    materials: [{ typeID: d.materialTypeID, quantity: d.materialQuantity }],
    walletCents: d.walletCents,
    installPort: p.install,
  });
  if (!again.ok || again.code !== 'ALREADY_ADMITTED' || again.jobID !== admitted.jobID) {
    return { ok: false, code: LOOP_CODE.STEP_FAILED, step: 'admit-duplicate', detail: again };
  }
  receipts.push({ step: 'admit', receiptID: admitted.jobID });
  if (!add(d.materialTypeID, -d.materialQuantity)) {
    return { ok: false, code: LOOP_CODE.CONSERVATION_VIOLATION, step: 'admit', ledger: snapshot() };
  }

  // 6. deliver exactly one product item once the original job is really ready
  const delivery = Delivery.createOutputDelivery();
  const delivered = delivery.deliver({
    job: {
      jobID: admitted.jobID,
      productTypeID: d.productTypeID,
      quantity: d.productQuantity,
      readyFlag: d.readyFlag === true,
    },
    readback: { jobID: admitted.jobID, completed: true, readyAt: d.readyAt || 1 },
    itemStore: p.itemStore,
  });
  if (!delivered.ok) return { ok: false, code: LOOP_CODE.STEP_FAILED, step: 'deliver', detail: delivered };
  const deliveredAgain = delivery.deliver({
    job: { jobID: admitted.jobID, productTypeID: d.productTypeID, quantity: d.productQuantity, readyFlag: true },
    readback: { jobID: admitted.jobID, completed: true, readyAt: d.readyAt || 1 },
    itemStore: p.itemStore,
  });
  if (!deliveredAgain.ok || deliveredAgain.code !== 'ALREADY_DELIVERED') {
    return { ok: false, code: LOOP_CODE.STEP_FAILED, step: 'deliver-duplicate', detail: deliveredAgain };
  }
  receipts.push({ step: 'deliver', receiptID: delivered.itemID });
  add(d.productTypeID, d.productQuantity);

  // 7. physical fleet resupply at the station where the hull really is
  const resupply = Resupply.createResupply();
  const issued = resupply.resupply({
    deliveryID: 'issue:' + admitted.jobID,
    item: { typeID: d.productTypeID, quantity: d.productQuantity, stationID: d.stationID },
    hull: { hullID: d.hullID, stationID: d.stationID, docked: true },
    warehouse: { stationID: d.stationID, quantity: d.productQuantity },
    equipmentPort: p.equipment,
  });
  if (!issued.ok) return { ok: false, code: LOOP_CODE.STEP_FAILED, step: 'resupply', detail: issued };
  const issuedAgain = resupply.resupply({
    deliveryID: 'issue:' + admitted.jobID,
    item: { typeID: d.productTypeID, quantity: d.productQuantity, stationID: d.stationID },
    hull: { hullID: d.hullID, stationID: d.stationID, docked: true },
    warehouse: { stationID: d.stationID, quantity: d.productQuantity },
    equipmentPort: p.equipment,
  });
  if (!issuedAgain.ok || issuedAgain.code !== 'ALREADY_ISSUED') {
    return { ok: false, code: LOOP_CODE.STEP_FAILED, step: 'resupply-duplicate', detail: issuedAgain };
  }
  receipts.push({ step: 'resupply', receiptID: issued.receiptID });
  // IE-036: the item still exists, it only changed holder - the waypoint ledger is global stock.
  if ((ledger.get(d.productTypeID) || 0) < d.productQuantity) {
    return { ok: false, code: LOOP_CODE.CONSERVATION_VIOLATION, step: 'resupply', ledger: snapshot() };
  }

  // 8. real consumption becomes the next demand signal, once per native evidence id
  let consumed;
  try {
    consumed = p.consumption.read({ hullID: d.hullID, typeID: d.productTypeID });
  } catch (error) {
    return { ok: false, code: LOOP_CODE.STEP_FAILED, step: 'consume', detail: String(error && error.message) };
  }
  const consumptionID = receiptOf(consumed);
  if (!consumptionID || !Number.isSafeInteger(consumed.quantity) || consumed.quantity <= 0) {
    return { ok: false, code: LOOP_CODE.NOT_LIVE_PROOF, step: 'consume', reason: 'no consumption evidence' };
  }
  if (consumed.quantity > d.productQuantity) {
    return { ok: false, code: LOOP_CODE.CONSERVATION_VIOLATION, step: 'consume', ledger: snapshot() };
  }
  receipts.push({ step: 'consume', receiptID: consumptionID, quantity: consumed.quantity });
  if (!add(d.productTypeID, -consumed.quantity)) {
    return { ok: false, code: LOOP_CODE.CONSERVATION_VIOLATION, step: 'consume', ledger: snapshot() };
  }

  const ledgerOfDemand = Feedback.createDemandLedger();
  const signalled = ledgerOfDemand.record({
    evidenceID: consumptionID,
    hullID: d.hullID,
    typeID: d.productTypeID,
    quantity: consumed.quantity,
  });
  const replayed = ledgerOfDemand.record({
    evidenceID: consumptionID,
    hullID: d.hullID,
    typeID: d.productTypeID,
    quantity: consumed.quantity,
  });
  if (!signalled.ok || !replayed.ok || replayed.code !== 'DUPLICATE_IGNORED') {
    return { ok: false, code: LOOP_CODE.STEP_FAILED, step: 'feedback', detail: replayed };
  }
  if (ledgerOfDemand.demandFor(d.productTypeID) !== consumed.quantity) {
    return { ok: false, code: LOOP_CODE.STEP_FAILED, step: 'feedback', reason: 'replay inflated demand' };
  }

  // 9. conservation and the new shortage
  const total = [...ledger.values()].reduce((sum, q) => sum + q, 0);
  const conserved = total === d.productQuantity - consumed.quantity;
  if (!conserved) {
    return { ok: false, code: LOOP_CODE.CONSERVATION_VIOLATION, ledger: snapshot() };
  }
  const shortage = ledgerOfDemand.demandFor(d.productTypeID) > 0;

  return {
    ok: true,
    code: LOOP_CODE.LOOP_CLOSED,
    receipts,
    ledger: snapshot(),
    conserved: {
      oreMined: d.oreQuantity,
      materialRefined: d.materialQuantity,
      productDelivered: d.productQuantity,
      productConsumed: consumed.quantity,
      remainingProduct: total,
    },
    shortage: { typeID: d.productTypeID, quantity: ledgerOfDemand.demandFor(d.productTypeID), signalled: shortage },
  };
}

module.exports = { runClosedLoop, LOOP_CODE };
