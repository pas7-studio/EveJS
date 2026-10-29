"use strict";
// FW-009B: the one bridge from a strictly proven native kill to a real career
// consequence (merit -> rank -> command size).
//
// The evidence is the upstream destruction caller's own `options.attackerEntity`
// as verified by `coopNpcDestructionAttacker` (status
// NATIVE_DESTRUCTION_ATTACKER_PROVIDED): a physical wreck, a named native victim
// and a named native attacker in the same system. Correlation, a controller
// target or a recent weapon event is never accepted as a killer.
//
// Nothing is spawned, moved or repaired here, and the payout is refused when the
// evidence is not strict or the war merit feature is off.
// FW-057: a player pilot is a real war participant too (coopMilitiaWarPlayer names
// it coop-player-<characterID>); the shared predicate accepts both, and nothing else.
const { isWarPilotID } = require("./coopWarPilotID" + (typeof __filename === "string" && __filename.endsWith(".js") ? "" : ".cjs"));
const pilotOf = (value) => (isWarPilotID(value) ? value : "");
const pos = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

let ledger = null;
// FW-005C: the war chest payer is installed by the live runtime. Without it a
// kill still earns merit, but no ISK moves (there is nothing to pay from).
let bountyPayer = null;
function setBountyPayer(payer) {
  bountyPayer = typeof payer === "function" ? payer : null;
}
function ledgerInstance() {
  if (!ledger) {
    ledger = require("./coopWarMeritLedger" + (__filename.endsWith(".js") ? "" : ".cjs"))
      .createWarMeritLedger({ gameStore: require("../gameStore") });
  }
  return ledger;
}

