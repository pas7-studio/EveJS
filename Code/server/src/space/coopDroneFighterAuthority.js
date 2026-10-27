"use strict";
// Pinned EveJS admission guard. No native mutation, fabricated entity, or
// alternate session/ownership registry. Intended for Chat 01's native hooks.
const id = value => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const active = session => Boolean(session?.socket &&
  session.socket.destroyed !== true && session.socket.writableEnded !== true &&
  session._space?.initialStateSent === true);
const deny = (reason, details = {}) => ({ok:false,reason,...details});
const accept = details => ({ok:true,reason:"NATIVE_AUTHORIZED",...details});
const sameSystem = (entity,systemID) => !id(entity?.systemID) || id(entity.systemID) === systemID;

function admitPilot({session, scene, shipRecord, registryLookup} = {}) {
  if (!(scene?.sessions instanceof Map) || !(scene.dynamicEntities instanceof Map) ||
    typeof scene.getEntityByID !== "function") return deny("NATIVE_SCENE_UNAVAILABLE");
  if (!active(session)) return deny("SESSION_NOT_BALLPARK_READY");
  const characterID = id(session.characterID ?? session.charID);
  const shipID = id(session._space.shipID);
  const systemID = id(session._space.systemID);
  if (!characterID || !shipID || !systemID || id(scene.systemID) !== systemID)
    return deny("SESSION_IDENTITY_MISMATCH");
  if (![...scene.sessions.values()].includes(session)) return deny("SESSION_NOT_IN_SCENE");
  if (typeof registryLookup === "function" && registryLookup(characterID) !== session)
    return deny("REGISTRY_OWNER_MISMATCH");
  const claiming = [...scene.sessions.values()].filter(candidate => active(candidate) &&
    (id(candidate.characterID ?? candidate.charID) === characterID ||
      id(candidate._space?.shipID) === shipID));
  if (claiming.length !== 1 || claiming[0] !== session)
    return deny("DUPLICATE_ACTIVE_CHARACTER_OR_SHIP");
  if (id(shipRecord?.itemID) !== shipID || id(shipRecord?.ownerID) !== characterID)
    return deny("ACTIVE_SHIP_INVENTORY_OWNER_MISMATCH");
  const ship = scene.dynamicEntities.get(shipID);
  if (!ship || scene.getEntityByID(shipID) !== ship ||
      ship.kind !== "ship" || id(ship.itemID) !== shipID ||
      ship.nativeNpc === true || !sameSystem(ship,systemID))
    return deny("NATIVE_SHIP_NOT_AUTHORITATIVE");
  const pilotID = id(ship.pilotCharacterID ?? ship.characterID);
  if (pilotID && pilotID !== characterID) return deny("PHYSICAL_PILOT_MISMATCH");
  if (ship.session && ship.session !== session) return deny("PHYSICAL_SHIP_SESSION_MISMATCH");
  return accept({characterID,shipID,systemID,ship});
}

function admitCraft({session,scene,shipRecord,registryLookup,craftIDs,kind,mode="control",findItemById} = {}) {
  const pilot = admitPilot({session,scene,shipRecord,registryLookup});
  if (!pilot.ok) return pilot;
  if (!['drone','fighter'].includes(kind) ||
    !['control','reconnect','scoop'].includes(mode) ||
    typeof findItemById !== "function") return deny("INVALID_CRAFT_OPERATION");
  if (!Array.isArray(craftIDs) || !craftIDs.length || craftIDs.length > 50 ||
    craftIDs.some(value => id(value) === null)) return deny("INVALID_CRAFT_IDS");
  const ids = craftIDs.map(id);
  if (new Set(ids).size !== ids.length) return deny("DUPLICATE_CRAFT_ID");
  const craft = [];
  for (const craftID of ids) {
    const entity = scene.dynamicEntities.get(craftID);
    if (!entity || scene.getEntityByID(craftID) !== entity ||
      entity.kind !== kind || id(entity.itemID) !== craftID ||
      !sameSystem(entity,pilot.systemID)) return deny("CRAFT_NOT_AUTHORITATIVE",{craftID});
    const stored = findItemById(craftID);
    if (!stored || id(stored.itemID) !== craftID ||
      id(stored.ownerID) !== pilot.characterID ||
      id(stored.locationID) !== pilot.systemID ||
      Number(stored.flagID) !== 0 ||
      id(stored.typeID) !== id(entity.typeID))
      return deny("CRAFT_INVENTORY_CUSTODY_MISMATCH",{craftID});
    const controllerID = id(entity.controllerID);
    const launcherID = id(entity.launcherID);
    const controllerOwnerID = id(entity.controllerOwnerID);
    if (mode === "control") {
      if (controllerID !== pilot.shipID || launcherID !== pilot.shipID ||
          (controllerOwnerID && controllerOwnerID !== pilot.characterID))
        return deny("CRAFT_CONTROL_OWNER_MISMATCH",{craftID});
    } else {
      if (controllerID || launcherID || controllerOwnerID)
        return deny("CRAFT_STILL_CONTROLLED",{craftID});
      // A remote player's abandoned fighter is not a free inventory grant.
      // Ownership transfers need an explicitly separate native policy.
      if (kind === "fighter" && mode === "reconnect")
        return deny("FIGHTER_RECONNECT_UNSUPPORTED",{craftID});
    }
    if (mode === "control") {
      if (kind === "fighter" && id(entity.tubeFlagID) === null)
        return deny("FIGHTER_TUBE_ID_MISSING",{craftID});
    }
    craft.push({craftID,entity,stored});
  }
  return accept({...pilot,craftIDs:ids,craft});
}

