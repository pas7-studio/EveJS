"use strict";

const BUDGET_REASON = {
  OK: "OK",
  INVALID_CENTS: "INVALID_CENTS",
  NO_SPENDABLE_FUNDS: "NO_SPENDABLE_FUNDS",
};

function normalizeCents(value) {
  // A value that is not a finite number or is negative counts as 0.
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}

function spendableCash({
  walletCents,
  escrowCents,
  committedCents,
  minReserveCents,
} = {}) {
  const fields = [
    walletCents,
    escrowCents,
    committedCents,
    minReserveCents,
  ];

  let reason = BUDGET_REASON.OK;
  let cashAvailable = 0;

  for (let i = 0; i < fields.length; i++) {
    const value = fields[i];
    const normalized = normalizeCents(value);
    if (i === 0) {
      cashAvailable += normalized;
    } else {
      cashAvailable -= normalized;
    }
    // A finite non-integer (e.g. 1.5) makes the result INVALID_CENTS.
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && !Number.isInteger(value)) {
      reason = BUDGET_REASON.INVALID_CENTS;
    }
  }

  if (reason === BUDGET_REASON.OK && cashAvailable < 0) {
    reason = BUDGET_REASON.NO_SPENDABLE_FUNDS;
  }
  // spendable cash is never negative: a negative position is zero spendable with a reason, not a
  // number a caller could add to something else (the earlier reservedOn/spendableCash class of bug)
  if (cashAvailable < 0) cashAvailable = 0;
  return { cashAvailable, reason };
}

function canSpend(state, cents) {
  // cents must be a positive safe integer.
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    return false;
  }
  // A state that is INVALID_CENTS cannot spend.
  if (state && state.reason === BUDGET_REASON.INVALID_CENTS) {
    return false;
  }
  const result = spendableCash(state);
  if (result.reason !== BUDGET_REASON.OK) {
    return false;
  }
  return cents <= result.cashAvailable;
}

module.exports = { spendableCash, canSpend, BUDGET_REASON };

