"use strict";
// Daily goals (eve_public.dailygoal.*): the client side is fully built - a cards
// list, progress bars, a redeem button and live notices - and the server answered
// an empty list, so the whole page was blank.
//
// This module is the data side. Everything it reports is measured, never invented:
//
//   mine_ore            -> the real character mining ledger
//                          (services/mining/miningLedgerState, written by the native
//                          mining cycle for a player ship)
//   kill_npc            -> the real killmail ledger, victim must be an NPC and the
//                          final blow must be the character (finalCharacterID)
//   space_jump          -> real accepted stargate jumps, counted by the one-line hook
//                          in space/runtime.startStargateJump
//   complete_daily_goal -> goals this character actually redeemed today
//
// Names and descriptions are real message ids from the pinned client's own
// localization data (res:/localizationFSD/localization_fsd_en-us.pickle): a daily
// goal carries only numeric message ids, so a made-up id would render an empty or
// "missing message" card. `tests/coop-daily-goals.test.mjs` re-reads that pickle
// when it is present and fails if an id no longer means what we claim.
//
// Rewards are skill points, the classic daily-goal reward in EVE, granted through
// the same path the campaign skill crates use (updateCharacterRecord +
// emitSkillSessionState). No ISK is minted: an ISK reward would have to be paid
// from a funded account, and the co-op world has no such sponsor for players.
const path = require("path");

const TABLE_CHARACTERS = "characters";
const TABLE_KILLMAILS = "killmails";
const STATE_KEY = "dailyGoals";
const VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const FILETIME_EPOCH_OFFSET_MS = 11644473600000;
const MAX_TARGET = 1000000;

// Pinned to the client build we run (V24.01). Every id was read out of the
// client's own en-us localization pickle, not guessed.
const MESSAGES = Object.freeze({
  mineOreName: 656416, // "Mine Ore"
  mineOreDescription: 528203, // "Mine ore to help with the materials shortage."
  killNpcName: 1037684, // "Kill NPCs"
  killNpcDescription: 550642, // "Destroy NPCs"
  jumpName: 532900, // "Jump Through"
  completeGoalsName: 696804, // "Complete other goals"
  completeGoalsDescription: 696803, // "Complete Goal"
  noHelp: 36, // an empty message in the client's own data
});

// category: 1 = CATEGORY_DAILY, 2 = CATEGORY_DAILY_BONUS
// career:   0 = CAREER_UNSPECIFIED, 1 = EXPLORATION, 2 = INDUSTRIALIST,
//           3 = ENFORCER, 4 = SOLDIER_OF_FORTUNE (eve_public.career.Path)
const DEFINITIONS = Object.freeze([
  Object.freeze({
    goalID: "1e0d0001-0000-4000-8000-000000000001",
    kind: "mine_ore",
    nameID: MESSAGES.mineOreName,
    descriptionID: MESSAGES.mineOreDescription,
    helpTextID: MESSAGES.noHelp,
    category: 1,
    career: 2,
    target: 5000,
    rewardSkillPoints: 2000,
  }),
  Object.freeze({
    goalID: "1e0d0002-0000-4000-8000-000000000002",
    kind: "kill_npc",
    nameID: MESSAGES.killNpcName,
    descriptionID: MESSAGES.killNpcDescription,
    helpTextID: MESSAGES.noHelp,
    category: 1,
    career: 3,
    target: 5,
    rewardSkillPoints: 3000,
  }),
  Object.freeze({
    goalID: "1e0d0003-0000-4000-8000-000000000003",
    kind: "space_jump",
    nameID: MESSAGES.jumpName,
    descriptionID: MESSAGES.noHelp,
    helpTextID: MESSAGES.noHelp,
    category: 1,
    career: 1,
    target: 10,
    rewardSkillPoints: 2000,
  }),
  Object.freeze({
    goalID: "1e0d0004-0000-4000-8000-000000000004",
    kind: "complete_daily_goal",
    nameID: MESSAGES.completeGoalsName,
    descriptionID: MESSAGES.completeGoalsDescription,
    helpTextID: MESSAGES.noHelp,
    category: 2,
    career: 0,
    target: 2,
    rewardSkillPoints: 5000,
  }),
]);

function int(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function filetimeToMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.floor(numeric / 10000) - FILETIME_EPOCH_OFFSET_MS;
}

function dayKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function dayBounds(nowMs) {
  const start = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return { start, end: start + DAY_MS };
}

function emptyState(nowMs) {
  return { version: VERSION, day: dayKey(nowMs), jumps: 0, claims: {}, manual: {} };
}

