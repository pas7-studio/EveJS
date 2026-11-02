"use strict";
// Wave 6: the eight modules waves 1-5 never exercised.
const path = require("node:path");
const fs = require("node:fs");
const root = process.env.EVEJS_FORK_ROOT || "O:\\tmp\\m003\\work";
const spaceDir = fs.existsSync(path.join(root, "Code/server/src/space"))
  ? path.join(root, "Code/server/src/space")
  : path.join(root, "src", "space");
const sp = (name) => path.join(spaceDir, name);

const m = {
  revalidate: require(sp("coopEconomyRevalidate.js")),
  live: require(sp("coopEconomyLiveReadiness.js")),
  recovery: require(sp("coopEconomyRecovery.js")),
  scorecard: require(sp("coopEconomyAutonomyScorecard.js")),
  conservation: require(sp("coopEconomyConservationAudit.js")),
  destination: require(sp("coopEconomyDestination.js")),
  repair: require(sp("coopEconomyRepairConsole.js")),
  e2e: require(sp("coopEconomyClientE2E.js")),
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
assert.equal = (a, b, msg) => assert(a === b, (msg || "") + " (" + String(a) + " !== " + String(b) + ")");
assert.ok = (cond, message) => assert(cond, message);
assert.deepEqual = (a, b, msg) => assert(JSON.stringify(a) === JSON.stringify(b),
  (msg || "") + " (" + JSON.stringify(a) + " !== " + JSON.stringify(b) + ")");

// A comparison gate that is handed null must say "changed", not throw: every caller of
// revalidate is a guard that must fail closed on a missing side of the comparison.
check("revalidate: a null side fails closed instead of throwing", () => {
  assert.equal(m.revalidate.revalidate({ before: null, after: { owner: 1 } }).ok, false, "null before passed");
  assert.equal(m.revalidate.revalidate({ before: { owner: 1 }, after: null }).ok, false, "null after passed");
  assert.equal(m.revalidate.revalidate({}).ok, false, "an empty comparison passed");
  const same = m.revalidate.revalidate({ before: { owner: 1, hullID: "h" }, after: { owner: 1, hullID: "h" } });
  assert.equal(same.ok, true, "identical state reported a change");
  const moved = m.revalidate.revalidate({ before: { owner: 1, location: 5 }, after: { owner: 1, location: 6 } });
  assert.equal(moved.ok, false);
  assert.deepEqual(moved.changed, ["location"]);
  assert.deepEqual(moved.codes, ["LOCATION_CHANGED"]);
});

check("revalidate: a custom field list is honoured and a nonsense list cannot crash", () => {
  const r = m.revalidate.revalidate({
    before: { walletCents: 10, owner: 1 },
    after: { walletCents: 11, owner: 2 },
    fields: ["walletCents"],
  });
  assert.deepEqual(r.changed, ["walletCents"], "the custom field list was ignored");
  assert.equal(r.ok, false);
  const empty = m.revalidate.revalidate({ before: { a: 1 }, after: { a: 1 }, fields: [] });
  assert.equal(empty.ok, true, "no fields compared must be no change");
});

// An attestation is evidence about a specific module. One that names nobody must not
// promote an anonymous binding: the whole point of the gate is that live needs identity.
check("live readiness: an attestation that names no module cannot promote it", () => {
  const anonymous = m.live.assessLiveReadiness({
    binding: { supportsLiveRuntime: true },
    attestation: { reviewedBy: "someone", reviewSHA: "abc" },
  });
  assert.equal(anonymous.live, false, "an anonymous attestation promoted an anonymous binding");
  const manual = m.live.assessLiveReadiness({ binding: { id: "x", supportsLiveRuntime: false } });
  assert.equal(manual.code, "MANUAL_ONLY", "a manual module was not MANUAL_ONLY");
  assert.equal(m.live.assessLiveReadiness({}).live, false, "an empty call went live");
  const real = m.live.assessLiveReadiness({
    binding: { id: "coopEconomyV2", supportsLiveRuntime: true },
    attestation: { id: "coopEconomyV2", reviewedBy: "owner", reviewSHA: "c08736d" },
  });
  assert.equal(real.live, true, "a complete attestation was refused: " + JSON.stringify(real));
  const wrongId = m.live.assessLiveReadiness({
    binding: { id: "coopEconomyV2", supportsLiveRuntime: true },
    attestation: { id: "somethingElse", reviewedBy: "owner", reviewSHA: "c08736d" },
  });
  assert.equal(wrongId.live, false, "an attestation for another module promoted this one");
  const blank = m.live.assessLiveReadiness({
    binding: { id: "coopEconomyV2", supportsLiveRuntime: true },
    attestation: { id: "coopEconomyV2", reviewedBy: "   ", reviewSHA: "   " },
  });
  assert.equal(blank.live, false, "whitespace counted as a review");
});

// Capital recovery may sell assets, never mint money and never sell escrow.
check("recovery: money is never minted and escrow is never sold", () => {
  const assets = [
    { itemID: "i1", quantity: 10, unitValueCents: 10 },
    { itemID: "i2", quantity: 100, unitValueCents: 1000, escrowed: true },
    { itemID: "i3", quantity: 5, unitValueCents: 20, escrowed: true },
  ];
  const plan = m.recovery.buildRecoveryPlan({
    walletCents: 100, commitmentsCents: 500, escrowClaimsCents: 200, assets,
  });
  assert.equal(plan.mintedCents, 0, "the recovery plan minted money");
  assert.equal(plan.sellableCents === undefined ? 100 : plan.sellableCents, 100, "sellable " + plan.sellableCents);
  assert.ok((plan.sellCents || 0) <= 100, "the plan sold " + plan.sellCents + " of a 100 cent holding");
  assert.equal(plan.preservedEscrowCents, 200 + 100000 + 100, "escrow value was not preserved");
  const rich = m.recovery.buildRecoveryPlan({ walletCents: 1000, commitmentsCents: 1, escrowClaimsCents: 0, assets: [] });
  assert.equal(rich.code, "NOT_DISTRESSED");
  assert.equal(rich.mintedCents, 0);
  // a negative or fractional quantity is a corrupt row, not a discount
  for (const bad of [-1, 1.5, "10", NaN]) {
    const r = m.recovery.buildRecoveryPlan({
      walletCents: 0, commitmentsCents: 10, escrowClaimsCents: 0,
      assets: [{ itemID: "i", quantity: bad, unitValueCents: 10 }],
    });
    assert.equal(r.ok, false, "a corrupt quantity " + String(bad) + " produced a plan");
  }
});

// A rescue is never autonomous, and work an author really did must be visible as that author.
check("autonomy scorecard: a rescue is never autonomous and deepseek's own work is attributed", () => {
  const events = [
    { taskID: "IE-001", kind: "PRODUCTION", actor: "ornith-a", loc: 100, accepted: true },
    { taskID: "IE-002", kind: "PRODUCTION", actor: "ornith-a", loc: 50, accepted: true },
    { taskID: "IE-002", kind: "RESCUE", actor: "deepseek", loc: 20, accepted: true },
    { taskID: "IE-003", kind: "PRODUCTION", actor: "deepseek", loc: 30, accepted: true },
  ];
  const card = m.scorecard.buildScorecard({ events });
  assert.equal(card.ok, true, JSON.stringify(card));
  assert.equal(card.autonomousVerifiedTasks, 1, "a rescued task counted as autonomous: " + card.autonomousVerifiedTasks);
  assert.equal(card.rescuedTasks, 1);
  assert.equal(card.deepseekRescueLOC, 20);
  const authors = Object.fromEntries(card.files.map((f) => [f.taskID, f.author]));
  assert.equal(authors["IE-003"], "deepseek", "deepseek's own accepted work is missing from the ledger");
  assert.equal(authors["IE-001"], "ornith");
  assert.equal(m.scorecard.buildScorecard({ events: [{ taskID: "x", kind: "PRODUCTION", actor: "nobody", accepted: true }] }).code, "UNATTRIBUTED");
  assert.equal(m.scorecard.buildScorecard({ events: [] }).autonomousVerifiedTasks, 0);
});

// The conservation audit is the gate that decides whether the economy added or lost goods.
check("conservation audit: a receipt without its claim, and an unbacked claim, are both issues", () => {
  const orphanReceipt = m.conservation.auditEconomyEvidence({
    nativeItems: [],
    rustClaims: [],
    gameStoreReceipts: [{ claimKey: "k1", fillID: 1, itemID: 2, ownerID: 3, typeID: 4, quantity: 5 }],
  });
  const text = JSON.stringify(orphanReceipt);
  assert(text.includes("GAMESTORE_RECEIPT_WITHOUT_RUST_CLAIM"), "an unattested receipt was accepted: " + text.slice(0, 240));
  const filledWithout = m.conservation.auditEconomyEvidence({
    nativeItems: [{ itemID: 2, typeID: 4, ownerID: 3, locationID: 6, quantity: 5 }],
    rustClaims: [{ claimKey: "k2", fillID: 9, orderID: 8, state: "filled" }],
    gameStoreReceipts: [],
  });
  assert(JSON.stringify(filledWithout).includes("RUST_FILLED_WITHOUT_NATIVE_RECEIPT"),
    "a filled claim without a native receipt was accepted");
  const clean = m.conservation.auditEconomyEvidence({
    nativeItems: [{ itemID: 2, typeID: 4, ownerID: 3, locationID: 6, quantity: 5 }],
    rustClaims: [{ claimKey: "k3", fillID: 7, orderID: 8, state: "filled" }],
    gameStoreReceipts: [{ claimKey: "k3", fillID: 7, itemID: 2, ownerID: 3, typeID: 4, quantity: 5, orderID: 8, locationID: 6 }],
  });
  assert.deepEqual((clean.issues || []).filter((i) => i.severity !== "INFO"), [], "a clean set raised issues: " + JSON.stringify(clean.issues).slice(0, 240));
});

check("destination: a negative price or a zero book never wins a sale", () => {
  const books = {
    34: { buys: [
      { order_id: 1, station_id: 600, price: -500, vol_remaining: 1000 },
      { order_id: 2, station_id: 600, price: 5, vol_remaining: 10 },
      { order_id: 3, station_id: 600, price: 9, vol_remaining: 0 },
    ] },
  };
  const best = m.destination.bestBuyAt(books[34], 600);
  assert.equal(best.price, 5, "a negative price or an empty book won: " + JSON.stringify(best));
  const ranked = m.destination.rankStations({
    cargo: [{ typeID: 34, quantity: 10 }],
    candidates: [{ stationID: 600 }, { stationID: 601 }],
    books,
  });
  const list = ranked.ranked || ranked;
  assert(Array.isArray(list) && list.length >= 1, "nothing ranked: " + JSON.stringify(ranked).slice(0, 200));
  assert.equal(list[0].stationID, 600, "the station that can pay was not first");
  const empty = m.destination.rankStations({ cargo: [], candidates: [{ stationID: 600 }], books });
  assert.deepEqual((empty.ranked || empty), [], "an empty hold still ranked a destination");
});

check("repair console: an action names its operation and health follows the operation", () => {
  for (const choice of m.repair.SAFE_CHOICES) {
    const nameless = m.repair.act({ choice, evidence: "readback" });
    assert.equal(nameless.ok, false, "a " + choice + " without operationID was accepted");
  }
  const real = m.repair.act({ choice: "RECONCILE", operationID: "op-1", evidence: "readback 42" });
  assert.equal(real.ok, true, "a complete action was refused: " + JSON.stringify(real));
  assert.equal(m.repair.act({ choice: "DROP_TABLE", operationID: "op-1" }).code, "UNSAFE_CHOICE");
  assert.equal(m.repair.act({ choice: "RECONCILE", operationID: "op-1", evidence: "   " }).code, "EVIDENCE_REQUIRED",
    "whitespace counted as evidence");
  // a journal with a receipt is not health: the operation in it may be failed
  const failed = m.repair.isHealthy({ journal: [{ step: 1, receiptID: "r1" }], operation: { state: "FAILED" } });
  assert.equal(failed, false, "a failed operation reported healthy");
  const view = m.repair.view({ operation: { state: "FAILED" }, journal: [{ step: 1, receiptID: "r1" }] });
  assert.equal(view.healthy, false, "view and isHealthy disagree");
  assert.equal(m.repair.isHealthy({ journal: [] }), false, "an empty journal reported healthy");
});

check("client e2e: a simulation can never stand in for a pinned client", () => {
  for (const client of [
    null,
    { kind: "eve-pinned-client", buildID: "b", sha256: "abc", twoAccounts: true },
    { kind: "eve-pinned-client", buildID: "b", sha256: "a".repeat(64), twoAccounts: false },
    { kind: "simulated", buildID: "b", sha256: "a".repeat(64), twoAccounts: true },
  ]) {
    const r = m.e2e.verifyE2E({ client });
    assert.equal(r.ok, false, "a bad client passed: " + JSON.stringify(client));
    assert.equal(r.simulated, false, "a refused run claimed to be simulated evidence");
  }
  const noReceipts = m.e2e.verifyE2E({
    client: { kind: "eve-pinned-client", buildID: "b", sha256: "a".repeat(64), twoAccounts: true },
    players: [{ playerID: "p1" }, { playerID: "p2" }],
    ui: {}, market: {}, inventory: {}, wallet: {},
    receipts: [],
  });
  assert.equal(noReceipts.ok, false);
  assert.equal(noReceipts.code, "RECEIPT_MISSING", "an empty receipt list was not REFUSED: " + JSON.stringify(noReceipts));
  // notRun() is the honest "no evidence was produced", distinct from a failed verification
  assert.equal(m.e2e.notRun("no pinned client").code, m.e2e.E2E_CODE.NOT_RUN);
});

const summary = { checks, failures: failures.length, details: failures };
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(failures.length === 0 ? 0 : 1);
