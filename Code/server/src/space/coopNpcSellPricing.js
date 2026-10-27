"use strict";
// How an NPC merchant sells like a real player: start at the best price the
// market already pays, and when nobody buys, step the asking price down in
// small amounts every few minutes until a floor. Mining never stops meanwhile,
// so stock keeps accumulating and the next haul starts from the top again.
//
// This module is pure policy: no orders, no ISK, no cargo, no market RPC. The
// guarded native trader still owns the only mutation.
const finite = value => {
 const numeric = Number(value);
 return Number.isFinite(numeric) ? numeric : null;
};
const keyOf = key => String(key ?? "");

function validConfig({intervalMs, stepPct, minPct}) {
 return Number.isSafeInteger(intervalMs) && intervalMs >= 5000 && intervalMs <= 3600000 &&
  typeof stepPct === "number" && Number.isFinite(stepPct) && stepPct > 0 && stepPct <= 0.5 &&
  typeof minPct === "number" && Number.isFinite(minPct) && minPct > 0 && minPct < 1;
}

function createSellPricing({clock = () => Date.now(), intervalMs = 120000,
 stepPct = 0.05, minPct = 0.55} = {}) {
 if (!validConfig({intervalMs, stepPct, minPct}))
  throw Error("INVALID_SELL_PRICING_CONFIG");
 const held = new Map();
 function offer(key, referencePrice) {
  const id = keyOf(key), price = finite(referencePrice);
  if (!id || price === null || price <= 0) return null;
  const existing = held.get(id);
  if (existing) {
   // A better bid is a new reason to ask for more: never lower a live anchor.
   if (price > existing.referencePrice) existing.referencePrice = price;
   return existing;
  }
  const entry = {referencePrice: price, since: clock(), sold: 0, attempts: 0};
  held.set(id, entry);
  return entry;
 }
 function pctFor(entry, now) {
  const waited = Math.max(0, now - entry.since);
  const steps = Math.floor(waited / intervalMs);
  return Math.max(minPct, 1 - stepPct * steps);
 }
 function floor(key) {
  const entry = held.get(keyOf(key));
  if (!entry) return null;
  const now = clock(), pct = pctFor(entry, now);
  return {pct: Math.round(pct * 10000) / 10000,
   price: Math.round(entry.referencePrice * pct * 100) / 100,
   waitedMs: Math.max(0, now - entry.since)};
 }
 function decide({key, bestBid} = {}) {
  const id = keyOf(key);
  const current = floor(id);
  if (!current) return {action: "NO_REFERENCE", floor: null, pct: null};
  const bid = finite(bestBid);
  if (bid === null || bid <= 0)
   return {...current, action: "HOLD_FLOOR", bestBid: 0,
    reason: "NO_BUYER_AT_ANY_PRICE"};
  if (bid + 1e-9 < current.price)
   return {...current, action: "HOLD_FLOOR", bestBid: bid,
    reason: "BID_BELOW_FLOOR"};
  return {...current, action: "SELL", bestBid: bid, reason: "BID_AT_OR_ABOVE_FLOOR"};
 }
 function noteSold(key) {
  const id = keyOf(key), entry = held.get(id);
  if (!entry) return false;
  entry.sold += 1;
  entry.attempts = 0;
  // Sold: the next haul asks for the best price again.
  entry.since = clock();
  return true;
 }
 function forget(key) {
  return held.delete(keyOf(key));
 }
 function snapshot() {
  const out = {};
  for (const [id, entry] of held)
   out[id] = {...floor(id), sold: entry.sold};
  return out;
 }
 return {offer, floor, decide, noteSold, forget, snapshot};
}

module.exports = {createSellPricing, validConfig};
