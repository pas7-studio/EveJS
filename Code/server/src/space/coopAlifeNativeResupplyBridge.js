"use strict";
/**
 * ALIFE-02: dispatch authorization for the EXISTING native NPC ammo-retreat
 * director. No side effects, timers, storage, orders, ammo, wallet, or market.
 *
 * Survival uses real current damage/aggression even without an economic
 * planning snapshot. Normal resupply requires a fresh native A-Life intent.
 */
const pos=x=>Number.isSafeInteger(Number(x))&&Number(x)>0;
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
function nativeResupplyActEnabled(env=process.env){
 return env.EVEJS_COOP_ALIFE==="1"&&
  env.EVEJS_COOP_ALIFE_ECONOMY==="1"&&
  env.EVEJS_COOP_ALIFE_NATIVE_RESUPPLY_ACT==="1"&&
  env.EVEJS_COOP_NPC_AMMO_SUPPLY==="1"&&
  env.EVEJS_COOP_NPC_STRICT_AMMO==="1";
}
function selectAmmoResupply({mode,systemID,assignments,decision,scene,
 getController,inspectAmmo,now=Date.now(),maxAgeMs=120000}={}){
 const deny=reason=>({status:"BLOCKED",reason,selected:[],intents:new Map()});
 if(!["SURVIVAL","PLANNED"].includes(mode)||!pos(systemID)||
  !Array.isArray(assignments)||assignments.length>256||
  typeof scene?.getEntityByID!=="function"||Number(scene.systemID)!==Number(systemID)||
  typeof getController!=="function"||typeof inspectAmmo!=="function"||
  !Number.isSafeInteger(now)||now<=0||
  !Number.isSafeInteger(maxAgeMs)||maxAgeMs<30000||maxAgeMs>300000)
  return deny("ALIFE_NATIVE_RESUPPLY_CONTEXT_UNVERIFIED");
 const intents=new Map();
 if(mode==="PLANNED"){
  if(decision?.status!=="OBSERVED"||
   Number(decision.systemID)!==Number(systemID)||
   !Number.isSafeInteger(decision.observedAt)||now<decision.observedAt||
   now-decision.observedAt>maxAgeMs||decision.proof!=="NATIVE_OBSERVATIONS_ONLY"||
   !Array.isArray(decision.intents)||decision.intents.length>32)
   return deny("ALIFE_RESUPPLY_DECISION_STALE_OR_UNVERIFIED");
  for(const intent of decision.intents){
   if(intent?.stage!=="RESUPPLY")continue;
   if(!named(intent.pilotID)||!pos(intent.entityID)||
    !pos(intent.stationID)||intent.role!=="pirate"||
    Number(intent.systemID)!==Number(systemID)||
    intent.provenance!=="NATIVE_READ_ONLY"||intent.nativeMutation!==false||
    intent.reason!=="NATIVE_WEAPON_AMMO_EXHAUSTED"||
    intent.intentID!==String(systemID)+":"+decision.observedAt+":"+
     intent.entityID+":RESUPPLY")
    return deny("ALIFE_RESUPPLY_INTENT_CORRUPT");
   if(intents.has(intent.pilotID))
    return deny("ALIFE_RESUPPLY_DUPLICATED_INTENT");
   intents.set(intent.pilotID,intent);
  }
 }
 const selected=[],seen=new Set();
 for(const a of assignments){
  if(!named(a?.pilotID)||!pos(a?.entityID)||
   Number(a.systemID)!==Number(systemID)||seen.has(a.pilotID))continue;
  seen.add(a.pilotID);
  const intent=intents.get(a.pilotID);
  if(mode==="PLANNED"&&(!intent||Number(intent.entityID)!==Number(a.entityID)))continue;
  const ship=scene.getEntityByID(Number(a.entityID));
  if(ship?.kind!=="ship"||ship.nativeNpc!==true||ship.session?.characterID||
   Number(ship.itemID)!==Number(a.entityID))continue;
  let controller,ammo;
  try{
   controller=getController(Number(a.entityID));
   ammo=inspectAmmo({scene,entityID:Number(a.entityID),
    pilotID:a.pilotID,assignments});
  }catch(_){continue}
  if(Number(controller?.entityID)!==Number(a.entityID)||
   Number(controller?.systemID)!==Number(systemID)||
   ammo?.status!=="AMMO_EXHAUSTED")continue;
  if(mode==="SURVIVAL"){
   const threat=Number(controller.currentTargetID)>0||
    controller.manualOrder?.type==="attack"||
    (typeof ship.hpRatio==="number"&&Number.isFinite(ship.hpRatio)&&
     ship.hpRatio>=0&&ship.hpRatio<0.5)||
    (Number(controller.lastAggressorID)>0&&
     Number.isFinite(controller.lastAggressedAtMs)&&
     now>=controller.lastAggressedAtMs&&now-controller.lastAggressedAtMs<120000);
   if(!threat)continue;
  }else if(controller.currentTargetID>0||controller.manualOrder?.type==="attack"||
    Number(ship.hpRatio)<0.5)continue; // Survival has its own earlier tick.
  selected.push(a);
 }
 return {status:"SELECTED",selected,intents};
}
module.exports={nativeResupplyActEnabled,selectAmmoResupply};
