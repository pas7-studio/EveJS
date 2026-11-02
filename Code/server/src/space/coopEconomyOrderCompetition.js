'use strict';

// IE-042: the NPC competes with players on the ordinary order book - no privileged matching.
// Bounds are on the NPC's own behaviour: it may only move its price by maxStepCents per repricing, it
// must wait minDelayTicks between repricings, it may not post more than maxOrdersPerTick orders, it may
// never bid above maxPriceCents, and it never fills its own order.

const COMPETITION_CODE = {
  MATCH: 'MATCH',
  NO_MATCH: 'NO_MATCH',
  INVALID_ORDER: 'INVALID_ORDER',
  ORDER_SPAM: 'ORDER_SPAM',
  INFINITY_BID: 'INFINITY_BID',
  REACTION_DELAY: 'REACTION_DELAY',
  REPRICE_OUT_OF_BOUNDS: 'REPRICE_OUT_OF_BOUNDS',
  SELF_TRADE_ONLY: 'SELF_TRADE_ONLY',
};

function isID(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPositive(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function badOrder(order) {
  return (
    !order ||
    !isID(order.orderID) ||
    !isID(order.ownerID) ||
    !isPositive(order.priceCents) ||
    !isPositive(order.quantity)
  );
}

// The best order: highest price, then the earliest position in the book (FIFO at equal price).
function bestOf(orders) {
  let best = null;
  for (let i = 0; i < orders.length; i += 1) {
    const order = orders[i];
    if (best === null || order.priceCents > best.order.priceCents) best = { order, index: i };
  }
  return best ? best.order : null;
}

function chooseFill(args) {
  const input = args || {};
  const { orders, npc, tick, maxStepCents, maxPriceCents, minDelayTicks, ordersThisTick, maxOrdersPerTick } = input;

  if (
    !Array.isArray(orders) ||
    orders.length === 0 ||
    !npc ||
    !isID(npc.corpID) ||
    !isPositive(npc.priceCents) ||
    !Number.isSafeInteger(tick) ||
    !Number.isSafeInteger(maxStepCents) ||
    !Number.isSafeInteger(maxPriceCents) ||
    !Number.isSafeInteger(minDelayTicks) ||
    !Number.isSafeInteger(ordersThisTick) ||
    !Number.isSafeInteger(maxOrdersPerTick)
  ) {
    return { ok: false, code: COMPETITION_CODE.INVALID_ORDER };
  }
  for (const order of orders) {
    if (badOrder(order)) return { ok: false, code: COMPETITION_CODE.INVALID_ORDER };
  }
  // an ambiguous book is not a market: one orderID cannot appear twice
  if (new Set(orders.map((order) => order.orderID)).size !== orders.length) {
    return { ok: false, code: COMPETITION_CODE.INVALID_ORDER };
  }

  // an NPC that posts every tick is order spam, not competition
  if (ordersThisTick > maxOrdersPerTick) return { ok: false, code: COMPETITION_CODE.ORDER_SPAM };

  // an "infinite" bid is never a real order
  if (npc.priceCents > maxPriceCents) return { ok: false, code: COMPETITION_CODE.INFINITY_BID };

  // the market needs time to react to the player's order
  if (Number.isSafeInteger(npc.lastRepriceTick) && tick - npc.lastRepriceTick < minDelayTicks) {
    return { ok: false, code: COMPETITION_CODE.REACTION_DELAY };
  }

  // bounded repricing is measured against the NPC's own previous price, not against a player's
  if (isPositive(npc.lastPriceCents) && Math.abs(npc.priceCents - npc.lastPriceCents) > maxStepCents) {
    return { ok: false, code: COMPETITION_CODE.REPRICE_OUT_OF_BOUNDS };
  }

  // The cap was validated as an integer and then never read: an NPC willing to pay 50 matched an
  // ask at 9000 against maxPriceCents 100 and reported MATCH. A budget that is not enforced is not
  // a budget - the bid and the price actually paid both have to fit under it.
  if (npc.priceCents > maxPriceCents) {
    return { ok: true, code: COMPETITION_CODE.NO_MATCH, reason: 'PRICE_CAP' };
  }

  const eligible = orders.filter((order) => order.ownerID !== npc.corpID);
  if (eligible.length === 0) return { ok: false, code: COMPETITION_CODE.SELF_TRADE_ONLY };

  const best = bestOf(eligible);
  if (best.priceCents > maxPriceCents) {
    return { ok: true, code: COMPETITION_CODE.NO_MATCH, reason: 'PRICE_CAP' };
  }
  if (npc.priceCents > best.priceCents) {
    return { ok: true, code: COMPETITION_CODE.NO_MATCH, reason: 'NPC_BEST' };
  }
  return { ok: true, code: COMPETITION_CODE.MATCH, orderID: best.orderID, priceCents: best.priceCents };
}

module.exports = { chooseFill, COMPETITION_CODE };
