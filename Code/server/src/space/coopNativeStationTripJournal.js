"use strict";
// ALIFE-12: original NPC station route recovery from an immutable original
// cargo manifest AND a separately fsynced native warp-ACK witness.
// No warp, cargo mutation, itemStore grants or ISK operations are permitted.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const pos=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):0;
const exact=x=>typeof x==="number"&&Number.isSafeInteger(x)&&x>0;
const hash=x=>crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
const marker=id=>"coop-warehouse:v1:cargo:"+id;
// Same 15 minute budget the arrival gate enforces; a route older than this cannot
// be resumed anyway, so its cargo mismatch is a stale route, not a live conflict.
const ROUTE_DEADLINE_MS=15*60*1000;
// A manifest with NO departure ack is not in flight: no ship is proven to have left,
// so it must not wait out the full route deadline. 2 minutes is ~80x the native warp
// ingress, which is the only window in which a real departure could still be moving.
const ABANDON_GRACE_MS=2*60*1000;
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=(reason,extra={})=>({status:"NEEDS_OPERATOR_REPAIR",reason,...extra});
function createJournal({root,manifest,store,items,getNativeEntity,io=fs,clock=()=>Date.now()}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||!manifest||
    typeof manifest.read!=="function"||
    !store||typeof store.listNativeCargoForEntity!=="function"||
    !items||typeof items.findWarehouseItem!=="function"||
    typeof getNativeEntity!=="function")throw Error("ALIFE12_AUTHORITIES_REQUIRED");
 const dir=path.join(root,"trip-departure-acks");
 const manifestDir=path.join(root,"trip-manifests");
 const receiptDir=path.join(root,"receipts");
 const keyPattern=/^([1-9]\d*)-([1-9]\d*)-([1-9]\d*)$/;
 const copy=x=>JSON.parse(JSON.stringify(x));
 const readJSON=(file)=>{
  let data;
  try{data=io.readFileSync(file,"utf8")}
  catch(error){if(error.code==="ENOENT")return null;throw error}
  if(typeof data!=="string"||Buffer.byteLength(data)>256*1024)
   throw Error("ALIFE12_DURABLE_RECORD_SIZE_INVALID");
  return JSON.parse(data);
 };
 const listing=location=>{
  try{
   const values=io.readdirSync(location);
   if(!Array.isArray(values)||values.length>5000)
    throw Error("ALIFE12_DIRECTORY_TOO_LARGE");
   return values.filter(x=>typeof x==="string"&&x.endsWith(".json"));
  }catch(e){if(e.code==="ENOENT")return[];throw e}
 };
 function overdueOf(key,m){
  const startedAt=Number(m&&m.startedAt);
  if(!exact(startedAt)||Number(clock())-startedAt<=ROUTE_DEADLINE_MS)return {};
  return {overdue:{manifestID:key,startedAt}};
 }
 function sourceRecord(key){
  const m=manifest.read(key);
  if(m?.status!=="READY"||m.record?.key!==key||
     !keyPattern.test(key))throw Error("ALIFE12_SOURCE_MANIFEST_UNVERIFIED");
  return m.record;
 }
 function writeAck(key,record){
  io.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,key+".json"),fd=io.openSync(file,"wx",0o600);
  try{io.writeFileSync(fd,JSON.stringify(record));io.fsyncSync(fd)}
  finally{io.closeSync(fd)}
  // Immutable manifest's fsync contract requires a directory sync as well.
  let d;
  try{d=io.openSync(dir,"r");io.fsyncSync(d)}
  catch(error){
   // NTFS/Windows cannot fsync a directory descriptor. The ack file itself
   // was fsynced, as for the existing original warehouse receipt protocol.
   if(!["EINVAL","ENOTSUP","EISDIR","EPERM","EACCES"].includes(error?.code))
    throw error;
  }finally{if(d!==undefined)io.closeSync(d)}
 }
 function confirm({manifestKey,systemID,fleetID,stationID,corporationID,
                   haulerIDs,cargoIDs,startedAt}={}){
  try{
   const key=String(manifestKey||""),m=sourceRecord(key);
   if(!exact(systemID)||!exact(fleetID)||!exact(stationID)||!exact(corporationID)||
      !exact(startedAt)||m.systemID!==systemID||m.fleetID!==fleetID||
      m.stationID!==stationID||m.corporationID!==corporationID||
      m.startedAt!==startedAt||
      !Array.isArray(haulerIDs)||!Array.isArray(cargoIDs)||
      !equal(haulerIDs.slice().sort((a,b)=>a-b),m.haulerIDs)||
      !equal(cargoIDs.slice().sort((a,b)=>a-b),m.cargo.map(x=>x.cargoID).sort((a,b)=>a-b)))
    return fail("ALIFE12_DEPARTURE_MANIFEST_IDENTITY_CONFLICT");
   const ack={version:1,status:"WARP_ACK_CONFIRMED",manifestKey:key,systemID,
    fleetID,stationID,corporationID,startedAt,
    haulerIDs:m.haulerIDs.slice(),cargoIDs:m.cargo.map(x=>x.cargoID),
    manifestHash:hash(m),confirmedAt:Number(clock())};
   if(!exact(ack.confirmedAt))return fail("ALIFE12_CONFIRMATION_TIME_UNVERIFIED");
   const prior=readJSON(path.join(dir,key+".json"));
   if(prior)return equal(prior,ack)?{status:"ALREADY_CONFIRMED",manifestKey:key}:
    fail("ALIFE12_ACK_ALREADY_EXISTS_OR_CHANGED");
   writeAck(key,ack);
   const verified=readJSON(path.join(dir,key+".json"));
   if(!equal(ack,verified))return fail("ALIFE12_ACK_READBACK_MISMATCH");
   return {status:"DURABLE_DEPARTURE_CONFIRMED",manifestKey:key};
  }catch(error){return fail("ALIFE12_ACK_WRITE_OUTCOME_UNKNOWN",{
   details:String(error?.message||error).slice(0,120)})}
  }
  // A trip that has outlived its deadline is a durable FACT, not a forgotten route.
  // The original ack stays immutable; the closure is its own fsynced record, and
  // recover() stops offering that trip so the fleet may plan a new one with the ore
  // it still carries. Nothing is delivered, nothing is credited, nothing is faked.
  const expiryFile=key=>path.join(dir,key+".expired.json");
  function expiryOf(key){try{return readJSON(expiryFile(key))}catch(_error){return null}}
  // A PREPARED manifest whose departure ack was never written is NOT a trip: the
  // ack is the only departure witness, so nothing proves a ship ever left. Such a
  // route can never be expired either (expire() demands an ack), which is how a
  // fleet sat in "loaded" for five hours in a healthy-looking state and never mined
  // again. Past the same deadline it is closed as ABANDONED - its own fsynced
  // record, with the manifest and any ack untouched - so the fleet plans a fresh
  // trip from what its hulls really carry. No cargo, no delivery and no ISK is
  // implied, and a route with a real departure ack is never abandoned.
  const abandonedFile=key=>path.join(dir,key+".abandoned.json");
  function abandonedOf(key){try{return readJSON(abandonedFile(key))}catch(_error){return null}}
  function abandon({manifestKey,systemID,fleetID,now,reason,graceMs}={}){
   try{
    const key=String(manifestKey||""),m=sourceRecord(key);
    if(!exact(systemID)||!exact(fleetID)||m.systemID!==systemID||m.fleetID!==fleetID)
     return fail("ALIFE12_ABANDON_IDENTITY_CONFLICT");
    const ack=readJSON(path.join(dir,key+".json"));
    if(ack)return fail("ALIFE12_ABANDON_WITH_DEPARTURE_ACK");
    const elapsed=Number(now||clock())-Number(m.startedAt);
    const grace=Number.isFinite(Number(graceMs))?Number(graceMs):ABANDON_GRACE_MS;
    if(!Number.isFinite(elapsed)||elapsed<=grace)
     return fail("ALIFE12_ABANDON_BEFORE_DEADLINE");
    const record={version:1,status:"ROUTE_ABANDONED",manifestKey:key,systemID,fleetID,
     stationID:pos(m.stationID),corporationID:pos(m.corporationID),startedAt:m.startedAt,
     manifestHash:hash(m),reason:String(reason||"PREPARED_WITHOUT_DEPARTURE_ACK"),graceMs:grace,
     abandonedAt:Number(now)||Number(clock())};
    if(!exact(record.abandonedAt))return fail("ALIFE12_ABANDON_TIME_UNVERIFIED");
    const prior=abandonedOf(key);
    if(prior)return equal(prior,record)?{status:"ALREADY_ABANDONED",manifestKey:key}:
     fail("ALIFE12_ABANDON_ALREADY_RECORDED_DIFFERENTLY");
    io.mkdirSync(dir,{recursive:true});
    const file=abandonedFile(key),fd=io.openSync(file,"wx",0o600);
    try{io.writeFileSync(fd,JSON.stringify(record));io.fsyncSync(fd)}
    finally{io.closeSync(fd)}
    if(!equal(record,abandonedOf(key)))return fail("ALIFE12_ABANDON_READBACK_MISMATCH");
    return {status:"ROUTE_ABANDONED",manifestKey:key};
   }catch(error){return fail("ALIFE12_ABANDON_WRITE_OUTCOME_UNKNOWN",{
    details:String(error?.message||error).slice(0,120)})}
  }
  function expire({manifestKey,systemID,fleetID,now}={}){
   try{
    const key=String(manifestKey||""),m=sourceRecord(key);
    if(!exact(systemID)||!exact(fleetID)||m.systemID!==systemID||m.fleetID!==fleetID)
     return fail("ALIFE12_EXPIRY_IDENTITY_CONFLICT");
    const ack=readJSON(path.join(dir,key+".json"));
    if(!ack||ack.status!=="WARP_ACK_CONFIRMED")
     return fail("ALIFE12_EXPIRY_WITHOUT_DEPARTURE");
    const record={version:1,status:"ROUTE_EXPIRED",manifestKey:key,systemID,fleetID,
     stationID:ack.stationID,corporationID:ack.corporationID,startedAt:ack.startedAt,
     manifestHash:ack.manifestHash,expiredAt:Number(now)||Number(clock())};
    if(!exact(record.expiredAt))return fail("ALIFE12_EXPIRY_TIME_UNVERIFIED");
    const prior=expiryOf(key);
    if(prior)return equal(prior,record)?{status:"ALREADY_EXPIRED",manifestKey:key}:
     fail("ALIFE12_EXPIRY_ALREADY_RECORDED_DIFFERENTLY");
    io.mkdirSync(dir,{recursive:true});
    const file=expiryFile(key),fd=io.openSync(file,"wx",0o600);
    try{io.writeFileSync(fd,JSON.stringify(record));io.fsyncSync(fd)}
    finally{io.closeSync(fd)}
    if(!equal(record,expiryOf(key)))return fail("ALIFE12_EXPIRY_READBACK_MISMATCH");
    return {status:"ROUTE_EXPIRED",manifestKey:key};
   }catch(error){return fail("ALIFE12_EXPIRY_WRITE_OUTCOME_UNKNOWN",{
    details:String(error?.message||error).slice(0,120)})}
  }
 function saleReceipt(row){
  try{return readJSON(path.join(receiptDir,row.cargoID+".json"))}catch(_error){return null}
 }
 // A sale removes units from a hull row through a REAL market fill. The receipt names
 // this exact row and the exact units the market paid for, so recovery can prove a
 // fully sold row (nothing left aboard) and a partly sold one (the remainder must be
 // declared minus sold). No inference, no averaging, no invented receipt.
  function saleReceiptCovers(row,m,remaining){
  const r=saleReceipt(row);
  if(!r||r.version!==1||r.phase!=="COMMITTED"||r.source!=="NPC_MARKET_FILL")return false;
  if(r.cargoID!==row.cargoID||r.haulerID!==row.haulerID||r.typeID!==row.typeID)return false;
  if(r.systemID!==m.systemID||r.fleetID!==m.fleetID)return false;
  // The receipt records the ore OWNER (used by the deposit path); the manifest names
 // the station corporation. Ownership was proven when the cargo was transferred, so
 // the fill proof itself is about units, station and time - not about the corporation.
 if(!pos(r.corporationID))return false;
  const left=Number(remaining);
  if(!Number.isSafeInteger(left)||left<0)return false;
  // Only fills that happened during THIS trip at THIS manifest's station can prove
  // the units that are missing now. A fill at another station, or before the trip
  // departed, belongs to another manifest and is never credited here.
  const fills=Array.isArray(r.fills)?r.fills:null;
  let sold=0;
  if(fills){
   sold=fills.filter(x=>Number(x&&x.stationID)===Number(m.stationID)&&
    Number(x&&x.at)>=Number(m.startedAt))
    .reduce((sum,x)=>sum+(Number(x.quantity)||0),0);
  }else{
   // Receipts written before the breakdown existed: one fill at one station.
   if(Number(r.stationID)!==Number(m.stationID))return false;
   sold=Number(r.quantity);
  }
  return Number.isSafeInteger(sold)&&sold>0&&sold===Number(row.quantity)-left;
 }
