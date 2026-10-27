"use strict";
// LW-02a / ALIFE-13: read-only startup-wide ORIGINAL mining cargo audit.
// Must run before restoring any physical NPC in an existing durable fleet.
// Source is original GameStore npcCargo + native ItemStore + immutable trip
// manifest, warp acknowledgement and warehouse receipts. Never repairs/mints.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
// In the overlay these ship as .js; direct Node tests use the .cjs copies.
const load=name=>{try{return require("./"+name)}catch(e){
 // A missing transitive dependency in an installed .js sibling is a real
 // error, never an excuse to load an older source-checkout .cjs fallback.
 if(e?.code!=="MODULE_NOT_FOUND"||
    !String(e.message).includes("Cannot find module './"+name+"'"))throw e;
 return require("./"+name+".cjs");
}};
const {createManifest}=load("coopNativeHaulManifest");
const {createJournal}=load("coopNativeStationTripJournal");
const positive=x=>typeof x==="number"&&Number.isSafeInteger(x)&&x>0;
const marker=id=>"coop-warehouse:v1:cargo:"+id;
const fail=(reason,cargoID=0)=>({status:"NEEDS_OPERATOR_REPAIR",reason,cargoID,nativeMutation:false});
const sha=x=>crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
function createStartupCargoAuditor({root,gameStore,store,items,getNativeEntity,io=fs}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||
    typeof gameStore?.read!=="function"||
    typeof store?.listNativeCargoForEntity!=="function"||
    typeof items?.findWarehouseItem!=="function"||
    typeof getNativeEntity!=="function")
  throw Error("ALIFE13_ORIGINAL_AUTHORITIES_REQUIRED");
 const manifest=createManifest({root,store,items,getNativeEntity,io});
 const journal=createJournal({root,manifest,store,items,getNativeEntity,io});
 function readReceipt(id){
  let value;
  try{value=io.readFileSync(path.join(root,"receipts",id+".json"),"utf8")}
  catch(e){if(e?.code==="ENOENT")return null;throw e}
  if(typeof value!=="string"||Buffer.byteLength(value)>256*1024)
   throw Error("ALIFE13_RECEIPT_TOO_LARGE");
  return JSON.parse(value);
 }
 function audit({systemID,fleetID,minerIDs,haulerIDs}={}){
  if(!positive(systemID)||!positive(fleetID)||!Array.isArray(minerIDs)||
     !Array.isArray(haulerIDs)||!minerIDs.length||!haulerIDs.length||
     minerIDs.length+haulerIDs.length>32||
     [...minerIDs,...haulerIDs].some(x=>!positive(x))||
     new Set([...minerIDs,...haulerIDs]).size!==minerIDs.length+haulerIDs.length)
   return fail("ALIFE13_FLEET_IDENTITY_UNVERIFIED");
  const ids=[...minerIDs,...haulerIDs];
  try{
   for(const id of ids){
    const actor=getNativeEntity(id);
    if(!actor||Number(actor.entityID||actor.itemID)!==id||
       Number(actor.systemID)!==systemID||actor.transient!==false)
     return fail("ALIFE13_DURABLE_ACTOR_UNVERIFIED");
   }
   // GameStore's original in-process read must resolve the complete npcCargo
   // root. An incomplete/unknown read never becomes empty authoritative stock.
   const observed=gameStore.read("npcCargo","/");
   const table=observed?.success===true?observed.data:null;
   if(!table||typeof table!=="object"||Array.isArray(table)||
      !table.cargo||typeof table.cargo!=="object"||Array.isArray(table.cargo))
    return fail("ALIFE13_NATIVE_CARGO_TABLE_UNAVAILABLE");
   const actual=new Map();
   for(const entityID of ids){
    const cargo=store.listNativeCargoForEntity(entityID);
    if(!Array.isArray(cargo)||cargo.length>2000)
     return fail("ALIFE13_NATIVE_CARGO_READ_UNAVAILABLE");
    for(const row of cargo){
     if(!positive(Number(row?.cargoID))||actual.has(Number(row.cargoID)))
      return fail("ALIFE13_DUPLICATE_CARGO_ID");
     actual.set(Number(row.cargoID),row);
    }
   }
   let names;
   try{names=io.readdirSync(path.join(root,"trip-manifests"))}
   catch(e){if(e?.code==="ENOENT")names=[];else throw e}
   if(!Array.isArray(names)||names.length>5000)
    return fail("ALIFE13_MANIFEST_DIRECTORY_UNTRUSTED");
   const prefix=systemID+"-"+fleetID+"-";
   const manifests=new Map(),validNames=names.filter(n=>n.startsWith(prefix));
   for(const name of validNames){
    if(!/^\d+-\d+-\d+\.json$/.test(name))
     return fail("ALIFE13_MANIFEST_FILENAME_INVALID");
    const key=name.slice(0,-5),read=manifest.read(key);
    if(read.status!=="READY")return fail("ALIFE13_MANIFEST_UNREADABLE");
    const m=read.record;
    if(m.systemID!==systemID||m.fleetID!==fleetID||
       m.haulerIDs.length!==haulerIDs.length||
       m.haulerIDs.some(x=>!haulerIDs.includes(x)))
     return fail("ALIFE13_MANIFEST_FLEET_MISMATCH");
    // Even a finished historical manifest must prove the original real warp.
    // ALIFE-12 recover() can legitimately skip a fully delivered history row,
    // so this startup-wide gate checks its immutable ACK independently.
    const ackFile=path.join(root,"trip-departure-acks",key+".json");
    let ackBytes;
    try{ackBytes=io.readFileSync(ackFile,"utf8")}
    catch{return fail("ALIFE13_ORIGINAL_WARP_ACK_MISSING")}
    if(typeof ackBytes!=="string"||Buffer.byteLength(ackBytes)>256*1024)
     return fail("ALIFE13_WARP_ACK_UNTRUSTED");
    const ack=JSON.parse(ackBytes);
    if(ack?.version!==1||ack.status!=="WARP_ACK_CONFIRMED"||
       ack.manifestKey!==key||ack.manifestHash!==sha(m)||
       ack.systemID!==systemID||ack.fleetID!==fleetID||
       ack.stationID!==m.stationID||ack.corporationID!==m.corporationID||
       ack.startedAt!==m.startedAt||!positive(ack.confirmedAt)||
       JSON.stringify(ack.haulerIDs)!==JSON.stringify(m.haulerIDs)||
       JSON.stringify(ack.cargoIDs)!==JSON.stringify(m.cargo.map(x=>x.cargoID)))
     return fail("ALIFE13_ORIGINAL_WARP_ACK_CHANGED");
    for(const row of m.cargo){
     if(!minerIDs.includes(row.fromMinerID)||manifests.has(row.cargoID))
      return fail("ALIFE13_MANIFEST_SOURCE_DUPLICATED",row.cargoID);
     manifests.set(row.cargoID,{m,row});
    }
   }
   let transfers=0,warehouse=0,pending=0;
   const seen=new Set();
   for(const [key,t] of Object.entries(table)){
    if(!key.startsWith("coopNativeHaulTransfer:"))continue;
    // Scope original receipts to THIS fleet, not all fleets sharing this
    // star system. A foreign fleet in the same system is unrelated and must
    // never quarantine an otherwise sound independent hauling chain.
    //
    // Fail closed when a record lies about fleet identity but still points
    // at our original miner/hauler, current cargo ID or historic manifest.
    const id=Number(key.slice("coopNativeHaulTransfer:".length));
    if(t?.fleetID!==fleetID&&!minerIDs.includes(t?.minerID)&&
       !haulerIDs.includes(t?.haulerID)&&
       !actual.has(id)&&!manifests.has(id))continue;
    if(!positive(id)||!t||t.version!==1||t.status!=="COMMITTED"||
       t.cargoID!==id||t.systemID!==systemID||t.fleetID!==fleetID||
       !minerIDs.includes(t.minerID)||!haulerIDs.includes(t.haulerID)||
       !positive(t.typeID)||!positive(t.quantity)||
       !positive(t.sourceOwnerID)||!positive(t.haulerOwnerID)||
       typeof t.afterHash!=="string"||!/^[0-9a-f]{64}$/.test(t.afterHash)||
       seen.has(id))return fail("ALIFE13_TRANSFER_RECEIPT_INVALID",id||0);
    const miner=getNativeEntity(t.minerID),hauler=getNativeEntity(t.haulerID);
    if(Number(miner?.ownerID)!==t.sourceOwnerID||
       Number(hauler?.ownerID)!==t.haulerOwnerID||
       Number(miner?.systemID)!==systemID||Number(hauler?.systemID)!==systemID)
     return fail("ALIFE13_TRANSFER_ACTOR_OWNER_CONFLICT",id);
    seen.add(id);transfers++;
    const current=table.cargo[String(id)]||null;
    const cached=actual.get(id)||null;
    if(Boolean(current)!==Boolean(cached)||
       current&&sha(current)!==sha(cached))
     return fail("ALIFE13_SQLITE_CACHE_MISMATCH",id);
    const linked=manifests.get(id);
    if(linked&&(linked.row.haulerID!==t.haulerID||
       linked.row.fromMinerID!==t.minerID||
       linked.row.typeID!==t.typeID||linked.row.quantity!==t.quantity))
     return fail("ALIFE13_MANIFEST_TRANSFER_CONFLICT",id);
    const receipt=readReceipt(id);
    if(current){
     if(receipt)return fail("ALIFE13_WAREHOUSE_RECEIPT_STILL_PENDING",id);
     if(current.entityID!==t.haulerID||current.ownerID!==t.haulerOwnerID||
        current.coopHaulFleetID!==fleetID||current.coopHaulFromMinerID!==t.minerID||
        current.typeID!==t.typeID||current.quantity!==t.quantity||
        current.transient!==false||sha(current)!==t.afterHash)
      return fail("ALIFE13_ORIGINAL_CARGO_CHANGED",id);
     pending++;
     continue;
    }
    if(!linked||!receipt||receipt.version!==1||receipt.phase!=="COMMITTED"||
       receipt.cargoID!==id||receipt.haulerID!==t.haulerID||
       receipt.typeID!==t.typeID||receipt.quantity!==t.quantity||
       receipt.fleetID!==fleetID||receipt.systemID!==systemID||
       receipt.stationID!==linked.m.stationID||
       receipt.corporationID!==linked.m.corporationID||
       !positive(receipt.itemID))
     return fail("ALIFE13_SOURCE_MISSING_WITHOUT_COMMITTED_WAREHOUSE",id);
    const item=items.findWarehouseItem({ownerID:receipt.corporationID,
     stationID:receipt.stationID,cargoID:id});
    if(!item||item.itemID!==receipt.itemID||
       item.typeID!==t.typeID||item.quantity!==t.quantity||
       item.ownerID!==receipt.corporationID||
       item.locationID!==receipt.stationID||
       String(item.customInfo)!==marker(id))
     return fail("ALIFE13_ITEMSTORE_CREDIT_INVALID",id);
    warehouse++;
   }
   // Detect orphan original warehouse receipts whose transfer receipt was
   // lost or removed. A receipt on disk is never a substitute for the source.
   let receipts;
   try{receipts=io.readdirSync(path.join(root,"receipts"))}
   catch(e){if(e?.code==="ENOENT")receipts=[];else throw e}
   if(!Array.isArray(receipts)||receipts.length>5000)
    return fail("ALIFE13_WAREHOUSE_DIRECTORY_UNTRUSTED");
   for(const filename of receipts){
    if(!/^[1-9]\d*\.json$/.test(filename))continue;
    const id=Number(filename.slice(0,-5));
    const receipt=readReceipt(id);
    // An independent fleet may settle warehouse stock in the same solar
    // system. Only our fleet, its hauler, its manifest or our physical cargo
    // can designate a missing receipt as OUR orphan. Retain fail-closed
    // behavior for a forged fleetID on our known original hauler.
    if(receipt&&(receipt.fleetID===fleetID||
       haulerIDs.includes(receipt.haulerID)||
       manifests.has(id)||actual.has(id))&&
       !seen.has(id))return fail("ALIFE13_ORPHAN_WAREHOUSE_RECEIPT",id);
   }
   for(const [id] of manifests)if(!seen.has(id))
    return fail("ALIFE13_MANIFEST_WITHOUT_ORIGINAL_TRANSFER",id);
   for(const row of actual.values())if(row.coopHaulFleetID===fleetID &&
      haulerIDs.includes(Number(row.entityID))&&!seen.has(Number(row.cargoID)))
    return fail("ALIFE13_HAUL_CARGO_WITHOUT_SQLITE_RECEIPT",Number(row.cargoID)||0);
   // This read-only original ALIFE-12 authority scans ALL historical manifests,
   // even when *every* restored hauler is empty. It verifies actual warp ACKs
   // for active trips and full native custody for completed historical trips.
   const route=journal.recover({systemID,fleetID,haulerIDs:haulerIDs.slice()});
   if(!["RECOVERED_NATIVE_TRIP","NO_PENDING_TRIP"].includes(route?.status))
    return fail("ALIFE13_"+String(route?.reason||"ROUTE_PROVENANCE_UNVERIFIED"));
   if(route.status==="NO_PENDING_TRIP"&&pending>0&&manifests.size>0)
    return fail("ALIFE13_UNMANIFESTED_PENDING_CARGO");
   return {status:"OK",systemID,fleetID,transfers,warehouse,pending,
    nativeMutation:false};
  }catch(e){return fail("ALIFE13_ORIGINAL_AUDIT_UNAVAILABLE:"+String(e?.message||e).slice(0,80))}
 }
 return Object.freeze({audit});
}
module.exports={createStartupCargoAuditor};
