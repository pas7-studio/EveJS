"use strict";
// Career portal (eve_public.career.goal.*): the four career goals, their completion and
// the reward claim.
//
// The portal used to render from hardcoded stubs that were always "not completed", so the
// Claim button could never exist. There is no real career content in this world - nobody
// hands out CCP's authored career checkpoints - so completion here is an explicit record:
// an admin call (the client's own career admin surface) marks a goal complete, and the
// player claims the reward. That is honest: the goal is complete because a real record
// says so, not because the server guessed.
//
// The reward is skill points, the same type the client's own career proto carries
// (RewardType.skill_points), granted through the one shared grant path.
//
// The goal catalogue lives here so the portal's list and the claim handler can never
// disagree about which goals exist.
const path = require("path");

const { createSkillPointGrant } = require("./coopSkillPointGrant");

const STATE_KEY = "careerGoals";
const VERSION = 1;
const CAREER_GOAL_REWARD_SKILL_POINTS = 25000;

// eve_public.career.Path: 1 exploration, 2 industrialist, 3 enforcer, 4 soldier of fortune
const DEFINITIONS = Object.freeze([
  Object.freeze({ goalID: "00000000-0000-0000-0000-000000000401", career: 1 }),
  Object.freeze({ goalID: "00000000-0000-0000-0000-000000000501", career: 2 }),
  Object.freeze({ goalID: "00000000-0000-0000-0000-000000000601", career: 3 }),
  Object.freeze({ goalID: "00000000-0000-0000-0000-000000000701", career: 4 }),
]);

const TARGET_PROGRESS = 1;

function int(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function pos(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function emptyState() {
  return { version: VERSION, completed: {}, claimed: {}, progress: {} };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || raw.version !== VERSION) {
    return emptyState();
  }
  const keep = (source) => {
    const out = {};
    for (const [key, value] of Object.entries(source || {})) {
      const numeric = int(value);
      if (key && numeric > 0) out[key] = numeric;
    }
    return out;
  };
  const progress = {};
  for (const [key, value] of Object.entries(raw.progress || {})) {
    const numeric = int(value);
    if (key && numeric !== 0) progress[key] = numeric;
  }
  return {
    version: VERSION,
    completed: keep(raw.completed),
    claimed: keep(raw.claimed),
    progress,
  };
}

function createCareerGoals({
  characterState = null,
  clock = () => Date.now(),
  env = process.env,
  grantSkillPoints = null,
} = {}) {
  const owner = () => characterState || require(path.join(
    __dirname,
    "../services/character/characterState",
  ));
  const grant = grantSkillPoints || createSkillPointGrant({ characterState });
  const enabled = () => env.EVEJS_COOP_CAREER_GOALS !== "0";

  function record(characterID) {
    try {
      return owner().getCharacterRecord(characterID) || null;
    } catch (_error) {
      return null;
    }
  }

  function stateOf(characterID) {
    return normalizeState(record(characterID) && record(characterID)[STATE_KEY]);
  }

  function save(characterID, state) {
    const result = owner().updateCharacterRecord(characterID, (entry) => ({
      ...(entry || {}),
      [STATE_KEY]: state,
    }));
    if (!result || result.success !== true) {
      throw Error("CAREER_GOAL_STATE_WRITE_FAILED");
    }
    return state;
  }

  function definitionOf(goalID) {
    return DEFINITIONS.find((entry) => entry.goalID === goalID) || null;
  }

  function snapshotFor(characterID) {
    const id = int(characterID);
    if (!enabled() || id <= 0) return [];
    const state = stateOf(id);
    return DEFINITIONS.map((definition) => {
      const completedAt = int(state.completed[definition.goalID]);
      const claimedAt = int(state.claimed[definition.goalID]);
      const progress = Math.min(
        TARGET_PROGRESS,
        Math.max(0, int(state.progress[definition.goalID])) ||
          (completedAt > 0 ? TARGET_PROGRESS : 0),
      );
      return {
        definition,
        progress,
        completed: progress >= TARGET_PROGRESS,
        completedAt,
        claimedAt,
        claimable: progress >= TARGET_PROGRESS && claimedAt === 0,
      };
    });
  }

  function completeFor(characterID, goalID, nowMs = clock()) {
    if (!enabled()) return { status: "DISABLED" };
    if (!definitionOf(goalID)) return { status: "UNKNOWN_GOAL" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const state = stateOf(id);
    state.completed[goalID] = state.completed[goalID] || nowMs;
    state.progress[goalID] = TARGET_PROGRESS;
    try {
      save(id, state);
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
    return { status: "COMPLETED" };
  }

  function setProgressFor(characterID, goalID, progress, nowMs = clock()) {
    if (!enabled()) return { status: "DISABLED" };
    if (!definitionOf(goalID)) return { status: "UNKNOWN_GOAL" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const state = stateOf(id);
    state.progress[goalID] = Math.max(0, int(progress));
    if (state.progress[goalID] >= TARGET_PROGRESS) {
      state.completed[goalID] = state.completed[goalID] || nowMs;
    }
    try {
      save(id, state);
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
    return { status: "RECORDED", progress: state.progress[goalID] };
  }

  function claim(characterID, goalID, nowMs = clock()) {
    if (!enabled()) return { status: "DISABLED" };
    if (!definitionOf(goalID)) return { status: "UNKNOWN_GOAL" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const state = stateOf(id);
    if (int(state.claimed[goalID]) > 0) return { status: "ALREADY_CLAIMED" };
    const progress = Math.max(
      0,
      int(state.progress[goalID]) || (int(state.completed[goalID]) > 0 ? TARGET_PROGRESS : 0),
    );
    if (progress < TARGET_PROGRESS) {
      return { status: "NOT_COMPLETED", progress, target: TARGET_PROGRESS };
    }
    // Claim first, pay second: a paid claim that was not recorded could pay twice.
    state.claimed[goalID] = nowMs;
    try {
      save(id, state);
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
    try {
      grant(id, CAREER_GOAL_REWARD_SKILL_POINTS);
    } catch (error) {
      delete state.claimed[goalID];
      try {
        save(id, state);
      } catch (_rollbackError) {
        return { status: "REWARD_FAILED_CLAIM_STUCK" };
      }
      return { status: "REWARD_FAILED", reason: error && error.message };
    }
    return { status: "CLAIMED", skillPoints: CAREER_GOAL_REWARD_SKILL_POINTS };
  }

  return Object.freeze({
    enabled,
    snapshotFor,
    completeFor,
    setProgressFor,
    claim,
    rewardSkillPoints: CAREER_GOAL_REWARD_SKILL_POINTS,
  });
}

let singleton = null;
function shared() {
  if (!singleton) {
    singleton = createCareerGoals();
  }
  return singleton;
}

module.exports = {
  CAREER_GOAL_REWARD_SKILL_POINTS,
  DEFINITIONS,
  STATE_KEY,
  TARGET_PROGRESS,
  createCareerGoals,
  emptyState,
  normalizeState,
  shared,
};
