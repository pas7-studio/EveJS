"use strict";
// FW-038C: pay a mercenary contract where the WALLET is the idempotency anchor.
//
// MEASURED FAILURE it fixes (work stack 2026-10-28): the first version journalled
// its intent in a separate `corporationRuntime` row, paid, and a replay 28 s later
// could no longer read that row - it paid again and 25 000 ISK was destroyed. Rows
// written through the atomic store do not reliably survive here, so a money mover
// must never anchor "did I already pay?" in one.
//
// This version marks every leg inside the same corporation record that holds the
// money: the payer's wallet journal gets `FW-MERC <eventID> DEBIT` and the payee's
// gets `FW-MERC <eventID> CREDIT`, written in the same write as the balance. A
// replay is therefore refused by the wallet itself, and a missing credit can be
// completed later without ever repeating the debit.
//
// Value is conserved: one debit and one credit of the same amount, nothing minted.
const KEY_BANK = "corporationRuntime";
const DIVISION = "1000";
const MAX_JOURNAL = 100;
const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const cents = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const key = (value) => typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value);
const round = (value) => Math.round(Number(value) * 100) / 100;

function walletPointer(corporationID) {
  return "/corporations/" + Number(corporationID) + "/wallet";
}

function createMercenarySettlement({ gameStore, clock = () => Date.now(), env = process.env } = {}) {
  if (typeof gameStore?.read !== "function" || typeof gameStore?.write !== "function" ||
    typeof clock !== "function") throw Error("WAR_MERCENARY_AUTHORITIES_REQUIRED");
  const enabled = () => String(env.EVEJS_COOP_WAR_MERCENARY_CONTRACT || "") === "1";

  function walletOf(corporationID) {
    const current = gameStore.read(KEY_BANK, walletPointer(corporationID));
    if (!current || current.success !== true || !current.data) return null;
    const divisions = current.data.divisions;
    if (!divisions || typeof divisions !== "object") return null;
    return current.data;
  }

  function balanceOf(corporationID) {
    const wallet = walletOf(corporationID);
    const value = Number(wallet && wallet.divisions && wallet.divisions[DIVISION] &&
      wallet.divisions[DIVISION].balance);
    return Number.isFinite(value) ? value : NaN;
  }

  function marker(eventID, side) {
    return "FW-MERC " + String(eventID) + " " + side;
  }

  // One leg. The marker lives in the wallet journal, in the same write as the
  // balance, so it cannot outlive or outrun the money it describes.
  function leg({ corporationID, eventID, side, deltaISK }) {
    const wallet = walletOf(corporationID);
    if (!wallet) return { status: "WALLET_UNREADABLE", corporationID };
    const division = { ...(wallet.divisions[DIVISION] || {}) };
    const balance = Number(division.balance) || 0;
    const journal = Array.isArray(division.journal) ? division.journal : [];
    const mark = marker(eventID, side);
    if (journal.some((entry) => String((entry && entry.description) || "").includes(mark)))
      return { status: "DUPLICATE", corporationID, balance };
    const next = round(balance + deltaISK);
    if (!Number.isFinite(next) || next < 0)
      return { status: "INSUFFICIENT", corporationID, balance };
    const lastID = journal.length
      ? Number(journal[journal.length - 1] && journal[journal.length - 1].transactionID) || 0 : 0;
    const entry = {
      transactionID: lastID + 1,
      transactionDate: String(clock()),
      description: mark,
      amount: round(deltaISK),
      balance: next,
    };
    const nextWallet = {
      ...wallet,
      divisions: {
        ...wallet.divisions,
        [DIVISION]: { ...division, balance: next, journal: [...journal, entry].slice(-MAX_JOURNAL) },
      },
    };
    const written = gameStore.write(KEY_BANK, walletPointer(corporationID), nextWallet);
    if (!written || written.success !== true)
      return { status: "WRITE_FAILED", corporationID, reason: String((written && written.errorMsg) || "") };
    const after = balanceOf(corporationID);
    if (!Number.isFinite(after) || Math.abs(after - next) > 0.005)
      return { status: "UNVERIFIED", corporationID, balance: after, expected: next };
    return { status: "APPLIED", corporationID, before: balance, balance: next };
  }

  function snapshot({ eventID = "", payerCorporationID = 0, payeeCorporationID = 0 } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const debtorWallet = walletOf(Number(payerCorporationID));
    const journal = (debtorWallet && debtorWallet.divisions && debtorWallet.divisions[DIVISION] &&
      Array.isArray(debtorWallet.divisions[DIVISION].journal))
      ? debtorWallet.divisions[DIVISION].journal : [];
    const rows = journal
      .filter((entry) => String((entry && entry.description) || "").startsWith("FW-MERC "))
      .map((entry) => ({ description: entry.description, amount: entry.amount, at: entry.transactionDate }));
    return {
      status: "OK",
      eventID: String(eventID || ""),
      payerBalanceISK: balanceOf(Number(payerCorporationID)),
      payeeBalanceISK: balanceOf(Number(payeeCorporationID)),
      legs: rows.slice(-20),
    };
  }

  function execute({ eventID, payerCorporationID, payeeCorporationID, amountCents, dryRun = false } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const payer = Number(payerCorporationID), payee = Number(payeeCorporationID);
    const amount = Number(amountCents);
    if (!key(eventID) || !pos(payer) || !pos(payee) || payer === payee || !cents(amount))
      return { status: "BLOCKED", reason: "INVALID_MERCENARY_IDENTITY" };
    const needISK = round(amount / 100);
    const payerBefore = balanceOf(payer), payeeBefore = balanceOf(payee);
    if (!Number.isFinite(payerBefore) || !Number.isFinite(payeeBefore))
      return { status: "BLOCKED", reason: "WAR_MERCENARY_WALLET_UNREADABLE" };
    if (payerBefore < needISK)
      return { status: "BLOCKED", reason: "WAR_MERCENARY_PAYER_INSOLVENT", payerBefore, needISK };
    const preview = {
      eventID, payerCorporationID: payer, payeeCorporationID: payee,
      amountCents: amount, payerBeforeISK: payerBefore, payeeBeforeISK: payeeBefore,
      payerAfterISK: round(payerBefore - needISK), payeeAfterISK: round(payeeBefore + needISK),
      idempotency: "WALLET_JOURNAL_MARKER",
    };
    if (dryRun) return { status: "DRY_RUN", phase: "PREVIEW", preview };

    const debit = leg({ corporationID: payer, eventID, side: "DEBIT", deltaISK: -needISK });
    if (debit.status !== "APPLIED" && debit.status !== "DUPLICATE")
      return { status: "BLOCKED", phase: "DEBIT", reason: "WAR_MERCENARY_DEBIT_" + debit.status,
        debit, paymentComplete: false };
    const credit = leg({ corporationID: payee, eventID, side: "CREDIT", deltaISK: needISK });
    if (credit.status !== "APPLIED" && credit.status !== "DUPLICATE") {
      // The debit is real and marked in the payer's own journal; re-running the
      // same event completes only the missing credit because the debit leg is
      // refused as DUPLICATE by the wallet itself.
      return { status: "BLOCKED", phase: "CREDIT", reason: "WAR_MERCENARY_CREDIT_" + credit.status,
        debit, credit, owedISK: needISK, retrySafe: true };
    }
    return {
      status: "PAID",
      phase: "PAID",
      eventID,
      payerCorporationID: payer,
      payeeCorporationID: payee,
      amountCents: amount,
      debitLeg: debit.status,
      creditLeg: credit.status,
      payerAfterISK: balanceOf(payer),
      payeeAfterISK: balanceOf(payee),
      idempotency: "WALLET_JOURNAL_MARKER",
    };
  }

  return Object.freeze({ enabled, execute, snapshot, balanceOf });
}

module.exports = { DIVISION, walletPointer, createMercenarySettlement };
