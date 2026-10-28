"use strict";
// Admin bridge: lets the local MCP server act on a *live or offline* character
// from inside the server process, where the real session and space runtime live.
//
// Why it exists: a tool that shells into the container is a separate Node
// process with its own empty session registry, so it cannot see the player. The
// only honest way to act on a player is from inside the server, so the tool
// drops a request file on the data volume and this module executes it.
//
// Actions are whitelisted and each one uses native primitives:
//   chat_command  - one slash/GM command as the character's live session
//   give_item     - grant an item (a ship hull included) to the station hangar,
//                   works without a session: the data layer is authoritative
//   remove_item   - delete an item the character really owns (never the active hull)
//   board_ship    - make an owned ship the active hull, works without a session
//
// Every action emits a coop-events.jsonl line with an explicit status, so a
// runtime decision is never only in a chat log.

// Pure helpers live in space/coopAdminBridgeActions.js (split by scripts/coop-split-module.cjs).
const { fs, siblingSuffix, REQUESTS, RESULTS, EVENTS, ALLOWED_ACTIONS, MAX_REQUESTS_PER_DRAIN, readJsonLines, writeJsonLines, appendJsonLine, emitEvent, readRow, liveSessionFor, executeChatCommand, giveItem, removeItem, boardShip, moveItem, fitShip, fitSlots, deployStructure, resolveWarPatrolLoadout, spawnNativeNpc, militiaEnlist, warFleetAuthorities, freeHullLinks, listFreeHullsFor, spawnWarFleet, warFleetState, fleetReconstitute, releaseIdentity, assignIdentity } = require("./coopAdminBridgeActions");
let stationIndex = null;
function stationRecord(stationID) {
  const id = Number(stationID) || 0;
  if (!(id > 0)) return null;
  if (!stationIndex) {
    stationIndex = new Map();
    try {
      const read = require("../gameStore").read("stations");
      const data = read && read.data !== undefined ? read.data : read;
      const walk = (value, depth) => {
        if (!value || depth > 6 || stationIndex.size > 20000) return;
        if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); return; }
        if (typeof value !== "object") return;
        const sid = Number(value.stationID);
        if (sid > 0) { stationIndex.set(sid, value); return; }
        for (const child of Object.values(value)) walk(child, depth + 1);
      };
      walk(data, 0);
    } catch (_error) { stationIndex = new Map(); }
  }
  return stationIndex.get(id) || null;
}
function militiaState(request) {
  const characterID = Number(request.characterID) || 0;
  if (!(characterID > 0)) return { ok: false, error: "characterID is required" };
  try {
    const characters = require("../services/character/characterState");
    const factions = require("../services/faction/factionState");
    const record = characters.getCharacterRecord(characterID);
    if (!record) return { ok: false, error: "character not found" };
    const factionID = Number(record.factionID) || 0;
    const faction = factionID ? factions.getFactionRecord(factionID) : null;
    const warStore = require("./coopFactionWarStore" + siblingSuffix);
    const { readRow } = require("./coopNativeRowPath" + siblingSuffix);
    let warState = null;
    try { warState = readRow(require("../gameStore"), warStore.TABLE, warStore.KEY); } catch (_error) { warState = null; }
    const data = require("./coopMilitiaWarData" + siblingSuffix);
    const situation = data.militiaSituation({ characterID, character: record, faction, warState });
    const enlistment = warState && warState.enlistments
      ? warState.enlistments[String(characterID)] || null : null;
    let merit = null;
    try {
      const ledger = require("./coopWarMeritLedger" + siblingSuffix)
        .createWarMeritLedger({ gameStore: require("../gameStore") });
      merit = ledger.read().records["coop-player-" + characterID] || null;
    } catch (_error) { merit = null; }
    // "Where do I enlist?" must be answerable without a human: resolve the real
    // militia agent and its real station instead of leaving the player guessing.
    let enlistHint = null;
    try {
      const agentAuthority = require("../services/agent/agentAuthority");
      const militiaCorp = Number(faction && faction.militiaCorporationID) || 0;
      const agents = militiaCorp && typeof agentAuthority.listAgentsByCorporationID === "function"
        ? agentAuthority.listAgentsByCorporationID(militiaCorp) : [];
      // Every real militia station, so the answer lists the actual venues instead
      // of sending the player to one arbitrary one (Jita has no militia agent).
      const stations = new Map();
      for (const agent of Array.isArray(agents) ? agents : []) {
        const stationID = Number(agent && agent.stationID) || 0;
        if (!(stationID > 0) || stations.has(stationID)) continue;
        const record_ = stationRecord(stationID);
        if (record_) stations.set(stationID, record_);
      }
      enlistHint = require("./coopMilitiaEnlistHint" + siblingSuffix)
        .buildEnlistHint({ record, faction, agents, stations });
    } catch (_error) { enlistHint = null; }
    return {
      ok: true, characterID,
      character: {
        name: String(record.characterName || ""), raceID: Number(record.raceID) || 0,
        bloodlineID: Number(record.bloodlineID) || 0,
        corporationID: Number(record.corporationID) || 0,
        factionID, stationID: Number(record.stationID) || 0,
        solarSystemID: Number(record.solarSystemID) || 0,
      },
      faction: faction ? { factionID: faction.factionID, name: String(faction.name || ""),
        militiaCorporationID: Number(faction.militiaCorporationID) || 0 } : null,
      situation, enlistment, merit, enlistHint,
      warCounts: warState ? {
        wars: Object.keys(warState.wars || {}).length,
        campaigns: Object.keys(warState.campaigns || {}).length,
        enlistments: Object.keys(warState.enlistments || {}).length,
      } : null,
    };
  } catch (error) {
    return { ok: false, error: "militia state failed: " + String(error && error.message || error) };
  }
}

