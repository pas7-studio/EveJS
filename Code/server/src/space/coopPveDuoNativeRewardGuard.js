"use strict";
// PVE-005A — optional fail-closed, source-bound authorization BEFORE the
// native leader agent DoAction. Native EveJS still owns every per-character
// mission, ISK, LP, item, standing and completion mutation.
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const tag=x=>(typeof x==="string"||typeof x==="number")&&String(x).trim()===String(x)&&String(x).length>0&&String(x).length<=256?String(x):null;
const REQUIRED_FLAGS=[
 "EVEJS_COOP_FLEET_MISSION_TURNIN",
 "EVEJS_COOP_FLEET_LEADER_FENCE",
 "EVEJS_COOP_MISSION_INSTANCE_LINK"
];
function checkConfiguration(flags={}){
 const missing=REQUIRED_FLAGS.filter(f=>flags[f]!=="1");
 return missing.length?{ok:false,status:"PVE_DUO_NATIVE_SETTLEMENT_DEPENDENCY_MISSING",
  missing}:{ok:true,status:"PVE_DUO_NATIVE_SETTLEMENT_CONFIGURED"};
}
function validate({ticket,getInstance,verifyLink,sharedObjectiveMatches,flags={}}={}){
 const configured=checkConfiguration(flags);
 if(!configured.ok)return configured;
 if(!ticket?.ok||typeof getInstance!=="function"||
    typeof verifyLink!=="function"||typeof sharedObjectiveMatches!=="function")
  return {ok:false,status:"PVE_DUO_NATIVE_API_UNAVAILABLE"};
 const owner=id(ticket.leader),peer=id(ticket.peerID),agent=id(ticket.agentID),
  fleet=id(ticket.fleetID),station=id(ticket.station);
 const a=ticket.leaderMission,b=ticket.peerMission;
 if(!owner||!peer||owner===peer||!agent||!fleet||!station||
    ![6,7].includes(Number(ticket.actionID))||
    !a||!b||a.runtimeStatus!=="accepted"||b.runtimeStatus!=="accepted"||
    a.objectiveMode!=="dungeon"||b.objectiveMode!=="dungeon"||
    a.objectiveCompleted!==true||b.objectiveCompleted!==true||
    a.gmCompleted===true||b.gmCompleted===true||
    a.importantMission===true||b.importantMission===true||
    a.storylineOfferProjection===true||b.storylineOfferProjection===true||
    id(a.agentID)!==agent||id(b.agentID)!==agent||
    !id(a.missionSequence)||!id(b.missionSequence)||
    id(a.missionSequence)===id(b.missionSequence)||
    !id(a.missionSystemID)||id(b.missionSystemID)!==id(a.missionSystemID)||
    !tag(a.contentID)||!tag(a.missionTemplateID)||
    tag(a.contentID)!==tag(b.contentID)||
    tag(a.missionTemplateID)!==tag(b.missionTemplateID)||
    !id(a.dungeonInstanceID)||
    (id(b.dungeonInstanceID)&&
     id(b.dungeonInstanceID)===id(a.dungeonInstanceID)&&
     !b.coopSharedDungeon))
  return {ok:false,status:"PVE_DUO_NOT_TWO_INDEPENDENT_COMPLETED_NATIVE_MISSIONS"};
 if(ticket.session===ticket.peer||id(ticket.session?.characterID)!==owner||
    id(ticket.peer?.characterID)!==peer||
    !ticket.session?.socket||!ticket.peer?.socket||
    ticket.session.socket.destroyed===true||
    ticket.peer.socket.destroyed===true)
  return {ok:false,status:"PVE_DUO_NATIVE_RECIPIENT_SESSIONS_INVALID"};
 const sourceID=id(a.dungeonInstanceID);
 let instance=null;
 try{instance=getInstance(sourceID)}catch{}
 const metadata=instance?.metadata||{},ownership=instance?.ownership||{};
 const listedOwners=[ownership.missionOwnerCharacterID,
  metadata.missionCharacterID,ownership.characterID]
  .map(id).filter(Boolean);
 const lifecycle=String(instance?.lifecycleState||"").toLowerCase(),
  objective=instance?.objectiveState||{},
  nativeCompleted=String(objective.state||"").toLowerCase()==="completed"||
   (Number.isSafeInteger(objective.completedAtMs)&&objective.completedAtMs>0)||
   lifecycle==="completed";
 if(!instance||id(instance.instanceID)!==sourceID||
    id(instance.solarSystemID)!==id(a.missionSystemID)||
    listedOwners.length===0||listedOwners.some(x=>x!==owner)||
    id(metadata.missionAgentID)!==agent||!nativeCompleted)
  return {ok:false,status:"PVE_DUO_ORIGINAL_DUNGEON_COMPLETION_UNPROVEN"};
 const request={ownerID:owner,peerID:peer,agentID:agent,
  leaderMission:a,peerMission:b,sourceInstanceID:sourceID};
 let link=null,shared=false;
 try{
  link=verifyLink(request);
  shared=sharedObjectiveMatches(request)===true;
 }catch{return {ok:false,status:"PVE_DUO_PROVENANCE_AUTHORITY_UNAVAILABLE"}}
 if(!link?.ok)return {ok:false,status:"PVE_DUO_DURABLE_INSTANCE_LINK_UNVERIFIED",
  reason:String(link?.status||"MISSING").slice(0,100)};
 if(!shared)return {ok:false,status:"PVE_DUO_PEER_NATIVE_SHARED_OBJECTIVE_UNVERIFIED"};
 return {ok:true,status:"PVE_DUO_NATIVE_REWARD_PREFLIGHT_READY",fleetID:fleet,
  leaderID:owner,peerID:peer,agentID:agent,stationID:station,
  sourceInstanceID:sourceID,missionSystemID:id(a.missionSystemID),
  leaderSequence:id(a.missionSequence),peerSequence:id(b.missionSequence),
  contentID:tag(a.contentID),missionTemplateID:tag(a.missionTemplateID),
  // This proof only authorizes the existing native TWO payouts; it
  // intentionally does NOT assert wallet/LP/standing balances changed.
  evidence:"ORIGINAL_DUNGEON_AND_TWO_ACCEPTED_NATIVE_MISSIONS_AND_DURABLE_SHARED_OBJECTIVE"};
}
function checkPeerBeforeNativePayout({ticket,currentPeer,preflight,
 verifyLink,sharedObjectiveMatches,flags={}}={}){
 // Native leader DoAction purges its own original dungeon instance after
 // reward! Requiring a *live instance* again here would strand the peer.
 // Instead preserve pre-LEADER-payout proof and independently revalidate
 // the durable immutable source link and native peer shared receipt.
 const configured=checkConfiguration(flags);
 if(!configured.ok)return configured;
 if(!preflight?.ok||preflight.status!=="PVE_DUO_NATIVE_REWARD_PREFLIGHT_READY"||
    !ticket?.ok||typeof verifyLink!=="function"||
    typeof sharedObjectiveMatches!=="function"||!currentPeer)
  return {ok:false,status:"PVE_DUO_PREFLIGHT_NOT_PRESENT"};
 const leader=ticket.leaderMission;
 if(id(ticket.leader)!==preflight.leaderID||
    id(ticket.peerID)!==preflight.peerID||
    id(ticket.fleetID)!==preflight.fleetID||
    id(ticket.agentID)!==preflight.agentID||
    id(ticket.station)!==preflight.stationID||
    id(leader?.dungeonInstanceID)!==preflight.sourceInstanceID||
    id(leader?.missionSequence)!==preflight.leaderSequence||
    id(currentPeer?.missionSequence)!==preflight.peerSequence||
    id(currentPeer?.agentID)!==preflight.agentID||
    id(currentPeer?.missionSystemID)!==preflight.missionSystemID||
    tag(currentPeer.contentID)!==preflight.contentID||
    tag(currentPeer.missionTemplateID)!==preflight.missionTemplateID||
    currentPeer.runtimeStatus!=="accepted"||
    currentPeer.objectiveMode!=="dungeon"||
    currentPeer.objectiveCompleted!==true||
    currentPeer.gmCompleted===true||
    ticket.session===ticket.peer||
    id(ticket.session?.characterID)!==preflight.leaderID||
    id(ticket.peer?.characterID)!==preflight.peerID||
    !ticket.session?.socket||!ticket.peer?.socket||
    ticket.session.socket.destroyed===true||
    ticket.peer.socket.destroyed===true)
  return {ok:false,status:"PVE_DUO_NATIVE_RECIPIENT_CHANGED_AFTER_LEADER"};
 const request={ownerID:preflight.leaderID,peerID:preflight.peerID,
  agentID:preflight.agentID,leaderMission:leader,peerMission:currentPeer,
  sourceInstanceID:preflight.sourceInstanceID};
 let link,shared=false;
 try{
  link=verifyLink(request);
  shared=sharedObjectiveMatches(request)===true;
 }catch{return {ok:false,status:"PVE_DUO_PROVENANCE_AUTHORITY_UNAVAILABLE"}}
 if(!link?.ok||!shared)return {ok:false,
  status:!link?.ok?"PVE_DUO_DURABLE_INSTANCE_LINK_UNVERIFIED":
   "PVE_DUO_PEER_NATIVE_SHARED_OBJECTIVE_UNVERIFIED"};
 return {ok:true,status:"PVE_DUO_PEER_NATIVE_REWARD_ALLOWED",
  sourceInstanceID:preflight.sourceInstanceID};
}
function defaultDependencies(){
 const source=require("../services/dungeon/dungeonRuntime"),
  provenance=require("./coopMissionInstanceProvenance");
 return {getInstance:id=>source.getInstance(id),
  verifyLink:opts=>provenance.verify(opts),
  sharedObjectiveMatches:opts=>provenance.nativeSharedObjectiveMatches(opts),
  flags:process.env};
}
function preflight(ticket){
 try{return validate({ticket,...defaultDependencies()})}
 catch{return {ok:false,status:"PVE_DUO_NATIVE_API_UNAVAILABLE"}}
}
function beforePeer(ticket,currentPeer){
 try{return checkPeerBeforeNativePayout({
  ticket,currentPeer,preflight:ticket?._pveRewardPreflight,...defaultDependencies()
 })}
 catch{return {ok:false,status:"PVE_DUO_NATIVE_API_UNAVAILABLE"}}
}
module.exports={checkConfiguration,validate,checkPeerBeforeNativePayout,
 preflight,beforePeer};
