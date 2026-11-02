#!/usr/bin/env node
"use strict";
// Mission 003 economy shadow evidence bundle (read-only).
// Runs inside the live container: it reads the observer state, the last native
// warehouse receipts and reports whether the shadow is honest about itself.

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
function arg(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const OUT = arg("--out", "/var/lib/evejs/coop-economy-v2-evidence.json");
const RECEIPTS_DIR = arg("--receipts-dir", "/var/lib/evejs/coop-native-warehouse/receipts");
const RECEIPT_COUNT = Number(arg("--receipts", "5")) || 5;

const v2 = require(path.join(__dirname, "..", "src", "space", "coopEconomyV2"));

function readReceipts() {
  let entries;
  try {
    entries = fs.readdirSync(RECEIPTS_DIR);
  } catch (error) {
    return { directory: "MISSING", files: [] };
  }
  const files = entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const full = path.join(RECEIPTS_DIR, name);
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch (error) {
        stat = null;
      }
      return { name, full, mtime: stat ? stat.mtimeMs : 0 };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, RECEIPT_COUNT)
    .map((entry) => {
      let parsed = null;
      try {
        parsed = JSON.parse(fs.readFileSync(entry.full, "utf8"));
      } catch (error) {
        parsed = null;
      }
      return { file: entry.name, parsed };
    });
  return { directory: RECEIPTS_DIR, files };
}

function stationTotalsMatch(probe) {
  const expected = new Map();
  for (const receipt of Array.isArray(probe.receipts) ? probe.receipts : []) {
    if (!receipt || receipt.proof !== "STOCK_PROVEN") continue;
    const key = String(receipt.stationID) + "|" + String(receipt.typeID);
    expected.set(key, (expected.get(key) || 0) + (Number(receipt.quantity) || 0));
  }
  for (const [stationID, types] of Object.entries(probe.stations || {})) {
    for (const [typeID, total] of Object.entries(types || {})) {
      const key = stationID + "|" + typeID;
      // the observer may have rolled old receipts out of its ring buffer, so the
      // recorded total can only be at least the sum of what is still in the buffer
      if ((expected.get(key) || 0) > total) return false;
    }
  }
  return true;
}

const probe = v2.status();
const receipts = readReceipts();
const checks = {
  offMeansNoWrite: probe.mode === "SHADOW" || (probe.mode === "OFF" && probe.deliveries === 0),
  shadowNeverLive: probe.readiness && probe.readiness.live === false,
  stationTotalsMatch: stationTotalsMatch(probe),
};
const healthy = checks.offMeansNoWrite && checks.shadowNeverLive && checks.stationTotalsMatch && !probe.lastError;

const bundle = {
  probe: "coop-economy-v2-evidence",
  generatedAt: new Date().toISOString(),
  node: process.version,
  pid: process.pid,
  host: require("node:os").hostname(),
  probeData: probe,
  warehouseReceipts: receipts,
  enableFile: { path: v2.ENABLE_FILE, exists: fs.existsSync(v2.ENABLE_FILE) },
  stateFile: { path: v2.STATE_FILE, exists: fs.existsSync(v2.STATE_FILE) },
  checks,
  healthy,
};

try {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(bundle, null, 2), "utf8");
} catch (error) {
  bundle.writeError = String((error && error.message) || error);
}

process.stdout.write(JSON.stringify(bundle, null, 2) + "\n");
process.exit(healthy ? 0 : 1);
