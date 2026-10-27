"use strict";

/**
 * The corporation's wallet, read and written through the NATIVE owner.
 *
 * Measured 2026-10-27 on the work stack: `/corporations/<id>/wallet` inside the
 * `corporationRuntime` table returned nothing at all, because that table had never been
 * bootstrapped (`ensureRuntimeInitialized` had never run in that world) - so both the
 * treasury sweep and the refinery fee reported CORP_WALLET_UNAVAILABLE while the pilot
 * really did hold 26 018 500 ISK of earned ore money.
 *
 * The corporation runtime is owned by `services/corporation/corporationRuntimeState`.
 * Reading and crediting through it means the native bootstrap creates the missing
 * divisions, and a balance change is written by the same module (and the same in-process
 * cache) that all native corporation code uses. The raw gameStore pointer stays as a
 * fallback so unit tests and a checkout without that module keep working, but the native
 * module is always preferred when it is present.
 *
 * Nothing here mints: callers only ever move ISK that already exists elsewhere.
 */

const DIVISION_FLAG = "EVEJS_COOP_CORP_DIVISION";
const DEFAULT_DIVISION = 1000;

function divisionID(env = process.env) {
  const raw = Number(env && env[DIVISION_FLAG]);
  return Number.isSafeInteger(raw) && raw >= 1000 && raw <= 1006 ? raw : DEFAULT_DIVISION;
}

function loadNative() {
  try {
    return require("../services/corporation/corporationRuntimeState");
  } catch (_error) {
    // A unit-test run or a checkout without the native module: the pointer path below
    // is the documented fallback, never a silent success.
    return null;
  }
}

function walletOf(record) {
  const divisions =
    record && record.divisions && typeof record.divisions === "object" ? record.divisions : null;
  return divisions;
}

function balanceOf(divisions, division) {
  const entry = divisions && divisions[String(division)];
  const balance = Number(entry && entry.balance);
  return Number.isFinite(balance) ? balance : null;
}

function pointer(corporationID) {
  return "/corporations/" + corporationID + "/wallet";
}

function readWallet({corporationState, gameStore, corporationID}) {
  const native =
    corporationState ||
    (gameStore && gameStore.coopCorporationState) ||
    loadNative();
  if (native && typeof native.getCorporationRuntime === "function") {
    let runtime = null;
    try {
      runtime = native.getCorporationRuntime(corporationID);
    } catch (error) {
      return {status: "CORP_WALLET_UNREADABLE", source: "native",
        reason: String((error && error.message) || error).slice(0, 80)};
    }
    const divisions = walletOf(runtime && runtime.wallet);
    if (!divisions)
      return {status: "CORP_WALLET_UNAVAILABLE", source: "native",
        reason: runtime ? "NO_WALLET_DIVISIONS" : "NO_CORPORATION_RUNTIME"};
    return {status: "OK", source: "native", divisions};
  }
  if (!gameStore || typeof gameStore.read !== "function")
    return {status: "GAMESTORE_UNAVAILABLE", source: "pointer"};
  const current = gameStore.read("corporationRuntime", pointer(corporationID));
  const divisions = current && current.success === true ? walletOf(current.data) : null;
  if (!divisions)
    return {status: "CORP_WALLET_UNAVAILABLE", source: "pointer",
      reason: String((current && current.errorMsg) || "").slice(0, 80)};
  return {status: "OK", source: "pointer", divisions};
}

/**
 * Move `delta` ISK (positive = credit the corporation, negative = the corporation pays)
 * in one division. The write is verified by reading the balance back: a write that
 * silently does nothing must never look like a payment.
 */
function applyDelta({corporationState, gameStore, corporationID, division, delta, env}) {
  const key = Number(division) || divisionID(env);
  const amount = Math.round(Number(delta) * 100) / 100;
  if (!Number.isFinite(amount) || amount === 0)
    return {status: "DELTA_INVALID", moved: 0};
  const native =
    corporationState ||
    (gameStore && gameStore.coopCorporationState) ||
    loadNative();
  if (native && typeof native.updateCorporationRuntime === "function") {
    let expected = null;
    let writeResult = null;
    try {
      writeResult = native.updateCorporationRuntime(corporationID, (current) => {
        const divisions = walletOf(current && current.wallet) || {};
        const before = balanceOf(divisions, key) ?? 0;
        expected = Math.round((before + amount) * 100) / 100;
        return {
          ...(current || {}),
          wallet: {
            ...((current && current.wallet) || {}),
            divisions: {
              ...divisions,
              [String(key)]: {
                ...(divisions[String(key)] || {}),
                balance: expected,
              },
            },
          },
        };
      });
    } catch (error) {
      return {status: "CORP_CREDIT_FAILED", moved: 0, source: "native",
        reason: String((error && error.message) || error).slice(0, 80)};
    }
    if (!writeResult || writeResult.success !== true)
      return {status: "CORP_CREDIT_FAILED", moved: 0, source: "native",
        reason: String((writeResult && (writeResult.errorMsg || writeResult.status)) || "UNKNOWN").slice(0, 80)};
    let after = null;
    try {
      after = balanceOf(walletOf((native.getCorporationRuntime(corporationID) || {}).wallet), key);
    } catch (_error) {
      after = null;
    }
    if (after === null || expected === null || Math.abs(after - expected) > 0.005)
      return {status: "CORP_CREDIT_UNVERIFIED", moved: 0, source: "native",
        expected, balance: after};
    return {status: "OK", moved: Math.abs(amount), balance: after, source: "native"};
  }
  if (!gameStore || typeof gameStore.read !== "function" || typeof gameStore.write !== "function")
    return {status: "GAMESTORE_UNAVAILABLE", moved: 0, source: "pointer"};
  const current = gameStore.read("corporationRuntime", pointer(corporationID));
  const divisions = current && current.success === true ? walletOf(current.data) : null;
  if (!divisions)
    return {status: "CORP_WALLET_UNAVAILABLE", moved: 0, source: "pointer"};
  const before = balanceOf(divisions, key);
  if (before === null || before < 0)
    return {status: "CORP_WALLET_INVALID", moved: 0, source: "pointer"};
  const expected = Math.round((before + amount) * 100) / 100;
  if (expected < 0) return {status: "CORP_WALLET_INSUFFICIENT", moved: 0, balance: before};
  const next = {
    divisions: {
      ...divisions,
      [String(key)]: {...(divisions[String(key)] || {}), balance: expected},
    },
  };
  const written = gameStore.write("corporationRuntime", pointer(corporationID), next);
  if (!written || written.success !== true)
    return {status: "CORP_CREDIT_FAILED", moved: 0, source: "pointer",
      reason: String((written && written.errorMsg) || "UNKNOWN").slice(0, 80)};
  return {status: "OK", moved: Math.abs(amount), balance: expected, source: "pointer"};
}

module.exports = {
  DEFAULT_DIVISION,
  divisionID,
  balanceOf,
  readWallet,
  applyDelta,
  _testing: {loadNative, walletOf, pointer},
};
