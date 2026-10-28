"use strict";
// Reconciliation for a market journal left in phase RPC_CALLING.
//
// Doctrine (docs/NATIVE_NPC_MARKET.md): an ambiguous market RPC halts the NPC's
// trading and the fill is NEVER repeated. Halting is right, but the SAME rule
// must not leave real ISK uncredited for ever: the market daemon is the
// authority on whether a fill happened, so the outcome is decided by READING
// that authority, never by re-sending the RPC.
//
// This module therefore:
//   1. accepts only a journal in phase RPC_CALLING,
//   2. proves the fill from the market's own order row (a seed bid that is
//      state "filled", carries exactly our quantity and has nothing left),
//   3. settles the pilot ledger locally exactly once,
//   4. writes a durable receipt naming that proof, and removes the journal.
// Anything it cannot prove stays pending for a human: it never guesses and
// never retries the trade.
const fs = require("node:fs");
const path = require("node:path");

const pilotName = (x) => typeof x === "string" && /^coop-pilot-[0-9]{3,}$/.test(x);
const amount = (x) => Number.isFinite(Number(x)) && Number(x) >= 0 ? Math.round(Number(x) * 100) / 100 : null;
const sameID = (a, b) => String(a) === String(b);
// An order ID is far beyond Number.MAX_SAFE_INTEGER, so it is compared as text.
const PROOF_TOLERANCE_MS = 120000;

function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

function parseTime(value) {
  const text = String(value || "");
  const ms = Date.parse(text);
  if (Number.isFinite(ms)) return ms;
  // RFC3339 with nanosecond fraction: Date only understands milliseconds.
  const trimmed = text.replace(/(\.\d{3})\d+/, "$1");
  const retry = Date.parse(trimmed);
  return Number.isFinite(retry) ? retry : null;
}

// Prove that the market itself recorded this exact fill. Returns
// {ok:true, ack} or {ok:false, reason}.
function proveFill(tx, order, { toleranceMs = PROOF_TOLERANCE_MS } = {}) {
  if (!tx || typeof tx !== "object") return { ok: false, reason: "JOURNAL_INVALID" };
  if (tx.side !== "sell") return { ok: false, reason: "JOURNAL_SIDE_NOT_SELL" };
  if (!pilotName(tx.pilotID)) return { ok: false, reason: "JOURNAL_PILOT_INVALID" };
  if (!Number.isSafeInteger(tx.quantity) || tx.quantity < 1) return { ok: false, reason: "JOURNAL_QUANTITY_INVALID" };
  if (!order || typeof order !== "object") return { ok: false, reason: "MARKET_ORDER_UNAVAILABLE" };
  if (!sameID(order.order_id, tx.marketOrderID)) return { ok: false, reason: "MARKET_ORDER_ID_MISMATCH" };
  if (String(order.state || "") !== "filled") return { ok: false, reason: "MARKET_ORDER_NOT_FILLED" };
  const row = order.row;
  if (!row || typeof row !== "object") return { ok: false, reason: "MARKET_ORDER_ROW_MISSING" };
  if (!sameID(row.order_id, tx.marketOrderID)) return { ok: false, reason: "MARKET_ROW_ORDER_ID_MISMATCH" };
  if (row.bid !== true) return { ok: false, reason: "MARKET_ROW_NOT_BID" };
  if (Number(row.station_id) !== Number(tx.stationID)) return { ok: false, reason: "MARKET_ROW_STATION_MISMATCH" };
  if (Number(row.type_id) !== Number(tx.typeID)) return { ok: false, reason: "MARKET_ROW_TYPE_MISMATCH" };
  if (Number(row.price) !== Number(tx.price)) return { ok: false, reason: "MARKET_ROW_PRICE_MISMATCH" };
  if (Number(row.vol_remaining) !== 0) return { ok: false, reason: "MARKET_ROW_STILL_OPEN" };
  // The fill must be exactly ours: the row carries our quantity and nothing more.
  if (Number(row.vol_entered) !== tx.quantity) return { ok: false, reason: "MARKET_ROW_VOLUME_MISMATCH" };
  const issuedAt = parseTime(row.issued_at);
  if (issuedAt === null) return { ok: false, reason: "MARKET_ROW_ISSUED_AT_MISSING" };
  if (Math.abs(issuedAt - Number(tx.at)) > toleranceMs) return { ok: false, reason: "MARKET_ROW_ISSUED_AT_NOT_THIS_TRADE" };
  return {
    ok: true,
    // The acknowledgement the settled trade would have produced.
    ack: {
      order_id: String(tx.marketOrderID),
      filled_quantity: tx.quantity,
      bid: true,
      station_id: Number(tx.stationID),
      type_id: Number(tx.typeID),
      price: Number(tx.price),
    },
    proof: {
      orderID: String(tx.marketOrderID),
      state: String(order.state),
      volEntered: Number(row.vol_entered),
      volRemaining: Number(row.vol_remaining),
      price: Number(row.price),
      stationID: Number(row.station_id),
      typeID: Number(row.type_id),
      issuedAt: String(row.issued_at),
      journalAt: new Date(Number(tx.at)).toISOString(),
    },
  };
}

