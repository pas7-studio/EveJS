"use strict";
// Achievements (eve_public.achievement.*): progress, completion and the rewards they unlock.
//
// The catalogue (which achievements exist, their targets, categories and rewards) is client
// content: it arrives through a definition checkpoint, and this module deliberately does not
// invent ids. What the server owns is what really happened:
//
//   rows        { uuid -> { progress, completedMs, milestones[] } }   per character
//   categories  { uuid -> { score } }                                 per character
//   unclaimed   [ { achievement, category, milestone, claimedMs } ]   per character
//
// Admin AddProgress adds a real delta; Complete marks the achievement finished and puts its
// reward on the unclaimed list; Reset clears the row and withdraws the reward that completion
// put there. A claim moves the reward from unclaimed to claimed and pays the skill points our
// catalogue declares for that achievement - SP is character state, the same currency the daily
// goals and the career portal grant. It is paid before the entry is removed, so a failed grant
// leaves the reward claimable instead of eating it.
//
// Rows live inside the character record through its single owner (characterState).
const path = require("path");
const { createSkillPointGrant } = require("./coopSkillPointGrant");

const STATE_KEY = "achievements";
const VERSION = 1;
const UUID_HEX = /^[0-9a-f]{2,128}$/;

function int(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function uuidKey(value) {
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return String(value == null ? "" : value).trim().toLowerCase();
}

function emptyState() {
  return { version: VERSION, rows: {}, categories: {}, unclaimed: [] };
}

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || Number(raw.version) !== VERSION) {
    return emptyState();
  }
  const rows = {};
  for (const [key, row] of Object.entries(raw.rows || {})) {
    const uuid = uuidKey(key);
    if (!UUID_HEX.test(uuid) || !row || typeof row !== "object") continue;
    rows[uuid] = {
      uuid,
      progress: Math.max(0, int(row.progress)),
      completedMs: Math.max(0, int(row.completedMs)),
      milestones: (Array.isArray(row.milestones) ? row.milestones : []).map((entry) => ({
        milestone: uuidKey(entry && entry.milestone),
        reachedMs: Math.max(0, int(entry && entry.reachedMs)),
        points: Math.max(0, int(entry && entry.points)),
      })).filter((entry) => UUID_HEX.test(entry.milestone)),
    };
  }
  const categories = {};
  for (const [key, row] of Object.entries(raw.categories || {})) {
    const uuid = uuidKey(key);
    if (!UUID_HEX.test(uuid)) continue;
    categories[uuid] = {
      uuid,
      score: Math.max(0, int(row && row.score)),
      milestones: (Array.isArray(row && row.milestones) ? row.milestones : [])
        .map((entry) => ({
          milestone: uuidKey(entry && entry.milestone),
          reachedMs: Math.max(0, int(entry && entry.reachedMs)),
        })).filter((entry) => UUID_HEX.test(entry.milestone)),
    };
  }
  const unclaimed = (Array.isArray(raw.unclaimed) ? raw.unclaimed : [])
    .map((entry) => ({
      achievement: uuidKey(entry && entry.achievement),
      category: uuidKey(entry && entry.category),
      milestone: uuidKey(entry && entry.milestone),
      grantedMs: Math.max(0, int(entry && entry.grantedMs)),
    }))
    .filter((entry) => UUID_HEX.test(entry.achievement) || UUID_HEX.test(entry.category));
  return { version: VERSION, rows, categories, unclaimed };
}

