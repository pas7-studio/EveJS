"use strict";
// Explicit player-owned native mission instance correspondence. This is a
// durable *permission* receipt, never a mission/reward/inventory writer.
const fs=require("node:fs"),path=require("node:path");
const DEFAULT_FILE="/var/lib/evejs/coop-mission-instance-links.jsonl";
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const str=x=>typeof x==="string"||typeof x==="number"?String(x).trim():"";
const fields=["v","peerID","agentID","peerSequence","ownerID","leaderSequence",
 "sourceInstanceID","systemID","contentID","missionTemplateID"];
const numbers=["peerID","agentID","peerSequence","ownerID","leaderSequence",
 "sourceInstanceID","systemID"];
function filePath(file){
 const p=file||process.env.EVEJS_COOP_MISSION_INSTANCE_LINK_FILE||DEFAULT_FILE;
 return typeof p==="string"&&path.isAbsolute(p)?p:null;
}
function identity({peerID,agentID,peerMission,ownerID,leaderMission}={}){
 const a={v:1,peerID:id(peerID),agentID:id(agentID),
  peerSequence:id(peerMission?.missionSequence),ownerID:id(ownerID),
  leaderSequence:id(leaderMission?.missionSequence),
  sourceInstanceID:id(leaderMission?.dungeonInstanceID),
  systemID:id(leaderMission?.missionSystemID),
  contentID:str(leaderMission?.contentID),
  missionTemplateID:str(leaderMission?.missionTemplateID)};
 if(numbers.some(k=>!a[k])||a.peerID===a.ownerID||
   !a.contentID||!a.missionTemplateID||
   id(leaderMission?.agentID)!==a.agentID||
   id(peerMission?.agentID)!==a.agentID||
   str(peerMission?.contentID)!==a.contentID||
   str(peerMission?.missionTemplateID)!==a.missionTemplateID||
   id(peerMission?.missionSystemID)!==null&&
   id(peerMission?.missionSystemID)!==a.systemID||
   leaderMission?.runtimeStatus!=="accepted"||
   peerMission?.runtimeStatus!=="offered"||
   leaderMission?.objectiveMode!=="dungeon"||
   peerMission?.objectiveMode!=="dungeon"||
   leaderMission?.gmCompleted===true||peerMission?.gmCompleted===true)
  return null;
 return a;
}
function peerKey(x){return [x.peerID,x.agentID,x.peerSequence].join(":");}
function leaderKey(x){return [x.ownerID,x.agentID,x.leaderSequence,x.sourceInstanceID].join(":");}
function signature(x){return JSON.stringify(fields.map(k=>x[k]));}
function read(file){
 const p=filePath(file);if(!p)return {status:"INVALID_LINK_PATH"};
 let data;
 try{data=fs.readFileSync(p,"utf8");}catch(e){
  if(e?.code==="ENOENT")return {status:"READY",links:[]};
  return {status:"LINK_LEDGER_UNAVAILABLE"};
 }
 if(Buffer.byteLength(data,"utf8")>8*1024*1024||
  (data.length&&!data.endsWith("\n")))return {status:"LINK_LEDGER_CORRUPT"};
 const links=[],seenPeers=new Map(),seenLeaders=new Map();
 for(const line of data.split("\n")){
  if(!line)continue;
  let row;try{row=JSON.parse(line);}catch{return {status:"LINK_LEDGER_CORRUPT"};}
  if(!row||row.v!==1||numbers.some(k=>!id(row[k])||id(row[k])!==row[k])||
   row.ownerID===row.peerID||!str(row.contentID)||
   !str(row.missionTemplateID)||str(row.contentID)!==row.contentID||
   str(row.missionTemplateID)!==row.missionTemplateID||
   fields.some(k=>!(k in row))||Object.keys(row).some(k=>
    !fields.includes(k)&&k!=="at")||
   !Number.isSafeInteger(row.at)||row.at<0)
   return {status:"LINK_LEDGER_CORRUPT"};
  const pkey=peerKey(row),lkey=leaderKey(row),sig=signature(row);
  if((seenPeers.has(pkey)&&seenPeers.get(pkey)!==sig)||
     (seenLeaders.has(lkey)&&seenLeaders.get(lkey)!==sig))
   return {status:"LINK_LEDGER_CONFLICT"};
  if(seenPeers.has(pkey))continue;
  seenPeers.set(pkey,sig);seenLeaders.set(lkey,sig);links.push(row);
 }
 return {status:"READY",links};
}
function durableAppend(file,row){
 let fd,dirfd;
 try{
  const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true});
  fd=fs.openSync(file,"a",0o600);
  const b=Buffer.from(JSON.stringify({...row,at:Date.now()})+"\n");
  if(fs.writeSync(fd,b,0,b.length,null)!==b.length)return false;
  fs.fsyncSync(fd);
  // Persist the new directory entry as well as the file contents.
  dirfd=fs.openSync(dir,"r");fs.fsyncSync(dirfd);
  return true;
 }catch{return false}
 finally{
  if(fd!==undefined)try{fs.closeSync(fd)}catch{}
  if(dirfd!==undefined)try{fs.closeSync(dirfd)}catch{}
 }
}
function record({peerID,agentID,peerMission,ownerID,leaderMission,file}={}){
 const row=identity({peerID,agentID,peerMission,ownerID,leaderMission});
 if(!row)return {status:"NATIVE_INSTANCE_LINK_INVALID"};
 const p=filePath(file),previous=read(p);
 if(previous.status!=="READY")return previous;
 const own=previous.links.find(x=>peerKey(x)===peerKey(row));
 const lead=previous.links.find(x=>leaderKey(x)===leaderKey(row));
 if((own&&signature(own)!==signature(row))||
    (lead&&signature(lead)!==signature(row)))return {status:"NATIVE_INSTANCE_LINK_CONFLICT"};
 if(own&&lead)return {status:"NATIVE_INSTANCE_LINK_ALREADY_RECORDED"};
 if(!p||!durableAppend(p,row))return {status:"NATIVE_INSTANCE_LINK_WRITE_UNCERTAIN"};
 const checked=read(p);
 if(checked.status!=="READY"||
   !checked.links.some(x=>peerKey(x)===peerKey(row)&&signature(x)===signature(row)))
  return {status:"NATIVE_INSTANCE_LINK_WRITE_UNCERTAIN"};
 return {status:"NATIVE_INSTANCE_LINK_RECORDED"};
}
function verify({peerID,agentID,peerMission,ownerID,leaderMission,
 sourceInstanceID,file}={}){
 if(!id(peerID)||!id(ownerID)||peerID===ownerID||!id(agentID)||
  !peerMission||!leaderMission||
  peerMission.runtimeStatus!=="accepted"||
  leaderMission.runtimeStatus!=="accepted"||
  peerMission.objectiveMode!=="dungeon"||
  leaderMission.objectiveMode!=="dungeon"||
  peerMission.gmCompleted===true||leaderMission.gmCompleted===true)
  return {ok:false,status:"NATIVE_ACCEPTED_INSTANCE_REQUIRED"};
 const row=identity({peerID,agentID,peerMission:{...peerMission,runtimeStatus:"offered"},
  ownerID,leaderMission});
 if(!row||(sourceInstanceID!==undefined&&sourceInstanceID!==null&&
  id(sourceInstanceID)!==row.sourceInstanceID))
  return {ok:false,status:"NATIVE_INSTANCE_LINK_MISMATCH"};
 const ledger=read(file);
 if(ledger.status!=="READY")return {ok:false,status:ledger.status};
 const matching=ledger.links.filter(x=>peerKey(x)===peerKey(row));
 if(matching.length!==1||signature(matching[0])!==signature(row))
  return {ok:false,status:"NATIVE_INSTANCE_LINK_NOT_PROVED"};
 if(ledger.links.some(x=>leaderKey(x)===leaderKey(row)&&
  signature(x)!==signature(row)))return {ok:false,status:"NATIVE_INSTANCE_LINK_CONFLICT"};
 return {ok:true,status:"NATIVE_INSTANCE_LINK_VERIFIED",link:{...matching[0]}};
}
function nativeSharedObjectiveMatches({ownerID,agentID,leaderMission,peerMission}={}){
 const receipt=peerMission?.coopSharedDungeon;
 return Boolean(receipt&&id(ownerID)&&id(agentID)&&
  id(leaderMission?.dungeonInstanceID)&&
  id(receipt.ownerID)===id(ownerID)&&
  id(receipt.agentID)===id(agentID)&&
  id(receipt.sourceInstanceID)===id(leaderMission.dungeonInstanceID)&&
  str(receipt.contentID)===str(leaderMission?.contentID)&&
  str(receipt.missionTemplateID)===str(leaderMission?.missionTemplateID)&&
  peerMission?.objectiveCompleted===true&&
  peerMission?.runtimeStatus==="accepted"&&
  peerMission?.gmCompleted!==true);
}
module.exports={record,verify,read,identity,nativeSharedObjectiveMatches,DEFAULT_FILE};
