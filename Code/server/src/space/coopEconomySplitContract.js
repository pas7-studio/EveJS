'use strict';

function isPositiveSafeInt(n) {
  return Number.isSafeInteger(n) && n > 0;
}

function createSplitContract() {
  const store = new Map();

  function create({ contractID, totalCents, parties }) {
    if (typeof contractID !== 'string' || contractID.length === 0) {
      return { ok: false, code: 'INVALID_SPLIT' };
    }
    if (!isPositiveSafeInt(totalCents)) {
      return { ok: false, code: 'INVALID_SPLIT' };
    }
    if (!Array.isArray(parties)) {
      return { ok: false, code: 'INVALID_SPLIT' };
    }
    const seen = new Set();
    let sum = 0;
    for (const p of parties) {
      if (!p || typeof p.playerID !== 'string' || typeof p.role !== 'string' ||
          typeof p.shareBps !== 'number') {
        return { ok: false, code: 'INVALID_SPLIT' };
      }
      if (p.role !== 'SUPPLIER' && p.role !== 'CARRIER') {
        return { ok: false, code: 'INVALID_SPLIT' };
      }
      if (seen.has(p.playerID)) {
        return { ok: false, code: 'INVALID_SPLIT' };
      }
      seen.add(p.playerID);
      if (!isPositiveSafeInt(p.shareBps)) {
        return { ok: false, code: 'INVALID_SPLIT' };
      }
      sum += p.shareBps;
    }
    if (sum !== 10000) {
      return { ok: false, code: 'INVALID_SPLIT' };
    }
    store.set(contractID, { parties, totalCents, awarded: [] });
    return { ok: true, code: 'CREATED', contractID };
  }

  function award({ contractID, work, disconnected }) {
    const c = store.get(contractID);
    if (!c) {
      return { ok: false, code: 'UNKNOWN_CONTRACT' };
    }
    const workMap = work && typeof work === 'object' ? work : {};
    const disconnectedSet = new Set(disconnected || []);
    const payouts = [];
    const held = [];
    let paidCents = 0;
    for (const p of c.parties) {
      const w = workMap[p.playerID];
      const isDisconnected = disconnectedSet.has(p.playerID);
      const verified = w && w.verified === true;
      const hasReceipt = !!(w && w.receiptID);
      if (isDisconnected) {
        held.push({ playerID: p.playerID, code: 'HELD_DISCONNECTED' });
      } else if (!verified) {
        held.push({ playerID: p.playerID, code: 'HELD_UNVERIFIED' });
      } else if (!hasReceipt) {
        held.push({ playerID: p.playerID, code: 'HELD_UNVERIFIED' });
      } else {
        const payoutCents = Math.floor(c.totalCents * p.shareBps / 10000);
        payouts.push({ playerID: p.playerID, role: p.role, payoutCents });
        paidCents += payoutCents;
      }
    }
    c.awarded.push({ contractID, paidCents });
    return { ok: true, code: 'AWARDED', payouts, held, paidCents };
  }

  return { create, award };
}

const SPLIT_CODE = 'INVALID_SPLIT';

module.exports = { createSplitContract, SPLIT_CODE };
