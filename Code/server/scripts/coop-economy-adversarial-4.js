"use strict";
// Wave 4 (corrected contracts): phase 0-3 modules.
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
  budget: require(sp("coopEconomyBudgetModel.js")),
  hysteresis: require(sp("coopEconomyHysteresis.js")),
  atp: require(sp("coopEconomyAvailableToPromise.js")),
  feasibility: require(sp("coopEconomyFeasibility.js")),
  comparator: require(sp("coopEconomyPathComparator.js")),
  strategy: require(sp("coopEconomyStrategyState.js")),
  schema: require(sp("coopEconomySnapshotSchema.js")),
  adapter: require(sp("coopEconomySnapshotAdapter.js")),
  receipts: require(sp("coopEconomyDemandReceipts.js")),
  identity: require(sp("coopEconomyIdentityMap.js")),
  workOrder: require(sp("coopEconomyWorkOrder.js")),
  reach: require(sp("coopEconomyReachability.js")),
  flags: require(sp("coopEconomyFlagAudit.js")),
  cap: require(sp("coopEconomyCapabilityIndex.js")),
  manifest: require(sp("coopEconomyWorldManifest.js")),
  baseline: require(sp("coopEconomyBaselineRecorder.js")),
  gap: require(sp("coopEconomyGapReport.js")),
  decisions: require(sp("coopEconomyDecisions.js")),
  registry: require(sp("coopEconomyExecutionRegistry.js")),
  stock: require(sp("coopEconomyStationStockProof.js")),
  custody: require(sp("coopEconomyOreCustody.js")),
  mining: require(sp("coopEconomyMiningDispatch.js")),
  delivery: require(sp("coopEconomyOutputDelivery.js")),
  quarantine: require(sp("coopEconomyQuarantine.js")),
  outcomes: require(sp("coopEconomyNativeOutcomes.js")),
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
assert.throws = (fn, pattern, msg) => {
  try {
    fn();
  } catch (error) {
    assert(!pattern || pattern.test(String(error.message)), (msg || "wrong error") + ": " + error.message);
    return;
  }
  throw new Error((msg || "expected a throw") + " (nothing thrown)");
};

// ---------- phase 1 ----------

check("budget: a negative position is zero spendable, never a negative number", () => {
  const r = m.budget.spendableCash({ walletCents: 0, escrowCents: 0, committedCents: 30, minReserveCents: 20 });
  assert(r.reason !== "OK", "a negative position reported OK");
  assert.equal(r.cashAvailable, 0, "cashAvailable leaked " + r.cashAvailable);
  const ok = m.budget.spendableCash({ walletCents: 100, escrowCents: 10, committedCents: 20, minReserveCents: 30 });
  assert.equal(ok.cashAvailable, 40);
  assert.equal(ok.reason, "OK");
});

check("budget: canSpend is exact at the boundary and rejects nonsense", () => {
  const state = { walletCents: 100, escrowCents: 0, committedCents: 0, minReserveCents: 40 };
  assert.equal(m.budget.canSpend(state, 60), true, "exact boundary refused");
  assert.equal(m.budget.canSpend(state, 61), false, "one cent over allowed");
  for (const bad of [NaN, -1, "60", null, undefined, 1.5]) {
    assert.equal(m.budget.canSpend(state, bad), false, "accepted " + String(bad));
  }
});

check("hysteresis: urgency wins, intent change respects the minimum age", () => {
  const base = { lastIntent: "BUY", nextIntent: "MINE", lastDecisionAt: 1000, now: 2000, minDecisionAgeMs: 500 };
  assert.equal(m.hysteresis.shouldReplan({ ...base, urgency: true }).replan, true);
  assert.equal(m.hysteresis.shouldReplan(base).reason, "REPLAN");
  assert.equal(m.hysteresis.shouldReplan({ ...base, now: 1200 }).reason, "MIN_DECISION_AGE");
  assert.equal(m.hysteresis.shouldReplan({ ...base, nextIntent: "BUY" }).reason, "SAME_INTENT");
  assert.equal(m.hysteresis.shouldReplan({ ...base, now: NaN }).reason, "MIN_DECISION_AGE");
  assert.equal(m.hysteresis.shouldReplan({}).reason, "SAME_INTENT", "an empty call must not replan");
});

