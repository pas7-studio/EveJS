"use strict";
// Opt-in: when an authenticated wingman presses the *stock* Request Mission
// button, offer the SAME allowlisted mission as the fleet creator's accepted
// dungeon. The wingman must still personally press stock Accept Mission.
// No GM completion, reward writes, mission-cloning or forced consent.
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const text=x=>String(x==null?"":x).trim();
function offer({characterID,agentRecord,fleetRuntime,sessions,
 getMissionRecord,getClientMissionRecord,offerSpecificMission,
 getDockedLocationID,isMissionOfferAllowedForAgent,canUseAgent,
 getReplayUntilFileTime,resolveReplayRemainingTicks}={}){
 try{
  const peer=id(characterID),agent=id(agentRecord?.agentID);
  const station=id(agentRecord?.stationID);
  if(!peer||!agent||!station)return {status:"NATIVE_AGENT_JOIN_UNAVAILABLE"};
  if(!fleetRuntime||typeof fleetRuntime.getFleetForCharacter!=="function"||
   typeof fleetRuntime.getMemberRecord!=="function"||
   typeof getMissionRecord!=="function"||
   typeof getClientMissionRecord!=="function"||
   typeof getDockedLocationID!=="function"||
   typeof offerSpecificMission!=="function"||
   typeof isMissionOfferAllowedForAgent!=="function"||
   typeof canUseAgent!=="function"||
   typeof getReplayUntilFileTime!=="function"||
   typeof resolveReplayRemainingTicks!=="function"||
   !Array.isArray(sessions))
   return {status:"NATIVE_JOIN_APIS_UNAVAILABLE"};
  // Both accounts must be present as unique connected native sessions.
  const fleet=fleetRuntime.getFleetForCharacter(peer);
  const leader=id(fleet?.creatorCharID);
  if(!leader||leader===peer||!id(fleet?.fleetID)||
   fleet.members?.size!==2||!fleet.members.has(peer)||
   !fleet.members.has(leader)||
   !fleetRuntime.getMemberRecord(fleet,peer)||
   !fleetRuntime.getMemberRecord(fleet,leader)||
   fleetRuntime.getFleetForCharacter(leader)!==fleet)
   return {status:"NOT_CREATOR_LED_NATIVE_DUO"};
  const matches=n=>sessions.filter(s=>
   id(s?.characterID)===n&&s?.socket?.destroyed!==true);
  const wing=matches(peer),captain=matches(leader);
  if(wing.length!==1||captain.length!==1||
   !wing[0].socket||!captain[0].socket||
   id(getDockedLocationID(wing[0]))!==station||
   id(getDockedLocationID(captain[0]))!==station)
   return {status:"NOT_TWO_AUTHENTIC_DOCKED_PLAYERS"};
  // Preserve standing requirements, native replay/cooldown restrictions and
  // existing offered/accepted missions. Never override a personal offer.
  if(!canUseAgent(peer,agentRecord))
   return {status:"PEER_AGENT_STANDING_BLOCKED"};
  if(resolveReplayRemainingTicks(getReplayUntilFileTime(peer,agent))>0)
   return {status:"PEER_NATIVE_REPLAY_COOLDOWN"};
  if(getMissionRecord(peer,agent))
   return {status:"PEER_ALREADY_HAS_NATIVE_MISSION"};
  const leaderMission=getMissionRecord(leader,agent);
  if(!leaderMission||id(leaderMission.agentID)!==agent||
   !id(leaderMission.missionSequence)||
   leaderMission.runtimeStatus!=="accepted"||
   leaderMission.objectiveMode!=="dungeon"||
   leaderMission.gmCompleted===true||
   leaderMission.importantMission===true||
   leaderMission.storylineOfferProjection===true||
   agentRecord.importantMission===true||
   agentRecord.isCareerAgent===true||
   leaderMission.objectiveCompleted===true||
   !text(leaderMission.contentID)||
   !text(leaderMission.missionTemplateID)||
   !id(leaderMission.missionSystemID)||
   !id(leaderMission.dungeonInstanceID))
   return {status:"LEADER_NATIVE_DUNGEON_NOT_READY"};
  const candidate=getClientMissionRecord(leaderMission);
  if(!candidate||!isMissionOfferAllowedForAgent(agentRecord,candidate)||
   text(candidate.missionID)!==text(leaderMission.contentID))
   return {status:"CLIENT_MISSION_NOT_ALLOWLISTED"};
  // Native offerSpecificMission writes an ordinary *offered* mission for the
  // requesting player, with independent native missionSequence/rewards.
  // Its own later Accept will spawn that player's normal site/state.
  const response=offerSpecificMission(peer,agentRecord,candidate);
  if(response?.success!==true||
   response.data?.kind!=="offered"||
   !response.data.missionRecord)
   return {status:"NATIVE_JOIN_OFFER_UNAVAILABLE"};
  const created=response.data.missionRecord;
  if(id(created.agentID)!==agent||
   created.runtimeStatus!=="offered"||
   created.objectiveMode!=="dungeon"||
   text(created.contentID)!==text(leaderMission.contentID)||
   text(created.missionTemplateID)!==text(leaderMission.missionTemplateID)||
   !id(created.missionSequence))
   return {status:"JOIN_OFFER_MISMATCH_REQUIRES_MANUAL_REVIEW"};
  // Native Request creates a separate peer offer; durable correspondence to the
 // captain's exact accepted instance must precede any cooperative objective.
 if(process.env.EVEJS_COOP_MISSION_INSTANCE_LINK==="1"){
  const persisted=getMissionRecord(peer,agent);
  if(!persisted||id(persisted.agentID)!==agent||
   id(persisted.missionSequence)!==id(created.missionSequence)||
   persisted.runtimeStatus!=="offered"||
   text(persisted.contentID)!==text(created.contentID)||
   text(persisted.missionTemplateID)!==text(created.missionTemplateID))
   return {status:"NATIVE_INSTANCE_OFFER_NOT_DURABLE"};
  const link=require("./coopMissionInstanceProvenance").record({
   ownerID:leader,peerID:peer,agentID:agent,
   leaderMission,peerMission:persisted
  });
  if(!["NATIVE_INSTANCE_LINK_RECORDED",
   "NATIVE_INSTANCE_LINK_ALREADY_RECORDED"].includes(link.status))
   return {status:link.status};
 }
 return {status:"PEER_NATIVE_MATCHING_MISSION_OFFERED",
   fleetID:id(fleet.fleetID),leaderID:leader,peerID:peer,
   agentID:agent,leaderMissionSequence:id(leaderMission.missionSequence),
   peerMissionSequence:id(created.missionSequence)};
 }catch{return {status:"NATIVE_JOIN_PREPARE_FAILED"}}
}
module.exports={offer};
