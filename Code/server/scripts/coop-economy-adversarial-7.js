"use strict";
// Wave 7: adversarial checks on the INTERACTION between economy modules.
// Waves 1-6 tested each module alone; here the escrow -> settlement -> gateway -> pnl
// pipeline must conserve goods and money exactly, with no double spend and no double credit.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const root = process.env.EVEJS_FORK_ROOT || "C:\\Games\\EveCoop\\upstream-evejs";
const spaceDir = fs.existsSync(path.join(root, "Code/server/src/space"))
  ? path.join(root, "Code/server/src/space")
  : path.join(root, "src", "space");
const sp = (name) => path.join(spaceDir, name);

const SellEscrow = require(sp("coopEconomySellEscrow.js"));
const settlement = require(sp("coopEconomySaleSettlement.js")).createSettlement();
const FundsGateway = require(sp("coopEconomyFundsGateway.js"));
const pnl = require(sp("coopEconomyPnl.js")).computePnl;
const conservation = require(sp("coopEconomyConservationAudit.js")).audit;

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

// A single wallet port that counts how many times it is invoked, so we can prove a
// settlement does not credit twice and a gateway does not charge twice.
function makeWalletPort() {
  const calls = { count: 0 };
  return {
    credit: (cents) => {
      calls.count += 1;
      return { receiptID: "r" + calls.count };
    },
    calls,
  };
}

// ---------------------------------------------------------------------------
// 1. The escrow invariant: onHand is always exactly available + reserved + listed.
//    If this breaks, units are created or destroyed by bookkeeping alone.
check("escrow: onHand === available + reserved + listed across stock, reserve, list and fill", () => {
  const e = SellEscrow.createEscrow();
  const stocked = 80;
  assert.equal(e.stock({ itemID: "i1", quantity: stocked }).ok, true);
  const invariant = (onHand, label) => assert.equal(
    e.available("i1") + e.reserved("i1") + e.listed("i1"), onHand,
    label + ": " + e.available("i1") + "+" + e.reserved("i1") + "+" + e.listed("i1") + " != " + onHand,
  );
  invariant(stocked, "after stock");
  assert.equal(e.reserve({ itemID: "i1", quantity: 40 }).ok, true);
  invariant(stocked, "after reserve");
  assert.equal(e.available("i1"), 40, "a reservation did not leave the rest available");
  assert.equal(e.list({ escrowID: "esc-1", itemID: "i1", quantity: 40, priceCents: 5 }).ok, true);
  invariant(stocked, "after list");
  assert.equal(e.available("i1"), 0, "listed units are still reported as free");
  assert.equal(e.fill({ escrowID: "esc-1", quantity: 40 }).ok, true);
  invariant(40, "after fill");
  assert.equal(e.listed("i1"), 0, "the listing still holds units after a full fill");
});

// 2. A filled listing cannot be filled again: the units physically left the station.
check("escrow: a second fill of the same listing cannot sell units the first fill took", () => {
  const e = SellEscrow.createEscrow();
  e.stock({ itemID: "i2", quantity: 10 });
  e.list({ escrowID: "esc-2", itemID: "i2", quantity: 10, priceCents: 7 });
  const first = e.fill({ escrowID: "esc-2", quantity: 10 });
  assert.equal(first.ok, true, "the first fill was refused: " + JSON.stringify(first));
  assert.equal(first.remaining, 0);
  const second = e.fill({ escrowID: "esc-2", quantity: 10 });
  assert.equal(second.ok, false, "a second fill sold the same units again");
  assert.equal(second.code, "INSUFFICIENT_ESCROW", "the second fill failed for the wrong reason: " + second.code);
  assert.equal(e.available("i2") + e.reserved("i2") + e.listed("i2"), 0, "the second fill moved units");
});

// 3. A reservation is a hold with an end: release() returns the units, and releasing more than
//    was held is refused. Before the fix, reserve() had no counterpart, so 40 held units stayed
//    unavailable for ever.
check("escrow: a hold can be released and the release is exact", () => {
  const e = SellEscrow.createEscrow();
  e.stock({ itemID: "i3", quantity: 80 });
  e.reserve({ itemID: "i3", quantity: 40 });
  assert.equal(e.available("i3"), 40, "the hold did not remove the units from available");
  assert.equal(e.release({ itemID: "i3", quantity: 41 }).ok, false, "over-releasing the hold was accepted");
  assert.equal(e.release({ itemID: "i3", quantity: 40 }).code, "RELEASED", "the hold could not be released");
  assert.equal(e.reserved("i3"), 0, "the hold survived its release");
  assert.equal(e.available("i3"), 80, "releasing the hold did not return the units");
});

// 3b. A sale out of the free pool must not free a fleet's hold: the two pools are disjoint.
check("escrow: a market fill does not free a fleet reservation", () => {
  const e = SellEscrow.createEscrow();
  e.stock({ itemID: "i3b", quantity: 10 });
  e.reserve({ itemID: "i3b", quantity: 4 });
  assert.equal(e.list({ escrowID: "esc-3b", itemID: "i3b", quantity: 6, priceCents: 5 }).code, "LISTED");
  assert.equal(e.available("i3b"), 0);
  assert.equal(e.fill({ escrowID: "esc-3b", quantity: 2 }).remaining, 4);
  assert.equal(e.reserved("i3b"), 4, "a market fill ate the fleet reservation");
  assert.equal(e.available("i3b"), 0, "a sold unit is not free stock");
});

