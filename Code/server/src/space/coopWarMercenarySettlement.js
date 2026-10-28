"use strict";
// FW-038B: pay a mercenary contract with a journaled two-leg wallet transfer.
//
// Measured on the work stack 2026-10-28: the only funded corporation (ORE,
// 1000129, 136.5 M ISK in division 1000) has no combat hulls, and every faction
// that can field a navy holds 0 ISK, so no war party could ever escrow a bounty.
// FW-038 decides WHO to hire; this moves the money that pays for it.
//
// Rules, all of them conservative:
//  - value is CONSERVED: one debit and one credit of the same amount in the real
//    native corporation wallets, nothing minted;
//  - the event is durable BEFORE the first leg, so a retry can never pay twice;
//  - a debit that cannot be verified as applied is AMBIGUOUS and halts; it is
//    never replayed, because replaying a debit that did apply creates or destroys
//    ISK depending on which leg is repeated;
//  - a verified debit whose credit fails is recorded as PARTIAL_CREDIT_MISSING
//    with the exact amount still owed, and is not silently retried either.
const fs = require("node:fs");
const path = require("node:path");
const suffix = typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs";
const rows = require("./coopNativeRowPath" + suffix);

const TABLE = "corporationRuntime";
const KEY = "coop-faction-war\u001fmercenary-v1";
const VERSION = 1;
const MAX_EVENTS = 512;
const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const cents = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const key = (value) => typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value);

function empty() {
  return { version: VERSION, processed: {}, nextSerial: 1 };
}

function validate(state) {
  if (!state || state.version !== VERSION || !state.processed ||
    typeof state.processed !== "object" || Array.isArray(state.processed) ||
    !pos(state.nextSerial)) throw Error("WAR_MERCENARY_JOURNAL_INVALID");
  if (Object.keys(state.processed).length > MAX_EVENTS)
    throw Error("WAR_MERCENARY_JOURNAL_FULL");
  for (const [id, row] of Object.entries(state.processed)) {
    if (!key(id) || row?.eventID !== id || !pos(row?.payerCorporationID) ||
      !pos(row?.payeeCorporationID) || !cents(row?.amountCents) ||
      !["PREPARED", "PAID", "PARTIAL_CREDIT_MISSING", "AMBIGUOUS_DEBIT"].includes(row?.phase))
      throw Error("WAR_MERCENARY_JOURNAL_CORRUPT");
  }
  return state;
}

