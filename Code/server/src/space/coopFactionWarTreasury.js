"use strict";
// Faction treasury as a PAPER budget.
//
// Owner decision 2026-10-27: for now a faction earns ISK for holding sectors and
// for enemy kills, and spends it on hulls and ammunition. Ship purchases are
// "on paper" because real market buying would bleed the market while there are
// no adequate producers yet. Nothing here invents a market fill: the paper
// nature is part of the result (`paper: true`) so it can never be mistaken for a
// real native settlement.
const num = (value) => Number(value) || 0;
const isk = (value) => Math.max(0, Math.round(num(value)));

// Paper hull prices, ordered small -> large. A promotion may only unlock the
// next class when the treasury can actually pay for it.
const HULL_CLASSES = Object.freeze([
  { classID: "frigate", name: "Frigate", priceISK: 4_000_000 },
  { classID: "destroyer", name: "Destroyer", priceISK: 12_000_000 },
  { classID: "cruiser", name: "Cruiser", priceISK: 35_000_000 },
  { classID: "battlecruiser", name: "Battlecruiser", priceISK: 90_000_000 },
  { classID: "battleship", name: "Battleship", priceISK: 220_000_000 },
  { classID: "capital", name: "Capital", priceISK: 3_200_000_000 },
]);

const DEFAULT_RATES = Object.freeze({
  // Income for holding a sector for one cycle, and for one confirmed enemy kill.
  sectorIncomeISK: 250_000,
  killBountyISK: 1_500_000,
  // Ammunition is abstract until real logistics exist.
  ammoPerShipISK: 1_500_000,
  // One military operation (a campaign opening, a front push) costs about one
  // sector cycle, so a faction that really holds ground can always act, and a
  // faction that holds nothing cannot.
  supplyPerOperationISK: 250_000,
});

function hullForClass(classID) {
  const wanted = String(classID || "");
  return HULL_CLASSES.find((entry) => entry.classID === wanted) || null;
}

// Income for one cycle. Only real holdings and real, evidenced kills count.
function income({ heldSystemIDs = [], confirmedKills = 0, rates = DEFAULT_RATES } = {}) {
  const rules = Object.assign({}, DEFAULT_RATES, rates || {});
  const systems = [...new Set((Array.isArray(heldSystemIDs) ? heldSystemIDs : [])
    .map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0))];
  const kills = Math.max(0, Math.trunc(num(confirmedKills)));
  const sectorISK = systems.length * isk(rules.sectorIncomeISK);
  const bountyISK = kills * isk(rules.killBountyISK);
  return {
    status: "INCOME",
    paper: true,
    systems: systems.length,
    kills,
    sectorISK,
    bountyISK,
    totalISK: sectorISK + bountyISK,
  };
}

// Applies income to a balance. A treasury never goes negative.
function credit({ balanceISK = 0, income: inflow = null } = {}) {
  const before = isk(balanceISK);
  const delta = isk(inflow && inflow.totalISK);
  return { status: "CREDITED", paper: true, beforeISK: before, deltaISK: delta, afterISK: before + delta };
}

// A purchase is refused, not silently allowed, when the treasury cannot pay.
// `paper: true` means no market order and no cargo was created.
function purchase({ balanceISK = 0, classID = "", quantity = 1, rates = DEFAULT_RATES } = {}) {
  const rules = Object.assign({}, DEFAULT_RATES, rates || {});
  const hull = hullForClass(classID);
  if (!hull) return { status: "REFUSED_UNKNOWN_CLASS", classID: String(classID || "") };
  const count = Math.max(1, Math.trunc(num(quantity) || 1));
  const hullISK = hull.priceISK * count;
  const ammoISK = isk(rules.ammoPerShipISK) * count;
  const costISK = hullISK + ammoISK;
  const balance = isk(balanceISK);
  if (costISK > balance) {
    return { status: "REFUSED_UNFUNDED", paper: true, classID: hull.classID, quantity: count, costISK, balanceISK: balance };
  }
  return {
    status: "PURCHASED",
    paper: true,
    classID: hull.classID,
    quantity: count,
    hullISK,
    ammoISK,
    costISK,
    balanceISK: balance - costISK,
    evidence: "PAPER_BUDGET_NO_MARKET_ORDER_NO_CARGO",
  };
}

// A promotion may only move a pilot into a class the treasury can equip. This is
// what keeps rank meaningful instead of cosmetic.
function affordableClass({ balanceISK = 0, preferredClassID = "", rates = DEFAULT_RATES } = {}) {
  const balance = isk(balanceISK);
  const rules = Object.assign({}, DEFAULT_RATES, rates || {});
  const preferred = hullForClass(preferredClassID);
  const candidates = preferred ? [preferred] : [...HULL_CLASSES].reverse();
  for (const hull of candidates) {
    if (hull.priceISK + isk(rules.ammoPerShipISK) <= balance) return hull.classID;
  }
  return null;
}

// Can this faction pay for one military operation right now? The budget is what
// it really holds plus whatever balance it carries. Still paper: no order, no
// cargo, and `paper: true` travels with the answer.
function fundOperation({ balanceISK = 0, heldSystemIDs = [], rates = DEFAULT_RATES } = {}) {
  const rules = Object.assign({}, DEFAULT_RATES, rates || {});
  const inflow = income({ heldSystemIDs, rates: rules });
  const budgetISK = isk(balanceISK) + inflow.totalISK;
  const costISK = isk(rules.supplyPerOperationISK);
  if (costISK <= 0) return { status: "REFUSED_INVALID_RATE", paper: true, costISK };
  if (budgetISK < costISK) {
    return {
      status: "REFUSED_UNFUNDED", paper: true,
      heldSystems: inflow.systems, sectorIncomeISK: inflow.totalISK,
      budgetISK, costISK, evidence: "PAPER_BUDGET_NO_HELD_GROUND",
    };
  }
  return {
    status: "FUNDED", paper: true,
    heldSystems: inflow.systems, sectorIncomeISK: inflow.totalISK,
    budgetISK, costISK, afterISK: budgetISK - costISK,
    evidence: "PAPER_OPERATION_BUDGET_NO_MARKET_ORDER_NO_CARGO",
  };
}

module.exports = { HULL_CLASSES, DEFAULT_RATES, hullForClass, income, credit, purchase, affordableClass, fundOperation };
