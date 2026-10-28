"use strict";
// FW-046: one real bounty escrow per campaign side.
//
// Measured on the work stack at 19:15Z: a decided war had a HELD bounty for the
// attacker only, the kill was made by a DEFENDER, and `coopWarBounty` correctly
// refused with NO_HELD_ESCROW_FOR_FACTION, so no ISK could move. The reservation
// loop returned on its first success, which made half of every war unpayable.
//
// This module is only the ordering decision, so it can be tested without any
// treasury, wallet or world: which sides are attempted, which side is the
// campaign's supply proof, and what a per-side refusal is allowed to do.
// It never decides that money exists - `reserveSide` is the real authority and
// its refusal is kept verbatim.

// `reserveSide(factionID)` must return {status:"RESERVED", reservationID, ...}
// or {status:"REFUSED", reason, ...}. Nothing here invents either.
function planSideReservations({ sides = [], both = false, attackerFactionID = 0,
  reserveSide } = {}) {
  if (typeof reserveSide !== "function") return { results: [], funded: [], primary: null };
  const ordered = (Array.isArray(sides) ? sides : [])
    .filter((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0)
    .map(Number);
  const results = [];
  for (const factionID of ordered) {
    const outcome = reserveSide(factionID) || { status: "REFUSED", reason: "NO_RESULT" };
    results.push(Object.assign({}, outcome, { factionID: Number(outcome.factionID) || factionID }));
    // Without the opt-in the old behaviour is preserved exactly: stop at the
    // first side that could fund, so an existing deployment cannot be surprised
    // by a second escrow it never asked for.
    if (!both && results[results.length - 1].status === "RESERVED") break;
  }
  const funded = results.filter((row) => row.status === "RESERVED");
  // The campaign runs attacker -> defender, so the attacker's escrow is the one
  // that names this campaign's supply; a defender-only funding stays a fallback.
  const primary = funded.find((row) => Number(row.factionID) === Number(attackerFactionID)) ||
    funded[0] || null;
  return { results, funded, primary };
}

module.exports = { planSideReservations };
