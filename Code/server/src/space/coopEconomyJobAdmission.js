'use strict';
const { createJournal } = require("./coopEconomyJournal");

const ADMISSION_CODE = 'ADMITTED';

function isValidQuote(quote) {
  if (!quote || typeof quote !== 'object') return false;
  if (typeof quote.blueprintID !== 'string') return false;
  if (typeof quote.productTypeID !== 'string') return false;
  if (typeof quote.runs !== 'number') return false;
  if (typeof quote.materialCostCents !== 'number') return false;
  if (!Array.isArray(quote.needs)) return false;
  for (const n of quote.needs) {
    if (!n || typeof n.typeID !== 'string' || typeof n.quantity !== 'number') return false;
  }
  return true;
}

function createJobAdmission(options) {
  // a replay after a restart must still see this record: pass {journal} to persist it
  const map = createJournal(options && options.journal);

  function admit(input) {
    const { operationID, quote, materials, walletCents, installPort } = input || {};

    // Shape validation
    if (typeof operationID !== 'string' || operationID.length === 0) {
      return { ok: false, code: 'INVALID_QUOTE' };
    }
    if (!isValidQuote(quote)) {
      return { ok: false, code: 'INVALID_QUOTE' };
    }

    // Already admitted: no second job, no second debit.
    const existing = map.get(operationID);
    if (existing && existing.state === 'ADMITTED') {
      return { ok: true, code: 'ALREADY_ADMITTED', jobID: existing.jobID };
    }

    // Previously unknown (install failed): never a retry.
    if (existing && existing.state === 'UNKNOWN') {
      return { ok: false, code: 'INSTALL_UNKNOWN' };
    }

    // Materials short.
    const have = {};
    for (const m of materials || []) {
      if (typeof m.typeID === 'string') {
        have[m.typeID] = (have[m.typeID] || 0) + (m.quantity || 0);
      }
    }
    const missing = [];
    for (const need of quote.needs) {
      const short = need.quantity - (have[need.typeID] || 0);
      if (short > 0) missing.push(need.typeID);
    }
    if (missing.length > 0) {
      missing.sort();
      return { ok: false, code: 'MATERIALS_SHORT', missing };
    }

    // Insufficient funds.
    if (typeof walletCents !== 'number' || walletCents < quote.materialCostCents) {
      return { ok: false, code: 'INSUFFICIENT_FUNDS' };
    }

    // Native authority.
    if (typeof installPort !== 'object' || typeof installPort.installOnce !== 'function') {
      return { ok: false, code: 'NATIVE_AUTHORITY_UNAVAILABLE' };
    }

    // Call installOnce exactly once.
    let result;
    try {
      result = installPort.installOnce({
        operationID,
        blueprintID: quote.blueprintID,
        productTypeID: quote.productTypeID,
        runs: quote.runs,
      });
    } catch (e) {
      map.set(operationID, { state: 'UNKNOWN', jobID: null });
      return { ok: false, code: 'INSTALL_UNKNOWN' };
    }

    if (!result || typeof result !== 'object' || !result.receiptID || String(result.receiptID).length === 0) {
      map.set(operationID, { state: 'UNKNOWN', jobID: null });
      return { ok: false, code: 'INSTALL_UNKNOWN' };
    }

    // Success.
    map.set(operationID, { state: 'ADMITTED', jobID: result.receiptID });
    return { ok: true, code: 'ADMITTED', jobID: result.receiptID };
  }

  return { admit };
}

module.exports = { createJobAdmission, ADMISSION_CODE };
