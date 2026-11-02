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
const ShadowLock = require("./coopEconomyShadowLock");

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
  conflicts: [],
  lastWriteAt: 0,
  lastError: null,
  lastLock: null,
  hydrated: false,
};

// A restart must not erase the evidence: the persisted totals are loaded once, before the first
// observation, and the file is never rewritten with a smaller picture than it already had.
function hydrate() {
  if (state.hydrated) return;
  state.hydrated = true;
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, "utf8");
  } catch (error) {
    return; // no file yet is the normal first run
  }
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch (error) {
    state.lastError = "STATE_UNREADABLE";
    return;
  }
  if (!saved || typeof saved !== "object") {
    state.lastError = "STATE_UNREADABLE";
    return;
  }
  if (typeof saved.startedAt === "string") state.startedAt = saved.startedAt;
  if (Number.isSafeInteger(saved.deliveries) && saved.deliveries > 0) state.deliveries = saved.deliveries;
  if (Number.isSafeInteger(saved.replays) && saved.replays > 0) state.replays = saved.replays;
  if (saved.proofs && typeof saved.proofs === "object") {
    if (Number.isSafeInteger(saved.proofs.proven)) state.proofs.proven = saved.proofs.proven;
    if (Number.isSafeInteger(saved.proofs.blocked)) state.proofs.blocked = saved.proofs.blocked;
  }
  if (Array.isArray(saved.conflicts)) {
    state.conflicts = saved.conflicts.filter((c) => c && Number.isSafeInteger(c.cargoID)).slice(-50);
  }
  if (Array.isArray(saved.receipts)) {
    state.receipts = saved.receipts.filter((r) => r && typeof r === "object" && Number.isSafeInteger(r.cargoID)).slice(-MAX_RECEIPTS);
  }
  if (saved.stations && typeof saved.stations === "object") {
    for (const [stationID, types] of Object.entries(saved.stations)) {
      if (!types || typeof types !== "object") continue;
      const row = new Map();
      for (const [typeID, quantity] of Object.entries(types)) {
        if (Number.isSafeInteger(quantity) && quantity > 0) row.set(Number(typeID), quantity);
      }
      if (row.size > 0) state.stations.set(Number(stationID), row);
    }
  }
}

function enabled() {
  if (process.env.EVEJS_COOP_ECONOMY_V2 === "1") {
    hydrate();
    return true;
  }
  try {
    if (!fs.existsSync(ENABLE_FILE)) return false;
  } catch (error) {
    return false;
  }
  hydrate();
  return true;
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
  // hydrate FIRST. The object literal below evaluates `mode: enabled()`, and enabled() hydrates;
  // evaluating stations before that produced an EMPTY station map on the first snapshot after a
  // restart while deliveries and receipts looked correct, and status() then persisted that empty
  // picture over the good one. A view must never be smaller than the file it came from.
  hydrate();
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
    conflicts: state.conflicts.map((c) => ({ ...c })),
    lastWriteAt: state.lastWriteAt,
    lastError: state.lastError,
    lastLock: state.lastLock,
    readiness: assess(),
    generatedAt: new Date().toISOString(),
  };
}

// Merge what is on disk into memory before writing, so a second writer is never erased and the
// file can only grow.
//
// Independent review 2026-11-02: the merge was read-modify-write with no cross-process
// serialisation, so two writers could both read version N and the second rename erased the first
// writer's receipts (measured: cargo 1039 lost by a concurrent writer). persist() now holds a lock
// for the whole merge+write. A cargoID that disagrees between memory and disk is resolved by the
// newer evidence and the disagreement is recorded in state.conflicts, never silently dropped.
function receiptStamp(receipt) {
  const numeric = Number(receipt && receipt.updatedAt);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const at = receipt && receipt.at;
  if (typeof at === "number" && Number.isFinite(at)) return at;
  if (typeof at === "string") {
    const parsed = Date.parse(at);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function sameReceipt(a, b) {
  return Number(a.stationID) === Number(b.stationID)
    && Number(a.typeID) === Number(b.typeID)
    && Number(a.quantity) === Number(b.quantity)
    && String(a.proof) === String(b.proof);
}

function noteConflict(cargoID, resolution) {
  const row = { cargoID, resolution, at: new Date().toISOString() };
  state.conflicts = state.conflicts.filter((c) => Number(c.cargoID) !== cargoID);
  state.conflicts.push(row);
  if (state.conflicts.length > 50) state.conflicts = state.conflicts.slice(-50);
}

function mergeFromDisk() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, "utf8");
  } catch (error) {
    return; // no file yet is the normal first run
  }
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch (error) {
    state.lastError = "STATE_UNREADABLE";
    return; // an unreadable file is named by hydrate(); never merge garbage
  }
  if (!saved || typeof saved !== "object") return;

  const index = new Map(state.receipts.map((r, i) => [Number(r.cargoID), i]));
  for (const receipt of Array.isArray(saved.receipts) ? saved.receipts : []) {
    const id = Number(receipt && receipt.cargoID);
    if (!Number.isSafeInteger(id)) continue;
    const at = index.get(id);
    if (at === undefined) {
      state.receipts.push(receipt);
      index.set(id, state.receipts.length - 1);
      continue;
    }
    const mine = state.receipts[at];
    if (sameReceipt(mine, receipt)) continue;
    if (receiptStamp(receipt) > receiptStamp(mine)) {
      state.receipts[at] = receipt;
      noteConflict(id, "DISK_NEWER");
    } else {
      noteConflict(id, "MEMORY_NEWER");
    }
  }
  if (state.receipts.length > MAX_RECEIPTS) {
    state.receipts = state.receipts.slice(-MAX_RECEIPTS);
  }
  if (Number.isSafeInteger(saved.deliveries)) {
    state.deliveries = Math.max(state.deliveries, saved.deliveries);
  }
  if (Number.isSafeInteger(saved.replays)) state.replays = Math.max(state.replays, saved.replays);
  if (saved.proofs && typeof saved.proofs === "object") {
    if (Number.isSafeInteger(saved.proofs.proven)) state.proofs.proven = Math.max(state.proofs.proven, saved.proofs.proven);
    if (Number.isSafeInteger(saved.proofs.blocked)) state.proofs.blocked = Math.max(state.proofs.blocked, saved.proofs.blocked);
  }
  const savedStations = saved.stations && typeof saved.stations === "object" ? saved.stations : {};
  for (const [stationKey, types] of Object.entries(savedStations)) {
    if (!types || typeof types !== "object") continue;
    const stationID = Number(stationKey);
    if (!Number.isSafeInteger(stationID)) continue;
    for (const [typeKey, quantity] of Object.entries(types)) {
      const typeID = Number(typeKey);
      const value = Number(quantity);
      if (!Number.isSafeInteger(typeID) || !Number.isFinite(value) || value <= 0) continue;
      const row = stationRow(stationID, typeID);
      const current = row.types.get(row.key) || 0;
      if (value > current) row.types.set(row.key, value);
    }
  }
  while (state.stations.size > MAX_STATIONS) {
    state.stations.delete(state.stations.keys().next().value);
  }
}