function note({ proof, victim, emit, ledger: injected } = {}) {
  const p = proof && typeof proof === "object" ? proof : null;
  if (!p || p.status !== "NATIVE_DESTRUCTION_ATTACKER_PROVIDED") {
    return { status: "NO_STRICT_NATIVE_ATTACKER", reason: String(p && p.status || "MISSING_PROOF") };
  }
  const wreckID = Number(p.wreckID), attackerID = Number(p.attackerEntityID);
  const attackerPilotID = pilotOf(p.attackerPilotID), victimPilotID = pilotOf(p.victimPilotID);
  if (!pos(wreckID) || !pos(attackerID) || !attackerPilotID || !victimPilotID ||
    attackerPilotID === victimPilotID) {
    return { status: "BLOCKED", reason: "INVALID_KILL_IDENTITY" };
  }
  let store = null;
  try {
    store = injected && typeof injected.award === "function" ? injected : ledgerInstance();
  } catch (error) {
    return { status: "UNAVAILABLE", reason: String(error && error.message || error) };
  }
  const evidence = { wreckID, victimEntityID: Number(p.victimEntityID) || 0, attackerEntityID: attackerID };
  const awards = [];
  const kill = store.award({
    pilotID: attackerPilotID,
    kind: "warship-kill",
    evidenceKey: "wreck:" + wreckID,
    evidence,
  });
  awards.push(kill);
  const loss = store.award({
    pilotID: victimPilotID,
    kind: "force-lost",
    evidenceKey: "wreck:" + wreckID,
    evidence,
  });
  awards.push(loss);
  const record = (emit && typeof emit === "function") ? emit : null;
  if (record) {
    for (const award of awards) {
      record("living-native-war-merit", null, { spaceState: { systemID: Number(p.systemID) || 0 } }, {
        status: award.status,
        pilotID: award.pilotID,
        kind: award.kind,
        merit: Number(award.merit) || 0,
        meritDelta: Number(award.meritDelta) || 0,
        from: String(award.from || ""),
        to: String(award.to || ""),
        command: Number(award.command) || 0,
        hullClassID: String(award.hullClassID || ""),
        wreckID,
        attackerEntityID: attackerID,
        victimEntityID: evidence.victimEntityID,
        evidence: "UPSTREAM_ATTACKER_ENTITY_PLUS_PHYSICAL_NATIVE_WRECK",
      });
    }
  }
  const killer = awards[0];
  // FW-012A: a real promotion changes the pilot's title and nothing else.
  let rankTitle = null;
  if (killer.status === "PROMOTED") {
    try {
      const titles = require("./coopWarRankTitle" +
        (__filename.endsWith(".js") ? "" : ".cjs"))
        .createRankTitles({gameStore: require("../gameStore")});
      rankTitle = titles.apply({pilotID: attackerPilotID,
        record: {rank: killer.rank, merit: killer.merit}});
      // A player's title must be visible where the client shows it: the stock
      // character record. A refusal is reported, never invented.
      if (/^coop-player-[0-9]{3,}$/.test(attackerPilotID)) {
        const onCharacter = titles.applyToCharacter({pilotID: attackerPilotID,
          rank: rankTitle.rank || killer.rank, title: rankTitle.title});
        rankTitle = Object.assign({}, rankTitle, {character: onCharacter});
        if (record && ["APPLIED", "REFUSED", "FAILED"].includes(onCharacter.status)) {
          record("living-native-war-rank-title", null,
            {spaceState: {systemID: Number(p.systemID) || 0}}, {
              status: onCharacter.status,
              surface: onCharacter.surface || "CHARACTER_RECORD_TITLE",
              characterID: onCharacter.characterID || 0,
              pilotID: attackerPilotID, rank: onCharacter.rank || "",
              title: onCharacter.title || "",
              reason: onCharacter.reason || "",
              unlocks: [], evidence: "STOCK_CHARACTER_RECORD_TITLE_ONLY",
            });
        }
      }
      if (rankTitle.status === "CHANGED" && record) {
        record("living-native-war-rank-title", null,
          {spaceState: {systemID: Number(p.systemID) || 0}}, {
            status: rankTitle.status, pilotID: attackerPilotID,
            rank: rankTitle.rank, title: rankTitle.title,
            previousRank: rankTitle.previousRank,
            previousTitle: rankTitle.previousTitle,
            unlocks: [], evidence: "REAL_PROMOTION_TITLE_ONLY",
          });
      }
    } catch (error) {
      rankTitle = {status: "UNAVAILABLE",
        reason: String((error && error.message) || error).slice(0, 120)};
    }
  }
  // A real kill can release a real bounty, but only from a HELD escrow that the
  // killer's own faction funded. A refusal is reported, never papered over.
  let bounty = null;
  if (bountyPayer && killer.status !== "BLOCKED") {
    try {
      bounty = bountyPayer({pilotID: attackerPilotID, kind: "warship-kill",
        wreckID, proofID: "wreck:" + wreckID,
        // FW-078: the campaign is resolved from the victim's own mobilised hull.
        victimEntityID: Number(p.victimEntityID) || 0});
    } catch (error) {
      bounty = {status: "UNAVAILABLE",
        reason: String((error && error.message) || error).slice(0, 120)};
    }
  }
  // The same escrow also compensates the faction's own fallen pilot. Only the
  // faction that really owns a HELD reservation for this campaign can pay it,
  // and the payer proves that before any ISK moves.
  let deathBenefit = null;
  if (bountyPayer && awards[1] && awards[1].status !== "BLOCKED") {
    try {
      deathBenefit = bountyPayer({pilotID: victimPilotID, kind: "force-lost",
        wreckID, proofID: "wreck:" + wreckID,
        victimEntityID: Number(p.victimEntityID) || 0});
    } catch (error) {
      deathBenefit = {status: "UNAVAILABLE",
        reason: String((error && error.message) || error).slice(0, 120)};
    }
  }
  // FW-047: a refused bounty used to be SILENT. `coopWarBounty` only emits when
  // value really moves (PAID / ALREADY_PAID / ESCROW_RELEASED_NOT_CREDITED) and
  // this function dropped its return value, so the work stack showed a real kill
  // with merit PROMOTED, a real HELD escrow for the OTHER side, and not one line
  // saying why no ISK could move. Every outcome that is not a payment is now
  // recorded with its own reason, so a missing payout always names its cause.
  if (record) {
    const outcomes = [["warship-kill", attackerPilotID, bounty],
      ["force-lost", victimPilotID, deathBenefit]];
    for (const [kind, pilotID, outcome] of outcomes) {
      if (!outcome) continue;
      const status = String(outcome.status || "");
      if (status === "PAID" || status === "ALREADY_PAID") continue;
      record("living-native-war-bounty-skipped", null,
        { spaceState: { systemID: Number(p.systemID) || 0 } }, {
          status: status || "UNKNOWN",
          reason: String(outcome.reason || ""),
          pilotID: String(pilotID || ""),
          factionID: Number(outcome.factionID) || 0,
          campaignID: String(outcome.campaignID || ""),
          kind: String(outcome.kind || kind),
          wreckID,
          evidence: "REAL_KILL_WITHOUT_PAYABLE_ESCROW",
        });
    }
  }
  return {
    status: killer.status,
    attackerPilotID,
    victimPilotID,
    wreckID,
    awards,
    bounty,
    deathBenefit,
    rankTitle,
    promoted: killer.promoted === true,
    rank: String(killer.rank || ""),
    merit: Number(killer.merit) || 0,
  };
}

module.exports = { note, setBountyPayer };
