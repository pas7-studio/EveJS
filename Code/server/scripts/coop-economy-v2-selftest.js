#!/usr/bin/env node
"use strict";
// Mission 003 economy shadow self-test. Proves the live observer is inert when OFF,
// idempotent per native cargoID and never able to declare itself live.
// No network, no docker, no game state: it runs against a temp directory.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tests = [];
function check(name, fn) {
  try {
    const detail = fn();
    tests.push({ name, ok: true, detail: detail === undefined ? null : detail });
  } catch (error) {
    tests.push({ name, ok: false, detail: String((error && error.message) || error) });
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// The module reads its paths at require time, so the environment must be set first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coopv2-selftest-"));
process.env.EVEJS_COOP_ECONOMY_V2_FILE = path.join(dir, "shadow.json");
process.env.EVEJS_COOP_ECONOMY_V2_ENABLE_FILE = path.join(dir, "enable");
delete process.env.EVEJS_COOP_ECONOMY_V2;

const v2 = require("../src/space/coopEconomyV2");
const ENABLE = process.env.EVEJS_COOP_ECONOMY_V2_ENABLE_FILE;
const STATE = process.env.EVEJS_COOP_ECONOMY_V2_FILE;

const record = (cargoID, extra) => ({
  cargoID,
  stationID: 60003760,
  typeID: 34,
  quantity: 120,
  corporationID: 1000125,
  phase: "COMMITTED",
  itemID: 9000 + cargoID,
  ...(extra || {}),
});

check("OFF by default", () => {
  assert(v2.enabled() === false, "expected enabled() false");
  return { enabled: v2.enabled() };
});

check("OFF observes nothing", () => {
  const result = v2.noteWarehouse(record(1), { itemID: 9001 }, true);
  assert(result === null, "expected null");
  assert(!fs.existsSync(STATE), "state file must not exist while OFF");
  return { mode: v2.snapshot().mode };
});

check("enable file turns the stage on", () => {
  fs.writeFileSync(ENABLE, "1");
  assert(v2.enabled() === true, "expected enabled() true");
  return { mode: v2.snapshot().mode };
});

check("a native receipt is observed", () => {
  const first = v2.noteWarehouse(record(41), { itemID: 9041 }, true);
  assert(first && first.code === "OBSERVED", "code " + (first && first.code));
  assert(first.proof === "STOCK_PROVEN", "proof " + first.proof);
  return first;
});

check("a replay cannot inflate the total", () => {
  const replay = v2.noteWarehouse(record(41), { itemID: 9041 }, true);
  assert(replay && replay.code === "ALREADY_OBSERVED", "code " + (replay && replay.code));
  const total = v2.status().stations["60003760"]["34"];
  assert(total === 120, "total " + total);
  return { total };
});

check("a record without an item is not stock", () => {
  const blocked = v2.noteWarehouse(record(43, { typeID: 35, quantity: 10, itemID: 0 }), null, false);
  assert(blocked.proof === "NO_PHYSICAL_STOCK", "proof " + blocked.proof);
  const view = v2.status();
  assert(view.stations["60003760"]["35"] === undefined, "type 35 must have no stock");
  return blocked;
});

check("the shadow never declares itself live", () => {
  const readiness = v2.assess();
  assert(readiness.live === false, "live " + readiness.live);
  assert(readiness.code === "MANUAL_ONLY", "code " + readiness.code);
  return readiness;
});

check("removing the enable file turns it off again", () => {
  fs.unlinkSync(ENABLE);
  assert(v2.enabled() === false, "expected enabled() false");
  const result = v2.noteWarehouse(record(44), { itemID: 9044 }, true);
  assert(result === null, "expected null");
  return { mode: v2.snapshot().mode };
});

const failed = tests.filter((t) => !t.ok).length;
const summary = {
  test: "coop-economy-v2-selftest",
  at: new Date().toISOString(),
  dir,
  tests,
  passed: tests.length - failed,
  failed,
  ok: failed === 0,
};
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
process.exit(failed === 0 ? 0 : 1);
