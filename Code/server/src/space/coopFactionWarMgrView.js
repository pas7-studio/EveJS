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

// --- statistics -------------------------------------------------------------------
//
// fwwarzone/client/dashboard/statisticsController.py builds every table from these
// answers and does not tolerate a missing one: GetStats_Personal dereferences
// topStats[0][groupCharacter][key] and GetStats_Character().items(). The pinned server
// had none of them, so the statistics tab raised instead of rendering.
//
// inventorycommon/const.py: groupCharacter = 1, groupCorporation = 2,
// groupAlliance = 32. The militia table is keyed by FACTION id, because the client maps
// each header entry through appConst.raceByFaction.
const GROUP_CHARACTER = 1;
const GROUP_CORPORATION = 2;
const GROUP_ALLIANCE = 32;
const STAT_KEYS = Object.freeze(["killsY", "killsLW", "killsTotal", "vpY", "vpLW", "vpTotal"]);

// The world records wrecks without a killer identity
// (attribution NATIVE_VICTIM_WRECK_ONLY_NO_KILLER), so no number here may claim a kill
// that was never attributed. The tables are well formed and honest: zero kills and zero
// victory points until a real attribution exists, and real system counts, which we do know.
function emptyStats() {
  const out = {};
  for (const key of STAT_KEYS) out[key] = 0;
  return out;
}

function statsForGroup(groupID) {
  return { [groupID]: emptyStats() };
}

// GetStats_TopAndAllKillsAndVPs: [topByGroup, allByGroup].
function topAndAllStats() {
  const top = {};
  const all = {};
  for (const groupID of [GROUP_CHARACTER, GROUP_CORPORATION, GROUP_ALLIANCE]) {
    top[groupID] = emptyStats();
    all[groupID] = emptyStats();
  }
  return [top, all];
}

// GetStats_Militia: one column per real warzone faction.
function militiaStats({ warzoneFactions = [] } = {}) {
  const header = (warzoneFactions || []).map(Number).filter(pos);
  const data = {};
  for (const key of STAT_KEYS) {
    data[key] = {};
    for (const factionID of header) data[key][factionID] = 0;
  }
  return { header, data };
}

// GetStats_FactionInfo: the only number we can honestly publish is how much ground each
// side really holds, straight from the war record's territory controllers.
function factionInfo(warState) {
  const counts = new Map();
  for (const record of Object.values((warState && warState.territories) || {})) {
    const controller = num(record && record.militaryControllerFactionID);
    if (!pos(controller)) continue;
    counts.set(controller, (counts.get(controller) || 0) + 1);
  }
  const out = {};
  for (const [factionID, systemsCount] of counts) {
    out[factionID] = {
      militiaMembersCount: 0,
      totalMembersCount: 0,
      topMemberCount: 0,
      systemsCount,
    };
  }
  return out;
}

module.exports = {
  CORPORATION_ACTIVE,
  GROUP_CHARACTER,
  GROUP_CORPORATION,
  GROUP_ALLIANCE,
  STAT_KEYS,
  filetimeNumber,
  militiaCorporation,
  corpFactionalWarStatus,
  emptyStats,
  statsForGroup,
  topAndAllStats,
  militiaStats,
  factionInfo,
};
