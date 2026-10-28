"use strict";
/**
 * Fail-closed, durable, per-native-module ammo debit fence.
 *
 * One durable PREPARED receipt is written and fsynced BEFORE the existing
 * source-owned nativeNpcStore update. COMMITTED is written only AFTER the
 * caller has re-read and verified the exact native cargo quantity.
 *
 * PREPARED, corrupt state, stale writer lock or uncertain disk result NEVER
 * causes an automatic retry or refund. Operator reconciliation required.
 * This does not make a cross-store missile spawn + ammo debit atomic.
 */
const fs = require("node:fs");
const path = require("node:path");
const positive = v => Number.isSafeInteger(Number(v)) && Number(v)>0 ? Number(v) : null;
const validBoundary = n => typeof n==="number" && Number.isFinite(n) && n>0;
let sequence = 0;
// The engine stores this sibling as .js; the repository mirror keeps the same
// code as .cjs, so the load has to survive both extensions.
const sibling = () => {
 try { return require("./coopNpcAmmoBankAtomic"); }
 catch (_error) { return require("./coopNpcAmmoBankAtomic.cjs"); }
};
const MAX_TX_BYTES = 8192;
function createAmmoDebitJournal({root,store,clock=()=>Date.now()}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||root.length<2||
  typeof store?.listNativeCargoForEntity!=="function"||
  typeof store?.getNativeEntity!=="function"||
  typeof clock!=="function")
  throw Error("INVALID_NATIVE_AMMO_JOURNAL_DEPENDENCIES");
 function fileFor(entityID,moduleID){
  return path.join(root,"ships",String(entityID),String(moduleID)+".json");
 }
 function load(file){
  let raw;
  try{raw=fs.readFileSync(file,"utf8");}
  catch(e){if(e.code==="ENOENT")return null;throw e;}
  if(typeof raw!=="string"||raw.length>MAX_TX_BYTES)throw Error("INVALID_JOURNAL_SIZE");
  const value=JSON.parse(raw);
  if(value?.version!==1||!["PREPARED","COMMITTED"].includes(value.phase)||
   !positive(value.entityID)||!positive(value.ownerID)||
   !positive(value.moduleID)||!positive(value.cargoID)||
   !positive(value.typeID)||!validBoundary(value.boundaryMs)||
   !positive(value.beforeQuantity)||!Number.isSafeInteger(value.afterQuantity)||
   value.afterQuantity<0||value.afterQuantity>=value.beforeQuantity||
   typeof value.nonce!=="string"||value.nonce.length>128)
   throw Error("INVALID_JOURNAL_RECORD");
  return value;
 }
 // Windows cannot open a directory for fsync at all; that is the platform
 // refusing the call, not this journal losing its durable acknowledgement.
 function syncDir(dir){
  let fd=null;
  try{fd=fs.openSync(dir,"r");fs.fsyncSync(fd);}
  catch(error){
   if(process.platform!=="win32"||!["EPERM","EACCES","EINVAL","ENOTSUP","EBADF","EISDIR"].includes(error?.code))throw error;
  }finally{if(fd!==null)try{fs.closeSync(fd);}catch(_ignored){}}
 }
 function atomic(file,value){
  const dir=path.dirname(file);
  const tmp=file+".tmp-"+String(process.pid)+"-"+String(++sequence);
  const bytes=JSON.stringify(value);
  if(bytes.length>MAX_TX_BYTES)throw Error("JOURNAL_TOO_LARGE");
  let fd=null;
  try{
   fd=fs.openSync(tmp,"wx",0o600);
   fs.writeFileSync(fd,bytes);
   fs.fsyncSync(fd);
   fs.closeSync(fd);fd=null;
   fs.renameSync(tmp,file);
   syncDir(dir);
  }finally{
   if(fd!==null){try{fs.closeSync(fd);}catch(_){}}
   // Temp files are intentionally left for operator inspection when
   // an I/O fault occurs; the exclusive lock remains as a safety fence.
  }
 }
 function ensureDurableShipDirectory(dir){
  // Persist *directory entries* before a native debit is possible. A
  // fsynced receipt alone cannot survive power loss if its new parent
  // directories were never fsynced.
  const ships=path.join(root,"ships");
  const rootStat=fs.lstatSync(root);
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink())
   throw Error("INVALID_AMMO_DEBIT_ROOT");
  for(const [parent,child] of [[root,ships],[ships,dir]]){
   try{fs.mkdirSync(child,{mode:0o700});}
   catch(e){if(e.code!=="EEXIST")throw e;}
   const stat=fs.lstatSync(child);
   if(!stat.isDirectory()||stat.isSymbolicLink())
    throw Error("UNSAFE_AMMO_JOURNAL_DIRECTORY");
   // Sync the parent even on EEXIST: another process may have created
   // the entry but not yet persisted it.
   syncDir(parent);
  }
 }
 function begin({entity,moduleItem,chargeItem,quantity=1,whenMs}={}){
  const entityID=positive(entity?.itemID),moduleID=positive(moduleItem?.itemID),
   cargoID=positive(chargeItem?.itemID),typeID=positive(chargeItem?.typeID),
   ownerID=positive(entity?.ownerID),debit=positive(quantity),
   boundaryMs=Number(whenMs);
  if(!entityID||!moduleID||!cargoID||!typeID||!ownerID||!debit||
   !validBoundary(boundaryMs))
   return {ok:false,status:"NATIVE_AMMO_CYCLE_IDENTITY_INVALID"};
  const beforeQuantity=Number(chargeItem?.quantity ?? chargeItem?.stacksize);
  if(!Number.isSafeInteger(beforeQuantity)||beforeQuantity<debit)
   return {ok:false,status:"NATIVE_AMMO_CYCLE_QUANTITY_INVALID"};
  const file=fileFor(entityID,moduleID),dir=path.dirname(file),
   lock=file+".lock";
  try{
   // A previous unresolved cycle cannot be replayed, regardless of the
   // current live cache. Monotonic boundary stops any older replay too.
   const previous=load(file);
   if(previous&&(previous.entityID!==entityID||
    previous.moduleID!==moduleID))
    return {ok:false,status:"NATIVE_AMMO_JOURNAL_IDENTITY_MISMATCH"};
   if(previous?.phase==="PREPARED")
    return {ok:false,status:"NATIVE_AMMO_CYCLE_NEEDS_RECONCILIATION"};
   if(previous&&boundaryMs<=previous.boundaryMs)
    return {ok:false,status:"NATIVE_AMMO_CYCLE_REPLAY"};
   ensureDurableShipDirectory(dir);
   const lockFD=fs.openSync(lock,"wx",0o600);
   try{
    fs.writeFileSync(lockFD,JSON.stringify({version:1,entityID,moduleID,
     cargoID,boundaryMs,pid:process.pid,at:clock()}));
    fs.fsyncSync(lockFD);
   }finally{fs.closeSync(lockFD);}
   syncDir(dir);
   // Never delete the lock after an I/O failure, even if preparation
   // appears to have failed. Its presence requires operator inspection.
   const fresh=load(file);
   if(JSON.stringify(fresh)!==JSON.stringify(previous))
    return {ok:false,status:"NATIVE_AMMO_JOURNAL_CHANGED"};
   const record={version:1,phase:"PREPARED",entityID,moduleID,cargoID,
    ownerID,typeID,boundaryMs,beforeQuantity,
    afterQuantity:beforeQuantity-debit,
    nonce:String(process.pid)+":"+String(clock())+":"+String(++sequence)};
   atomic(file,record);
   return {ok:true,status:"PREPARED",token:Object.freeze({
    ...record,file,lock
   })};
  }catch(_){return {ok:false,status:"NATIVE_AMMO_JOURNAL_UNSAFE"};}
 }
 function commit(token){
  const err=status=>({ok:false,status});
  if(!token||token.phase!=="PREPARED"||
   !positive(token.entityID)||!positive(token.moduleID)||
   !positive(token.cargoID)||!validBoundary(token.boundaryMs))
   return err("NATIVE_AMMO_COMMIT_TOKEN_INVALID");
  const file=fileFor(token.entityID,token.moduleID),lock=file+".lock";
  if(token.file!==file||token.lock!==lock)
   return err("NATIVE_AMMO_COMMIT_TOKEN_INVALID");
  try{
   // The claimant must still own the same exclusive writer lock. A
   // missing/replaced lock is never permission to finish a debit.
   const lockOwner=JSON.parse(fs.readFileSync(lock,"utf8"));
   if(lockOwner?.entityID!==token.entityID||
    lockOwner.moduleID!==token.moduleID||
    lockOwner.cargoID!==token.cargoID||
    lockOwner.boundaryMs!==token.boundaryMs||
    lockOwner.pid!==process.pid)
    return err("NATIVE_AMMO_COMMIT_LOCK_LOST");
   const record=load(file);
   if(!record||record.phase!=="PREPARED"||
    record.nonce!==token.nonce||
    record.entityID!==token.entityID||
    record.moduleID!==token.moduleID||
    record.cargoID!==token.cargoID||
    record.beforeQuantity!==token.beforeQuantity||
    record.afterQuantity!==token.afterQuantity||
    record.boundaryMs!==token.boundaryMs)
    return err("NATIVE_AMMO_COMMIT_JOURNAL_MISMATCH");
   // The caller has already verified this after the native cargo write.
   // Check it again here so the journal cannot settle without a matching
   // persisted native state.
   const owner=store.getNativeEntity(record.entityID);
   if(Number(owner?.ownerID)!==record.ownerID)
    return err("NATIVE_AMMO_COMMIT_SHIP_CHANGED");
   const rows=store.listNativeCargoForEntity(record.entityID).filter(c=>
    Number(c?.cargoID)===record.cargoID);
   if(record.afterQuantity>0){
    if(rows.length!==1||Number(rows[0].quantity)!==record.afterQuantity||
     Number(rows[0].entityID)!==record.entityID||
     Number(rows[0].ownerID)!==record.ownerID||
     Number(rows[0].moduleID)!==record.moduleID||
     Number(rows[0].typeID)!==record.typeID)
     return err("NATIVE_AMMO_COMMIT_STOCK_MISMATCH");
   }else if(rows.length!==0)
    return err("NATIVE_AMMO_COMMIT_STOCK_MISMATCH");
   atomic(file,{...record,phase:"COMMITTED"});
   // The durable cycle receipt stays; only the exclusive writer lock is
   // cleared after the committed file + parent directory have been fsynced.
   fs.unlinkSync(lock);
   syncDir(path.dirname(file));
   return {ok:true,status:"NATIVE_AMMO_DEBIT_COMMITTED",
    entityID:record.entityID,moduleID:record.moduleID,
    cargoID:record.cargoID,boundaryMs:record.boundaryMs};
  }catch(_){return err("NATIVE_AMMO_COMMIT_UNSAFE");}
 }
 function inspect({entityID,moduleID}={}){
  const e=positive(entityID),m=positive(moduleID);
  if(!e||!m)return {status:"INVALID"};
  const file=fileFor(e,m);
  try{
   const state=load(file),lockExists=fs.existsSync(file+".lock");
   const dir=path.dirname(file);
   const orphanTemps=fs.existsSync(dir)&&fs.readdirSync(dir).some(name=>
    name.startsWith(String(m)+".json.tmp-"));
   return {status:lockExists?"LOCKED_RECONCILE":
    orphanTemps?"ORPHAN_TEMP_RECONCILE":
    state?.phase==="PREPARED"?"PREPARED_RECONCILE":
    state?.phase==="COMMITTED"?"COMMITTED":"EMPTY",
    state,lockExists};
  }catch(_){return {status:"CORRUPT_RECONCILE"};}
 }
 function preflightBank({entity,entries,whenMs}={}){
  const entityID=positive(entity?.itemID),ownerID=positive(entity?.ownerID),
   boundaryMs=Number(whenMs);
  if(!entityID||!ownerID||!validBoundary(boundaryMs)||
   !Array.isArray(entries)||!entries.length||entries.length>16)
   return {ok:false,status:"NATIVE_AMMO_BANK_IDENTITY_INVALID"};
  // A prior atomic multi-barrel debit may have reached SQLite while its
  // ship journal remains PREPARED. Never switch back to module-wise fire
  // to bypass that unresolved transaction. A PREPARED journal whose SQLite
  // replay fence proves the debit never committed is recovered as ABORTED
  // first: one failed transaction must not quarantine a real warship forever.
  let bankShip=sibling().inspectShip({root,entityID});
  if(!bankShip.ok&&(bankShip.status==="BANK_NEEDS_RECONCILIATION"||
   bankShip.status==="BANK_LOCKED_RECONCILE")){
   try{
    const recovered=sibling().recoverUncommitted({
     root,entityID,
     readFence:id=>require("./coopNativeRowPath").readRow(
      require("../gameStore"),"npcCargo","coopAmmoCycles_"+String(id))});
    if(recovered.status==="ABORTED")
     bankShip=sibling().inspectShip({root,entityID});
    else console.warn("[CoopAmmoJournal] bank recovery",
     String(recovered.status||"UNKNOWN"),String(recovered.reason||""));
   }catch(error){
    console.warn("[CoopAmmoJournal] bank recovery threw",
     String(error&&error.message||error));
   }
  }
  if(!bankShip.ok)return {ok:false,status:"NATIVE_AMMO_BANK_SHIP_QUARANTINED",
   reason:bankShip.status};
  // Never downgrade a ship with atomic cargo history back to separate
  // module writes: the latter do not carry its SQLite replay fences.
  if(bankShip.receipt&&process.env.EVEJS_COOP_NPC_BANK_ATOMIC!=="1")
   return {ok:false,status:"NATIVE_AMMO_ATOMIC_DOWNGRADE_FORBIDDEN"};
  const activeModules=new Set();
  for(const entry of entries){
   const moduleID=positive(entry?.moduleItem?.itemID);
   if(!moduleID||activeModules.has(moduleID))
    return {ok:false,status:"NATIVE_AMMO_BANK_DUPLICATE_MODULE"};
   activeModules.add(moduleID);
  }
  if(bankShip.receipt&&boundaryMs<=bankShip.receipt.boundaryMs&&
    bankShip.receipt.modules.some(m=>activeModules.has(m)))
   return {ok:false,status:"NATIVE_AMMO_BANK_REPLAY"};
  // Even if a gun was unloaded after an uncertain debit, its journal
  // must still quarantine the *ship*. Otherwise changing bank membership
  // lets previously healthy guns debit repeatedly before failing again.
  const toInspect=new Set(activeModules);
  const dir=path.join(root,"ships",String(entityID));
  try{
   if(fs.existsSync(dir)){
    const stat=fs.lstatSync(dir);
    if(!stat.isDirectory()||stat.isSymbolicLink())
     return {ok:false,status:"NATIVE_AMMO_BANK_UNSAFE_DIRECTORY"};
    const names=fs.readdirSync(dir);
    if(names.length>256)
     return {ok:false,status:"NATIVE_AMMO_BANK_SCAN_LIMIT"};
    for(const name of names){
     const found=/^([1-9][0-9]*)\.json(?:\.lock|\.tmp-[0-9]+-[0-9]+)?$/.exec(name);
     const moduleID=found?positive(found[1]):null;
     if(!moduleID||String(moduleID)!==found[1])
      return {ok:false,status:"NATIVE_AMMO_BANK_UNKNOWN_FILE"};
     toInspect.add(moduleID);
    }
   }
  }catch(_){return {ok:false,status:"NATIVE_AMMO_BANK_SCAN_UNSAFE"};}
  for(const moduleID of toInspect){
   const result=inspect({entityID,moduleID});
   if(result.status!=="EMPTY"&&result.status!=="COMMITTED")
    return {ok:false,status:"NATIVE_AMMO_BANK_NEEDS_RECONCILIATION",
     moduleID,reason:result.status};
   const prev=result.state;
   if(prev&&(prev.entityID!==entityID||prev.moduleID!==moduleID||
    prev.ownerID!==ownerID))
    return {ok:false,status:"NATIVE_AMMO_BANK_IDENTITY_MISMATCH",moduleID};
   if(activeModules.has(moduleID)&&prev&&boundaryMs<=prev.boundaryMs)
    return {ok:false,status:"NATIVE_AMMO_BANK_REPLAY",moduleID};
  }
  return {ok:true,status:"NATIVE_AMMO_BANK_READY",
   checked:activeModules.size,receiptsScanned:toInspect.size};
 }

 return {begin,commit,inspect,preflightBank};
}
let defaultJournal=null,defaultRoot=null;
function active(){
 const root=process.env.EVEJS_COOP_NPC_AMMO_DEBIT_ROOT||
  "/var/lib/evejs/coop-npc-ammo-debits";
 if(!defaultJournal||defaultRoot!==root){
  defaultJournal=createAmmoDebitJournal({
   root,store:require("./npc/nativeNpcStore")
  });defaultRoot=root;
 }
 return defaultJournal;
}
function begin(args){
 if(process.env.EVEJS_COOP_NPC_STRICT_AMMO!=="1"||
  process.env.EVEJS_COOP_NPC_AMMO_DURABLE_CYCLE!=="1")
  return {ok:true,status:"OFF",token:null};
 try{return active().begin(args);}
 catch(_){return {ok:false,status:"NATIVE_AMMO_JOURNAL_UNSAFE"};}
}
function commit(token){
 if(!token)return {ok:true,status:"OFF"};
 try{return active().commit(token);}
 catch(_){return {ok:false,status:"NATIVE_AMMO_COMMIT_UNSAFE"};}
}
function preflightBank(args){
 if(process.env.EVEJS_COOP_NPC_STRICT_AMMO!=="1"||
  process.env.EVEJS_COOP_NPC_AMMO_DURABLE_CYCLE!=="1")
  return {ok:true,status:"OFF"};
 try{return active().preflightBank(args);}
 catch(_){return {ok:false,status:"NATIVE_AMMO_BANK_UNSAFE"};}
}
module.exports={createAmmoDebitJournal,begin,commit,preflightBank};
