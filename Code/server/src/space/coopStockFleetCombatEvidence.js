"use strict";
// Read-only native HP delta witness for named pirates attacking *real*
// stock EveJS miner/hauler ships without a co-op pilot name.
// Correlation with current attack orders is not kill credit or a weapon hit.
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const validPilot=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
function healthLayers(value){
 if(!value||typeof value!=="object")return null;
 const out={};
 for(const key of ["shield","armor","structure"]){
  if(!Number.isFinite(value[key])||value[key]<0)return null;
  out[key]=value[key];
 }
 return out;
}
function createStockFleetCombatEvidence({clock=()=>Date.now(),maxTracked=100,minLossHP=0.01}={}){
 if(typeof clock!=="function"||!Number.isSafeInteger(maxTracked)||maxTracked<1||
  !Number.isFinite(minLossHP)||minLossHP<=0)throw Error("invalid stock combat evidence options");
 const previous=new Map();
 function sample({systemID,scene,links=[],pilots=[],fleetShips=[],
  getHealth,getController}={}){
  const system=positive(systemID),now=clock();
  if(!system||typeof scene?.getEntityByID!=="function"||
   !Array.isArray(links)||!Array.isArray(pilots)||!Array.isArray(fleetShips)||
   typeof getHealth!=="function"||typeof getController!=="function"||
   !Number.isFinite(now))return {status:"UNAVAILABLE",events:[]};
  const permit=require("./coopNativeRaidEligibility").isAuthorizedStockMiningRaid;
  const players=new Set(Array.from(scene.sessions?.values?.()||[])
   .map(session=>positive(session?._space?.shipID)).filter(Boolean));
  const sourceIDs=[...new Set(links.filter(link=>
   validPilot(link?.pilotID)&&link?.role==="pirate"&&
   Number(link?.systemID)===system).map(link=>positive(link.entityID)).filter(Boolean))];
  const events=[],observedTargets=new Set();
  for(const targetRow of fleetShips){
   const id=positive(targetRow?.id),victim=id&&scene.getEntityByID(id);
   if(!id||observedTargets.has(id)||players.has(id)||
    victim?.nativeNpc!==true||victim.kind!=="ship")continue;
   // Named victims are already covered by the stricter named-vs-named
   // combat witness; do not double-count damage or rewrite that proof.
   if(links.some(link=>Number(link.systemID)===system&&
    Number(link.entityID)===id&&validPilot(link.pilotID)))continue;
   observedTargets.add(id);
   const attackers=[];
   for(const attackerID of sourceIDs){
    if(attackerID===id||players.has(attackerID))continue;
    const pirate=scene.getEntityByID(attackerID);
    const controller=getController(attackerID);
    if(controller?.manualOrder?.type!=="attack"||
     Number(controller.manualOrder.targetID)!==id)continue;
    if(!permit({systemID:system,attacker:pirate,target:victim,
     links,pilots,fleetShips}))continue;
    const pilot=links.find(link=>Number(link.entityID)===attackerID&&
     Number(link.systemID)===system);
    attackers.push({pilotID:pilot.pilotID,entityID:attackerID});
   }
   let current;
   try{current=healthLayers(getHealth(victim));}catch(_error){}
   if(!current)continue;
   const key=system+":"+id,prior=previous.get(key);
   // One snapshot only establishes a baseline. A different ship that
   // reuses a native ID must not inherit stale HP from a dead miner.
   if(prior&&prior.entity===victim&&now>prior.at){
    const lost={shield:Math.max(0,prior.layers.shield-current.shield),
     armor:Math.max(0,prior.layers.armor-current.armor),
     structure:Math.max(0,prior.layers.structure-current.structure)};
    const total=lost.shield+lost.armor+lost.structure;
    if(total>=minLossHP&&attackers.length){
     events.push({systemID:system,victimEntityID:id,victimRole:targetRow.role,
      healthLossHP:Math.round(total*1000)/1000,layerLossHP:lost,
      attackerPilotIDs:[...new Set(attackers.map(a=>a.pilotID))].sort(),
      attackerEntityIDs:[...new Set(attackers.map(a=>a.entityID))].sort((a,b)=>a-b),
      attribution:"PHYSICAL_STOCK_FLEET_HP_DROP_CORRELATED_NATIVE_ORDER_NOT_HIT_CREDIT"});
    }
   }
   if(previous.has(key)||previous.size<maxTracked)
    previous.set(key,{entity:victim,layers:current,at:now,
     victimRole:targetRow.role,attackers});
  }
  if(previous.size>=maxTracked)
   for(const [key,row] of previous)if(now-row.at>60000)previous.delete(key);
  return {status:"SAMPLED",systemID:system,physicalStockShips:observedTargets.size,
   damageEvents:events.length,events:events.slice(0,30)};
 }
 // Final native wreck callback runs after EveJS removed the entity
 // and controller, possibly before the next 5s sampler. The original
 // physical ship object still exists in the callback. Compare ONLY that
 // same object's fresh pre-destruction HP to its actual terminal HP.
 // Earlier native attack orders remain correlation, NOT final-shot credit.
 function terminalDamage({systemID,entityID,ship,wreckID,getHealth}={}){
  const system=positive(systemID),id=positive(entityID),wreck=positive(wreckID);
  if(!system||!id||!wreck||ship?.kind!=="ship"||
   ship.nativeNpc!==true||Number(ship.itemID)!==id||
   typeof getHealth!=="function")return {status:"INVALID_STOCK_TERMINAL"};
  const key=system+":"+id,prior=previous.get(key);
  if(!prior||prior.entity!==ship)return {status:"NO_PRIOR_PHYSICAL_STOCK_SAMPLE"};
  const now=clock();
  if(!Number.isFinite(now)||now<=prior.at||now-prior.at>30000)
   return {status:"STALE_STOCK_TERMINAL_HP"};
  const attackers=prior.attackers||[];
  if(!attackers.length)return {status:"NO_PRIOR_VERIFIED_PIRATE_ATTACK_ORDER"};
  let current;
  try{current=healthLayers(getHealth(ship));}catch(_error){}
  if(!current)return {status:"NO_STOCK_TERMINAL_HP"};
  const lost={shield:Math.max(0,prior.layers.shield-current.shield),
   armor:Math.max(0,prior.layers.armor-current.armor),
   structure:Math.max(0,prior.layers.structure-current.structure)};
  const total=lost.shield+lost.armor+lost.structure;
  if(total<minLossHP)return {status:"NO_OBSERVED_STOCK_TERMINAL_LOSS"};
  previous.delete(key);
  return {status:"NATIVE_STOCK_TERMINAL_HP_DROP",event:{
   systemID:system,victimEntityID:id,victimRole:prior.victimRole,
   nativeWreckID:wreck,healthLossHP:Math.round(total*1000)/1000,
   layerLossHP:lost,
   attackerPilotIDs:[...new Set(attackers.map(a=>a.pilotID))].sort(),
   attackerEntityIDs:[...new Set(attackers.map(a=>a.entityID))].sort((a,b)=>a-b),
   attribution:"NATIVE_STOCK_TERMINAL_HP_CORRELATED_PRIOR_ORDER_NOT_KILL_CREDIT"
  }};
 }
 return {sample,terminalDamage};
}
module.exports={createStockFleetCombatEvidence};
