#!/usr/bin/env node
"use strict";
// Economy shadow crosscheck: compare every receipt the warehouse WROTE inside the shadow's lifetime
// with what the shadow OBSERVED.
//
// Why this shape:
//  - The warehouse holds receipts from long before the shadow existed. Comparing those made the
//    report 1600 lines of MISSING noise and hid the one miss that mattered, so only receipts written
//    since the shadow started are compared.
//  - Inside that window a MISSING is a real loss: something was written and not observed. It fails
//    the gate, together with MISMATCH (the observer disagrees with the file) and UNEXPECTED (the
//    observer invented a receipt).
//  - A numeric-string cargoID is still the same cargo: ids are compared as numbers on both sides.
//
// usage: node coop-economy-v2-crosscheck.js [--out FILE] [--receipts N]
//   --receipts N limits the files examined; observations outside that sample are reported as
//   outsideSample instead of being called contradictions.

const fs = require("node:fs");
const path = require("node:path");

const STATE = "/var/lib/evejs/coop-economy-v2-shadow.json";
const RECEIPTS_DIR = "/var/lib/evejs/coop-native-warehouse/receipts";

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const outPath = argOf("--out", null);
const limit = Number(argOf("--receipts", "0")) || 0;
const acknowledged = new Set(String(argOf("--allow-missing", "") || "")
  .split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0));

let state;
try {
  state = JSON.parse(fs.readFileSync(STATE, "utf8"));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: "STATE_UNREADABLE",
    detail: String((error && error.message) || error) }));
  process.exit(1);
}

const observers = Array.isArray(state.receipts) ? state.receipts : [];
const SLACK_MS = 60 * 1000;
const startedMs = typeof state.startedAt === "string" && Number.isFinite(Date.parse(state.startedAt))
  ? Date.parse(state.startedAt) - SLACK_MS : null;

let names;
try {
  names = fs.readdirSync(RECEIPTS_DIR).filter((n) => n.endsWith(".json"));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: "RECEIPTS_UNREADABLE",
    detail: String((error && error.message) || error) }));
  process.exit(1);
}

const files = [];
for (const name of names) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(RECEIPTS_DIR, name), "utf8"));
    if (typeof record.at !== "number") continue;
    if (startedMs !== null && record.at < startedMs) continue;
    files.push(record);
  } catch (error) {
    // a torn file is not evidence of anything; it is counted as malformed below
    files.push(null);
  }
}
files.sort((a, b) => (b && b.at || 0) - (a && a.at || 0));
const malformed = files.filter((r) => r === null).length;
const considered = (limit > 0 ? files.slice(0, limit) : files).filter(Boolean);

const byCargo = new Map();
for (const observer of observers) {
  if (!observer || observer.cargoID === undefined) continue;
  byCargo.set(Number(observer.cargoID), observer);
}

let matched = 0;
let missing = 0;
let mismatch = 0;
let unexpected = 0;
let outsideSample = 0;
const results = [];
const written = new Set();

for (const record of considered) {
  const cargoID = Number(record.cargoID);
  if (!Number.isFinite(cargoID)) continue;
  written.add(cargoID);
  const observer = byCargo.get(cargoID);
  if (!observer) {
    if (limit > 0) { outsideSample += 1; continue; }
    if (acknowledged.has(cargoID)) {
      results.push({ cargoID, status: "ACKNOWLEDGED" });
      continue;
    }
    missing += 1;
    results.push({ cargoID, status: "MISSING" });
    continue;
  }
  const fields = [];
  if (Number(observer.stationID) !== Number(record.stationID)) {
    fields.push({ field: "stationID", expected: record.stationID, actual: observer.stationID });
  }
  if (Number(observer.typeID) !== Number(record.typeID)) {
    fields.push({ field: "typeID", expected: record.typeID, actual: observer.typeID });
  }
  if (Number(observer.quantity) !== Number(record.quantity)) {
    fields.push({ field: "quantity", expected: record.quantity, actual: observer.quantity });
  }
  if (observer.proof !== "STOCK_PROVEN") {
    fields.push({ field: "proof", expected: "STOCK_PROVEN", actual: observer.proof });
  }
  if (fields.length === 0) {
    matched += 1;
    results.push({ cargoID, status: "MATCHED" });
  } else {
    mismatch += 1;
    results.push({ cargoID, status: "MISMATCH", fields });
  }
}

for (const cargoID of byCargo.keys()) {
  if (!written.has(cargoID)) {
    unexpected += 1;
    results.push({ cargoID, status: "UNEXPECTED" });
  }
}

const missingDetail = results.filter((r) => r.status === "MISSING").map((r) => r.cargoID).slice(0, 20);
const unexpectedDetail = results.filter((r) => r.status === "UNEXPECTED").map((r) => r.cargoID).slice(0, 20);
const mismatchDetail = results.filter((r) => r.status === "MISMATCH").slice(0, 20);

const ok = mismatch === 0 && unexpected === 0 && missing === 0;
const output = {
  generatedAt: new Date().toISOString(),
  mode: "crosscheck",
  since: state.startedAt || null,
  counts: { matched, missing, mismatch, unexpected, outsideSample, malformed,
    acknowledged: results.filter((r) => r.status === "ACKNOWLEDGED").length },
  missingDetail,
  unexpectedDetail,
  mismatchDetail,
  ok,
};
const json = JSON.stringify(output, null, 2);
if (outPath) {
  try { fs.writeFileSync(outPath, json); } catch (error) { /* the report is still printed */ }
}
process.stdout.write(json + "\n");
process.exit(ok ? 0 : 1);