function createAchievements({
  characterState = null,
  clock = () => Date.now(),
  env = process.env,
  rewardLookup = null,
  grantSkillPoints = null,
} = {}) {
  const owner = () => characterState || require(path.join(
    __dirname,
    "../services/character/characterState",
  ));
  const enabled = () => env.EVEJS_COOP_ACHIEVEMENTS === "1";

  // What claiming an achievement actually pays. The amount comes from our own catalogue
  // (space/coopAchievementContent), so the reward shown in the client and the reward paid are the
  // same number, and an achievement the catalogue does not declare pays nothing.
  function declaredSkillPoints(achievementKey) {
    try {
      const lookup = rewardLookup || require(path.join(__dirname, "coopAchievementContent"));
      return Number(lookup.skillPointsFor(achievementKey)) || 0;
    } catch (_error) {
      return 0;
    }
  }

  function pay(characterID, amount) {
    if (amount <= 0) return { status: "OK" };
    try {
      const grant = grantSkillPoints || createSkillPointGrant();
      grant(characterID, amount);
      return { status: "OK" };
    } catch (_error) {
      return { status: "REWARD_FAILED" };
    }
  }

  function stateOf(characterID) {
    try {
      const record = owner().getCharacterRecord(characterID);
      return normalizeState(record && record[STATE_KEY]);
    } catch (_error) {
      return emptyState();
    }
  }

  function persist(characterID, state) {
    try {
      const result = owner().updateCharacterRecord(characterID, (record) => ({
        ...(record || {}),
        [STATE_KEY]: state,
      }));
      return result && result.success === true ? { status: "OK" } : { status: "WRITE_FAILED" };
    } catch (_error) {
      return { status: "WRITE_FAILED" };
    }
  }

  function rowOf(state, uuid) {
    if (!state.rows[uuid]) {
      state.rows[uuid] = { uuid, progress: 0, completedMs: 0, milestones: [] };
    }
    return state.rows[uuid];
  }

  function get(characterID, uuid) {
    const id = int(characterID);
    const key = uuidKey(uuid);
    if (!enabled() || id <= 0 || !UUID_HEX.test(key)) return null;
    return stateOf(id).rows[key] || null;
  }

  // A delta is a real measurement, so a zero delta is refused rather than recorded as activity.
  function addProgress(characterID, uuid, delta) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    const key = uuidKey(uuid);
    if (id <= 0) return { status: "NO_CHARACTER" };
    if (!UUID_HEX.test(key)) return { status: "ACHIEVEMENT_REQUIRED" };
    const amount = int(delta);
    if (amount === 0) return { status: "DELTA_REQUIRED" };
    const state = stateOf(id);
    const row = rowOf(state, key);
    if (row.completedMs > 0) return { status: "ALREADY_COMPLETE" };
    row.progress = Math.max(0, row.progress + amount);
    const written = persist(id, state);
    return written.status === "OK"
      ? { status: "RECORDED", progress: row.progress }
      : written;
  }

  function complete(characterID, uuid) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    const key = uuidKey(uuid);
    if (id <= 0) return { status: "NO_CHARACTER" };
    if (!UUID_HEX.test(key)) return { status: "ACHIEVEMENT_REQUIRED" };
    const state = stateOf(id);
    const row = rowOf(state, key);
    if (row.completedMs > 0) return { status: "ALREADY_COMPLETE" };
    row.completedMs = int(clock()) || Date.now();
    state.unclaimed.push({ achievement: key, category: "", milestone: "", grantedMs: row.completedMs });
    const written = persist(id, state);
    return written.status === "OK" ? { status: "COMPLETED", row } : written;
  }

  // Reset is the undo of "this really happened": the progress, the completion and the reward that
  // completion created all go away together.
  function reset(characterID, uuid) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    const key = uuidKey(uuid);
    if (id <= 0) return { status: "NO_CHARACTER" };
    if (!UUID_HEX.test(key)) return { status: "ACHIEVEMENT_REQUIRED" };
    const state = stateOf(id);
    if (!state.rows[key]) return { status: "NOT_FOUND" };
    delete state.rows[key];
    state.unclaimed = state.unclaimed.filter((entry) => entry.achievement !== key);
    const written = persist(id, state);
    return written.status === "OK" ? { status: "RESET" } : written;
  }

  // ResetAll is the admin surface that clears every achievement of one character. It removes the
  // progress rows and the unclaimed list together, because a reward left claimable after its
  // progress was wiped would be a reward for something the character no longer did.
  function clear(characterID) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const state = stateOf(id);
    const written = persist(id, { version: VERSION, rows: {}, categories: {}, unclaimed: [] });
    return written.status === "OK"
      ? { status: "CLEARED", achievements: Object.keys(state.rows || {}).length }
      : written;
  }

  function category(characterID, uuid) {
    const id = int(characterID);
    const key = uuidKey(uuid);
    if (!enabled() || id <= 0 || !UUID_HEX.test(key)) return null;
    return stateOf(id).categories[key] || { uuid: key, score: 0, milestones: [] };
  }

  function unclaimed(characterID) {
    const id = int(characterID);
    if (!enabled() || id <= 0) return [];
    return stateOf(id).unclaimed.filter((entry) => entry.grantedMs > 0);
  }

  function claim(characterID, { achievement = "", category = "", milestone = "" } = {}) {
    if (!enabled()) return { status: "DISABLED" };
    const id = int(characterID);
    if (id <= 0) return { status: "NO_CHARACTER" };
    const achievementKey = uuidKey(achievement);
    const categoryKey = uuidKey(category);
    const milestoneKey = uuidKey(milestone);
    if (!UUID_HEX.test(achievementKey) && !UUID_HEX.test(categoryKey)) {
      return { status: "SOURCE_REQUIRED" };
    }
    const state = stateOf(id);
    const index = state.unclaimed.findIndex((entry) =>
      (achievementKey ? entry.achievement === achievementKey : true)
      && (categoryKey ? entry.category === categoryKey : true)
      && (milestoneKey ? entry.milestone === milestoneKey : true));
    if (index < 0) return { status: "NOT_FOUND" };
    // Pay first: a claim that removes the reward but fails to pay it would silently eat it.
    const skillPoints = declaredSkillPoints(state.unclaimed[index].achievement);
    const paid = pay(id, skillPoints);
    if (paid.status !== "OK") return paid;
    state.unclaimed.splice(index, 1);
    const written = persist(id, state);
    return written.status === "OK" ? { status: "CLAIMED", skillPoints } : written;
  }

  // The showcase score is the sum of the category scores the character really has.
  function score(characterID) {
    const id = int(characterID);
    if (!enabled() || id <= 0) return 0;
    return Object.values(stateOf(id).categories)
      .reduce((total, row) => total + Math.max(0, int(row.score)), 0);
  }

  return Object.freeze({
    enabled,
    get,
    addProgress,
    complete,
    reset,
    clear,
    category,
    unclaimed,
    claim,
    score,
  });
}

let singleton = null;
function shared() {
  if (!singleton) {
    singleton = createAchievements();
  }
  return singleton;
}

module.exports = {
  STATE_KEY,
  createAchievements,
  emptyState,
  normalizeState,
  shared,
  uuidKey,
};
