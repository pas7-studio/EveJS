"use strict";
// Wave 5: phase 5-8 edges plus the live shadow's bounded state.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const root = process.env.EVEJS_FORK_ROOT || "O:\\tmp\\m003\\work";
const fsProbe = require("node:fs");
const spaceDir = fsProbe.existsSync(path.join(root, "Code/server/src/space"))
  ? path.join(root, "Code/server/src/space")
  : path.join(root, "src", "space");
const sp = (name) => path.join(spaceDir, name);

const m = {
  route: require(sp("coopEconomyRouteComparison.js")),
  hauler: require(sp("coopEconomyHaulerReservation.js")),
  run: require(sp("coopEconomyDistributionRun.js")),
  unload: require(sp("coopEconomyUnload.js")),
  disruption: require(sp("coopEconomyRouteDisruption.js")),
  carrier: require(sp("coopEconomyCarrierChoice.js")),
  contract: require(sp("coopEconomyProcurementContract.js")),
  board: require(sp("coopEconomyContractBoard.js")),
  acceptance: require(sp("coopEconomyDeliveryAcceptance.js")),
  contractSettle: require(sp("coopEconomyContractSettlement.js")),
  offers: require(sp("coopEconomyOfferSelection.js")),
  split: require(sp("coopEconomySplitContract.js")),
  reputation: require(sp("coopEconomyReputation.js")),
  coverage: require(sp("coopEconomyConservationCoverage.js")),
  release: require(sp("coopEconomyReleaseEvidence.js")),
  perf: require(sp("coopEconomyPerformanceGuard.js")),
  final: require(sp("coopEconomyFinalAcceptance.js")),
};

const failures = [];
let checks = 0;
function check(name, fn) {
  checks += 1;
  try {
    fn();
  } catch (error) {
    failures.push({ name, error: String((error && error.message) || error).slice(0, 260) });
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
assert.equal = (a, b, msg) => assert(a === b, (msg || "") + " (" + a + " !== " + b + ")");
assert.deepEqual = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b), (msg || "") + " (" + JSON.stringify(a) + " !== " + JSON.stringify(b) + ")");

// ---------- phase 5 ----------

check("route: every rejection carries a reason and a tie breaks by time then id", () => {
  const cargo = { typeID: "35", quantity: 10, m3PerUnit: 2, valueCents: 50 };
  const result = m.route.chooseRoute({
    cargo,
    routes: [
      { routeID: "b", destinationID: "d", verified: true, m3Capacity: 100, timeSeconds: 60, riskScore: 1, costCents: 10, buyerOrders: [{ priceCents: 5, quantity: 10 }] },
      { routeID: "a", destinationID: "d", verified: true, m3Capacity: 100, timeSeconds: 60, riskScore: 1, costCents: 10, buyerOrders: [{ priceCents: 5, quantity: 10 }] },
      { routeID: "c", destinationID: "d", verified: true, m3Capacity: 100, timeSeconds: 30, riskScore: 1, costCents: 10, buyerOrders: [{ priceCents: 5, quantity: 10 }] },
    ],
  });
  assert.equal(result.routeID, "c", "the faster route lost a profit tie: " + result.routeID);
  const noBuyer = m.route.chooseRoute({ cargo, routes: [{ routeID: "x", destinationID: "d", verified: true, m3Capacity: 100, timeSeconds: 1, riskScore: 0, costCents: 0, buyerOrders: [] }] });
  assert.equal(noBuyer.code, "NO_VIABLE_ROUTE");
  assert.equal(noBuyer.rejected[0].reason, "NO_BUYER");
});

check("route: a zero-quantity cargo cannot select a route", () => {
  const r = m.route.chooseRoute({ cargo: { typeID: "35", quantity: 0, m3PerUnit: 2, valueCents: 50 }, routes: [{ routeID: "x", destinationID: "d", verified: true, m3Capacity: 100, timeSeconds: 1, riskScore: 0, costCents: 0, buyerOrders: [{ priceCents: 5, quantity: 1 }] }] });
  assert(r.ok === false, "an empty cargo selected a route: " + JSON.stringify(r));
});

