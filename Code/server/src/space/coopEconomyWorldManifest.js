'use strict';
// A test world is finite by construction: two corporations, a bounded bootstrap balance and real
// station identities. This module only validates and freezes a manifest; it never invents a station,
// a corporation, cash or a product.

const MAX_BOOTSTRAP_CASH_CENTS = 1000000000000; // 10 billion ISK in cents
const MAX_JOB_SLOTS = 64;

function stationIds(m) {
  const ids = new Set();
  if (Array.isArray(m.stations)) {
    for (const s of m.stations) {
      if (s && typeof s === 'object' && typeof s.stationID === 'string' && s.stationID.length > 0) {
        ids.add(s.stationID);
      }
    }
  }
  return ids;
}

function validateWorldManifest(m) {
  if (m === null || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, errors: ['MISSING_SEED'] };
  }
  const errors = new Set();

  if (typeof m.worldSeed !== 'string' || m.worldSeed.length === 0) {
    errors.add('MISSING_SEED');
  }

  let stationsOk = Array.isArray(m.stations) && m.stations.length > 0;
  if (stationsOk) {
    for (const s of m.stations) {
      if (!s || typeof s !== 'object' || typeof s.stationID !== 'string' || s.stationID.length === 0) {
        stationsOk = false;
        break;
      }
    }
  }
  if (!stationsOk) {
    errors.add('NO_STATIONS');
  }
  const known = stationIds(m);

  const corps = m.corporations;
  if (!Array.isArray(corps)) {
    errors.add('DUPLICATE_CORP');
    errors.add('NEGATIVE_CASH');
  } else {
    const seen = new Set();
    for (const c of corps) {
      const corp = c && typeof c === 'object' ? c : {};
      const cid = corp.corpID;
      if (typeof cid !== 'string' || cid.length === 0 || seen.has(cid)) {
        errors.add('DUPLICATE_CORP');
      }
      if (typeof cid === 'string' && cid.length > 0) {
        seen.add(cid);
      }

      if (!Number.isSafeInteger(corp.cashCents) || corp.cashCents < 0) {
        errors.add('NEGATIVE_CASH');
      } else if (corp.cashCents > MAX_BOOTSTRAP_CASH_CENTS) {
        errors.add('UNBOUNDED_CASH');
      }

      if (typeof corp.homeStationID !== 'string' || !known.has(corp.homeStationID)) {
        errors.add('UNKNOWN_STATION');
      }

      const cap = corp.dailySpendCapCents;
      if (
        cap !== undefined &&
        (!Number.isSafeInteger(cap) || cap < 0 || (Number.isSafeInteger(corp.cashCents) && cap > corp.cashCents))
      ) {
        errors.add('SPEND_CAP_OVER_CASH');
      }

      const slots = corp.maxActiveJobs;
      if (
        slots !== undefined &&
        (!Number.isInteger(slots) || slots < 0 || slots > MAX_JOB_SLOTS)
      ) {
        errors.add('INVALID_JOB_SLOTS');
      }
    }
  }

  const sorted = [...errors].sort();
  return { ok: sorted.length === 0, errors: sorted };
}

function createWorldManifest(spec) {
  const verdict = validateWorldManifest(spec);
  if (!verdict.ok) {
    throw new TypeError('invalid world manifest: ' + verdict.errors.join(','));
  }
  const cashCents = spec.corporations.reduce((sum, c) => sum + c.cashCents, 0);
  return Object.freeze({
    version: 1,
    worldSeed: spec.worldSeed,
    stations: spec.stations,
    corporations: spec.corporations,
    totals: Object.freeze({
      corporations: spec.corporations.length,
      stations: spec.stations.length,
      cashCents,
    }),
    bootstrap: true,
  });
}

module.exports = { MAX_BOOTSTRAP_CASH_CENTS, validateWorldManifest, createWorldManifest };
