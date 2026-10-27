"use strict";
/**
 * P0 durable fire outcome witness (not durable scene/damage settlement).
 * A matching native SQLite ammo bank must already be COMMITTED.
 * Misses are valid turret outcomes; missile launch failures remain quarantined.
 * Journal lock failures, crashes, and ambiguous scene results are NOT refunded.
 */
const fs=require("node:fs");
const path=require("node:path");
const {inspectShip}=require("./coopNpcAmmoBankAtomic");
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const allowedKinds=new Set(["TURRET_RESOLVED","MISSILE_LAUNCHED","MISSILE_LAUNCH_FAILED"]);
let sequence=0;
function sync(io,dir){
 const fd=io.openSync(dir,"r");
 try{io.fsyncSync(fd);}finally{io.closeSync(fd);}
}
function receiptAt(io,file){
 const st=io.lstatSync(file);
 if(st.isSymbolicLink()||!st.isFile()||st.size>16384)
  throw Error("UNSAFE_BANK_OUTCOME_RECEIPT");
 const data=io.readFileSync(file,"utf8");
 if(data.length>16384)throw Error("OVERSIZE_BANK_OUTCOME_RECEIPT");
 const receipt=JSON.parse(data);
 if(receipt?.version!==1||receipt.phase!=="COMMITTED"||
    !positive(receipt.entityID)||!Number.isFinite(receipt.boundaryMs)||
    !Array.isArray(receipt.modules)||!receipt.nonce)
  throw Error("INVALID_BANK_OUTCOME_RECEIPT");
 return receipt;
}
function write(io,file,value){
 const text=JSON.stringify(value);
 if(text.length>16384)throw Error("OVERSIZE_BANK_OUTCOME_RECEIPT");
 const tmp=file+".tmp-"+String(process.pid)+"-"+String(++sequence);
 let fd=null;
 try{
  fd=io.openSync(tmp,"wx",0o600);
  io.writeFileSync(fd,text);io.fsyncSync(fd);io.closeSync(fd);fd=null;
  io.renameSync(tmp,file);sync(io,path.dirname(file));
 }finally{if(fd!==null)try{io.closeSync(fd);}catch(_){}}
}
function createFireOutcomeWitness({root,io=fs,clock=()=>Date.now()}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||typeof clock!=="function")
  throw Error("BANK_OUTCOME_DEPENDENCIES_REQUIRED");
 function record({entity,whenMs,kind,hit=null,missileID=null}={}){
  const fail=status=>({ok:false,status});
  const entityID=positive(entity?.itemID);
  if(entity?.kind!=="ship"||entity?.nativeNpc!==true||!entityID||
     !Number.isFinite(whenMs)||whenMs<=0||!allowedKinds.has(kind)||
     (kind==="TURRET_RESOLVED"&&typeof hit!=="boolean")||
     (kind==="MISSILE_LAUNCHED"&&!positive(missileID)))
   return fail("BANK_OUTCOME_INVALID_INPUT");
  const existing=inspectShip({root,entityID,io});
  if(!existing.ok||existing.status!=="COMMITTED"||
     existing.receipt?.boundaryMs!==whenMs)
   return fail("BANK_OUTCOME_UNCOMMITTED");
  if(existing.receipt.outcome)return fail("BANK_OUTCOME_ALREADY_PRESENT");
  const file=path.join(root,"bank-ships",String(entityID)+".json");
  const lock=file+".lock",dir=path.dirname(file);
  try{
   // Same exclusive writer-lock name as prepare(), so a new cycle can
   // never overwrite an in-flight outcome witness.
   const fd=io.openSync(lock,"wx",0o600);
   try{
    io.writeFileSync(fd,JSON.stringify({version:1,entityID,nonce:existing.receipt.nonce,
      purpose:"OUTCOME",pid:process.pid}));
    io.fsyncSync(fd);
   }finally{io.closeSync(fd);}
   sync(io,dir);
   const current=receiptAt(io,file);
   if(current.entityID!==entityID||current.boundaryMs!==whenMs||
      current.nonce!==existing.receipt.nonce||current.outcome)
    return fail("BANK_OUTCOME_CHANGED");
   const outcome={version:1,kind,boundaryMs:whenMs,
    observedAtMs:Number(clock()),...(kind==="TURRET_RESOLVED"?{hit}:{}),
    ...(kind==="MISSILE_LAUNCHED"?{missileID:positive(missileID)}:{})};
   if(!Number.isFinite(outcome.observedAtMs)||outcome.observedAtMs<=0)
    return fail("BANK_OUTCOME_CLOCK_UNSAFE");
   write(io,file,{...current,outcome});
   io.unlinkSync(lock);sync(io,dir);
   return {ok:true,status:"BANK_OUTCOME_RECORDED",outcome};
  }catch(_){
   // Never remove an uncertain lock. It is the durable quarantine fence.
   return fail("BANK_OUTCOME_PERSISTENCE_UNSAFE");
  }
 }
 return {record};
}
function enabled(env=process.env){
 return env.EVEJS_COOP_NPC_STRICT_AMMO==="1"&&
 env.EVEJS_COOP_NPC_AMMO_DURABLE_CYCLE==="1"&&
 env.EVEJS_COOP_NPC_BANK_ATOMIC==="1"&&
 env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
 env.EVEJS_COOP_NPC_BANK_OUTCOME_WITNESS==="1";
}
let instance=null,lastRoot=null;
function record(args){
 if(!enabled())return {ok:false,status:"BANK_OUTCOME_FLAGS_INCOMPLETE"};
 try{
  const root=process.env.EVEJS_COOP_NPC_AMMO_DEBIT_ROOT||
   "/var/lib/evejs/coop-npc-ammo-debits";
  if(!instance||root!==lastRoot){instance=createFireOutcomeWitness({root});lastRoot=root;}
  return instance.record(args);
 }catch(_){return {ok:false,status:"BANK_OUTCOME_UNAVAILABLE"};}
}
module.exports={createFireOutcomeWitness,enabled,record};