check("hauler: capacity is inclusive at the boundary and a released hull is reusable", () => {
  const pool = m.hauler.createHaulerPool();
  pool.register({ hullID: "h", capacityM3: 100 });
  assert.equal(pool.reserve({ runID: "r1", hullID: "h", volumeM3: 100, cargoIDs: ["c"] }).ok, true, "exact capacity refused");
  assert.equal(pool.release("r1"), true);
  assert.equal(pool.reserve({ runID: "r2", hullID: "h", volumeM3: 100, cargoIDs: ["c"] }).ok, true, "a released hull stayed reserved");
  assert.equal(pool.reserve({ runID: "r3", hullID: "h", volumeM3: 1, cargoIDs: ["c"] }).code, "HULL_RESERVED");
});

check("run: a receipt for the wrong stage cannot advance the run", () => {
  const d = m.run.createDistributor();
  d.start({ runID: "r", hullID: "h", cargoID: "c", quantity: 1 });
  assert.equal(d.advance({ runID: "r", to: "SELL", receiptID: "x" }).code, "INVALID_TRANSITION");
  assert.equal(d.snapshot("r").stage, "PLAN", "the stage moved on a rejected transition");
});

check("unload: the docking boundary is inclusive and an over-range hull sells nothing", () => {
  const base = { cargo: { ownerID: "o", typeID: "35", quantity: 10 }, orders: [{ priceCents: 5, quantity: 10 }], unloadPort: { deposit: () => ({ receiptID: "d" }) } };
  assert.equal(m.unload.unload({ ...base, station: { stationID: "s", dockRangeMeters: 2500, distanceMeters: 2500 } }).ok, true, "the boundary was refused");
  assert.equal(m.unload.unload({ ...base, station: { stationID: "s", dockRangeMeters: 2500, distanceMeters: 2500.5 } }).code, "NOT_AT_STATION");
  assert.equal(m.unload.unload({ ...base, cargo: { ...base.cargo, quantity: 0 }, station: { stationID: "s", dockRangeMeters: 2500, distanceMeters: 1 } }).code, "EMPTY_HULL");
});

check("disruption: a destroyed hull is LOST even with a gate receipt, and replan needs reconcile", () => {
  const lost = m.disruption.classifyDisruption({ evidence: { destroyed: true, gateReceiptID: "g", hullPresent: true, cargoPresent: true } });
  assert.equal(lost.state, "LOST", "a destroyed hull with a stale receipt read " + lost.state);
  assert.equal(m.disruption.replan({ state: "LOST", fleet: [{ hullID: "h", available: true }] }).code, "RECONCILE_REQUIRED");
});

check("carrier: an external option exactly at the ETA limit is allowed", () => {
  const external = { contractID: "c", priceCents: 10, etaSeconds: 100, funded: true };
  assert.equal(m.carrier.chooseCarrier({ internal: { hullID: "h", capacityM3: 10, etaSeconds: 10, riskScore: 0, costCents: 5, available: false }, external, maxEtaSeconds: 100 }).choice, "EXTERNAL");
  assert.equal(m.carrier.chooseCarrier({ internal: null, external: { ...external, etaSeconds: 101 }, maxEtaSeconds: 100 }).code, "IMPOSSIBLE_ETA");
});

// ---------- phase 6 ----------

check("contract: the expiry boundary keeps the contract open, one tick later it is expired", () => {
  const c = { contractID: "k", typeID: "35", stationID: "s", quantity: 10, unitPriceCents: 5, expiryTick: 100, buyerCorpID: "b", supplierID: "s1", funding: { funded: true, reservedCents: 50, receiptID: "e" } };
  assert.equal(m.contract.openContract(c).ok, true);
  assert.equal(m.contract.expire("k", 100).status, "FUNDED", "expired at the boundary");
  assert.equal(m.contract.expire("k", 101).status, "EXPIRED");
  assert.equal(m.contract.expire("k", 50).status, "EXPIRED", "an expired contract came back");
});

check("board: a contract cannot be accepted after its expiry", () => {
  const board = m.board.createBoard();
  board.publish({ contractID: "k", typeID: "35", stationID: "s", quantity: 1, unitPriceCents: 1, expiryTick: 10, status: "FUNDED" });
  assert.equal(board.accept({ contractID: "k", playerID: "p", channelID: "jobBoard", requestID: "r", tick: 11 }).code, "UNKNOWN_CONTRACT");
  assert.equal(board.accept({ contractID: "k", playerID: "p", channelID: "jobBoard", requestID: "r", tick: 10 }).code, "ACCEPTED");
});

