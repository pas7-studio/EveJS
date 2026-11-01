'use strict';

// IE-038: an NPC-manufactured item is escrowed physically for a market SELL order.
// The fleet reserve and the market escrow are two separate pools over the same on-hand stock, so a unit
// can never be counted in both, and a partial fill only ever reduces the escrow by the filled amount.

const ESCROW_CODE = {
  STOCKED: 'STOCKED',
  RESERVED: 'RESERVED',
  LISTED: 'LISTED',
  FILLED: 'FILLED',
  CANCELLED: 'CANCELLED',
  INVALID_LISTING: 'INVALID_LISTING',
  ALREADY_LISTED: 'ALREADY_LISTED',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  INSUFFICIENT_ESCROW: 'INSUFFICIENT_ESCROW',
  UNKNOWN_ESCROW: 'UNKNOWN_ESCROW',
};

function isID(value) {
  return typeof value === 'string' && value.length > 0;
}

function isQuantity(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function createEscrow() {
  const stock = new Map(); // itemID -> { onHand, reserved }
  const listings = new Map(); // escrowID -> { itemID, remaining, priceCents }
  const listedByItem = new Map(); // itemID -> escrowID

  function row(itemID) {
    let entry = stock.get(itemID);
    if (!entry) {
      entry = { onHand: 0, reserved: 0 };
      stock.set(itemID, entry);
    }
    return entry;
  }

  function available(itemID) {
    const entry = row(itemID);
    let listed = 0;
    const escrowID = listedByItem.get(itemID);
    if (escrowID) {
      const listing = listings.get(escrowID);
      if (listing) listed = listing.remaining;
    }
    const free = entry.onHand - entry.reserved - listed;
    return free > 0 ? free : 0;
  }

  function stockIn(args) {
    const { itemID, quantity } = args || {};
    if (!isID(itemID) || !isQuantity(quantity)) return { ok: false, code: ESCROW_CODE.INVALID_LISTING };
    row(itemID).onHand += quantity;
    return { ok: true, code: ESCROW_CODE.STOCKED, available: available(itemID) };
  }

  function reserve(args) {
    const { itemID, quantity } = args || {};
    if (!isID(itemID) || !isQuantity(quantity)) return { ok: false, code: ESCROW_CODE.INVALID_LISTING };
    if (available(itemID) < quantity) return { ok: false, code: ESCROW_CODE.INSUFFICIENT_STOCK };
    row(itemID).reserved += quantity;
    return { ok: true, code: ESCROW_CODE.RESERVED, available: available(itemID) };
  }

  function list(args) {
    const { escrowID, itemID, quantity, priceCents } = args || {};
    if (!isID(escrowID) || !isID(itemID) || !isQuantity(quantity) || !isQuantity(priceCents)) {
      return { ok: false, code: ESCROW_CODE.INVALID_LISTING };
    }
    if (listedByItem.has(itemID)) return { ok: false, code: ESCROW_CODE.ALREADY_LISTED };
    if (available(itemID) < quantity) return { ok: false, code: ESCROW_CODE.INSUFFICIENT_STOCK };
    listings.set(escrowID, { itemID, remaining: quantity, priceCents });
    listedByItem.set(itemID, escrowID);
    return { ok: true, code: ESCROW_CODE.LISTED, escrowID, quantity };
  }

  function fill(args) {
    const { escrowID, quantity } = args || {};
    const listing = listings.get(escrowID);
    if (!listing) return { ok: false, code: ESCROW_CODE.UNKNOWN_ESCROW };
    if (!isQuantity(quantity) || quantity > listing.remaining) {
      return { ok: false, code: ESCROW_CODE.INSUFFICIENT_ESCROW };
    }
    listing.remaining -= quantity;
    if (listing.remaining === 0) {
      // a fully filled listing stays recorded at zero so a replay cannot re-list the same stock
      listings.set(escrowID, listing);
    }
    return { ok: true, code: ESCROW_CODE.FILLED, remaining: listing.remaining };
  }

  function cancel(args) {
    const { escrowID } = args || {};
    const listing = listings.get(escrowID);
    if (!listing) return { ok: false, code: ESCROW_CODE.UNKNOWN_ESCROW };
    listings.delete(escrowID);
    if (listedByItem.get(listing.itemID) === escrowID) listedByItem.delete(listing.itemID);
    return { ok: true, code: ESCROW_CODE.CANCELLED, available: available(listing.itemID) };
  }

  function listed(itemID) {
    const escrowID = listedByItem.get(itemID);
    if (!escrowID) return 0;
    const listing = listings.get(escrowID);
    return listing ? listing.remaining : 0;
  }

  function reserved(itemID) {
    return row(itemID).reserved;
  }

  return { stock: stockIn, reserve, list, fill, cancel, available, listed, reserved };
}

module.exports = { createEscrow, ESCROW_CODE };
