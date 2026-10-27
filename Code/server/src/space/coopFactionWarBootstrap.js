"use strict";
// Opening move of a war: turn a real front into a real war + campaign record.
//
// The mobiliser only reserves ships for a campaign that already exists in the war
// state (`wars[warID]` ACTIVE + `campaigns[campaignID]` PREPARING/ASSAULT with
// sourceSystemID and targetSystemID). This module builds exactly that shape from
// the derived fronts, so nothing has to be hand-written into the store.
const num = (value) => Number(value) || 0;
const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

// A front owner arrives as a string from `territoriesFromPresence` and as a
// number from the authoritative war state. Both are real faction ids; anything
// else (`"caldari"`, `"unknown"`, 0) is not a faction and cannot start a war.
const factionID = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

function refuse(reason, extra) {
  return Object.assign({ status: "REFUSED", reason }, extra || {});
}

const realEdge = (edge) => edge && pos(edge.fromSystemID) && pos(edge.toSystemID) &&
  factionID(edge.fromOwner) !== null && factionID(edge.toOwner) !== null &&
  factionID(edge.fromOwner) !== factionID(edge.toOwner);

// The biggest front with a real, numeric faction pair on both sides. Ties are
// broken by the system ids so two ticks never flip the war back and forth.
function pickFront(fronts) {
  const usable = (Array.isArray(fronts) ? fronts : [])
    .filter((front) => front && Array.isArray(front.edges) && front.edges.length)
    .filter((front) => front.edges.some(realEdge))
    .sort((a, b) => b.edgeCount - a.edgeCount || String(a.frontID).localeCompare(String(b.frontID)));
  return usable[0] || null;
}

function planOpeningCampaign({ fronts, nowMs, warID, campaignID } = {}) {
  const front = pickFront(fronts);
  if (!front) return refuse("NO_FRONT_WITH_TWO_REAL_FACTIONS");
  const edge = front.edges
    .filter(realEdge)
    .sort((a, b) => a.fromSystemID - b.fromSystemID || a.toSystemID - b.toSystemID)[0];
  if (!edge) return refuse("NO_REAL_EDGE");
  const at = num(nowMs) > 0 ? num(nowMs) : Date.now();
  const attackerFactionID = factionID(edge.fromOwner);
  const defenderFactionID = factionID(edge.toOwner);
  const war = {
    warID: String(warID || "war:" + attackerFactionID + "-" + defenderFactionID + ":" + at),
    state: "ACTIVE",
    attackerFactionID,
    defenderFactionID,
    startedAtMs: at,
    frontID: String(front.frontID || ""),
  };
  const campaign = {
    campaignID: String(campaignID || "campaign:" + war.warID + ":1"),
    warID: war.warID,
    state: "PREPARING",
    sourceSystemID: Number(edge.fromSystemID),
    targetSystemID: Number(edge.toSystemID),
    startedAt: at,
  };
  return {
    status: "PLANNED",
    war,
    campaign,
    frontID: front.frontID,
    edgeCount: front.edgeCount,
    gateID: pos(edge.gateID) ? Number(edge.gateID) : null,
    reciprocalGateID: pos(edge.reciprocalGateID) ? Number(edge.reciprocalGateID) : null,
  };
}

module.exports = { pickFront, planOpeningCampaign, factionID, realEdge };
