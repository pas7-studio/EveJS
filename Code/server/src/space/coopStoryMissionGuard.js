"use strict";
// Pure, default-OFF preflight for authored EveJS career/storyline/Epic Arc missions.
// This file neither modifies missionRuntimeState nor grants rewards.
// Pinned EveJS state / missionAuthority are authoritative; never use fleet
// membership, a client mission title or the last visited agent as proof.
const positive=value=>{
 const n=Number(value);
 return Number.isSafeInteger(n)&&n>0?n:null;
};
const identifier=value=>{
 if(typeof value==="number")return Number.isSafeInteger(value)&&value>=0?String(value):null;
 if(typeof value!=="string"||!value.trim())return null;
 const s=value.trim();
 return /^[a-zA-Z0-9_./:-]{1,160}$/.test(s)?s:null;
};
const has=(o,k)=>Boolean(o&&typeof o==="object"&&
 Object.prototype.hasOwnProperty.call(o,String(k)));
const active=(s)=>Boolean(s&&s.socket&&s.socket.destroyed!==true);
const status=(ok,reason,extra={})=>({ok,reason,...extra});
function classify(mission,agent){
 const epicArcID=positive(mission?.epicArcID);
 const epic=Boolean(mission?.isEpicArc===true||
  String(mission?.missionFlavor||"").toLowerCase()==="epicarc"||epicArcID);
 const storyline=Boolean(mission?.isStoryline===true||mission?.isGenericStoryline===true||
  agent?.importantMission===true);
 const career=Boolean(positive(agent?.careerID));
 const agentInteraction=Boolean(mission?.isAgentInteraction===true||
  mission?.isTalkToAgent===true||
  ["agentinteraction","talktoagent"].includes(String(mission?.missionKind||"").toLowerCase()));
 return {epic,storyline,career,agentInteraction,
  scripted:epic||storyline||career,epicArcID};
}
function filetimeFuture(value,nowFiletime){
 if(value===null||value===undefined||value==="")return {ok:true,future:false};
 if(typeof value!=="string"||!/^\d{16,20}$/.test(value))
  return {ok:false,reason:"INVALID_NATIVE_FILETIME"};
 let now;
 try{now=BigInt(nowFiletime());}catch{return {ok:false,reason:"INVALID_NATIVE_CLOCK"};}
 if(now<=0n)return {ok:false,reason:"INVALID_NATIVE_CLOCK"};
 return {ok:true,future:BigInt(value)>now};
}
function createStoryMissionGuard({
 getSessions,getCharacterRecord,getCharacterStateSnapshot,getAgentByID,
 getMissionByID,listAuthoredMissions,isMissionOfferAllowedForAgent,checkAgentEligibility,
 nowFiletime=()=>((BigInt(Date.now())*10000n)+116444736000000000n).toString()
}={}){
 const dependencies=[getSessions,getCharacterRecord,getCharacterStateSnapshot,
  getAgentByID,getMissionByID,listAuthoredMissions,isMissionOfferAllowedForAgent,checkAgentEligibility,nowFiletime];
 if(!dependencies.every(f=>typeof f==="function"))
  throw Error("NATIVE_STORY_MISSION_AUTHORITY_REQUIRED");
 function authority(session){
  const characterID=positive(session?.characterID),accountID=positive(session?.userid);
  if(!characterID||!accountID||!active(session))return status(false,"INVALID_NATIVE_SESSION");
  let sessions,character,state;
  try{
   sessions=getSessions();
   character=getCharacterRecord(characterID);
   state=getCharacterStateSnapshot(characterID);
  }catch{return status(false,"NATIVE_AUTHORITY_UNAVAILABLE");}
  if(!Array.isArray(sessions)||!sessions.includes(session)||
   sessions.filter(s=>active(s)&&positive(s.characterID)===characterID).length!==1)
   return status(false,"AMBIGUOUS_NATIVE_CHARACTER_SESSION");
  if(positive(character?.accountId)!==accountID)
   return status(false,"NATIVE_ACCOUNT_MISMATCH");
  if(positive(state?.characterID)!==characterID||
   !state?.missionsByAgentID||!Array.isArray(state?.history))
   return status(false,"NATIVE_MISSION_STATE_UNAVAILABLE");
  return status(true,"NATIVE_CHARACTER_VERIFIED",{characterID,state});
 }
 function canonical(missionID){
  const key=identifier(missionID);
  if(key===null)return null;
  let mission;
  try{mission=getMissionByID(missionID);}catch{return null;}
  return mission&&identifier(mission.missionID)===key?mission:null;
 }
 function agent(agentID){
  const id=positive(agentID);
  if(!id)return null;
  try{const row=getAgentByID(id);return positive(row?.agentID)===id?row:null;}
  catch{return null;}
 }
 function canAccess(characterID,agentRecord,mission){
  try{
   if(checkAgentEligibility(characterID,agentRecord)!==true)
    return status(false,"NATIVE_AGENT_ELIGIBILITY_NOT_MET");
   if(isMissionOfferAllowedForAgent(agentRecord,mission)!==true)
    return status(false,"NATIVE_MISSION_NOT_ALLOWLISTED");
  }catch{return status(false,"NATIVE_ELIGIBILITY_UNAVAILABLE");}
  return status(true,"NATIVE_ELIGIBLE");
 }
 function matchRuntime(record,agentID,missionID,expectedSequence){
  return Boolean(record&&positive(record.agentID)===agentID&&
   identifier(record.contentID)===identifier(missionID)&&
   positive(record.missionSequence)&&
   positive(record.missionSequence)===positive(expectedSequence)&&
   typeof record.missionTemplateID==="string"&&record.missionTemplateID.length>0);
 }
 function completedHistory(state,{missionSequence,agentID,contentID}){
  return state.history.some(h=>positive(h?.missionSequence)===positive(missionSequence)&&
   positive(h?.agentID)===positive(agentID)&&
   identifier(h?.contentID)===identifier(contentID)&&h?.runtimeStatus==="completed");
 }
 function cooldown(state,agentID){
  const t=filetimeFuture(state?.declineTimersByAgentID?.[String(agentID)],nowFiletime);
  return !t.ok?status(false,t.reason):t.future?
   status(false,"NATIVE_AGENT_COOLDOWN_ACTIVE"):status(true,"NO_COOLDOWN");
 }
 function epicReplay(state,mission){
  const arc=positive(mission?.epicArcID);
  if(!arc)return status(false,"EPIC_ARC_ID_UNVERIFIED");
  const last=state?.epicArcProgress?.completedArcsByID?.[String(arc)];
  if(!last)return status(true,"ARC_NOT_COMPLETED");
  const result=filetimeFuture(last.replayUntilFileTime,nowFiletime);
  if(!result.ok)return status(false,result.reason);
  if(!last.replayUntilFileTime)return status(false,"EPIC_ARC_REPLAY_UNVERIFIED");
  return result.future?status(false,"EPIC_ARC_REPLAY_COOLDOWN"):
   status(true,"EPIC_ARC_REPLAY_ELIGIBLE");
 }
 function edge(source,next){
  const sid=identifier(source?.missionID),nid=identifier(next?.missionID);
  if(!sid||!nid||sid===nid)return status(false,"INVALID_MISSION_EDGE");
  if(!Array.isArray(source.nextMissionIDs)||
   !source.nextMissionIDs.some(x=>identifier(x)===nid))
   return status(false,"NEXT_MISSION_NOT_AUTHORED_EDGE");
  const sa=positive(source.epicArcID),na=positive(next.epicArcID);
  if(sa||na){
   if(!sa||sa!==na)return status(false,"EPIC_ARC_BRANCH_MISMATCH");
  }
  if((source.isStoryline===true||source.isGenericStoryline===true)&&
   next.isEpicArc===true)return status(false,"STORYLINE_TO_EPIC_MISMATCH");
  return status(true,"AUTHORED_MISSION_EDGE");
 }
 function sourceCompletion(state,sourceAgentID,sourceMissionID,sourceSequence){
  const sid=positive(sourceAgentID),seq=positive(sourceSequence);
  const source=canonical(sourceMissionID);
  if(!sid||!seq||!source)return status(false,"SOURCE_MISSION_NOT_AUTHORED");
  // Only the most recently completed native mission can yield an
  // interrupted continuation. No stale source can resurrect rewards.
  const latest=state.history[0];
  if(!latest||latest.runtimeStatus!=="completed"||
   positive(latest.missionSequence)!==seq||
   positive(latest.agentID)!==sid||
   identifier(latest.contentID)!==identifier(sourceMissionID))
   return status(false,"NATIVE_SOURCE_COMPLETION_NOT_LATEST");
  if(!completedHistory(state,{missionSequence:seq,agentID:sid,contentID:sourceMissionID}))
   return status(false,"NATIVE_SOURCE_COMPLETION_MISSING");
  return status(true,"LATEST_NATIVE_SOURCE_COMPLETED",{source});
 }
 function targetAgent(mission){
  const agentID=positive(mission?.sourceAgentID)||positive(mission?.targetAgentID);
  return agentID?agent(agentID):null;
 }
 function check({session,action,agentID,missionID,expectedSequence,
  sourceAgentID,sourceMissionID,sourceSequence,nextMissionID}={}){
  if(!["offer","accept","complete","advance","recover"].includes(action))
   return status(false,"INVALID_SCRIPTED_MISSION_ACTION");
  const auth=authority(session);
  if(!auth.ok)return auth;
  const {characterID,state}=auth;
  if(action==="advance"||action==="recover"){
   const to=canonical(nextMissionID),from=canonical(sourceMissionID);
   if(!from||!to)return status(false,"MISSING_AUTHORED_CHAIN_STAGE");
   const fromAgent=agent(sourceAgentID),toAgent=targetAgent(to);
   if(!fromAgent||!toAgent||positive(toAgent.agentID)!==positive(agentID))
    return status(false,"AUTHORED_TARGET_AGENT_MISMATCH");
   const category=classify(from,fromAgent);
   if(!category.scripted)return status(false,"NOT_SCRIPTED_CHAIN");
   const linked=edge(from,to);
   if(!linked.ok)return linked;
   if(!classify(to,toAgent).scripted)
    return status(false,"NEXT_STAGE_NOT_SCRIPTED");
   const eligibility=canAccess(characterID,toAgent,to);
   if(!eligibility.ok)return eligibility;
   const wait=cooldown(state,toAgent.agentID);
   if(!wait.ok)return wait;
   const targetActive=state.missionsByAgentID[String(toAgent.agentID)];
   const sameSource=action==="advance"&&
    positive(toAgent.agentID)===positive(sourceAgentID)&&
    matchRuntime(targetActive,positive(sourceAgentID),sourceMissionID,sourceSequence);
   if(targetActive&&!sameSource)
    return status(false,"TARGET_AGENT_HAS_ACTIVE_NATIVE_MISSION");
   if(action==="recover"){
    const prev=sourceCompletion(state,sourceAgentID,sourceMissionID,sourceSequence);
    if(!prev.ok)return prev;
    if(state.missionsByAgentID[String(sourceAgentID)])
     return status(false,"SOURCE_AGENT_REUSED");
    return status(true,"NATIVE_CONTINUATION_OFFER_RECOVERABLE",{
     characterID,sourceSequence:positive(sourceSequence),
     nextMissionID:identifier(nextMissionID),nextAgentID:positive(agentID),
     personalProgressOnly:true});
   }
   const sourceRuntime=state.missionsByAgentID[String(sourceAgentID)];
   if(!matchRuntime(sourceRuntime,positive(sourceAgentID),sourceMissionID,sourceSequence)||
    sourceRuntime.runtimeStatus!=="accepted"||
    sourceRuntime.objectiveMode!=="agent")
    return status(false,"NATIVE_SOURCE_STAGE_NOT_ACCEPTED");
   if(completedHistory(state,{missionSequence:sourceSequence,
    agentID:sourceAgentID,contentID:sourceMissionID}))
    return status(false,"SOURCE_STAGE_ALREADY_COMPLETED");
   return status(true,"AUTHORED_CHAIN_ADVANCE_AUTHORIZED",{
    characterID,sourceSequence:positive(sourceSequence),
    nextMissionID:identifier(nextMissionID),nextAgentID:positive(agentID),
    personalProgressOnly:true});
  }
  const agentRecord=agent(agentID),mission=canonical(missionID);
  if(!agentRecord||!mission)return status(false,"AUTHORED_MISSION_UNAVAILABLE");
  const category=classify(mission,agentRecord);
  if(!category.scripted)return status(true,"ORDINARY_MISSION_OUT_OF_SCOPE",{skip:true});
  const nativeActive=state.missionsByAgentID[String(agentID)];
  if(action==="offer"){
   if(nativeActive)return status(false,"AGENT_ALREADY_HAS_NATIVE_MISSION");
   const eligibility=canAccess(characterID,agentRecord,mission);
   if(!eligibility.ok)return eligibility;
   const wait=cooldown(state,agentID);
   if(!wait.ok)return wait;
   const last=state.history[0];
   const predecessor=canonical(last?.contentID);
   const continuationEdge=predecessor?edge(predecessor,mission):null;
   const validContinuation=last?.runtimeStatus==="completed"&&
    continuationEdge?.ok===true&&
    positive(last.agentID)===positive(sourceAgentID)&&
    positive(last.missionSequence)===positive(sourceSequence)&&
    positive(sourceSequence)&&positive(sourceAgentID);
   let allAuthored;
   try{allAuthored=listAuthoredMissions();}catch{
    return status(false,"AUTHORED_GRAPH_UNAVAILABLE");
   }
   if(!Array.isArray(allAuthored))return status(false,"AUTHORED_GRAPH_UNAVAILABLE");
   const incoming=allAuthored.some(candidate=>{
    if(identifier(candidate?.missionID)===null||
      identifier(candidate?.missionID)===identifier(missionID))return false;
    if(category.epic&&positive(candidate?.epicArcID)!==category.epicArcID)return false;
    return Array.isArray(candidate?.nextMissionIDs)&&
     candidate.nextMissionIDs.some(next=>identifier(next)===identifier(missionID));
   });
   if(incoming&&!validContinuation)
    return status(false,"SCRIPTED_PREDECESSOR_NOT_VERIFIED");
   if(category.career&&state.completedCareerAgentIDs?.[String(agentID)]===true&&
    !validContinuation)
    return status(false,"CAREER_AGENT_ONCE_ONLY");
   if(category.epic){
    if(!category.epicArcID)return status(false,"EPIC_ARC_ID_UNVERIFIED");
    if(!validContinuation){
     const replay=epicReplay(state,mission);
     if(!replay.ok)return replay;
    }
   }
   if(category.storyline&&!category.epic&&!validContinuation){
    const pending=state.storylineProgress?.pendingOffersByAgentID?.[String(agentID)];
    if(!pending||identifier(pending.contentID)!==identifier(missionID)||
     pending.status!=="pending")return status(false,"STORYLINE_MILESTONE_OFFER_MISSING");
   }
   return status(true,"SCRIPTED_MISSION_OFFER_AUTHORIZED",{characterID,
    missionID:identifier(missionID),personalProgressOnly:true});
  }
  if(!matchRuntime(nativeActive,positive(agentID),missionID,expectedSequence))
   return status(false,"STALE_OR_DIFFERENT_NATIVE_MISSION");
  if(completedHistory(state,{missionSequence:expectedSequence,agentID,contentID:missionID}))
   return status(false,"NATIVE_STAGE_ALREADY_COMPLETED");
  if(action==="accept"){
   const eligibility=canAccess(characterID,agentRecord,mission);
   if(!eligibility.ok)return eligibility;
   if(nativeActive.runtimeStatus!=="offered")
    return status(false,"NATIVE_STAGE_NOT_OFFERED");
   return status(true,"PERSONAL_ACCEPT_AUTHORIZED",{
    characterID,agentID:positive(agentID),missionSequence:positive(expectedSequence),
    contentID:identifier(missionID),missionTemplateID:nativeActive.missionTemplateID,
    personalProgressOnly:true,giftAtomicityVerified:false});
  }
  if(nativeActive.runtimeStatus!=="accepted"||nativeActive.objectiveCompleted!==true)
   return status(false,"NATIVE_OBJECTIVE_NOT_COMPLETE");
  return status(true,"PERSONAL_COMPLETE_PREFLIGHT_ONLY",{
   characterID,agentID:positive(agentID),missionSequence:positive(expectedSequence),
   contentID:identifier(missionID),missionTemplateID:nativeActive.missionTemplateID,
   personalProgressOnly:true,rewardAtomicityVerified:false});
 }
 return {check,classify,authority};
}
module.exports={createStoryMissionGuard,classify,filetimeFuture};
