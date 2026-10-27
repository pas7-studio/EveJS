"use strict";
// Chat 27: write-ahead custody fence around EXISTING native EveJS industry.
// Does not debit wallet, consume minerals, mint products or modify GameStore.
// An ambiguous native result is quarantined, never automatically retried.
const fs=require("node:fs"),path=require("node:path");
const pos=x=>{const n=Number(x);return Number.isSafeInteger(n)&&n>0?n:0};
const FINAL=new Set(["SETTLED","UNKNOWN"]);
function makePlayerIndustryFence({file,storage=fs,clock=()=>Date.now()}={}){
 if(typeof file!=="string"||!path.isAbsolute(file)||
  !storage||typeof clock!=="function"||
  ["readFileSync","mkdirSync","openSync","writeSync","fsyncSync",
   "closeSync","unlinkSync"].some(k=>typeof storage[k]!=="function"))
  throw Error("PERSISTENT_NATIVE_INDUSTRY_JOURNAL_REQUIRED");
 let unsafe=false;
 const lockFile=file+".lock";
 const ticketScope=(proof)=>{
  if(!proof||proof.ok!==true||!pos(proof.ownerID)||
   !pos(proof.blueprintID)||!pos(proof.characterID))
   return null;
  if(proof.kind==="INSTALL"&&!proof.jobID)
   return JSON.stringify(["INSTALL",proof.ownerID,proof.blueprintID]);
  if(["DELIVER","CANCEL"].includes(proof.kind)&&pos(proof.jobID))
   return JSON.stringify([proof.kind,proof.ownerID,proof.jobID]);
  return null;
 };
 function read(){
  let body;
  try{body=storage.readFileSync(file,"utf8")}
  catch(e){if(e.code==="ENOENT")return new Map();throw e;}
  if(typeof body!=="string"||(body&&!body.endsWith("\n")))
   throw Error("INCOMPLETE_NATIVE_INDUSTRY_JOURNAL");
  const rows=new Map();
  for(const line of body.split("\n").filter(Boolean)){
   let event;
   try{event=JSON.parse(line)}catch{throw Error("INVALID_NATIVE_INDUSTRY_JOURNAL_JSON")}
   if(event?.version!==1||!event.scope||!pos(event.cycle)||
    !["PREPARED","SETTLED","UNKNOWN"].includes(event.status)||
    !Number.isFinite(event.at))
    throw Error("INVALID_NATIVE_INDUSTRY_JOURNAL_ENTRY");
   const prev=rows.get(event.scope);
   if(!prev){
    if(event.cycle!==1||event.status!=="PREPARED")
     throw Error("INVALID_NATIVE_INDUSTRY_JOURNAL_START");
   }else if(event.cycle===prev.cycle){
    if(prev.status!=="PREPARED"||!FINAL.has(event.status))
     throw Error("INVALID_NATIVE_INDUSTRY_JOURNAL_FINAL");
   }else if(event.cycle===prev.cycle+1){
    if(prev.status!=="SETTLED"||event.status!=="PREPARED")
     throw Error("INVALID_NATIVE_INDUSTRY_JOURNAL_NEXT_CYCLE");
   }else throw Error("INVALID_NATIVE_INDUSTRY_JOURNAL_SEQUENCE");
   rows.set(event.scope,event);
  }
  return rows;
 }
 function append(event){
  const dir=path.dirname(file);
  storage.mkdirSync(dir,{recursive:true});
  const fd=storage.openSync(file,"a",0o600);
  try{
   const payload=Buffer.from(JSON.stringify(event)+"\n","utf8");
   let offset=0;
   while(offset<payload.length){
    const n=storage.writeSync(fd,payload,offset,payload.length-offset);
    if(!Number.isSafeInteger(n)||n<=0)throw Error("SHORT_INDUSTRY_JOURNAL_WRITE");
    offset+=n;
   }
   storage.fsyncSync(fd);
  }finally{storage.closeSync(fd)}
  const dirFd=storage.openSync(dir,"r");
  try{storage.fsyncSync(dirFd)}finally{storage.closeSync(dirFd)}
 }
 function withLock(fn){
  if(unsafe)return {status:"NATIVE_INDUSTRY_JOURNAL_UNSAFE"};
  let fd=null;
  try{
   storage.mkdirSync(path.dirname(file),{recursive:true});
   fd=storage.openSync(lockFile,"wx",0o600);
   const data=Buffer.from(JSON.stringify({pid:process.pid,at:clock()}));
   storage.writeSync(fd,data,0,data.length);
   storage.fsyncSync(fd);
   storage.closeSync(fd);fd=null;
  }catch{
   if(fd!==null){try{storage.closeSync(fd)}catch{}}
   unsafe=true;
   return {status:"NATIVE_INDUSTRY_LOCK_UNAVAILABLE"};
  }
  let result;
  try{result=fn()}catch(e){
   unsafe=true;
   result={status:"NATIVE_INDUSTRY_REPAIR_REQUIRED",
    reason:String(e?.message||e).slice(0,140)};
  }finally{
   try{storage.unlinkSync(lockFile)}catch{unsafe=true}
  }
  return unsafe?{status:"NATIVE_INDUSTRY_REPAIR_REQUIRED"}:result;
 }
 function inspect(proof){
  const scope=ticketScope(proof);
  if(!scope)return {status:"INVALID_NATIVE_INDUSTRY_PROOF"};
  return withLock(()=>{
   const prev=read().get(scope);
   return {status:!prev?"NEW_NATIVE_JOB":prev.status==="SETTLED"?
    "NATIVE_INDUSTRY_ALREADY_SETTLED":"NATIVE_INDUSTRY_MANUAL_RECONCILIATION",
    cycle:prev?.cycle||0,nativeJobID:prev?.nativeJobID||null};
  });
 }
 function execute({proof,nativeExecute,captureNative,verifyNative,readPreviousJob}={}){
  const scope=ticketScope(proof);
  if(!scope||typeof nativeExecute!=="function"||
   typeof captureNative!=="function"||typeof verifyNative!=="function")
   return {status:"INVALID_NATIVE_INDUSTRY_EXECUTION"};
  // Durable reservation MUST precede any inventory/wallet/blueprint mutation.
  const start=withLock(()=>{
   const latest=read().get(scope);
   if(latest&&latest.status!=="SETTLED")
    return {status:"NATIVE_INDUSTRY_MANUAL_RECONCILIATION"};
   if(latest&&["DELIVER","CANCEL"].includes(proof.kind))
    return {status:proof.kind==="CANCEL"?"NATIVE_CANCEL_ALREADY_SETTLED":
     "NATIVE_DELIVERY_ALREADY_SETTLED"};
   if(latest&&proof.kind==="INSTALL"){
    if(typeof readPreviousJob!=="function")
     return {status:"PREVIOUS_NATIVE_JOB_AUTHORITY_REQUIRED"};
    let prevJob;
    try{prevJob=readPreviousJob(latest.nativeJobID)}catch{return {status:"NATIVE_PREVIOUS_JOB_UNAVAILABLE"}}
    if(!pos(latest.nativeJobID)||pos(prevJob?.jobID)!==pos(latest.nativeJobID)||
     pos(prevJob?.blueprintID)!==pos(proof.blueprintID)||
     ![101,102].includes(Number(prevJob?.status)))
     return {status:"PREVIOUS_NATIVE_BLUEPRINT_JOB_STILL_ACTIVE"};
   }
   const cycle=latest?latest.cycle+1:1;
   append({version:1,scope,cycle,status:"PREPARED",at:clock()});
   return {status:"PREPARED",scope,cycle};
  });
  if(start.status!=="PREPARED")return start;
  // No retry is allowed, even if this callback throws before it returns.
  let nativeResult,nativeError=null,confirmed=false,before=null;
  try{before=captureNative(proof)}catch(e){
   nativeError="NATIVE_BEFORE_SNAPSHOT_FAILED";
  }
  if(!before||typeof before!=="object")
   nativeError="NATIVE_BEFORE_SNAPSHOT_UNAVAILABLE";
  if(!nativeError){
   try{nativeResult=nativeExecute()}catch(e){nativeError=String(e?.message||e).slice(0,120)}
  }
  if(!nativeError&&nativeResult?.success===true){
   try{confirmed=verifyNative({proof,nativeResult,before})===true}catch{confirmed=false}
  }
  const final=withLock(()=>{
   const latest=read().get(start.scope);
   if(!latest||latest.cycle!==start.cycle||latest.status!=="PREPARED")
    return {status:"NATIVE_INDUSTRY_MANUAL_RECONCILIATION"};
   const nativeJobID=proof.kind==="INSTALL"?pos(nativeResult?.data?.jobID):pos(proof.jobID);
   if(proof.kind==="INSTALL"&&!nativeJobID)confirmed=false;
   append({version:1,scope:start.scope,cycle:start.cycle,
    status:confirmed?"SETTLED":"UNKNOWN",at:clock(),nativeJobID:nativeJobID||null});
   return {status:confirmed?"NATIVE_INDUSTRY_OPERATION_SETTLED":
    "NATIVE_INDUSTRY_MANUAL_RECONCILIATION",
    nativeJobID:nativeJobID||null,cycle:start.cycle};
  });
  if(nativeError)return {...final,nativeError};
  return final;
 }
 return {inspect,execute};
}
module.exports={makePlayerIndustryFence};