// FW-024: prove the stock militia-agent enlistment end to end without a client.
// The character must be REALLY docked at the agent's own station (character
// record), and the write goes through the same coopFactionWarAgent.doAction the
// client calls. The session used is an explicit server-side in-process session,
// NOT a client login, and the result says so.
function executeRequest(request) {
  if (!request || typeof request !== "object") return { ok: false, error: "empty request" };
  const action = String(request.action || "");
  if (!ALLOWED_ACTIONS.has(action)) return { ok: false, error: "action not allowed: " + action };
  // A structure belongs to a corporation, not to a character, so this action is
  // the one admin request that legitimately has no characterID.
  if (action === "deploy_structure") return deployStructure(request);
  if (action === "spawn_native_npc") return spawnNativeNpc(request);
  if (action === "spawn_war_fleet") return spawnWarFleet(request);
  if (action === "war_fleet_state") return warFleetState(request);
  if (action === "fleet_reconstitute") return fleetReconstitute(request);
  if (action === "release_identity") return releaseIdentity(request);
  if (action === "assign_identity") return assignIdentity(request);
  // Read-only war diagnostics: never reserves, orders or writes anything.
  if (action === "inspect_npc") {
    // Read-only: what a native hull really carries right now.
    const entityID = Number(request.entityID) || 0;
    if (!(entityID > 0)) return { ok: false, error: "entityID is required" };
    try {
      const store = require("./npc/nativeNpcStore");
      const native = store.getNativeEntity(entityID);
      const modules = store.listNativeModulesForEntity(entityID) || [];
      const cargo = store.listNativeCargoForEntity(entityID) || [];
      return {
        ok: true,
        entityID,
        native: native ? {
          systemID: Number(native.systemID) || 0,
          corporationID: Number(native.corporationID) || 0,
          ownerID: Number(native.ownerID) || 0,
          transient: native.transient === true,
        } : null,
        modules: modules.slice(0, 16).map((m) => ({
          moduleID: Number(m.moduleID) || 0,
          categoryID: Number(m.categoryID) || 0,
          typeID: Number(m.typeID) || 0,
          flagID: Number(m.flagID) || 0,
          online: Boolean(m.moduleState && m.moduleState.online),
        })),
        moduleCount: modules.length,
        cargo: cargo.slice(0, 16).map((c) => ({
          cargoID: Number(c.cargoID) || 0,
          categoryID: Number(c.categoryID) || 0,
          typeID: Number(c.typeID) || 0,
          quantity: Number(c.quantity) || 0,
          moduleID: Number(c.moduleID) || 0,
          transient: c.transient === true,
          // Provenance of recovered wreck cargo: the custody writer stamps these,
          // so "the loot really came from a wreck" is a field, not an assumption.
          groupID: Number(c.groupID) || 0,
          sourceWreckID: Number(c.sourceWreckID) || 0,
          sourceWreckItemID: Number(c.sourceWreckItemID) || 0,
        })),
        cargoCount: cargo.length,
      };
    } catch (error) {
      return { ok: false, error: "inspect failed: " + String(error && error.message || error) };
    }
  }
  // Read-only: the raid director's own view of a system - every linked pirate,
  // why it is excluded (loot delivery / ammo supply), its native controller
  // state, its own gun range and the distance to its nearest real prey. Never
  // issues, releases or retains an order.
  if (action === "raid_diagnose") {
    const systemID = Number(request.systemID) || 0;
    if (!(systemID > 0)) return { ok: false, error: "systemID is required" };
    try {
      return Object.assign({ ok: true },
        require("./coopVirtualWorldRuntime" + siblingSuffix).diagnoseNativeRaids({ systemID }));
    } catch (error) {
      return { ok: false, error: "raid diagnose failed: " + String(error && error.message || error) };
    }
  }
  // Read-only: why two native hulls do or do not engage. Never orders, never
  // moves, never writes - positions, distance, controller order and the exact
  // native hostility verdict, so "no fire" is a measurement instead of a guess.
  if (action === "npc_pair_diagnose") {
    const attackerID = Number(request.attackerID) || 0;
    const targetID = Number(request.targetID) || 0;
    if (!(attackerID > 0) || !(targetID > 0))
      return { ok: false, error: "attackerID and targetID are required" };
    try {
      const runtime = require("./runtime");
      const store = require("./npc/nativeNpcStore");
      const controllers = require("./npc/npcRegistry");
      const sceneFor = (systemID) => (runtime.scenes instanceof Map ? runtime.scenes.get(Number(systemID)) : null);
      const a = store.getNativeEntity(attackerID), b = store.getNativeEntity(targetID);
      const shipA = a ? sceneFor(a.systemID)?.getEntityByID?.(attackerID) : null;
      const shipB = b ? sceneFor(b.systemID)?.getEntityByID?.(targetID) : null;
      const distance = ["x", "y", "z"].every((k) => Number.isFinite(shipA?.position?.[k]) && Number.isFinite(shipB?.position?.[k]))
        ? Math.hypot(shipA.position.x - shipB.position.x, shipA.position.y - shipB.position.y, shipA.position.z - shipB.position.z)
        : null;
      const ctrl = controllers.getControllerByEntityID(attackerID);
      // Read-only: the native target-lock state of both hulls. A warp point and a
      // turret both need a real lock, so "TARGET_NOT_LOCKED" and "no fire" are
      // answered here instead of guessed: a completed lock, a pending lock with
      // its completion time, and the live module effects.
      const locks = (systemID, ship) => {
        if (!ship) return null;
        const scene = sceneFor(systemID);
        if (!scene || typeof scene.getTargetsForEntity !== "function") return null;
        try {
          const locked = scene.getTargetsForEntity(ship) || [];
          const pending = typeof scene.getSortedPendingTargetLocks === "function"
            ? (scene.getSortedPendingTargetLocks(ship) || []).map((entry) => ({
              targetID: Number(entry && entry.targetID) || 0,
              completeAtMs: Number(entry && entry.completeAtMs) || 0,
            }))
            : [];
          const active = ship.activeModuleEffects instanceof Map
            ? Array.from(ship.activeModuleEffects.keys()).map((id) => Number(id) || 0)
            : [];
          return { locked: locked.map((id) => Number(id) || 0), pending, activeModules: active };
        } catch (error) {
          return { error: String(error && error.message || error).slice(0, 80) };
        }
      };
      // Read-only health layers: a kill is measured damage, never a claim.
      let damage = null;
      try { damage = require("./combat/damage"); } catch (_error) { damage = null; }
      const health = (ship) => {
        if (!ship || !damage) return null;
        try {
          const max = damage.getEntityMaxHealthLayers(ship);
          const cur = damage.getEntityCurrentHealthLayers(ship, max);
          if (!max || !cur) return null;
          return {
            max: { shield: Number(max.shield) || 0, armor: Number(max.armor) || 0, structure: Number(max.structure) || 0 },
            current: { shield: Number(cur.shield) || 0, armor: Number(cur.armor) || 0, structure: Number(cur.structure) || 0 },
          };
        } catch (_error) { return null; }
      };
      // Read-only: the exact first blocker the order bridge reports for this
      // hull, so a refused or unexecutable order is measured, not inferred.
      let orderDiagnosis = null;
      try {
        orderDiagnosis = require("./coopVirtualWorldRuntime" + siblingSuffix)
          .diagnoseNpcOrder({ entityID: attackerID, systemID: Number(a?.systemID) || 0, owner: "RAID" });
      } catch (error) {
        orderDiagnosis = { status: "THREW", reason: String(error && error.message || error).slice(0, 80) };
      }
      let engagement = null;
      try {
        engagement = require("./coopNpcHostility" + siblingSuffix).allowsNativeEngagement(shipA, shipB) === true;
      } catch (error) {
        engagement = "THREW:" + String(error && error.message || error).slice(0, 80);
      }
      let warVerdict = null;
      try {
        warVerdict = require("./coopWarCombatAuthority" + siblingSuffix).nativeWarCombatVerdict(shipA, shipB);
      } catch (error) {
        warVerdict = { status: "THREW", reason: String(error && error.message || error).slice(0, 80) };
      }
      // Read-only: the range the attacker's own fitted weapon really has in
      // dogma. A raider parked outside its own gun range can never convert an
      // attack order into damage, so the number the raid orbits at is measured.
      let attackerGun = null;
      try {
        attackerGun = require("./coopNpcGunRange" + siblingSuffix).shared().rangeOf(shipA);
      } catch (error) {
        attackerGun = { status: "THREW", reason: String(error && error.message || error).slice(0, 80) };
      }
      return {
        ok: true,
        attackerID, targetID,
        attacker: { systemID: Number(a?.systemID) || 0, inScene: Boolean(shipA), mode: String(shipA?.mode || ""), position: shipA?.position || null, health: health(shipA), gunRange: attackerGun, locks: locks(a?.systemID, shipA) },
        target: { systemID: Number(b?.systemID) || 0, inScene: Boolean(shipB), mode: String(shipB?.mode || ""), position: shipB?.position || null, health: health(shipB), locks: locks(b?.systemID, shipB) },
        distanceMeters: distance,
        orderDiagnosis,
        controller: {
          entityID: Number(ctrl?.entityID) || 0,
          systemID: Number(ctrl?.systemID) || 0,
          currentTargetID: Number(ctrl?.currentTargetID) || 0,
          manualType: String(ctrl?.manualOrder?.type || ""),
          manualTargetID: Number(ctrl?.manualOrder?.targetID) || 0,
          allowWeapons: ctrl?.manualOrder?.allowWeapons !== false,
          // A stock NPC that is beyond its own leash clears its combat state and
          // flies home on every think, so an issued order can never become fire.
          returningHome: ctrl?.returningHome === true,
          leashRangeMeters: Number(ctrl?.behaviorProfile?.leashRangeMeters) || 0,
          behaviorOverrides: ctrl?.behaviorOverrides || null,
          homeDistanceMeters: (() => {
            const home = ctrl?.homePosition;
            if (!shipA || !home) return null;
            return ["x", "y", "z"].every((k) => Number.isFinite(Number(home[k])) && Number.isFinite(shipA.position?.[k]))
              ? Math.hypot(shipA.position.x - Number(home.x), shipA.position.y - Number(home.y), shipA.position.z - Number(home.z))
              : null;
          })(),
        },
        engagementAllowed: engagement,
        warVerdict,
      };
    } catch (error) {
      return { ok: false, error: "pair diagnose failed: " + String(error && error.message || error) };
    }
  }
  if (action === "war_combat_diagnose") {
    try {
      const runtimeWorld = require("./coopVirtualWorldRuntime" + siblingSuffix);
      return { ok: true, combat: runtimeWorld.diagnoseCombat() };
    } catch (error) {
      return { ok: false, error: "combat diagnose failed: " + String(error && error.message || error) };
    }
  }
  if (action === "trip_diagnose") {
    const systemID = Number(request.systemID) || 0;
    const fleetID = Number(request.fleetID) || 0;
    if (!(systemID > 0) || !(fleetID > 0)) return { ok: false, error: "systemID and fleetID are required" };
    try {
      return { ok: true, trip: require("./coopNativeStationArrival" + siblingSuffix).diagnoseTrip({ systemID, fleetID }) };
    } catch (error) {
      return { ok: false, error: "trip diagnose failed: " + String(error && error.message || error) };
    }
  }
  // Read-only: WHICH term of the arrival gate refuses a deposit for one hauler of
  // a live trip (station point / physical stability / dwell). Never warps, orders,
  // deposits or creates a scene.
  if (action === "arrival_diagnose") {
    const systemID = Number(request.systemID) || 0;
    const fleetID = Number(request.fleetID) || 0;
    const haulerID = Number(request.haulerID) || 0;
    const cargoID = Number(request.cargoID) || 0;
    if (!(systemID > 0) || !(haulerID > 0)) return { ok: false, error: "systemID and haulerID are required" };
    try {
      const operations = require("../services/mining/miningNpcOperations");
      const fleets = operations.getMiningFleetsForSystem(systemID) || [];
      const fleet = fleetID > 0 ? fleets.find((row) => Number(row?.fleetID) === fleetID) : fleets[0];
      const trip = fleet?.coopStationArrival || null;
      const stationID = Number(request.stationID) || Number(trip?.stationID) || 0;
      const arrivedAtMs = Number(trip?.haulers?.[haulerID]?.arrivedAt) || 0;
      const arrival = require("./coopNativeStationArrival" + siblingSuffix).diagnoseArrival({
        systemID, stationID, fleetID: Number(fleet?.fleetID) || 0, haulerID, cargoID, arrivedAtMs });
      return { ok: true, systemID, fleetID: Number(fleet?.fleetID) || 0, stationID, haulerID,
        cargoID, fleetState: String(fleet?.state || ""), tripStationID: Number(trip?.stationID) || 0,
        tripCorporationID: Number(trip?.corporationID) || 0, arrival };
    } catch (error) {
      return { ok: false, error: "arrival diagnose failed: " + String(error && error.message || error) };
    }
  }
  // Read-only: why a stock mining fleet is not at its belt, or why a loaded fleet
  // never leaves for a station. Never warps, orders, mines or writes a journal.
  if (action === "mining_fleet_diagnose") {
    const systemIDs = (Array.isArray(request.systemIDs) ? request.systemIDs : [request.systemID])
      .map((value) => Number(value) || 0).filter((value) => value > 0);
    if (!systemIDs.length) return { ok: false, error: "systemID or systemIDs is required" };
    try {
      const runtime = require("./runtime");
      const controllers = require("./npc/npcRegistry");
      const operations = require("../services/mining/miningNpcOperations");
      const diagnose = require("./coopMiningFleetDiagnose" + siblingSuffix).createMiningFleetDiagnose({
        getFleets: (systemID) => operations.getMiningFleetsForSystem(systemID) || [],
        getScene: (systemID) => (runtime.scenes instanceof Map ? runtime.scenes.get(Number(systemID)) : null),
        getController: (entityID) => controllers.getControllerByEntityID(entityID),
        waypoints: (scene) => require("./coopNpcTopology" + siblingSuffix).waypoints(scene),
        getNativeEntity: (entityID) => require("./npc/nativeNpcStore").getNativeEntity(entityID),
        orderDiagnose: (args) => require("./coopVirtualWorldRuntime" + siblingSuffix).diagnoseNpcOrder(args),
        journalRoot: process.env.EVEJS_COOP_NPC_WAREHOUSE_DIR || "/var/lib/evejs/coop-native-warehouse",
      });
      return { ok: true, systemIDs, fleets: diagnose.run({ systemIDs }) };
    } catch (error) {
      return { ok: false, error: "mining fleet diagnose failed: " + String(error && error.message || error) };
    }
  }
  if (action === "war_diagnose") {
    try {
      const runtimeWorld = require("./coopVirtualWorldRuntime" + siblingSuffix);
      // FW-036: "can this border be fought at all" is a measurement, not a guess.
      let navy = null;
      try { navy = runtimeWorld.diagnoseNavy(); }
      catch (error) { navy = { status: "UNAVAILABLE", reason: String(error && error.message || error) }; }
      return { ok: true, mobilization: runtimeWorld.diagnoseMobilization(), navy };
    } catch (error) {
      return { ok: false, error: "diagnose failed: " + String(error && error.message || error) };
    }
  }
  // Read-only: the war state exactly as the phases read it (territories, wars,
  // campaigns), so "no front" and "0 campaigns" are measurements.
  if (action === "war_state") {
    try {
      const runtimeWorld = require("./coopVirtualWorldRuntime" + siblingSuffix);
      return { ok: true, warState: runtimeWorld.diagnoseWarState() };
    } catch (error) {
      return { ok: false, error: "war state diagnose failed: " + String(error && error.message || error) };
    }
  }
  // FW-038B: pay (or preview) a mercenary contract between two real corporation
  // wallets. dryRun previews and writes nothing.
  if (action === "war_mercenary_settle" || action === "war_mercenary_state") {
    try {
      const runtimeWorld = require("./coopVirtualWorldRuntime" + siblingSuffix);
      if (action === "war_mercenary_state")
        return { ok: true, settlement: runtimeWorld.diagnoseMercenarySettlement() };
      const result = runtimeWorld.executeMercenaryContract(request);
      return Object.assign({ ok: result.status === "PAID" || result.status === "DRY_RUN" || result.status === "DUPLICATE" }, result);
    } catch (error) {
      return { ok: false, error: "mercenary settle failed: " + String(error && error.message || error) };
    }
  }
  if (action === "war_funding_diagnose") {
    try {
      const runtimeWorld = require("./coopVirtualWorldRuntime" + siblingSuffix);
      return { ok: true, funding: runtimeWorld.diagnoseWarFunding() };
    } catch (error) {
      return { ok: false, error: "funding diagnose failed: " + String(error && error.message || error) };
    }
  }
  if (action === "militia_state") return militiaState(request);
  if (action === "militia_enlist") return militiaEnlist(request);
  const characterID = Number(request.characterID) || 0;
  if (!(characterID > 0)) return { ok: false, error: "characterID is required" };
  if (action === "chat_command") return executeChatCommand(request);
  if (action === "give_item") return giveItem(request);
  if (action === "remove_item") return removeItem(request);
  if (action === "fit_ship") return fitShip(request);
  if (action === "move_item") return moveItem(request);
  if (action === "fit_slots") return fitSlots(request);
  return boardShip(request);
}

