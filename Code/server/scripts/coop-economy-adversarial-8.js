"use strict";
// Wave 8: the refine -> buy -> transfer -> compete -> distress chain, and the resupply a hull needs.
// Waves 1-7 left these modules with contract tests only; here money and units have to survive a
// hostile sequence.
const path = require("node:path");
const fs = require("node:fs");
const root = process.env.EVEJS_FORK_ROOT || "C:\\Games\\EveCoop\\upstream-evejs";
const spaceDir = fs.existsSync(path.join(root, "Code/server/src/space"))
  ? path.join(root, "Code/server/src/space") : path.join(root, "src", "space");
const sp = (n) => path.join(spaceDir, n);

const Refinery = require(sp("coopEconomyRefineryQuote.js"));
const Purchase = require(sp("coopEconomyPlayerPurchase.js"));
const Transfer = require(sp("coopEconomyWarehouseTransfer.js"));
const Competition = require(sp("coopEconomyOrderCompetition.js"));
const Distress = require(sp("coopEconomyDistress.js"));
const Admission = require(sp("coopEconomyJobAdmission.js"));
const Feedback = require(sp("coopEconomyConsumptionFeedback.js"));
const Resupply = require(sp("coopEconomyFleetResupply.js"));

const failures = [];
let checks = 0;
function check(name, fn) {
  checks += 1;
  try { fn(); } catch (e) {
    failures.push({ name, error: String((e && e.message) || e).slice(0, 300) });
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
assert.equal = (a, b, m) => assert(a === b, (m || "") + " (" + String(a) + " !== " + String(b) + ")");
assert.ok = (c, m) => assert(c, m);

// 1. A refinery charges its fee once even when the caller retries the same operation, and it never
//    produces more output than the ore it was given.
check("refinery: the fee is charged once per operation and output never exceeds input", () => {
  const quote = { inputTypeID: "34", outputTypeID: "35", facilityID: "f1",
    inputQuantity: 100, outputQuantity: 80, feeCents: 25 };
  const debits = [];
  const paymentPort = { debit: (a) => { debits.push(a); return { ok: true, receiptID: "p" + debits.length }; } };
  const args = { operationID: "ref-1", quote, inputs: [{ typeID: "34", quantity: 100 }],
    walletCents: 1000, facility: { facilityID: "f1", supportsFeePayment: true }, paymentPort };
  const first = Refinery.runRefinery(args);
  assert.equal(first.ok, true, "a valid refinery run was refused: " + JSON.stringify(first).slice(0, 160));
  const second = Refinery.runRefinery(args);
  assert.equal(debits.length, 1, "a replayed operation debited " + debits.length + " times");
  assert.equal(second.code, "ALREADY_REFINED", "the replay was " + second.code);
  assert.equal(second.debitReceiptID, first.debitReceiptID, "the replay returned a different receipt");
  const produced = first.outputQuantity !== undefined ? first.outputQuantity : first.quantity;
  assert.ok(produced === undefined || produced <= quote.inputQuantity,
    "the refinery produced " + produced + " from " + quote.inputQuantity);
});

// 2. A corporation cannot sell to itself, and a purchase it cannot afford moves nothing.
check("purchase: self-trade and an unaffordable ask move no money", () => {
  const buyer = Purchase.createBuyer();
  const debits = [];
  const settlementPort = { debit: (a) => { debits.push(a); return { receiptID: "s" + debits.length }; } };
  const itemPort = { transfer: () => ({ receiptID: "i1" }) };
  const self = buyer.purchase({ operationID: "buy-self", buyerCorpID: "corp-1",
    ask: { askID: "a1", sellerCorpID: "corp-1", typeID: "35", quantity: 1, priceCents: 10 },
    walletCents: 1000, settlementPort, itemPort });
  assert.equal(self.ok, false, "a corporation bought from itself");
  assert.equal(self.code, "SELF_TRADE", "the self-trade was refused as " + self.code);
  assert.equal(debits.length, 0, "a self-trade moved money");
  const poor = buyer.purchase({ operationID: "buy-poor", buyerCorpID: "corp-1",
    ask: { askID: "a2", sellerCorpID: "corp-2", typeID: "35", quantity: 10, priceCents: 100 },
    walletCents: 5, settlementPort, itemPort });
  assert.equal(poor.ok, false, "a purchase beyond the wallet was accepted");
  assert.equal(debits.length, 0, "an unaffordable purchase moved money");
});

// 3. A successful purchase moves the same amount in and out, and the same operation cannot repeat.
check("purchase: one operation debits once", () => {
  const buyer = Purchase.createBuyer();
  const debits = [];
  const settlementPort = { debit: (a) => { debits.push(a); return { receiptID: "s" + debits.length }; } };
  const itemPort = { transfer: () => ({ receiptID: "i1" }) };
  const args = { operationID: "buy-ok", buyerCorpID: "corp-1",
    ask: { askID: "a3", sellerCorpID: "corp-2", typeID: "35", quantity: 5, priceCents: 100 },
    walletCents: 1000, settlementPort, itemPort };
  const ok = buyer.purchase(args);
  assert.equal(ok.ok, true, "an affordable purchase was refused: " + JSON.stringify(ok).slice(0, 160));
  assert.equal(debits.length, 1, "the settlement was called " + debits.length + " times");
  assert.equal(debits[0].cents, 500, "the buyer was debited " + debits[0].cents + " for 5 x 100");
  const again = buyer.purchase(args);
  assert.equal(again.code, "ALREADY_PURCHASED", "the replay was " + again.code);
  assert.equal(debits.length, 1, "a replayed purchase moved money again");
});

// 4. A warehouse transfer moves exactly once per cargo, through the native authority only.
check("transfer: units move once and a replay moves nothing", () => {
  const transfer = Transfer.createTransfer();
  const moves = [];
  const transferPort = { transferGoodsAndFunds: (a) => { moves.push(a);
    return { ok: true, goodsReceiptID: "g" + moves.length, paymentReceiptID: "p" + moves.length }; } };
  const args = { cargoID: "cargo-1", sellerCorpID: "s", buyerCorpID: "b", typeID: "35",
    quantity: 7, priceCents: 50, buyerWalletCents: 1000, transferPort };
  const first = transfer.transfer(args);
  assert.equal(first.ok, true, "a valid transfer was refused: " + JSON.stringify(first).slice(0, 160));
  assert.equal(moves.length, 1, "the transfer port was called " + moves.length + " times");
  assert.equal(moves[0].quantity, 7, "the port was asked for " + moves[0].quantity + " units");
  const again = transfer.transfer(args);
  assert.equal(again.code, "ALREADY_TRANSFERRED", "the replay was " + again.code);
  assert.equal(again.goodsReceiptID, first.goodsReceiptID, "the replay reported a different goods receipt");
  assert.equal(moves.length, 1, "the replay moved units again");
});

// 5. No fill can be priced above the cap, and an ineligible book produces no fill at all.
check("competition: the price cap holds and an ineligible book fills nothing", () => {
  const npc = { corpID: "npc-1", priceCents: 50 };
  const base = { npc, tick: 10, maxStepCents: 100, maxPriceCents: 100, minDelayTicks: 1,
    ordersThisTick: 0, maxOrdersPerTick: 5 };
  const tooPriced = Competition.chooseFill({ ...base, orders: [
    { orderID: "o1", ownerID: "p1", priceCents: 5000, quantity: 10 },
    { orderID: "o2", ownerID: "p2", priceCents: 9000, quantity: 5 },
  ] });
  assert.equal(tooPriced.ok, true, "the competition call failed: " + JSON.stringify(tooPriced).slice(0, 160));
  assert.equal(tooPriced.fill == null, true, "an order above the price cap was filled: " + JSON.stringify(tooPriced.fill));
  assert.equal(tooPriced.code, "NO_MATCH", "a capped book returned " + tooPriced.code);
  const empty = Competition.chooseFill({ ...base, orders: [] });
  assert.equal(empty.fill == null, true, "an empty book produced a fill");
});

// 6. Distress suspends spending, and a liquidation never sells the escrowed or the reserved units.
check("distress: a thin wallet suspends spending and escrow is never liquidated", () => {
  const state = Distress.assessDistress({ walletCents: 10, commitmentsCents: 500, minimumReserveCents: 100 });
  assert.equal(state.suspendSpending, true, "a short wallet kept spending: " + JSON.stringify(state));
  const r = Distress.liquidate({ escrowCents: 5000, surplus: [
    { itemID: "i1", quantity: 100, reservedQuantity: 100, unitValueCents: 10 },
    { itemID: "i2", quantity: 10, reservedQuantity: 0, unitValueCents: 100 },
  ] });
  assert.equal(r.ok !== false, true, "a valid liquidation was refused: " + JSON.stringify(r).slice(0, 140));
  const raised = r.liquidatedCents !== undefined ? r.liquidatedCents : r.soldCents;
  assert.equal(raised, 1000, "the liquidation raised " + raised + "; only i2 (10 x 100) is free");
});

// 7. A job without materials is refused and installs nothing; a duplicate operation installs once.
check("admission: a job without materials is refused and an operation installs once", () => {
  const admission = Admission.createJobAdmission();
  let installs = 0;
  const installPort = { installOnce: () => { installs += 1; return { ok: true, receiptID: "j" + installs }; } };
  const quote = { blueprintID: "bp-1", productTypeID: "35", runs: 1,
    needs: [{ typeID: "34", quantity: 10 }], materialCostCents: 100 };
  const short = admission.admit({ operationID: "job-1", quote, materials: [{ typeID: "34", quantity: 1 }],
    walletCents: 1000, installPort });
  assert.equal(short.ok, false, "a job without materials was admitted");
  assert.equal(short.code, "MATERIALS_SHORT", "refused as " + short.code);
  assert.equal(installs, 0, "a refused job installed a blueprint");
  const good = admission.admit({ operationID: "job-2", quote, materials: [{ typeID: "34", quantity: 10 }],
    walletCents: 1000, installPort });
  assert.equal(good.ok, true, "a complete job was refused: " + JSON.stringify(good).slice(0, 160));
  assert.equal(installs, 1, "the install was called " + installs + " times");
  admission.admit({ operationID: "job-2", quote, materials: [{ typeID: "34", quantity: 10 }],
    walletCents: 1000, installPort });
  assert.equal(installs, 1, "a duplicate operation installed again");
});

// 8. The same evidence counts once, and a resupply never takes more than the warehouse holds.
check("feedback and resupply: evidence counts once and stock is never overdrawn", () => {
  const ledger = Feedback.createDemandLedger();
  ledger.record({ evidenceID: "e1", hullID: "h1", typeID: "35", quantity: 10 });
  ledger.record({ evidenceID: "e1", hullID: "h1", typeID: "35", quantity: 10 });
  assert.equal(ledger.total(), 10, "the same evidence was counted twice");
  assert.equal(ledger.demandFor("35"), 10, "demandFor disagrees with the total");
  const resupply = Resupply.createResupply();
  const fits = [];
  const equipmentPort = { fit: (a) => { fits.push(a); return { ok: true, receiptID: "f1" }; } };
  const over = resupply.resupply({
    deliveryID: "d1",
    item: { typeID: "35", quantity: 50, stationID: 60000358 },
    hull: { hullID: "h1", docked: true, stationID: 60000358 },
    warehouse: { stationID: 60000358, quantity: 10 },
    equipmentPort,
  });
  assert.equal(over.ok, false, "a resupply above the warehouse stock was accepted");
  assert.equal(fits.length, 0, "an overdrawn resupply fitted equipment anyway");
  const ok = resupply.resupply({
    deliveryID: "d2",
    item: { typeID: "35", quantity: 10, stationID: 60000358 },
    hull: { hullID: "h1", docked: true, stationID: 60000358 },
    warehouse: { stationID: 60000358, quantity: 10 },
    equipmentPort,
  });
  assert.equal(ok.ok, true, "a resupply that fits was refused: " + JSON.stringify(ok).slice(0, 140));
  assert.equal(fits.length, 1, "the equipment port was called " + fits.length + " times");
});

process.stdout.write(JSON.stringify({ checks, failures: failures.length, details: failures }, null, 2) + "\n");
process.exit(failures.length === 0 ? 0 : 1);
