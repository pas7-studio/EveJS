"use strict";
// ALIFE-18. What to ship, and whether the trip is worth its fuel.
//
// The loop now mines, refines, builds and sells - but only INSIDE one system, and the
// book in that system has no buyer for the corporation's stock (measured 2026-10-29: 83
// local bids, all LP/event items). Jita is one real gate away (New Caldari 30000145 ->
// Jita 30000142, verified reciprocal gate 50016293) and it bids like a real market:
// Tritanium 4 ISK x 4 000 000, Pyerite 15 x 3 300 000, Scordite III-Grade 17 x 3 900 000.
//
// This module is the DECISION, deliberately pure: it owns no ship, no scene and no wallet.
// It answers exactly one question - which stack, how much of it, from where to where, and
// what the trip is worth - and refuses every trip that cannot pay for itself, because a
// distribution run that loses money is worse than leaving the ore on the shelf.
//
// Moving the hull is NOT done here: cross-system transfer is opt-in and needs live QA
// (docs/NATIVE_NPC_GATE_TRAVEL.md), so a planner that ran ships by itself would be exactly
// the kind of unverified claim this repository forbids.
const pos = (x) => (Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : 0);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

const DEFAULT_MIN_ISK = 200000;

/**
 * @param {object} input
 * @param {Array}  input.stacks      [{stationID, typeID, quantity, m3PerUnit}]
 * @param {object} input.destination {systemID, stationID, bids:{typeID:{price, volume}}}
 * @param {object} input.local       {stationID, bids:{typeID:{price, volume}}}
 * @param {number} input.capacityM3  real free hold of the hull that would fly
 * @param {number} input.minIsk      smallest trip worth undocking for
 */
function plan({stacks = [], destination = null, local = null, capacityM3 = 0,
  minIsk = DEFAULT_MIN_ISK} = {}) {
  const refusals = [];
  const trips = [];
  const destStation = pos(destination && destination.stationID);
  if (!destStation) return {status: "NO_DESTINATION", trip: null, refusals, trips};
  const destBids = (destination && destination.bids) || {};
  const localBids = (local && local.bids) || {};
  const capacity = Math.max(0, num(capacityM3));
  for (const stack of Array.isArray(stacks) ? stacks : []) {
    const typeID = pos(stack && stack.typeID);
    const stationID = pos(stack && stack.stationID);
    const quantity = Math.max(0, Math.floor(num(stack && stack.quantity)));
    if (!typeID || !stationID || !quantity) continue;
    const where = {typeID, stationID, quantity};
    const bid = destBids[typeID] || null;
    if (!bid || num(bid.price) <= 0 || num(bid.volume) <= 0) {
      refusals.push({...where, reason: "NO_BUYER_AT_DESTINATION"});
      continue;
    }
    // Arbitrage only: if the goods fetch more where they already are, flying them away is
    // a loss dressed up as activity.
    const here = localBids[typeID] || null;
    if (here && num(here.price) >= num(bid.price)) {
      refusals.push({...where, reason: "DESTINATION_DOES_NOT_PAY_MORE",
        localPrice: num(here.price), destinationPrice: num(bid.price)});
      continue;
    }
    // The hull holds volume, not units. A stack that does not fit is shipped partially,
    // never "planned" beyond what a real hold can carry.
    const perUnit = Math.max(0, num(stack && stack.m3PerUnit));
    const byHold = perUnit > 0 && capacity > 0 ? Math.floor(capacity / perUnit) : quantity;
    const shipped = Math.min(quantity, Math.floor(num(bid.volume)), Math.max(0, byHold));
    if (shipped < 1) {
      refusals.push({...where, reason: byHold < 1 ? "DOES_NOT_FIT_HOLD" : "BUYER_VOLUME_EXHAUSTED",
        capacityM3: capacity, m3PerUnit: perUnit, buyerVolume: Math.floor(num(bid.volume))});
      continue;
    }
    const expectedISK = shipped * num(bid.price);
    if (expectedISK < num(minIsk)) {
      refusals.push({...where, reason: "TRIP_NOT_WORTH_IT", expectedISK, minIsk: num(minIsk)});
      continue;
    }
    trips.push({stationID, typeID, quantity: shipped, stackQuantity: quantity,
      destinationStationID: destStation, destinationSystemID: pos(destination.systemID),
      price: num(bid.price), localPrice: here ? num(here.price) : 0,
      expectedISK, m3: perUnit > 0 ? Math.round(shipped * perUnit * 100) / 100 : null,
      remaining: quantity - shipped});
  }
  trips.sort((left, right) => right.expectedISK - left.expectedISK);
  if (!trips.length) return {status: "NO_TRIP", trip: null, refusals, trips};
  return {status: "TRIP", trip: trips[0], refusals, trips};
}


