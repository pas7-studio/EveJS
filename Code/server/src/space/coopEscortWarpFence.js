"use strict";
// P0: fsync-before-native-warp dispatch intent. The ONLY automatic action on
// replay is read-only inspection; no restart may rewarp or re-debit an old cargo.
const fs=require("node:fs"),path=require("node:path");
const pos=x=>Number.isSafeInteger(x)&&x>0;
const validKey=x=>typeof x==="string"&&/^\d+-\d+-\d+$/.test(x);
const deny=status=>({status});
function createWarpFence({root,io=fs,clock=()=>Date.now()}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||
  typeof io.openSync!=="function"||typeof io.readdirSync!=="function"||
  typeof io.lstatSync!=="function"||typeof clock!=="function")
  throw Error("ESCORT_DURABLE_WARP_FENCE_AUTHORITY_REQUIRED");
 const dir=path.join(root,"escort-native-warp-fence");
 const loc=k=>path.join(dir,k+".jsonl");
 function directorySynced(){
  let fd;try{fd=io.openSync(dir,"r");io.fsyncSync(fd);return true}
  catch{return false}finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
 }
 function append(key,entry,exclusive){
  let fd;
  try{
   io.mkdirSync(dir,{recursive:true});
   const bytes=Buffer.from(JSON.stringify(entry)+"\n");
   if(bytes.length>4096)return false;
   fd=io.openSync(loc(key),exclusive?"wx":"a",0o600);
   if(io.writeSync(fd,bytes,0,bytes.length,null)!==bytes.length)
    return false;
   io.fsyncSync(fd);
  }catch{return false}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
  return directorySynced();
 }
 function inspect(manifestKey){
  if(!validKey(manifestKey))return deny("WARP_FENCE_MANIFEST_INVALID");
  let raw;try{raw=io.readFileSync(loc(manifestKey),"utf8")}
  catch(e){return deny(e?.code==="ENOENT"?"WARP_FENCE_NOT_FOUND":
   "WARP_FENCE_UNAVAILABLE")}
  if(typeof raw!=="string"||raw.length>8192||!raw.endsWith("\n"))
   return deny("WARP_FENCE_CORRUPT");
  let events;try{events=raw.trimEnd().split("\n").map(x=>JSON.parse(x))}
  catch{return deny("WARP_FENCE_CORRUPT")}
  if(![1,2].includes(events.length))return deny("WARP_FENCE_CORRUPT");
  const b=events[0];
  if(b?.v!==1||b.phase!=="WARP_PREPARED"||
   b.manifestKey!==manifestKey||
   ![b.systemID,b.fleetID,b.haulerID,b.stationID,
    b.corporationID,b.at].every(pos)||
   typeof b.contractID!=="string"||
   !/^escort-[a-zA-Z0-9-]{1,48}$/.test(b.contractID)||
   !Array.isArray(b.cargoIDs)||b.cargoIDs.length<1||
   b.cargoIDs.length>1000||
   b.cargoIDs.some((x,i)=>!pos(x)||(i>0&&b.cargoIDs[i-1]>=x)))
   return deny("WARP_FENCE_CORRUPT");
  if(events.length===2){
   const a=events[1];
   if(a?.v!==1||a.phase!=="WARP_ACK_CONFIRMED"||
    a.manifestKey!==manifestKey||!pos(a.at))
    return deny("WARP_FENCE_CORRUPT");
  }
  return {status:"READY",phase:events.length===2?
   "WARP_ACK_CONFIRMED":"WARP_PREPARED",booking:b};
 }
 function inspectSource({systemID,fleetID,haulerID,cargoIDs}={}){
  if(![systemID,fleetID,haulerID].every(pos)||
   !Array.isArray(cargoIDs)||!cargoIDs.length||
   cargoIDs.some(x=>!pos(x))||new Set(cargoIDs).size!==cargoIDs.length)
   return deny("WARP_SOURCE_INVALID");
  let names;
  try{names=io.readdirSync(dir)}
  catch(e){return e?.code==="ENOENT"?
   {status:"WARP_SOURCE_CLEAR"}:deny("WARP_FENCE_SCAN_UNAVAILABLE")}
  if(!Array.isArray(names)||names.length>256)
   return deny("WARP_FENCE_SCAN_CAP_EXCEEDED");
  const files=names.filter(x=>typeof x==="string"&&
   /^\d+-\d+-\d+\.jsonl$/.test(x));
  for(const name of files){
   let info;try{info=io.lstatSync(path.join(dir,name))}
   catch{return deny("WARP_FENCE_SCAN_METADATA_UNAVAILABLE")}
   if(!info?.isFile()||info.isSymbolicLink())
    return deny("WARP_FENCE_NONREGULAR_SOURCE");
   const loaded=inspect(name.slice(0,-6));
   if(loaded.status!=="READY")return deny("WARP_FENCE_SCAN_UNVERIFIED");
   const b=loaded.booking;
   if(b.systemID===systemID&&b.fleetID===fleetID&&
    b.haulerID===haulerID&&b.cargoIDs.some(x=>cargoIDs.includes(x)))
    return {status:"WARP_SOURCE_ALREADY_DISPATCHED",
     manifestKey:b.manifestKey,phase:loaded.phase};
  }
  return {status:"WARP_SOURCE_CLEAR"};
 }
 function prepare({manifestKey,contractID,systemID,fleetID,haulerID,
  stationID,corporationID,cargoIDs}={}){
  if(process.env.EVEJS_COOP_ESCORT_WARP_FENCE!=="1")
   return deny("DISABLED");
  if(!validKey(manifestKey)||typeof contractID!=="string"||
   !/^escort-[a-zA-Z0-9-]{1,48}$/.test(contractID)||
   ![systemID,fleetID,haulerID,stationID,corporationID].every(pos)||
   !Array.isArray(cargoIDs)||!cargoIDs.length||cargoIDs.length>1000||
   cargoIDs.some(x=>!pos(x))||new Set(cargoIDs).size!==cargoIDs.length)
   return deny("WARP_INTENT_INVALID");
  const before=inspectSource({systemID,fleetID,haulerID,cargoIDs});
  if(before.status!=="WARP_SOURCE_CLEAR")
   return deny(before.status);
  const at=clock();
  if(!pos(at))return deny("WARP_CLOCK_INVALID");
  const booking={v:1,phase:"WARP_PREPARED",manifestKey,contractID,
   systemID,fleetID,haulerID,stationID,corporationID,
   cargoIDs:cargoIDs.slice().sort((a,b)=>a-b),at};
  if(!append(manifestKey,booking,true))
   return deny("WARP_PREPARE_UNCERTAIN_REPAIR_REQUIRED");
  return {status:"DURABLE_WARP_PREPARED",manifestKey};
 }
 function confirm(manifestKey){
  if(process.env.EVEJS_COOP_ESCORT_WARP_FENCE!=="1")
   return deny("DISABLED");
  const r=inspect(manifestKey);
  if(r.status!=="READY")return r;
  if(r.phase==="WARP_ACK_CONFIRMED")
   return {status:"DURABLE_WARP_ACK_CONFIRMED",manifestKey};
  if(!append(manifestKey,{v:1,phase:"WARP_ACK_CONFIRMED",
   manifestKey,at:clock()},false))
   return deny("WARP_ACK_JOURNAL_UNCERTAIN_REPAIR_REQUIRED");
  return {status:"DURABLE_WARP_ACK_CONFIRMED",manifestKey};
 }
 return Object.freeze({inspect,inspectSource,prepare,confirm});
}
module.exports={createWarpFence};
