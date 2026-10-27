"use strict";
// An organic replacement convoy ONLY after the actual native startup
// fleet is fully lost. Calls no spawn or inventory APIs; the pinned EveJS
// handleSceneCreated performs all native fleet creation when permitted.
const positive=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
function createRenewal({clock=()=>Date.now(),cooldownMs=1800000,
 retryMs=600000,dailyCap=4}={}){
 if(typeof clock!=="function"||!Number.isSafeInteger(cooldownMs)||cooldownMs<300000||
  !Number.isSafeInteger(retryMs)||retryMs<60000||
  !Number.isSafeInteger(dailyCap)||dailyCap<1||dailyCap>24)
  throw Error("Invalid native convoy renewal controls");
 const records=new Map();
 function inspect({scene,systemID,slotCount=1,seeded=false,fleets=[]}={}){
  const id=positive(systemID),now=clock();
  if(!id||Number(scene?.systemID)!==id||
   typeof scene.getEntityByID!=="function"||!Array.isArray(fleets)||
   !Number.isSafeInteger(slotCount)||slotCount<1||slotCount>20||
   !Number.isFinite(now))
   return {allowed:false,status:"INVALID_NATIVE_CONVOY_SCENE"};
  // Never replenish a beltless or not yet initialized static system.
  if(!Array.isArray(scene.staticEntities)||
   !scene.staticEntities.some(e=>e?.kind==="asteroidBelt"))
   return {allowed:false,status:"NO_REAL_ASTEROID_BELT"};
  const present=new Set();
  for(const fleet of fleets){
   if(fleet?.source!=="startup"||Number(fleet.systemID)!==id||
    typeof fleet.startupKey!=="string")continue;
   const ships=[...(fleet.minerEntityIDs||[]),...(fleet.haulerEntityIDs||[])];
   if(ships.some(raw=>{
    const entityID=positive(raw),entity=entityID&&scene.getEntityByID(entityID);
    return entity?.kind==="ship"&&entity.nativeNpc===true&&
      Number(entity.itemID)===entityID;
   }))present.add(fleet.startupKey);
  }
  const missing=[];
  for(let slot=1;slot<=slotCount;slot++)
   if(!present.has(id+":"+slot))missing.push(slot);
  let record=records.get(id);
  if(!record){record={
   wasComplete:false,missingSince:null,nextTryAt:0,
   day:Math.floor(now/86400000),attempts:0
  };records.set(id,record);}
  if(record.day!==Math.floor(now/86400000)){
   record.day=Math.floor(now/86400000);record.attempts=0;
  }
  if(missing.length===0){
   record.wasComplete=true;record.missingSince=null;
   return {allowed:false,status:"ACTIVE_NATIVE_CONVOY",missing:[]};
  }
  if(seeded===true)record.wasComplete=true;
  if(!record.wasComplete){
   // The initial startup has not yet succeeded: let the existing
   // bounded headless startup recovery handle these missing slots.
   return {allowed:true,renewal:false,status:"INITIAL_NATIVE_BOOT",missing};
  }
  if(record.missingSince===null){
   record.missingSince=now;
   return {allowed:false,status:"CONVOY_LOST_COOLDOWN",missing,
    retryAfterMs:cooldownMs};
  }
  const wait=Math.max(0,record.missingSince+cooldownMs-now,
   record.nextTryAt-now);
  if(wait>0)return {allowed:false,status:"CONVOY_LOST_COOLDOWN",
   missing,retryAfterMs:wait};
  if(record.attempts>=dailyCap)
   return {allowed:false,status:"CONVOY_RENEWAL_DAILY_CAP",
    missing,attempts:record.attempts};
  record.attempts++;
  record.nextTryAt=now+retryMs;
  return {allowed:true,renewal:true,status:"NATIVE_CONVOY_RENEWAL_AUTHORIZED",
   missing,attempts:record.attempts};
 }
 return {inspect};
}
let singleton;
function inspect(args){
 if(process.env.EVEJS_COOP_CONVOY_RENEWAL!=="1")
  return {allowed:true,renewal:false,status:"RENEWAL_DISABLED"};
 if(!singleton)singleton=createRenewal();
 return singleton.inspect(args);
}
module.exports={createRenewal,inspect};
