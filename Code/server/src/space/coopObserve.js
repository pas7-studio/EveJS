"use strict";
// Telemetry must never change gameplay. Every module that reports a decision
// used to wrap probe.observe() in its own try/catch, so one throwing probe could
// still break a haul. This is the single guarded entry point.
//
// Rules it enforces:
//  - no payload is invented here: callers pass exact IDs and an explicit
//    status/reason, and a missing probe simply means "no telemetry";
//  - a repeated (key, status) pair is reported once, so a per-tick caller cannot
//    flood the event log;
//  - nothing is cached globally: the caller owns its dedupe set.
function observe(probe,event,{systemID=0,itemID=0}={},payload={}){
 try{
  if(typeof probe?.observe!=="function")return false;
  probe.observe(event,itemID?{itemID}:null,{spaceState:{systemID}},payload);
  return true;
 }catch(_error){
  return false;
 }
}
function noteOnce(seen,key,probe,event,context,payload){
 const id=String(key||"")+"|"+String(event||"")+"|"+String(payload?.status||payload?.reason||"");
 if(seen&&seen.has(id))return false;
 if(seen&&typeof seen.add==="function")seen.add(id);
 return observe(probe,event,context,payload);
}
module.exports={observe,noteOnce};
