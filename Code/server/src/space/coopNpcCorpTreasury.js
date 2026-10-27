"use strict";
/**
 * ALIFE-17. The corporation earns nothing while its pilots do.
 *
 * The NPC market credits a PILOT ledger (`<market root>/ledger.json`), so after three
 * live sales the fleet's pilots held 98 402 ISK while the owning corporation's wallet
 * stayed at 0 - and the refinery, which charges a real station fee
 * (measured 4 998-23 760 ISK per stack), could therefore never run. The ore is the
 * corporation's, so the proceeds belong to the corporation.
 *
 * This sweeps earned pilot ISK into the corporation's own wallet in the native
 * gameStore, with a durable receipt and a compensating write if the credit fails. It
 * never mints: every cent moved already exists in the pilot ledger, and the amount is
 * debited there in the same operation.
 *
 * Default OFF (EVEJS_COOP_CORP_TREASURY=1).
 */

const fs = require("node:fs");
const path = require("node:path");

const FLAG = "EVEJS_COOP_CORP_TREASURY";
const DIR_FLAG = "EVEJS_COOP_NPC_MARKET_DIR";
const CORPORATION_FLAG = "EVEJS_COOP_FACTORY_CORP_ID";
const DEFAULT_CORP = 1000129;
const DIVISION = 1000;

