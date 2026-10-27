"use strict";
// Restart resilience (path B): a durable haul-cargo row keeps its original
// native cargoID, but after a process restart the hauler that loaded it no
// longer exists. The ore then waits on disk as an orphan while the re-seeded
// fleet starts its cycle from zero. This module re-attaches such orphans to
// the live hauler of the SAME solar system and the SAME fleet slot exactly
// once, then hands the fleet back to the normal loaded -> station -> sell
// pipeline. It never creates cargo, never grants station stock and never
// invents a destination.
const load=name=>{try{return require("./"+name)}catch(_error){return require("./"+name+".cjs")}};
const {observe,noteOnce}=load("coopObserve");
const pos=v=>{const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:0;};
const DEFAULT_TTL_MS=45*60*1000;
// Adoption is idempotent by cargo state (an adopted row carries
// coopHaulAdoptedAt and is no longer an orphan), so no time throttle is needed
// and a failure must never consume the slot: only a real ADOPTED is final.
const doneSlots=new Set();
const noted=new Set();
const loadFlag=name=>{try{return require("./"+name)}catch(_error){return require("./"+name+".cjs")}};
const flags=loadFlag("coopFlags");
function enableFlag(){return flags.on("EVEJS_COOP_HAUL_CARGO_ADOPTION");}
function dependenciesOf(options={}){
 return {store:options.store||require("./npc/nativeNpcStore"),
  probe:options.probe||require("./coopRuntimeProbe"),
  database:options.database||null,
  cargoTable:options.cargoTable||null,
  clock:options.clock||(()=>Date.now())};
}
// The pinned store exports listNativeCargoForEntity but NOT a global
// listNativeCargo, so the durable table is read through gameStore when the
// store cannot enumerate.
function cargoRows({store,cargoTable,database}={}){
 if(typeof store?.listNativeCargo==="function"){
  // The native store re-reads and deep-clones the whole cargo table on every
  // call, and a plan runs per hauler per pass. One cached read per cache window
  // replaces that; the TTL is the staleness bound for custody decisions.
  const all=require("./coopNativeReadCache"+(__filename.endsWith(".js")?"":".cjs"))
   .nativeCache().allCargoRows();
  if(Array.isArray(all))return all;
 }
 let read=cargoTable;
 if(typeof read!=="function"){
  const db=database||require("../gameStore");
  read=()=>{
   const result=db.read?.("npcCargo","/cargo");
   // GameStore.read returns a result envelope, not the native table itself.
   // A failed or malformed read is unverified custody, never "no ore".
   return result?.success===true?result.data:null;
  };
 }
 const table=read();
 return table&&typeof table==="object"&&!Array.isArray(table)?
  Object.values(table):null;
}
function liveShip(scene,id){
 const entity=scene?.getEntityByID?.(Number(id));
 return entity?.kind==="ship"&&pos(entity.itemID)===Number(id)?entity:null;
}
// Missing or failing native entity registry is NOT proof a former hauler
// has disappeared. Reusing its original cargo would duplicate custody.
const REGISTRY_UNVERIFIED=Symbol("NATIVE_ENTITY_REGISTRY_UNVERIFIED");
// Only an actual successful in-process exclusive claim can exempt its OWN lock.
// plan() is exported, so caller-supplied fake Sets must never bypass custody.
const authoritativeLockClaims=new WeakSet();
function stillRegistered(store,entityID){
 if(typeof store?.getNativeEntity!=="function")return REGISTRY_UNVERIFIED;
 try{return store.getNativeEntity(Number(entityID))||null}
 catch(_error){return REGISTRY_UNVERIFIED}
}
// On a second restart, a prior adoption marker is not by itself proof
// that original cargo was delivered. However, deleting that marker alone
// would also allow a sold stack to be hauled and paid a second time.
// This read-only check must verify ALL settlement authorities before a
// single source row can move. Missing authority is never an empty ledger.
function verifyReAdoptionCustody(row, options={}, ownedLocks=null) {
 const cargoID=pos(row?.cargoID);
 if(!cargoID)return "RE_ADOPTION_SETTLEMENT_UNVERIFIED";
 try{
  const path=require("node:path");
  const io=options.custodyIo||require("node:fs");
  // No guessed default: the path must match the actual native warehouse
  // writer. Missing configuration is unknown settlement, not no receipt.
  const root=options.warehouseRoot||
   process.env.EVEJS_COOP_NATIVE_WAREHOUSE_ROOT;
  if(typeof root!=="string"||!path.isAbsolute(root)||
     typeof io?.readdirSync!=="function")
   return "RE_ADOPTION_SETTLEMENT_UNVERIFIED";
  const names=io.readdirSync(path.join(root,"receipts"));
  if(!Array.isArray(names))return "RE_ADOPTION_SETTLEMENT_UNVERIFIED";
  // Warehouse uses <cargoID>.lock BEFORE writing PREPARED. A concurrent
  // or crash-abandoned lock is already custody evidence, even without a
  // receipt. Noncanonical numeric aliases must not disguise a claimed
  // original cargoID either (the warehouse audit treats them as corrupt).
  if(names.some(name=>typeof name!=="string"))
   return "RE_ADOPTION_SETTLEMENT_UNVERIFIED";
  const warehouseClaim=names.some(name=>{
   const match=/^(\d+)\.(?:json(?:\.tmp-[^/\\]*)?|lock)$/.exec(name);
   return match&&Number(match[1])===cargoID&&
    !(name===cargoID+".lock"&&ownedLocks instanceof Set&&
      authoritativeLockClaims.has(ownedLocks)&&ownedLocks.has(cargoID));
  });
  if(warehouseClaim)return "RE_ADOPTION_WAREHOUSE_RECEIPT_EXISTS";
  const items=options.custodyItems||
   require("../services/inventory/itemStore");
  if(typeof items?.findWarehouseItem!=="function")
   return "RE_ADOPTION_SETTLEMENT_UNVERIFIED";
  // findWarehouseItem searches the unique original physical cargoID tag.
  // Any matching item may have been paid, sold, or reserved; never replay.
  if(items.findWarehouseItem({cargoID}))
   return "RE_ADOPTION_WAREHOUSE_ITEM_EXISTS";
  const depot=options.custodyDepot||
   require("./coopNativeDepot").getNativeDepot();
  if(typeof depot?.snapshot!=="function")
   return "RE_ADOPTION_SETTLEMENT_UNVERIFIED";
  const state=depot.snapshot();
  if(state?.version!==1||!state.receipts||!state.pending||
     typeof state.receipts!=="object"||typeof state.pending!=="object"||
     Array.isArray(state.receipts)||Array.isArray(state.pending))
   return "RE_ADOPTION_SETTLEMENT_UNVERIFIED";
  // An explicit prior receipt denies the second haul even if unrelated
  // journal fields are malformed; preserve this stronger direct witness.
  if(Object.hasOwn(state.receipts,String(cargoID))||
     Object.hasOwn(state.pending,String(cargoID)))
   return "RE_ADOPTION_DEPOT_RECEIPT_EXISTS";
  if(typeof depot.audit!=="function"||!state.totals||
     typeof state.totals!=="object"||Array.isArray(state.totals))
   return "RE_ADOPTION_SETTLEMENT_UNVERIFIED";
  // Absence of an individual receipt is NOT evidence that no credit was
  // committed if the global depot journal is inconsistent. In particular,
  // an empty receipts map with positive persisted totals may mean a receipt
  // disappeared after a prior settlement. Never resurrect such cargo.
  const audit=depot.audit();
  if(audit?.status!=="OK"||audit.invalid!==0||
     audit.unresolved!==0||!Number.isSafeInteger(audit.committed)||
     audit.committed<0)
   return "RE_ADOPTION_DEPOT_AUDIT_UNVERIFIED";
  return "CLEAR";
 }catch(_error){return "RE_ADOPTION_SETTLEMENT_UNVERIFIED"}
}
// Lock the SAME <cargoID>.lock used by coopNativeWarehouse. No lock
// removal unless our own exclusive wx acquired it; crashed locks stay put.
function acquireReAdoptionLocks(rows,options={}){
 const fs=require("node:fs"),path=require("node:path");
 const io=options.custodyIo||fs;
 const root=options.warehouseRoot||process.env.EVEJS_COOP_NATIVE_WAREHOUSE_ROOT;
 if(typeof root!=="string"||!path.isAbsolute(root)||
    ["openSync","writeFileSync","fsyncSync","closeSync","unlinkSync","readdirSync"]
     .some(method=>typeof io?.[method]!=="function"))
  return {status:"RE_ADOPTION_LOCK_AUTHORITY_UNVERIFIED"};
 const ids=rows.map(row=>pos(row.cargoID));
 if(ids.some(id=>!id)||new Set(ids).size!==ids.length)
  return {status:"RE_ADOPTION_LOCK_AUTHORITY_UNVERIFIED"};
 const dir=path.join(root,"receipts"),held=new Set();
 let released=false;
 function release(){
  authoritativeLockClaims.delete(held);
  if(released)return true;
  let ok=true;
  for(const id of [...held].reverse()){
   try{io.unlinkSync(path.join(dir,id+".lock"));held.delete(id)}
   catch(_error){ok=false}
  }
  if(ok)released=true;
  return ok;
 }
 try{
  for(const id of ids.sort((a,b)=>a-b)){
   const fd=io.openSync(path.join(dir,id+".lock"),"wx",0o600);
   held.add(id);
   try{io.writeFileSync(fd,String(process.pid));io.fsyncSync(fd);}
   finally{io.closeSync(fd);}
  }
  authoritativeLockClaims.add(held);
  return {status:"HELD",held,release};
 }catch(error){
  const cleared=release();
  return {status:!cleared?"RE_ADOPTION_LOCK_RELEASE_UNVERIFIED":
   error?.code==="EEXIST"?"RE_ADOPTION_WAREHOUSE_LOCKED":
   "RE_ADOPTION_LOCK_AUTHORITY_UNVERIFIED"};
 }
}
// Which orphans may this exact fleet slot adopt? Every condition is an
// independent refusal, so a missing or odd field never guesses ownership.
function plan({store,scene,systemID,fleetID,now,ttlMs=DEFAULT_TTL_MS,
 cargoTable,database,enableReAdoption=false,custodyOptions,ownedLocks=null}={}){
 const pid=pos(systemID),fid=pos(fleetID);
 if(!pid||!fid||!scene||!Number.isSafeInteger(now)||now<=0)
  return {status:"INVALID_AUTHORITIES",rows:[]};
 let all;try{all=cargoRows({store,cargoTable,database})}
 catch(_error){return {status:"CARGO_UNAVAILABLE",rows:[]}}
 if(!Array.isArray(all))return {status:"CARGO_UNAVAILABLE",rows:[]};
 // A corrupt native enumeration may expose the same original cargoID more
 // than once. Never count it twice or overwrite its custody under two rows.
 const cargoIDCount=new Map();
 for(const row of all){
  const cargoID=pos(row?.cargoID);
  if(cargoID)cargoIDCount.set(cargoID,(cargoIDCount.get(cargoID)||0)+1);
 }
 const rows=[];
 for(const row of all){
  // A row tagged for this fleet/system belongs to its original haul batch.
  // Never silently skip a damaged sibling and adopt/sell only the valid
  // portion. The whole tagged batch needs operator reconciliation instead.
  if(!row||typeof row!=="object"||
     Number(row.coopHaulFleetID)!==fid||
     Number(row.coopHaulSystemID)!==pid)continue;
  if(row.transient!==false||Number(row.moduleID||0)!==0||
     !pos(row.cargoID)||!pos(row.typeID)||!pos(row.quantity)||
     !pos(row.coopHaulFromMinerID)||!pos(row.entityID))
   return {status:"ORIGINAL_HAUL_CARGO_UNVERIFIED",rows:[]};
  if(cargoIDCount.get(pos(row.cargoID))!==1)
   return {status:"NATIVE_CARGO_ID_COLLISION",rows:[]};
  // A cargo still on a physical live ship is not an orphan. This includes
  // the current replacement hauler: its existing load is rejected below
  // by HAULER_ALREADY_LOADED, not mistaken for a corrupt orphan batch.
  if(liveShip(scene,row.entityID))continue;
  // Never reinterpret a damaged historical adoption as a first adoption:
  // that would bypass the warehouse/ItemStore/depot replay guards.
  const adoptedAt=pos(row.coopHaulAdoptedAt);
  const adoptedFrom=pos(row.coopHaulAdoptedFrom);
  const hasHistory=Object.hasOwn(row,"coopHaulAdoptedAt")||
   Object.hasOwn(row,"coopHaulAdoptedFrom");
  if(hasHistory&&(!adoptedAt||!adoptedFrom||
     adoptedFrom===pos(row.entityID)||adoptedAt>now))
   return {status:"RE_ADOPTION_HISTORY_UNVERIFIED",rows:[]};
  if(adoptedAt&&!enableReAdoption)continue;
  const loadedAt=Number(row.coopHaulLoadedAt);
  if(!Number.isFinite(loadedAt)||loadedAt<=0||loadedAt>now)continue;
  if(adoptedAt&&adoptedAt<loadedAt)
   return {status:"RE_ADOPTION_HISTORY_UNVERIFIED",rows:[]};
  const witnessAt=adoptedAt||loadedAt;
  if(witnessAt>now||now-witnessAt>ttlMs)continue;
  const registered=stillRegistered(store,row.entityID);
  if(registered===REGISTRY_UNVERIFIED)
   return {status:"NATIVE_ENTITY_REGISTRY_UNVERIFIED",rows:[]};
  if(registered)continue;
  if(adoptedAt){
   const custody=verifyReAdoptionCustody(row,custodyOptions,ownedLocks);
   if(custody!=="CLEAR")return {status:custody,rows:[]};
  }
  rows.push(row);
 }
 return {status:rows.length?"ADOPTABLE":"NO_ORPHAN_CARGO",rows};
}
// adopt() is idempotent per process and per fleet slot. A row may only be
// re-pointed while its original hauler is provably gone, and its cargoID is
// preserved so every existing receipt/audit identity still matches.
function adopt(scene,fleet,options={}){
 if(!enableFlag())return {status:"DISABLED"};
 const {store,probe,database,clock}=dependenciesOf(options);
 const systemID=pos(scene?.systemID),fleetID=pos(fleet?.fleetID);
 const now=Number(clock());
 if(!Number.isSafeInteger(now)||now<=0)
  return {status:"INVALID_CLOCK",adopted:0};
 if(!systemID||!fleetID||systemID!==pos(fleet?.systemID))
  return {status:"INVALID_FLEET"};
 const key=systemID+":"+fleetID;
 if(doneSlots.has(key))return {status:"ALREADY_ATTEMPTED"};
 const ttlMs=flags.number("EVEJS_COOP_HAUL_CARGO_ADOPTION_TTL_MS",DEFAULT_TTL_MS);
 const planned=plan({store,scene,systemID,fleetID,now,ttlMs,
  cargoTable:options.cargoTable,database,
  enableReAdoption:flags.on("EVEJS_COOP_HAUL_CARGO_RE_ADOPTION"),
  custodyOptions:options});
 if(planned.status!=="ADOPTABLE"){
  // One status line per slot, not one per native tick.
  if(planned.status!=="NO_ORPHAN_CARGO")
   noteOnce(noted,key,probe,"living-haul-cargo-adoption-skipped",
    {systemID},{fleetID,status:planned.status});
  return {status:planned.status,adopted:0};
 }
 // A fresh slot may keep mining; an active trip or a fleet already holding
 // durable cargo must never receive a second batch.
 if(String(fleet?.state||"")!=="mining"||fleet?.coopStationArrival||
    fleet?.coopHaulNeedsOperatorRepair)
  return {status:"FLEET_NOT_IDLE",adopted:0};
 const haulerIDs=(fleet.haulerEntityIDs||[]).map(pos).filter(Boolean);
 if(haulerIDs.length!==1||(fleet.haulerEntityIDs||[]).length!==1)
  return {status:"HAULER_NOT_UNIQUE",adopted:0};
 const hauler=liveShip(scene,haulerIDs[0]);
 if(!hauler)return {status:"HAULER_NOT_UNIQUE",adopted:0};
 const haulerID=pos(hauler.itemID),ownerID=pos(hauler.ownerID);
 if(!haulerID||!ownerID)return {status:"HAULER_NOT_ATTESTED",adopted:0};
 // A fleet slot is NOT corporate title: fleet IDs can be reused across
 // original NPC owners. Never transfer a cargo item to a different owner
 // merely by adopting its previous hauler's stale entityID.
 // Validate the entire batch before any original cargo row is rewritten.
 if(planned.rows.some(row=>pos(row.ownerID)!==ownerID))
  return {status:"ORIGINAL_CARGO_OWNER_MISMATCH",adopted:0};
 // A missing/throwing native inventory read is not proof this ship is empty.
 // Require authoritative original custody before changing a single cargoID.
 let existing;
 try{existing=store.listNativeCargoForEntity(haulerID)}
 catch(_error){return {status:"HAULER_CARGO_PREFLIGHT_UNVERIFIED",adopted:0}}
 if(!Array.isArray(existing)||existing.some(x=>
    !pos(x?.cargoID)||pos(x?.entityID)!==haulerID||
    pos(x?.ownerID)!==ownerID||x?.transient===true))
  return {status:"HAULER_CARGO_PREFLIGHT_UNVERIFIED",adopted:0};
 // A recovery hauler must be truly empty. An untagged same-owner
 // stack (salvage, old ore, or another job) is still physical cargo: mixing
 // it into the loaded NPC route could deliver or account for someone else's
 // goods. A fleet tag is NOT the definition of an empty hold.
 if(existing.length>0)return {status:"HAULER_ALREADY_LOADED",adopted:0};
 // A partial per-ship adapter can claim empty while the original global
 // table still assigns cargo to this hauler. Both views must agree before
 // reparenting the first cargoID.
 let globalBefore;
 try{globalBefore=cargoRows({store,cargoTable:options.cargoTable,database})}
 catch(_error){return {status:"HAULER_CARGO_PREFLIGHT_UNVERIFIED",adopted:0}}
 if(!Array.isArray(globalBefore))
  return {status:"HAULER_CARGO_PREFLIGHT_UNVERIFIED",adopted:0};
 if(globalBefore.some(row=>pos(row?.entityID)===haulerID))
  return {status:"HAULER_ALREADY_LOADED",adopted:0};
 // Repeat-adoption requires the SAME warehouse writer lock across the
 // second settlement check, native upsert, flush and final readback.
 const needsReAdoption=planned.rows.some(row=>pos(row.coopHaulAdoptedAt));
 const custodyLock=needsReAdoption?acquireReAdoptionLocks(planned.rows,options):null;
 if(custodyLock&&custodyLock.status!=="HELD")
  return {status:custodyLock.status,adopted:0};
 try{
  if(custodyLock){
   const current=plan({store,scene,systemID,fleetID,now,ttlMs,
    cargoTable:options.cargoTable,database,enableReAdoption:true,
    custodyOptions:options,ownedLocks:custodyLock.held});
   if(current.status!=="ADOPTABLE")
    return {status:current.status,adopted:0};
   const originals=new Map(planned.rows.map(row=>[pos(row.cargoID),JSON.stringify(row)]));
   if(current.rows.length!==planned.rows.length||current.rows.some(row=>
      originals.get(pos(row.cargoID))!==JSON.stringify(row)))
    return {status:"RE_ADOPTION_SOURCE_CHANGED",adopted:0};
   try{
    const local=store.listNativeCargoForEntity(haulerID);
    const global=cargoRows({store,cargoTable:options.cargoTable,database});
    if(!Array.isArray(local)||!Array.isArray(global))
     return {status:"RE_ADOPTION_PREFLIGHT_UNVERIFIED",adopted:0};
    if(local.length||global.some(row=>pos(row?.entityID)===haulerID))
     return {status:"HAULER_ALREADY_LOADED",adopted:0};
   }catch(_error){return {status:"RE_ADOPTION_PREFLIGHT_UNVERIFIED",adopted:0};}
  }
 // Upserts are not a GameStore transaction. A failed second write
 // cannot turn a partially transferred batch into an authorised haul.
 // Include the failing row: an adapter may mutate then return failure.
 const flushCargo=()=>{
  try{
   const db=database||require("../gameStore");
   return db?.flushTableSync?.("npcCargo")?.success===true;
  }catch(_error){return false}
 };
 const restore=(touched,status,detail)=>{
  let restored=true;
  for(const row of [...touched].reverse()){
   try{
    const result=store.upsertNativeCargo({...row},{transient:false});
    if(result?.success!==true)restored=false;
   }catch(_error){restored=false}
  }
  // The original custody must be re-flushed after compensation, not just
  // restored to an in-memory table. Unknown rollback means operator hold.
  const durable=flushCargo();
  // Upsert and flush ACKs do not prove that the original cargo rows were
  // restored. Some adapters can acknowledge a write yet silently keep the
  // replacement-hauler row. Read back every original cargoID globally and
  // confirm exact source custody before permitting a later retry.
  let verified=false;
  if(restored&&durable){
   try{
    const all=cargoRows({store,cargoTable:options.cargoTable,database});
    const target=store.listNativeCargoForEntity(haulerID);
    const custodyFields=["cargoID","entityID","ownerID","typeID","quantity",
     "moduleID","transient","coopHaulFleetID","coopHaulSystemID",
     "coopHaulFromMinerID","coopHaulLoadedAt","coopHaulAdoptedAt",
     "coopHaulAdoptedFrom"];
    const same=(actual,original)=>custodyFields.every(field=>
     Object.hasOwn(actual,field)===Object.hasOwn(original,field)&&
     Object.is(actual[field],original[field]));
    // Initial preflight proved an empty hold: compensation must restore it.
    verified=Array.isArray(all)&&Array.isArray(target)&&
     target.length===0&&
     all.every(row=>pos(row?.entityID)!==haulerID)&&
     touched.every(original=>{
      const hits=all.filter(row=>pos(row?.cargoID)===pos(original.cargoID));
      return hits.length===1&&same(hits[0],original)&&
       !target.some(row=>pos(row?.cargoID)===pos(original.cargoID));
     });
   }catch(_error){verified=false}
  }
  if(!restored||!durable||!verified){
   fleet.coopHaulNeedsOperatorRepair=true;
   hauler.coopHaulNeedsOperatorRepair="ADOPTION_RECOVERY_UNVERIFIED";
   doneSlots.add(key);
   noteOnce(noted,key+":recovery",probe,"living-haul-cargo-adoption-skipped",
    {systemID},{fleetID,status:"ADOPTION_RECOVERY_UNVERIFIED",reason:status});
   return {status:"ADOPTION_RECOVERY_UNVERIFIED",detail,adopted:0};
  }
  noteOnce(noted,key+":"+status,probe,"living-haul-cargo-adoption-skipped",
   {systemID},{fleetID,status,rows:touched.length});
  return {status,detail,adopted:0};
 };
 let adopted=0,quantity=0,volume=0,failed=null;
 const attempted=[];
 for(const row of planned.rows){
  const next={...row,entityID:haulerID,ownerID,
   coopHaulFleetID:fleetID,coopHaulSystemID:systemID,
   coopHaulAdoptedAt:now,coopHaulAdoptedFrom:pos(row.entityID)};
  attempted.push(row);
  let result;try{result=store.upsertNativeCargo(next,{transient:false})}
  catch(error){failed=String(error?.message||error).slice(0,80);break}
  if(!result||result.success!==true){failed=String(result?.errorMsg||"UPSERT_REJECTED");break}
  adopted+=1;quantity+=pos(next.quantity);
  volume+=pos(next.quantity)*Math.max(0,Number(row.volume)||0);
 }
 if(failed!==null)return restore(attempted,"ADOPTION_REJECTED",failed);
 // The entire original cargo batch must be durable before sailing.
 if(!flushCargo())return restore(attempted,"CARGO_FLUSH_FAILED",null);
 // A successful flush is not yet evidence the replacement ship can read
 // every original source cargoID. The writer could silently omit one
 // row, or the post-commit inventory adapter could throw. Do not put a
 // half-observed loaded ship into the live hauling / selling lifecycle.
 let cargoItems,readback;
 try{
  // The target ship's local view is not global custody proof. A broken
  // upsert could leave the original row visible on the former hauler while
  // returning a correct-looking new-hauler view. Check the original cargoID
  // across the WHOLE native store after durable flush, before starting warp.
  const allCommitted=cargoRows({store,cargoTable:options.cargoTable,database});
  if(!Array.isArray(allCommitted))
   throw Error("ORIGINAL_CARGO_GLOBAL_READBACK_UNAVAILABLE");
  const intended=new Set(planned.rows.map(row=>pos(row.cargoID)));
  const globalHits=new Map();
  for(const entry of allCommitted){
   const id=pos(entry?.cargoID);
   if(intended.has(id)){
    const group=globalHits.get(id)||[];
    group.push(entry);
    globalHits.set(id,group);
   }
  }
  // Exact global membership matters: other physical cargoIDs cannot ride
  // the recovered ore under the same loaded/settlement lifecycle.
  const targetGlobal=allCommitted.filter(row=>pos(row?.entityID)===haulerID);
  if(targetGlobal.length!==planned.rows.length||
     targetGlobal.some(row=>!intended.has(pos(row?.cargoID))))
   throw Error("ORIGINAL_CARGO_GLOBAL_HOLD_CONTAINS_UNPLANNED_ITEMS");
  if(planned.rows.some(row=>{
   const matches=globalHits.get(pos(row.cargoID))||[];
   return matches.length!==1||
    pos(matches[0].entityID)!==haulerID||
    pos(matches[0].ownerID)!==ownerID||
    pos(matches[0].typeID)!==pos(row.typeID)||
    pos(matches[0].quantity)!==pos(row.quantity)||
    pos(matches[0].coopHaulFromMinerID)!==pos(row.coopHaulFromMinerID)||
    Number(matches[0].coopHaulLoadedAt)!==Number(row.coopHaulLoadedAt)||
    matches[0].transient!==false||
    Number(matches[0].moduleID||0)!==0;
  }))throw Error("ORIGINAL_CARGO_GLOBAL_READBACK_MISMATCH");
  readback=store.listNativeCargoForEntity(haulerID);
  if(!Array.isArray(readback)||readback.length!==planned.rows.length||
     planned.rows.some(row=>{
   const matches=readback.filter(x=>pos(x?.cargoID)===pos(row.cargoID));
   return matches.length!==1||
    pos(matches[0].entityID)!==haulerID||
    pos(matches[0].ownerID)!==ownerID||
    pos(matches[0].typeID)!==pos(row.typeID)||
    pos(matches[0].quantity)!==pos(row.quantity)||
    pos(matches[0].coopHaulFromMinerID)!==pos(row.coopHaulFromMinerID)||
    Number(matches[0].coopHaulLoadedAt)!==Number(row.coopHaulLoadedAt)||
    pos(matches[0].coopHaulFleetID)!==fleetID||
    pos(matches[0].coopHaulSystemID)!==systemID||
    pos(matches[0].coopHaulAdoptedFrom)!==pos(row.entityID)||
    Number(matches[0].coopHaulAdoptedAt)!==now||
    matches[0].transient!==false||Number(matches[0].moduleID||0)!==0;
  }))throw Error("ORIGINAL_CARGO_READBACK_MISMATCH");
  // buildNativeCargoItems produces itemID (the original cargoID), not
  // cargoID. A view with the right length but wrong items must never sail.
  cargoItems=store.buildNativeCargoItems(haulerID);
  if(!Array.isArray(cargoItems)||cargoItems.length!==planned.rows.length||
     planned.rows.some(row=>{
   const matches=cargoItems.filter(x=>pos(x?.itemID)===pos(row.cargoID));
   return matches.length!==1||
    pos(matches[0].typeID)!==pos(row.typeID)||
    pos(matches[0].quantity)!==pos(row.quantity);
  }))throw Error("NATIVE_HAULER_CARGO_VIEW_MISMATCH");
 }catch(error){
  // The original GameStore mutation is already durable. Blind rollback
  // or a second delivery attempt could duplicate custody. Quarantine
  // both actors for source-backed operator reconciliation.
  fleet.coopHaulNeedsOperatorRepair="ADOPTION_POST_COMMIT_CUSTODY_UNVERIFIED";
  hauler.coopHaulNeedsOperatorRepair="ADOPTION_POST_COMMIT_CUSTODY_UNVERIFIED";
  // Rows are durable and the fleet is quarantined; the slot stays burned so a
  // later tick reports ALREADY_ATTEMPTED instead of retrying custody.
  doneSlots.add(key);
  noteOnce(noted,key+":custody",probe,"living-haul-cargo-adoption-skipped",
   {systemID},{fleetID,status:"ADOPTION_POST_COMMIT_CUSTODY_UNVERIFIED",
    reason:String(error?.message||error).slice(0,80)});
  return {status:"ADOPTION_POST_COMMIT_CUSTODY_UNVERIFIED",adopted:0};
 }
 hauler.nativeCargoItems=cargoItems;
 fleet.lastHauledVolumeM3=volume;
 fleet.lastHauledAtMs=now;
 fleet.state="loaded";
 fleet.loadedUntilMs=now+5000;
 fleet.nextThinkAtMs=fleet.loadedUntilMs;
 fleet.coopHaulAdoptedAt=now;
 fleet.coopHaulAdoptedVolumeM3=volume;
 noteOnce(noted,key+":adopted",probe,"living-haul-cargo-adopted",
  {systemID},{fleetID,rows:adopted,quantity,volumeM3:volume,haulerID,
   fromEntityIDs:planned.rows.map(row=>pos(row.entityID)).slice(0,16),
   carriage:"native",invented:false});
 doneSlots.add(key);
 return {status:"ADOPTED",adopted,quantity,volumeM3:volume,haulerID};
 }finally{
  if(custodyLock&&!custodyLock.release()){
   fleet.coopHaulNeedsOperatorRepair="RE_ADOPTION_LOCK_RELEASE_UNVERIFIED";
   hauler.coopHaulNeedsOperatorRepair="RE_ADOPTION_LOCK_RELEASE_UNVERIFIED";
   doneSlots.add(key);
   noteOnce(noted,key+":lock",probe,"living-haul-cargo-adoption-skipped",
    {systemID},{fleetID,status:"RE_ADOPTION_LOCK_RELEASE_UNVERIFIED"});
   return {status:"RE_ADOPTION_LOCK_RELEASE_UNVERIFIED",adopted:0};
  }
 }
}
function resetForTests(){doneSlots.clear();noted.clear();}
module.exports={adopt,plan,resetForTests};
