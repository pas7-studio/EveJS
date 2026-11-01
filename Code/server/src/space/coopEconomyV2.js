"use strict";
// Mission 003 (IE-029/036/065) live shadow stage for the NPC Industrial Economy 2.0.
//
// This module is the ONLY live integration point of the economy work in the running
// server. It observes real, already-committed native warehouse deliveries and turns
// them into a read-only evidence stream:
//   - the native receipt (cargoID, itemID, station, corp, type, quantity),
//   - a station-stock proof computed with the delivered pure module,
//   - a demand/supply ledger keyed by the native cargoID so a replay can never
//     inflate anything.
//
// It never writes items, wallets, jobs or market state. The write-capable stages
// (CORP1/CORP2) still need an explicit attestation, and assess() reports
// MANUAL_ONLY without one - the module must not be able to promote itself.
//
// Activation is deliberately boring and reversible:
//   EVEJS_COOP_ECONOMY_V2=1                     -> on (container env)
//   <enable file> exists                        -> on (live experiment without recreation)
//   neither                                     -> OFF: noteWarehouse returns null, nothing is read or written

const fs = require("node:fs");
const path = require("node:path");
const { proveStationStock } = require("./coopEconomyStationStockProof");
const { assessLiveReadiness } = require("./coopEconomyLiveReadiness");

const ENABLE_FILE = process.env.EVEJS_COOP_ECONOMY_V2_ENABLE_FILE || "/var/lib/evejs/coop-economy-v2.enable";
const STATE_FILE = process.env.EVEJS_COOP_ECONOMY_V2_FILE || "/var/lib/evejs/coop-economy-v2-shadow.json";
const MAX_RECEIPTS = 200;
const MAX_STATIONS = 200;

const state = {
  startedAt: null,
  deliveries: 0,
  replays: 0,
  proofs: { proven: 0, blocked: 0 },
  receipts: [],
  stations: new Map(), // stationID -> Map(typeID -> quantity)
  lastWriteAt: 0,
  lastError: null,
};

function enabled() {
  if (process.env.EVEJS_COOP_ECONOMY_V2 === "1") return true;
  try {
    return fs.existsSync(ENABLE_FILE);
  } catch (error) {
    return false;
  }
}

function attestation() {
  const raw = process.env.EVEJS_COOP_ECONOMY_V2_ATTESTATION;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    return null;
  }
}

// the honest answer to "can this stage write?" - it cannot, and it says so
function assess() {
  return assessLiveReadiness({
    binding: { id: "coopEconomyV2", supportsLiveRuntime: false },
    attestation: attestation(),
  });
}

function stationRow(stationID, typeID) {
  let types = state.stations.get(stationID);
  if (!types) {
    types = new Map();
    state.stations.set(stationID, types);
  }
  return { types, key: typeID };
}

function snapshot() {
  const stations = {};
  for (const [stationID, types] of state.stations.entries()) {
    const view = {};
    for (const [typeID, quantity] of types.entries()) view[String(typeID)] = quantity;
    stations[String(stationID)] = view;
  }
  return {
    version: 1,
    mode: enabled() ? "SHADOW" : "OFF",
    startedAt: state.startedAt,
    deliveries: state.deliveries,
    replays: state.replays,
    proofs: { ...state.proofs },
    stations,
    receipts: state.receipts.map((r) => ({ ...r })),
    lastWriteAt: state.lastWriteAt,
    lastError: state.lastError,
    readiness: assess(),
    generatedAt: new Date().toISOString(),
  };
}

function persist(force) {
  const now = Date.now();
  if (!force && now - state.lastWriteAt < 2000) return;
  state.lastWriteAt = now;
  const body = JSON.stringify(snapshot(), null, 2);
  const tmp = STATE_FILE + ".tmp";
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, STATE_FILE);
  } catch (error) {
    state.lastError = String((error && error.message) || error).slice(0, 300);
  }
}

// Called by coopNativeWarehouse right after a durable COMMITTED receipt.
// record: { cargoID, corporationID, stationID, typeID, quantity, itemID }
// item:   the real native ItemStore stack (or null when it was already committed)
function noteWarehouse(record, item, durable) {
  if (!enabled()) return null;
  try {
    if (!record || !Number.isSafeInteger(Number(record.cargoID)) || Number(record.cargoID) <= 0) return null;
    if (state.startedAt === null) state.startedAt = new Date().toISOString();

    const cargoID = Number(record.cargoID);
    const stationID = Number(record.stationID) || 0;
    const typeID = Number(record.typeID) || 0;
    const quantity = Number(record.quantity) || 0;
    const itemID = Number((item && item.itemID) || record.itemID) || 0;

    // one native cargoID is one receipt; a retry of the same stack is a replay
    if (state.receipts.some((r) => r.cargoID === cargoID)) {
      state.replays += 1;
      persist(false);
      return { ok: true, code: "ALREADY_OBSERVED", cargoID };
    }

    // A COMMITTED receipt without a real ItemStore stack is NOT station stock.
    // Counting it would let a bare depot phase unlock a refinery, so it is
    // recorded as a blocked observation and never added to the physical total.
    const hasPhysicalItem = itemID > 0 && quantity > 0;
    const row = stationRow(stationID, typeID);
    if (hasPhysicalItem) {
      row.types.set(row.key, (row.types.get(row.key) || 0) + quantity);
    }
    if (state.stations.size > MAX_STATIONS) {
      const oldest = state.stations.keys().next().value;
      state.stations.delete(oldest);
    }

    const physical = row.types.get(row.key) || 0;
    const proof = proveStationStock({
      stationID: String(stationID),
      typeID: String(typeID),
      quantity: Math.max(1, quantity),
      arrival: { receiptID: "cargo:" + cargoID },
      // only a real observed native stack counts; a depot phase is never stock
      warehouseItems: hasPhysicalItem
        ? [{ stationID: String(stationID), typeID: String(typeID), itemID: String(itemID), quantity }]
        : [],
      depotStatus: record.phase,
    });
    if (proof.ok) state.proofs.proven += 1;
    else state.proofs.blocked += 1;

    state.deliveries += 1;
    state.receipts.push({
      cargoID,
      itemID,
      stationID,
      corporationID: Number(record.corporationID) || 0,
      typeID,
      quantity,
      durable: durable === true,
      phase: String(record.phase || ""),
      proof: proof.code,
      physical,
      at: new Date().toISOString(),
    });
    if (state.receipts.length > MAX_RECEIPTS) state.receipts.shift();

    persist(state.deliveries % 10 === 0);
    return { ok: true, code: "OBSERVED", cargoID, proof: proof.code, physical };
  } catch (error) {
    state.lastError = String((error && error.message) || error).slice(0, 300);
    return { ok: false, code: "OBSERVER_ERROR", error: state.lastError };
  }
}

function status() {
  const view = snapshot();
  if (enabled()) persist(true);
  return view;
}

module.exports = {
  enabled,
  assess,
  noteWarehouse,
  status,
  snapshot,
  ENABLE_FILE,
  STATE_FILE,
};
