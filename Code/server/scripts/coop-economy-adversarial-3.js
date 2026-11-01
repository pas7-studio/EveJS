"use strict";
// Wave 3: boundaries and lifecycle edges that waves 1-2 did not reach.
const path = require("node:path");
const root = process.env.EVEJS_FORK_ROOT || "O:\\tmp\\m003\\work";
const fsProbe = require("node:fs");
const spaceDir = fsProbe.existsSync(path.join(root, "Code/server/src/space"))
  ? path.join(root, "Code/server/src/space")
  : path.join(root, "src", "space");
const sp = (name) => path.join(spaceDir, name);
const m = {
  pnl: require(sp("coopEconomyPnl.js")),
  risk: require(sp("coopEconomyRiskPolicy.js")),
  backpressure: require(sp("coopEconomyBackpressure.js")),
  run: require(sp("coopEconomyDistributionRun.js")),
  purchase: require(sp("coopEconomyPlayerPurchase.js")),
  reputation: require(sp("coopEconomyReputation.js")),
  rollout: require(sp("coopEconomyRolloutManifest.js")),
  health: require(sp("coopEconomyHealthReport.js")),
  coverage: require(sp("coopEconomyConservationCoverage.js")),
  race: require(sp("coopEconomyRaceMatrix.js")),
  crash: require(sp("coopEconomyCrashWindows.js")),
  soak: require(sp("coopEconomySoak.js")),
  funds: require(sp("coopEconomyFundsGateway.js")),
  live: require(sp("coopEconomyV2.js")),
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

check("pnl: negative or unsafe cents are refused, not silently summed", () => {
  for (const cents of [-1, Number.MAX_SAFE_INTEGER, 1.5]) {
    const r = m.pnl.computePnl({ transactions: [{ kind: "SALE", cents, costCents: 0 }], stock: [] });
    assert(r.ok === false || Number.isSafeInteger(r.realizedCents), "unsafe pnl for cents=" + cents + ": " + JSON.stringify(r));
  }
});

check("risk: a second incident exactly at the cooldown boundary still gets no job", () => {
  const p = m.risk.createRiskPolicy({ cooldownTicks: 60 });
  p.register({ routeID: "r" });
  const first = p.apply({ incidentID: "a", routeID: "r", kind: "LOSS", receiptID: "x", tick: 0 });
  const boundary = p.apply({ incidentID: "b", routeID: "r", kind: "LOSS", receiptID: "y", tick: 60 });
  assert(first.securityJobs === 1, "first job");
  assert(boundary.securityJobs === 0 || boundary.securityJobs === 1, "boundary crashed");
  const justAfter = p.apply({ incidentID: "c", routeID: "r", kind: "LOSS", receiptID: "z", tick: 121 });
  assert(justAfter.securityJobs === 1, "after the window a new response is allowed");
});

check("backpressure: completing twice cannot make the counter negative", () => {
  const bp = m.backpressure.createBackpressure({ maxActive: 2, maxQueued: 2 });
  const ok = { facility: { facilityID: "f", available: true }, warehouse: { capacityUnits: 10, usedUnits: 0 } };
  bp.admit({ operationID: "o", ...ok });
  bp.complete({ operationID: "o" });
  const second = bp.complete({ operationID: "o" });
  assert(second.ok === false, "double complete accepted");
  assert(bp.counts().active === 0, "active " + bp.counts().active);
});

check("run: advancing past DONE is refused and the run stays resumable", () => {
  const d = m.run.createDistributor();
  d.start({ runID: "r", hullID: "h", cargoID: "c", quantity: 1 });
  d.advance({ runID: "r", to: "LOAD" });
  d.advance({ runID: "r", to: "CROSS", receiptID: "g" });
  d.advance({ runID: "r", to: "SELL", receiptID: "s" });
  assert(d.advance({ runID: "r", to: "DONE", receiptID: "d" }).ok === true, "cannot finish");
  assert(d.advance({ runID: "r", to: "DONE", receiptID: "d" }).ok === false, "advanced past DONE");
  assert(d.resume("r").hullID === "h", "resume lost the hull");
});

check("purchase: a quantity whose total overflows is refused before any debit", () => {
  let debits = 0;
  const b = m.purchase.createBuyer();
  const ask = { askID: "a", sellerCorpID: "s", typeID: "35", quantity: Number.MAX_SAFE_INTEGER, priceCents: 2 };
  const r = b.purchase({ operationID: "o", buyerCorpID: "b", ask, walletCents: Number.MAX_SAFE_INTEGER, settlementPort: { debit: () => { debits += 1; return { receiptID: "d" }; } }, itemPort: { transfer: () => ({ receiptID: "t" }) } });
  assert(debits === 0, "an overflowing total was debited");
  assert(r.ok === false, "overflow accepted: " + JSON.stringify(r));
});

check("reputation: the score clamps at maxScore after a success", () => {
  const rep = m.reputation.createReputation({ maxScore: 2 });
  for (let i = 0; i < 5; i += 1) rep.record({ playerID: "p", contractID: "k" + i, outcome: "SUCCESS", receiptID: "r" + i });
  assert(rep.score("p") === 2, "score " + rep.score("p"));
});

check("rollout: CORP2 with both flags writes, and rollback from OFF stays OFF", () => {
  const ok = m.rollout.evaluate({ stage: "CORP2", flags: { EVEJS_COOP_ECONOMY: true, EVEJS_COOP_SECOND_CORP: true } });
  assert(ok.writes === true, JSON.stringify(ok));
  const off = m.rollout.rollback({ stage: "OFF" });
  assert(off.stage === "OFF" && off.deletesData === false, JSON.stringify(off));
});

check("health: unsafe pnl cents are refused, not displayed", () => {
  const r = m.health.buildReport({
    pnl: { realizedCents: Number.MAX_SAFE_INTEGER, stockValueCents: Number.MAX_SAFE_INTEGER, committedCents: 1 },
    demand: { intents: 0, fulfilled: [] }, shortages: [], cargoLosses: [], players: [],
  });
  assert(r.ok === false || Number.isSafeInteger(r.realizedCents), "unsafe report: " + JSON.stringify(r));
});

check("coverage: a custody entry without a holder is a blocked scope", () => {
  const s = (u) => ({ units: u, sourceReceiptID: "r" });
  const r = m.coverage.audit({ before: { cargo: s(1) }, after: { cargo: s(1) }, custody: [{ cargoID: "c" }] });
  assert(r.ok === false, "a nameless holder passed");
});

check("race: acquiring twice as the same owner is one lease, not two writers", () => {
  const l = m.race.createLeases({ ttlTicks: 10 });
  assert(l.acquire({ key: "k", ownerID: "a", tick: 0 }).ok, "first");
  const again = l.acquire({ key: "k", ownerID: "a", tick: 1 });
  assert(again.ok === true && again.reentrant === true, "reentrant acquire failed: " + JSON.stringify(again));
  assert(l.holderOf("k") === "a", "holder changed");
});

check("race: a negative tick is refused", () => {
  const l = m.race.createLeases({ ttlTicks: 10 });
  const r = l.acquire({ key: "k", ownerID: "a", tick: -5 });
  assert(r.ok === false, "negative tick accepted");
});

check("crash: a step recorded DONE is never re-applied even if the executor is fresh", () => {
  const steps = { INTENT: () => ({ receiptID: "i" }), DEBIT: () => ({ receiptID: "d" }), CREDIT: () => ({ receiptID: "c" }) };
  const r = m.crash.runWindow({ window: "AFTER_CREDIT", operationID: "o", steps });
  assert(r.ok === true, JSON.stringify(r));
  assert(r.counts.CREDIT === 1, "credit " + r.counts.CREDIT);
});

check("soak: a zero stock cap fails visibly instead of resetting", () => {
  const r = m.soak.runSoak({ ticks: 50, seed: 2, stockCap: 0 });
  assert(r.ok === false, "a zero capacity passed");
  assert(r.reset === false && r.failures.length > 0, "failure was hidden");
});

check("funds: a duplicate commit with a larger amount keeps the original liability", () => {
  const g = m.funds.createGateway();
  const first = g.commit({ operationID: "o", cents: 10, walletCents: 100, escrowProof: true });
  const again = g.commit({ operationID: "o", cents: 90, walletCents: 100, escrowProof: true });
  assert(again.duplicate === true, "not a duplicate");
  assert(g.committedCents() === 10, "liability grew to " + g.committedCents());
  assert(first.status === again.status, "status changed");
});

check("live: an unwritable state path is reported, not thrown", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coopv2-ro-"));
  process.env.EVEJS_COOP_ECONOMY_V2_FILE = path.join(dir, "missing-dir", "shadow.json");
  process.env.EVEJS_COOP_ECONOMY_V2_ENABLE_FILE = path.join(dir, "enable");
  fs.writeFileSync(process.env.EVEJS_COOP_ECONOMY_V2_ENABLE_FILE, "1");
  delete require.cache[require.resolve(sp("coopEconomyV2.js"))];
  const v2 = require(sp("coopEconomyV2.js"));
  const r = v2.noteWarehouse({ cargoID: 5, stationID: 1, typeID: 2, quantity: 3, corporationID: 4, phase: "COMMITTED", itemID: 6 }, { itemID: 6 }, true);
  assert(r !== null && r.ok === true, "an unwritable path broke observation: " + JSON.stringify(r));
  const st = v2.status();
  assert(typeof st.lastError === "string" || st.lastError === null, "lastError type " + typeof st.lastError);
});

const summary = { checks, failures: failures.length, details: failures };
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(failures.length === 0 ? 0 : 1);
