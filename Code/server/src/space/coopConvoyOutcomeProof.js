"use strict";
// Correlate verified native warehouse item custody or stock-fleet wreck with
// a real attacked convoy. NO wallet writes, item mutation or fake "rescued".
const fs=require("node:fs"),path=require("node:path");
const DEFAULT="/var/lib/evejs/coop-convoy-native-outcomes.jsonl";
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):0;
const keyOf=x=>[x.systemID,x.pirateID,x.targetID].join(":");
const marker=n=>"coop-warehouse:v1:cargo:"+n;
function createOutcomes({file=process.env.EVEJS_COOP_CONVOY_OUTCOMES_FILE||DEFAULT,
 io=fs,clock=()=>Date.now(),incidents=()=>require("./coopConvoyOperations").createOperations().snapshot(),
 maxBytes=8*1024*1024}={}){
 let blocked="";
 function load(){
  if(blocked)return {status:blocked};
  if(typeof file!=="string"||!path.isAbsolute(file)||file.length>500)
   return {status:blocked="OUTCOME_JOURNAL_PATH_INVALID"};
  let raw;
  try{raw=io.readFileSync(file,"utf8")}
  catch(error){if(error?.code==="ENOENT")raw="";else return {status:blocked="OUTCOME_JOURNAL_READ_FAILED"}}
  if(typeof raw!=="string"||Buffer.byteLength(raw)>maxBytes||
   (raw.length>0&&!raw.endsWith("\n")))
   return {status:blocked="OUTCOME_JOURNAL_CORRUPT"};
  const state=new Map();
  for(const line of raw.split("\n")){
   if(!line)continue;
   let event;try{event=JSON.parse(line)}catch{return {status:blocked="OUTCOME_JOURNAL_CORRUPT"}}
   if(event?.v!==1||!["WAREHOUSE_STOCK_VERIFIED","HAULER_WRECK_VERIFIED"].includes(event.state)||
    !id(event.systemID)||!id(event.pirateID)||!id(event.targetID)||
    event.pirateID===event.targetID||event.key!==keyOf(event)||
    !Number.isFinite(event.at)||event.at<0)
    return {status:blocked="OUTCOME_JOURNAL_CORRUPT"};
   let row=state.get(event.key);
   if(!row){row={key:event.key,systemID:event.systemID,
     pirateID:event.pirateID,targetID:event.targetID,stacks:new Map(),lostWreckID:0};
    state.set(event.key,row)}
   if(event.state==="WAREHOUSE_STOCK_VERIFIED"){
    if(!id(event.cargoID)||!id(event.itemID)||!id(event.quantity)||
     !id(event.typeID)||!id(event.stationID)||!id(event.ownerID)||
     row.lostWreckID||row.stacks.has(event.cargoID))
     return {status:blocked="OUTCOME_JOURNAL_BAD_SEQUENCE"};
    row.stacks.set(event.cargoID,{cargoID:event.cargoID,itemID:event.itemID,
     typeID:event.typeID,quantity:event.quantity,stationID:event.stationID,ownerID:event.ownerID});
   }else{
    if(!id(event.wreckID)||row.lostWreckID)
     return {status:blocked="OUTCOME_JOURNAL_BAD_SEQUENCE"};
    row.lostWreckID=event.wreckID;
   }
  }
  return {status:"READY",state};
 }
 function eligible(systemID,haulerID){
  let proof;try{proof=incidents()}catch{return {status:"NATIVE_INCIDENT_AUTHORITY_UNAVAILABLE"}}
  if(proof?.status!=="READY"||!Array.isArray(proof.incidents))
   return {status:"NATIVE_INCIDENT_AUTHORITY_UNAVAILABLE"};
  const matches=proof.incidents.filter(i=>i.systemID===systemID&&
   i.targetID===haulerID&&i.targetRole==="hauler"&&
   ["UNDER_ATTACK","PIRATE_WRECK_CONFIRMED"].includes(i.status)&&
   id(i.pirateID)&&id(i.targetID)&&i.pirateID!==i.targetID&&i.key===keyOf(i));
  if(matches.length!==1)
   return {status:matches.length?"AMBIGUOUS_NATIVE_CONVOY_RAIDS":"NO_ATTACKED_NATIVE_HAULER"};
  return {status:"READY",incident:matches[0]};
 }
 function store(proof){
  if(blocked)return {status:blocked};
  const lock=file+".lock",key=proof.key;
  let lockFD;
  try{io.mkdirSync(path.dirname(file),{recursive:true});
   lockFD=io.openSync(lock,"wx",0o600)}
  catch{return {status:"OUTCOME_WRITER_LOCKED_NEEDS_REPAIR"}}
  let release=false;
  try{
   const previous=load();if(previous.status!=="READY")return previous;
   const row=previous.state.get(key);
   if(proof.state==="WAREHOUSE_STOCK_VERIFIED"){
    if(row?.lostWreckID){release=true;return {status:"HAULER_ALREADY_DESTROYED"}}
    const old=row?.stacks.get(proof.cargoID);
    if(old){
     const equal=["cargoID","itemID","typeID","quantity","stationID","ownerID"]
      .every(k=>old[k]===proof[k]);
     release=true;
     return {status:equal?"NATIVE_STOCK_ALREADY_RECORDED":"NATIVE_CARGO_IDENTITY_CONFLICT",key};
    }
   }else if(row?.lostWreckID){
    release=true;
    return {status:row.lostWreckID===proof.wreckID?"NATIVE_LOSS_ALREADY_RECORDED":
      "NATIVE_WRECK_IDENTITY_CONFLICT",key};
   }
   const now=clock();
   if(!Number.isFinite(now)||now<0){release=true;return {status:"OUTCOME_CLOCK_INVALID"}}
   const data=Buffer.from(JSON.stringify({v:1,...proof,at:now})+"\n");
   let size=0;
   try{size=Buffer.byteLength(io.readFileSync(file,"utf8"))}
   catch(e){if(e?.code!=="ENOENT")return {status:blocked="OUTCOME_JOURNAL_READ_FAILED"}}
   if(data.length>4096||size+data.length>maxBytes){
    release=true;return {status:"OUTCOME_JOURNAL_CAP_REACHED"}}
   let fd;
   try{
    fd=io.openSync(file,"a",0o600);
    if(io.writeSync(fd,data,0,data.length,null)!==data.length)
     return {status:blocked="OUTCOME_JOURNAL_WRITE_UNCERTAIN"};
    io.fsyncSync(fd);
   }catch{return {status:blocked="OUTCOME_JOURNAL_WRITE_UNCERTAIN"}}
   finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
   const checked=load();if(checked.status!=="READY")return checked;
   release=true;
   return {status:"NATIVE_CONVOY_OUTCOME_RECORDED",key,event:proof.state};
  }finally{
   try{io.closeSync(lockFD)}catch{}
   // If writing was uncertain, the lock is left to block automatic retry.
   if(release)try{io.unlinkSync(lock)}catch{}
  }
 }
 function warehouse({record,stock,sourceAbsent}={}){
  const r=record,t=stock;
  if(r?.phase!=="COMMITTED"||sourceAbsent!==true||
   ![r?.cargoID,r?.haulerID,r?.systemID,r?.stationID,r?.corporationID,r?.typeID,r?.quantity,r?.itemID]
    .every(id)||
   id(t?.itemID)!==id(r.itemID)||id(t?.typeID)!==id(r.typeID)||
   id(t?.ownerID)!==id(r.corporationID)||id(t?.locationID)!==id(r.stationID)||
   id(t?.quantity)!==id(r.quantity)||String(t?.customInfo)!==marker(r.cargoID))
   return {status:"WAREHOUSE_NATIVE_STOCK_NOT_PROVEN"};
  const match=eligible(id(r.systemID),id(r.haulerID));
  if(match.status!=="READY")return match;
  const i=match.incident;
  return store({key:i.key,systemID:i.systemID,pirateID:i.pirateID,targetID:i.targetID,
   state:"WAREHOUSE_STOCK_VERIFIED",cargoID:id(r.cargoID),itemID:id(r.itemID),
   typeID:id(r.typeID),quantity:id(r.quantity),stationID:id(r.stationID),ownerID:id(r.corporationID)});
 }
 function loss({proof}={}){
  if(proof?.status!=="PHYSICAL_NATIVE_STOCK_FLEET_WRECK_VERIFIED"||
   proof?.attribution!=="REAL_NATIVE_MINING_FLEET_MEMBERSHIP_AND_WRECK_STORE"||
   proof?.victimRole!=="hauler"||!id(proof.systemID)||!id(proof.victimEntityID)||!id(proof.wreckID))
   return {status:"HAULER_NATIVE_WRECK_NOT_PROVEN"};
  const match=eligible(id(proof.systemID),id(proof.victimEntityID));
  if(match.status!=="READY")return match;
  const i=match.incident;
  return store({key:i.key,systemID:i.systemID,pirateID:i.pirateID,targetID:i.targetID,
   state:"HAULER_WRECK_VERIFIED",wreckID:id(proof.wreckID)});
 }
 function snapshot(){
  const r=load();if(r.status!=="READY")return r;
  return {status:"READY",outcomes:[...r.state.values()].map(i=>({
   key:i.key,systemID:i.systemID,pirateID:i.pirateID,targetID:i.targetID,
   verifiedWarehouseStacks:[...i.stacks.values()],haulerNativeWreckID:i.lostWreckID,
   status:i.lostWreckID?(i.stacks.size?"PARTIAL_STOCK_DELIVERED_THEN_HAULER_LOST":"HAULER_NATIVE_LOSS_VERIFIED"):
    i.stacks.size?"NATIVE_STATION_STOCK_PARTIALLY_VERIFIED":"NO_NATIVE_CARGO_OUTCOME",
   convoySaved:false,paidReward:false
  }))};
 }
 return {warehouse,loss,snapshot};
}
let singleton;
function get(){if(!singleton)singleton=createOutcomes();return singleton}
function noteWarehouse(record,stock,sourceAbsent){
 if(process.env.EVEJS_COOP_CONVOY_OPERATIONS!=="1")return {status:"DISABLED"};
 try{return get().warehouse({record,stock,sourceAbsent})}
 catch{return {status:"CONVOY_OUTCOME_UNAVAILABLE"}}
}
function noteLoss(proof){
 if(process.env.EVEJS_COOP_CONVOY_OPERATIONS!=="1")return {status:"DISABLED"};
 try{return get().loss({proof})}
 catch{return {status:"CONVOY_OUTCOME_UNAVAILABLE"}}
}
module.exports={createOutcomes,noteWarehouse,noteLoss};
