'use strict';

// IE-067: the economy health report. Every number that claims real production must come from a native
// receipt. An intent is a wish, not output, so it is reported in its own field and never added to production.
// A metric without a receipt is not shown as healthy: the report refuses it.

const HEALTH_CODE = {
  REPORT: 'REPORT',
  INVALID_REPORT: 'INVALID_REPORT',
  UNVERIFIED_METRIC: 'UNVERIFIED_METRIC',
};

function isID(value) {
  return typeof value === 'string' && value.length > 0;
}

function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPnl(pnl) {
  return (
    pnl &&
    isCount(pnl.realizedCents) &&
    isCount(pnl.stockValueCents) &&
    isCount(pnl.committedCents)
  );
}

function buildReport(args) {
  const { pnl, demand, shortages, cargoLosses, players } = args || {};

  if (!isPnl(pnl)) return { ok: false, code: HEALTH_CODE.INVALID_REPORT, metric: 'pnl' };
  if (!demand || !isCount(demand.intents) || !Array.isArray(demand.fulfilled)) {
    return { ok: false, code: HEALTH_CODE.INVALID_REPORT, metric: 'demand' };
  }

  let producedQuantity = 0;
  const fulfilledOrders = [];
  for (const entry of demand.fulfilled) {
    if (!entry || !isID(entry.receiptID) || !isCount(entry.quantity)) {
      return { ok: false, code: HEALTH_CODE.UNVERIFIED_METRIC, metric: 'demand.fulfilled' };
    }
    producedQuantity += entry.quantity;
    fulfilledOrders.push({ receiptID: entry.receiptID, quantity: entry.quantity });
  }

  let shortageQuantity = 0;
  for (const entry of Array.isArray(shortages) ? shortages : []) {
    if (!entry || !isCount(entry.quantity)) {
      return { ok: false, code: HEALTH_CODE.UNVERIFIED_METRIC, metric: 'shortages' };
    }
    shortageQuantity += entry.quantity;
  }

  let cargoLostQuantity = 0;
  for (const entry of Array.isArray(cargoLosses) ? cargoLosses : []) {
    if (!entry || !isID(entry.receiptID) || !isCount(entry.quantity)) {
      return { ok: false, code: HEALTH_CODE.UNVERIFIED_METRIC, metric: 'cargoLosses' };
    }
    cargoLostQuantity += entry.quantity;
  }

  const contributions = [];
  for (const player of Array.isArray(players) ? players : []) {
    if (
      !player ||
      !isID(player.playerID) ||
      !isCount(player.deliveredQuantity) ||
      !isCount(player.paidCents)
    ) {
      return { ok: false, code: HEALTH_CODE.UNVERIFIED_METRIC, metric: 'players' };
    }
    // a player cannot be paid for more than the receipts show being produced
    if (player.deliveredQuantity > producedQuantity) {
      return { ok: false, code: HEALTH_CODE.UNVERIFIED_METRIC, metric: 'players.' + player.playerID };
    }
    contributions.push({
      playerID: player.playerID,
      deliveredQuantity: player.deliveredQuantity,
      paidCents: player.paidCents,
    });
  }

  return {
    ok: true,
    code: HEALTH_CODE.REPORT,
    realizedCents: pnl.realizedCents,
    stockValueCents: pnl.stockValueCents,
    committedCents: pnl.committedCents,
    // real production only: receipts, never intents
    producedQuantity,
    fulfilledOrders: fulfilledOrders.length,
    intents: demand.intents,
    shortageQuantity,
    cargoLostQuantity,
    players: contributions,
  };
}

module.exports = { buildReport, HEALTH_CODE };
