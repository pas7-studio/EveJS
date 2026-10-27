"use strict";
// Share a *completed native EveJS dungeon objective* with the one other
// consenting fleet member ONLY when BOTH actual player ships are still
// physically at the same authentic mission site. No GM completion,
// fabricated kills, reward writes or client impersonation.
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
function observe({instance,missionRuntime,fleetRuntime,spaceRuntime,
 sessions=[]}={}){
 const ownership=instance?.ownership||{},meta=instance?.metadata||{};
 const owner=id(ownership.missionOwnerCharacterID||meta.missionCharacterID);
 const agent=id(meta.missionAgentID);
 const source=id(instance?.instanceID);
 if(!owner||!agent||!source||
  !["completed"].includes(String(instance?.objectiveState?.state||"").toLowerCase())&&
   !(Number(instance?.objectiveState?.completedAtMs)>0))
  return {status:"NOT_VERIFIED_NATIVE_DUNGEON"};
 if(!Array.isArray(sessions)||!missionRuntime||
  typeof missionRuntime.getMissionRecord!=="function"||
  typeof missionRuntime.shareCoopDungeonObjective!=="function"||
  typeof missionRuntime.isSessionInActiveMissionDungeon!=="function"||
  !fleetRuntime)
  return {status:"NATIVE_MISSION_API_UNAVAILABLE"};
 const leaderSession=sessions.filter(s=>id(s?.characterID)===owner&&
  s?.socket?.destroyed!==true);
 if(leaderSession.length!==1)return {status:"NO_SINGLE_AUTHENTIC_OWNER"};
 const fleet=fleetRuntime.getFleetForCharacter?.(owner);
 if(!fleet||fleet.members?.size!==2||!fleet.members.has(owner))
  return {status:"NOT_TWO_NATIVE_FLEET_MEMBERS"};
 const peer=id([...fleet.members.keys()].find(x=>id(x)!==owner));
 if(!peer)return {status:"PEER_ID_MISSING"};
 const peers=sessions.filter(s=>id(s?.characterID)===peer&&
  s?.socket?.destroyed!==true);
 if(peers.length!==1)return {status:"NO_SINGLE_AUTHENTIC_PEER"};
 const leader=leaderSession[0],wingman=peers[0];
 const site=require("./coopNativeFleetParty").inSpaceParty({
  leaderSession:leader,peerSession:wingman,fleetRuntime,spaceRuntime});
 if(!site.ok)return {status:site.reason};
 const original=missionRuntime.getMissionRecord(owner,agent);
 const other=missionRuntime.getMissionRecord(peer,agent);
 if(!original||!other||
  original.runtimeStatus!=="accepted"||
  original.objectiveMode!=="dungeon"||
  original.objectiveCompleted!==true||
  original.gmCompleted===true||
  Number(original.dungeonInstanceID)!==source||
  other.runtimeStatus!=="accepted"||
  other.objectiveMode!=="dungeon"||
  other.gmCompleted===true||
  String(original.contentID)!==String(other.contentID)||
  !original.contentID||
  String(original.missionTemplateID||"")!==String(other.missionTemplateID||"")||
  id(original.missionSystemID)!==site.systemID||
  id(other.missionSystemID)!==site.systemID)
  return {status:"NATIVE_MISSION_OBJECTIVES_MISMATCH"};
 // Both players must physically be at the leader's real mission
 // dungeon location at the moment its native objective is completed.
 // Merely being in the same fleet, or docked elsewhere, is NOT proof.
 if(missionRuntime.isSessionInActiveMissionDungeon(leader,original)!==true||
  missionRuntime.isSessionInActiveMissionDungeon(wingman,original)!==true)
  return {status:"BOTH_SHIPS_NOT_AT_COMPLETED_DUNGEON"};
 if(process.env.EVEJS_COOP_MISSION_INSTANCE_LINK==="1"){
  const link=require("./coopMissionInstanceProvenance").verify({
   ownerID:owner,peerID:peer,agentID:agent,leaderMission:original,
   peerMission:other,sourceInstanceID:source
  });
  if(!link.ok)return {status:link.status};
 }
 if(other.objectiveCompleted===true)
  return {status:"PEER_ALREADY_NATIVE_COMPLETED"};
 const result=missionRuntime.shareCoopDungeonObjective(
  peer,agent,owner,source);
 if(!result?.success)
  return {status:"NATIVE_SHARED_OBJECTIVE_FAILED",
   reason:String(result?.errorMsg||"UNKNOWN").slice(0,90)};
 return {status:"TWO_PLAYER_NATIVE_DUNGEON_OBJECTIVE_CREDITED",
  fleetID:site.fleetID,systemID:site.systemID,
  sourceInstanceID:source,agentID:agent,characterIDs:[owner,peer]};
}
module.exports={observe};
