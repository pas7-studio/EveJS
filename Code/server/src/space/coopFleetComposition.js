"use strict";
// What hulls a co-op mining fleet can actually afford.
//
// Two problems this replaces:
//  1. one query per fleet turned every role into the same hull (measured live: all
//     three durable "hauler" slots were Mining Ventures with a 50 m3 ore hold, so
//     the strict transfer could never take an 8 000-12 000 m3 stack);
//  2. a hull choice made once and forgotten. A corporation's fleet should follow
//     its wallet: a corp that has earned little flies T1 industrials, one that has
//     earned real ISK upgrades to T2 on the next reseed.
//
// Every pool and profile below is a real row (tools/DatabaseCreator/staticTables):
//   npc_mining_hauler_t1  bestower / badger / mammoth
//   npc_mining_hauler_t2  bustard / impel / mastodon / occator
//   ore_mining_venture / retriever / skiff / hulk  (miners; the only miner pool,
//   npc_mining_ops, mixes T1 and T2, so a tier needs a profile instead of a pool)
//
// Default OFF (EVEJS_COOP_FLEET_COMPOSITION); with it off query() returns "" and
// the pinned spawner keeps using its configured query exactly as before.

const FLAG = "EVEJS_COOP_FLEET_COMPOSITION";
const CORP_FLAG = "EVEJS_COOP_MINING_CORP_ID";
const DEFAULT_CORP_ID = 1000129; // ORE: the corporation that owns the mining NPCs

const HULLS = Object.freeze({
  miner: Object.freeze({
    t1: Object.freeze(["ore_mining_venture", "ore_mining_retriever"]),
    t2: Object.freeze(["ore_mining_skiff", "ore_mining_hulk"]),
  }),
  hauler: Object.freeze({
    t1: Object.freeze(["ore_mining_bestower_hauler", "ore_mining_badger_hauler", "ore_mining_mammoth_hauler"]),
    t2: Object.freeze(["ore_mining_bustard_hauler", "ore_mining_impel_hauler", "ore_mining_mastodon_hauler", "ore_mining_occator_hauler"]),
  }),
});

// A hull tier is a budget, not a wish: T2 industrial hulls cost hundreds of
// millions, so a corporation below that flies T1 and says so.
const TIERS = Object.freeze([
  Object.freeze({id: "t2", minBudgetISK: 250_000_000}),
  Object.freeze({id: "t1", minBudgetISK: 0}),
]);

// A hull's class is a property of the profile, not of the slot it sits in. The live
// failure was a mining hull holding the hauler role, so the role must be checked
// against the real profile before a fleet is declared healthy.
const HAULER_PROFILE = /_hauler$/;
const MINER_PROFILE = /^ore_mining_/;

function classify(profileID) {
  const id = String(profileID || "");
  if (HAULER_PROFILE.test(id)) return "hauler";
  if (MINER_PROFILE.test(id)) return "miner";
  return "unknown";
}

const isHaulerHull = (profileID) => classify(profileID) === "hauler";
const isMinerHull = (profileID) => classify(profileID) === "miner";

const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const clampRoll = (roll) => {
  const value = Number(roll);
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.999999, Math.max(0, value));
};

function tierFor(budgetISK) {
  const budget = Number(budgetISK) || 0;
  return (TIERS.find((tier) => budget >= tier.minBudgetISK) || TIERS[TIERS.length - 1]).id;
}

function pickHull(role, tier, roll) {
  const list = HULLS[role] && HULLS[role][tier];
  if (!Array.isArray(list) || list.length === 0) return null;
  const index = Math.min(list.length - 1, Math.floor(clampRoll(roll) * list.length));
  return list[index];
}

// The fleet's budget is the corporation's own wallet, not a per-pilot ledger: hulls
// belong to the corp, so a corp with no ISK cannot fly T2 ships no matter how many
// of its pilots are busy.
function readCorpWallet({gameStore, corporationID} = {}) {
  try {
    const store = gameStore || require("../gameStore");
    const read = store && typeof store.read === "function" ? store.read.bind(store) : null;
    if (!read) return {status: "STORE_UNAVAILABLE", budgetISK: 0};
    const pointer = "/corporations/" + String(corporationID) + "/wallet";
    const record = read("corporationRuntime", pointer);
    if (!record || record.success === false || !record.data) return {status: "WALLET_UNAVAILABLE", budgetISK: 0};
    const divisions = record.data.divisions && typeof record.data.divisions === "object"
      ? record.data.divisions : {};
    const budgetISK = Object.keys(divisions)
      .reduce((sum, key) => sum + (Number(divisions[key] && divisions[key].balance) || 0), 0);
    return {status: "OK", budgetISK};
  } catch (_error) {
    return {status: "WALLET_UNREADABLE", budgetISK: 0};
  }
}

function createComposition({readWallet, roll} = {}) {
  const wallet = typeof readWallet === "function" ? readWallet : readCorpWallet;
  const rollFor = typeof roll === "function" ? roll : Math.random;
  function plan(role, {tier, rollValue} = {}) {
    const chosenTier = tier || "t1";
    const hull = pickHull(role, chosenTier, rollValue === undefined ? rollFor() : rollValue);
    return {role, tier: chosenTier, hull, query: hull};
  }
  return Object.freeze({plan, tierFor, pickHull});
}

const defaultComposition = createComposition();

// Called from the pinned fleet spawn. "" means "not my decision": the caller keeps
// its configured query, which is exactly the pre-existing behaviour.
function query(role, {env = process.env, gameStore, roll} = {}) {
  if (String(env[FLAG] || "") !== "1") return "";
  if (role !== "miner" && role !== "hauler") return "";
  const corporationID = positive(env[CORP_FLAG]) ? Number(env[CORP_FLAG]) : DEFAULT_CORP_ID;
  const wallet = readCorpWallet({gameStore, corporationID});
  const tier = tierFor(wallet.budgetISK);
  return defaultComposition.plan(role, {tier, rollValue: typeof roll === "function" ? roll() : undefined}).query || "";
}

module.exports = {
  FLAG,
  CORP_FLAG,
  DEFAULT_CORP_ID,
  HULLS,
  TIERS,
  HAULER_PROFILE,
  MINER_PROFILE,
  classify,
  isHaulerHull,
  isMinerHull,
  tierFor,
  pickHull,
  readCorpWallet,
  createComposition,
  query,
};
