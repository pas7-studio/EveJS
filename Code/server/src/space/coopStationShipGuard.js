"use strict";
// Opt-in validation of native EveJS station/ship boundaries. No shadow state,
// item moves, wallet mutation, timers or writes. The actual transition remains
// in pinned EveJS. Integration is owned by Chat 01.
const ACTIVE_FLAG_HANGAR = 4;
const SHIP_CATEGORY = 6;
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
const fail = code => ({success:false,errorMsg:code});
const ok = () => ({success:true});

function createStationShipGuard(deps) {
  for (const name of ["peekCharacterRecord", "findItemById", "getActiveShipRecord", "findCharacterShip", "getSceneForSession", "getEntity"]) {
    if (typeof deps?.[name] !== "function") throw Error("STATION_GUARD_DEPENDENCY_MISSING:"+name);
  }

  function identity(session) {
    const charID = positive(session?.characterID);
    if (!charID || (session.charid != null && Number(session.charid) !== charID))
      return fail("STATION_CHARACTER_IDENTITY_INVALID");
    const record = deps.peekCharacterRecord(charID);
    if (!record || positive(record.characterID || record.charID || charID) !== charID)
      return fail("STATION_CHARACTER_RECORD_MISSING");
    return {success:true,charID,record};
  }

  function dockedIdentity(session) {
    const id = identity(session);
    if (!id.success) return id;
    const persistedStation = positive(id.record.stationID);
    const persistedStructure = positive(id.record.structureID);
    if (Boolean(persistedStation) === Boolean(persistedStructure))
      return fail("STATION_PERSISTED_LOCATION_INVALID");
    const isStructure = Boolean(persistedStructure);
    const locationID = persistedStructure || persistedStation;
    const stationAliases = ["stationid", "stationID", "stationId"];
    const structureAliases = ["structureid", "structureID", "structureId"];
    for (const key of stationAliases) {
      if (session[key] != null && positive(session[key]) !== persistedStation)
        return fail("STATION_SESSION_LOCATION_STALE");
    }
    for (const key of structureAliases) {
      if (session[key] != null && positive(session[key]) !== persistedStructure)
        return fail("STATION_SESSION_LOCATION_STALE");
    }
    if (!stationAliases.some(k=>positive(session[k])===persistedStation && persistedStation>0) &&
        !structureAliases.some(k=>positive(session[k])===persistedStructure && persistedStructure>0))
      return fail("STATION_SESSION_LOCATION_STALE");
    if (session._space) return fail("STATION_SPACE_SESSION_STALE");
    return {success:true,...id,locationID,kind:isStructure?"structure":"station"};
  }

  function ownedHull(charID, shipID) {
    if (!positive(shipID)) return fail("STATION_SHIP_ID_INVALID");
    const owned = deps.findCharacterShip(charID,shipID);
    const item = deps.findItemById(shipID);
    if (!owned || !item || positive(owned.itemID)!==shipID || positive(item.itemID)!==shipID ||
        positive(item.ownerID)!==charID || positive(owned.ownerID)!==charID ||
        Number(item.categoryID)!==SHIP_CATEGORY || Number(owned.categoryID)!==SHIP_CATEGORY)
      return fail("STATION_SHIP_NOT_OWNED");
    if (positive(owned.locationID)!==positive(item.locationID) ||
        Number(owned.typeID)!==Number(item.typeID) ||
        Number(owned.flagID)!==Number(item.flagID) || Number(owned.singleton)!==Number(item.singleton))
      return fail("STATION_SHIP_SNAPSHOT_DRIFT");
    return {success:true,item};
  }

  function activate(session, rawShipID) {
    const id = dockedIdentity(session);
    if (!id.success) return id;
    const shipID = positive(rawShipID);
    const hull = ownedHull(id.charID,shipID);
    if (!hull.success) return hull;
    if (positive(hull.item.locationID)!==id.locationID || Number(hull.item.flagID)!==ACTIVE_FLAG_HANGAR)
      return fail("STATION_SHIP_NOT_IN_CURRENT_HANGAR");
    if (Number(hull.item.singleton)!==1) return fail("STATION_SHIP_NOT_ASSEMBLED");
    return ok();
  }

  function undock(session, rawRequestedID) {
    const id = dockedIdentity(session);
    if (!id.success) return id;
    const active = deps.getActiveShipRecord(id.charID);
    const activeShipID = positive(active?.itemID);
    const hull = ownedHull(id.charID,activeShipID);
    if (!hull.success) return hull;
    if (!active || positive(active.ownerID)!==id.charID || positive(active.locationID)!==id.locationID ||
        Number(active.flagID)!==ACTIVE_FLAG_HANGAR || Number(active.singleton)!==1)
      return fail("STATION_ACTIVE_SHIP_INVALID");
    if (positive(hull.item.locationID)!==id.locationID || Number(hull.item.flagID)!==ACTIVE_FLAG_HANGAR)
      return fail("STATION_ACTIVE_SHIP_NOT_DOCKED_HERE");
    if (Number(hull.item.singleton)!==1) return fail("STATION_SHIP_NOT_ASSEMBLED");
    if (rawRequestedID!==null && rawRequestedID!==undefined && positive(rawRequestedID)!==activeShipID)
      return fail("STATION_UNDOCK_SHIP_MISMATCH");
    if (["shipID", "shipid", "activeShipID"].some(k=>
        session[k] != null && positive(session[k])!==activeShipID) ||
        !["shipID", "shipid", "activeShipID"].some(k=>positive(session[k])===activeShipID))
      return fail("STATION_ACTIVE_SESSION_SHIP_STALE");
    if (positive(id.record.shipID)!==activeShipID)
      return fail("STATION_ACTIVE_RECORD_SHIP_STALE");
    return ok();
  }

  // Before the stock dock transition detaches Ballpark, verify the current
  // physical object is the same persistently-owned hull in the same system.
  function dock(session, targetID, dockable) {
    const id = identity(session);
    if (!id.success) return id;
    if (positive(id.record.stationID) || positive(id.record.structureID) ||
        ["stationID","stationid","structureID","structureid"].some(k=>positive(session?.[k])))
      return fail("STATION_ALREADY_DOCKED");
    const scene = deps.getSceneForSession(session);
    const ship = deps.getActiveShipRecord(id.charID);
    const shipID = positive(ship?.itemID);
    if (!shipID) return fail("STATION_SHIP_ID_INVALID");
    if (positive(id.record.shipID)!==shipID ||
        ["shipID", "shipid", "activeShipID"].some(k=>
          session[k] != null && positive(session[k])!==shipID))
      return fail("STATION_ACTIVE_SESSION_SHIP_STALE");
    const hull = ownedHull(id.charID,shipID);
    if (!hull.success) return hull;
    const sceneID = positive(scene?.systemID);
    const targetLocation = positive(targetID);
    if (!targetLocation || targetLocation !== positive(dockable?.locationID) ||
        !sceneID || sceneID !== positive(dockable?.solarSystemID) ||
        sceneID !== positive(id.record.solarSystemID))
      return fail("STATION_DOCK_SYSTEM_MISMATCH");
    if (positive(hull.item.locationID)!==sceneID || Number(hull.item.flagID)!==0 ||
        positive(ship?.ownerID)!==id.charID || positive(ship?.locationID)!==sceneID)
      return fail("STATION_DOCK_SHIP_NOT_IN_SPACE");
    const physical = deps.getEntity(session,shipID);
    if (!physical || physical.kind!=="ship" || positive(physical.itemID)!==shipID ||
        (physical.session && physical.session!==session) ||
        positive(session?._space?.shipID)!==shipID ||
        positive(session?._space?.systemID)!==sceneID ||
        session?._space?.initialStateSent!==true)
      return fail("STATION_DOCK_BALLPARK_STALE");
    if (!Array.isArray(scene.sessions) && !(scene.sessions instanceof Set) && !(scene.sessions instanceof Map))
      return fail("STATION_DOCK_SCENE_SESSION_UNKNOWN");
    const sessions = Array.isArray(scene.sessions)?scene.sessions:scene.sessions instanceof Map?[...scene.sessions.values()]:[...scene.sessions];
    if (sessions.filter(s=>s===session).length!==1)
      return fail("STATION_DOCK_SCENE_SESSION_STALE");
    if (sessions.some(s=>s!==session &&
        positive(s?._space?.shipID)===shipID && s?._space?.systemID===sceneID))
      return fail("STATION_DOCK_SHIP_DOUBLE_CLAIMED");
    return ok();
  }

  return {activate,undock,dock};
}