// Native damage may use a shallow combat-source copy with the ORIGINAL entityID.
// Never assign player attribution from an NPC target, last-target history or
// a controller ID alone. This is a read-only proof, not killmail mutation.
function witnessAppliedDamage({scene,source,target,appliedDamage,findItemById,registryLookup} = {}) {
  if (!(scene?.sessions instanceof Map) || !(scene?.dynamicEntities instanceof Map) ||
    typeof scene.getEntityByID !== "function") return deny("NATIVE_SCENE_UNAVAILABLE");
  const craftID = id(source?.itemID);
  const targetID = id(target?.itemID);
  if (!craftID || !targetID || craftID === targetID ||
    !['drone','fighter'].includes(source?.kind) ||
    !Number.isFinite(appliedDamage) || appliedDamage <= 0)
    return deny("NO_VERIFIED_CRAFT_DAMAGE");
  const entity = scene.dynamicEntities.get(craftID);
  if (!entity || scene.getEntityByID(craftID) !== entity || entity.kind !== source.kind ||
      scene.getEntityByID(targetID) !== target ||
      scene.dynamicEntities.get(targetID) !== target)
    return deny("SOURCE_OR_TARGET_NOT_AUTHORITATIVE");
  const shipID = id(entity.controllerID);
  if (!shipID || id(source.controllerID) !== shipID ||
      id(source.launcherID) !== shipID || id(entity.launcherID) !== shipID)
    return deny("COMBAT_SOURCE_CONTROLLER_MISMATCH");
  const ship = scene.dynamicEntities.get(shipID);
  const session = ship?.session;
  if (!session) return deny("OWNER_SESSION_UNVERIFIED");
  const pilot = admitPilot({session,scene,shipRecord:findItemById?.(shipID),registryLookup});
  if (!pilot.ok) return pilot;
  const attestedID = id(source.pilotCharacterID ?? source.characterID);
  if (attestedID !== pilot.characterID ||
      id(entity.controllerOwnerID) !== pilot.characterID ||
      id(source.controllerOwnerID) !== pilot.characterID)
    return deny("COMBAT_ATTRIBUTION_OWNER_MISMATCH");
  const item = findItemById?.(craftID);
  if (!item || id(item.ownerID) !== pilot.characterID ||
      id(item.locationID) !== pilot.systemID ||
      id(item.typeID) !== id(entity.typeID))
    return deny("COMBAT_SOURCE_INVENTORY_MISMATCH");
  return accept({characterID:pilot.characterID,shipID,craftID,targetID,
    kind:entity.kind,appliedDamage,scope:"NATIVE_DAMAGE_SOURCE_ONLY"});
}

function admitNativeLaunch({session,scene,shipRecord,registryLookup,itemIDs,kind,findItemById,flagID}={}) {
  const pilot=admitPilot({session,scene,shipRecord,registryLookup});
  if (!pilot.ok) return pilot;
  if (!['drone','fighter'].includes(kind) || !Array.isArray(itemIDs) ||
    !itemIDs.length || itemIDs.length>50 || typeof findItemById!=="function" ||
    !id(flagID)) return deny("INVALID_LAUNCH_REQUEST");
  if (new Set(itemIDs.map(id)).size!==itemIDs.length || itemIDs.some(v=>!id(v)))
    return deny("INVALID_OR_DUPLICATE_LAUNCH_ITEM");
  for(const rawID of itemIDs){
    const item=findItemById(id(rawID));
    if (!item || id(item.itemID)!==id(rawID) ||
        id(item.ownerID)!==pilot.characterID ||
        id(item.locationID)!==pilot.shipID ||
        Number(item.flagID)!==Number(flagID) || !id(item.typeID))
      return deny("LAUNCH_ITEM_NOT_OWNED_IN_BAY",{itemID:id(rawID)});
    if(scene.getEntityByID(item.itemID))return deny("LAUNCH_ENTITY_ALREADY_PHYSICAL",{itemID:id(rawID)});
  }
  return accept({...pilot,itemIDs:itemIDs.map(id),kind});
}
module.exports={admitPilot,admitCraft,admitNativeLaunch,witnessAppliedDamage};
