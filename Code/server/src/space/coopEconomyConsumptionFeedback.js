'use strict';
const { createJournal } = require("./coopEconomyJournal");

const INVALID_EVIDENCE = 'INVALID_EVIDENCE';
const DUPLICATE_IGNORED = 'DUPLICATE_IGNORED';
const RECORDED = 'RECORDED';

const FEEDBACK_CODE = {
  INVALID_EVIDENCE,
  DUPLICATE_IGNORED,
  RECORDED,
};

function isPositiveSafeInteger(value) {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function createDemandLedger(opts) {
  const durable = opts && opts.journal;
  const namespaced = (prefix) => {
    if (!durable) return undefined;
    return {
      get: (k) => durable.get(prefix + k),
      set: (k, v) => durable.set(prefix + k, v),
      has: (k) => (typeof durable.has === "function" ? durable.has(prefix + k) : durable.get(prefix + k) !== undefined),
      delete: (k) => (typeof durable.delete === "function" ? durable.delete(prefix + k) : undefined),
      entries: () => (typeof durable.entries === "function"
        ? [...durable.entries()].filter((e) => String(e[0]).startsWith(prefix))
            .map((e) => [String(e[0]).slice(prefix.length), e[1]])
        : []),
    };
  };
  const evidenceMap = createJournal(namespaced("evidence:"));
  const typeDemand = createJournal(namespaced("demand:"));
  const typeEvidence = new Map(); // typeID -> Set<evidenceID>

  function record({ evidenceID, hullID, typeID, quantity }) {
    if (
      typeof evidenceID !== 'string' ||
      evidenceID.length === 0 ||
      typeof typeID !== 'string' ||
      typeID.length === 0 ||
      !isPositiveSafeInteger(quantity)
    ) {
      return { ok: false, code: FEEDBACK_CODE.INVALID_EVIDENCE };
    }

    const existing = evidenceMap.get(evidenceID);
    if (existing) {
      const demand = typeDemand.get(typeID) || 0;
      return { ok: true, code: FEEDBACK_CODE.DUPLICATE_IGNORED, demand };
    }

    evidenceMap.set(evidenceID, { typeID, quantity });
    typeDemand.set(typeID, (typeDemand.get(typeID) || 0) + quantity);
    if (!typeEvidence.get(typeID)) {
      typeEvidence.set(typeID, new Set());
    }
    typeEvidence.get(typeID).add(evidenceID);

    return { ok: true, code: FEEDBACK_CODE.RECORDED, demand: typeDemand.get(typeID) };
  }

  function demandFor(typeID) {
    return typeDemand.get(typeID) || 0;
  }

  function signals() {
    const signals = [];
    for (const typeID of typeDemand.keys()) {
      const evidenceIDs = Array.from(typeEvidence.get(typeID)).sort();
      signals.push({ typeID, quantity: typeDemand.get(typeID), evidenceIDs });
    }
    signals.sort((a, b) => (a.typeID < b.typeID ? -1 : a.typeID > b.typeID ? 1 : 0));
    return signals;
  }

  function total() {
    let sum = 0;
    for (const value of typeDemand.values()) {
      sum += value;
    }
    return sum;
  }

  return { record, demandFor, signals, total };
}

module.exports = { createDemandLedger, FEEDBACK_CODE };
