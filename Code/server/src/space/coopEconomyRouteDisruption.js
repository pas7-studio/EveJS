'use strict';

function classifyDisruption({ evidence } = {}) {
  const ev = evidence || {};

  // Lost cargo is never recreated.
  if (ev.destroyed === true || (ev.hullPresent === false && ev.cargoPresent === false)) {
    return { state: 'LOST', code: 'CARGO_LOST', recreateCargo: false };
  }

  if (ev.hullPresent === false && ev.cargoPresent === true) {
    return { state: 'STRANDED', code: 'HULL_MISSING' };
  }

  if (ev.hullPresent === true && ev.cargoPresent === false) {
    return { state: 'ATTACKED', code: 'CARGO_MISSING' };
  }

  // A timeout never teleports a live ship.
  if (
    ev.tick - ev.lastPingTick > ev.timeoutTicks &&
    !ev.gateReceiptID
  ) {
    return { state: 'UNCERTAIN', code: 'NO_EVIDENCE', teleport: false };
  }

  return { state: 'NOMINAL', code: 'ON_ROUTE' };
}

function replan({ state, fleet }) {
  // No replan without an authoritative readback.
  if (state === 'UNCERTAIN' || state === 'LOST') {
    return { ok: false, code: 'RECONCILE_REQUIRED' };
  }

  const available = (fleet || []).filter((h) => h.available);

  if (available.length === 0) {
    return { ok: false, code: 'NO_SHIP' };
  }

  const chosen = available
    .slice()
    .sort((a, b) => (a.hullID < b.hullID ? -1 : a.hullID > b.hullID ? 1 : 0))[0];

  return { ok: true, code: 'REPLANNED', hullID: chosen.hullID };
}

const DISRUPTION_CODE = {
  LOST: 'CARGO_LOST',
  STRANDED: 'HULL_MISSING',
  ATTACKED: 'CARGO_MISSING',
  UNCERTAIN: 'NO_EVIDENCE',
  NOMINAL: 'ON_ROUTE',
};

module.exports = { classifyDisruption, replan, DISRUPTION_CODE };
