"use strict";
/**
 * COOP-042: A-Life economic intent layer. One 30 s A-Life tick, NO extra timer.
 * Read-only proof from native EveJS. Never issues orders, spends ISK, mints
 * items or calls a market RPC. Only the existing native directors can ACT.
 */
const PILOT=/^coop-pilot-[0-9]{3,}$/;
const positive=x=>Number.isSafeInteger(x)&&x>0;
const natural=x=>Number.isSafeInteger(x)&&x>=0;
const VALID_ROLES=new Set(["miner","hauler","trader","patrol","pirate"]);
const VALID_STAGES=new Set(["MINE","HAUL","DELIVER","REFINE","MANUFACTURE","COMPLETE_JOB",
  "LIST_OUTPUT","BUY_SUPPLIES","RESUPPLY","YIELD_SURVIVAL","YIELD_COMMITTED","IDLE"]);
const stable=(a,b)=>String(a).localeCompare(String(b));
function decideNativeEconomy(snapshot,{maxIntents=12,now=Date.now(),maxAgeMs=120000}={}){
 const deny=(reason)=>({status:"BLOCKED",reason,intents:[],blockers:[{reason}],proof:"NONE"});
 if(!snapshot||snapshot.authoritativeNative!==true||!positive(snapshot.systemID)||
    !natural(snapshot.observedAt)||!Number.isSafeInteger(now)||now<snapshot.observedAt||
    now-snapshot.observedAt>maxAgeMs||!Array.isArray(snapshot.pilots)||
    !Array.isArray(snapshot.stations)||snapshot.pilots.length>256||
    snapshot.stations.length>64||!natural(maxIntents)||maxIntents>32)
   return deny("NATIVE_WORLD_SNAPSHOT_UNVERIFIED");
 const stations=new Map();
 for(const st of snapshot.stations){
  if(!positive(st?.stationID)||st.systemID!==snapshot.systemID||
    st.nativeVerified!==true||st.stationID>Number.MAX_SAFE_INTEGER||
    stations.has(st.stationID))return deny("NATIVE_STATION_IDENTITY_CONFLICT");
  stations.set(st.stationID,st);
 }
 const pilots=new Map(),entities=new Set();
 for(const p of snapshot.pilots){
  if(!PILOT.test(p?.pilotID)||!positive(p.entityID)||p.systemID!==snapshot.systemID||
     !VALID_ROLES.has(p.role)||pilots.has(p.pilotID)||entities.has(p.entityID)||
     p.nativeVerified!==true||!Number.isFinite(p.health)||p.health<0||p.health>1||
     typeof p.underAttack!=="boolean"||typeof p.inWarp!=="boolean"||
     typeof p.activeNativeOrder!=="boolean"||typeof p.playerControlled!=="boolean"||
     !natural(p.cargoOreQuantity)||!natural(p.cargoAmmoQuantity))
   return deny("NATIVE_PILOT_IDENTITY_OR_CARGO_UNVERIFIED");
  entities.add(p.entityID);pilots.set(p.pilotID,p);
 }
 const intents=[],blockers=[],resourceKeys=new Set();
 if(pilots.size===0)blockers.push({reason:"NATIVE_ECONOMY_NO_VERIFIED_PILOTS"});
 if(stations.size===0)blockers.push({reason:"NATIVE_ECONOMY_NO_VERIFIED_STATIONS"});
 if(snapshot.omitted!==undefined){
  if(!Array.isArray(snapshot.omitted)||snapshot.omitted.length>256)return deny("NATIVE_SENSOR_OMISSIONS_INVALID");
  for(const missing of snapshot.omitted){
   if(!PILOT.test(missing?.pilotID)||typeof missing.reason!=="string"||
      !/^NATIVE_[A-Z_]{4,70}$/.test(missing.reason))return deny("NATIVE_SENSOR_OMISSIONS_INVALID");
   blockers.push({pilotID:missing.pilotID,reason:missing.reason});
  }
 }
 function choose(p){
  if(p.playerControlled)return {stage:"IDLE",reason:"PLAYER_OWNED_SHIP_EXCLUDED"};
  if(p.underAttack||p.health<0.5)return{stage:"YIELD_SURVIVAL",reason:"NATIVE_SURVIVAL_PREEMPTS_ECONOMY"};
  if(p.inWarp||p.activeNativeOrder)return {stage:"YIELD_COMMITTED",reason:"NATIVE_COMMITTED_ORDER_ACTIVE"};
  const station=stations.get(p.stationID)||null;
  if(!station)return {stage:"IDLE",reason:"NO_VERIFIED_NATIVE_STATION"};
  if(p.role==="hauler"){
   if(p.cargoOreQuantity>0)
    return{stage:p.atStation===true?"DELIVER":"HAUL",reason:"REAL_ORE_CARGO_NEEDS_STATION_RECEIPT",
      resource:"cargo:"+p.entityID,stationID:station.stationID};
   return{stage:"IDLE",reason:"NO_NATIVE_HAUL_CARGO"};
  }
  if(p.role==="miner")return{stage:"MINE",reason:"MINING_REMAINS_NATIVE_FLEET_AUTHORITY",
    stationID:station.stationID,resource:"miner:"+p.entityID};
  if(p.role==="pirate"||p.role==="patrol"){
   if(p.ammoState==="AMMO_EXHAUSTED")
    return{stage:"RESUPPLY",reason:"NATIVE_WEAPON_AMMO_EXHAUSTED",
      stationID:station.stationID,resource:"rearm:"+p.entityID};
   return{stage:"IDLE",reason:p.ammoState==="AMMO_AVAILABLE"?"NATIVE_AMMO_SUFFICIENT":
    "NPC_AMMO_NATIVE_EVIDENCE_REQUIRED"};
  }
  if(p.role!=="trader")return{stage:"IDLE",reason:"NO_ECONOMY_ROLE"};
  // COOP-043: native NPC pilot owner ID is authoritative. Never reuse a
  // station-level economic projection for an unrelated corporation.
  const e=positive(p.ownerID)?p.economy:station.economy;
  if(positive(p.ownerID)&&!e)return{stage:"IDLE",reason:"NATIVE_FACTORY_MARKET_PROOF_REQUIRED"};
  if(positive(p.ownerID)&&e?.authoritativeNative===false&&
     /^[A-Z][A-Z0-9_]{3,110}$/.test(String(e.reason||"")))
   return {stage:"IDLE",reason:e.reason};
  if(positive(p.ownerID)&&(e?.ownerID!==p.ownerID||e?.stationID!==station.stationID||
     e?.systemID!==snapshot.systemID))return{stage:"IDLE",reason:"NATIVE_OWNER_STATION_AUTHORITY_MISMATCH"};
  if(!e||e.authoritativeNative!==true||!natural(e.oreAtStation)||
     !natural(e.mineralStock)||!natural(e.materialShortage)||
     !natural(e.productShortage)||!natural(e.nativeOutputQty)||
     !natural(e.nativeReadyJobs)||!natural(e.nativeOreToRefine)||
     !natural(e.nativeActiveJobs)||typeof e.factoryOnline!=="boolean"||
     typeof e.marketOnline!=="boolean")
   return {stage:"IDLE",reason:"NATIVE_FACTORY_MARKET_PROOF_REQUIRED"};
  // Zero ISK must NOT lock a corporation out of delivering or listing
  // already-paid-for goods. Otherwise the NPC can never earn its first sale.
  // Missing/invalid wallet proof still blocks ALL economic intents.
  if(positive(p.ownerID)&&!natural(e.walletCents))
   return{stage:"IDLE",reason:"NPC_CORPORATION_FUNDS_UNVERIFIED_OR_EMPTY"};
  if(e.nativeOutputQty>0&&e.marketOnline)
   return{stage:"LIST_OUTPUT",reason:"NATIVE_MANUFACTURED_OUTPUT_UNLISTED",
      stationID:station.stationID,resource:"station:"+station.stationID+":list"};
  if(e.nativeReadyJobs>0)
   return{stage:"COMPLETE_JOB",reason:"NATIVE_JOB_READY_PROVEN",
      stationID:station.stationID,resource:"station:"+station.stationID+":job"};
  if(e.productShortage>0&&e.factoryOnline&&e.materialShortage===0&&e.mineralStock>0&&e.nativeActiveJobs<2){
   if(positive(p.ownerID)&&e.walletCents===0)
    return{stage:"IDLE",reason:"NPC_CORPORATION_FUNDS_UNVERIFIED_OR_EMPTY"};
   return{stage:"MANUFACTURE",reason:"VERIFIED_SHORTAGE_AND_NATIVE_INPUTS",
      stationID:station.stationID,resource:"station:"+station.stationID+":job"};
  }
  if(e.materialShortage>0&&e.nativeOreToRefine>0)
   return{stage:"REFINE",reason:"NATIVE_ORE_AVAILABLE_FOR_MINERAL_SHORTAGE",
      stationID:station.stationID,resource:"station:"+station.stationID+":refine"};
  if(e.materialShortage>0){
   if(positive(p.ownerID)&&e.walletCents===0)
    return{stage:"IDLE",reason:"NPC_CORPORATION_FUNDS_UNVERIFIED_OR_EMPTY"};
   return{stage:"BUY_SUPPLIES",reason:"MATERIAL_DEFICIT_REQUIRES_REAL_MARKET_PURCHASE",
      stationID:station.stationID,resource:"station:"+station.stationID+":supplies"};
  }
  return{stage:"IDLE",reason:e.productShortage===0?"ENOUGH_REAL_STOCK":"PRODUCTION_DEPENDENCY_NOT_READY"};
 }
 const ordered=[...pilots.values()].sort((a,b)=>
  (a.underAttack||a.health<0.5?0:1)-(b.underAttack||b.health<0.5?0:1)||
  stable(a.pilotID,b.pilotID));
 for(const p of ordered){
  const selected=choose(p),isAction=!["IDLE","YIELD_SURVIVAL","YIELD_COMMITTED"].includes(selected.stage);
  if(!VALID_STAGES.has(selected.stage))return deny("UNKNOWN_ECONOMY_STAGE");
  if(selected.resource&&resourceKeys.has(selected.resource)){
   blockers.push({pilotID:p.pilotID,reason:"ALIFE_ECONOMY_RESOURCE_RESERVED",
     resource:selected.resource});continue;
  }
  if(!isAction){blockers.push({pilotID:p.pilotID,entityID:p.entityID,reason:selected.reason,
   stage:selected.stage});continue;}
  if(intents.length>=maxIntents){blockers.push({pilotID:p.pilotID,reason:"ALIFE_INTENT_BUDGET_EXHAUSTED"});continue;}
  if(selected.resource)resourceKeys.add(selected.resource);
  intents.push({pilotID:p.pilotID,entityID:p.entityID,systemID:snapshot.systemID,
   role:p.role,stage:selected.stage,reason:selected.reason,
   stationID:selected.stationID,resource:selected.resource,
   intentID:snapshot.systemID+":"+snapshot.observedAt+":"+p.entityID+":"+selected.stage,
   provenance:"NATIVE_READ_ONLY",nativeMutation:false});
 }
 return{status:"OBSERVED",intents,blockers,proof:"NATIVE_OBSERVATIONS_ONLY",
  observedAt:snapshot.observedAt,systemID:snapshot.systemID,
  totals:{nativePilots:pilots.size,nativeStations:stations.size,intents:intents.length,
   blockers:blockers.length}};
}
function createAlifeEconomyObserver({clock=()=>Date.now(),emit=()=>{},
 maxAgeMs=120000,minRepeatMs=300000,maxIntents=12}={}){
 if(typeof clock!=="function"||typeof emit!=="function"||
   !natural(minRepeatMs)||minRepeatMs<30000||minRepeatMs>3600000||
   !natural(maxAgeMs)||maxAgeMs<30000||maxAgeMs>600000||
   !positive(maxIntents)||maxIntents>32)throw Error("ALIFE_ECONOMY_OBSERVER_CONFIG");
 const last=new Map();
 function tick(snapshot){
  if(process.env.EVEJS_COOP_ALIFE!=="1"||process.env.EVEJS_COOP_ALIFE_ECONOMY!=="1")
   return{status:"ALIFE_ECONOMY_DISABLED",intents:[],blockers:[]};
  const now=clock(),result=decideNativeEconomy(snapshot,{now,maxAgeMs,maxIntents});
  if(result.status!=="OBSERVED"){
   const key="blocked:"+String(snapshot?.systemID||0)+":"+result.reason;
   if(now-(last.get(key)??-Infinity)>=minRepeatMs){last.set(key,now);
    emit({event:"alife-economy-blocker",systemID:snapshot?.systemID||0,
     reason:result.reason,source:"NATIVE_ECONOMY_SENSOR",at:now});}
   return result;
  }
  for(const entry of result.intents){
   const key="intent:"+entry.pilotID+":"+entry.stage+":"+entry.resource;
   if(now-(last.get(key)??-Infinity)<minRepeatMs)continue;
   last.set(key,now);
   emit({event:"alife-economy-intent",systemID:entry.systemID,
    pilotID:entry.pilotID,entityID:entry.entityID,stage:entry.stage,
    reason:entry.reason,stationID:entry.stationID,resource:entry.resource,
    intentID:entry.intentID,proof:"NATIVE_READ_ONLY",nativeMutation:false,at:now});
  }
  for(const block of result.blockers){
   const key="block:"+block.pilotID+":"+block.reason;
   if(now-(last.get(key)??-Infinity)<minRepeatMs)continue;
   last.set(key,now);
   emit({event:"alife-economy-blocker",systemID:result.systemID,
    ...block,source:"NATIVE_ECONOMY_SENSOR",at:now});
  }
  if(last.size>5000)for(const [key,at]of last)if(now-at>minRepeatMs*4)last.delete(key);
  return result;
 }
 return Object.freeze({tick,mode:"READ_ONLY_ALIFE_STAGE",supportsNativeMutation:false});
}
module.exports={decideNativeEconomy,createAlifeEconomyObserver};
