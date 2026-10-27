"use strict";
// FW-024: an enlisted character is a real participant in the faction war.
//
// The war combat authority deliberately requires BOTH sides of an engagement to
// be registered native NPC hulls, so before this module a player could never be
// part of a battle: an enemy patrol had no legal reason to fire at him and a
// kill he made was rejected as PLAYER_SHIP_EXCLUDED.
//
// This module supplies the ONE missing fact that makes a player a legal war
// participant: an ACTIVE enlistment record, written by the stock militia agent,
// in the faction opposing a registered war ship, inside a campaign whose state
// is ASSAULT. Nothing here spawns, moves, damages, pays or rewrites anything.
// It is a read-only policy plus one durable merit award on a strictly proven
// native kill.
const fs = require("node:fs");
const path = require("node:path");
const sibling = (name) => require("./" + name + (__filename.endsWith(".js") ? "" : ".cjs"));
const { readRow } = sibling("coopNativeRowPath");
const war = sibling("coopFactionWarStore");
const fleet = sibling("coopWarFleetRegistry");
const warCore = sibling("coopFactionWarCore");
const fleetCore = sibling("coopWarFleetRegistry");
const pos = (x) => Number.isSafeInteger(Number(x)) && Number(x) > 0 ? Number(x) : 0;

function combatEnabled(env = process.env) {
  return env.EVEJS_COOP_FACTION_WAR === "1" &&
    env.EVEJS_COOP_FACTION_WAR_FLEETS === "1" &&
    env.EVEJS_COOP_FACTION_WAR_COMBAT === "1" &&
    (env.EVEJS_COOP_NPC_ORDER_ARBITER === "1" || env.EVEJS_COOP_ALIFE === "1");
}

function activeEnlistment(state, characterID) {
  const id = pos(characterID);
  if (!id || !state?.enlistments) return null;
  const row = state.enlistments[String(id)];
  if (!row || row.status !== "ACTIVE" || Number(row.characterID) !== id || !pos(row.factionID)) return null;
  return row;
}

// The single verdict: may a registered war ship treat this character as an
// enemy? Only a real ACTIVE enlistment in the opposing side of an ACTIVE war,
// inside a campaign that is really in ASSAULT, in the ship's own system.
function verdictFor({ warState, fleetState, npcEntityID, npcCorporationID = 0,
  npcFactionID = 0, systemID = 0, characterID = 0 } = {}) {
  const entityID = pos(npcEntityID);
  if (!entityID) return { status: "NOT_WAR_SHIP", reason: "INVALID_ENTITY" };
  const ship = fleetState?.ships?.[String(entityID)];
  if (!ship || Number(ship.entityID) !== entityID) return { status: "NOT_WAR_SHIP" };
  const shipSystem = pos(ship.systemID);
  if (!shipSystem || (pos(systemID) && pos(systemID) !== shipSystem))
    return { status: "NOT_WAR_SHIP", reason: "OTHER_SYSTEM" };
  if (pos(npcCorporationID) && Number(ship.corporationID) !== pos(npcCorporationID))
    return { status: "BLOCKED", reason: "WAR_SHIP_CORPORATION_MISMATCH" };
  if (pos(npcFactionID) && Number(ship.factionID) !== pos(npcFactionID))
    return { status: "BLOCKED", reason: "WAR_SHIP_FACTION_MISMATCH" };
  const declared = warState?.wars?.[String(ship.warID)];
  if (!declared || declared.state !== "ACTIVE") return { status: "NO_ACTIVE_WAR" };
  const campaign = warState?.campaigns?.[String(ship.campaignID)];
  if (!campaign || campaign.state !== "ASSAULT" ||
    Number(campaign.targetSystemID) !== shipSystem || campaign.warID !== ship.warID)
    return { status: "NO_ACTIVE_ASSAULT" };
  const own = pos(ship.factionID);
  const enemy = declared.attackerFactionID === own ? pos(declared.defenderFactionID)
    : declared.defenderFactionID === own ? pos(declared.attackerFactionID) : 0;
  if (!own || !enemy) return { status: "BLOCKED", reason: "WAR_SIDE_UNKNOWN" };
  const enlistment = activeEnlistment(warState, characterID);
  if (!enlistment) return { status: "NOT_ENLISTED" };
  if (enlistment.factionID === own) return { status: "ALLY", factionID: own };
  if (enlistment.factionID !== enemy) return { status: "NOT_INVOLVED" };
  return {
    status: "ENEMY_MILITIA",
    characterID: pos(characterID),
    factionID: enemy,
    npcFactionID: own,
    npcEntityID: entityID,
    systemID: shipSystem,
    warID: String(ship.warID),
    campaignID: String(ship.campaignID),
  };
}

