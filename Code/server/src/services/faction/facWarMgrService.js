const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { getCharacterRecord } = require(path.join(
  __dirname,
  "../character/characterState",
));
const {
  buildDict,
  buildKeyVal,
  buildList,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));

let factionStateModule = null;
function factionState() {
  if (!factionStateModule) {
    factionStateModule = require(path.join(__dirname, "factionState"));
  }
  return factionStateModule;
}

// The statistics the client asks for are about the same war record the rest of the
// co-op layer writes, so they are read through the one projection that already reads it.
function readWarState() {
  try {
    return require(path.join(__dirname, "../../space/coopWarClientView")).warState();
  } catch (_error) {
    return null;
  }
}

// The header of the militia table is faction ids: the client maps each one through
// appConst.raceByFaction, so only real warzone empires may appear.
function warzoneFactionsOf(warState) {
  const factions = new Set();
  for (const war of Object.values((warState && warState.wars) || {})) {
    if (!war || war.state !== "ACTIVE") continue;
    for (const id of [war.attackerFactionID, war.defenderFactionID]) {
      const factionID = Number(id);
      if (factionID >= 500001 && factionID <= 500004) factions.add(factionID);
    }
  }
  return [...factions].sort((left, right) => left - right);
}

let factionWarMgrViewModule = null;
// The projection lives in the deployed co-op module so it can be tested without a
// server; the service only maps the answer onto the native marshal helpers.
function factionWarMgrView() {
  if (!factionWarMgrViewModule) {
    factionWarMgrViewModule = require(path.join(__dirname, "../../space/coopFactionWarMgrView"));
  }
  return factionWarMgrViewModule;
}

function resolveCharacterID(args, session) {
  return Number(
    (Array.isArray(args) && args.length > 0 && args[0]) ||
      (session &&
        (session.characterID || session.charID || session.charid || session.userid)),
  ) || 0;
}

function normalizePositiveInteger(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue > 0
    ? numericValue
    : fallback;
}

function normalizeRank(value, fallback = null) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.max(0, Math.min(9, Math.trunc(numericValue)));
}

function resolveWarFactionID(charData = {}, session = null) {
  return normalizePositiveInteger(
    charData.warFactionID ??
      charData.warfactionid ??
      (session && (session.warFactionID || session.warfactionid)),
    null,
  );
}

function resolveCurrentRank(charData = {}, fallback = null) {
  const directCandidates = [
    charData.facWarCurrentRank,
    charData.currentRank,
    charData.factionRank,
    charData.factionWarRank,
    charData.militiaRank,
    charData.warFactionRank,
  ];

  for (const candidate of directCandidates) {
    const normalized = normalizeRank(candidate, null);
    if (normalized !== null) {
      return normalized;
    }
  }

  if (charData.facWar && typeof charData.facWar === "object") {
    const nestedRank = normalizeRank(charData.facWar.currentRank, null);
    if (nestedRank !== null) {
      return nestedRank;
    }
  }

  if (charData.rankInfo && typeof charData.rankInfo === "object") {
    const nestedRank = normalizeRank(charData.rankInfo.currentRank, null);
    if (nestedRank !== null) {
      return nestedRank;
    }
  }

  return fallback;
}

function buildRankInfoPayload(characterID, factionID, currentRank) {
  return buildKeyVal([
    ["characterID", characterID || null],
    ["factionID", factionID],
    ["warFactionID", factionID],
    ["currentRank", currentRank],
  ]);
}

function normalizeRankOverviewEntry(entry, fallbackFactionID) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const factionID = normalizePositiveInteger(
    entry.factionID ?? entry.warFactionID,
    fallbackFactionID,
  );
  const currentRank = normalizeRank(entry.currentRank, null);
  if (!factionID || currentRank === null) {
    return null;
  }

  return { factionID, currentRank };
}

function buildRankOverviewPayload(characterID, charData, session) {
  const factionID = resolveWarFactionID(charData, session);
  if (!factionID) {
    return buildList([]);
  }

  const sourceCandidates = [
    charData.facWarRankOverview,
    charData.rankOverview,
    charData.characterRankOverview,
    charData.factionRankOverview,
  ];
  const overviewSource = sourceCandidates.find(Array.isArray);
  const normalizedEntries = [];

  if (overviewSource) {
    for (const entry of overviewSource) {
      const normalized = normalizeRankOverviewEntry(entry, factionID);
      if (normalized) {
        normalizedEntries.push(normalized);
      }
    }
  } else {
    const currentRank = resolveCurrentRank(charData, 0);
    if (currentRank > 0) {
      normalizedEntries.push({ factionID, currentRank });
    }
  }

  return buildList(
    normalizedEntries.map((entry) =>
      buildRankInfoPayload(characterID, entry.factionID, entry.currentRank)
    ),
  );
}

function buildSingleRankInfo(characterID, charData, session) {
  const factionID = resolveWarFactionID(charData, session);
  if (!factionID) {
    return null;
  }

  return buildRankInfoPayload(
    characterID,
    factionID,
    resolveCurrentRank(charData, 0),
  );
}