check("ATP: available never exceeds on hand minus commitments", () => {
  const r = m.atp.availableToPromise({ onHand: 10, hardCommitted: 4, softReserved: 3, incomingVerified: 5 });
  assert.equal(r.available, 3);
  assert.equal(r.projected, 8);
  assert.equal(m.atp.canReserve({ onHand: 10, hardCommitted: 4, softReserved: 3 }, 3), true);
  assert.equal(m.atp.canReserve({ onHand: 10, hardCommitted: 4, softReserved: 3 }, 4), false);
  const over = m.atp.availableToPromise({ onHand: 2, hardCommitted: 5, softReserved: 5, incomingVerified: -3 });
  assert(over.available === 0 && over.projected >= 0, "negative clamp failed: " + JSON.stringify(over));
});

check("feasibility: every missing term is named and a complete set is feasible", () => {
  const bad = m.feasibility.assessFeasibility({});
  assert.equal(bad.feasible, false);
  assert.deepEqual(bad.reasons, ["BPO_MISSING", "FACILITY_UNAVAILABLE", "NO_JOB_SLOTS"]);
  const partial = m.feasibility.assessFeasibility({ blueprint: { typeID: "35", materials: { 34: 10 } }, materials: { 34: 5 }, jobSlots: 1, facility: { available: true } });
  assert.deepEqual(partial.reasons, ["INSUFFICIENT_MATERIALS"]);
  const good = m.feasibility.assessFeasibility({ blueprint: { typeID: "35", materials: { 34: 10 } }, materials: { 34: 10 }, jobSlots: 1, facility: { available: true } });
  assert.equal(good.feasible, true);
});

check("comparator: deterministic total order, ties stable, input untouched", () => {
  const options = [
    { kind: "BUY", landedCostCents: 10, feasible: true },
    { kind: "MINE", landedCostCents: 5, feasible: true },
    { kind: "REFINE", landedCostCents: 5, feasible: true },
    { kind: "SHIP", landedCostCents: 1, feasible: false },
    { kind: "NOPE", landedCostCents: 2, feasible: true },
    { kind: "BUY", landedCostCents: -1, feasible: true },
  ];
  const snapshot = JSON.stringify(options);
  const r = m.comparator.compareOptions(options);
  assert.equal(JSON.stringify(options), snapshot, "the comparator mutated its input");
  assert.equal(r.ranked.length, 3, "ranked " + r.ranked.length);
  assert(r.ranked[0].landedCostCents <= r.ranked[1].landedCostCents, "not ordered");
  assert.equal(r.best.kind, "MINE", "the tie is not stable: " + r.best.kind);
  assert.equal(r.rejected.length, 3, "rejections " + JSON.stringify(r.rejected));
  const again = m.comparator.compareOptions(options);
  assert.equal(JSON.stringify(again), JSON.stringify(r), "two runs differ");
});

check("strategy: no cash means hold with a reason, and nonsense cannot crash it", () => {
  const broke = m.strategy.chooseIntent({ cashAvailable: 0, onHand: 0, reorderPoint: 5, maxStock: 10 });
  assert.equal(broke.intent, "HOLD");
  assert(broke.reasons.indexOf("INSUFFICIENT_FUNDS") >= 0, "reason " + JSON.stringify(broke.reasons));
  for (const bad of [null, undefined, {}, { cashAvailable: "x", onHand: -5 }]) {
    const r = m.strategy.chooseIntent(bad);
    assert(typeof r.intent === "string", "no intent for " + JSON.stringify(bad));
  }
});

// ---------- phase 0 ----------

