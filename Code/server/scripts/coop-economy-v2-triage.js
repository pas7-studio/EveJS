#!/usr/bin/env node
"use strict";
// Mission 003 economy shadow operator triage (read-only).
// Reads one evidence bundle and prints the stock picture, the receipts and every
// blocker in plain rows. A missing or unreadable bundle is a reportable state, not
// a stack trace.

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const IN = arg("--in", "/var/lib/evejs/coop-economy-v2-evidence.json");

function emit(row) {
  process.stdout.write(JSON.stringify(row) + "\n");
}

if (!fs.existsSync(IN)) {
  emit({ error: "EVIDENCE_MISSING", path: IN });
  process.exit(2);
}

let bundle;
try {
  bundle = JSON.parse(fs.readFileSync(IN, "utf8"));
} catch (error) {
  emit({ error: "EVIDENCE_UNREADABLE", path: IN, detail: String((error && error.message) || error) });
  process.exit(2);
}

const probe = bundle.probeData || {};
const stations = probe.stations && typeof probe.stations === "object" ? probe.stations : {};
const receipts = Array.isArray(probe.receipts) ? probe.receipts : [];
const checks = bundle.checks && typeof bundle.checks === "object" ? bundle.checks : {};

const blockers = [];
for (const [stationID, types] of Object.entries(stations)) {
  for (const [typeID, total] of Object.entries(types || {})) {
    emit({ row: "STOCK", stationID, typeID, total });
  }
}
for (const receipt of receipts) {
  emit({
    row: "RECEIPT",
    cargoID: receipt.cargoID,
    proof: receipt.proof,
    stationID: receipt.stationID,
    typeID: receipt.typeID,
    quantity: receipt.quantity,
  });
  if (receipt.proof !== "STOCK_PROVEN") {
    blockers.push({ kind: "RECEIPT", id: receipt.cargoID, reason: receipt.proof });
  }
}
for (const [name, value] of Object.entries(checks)) {
  if (value !== true) blockers.push({ kind: "CHECK", id: name, reason: "false" });
}
if (probe.lastError) blockers.push({ kind: "PROBE", id: "lastError", reason: probe.lastError });

const healthy = blockers.length === 0 && bundle.healthy === true;
emit({
  row: "SUMMARY",
  mode: probe.mode,
  deliveries: probe.deliveries,
  replays: probe.replays,
  blockers: blockers.length,
  readiness: probe.readiness && probe.readiness.code,
  healthy,
});
for (const blocker of blockers) emit({ row: "BLOCKER", ...blocker });

process.exit(healthy ? 0 : 1);
