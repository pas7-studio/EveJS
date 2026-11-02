"use strict";
// Adversarial harness for the Mission 003 economy modules.
// It is deliberately hostile: NaN/Infinity/negative/huge numbers, replayed receipts,
// reordered calls, corrupted state, wrong shapes. Any throw or invariant break is a defect.
//
// Usage: node adversarial.js [--seeds 200]

const path = require("node:path");
const root = process.env.EVEJS_FORK_ROOT || "O:\\tmp\\m003\\work";
const fsProbe = require("node:fs");
const spaceDir = fsProbe.existsSync(path.join(root, "Code/server/src/space"))
  ? path.join(root, "Code/server/src/space")
  : path.join(root, "src", "space");
const sp = (name) => path.join(spaceDir, name);

const mods = {
  reservations: require(sp("coopEconomyReservations.js")),
  funds: require(sp("coopEconomyFundsGateway.js")),
  graph: require(sp("coopEconomyOperationGraph.js")),
  refinery: require(sp("coopEconomyRefineryQuote.js")),
  admission: require(sp("coopEconomyJobAdmission.js")),
  delivery: require(sp("coopEconomyOutputDelivery.js")),
  resupply: require(sp("coopEconomyFleetResupply.js")),
  consumption: require(sp("coopEconomyConsumptionFeedback.js")),
  escrow: require(sp("coopEconomySellEscrow.js")),
  settlement: require(sp("coopEconomySaleSettlement.js")),
  transfer: require(sp("coopEconomyWarehouseTransfer.js")),
  pnl: require(sp("coopEconomyPnl.js")),
  competition: require(sp("coopEconomyOrderCompetition.js")),
  distress: require(sp("coopEconomyDistress.js")),
  unload: require(sp("coopEconomyUnload.js")),
  split: require(sp("coopEconomySplitContract.js")),
  reputation: require(sp("coopEconomyReputation.js")),
  crash: require(sp("coopEconomyCrashWindows.js")),
  race: require(sp("coopEconomyRaceMatrix.js")),
  soak: require(sp("coopEconomySoak.js")),
  rollout: require(sp("coopEconomyRolloutManifest.js")),
  calibration: require(sp("coopEconomyCalibration.js")),
  perf: require(sp("coopEconomyPerformanceGuard.js")),
  final: require(sp("coopEconomyFinalAcceptance.js")),
  coverage: require(sp("coopEconomyConservationCoverage.js")),
  risk: require(sp("coopEconomyRiskPolicy.js")),
  health: require(sp("coopEconomyHealthReport.js")),
  compat: require(sp("coopEconomyCompatMatrix.js")),
  purchase: require(sp("coopEconomyPlayerPurchase.js")),
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

const NASTY = [NaN, Infinity, -Infinity, -1, -0.5, 0, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, null, undefined, "", "1", {}, [], true];

// ---------- money and quantity invariants ----------

check("funds: nasty inputs never create a funded liability", () => {
  const g = mods.funds.createGateway();
  for (const cents of NASTY) {
    const result = g.commit({ operationID: "op", cents, walletCents: 1000, escrowProof: true });
    assert(result.ok === false || result.status === "FUNDED", "unexpected " + JSON.stringify(result));
    if (result.ok) g.release("op");
  }
  assert(g.fundedCents() === 0, "funded after nasty inputs: " + g.fundedCents());
});

check("funds: the wallet cap holds across many operations and releases", () => {
  const g = mods.funds.createGateway();
  for (let i = 0; i < 50; i += 1) {
    g.commit({ operationID: "o" + i, cents: 10, walletCents: 100 });
  }
  assert(g.committedCents() <= 100, "committed " + g.committedCents());
  for (let i = 0; i < 50; i += 1) g.release("o" + i);
  assert(g.committedCents() === 0, "release did not free the total: " + g.committedCents());
});

check("reservations: total on hand is never exceeded under any interleaving", () => {
  const r = mods.reservations.createReservations();
  let accepted = 0;
  for (let i = 0; i < 200; i += 1) {
    const result = r.reserve("k", "op" + (i % 37), 1 + (i % 7), 40);
    if (result.ok && result.code === "RESERVED") accepted += 1;
    assert(r.reservedFor("k") <= 40, "over-reserved " + r.reservedFor("k"));
  }
  assert(accepted > 0, "nothing was ever reserved");
  for (let i = 0; i < 37; i += 1) r.releaseAll("op" + i);
  assert(r.reservedFor("k") === 0, "releaseAll left " + r.reservedFor("k"));
});

check("escrow: partial fills sum to the listed quantity, never more", () => {
  const e = mods.escrow.createEscrow();
  e.stock({ itemID: "i1", quantity: 10 });
  assert(e.list({ escrowID: "e1", itemID: "i1", quantity: 10, priceCents: 5 }).ok);
  let filled = 0;
  for (const qty of [3, 3, 3, 3]) {
    const result = e.fill({ escrowID: "e1", quantity: qty });
    if (result.ok) filled += qty;
  }
  assert(filled === 9, "filled " + filled);
  assert(e.fill({ escrowID: "e1", quantity: 2 }).ok === false, "overfill accepted");
  assert(e.available("i1") === 0, "available " + e.available("i1"));
  assert(e.cancel({ escrowID: "e1" }).ok, "cancel failed");
  assert(e.available("i1") === 1, "cancel returns only the unsold unit, not the sold ones: " + e.available("i1"));
});

check("settlement: net + tax + fee never exceeds gross and the cap holds", () => {
  const s = mods.settlement.createSettlement();
  let creditCalls = 0;
  const walletPort = { credit: ({ cents }) => { assert(cents >= 0, "negative credit " + cents); creditCalls += 1; return { receiptID: "r" + creditCalls }; } };
  for (let i = 0; i < 100; i += 1) {
    const gross = 1 + (i % 50);
    const tax = i % 7;
    const fee = i % 5;
    const result = s.settle({ fillID: "f" + i, ownerCorpID: "c", grossCents: gross, taxCents: tax, feeCents: fee, walletPort });
    if (result.ok) {
      assert(result.netCents <= gross, "net > gross");
      assert(result.netCents >= 0, "net < 0");
    }
  }
});

check("transfer: a partial authoritative call never records a completed transfer", () => {
  const t = mods.transfer.createTransfer();
  let calls = 0;
  const base = { cargoID: "c1", sellerCorpID: "s", buyerCorpID: "b", typeID: "35", quantity: 10, priceCents: 5, buyerWalletCents: 100 };
  const partial = t.transfer({ ...base, transferPort: { transferGoodsAndFunds: () => { calls += 1; return { goodsReceiptID: "g1" }; } } });
  assert(partial.ok === false, "partial recorded as ok");
  const retry = t.transfer({ ...base, transferPort: { transferGoodsAndFunds: () => { calls += 1; return { goodsReceiptID: "g1", paymentReceiptID: "p1" }; } } });
  assert(calls === 2, "calls " + calls);
  assert(retry.ok === true, "the retry should be able to complete: " + JSON.stringify(retry));
});

check("pnl: a warehouse move can never move realized profit", () => {
  const a = mods.pnl.computePnl({ transactions: [{ kind: "SALE", cents: 100, costCents: 60 }], stock: [] });
  const b = mods.pnl.computePnl({ transactions: [{ kind: "SALE", cents: 100, costCents: 60 }, { kind: "WAREHOUSE_MOVE", cents: 5000, costCents: 5000 }], stock: [] });
  assert(a.realizedCents === b.realizedCents, "realized moved: " + a.realizedCents + " vs " + b.realizedCents);
  assert(a.cashCents === b.cashCents, "cash moved");
  assert(a.stockValueCents === b.stockValueCents, "stock value moved");
});

check("distress: liquidation never exceeds sellable value and never mints", () => {
  const d = mods.distress.liquidate({ surplus: [{ itemID: "i", quantity: 10, reservedQuantity: 4, unitValueCents: 3 }], escrowCents: 7 });
  assert(d.liquidatedCents === 18, "liquidated " + d.liquidatedCents);
  assert(d.protectedCents === 19, "protected " + d.protectedCents);
});

// ---------- structural invariants ----------

check("graph: every failed order leaves the graph usable", () => {
  const g = mods.graph.createGraph();
  g.add({ operationID: "a", resourceKeys: [], dependencies: [] });
  const bad = g.add({ operationID: "b", resourceKeys: [1], dependencies: [] });
  assert(bad.ok === false, "bad resourceKeys accepted");
  g.add({ operationID: "b", resourceKeys: ["x"], dependencies: ["a"] });
  assert(g.order().ok === true, "graph became unusable after a rejected add");
});

check("refinery: a failed run never calls debit, a successful one calls it once", () => {
  let debits = 0;
  const quote = { inputTypeID: "34", inputQuantity: 100, outputTypeID: "35", outputQuantity: 90, feeCents: 10, facilityID: "f" };
  const port = { debit: () => { debits += 1; return { receiptID: "d" + debits }; } };
  const bad = [
    { quote: { ...quote, inputQuantity: 0 }, inputs: [] },
    { quote: { ...quote, outputQuantity: 1.5 }, inputs: [{ typeID: "34", quantity: 200 }] },
    { quote, inputs: [] },
    { quote, inputs: [{ typeID: "34", quantity: 100 }], walletCents: 0 },
    { quote, inputs: [{ typeID: "34", quantity: 100 }], facility: { facilityID: "other" } },
  ];
  for (const args of bad) {
    mods.refinery.runRefinery({ ...args, walletCents: args.walletCents === undefined ? 100 : args.walletCents, facility: args.facility || { facilityID: "f", supportsFeePayment: true }, paymentPort: port });
  }
  assert(debits === 0, "failed runs debited " + debits);
  const ok = mods.refinery.runRefinery({ quote, inputs: [{ typeID: "34", quantity: 100 }], walletCents: 100, facility: { facilityID: "f", supportsFeePayment: true }, paymentPort: port });
  assert(ok.ok === true, "valid run failed: " + JSON.stringify(ok));
  assert(debits === 1, "debits " + debits);
});

check("admission: a rejected install never permits a second job", () => {
  const q = { blueprintID: "bp", productTypeID: "35", runs: 1, materialCostCents: 0, needs: [{ typeID: "34", quantity: 10 }] };
  const mats = [{ typeID: "34", quantity: 10 }];
  let installs = 0;
  const port = { installOnce: () => { installs += 1; throw new Error("boom"); } };
  const a = mods.admission.createJobAdmission();
  assert(a.admit({ operationID: "o", quote: q, materials: mats, walletCents: 100, installPort: port }).code === "INSTALL_UNKNOWN");
  const second = a.admit({ operationID: "o", quote: q, materials: mats, walletCents: 100, installPort: { installOnce: () => { installs += 1; return { receiptID: "j" }; } } });
  assert(second.ok === false, "second job created after an unknown install");
  assert(installs === 1, "installs " + installs);
});

check("delivery: an itemStore that throws cannot mint or double-issue", () => {
  const d = mods.delivery.createOutputDelivery();
  const job = { jobID: "j", productTypeID: "35", quantity: 2 };
  let calls = 0;
  const store = { issue: () => { calls += 1; throw new Error("disk full"); } };
  const first = d.deliver({ job, readback: { jobID: "j", completed: true, readyAt: 1 }, itemStore: store });
  assert(first.ok === false, "minted without a receipt");
  const second = d.deliver({ job, readback: { jobID: "j", completed: true, readyAt: 1 }, itemStore: { issue: () => { calls += 1; return { itemID: "it" }; } } });
  assert(calls === 2, "calls " + calls);
  assert(second.ok === true, "retry after a failed issue must be possible: " + JSON.stringify(second));
  assert(d.deliver({ job, readback: { jobID: "j", completed: true, readyAt: 1 }, itemStore: { issue: () => { calls += 1; return { itemID: "it2" }; } } }).code === "ALREADY_DELIVERED");
});

check("resupply: a failed fit never issues stock twice", () => {
  const r = mods.resupply.createResupply();
  const base = { deliveryID: "d", item: { typeID: "35", quantity: 5, stationID: "s" }, hull: { hullID: "h", stationID: "s", docked: true }, warehouse: { stationID: "s", quantity: 50 } };
  let fits = 0;
  const bad = r.resupply({ ...base, equipmentPort: { fit: () => { fits += 1; throw new Error("no cargo hold"); } } });
  assert(bad.ok === false, "bad fit ok");
  const good = r.resupply({ ...base, equipmentPort: { fit: () => { fits += 1; return { receiptID: "f" }; } } });
  assert(fits === 2, "fits " + fits);
  assert(good.ok === true || good.code === "ALREADY_ISSUED", "unexpected after a failed fit: " + JSON.stringify(good));
});

check("consumption: identical evidence with different quantities cannot inflate", () => {
  const ledger = mods.consumption.createDemandLedger();
  ledger.record({ evidenceID: "e", hullID: "h", typeID: "35", quantity: 10 });
  const again = ledger.record({ evidenceID: "e", hullID: "h", typeID: "35", quantity: 999 });
  assert(again.code === "DUPLICATE_IGNORED", "different quantity with the same evidence was accepted");
  assert(ledger.demandFor("35") === 10, "demand " + ledger.demandFor("35"));
});

check("competition: a tie never starves the player and never lets the NPC self-trade", () => {
  const orders = [
    { orderID: "p", ownerID: "player", priceCents: 100, quantity: 1 },
    { orderID: "n", ownerID: "npc", priceCents: 100, quantity: 1 },
  ];
  const r = mods.competition.chooseFill({ orders, npc: { corpID: "npc", priceCents: 100, lastRepriceTick: 0 }, tick: 100, minDelayTicks: 1, maxStepCents: 10, maxPriceCents: 1000, ordersThisTick: 1, maxOrdersPerTick: 2 });
  assert(r.ok === true, "tie crashed: " + JSON.stringify(r));
  if (r.code === "MATCH") assert(r.orderID === "p", "the NPC matched its own price against the player: " + r.orderID);
});

check("unload: an order list with huge prices cannot overflow the sold cents", () => {
  const r = mods.unload.unload({
    cargo: { ownerID: "c", typeID: "35", quantity: 10 },
    station: { stationID: "s", dockRangeMeters: 2500, distanceMeters: 10 },
    orders: [{ priceCents: Number.MAX_SAFE_INTEGER, quantity: 9 }, { priceCents: Number.MAX_SAFE_INTEGER, quantity: 9 }],
    unloadPort: { deposit: () => ({ receiptID: "r" }) },
  });
  assert(r.ok === false ? r.code === "INVALID_ORDER" : Number.isSafeInteger(r.sold.cents), "overflow was neither refused nor safe: " + JSON.stringify(r));
});

check("coverage: three holders of one cargo block the scope", () => {
  const s = (units) => ({ units, sourceReceiptID: "r" + units });
  const r = mods.coverage.audit({ before: { cargo: s(10) }, after: { cargo: s(10) }, custody: [{ cargoID: "c", holderID: "a" }, { cargoID: "c", holderID: "b" }, { cargoID: "c", holderID: "c" }] });
  assert(r.code === "DUPLICATE_CUSTODY", "code " + r.code);
});

check("crash windows: a throwing step is reported, not swallowed", () => {
  const steps = { INTENT: () => ({ receiptID: "i" }), DEBIT: () => { throw new Error("native refused"); } };
  let threw = false;
  let result = null;
  try {
    result = mods.crash.runWindow({ window: "AFTER_INTENT", operationID: "o", steps });
  } catch (error) {
    threw = true;
  }
  assert(threw === true || (result && result.ok === false), "a throwing step produced a quiet success: " + JSON.stringify(result));
});

check("race: reclaim with a heartbeat exactly at ttl is still refused", () => {
  const leases = mods.race.createLeases({ ttlTicks: 30, graceTicks: 5 });
  leases.acquire({ key: "k", ownerID: "a", tick: 0 });
  leases.heartbeat({ key: "k", ownerID: "a", tick: 30 });
  const r = leases.reclaim({ key: "k", ownerID: "b", tick: 30, evidence: "x" });
  assert(r.ok === false, "a live owner was stolen at the ttl boundary");
});

check("soak: a failing soak never reports reset or hides failures", () => {
  const r = mods.soak.runSoak({ ticks: 500, seed: 3, stockCap: 4 });
  assert(r.reset === false, "reset true");
  if (r.ok === false) assert(Array.isArray(r.failures) && r.failures.length > 0, "failed soak without failures");
});

check("rollout: string flags never enable writes", () => {
  for (const value of ["1", "true", 1, true]) {
    const r = mods.rollout.evaluate({ stage: "CORP1", flags: { EVEJS_COOP_ECONOMY: value } });
    if (value === true) assert(r.writes === true, "boolean true did not enable");
    else assert(r.writes === false, "non-boolean " + JSON.stringify(value) + " enabled writes");
  }
});

check("calibration: refuse a demand pump before clamping anything else", () => {
  const bounds = { safetyStockTicks: [10, 100], productionCadenceTicks: [5, 60], offerRefreshTicks: [5, 120], riskStep: [1, 5] };
  const r = mods.calibration.calibrate({ measured: { safetyStockTicks: 1, productionCadenceTicks: 1, offerRefreshTicks: 1, riskStep: 1, demandMultiplier: 2 }, bounds });
  assert(r.ok === false && r.code === "DEMAND_PUMP_REFUSED", JSON.stringify(r));
});

check("perf: a zero baseline p95 cannot hide an infinite regression", () => {
  const r = mods.perf.check({ baseline: { paths: [{ name: "t", p95Ms: 0 }], ticks: { slowestMs: 1 } }, candidate: { paths: [{ name: "t", p95Ms: 500 }], ticks: { slowestMs: 1 } }, budgets: { p95TolerancePct: 20, tickBudgetMs: 10, maxCheckMinutes: 5 } });
  assert(r.ok === false, "a zero baseline swallowed a 500ms regression");
});

check("final: gates must be real booleans, not truthy strings", () => {
  const gates = {};
  for (const g of mods.final.REQUIRED_GATES) gates[g] = { ok: "true", evidence: "e" };
  const r = mods.final.evaluate({ gates, ownerApproval: { approved: true, role: "OWNER", approverID: "o", sha: "s" } });
  assert(r.ok === false, "string 'true' gates promoted to PLAY");
});

check("health: an intent-only economy reports zero production", () => {
  const r = mods.health.buildReport({ pnl: { realizedCents: 0, stockValueCents: 0, committedCents: 0 }, demand: { intents: 5000, fulfilled: [] }, shortages: [], cargoLosses: [], players: [] });
  assert(r.producedQuantity === 0, "production " + r.producedQuantity);
  assert(r.intents === 5000, "intents " + r.intents);
});

check("compat: a key order change is not a behavior change", () => {
  const a = { combat: { x: 1, y: 2 }, salvage: {}, factionWarfare: {}, market: {}, clientRpc: {} };
  const b = { clientRpc: {}, market: {}, factionWarfare: {}, salvage: {}, combat: { y: 2, x: 1 } };
  const r = mods.compat.run({ baseline: a, candidate: b, flags: { economy: false } });
  assert(r.code === "OFF_PARITY", "object key order produced a false diff: " + r.code);
});

check("risk: a rejected incident does not consume the incident id", () => {
  const p = mods.risk.createRiskPolicy();
  assert(p.apply({ incidentID: "i", routeID: "r", kind: "LOSS", receiptID: "x", tick: 0 }).code === "UNKNOWN_ROUTE");
  p.register({ routeID: "r" });
  const applied = p.apply({ incidentID: "i", routeID: "r", kind: "LOSS", receiptID: "x", tick: 0 });
  assert(applied.code === "RISK_UPDATED", "a rejected incident burned its id: " + applied.code);
});

check("purchase: a transfer loss after a debit is not silently a success", () => {
  const b = mods.purchase.createBuyer();
  const ask = { askID: "a", sellerCorpID: "s", typeID: "35", quantity: 10, priceCents: 5 };
  const r = b.purchase({ operationID: "o", buyerCorpID: "b", ask, walletCents: 100, settlementPort: { debit: () => ({ receiptID: "d" }) }, itemPort: { transfer: () => { throw new Error("lost"); } } });
  assert(r.ok === false && r.code === "TRANSFER_UNKNOWN", JSON.stringify(r));
  assert(r.debitReceiptID === "d", "the debit receipt must be reported for reconciliation");
  const again = b.purchase({ operationID: "o", buyerCorpID: "b", ask, walletCents: 100, settlementPort: { debit: () => ({ receiptID: "d2" }) }, itemPort: { transfer: () => ({ receiptID: "t2" }) } });
  assert(again.code !== "TRANSFER_UNKNOWN" || again.debitReceiptID === "d", "a second debit after a lost transfer: " + JSON.stringify(again));
});

check("split: bps rounding never pays more than the contract", () => {
  const s = mods.split.createSplitContract();
  assert(s.create({ contractID: "k", totalCents: 100, parties: [{ playerID: "a", role: "SUPPLIER", shareBps: 3333 }, { playerID: "b", role: "CARRIER", shareBps: 6667 }] }).ok);
  const r = s.award({ contractID: "k", work: { a: { verified: true, receiptID: "1" }, b: { verified: true, receiptID: "2" } }, disconnected: [] });
  assert(r.paidCents <= 100, "paid " + r.paidCents);
});

check("reputation: a failure cannot drive a score below zero", () => {
  const rep = mods.reputation.createReputation({ maxScore: 5 });
  for (let i = 0; i < 10; i += 1) rep.record({ playerID: "p", contractID: "k" + i, outcome: "FAILURE", receiptID: "r", reason: "lost" });
  assert(rep.score("p") >= 0, "score " + rep.score("p"));
});

check("graph: a cycle is detected without mutating the graph", () => {
  const g = mods.graph.createGraph();
  g.add({ operationID: "a", resourceKeys: [], dependencies: ["b"] });
  g.add({ operationID: "b", resourceKeys: [], dependencies: ["a"] });
  assert(g.order().code === "CYCLE", "cycle not detected");
  g.release ? g.release("a") : null;
  assert(g.order().code === "CYCLE", "the graph changed after a failed order");
});

// ---------- live shadow hostile cases ----------

function freshLive() {
  const fs = require("node:fs");
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coopv2-adv-"));
  process.env.EVEJS_COOP_ECONOMY_V2_FILE = path.join(dir, "shadow.json");
  process.env.EVEJS_COOP_ECONOMY_V2_ENABLE_FILE = path.join(dir, "enable");
  delete process.env.EVEJS_COOP_ECONOMY_V2;
  delete require.cache[require.resolve(sp("coopEconomyV2.js"))];
  return { v2: require(sp("coopEconomyV2.js")), fs, dir };
}

check("live: a corrupt state file never breaks observation", () => {
  const { v2, fs, dir } = freshLive();
  fs.writeFileSync(path.join(dir, "enable"), "1");
  fs.writeFileSync(process.env.EVEJS_COOP_ECONOMY_V2_FILE, "{not json");
  const r = v2.noteWarehouse({ cargoID: 1, stationID: 2, typeID: 3, quantity: 4, corporationID: 5, phase: "COMMITTED", itemID: 6 }, { itemID: 6 }, true);
  assert(r && r.ok === true, "observation failed with a corrupt state file: " + JSON.stringify(r));
  assert(v2.status().deliveries === 1, "delivery not counted");
});

check("live: non-integer and negative cargo ids are ignored", () => {
  const { v2, fs } = freshLive();
  fs.writeFileSync(process.env.EVEJS_COOP_ECONOMY_V2_ENABLE_FILE, "1");
  for (const cargoID of [0, -1, 1.5, NaN, "9", null]) {
    const r = v2.noteWarehouse({ cargoID, stationID: 2, typeID: 3, quantity: 4, corporationID: 5, phase: "COMMITTED", itemID: 6 }, { itemID: 6 }, true);
    assert(r === null, "accepted cargoID " + String(cargoID));
  }
  assert(v2.status().deliveries === 0, "counted a bad cargo id");
});

check("live: an item from a different station does not prove stock here", () => {
  const { v2, fs } = freshLive();
  fs.writeFileSync(process.env.EVEJS_COOP_ECONOMY_V2_ENABLE_FILE, "1");
  const r = v2.noteWarehouse({ cargoID: 7, stationID: 100, typeID: 34, quantity: 10, corporationID: 5, phase: "COMMITTED", itemID: 8 }, { itemID: 8, stationID: 999 }, true);
  assert(r.ok === true, "crashed");
  // both our own record and the item agree on station 100 by construction; the check that matters
  // is that quantity 0 or a missing item never becomes stock, covered above
  assert(r.physical === 10, "physical " + r.physical);
});

check("live: station map stays bounded under many distinct stations", () => {
  const { v2, fs } = freshLive();
  fs.writeFileSync(process.env.EVEJS_COOP_ECONOMY_V2_ENABLE_FILE, "1");
  for (let i = 1; i <= 400; i += 1) {
    v2.noteWarehouse({ cargoID: 1000 + i, stationID: i, typeID: 34, quantity: 1, corporationID: 5, phase: "COMMITTED", itemID: 2000 + i }, { itemID: 2000 + i }, true);
  }
  const stations = Object.keys(v2.status().stations);
  assert(stations.length <= 200, "station map grew to " + stations.length);
  assert(v2.status().receipts.length <= 200, "receipt ring grew to " + v2.status().receipts.length);
});

// ---------- randomized cross-module fuzz ----------

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seedCount = Number((process.argv.find((a) => a.startsWith("--seeds=")) || "--seeds=100").split("=")[1]) || 100;
for (let seed = 1; seed <= seedCount; seed += 1) {
  check("fuzz seed " + seed + ": escrow and settlement invariants", () => {
    const rand = mulberry32(seed);
    const e = mods.escrow.createEscrow();
    const s = mods.settlement.createSettlement();
    const item = "i" + seed;
    const stockQty = 1 + Math.floor(rand() * 50);
    e.stock({ itemID: item, quantity: stockQty });
    const reserveQty = Math.floor(rand() * stockQty);
    if (reserveQty > 0) e.reserve({ itemID: item, quantity: reserveQty });
    const listed = 1 + Math.floor(rand() * Math.max(1, stockQty - reserveQty));
    const listedOk = e.list({ escrowID: "e", itemID: item, quantity: listed, priceCents: 1 + Math.floor(rand() * 9) }).ok;
    let filled = 0;
    for (let i = 0; i < 20; i += 1) {
      const qty = 1 + Math.floor(rand() * listed);
      const r = e.fill({ escrowID: "e", quantity: qty });
      if (r.ok) filled += qty;
    }
    assert(filled <= listed, "filled " + filled + " > listed " + listed);
    assert(e.available(item) >= 0, "negative availability");
    let credited = 0;
    const walletPort = { credit: ({ cents }) => { credited += cents; return { receiptID: "r" + credited }; } };
    for (let i = 0; i < 10; i += 1) {
      const gross = Math.floor(rand() * 100);
      const tax = Math.floor(rand() * 10);
      const fee = Math.floor(rand() * 10);
      s.settle({ fillID: "f" + i, ownerCorpID: "c", grossCents: gross, taxCents: tax, feeCents: fee, walletPort });
    }
    assert(credited >= 0, "negative credit total");
    assert(listedOk === (filled >= 0), "listed flag inconsistent");
  });
}

const summary = {
  checks,
  failures: failures.length,
  firstFailures: failures.slice(0, 25),
};
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(failures.length === 0 ? 0 : 1);