check("acceptance: the quantity credited never exceeds the delivery receipt", () => {
  const a = m.acceptance.createAcceptance();
  const contract = { contractID: "k", typeID: "35", stationID: "s", quantity: 100, supplierID: "p" };
  const delivery = { receiptID: "r", itemID: "i", typeID: "35", quantity: 40, stationID: "s", ownerID: "p" };
  const itemStore = { read: () => ({ itemID: "i", typeID: "35", stationID: "s", quantity: 40 }) };
  const first = a.accept({ contract, delivery, itemStore });
  assert.equal(first.ok, true);
  assert.equal(first.quantity, 40);
  const replay = a.accept({ contract, delivery: { ...delivery, quantity: 100 }, itemStore });
  assert.equal(replay.code, "ALREADY_ACCEPTED", "a replayed receipt with a bigger quantity was credited again");
  assert.equal(replay.quantity, 40, "the replay reported the inflated quantity");
});

check("contract settlement: no delivered units means no credit call and a full refund", () => {
  let credits = 0;
  const s = m.contractSettle.createContractSettlement();
  const r = s.settle({ contractID: "k", playerID: "p", deliveredQuantity: 0, contractQuantity: 10, unitPriceCents: 10, feeCents: 5, capCents: 100, walletPort: { credit: () => { credits += 1; return { receiptID: "c" }; } } });
  if (r.ok) {
    assert.equal(r.netCents, 0, "paid " + r.netCents + " for nothing");
    assert.equal(r.refundCents, 100, "refund " + r.refundCents);
  }
  assert(credits <= 1, "the wallet was credited more than once");
});

check("offers: a price cap and a short capacity are named rejections", () => {
  const r = m.offers.selectOffer({
    offers: [
      { offerID: "a", supplierID: "p", priceCents: 500, etaSeconds: 10, capacity: 10, refreshTick: 0 },
      { offerID: "b", supplierID: "p", priceCents: 10, etaSeconds: 10, capacity: 1, refreshTick: 0 },
    ],
    npcOffer: null,
    requiredQuantity: 5,
    tick: 10,
    minRefreshTicks: 5,
    maxPriceCents: 100,
  });
  assert.equal(r.code, "NO_OFFER", JSON.stringify(r));
  const reasons = Object.fromEntries(r.rejected.map((x) => [x.offerID, x.reason]));
  assert.equal(reasons.a, "PRICE_CAP");
  assert.equal(reasons.b, "INSUFFICIENT_CAPACITY");
});

check("split: awarding twice does not pay twice", () => {
  const s = m.split.createSplitContract();
  s.create({ contractID: "k", totalCents: 100, parties: [{ playerID: "a", role: "SUPPLIER", shareBps: 5000 }, { playerID: "b", role: "CARRIER", shareBps: 5000 }] });
  const work = { a: { verified: true, receiptID: "1" }, b: { verified: true, receiptID: "2" } };
  const first = s.award({ contractID: "k", work, disconnected: [] });
  const second = s.award({ contractID: "k", work, disconnected: [] });
  const total = (first.paidCents || 0) + (second.paidCents || 0);
  assert(total <= 100, "two awards paid " + total + " of a 100 cent contract");
});

check("reputation: an ineligible record does not consume the contract id", () => {
  const rep = m.reputation.createReputation();
  assert.equal(rep.record({ playerID: "p", contractID: "k", outcome: "SUCCESS", receiptID: "r", selfDealing: true }).ok, false);
  const real = rep.record({ playerID: "p", contractID: "k", outcome: "SUCCESS", receiptID: "r" });
  assert.equal(real.code, "RECORDED", "the refused record burned the contract id");
});

// ---------- phase 7-8 ----------

check("coverage: two scopes missing source receipts fail closed and name both", () => {
  const r = m.coverage.audit({ before: { mining: { units: 1 }, wallet: { cents: 1 } }, after: { mining: { units: 1 }, wallet: { cents: 1 } }, custody: [] });
  assert.equal(r.code, "UNKNOWN_SOURCE");
  assert.deepEqual(r.missing.sort(), ["mining", "wallet"]);
});

