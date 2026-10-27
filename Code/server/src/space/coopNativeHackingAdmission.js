"use strict";
// EX-04A: an analyzer activation in native Dogma is the ONLY authority for
// starting a hacking game. A client RPC or synthetic "resolved" scan is not.
// All evidence is session-bound, one-use and in-memory. No game state writes.
const positive = n => Number.isSafeInteger(n) && n > 0;
const vector = p => p && ["x","y","z"].every(k=>typeof p[k]==="number"&&Number.isFinite(p[k]));
const distance = (a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const finite = n=>typeof n==="number"&&Number.isFinite(n);
function createNativeHackingAdmission({getSceneForSession,clock=()=>Date.now(),
 ttlMs=5000,maxGameDurationMs=180000,maxRangeMeters=10000}={}) {
 if(typeof getSceneForSession!=="function"||typeof clock!=="function"||
  !Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>30000||
  !Number.isSafeInteger(maxGameDurationMs)||maxGameDurationMs<60000||
  maxGameDurationMs>600000||maxGameDurationMs<=ttlMs||
  !Number.isSafeInteger(maxRangeMeters)||maxRangeMeters<1000||maxRangeMeters>20000)
  throw Error("NATIVE_HACKING_AUTHORITIES_REQUIRED");
 const pending=new WeakMap();
 function state(session,targetID) {
  if(!session||typeof session!=="object"||!positive(session.characterID)||
   !positive(session?._space?.shipID)||!positive(session?._space?.systemID)||
   session.socket?.destroyed===true||!positive(targetID))return null;
  let scene;try{scene=getSceneForSession(session)}catch{return null}
  if(scene?.systemID!==session._space.systemID||
   typeof scene.getShipEntityForSession!=="function"||
   typeof scene.getEntityByID!=="function")return null;
  const ship=scene.getShipEntityForSession(session),target=scene.getEntityByID(targetID);
  if(!ship||ship.kind!=="ship"||ship.nativeNpc===true||
   ship.itemID!==session._space.shipID||
   ship.session?.characterID&&ship.session.characterID!==session.characterID||
   !vector(ship.position)||ship.pendingWarp||ship.warpState||ship.isWarping||
   String(ship.mode||"").toUpperCase().includes("WARP")||
   !target||target.itemID!==targetID||
   target.dungeonMaterializedContainer!==true||
   target.dungeonMaterializedSiteContent!==true||
   !vector(target.position)||Number(target.dungeonSiteContentHackingState)===2)
   return null;
  const locks=ship.lockedTargets;
  const locked=locks instanceof Set||locks instanceof Map?locks.has(targetID):
   Array.isArray(locks)&&locks.includes(targetID);
  if(!locked)return null;
  const surface=Math.max(0,distance(ship.position,target.position)-
   Math.max(0,Number(ship.radius)||0)-Math.max(0,Number(target.radius)||0));
  if(!finite(surface)||surface>maxRangeMeters)return null;
  return {ship,target,systemID:scene.systemID,shipID:ship.itemID,
   characterID:session.characterID,instanceID:Number(target.dungeonSiteInstanceID)||0};
 }
 function issue(session,context={}) {
  if(!session||typeof session!=="object")return {status:"NOT_AUTHORIZED"};
  pending.delete(session);
  const now=clock();
  if(!Number.isSafeInteger(now)||now<=0)return {status:"INVALID_CLOCK"};
  const targetID=context.targetID,proof=state(session,targetID);
  if(!proof||context.targetEntity!==proof.target||
   !positive(context.moduleTypeID)||![0,1].includes(context.gameType)||
   !finite(context.difficulty)||context.difficulty<1||context.difficulty>50||
   !positive(context.coherence)||context.coherence>2000||
   !positive(context.strength)||context.strength>2000||
   !Number.isSafeInteger(context.slots)||context.slots<0||context.slots>8||
   Number(proof.target.dungeonSiteContentHackingState)===1)
   return {status:"NATIVE_DOGMA_PROOF_REQUIRED"};
  const targetKind=String(proof.target.dungeonSiteContentAnalyzer||"").toLowerCase();
  if((targetKind==="relic")!==(context.gameType===1)||
     !["relic","data"].includes(targetKind))
   return {status:"ANALYZER_TARGET_KIND_MISMATCH"};
  const entry={...proof,targetID,moduleTypeID:context.moduleTypeID,
   gameType:context.gameType,difficulty:context.difficulty,
   coherence:context.coherence,strength:context.strength,slots:context.slots,at:now};
  pending.set(session,entry);
  return {status:"ISSUED"};
 }
 function validate(session,entry,{starting=false}={}){
  if(!entry||entry.session!==session)return false;
  const now=clock();
  if(!Number.isSafeInteger(now)||now<entry.at||
   now-entry.at>(starting?ttlMs:maxGameDurationMs))return false;
  const proof=state(session,entry.targetID);
  return Boolean(proof&&proof.shipID===entry.shipID&&
   proof.systemID===entry.systemID&&proof.characterID===entry.characterID&&
   proof.target===entry.target&&proof.instanceID===entry.instanceID);
 }
 function consume(session,{targetID,gameType,moduleTypeID}={}) {
  if(!session||typeof session!=="object")return null;
  const entry=pending.get(session);
  pending.delete(session); // one-use even on spoofed/expired consume
  if(!entry||entry.targetID!==targetID||entry.gameType!==gameType||
    entry.moduleTypeID!==moduleTypeID)return null;
  const sealed={...entry,session};
  if(!validate(session,sealed,{starting:true}))return null;
  return sealed;
 }
 return Object.freeze({issue,consume,validate});
}
let singleton;
function getNativeHackingAdmission(){
 if(!singleton){
  const runtime=require("./runtime");
  singleton=createNativeHackingAdmission({
   getSceneForSession:s=>runtime.getSceneForSession(s)
  });
 }
 return singleton;
}
module.exports={createNativeHackingAdmission,getNativeHackingAdmission};
