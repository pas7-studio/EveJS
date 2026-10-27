"use strict";
// COOP-030: real NPC cargo -> persistent native EveJS itemStore station item.
// Intentionally NOT connected to the timer-driven mining fleet 'haulereturn'.
// A trusted caller must supply authoritative physical station arrival evidence.
const fs = require("node:fs");
const path = require("node:path");
const pos = v => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : 0;
const marker = cargoID => `coop-warehouse:v1:cargo:${cargoID}`;
const copy = value => JSON.parse(JSON.stringify(value));
const statuses = Object.freeze({PREPARED:"PREPARED", DEBIT:"SOURCE_DEBIT_PROVEN", CREDIT:"TARGET_CREDIT_PROVEN", COMMITTED:"COMMITTED"});

function createWarehouse({root, store, items, flush, getStation, getCorporation, isNpcCorporation, verifyArrival, verifyDurableCargo, verifyTransferredTitle=null, explainArrival=null, clock=()=>Date.now(), fsApi=fs}={}) {
 if(!root || !path.isAbsolute(root) || !store || !items || typeof flush!=="function" ||
    typeof getStation!=="function" || typeof getCorporation!=="function" ||
    typeof isNpcCorporation!=="function" || typeof verifyArrival!=="function" ||
    typeof verifyDurableCargo!=="function" ||
    (verifyTransferredTitle!==null&&typeof verifyTransferredTitle!=="function") ||
    !["listNativeCargoForEntity","listNativeCargo","removeNativeCargo"].every(x=>typeof store[x]==="function") ||
    !["findWarehouseItem","grantUniqueNpcDepotItem"].every(x=>typeof items[x]==="function"))
  throw Error("WAREHOUSE_DEPENDENCIES_REQUIRED");
 const dir=path.join(root,"receipts"),busy=new Set();
 const receiptPath=id=>path.join(dir,`${id}.json`);
 const lockPath=id=>path.join(dir,`${id}.lock`);
 // The in-process busy set cannot serialize independent Node workers using
 // the same native warehouse. Fence *before* the initial receipt read,
 // through the last native debit, ItemStore grant and COMMITTED receipt.
 function withCustodyLock(id,action){
  let fd=null,held=false,result;
  try{
   fsApi.mkdirSync(dir,{recursive:true});
   fd=fsApi.openSync(lockPath(id),"wx",0o600);held=true;
   fsApi.writeFileSync(fd,String(process.pid));fsApi.fsyncSync(fd);
   fsApi.closeSync(fd);fd=null;
   result=action();
  }catch(error){
   result=answer(error?.code==="EEXIST"?"WAREHOUSE_CUSTODY_LOCKED":
    "NEEDS_OPERATOR_REPAIR",{cargoID:id},
    {reason:String(error?.message||error).slice(0,95)});
  }finally{
   if(fd!==null)try{fsApi.closeSync(fd);}catch(_ignored){}
   if(held)try{fsApi.unlinkSync(lockPath(id));}
   catch(_error){result=answer("NEEDS_OPERATOR_REPAIR",{cargoID:id},
    {reason:"WAREHOUSE_LOCK_RELEASE_UNVERIFIED"});}
  }
  return result;
 }
 function syncDir(location){
  // Best effort on platforms where directory fsync is unsupported. File fsync
  // is compulsory; a failed file fsync is never reported as durable.
  try { const fd=fsApi.openSync(location,"r");try{fsApi.fsyncSync(fd);}finally{fsApi.closeSync(fd);} }
  catch(e){if(!["EINVAL","ENOTSUP","EISDIR","EPERM","EACCES"].includes(e.code))throw e;}
 }
 function persist(id,record){
  fsApi.mkdirSync(dir,{recursive:true});
  const file=receiptPath(id),temp=file+`.tmp-${process.pid}-${Math.floor(Math.random()*1e9)}`;
  let fd=null,ownedTemp=false;
  try{
   // A failed exclusive open never grants ownership of a collided temp.
   // Preserve foreign/crash-abandoned receipts for operator reconciliation.
   fd=fsApi.openSync(temp,"wx",0o600);ownedTemp=true;
   fsApi.writeFileSync(fd,JSON.stringify(record));fsApi.fsyncSync(fd);
   fsApi.closeSync(fd);fd=null;
   fsApi.renameSync(temp,file);ownedTemp=false;
   syncDir(dir);
  }catch(e){
   if(fd!==null)try{fsApi.closeSync(fd);}catch(_ignored){}
   if(ownedTemp)try{fsApi.unlinkSync(temp);}catch(_ignored){}
   throw e;
  }
 }
 function load(id){
  let row;try{row=JSON.parse(fsApi.readFileSync(receiptPath(id),"utf8"));}
  catch(e){if(e.code==="ENOENT")return null;throw Error("WAREHOUSE_JOURNAL_UNREADABLE");}
  // A DEBIT-stage recovery can create a real station item without the
  // original hauler row. Refuse incomplete receipt provenance: station and
  // corporation alone cannot prove which fleet/system owned the source.
  if(!row||row.version!==1||row.cargoID!==id||!Object.values(statuses).includes(row.phase)||
     !pos(row.typeID)||!pos(row.quantity)||!pos(row.haulerID)||
     !pos(row.fleetID)||!pos(row.systemID)||!pos(row.stationID)||
     !pos(row.corporationID))
   throw Error("WAREHOUSE_JOURNAL_INVALID");
  return row;
 }
 // A missing/failed native cargo read cannot attest source debit.
 // In particular, authorized DEBIT repair must NEVER mint a station item
 // just because a disconnected adapter returned null instead of an array.
 function lookupCargo(haulerID,cargoID){
  // A per-entity empty hold is NOT global proof that the original cargoID
  // disappeared. The same original ID may have moved to another NPC or
  // survived a failed reparent, making a new ItemStore grant a duplicate.
  const rows=store.listNativeCargoForEntity(haulerID);
  const all=store.listNativeCargo();
  if(!Array.isArray(rows)||!Array.isArray(all))
   throw Error("WAREHOUSE_SOURCE_CUSTODY_UNAVAILABLE");
  const matches=rows.filter(row=>Number(row?.cargoID)===cargoID);
  const global=all.filter(row=>Number(row?.cargoID)===cargoID);
  if(matches.length>1||global.length>1)
   throw Error("WAREHOUSE_DUPLICATE_SOURCE_CARGO");
  if(global.length&&Number(global[0].entityID)!==haulerID)
   throw Error("WAREHOUSE_SOURCE_CARGO_ELSEWHERE");
  if(matches.length!==global.length)
   throw Error("WAREHOUSE_SOURCE_VIEWS_DISAGREE");
  const cargo=matches[0]||null;
  if(cargo&&(
    Number(cargo.entityID)!==haulerID||
    Number(cargo.cargoID)!==Number(global[0]?.cargoID)||
    Number(cargo.typeID)!==Number(global[0]?.typeID)||
    Number(cargo.quantity)!==Number(global[0]?.quantity)||
    String(cargo.ownerID??"")!==String(global[0]?.ownerID??"")||
    Number(cargo.moduleID||0)!==Number(global[0]?.moduleID||0)||
    Number(cargo.coopHaulFleetID)!==Number(global[0]?.coopHaulFleetID)||
    Number(cargo.coopHaulFromMinerID)!==Number(global[0]?.coopHaulFromMinerID)||
    Number(cargo.coopHaulSystemID||0)!==Number(global[0]?.coopHaulSystemID||0)||
    cargo.transient!==global[0]?.transient))
   throw Error("WAREHOUSE_SOURCE_VIEWS_DISAGREE");
  return cargo;
 }
 function findCargo(record){
  return lookupCargo(record.haulerID,record.cargoID);
 }
 function validateOwner(record){
  const corp=getCorporation(record.corporationID);
  const station=getStation(record.stationID);
  return Boolean(corp&&Number(corp.corporationID)===record.corporationID&&
    isNpcCorporation(record.corporationID)===true&&station&&
    Number(station.stationID)===record.stationID&&
    Number(station.solarSystemID)===record.systemID);
 }
 function checkTarget(record){
  // The pinned ItemStore lookup is global by the original cargo tag.
  // A target is proven as station stock only while it is the *same*
  // physical, unsplit stack in the receiving corporation's hangar.
  const result=items.findWarehouseItem({cargoID:record.cargoID});
  if(result&&(!pos(result.itemID)||Number(result.typeID)!==record.typeID||
     Number(result.quantity)!==record.quantity||Number(result.ownerID)!==record.corporationID||
     Number(result.locationID)!==record.stationID||
     !Number.isSafeInteger(items.ITEM_FLAGS?.HANGAR)||
     Number(result.flagID)!==items.ITEM_FLAGS.HANGAR||
     Number(result.singleton)!==0||
     Number(result.stacksize)!==record.quantity||
     String(result.customInfo)!==marker(record.cargoID)))
   throw Error("WAREHOUSE_TARGET_IDENTITY_CONFLICT");
  return result||null;
 }
 const answer=(status,record=null,extra={})=>({status,cargoID:record?.cargoID||0,...extra});
 function commitCredit(record){
  if(!validateOwner(record))return answer("OWNER_OR_STATION_MISSING",record);
  if(findCargo(record))return answer("SOURCE_STILL_PRESENT",record);
  let target=checkTarget(record);
  if(!target){
   // This is the only item-creation path. It creates an isolated, tagged
   // native stack: stock EveJS grants would merge into existing stacks.
   const result=items.grantUniqueNpcDepotItem({ownerID:record.corporationID,
    stationID:record.stationID,typeID:record.typeID,quantity:record.quantity,cargoID:record.cargoID});
   if(!result?.success)return answer("TARGET_WRITE_UNCERTAIN",record);
  }
  const f=flush("items");
  if(!f?.success)return answer("TARGET_FLUSH_UNCERTAIN",record);
  target=checkTarget(record);
  if(!target)return answer("TARGET_NOT_VERIFIED",record);
  record={...record,phase:statuses.CREDIT,itemID:target.itemID,updatedAt:clock()};persist(record.cargoID,record);
  record={...record,phase:statuses.COMMITTED,updatedAt:clock()};persist(record.cargoID,record);
  // Observe a native delivery only AFTER debit, flush, target identity and
  // a durable COMMITTED receipt. Errors never roll back genuine native stock.
  if(process.env.EVEJS_COOP_CONVOY_OPERATIONS==="1"){
   try{require("./coopConvoyOutcomeProof").noteWarehouse(record,target,!findCargo(record))}
   catch(error){console.warn("[CoopConvoyOutcomeProof] stock",String(error?.message||error))}
  }
  return answer("COMMITTED",record,{itemID:record.itemID,quantity:record.quantity});
 }
 // Only independently verified native GameStore ownership and payment
 // may justify an item transferred out of the original warehouse.
 function titleTransferred(record){
  if(record?.phase!==statuses.COMMITTED||typeof verifyTransferredTitle!=="function")
   return false;
  if(findCargo(record))return false;
  return verifyTransferredTitle(copy(record))===true;
 }
 function getReceipt(cargoID){
  const id=pos(cargoID);
  if(!id)return null;
  const saved=load(id);
  return saved?copy(saved):null;
 }
 function deposit({cargoID,haulerID,fleetID,systemID,stationID,corporationID,arrivedAtMs,nowMs}={}){
  const id=pos(cargoID),args={cargoID:id,haulerID:pos(haulerID),fleetID:pos(fleetID),
   systemID:pos(systemID),stationID:pos(stationID),corporationID:pos(corporationID)};
  // The arrival proof is checked but never becomes part of the receipt identity:
  // it is a time stamp, not a property of the cargo. `nowMs` is the native tick
  // clock the trip measured its own dwell with; it is never persisted either.
  const arrivalAtMs=pos(arrivedAtMs),tickMs=pos(nowMs);
  if(Object.values(args).some(v=>!v))return answer("INVALID_REQUEST");
  if(busy.has(id))return answer("IN_PROGRESS");
  busy.add(id);
  try{
   return withCustodyLock(id,()=>{
   let record=load(id);
   if(record){
    if(Object.keys(args).some(k=>args[k]!==record[k]))return answer("RECEIPT_IDENTITY_CONFLICT",record);
    if(record.phase===statuses.COMMITTED){
     if(titleTransferred(record))return answer("TITLE_TRANSFERRED",record,{itemID:record.itemID});
     const target=checkTarget(record);
     return target&&Number(target.itemID)===record.itemID&&!findCargo(record)?answer("ALREADY_COMMITTED",record,{itemID:target.itemID}):answer("COMMITTED_STATE_INVALID",record);
    }
    // No automatic credit for PREPARED; the source may have disappeared
    // due to destruction before its debit was proven.
    return answer("PENDING_RECONCILIATION",record,{phase:record.phase});
   }
   if(!validateOwner(args))return answer("OWNER_OR_STATION_MISSING");
   // A refusal must say WHICH term of the arrival gate failed (station point,
   // physical stability, dwell). The gate itself is unchanged: only `true` passes.
   const arrivalProof=verifyArrival({...args,arrivedAtMs:arrivalAtMs,nowMs:tickMs});
   if(arrivalProof!==true)return answer("ARRIVAL_NOT_VERIFIED",null,
    typeof explainArrival==="function"?
     {detail:explainArrival({...args,arrivedAtMs:arrivalAtMs,nowMs:tickMs})}:{});
   const cargo=lookupCargo(args.haulerID,id);
   if(!cargo||Number(cargo.entityID)!==args.haulerID||!pos(cargo.typeID)||!pos(cargo.quantity)||
      Number(cargo.moduleID||0)!==0||Number(cargo.coopHaulFleetID)!==args.fleetID||
      !pos(cargo.coopHaulFromMinerID))return answer("CARGO_NOT_PROVEN");
   // Station/corporation existence does not establish title to this actual
   // native cargo item. Always verify the ORIGINAL physical cargo owner
   // before durable PREPARED, debit or credit, independent of injected proofs.
   if(pos(cargo.ownerID)!==args.corporationID)
    return answer("ORIGINAL_CARGO_OWNER_MISMATCH");
   if(verifyDurableCargo(cargo,args)!==true)return answer("CARGO_NOT_DURABLE");
   // Before the durable PREPARED fence and irreversible native source debit,
   // check the *global* original cargo-tag namespace. If this cargoID already
   // has any station item, the source and target coexist: never delete ore
   // from the ship merely to discover an ownership/stack conflict later.
   const originalTicket={...args,typeID:Number(cargo.typeID),quantity:Number(cargo.quantity)};
   if(checkTarget(originalTicket))return answer("WAREHOUSE_SOURCE_TARGET_COLLISION");
   record={version:1,...args,typeID:Number(cargo.typeID),quantity:Number(cargo.quantity),
    phase:statuses.PREPARED,at:clock(),updatedAt:clock()};
   persist(id,record); // Durably prepared before source mutation.
   const removed=store.removeNativeCargo(id);
   if(!removed?.success)return answer("SOURCE_DEBIT_UNCERTAIN",record);
   const f=flush("npcCargo");
   if(!f?.success)return answer("SOURCE_FLUSH_UNCERTAIN",record);
   if(findCargo(record))return answer("SOURCE_STILL_PRESENT",record);
   record={...record,phase:statuses.DEBIT,updatedAt:clock()};persist(id,record);
   return commitCredit(record);
   });
  }catch(e){return answer("NEEDS_OPERATOR_REPAIR",{cargoID:id},{reason:String(e.message).slice(0,95)});}
  finally{busy.delete(id);}
 }
 function resume(cargoID,{authorize=false}={}){
  const id=pos(cargoID);if(!id||!authorize)return answer("REPAIR_AUTHORIZATION_REQUIRED");
  if(busy.has(id))return answer("IN_PROGRESS");busy.add(id);
  try{
   return withCustodyLock(id,()=>{
   const record=load(id);if(!record)return answer("RECEIPT_NOT_FOUND");
   if(record.phase===statuses.COMMITTED){
    if(titleTransferred(record))return answer("TITLE_TRANSFERRED",record,{itemID:record.itemID});
    const t=checkTarget(record);
    return t&&!findCargo(record)?answer("ALREADY_COMMITTED",record):answer("COMMITTED_STATE_INVALID",record);
   }
   if(record.phase===statuses.PREPARED)return answer(findCargo(record)?"PREPARED_SOURCE_PRESENT":"PREPARED_SOURCE_UNKNOWN",record);
   if(record.phase===statuses.DEBIT)return commitCredit(record);
   if(record.phase===statuses.CREDIT){
    const t=checkTarget(record);
    if(!t||findCargo(record)||Number(t.itemID)!==record.itemID)return answer("TARGET_RECONCILIATION_REQUIRED",record);
    if(!flush("items")?.success)return answer("TARGET_FLUSH_UNCERTAIN",record);
    const committed={...record,phase:statuses.COMMITTED,updatedAt:clock()};persist(id,committed);
    return answer("COMMITTED",committed,{itemID:t.itemID});
   }
   return answer("NEEDS_OPERATOR_REPAIR",record);
   });
  }catch(e){return answer("NEEDS_OPERATOR_REPAIR",{cargoID:id},{reason:String(e.message).slice(0,95)});}
  finally{busy.delete(id);}
 }
 function audit(){
  let entries;try{entries=fsApi.readdirSync(dir);}
  catch(e){if(e.code==="ENOENT")return {status:"EMPTY",committed:0,pending:0,problems:[]};throw e;}
  // In this dedicated receipt directory any .json is a claimed journal.
  // An alias like 0008001.json must NOT resolve through load(8001) and
  // count the same COMMITTED native ore a second time.
  const files=entries.filter(x=>x.endsWith(".json"));
  let committed=0,transferred=0,pending=0;const problems=entries
   .filter(x=>/^\d+\.lock$/.test(x))
   .map(x=>({cargoID:Number(x.slice(0,-5)),reason:"WAREHOUSE_CUSTODY_LOCKED"}));
  for(const temp of entries.filter(x=>/^\d+\.json\.tmp-/.test(x)))
   problems.push({cargoID:Number(temp.split(".")[0]),reason:"WAREHOUSE_INCOMPLETE_RECEIPT_WRITE"});
  if(!files.length&&!problems.length)
   return {status:"EMPTY",committed:0,pending:0,problems:[]};
  for(const file of files){
   const stem=file.slice(0,-5),id=Number(stem);
   if(!pos(id)||stem!==String(id)){
    problems.push({cargoID:pos(id),reason:"WAREHOUSE_NONCANONICAL_RECEIPT_FILENAME"});
    continue;
   }
   try{
   const row=load(id);
   if(row.phase===statuses.COMMITTED&&titleTransferred(row)){
    committed++;transferred++;continue;
   }
   const target=checkTarget(row),source=findCargo(row);
   if(row.phase===statuses.COMMITTED){if(!target||source||Number(target.itemID)!==row.itemID)problems.push({cargoID:id,reason:"COMMITTED_MISMATCH"});else committed++;}
   else{pending++;problems.push({cargoID:id,reason:row.phase+(source?"_SOURCE_PRESENT":"_SOURCE_ABSENT")});}
  }catch(e){problems.push({cargoID:id,reason:String(e.message).slice(0,95)});}}
  return {status:problems.length?"NEEDS_RECONCILIATION":"OK",committed,transferred,pending,problems};
 }
 return {deposit,resume,audit,getReceipt,marker};
}
module.exports={createWarehouse,marker};