// Executes pending requests once. Called from the world tick; cheap when empty.
function drain(options) {
  const opts = options || {};
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const pending = readJsonLines(REQUESTS);
  if (!pending.length) return 0;

  const keep = [];
  let executed = 0;
  for (let index = 0; index < pending.length; index += 1) {
    if (executed >= MAX_REQUESTS_PER_DRAIN) {
      keep.push(pending[index]);
      continue;
    }
    let request = null;
    try {
      request = JSON.parse(pending[index]);
    } catch (_error) {
      appendJsonLine(RESULTS, { id: "unparseable", ok: false, error: "request is not JSON" });
      continue;
    }
    const result = executeRequest(request);
    appendJsonLine(RESULTS, Object.assign({ id: request.id || "", at: new Date().toISOString() }, result));
    emitEvent("admin-action", result.ok ? "ok" : "refused", {
      action: String(request.action || ""),
      characterID: Number(request.characterID) || 0,
      detail: result.ok ? "" : String(result.error || ""),
    });
    log(`[CoopAdminBridge] ${request.action} for ${request.characterID}: ${result.ok ? "ok" : "refused"} ${result.error || ""}`.trim());
    executed += 1;
  }
  writeJsonLines(REQUESTS, keep);
  return executed;
}

module.exports = { drain, executeRequest, REQUESTS, RESULTS, ALLOWED_ACTIONS };