/**
 * What one trip should actually carry, when the hold is the scarce thing.
 *
 * plan() answers "is this stack worth a trip" one stack at a time, and the caller takes the
 * single best. Measured 2026-10-30: an Impel left with 1 unit of 560 000 ISK ammunition because
 * it was the highest-revenue stack, while 3 099 m3 of its hold flew empty - and a hold of
 * 4 ISK ore would have earned more for the same trip. A trip has to FILL the hold with the
 * most valuable freight it can carry, not pick one stack.
 *
 * Ranking is value per cubic metre (the thing that is limited), and the hold is filled
 * greedily from the densest cargo down. Every chosen line still needs a real destination bid
 * that pays more than the goods fetch where they are.
 */
function planBundle({stacks = [], destination = null, local = null, capacityM3 = 0,
  minIsk = DEFAULT_MIN_ISK} = {}) {
  const refusals = [];
  const destStation = pos(destination && destination.stationID);
  if (!destStation) return {status: "NO_DESTINATION", items: [], refusals, totalIsk: 0, m3: 0};
  const destBids = (destination && destination.bids) || {};
  const localBids = (local && local.bids) || {};
  const capacity = Math.max(0, num(capacityM3));
  if (!capacity) return {status: "NO_HOLD_CAPACITY", items: [], refusals, totalIsk: 0, m3: 0};
  const candidates = [];
  for (const stack of Array.isArray(stacks) ? stacks : []) {
    const typeID = pos(stack && stack.typeID);
    const stationID = pos(stack && stack.stationID);
    const quantity = Math.max(0, Math.floor(num(stack && stack.quantity)));
    if (!typeID || !stationID || !quantity) continue;
    const where = {typeID, stationID, quantity};
    const bid = destBids[typeID] || null;
    if (!bid || num(bid.price) <= 0 || num(bid.volume) <= 0) {
      refusals.push({...where, reason: "NO_BUYER_AT_DESTINATION"});
      continue;
    }
    const here = localBids[typeID] || null;
    if (here && num(here.price) >= num(bid.price)) {
      refusals.push({...where, reason: "DESTINATION_DOES_NOT_PAY_MORE",
        localPrice: num(here.price), destinationPrice: num(bid.price)});
      continue;
    }
    const perUnit = Math.max(0, num(stack && stack.m3PerUnit));
    if (!(perUnit > 0)) {
      refusals.push({...where, reason: "VOLUME_UNKNOWN"});
      continue;
    }
    candidates.push({...where, perUnit, price: num(bid.price), buyerVolume: Math.floor(num(bid.volume)),
      density: num(bid.price) / perUnit});
  }
  // Densest cargo first: a cubic metre spent on 4 ISK ore cannot be spent on ammunition.
  candidates.sort((a, b) => b.density - a.density || b.price - a.price);
  const items = [];
  let left = capacity;
  let totalIsk = 0;
  let used = 0;
  for (const row of candidates) {
    const fit = Math.floor(left / row.perUnit);
    const shipped = Math.min(row.quantity, row.buyerVolume, Math.max(0, fit));
    if (shipped < 1) {
      refusals.push({typeID: row.typeID, stationID: row.stationID, quantity: row.quantity,
        reason: fit < 1 ? "HOLD_FULL" : "BUYER_VOLUME_EXHAUSTED"});
      continue;
    }
    items.push({typeID: row.typeID, stationID: row.stationID, quantity: shipped,
      price: row.price, m3PerUnit: row.perUnit,
      m3: Math.round(shipped * row.perUnit * 100) / 100, isk: shipped * row.price});
    left -= shipped * row.perUnit;
    used += shipped * row.perUnit;
    totalIsk += shipped * row.price;
  }
  if (!items.length) return {status: "NO_TRIP", items: [], refusals, totalIsk: 0, m3: 0};
  if (totalIsk < num(minIsk)) {
    return {status: "TRIP_NOT_WORTH_IT", items: [], refusals,
      totalIsk, m3: Math.round(used * 100) / 100, minIsk: num(minIsk)};
  }
  return {status: "TRIP", items, refusals, totalIsk,
    m3: Math.round(used * 100) / 100, capacityM3: capacity};
}
module.exports = {plan, planBundle, DEFAULT_MIN_ISK};
