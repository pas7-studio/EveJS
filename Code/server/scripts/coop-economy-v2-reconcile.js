#!/usr/bin/env node
"use strict";
// Reconcile the shadow with the warehouse, from evidence.
//
// A receipt the warehouse wrote and the shadow never observed is a gap in OUR record, not a missing
// delivery: the file is the authority (the warehouse writes it only after a durable COMMITTED). But
// filling the gap silently would be dishonest, so every reconstructed observation is marked
// `reconciled: true` with the time and the source, the previous state is kept as a backup, and the
// native ItemStore must still agree with the receipt before anything is added.
//
// usage: node coop-economy-v2-reconcile.js [--state FILE] [--receipts DIR] [--db FILE] [--dry-run]

const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const dryRun = argv.includes("--dry-run");

const STATE = argOf("--state", "/var/lib/evejs/coop-economy-v2-shadow.json");
const RECEIPTS = argOf("--receipts", "/var/lib/evejs/coop-native-warehouse/receipts");
const DB = argOf("--db", "/var/lib/evejs/gameStore/gamestore.sqlite");
const SLACK_MS = 60 * 1000;

function openDb() {
  for (const candidate of ["/app/server/node_modules/better-sqlite3", "better-sqlite3"]) {
    try {
      const Database = require(candidate);
      return new Database(DB, { readonly: true, fileMustExist: true });
    } catch (error) {
      // try the next one
    }
  }
  return null;
}

function main() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: "STATE_UNREADABLE",
      detail: String((error && error.message) || error) }));
    return 1;
  }
  const known = new Set((state.receipts || []).map((r) => Number(r.cargoID)));
  const sinceMs = typeof state.startedAt === "string" ? Date.parse(state.startedAt) - SLACK_MS : null;

  const db = openDb();
  if (!db) {
    console.log(JSON.stringify({ ok: false, code: "ITEM_STORE_UNAVAILABLE",
      detail: "the native ItemStore is the proof; refusing to reconcile without it" }));
    return 1;
  }
  const items = new Map();
  for (const row of db.prepare("select json from items").all()) {
    let item;
    try { item = JSON.parse(row.json); } catch (error) { continue; }
    if (item && item.itemID !== undefined) items.set(String(item.itemID), item);
  }
  db.close();

  const added = [];
  const refused = [];
  const stations = state.stations && typeof state.stations === "object" ? state.stations : {};

  for (const name of fs.readdirSync(RECEIPTS).filter((n) => n.endsWith(".json"))) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(RECEIPTS, name), "utf8"));
    } catch (error) {
      continue;
    }
    if (typeof record.at !== "number") continue;
    if (sinceMs !== null && record.at < sinceMs) continue;
    const cargoID = Number(record.cargoID);
    if (!Number.isFinite(cargoID) || known.has(cargoID)) continue;
    if (record.phase !== "COMMITTED") { refused.push({ cargoID, why: "NOT_COMMITTED" }); continue; }

    const item = items.get(String(record.itemID));
    if (!item) { refused.push({ cargoID, why: "NO_ITEM_ROW" }); continue; }
    if (Number(item.typeID) !== Number(record.typeID)
      || Number(item.locationID) !== Number(record.stationID)
      || Number(item.quantity) < Number(record.quantity)) {
      refused.push({ cargoID, why: "ITEM_ROW_DISAGREES" });
      continue;
    }

    const stationKey = String(record.stationID);
    const typeKey = String(record.typeID);
    stations[stationKey] = stations[stationKey] || {};
    stations[stationKey][typeKey] = Number(stations[stationKey][typeKey] || 0) + Number(record.quantity);

    state.receipts = Array.isArray(state.receipts) ? state.receipts : [];
    state.receipts.push({
      cargoID,
      itemID: record.itemID,
      stationID: record.stationID,
      corporationID: record.corporationID,
      typeID: record.typeID,
      quantity: record.quantity,
      durable: true,
      phase: "COMMITTED",
      proof: "STOCK_PROVEN",
      physical: Number(stations[stationKey][typeKey]),
      at: new Date(record.at).toISOString(),
      reconciled: true,
      reconciledAt: new Date().toISOString(),
      source: "receipt-file",
    });
    known.add(cargoID);
    added.push({ cargoID, quantity: record.quantity, itemID: record.itemID, at: new Date(record.at).toISOString() });
  }

  if (added.length === 0 && refused.length === 0) {
    console.log(JSON.stringify({ ok: true, code: "ALREADY_CONSISTENT", added: 0 }, null, 2));
    return 0;
  }

  // The counter follows the record: a reconciled observation is a delivery the shadow now knows.
  state.deliveries = Array.isArray(state.receipts) ? state.receipts.length : state.deliveries;
  state.proofs = state.proofs || { proven: 0, blocked: 0 };
  state.proofs.proven = Number(state.proofs.proven || 0) + added.length;
  state.stations = stations;
  state.lastError = null;

  const report = {
    ok: refused.length === 0,
    added: added.length,
    refused: refused.length,
    detail: added,
    refusedDetail: refused.slice(0, 20),
    dryRun,
  };
  if (!dryRun && added.length > 0) {
    const backup = STATE + ".bak-" + Date.now();
    try {
      fs.copyFileSync(STATE, backup);
      report.backup = backup;
    } catch (error) {
      report.backup = "FAILED";
    }
    const tmp = STATE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, STATE);
  }
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

process.exit(main());
