"use strict";
// FW-009B physical observation seam. Missing/incomplete scene enumeration
// is UNKNOWN, never "zero defenders". It cannot create an objective or
// determine which actor dealt lethal structure damage.
const POS=x=>Number.isSafeInteger(x)&&x>0;
const VEC=x=>x&&["x","y","z"].every(k=>Number.isFinite(x[k]));
const RANGE=20000;
// Confirmed against the pinned SolarSystemScene: dynamicEntities is Map,
// staticEntities is Array. A scene missing either collection is NOT
// complete, and any active player ship missing from that map is unsafe.
function listPinnedSceneShips(scene){
 if(!(scene?.dynamicEntities instanceof Map)||
  !Array.isArray(scene.staticEntities)||
  typeof scene.getEntityByID!=="function")
  return {complete:false,ships:[]};
 const ships=[...scene.dynamicEntities.values(),...scene.staticEntities]
  .filter(e=>e?.kind==="ship");
 const ids=new Set();
 for(const ship of ships){
  if(!POS(ship?.itemID)||ids.has(ship.itemID)||
   scene.getEntityByID(ship.itemID)!==ship)
   return {complete:false,ships:[]};
  ids.add(ship.itemID);
 }
 const sessions=scene.sessions;
 if(sessions&&typeof sessions.values==="function"){
  for(const session of sessions.values()){
   const shipID=Number(session?._space?.shipID);
   if(POS(shipID)&&!ids.has(shipID))
    return {complete:false,ships:[]};
  }
 }
 return {complete:true,ships};
}