class FacWarMgrService extends BaseService {
  constructor() {
    super("facWarMgr");
  }

  Handle_GetMyCharacterRankOverview(args, session) {
    const characterID = resolveCharacterID(args, session);
    const charData = characterID ? getCharacterRecord(characterID) || {} : {};
    const result = buildRankOverviewPayload(characterID, charData, session);

    log.debug(
      `[FacWarMgr] GetMyCharacterRankOverview(charID=${characterID}) -> ${result.items.length}`,
    );

    return result;
  }

  Handle_GetCharacterRankOverview(args, session) {
    const characterID = resolveCharacterID(args, session);
    const charData = characterID ? getCharacterRecord(characterID) || {} : {};
    const result = buildRankOverviewPayload(characterID, charData, session);

    log.debug(
      `[FacWarMgr] GetCharacterRankOverview(charID=${characterID}) -> ${result.items.length}`,
    );

    return result;
  }

  Handle_GetMyCharacterRankInfo(args, session) {
    const characterID = resolveCharacterID(args, session);
    const charData = characterID ? getCharacterRecord(characterID) || {} : {};
    const result = buildSingleRankInfo(characterID, charData, session);

    log.debug(
      `[FacWarMgr] GetMyCharacterRankInfo(charID=${characterID}) -> ${result ? "rank" : "none"}`,
    );

    return result;
  }

  Handle_GetCharacterRankInfo(args, session) {
    const characterID = resolveCharacterID(args, session);
    const charData = characterID ? getCharacterRecord(characterID) || {} : {};
    const result = buildSingleRankInfo(characterID, charData, session);

    log.debug(
      `[FacWarMgr] GetCharacterRankInfo(charID=${characterID}) -> ${result ? "rank" : "none"}`,
    );

    return result;
  }
  // The client asks these before it can build a single faction-warfare panel, and the
  // pinned server answered every one of them with baseService's "Unhandled method"
  // null: fwWarzoneDashboard.py dereferences cfg.eveowners.Get(GetFactionMilitiaCorporation())
  // and factionalWarStatus.startDate, so the dashboard threw instead of opening.
  Handle_GetFactionMilitiaCorporation(args) {
    const factionID = normalizePositiveInteger(args && args[0], null);
    const corpID = factionWarMgrView().militiaCorporation(factionID, {
      getFactionRecord: (id) => factionState().getFactionRecord(id),
    });

    log.debug(
      `[FacWarMgr] GetFactionMilitiaCorporation(factionID=${factionID}) -> ${corpID || "none"}`,
    );

    return corpID;
  }

  Handle_GetCorpFactionalWarStatus(args, session) {
    const characterID = resolveCharacterID(args, session);
    const charData = characterID ? getCharacterRecord(characterID) || {} : {};
    const status = factionWarMgrView().corpFactionalWarStatus({ charData, session });

    log.debug(
      `[FacWarMgr] GetCorpFactionalWarStatus(charID=${characterID}) -> ${status ? status.status : "none"}`,
    );

    return status
      ? buildKeyVal([
          ["status", status.status],
          ["factionID", status.factionID],
          ["startDate", status.startDate],
        ])
      : null;
  }

  // A corporation or alliance holds a war faction only through persisted state; this
  // world has no such registry, so the honest answer is "none" rather than a guess.
  Handle_GetCorporationWarFactionID() {
    return null;
  }

  Handle_GetAllianceWarFactionID() {
    return null;
  }

  Handle_GetFactionCorporations() {
    return buildList([]);
  }

  // The statistics tab builds every table from these six answers, and
  // statisticsController.py dereferences topStats[0][group] and .items() directly, so a
  // null here raised instead of rendering an empty table.
  Handle_GetStats_Character() {
    return factionWarMgrView().emptyStats();
  }

  Handle_GetStats_Corp() {
    return factionWarMgrView().emptyStats();
  }

  Handle_GetStats_Alliance() {
    return factionWarMgrView().emptyStats();
  }

  Handle_GetStats_TopAndAllKillsAndVPs() {
    const [top, all] = factionWarMgrView().topAndAllStats();
    return [buildDict(Object.entries(top)), buildDict(Object.entries(all))];
  }

  Handle_GetStats_Militia() {
    const view = factionWarMgrView();
    const warState = readWarState();
    const militia = view.militiaStats({ warzoneFactions: warzoneFactionsOf(warState) });
    const data = {};
    for (const [key, byFaction] of Object.entries(militia.data || {})) {
      data[key] = buildDict(Object.entries(byFaction));
    }
    return buildKeyVal([["header", buildList(militia.header)], ["data", buildDict(Object.entries(data))]]);
  }

  Handle_GetStats_FactionInfo() {
    const rows = factionWarMgrView().factionInfo(readWarState());
    return buildDict(Object.entries(rows).map(([factionID, row]) => [
      Number(factionID),
      buildKeyVal(Object.entries(row)),
    ]));
  }
}

module.exports = FacWarMgrService;