// Runtime adapters load lazily, after native modules have finished initializing.
function nativeGuard() {
  const character = require("../services/character/characterState");
  const itemStore = require("../services/inventory/itemStore");
  const spaceRuntime = require("./runtime");
  return createStationShipGuard({
    peekCharacterRecord:character.peekCharacterRecord,
    findCharacterShip:character.findCharacterShip,
    getActiveShipRecord:character.getActiveShipRecord,
    findItemById:itemStore.findItemById,
    getSceneForSession:session=>spaceRuntime.getSceneForSession(session),
    getEntity:(session,id)=>spaceRuntime.getEntity(session,id),
  });
}
function ensure(result) {
  if (result.success) return;
  const stale = /STALE|MISMATCH|DOUBLE_CLAIMED/.test(result.errorMsg);
  const notify = stale
    ? "Station or ship state changed. Reconnect before trying again."
    : "The requested station service or ship is not currently available.";
  require("../common/machoErrors").throwWrappedUserError("CustomNotify", {notify});
  // Defensive fail-closed if a native error adapter ever returns.
  throw Error(result.errorMsg);
}
function assertDockedActivation(session,shipID) {
  if (process.env.EVEJS_COOP_STATION_SHIP_GUARD!=="1") return;
  ensure(nativeGuard().activate(session,shipID));
}
function assertUndock(session,shipID) {
  if (process.env.EVEJS_COOP_STATION_SHIP_GUARD!=="1") return;
  ensure(nativeGuard().undock(session,shipID));
}
function assertDock(session,stationID,dockable) {
  if (process.env.EVEJS_COOP_STATION_SHIP_GUARD!=="1") return;
  ensure(nativeGuard().dock(session,stationID,dockable));
}
module.exports = {createStationShipGuard,assertDockedActivation,assertUndock,assertDock};
