"use strict";
// Answers the faction-warfare manager RPCs the client asks before it can build a
// single panel. The pinned server only implements the four rank getters, so every
// other call fell through baseService's "Unhandled method" branch and returned null:
//
//   * eve/client/script/ui/shared/.../fwwarzone/.../fwWarzoneDashboard.py
//     cfg.eveowners.Get(facwar.GetFactionMilitiaCorporation(faction)).name
//     -> KeyError(None), the whole dashboard fails to construct;
//   * the same dashboard calls GetCorpFactionalWarStatus() twice and reads
//     .startDate, so an unanswered call is an AttributeError on None.
//
// Nothing here invents a militia: the corporation comes from the native faction
// record, the status comes from the character's persisted war faction, and a corp or
// alliance with no persisted war faction is reported as having none.
//
// Source .cjs modules become .js siblings in the deployed EveJS overlay.
const num = (value) => Number(value) || 0;
const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

// appConst.py: facwarCorporationJoining = 0, facwarCorporationActive = 1,
// facwarCorporationLeaving = 2.
const CORPORATION_ACTIVE = 1;

// blue.os.GetWallclockTime() is a Windows FILETIME, and the client subtracts it from
// the employment start date, so this has to be a number, not a formatted string.
function filetimeNumber(ms) {
  const value = Math.trunc(num(ms));
  return Number(BigInt(value) * 10000n + 116444736000000000n);
}

// The militia corporation native to a faction (e.g. 500001 Caldari -> 1000180).
// The client feeds this straight into cfg.eveowners, so a faction without a militia
// must answer null rather than a fabricated corporation.
function militiaCorporation(factionID, { getFactionRecord } = {}) {
  const faction = num(factionID);
  if (!pos(faction) || typeof getFactionRecord !== "function") return null;
  const record = getFactionRecord(faction);
  const corpID = num(record && record.militiaCorporationID);
  return pos(corpID) ? corpID : null;
}

// The character's militia status. A character with no persisted war faction has no
// corporation war status at all, and the client renders the enlistment call-to-action
// for that case.
function corpFactionalWarStatus({ charData = {}, session = null, nowMs = Date.now() } = {}) {
  const factionID = num(charData.warFactionID ?? charData.warfactionid ??
    (session && (session.warFactionID ?? session.warfactionid)));
  if (!pos(factionID)) return null;
  const startedAt = num(charData.facWarStartDate ?? charData.warFactionStartDate) ||
    nowMs;
  return { status: CORPORATION_ACTIVE, factionID, startDate: filetimeNumber(startedAt) };
}

module.exports = {
  CORPORATION_ACTIVE,
  filetimeNumber,
  militiaCorporation,
  corpFactionalWarStatus,
};