async function reconcileJournals({ root = "/var/lib/evejs/coop-native-market", inspectOrder, store, sceneForSystem,
  resolveType, toleranceMs = PROOF_TOLERANCE_MS, now = () => Date.now(), dryRun = false } = {}) {
  if (typeof inspectOrder !== "function") throw Error("RECONCILE_INSPECTOR_REQUIRED");
  const dir = path.join(root, "tx");
  let files;
  try {
    files = fs.readdirSync(dir).filter((x) => /^coop-pilot-[0-9]{3,}\.json$/.test(x));
  } catch (error) {
    if (error.code === "ENOENT") return { settled: [], pending: [] };
    throw error;
  }
  const settled = [];
  const pending = [];
  for (const file of files) {
    const journalFile = path.join(dir, file);
    let tx;
    try {
      tx = JSON.parse(fs.readFileSync(journalFile, "utf8"));
    } catch (_error) {
      pending.push({ file, reason: "JOURNAL_CORRUPT" });
      continue;
    }
    // Anything else belongs to the normal recover() path.
    if (tx.phase !== "RPC_CALLING") continue;
    let order;
    try {
      // The market client's RPC is asynchronous; a rejected or timed-out read is
      // an unknown outcome, never a proof.
      order = await inspectOrder(tx.marketOrderID);
    } catch (_error) {
      pending.push({ file, reason: "RPC_OUTCOME_UNKNOWN" });
      continue;
    }
    const proof = proveFill(tx, order, { toleranceMs });
    if (proof.ok !== true) {
      pending.push({ file, reason: proof.reason || "RPC_OUTCOME_UNKNOWN" });
      continue;
    }
    // A pilot whose balance already moved cannot be settled twice.
    const ledgerFile = path.join(root, "ledger.json");
    let ledger;
    try {
      ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ledger = { version: 1, pilots: {} };
    }
    if (ledger?.version !== 1 || !ledger.pilots || typeof ledger.pilots !== "object") {
      pending.push({ file, reason: "NPC_MARKET_LEDGER_INVALID" });
      continue;
    }
    const account = ledger.pilots[tx.pilotID] || { balance: 0, lastTradeAt: 0, tradeCount: 0 };
    if (amount(account.balance) === null) {
      pending.push({ file, reason: "NPC_MARKET_ACCOUNT_INVALID" });
      continue;
    }
    if (account.balance === tx.afterBalance) {
      // The trade was already applied locally; only the journal was left behind.
      const receipt = { version: 1, status: "SETTLED_ALREADY_APPLIED", ...proof.proof, pilotID: tx.pilotID,
        at: Number(tx.at), reconciledAt: now() };
      atomic(path.join(root, "reconciled", file), receipt);
      fs.unlinkSync(journalFile);
      settled.push({ file, pilotID: tx.pilotID, alreadyApplied: true });
      continue;
    }
    if (account.balance !== tx.beforeBalance) {
      pending.push({ file, reason: "NPC_MARKET_BALANCE_CONFLICT" });
      continue;
    }
    // Local cargo: the goods are either still here untouched, already at the
    // post-trade quantity, or gone. Anything else is somebody else's conflict.
    const cargoRows = store && typeof store.listNativeCargoForEntity === "function"
      ? store.listNativeCargoForEntity(tx.entityID) || []
      : [];
    const cargo = cargoRows.find((row) => Number(row.cargoID) === Number(tx.cargoID)) || null;
    let cargoState = "ABSENT_SINCE";
    if (dryRun) {
      settled.push({ file, pilotID: tx.pilotID, entityID: Number(tx.entityID), quantity: Number(tx.quantity),
        price: Number(tx.price), isk: Math.round(Number(tx.price) * Number(tx.quantity) * 100) / 100,
        beforeBalance: tx.beforeBalance, afterBalance: tx.afterBalance,
        cargoPresent: Boolean(cargo), dryRun: true, proof: proof.proof });
      continue;
    }
    if (cargo) {
      if (Number(cargo.entityID) !== Number(tx.entityID) || Number(cargo.typeID) !== Number(tx.typeID)) {
        pending.push({ file, reason: "NPC_MARKET_CARGO_IDENTITY_CHANGED" });
        continue;
      }
      if (Number(cargo.quantity) === Number(tx.afterQuantity)) {
        cargoState = "ALREADY_APPLIED";
      } else if (Number(cargo.quantity) === Number(tx.beforeQuantity)) {
        cargoState = "APPLIED_NOW";
        if (Number(tx.afterQuantity) === 0) {
          const removed = store.removeNativeCargo(tx.cargoID);
          if (removed?.success !== true) {
            pending.push({ file, reason: "NPC_MARKET_CARGO_REMOVE_FAILED" });
            continue;
          }
        } else {
          const written = store.upsertNativeCargo({ ...cargo, quantity: Number(tx.afterQuantity) },
            { transient: cargo.transient === true });
          if (written?.success !== true) {
            pending.push({ file, reason: "NPC_MARKET_CARGO_WRITE_FAILED" });
            continue;
          }
        }
      } else {
        pending.push({ file, reason: "NPC_MARKET_CARGO_CONFLICT" });
        continue;
      }
    }
    // Durable receipt BEFORE the ledger, so a crash repeats settle, not the proof.
    const receipt = { version: 1, status: "SETTLED_BY_MARKET_PROOF", ...proof.proof,
      pilotID: tx.pilotID, entityID: Number(tx.entityID), systemID: Number(tx.systemID),
      stationID: Number(tx.stationID), typeID: Number(tx.typeID), quantity: Number(tx.quantity),
      price: Number(tx.price), beforeBalance: tx.beforeBalance, afterBalance: tx.afterBalance,
      isk: Math.round(Number(tx.price) * Number(tx.quantity) * 100) / 100,
      cargoID: Number(tx.cargoID), cargoState, at: Number(tx.at), reconciledAt: now(),
      marketRPC: "FillOrder", replayed: false };
    atomic(path.join(root, "reconciled", file), receipt);
    ledger.pilots[tx.pilotID] = { balance: tx.afterBalance, lastTradeAt: Number(tx.at),
      tradeCount: Number(account.tradeCount || 0) + 1 };
    atomic(ledgerFile, ledger);
    // The live hull caches nativeCargoItems; refresh it from the store, which is
    // the authority, before declaring the sale settled.
    try {
      const scene = sceneForSystem(tx.systemID);
      const live = scene?.getEntityByID?.(Number(tx.entityID));
      if (live && live.kind === "ship" && live.nativeNpc === true &&
        typeof store.buildNativeCargoItems === "function" && typeof resolveType === "function") {
        const items = store.buildNativeCargoItems(tx.entityID);
        if (Array.isArray(items)) {
          live.nativeCargoItems = items.map((item) => {
            const type = resolveType(item.typeID);
            return { ...item, volume: type?.volume === null || type?.volume === undefined
              ? 0 : Math.max(0, Number(type.volume) || 0) };
          });
        }
      }
    } catch (_refreshError) { /* the ledger is already settled; the cache heals on reload */ }
    fs.unlinkSync(journalFile);
    settled.push({ file, pilotID: tx.pilotID, entityID: Number(tx.entityID), quantity: Number(tx.quantity),
      price: Number(tx.price), isk: receipt.isk, cargoState, proof: proof.proof });
  }
  return { settled, pending };
}

module.exports = { proveFill, reconcileJournals };