function createMercenarySettlement({
  gameStore,
  readBalance,
  applyDelta,
  clock = () => Date.now(),
  env = process.env,
  division = "1000",
} = {}) {
  if (typeof gameStore?.coopAtomicNativeRows?.transact !== "function" ||
    typeof readBalance !== "function" || typeof applyDelta !== "function" ||
    typeof clock !== "function")
    throw Error("WAR_MERCENARY_AUTHORITIES_REQUIRED");
  const enabled = () => String(env.EVEJS_COOP_WAR_MERCENARY_CONTRACT || "") === "1";
  const transact = (fn) => gameStore.coopAtomicNativeRows.transact([TABLE], fn);
  let busy = false;

  function read() {
    return transact((tx) => validate(tx.get(TABLE, KEY) || empty()));
  }

  function snapshot() {
    if (!enabled()) return { status: "DISABLED" };
    const state = read();
    return {
      status: "OK",
      events: Object.keys(state.processed).length,
      rows: Object.values(state.processed).map((row) => ({ ...row })),
    };
  }

  function isk(centsValue) {
    return Math.round(Number(centsValue)) / 100;
  }

  function execute({ eventID, payerCorporationID, payeeCorporationID, amountCents, dryRun = false } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    if (busy) return { status: "BLOCKED", reason: "WAR_MERCENARY_REENTRANT" };
    const payer = Number(payerCorporationID), payee = Number(payeeCorporationID);
    const amount = Number(amountCents);
    if (!key(eventID) || !pos(payer) || !pos(payee) || payer === payee || !cents(amount))
      return { status: "BLOCKED", reason: "INVALID_MERCENARY_IDENTITY" };
    busy = true;
    try {
      const prior = (() => {
        try { return read().processed[eventID] || null; } catch (_error) { return null; }
      })();
      if (prior) {
        if (prior.payerCorporationID !== payer || prior.payeeCorporationID !== payee ||
          prior.amountCents !== amount)
          return { status: "BLOCKED", reason: "WAR_MERCENARY_EVENT_CONFLICT" };
        if (prior.phase === "PAID") return { status: "DUPLICATE", entry: { ...prior } };
        // A debit that may have landed is never repeated.
        return { status: "BLOCKED", reason: "WAR_MERCENARY_PRIOR_LEG_UNRESOLVED", phase: prior.phase };
      }
      const payerBefore = readBalance(payer, division);
      const payeeBefore = readBalance(payee, division);
      const needISK = isk(amount);
      if (!Number.isFinite(payerBefore) || !Number.isFinite(payeeBefore))
        return { status: "BLOCKED", reason: "WAR_MERCENARY_WALLET_UNREADABLE" };
      if (payerBefore < needISK)
        return { status: "BLOCKED", reason: "WAR_MERCENARY_PAYER_INSOLVENT",
          payerBefore, needISK };
      const preview = {
        eventID, payerCorporationID: payer, payeeCorporationID: payee,
        amountCents: amount, payerBeforeISK: payerBefore, payeeBeforeISK: payeeBefore,
        payeeAfterISK: Math.round((payeeBefore + needISK) * 100) / 100,
      };
      if (dryRun) return { status: "DRY_RUN", phase: "PREPARED", preview };

      // Durable intent first: from here on a retry is refused, never re-paid.
      const prepared = transact((tx) => {
        const state = validate(tx.get(TABLE, KEY) || empty());
        if (state.processed[eventID]) return { ok: false, state };
        state.processed[eventID] = {
          eventID, phase: "PREPARED", payerCorporationID: payer,
          payeeCorporationID: payee, amountCents: amount,
          payerBeforeISK: payerBefore, payeeBeforeISK: payeeBefore,
          preparedAt: clock(),
        };
        state.nextSerial += 1;
        tx.put(TABLE, KEY, state);
        return { ok: true, state };
      });
      if (!prepared.ok) return { status: "DUPLICATE", entry: { ...prepared.state.processed[eventID] } };
      // JOURNALLED-NOT-DURABLE guard. Measured on the work stack 2026-10-28: the
      // intent row was written, the transfer paid, and a replay could no longer
      // read the row - it paid a second time and 25 000 ISK left the payer with no
      // matching credit. A money mover must never trust a write it cannot read
      // back, so the debit only happens when the journal really persists.
      let durable = null;
      try { durable = read().processed[eventID] || null; } catch (_error) { durable = null; }
      if (!durable || durable.phase !== "PREPARED")
        return { status: "BLOCKED", reason: "WAR_MERCENARY_JOURNAL_NOT_DURABLE",
          eventID, debitAttempted: false };

      const debit = applyDelta({ corporationID: payer, division, delta: -needISK, env });
      const payerAfter = readBalance(payer, division);
      const debitVerified = debit && debit.status === "OK" &&
        Number.isFinite(payerAfter) &&
        Math.abs((payerBefore - payerAfter) - needISK) <= 0.005;
      const finish = (phase, extra) => {
        try {
          transact((tx) => {
            const state = validate(tx.get(TABLE, KEY) || empty());
            const row = state.processed[eventID];
            if (!row) return;
            state.processed[eventID] = { ...row, phase, at: clock(), ...extra };
            tx.put(TABLE, KEY, state);
          });
        } catch (_error) { /* the journal is best effort; the wallets are the truth */ }
        return { status: phase === "PAID" ? "PAID" : "BLOCKED", phase, reason: extra.reason, ...extra };
      };
      if (!debitVerified) {
        return finish("AMBIGUOUS_DEBIT", {
          reason: "WAR_MERCENARY_DEBIT_UNVERIFIED",
          debitStatus: String((debit && debit.status) || "NO_RESULT"),
          payerAfterISK: payerAfter,
        });
      }
      const credit = applyDelta({ corporationID: payee, division, delta: needISK, env });
      const payeeAfter = readBalance(payee, division);
      const creditVerified = credit && credit.status === "OK" &&
        Number.isFinite(payeeAfter) &&
        Math.abs((payeeAfter - payeeBefore) - needISK) <= 0.005;
      if (!creditVerified) {
        return finish("PARTIAL_CREDIT_MISSING", {
          reason: "WAR_MERCENARY_CREDIT_UNVERIFIED",
          creditStatus: String((credit && credit.status) || "NO_RESULT"),
          payerAfterISK: payerAfter, payeeAfterISK: payeeAfter, owedISK: needISK,
        });
      }
      return finish("PAID", {
        payerAfterISK: payerAfter, payeeAfterISK: payeeAfter,
      });
    } finally { busy = false; }
  }

  return Object.freeze({ enabled, execute, snapshot, read });
}

module.exports = { TABLE, KEY, empty, validate, createMercenarySettlement };
