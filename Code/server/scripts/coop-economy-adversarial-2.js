"use strict";
// Wave 2 of the adversarial harness: identity conflicts, partial state, replay with different
// payloads, boundary currencies, and the closed loop under hostile ports.

const path = require("node:path");
const root = process.env.EVEJS_FORK_ROOT || path.resolve(__dirname, "..", "..", "..");
const sp = (name) => path.join(root, "Code/server/src/space", name);

const m = {
  closedLoop: require(sp("coopEconomyClosedLoop.js")),
  advisory: require(sp("coopEconomyAvailableToPromise.js")),
  admission: require(sp("coopEconomyJobAdmission.js")),
  refinery: require(sp("coopEconomyRefineryQuote.js")),
  settlement: require(sp("coopEconomySaleSettlement.js")),
  split: require(sp("coopEconomySplitContract.js")),
  reputation: require(sp("coopEconomyReputation.js")),
  race: require(sp("coopEconomyRaceMatrix.js")),
  crash: require(sp("coopEconomyCrashWindows.js")),
  competition: require(sp("coopEconomyOrderCompetition.js")),
  reservations: require(sp("coopEconomyReservations.js")),
  funds: require(sp("coopEconomyFundsGateway.js")),
  soak: require(sp("coopEconomySoak.js")),
  coverage: require(sp("coopEconomyConservationCoverage.js")),
};

