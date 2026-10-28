"use strict";
// FW-038: a faction with money and no navy must be able to hire one.
//
// Measured on the work stack 2026-10-28, and it is the whole reason no bounty can
// exist: the only funded corporation in the world is ORE (500014, 136.5 M ISK in
// division 1000), and ORE has NO combat hulls at all, while every faction that
// CAN field a navy (500001, 500004, 500011, 500020) holds exactly 0 ISK. Money
// and navies sit on opposite sides, so no war party can ever escrow a bounty.
//
// This module is the decision only: it pairs a funded faction with a
// navy-capable faction and states the exact amount a mercenary contract would
// need. It moves no ISK and creates none - the transfer stays a separate,
// journaled, two-leg operation on the real corporation wallets.
const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const cents = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0;

// Pure. Inputs are measurements, never assumptions.
//   capabilities: [{factionID, status}]  status is "CAN_FIELD" | "NO_NAVY" | ...
//   treasuries:   [{factionID, corporationID, balanceCents}]
function proposeContracts({ capabilities = [], treasuries = [], needCents = 0, limit = 4 } = {}) {
  const need = cents(needCents) ? Number(needCents) : 0;
  if (!need) return { status: "REFUSED", reason: "INVALID_NEED", proposals: [] };
  const navy = new Map(), wallet = new Map();
  for (const row of Array.isArray(capabilities) ? capabilities : []) {
    const factionID = Number(row?.factionID);
    if (!pos(factionID)) continue;
    navy.set(factionID, String(row?.status || "UNKNOWN"));
  }
  for (const row of Array.isArray(treasuries) ? treasuries : []) {
    const factionID = Number(row?.factionID);
    if (!pos(factionID) || !cents(row?.balanceCents)) continue;
    const balance = Number(row.balanceCents);
    const prior = wallet.get(factionID);
    if (!prior || balance > prior.balanceCents) {
      wallet.set(factionID, { factionID, corporationID: Number(row?.corporationID) || 0, balanceCents: balance });
    }
  }
  const payers = [...wallet.values()]
    .filter((w) => w.balanceCents >= need && w.corporationID > 0)
    .sort((a, b) => b.balanceCents - a.balanceCents);
  const fighters = [...navy.entries()]
    .filter(([, status]) => status === "CAN_FIELD")
    .map(([factionID]) => factionID)
    .sort((a, b) => a - b);
  const proposals = [];
  const refusals = [];
  for (const payer of payers) {
    // A faction that can already pay for its own war needs no contract.
    if (navy.get(payer.factionID) === "CAN_FIELD" && payer.balanceCents >= need) {
      refusals.push({ factionID: payer.factionID, reason: "ALREADY_SELF_SUFFICIENT" });
      continue;
    }
    for (const payee of fighters) {
      if (payee === payer.factionID) continue;
      const payeeWallet = wallet.get(payee);
      if (payeeWallet && payeeWallet.balanceCents >= need) {
        refusals.push({ factionID: payee, reason: "PAYEE_ALREADY_FUNDED" });
        continue;
      }
      proposals.push({
        payerFactionID: payer.factionID,
        payerCorporationID: payer.corporationID,
        payerBalanceCents: payer.balanceCents,
        mercenaryFactionID: payee,
        amountCents: need,
        reason: "NAVY_WITHOUT_TREASURY_PAIRED_WITH_TREASURY_WITHOUT_NAVY",
      });
      // One contract per payer: hiring two navies with one treasury is a
      // separate, explicit decision, never an accident of ordering.
      break;
    }
    if (proposals.length >= Math.max(1, Math.min(8, Number(limit) || 1))) break;
  }
  if (!proposals.length)
    return { status: "REFUSED", reason: "NO_FUNDED_NAVY_PAIR", proposals: [], refusals };
  return { status: "PROPOSED", needCents: need, proposals, refusals };
}

module.exports = { proposeContracts };
