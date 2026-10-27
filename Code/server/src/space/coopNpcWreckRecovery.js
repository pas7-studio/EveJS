"use strict";
// Physically navigates the *same* killer NPC hull to its own real native wreck.
// It never awards loot, cargo or ISK. Transfer requires separate custody proof.
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const vector=p=>!!p&&["x","y","z"].every(k=>Number.isFinite(p[k]));
const meters=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function createWreckRecovery({warp,orbit,clock=()=>Date.now(),
 maxPerTick=2,approachMeters=5000,cooldownMs=60000}={}){
 if(typeof warp!=="function"||typeof orbit!=="function"||
  typeof clock!=="function"||!Number.isSafeInteger(maxPerTick)||
  maxPerTick<1||maxPerTick>5||!Number.isFinite(approachMeters)||
  approachMeters<2500||approachMeters>10000||
  !Number.isSafeInteger(cooldownMs)||cooldownMs<15000)
  throw Error("INVALID_WRECK_RECOVERY_OPTIONS");
 const pending=new Map();
 function tick({systemID,scene,claims=[],assignments=[],store,
  getController=()=>null,blockedIDs=new Set(),pickupDistance=0}={}){
  const system=id(systemID);
  if(!system||Number(scene?.systemID)!==system||
   typeof scene.getEntityByID!=="function"||!Array.isArray(claims)||
   !Array.isArray(assignments)||!store||
   typeof store.getNativeWreck!=="function"||
   typeof store.listNativeWreckItemsForWreck!=="function"||
   typeof getController!=="function")
   return {status:"INVALID_NATIVE_INPUT",orders:[],inspections:[]};
  const now=clock(),orders=[],inspections=[];
  const byPilot=new Map(),byEntity=new Map();
  for(const a of assignments){
   if(typeof a?.pilotID!=="string"||!/^coop-pilot-[0-9]{3,}$/.test(a.pilotID)||
    !id(a.entityID)||Number(a.systemID)!==system)continue;
   if(!byPilot.has(a.pilotID))byPilot.set(a.pilotID,new Set());
   if(!byEntity.has(Number(a.entityID)))byEntity.set(Number(a.entityID),new Set());
   byPilot.get(a.pilotID).add(String(a.entityID)+":"+String(a.systemID));
   byEntity.get(Number(a.entityID)).add(a.pilotID+":"+String(a.systemID));
  }
  const sorted=claims.slice(0,500).sort((a,b)=>Number(a.wreckID)-Number(b.wreckID));
  for(const claim of sorted){
   if(orders.length>=maxPerTick)break;
   const wreckID=id(claim?.wreckID),shipID=id(claim?.attackerEntityID);
   if(!wreckID||!shipID||Number(claim.systemID)!==system||
    !/^coop-pilot-[0-9]{3,}$/.test(String(claim.attackerPilotID))||
    !Number.isSafeInteger(claim.at)||!Number.isSafeInteger(claim.expiresAt)||
    now<claim.at||now>claim.expiresAt||blockedIDs.has(shipID)||
    byPilot.get(claim.attackerPilotID)?.size!==1||byEntity.get(shipID)?.size!==1)
    continue;
   const assignment=assignments.find(a=>a.pilotID===claim.attackerPilotID&&
    Number(a.entityID)===shipID&&Number(a.systemID)===system);
   if(!assignment)continue;
   const hunter=scene.getEntityByID(shipID);
   const physical=scene.getEntityByID(wreckID);
   const wreck=store.getNativeWreck(wreckID);
   if(hunter?.kind!=="ship"||hunter.nativeNpc!==true||
    hunter.session?.characterID||!vector(hunter.position)||
    physical?.nativeNpcWreck!==true||Number(physical.itemID)!==wreckID||
    !vector(physical.position)||!wreck||
    Number(wreck.systemID)!==system||
    Number(wreck.sourceEntityID)!==Number(claim.sourceEntityID)||
    Number(wreck.launcherID)!==Number(claim.sourceEntityID)||
    (typeof scene.getCurrentSimTimeMs==="function"&&
     Number(wreck.expiresAtMs)>0&&
     Number(scene.getCurrentSimTimeMs())>=Number(wreck.expiresAtMs)))
    continue;
   const contents=store.listNativeWreckItemsForWreck(wreckID);
   if(!Array.isArray(contents)||!contents.some(x=>
    id(x.wreckItemID)&&id(x.typeID)&&
    Number(x.wreckID)===wreckID&&
    (x.singleton===true||Number(x.quantity)>0)))continue;
   let controller;
   try{controller=getController(shipID);}catch(_){continue;}
   if(Number(controller?.entityID)!==shipID||
    Number(controller?.systemID)!==system||
    id(controller?.currentTargetID)||controller.manualOrder?.type==="attack"||
    (id(controller?.lastAggressorID)&&now-Number(controller.lastAggressedAtMs||0)<120000)||
    String(hunter.mode||"").toUpperCase().includes("WARP")||
    hunter.pendingWarp||hunter.warpState)continue;
   const key=system+":"+shipID,lease=pending.get(key);
   if(lease&&lease.nextAt>now)continue;
   const distance=meters(hunter.position,physical.position);
   // When the separately gated custody feature is enabled, a mere 5-km
   // inspection must not strand the ship outside its 2.5-km pickup radius.
   const needPickupApproach=pickupDistance>0&&pickupDistance<=approachMeters&&
    distance>pickupDistance;
   if(distance<=approachMeters&&!needPickupApproach){
    inspections.push({status:"NATIVE_WRECK_REACHED",systemID:system,
     pilotID:claim.attackerPilotID,entityID:shipID,wreckID,
     distinctNativeItemCount:contents.length,source:"LIVE_NATIVE_WRECK_STORE",
     cargoTransferred:false,iskGranted:false});
    pending.set(key,{entityID:shipID,wreckID,phase:"INSPECTED",nextAt:now+cooldownMs});
    continue;
   }
   const far=distance>250000;
   let outcome;
   const orbitRange=pickupDistance>0?
    Math.max(500,Math.min(2000,pickupDistance-300)):
    Math.max(2500,Math.min(approachMeters,4500));
   try{outcome=far?warp(shipID,wreckID,{forceImmediateStart:true}):
    orbit(shipID,wreckID,orbitRange);}
   catch(_error){continue;}
   const ok=outcome?.success===true;
   pending.set(key,{entityID:shipID,wreckID,phase:ok?
    (far?"WARP_TO_WRECK":"ORBIT_REAL_WRECK"):"NATIVE_ORDER_FAILED",
    nextAt:now+(ok?cooldownMs:15000)});
   if(ok)orders.push({systemID:system,pilotID:claim.attackerPilotID,
    entityID:shipID,wreckID,action:far?"NATIVE_WARP_TO_WRECK":"NATIVE_ORBIT_WRECK",
    cargoTransferred:false,iskGranted:false});
  }
  if(pending.size>500)for(const [key,l] of pending)
   if(l.nextAt<now-3600000)pending.delete(key);
  return {status:"OK",orders,inspections};
 }
 function activeIDs(systemID){
  const system=id(systemID),now=clock(),out=new Set();
  if(!system)return out;
  for(const [key,l] of pending)if(key.startsWith(system+":")&&l.nextAt>now&&
   ["WARP_TO_WRECK","ORBIT_REAL_WRECK"].includes(l.phase))out.add(l.entityID);
  return out;
 }
 return {tick,activeIDs,snapshot:()=>[...pending].map(([key,l])=>({key,...l}))};
}
module.exports={createWreckRecovery};
