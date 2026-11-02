'use strict';

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function isNonNegativeSafeInteger(n) {
  return typeof n === 'number'
    && Number.isInteger(n)
    && n >= 0
    && n <= MAX_SAFE_INTEGER;
}

function assessDistress({ walletCents, commitmentsCents, minimumReserveCents }) {
  if (
    !isNonNegativeSafeInteger(walletCents)
    || !isNonNegativeSafeInteger(commitmentsCents)
    || !isNonNegativeSafeInteger(minimumReserveCents)
  ) {
    return { mode: 'UNKNOWN', code: 'INVALID_STATE', suspendSpending: false, actions: [] };
  }

  if (walletCents === 0 && commitmentsCents > 0) {
    return {
      mode: 'DISTRESSED',
      code: 'CASH_STARVED',
      suspendSpending: true,
      actions: ['SUSPEND_SPENDING'],
    };
  }

  if (walletCents < commitmentsCents + minimumReserveCents) {
    return {
      mode: 'DISTRESSED',
      code: 'LOW_RESERVE',
      suspendSpending: true,
      actions: ['SUSPEND_SPENDING', 'LIQUIDATE_SURPLUS'],
    };
  }

  return {
    mode: 'NORMAL',
    code: 'HEALTHY',
    suspendSpending: false,
    actions: [],
  };
}

function liquidate({ surplus, escrowCents }) {
  if (!Array.isArray(surplus)) {
    return { ok: false, code: 'INVALID_SURPLUS' };
  }

  let protectedCents =
    typeof escrowCents === 'number' && escrowCents >= 0 ? escrowCents : 0;
  let liquidatedCents = 0;

  for (const entry of surplus) {
    if (
      !entry || typeof entry !== 'object'
      || typeof entry.itemID !== 'string'
      || entry.itemID.length === 0
      || !Number.isSafeInteger(entry.quantity)
      || !Number.isSafeInteger(entry.reservedQuantity)
      || !Number.isSafeInteger(entry.unitValueCents)
      || entry.quantity < 0
      || entry.reservedQuantity < 0
      || entry.reservedQuantity > entry.quantity
      || entry.unitValueCents < 0
    ) {
      return { ok: false, code: 'INVALID_SURPLUS' };
    }

    const sellable = entry.quantity - entry.reservedQuantity;
    liquidatedCents += sellable * entry.unitValueCents;
    protectedCents += entry.reservedQuantity * entry.unitValueCents;
  }

  const items = surplus.map((entry) => ({
    itemID: entry.itemID,
    quantity: entry.quantity - entry.reservedQuantity,
  }));

  return {
    ok: true,
    code: 'LIQUIDATED',
    liquidatedCents,
    protectedCents,
    items,
  };
}

const DISTRESS_CODE = {
  CASH_STARVED: 'CASH_STARVED',
  LOW_RESERVE: 'LOW_RESERVE',
};

module.exports = { assessDistress, liquidate, DISTRESS_CODE };
