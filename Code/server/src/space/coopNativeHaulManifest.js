"use strict";
// Immutable, native source-derived NPC hauler cargo manifest before first warp.
// Read-only full-trip reconciliation after the stock warehouse COMMITTED debit
// and exact EveJS itemStore credit. NO grants, payout, or virtual "rescue".
const fs=require("node:fs"),path=require("node:path");
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):0;
const valid=x=>id(x)>0;
const marker=cargoID=>"coop-warehouse:v1:cargo:"+cargoID;
function createManifest({root,store,items,getNativeEntity,io=fs,clock=()=>Date.now()}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||!store||
  typeof store.listNativeCargoForEntity!=="function"||!items||
  typeof items.findWarehouseItem!=="function"||typeof getNativeEntity!=="function")
  throw Error("NATIVE_MANIFEST_DEPENDENCIES_REQUIRED");
 const dir=path.join(root,"trip-manifests");
 const manifestPath=k=>path.join(dir,k+".json");
 function syncDir(){
  let fd;try{fd=io.openSync(dir,"r");io.fsyncSync(fd);return true}
  catch{return false}finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
 }
 function identity(args){
  if(![args?.systemID,args?.fleetID,args?.stationID,args?.corporationID].every(valid)||
   !Number.isSafeInteger(args?.startedAt)||args.startedAt<=0)return null;
  return [id(args.systemID),id(args.fleetID),args.startedAt].join("-");
 }
 function check(record){
  if(record?.v!==1||!identity(record)||record.key!==identity(record)||
   !Array.isArray(record.haulerIDs)||!record.haulerIDs.length||
   record.haulerIDs.length>32||!Array.isArray(record.cargo)||!record.cargo.length||
   record.cargo.length>1000)return false;
  const haulers=record.haulerIDs;
  if(haulers.some(x=>!valid(x))||new Set(haulers).size!==haulers.length||
   haulers.some((x,i)=>i&&haulers[i-1]>=x))return false;
  const cargoIDs=new Set();
  for(const row of record.cargo){
   if(![row?.cargoID,row?.haulerID,row?.typeID,row?.quantity,row?.fromMinerID]
    .every(valid)||!haulers.includes(row.haulerID)||
    cargoIDs.has(row.cargoID))return false;
   // The pre-warp OWNER of the row is recorded when it is known (new manifests).
   // A manifest written before the field existed stays readable: its owner is
   // then proven from the physical stack the receipt names, never assumed.
   if(row.ownerID!==undefined&&!valid(row.ownerID))return false;
   cargoIDs.add(row.cargoID);
  }
  return true;
 }
 function read(key){
  if(!/^\d+-\d+-\d+$/.test(String(key)))return {status:"MANIFEST_KEY_INVALID"};
  let raw;
  try{raw=io.readFileSync(manifestPath(key),"utf8")}
  catch(e){return {status:e?.code==="ENOENT"?"MANIFEST_MISSING":"MANIFEST_READ_FAILED"}}
  if(typeof raw!=="string"||Buffer.byteLength(raw)>256*1024)
   return {status:"MANIFEST_CORRUPT"};
  let record;
  try{record=JSON.parse(raw)}catch{return {status:"MANIFEST_CORRUPT"}}
  if(!check(record)||record.key!==key)return {status:"MANIFEST_CORRUPT"};
  return {status:"READY",record};
 }
 function prepare({systemID,fleetID,stationID,corporationID,startedAt,haulerIDs}={}){
  const key=identity({systemID,fleetID,stationID,corporationID,startedAt});
  if(!key||!Array.isArray(haulerIDs)||!haulerIDs.length||
   new Set(haulerIDs.map(id)).size!==haulerIDs.length||
   haulerIDs.some(x=>!valid(x)))return {status:"MANIFEST_IDENTITY_INVALID"};
  const sorted=haulerIDs.map(id).sort((a,b)=>a-b),cargo=[],seen=new Set();
  try{
   for(const haulerID of sorted){
    const entity=getNativeEntity(haulerID);
    if(!entity||id(entity.entityID||entity.itemID)!==haulerID||
     id(entity.systemID)!==id(systemID)||entity.transient===true)
     return {status:"HAULER_NATIVE_PERSISTENCE_UNVERIFIED"};
    const rows=store.listNativeCargoForEntity(haulerID);
    if(!Array.isArray(rows))return {status:"MANIFEST_CARGO_UNAVAILABLE"};
    for(const row of rows){
     // Measured 2026-10-27: the same hold carries the fleet's own lift-tagged minerals back
     // to market, and those rows have no ore provenance by design. They are NOT part of the
     // ore manifest, so they are skipped instead of invalidating the whole trip (measured:
     // MANIFEST_CARGO_INVALID_OR_AMBIGUOUS on every route attempt after a successful load).
     const coopLiftRow=/^coop-mineral-lift:v1:/.test(String(row?.customInfo||""));
     if(coopLiftRow)continue;
     if(![row?.cargoID,row?.typeID,row?.quantity,row?.coopHaulFromMinerID].every(valid)||
      id(row.entityID)!==haulerID||id(row.coopHaulFleetID)!==id(fleetID)||
      Number(row.moduleID||0)!==0||row.transient===true||seen.has(id(row.cargoID)))
      return {status:"MANIFEST_CARGO_INVALID_OR_AMBIGUOUS"};
     seen.add(id(row.cargoID));
     // The row's own cargo owner travels with the manifest: the receipt written at
     // the station names THIS corporation (the ore owner), while the manifest's
     // corporationID is the station operator the fleet trades with.
     cargo.push({cargoID:id(row.cargoID),haulerID,
      typeID:id(row.typeID),quantity:id(row.quantity),
      fromMinerID:id(row.coopHaulFromMinerID),
      ...(valid(row.ownerID)?{ownerID:id(row.ownerID)}:{})});
    }
   }
  }catch{return {status:"MANIFEST_SOURCE_UNAVAILABLE"}}
  if(!cargo.length||cargo.length>1000||sorted.length>32)
   return {status:"MANIFEST_NO_VERIFIED_CARGO"};
  cargo.sort((a,b)=>a.cargoID-b.cargoID);
  const record={v:1,key,systemID:id(systemID),fleetID:id(fleetID),
   stationID:id(stationID),corporationID:id(corporationID),
   startedAt,haulerIDs:sorted,cargo};
  if(!check(record))return {status:"MANIFEST_SOURCE_INVALID"};
  let fd,opened=false;
  try{
   io.mkdirSync(dir,{recursive:true});
   // O_EXCL: a reused route identity is never silently replaced.
   fd=io.openSync(manifestPath(key),"wx",0o600);opened=true;
   io.writeFileSync(fd,JSON.stringify(record));
   io.fsyncSync(fd);
  }catch{return {status:opened?"MANIFEST_WRITE_UNCERTAIN":"MANIFEST_ALREADY_EXISTS_OR_UNAVAILABLE"}}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
  if(!syncDir())return {status:"MANIFEST_DIRECTORY_DURABILITY_UNCERTAIN"};
  const reread=read(key);
  if(reread.status!=="READY")return {status:"MANIFEST_AFTER_WRITE_NOT_VERIFIED"};
  return {status:"MANIFEST_DURABLY_PREPARED",key,cargoIDs:cargo.map(x=>x.cargoID),
   expectedStacks:cargo.length,expectedQuantity:cargo.reduce((n,x)=>n+x.quantity,0)};
 }
 // A market fill leaves no station item, so it proves a row only through its own
 // recorded fills for THIS manifest's station. Receipts written before the breakdown
 // existed carry a single quantity and one station.
 function saleFillCoversRow(receipt,row,mSpec){
  const fills=Array.isArray(receipt.fills)?receipt.fills:null;
  if(fills)
   return fills.filter(x=>id(x&&x.stationID)===id(mSpec.stationID)&&
    Number(x&&x.at)>=Number(mSpec.startedAt))
    .reduce((sum,x)=>sum+(id(x.quantity)||0),0)===id(row.quantity);
  return id(receipt.stationID)===id(mSpec.stationID)&&
   id(receipt.quantity)===id(row.quantity)&&
   Number(receipt.quantity)===Number(receipt.marketQuantity);
 }
 function verify({key,systemID,fleetID,stationID,corporationID,haulerIDs}={}){
  const loaded=read(key);if(loaded.status!=="READY")return loaded;
  const m=loaded.record;
  if(m.systemID!==id(systemID)||m.fleetID!==id(fleetID)||
   m.stationID!==id(stationID)||m.corporationID!==id(corporationID)||
   !Array.isArray(haulerIDs)||haulerIDs.length!==m.haulerIDs.length||
   haulerIDs.some(x=>!m.haulerIDs.includes(id(x))))
   return {status:"MANIFEST_ROUTE_IDENTITY_CONFLICT"};
  try{
   for(const haulerID of m.haulerIDs){
    const native=getNativeEntity(haulerID);
    if(!native||id(native.entityID||native.itemID)!==haulerID||
     id(native.systemID)!==m.systemID||native.transient===true)
     return {status:"MANIFEST_HAULER_NO_LONGER_DURABLE"};
    const current=store.listNativeCargoForEntity(haulerID);
    if(!Array.isArray(current))return {status:"MANIFEST_CARGO_UNAVAILABLE"};
    // A newly loaded or undelivered cargo stack prevents a blanket success.
    if(current.some(x=>id(x.coopHaulFleetID)===m.fleetID||
      m.cargo.some(y=>y.cargoID===id(x.cargoID))))
     return {status:"MANIFEST_SOURCE_CARGO_STILL_PRESENT"};
   }
   for(const row of m.cargo){
    let receipt;
    try{receipt=JSON.parse(io.readFileSync(
     path.join(root,"receipts",row.cargoID+".json"),"utf8"))}
    catch(e){return {status:e?.code==="ENOENT"?"MANIFEST_WAREHOUSE_RECEIPT_MISSING":
     "MANIFEST_WAREHOUSE_RECEIPT_INVALID"}}
    // Two kinds of receipt can close a declared row: a WAREHOUSE deposit, which leaves
    // the exact stack in the corporation hangar, and a MARKET FILL, which sold the
    // units outright. A fill never creates a station item, so it is proven by its own
    // recorded quantity and type - never by inventing stock - and it may cover only
    // part of the row when the market filled less than the hull carried.
    const saleFill=String(receipt&&receipt.source)==="NPC_MARKET_FILL";
    // Ownership: a warehouse receipt names the corporation that owned THIS row
    // (the deposit goes into the owner's own hangar), while m.corporationID is the
    // station operator. Comparing the two rejected every real deposit as
    // MANIFEST_WAREHOUSE_RECEIPT_CONFLICT. The owner is now taken from the manifest
    // row when it recorded one, and otherwise from the physical stack the receipt
    // names - which the native itemStore check below must still prove exists.
    const ownerCorporationID=valid(row.ownerID)?row.ownerID:id(receipt&&receipt.corporationID);
    if(receipt?.version!==1||receipt.phase!=="COMMITTED"||
     id(receipt.cargoID)!==row.cargoID||id(receipt.haulerID)!==row.haulerID||
     id(receipt.typeID)!==row.typeID||
     id(receipt.stationID)!==m.stationID||
     (!saleFill&&(id(receipt.corporationID)!==ownerCorporationID))||
     id(receipt.systemID)!==m.systemID||id(receipt.fleetID)!==m.fleetID||
     (saleFill?!saleFillCoversRow(receipt,row,m):
      (id(receipt.quantity)!==row.quantity||!valid(receipt.itemID))))
     return {status:"MANIFEST_WAREHOUSE_RECEIPT_CONFLICT",cargoID:row.cargoID};
    if(saleFill)continue;
    const stock=items.findWarehouseItem({ownerID:ownerCorporationID,
     stationID:m.stationID,cargoID:row.cargoID});
    if(!stock||id(stock.itemID)!==id(receipt.itemID)||
     id(stock.typeID)!==row.typeID||id(stock.quantity)!==row.quantity||
     id(stock.ownerID)!==ownerCorporationID||id(stock.locationID)!==m.stationID||
     String(stock.customInfo)!==marker(row.cargoID))
     return {status:"MANIFEST_NATIVE_ITEMSTORE_STOCK_CONFLICT",cargoID:row.cargoID};
   }
  }catch{return {status:"MANIFEST_EVIDENCE_UNAVAILABLE"}}
  return {status:"FULL_NATIVE_CARGO_DELIVERY_VERIFIED",key,stationID:m.stationID,
   haulerIDs:m.haulerIDs.slice(),cargoIDs:m.cargo.map(x=>x.cargoID),
   stacks:m.cargo.length,quantity:m.cargo.reduce((n,x)=>n+x.quantity,0),
   convoySaved:false,paidReward:false};
 }
 return {prepare,verify,read};
}
module.exports={createManifest};