check("snapshot: a fresh valid snapshot validates, tampered ones do not", () => {
  const spec = { observedAt: 100, expiresAt: 200, sources: ["warehouse"], itemsByType: { 34: 5 }, incomingByType: {}, reservedByType: {}, stationID: "s1" };
  const snap = m.schema.createSnapshot(spec, { now: 150 });
  assert.equal(m.schema.validateSnapshot(snap, { now: 150 }).ok, true, "fresh snapshot rejected");
  assert.equal(m.schema.validateSnapshot(snap, { now: 300 }).ok, false, "an expired snapshot passed");
  assert.throws(() => m.schema.createSnapshot({ ...spec, itemsByType: { 34: -1 } }, { now: 150 }), /NEGATIVE_QUANTITY|invalid snapshot/);
  assert.throws(() => m.schema.createSnapshot({ ...spec, reservedByType: { 34: 99 } }, { now: 150 }), /CONTRADICTORY|invalid snapshot/);
  assert.equal(m.schema.validateSnapshot(null).ok, false);
});

check("snapshot adapter: an unverified reader is named, and a snapshot is still produced", () => {
  const readers = [
    { id: "warehouse", read: () => ({ items: [{ typeID: "34", quantity: 4 }] }) },
    { id: "market", read: () => { throw new Error("native read failed"); } },
  ];
  const result = m.adapter.buildSnapshot({ readers, now: 5, ttlMs: 1000 });
  assert(result.unverifiedSources.indexOf("market") >= 0, "the failed reader is not named: " + JSON.stringify(result).slice(0, 200));
  assert(result.blockedReasons.indexOf("UNVERIFIED_SOURCE") >= 0, "the snapshot does not declare itself blocked");
  assert.equal(result.sources.length, 1, "a failed reader contributed data");
});

check("receipts: dedupe keeps one per id, first wins, order stable", () => {
  const receipts = [
    { id: "a", typeID: "34", stationID: "s", kind: "BUY", quantity: 1 },
    { id: "b", typeID: "34", stationID: "s", kind: "BUY", quantity: 2 },
    { id: "a", typeID: "34", stationID: "s", kind: "BUY", quantity: 99 },
    { id: "c", typeID: "34", stationID: "s", kind: "BUY", quantity: 3 },
    { quantity: 4 },
  ];
  const r = m.receipts.dedupeReceipts(receipts);
  assert.equal(r.unique.length, 3, "unique " + r.unique.length);
  assert.equal(r.unique.find((x) => x.id === "a").quantity, 1, "a duplicate won");
  assert.deepEqual(r.unique.map((x) => x.id), ["a", "b", "c"], "order changed");
  assert.equal(r.invalid.length, 1, "the receipt without an id was accepted");
});

check("identity: only the physical ledger sources are station stock", () => {
  assert.equal(m.identity.isStationStock("item"), true);
  assert.equal(m.identity.isStationStock("cargo"), false, "ship cargo is not station stock");
  assert.equal(m.identity.isStationStock("depot_receipt"), false, "a depot receipt counted as stock");
  assert.equal(m.identity.isStationStock("corp_wallet"), false);
  assert.equal(m.identity.describeSource("depot_receipt").countsAs, "receipt");
  for (const source of m.identity.LEDGER_SOURCES) {
    assert.equal(typeof source.owner, "string", "source without an owner: " + source.id);
  }
});

check("work order: an illegal transition throws and the input is untouched", () => {
  const wo = { operationID: "op", corpID: "c", phase: "NEED_IDENTIFIED", quantity: 1, resourceKeys: ["k"] };
  const snapshot = JSON.stringify(wo);
  assert.equal(m.workOrder.canTransition("NEED_IDENTIFIED", "PLANNED"), true);
  assert.equal(m.workOrder.canTransition("NEED_IDENTIFIED", "EXECUTING"), false);
  assert.throws(() => m.workOrder.transition(wo, "EXECUTING"), /illegal transition/);
  const planned = m.workOrder.transition(wo, "PLANNED");
  assert.equal(planned.phase, "PLANNED");
  assert.equal(JSON.stringify(wo), snapshot, "transition mutated the input");
  assert.equal(m.workOrder.validateWorkOrder({}).ok, false);
  assert.equal(m.workOrder.validateWorkOrder({ operationID: "op", corpID: "c", phase: "COMPLETED", quantity: 0, resourceKeys: [] }).ok, false, "a zero quantity passed");
});

