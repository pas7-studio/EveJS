"use strict";
// COOP-057: original, one-shot native NPC ingress AFTER actual WARP_ACK.
// Only a pinned, real movement-state restore may consume it; no wallet or warp
// command is exposed. A missed ACK can never mint a snapshot on replay.
const fs=require("node:fs"),path=require("node:path");
const positive=x=>Number.isSafeInteger(x)&&x>0;
const keyOK=x=>typeof x==="string"&&/^\d+-\d+-\d+$/.test(x);
const vec=x=>x&&["x","y","z"].every(k=>Number.isFinite(x[k]));
const sameVec=(x,y)=>vec(x)&&vec(y)&&["x","y","z"].every(k=>x[k]===y[k]);
const same=(x,y)=>Array.isArray(x)&&Array.isArray(y)&&x.length===y.length&&
 x.every((v,i)=>v===y[i]);
const deny=status=>({status});
const DURATION_MIN=6000,DURATION_MAX=30000,MAX_BYTES=3072;
function createNativeIngressSnapshot({root,io=fs,clock=()=>Date.now()}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||
  typeof clock!=="function"||!io?.openSync||!io?.lstatSync)
  throw Error("ESCORT_INGRESS_SNAPSHOT_ROOT_REQUIRED");
 const dir=path.join(root,"escort-native-ingress-snapshot");
 const file=k=>path.join(dir,k+".json");
 function identity(b){
  return keyOK(b?.manifestKey)&&
   typeof b.contractID==="string"&&/^escort-[a-zA-Z0-9-]{1,48}$/.test(b.contractID)&&
   [b.systemID,b.fleetID,b.haulerID,b.stationID,b.corporationID].every(positive)&&
   Array.isArray(b.cargoIDs)&&b.cargoIDs.length>0&&b.cargoIDs.length<=1000&&
   b.cargoIDs.every(positive)&&new Set(b.cargoIDs).size===b.cargoIDs.length;
 }
 function validIngress(g){
  return g&&vec(g.origin)&&vec(g.targetPoint)&&
   positive(g.startTimeMs)&&positive(g.travelCompleteAtMs)&&
   Math.hypot(g.targetPoint.x-g.origin.x,g.targetPoint.y-g.origin.y,
    g.targetPoint.z-g.origin.z)>=10000&&
   g.travelCompleteAtMs-g.startTimeMs>=DURATION_MIN&&
   g.travelCompleteAtMs-g.startTimeMs<=DURATION_MAX&&
   (g.completeAtMs===undefined||
    Number.isFinite(g.completeAtMs)&&
    g.completeAtMs>=g.travelCompleteAtMs&&
    g.completeAtMs-g.travelCompleteAtMs<=5000);
 }
 function original(b,g){
  return {v:1,phase:"NATIVE_INGRESS_AFTER_WARP_ACK",
   manifestKey:b.manifestKey,contractID:b.contractID,
   systemID:b.systemID,fleetID:b.fleetID,haulerID:b.haulerID,
   stationID:b.stationID,corporationID:b.corporationID,
   cargoIDs:b.cargoIDs.slice().sort((a,b)=>a-b),
   origin:{x:g.origin.x,y:g.origin.y,z:g.origin.z},
   targetPoint:{x:g.targetPoint.x,y:g.targetPoint.y,z:g.targetPoint.z},
   startTimeMs:g.startTimeMs,travelCompleteAtMs:g.travelCompleteAtMs,
   completeAtMs:Math.max(g.completeAtMs||g.travelCompleteAtMs,g.travelCompleteAtMs)};
 }
 function check(row,b){
  return row&&row.v===1&&row.phase==="NATIVE_INGRESS_AFTER_WARP_ACK"&&
   identity(b)&&row.manifestKey===b.manifestKey&&row.contractID===b.contractID&&
   row.systemID===b.systemID&&row.fleetID===b.fleetID&&
   row.haulerID===b.haulerID&&row.stationID===b.stationID&&
   row.corporationID===b.corporationID&&same(row.cargoIDs,b.cargoIDs.slice().sort((a,b)=>a-b))&&
   validIngress(row)&&vec(row.origin)&&vec(row.targetPoint)&&
   Number.isSafeInteger(row.at)&&row.at>0&&row.at>=row.startTimeMs&&
   row.at<=row.travelCompleteAtMs&&
   Math.hypot(row.targetPoint.x-row.origin.x,
    row.targetPoint.y-row.origin.y,row.targetPoint.z-row.origin.z)>=10000;
 }
 function inspect(b){
  if(!identity(b))return deny("INGRESS_SNAPSHOT_IDENTITY_INVALID");
  const target=file(b.manifestKey);
  let raw;try{
   const stat=io.lstatSync(target);
   if(!stat?.isFile()||stat.isSymbolicLink()||stat.nlink!==1)
    return deny("INGRESS_SNAPSHOT_NOT_REGULAR_OR_LINKED");
   raw=io.readFileSync(target,"utf8");
  }catch(e){return deny(e?.code==="ENOENT"?"INGRESS_SNAPSHOT_NOT_FOUND":
   "INGRESS_SNAPSHOT_READ_UNAVAILABLE")}
  if(typeof raw!=="string"||Buffer.byteLength(raw)>MAX_BYTES||!raw.endsWith("\n"))
   return deny("INGRESS_SNAPSHOT_CORRUPT");
  let row;try{row=JSON.parse(raw.trim())}
  catch{return deny("INGRESS_SNAPSHOT_CORRUPT")}
  if(!check(row,b))return deny("INGRESS_SNAPSHOT_SOURCE_MISMATCH");
  return {status:"VERIFIED_NATIVE_INGRESS_SNAPSHOT",row};
 }
 function sync(b){
  let fd,dirfd;
  try{
   fd=io.openSync(file(b.manifestKey),"r");io.fsyncSync(fd);
   io.closeSync(fd);fd=undefined;
   dirfd=io.openSync(dir,"r");io.fsyncSync(dirfd);
  }catch{return false}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}
   if(dirfd!==undefined)try{io.closeSync(dirfd)}catch{}}
  return true;
 }
 function readDurable(b){
  const first=inspect(b);
  if(first.status!=="VERIFIED_NATIVE_INGRESS_SNAPSHOT")return first;
  if(!sync(b))return deny("INGRESS_SNAPSHOT_FSYNC_UNCERTAIN");
  const second=inspect(b);
  if(second.status!=="VERIFIED_NATIVE_INGRESS_SNAPSHOT")return second;
  return second;
 }
 function record({booking:b,ingress,verifiedAck,source,at=clock()}={}){
  if(process.env.EVEJS_COOP_ESCORT_NATIVE_INGRESS_SNAPSHOT!=="1")
   return deny("DISABLED");
  if(!identity(b)||!validIngress(ingress)||!Number.isSafeInteger(at)||
   at<ingress.startTimeMs||at>ingress.travelCompleteAtMs||
   verifiedAck?.status!=="READY"||
   verifiedAck.phase!=="WARP_ACK_CONFIRMED"||
   source?.status!=="VERIFIED_NATIVE_ESCORT_DEPARTURE"||
   source.manifestKey!==b.manifestKey||source.contractID!==b.contractID||
   !sameVec(source.origin,ingress.origin)||
   verifiedAck.booking?.contractID!==b.contractID||
   verifiedAck.booking?.manifestKey!==b.manifestKey||
   verifiedAck.booking?.systemID!==b.systemID||
   verifiedAck.booking?.fleetID!==b.fleetID||
   verifiedAck.booking?.haulerID!==b.haulerID||
   verifiedAck.booking?.stationID!==b.stationID||
   verifiedAck.booking?.corporationID!==b.corporationID||
   !same(verifiedAck.booking?.cargoIDs,b.cargoIDs))
   return deny("INGRESS_SNAPSHOT_NATIVE_ACK_OR_SOURCE_INVALID");
  const row={...original(b,ingress),at};
  const existing=inspect(b);
  if(existing.status==="VERIFIED_NATIVE_INGRESS_SNAPSHOT"){
   const old=existing.row;
   if(!["contractID","origin","targetPoint","startTimeMs","travelCompleteAtMs","completeAtMs"]
    .every(k=>JSON.stringify(old[k])===JSON.stringify(row[k])))
    return deny("INGRESS_SNAPSHOT_REPLAY_MISMATCH");
   return readDurable(b).status==="VERIFIED_NATIVE_INGRESS_SNAPSHOT"?
    {status:"INGRESS_SNAPSHOT_ALREADY_DURABLE",manifestKey:b.manifestKey}:
    deny("INGRESS_SNAPSHOT_REPLAY_FSYNC_UNCERTAIN");
  }
  if(existing.status!=="INGRESS_SNAPSHOT_NOT_FOUND")return existing;
  let fd,dirfd;
  try{
   io.mkdirSync(dir,{recursive:true});
   const bytes=Buffer.from(JSON.stringify(row)+"\n");
   if(bytes.length>MAX_BYTES)return deny("INGRESS_SNAPSHOT_TOO_LARGE");
   fd=io.openSync(file(b.manifestKey),"wx",0o600);
   if(io.writeSync(fd,bytes,0,bytes.length,null)!==bytes.length)
    return deny("INGRESS_SNAPSHOT_WRITE_UNCERTAIN");
   io.fsyncSync(fd);io.closeSync(fd);fd=undefined;
   dirfd=io.openSync(dir,"r");io.fsyncSync(dirfd);
  }catch{return deny("INGRESS_SNAPSHOT_WRITE_UNCERTAIN")}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}
   if(dirfd!==undefined)try{io.closeSync(dirfd)}catch{}}
  return inspect(b).status==="VERIFIED_NATIVE_INGRESS_SNAPSHOT"?
   {status:"DURABLE_NATIVE_INGRESS_SNAPSHOT",manifestKey:b.manifestKey}:
   deny("INGRESS_SNAPSHOT_RECHECK_UNCERTAIN");
 }
 return Object.freeze({record,inspect,readDurable});
}
module.exports={createNativeIngressSnapshot};
