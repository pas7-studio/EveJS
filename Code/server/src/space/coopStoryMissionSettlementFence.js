"use strict";
// Durable pre-grant fence for personal authored mission rewards.
// A PREPARED/UNKNOWN result never authorizes another EveJS payout; no
// shadow ISK, LP, item or standing writer is ever invoked here.
const fs=require("node:fs"),path=require("node:path");
const id=x=>{const n=Number(x);return Number.isSafeInteger(n)&&n>0?n:null};
const content=x=>typeof x==="number"&&Number.isSafeInteger(x)&&x>=0?String(x):
 typeof x==="string"&&/^[a-zA-Z0-9_./:-]{1,160}$/.test(x)?x:null;
const states=new Set(["PREPARED","SETTLED","UNKNOWN"]);
function createStoryMissionSettlementFence({file,clock=()=>Date.now(),storage=fs}={}){
 if(typeof file!=="string"||!path.isAbsolute(file)||
  typeof clock!=="function"||!storage||
  ["readFileSync","openSync","writeSync","fsyncSync","closeSync","unlinkSync","mkdirSync"].some(k=>typeof storage[k]!=="function"))
  throw Error("DURABLE_STORY_MISSION_FENCE_REQUIRED");
 const lockFile=file+".lock",outstanding=new Map();
 let unsafe=false;
 const keyFor=({characterID,agentID,missionSequence,contentID,missionTemplateID,kind="COMPLETE"}={})=>{
  const c=id(characterID),a=id(agentID),s=id(missionSequence),m=content(contentID);
  if(!["COMPLETE","ACCEPT_GIFT"].includes(kind)||!c||!a||!s||m===null||
   typeof missionTemplateID!=="string"||
   !missionTemplateID||missionTemplateID.length>256)return null;
  return JSON.stringify([kind,c,a,s,m,missionTemplateID]);
 };
 function load(){
  let body;
  try{body=storage.readFileSync(file,"utf8")}
  catch(e){if(e.code==="ENOENT")return new Map();throw e;}
  if(typeof body!=="string"||body && !body.endsWith("\n"))
   throw Error("INCOMPLETE_STORY_MISSION_JOURNAL");
  const entries=new Map();
  for(const line of body.split("\n").filter(Boolean)){
   let event;
   try{event=JSON.parse(line)}catch{throw Error("CORRUPT_STORY_MISSION_JOURNAL")}
   if(event?.version!==1||!states.has(event.state)||
    typeof event.key!=="string"||!Number.isFinite(event.at))
    throw Error("INVALID_STORY_MISSION_JOURNAL_EVENT");
   const previous=entries.get(event.key);
   if(previous&&previous.state!=="PREPARED")
    throw Error("INVALID_STORY_MISSION_STATE_REPLAY");
   if(previous&&event.state==="PREPARED")
    throw Error("DUPLICATE_STORY_MISSION_PREPARE");
   if(!previous&&event.state!=="PREPARED")
    throw Error("STORY_MISSION_JOURNAL_TRANSITION_MISSING");
   entries.set(event.key,event);
  }
  return entries;
 }
 function append(event){
  const dir=path.dirname(file);
  storage.mkdirSync(dir,{recursive:true});
  const fd=storage.openSync(file,"a",0o600);
  try{
   const line=JSON.stringify(event)+"\n";
   storage.writeSync(fd,line);
   storage.fsyncSync(fd);
  }finally{storage.closeSync(fd)}
  const d=storage.openSync(dir,"r");
  try{storage.fsyncSync(d)}finally{storage.closeSync(d)}
 }
 function locked(run){
  if(unsafe)return {status:"STORY_MISSION_FENCE_UNSAFE"};
  let fd=null;
  try{
   storage.mkdirSync(path.dirname(file),{recursive:true});
   fd=storage.openSync(lockFile,"wx",0o600);
   storage.writeSync(fd,JSON.stringify({purpose:"SCRIPTED_MISSION_SETTLEMENT",at:clock()}));
   storage.fsyncSync(fd);
   storage.closeSync(fd);fd=null;
  }catch{
   if(fd!==null){try{storage.closeSync(fd)}catch{}}
   unsafe=true;
   return {status:"STORY_MISSION_FENCE_LOCK_UNAVAILABLE"};
  }
  let output;
  try{output=run()}catch(e){
   unsafe=true;
   output={status:"STORY_MISSION_FENCE_REPAIR_REQUIRED",
    reason:String(e?.message||e).slice(0,160)};
  }finally{
   try{storage.unlinkSync(lockFile)}
   catch{unsafe=true}
  }
  return unsafe?{status:"STORY_MISSION_FENCE_REPAIR_REQUIRED"}:output;
 }
 function begin({preflight,mission,kind="COMPLETE"}={}){
  const key=keyFor({...mission,kind});
  const reason=kind==="COMPLETE"?"PERSONAL_COMPLETE_PREFLIGHT_ONLY":
   kind==="ACCEPT_GIFT"?"PERSONAL_ACCEPT_AUTHORIZED":null;
  if(!key||!reason||preflight?.ok!==true||
   preflight.reason!==reason||
   (kind==="COMPLETE"?
    preflight.rewardAtomicityVerified!==false:
    preflight.giftAtomicityVerified!==false)||
   id(preflight.characterID)!==id(mission.characterID)||
   id(preflight.agentID)!==id(mission.agentID)||
   id(preflight.missionSequence)!==id(mission.missionSequence)||
   content(preflight.contentID)!==content(mission.contentID)||
   preflight.missionTemplateID!==mission.missionTemplateID)
   return {status:"UNVERIFIED_NATIVE_MISSION_COMPLETION"};
  return locked(()=>{
   const events=load(),previous=events.get(key);
   if(previous)return {status:previous.state==="SETTLED"?
    "NATIVE_STORY_MISSION_ALREADY_SETTLED":
    "NATIVE_STORY_MISSION_REQUIRES_MANUAL_RECONCILIATION"};
   const ticket=Object.freeze({key,kind,characterID:id(mission.characterID),
    agentID:id(mission.agentID),missionSequence:id(mission.missionSequence),
    contentID:content(mission.contentID),
    missionTemplateID:mission.missionTemplateID});
   append({version:1,key,state:"PREPARED",at:clock()});
   outstanding.set(key,ticket);
   return {status:"PREPARED",ticket};
  });
 }
 function finish({ticket,nativeResult,readNativeState}={}){
  if(!ticket||outstanding.get(ticket.key)!==ticket||
   typeof readNativeState!=="function")
   return {status:"UNRECOGNIZED_STORY_MISSION_TICKET"};
  return locked(()=>{
   const row=load().get(ticket.key);
   if(row?.state!=="PREPARED")
    return {status:"NATIVE_STORY_MISSION_REQUIRES_MANUAL_RECONCILIATION"};
   let nativeState;
   try{nativeState=readNativeState(ticket.characterID)}
   catch{nativeState=null}
   const stillActive=nativeState?.missionsByAgentID?.[String(ticket.agentID)];
   const confirmed=Boolean(nativeResult?.success===true&&
    (ticket.kind==="COMPLETE"?
     !stillActive&&positiveHistory(nativeState?.history,ticket):
     stillActive&&id(stillActive.missionSequence)===ticket.missionSequence&&
      content(stillActive.contentID)===ticket.contentID&&
      stillActive.missionTemplateID===ticket.missionTemplateID&&
      stillActive.runtimeStatus==="accepted"));
   const nextState=confirmed?"SETTLED":"UNKNOWN";
   append({version:1,key:ticket.key,state:nextState,at:clock()});
   outstanding.delete(ticket.key);
   return {status:confirmed?"NATIVE_STORY_MISSION_SETTLED":
    "NATIVE_STORY_MISSION_REQUIRES_MANUAL_RECONCILIATION"};
  });
 }
 function positiveHistory(history,ticket){
  return Array.isArray(history)&&history.some(h=>
   id(h?.agentID)===ticket.agentID&&
   id(h?.missionSequence)===ticket.missionSequence&&
   content(h?.contentID)===ticket.contentID&&h.runtimeStatus==="completed");
 }
 function inspect(mission){
  const key=keyFor(mission);
  if(!key)return {status:"INVALID_STORY_MISSION_KEY"};
  return locked(()=>{
   const row=load().get(key);
   return {status:!row?"NOT_SEEN":row.state==="SETTLED"?
    "NATIVE_STORY_MISSION_ALREADY_SETTLED":
    "NATIVE_STORY_MISSION_REQUIRES_MANUAL_RECONCILIATION"};
  });
 }
 return {begin,finish,inspect};
}
module.exports={createStoryMissionSettlementFence};