check("reachability: an orphan module is reported with an absolute directory prefix", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coop-reach-"));
  const space = path.join(dir, "space");
  fs.mkdirSync(space, { recursive: true });
  fs.writeFileSync(path.join(space, "entry.js"), 'require("./a");require("./b");');
  fs.writeFileSync(path.join(space, "a.js"), "module.exports = 1;");
  fs.writeFileSync(path.join(space, "b.js"), "module.exports = 2;");
  fs.writeFileSync(path.join(space, "orphan.js"), "module.exports = 3;");
  const graph = m.reach.buildRequireGraph({ srcRoot: dir, entryFile: path.join(space, "entry.js") });
  const unreachable = m.reach.unreachableModules(graph, [space]);
  assert.equal(unreachable.length, 1, "unreachable " + JSON.stringify(unreachable));
  assert(unreachable[0].indexOf("orphan") >= 0, "wrong module: " + unreachable[0]);
  const conflicts = m.reach.detectIncompatibleExecutors([
    { phase: "manufacture", owner: "a", enabled: true },
    { phase: "manufacture", owner: "b", enabled: "1" },
  ]);
  assert(Array.isArray(conflicts) && conflicts.length === 1, "conflict missed: " + JSON.stringify(conflicts));
});

check("flag audit: a negated read is classified before a plain read", () => {
  const text = "const on = process.env.EVEJS_X !== '1'; const b = process.env.EVEJS_Y === 1; const c = process.env.EVEJS_Z;";
  assert.equal(m.flags.classifyFlagUsage(text, "EVEJS_X").mode, "STRICT_ONE_NEGATED");
  assert.equal(m.flags.classifyFlagUsage(text, "EVEJS_Y").mode, "STRICT_ONE");
  assert.equal(m.flags.classifyFlagUsage(text, "EVEJS_Z").mode, "OTHER");
  assert.equal(m.flags.collectFlags("EVEJS_A EVEJS_A EVEJS_B").length, 2, "collectFlags did not dedupe");
});

check("capability index: every family is represented in the markdown", () => {
  assert(Array.isArray(m.cap.CAPABILITY_FAMILIES) && m.cap.CAPABILITY_FAMILIES.length > 0);
  const index = m.cap.buildCapabilityIndex({ srcRoot: path.join(spaceDir, "..") });
  const markdown = m.cap.toMarkdown(index);
  for (const family of m.cap.CAPABILITY_FAMILIES) {
    const id = typeof family === "string" ? family : family.id || family.name;
    assert(markdown.indexOf(id) >= 0, "family missing from markdown: " + id);
  }
});

check("world manifest: deterministic creation, strict validation, bounded cash", () => {
  const spec = {
    worldSeed: "seed-1",
    stations: [{ stationID: "s1", systemID: 1, corpID: "c1" }],
    corporations: [{ corpID: "c1", cashCents: 1000, homeStationID: "s1" }],
    jobSlots: 2,
  };
  const a = m.manifest.createWorldManifest(spec);
  const b = m.manifest.createWorldManifest(spec);
  assert.equal(JSON.stringify(a), JSON.stringify(b), "creation is not deterministic");
  const validated = m.manifest.validateWorldManifest(a.manifest || a);
  assert.equal(validated.ok, true, "a created manifest does not validate: " + JSON.stringify(validated.errors));
  assert.equal(m.manifest.validateWorldManifest({}).ok, false);
  const rich = m.manifest.createWorldManifest({ ...spec, bootstrapCashCents: m.manifest.MAX_BOOTSTRAP_CASH_CENTS + 1 });
  const richManifest = rich.manifest || rich;
  assert.equal(m.manifest.validateWorldManifest(richManifest).ok, true, "a clamped manifest must validate");
  const richCash = richManifest.bootstrapCashCents === undefined ? richManifest.corporations[0].cashCents : richManifest.bootstrapCashCents;
  assert(richCash <= m.manifest.MAX_BOOTSTRAP_CASH_CENTS, "bootstrap cash exceeded the ceiling: " + richCash);
});

