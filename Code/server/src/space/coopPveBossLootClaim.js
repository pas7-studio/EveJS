"use strict";
// PVE-004B: durable BEFORE-GRANT fence for source-verified native boss loot.
// Does not grant/debit inventory; original EveJS still owns both mutations.
// Interrupted grants remain PENDING; only an operator may reconcile them.
const fs=require("node:fs"),path=require("node:path");
const id=n=>Number.isSafeInteger(n)&&n>0?n:null;
function createFence({file,storage=fs,clock=()=>Date.now(),getBossWreck,
 getNativeWreck,maxEntries=4096}={}){
 if(typeof file!=="string"||!path.isAbsolute(file)||
    ![ "openSync","readFileSync","writeFileSync","closeSync","fsyncSync",
       "mkdirSync","existsSync","readdirSync","renameSync","unlinkSync"]
     .every(n=>typeof storage[n]==="function")||
    typeof clock!=="function"||typeof getBossWreck!=="function"||
    typeof getNativeWreck!=="function"||
    !Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>50000)
  throw Error("INVALID_BOSS_LOOT_FENCE");
 const dir=path.dirname(file),lock=file+".writer.lock",tmp=file+".tmp-";
 let unsafe=false;
 const persistDir=()=>{const fd=storage.openSync(dir,"r");try{storage.fsyncSync(fd)}finally{storage.closeSync(fd)}};
 function read(){
  if(storage.existsSync(dir)&&storage.readdirSync(dir).some(n=>n.startsWith(path.basename(tmp))))
   throw Error("UNFINISHED_BOSS_LOOT_JOURNAL");
  let payload;
  try{payload=storage.readFileSync(file,"utf8")}
  catch(e){if(e?.code==="ENOENT")return {version:1,entries:{}};throw e}
  const state=JSON.parse(payload);
  if(state?.version!==1||!state.entries||Array.isArray(state.entries)||
     Object.getPrototypeOf(state.entries)!==Object.prototype||
     Object.keys(state.entries).length>maxEntries)throw Error("BAD_BOSS_LOOT_JOURNAL");
  for(const [key,row] of Object.entries(state.entries)){
   if(key!==row?.key||!id(row.wreckID)||!id(row.wreckItemID)||
      !id(row.characterID)||!id(row.destinationLocationID)||
      !id(row.beforeQuantity)||!id(row.quantity)||
      !["PENDING","SETTLED"].includes(row.phase)||!id(row.createdAt)||
      (row.phase==="SETTLED"&&!id(row.settledAt)))
    throw Error("BAD_BOSS_LOOT_ROW");
  }
  return state;
 }
 function write(op){
  if(unsafe)return {status:"BOSS_LOOT_JOURNAL_UNSAFE"};
  let fd,lockOwned=false,done=false;
  let output={status:"BOSS_LOOT_JOURNAL_UNSAFE"};
  try{
   storage.mkdirSync(dir,{recursive:true});
   fd=storage.openSync(lock,"wx",0o600);lockOwned=true;
   storage.writeFileSync(fd,JSON.stringify({pid:process.pid,at:clock()}));
   storage.fsyncSync(fd);persistDir();
   const state=read();
   const result=op(state);
   if(result.changed){
    const out=tmp+process.pid;
    const outfd=storage.openSync(out,"wx",0o600);
    try{storage.writeFileSync(outfd,JSON.stringify(state));storage.fsyncSync(outfd)}
    finally{storage.closeSync(outfd)}
    storage.renameSync(out,file);persistDir();
   }
   done=true;output=result.output;
  }catch(e){
   // A lock owned by ANOTHER process is not automatically deleted.
   if(e?.code!=="EEXIST")unsafe=true;
   output={status:e?.code==="EEXIST"?
    "BOSS_LOOT_WRITER_BUSY":"BOSS_LOOT_JOURNAL_UNSAFE"};
  }finally{
   if(fd!==undefined)try{storage.closeSync(fd)}catch{unsafe=true;done=false}
   if(lockOwned&&done&&!unsafe)try{storage.unlinkSync(lock);persistDir()}
    catch{unsafe=true}
   // Unknown crash/failure retains lock and blocks all subsequent attempts.
  }
  // The final close/unlink/fsync happens in finally. Never acknowledge a
  // pre-grant claim if that final durability step was ambiguous.
  return unsafe?{status:"BOSS_LOOT_JOURNAL_UNSAFE"}:output;
 }
 function begin({wreck,wreckItem,characterID,destinationLocationID,
   requestedQuantity}={}){
  let witness,native;
  try{
   // Inspect native original wreck BEFORE giving an unclassified wreck
   // permission to bypass the boss-specific pre-grant fence. After
   // restart an authored overseer can lose its in-memory live witness.
   native=getNativeWreck(wreck?.wreckID);
   witness=getBossWreck(wreck?.wreckID);
   if(!witness){
    const authored=String(native?.profileID||"")+" "+
     String(native?.lootTableID||"");
    if(native?.transient===true&&
       /(?:overseer|boss|officer|commander)/i.test(authored))
     return {status:"BOSS_LOOT_LIVE_WITNESS_REQUIRED"};
    return {status:"NOT_VERIFIED_BOSS_WRECK"};
   }
  }catch{return {status:"BOSS_LOOT_AUTHORITY_UNAVAILABLE"}}
  const w=id(wreck?.wreckID),i=id(wreckItem?.wreckItemID),
   ch=id(characterID),dest=id(destinationLocationID),
   qty=id(requestedQuantity),before=id(wreckItem?.quantity);
  if(!w||!i||!ch||!dest||!qty||!before||qty>before||
     witness.wreckID!==w||native?.wreckID!==w||
     native.sourceEntityID!==witness.bossEntityID||
     native.sourceTypeID!==witness.bossTypeID||
     native.launcherID!==witness.bossEntityID||
     native.systemID!==witness.systemID||
     wreck?.systemID!==native.systemID||
     native.transient!==true||
     wreckItem?.wreckID!==w||wreckItem?.locationID!==w||
     !id(wreckItem.typeID)||!Array.isArray(witness.originalItems)||
     !witness.originalItems.some(row=>row.wreckItemID===i&&
      row.typeID===wreckItem.typeID&&
      row.quantity>=before))return {status:"BOSS_LOOT_SOURCE_UNVERIFIED"};
  const key=w+":"+i+":"+before;
  return write(state=>{
   if(Object.keys(state.entries).length>=maxEntries)
    return {changed:false,output:{status:"BOSS_LOOT_JOURNAL_FULL"}};
   const prior=Object.values(state.entries).filter(row=>
    row.wreckID===w&&row.wreckItemID===i);
   if(prior.some(row=>row.phase==="PENDING"||row.beforeQuantity===before))
    return {changed:false,output:{status:"BOSS_LOOT_REPLAY_BLOCKED"}};
   // Exactly the original native source remainder is authorized, not an
   // accidentally resurrected or inflated stack after an earlier pickup.
   if(prior.length){
    const previousRemainders=prior.map(row=>row.beforeQuantity-row.quantity);
    if(previousRemainders.some(q=>!Number.isSafeInteger(q)||q<0))
     return {changed:false,output:{status:"BOSS_LOOT_JOURNAL_UNSAFE"}};
    const lastRemaining=Math.min(...previousRemainders);
    if(lastRemaining!==before)
     return {changed:false,output:{status:"BOSS_LOOT_SOURCE_SEQUENCE_MISMATCH"}};
   }
   const now=clock();
   if(!id(now))return {changed:false,output:{status:"BOSS_LOOT_CLOCK_INVALID"}};
   state.entries[key]={key,wreckID:w,wreckItemID:i,characterID:ch,
    destinationLocationID:dest,beforeQuantity:before,quantity:qty,
    phase:"PENDING",createdAt:now};
   return {changed:true,output:{status:"BOSS_LOOT_CLAIMED"}};
  });
 }
 function settle({verified,sourceBefore}={}){
  if(verified?.status!=="ORIGINAL_BOSS_ITEM_PICKUP_VERIFIED"||
     !id(sourceBefore?.quantity))return {status:"BOSS_LOOT_SETTLEMENT_NOT_VERIFIED"};
  const key=verified.wreckID+":"+verified.wreckItemID+":"+sourceBefore.quantity;
  return write(state=>{
   const row=state.entries[key];
   if(!row||row.phase!=="PENDING"||
      row.characterID!==verified.characterID||
      row.destinationLocationID!==verified.shipID||
      row.quantity!==verified.quantity||
      row.beforeQuantity-verified.quantity!==verified.remainingQuantity)
    return {changed:false,output:{status:"BOSS_LOOT_CLAIM_NOT_MATCHED"}};
   const now=clock();
   if(!id(now))return {changed:false,output:{status:"BOSS_LOOT_CLOCK_INVALID"}};
   row.phase="SETTLED";row.settledAt=now;
   return {changed:true,output:{status:"BOSS_LOOT_CLAIM_SETTLED"}};
  });
 }
 function snapshot(){
  if(unsafe)return {status:"BOSS_LOOT_JOURNAL_UNSAFE"};
  try{if(storage.existsSync(lock))return {status:"BOSS_LOOT_WRITER_BUSY"};
   return {status:"OK",entries:read().entries}}
  catch{return {status:"BOSS_LOOT_JOURNAL_UNSAFE"}}
 }
 return {begin,settle,snapshot};
}
let singleton=null,filename=null;
function current(){
 const file=process.env.EVEJS_COOP_PVE_BOSS_LOOT_FENCE_FILE||
  "/var/lib/evejs/coop-pve-boss-loot-claims.json";
 if(!singleton||file!==filename){
  singleton=createFence({file,
   getBossWreck:id=>require("./coopVirtualWorldRuntime").witnessedNativeBossWreck(id),
   getNativeWreck:id=>require("./npc/nativeNpcStore").getNativeWreck(id)});
  filename=file;
 }
 return singleton;
}
function begin(args){
 if(process.env.EVEJS_COOP_PVE_BOSS_LOOT_FENCE!=="1")return {status:"DISABLED"};
 if(["EVEJS_COOP_PVE_SITE_DEFENSE","EVEJS_COOP_PVE_NATIVE_BOSSES",
  "EVEJS_COOP_NATIVE_LOOT_EVIDENCE","EVEJS_COOP_PVE_BOSS_LOOT_PICKUP"]
  .some(key=>process.env[key]!=="1"))
  return {status:"BOSS_LOOT_DEPENDENCY_DISABLED"};
 try{return current().begin(args)}catch{return {status:"BOSS_LOOT_JOURNAL_UNSAFE"}}
}
function settle(args){
 if(process.env.EVEJS_COOP_PVE_BOSS_LOOT_FENCE!=="1")return {status:"DISABLED"};
 try{return current().settle(args)}catch{return {status:"BOSS_LOOT_JOURNAL_UNSAFE"}}
}
module.exports={createFence,begin,settle};
