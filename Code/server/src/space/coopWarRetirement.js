"use strict";
// FW-140: a war nobody can fight must stop being called a war.
//
// MEASURED 2026-10-31T17:40Z with the navy capability itself: factions 500014 (ORE) and
// 500019 (Sansha's Nation) have NO_NAVY - every loadout they carry is a mining hull - so
// `war:500004-500014` and `war:500014-500019` answered NO_NAVY_CAPABILITY:ATTACKER on every
// tick and produced nothing but EXPIRED campaigns (six of them for 30002642, from 07:48Z).
// The world still reported "7 wars ACTIVE" while only five could ever fight.
//
// This retires such a war through the war core's own END_WAR transition, and only when the
// navy authority says the SAME thing inside the proof. It never ends a war that has a live
// or captured campaign: a war that fights stays.
const suffix = typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs";
const warStore = require("./coopFactionWarStore" + suffix);
const core = require("./coopFactionWarCore" + suffix);
const key = (x) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x);
const LIVE = ["PREPARING", "ASSAULT", "OCCUPIED"];

function createWarRetirement({ gameStore, navyCapability, clock = () => Date.now(), env = process.env } = {}) {
  if (typeof gameStore?.coopAtomicNativeRows?.transact !== "function" ||
    typeof navyCapability !== "function" || typeof clock !== "function") {
    throw Error("WAR_RETIREMENT_AUTHORITIES_REQUIRED");
  }
  const enabled = () => env.EVEJS_COOP_FACTION_WAR === "1" &&
    env.EVEJS_COOP_FACTION_WAR_FLEETS === "1" &&
    env.EVEJS_COOP_NATIVE_ATOMIC_ROWS === "1";
  const transact = (fn) => gameStore.coopAtomicNativeRows.transact([warStore.TABLE], fn);

  function decision(war) {
    try {
      const navy = navyCapability({ attackerFactionID: Number(war.attackerFactionID),
        defenderFactionID: Number(war.defenderFactionID) });
      if (!navy || navy.open === true) return null;
      return String(navy.reason || "NO_NAVY_CAPABILITY:UNKNOWN");
    } catch (_error) { return null; }
  }

  function tick() {
    if (!enabled()) return { status: "DISABLED", ended: [], skips: [] };
    const now = clock();
    if (!Number.isSafeInteger(now) || now <= 0) return { status: "CLOCK_UNSAFE", ended: [], skips: [] };
    try {
      return transact((tx) => {
        const state = tx.get(warStore.TABLE, warStore.KEY);
        if (!state || state.version !== 1) return { status: "WAR_STATE_UNAVAILABLE", ended: [], skips: [] };
        core.validateState(state);
        const ended = [], skips = [];
        // MEASURED 17:54:21Z: two wars were retired in one tick and only the SECOND one stayed
        // ENDED, because every transition cloned the state read at the start of the tick and
        // the later put overwrote the earlier retirement. The working state now advances with
        // each applied transition, so two retirements in one tick cannot erase each other.
        let current = state;
        for (const warID of Object.keys(state.wars || {})) {
          const war = (current.wars || {})[warID];
          if (!war || war.state !== "ACTIVE") continue;
          const campaigns = Object.values(current.campaigns || {}).filter((c) => c && c.warID === war.warID);
          const live = campaigns.filter((c) => LIVE.includes(String(c.state)));
          if (live.length) { skips.push({ warID: war.warID, reason: "WAR_IS_FIGHTING" }); continue; }
          const reason = decision(war);
          if (!reason) { skips.push({ warID: war.warID, reason: "BOTH_SIDES_CAN_FIELD_NAVY" }); continue; }
          const proofID = "no-navy:" + war.warID + ":" + String(war.attackerFactionID) + ":" +
            String(war.defenderFactionID);
          if (!key(proofID)) { skips.push({ warID: war.warID, reason: "PROOF_ID_INVALID" }); continue; }
          const result = core.transition(current, {
            type: "END_WAR",
            eventID: "fwr-retire:" + war.warID,
            warID: war.warID,
            proofID,
            reason,
          }, {
            now,
            // The proof is the capability itself, re-measured inside the transition: a war
            // may only be retired while the navy authority still says it cannot be fought.
            proofs: {
              ceasefire: ({ war: candidate, proofID: p }) =>
                p === proofID && candidate.warID === war.warID &&
                decision(candidate) === reason,
            },
          });
          if (result.status !== "APPLIED") {
            skips.push({ warID: war.warID, reason: "RETIREMENT_REJECTED", core: String(result.reason || result.status) });
            continue;
          }
          tx.put(warStore.TABLE, warStore.KEY, result.state);
          current = result.state;
          ended.push({ warID: war.warID, attackerFactionID: Number(war.attackerFactionID),
            defenderFactionID: Number(war.defenderFactionID), reason,
            cancelledCampaigns: campaigns.length, receipt: result.receipt });
        }
        return { status: ended.length ? "RETIRED" : "NO_CHANGE", ended, skips };
      });
    } catch (error) {
      return { status: "BLOCKED", reason: String(error?.message || error).slice(0, 120), ended: [], skips: [] };
    }
  }

  return Object.freeze({ tick });
}

module.exports = { createWarRetirement };
