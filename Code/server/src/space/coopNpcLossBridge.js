"use strict";
// Exactly-once economic consequence of a confirmed native NPC wreck.
// Only the authoritative EveJS wreck record is valid evidence of death.
const fs=require("node:fs"),path=require("node:path");
function createLossBridge({file,recordLoss}){
 if(!file||typeof recordLoss!=="function")throw Error("file and recordLoss required");
 let state={version:1,processed:{}};
 try{state=JSON.parse(fs.readFileSync(file,"utf8"));if(state.version!==1||!state.processed)throw Error("invalid loss ledger");}
 catch(e){if(e.code!=="ENOENT")throw e;}
 const persist=()=>{
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+".tmp-"+process.pid;
  fs.writeFileSync(tmp,JSON.stringify(state));fs.renameSync(tmp,file);
 };
 function accept({systemID,npcID,wreckID,pilotID=null}){
  for(const v of [systemID,npcID,wreckID])if(!Number.isSafeInteger(Number(v))||Number(v)<=0)return {status:"INVALID"};
  const key=String(wreckID);
  if(state.processed[key])return {status:"DUPLICATE"};
  // Reserve before changing the economy to prefer no duplicate loss to
  // repeated loss after a crash. An incomplete ledger entry is inspectable.
  state.processed[key]={systemID:Number(systemID),npcID:Number(npcID),pilotID,status:"PENDING"};
  persist();
  try{
   recordLoss(Number(systemID),1);
   state.processed[key].status="COMMITTED";
   persist();
   return {status:"COMMITTED"};
  }catch(e){return {status:"PENDING",error:e.message};}
 }
 return {accept,snapshot:()=>structuredClone(state)};
}
module.exports={createLossBridge};
