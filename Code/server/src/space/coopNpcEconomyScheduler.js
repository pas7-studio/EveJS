"use strict";
// COOP-033 scheduler. Explicit start only; no startup side effects.
function createScheduler({director,stations,intervalMs=60000,maxStations=8,
 clock=()=>Date.now(),onResult=()=>{},setTimer=setInterval,clearTimer=clearInterval}={}){
 if(!director||typeof director.tick!=="function"||!Array.isArray(stations)||stations.length<1||
  stations.length>maxStations||!Number.isSafeInteger(intervalMs)||intervalMs<30000||intervalMs>3600000||
  !Number.isSafeInteger(maxStations)||maxStations<1||maxStations>32||typeof clock!=="function"||
  typeof onResult!=="function"||typeof setTimer!=="function"||typeof clearTimer!=="function")
   throw Error("NATIVE_ECONOMY_SCHEDULER_DEPENDENCIES");
 const ids=new Set(),entries=stations.map(s=>{
  if(!s||!Number.isSafeInteger(s.ownerID)||s.ownerID<=0||!Number.isSafeInteger(s.stationID)||s.stationID<=0||
    !Array.isArray(s.productTypeIDs)||s.productTypeIDs.length<1||s.productTypeIDs.length>8||
    s.productTypeIDs.some(x=>!Number.isSafeInteger(x)||x<=0))
    throw Error("NATIVE_ECONOMY_SCHEDULER_INVALID_STATION");
  const id=s.ownerID+":"+s.stationID;
  if(ids.has(id))throw Error("NATIVE_ECONOMY_SCHEDULER_DUPLICATE_STATION");ids.add(id);
  return Object.freeze({ownerID:s.ownerID,stationID:s.stationID,
   productTypeIDs:Object.freeze([...new Set(s.productTypeIDs)].sort((a,b)=>a-b)),id});
 }).sort((a,b)=>a.id.localeCompare(b.id));
 let timer=null,active=false,running=false,lastAt=0;
 const paused=new Map(),stats=new Map();
 function enabled(){return process.env.EVEJS_COOP_NATIVE_NPC_ECONOMY==="1"&&
  process.env.EVEJS_COOP_NATIVE_NPC_ECONOMY_SCHEDULER==="1"}
 async function runOnce(){
  if(!enabled())return{status:"SCHEDULER_DISABLED"};
  if(running)return{status:"SCHEDULER_BUSY"};
  if(!active)return{status:"SCHEDULER_NOT_STARTED"};
  const now=clock();if(!Number.isSafeInteger(now)||now<0)return {status:"INVALID_CLOCK"};
  if(now-lastAt<intervalMs)return{status:"SCHEDULER_RATE_LIMITED"};
  running=true;lastAt=now;const outcomes=[];
  try{
   for(const entry of entries){
    if(!active||!enabled())break;
    if(paused.has(entry.id)){outcomes.push({id:entry.id,status:"STATION_PAUSED"});continue}
    let result;
    try{result=await director.tick(entry);
      if(!result||typeof result.status!=="string")throw Error("UNVERIFIED_TICK_RESULT");
      if(result.status==="BLOCKED"||result.status==="ECONOMY_LOCKED"||
        result.status==="INSTALL_OUTCOME_UNKNOWN"||result.status==="DELIVERY_OUTCOME_UNKNOWN")
       paused.set(entry.id,{reason:result.reason||result.status,at:clock()});
    }catch(error){result={status:"STATION_ERROR",reason:String(error?.message||error)};
      paused.set(entry.id,{reason:result.reason,at:clock()});
    }
    const row={id:entry.id,...result};outcomes.push(row);
    stats.set(entry.id,{at:clock(),last:row});
    try{onResult(row)}catch(_error){}
   }
   return {status:paused.size?"NEEDS_OPERATOR_ATTENTION":"CYCLE_COMPLETE",outcomes};
  }finally{running=false}
 }
 function start(){
  if(!enabled())return {status:"SCHEDULER_DISABLED"};
  if(active)return{status:"ALREADY_STARTED"};
  active=true;lastAt=clock()-intervalMs;
  timer=setTimer(()=>{void runOnce().catch(()=>{})},intervalMs);
  timer?.unref?.();
  return {status:"STARTED",stations:entries.length,intervalMs};
 }
 function stop(){active=false;if(timer!==null){clearTimer(timer);timer=null}return{status:"STOPPED",inFlight:running}}
 function snapshot(){return{active,running,lastAt,paused:Object.fromEntries(paused),stations:entries.map(x=>x.id),
   stats:Object.fromEntries(stats)}}
 // Only explicit operator reconciliation may resume a quarantined station.
 function resume(id,{operatorVerified=false}={}){
  if(operatorVerified!==true)return{status:"RECONCILIATION_REQUIRED"};
  if(!ids.has(id))return{status:"UNKNOWN_STATION"};
  paused.delete(id);return{status:"RESUMED"};
 }
 return Object.freeze({start,stop,runOnce,resume,snapshot});
}
module.exports={createScheduler};