check("baseline recorder: a changed value is detected, an identical one is not", () => {
  const read = (value) => ({ id: "a", read: () => ({ ok: true, value }) });
  const before = m.baseline.recordBaseline({ sources: [read(1)] });
  const same = m.baseline.recordBaseline({ sources: [read(1)] });
  const after = m.baseline.recordBaseline({ sources: [read(2)] });
  assert.equal(m.baseline.compareBaselines(before, same).ok, true, "identical baselines reported a problem");
  const sameEntries = m.baseline.compareBaselines(before, same).entries;
  assert.equal(sameEntries.filter((e) => e.changed !== false && e.status === undefined).length, 0, "identical baselines reported a change: " + JSON.stringify(sameEntries));
  const diff = m.baseline.compareBaselines(before, after);
  assert(diff.entries.length > 0 || diff.ok === false, "a change was missed: " + JSON.stringify(diff));
});

check("gap report: an unreachable stage blocks the verdict", () => {
  const ready = m.gap.buildGapReport({ chain: [{ id: "supply", modules: ["a", "b"] }], present: ["a", "b"], reachable: ["a", "b"] });
  assert.equal(ready.verdict, "READY", JSON.stringify(ready));
  const blocked = m.gap.buildGapReport({ chain: [{ id: "supply", modules: ["a", "b"] }], present: ["a", "b"], reachable: ["a"] });
  assert.equal(blocked.verdict !== "READY", true, "an unreachable stage still read READY: " + JSON.stringify(blocked));
  assert.equal(blocked.stages[0].reachableCount, 1);
});

check("decisions: an open decision or a decided-without-evidence blocks", () => {
  const blocking = m.decisions.blockingDecisions();
  assert(blocking.indexOf("ADR-07") >= 0, "an OPEN decision is not blocking: " + JSON.stringify(blocking));
  assert(blocking.indexOf("ADR-04") >= 0, "a DECIDED decision with no evidence is not blocking");
  assert.equal(m.decisions.isReadyToImplement(), false);
  const decidedWithEvidence = m.decisions.DECISIONS.filter((d) => d.status === "DECIDED" && d.evidence.length > 0);
  assert(decidedWithEvidence.length > 0, "no decision carries evidence at all");
});

// ---------- phase 2-3 ----------

check("registry: one executor per phase, release requires the owner", () => {
  const r = m.registry.createRegistry();
  assert.equal(r.register("manufacture", "a").ok, true);
  assert.equal(r.register("manufacture", "a").code, "ALREADY_OWNER");
  assert.equal(r.register("manufacture", "b").ok, false, "two executors owned one phase");
  assert.equal(r.release("manufacture", "b"), false, "a stranger released the phase");
  assert.equal(r.release("manufacture", "a"), true);
  assert.equal(r.register("manufacture", "b").ok, true);
});

check("station proof: a COMMITTED depot without an item is blocked, a matching item is not", () => {
  const blocked = m.stock.proveStationStock({ stationID: "s", typeID: "34", quantity: 10, arrival: { receiptID: "r" }, warehouseItems: [], depotStatus: "COMMITTED" });
  assert.equal(blocked.code, "NO_PHYSICAL_STOCK");
  const proven = m.stock.proveStationStock({ stationID: "s", typeID: "34", quantity: 10, arrival: { receiptID: "r" }, warehouseItems: [{ stationID: "s", typeID: "34", itemID: "i", quantity: 10 }] });
  assert.equal(proven.code, "STOCK_PROVEN");
});

