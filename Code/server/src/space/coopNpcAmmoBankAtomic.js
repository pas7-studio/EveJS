"use strict";
/**
 * Opt-in, source-first native NPC weapon-bank debit.
 *
 * The entire native npcCargo cargo map and all module replay fences are changed
 * in ONE SQLite BEGIN IMMEDIATE transaction via the existing GameStore owner.
 * A separately fsynced ship-wide PREPARED/COMMITTED journal fences crashes,
 * but is NOT a transaction with damage, missiles, or the JavaScript scene.
 */
const fs=require("node:fs");
const path=require("node:path");
const pos=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const boundary=v=>typeof v==="number"&&Number.isFinite(v)&&v>0;
// Pinned nativeNpcService creates fitted ammo cargo with moduleID but no
// flagID. Runtime getNpcLoadedChargeForModule adds the fitted module flag;
// a persisted cargo flag, when supplied, may be generic cargo flag 5.
const compatibleCargoFlag=(record,moduleFlag)=>record.flagID==null||
 Number(record.flagID)===5||Number(record.flagID)===moduleFlag;
let sequence=0;
const maxReceiptBytes=16384;
const gate=env=>env.EVEJS_COOP_NPC_STRICT_AMMO==="1"&&
 env.EVEJS_COOP_NPC_AMMO_DURABLE_CYCLE==="1"&&
 env.EVEJS_COOP_NPC_BANK_ATOMIC==="1"&&
 env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1";
