'use strict';

/**
 * CommonJS module with no external dependencies.
 *
 * chooseRoute evaluates a set of delivery routes against a cargo manifest and
 * selects the route that maximises profit, rejecting unsuitable routes with a
 * reason instead of silently dropping them.
 */

// Rejection reasons for individual routes.
const ROUTE_CODE = {
  UNVERIFIED_ROUTE: 'UNVERIFIED_ROUTE',
  NO_BUYER: 'NO_BUYER',
  INSUFFICIENT_CAPACITY: 'INSUFFICIENT_CAPACITY'
};

const INVALID_CARGO = 'INVALID_CARGO';
const NO_VIABLE_ROUTE = 'NO_VIABLE_ROUTE';
const ROUTE_SELECTED = 'ROUTE_SELECTED';

function isPositiveSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function chooseRoute({ cargo, routes } = {}) {
  // ---- Validate cargo ----
  if (!cargo || typeof cargo !== 'object' || Array.isArray(cargo)) {
    return { ok: false, code: INVALID_CARGO };
  }
  if (
    !isPositiveSafeInteger(cargo.quantity) ||
    !isPositiveSafeInteger(cargo.m3PerUnit) ||
    !isPositiveSafeInteger(cargo.valueCents)
  ) {
    return { ok: false, code: INVALID_CARGO };
  }

  const volumeM3 = cargo.quantity * cargo.m3PerUnit;

  // ---- Validate routes ----
  if (!Array.isArray(routes)) {
    return { ok: false, code: NO_VIABLE_ROUTE, rejected: [] };
  }

  const rejected = [];
  const viable = [];

  for (const route of routes) {
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      rejected.push({ routeID: null, reason: INVALID_CARGO });
      continue;
    }

    const reason = rejectRoute(route, volumeM3);
    if (reason) {
      rejected.push({ routeID: route.routeID, reason });
      continue;
    }

    const revenueCents = revenueFor(route.buyerOrders, cargo.quantity);
    const profitCents = revenueCents - route.costCents;
    viable.push({
      route,
      revenueCents,
      costCents: route.costCents,
      profitCents
    });
  }

  if (viable.length === 0) {
    return { ok: false, code: NO_VIABLE_ROUTE, rejected };
  }

  // Highest profit, ties broken by lower timeSeconds then lower routeID.
  viable.sort((a, b) => {
    if (b.profitCents !== a.profitCents) return b.profitCents - a.profitCents;
    if (a.route.timeSeconds !== b.route.timeSeconds) {
      return a.route.timeSeconds - b.route.timeSeconds;
    }
    return String(a.route.routeID) < String(b.route.routeID) ? -1 : 1;
  });

  const best = viable[0];
  return {
    ok: true,
    code: ROUTE_SELECTED,
    routeID: best.route.routeID,
    revenueCents: best.revenueCents,
    costCents: best.costCents,
    profitCents: best.profitCents,
    timeSeconds: best.route.timeSeconds,
    riskScore: best.route.riskScore,
    rejected
  };
}

function rejectRoute(route, volumeM3) {
  if (route.verified !== true) {
    return ROUTE_CODE.UNVERIFIED_ROUTE;
  }
  const hasBuyer =
    Array.isArray(route.buyerOrders) &&
    route.buyerOrders.some((o) => o && typeof o === 'object' && o.quantity > 0);
  if (!hasBuyer) {
    return ROUTE_CODE.NO_BUYER;
  }
  if (route.m3Capacity < volumeM3) {
    return ROUTE_CODE.INSUFFICIENT_CAPACITY;
  }
  return null;
}

function revenueFor(buyerOrders, cargoQuantity) {
  let remaining = cargoQuantity;
  let revenueCents = 0;
  for (const order of buyerOrders) {
    if (!order || typeof order !== 'object') continue;
    if (remaining <= 0) break;
    const sold = Math.min(order.quantity, remaining);
    revenueCents += order.priceCents * sold;
    remaining -= sold;
  }
  return revenueCents;
}

module.exports = { chooseRoute, ROUTE_CODE };
