"use strict";
// Advice only: two physically-present pilots in a genuine native fleet get
// complementary interception/escort roles during an already verified raid.
// Never mutates ship orders, target locks, inventory, wallet or NPC AI.
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):0;
const valid=p=>p&&["x","y","z"].every(k=>typeof p[k]==="number"&&Number.isFinite(p[k]));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function plan({scene,raid,fleetRuntime}={}){
 const pirate=id(raid?.pirateID),victim=id(raid?.targetID);
 const system=id(scene?.systemID||scene?.solarSystemID);
 if(!scene||!system||!pirate||!victim||pirate===victim||
   !scene.sessions||typeof scene.sessions.values!=="function"||
   typeof scene.getEntityByID!=="function"||
   !fleetRuntime||typeof fleetRuntime.getFleetForCharacter!=="function"||
   typeof fleetRuntime.getMemberRecord!=="function")
   return {status:"UNAVAILABLE",roles:new Map()};
 const pirateEntity=scene.getEntityByID(pirate),victimEntity=scene.getEntityByID(victim);
 if(pirateEntity?.kind!=="ship"||victimEntity?.kind!=="ship"||
   !valid(pirateEntity.position)||!valid(victimEntity.position))
   return {status:"INVALID_NATIVE_RAID",roles:new Map()};
 const pilots=[],seen=new Set();
 for(const session of scene.sessions.values()){
  const characterID=id(session?.characterID),shipID=id(session?._space?.shipID);
  if(!characterID||seen.has(characterID)||!shipID||
    session._space?.initialStateSent!==true||
    id(session._space.systemID)!==system||session.socket?.destroyed===true)
   continue;
  const entity=scene.getEntityByID(shipID);
  if(entity?.kind!=="ship"||!valid(entity.position)||shipID===pirate||shipID===victim)
   continue;
  seen.add(characterID);
  pilots.push({characterID,shipID,entity});
 }
 // Only assign roles to exactly two present, distinct pilots. No phantom
 // fleet membership, AFK offline entries, third pilot or cross-system play.
 if(pilots.length!==2)return {status:"NOT_EXACT_DUO",roles:new Map()};
 pilots.sort((a,b)=>a.characterID-b.characterID);
 let fleetA,fleetB;
 try{
  fleetA=fleetRuntime.getFleetForCharacter(pilots[0].characterID);
  fleetB=fleetRuntime.getFleetForCharacter(pilots[1].characterID);
  if(!fleetA||fleetA!==fleetB||
    !fleetRuntime.getMemberRecord(fleetA,pilots[0].characterID)||
    !fleetRuntime.getMemberRecord(fleetA,pilots[1].characterID))
    return {status:"NOT_SAME_NATIVE_FLEET",roles:new Map()};
 }catch(_e){return {status:"FLEET_UNAVAILABLE",roles:new Map()};}
 // Nearest to pirate intercepts; the other escorts the threatened freighter.
 // Native coordinates only. Stable character-ID tiebreak for equal distance.
 const first=distance(pilots[0].entity.position,pirateEntity.position);
 const second=distance(pilots[1].entity.position,pirateEntity.position);
 const interceptor=first<=second?pilots[0]:pilots[1];
 const escort=interceptor===pilots[0]?pilots[1]:pilots[0];
 return {status:"DUO_TACTICS_READY",roles:new Map([
  [interceptor.characterID,{role:"intercept",targetID:pirate}],
  [escort.characterID,{role:"escort",targetID:victim}]
 ])};
}
module.exports={plan};
