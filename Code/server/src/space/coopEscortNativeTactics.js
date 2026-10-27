"use strict";
// Tactical orders for REAL native convoy ships, never an RPC from client.
// This adapter gates owner authority; native EveJS movement remains authoritative.
const pos=x=>Number.isSafeInteger(x)&&x>0;
const MODES=new Set(["HOLD","CONTINUE","RETREAT"]);
function createTactics({readVolunteers,readRoute,getScene,authorizeCommander,
 issueNativeCommand,observeNativeCommand,clock=()=>Date.now()}={}){
 if([readVolunteers,readRoute,getScene,authorizeCommander,issueNativeCommand,
  observeNativeCommand,clock].some(x=>typeof x!=="function"))
  throw Error("ESCORT_NATIVE_TACTICS_AUTHORITIES_REQUIRED");
 const last=new Map();
 function command({session,eventID,mode}={}){
  if(process.env.EVEJS_COOP_ESCORT_TACTICS!=="1")return {status:"DISABLED"};
  if(!MODES.has(mode)||typeof eventID!=="string"||
   !/^convoy-\d+-\d+-\d+$/.test(eventID))
   return {status:"INVALID_TACTICAL_ORDER"};
  const characterID=session?.characterID;
  if(!pos(characterID)||session?.socket?.destroyed===true||
   session?._space?.initialStateSent!==true)return {status:"UNAUTHENTICATED_NATIVE_PILOT"};
  let volunteers,route,scene,authority;
  try{volunteers=readVolunteers(eventID);route=readRoute(eventID);
   scene=getScene(session);authority=authorizeCommander({session,eventID,mode,volunteers,route})}
  catch{return {status:"NATIVE_TACTICS_SOURCE_UNAVAILABLE"}}
  if(volunteers?.status!=="VERIFIED_NATIVE_DUO_VOLUNTEER"||
   !volunteers.pilots?.some(p=>p.characterID===characterID&&
    p.shipID===session._space.shipID)||
   volunteers.eventID!==eventID||
   route?.status!=="NATIVE_CONVOY_EN_ROUTE"||
   route.systemID!==volunteers.systemID||
   // NPC source fleet and the two PLAYER pilots belong to distinct native
   // fleets. Requiring them equal falsely blocks every genuine convoy.
   route.playerFleetID!==volunteers.fleetID||
   route.entityID!==volunteers.entityID||
   scene?.systemID!==route.systemID||
   !pos(route.entityID)||scene.getEntityByID?.(route.entityID)?.nativeNpc!==true||
   scene.getEntityByID(route.entityID).itemID!==route.entityID||
   session._space.systemID!==scene.systemID)
   return {status:"NATIVE_CONVOY_OR_FLEET_NOT_CONFIRMED"};
  if(authority?.status!=="AUTHORIZED_NATIVE_CONVOY_COMMANDER"||
   authority.characterID!==characterID||
   authority.fleetID!==route.playerFleetID)
   return {status:"NATIVE_COMMANDER_NOT_AUTHORIZED"};
  const now=clock(),key=eventID+":"+mode;
  if(!pos(now))return {status:"CLOCK_INVALID"};
  if(last.has(key)&&now-last.get(key)<10000)return {status:"TACTICAL_COOLDOWN"};
  let ack;try{ack=issueNativeCommand({eventID,mode,shipID:route.entityID,
   npcFleetID:route.fleetID,playerFleetID:route.playerFleetID,
   fleetID:route.fleetID,systemID:route.systemID})}
  catch{return {status:"NATIVE_TACTICAL_COMMAND_FAILED"}}
  if(ack?.status!=="NATIVE_COMMAND_ACCEPTED"||ack.entityID!==route.entityID)
   return {status:"NATIVE_TACTICAL_COMMAND_NOT_ACKNOWLEDGED"};
  let proof;try{proof=observeNativeCommand({scene,eventID,shipID:route.entityID,mode,ack})}
  catch{return {status:"NATIVE_TACTICAL_EFFECT_UNVERIFIED"}}
  if(proof?.status!=="NATIVE_COMMAND_APPLIED"||
   proof.entityID!==route.entityID||proof.mode!==mode)
   return {status:"NATIVE_TACTICAL_EFFECT_UNVERIFIED"};
  last.set(key,now);
  while(last.size>256)last.delete(last.keys().next().value);
  return {status:"NATIVE_CONVOY_TACTIC_VERIFIED",eventID,mode,
   entityID:route.entityID};
 }
 return {command};
}
module.exports={createTactics};