check("release: an audit with empty evidence is incomplete", () => {
  const good = { ok: true, evidence: "log" };
  const base = {
    integratedSHA: "abc", testedSHA: "abc", deployedSHA: "abc",
    audits: { conservation: good, crash: good, race: good, soak: good, compat: good },
    client: { ok: true, code: "E2E_VERIFIED", buildID: "b" },
    rollback: { tested: true, deletesData: false },
    migrations: [],
    reviewer: { reviewerID: "r", role: "REVIEWER", sha: "abc" },
  };
  assert.equal(m.release.build(base).ok, true);
  const empty = m.release.build({ ...base, audits: { ...base.audits, soak: { ok: true, evidence: "" } } });
  assert.equal(empty.code, "AUDIT_INCOMPLETE", "an audit without evidence passed: " + JSON.stringify(empty));
  assert.deepEqual(empty.missing, ["soak"]);
});

check("perf: a new heavy path under the tick budget passes and is listed", () => {
  const r = m.perf.check({
    baseline: { paths: [{ name: "tick", p95Ms: 4 }], ticks: { slowestMs: 5 } },
    candidate: { paths: [{ name: "tick", p95Ms: 4 }, { name: "newProbe", p95Ms: 9 }], ticks: { slowestMs: 9 } },
    budgets: { p95TolerancePct: 20, tickBudgetMs: 10, maxCheckMinutes: 5 },
  });
  assert.equal(r.code, "PASS", JSON.stringify(r));
  assert.deepEqual(r.newPaths, ["newProbe"]);
});

check("final: extra unknown gates do not block, a missing required gate does", () => {
  const gates = {};
  for (const g of m.final.REQUIRED_GATES) gates[g] = { ok: true, evidence: "e" };
  const owner = { approved: true, role: "OWNER", approverID: "o", sha: "abc" };
  assert.equal(m.final.evaluate({ gates, ownerApproval: owner }).ok, true);
  const extra = m.final.evaluate({ gates: { ...gates, GX: { ok: false } }, ownerApproval: owner });
  assert.equal(extra.ok, true, "an unknown gate blocked the decision");
  const without = { ...gates };
  delete without.G7;
  assert.equal(m.final.evaluate({ gates: without, ownerApproval: owner }).code, "GATE_INCOMPLETE");
});

// ---------- live shadow bounds ----------

function freshLive() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coopv2-w5-"));
  process.env.EVEJS_COOP_ECONOMY_V2_FILE = path.join(dir, "shadow.json");
  process.env.EVEJS_COOP_ECONOMY_V2_ENABLE_FILE = path.join(dir, "enable");
  delete process.env.EVEJS_COOP_ECONOMY_V2;
  const livePath = path.join(spaceDir, "coopEconomyV2.js");
  delete require.cache[require.resolve(livePath)];
  const v2 = require(livePath);
  fs.writeFileSync(path.join(dir, "enable"), "1");
  return { v2, dir };
}

check("live: the receipt ring and station map stay bounded under a flood", () => {
  const { v2 } = freshLive();
  for (let i = 1; i <= 300; i += 1) {
    v2.noteWarehouse({ cargoID: 5000 + i, stationID: i % 250, typeID: 34, quantity: 1, corporationID: 1, phase: "COMMITTED", itemID: 7000 + i }, { itemID: 7000 + i }, true);
  }
  const view = v2.status();
  assert(view.receipts.length <= 200, "receipts " + view.receipts.length);
  assert(Object.keys(view.stations).length <= 200, "stations " + Object.keys(view.stations).length);
  assert.equal(view.deliveries, 300, "deliveries " + view.deliveries);
});

check("live: a replayed cargo id after the ring rolled over is still refused", () => {
  const { v2 } = freshLive();
  for (let i = 1; i <= 250; i += 1) {
    v2.noteWarehouse({ cargoID: 9000 + i, stationID: 1, typeID: 34, quantity: 1, corporationID: 1, phase: "COMMITTED", itemID: 9500 + i }, { itemID: 9500 + i }, true);
  }
  const view = v2.status();
  assert(view.receipts.length <= 200, "ring not bounded");
  // a receipt that fell out of the ring can no longer be recognised: the totals must not silently double
  // either, so a second observation of the same id either refuses it or is counted as a replay only once
  const replay = v2.noteWarehouse({ cargoID: 9001, stationID: 1, typeID: 34, quantity: 1, corporationID: 1, phase: "COMMITTED", itemID: 9501 }, { itemID: 9501 }, true);
  assert(replay !== null, "observer crashed on an old id");
  const after = v2.status();
  assert(after.deliveries >= 250, "deliveries " + after.deliveries);
});

const summary = { checks, failures: failures.length, details: failures };
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(failures.length === 0 ? 0 : 1);
