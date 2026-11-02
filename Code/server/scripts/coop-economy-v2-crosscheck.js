#!/usr/bin/env node
"use strict";
// Economy shadow crosscheck: compare every receipt the warehouse WROTE inside the shadow's lifetime
// with what the shadow OBSERVED.
//
// Why this shape:
//  - The warehouse holds receipts from long before the shadow existed. Comparing those made the
//    report 1600 lines of MISSING noise and hid the one miss that mattered, so only receipts written
//    since the shadow started are compared.
//  - Inside that window a MISSING is a real loss. It fails the gate, together with MISMATCH (the
//    observer disagrees with the file) and UNEXPECTED (the observer invented a receipt).
//  - A receipt file that cannot be read is a possible loss, not noise: it fails the gate too, unless
//    an operator acknowledges it with --allow-malformed N. Files that are clearly older than the
//    shadow are outside the window and are reported separately.
//
// usage: node coop-economy-v2-crosscheck.js [--state FILE] [--receipts DIR] [--sample N]
//        [--out FILE] [--allow-missing id,id] [--allow-malformed N]

const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const STATE = argOf("--state", "/var/lib/evejs/coop-economy-v2-shadow.json");
const RECEIPTS_DIR = argOf("--receipts", "/var/lib/evejs/coop-native-warehouse/receipts");
const outPath = argOf("--out", null);
const acknowledged = new Set(String(argOf("--allow-missing", "") || "")
  .split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0));

// --receipts may be a number in old invocations: keep that as the sample limit.
const receiptsArg = argOf("--receipts", null);
const sampleLimit = Number(argOf("--sample", Number.isFinite(Number(receiptsArg)) ? receiptsArg : 0)) || 0;
const allowMalformed = Math.max(0, Number(argOf("--allow-malformed", "0")) || 0);

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
const oldBeforeMs = typeof state.startedAt === "string" && Number.isFinite(Date.parse(state.startedAt))
  ? Date.parse(state.startedAt) - 5 * 60 * 1000 : null;

let names;
try {
  names = fs.readdirSync(RECEIPTS_DIR).filter((n) => n.endsWith(".json"));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: "RECEIPTS_UNREADABLE",
    detail: String((error && error.message) || error) }));
  process.exit(1);
}

let files = [];
const malformed = [];
const malformedOutsideWindow = [];
for (const name of names) {
  const full = path.join(RECEIPTS_DIR, name);
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(full).mtimeMs; } catch (_error) { mtimeMs = null; }
  let record = null;
  let failure = null;
  try {
    record = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (error) {
    failure = String((error && error.message) || error);
  }
  const usable = record && typeof record === "object"
    && typeof record.at === "number" && Number.isFinite(record.at)
    && typeof record.cargoID === "number" && Number.isFinite(record.cargoID);
  if (!usable) {
    // an unreadable file older than the shadow cannot have been written by this shadow
    if (oldBeforeMs !== null && mtimeMs !== null && mtimeMs < oldBeforeMs) malformedOutsideWindow.push(name);
    else malformed.push({ name, error: failure || "missing numeric at/cargoID" });
    continue;
  }
  if (startedMs !== null && record.at < startedMs) continue;
  files.push({ name, record, mtimeMs });
}
files.sort((a, b) => b.record.at - a.record.at);
const malformedCount = malformed.length;
const malformedOutsideWindowCount = malformedOutsideWindow.length;
const considered = (sampleLimit > 0 ? files.slice(0, sampleLimit) : files).map((f) => f.record);

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
let acknowledgedCount = 0;
const results = [];
const written = new Set();

for (const record of considered) {
  const cargoID = Number(record.cargoID);
  written.add(cargoID);
  const observer = byCargo.get(cargoID);
  if (!observer) {
    if (sampleLimit > 0 && files.length > sampleLimit) { outsideSample += 1; continue; }
    if (acknowledged.has(cargoID)) {
      acknowledgedCount += 1;
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

// a malformed file is a possible lost receipt: it fails the gate unless explicitly acknowledged
const ok = mismatch === 0 && unexpected === 0 && missing === 0 && malformedCount <= allowMalformed;
const output = {
  generatedAt: new Date().toISOString(),
  mode: "crosscheck",
  since: state.startedAt || null,
  counts: {
    matched, missing, mismatch, unexpected, outsideSample,
    malformed: malformedCount, malformedOutsideWindow: malformedOutsideWindowCount,
    acknowledged: acknowledgedCount, allowMalformed,
    acknowledgedMalformed: Math.min(allowMalformed, malformedCount),
  },
  malformedDetail: malformed.map((m) => m.name).slice(0, 20),
  missingDetail,
  unexpectedDetail,
  mismatchDetail,
  ok,
};
const json = JSON.stringify(output, null, 2);
if (outPath) {
  try { fs.writeFileSync(outPath, json); } catch (_error) { /* the report is still printed */ }
}
process.stdout.write(json + "\n");
process.exit(ok ? 0 : 1);