check("custody: transferring every stack conserves the owner's total", () => {
  const c = m.custody.createCustody();
  c.load({ cargoID: "a", ownerID: "o", holderID: "h1", typeID: "34", quantity: 5 });
  c.load({ cargoID: "b", ownerID: "o", holderID: "h1", typeID: "34", quantity: 7 });
  const before = c.ownerTotal("o");
  c.transfer({ cargoID: "a", toHolderID: "h2" });
  c.transfer({ cargoID: "b", toHolderID: "h2" });
  assert.equal(c.ownerTotal("o"), before, "ownership total changed on custody moves");
  assert.equal(c.totalQuantity(), 12);
});

check("mining dispatch: a busy hull is skipped and the port is called once", () => {
  let calls = 0;
  const result = m.mining.dispatchMining({
    need: { typeID: "34", quantity: 100 },
    fleet: [
      { hullID: "h1", capacity: 500, busy: true },
      { hullID: "h2", capacity: 500, busy: false },
    ],
    miningPort: { dispatch: () => { calls += 1; return { receiptID: "r" }; } },
  });
  assert.equal(calls, 1, "dispatch calls " + calls);
  assert.equal(result.operationID, "mine:h2:34:100", "wrong hull chosen: " + result.operationID);
});

check("delivery: a readback for another job is not readiness", () => {
  const d = m.delivery.createOutputDelivery();
  const r = d.deliver({
    job: { jobID: "j1", productTypeID: "35", quantity: 1, readyFlag: true },
    readback: { jobID: "j2", completed: true, readyAt: 1 },
    itemStore: { issue: () => ({ itemID: "i" }) },
  });
  assert.equal(r.ok, false, "a foreign readback minted an item: " + JSON.stringify(r));
  assert.equal(r.code, "NOT_READY");
  const own = d.deliver({
    job: { jobID: "j1", productTypeID: "35", quantity: 1, readyFlag: true },
    readback: { jobID: "j1", completed: true, readyAt: 1 },
    itemStore: { issue: () => ({ itemID: "i" }) },
  });
  assert.equal(own.ok, true, "the matching readback failed: " + JSON.stringify(own));
});

check("quarantine: re-quarantine replaces and evidence is mandatory to clear", () => {
  const q = m.quarantine.createQuarantine();
  q.quarantine({ operationID: "op", resourceKeys: ["i1"], reason: "ACK_LOST" });
  const replaced = q.quarantine({ operationID: "op", resourceKeys: ["i2"], reason: "ACK_LOST" });
  assert.equal(replaced.replaced, true, "re-quarantine did not replace");
  assert.equal(q.isBlocked("i1"), false, "the old key stayed blocked");
  assert.equal(q.isBlocked("i2"), true);
  assert.equal(q.resolve("op", "").code, "EVIDENCE_REQUIRED");
  assert.equal(q.isBlocked("i2"), true, "resolved without evidence");
});

check("outcomes: readback mismatch and unknown errors never become success", () => {
  assert.equal(m.outcomes.classifyOutcome({ receipt: { receiptID: "a" }, readBack: { receiptID: "b" } }).outcome, "UNKNOWN");
  assert.equal(m.outcomes.classifyOutcome({}).outcome, "NOT_STARTED");
  assert.equal(m.outcomes.classifyOutcome({ threw: true, errorCode: "REFUSED" }).outcome, "NOT_STARTED");
  assert.equal(m.outcomes.classifyOutcome({ threw: true, errorCode: "TIMEOUT" }).outcome, "UNKNOWN");
  assert.equal(m.outcomes.classifyOutcome({ receipt: { receiptID: "a" } }).outcome, "COMMITTED");
});

const summary = { checks, failures: failures.length, details: failures };
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(failures.length === 0 ? 0 : 1);