function createMilitiaWarPlayer({ snapshots = null, getController, getNativeEntity,
  getFactionForCorporation, env = process.env, clock = () => Date.now() } = {}) {
  if ((snapshots !== null && typeof snapshots !== "function") ||
    typeof getController !== "function" ||
    typeof getNativeEntity !== "function" || typeof getFactionForCorporation !== "function")
    throw Error("MILITIA_WAR_NATIVE_AUTHORITIES_REQUIRED");

  function state() {
    try {
      if (typeof snapshots === "function") {
        const injected = snapshots();
        return injected && injected.warState && injected.fleetState ? injected : null;
      }
      const gameStore = require("../gameStore");
      const a = readRow(gameStore, war.TABLE, war.KEY);
      const b = readRow(gameStore, fleet.TABLE, fleet.KEY);
      if (!a || !b) return null;
      warCore.validateState(a);
      fleetCore.validate(b);
      return { warState: a, fleetState: b };
    } catch { return null; }
  }

  // Hot path used by the native combat policy for an NPC -> player candidate.
  function npcPlayerVerdict(npcEntity, playerEntity) {
    if (!combatEnabled(env)) return { status: "DISABLED" };
    const characterID = pos(playerEntity?.session?.characterID);
    const npcID = pos(npcEntity?.itemID);
    if (!characterID || !npcID || npcEntity?.kind !== "ship" || playerEntity?.kind !== "ship")
      return { status: "NOT_PLAYER_TARGET" };
    if (npcID === pos(playerEntity?.itemID)) return { status: "NOT_PLAYER_TARGET" };
    const controller = getController(npcID);
    const native = getNativeEntity(npcID);
    if (!controller || Number(controller.entityID) !== npcID || !native ||
      Number(native.entityID) !== npcID) return { status: "NOT_WAR_SHIP" };
    let faction = 0;
    try { faction = pos(getFactionForCorporation(Number(native.corporationID))); } catch { faction = 0; }
    if (!faction) return { status: "NOT_WAR_SHIP", reason: "SDE_FACTION_UNAVAILABLE" };
    const snapshot = state();
    if (!snapshot) return { status: "BLOCKED", reason: "WAR_SNAPSHOT_UNAVAILABLE" };
    return verdictFor({
      warState: snapshot.warState,
      fleetState: snapshot.fleetState,
      npcEntityID: npcID,
      npcCorporationID: Number(native.corporationID),
      npcFactionID: faction,
      systemID: pos(controller.systemID),
      characterID,
    });
  }

  // Every live player this war ship may legally engage right now.
  function enemyPlayersForShip({ scene, shipRow } = {}) {
    if (!combatEnabled(env) || !scene?.sessions?.values || !pos(shipRow?.entityID)) return [];
    const snapshot = state();
    if (!snapshot) return [];
    const out = [];
    for (const session of scene.sessions.values()) {
      const entityID = pos(session?._space?.shipID);
      const characterID = pos(session?.characterID);
      if (!entityID || !characterID) continue;
      const entity = scene.getEntityByID ? scene.getEntityByID(entityID) : null;
      if (!entity || entity.kind !== "ship") continue;
      const verdict = verdictFor({
        warState: snapshot.warState,
        fleetState: snapshot.fleetState,
        npcEntityID: Number(shipRow.entityID),
        npcCorporationID: Number(shipRow.corporationID),
        npcFactionID: Number(shipRow.factionID),
        systemID: pos(shipRow.systemID),
        characterID,
      });
      if (verdict.status === "ENEMY_MILITIA")
        out.push({ characterID, entityID, entity, verdict });
    }
    return out;
  }

  // A player kill is only a war kill when the native destruction caller names
  // the player hull, the victim is a registered war ship of the opposing side,
  // the physical wreck exists, and the enlistment is ACTIVE for that side.
  function playerKillProof({ scene, victim, options = {}, wreck } = {}) {
    const systemID = pos(scene?.systemID);
    const victimID = pos(victim?.itemID);
    const wreckID = pos(wreck?.wreckID);
    const attacker = options?.attackerEntity;
    const attackerID = pos(attacker?.itemID);
    const characterID = pos(attacker?.session?.characterID);
    if (!systemID || !victimID || !wreckID || !attackerID || !characterID)
      return { status: "NOT_PLAYER_KILL" };
    if (victim?.nativeNpc !== true || victim?.kind !== "ship" ||
      Number(wreck.systemID) !== systemID || Number(wreck.sourceEntityID) !== victimID ||
      Number(wreck.launcherID) !== victimID)
      return { status: "INVALID_NATIVE_DESTRUCTION" };
    const physical = scene.getEntityByID ? scene.getEntityByID(wreckID) : null;
    if (physical?.nativeNpcWreck !== true || Number(physical.itemID) !== wreckID ||
      Number(physical.launcherID) !== victimID)
      return { status: "PHYSICAL_WRECK_MISSING" };
    const attackerInScene = scene.getEntityByID ? scene.getEntityByID(attackerID) : null;
    if (attackerInScene !== attacker) return { status: "UPSTREAM_ATTACKER_NOT_PROVIDED" };
    const snapshot = state();
    if (!snapshot) return { status: "BLOCKED", reason: "WAR_SNAPSHOT_UNAVAILABLE" };
    const verdict = verdictFor({
      warState: snapshot.warState,
      fleetState: snapshot.fleetState,
      npcEntityID: victimID,
      npcCorporationID: Number(victim.corporationID),
      npcFactionID: 0,
      systemID,
      characterID,
    });
    if (verdict.status !== "ENEMY_MILITIA")
      return { status: "NOT_A_WAR_KILL", reason: verdict.status, characterID };
    return {
      status: "PLAYER_NATIVE_WAR_KILL_PROVIDED",
      systemID,
      characterID,
      attackerEntityID: attackerID,
      victimEntityID: victimID,
      wreckID,
      factionID: verdict.factionID,
      enemyFactionID: verdict.npcFactionID,
      warID: verdict.warID,
      campaignID: verdict.campaignID,
      attribution: "UPSTREAM_DESTRUCTION_OPTIONS_ATTACKER_ENTITY_PLUS_ACTIVE_ENLISTMENT",
      at: clock(),
    };
  }

  return Object.freeze({ npcPlayerVerdict, enemyPlayersForShip, playerKillProof, activeEnlistment: (id) => {
    const snapshot = state();
    return snapshot ? activeEnlistment(snapshot.warState, id) : null;
  } });
}

let singleton = null;
function native() {
  if (!singleton) singleton = createMilitiaWarPlayer({
    snapshots: null,
    getController: (id) => require("./npc/npcRegistry").getControllerByEntityID(id),
    getNativeEntity: (id) => require("./npc/nativeNpcStore").getNativeEntity(id),
    getFactionForCorporation: (id) => require("../services/faction/factionState").getFactionIDForCorporation(id),
  });
  return singleton;
}

// The native combat policy hook (npcBehaviorLoop.isFriendlyCombatTarget).
// true => this player is friendly to that NPC and must never be fired upon.
function npcPlayerVerdict(npcEntity, playerEntity) {
  if (process.env.EVEJS_COOP_FACTION_WAR_COMBAT !== "1") return { status: "DISABLED" };
  try { return native().npcPlayerVerdict(npcEntity, playerEntity); }
  catch (error) { return { status: "UNAVAILABLE", reason: String(error?.message || error).slice(0, 120) }; }
}

module.exports = {
  combatEnabled,
  activeEnlistment,
  verdictFor,
  createMilitiaWarPlayer,
  npcPlayerVerdict,
  native,
};
