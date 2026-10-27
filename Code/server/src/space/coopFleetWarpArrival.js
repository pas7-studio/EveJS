"use strict";
// Evidence from the real native fleet-warp follower and commander after
// EveJS accepts an actual command. No ship movement or client mutations.
// A successful order alone NEVER constitutes an arrival.
const pos=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const vector=v=>v&&["x","y","z"].every(k=>Number.isFinite(v[k]));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const warping=ship=>String(ship?.mode||"").toUpperCase().includes("WARP")||
 Boolean(ship?.pendingWarp||ship?.warpState);
function createTracker({
 clock=()=>Date.now(),emit=()=>{},tickMs=1500,timeoutMs=180000,
 minTravelMeters=150000,maxDestinationErrorMeters=150000,maxPartyDistanceMeters=250000,
 schedule=(callback,ms)=>setInterval(callback,ms),
 unschedule=handle=>clearInterval(handle)
}={}){
 if(typeof clock!=="function"||typeof emit!=="function"||
  typeof schedule!=="function"||typeof unschedule!=="function"||
  !Number.isSafeInteger(tickMs)||tickMs<250||
  !Number.isSafeInteger(timeoutMs)||timeoutMs<tickMs||
  !Number.isFinite(minTravelMeters)||minTravelMeters<1||
  !Number.isFinite(maxDestinationErrorMeters)||maxDestinationErrorMeters<1||
  !Number.isFinite(maxPartyDistanceMeters)||maxPartyDistanceMeters<1)
  throw Error("invalid physical fleet arrival tracker options");
 const pending=new Map();let handle=null;
 function stopClock(){
  if(handle&&pending.size===0){unschedule(handle);handle=null;}
 }
 function complete(key,state,status,reason,extra={}){
  pending.delete(key);
  const evidence={status,reason,systemID:state.systemID,
   commanderCharacterID:state.commanderCharacterID,
   followerCharacterID:state.followerCharacterID,
   commanderShipID:state.commanderShipID,
   followerShipID:state.followerShipID,targetEntityID:state.targetEntityID,
   actualFollowerWarpObserved:state.warpObserved,
   arrivalVerified:status==="NATIVE_FLEET_FOLLOWER_ARRIVAL_VERIFIED",
   ...extra};
  try{emit(evidence,state.commanderSession);}catch(error){
   console.warn("[CoopFleetWarpArrival] evidence",String(error?.message||error));
  }
  stopClock();
  return evidence;
 }
 function verifiedPair(s){
  const {commanderSession:a,followerSession:b,spaceRuntime:r}=s;
  if(a?.socket?.destroyed===true||b?.socket?.destroyed===true||
   Number(a?._space?.systemID)!==s.systemID||
   Number(b?._space?.systemID)!==s.systemID||
   Number(a?._space?.shipID)!==s.commanderShipID||
   Number(b?._space?.shipID)!==s.followerShipID||
   a?._space?.initialStateSent!==true||b?._space?.initialStateSent!==true)
   return {reason:"SESSION_OR_SHIP_CHANGED"};
  const scene=r?.getSceneForSession?.(a);
  if(!scene||r.getSceneForSession(b)!==scene||
   Number(scene.systemID)!==s.systemID||
   ![...scene.sessions?.values?.()||[]].includes(a)||
   ![...scene.sessions?.values?.()||[]].includes(b))
   return {reason:"NOT_SAME_NATIVE_SCENE"};
  if(!require("./coopFleetWarpSafety").uniqueOwners(scene,a,b,s.systemID))
   return {reason:"STALE_OR_DUPLICATE_NATIVE_OWNER"};
  const leader=scene.getShipEntityForSession?.(a);
  const follower=scene.getShipEntityForSession?.(b);
  if(!leader||!follower||leader!==s.leader||follower!==s.follower||
   leader.kind!=="ship"||follower.kind!=="ship"||
   scene.getEntityByID?.(s.commanderShipID)!==leader||
   scene.getEntityByID?.(s.followerShipID)!==follower||
   !vector(leader.position)||!vector(follower.position))
   return {reason:"NATIVE_ENTITY_MISSING_OR_REPLACED"};
  return {scene,leader,follower};
 }
 function tick(){
  const now=clock();
  for(const [key,s] of pending){
   const x=verifiedPair(s);
   if(x.reason){complete(key,s,"NATIVE_FLEET_FOLLOWER_ARRIVAL_UNVERIFIED",x.reason);continue;}
   if(warping(x.follower))s.warpObserved=true;
   if(now-s.startedAt>=timeoutMs){
    complete(key,s,"NATIVE_FLEET_FOLLOWER_ARRIVAL_UNVERIFIED","NATIVE_ARRIVAL_TIMEOUT");continue;
   }
   if(!s.warpObserved||warping(x.follower)||warping(x.leader))continue;
   const travelled=distance(s.origin,x.follower.position);
   if(travelled<minTravelMeters)continue;
   // Only a physical, stationary arrival near the authoritative native
   // destination is accepted. A mere position update isn't enough.
   if(!s.destination)continue;
   const destinationDistance=distance(x.follower.position,s.destination);
   const teammateDistance=distance(x.follower.position,x.leader.position);
   if(destinationDistance>maxDestinationErrorMeters||
    teammateDistance>maxPartyDistanceMeters)continue;
   complete(key,s,"NATIVE_FLEET_FOLLOWER_ARRIVAL_VERIFIED","NATIVE_SHIPS_AT_DESTINATION",{
    travelledMeters:Math.round(travelled),
    destinationDistanceMeters:Math.round(destinationDistance),
    teammateDistanceMeters:Math.round(teammateDistance)
   });
  }
  stopClock();
  return {pending:pending.size};
 }
 function track({commanderSession,followerSession,spaceRuntime,result,
  targetEntityID}={}){
  if(result?.success!==true)return {status:"ORDER_NOT_ACCEPTED"};
  const commanderCharacterID=pos(commanderSession?.characterID),
   followerCharacterID=pos(followerSession?.characterID),
   commanderShipID=pos(commanderSession?._space?.shipID),
   followerShipID=pos(followerSession?._space?.shipID),
   systemID=pos(followerSession?._space?.systemID);
  if(!commanderCharacterID||!followerCharacterID||
   commanderCharacterID===followerCharacterID||!commanderShipID||
   !followerShipID||commanderShipID===followerShipID||!systemID)
   return {status:"INVALID_NATIVE_FLEET_ORDER"};
  const native=spaceRuntime?.getSceneForSession?.(followerSession);
  if(!native||spaceRuntime.getSceneForSession(commanderSession)!==native||
   Number(native.systemID)!==systemID)
   return {status:"UNVERIFIABLE_NATIVE_SCENE"};
  const leader=native.getShipEntityForSession?.(commanderSession),
   follower=native.getShipEntityForSession?.(followerSession);
  if(!leader||!follower||!vector(follower.position)||!vector(leader.position)||
   native.getEntityByID?.(followerShipID)!==follower||
   native.getEntityByID?.(commanderShipID)!==leader||
   ![...native.sessions?.values?.()||[]].includes(commanderSession)||
   ![...native.sessions?.values?.()||[]].includes(followerSession))
   return {status:"UNVERIFIABLE_NATIVE_SHIPS"};
  if(!require("./coopFleetWarpSafety").uniqueOwners(native,commanderSession,followerSession,systemID))
   return {status:"STALE_OR_DUPLICATE_NATIVE_OWNER"};
  const data=result.data||{};
  const target=pos(targetEntityID);
  const destination=[data.targetPoint,data.rawDestination,
   target&&native.getEntityByID?.(target)?.position].find(vector);
  const key=systemID+":"+followerCharacterID;
  if(pending.has(key))complete(key,pending.get(key),
   "NATIVE_FLEET_FOLLOWER_ARRIVAL_UNVERIFIED","SUPERSEDED_BY_ANOTHER_WARP");
  const state={commanderSession,followerSession,spaceRuntime,
   commanderCharacterID,followerCharacterID,commanderShipID,followerShipID,
   systemID,leader,follower,targetEntityID:target,startedAt:clock(),
   origin:{...follower.position},
   destination:destination?{...destination}:null,warpObserved:warping(follower)};
  pending.set(key,state);
  if(!handle){handle=schedule(tick,tickMs);handle?.unref?.();}
  return {status:"TRACKING_NATIVE_FLEET_FOLLOWER",systemID,
   followerShipID,destinationKnown:Boolean(state.destination)};
 }
 return {track,tick,pendingCount:()=>pending.size};
}
let tracker=null;
function observeAccepted(args){
 if(process.env.EVEJS_COOP_FLEET_WARP_ARRIVAL!=="1")
  return {status:"DISABLED"};
 if(!tracker)tracker=createTracker({emit:(event,session)=>{
  require("./coopRuntimeProbe").observe("coop-fleet-warp-physical-arrival",
   session,null,event);
 }});
 return tracker.track(args);
}
module.exports={createTracker,observeAccepted};
