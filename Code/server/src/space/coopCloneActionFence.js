"use strict";
// Crash-stop, per-character clone/implant/booster operation journal.  Requires
// native side effect callbacks; never repairs game state or fabricates items.
const fs=require("node:fs"),path=require("node:path");
const pos=x=>{const n=Number(x);return Number.isSafeInteger(n)&&n>0?n:0};
const safe=x=>typeof x==="string"&&/^[a-zA-Z0-9_.:-]{1,120}$/.test(x);
const OPS=new Set(["INSTALL_CLONE","CLONE_JUMP","IMPLANT","BOOSTER","HOME_STATION","POD_DEATH"]);
function createCloneActionFence({file,storage=fs,clock=()=>Date.now()}={}){
 if(typeof file!=="string"||!path.isAbsolute(file)||typeof clock!=="function"||
  !storage||["readFileSync","mkdirSync","openSync","writeSync","fsyncSync","closeSync","unlinkSync"].some(x=>typeof storage[x]!=="function"))
  throw Error("DURABLE_NATIVE_CLONE_FENCE_REQUIRED");
 let unsafe=false;const lock=file+".lock";
 const keyOf=proof=>{
  if(!proof?.ok||!OPS.has(proof.kind)||!pos(proof.characterID))return null;
  let identity;
  switch(proof.kind){
   case "INSTALL_CLONE":
    if(!pos(proof.locationID)||!Array.isArray(proof.previousCloneIDs))return null;
    identity=[proof.locationID,[...proof.previousCloneIDs].sort((a,b)=>a-b)];break;
   case "CLONE_JUMP":
    if(!pos(proof.cloneID)||!pos(proof.sourceLocationID)||!pos(proof.destinationLocationID)||
     !/^\d+$/.test(String(proof.previousLastJump??"")))return null;
    identity=[proof.cloneID,proof.sourceLocationID,proof.destinationLocationID,
     String(proof.previousLastJump)];break;
   case "IMPLANT":case "BOOSTER":
    if(!pos(proof.itemID))return null;identity=[proof.itemID];break;
   case "HOME_STATION":
    if(!pos(proof.homeStationID)||!pos(proof.previousHomeStationID))return null;
    identity=[proof.previousHomeStationID,proof.homeStationID];break;
   case "POD_DEATH":
    if(!safe(proof.deathEventID))return null;identity=[proof.deathEventID];break;
  }
  return JSON.stringify([proof.kind,proof.characterID,...identity]);
 };
 function load(){
  let data;
  try{data=storage.readFileSync(file,"utf8")}
  catch(e){if(e.code==="ENOENT")return new Map();throw e}
  if(typeof data!=="string"||(data&&!data.endsWith("\n")))
   throw Error("INCOMPLETE_CLONE_JOURNAL");
  const rows=new Map();
  for(const line of data.split("\n").filter(Boolean)){
   let record;try{record=JSON.parse(line)}catch{throw Error("INVALID_CLONE_JOURNAL_JSON")}
   if(record?.version!==1||!Number.isFinite(record.at)||
    typeof record.key!=="string"||!["PREPARED","SETTLED","UNKNOWN"].includes(record.state))
    throw Error("INVALID_CLONE_JOURNAL_ENTRY");
   const prev=rows.get(record.key);
   if(!prev&&record.state!=="PREPARED")throw Error("INVALID_CLONE_JOURNAL_START");
   if(prev&&(prev.state!=="PREPARED"||record.state==="PREPARED"))
    throw Error("INVALID_CLONE_JOURNAL_TRANSITION");
   rows.set(record.key,record);
  }
  return rows;
 }
 function append(record){
  const dir=path.dirname(file);storage.mkdirSync(dir,{recursive:true});
  const fd=storage.openSync(file,"a",0o600);
  try{
   const buffer=Buffer.from(JSON.stringify(record)+"\n","utf8");
   let offset=0;
   while(offset<buffer.length){
    const written=storage.writeSync(fd,buffer,offset,buffer.length-offset);
    if(!Number.isSafeInteger(written)||written<=0)throw Error("INCOMPLETE_CLONE_WRITE");
    offset+=written;
   }
   storage.fsyncSync(fd);
  }finally{storage.closeSync(fd)}
  const d=storage.openSync(dir,"r");
  try{storage.fsyncSync(d)}finally{storage.closeSync(d)}
 }
 function locked(fn){
  if(unsafe)return {status:"NATIVE_CLONE_JOURNAL_UNSAFE"};
  let fd=null;
  try{
   storage.mkdirSync(path.dirname(file),{recursive:true});
   fd=storage.openSync(lock,"wx",0o600);
   const buf=Buffer.from(JSON.stringify({pid:process.pid,at:clock()}));
   storage.writeSync(fd,buf,0,buf.length);storage.fsyncSync(fd);
   storage.closeSync(fd);fd=null;
  }catch{
   if(fd!==null){try{storage.closeSync(fd)}catch{}}
   unsafe=true;return {status:"NATIVE_CLONE_LOCK_UNAVAILABLE"};
  }
  let result;
  try{result=fn()}catch(e){unsafe=true;result={
   status:"NATIVE_CLONE_REPAIR_REQUIRED",reason:String(e?.message||e).slice(0,140)}}
  finally{try{storage.unlinkSync(lock)}catch{unsafe=true}}
  return unsafe?{status:"NATIVE_CLONE_REPAIR_REQUIRED"}:result;
 }
 function inspect(proof){
  const key=keyOf(proof);if(!key)return {status:"INVALID_NATIVE_CLONE_PROOF"};
  return locked(()=>{
   const previous=load().get(key);
   return {status:!previous?"NEW_NATIVE_CLONE_ACTION":previous.state==="SETTLED"?
    "NATIVE_CLONE_ACTION_ALREADY_SETTLED":"NATIVE_CLONE_MANUAL_RECONCILIATION"};
  });
 }
 function execute({proof,captureNative,nativeExecute,verifyNative}={}){
  const key=keyOf(proof);
  if(!key||typeof captureNative!=="function"||
   typeof nativeExecute!=="function"||typeof verifyNative!=="function")
   return {status:"INVALID_NATIVE_CLONE_EXECUTION"};
  const begin=locked(()=>{
   if(load().has(key))return {status:"NATIVE_CLONE_MANUAL_RECONCILIATION_OR_REPLAY"};
   append({version:1,key,state:"PREPARED",at:clock()});
   return {status:"PREPARED"};
  });
  if(begin.status!=="PREPARED")return begin;
  let before=null,result,nativeError=null,verified=false;
  try{before=captureNative(proof)}catch{nativeError="NATIVE_CLONE_PRE_SNAPSHOT_FAILED"}
  if(!before||typeof before!=="object")
   nativeError="NATIVE_CLONE_PRE_SNAPSHOT_UNAVAILABLE";
  if(!nativeError){
   try{result=nativeExecute()}catch(e){nativeError=String(e?.message||e).slice(0,140)}
  }
  if(!nativeError){
   try{verified=verifyNative({proof,before,nativeResult:result})?.ok===true}
   catch{verified=false}
  }
  const done=locked(()=>{
   const event=load().get(key);
   if(event?.state!=="PREPARED")return {status:"NATIVE_CLONE_MANUAL_RECONCILIATION"};
   append({version:1,key,state:verified?"SETTLED":"UNKNOWN",at:clock()});
   return {status:verified?"NATIVE_CLONE_ACTION_SETTLED":
    "NATIVE_CLONE_MANUAL_RECONCILIATION"};
  });
  return nativeError?{...done,nativeError}:done;
 }
 return {inspect,execute};
}
module.exports={createCloneActionFence};