function createNativeStructureControlWitness({sceneForSystem,
 listAllPhysicalShips,getNativeEntity,getController,
 getFactionForCorporation,
 getLivePlayerSessions=()=>[],
 allowMilitiaPlayers=false,rangeM=RANGE}={}){
 if([sceneForSystem,listAllPhysicalShips,getNativeEntity,getController,
  getFactionForCorporation,getLivePlayerSessions]
  .some(fn=>typeof fn!=="function")||
  !Number.isSafeInteger(rangeM)||rangeM<5000||rangeM>50000)
  throw Error("FW_STRUCTURE_CONTROL_NATIVE_AUTHORITIES_REQUIRED");
 function observe({systemID,position,warID,campaignID,
  attackerFactionID,defenderFactionID,fleetState,warState}={}){
  const unknown=reason=>({status:"NATIVE_CONTROL_UNKNOWN",reason});
  if(!POS(systemID)||!VEC(position)||!POS(attackerFactionID)||
   !POS(defenderFactionID)||attackerFactionID===defenderFactionID||
   typeof warID!=="string"||typeof campaignID!=="string"||
   !fleetState?.ships)return unknown("INVALID_OBJECTIVE");
  let scene,all;
  try{
   scene=sceneForSystem(systemID);
   all=scene&&listAllPhysicalShips(scene);
  }catch{return unknown("PHYSICAL_SCENE_UNAVAILABLE")}
  if(scene?.systemID!==systemID||typeof scene.getEntityByID!=="function"||
   all?.complete!==true||!Array.isArray(all.ships)||all.ships.length>4096)
   return unknown("INCOMPLETE_SCENE_ENUMERATION");
  // Exact login uniqueness and native scene binding. Even non-enlisted
  // players MUST be represented in the complete scene. A duplicate live
  // session for one character can never manufacture more capture votes.
  let liveSessions=[];
  const sessionsByShip=new Map(),sessionsByCharacter=new Map();
  if(allowMilitiaPlayers){
   if(warState?.version!==1||!warState.enlistments||
    typeof warState.enlistments!=="object"||!Array.isArray(all.ships))
    return unknown("MILITIA_WAR_STATE_UNAVAILABLE");
   try{liveSessions=getLivePlayerSessions()}catch{return unknown("NATIVE_PLAYER_REGISTRY_UNAVAILABLE")}
   if(!Array.isArray(liveSessions)||liveSessions.length>2048)
    return unknown("NATIVE_PLAYER_REGISTRY_INCOMPLETE");
   for(const session of liveSessions){
    const cid=session?.characterID,shipID=Number(session?._space?.shipID),
     sid=Number(session?._space?.systemID);
    // Character-selection / login sessions have no in-space ship
    // and are not combat actors. They must not stop every siege.
    if(!POS(cid))continue;
    if(!session.socket||session.socket.destroyed||
     sessionsByCharacter.has(cid))
     return unknown("DUPLICATE_OR_INVALID_LIVE_CHARACTER");
    sessionsByCharacter.set(cid,session);
    if(sid!==systemID)continue;
    // In-space presence must be hydrated and must exist exactly once
    // in the same scene registered for this solar system.
    if(!POS(shipID)||session._space.initialStateSent!==true||
     Number(session.shipID||session.shipid||session.activeShipID)!==shipID||
     !(scene.sessions instanceof Map)||
     ![...scene.sessions.values()].includes(session)||
     typeof scene.getShipEntityForSession!=="function"||
     scene.getShipEntityForSession(session)?.itemID!==shipID||
     sessionsByShip.has(shipID))
     return unknown("LIVE_PLAYER_SHIP_NOT_NATIVE_READY");
    sessionsByShip.set(shipID,session);
    if(!all.ships.some(x=>x?.itemID===shipID))
     return unknown("MISSING_LIVE_PLAYER_SHIP_IN_PHYSICAL_CENSUS");
   }
  }
  const seen=new Set();let attackerCount=0,defenderCount=0,
   playerAttackers=0,playerDefenders=0,unaffiliatedPlayers=0;
  for(const ship of all.ships){
   const id=ship?.itemID;
   if(!POS(id)||seen.has(id)||!VEC(ship.position)||
    ship.kind!=="ship"||scene.getEntityByID(id)!==ship)
    return unknown("UNVERIFIED_PHYSICAL_ENTITY");
   seen.add(id);
   const d=Math.hypot(ship.position.x-position.x,
    ship.position.y-position.y,ship.position.z-position.z);
   if(!Number.isFinite(d))return unknown("INVALID_DISTANCE");
   if(d>rangeM)continue;
   if(ship.nativeNpc!==true||ship.session?.characterID){
    if(!allowMilitiaPlayers){
     defenderCount++;unaffiliatedPlayers++;continue;
    }
    const session=sessionsByShip.get(id);
    if(!session||session.socket?.destroyed===true||
     ship.nativeNpc===true||
     Number(session._space?.systemID)!==systemID||
     session._space?.initialStateSent!==true||
     scene.getShipEntityForSession(session)!==ship||
     Number(session._space?.shipID)!==id||
     ship.pendingWarp||ship.warpState||ship.isWarping){
     defenderCount++;unaffiliatedPlayers++;continue;
    }
    const enlistment=warState.enlistments[String(session.characterID)];
    if(enlistment?.status!=="ACTIVE"||
     enlistment.characterID!==session.characterID||
     !POS(enlistment.enlistedAt)||!POS(enlistment.factionID)){
     defenderCount++;unaffiliatedPlayers++;continue;
    }
    if(enlistment.factionID===attackerFactionID){
     attackerCount++;playerAttackers++;
    }else if(enlistment.factionID===defenderFactionID){
     defenderCount++;playerDefenders++;
    }else{
     defenderCount++;unaffiliatedPlayers++;
    }
    continue;
   }
   const assignment=fleetState.ships[String(id)];
   if(!assignment||assignment.systemID!==systemID||
    assignment.entityID!==id||assignment.campaignID!==campaignID||
    assignment.warID!==warID||!POS(assignment.corporationID)||
    !POS(assignment.factionID)){
    defenderCount++;continue;
   }
   let native,controller,faction;
   try{
    native=getNativeEntity(id);controller=getController(id);
    faction=getFactionForCorporation(assignment.corporationID);
   }catch{return unknown("NATIVE_CORPORATION_OR_CONTROLLER_UNAVAILABLE")}
   if(native?.entityID!==id||native.systemID!==systemID||
    native.corporationID!==assignment.corporationID||
    controller?.entityID!==id||controller.systemID!==systemID||
    faction!==assignment.factionID||
    ship.corporationID!==assignment.corporationID||
    ship.pendingWarp||ship.warpState||ship.isWarping)
    return unknown("NATIVE_SHIP_OR_ORDER_DRIFT");
   if(faction===attackerFactionID)attackerCount++;
   else defenderCount++;
  }
  return {status:attackerCount>0&&defenderCount===0?
   "UNCONTESTED_NATIVE_ATTACKER":"CONTESTED_NATIVE_OBJECTIVE",
   systemID,attackerFactionID,defenderFactionID,
   attackerCount,defenderCount,playerAttackers,playerDefenders,
   unaffiliatedPlayers,physicalProof:true};
 }
 return Object.freeze({observe});
}
module.exports={createNativeStructureControlWitness,listPinnedSceneShips};