// A character's daily state is one small object inside its own character record:
// the record already has a real owner (characterState) and a persistence path, so
// a goal counter never competes with it for the row.
function normalizeState(raw, nowMs) {
  const day = dayKey(nowMs);
  if (!raw || typeof raw !== "object" || raw.version !== VERSION || raw.day !== day) {
    return emptyState(nowMs);
  }
  const claims = {};
  for (const [goalID, claimedAt] of Object.entries(raw.claims || {})) {
    const numeric = int(claimedAt);
    if (goalID && numeric > 0) claims[goalID] = numeric;
  }
  const manual = {};
  for (const [goalID, amount] of Object.entries(raw.manual || {})) {
    const numeric = int(amount);
    if (goalID && numeric !== 0) manual[goalID] = numeric;
  }
  return {
    version: VERSION,
    day,
    jumps: Math.max(0, int(raw.jumps)),
    claims,
    manual,
  };
}

function createDailyGoals({
  gameStore,
  characterState,
  miningLogsFor = null,
  clock = () => Date.now(),
  env = process.env,
} = {}) {
  if (typeof gameStore?.read !== "function" || typeof clock !== "function") {
    throw Error("DAILY_GOALS_STORE_REQUIRED");
  }
  const enabled = () => env.EVEJS_COOP_DAILY_GOALS === "1";

  function readRow(table, pth) {
    try {
      const read = gameStore.read(table, pth);
      return read && read.success ? read.data : null;
    } catch (_error) {
      return null;
    }
  }

  function owner() {
    return characterState || require(path.join(
      __dirname,
      "../services/character/characterState",
    ));
  }

  function characterRecord(characterID) {
    // Read through the same owner that writes: the character record has exactly one
    // owner (characterState), and a second reader would answer stale rows.
    try {
      const viaOwner = owner().getCharacterRecord(characterID);
      if (viaOwner) return viaOwner;
    } catch (_error) { /* fall back to the store below */ }
    const records = readRow(TABLE_CHARACTERS, "/") || {};
    return records[String(characterID)] || null;
  }

  function stateOf(characterID, nowMs) {
    const record = characterRecord(characterID);
    return normalizeState(record && record[STATE_KEY], nowMs);
  }

  function saveState(characterID, state) {
    const result = owner().updateCharacterRecord(characterID, (record) => ({
      ...(record || {}),
      [STATE_KEY]: state,
    }));
    if (!result || result.success !== true) {
      throw Error("DAILY_GOALS_STATE_WRITE_FAILED");
    }
    return state;
  }

  function miningLogs(characterID) {
    if (typeof miningLogsFor === "function") {
      return miningLogsFor(characterID) || [];
    }
    // Lazy: the ledger module owns the gameStore, and a goal read must not drag it
    // in before the store is ready.
    return require(path.join(
      __dirname,
      "../services/mining/miningLedgerState",
    )).getCharacterMiningLogs(characterID);
  }

  function minedUnitsToday(characterID, nowMs) {
    const { start, end } = dayBounds(nowMs);
    let total = 0;
    for (const entry of miningLogs(characterID) || []) {
      const at = filetimeToMs(entry && entry.eventDate);
      if (at >= start && at < end) {
        total += Math.max(0, int(entry.quantity));
      }
    }
    return total;
  }

  function npcKillsToday(characterID, nowMs) {
    const { start, end } = dayBounds(nowMs);
    const table = readRow(TABLE_KILLMAILS, "/") || {};
    const records = table.records || {};
    let total = 0;
    for (const record of Object.values(records)) {
      if (!record || int(record.finalCharacterID) !== characterID) continue;
      // An NPC victim has no character id; a player ship is never "kill NPCs".
      if (int(record.victimCharacterID) > 0) continue;
      const at = filetimeToMs(record.killTime);
      if (at >= start && at < end) total += 1;
    }
    return total;
  }

  function claimsToday(state, nowMs, excludeGoalID) {
    const { start, end } = dayBounds(nowMs);
    let total = 0;
    for (const [goalID, claimedAt] of Object.entries(state.claims)) {
      if (excludeGoalID && goalID === excludeGoalID) continue;
      if (claimedAt >= start && claimedAt < end) total += 1;
    }
    return total;
  }

  function measuredProgress(definition, characterID, state, nowMs) {
    if (definition.kind === "mine_ore") return minedUnitsToday(characterID, nowMs);
    if (definition.kind === "kill_npc") return npcKillsToday(characterID, nowMs);
    if (definition.kind === "space_jump") return state.jumps;
    if (definition.kind === "complete_daily_goal") {
      return claimsToday(state, nowMs, definition.goalID);
    }
    return 0;
  }

  function progressFor(definition, characterID, state, nowMs) {
    const measured = measuredProgress(definition, characterID, state, nowMs);
    const manual = int(state.manual[definition.goalID]);
    return Math.max(0, Math.min(MAX_TARGET, measured + manual));
  }

  function snapshotFor(characterID, nowMs = clock()) {
    if (!enabled()) return { status: "DISABLED", goals: [] };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER", goals: [] };
    const state = stateOf(id, nowMs);
    return {
      status: "OBSERVED",
      goals: DEFINITIONS.map((definition) => {
        const progress = progressFor(definition, id, state, nowMs);
        const claimedAt = int(state.claims[definition.goalID]);
        return {
          definition,
          progress,
          target: definition.target,
          completed: progress >= definition.target,
          claimedAt,
          claimable: progress >= definition.target && claimedAt === 0,
        };
      }),
    };
  }

  // A real accepted stargate jump, from the runtime hook. Never called by a test
  // double: an unmeasured jump is better than an invented one.
  function recordJump(characterID, nowMs = clock()) {
    if (!enabled()) return "DISABLED";
    const id = int(characterID);
    if (id <= 0) return "NO_CHARACTER";
    const state = stateOf(id, nowMs);
    state.jumps = Math.min(MAX_TARGET, state.jumps + 1);
    try {
      saveState(id, state);
    } catch (_error) {
      return "WRITE_FAILED";
    }
    return "RECORDED";
  }

  // The QA path the client itself calls (dailygoal.api.admin.Progress): it adds to
  // the goal's progress for a character. Stored as an explicit manual delta so a
  // QA adjustment is never confused with a measured event.
  function recordManualProgress(goalID, characterID, amount, nowMs = clock()) {
    if (!enabled()) return { status: "DISABLED" };
    const definition = DEFINITIONS.find((entry) => entry.goalID === goalID);
    if (!definition) return { status: "UNKNOWN_GOAL" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const state = stateOf(id, nowMs);
    state.manual[goalID] = int(state.manual[goalID]) + int(amount);
    try {
      saveState(id, state);
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
    return { status: "RECORDED", progress: progressFor(definition, id, state, nowMs) };
  }

  function grantSkillPoints(characterID, amount) {
    const result = owner().updateCharacterRecord(characterID, (record) => ({
      ...(record || {}),
      freeSkillPoints: Math.max(0, int(record && record.freeSkillPoints)) + amount,
    }));
    if (!result || result.success !== true) {
      throw Error("DAILY_GOALS_REWARD_WRITE_FAILED");
    }
    // Tell the live client, exactly like a campaign skill crate does. Without a
    // session the points are still on the record and arrive on the next login.
    try {
      const notifications = require(path.join(
        __dirname,
        "../services/skills/training/skillQueueNotifications",
      ));
      const sessions = require(path.join(__dirname, "../services/chat/sessionRegistry"));
      const session = typeof sessions.findSessionByCharacterID === "function"
        ? sessions.findSessionByCharacterID(characterID)
        : null;
      if (typeof notifications.emitSkillSessionState === "function") {
        notifications.emitSkillSessionState(session, characterID, [], {
          freeSkillPoints: int(result.data && result.data.freeSkillPoints),
        });
      }
    } catch (_error) {
      // the reward is already durable; a missed notification is not a lost reward
    }
    return amount;
  }

  function redeem(characterID, goalID, nowMs = clock()) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const definition = DEFINITIONS.find((entry) => entry.goalID === goalID);
    if (!definition) return { status: "UNKNOWN_GOAL" };
    const state = stateOf(id, nowMs);
    if (int(state.claims[goalID]) > 0) return { status: "ALREADY_CLAIMED" };
    const progress = progressFor(definition, id, state, nowMs);
    if (progress < definition.target) {
      return { status: "NOT_COMPLETED", progress, target: definition.target };
    }
    // Claim first, pay second: a paid goal that was not recorded could be paid
    // twice, a recorded goal that was not paid is recoverable.
    state.claims[goalID] = nowMs;
    try {
      saveState(id, state);
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
    try {
      grantSkillPoints(id, definition.rewardSkillPoints);
    } catch (error) {
      delete state.claims[goalID];
      try {
        saveState(id, state);
      } catch (_rollbackError) {
        return { status: "REWARD_FAILED_CLAIM_STUCK" };
      }
      return { status: "REWARD_FAILED", reason: error && error.message };
    }
    return { status: "REDEEMED", skillPoints: definition.rewardSkillPoints };
  }

  return Object.freeze({
    enabled,
    snapshotFor,
    progressFor,
    recordJump,
    recordManualProgress,
    redeem,
    grantSkillPoints,
  });
}

let singleton = null;
function shared() {
  if (!singleton) {
    singleton = createDailyGoals({ gameStore: require("../gameStore") });
  }
  return singleton;
}

module.exports = {
  DEFINITIONS,
  MESSAGES,
  dayBounds,
  dayKey,
  emptyState,
  filetimeToMs,
  normalizeState,
  createDailyGoals,
  shared,
};
