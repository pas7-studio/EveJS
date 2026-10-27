"use strict";
// A durable, fail-closed quarantine for an already-committed native player
// loot grant whose separate wreck-source debit could not be verified.
// It NEVER issues native inventory mutations or retries an ambiguous grant.
const fs=require("node:fs"),path=require("node:path");
const positive=n=>Number.isSafeInteger(Number(n))&&Number(n)>0?Number(n):null;
const reasons=new Set(["NATIVE_LOOT_SOURCE_NOT_REMOVED","NATIVE_LOOT_SOURCE_NOT_DECREMENTED"]);
function createGuard({file,storage=fs,clock=()=>Date.now()}={}){
 if(typeof file!=="string"||!file||!path.isAbsolute(file)||
  !["readFileSync","readdirSync","mkdirSync","openSync","writeFileSync",
    "fsyncSync","closeSync","renameSync","unlinkSync","existsSync"].every(
     method=>typeof storage[method]==="function")||typeof clock!=="function")
  throw Error("invalid native loot quarantine store");
 const local=new Set(),dir=path.dirname(file),basename=path.basename(file);
 const lock=file+".writer.lock";
 let hardBlocked=false;
 const key=(w,i)=>String(w)+":"+String(i);
 function durableDirectory(){
  const fd=storage.openSync(dir,"r");
  try{storage.fsyncSync(fd);}finally{storage.closeSync(fd);}
 }
 function assertNoIncompleteWrites(){
  const names=storage.readdirSync(dir);
  if(names.some(name=>name.startsWith(basename+".tmp-")))
   throw Error("INCOMPLETE_LOOT_QUARANTINE_WRITE");
 }
 function read(){
  if(storage.existsSync(dir))assertNoIncompleteWrites();
  let value;
  try{value=storage.readFileSync(file,"utf8");}
  catch(error){if(error?.code==="ENOENT")return {version:1,entries:{}};throw error;}
  const state=JSON.parse(value);
  if(state?.version!==1||!state.entries||
   Object.getPrototypeOf(state.entries)!==Object.prototype||
   Array.isArray(state.entries))throw Error("INVALID_LOOT_QUARANTINE_FILE");
  for(const [id,row] of Object.entries(state.entries)){
   if(!positive(row?.wreckID)||!positive(row?.wreckItemID)||
    !reasons.has(row.reason)||key(row.wreckID,row.wreckItemID)!==id)
    throw Error("INVALID_LOOT_QUARANTINE_ENTRY");
  }
  return state;
 }
 function check({wreckID,wreckItemID}={}){
  const w=positive(wreckID),i=positive(wreckItemID);
  if(!w||!i)return {status:"INVALID"};
  if(hardBlocked)return {status:"QUARANTINE_STORAGE_UNSAFE"};
  if(storage.existsSync(lock))return {status:"QUARANTINE_WRITER_BUSY"};
  const id=key(w,i);
  try{
   const state=read();
   if(local.has(id)||Object.prototype.hasOwnProperty.call(state.entries,id)){
    local.add(id);
    return {status:"QUARANTINED",wreckID:w,wreckItemID:i,
     reason:state.entries[id]?.reason};
   }
   // If a writer appeared during the read, reject instead of claiming ALLOW.
   if(storage.existsSync(lock))return {status:"QUARANTINE_WRITER_BUSY"};
   return {status:"ALLOW"};
  }catch(error){
   hardBlocked=true;
   return {status:"QUARANTINE_STORAGE_UNSAFE",reason:String(error.message).slice(0,120)};
  }
 }
 function quarantine({wreckID,wreckItemID,reason}={}){
  const w=positive(wreckID),i=positive(wreckItemID);
  if(!w||!i||!reasons.has(reason))return {status:"INVALID"};
  const id=key(w,i);
  // Process-local block is immediate, including if persistence fails.
  local.add(id);
  if(hardBlocked)return {status:"QUARANTINE_STORAGE_UNSAFE"};
  let lockFD,lockWritten=false,complete=false;
  try{
   storage.mkdirSync(dir,{recursive:true});
   // This is an interprocess exclusion lock, not a lease. Stale locks are
   // never automatically stolen or removed after an unknown crash.
   lockFD=storage.openSync(lock,"wx",0o600);
   storage.writeFileSync(lockFD,JSON.stringify({version:1,pid:process.pid,
    purpose:"NATIVE_LOOT_QUARANTINE",at:clock()}));
   storage.fsyncSync(lockFD);
   durableDirectory();lockWritten=true;
   const state=read();
   if(!Object.prototype.hasOwnProperty.call(state.entries,id)){
    const when=Number(clock());
    if(!Number.isSafeInteger(when)||when<0)throw Error("INVALID_QUARANTINE_CLOCK");
    state.entries[id]={wreckID:w,wreckItemID:i,reason,createdAt:when};
    const tmp=file+".tmp-"+process.pid;
    const fd=storage.openSync(tmp,"wx",0o600);
    try{
     storage.writeFileSync(fd,JSON.stringify(state));
     storage.fsyncSync(fd);
    }finally{storage.closeSync(fd);}
    storage.renameSync(tmp,file);
    durableDirectory();
   }
   complete=true;
  }catch(error){
   hardBlocked=true;
   return {status:"QUARANTINE_STORAGE_UNSAFE",
    reason:String(error?.message||error).slice(0,120)};
  }finally{
   if(lockFD!==undefined){
    try{storage.closeSync(lockFD);}catch(_){hardBlocked=true;complete=false;}
   }
   // A failed or ambiguous durable write retains the lock for operator
   // reconciliation. Do not erase an unresolved crash fence on recovery.
   if(complete&&lockWritten){
    try{storage.unlinkSync(lock);durableDirectory();}
    catch(_){hardBlocked=true;}
   }
  }
  return hardBlocked?{status:"QUARANTINE_STORAGE_UNSAFE"}:
   {status:"QUARANTINED",wreckID:w,wreckItemID:i};
 }
 return {check,quarantine};
}
let singleton=null,filename=null;
function guard(){
 const file=process.env.EVEJS_COOP_NATIVE_LOOT_QUARANTINE_FILE||
  "/var/lib/evejs/coop-native-loot-quarantine.json";
 if(!singleton||filename!==file){singleton=createGuard({file});filename=file;}
 return singleton;
}
function check(request){
 if(process.env.EVEJS_COOP_NATIVE_LOOT_QUARANTINE!=="1")return {status:"ALLOW"};
 return guard().check(request);
}
function quarantine(request){
 if(process.env.EVEJS_COOP_NATIVE_LOOT_QUARANTINE!=="1")return {status:"DISABLED"};
 return guard().quarantine(request);
}
module.exports={createGuard,check,quarantine};
