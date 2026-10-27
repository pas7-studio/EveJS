"use strict";
// Stage J: fsynced, immutable provenance for original NPC cargo -> native wreck.
// NEVER manufactures loot, mutates itemStore or pays rewards.
const fs=require("node:fs"),path=require("node:path");
const pos=x=>Number.isSafeInteger(x)&&x>0;
const key=x=>typeof x==="string"&&/^\d+-\d+-\d+$/.test(x);
const deny=status=>({status});
function createSalvageLedger({root,io=fs,clock=()=>Date.now(),readManifest,
 getWreck,getWreckItems,readOriginalCargo,readWarehouseItem}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||
  [clock,readManifest,getWreck,getWreckItems,readOriginalCargo,
   readWarehouseItem].some(x=>typeof x!=="function"))
  throw Error("SALVAGE_NATIVE_SOURCES_REQUIRED");
 const dir=path.join(root,"salvage-provenance");
 const file=k=>path.join(dir,k+".json");
 const clone=x=>JSON.parse(JSON.stringify(x));
 function read(manifestKey){
  if(!key(manifestKey))return deny("SALVAGE_KEY_INVALID");
  let raw;
  try{raw=io.readFileSync(file(manifestKey),"utf8")}
  catch(e){return deny(e?.code==="ENOENT"?"NOT_FOUND":"SALVAGE_READ_UNAVAILABLE")}
  if(typeof raw!=="string"||raw.length>131072||!raw.endsWith("\n"))
   return deny("SALVAGE_JOURNAL_CORRUPT");
  let r;try{r=JSON.parse(raw.trimEnd())}
  catch{return deny("SALVAGE_JOURNAL_CORRUPT")}
  if(r?.v!==1||r.manifestKey!==manifestKey||
   ![r.systemID,r.haulerID,r.wreckID,r.stationID,r.corporationID,r.at].every(pos)||
   !Array.isArray(r.rows)||!r.rows.length||r.rows.length>1000||
   r.rows.some(x=>![x.cargoID,x.wreckItemID,x.typeID,x.quantity].every(pos))||
   new Set(r.rows.map(x=>x.cargoID)).size!==r.rows.length||
   new Set(r.rows.map(x=>x.wreckItemID)).size!==r.rows.length)
   return deny("SALVAGE_JOURNAL_CORRUPT");
  return {status:"READY",record:clone(r)};
 }
 function verify(manifestKey){
  const current=read(manifestKey);
  if(current.status!=="READY")return current;
  const r=current.record;
  let manifest,wreck,items;
  try{manifest=readManifest(manifestKey);wreck=getWreck(r.wreckID);
   items=getWreckItems(r.wreckID)}
  catch{return deny("SALVAGE_NATIVE_READ_UNAVAILABLE")}
  const m=manifest?.record;
  if(manifest?.status!=="READY"||m?.key!==manifestKey||
   m.systemID!==r.systemID||m.stationID!==r.stationID||
   m.corporationID!==r.corporationID||
   !m.haulerIDs?.includes(r.haulerID)||
   wreck?.wreckID!==r.wreckID||wreck.systemID!==r.systemID||
   wreck.sourceEntityID!==r.haulerID||!Array.isArray(items))
   return deny("SALVAGE_SOURCE_IDENTITY_CHANGED");
  for(const row of r.rows){
   const original=m.cargo.filter(x=>x.cargoID===row.cargoID&&
    x.haulerID===r.haulerID&&x.typeID===row.typeID&&
    x.quantity>=row.quantity);
   const matches=items.filter(x=>x.wreckItemID===row.wreckItemID&&
    x.wreckID===r.wreckID&&x.sourceCargoID===row.cargoID&&
    x.typeID===row.typeID&&x.quantity===row.quantity);
   if(original.length!==1||matches.length!==1)
    return deny("SALVAGE_ORIGINAL_ITEM_MISMATCH");
  }
  return {status:"SALVAGE_ORIGIN_VERIFIED",manifestKey,
   wreckID:r.wreckID,rows:clone(r.rows),quantity:r.rows.reduce((n,x)=>n+x.quantity,0),
   stockTransferred:false,paid:false};
 }
 function witness({manifestKey,wreckID,haulerID,systemID}={}){
  if(process.env.EVEJS_COOP_SALVAGE_PROVENANCE!=="1")
   return deny("DISABLED");
  if(!key(manifestKey)||![wreckID,haulerID,systemID].every(pos))
   return deny("SALVAGE_WITNESS_INVALID");
  const prior=read(manifestKey);
  if(prior.status==="READY"){
   if(prior.record.wreckID!==wreckID||prior.record.haulerID!==haulerID||
    prior.record.systemID!==systemID)
    return deny("SALVAGE_WITNESS_CONFLICT");
   const confirmed=verify(manifestKey);
   return confirmed.status==="SALVAGE_ORIGIN_VERIFIED"?
    {...confirmed,status:"ALREADY_VERIFIED"}:confirmed;
  }
  if(prior.status!=="NOT_FOUND")return prior;
  let manifest,wreck,items;
  try{manifest=readManifest(manifestKey);wreck=getWreck(wreckID);
   items=getWreckItems(wreckID)}
  catch{return deny("SALVAGE_NATIVE_SOURCE_UNAVAILABLE")}
  const m=manifest?.record;
  if(manifest?.status!=="READY"||m?.key!==manifestKey||
   m.systemID!==systemID||!m.haulerIDs?.includes(haulerID)||
   !pos(m.stationID)||!pos(m.corporationID)||
   wreck?.wreckID!==wreckID||wreck.systemID!==systemID||
   wreck.sourceEntityID!==haulerID||!Array.isArray(items)||
   !Array.isArray(m.cargo)||!m.cargo.length)
   return deny("SALVAGE_ORIGINAL_MANIFEST_UNVERIFIED");
  const source=m.cargo.filter(x=>x.haulerID===haulerID);
  if(!source.length||source.length>1000)return deny("SALVAGE_ORIGINAL_EMPTY");
  const rows=[];
  for(const original of source){
   if(![original.cargoID,original.typeID,original.quantity].every(pos))
    return deny("SALVAGE_ORIGINAL_INVALID");
   // Destination warehouse stock and surviving wreck inventory cannot
   // both claim the same original cargo ID.
   let warehouse,originalCargo;
   try{warehouse=readWarehouseItem(original.cargoID);
    originalCargo=readOriginalCargo(original.cargoID)}
   catch{return deny("SALVAGE_STOCK_SOURCE_UNAVAILABLE")}
   if(warehouse||originalCargo)return deny("SALVAGE_ORIGINAL_NOT_EXCLUSIVELY_LOST");
   const matches=items.filter(x=>x.wreckID===wreckID&&
    x.sourceCargoID===original.cargoID&&
    x.typeID===original.typeID&&pos(x.wreckItemID)&&
    pos(x.quantity)&&x.quantity<=original.quantity);
   if(matches.length>1)return deny("SALVAGE_DUPLICATE_SOURCE_CARGO");
   if(matches.length===1)rows.push({cargoID:original.cargoID,
    wreckItemID:matches[0].wreckItemID,typeID:original.typeID,
    quantity:matches[0].quantity});
  }
  if(!rows.length)return deny("SALVAGE_NO_SOURCE_PROVEN_SURVIVORS");
  if(new Set(rows.map(x=>x.wreckItemID)).size!==rows.length)
   return deny("SALVAGE_DUPLICATE_WRECK_ITEM");
  const record={v:1,manifestKey,systemID,haulerID,wreckID,
   stationID:m.stationID,corporationID:m.corporationID,
   rows:rows.sort((a,b)=>a.cargoID-b.cargoID),at:clock()};
  if(!pos(record.at))return deny("SALVAGE_CLOCK_INVALID");
  let fd;
  try{
   io.mkdirSync(dir,{recursive:true});
   const buf=Buffer.from(JSON.stringify(record)+"\n");
   fd=io.openSync(file(manifestKey),"wx",0o600);
   if(io.writeSync(fd,buf,0,buf.length,null)!==buf.length)
    return deny("SALVAGE_FSYNC_UNCERTAIN");
   io.fsyncSync(fd);
  }catch{return deny("SALVAGE_WITNESS_WRITE_UNCERTAIN")}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
  try{fd=io.openSync(dir,"r");io.fsyncSync(fd)}
  catch{return deny("SALVAGE_FSYNC_UNCERTAIN")}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
  return {status:"SALVAGE_ORIGIN_DURABLE",manifestKey,
   wreckID,rows:clone(record.rows),stockTransferred:false,paid:false};
 }
 return {witness,verify,read};
}
module.exports={createSalvageLedger};
