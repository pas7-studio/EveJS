"use strict";
// Military progression for a faction pilot.
//
// Owner model (2026-10-27): the roster starts fixed, and from there a pilot earns
// merit ONLY through real results - a confirmed kill, an objective taken or held,
// a supply run delivered, surviving a battle. Enough merit means promotion, a
// higher rank means a bigger hull and a bigger command. Failure costs position,
// not just points.
const RANKS = Object.freeze([
  { rank: "recruit", merit: 0, hullClassID: "frigate", command: 1 },
  { rank: "pilot", merit: 25, hullClassID: "destroyer", command: 2 },
  { rank: "wingman", merit: 70, hullClassID: "cruiser", command: 3 },
  { rank: "squad-lead", merit: 150, hullClassID: "battlecruiser", command: 5 },
  { rank: "wing-lead", merit: 300, hullClassID: "battleship", command: 8 },
  { rank: "front-commander", merit: 600, hullClassID: "battleship", command: 14 },
  { rank: "admiral", merit: 1200, hullClassID: "capital", command: 25 },
]);

// Merit is paid for evidence, never for time served.
const MERIT = Object.freeze({
  // A confirmed native warship kill is the one result that can promote a recruit
  // in a single real battle: the attacker proof is the upstream destruction
  // caller's own attackerEntity, the wreck is physical and the loot is stored.
  "warship-kill": 25,
  "kill-confirmed": 3,
  "objective-captured": 12,
  "objective-defended": 9,
  "supply-delivered": 4,
  "survived-battle": 1,
  "force-lost": -10,
  "objective-lost": -6,
});

const num = (value) => Number(value) || 0;
const clampMerit = (value) => Math.max(0, Math.round(num(value)));

function rankForMerit(merit) {
  const total = clampMerit(merit);
  let current = RANKS[0];
  for (const entry of RANKS) if (total >= entry.merit) current = entry;
  return current;
}

function emptyRecord({ pilotID = 0 } = {}) {
  return { pilotID: num(pilotID), merit: 0, rank: RANKS[0].rank, history: [] };
}

function meritForEvent(kind, count = 1) {
  const key = String(kind || "");
  if (!Object.prototype.hasOwnProperty.call(MERIT, key)) return { status: "UNKNOWN_EVENT", kind: key, merit: 0 };
  const times = Math.max(1, Math.trunc(num(count) || 1));
  return { status: "MERIT", kind: key, count: times, merit: MERIT[key] * times };
}

// Applies one evidenced event to a record. A promotion happens only when the
// merit really crossed the next threshold; a loss can drop the rank back.
function applyEvent(record, kind, options = {}) {
  const base = record && typeof record === "object" ? record : emptyRecord({ pilotID: options.pilotID });
  const payout = meritForEvent(kind, options.count);
  if (payout.status !== "MERIT") return { status: "UNKNOWN_EVENT", kind: String(kind || ""), record: base };
  const before = clampMerit(base.merit);
  const after = clampMerit(before + payout.merit);
  const rankBefore = rankForMerit(before);
  const rankAfter = rankForMerit(after);
  const history = (Array.isArray(base.history) ? base.history.slice() : []).concat([{
    at: num(options.nowMs) > 0 ? num(options.nowMs) : Date.now(),
    kind: payout.kind,
    count: payout.count,
    merit: payout.merit,
    meritAfter: after,
  }]);
  if (history.length > 500) history.splice(0, history.length - 500);
  return {
    status: rankAfter.rank !== rankBefore.rank ? (rankAfter.merit > rankBefore.merit ? "PROMOTED" : "DEMOTED") : "UPDATED",
    from: rankBefore.rank,
    to: rankAfter.rank,
    merit: after,
    hullClassID: rankAfter.hullClassID,
    command: rankAfter.command,
    record: Object.assign({}, base, { merit: after, rank: rankAfter.rank, history }),
  };
}

// What a pilot may fly and command right now. The treasury still has the final
// say on whether the hull can actually be equipped.
function capabilitiesFor(record) {
  const rank = rankForMerit(record && record.merit);
  return { rank: rank.rank, hullClassID: rank.hullClassID, command: rank.command, merit: clampMerit(record && record.merit) };
}

const RANK_BY_NAME = Object.freeze(Object.fromEntries(RANKS.map((entry) => [entry.rank, entry])));

// How many ships one pilot may command: recruit 1, squad-lead 5, admiral 25.
// A record that does not exist yet is a recruit, never a silent promotion.
function commandCapFor(record) {
  return rankForMerit(record && record.merit).command;
}

// One side of a campaign is commanded by its highest-ranked assigned pilot. With
// nobody assigned yet the first ship IS the commander, so the cap starts at a
// recruit's 1 and only grows when somebody really earned the rank.
function sideCommandCap({ pilotIDs = [], records = {} } = {}) {
  const ids = Array.isArray(pilotIDs) ? pilotIDs : [];
  const table = records && typeof records === "object" ? records : {};
  let cap = RANKS[0].command;
  for (const id of ids) {
    const record = table[String(id)] || table[id];
    if (record) cap = Math.max(cap, commandCapFor(record));
  }
  return Math.min(25, cap);
}

module.exports = {
  RANKS, MERIT, RANK_BY_NAME, rankForMerit, emptyRecord, meritForEvent, applyEvent,
  capabilitiesFor, commandCapFor, sideCommandCap,
};
