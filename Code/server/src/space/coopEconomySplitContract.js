'use strict';
const { createJournal } = require("./coopEconomyJournal");

function isPositiveSafeInt(n) {
  return Number.isSafeInteger(n) && n > 0;
}

function createSplitContract(options) {
  // a replay after a restart must still see this record: pass {journal} to persist it
  const store = createJournal(options && options.journal);

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
    // each party is paid at most once: a held share may be paid later, a paid share never again
    if (!(c.paid instanceof Map)) c.paid = new Map();
    if (c.parties.every((p) => c.paid.has(p.playerID))) {
      return { ok: true, code: 'ALREADY_AWARDED', payouts: [], held: [], paidCents: 0 };
    }
    const workMap = work && typeof work === 'object' ? work : {};
    const disconnectedSet = new Set(disconnected || []);
    const payouts = [];
    const held = [];
    let paidCents = 0;
    for (const p of c.parties) {
      if (c.paid.has(p.playerID)) continue;
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
        c.paid.set(p.playerID, payoutCents);
        paidCents += payoutCents;
      }
    }
    c.awarded.push({ contractID, paidCents });
    const totalPaidCents = [...c.paid.values()].reduce((sum, value) => sum + value, 0);
    // paidCents is what THIS call paid; totalPaidCents is the cumulative position of the contract
    return { ok: true, code: 'AWARDED', payouts, held, paidCents, totalPaidCents };
  }

  return { create, award };
}

const SPLIT_CODE = 'INVALID_SPLIT';

module.exports = { createSplitContract, SPLIT_CODE };
