#!/usr/bin/env node
"use strict";
// Mission 003 economy shadow probe (read-only).
// Prints one JSON document describing the live shadow stage and exits 0 when the
// stage is healthy for what it claims (OFF or SHADOW), 1 when it reports an error.
//
// Usage: node scripts/coop-economy-v2-probe.js [--write]

const path = require("node:path");
const { status, enabled, ENABLE_FILE, STATE_FILE } = require(path.join(__dirname, "..", "src", "space", "coopEconomyV2"));

const write = process.argv.includes("--write");
const view = write ? status() : require(path.join(__dirname, "..", "src", "space", "coopEconomyV2")).snapshot();

const report = {
  probe: "coop-economy-v2",
  at: new Date().toISOString(),
  enabled: enabled(),
  mode: view.mode,
  enableFile: ENABLE_FILE,
  stateFile: STATE_FILE,
  deliveries: view.deliveries,
  replays: view.replays,
  proofs: view.proofs,
  stations: view.stations,
  receipts: view.receipts.slice(-5),
  readiness: view.readiness,
  lastError: view.lastError,
  healthy: !view.lastError && view.readiness.live === false,
};

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(report.healthy ? 0 : 1);