function persist(force) {
  const now = Date.now();
  if (!force && now - state.lastWriteAt < 2000) return;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  } catch (error) {
    state.lastError = String((error && error.message) || error).slice(0, 300);
    return;
  }
  // one writer at a time across processes: the merge and the rename are one critical section.
  // The lock is held for a merge and a rename (milliseconds); retry briefly so an observation is
  // never dropped just because another writer happened to be inside the critical section.
  let lock = ShadowLock.acquire(STATE_FILE, { staleMs: 30000 });
  for (let attempt = 0; !lock.ok && attempt < 100; attempt += 1) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } catch (_e) { /* busy wait */ }
    lock = ShadowLock.acquire(STATE_FILE, { staleMs: 30000 });
  }
  if (!lock.ok) {
    // nothing was written; the observation stays in memory and the next lock persists it, so a
    // busy lock can delay evidence but can never erase it
    state.lastLock = lock.code;
    return;
  }
  try {
    state.lastLock = null;
    mergeFromDisk();
    state.lastWriteAt = now;
    const body = JSON.stringify(snapshot(), null, 2);
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, STATE_FILE);
  } catch (error) {
    state.lastError = String((error && error.message) || error).slice(0, 300);
  } finally {
    lock.release();
  }
}

// Called by coopNativeWarehouse right after a durable COMMITTED receipt.
// record: { cargoID, corporationID, stationID, typeID, quantity, itemID }
// item:   the real native ItemStore stack (or null when it was already committed)
function noteWarehouse(record, item, durable) {
  if (!enabled()) return null;
  try {
    // a cargo id is a number: a numeric string is a caller bug, not a receipt
    if (!record || typeof record.cargoID !== "number" || !Number.isSafeInteger(record.cargoID) || record.cargoID <= 0) return null;
    if (state.startedAt === null) state.startedAt = new Date().toISOString();

    const cargoID = Number(record.cargoID);
    const stationID = Number(record.stationID) || 0;
    const typeID = Number(record.typeID) || 0;
    const quantity = Number(record.quantity) || 0;
    const itemID = Number((item && item.itemID) || record.itemID) || 0;
    // what the caller OBSERVED in the native ItemStore, never what the receipt claims
    const observedItemID = Number(item && item.itemID) || 0;

    // one native cargoID is one receipt; a retry of the same stack is a replay
    if (state.receipts.some((r) => r.cargoID === cargoID)) {
      state.replays += 1;
      persist(false);
      return { ok: true, code: "ALREADY_OBSERVED", cargoID };
    }

    // A COMMITTED receipt without a real ItemStore stack is NOT station stock.
    // Counting it would let a bare depot phase unlock a refinery, so it is
    // recorded as a blocked observation and never added to the physical total.
    const hasPhysicalItem = observedItemID > 0 && quantity > 0;
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
        ? [{ stationID: String(stationID), typeID: String(typeID), itemID: String(observedItemID), quantity }]
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

    // A new receipt is the product of this module: it is written immediately. The 2-second
    // throttle was measured to lose evidence - two receipts arrive as a batch (25999 units and the
    // 1-unit remainder), the second one waits out the throttle in memory, and a restart in that
    // window drops it (measured live 2026-11-01: cargo 980200218463 was observed and never stored).
    persist(true);
    return { ok: true, code: "OBSERVED", cargoID, proof: proof.code, physical };
  } catch (error) {
    state.lastError = String((error && error.message) || error).slice(0, 300);
    return { ok: false, code: "OBSERVER_ERROR", error: state.lastError };
  }
}

function status() {
  // hydrate before snapshotting: the first status() after a restart must never report or overwrite
  // a smaller picture than the one already on disk
  // hydrate first, whatever the switch says: an operator reading the view while the shadow is
  // OFF must see what is on disk, and a corrupt state file must be named instead of looking empty.
  hydrate();
  const live = enabled();
  const view = snapshot();
  if (live) persist(true);
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