function journalFile(root,entityID){return path.join(root,"bank-ships",String(entityID)+".json");}
function readReceipt(file,io=fs){
 let raw;
 try{
  const st=io.lstatSync(file);
  if(st.isSymbolicLink()||!st.isFile()||st.size>maxReceiptBytes)
   throw Error("UNSAFE_BANK_RECEIPT_FILE");
  raw=io.readFileSync(file,"utf8");
 }catch(e){if(e.code==="ENOENT")return null;throw e;}
 if(typeof raw!=="string"||raw.length>maxReceiptBytes)throw Error("BANK_RECEIPT_SIZE_INVALID");
 const v=JSON.parse(raw);
 if(v?.version!==1||!["PREPARED","COMMITTED","ABORTED"].includes(v.phase)||
   !pos(v.entityID)||!boundary(v.boundaryMs)||
   !Array.isArray(v.modules)||!v.modules.length||v.modules.length>16||
   v.modules.some(m=>!pos(m))||new Set(v.modules).size!==v.modules.length||
   typeof v.nonce!=="string"||!v.nonce.length||
   (v.outcomeRequired!==undefined&&typeof v.outcomeRequired!=="boolean"))
   throw Error("BANK_RECEIPT_INVALID");
 return v;
}
function inspectShip({root,entityID,io=fs}={}){
 const id=pos(entityID);
 if(typeof root!=="string"||!path.isAbsolute(root)||!id)return {ok:false,status:"BANK_JOURNAL_INVALID"};
 const file=journalFile(root,id),dir=path.dirname(file);
 try{
  if(!io.existsSync(dir))return {ok:true,status:"EMPTY"};
  const stat=io.lstatSync(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink())return {ok:false,status:"BANK_DIRECTORY_UNSAFE"};
  const names=io.readdirSync(dir);
  if(names.some(n=>n.startsWith(String(id)+".json.tmp-")))
   return {ok:false,status:"BANK_ORPHAN_TEMP"};
  if(io.existsSync(file+".lock"))return {ok:false,status:"BANK_LOCKED_RECONCILE"};
  const receipt=readReceipt(file,io);
  if(!receipt)return {ok:true,status:"EMPTY"};
  if(receipt.entityID!==id)return {ok:false,status:"BANK_IDENTITY_MISMATCH"};
  if(receipt.phase==="PREPARED")return {ok:false,status:"BANK_NEEDS_RECONCILIATION"};
  if(receipt.phase==="ABORTED")return {ok:true,status:"ABORTED",receipt};
  return {ok:true,status:"COMMITTED",receipt};
 }catch(_){return {ok:false,status:"BANK_JOURNAL_CORRUPT"};}
}
function syncDir(io,dir){
 // Windows cannot open a directory for fsync; the deployed runtime is POSIX.
 // Every other platform stays strict: a failed directory fsync is an error.
 if(process.platform==="win32")return;
 const fd=io.openSync(dir,"r");
 try{io.fsyncSync(fd);}finally{io.closeSync(fd);}
}
// The journal root is a private directory, not game state: create it when the
// deployment never made it (a container that never provisioned the volume would
// otherwise fail every single turret cycle as BANK_ATOMIC_JOURNAL_UNSAFE).
// A symlink or a non-directory still fails closed, because that is exactly how
// a real path substitution would look.
function ensureJournalRoot({root,io=fs}={}){
 if(typeof root!=="string"||!path.isAbsolute(root))throw Error("BANK_ROOT_UNSAFE");
 try{io.mkdirSync(root,{mode:0o700});}
 catch(e){if(e.code!=="EEXIST")throw e;}
 const stat=io.lstatSync(root);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw Error("BANK_ROOT_UNSAFE");
 return root;
}
function writeAtomic(io,file,receipt){
 const dir=path.dirname(file),bytes=JSON.stringify(receipt);
 if(bytes.length>maxReceiptBytes)throw Error("BANK_RECEIPT_TOO_LARGE");
 const tmp=file+".tmp-"+String(process.pid)+"-"+String(++sequence);
 let fd=null;
 try{
  fd=io.openSync(tmp,"wx",0o600);
  io.writeFileSync(fd,bytes);
  io.fsyncSync(fd);
  io.closeSync(fd);fd=null;
  io.renameSync(tmp,file);
  syncDir(io,dir);
 }finally{if(fd!==null)try{io.closeSync(fd);}catch(_){}}
}
function prepare(io,root,entityID,modules,whenMs,clock){
 const status=inspectShip({root,entityID,io});
 if(!status.ok)throw Error(status.status);
 if(status.receipt?.outcomeRequired===true&&
    process.env.EVEJS_COOP_NPC_BANK_OUTCOME_WITNESS!=="1")
  throw Error("BANK_OUTCOME_DOWNGRADE_FORBIDDEN");
 if(status.receipt&&whenMs<=status.receipt.boundaryMs&&
    status.receipt.modules.some(m=>modules.has(m)))
  throw Error("BANK_CYCLE_REPLAY");
 // COOP-046: when outcome attestation is requested, never overwrite a
 // successful cargo debit whose native fire result is still unknown.
 if((process.env.EVEJS_COOP_NPC_BANK_OUTCOME_WITNESS==="1"||
     status.receipt?.outcomeRequired===true)&&status.receipt&&
    status.receipt.phase==="COMMITTED"){
  const o=status.receipt.outcome;
  if(!o||o.version!==1||o.boundaryMs!==status.receipt.boundaryMs||
     !Number.isFinite(o.observedAtMs)||o.observedAtMs<=0||
     !(o.kind==="TURRET_RESOLVED"&&typeof o.hit==="boolean"||
       o.kind==="MISSILE_LAUNCHED"&&pos(o.missileID)))
   throw Error("BANK_OUTCOME_NOT_ATTESTED");
 }
 const dir=path.join(root,"bank-ships");
 ensureJournalRoot({root,io});
 try{io.mkdirSync(dir,{mode:0o700});}
 catch(e){if(e.code!=="EEXIST")throw e;}
 const dirStat=io.lstatSync(dir);
 if(!dirStat.isDirectory()||dirStat.isSymbolicLink())throw Error("BANK_DIRECTORY_UNSAFE");
 syncDir(io,root);
 const file=journalFile(root,entityID),lock=file+".lock";
 const nonce=String(process.pid)+":"+String(clock())+":"+String(++sequence);
 const fd=io.openSync(lock,"wx",0o600);
 try{
  io.writeFileSync(fd,JSON.stringify({version:1,entityID,nonce}));
  io.fsyncSync(fd);
 }finally{io.closeSync(fd);}
 syncDir(io,dir);
 const state=readReceipt(file,io);
 if((state?.nonce||null)!==(status.receipt?.nonce||null))
  throw Error("BANK_JOURNAL_RACE");
 const receipt={version:1,phase:"PREPARED",entityID,boundaryMs:whenMs,
  modules:[...modules].sort((a,b)=>a-b),nonce,
  outcomeRequired:process.env.EVEJS_COOP_NPC_BANK_OUTCOME_WITNESS==="1"};
 writeAtomic(io,file,receipt);
 return {file,lock,receipt,previousReceipt:status.receipt||null};
}
function settle(io,token){
 const owner=JSON.parse(io.readFileSync(token.lock,"utf8"));
 if(owner?.entityID!==token.receipt.entityID||owner?.nonce!==token.receipt.nonce)
  throw Error("BANK_LOCK_CHANGED");
 const old=readReceipt(token.file,io);
 if(old?.phase!=="PREPARED"||old.nonce!==token.receipt.nonce)
  throw Error("BANK_JOURNAL_CHANGED");
 writeAtomic(io,token.file,{...old,phase:"COMMITTED"});
 io.unlinkSync(token.lock);
 syncDir(io,path.dirname(token.file));
}
// A PREPARED journal whose SQLite replay fence never reached the boundary is a
// debit that provably did NOT commit: the fence is written in the same
// transaction as the cargo delta. Such a journal is recovered as ABORTED (no
// refund, no invented shot) so one failed transaction cannot quarantine a real
// warship forever. A fence at or past the boundary is the opposite proof: the
// debit landed, so nothing is touched and the ship stays NEEDS_OPERATOR_REPAIR.
function recoverUncommitted({root,entityID,atomicRows,readFence,io=fs,clock=()=>Date.now()}={}){
 const id=pos(entityID);
 if(typeof root!=="string"||!path.isAbsolute(root)||!id||
    (typeof readFence!=="function"&&typeof atomicRows?.transact!=="function"))
  return {status:"RECOVERY_UNAVAILABLE"};
 const file=journalFile(root,id),lock=file+".lock";
 let receipt;
 try{
  if(!io.existsSync(file))return {status:"NOTHING_TO_RECOVER"};
  receipt=readReceipt(file,io);
 }catch(_){return {status:"RECOVERY_JOURNAL_UNREADABLE"}}
 if(!receipt)return {status:"NOTHING_TO_RECOVER"};
 if(receipt.entityID!==id)return {status:"RECOVERY_IDENTITY_MISMATCH"};
 if(receipt.phase!=="PREPARED")return {status:"NOTHING_TO_RECOVER"};
 let fence=null;
 try{
  // A plain cache read is enough: the atomic writer reconciles the GameStore
  // cache synchronously after COMMIT. The runtime therefore never needs a new
  // SQLite transaction just to prove a debit did not land.
  if(typeof readFence==="function")fence=readFence(id)||null;
  else fence=atomicRows.transact(["npcCargo"],tx=>
   tx.get("npcCargo","coopAmmoCycles_"+String(id)));
 }catch(_){return {status:"RECOVERY_SQLITE_UNAVAILABLE"}}
 const committed=receipt.modules.some(moduleID=>
  Number(fence?.modules?.[String(moduleID)]||0)>=receipt.boundaryMs);
 if(committed)return {status:"NEEDS_OPERATOR_REPAIR",
  reason:"SQLITE_FENCE_PROVES_COMMITTED_DEBIT",boundaryMs:receipt.boundaryMs};
 try{
  if(io.existsSync(lock)){
   const owner=JSON.parse(io.readFileSync(lock,"utf8"));
   if(owner?.entityID!==id||owner?.nonce!==receipt.nonce)
    return {status:"NEEDS_OPERATOR_REPAIR",reason:"BANK_LOCK_OWNER_MISMATCH"};
  }
  const current=readReceipt(file,io);
  if(current?.phase!=="PREPARED"||current.nonce!==receipt.nonce)
   return {status:"NEEDS_OPERATOR_REPAIR",reason:"BANK_JOURNAL_CHANGED"};
  writeAtomic(io,file,{...current,phase:"ABORTED",
   abortedAtMs:Number(clock()),abortReason:"NO_COMMITTED_SQLITE_FENCE"});
  if(io.existsSync(lock))io.unlinkSync(lock);
  syncDir(io,path.dirname(file));
  return {status:"ABORTED",entityID:id,boundaryMs:receipt.boundaryMs};
 }catch(_){return {status:"RECOVERY_PERSISTENCE_UNSAFE"}}
}
// Bounded discovery for the periodic recovery phase: only real journal files.
function listJournals({root,io=fs}={}){
 if(typeof root!=="string"||!path.isAbsolute(root))return {status:"INVALID_ROOT",entityIDs:[]};
 const dir=path.join(root,"bank-ships");
 let names;
 try{names=io.readdirSync(dir);}
 catch(e){if(e.code==="ENOENT")return {status:"EMPTY",entityIDs:[]};
  return {status:"UNAVAILABLE",entityIDs:[]};}
 const entityIDs=[];
 for(const name of names.slice(0,4096)){
  const match=/^([1-9]\d{0,15})\.json$/.exec(String(name));
  if(!match)continue;
  const id=Number(match[1]);
  if(!Number.isSafeInteger(id)||id<=0)continue;
  entityIDs.push(id);
 }
 entityIDs.sort((a,b)=>a-b);
 return {status:"OBSERVED",entityIDs:entityIDs.slice(0,256)};
}
function createAtomicAmmoBank({root,atomicRows,store,compatible,io=fs,clock=()=>Date.now(),faultProbe=null}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||
   typeof atomicRows?.transact!=="function"||
   typeof store?.listNativeCargoForEntity!=="function"||
   typeof compatible!=="function"||typeof clock!=="function"||
   (faultProbe!==null&&typeof faultProbe!=="function"))
  throw Error("BANK_ATOMIC_DEPENDENCIES_REQUIRED");
 function consume({entity,entries,whenMs}={}){
  const fail=status=>({success:false,errorMsg:status,stopReason:"ammo"});
  const entityID=pos(entity?.itemID),ownerID=pos(entity?.ownerID);
  if(entity?.kind!=="ship"||entity?.nativeNpc!==true||!entityID||!ownerID||
    !boundary(whenMs)||!Array.isArray(entries)||entries.length<1||entries.length>16||
    entity.session)return fail("BANK_ATOMIC_INVALID_IDENTITY");
  const seenModules=new Set(),seenCargo=new Set(),expected=[];
  for(const e of entries){
   const moduleID=pos(e?.moduleItem?.itemID),cargoID=pos(e?.chargeItem?.itemID),
    typeID=pos(e?.chargeItem?.typeID),amount=Number(e?.quantity||1),
    qty=Number(e?.chargeItem?.quantity??e?.chargeItem?.stacksize);
   if(!moduleID||!cargoID||!typeID||seenModules.has(moduleID)||
      seenCargo.has(cargoID)||amount!==1||!Number.isSafeInteger(qty)||qty<1)
    return fail("BANK_ATOMIC_BAD_MANIFEST");
   seenModules.add(moduleID);seenCargo.add(cargoID);
   expected.push({moduleID,cargoID,typeID,flagID:Number(e.moduleItem.flagID),
    moduleTypeID:pos(e.moduleItem.typeID),qty,original:e.chargeItem});
  }
  let shipRow=null;
  try{
   shipRow=typeof store.getNativeEntity==="function"?
    store.getNativeEntity(entityID):null;
  }catch{shipRow=null}
  // The native ship record is read before the transaction on purpose: the
  // npcEntities table carries transient rows for transient hulls, and the
  // transient-cargo contract cannot cover that table, so declaring it made the
  // GameStore owner refuse every bank transaction. Ownership is still proven
  // inside the transaction by every module and cargo row's own entityID and
  // ownerID, which must equal this verified owner.
  if(!shipRow||Number(shipRow.entityID)!==entityID||
   Number(shipRow.ownerID)!==ownerID||!pos(shipRow.systemID))
   return fail("BANK_ATOMIC_INVALID_IDENTITY");
  // Verify every fitted module against the native store BEFORE the transaction,
  // because npcModules carries transient rows and cannot join the cargo contract.
  let fittedModules;
  try{fittedModules=store.listNativeModulesForEntity(entityID);}
  catch{return fail("BANK_ATOMIC_MODULE_PROOF_UNAVAILABLE")}
  if(!Array.isArray(fittedModules))return fail("BANK_ATOMIC_MODULE_PROOF_UNAVAILABLE");
  for(const part of expected){
   const fitted=fittedModules.filter(row=>Number(row?.moduleID)===part.moduleID);
   if(fitted.length!==1)return fail("BANK_ATOMIC_MODULE_NOT_VERIFIED");
   part.fitted=fitted[0];
  }
  let token,recovery=null;
  try{token=prepare(io,root,entityID,seenModules,whenMs,clock);}
  catch(error){
   // Recover a provably uncommitted PREPARED journal, then retry once. Without
   // this a single failed transaction quarantines a real warship forever.
   recovery=recoverUncommitted({root,entityID,atomicRows,io,clock});
   if(recovery.status!=="ABORTED")
    return fail("BANK_ATOMIC_JOURNAL_UNSAFE");
   try{token=prepare(io,root,entityID,seenModules,whenMs,clock);}
   catch(_){return fail("BANK_ATOMIC_JOURNAL_UNSAFE");}
  }
  // Test-only crash probe. Runtime never passes this injectable callback.
  if(faultProbe)try{faultProbe("after-prepared",token);}catch(_){
   return fail("BANK_ATOMIC_FAULT_PROBE_STOP");
  }
  let updated;
  try{
   updated=atomicRows.transact(["npcCargo"],tx=>{
    const cargo=tx.get("npcCargo","cargo");
    if(!cargo||typeof cargo!=="object"||Array.isArray(cargo))
     throw Error("BANK_NATIVE_CARGO_UNAVAILABLE");
    const fenceKey="coopAmmoCycles_"+String(entityID);
    const previousFence=tx.get("npcCargo",fenceKey);
    if(previousFence!==null&&(previousFence?.version!==1||
       previousFence.entityID!==entityID||
       !previousFence.modules||typeof previousFence.modules!=="object"||
       Array.isArray(previousFence.modules)||
       (previousFence.outcomeRequired!==undefined&&
        typeof previousFence.outcomeRequired!=="boolean")))
     throw Error("BANK_NATIVE_FENCE_CORRUPT");
    // SQLite retains a per-ship mode latch even if the POSIX root is lost.
    if(previousFence?.outcomeRequired===true&&
       process.env.EVEJS_COOP_NPC_BANK_OUTCOME_WITNESS!=="1")
     throw Error("BANK_NATIVE_OUTCOME_DOWNGRADE_FORBIDDEN");
    // COOP-046: the operator can rotate/misplace a POSIX root, but native
    // SQLite keeps prior debits. A new empty root must NEVER silently
    // bootstrap a new accepted outcome history for an already-spent ship.
    if(process.env.EVEJS_COOP_NPC_BANK_OUTCOME_WITNESS==="1"){
     // An ABORTED journal is a proven non-debit: it carries no SQLite history,
     // so it must not look like a rotated/lost root.
     const priorReceipt=token.previousReceipt;
     const previousReceipt=priorReceipt&&priorReceipt.phase==="COMMITTED"?
      priorReceipt:null;
     const exists=previousFence!==null;
     if(exists!==Boolean(previousReceipt))
      throw Error("BANK_NATIVE_JOURNAL_FENCE_DIVERGED");
     if(exists){
      if(previousReceipt.phase!=="COMMITTED"||
         !Array.isArray(previousReceipt.modules)||
         !previousReceipt.modules.length||
         previousReceipt.modules.some(mid=>
          Number(previousFence.modules[String(mid)])!==previousReceipt.boundaryMs))
       throw Error("BANK_NATIVE_JOURNAL_FENCE_MISMATCH");
     }
    }
    const fences={...(previousFence?.modules||{})};
    const next={...cargo};
    const result=[];
    for(const part of expected){
     // The fitted module row was verified from the same native store before this
     // transaction: the npcModules table carries transient rows for transient
     // hulls and cannot be part of the cargo contract, and the event loop cannot
     // interleave a module change between that synchronous read and this commit.
     const fitted=part.fitted;
     const row=next[String(part.cargoID)];
     if(!fitted||Number(fitted.moduleID)!==part.moduleID||
       Number(fitted.entityID)!==entityID||
       Number(fitted.ownerID)!==ownerID||
       Number(fitted.categoryID)!==7||
       Number(fitted.flagID)!==part.flagID||
       (part.moduleTypeID&&Number(fitted.typeID)!==part.moduleTypeID)||
       compatible(fitted,part.typeID)!==true)
      throw Error("BANK_NATIVE_MODULE_CHANGED");
     if(!row||Number(row.cargoID)!==part.cargoID||
       Number(row.entityID)!==entityID||
       Number(row.moduleID)!==part.moduleID||
       Number(row.ownerID)!==ownerID||
       Number(row.typeID)!==part.typeID||
       Number(row.categoryID)!==8||
       !compatibleCargoFlag(row,part.flagID)||
       Number(row.quantity)!==part.qty||
       row.transient===true)
      throw Error("BANK_NATIVE_CARGO_STALE");
     const last=Number(fences[String(part.moduleID)]||0);
     if(!Number.isFinite(last)||last>=whenMs)
      throw Error("BANK_NATIVE_CYCLE_REPLAY");
     const remaining=part.qty-1;
     if(remaining>0)next[String(part.cargoID)]={...row,quantity:remaining};
     else delete next[String(part.cargoID)];
     fences[String(part.moduleID)]=whenMs;
     result.push({moduleID:part.moduleID,cargoID:part.cargoID,
      typeID:part.typeID,previousQuantity:part.qty,nextQuantity:remaining});
    }
    if(Object.keys(fences).length>2048)
     throw Error("BANK_NATIVE_FENCE_LIMIT");
    tx.put("npcCargo","cargo",next);
    tx.put("npcCargo",fenceKey,{version:1,entityID,modules:fences,
     outcomeRequired:previousFence?.outcomeRequired===true||
      process.env.EVEJS_COOP_NPC_BANK_OUTCOME_WITNESS==="1"});
    return result;
   },{contract:"npc-ammo-bank"});
  }catch(error){
   // A swallowed error here is an undiagnosable deadlock: the ship stays
   // quarantined forever with no reason on record. Keep the fail-closed
   // result, but name the real cause in the server log.
   console.warn("[CoopAmmoBank] transaction refused",
    String(error&&error.message||error));
   return fail("BANK_ATOMIC_TRANSACTION_UNCERTAIN");
  }
  if(faultProbe)try{faultProbe("after-sqlite-commit",token);}catch(_){
   return fail("BANK_ATOMIC_FAULT_PROBE_STOP");
  }
  // Re-read real post-transaction GameStore state before marking the
  // separate POSIX journal COMMITTED. Unknown state never retries/refunds.
  try{
   const rows=store.listNativeCargoForEntity(entityID);
   if(!Array.isArray(rows))return fail("BANK_ATOMIC_READBACK_UNSAFE");
   for(const row of updated){
    const actual=rows.filter(x=>Number(x.cargoID)===row.cargoID);
    if(row.nextQuantity===0?actual.length!==0:
      actual.length!==1||Number(actual[0].quantity)!==row.nextQuantity||
       Number(actual[0].entityID)!==entityID||
       Number(actual[0].ownerID)!==ownerID||
       Number(actual[0].moduleID)!==row.moduleID||
       Number(actual[0].typeID)!==row.typeID||
       !compatibleCargoFlag(actual[0],expected.find(x=>x.moduleID===row.moduleID)?.flagID))
     return fail("BANK_ATOMIC_READBACK_MISMATCH");
   }
   settle(io,token);
  }catch(_){return fail("BANK_ATOMIC_SETTLEMENT_UNSAFE");}
  // Only after verified native persistence AND durable commit do we touch
  // the in-scene NPC cargo cache. Never spawn projectiles from this module.
  const byCargo=new Map(updated.map(r=>[r.cargoID,r]));
  if(Array.isArray(entity.nativeCargoItems)){
   entity.nativeCargoItems=entity.nativeCargoItems.flatMap(item=>{
    const r=byCargo.get(Number(item?.itemID));
    if(!r)return [item];
    return r.nextQuantity>0?[{...item,quantity:r.nextQuantity,
      stacksize:r.nextQuantity}]:[];
   });
  }
  return {success:true,results:updated.map(r=>{
   const part=expected.find(e=>e.moduleID===r.moduleID);
   const chargeItem=r.nextQuantity>0
    ? {...part.original,quantity:r.nextQuantity,stacksize:r.nextQuantity}
    : null;
   return {moduleID:r.moduleID,result:{
    success:true,
    data:{chargeItem,previousQuantity:r.previousQuantity,
     nextQuantity:r.nextQuantity,depleted:r.nextQuantity===0},
    stopReason:r.nextQuantity===0?"ammo":null
   }};
  })};
 }
 return {consume};
}
// A direct per-module/native legacy write must never bypass SQLite fences
// that were minted by a previous atomic weapon-bank transaction.
function verifyDirectDebit({entity,root,io=fs,database,env=process.env}={}){
 const fail=status=>({allowed:false,status});
 if(entity?.nativeNpc!==true||entity?.kind!=="ship")
  return {allowed:true,status:"NON_NPC_UNCHANGED"};
 const id=pos(entity?.itemID);
 if(!id)return fail("BANK_DIRECT_IDENTITY_INVALID");
 if(env.EVEJS_COOP_NPC_BANK_ATOMIC==="1")
  return fail("BANK_ATOMIC_DIRECT_DEBIT_FORBIDDEN");
 try{
  const journalRoot=root||env.EVEJS_COOP_NPC_AMMO_DEBIT_ROOT||
   "/var/lib/evejs/coop-npc-ammo-debits";
  const receipt=inspectShip({root:journalRoot,entityID:id,io});
  if(!receipt.ok)return fail("BANK_DIRECT_JOURNAL_UNSAFE");
  if(receipt.receipt)return fail("BANK_DIRECT_RECEIPT_PRESENT");
  const db=database||require("../gameStore");
  if(typeof db?.read!=="function")return fail("BANK_DIRECT_NATIVE_STORE_UNAVAILABLE");
  const fence=db.read("npcCargo","/coopAmmoCycles_"+String(id));
  if(fence?.success===true)return fail("BANK_DIRECT_SQLITE_FENCE_PRESENT");
  if(fence?.success!==false||fence.errorMsg!=="ENTRY_NOT_FOUND")
   return fail("BANK_DIRECT_NATIVE_READ_UNSAFE");
  return {allowed:true,status:"BANK_DIRECT_NO_ATOMIC_HISTORY"};
 }catch(_){return fail("BANK_DIRECT_GUARD_UNSAFE");}
}
function guardDirectDebit({entity}={}){
 if(entity?.nativeNpc!==true||entity?.kind!=="ship")
  return {allowed:true,status:"NON_NPC_UNCHANGED"};
 if(process.env.EVEJS_COOP_NPC_STRICT_AMMO!=="1"&&
  process.env.EVEJS_COOP_NPC_BANK_ATOMIC!=="1")
  return {allowed:true,status:"LEGACY_UNCHANGED"};
 return verifyDirectDebit({entity});
}
function consumeBank(args){
 if(!gate(process.env))
  return {success:false,errorMsg:"BANK_ATOMIC_FLAG_INCOMPLETE",stopReason:"ammo"};
 try{
  const gameStore=require("../gameStore");
  const store=require("./npc/nativeNpcStore");
  const compatible=require("./npc/npcCapabilityResolver").isNpcChargeCompatibleWithModule;
  const root=process.env.EVEJS_COOP_NPC_AMMO_DEBIT_ROOT||
   "/var/lib/evejs/coop-npc-ammo-debits";
  return createAtomicAmmoBank({root,atomicRows:gameStore.coopAtomicNativeRows,
   store,compatible}).consume(args);
 }catch(_){return {success:false,errorMsg:"BANK_ATOMIC_UNAVAILABLE",stopReason:"ammo"};}
}
module.exports={createAtomicAmmoBank,inspectShip,ensureJournalRoot,recoverUncommitted,listJournals,consumeBank,gate,verifyDirectDebit,guardDirectDebit};
