'use strict';

// IE-060: one conservation audit across mining, warehouse, industry, market, wallet and cargo.
// The audit fails closed: a scope without a real source receipt is unknown, not zero, and the same
// cargo held by two holders blocks the whole scope instead of being silently averaged. An empty or
// partial audit is not evidence: if no scope was measured at all, or a required scope was not measured
// on both sides, the audit reports INCOMPLETE_SCOPE rather than pretending to be BALANCED.

const SCOPES = ['mining', 'warehouse', 'industry', 'market', 'wallet', 'cargo'];

const COVERAGE_CODE = {
  BALANCED: 'BALANCED',
  IMBALANCE: 'IMBALANCE',
  UNKNOWN_SOURCE: 'UNKNOWN_SOURCE',
  DUPLICATE_CUSTODY: 'DUPLICATE_CUSTODY',
  INCOMPLETE_SCOPE: 'INCOMPLETE_SCOPE',
};

function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isID(value) {
  return typeof value === 'string' && value.length > 0;
}

// one scope reading: either physical units or wallet cents, always with a native source receipt
function measure(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (!isID(entry.sourceReceiptID)) return null;
  const hasUnits = entry.units !== undefined;
  const hasCents = entry.cents !== undefined;
  if (hasUnits === hasCents) return null;
  const amount = hasUnits ? entry.units : entry.cents;
  if (!isCount(amount)) return null;
  // the kind is part of the reading: 100 cents is not 100 physical units
  return { kind: hasUnits ? 'units' : 'cents', amount };
}

function audit(args) {
  const { before, after, custody, requiredScopes } = args || {};
  const missing = [];

  const deltas = {};
  for (const scope of SCOPES) {
    const inBefore = before && before[scope] !== undefined;
    const inAfter = after && after[scope] !== undefined;
    // a scope nobody reported is not part of this audit
    if (!inBefore && !inAfter) continue;
    // a scope reported on only one side is a change without a reading: fail closed
    if (inBefore !== inAfter) {
      missing.push(scope);
      continue;
    }
    const from = measure(before[scope]);
    const to = measure(after[scope]);
    if (from === null || to === null || from.kind !== to.kind) {
      missing.push(scope);
      continue;
    }
    deltas[scope] = to.amount - from.amount;
  }


  // a required scope must have been measured on both sides; the ones that were not are reported
  if (Array.isArray(requiredScopes)) {
    const unmeasured = requiredScopes.filter((scope) => !(scope in deltas));
    if (unmeasured.length > 0) {
      return { ok: false, code: COVERAGE_CODE.INCOMPLETE_SCOPE, closed: true, missing: unmeasured.slice().sort() };
    }
  }

  if (missing.length > 0) {
    return { ok: false, code: COVERAGE_CODE.UNKNOWN_SOURCE, closed: true, missing };
  }
  // nothing was measured at all: an empty or partial audit is not evidence
  if (Object.keys(deltas).length === 0) {
    return { ok: false, code: COVERAGE_CODE.INCOMPLETE_SCOPE, closed: true, missing: missing.slice().sort() };
  }
  // physical custody: one cargoID can only have one holder
  const holders = new Map();
  for (const entry of Array.isArray(custody) ? custody : []) {
    if (!entry || !isID(entry.cargoID) || !isID(entry.holderID)) {
      return { ok: false, code: COVERAGE_CODE.DUPLICATE_CUSTODY, cargoID: entry && entry.cargoID, blocksScope: true };
    }
    const seen = holders.get(entry.cargoID);
    if (seen !== undefined && seen !== entry.holderID) {
      return { ok: false, code: COVERAGE_CODE.DUPLICATE_CUSTODY, cargoID: entry.cargoID, blocksScope: true };
    }
    holders.set(entry.cargoID, entry.holderID);
  }

  const imbalanced = Object.keys(deltas).filter((scope) => deltas[scope] !== 0);
  if (imbalanced.length > 0) {
    return { ok: false, code: COVERAGE_CODE.IMBALANCE, deltas };
  }
  return { ok: true, code: COVERAGE_CODE.BALANCED, deltas };
}

module.exports = { audit, SCOPES, COVERAGE_CODE };
