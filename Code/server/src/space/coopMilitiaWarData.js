"use strict";
// FW-024: the faction <-> enemy pairs come from the game's own data, never from
// a co-op list.
//
// Source of truth 1 (the client's faction-warfare warzones), mirrored here
// because `services/map/fwWarzoneSolarsystemService.js` keeps them private:
//   WARZONE_AMARR_MINMATAR = 1 -> [Amarr 500003, Minmatar 500002]
//   WARZONE_CALDARI_GALLENTE = 2 -> [Caldari 500001, Gallente 500004]
// `tests/coop-militia-war-data.test.mjs` re-reads that service source and fails
// if this mirror ever drifts from it.
//
// Source of truth 2 (a war that is really declared in this world): the war
// state's own `wars` records, which are only ever opened from real territories
// and real reciprocal gates. A declared war always wins over the static pair,
// because it is the war that actually exists right now.
const fs = require("node:fs");
const path = require("node:path");
const pos = (x) => Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : 0;

const WARZONES = Object.freeze({
  1: Object.freeze([500003, 500002]),
  2: Object.freeze([500001, 500004]),
});

function warzonePairs() {
  return Object.entries(WARZONES).map(([warzoneID, factionIDs]) => ({
    warzoneID: Number(warzoneID), factionIDs: factionIDs.slice(),
  }));
}

function warzoneOpponent(factionID) {
  const id = pos(factionID);
  for (const [warzoneID, pair] of Object.entries(WARZONES)) {
    if (pair.includes(id)) return { warzoneID: Number(warzoneID), opponentFactionID: pair.find((x) => x !== id) };
  }
  return null;
}

// Every war this faction is really part of, from the live war state.
function declaredOpponents(factionID, warState) {
  const id = pos(factionID);
  if (!id || !warState?.wars) return [];
  const out = [];
  for (const war of Object.values(warState.wars)) {
    if (!war || !pos(war.attackerFactionID) || !pos(war.defenderFactionID)) continue;
    const opponent = war.attackerFactionID === id ? pos(war.defenderFactionID)
      : war.defenderFactionID === id ? pos(war.attackerFactionID) : 0;
    if (!opponent) continue;
    const campaigns = Object.values(warState.campaigns || {})
      .filter((c) => c && c.warID === war.warID && pos(c.targetSystemID))
      .map((c) => ({ campaignID: String(c.campaignID), state: String(c.state || ""), targetSystemID: pos(c.targetSystemID) }));
    out.push({ warID: String(war.warID), state: String(war.state || ""), opponentFactionID: opponent, campaigns });
  }
  return out;
}

// What this character would fight for, and who the enemy is.
function militiaSituation({ characterID, character, faction, warState } = {}) {
  const id = pos(characterID);
  if (!id || !character) return { status: "NO_CHARACTER" };
  // The record is read BY characterID; some stock rows omit the field entirely,
  // so only an explicit, different id is a mismatch.
  if (character.characterID !== undefined && character.characterID !== null &&
    Number(character.characterID) !== id) return { status: "NO_CHARACTER" };
  const factionID = pos(character.factionID) || pos(faction?.factionID);
  if (!factionID) return { status: "NO_CHARACTER_FACTION" };
  if (!faction || Number(faction.factionID) !== factionID) return { status: "FACTION_NOT_FOUND", factionID };
  if (!pos(faction.militiaCorporationID))
    return { status: "NO_MILITIA_CORPORATION", factionID, factionName: String(faction.name || "") };
  const declared = declaredOpponents(factionID, warState);
  const zone = warzoneOpponent(factionID);
  return {
    status: "MILITIA_AVAILABLE",
    characterID: id,
    factionID,
    factionName: String(faction.name || ""),
    militiaCorporationID: pos(faction.militiaCorporationID),
    declaredWars: declared,
    warzone: zone,
    enemyFactionIDs: [...new Set([
      ...declared.map((w) => w.opponentFactionID),
      ...(zone ? [zone.opponentFactionID] : []),
    ])].sort((a, b) => a - b),
    fronts: declared.flatMap((w) => w.campaigns.filter((c) => c.state === "ASSAULT")
      .map((c) => ({ warID: w.warID, campaignID: c.campaignID, systemID: c.targetSystemID }))),
  };
}

module.exports = { WARZONES, warzonePairs, warzoneOpponent, declaredOpponents, militiaSituation };