const pos = (x) => {
  const n = Number(x);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
const cents = (isk) => Math.round(Number(isk) * 100);

function loadWallet() {
  try {
    return require("./coopCorpWallet.cjs");
  } catch (error) {
    if (error && error.code === "MODULE_NOT_FOUND") return require("./coopCorpWallet");
    throw error;
  }
}

function atomicWrite(file, value, fsApi) {
  fsApi.mkdirSync(path.dirname(file), {recursive: true});
  const tmp = file + ".tmp-" + process.pid;
  const fd = fsApi.openSync(tmp, "w", 0o600);
  try { fsApi.writeFileSync(fd, JSON.stringify(value)); fsApi.fsyncSync(fd); }
  finally { fsApi.closeSync(fd); }
  fsApi.renameSync(tmp, file);
}

// Read the pilot ledger without touching it: balances are cents-precise ISK.
function pilotEarnings(ledger) {
  const out = [];
  const pilots = ledger && ledger.pilots && typeof ledger.pilots === "object" ? ledger.pilots : {};
  for (const [pilotID, record] of Object.entries(pilots)) {
    const value = Number(record && record.balance);
    if (!Number.isFinite(value) || value <= 0) continue;
    out.push({pilotID, isk: Math.round(value * 100) / 100});
  }
  return out.sort((a, b) => b.isk - a.isk || String(a.pilotID).localeCompare(String(b.pilotID)));
}

function walletOf(record) {
  const divisions = record && record.divisions && typeof record.divisions === "object" ? record.divisions : null;
  return divisions;
}

function run(options = {}) {
  const env = options.env || process.env;
  if (String(env[FLAG] || "") !== "1") return {status: "DISABLED", moved: 0};
  const fsApi = options.fsApi || fs;
  const root = options.root || env[DIR_FLAG];
  if (typeof root !== "string" || !path.isAbsolute(root)) return {status: "MARKET_DIRECTORY_REQUIRED", moved: 0};
  const corporationID = pos(options.corporationID) || pos(env[CORPORATION_FLAG]) || DEFAULT_CORP;
  // FW-040: a pilot's earned ISK belongs to the pilot's OWN corporation. When the
  // caller can prove a pilot's corporation, only the pilots that really belong to
  // this corporation are swept - otherwise an Angel pilot's real sale would fund
  // an ORE factory, which is exactly why an armed faction never showed income.
  const resolveCorporation = typeof options.resolveCorporation === "function"
    ? options.resolveCorporation : null;
  const ledgerFile = path.join(root, "ledger.json");
  let ledger;
  try { ledger = JSON.parse(fsApi.readFileSync(ledgerFile, "utf8")); }
  catch (error) {
    return {status: error && error.code === "ENOENT" ? "NO_LEDGER" : "LEDGER_UNREADABLE", moved: 0};
  }
  const allEarnings = pilotEarnings(ledger);
  let skippedForeign = 0;
  const earnings = resolveCorporation
    ? allEarnings.filter((entry) => {
      let owner = 0;
      try { owner = Number(resolveCorporation(entry.pilotID)) || 0; }
      catch (_error) { owner = 0; }
      // An unknown owner is never swept: unproven ISK must not move.
      if (owner !== Number(corporationID)) { skippedForeign += 1; return false; }
      return true;
    })
    : allEarnings;
  if (!earnings.length)
    return {status: skippedForeign ? "NO_EARNINGS_FOR_THIS_CORPORATION" : "NO_PILOT_EARNINGS",
      moved: 0, skippedForeign};
  const total = Math.round(earnings.reduce((sum, entry) => sum + cents(entry.isk), 0)) / 100;
  if (!(total > 0)) return {status: "NO_PILOT_EARNINGS", moved: 0};

  const gameStore = options.gameStore || require("../gameStore");
  // The corporation's wallet is owned by the native corporation runtime. Reading it as a
  // raw store pointer reported CORP_WALLET_UNAVAILABLE forever on a world whose runtime
  // table had never been bootstrapped, while the pilots really held earned ISK.
  const wallet = loadWallet().readWallet({corporationState: options.corporationState,
    gameStore, corporationID});
  if (wallet.status !== "OK")
    return {status: wallet.status, moved: 0, reason: wallet.reason || ""};
  const divisions = wallet.divisions;
  const before = Number(divisions[DIVISION] && divisions[DIVISION].balance);
  if (!Number.isFinite(before) || before < 0) return {status: "CORP_WALLET_INVALID", moved: 0};

  // Debit the pilots first: if the credit then fails we put every cent back, so ISK can
  // never be lost or created by a half-applied sweep.
  const debited = ledger.pilots;
  for (const entry of earnings) {
    const record = debited[entry.pilotID] || {};
    debited[entry.pilotID] = {...record, balance: 0,
      lastCorpSweepAt: Number(options.now) || Date.now()};
  }
  try { atomicWrite(ledgerFile, ledger, fsApi); }
  catch (error) { return {status: "LEDGER_WRITE_FAILED", moved: 0, reason: String(error && error.message).slice(0, 80)}; }

  const written = loadWallet().applyDelta({corporationState: options.corporationState,
    gameStore, corporationID, division: DIVISION, delta: total});
  if (!written || written.status !== "OK") {
    for (const entry of earnings) {
      const record = debited[entry.pilotID] || {};
      debited[entry.pilotID] = {...record, balance: entry.isk};
    }
    try { atomicWrite(ledgerFile, ledger, fsApi); } catch (_error) { /* reported below */ }
    return {status: String((written && written.status) || "CORP_CREDIT_FAILED"), moved: 0,
      reason: String((written && (written.reason || written.status)) || "UNKNOWN").slice(0, 80)};
  }
  const after = Number.isFinite(Number(written.balance))
    ? Number(written.balance)
    : Math.round((before + total) * 100) / 100;
  if (typeof gameStore.flushTableSync === "function") {
    const flushed = gameStore.flushTableSync("corporationRuntime", {log: false});
    if (!flushed || flushed.success !== true) return {status: "CORP_FLUSH_UNCERTAIN", moved: total};
  }
  const receipt = {version: 1, status: "SWEPT", corporationID, division: DIVISION,
    amountISK: total, beforeISK: before, afterISK: after,
    pilots: earnings, at: Number(options.now) || Date.now()};
  try {
    atomicWrite(path.join(root, "corp-treasury", corporationID + ".json"), receipt, fsApi);
  } catch (_error) { /* the money already moved; the ledger is the authority */ }
  try {
    const observe = options.observe || require("./coopObserve").observe;
    const probe = options.probe || require("./coopRuntimeProbe");
    observe(probe, "living-npc-corp-wallet-funded", {systemID: 0}, {
      corporationID, amountISK: total, beforeISK: before, afterISK: receipt.afterISK,
      pilots: earnings.length});
  } catch (_error) { /* telemetry only */ }
  return {status: "SWEPT", moved: total, corporationID, afterISK: receipt.afterISK,
    pilots: earnings.length, skippedForeign};
}

module.exports = {FLAG, DIR_FLAG, CORPORATION_FLAG, DEFAULT_CORP, DIVISION, pilotEarnings, run};
