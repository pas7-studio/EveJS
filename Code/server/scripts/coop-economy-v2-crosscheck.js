"use strict";

const fs = require("fs");
const path = require("path");
const v2 = require("../src/space/coopEconomyV2");

const RECEIPTS_DIR = "/var/lib/evejs/coop-native-warehouse/receipts";

function parseArgs(argv) {
  const args = { receipts: 20, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--receipts") {
      args.receipts = parseInt(argv[++i], 10);
    } else if (a === "--out") {
      args.out = argv[++i];
    }
  }
  return args;
}

function main() {
  const { receipts: n, out } = parseArgs(process.argv.slice(2));

  const v2data = v2.snapshot();
  const observerRecords = Array.isArray(v2data.receipts) ? v2data.receipts : [];

  // Collect receipt files, keep the last N by mtime.
  let files = [];
  try {
    const entries = fs.readdirSync(RECEIPTS_DIR);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(RECEIPTS_DIR, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (e) {
        continue;
      }
      files.push({ name, mtime: stat.mtimeMs });
    }
  } catch (e) {
    files = [];
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const recent = files.slice(0, n);

  const receiptCargoIds = new Set();
  const results = [];
  let matched = 0;
  let missing = 0;
  let mismatch = 0;
  let unexpected = 0;

  for (const f of recent) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(RECEIPTS_DIR, f.name), "utf8");
    } catch (e) {
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch (e) {
      continue;
    }
    if (rec.phase !== "COMMITTED") continue;
    if (!(rec.itemID > 0)) continue;
    const cargoID = rec.cargoID;
    if (cargoID === undefined || cargoID === null) continue;
    receiptCargoIds.add(cargoID);

    const observer = observerRecords.find((o) => o && o.cargoID === cargoID);

    if (!observer) {
      missing++;
      results.push({ cargoID, status: "MISSING" });
      continue;
    }

    const fields = [];
    if (observer.stationID !== rec.stationID) {
      fields.push({ field: "stationID", expected: rec.stationID, actual: observer.stationID });
    }
    if (observer.typeID !== rec.typeID) {
      fields.push({ field: "typeID", expected: rec.typeID, actual: observer.typeID });
    }
    if (observer.quantity !== rec.quantity) {
      fields.push({ field: "quantity", expected: rec.quantity, actual: observer.quantity });
    }
    if (observer.proof !== "STOCK_PROVEN") {
      fields.push({ field: "proof", expected: "STOCK_PROVEN", actual: observer.proof });
    }

    const equal =
      observer.stationID === rec.stationID &&
      observer.typeID === rec.typeID &&
      observer.quantity === rec.quantity &&
      observer.proof === "STOCK_PROVEN";

    if (equal) {
      matched++;
      results.push({ cargoID, status: "MATCHED" });
    } else {
      mismatch++;
      results.push({ cargoID, status: "MISMATCH", fields });
    }
  }

  // Unexpected: observer records that have no native receipt file at all.
  for (const o of observerRecords) {
    if (!o || o.cargoID === undefined || o.cargoID === null) continue;
    if (!receiptCargoIds.has(o.cargoID)) {
      unexpected++;
    }
  }

  const ok = mismatch === 0 && unexpected === 0;

  const output = {
    generatedAt: new Date().toISOString(),
    mode: "crosscheck",
    receipts: results,
    counts: { matched, missing, mismatch, unexpected },
    ok
  };

  const json = JSON.stringify(output, null, 2);

  if (out) {
    fs.writeFileSync(out, json);
  } else {
    process.stdout.write(json + "\n");
  }

  process.exit(ok ? 0 : 1);
}

main();
