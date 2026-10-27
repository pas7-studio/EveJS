"use strict";
// Persistent capsule/clone recovery for autonomous NPCs after real ship losses.
// Ship destruction comes ONLY from the authoritative native EveJS wreck hook.
const fs=require("node:fs"),path=require("node:path");
const valid=id=>typeof id==="string"&&/^coop-pilot-[0-9]{3,}$/.test(id);
const positive=n=>Number.isSafeInteger(Number(n))&&Number(n)>0;
function createLife({file,clock=()=>Date.now(),recoveryMs=1800000}){
 if(!file||!Number.isSafeInteger(recoveryMs)||recoveryMs<60000)throw Error("invalid NPC life settings");
 let state={version:1,pilots:{},wrecks:{}};
 try{const saved=JSON.parse(fs.readFileSync(file,"utf8"));if(saved?.version!==1||!saved.pilots||!saved.wrecks)throw Error("invalid NPC life state");state=saved;}
 catch(e){if(e.code!=="ENOENT")throw e;}
 const persist=()=>{
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+".tmp-"+process.pid;
  fs.writeFileSync(tmp,JSON.stringify(state));fs.renameSync(tmp,file);
 };
 function markLoss({pilotID,systemID,shipID,wreckID}){
  if(!valid(pilotID)||![systemID,shipID,wreckID].every(positive))return {status:"INVALID"};
  const key=String(wreckID);
  if(state.wrecks[key])return {status:"DUPLICATE",...state.wrecks[key]};
  const now=clock();
  const prior=state.pilots[pilotID]||{lossCount:0};
  const entry={pilotID,systemID:Number(systemID),shipID:Number(shipID),wreckID:Number(wreckID),lostAt:now,readyAt:now+recoveryMs};
  state.wrecks[key]=entry;
  state.pilots[pilotID]={status:"RECOVERING",lossCount:(prior.lossCount||0)+1,readyAt:entry.readyAt,lastLoss:entry};
  persist();
  return {status:"RECOVERING",...entry};
 }
 function canFly(pilotID){
  const p=state.pilots[pilotID];
  return valid(pilotID)&&(!p||p.status!=="RECOVERING"||clock()>=Number(p.readyAt));
 }
 function recover(pilotID){
  if(!valid(pilotID))return {status:"INVALID"};
  const p=state.pilots[pilotID];
  if(!p||p.status!=="RECOVERING")return {status:"ACTIVE"};
  if(!canFly(pilotID))return {status:"RECOVERING",readyAt:p.readyAt};
  p.status="ACTIVE";p.recoveredAt=clock();persist();return {status:"ACTIVE",lossCount:p.lossCount};
 }
 return {markLoss,canFly,recover,snapshot:()=>structuredClone(state)};
}
module.exports={createLife};