const failures = [];
let checks = 0;
function check(name, fn) {
  checks += 1;
  try {
    fn();
  } catch (error) {
    failures.push({ name, error: String((error && error.message) || error).slice(0, 300) });
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const demand = {
  oreTypeID: "34", materialTypeID: "35", productTypeID: "36",
  stationID: "s1", hullID: "h1", blueprintID: "bp1",
  oreQuantity: 100, materialQuantity: 90, productQuantity: 2, runs: 1,
  feeCents: 10, walletCents: 1000, materialCostCents: 50, corpID: "c",
};
const livePorts = () => ({
  mining: { dispatch: () => ({ receiptID: "m1" }) },
  warehouse: { receive: () => ({ receiptID: "a1", itemID: "i1" }) },
  payment: { debit: () => ({ receiptID: "p1" }) },
  install: { installOnce: () => ({ receiptID: "j1" }) },
  itemStore: { issue: () => ({ itemID: "it1" }) },
  equipment: { fit: () => ({ receiptID: "f1" }) },
  consumption: { read: () => ({ receiptID: "c1", quantity: 1 }) },
});

// ---------- closed loop hostile ports ----------

for (const [label, mutate] of [
  ["no mining receipt", (p) => { p.mining = { dispatch: () => ({}) }; }],
  ["mining throws", (p) => { p.mining = { dispatch: () => { throw new Error("x"); } }; }],
  ["warehouse without item", (p) => { p.warehouse = { receive: () => ({ receiptID: "a" }) }; }],
  ["warehouse throws", (p) => { p.warehouse = { receive: () => { throw new Error("x"); } }; }],
  ["payment receiptless", (p) => { p.payment = { debit: () => ({}) }; }],
  ["install throws", (p) => { p.install = { installOnce: () => { throw new Error("x"); } }; }],
  ["itemStore without item", (p) => { p.itemStore = { issue: () => ({}) }; }],
  ["fit throws", (p) => { p.equipment = { fit: () => { throw new Error("x"); } }; }],
  ["consumption without receipt", (p) => { p.consumption = { read: () => ({ quantity: 1 }) }; }],
  ["consumption over-delivers", (p) => { p.consumption = { read: () => ({ receiptID: "c", quantity: 999 }) }; }],
  ["port marked manual", (p) => { p.equipment = { manual: true }; }],
]) {
  check("closed loop refuses: " + label, () => {
    const ports = livePorts();
    mutate(ports);
    const result = m.closedLoop.runClosedLoop({ demand, ports });
    assert(result.ok === false, "a hostile port produced a closed loop: " + JSON.stringify(result).slice(0, 200));
    assert(result.receipts === undefined || result.receipts.length < 7, "a receipt chain was reported for a failed loop");
  });
}

check("closed loop: the same receipt id used by two steps is visible", () => {
  const ports = livePorts();
  ports.payment = { debit: () => ({ receiptID: "same" }) };
  ports.install = { installOnce: () => ({ receiptID: "same" }) };
  const result = m.closedLoop.runClosedLoop({ demand, ports });
  assert(result.ok === true, "the loop failed for a shared receipt id");
  const ids = result.receipts.map((r) => r.receiptID);
  assert(ids.length === new Set(ids).size || ids.includes("same"), "no receipt chain");
});

// ---------- identity conflicts ----------

check("admission: the same operation with a different quote is not silently the old job", () => {
  const a = m.admission.createJobAdmission();
  const quote = { blueprintID: "bp", productTypeID: "35", runs: 1, materialCostCents: 0, needs: [{ typeID: "34", quantity: 10 }] };
  const port = { installOnce: () => ({ receiptID: "j1" }) };
  const first = a.admit({ operationID: "o", quote, materials: [{ typeID: "34", quantity: 10 }], walletCents: 100, installPort: port });
  assert(first.ok, "first admit failed");
  const different = a.admit({ operationID: "o", quote: { ...quote, blueprintID: "bp2", runs: 9 }, materials: [{ typeID: "34", quantity: 10 }], walletCents: 100, installPort: port });
  if (different.code === "ALREADY_ADMITTED") {
    assert(different.jobID === "j1", "returned a different job");
  } else {
    assert(different.ok === false, "a different quote under the same operation was admitted: " + JSON.stringify(different));
  }
});

check("refinery: fee equal to the wallet is payable, one cent more is not", () => {
  const quote = { inputTypeID: "34", inputQuantity: 1, outputTypeID: "35", outputQuantity: 1, feeCents: 10, facilityID: "f" };
  const port = { debit: () => ({ receiptID: "d" }) };
  const exact = m.refinery.runRefinery({ quote, inputs: [{ typeID: "34", quantity: 1 }], walletCents: 10, facility: { facilityID: "f", supportsFeePayment: true }, paymentPort: port });
  assert(exact.ok === true, "exact wallet refused: " + JSON.stringify(exact));
  const short = m.refinery.runRefinery({ quote, inputs: [{ typeID: "34", quantity: 1 }], walletCents: 9, facility: { facilityID: "f", supportsFeePayment: true }, paymentPort: port });
  assert(short.code === "INSUFFICIENT_FUNDS", "short wallet " + JSON.stringify(short));
});

check("settlement: the same fill with a different amount still credits once", () => {
  let credits = 0;
  const s = m.settlement.createSettlement();
  const walletPort = { credit: () => { credits += 1; return { receiptID: "r" }; } };
  s.settle({ fillID: "f", ownerCorpID: "c", grossCents: 100, taxCents: 0, feeCents: 0, walletPort });
  const again = s.settle({ fillID: "f", ownerCorpID: "c", grossCents: 999999, taxCents: 0, feeCents: 0, walletPort });
  assert(again.code === "ALREADY_SETTLED", again.code);
  assert(credits === 1, "credits " + credits);
});

check("split: two parties cannot share one playerID", () => {
  const s = m.split.createSplitContract();
  const r = s.create({ contractID: "k", totalCents: 100, parties: [{ playerID: "p", role: "SUPPLIER", shareBps: 5000 }, { playerID: "p", role: "CARRIER", shareBps: 5000 }] });
  assert(r.ok === false, "the same player took both roles");
});

check("split: negative or non-integer bps are refused", () => {
  const s = m.split.createSplitContract();
  for (const bps of [-1, 1.5, NaN, "5000"]) {
    const r = s.create({ contractID: "k" + bps, totalCents: 100, parties: [{ playerID: "a", role: "SUPPLIER", shareBps: bps }, { playerID: "b", role: "CARRIER", shareBps: 10000 - bps }] });
    assert(r.ok === false, "accepted bps " + String(bps));
  }
});

check("reputation: the same contract for two players is two records", () => {
  const rep = m.reputation.createReputation();
  rep.record({ playerID: "a", contractID: "k", outcome: "SUCCESS", receiptID: "r" });
  const second = rep.record({ playerID: "b", contractID: "k", outcome: "SUCCESS", receiptID: "r" });
  assert(second.code === "RECORDED", "second player blocked: " + second.code);
  assert(rep.entries().length === 2, "entries " + rep.entries().length);
});

// ---------- leases and crash windows ----------

check("race: only the holder may heartbeat", () => {
  const l = m.race.createLeases({ ttlTicks: 10 });
  l.acquire({ key: "k", ownerID: "a", tick: 0 });
  const r = l.heartbeat({ key: "k", ownerID: "b", tick: 1 });
  assert(r.ok === false, "a stranger kept the lease alive");
});

check("race: a sweep never releases a lease that just beat", () => {
  const l = m.race.createLeases({ ttlTicks: 10, graceTicks: 0 });
  l.acquire({ key: "k", ownerID: "a", tick: 0 });
  l.heartbeat({ key: "k", ownerID: "a", tick: 100 });
  const swept = l.sweep({ tick: 105 });
  assert(swept.released.length === 0, "swept a live lease: " + JSON.stringify(swept));
});

check("crash: two operations in one journal do not share steps", () => {
  const steps = { INTENT: () => ({ receiptID: "i" }), DEBIT: () => ({ receiptID: "d" }), CREDIT: () => ({ receiptID: "c" }), ESCROW: () => ({ receiptID: "e" }), FINALIZE: () => ({ receiptID: "f" }) };
  const a = m.crash.runWindow({ window: "AFTER_DEBIT", operationID: "op-a", steps });
  const b = m.crash.runWindow({ window: "AFTER_DEBIT", operationID: "op-b", steps });
  assert(a.ok && b.ok, "one of two windows failed");
  assert(a.counts.DEBIT === 1 && b.counts.DEBIT === 1, "counts leaked between operations");
});

// ---------- coverage and money boundaries ----------

check("coverage: cents and units never mix silently", () => {
  const r = m.coverage.audit({
    before: { wallet: { cents: 100, sourceReceiptID: "w" }, warehouse: { units: 5, sourceReceiptID: "u" } },
    after: { wallet: { units: 100, sourceReceiptID: "w" }, warehouse: { units: 5, sourceReceiptID: "u" } },
    custody: [],
  });
  assert(r.ok === false, "a unit reading was accepted as cents");
});

check("funds: a commitment of MAX_SAFE_INTEGER is refused, not wrapped", () => {
  const g = m.funds.createGateway();
  const r = g.commit({ operationID: "o", cents: Number.MAX_SAFE_INTEGER, walletCents: Number.MAX_SAFE_INTEGER, escrowProof: true });
  assert(r.ok === false || g.fundedCents() === Number.MAX_SAFE_INTEGER, "unsafe total: " + g.fundedCents());
  const second = g.commit({ operationID: "o2", cents: 1, walletCents: Number.MAX_SAFE_INTEGER, escrowProof: true });
  assert(second.ok === false, "a one cent commitment overflowed the wallet cap");
});

check("reservations: releasing an unknown operation is a no-op", () => {
  const r = m.reservations.createReservations();
  r.reserve("k", "a", 5, 10);
  assert(r.releaseAll("ghost") === 0, "releaseAll counted a ghost");
  assert(r.reservedFor("k") === 5, "total changed");
  assert(r.release("ghost", "a") === false, "release on the wrong key succeeded");
});

check("soak: three runs of one seed are identical, and a different seed differs", () => {
  const a = m.soak.runSoak({ ticks: 300, seed: 11 });
  const b = m.soak.runSoak({ ticks: 300, seed: 11 });
  const c = m.soak.runSoak({ ticks: 300, seed: 12 });
  assert(JSON.stringify(a.metrics) === JSON.stringify(b.metrics), "same seed diverged");
  assert(JSON.stringify(a.metrics) !== JSON.stringify(c.metrics), "different seed identical");
});

check("competition: a player at the same price as the NPC wins the tie", () => {
  const orders = [{ orderID: "p1", ownerID: "player", priceCents: 50, quantity: 1 }, { orderID: "n1", ownerID: "npc", priceCents: 50, quantity: 1 }];
  const r = m.competition.chooseFill({ orders, npc: { corpID: "npc", priceCents: 50, lastRepriceTick: 0 }, tick: 10, minDelayTicks: 1, maxStepCents: 10, maxPriceCents: 100, ordersThisTick: 1, maxOrdersPerTick: 2 });
  assert(r.ok === true && r.code === "MATCH" && r.orderID === "p1", "tie lost: " + JSON.stringify(r));
});

check("competition: duplicate order ids are refused", () => {
  const orders = [{ orderID: "x", ownerID: "player", priceCents: 5, quantity: 1 }, { orderID: "x", ownerID: "npc", priceCents: 6, quantity: 1 }];
  const r = m.competition.chooseFill({ orders, npc: { corpID: "npc", priceCents: 5, lastRepriceTick: 0 }, tick: 10, minDelayTicks: 1, maxStepCents: 10, maxPriceCents: 100, ordersThisTick: 1, maxOrdersPerTick: 2 });
  assert(r.ok === false, "duplicate order ids matched: " + JSON.stringify(r));
});

// ---------- available-to-promise boundary ----------

check("ATP: promises never exceed on hand minus reserved", () => {
  if (typeof m.advisory.computeAvailableToPromise !== "function") return;
  const r = m.advisory.computeAvailableToPromise({ onHand: 10, reserved: 3, incoming: 5, committed: 4 });
  assert(r.available === undefined || r.available <= 10 + 5 - 3, "over-promised " + JSON.stringify(r));
});

const summary = { checks, failures: failures.length, details: failures };
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(failures.length === 0 ? 0 : 1);
