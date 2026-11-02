#!/usr/bin/env node
"use strict";
// Economy shadow audit: compare what the warehouse WROTE with what the shadow OBSERVED.
//
// The module's own health flag cannot see a lost observation - a receipt that was never recorded
// looks exactly like a receipt that never happened. Measured 2026-11-01: cargo 980200218463 was
// observed and dropped by a persist throttle, while the probe reported healthy=true and the
// crosscheck reported mismatch=0. Only this comparison found it.
//
// usage: node coop-economy-v2-audit.js [--state FILE] [--receipts DIR] [--since ISO]
// exit 0 when every receipt written since the shadow started has been observed, 1 otherwise.

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const STATE = arg("--state", "/var/lib/evejs/coop-economy-v2-shadow.json");
const RECEIPTS = arg("--receipts", "/var/lib/evejs/coop-native-warehouse/receipts");

let state;
try {
  state = JSON.parse(fs.readFileSync(STATE, "utf8"));
} catch (error) {
  console.log(JSON.stringify({ audit: "coop-economy-v2", ok: false, code: "STATE_UNREADABLE",
    detail: String((error && error.message) || error) }));
  process.exit(1);
}

const receipts = Array.isArray(state.receipts) ? state.receipts : [];
const seen = new Set(receipts.map((r) => Number(r.cargoID)));
const since = arg("--since", state.startedAt || null);
const sinceMs = since ? Date.parse(since) : null;
if (sinceMs !== null && !Number.isFinite(sinceMs)) {
  console.log(JSON.stringify({ audit: "coop-economy-v2", ok: false, code: "INVALID_SINCE", since }));
  process.exit(1);
}

let files = [];
try {
  files = fs.readdirSync(RECEIPTS).filter((f) => f.endsWith(".json"));
} catch (error) {
  console.log(JSON.stringify({ audit: "coop-economy-v2", ok: false, code: "RECEIPTS_UNREADABLE",
    detail: String((error && error.message) || error) }));
  process.exit(1);
}

let inWindow = 0;
const missed = [];
const malformed = [];
for (const file of files) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(RECEIPTS, file), "utf8"));
  } catch (error) {
    malformed.push(file);
    continue;
  }
  if (typeof record.at !== "number") { malformed.push(file); continue; }
  if (sinceMs !== null && record.at < sinceMs) continue;
  inWindow += 1;
  if (!seen.has(Number(record.cargoID))) {
    missed.push({ cargoID: record.cargoID, at: new Date(record.at).toISOString(),
      stationID: record.stationID, typeID: record.typeID, quantity: record.quantity });
  }
}

missed.sort((a, b) => a.at.localeCompare(b.at));
const report = {
  audit: "coop-economy-v2",
  ok: missed.length === 0,
  since: since || null,
  observed: seen.size,
  writtenInWindow: inWindow,
  missed: missed.length,
  malformedFiles: malformed.length,
  missedDetail: missed.slice(0, 20),
};
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(report.ok ? 0 : 1);