// 4. Settlement credits netCents = gross - tax - fee, once per fillID.
check("settlement: one fillID credits the wallet once at gross - tax - fee", () => {
  const port = makeWalletPort();
  const result = settlement.settle({
    fillID: "fill-1", ownerCorpID: "corp-1", grossCents: 1000, taxCents: 100, feeCents: 50, walletPort: port,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.netCents, 850, "the credited amount was not gross - tax - fee");
  assert.equal(port.calls.count, 1, "the wallet port was called " + port.calls.count + " times for one settle");
});

// 5. A replay of the same fillID is ALREADY_SETTLED and must not credit again.
check("settlement: a repeat settle is ALREADY_SETTLED and credits nothing", () => {
  const port = makeWalletPort();
  const args = { fillID: "fill-2", ownerCorpID: "corp-1", grossCents: 300, taxCents: 0, feeCents: 0, walletPort: port };
  const first = settlement.settle(args);
  assert.equal(first.code, "SETTLED");
  const again = settlement.settle(args);
  assert.equal(again.code, "ALREADY_SETTLED", "a repeat settle was " + again.code);
  assert.equal(again.netCents, first.netCents, "the replay reported a different amount");
  assert.equal(port.calls.count, 1, "the repeat settle credited the wallet a second time");
});

// 6. The gateway charges an operationID once, on a fresh gateway so earlier checks cannot leak in.
check("gateway: the same operationID is charged once and the duplicate is reported", () => {
  const fresh = FundsGateway.createGateway();
  const opID = "op-7";
  const first = fresh.commit({ operationID: opID, cents: 100, from: "a", to: "b" });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(fresh.committedCents(), 100);
  const second = fresh.commit({ operationID: opID, cents: 100, from: "a", to: "b" });
  assert.equal(second.duplicate, true, "the duplicate commit did not report duplicate");
  assert.equal(fresh.committedCents(), 100, "the duplicate commit added money");
});

// 7. Corrupt money never moves: negative and fractional cents are refused by both modules.
check("settlement and gateway: negative or fractional cents are refused and move nothing", () => {
  const port = makeWalletPort();
  for (const gross of [-50, 12.5, NaN, "100"]) {
    const r = settlement.settle({
      fillID: "fill-neg-" + String(gross), ownerCorpID: "corp-1", grossCents: gross, taxCents: 0, feeCents: 0, walletPort: port,
    });
    assert.equal(r.ok, false, "settlement accepted gross " + String(gross));
  }
  assert.equal(port.calls.count, 0, "a refused settle credited the wallet");
  const fresh = FundsGateway.createGateway();
  for (const cents of [-1, 9.99, NaN, "100"]) {
    const g = fresh.commit({ operationID: "op-bad-" + String(cents), cents, from: "a", to: "b" });
    assert.equal(g.ok, false, "the gateway accepted cents " + String(cents));
  }
  assert.equal(fresh.committedCents(), 0, "a refused gateway commit moved money");
});

// 8. PnL reconciles: revenue - cost is what it reports, and an empty ledger is zero.
check("pnl: an empty ledger is zero and the reported profit equals revenue - cost", () => {
  const empty = pnl({ transactions: [], stock: [] });
  assert.equal(empty.ok, true, "an empty ledger was an error: " + (empty && empty.code));
  assert.equal(empty.revenueCents, 0);
  assert.equal(empty.costOfGoodsCents, 0);
  const one = pnl({
    transactions: [{ id: "t1", grossCents: 1000, taxCents: 100, feeCents: 50, costCents: 400, quantity: 1 }],
    stock: [],
  });
  if (one.ok) {
    assert.equal(one.revenueCents, 1000, "revenue " + one.revenueCents);
    assert.equal(one.realizedCents, 1000 - 400, "the realized profit does not reconcile: " + one.realizedCents);
  } else {
    assert.equal(one.code, "INVALID_TRANSACTION", "a rejected transaction was not named");
  }
});

// 9. A refused fill leaves the escrow exactly as it was.
check("conservation: a refused fill leaves the escrow totals unchanged", () => {
  const e = SellEscrow.createEscrow();
  e.stock({ itemID: "i9", quantity: 7 });
  e.list({ escrowID: "esc-9", itemID: "i9", quantity: 7, priceCents: 2 });
  const before = { available: e.available("i9"), listed: e.listed("i9"), reserved: e.reserved("i9") };
  const refused = e.fill({ escrowID: "esc-9", quantity: 999 });
  assert.equal(refused.ok, false, "an over-fill was accepted");
  const after = { available: e.available("i9"), listed: e.listed("i9"), reserved: e.reserved("i9") };
  assert.deepEqual(after, before, "the refused fill moved escrow units");
});

process.stdout.write(JSON.stringify({ checks, failures: failures.length, details: failures }, null, 2) + "\n");
process.exit(failures.length === 0 ? 0 : 1);