function saleReceiptMatches(row,m){return saleReceiptCovers(row,m,0)}
 function receiptMatches(row,m){
 if(saleReceiptMatches(row,m))return true;
 const r=readJSON(path.join(receiptDir,row.cargoID+".json"));
  if(!r||r.version!==1||r.phase!=="COMMITTED"||
     r.cargoID!==row.cargoID||r.haulerID!==row.haulerID||
     r.typeID!==row.typeID||r.quantity!==row.quantity||
     r.systemID!==m.systemID||r.fleetID!==m.fleetID||
     r.stationID!==m.stationID||!pos(r.corporationID)||!pos(r.itemID))return false;
  // The receipt names the ore OWNER; the manifest names the station corporation.
  // A manifest row that recorded its pre-warp owner must match it exactly, and the
  // physical stack below is the final authority on who holds the ore.
  if(pos(row.ownerID)&&pos(row.ownerID)!==pos(r.corporationID))return false;
  const ownerID=pos(r.corporationID);
  const item=items.findWarehouseItem({
   ownerID,stationID:m.stationID,cargoID:row.cargoID});
  return Boolean(item&&item.itemID===r.itemID&&item.typeID===row.typeID&&
   item.quantity===row.quantity&&item.ownerID===ownerID&&
   item.locationID===m.stationID&&String(item.customInfo)===marker(row.cargoID));
 }
 function recover({systemID,fleetID,haulerIDs}={}){
  if(!exact(systemID)||!exact(fleetID)||!Array.isArray(haulerIDs)||
     !haulerIDs.length||haulerIDs.length>32||
     haulerIDs.some(x=>!exact(x))||
     new Set(haulerIDs).size!==haulerIDs.length)
   return fail("ALIFE12_FLEET_IDENTITY_INVALID");
  const sorted=haulerIDs.slice().sort((a,b)=>a-b);
  try{
   const ships=new Map();
   for(const id of sorted){
    const native=getNativeEntity(id);
    if(!native||Number(native.entityID||native.itemID)!==id||
       Number(native.systemID)!==systemID||native.transient===true)
     return fail("ALIFE12_HAULER_NATIVE_NOT_DURABLE");
    const cargo=store.listNativeCargoForEntity(id);
    if(!Array.isArray(cargo)||cargo.length>1000)
     return fail("ALIFE12_CARGO_UNAVAILABLE");
    ships.set(id,cargo);
   }
   const prefix=systemID+"-"+fleetID+"-";
   const names=listing(manifestDir).filter(x=>x.startsWith(prefix));
   let pending=null;
   for(const name of names){
    const key=name.slice(0,-5);
    if(!keyPattern.test(key))return fail("ALIFE12_MANIFEST_FILENAME_INVALID");
    const m=sourceRecord(key);
    if(m.systemID!==systemID||m.fleetID!==fleetID||
       !equal(m.haulerIDs,sorted))return fail("ALIFE12_MANIFEST_FLEET_CONFLICT");
    // A closed route is closed for good: never re-account a manifest the operator or
    // the deadline already expired, or a stale sale would block the fleet forever.
    if(expiryOf(key)||abandonedOf(key))continue;
    let active=0,accounted=0,undeclared=null;
    const declared=new Set(m.cargo.map(x=>x.cargoID));
    for(const [id,rows] of ships)
     if(!undeclared)undeclared=rows.find(row=>Number(row.coopHaulFleetID)===fleetID&&
      !declared.has(Number(row.cargoID)))||null;
    for(const row of m.cargo){
     const rows=ships.get(row.haulerID)||[];
     const hits=rows.filter(x=>Number(x.cargoID)===row.cargoID);
     if(hits.length>1)return fail("ALIFE12_DUPLICATE_ORIGINAL_CARGO");
     if(hits.length===1){
      const c=hits[0];
      if(c.entityID!==row.haulerID||c.coopHaulFleetID!==fleetID||
         c.coopHaulFromMinerID!==row.fromMinerID||
         c.typeID!==row.typeID||
         Number(c.moduleID||0)!==0||c.transient===true||
         !(c.quantity===row.quantity||
           c.quantity<row.quantity&&saleReceiptCovers(row,m,c.quantity)))
       return fail("ALIFE12_SOURCE_CARGO_CHANGED",overdueOf(key,m));
      // Still aboard, in full or as the proven remainder of a sale: the trip is live.
      active++;accounted++;
      }else if(receiptMatches(row,m))accounted++;
      else return fail("ALIFE12_SOURCE_MISSING_WITHOUT_WAREHOUSE_PROOF",overdueOf(key,m));
      }
      // The hull carries ore this manifest never declared, so the route is out of date.
      // Supersede it ONLY when every row it did declare is proven - still aboard exactly,
      // or covered by a warehouse/sale receipt. Then a fresh manifest declares exactly
      // what the ships carry now, and nothing is dropped or invented.
      if(undeclared){
       if(accounted!==m.cargo.length)
        return fail("ALIFE12_UNDECLARED_HAUL_CARGO",overdueOf(key,m));
       return {status:"ROUTE_SUPERSEDED",reason:"ALIFE12_UNDECLARED_HAUL_CARGO",
        trip:{systemID,fleetID,stationID:m.stationID,corporationID:m.corporationID,
         startedAt:m.startedAt,manifestID:key,
         expectedCargoIDs:m.cargo.map(x=>x.cargoID),
         haulers:Object.fromEntries(sorted.map(id=>[id,{arrivedAt:0}]))}};
      }
    // A completed manifest is historical, not a new route to replay.
    if(active===0)continue;
    const ack=readJSON(path.join(dir,key+".json"));
    if(!ack)return fail("ALIFE12_PREPARED_BUT_WARP_UNCONFIRMED",{...overdueOf(key,m),abandonable:{manifestID:key,startedAt:m.startedAt,elapsedMs:Number(clock())-Number(m.startedAt),graceMs:ABANDON_GRACE_MS}});
    if(ack.version!==1||ack.status!=="WARP_ACK_CONFIRMED"||
       ack.manifestKey!==key||ack.manifestHash!==hash(m)||
       ack.systemID!==systemID||ack.fleetID!==fleetID||
       ack.stationID!==m.stationID||ack.corporationID!==m.corporationID||
       ack.startedAt!==m.startedAt||!exact(ack.confirmedAt)||
       !equal(ack.haulerIDs,sorted)||
       !equal(ack.cargoIDs,m.cargo.map(x=>x.cargoID)))
     return fail("ALIFE12_WARP_ACK_PROVENANCE_INVALID");
    if(pending)return fail("ALIFE12_TWO_ACTIVE_DURABLE_TRIPS");
    pending={status:"RECOVERED_NATIVE_TRIP",trip:{
     systemID,fleetID,stationID:m.stationID,corporationID:m.corporationID,
     startedAt:m.startedAt,manifestID:key,
     expectedCargoIDs:m.cargo.map(x=>x.cargoID),
     haulers:Object.fromEntries(sorted.map(id=>[id,{arrivedAt:0}])),
     coopRecoveredAt:Number(clock())},activeCargo:active};
   }
   return pending||{status:"NO_PENDING_TRIP"};
  }catch(error){return fail("ALIFE12_JOURNAL_READ_OR_PROVENANCE_UNAVAILABLE",{
   details:String(error?.message||error).slice(0,120)})}
 }
 return Object.freeze({confirm,recover,expire,abandon});
}
module.exports={createJournal};
