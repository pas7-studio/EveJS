"use strict";

const INTENT = {
  HOLD: "HOLD",
  BUY: "BUY",
  MINE: "MINE",
  REFINE: "REFINE",
  MANUFACTURE: "MANUFACTURE",
  SHIP: "SHIP",
  SELL: "SELL",
};

const STRATEGY_REASON = {
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  OVERSTOCK: "OVERSTOCK",
  BELOW_REORDER: "BELOW_REORDER",
  NO_SELLER: "NO_SELLER",
  NO_FEASIBLE_PATH: "NO_FEASIBLE_PATH",
  OK: "OK",
};

function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function bool(v) {
  return v === true;
}

function chooseIntent(input) {
  const onHand = num(input && input.onHand);
  const reorderPoint = num(input && input.reorderPoint);
  const maxStock = num(input && input.maxStock);
  const cashAvailable = num(input && input.cashAvailable);
  const canMine = bool(input && input.canMine);
  const canBuy = bool(input && input.canBuy);

  const reasons = [];

  if (cashAvailable <= 0) {
    reasons.push(STRATEGY_REASON.INSUFFICIENT_FUNDS);
    return { intent: INTENT.HOLD, reasons: reasons.slice().sort() };
  }

  if (onHand > maxStock) {
    reasons.push(STRATEGY_REASON.OVERSTOCK);
    return { intent: INTENT.SELL, reasons: reasons.slice().sort() };
  }

  if (onHand >= reorderPoint) {
    reasons.push(STRATEGY_REASON.OK);
    return { intent: INTENT.HOLD, reasons: reasons.slice().sort() };
  }

  if (canBuy) {
    reasons.push(STRATEGY_REASON.BELOW_REORDER);
    return { intent: INTENT.BUY, reasons: reasons.slice().sort() };
  }

  if (canMine) {
    reasons.push(STRATEGY_REASON.BELOW_REORDER);
    return { intent: INTENT.MINE, reasons: reasons.slice().sort() };
  }

  reasons.push(STRATEGY_REASON.NO_SELLER);
  reasons.push(STRATEGY_REASON.NO_FEASIBLE_PATH);
  return { intent: INTENT.HOLD, reasons: reasons.slice().sort() };
}

module.exports = { chooseIntent, INTENT, STRATEGY_REASON };
