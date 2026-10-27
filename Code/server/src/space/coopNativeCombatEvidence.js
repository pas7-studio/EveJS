"use strict";
// Native-only evidence: observed HP loss, controller target and persisted wreck.
// Never applies damage, assigns kill credit, spawns wrecks or creates loot.
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
const layers=x=>{
 if(!x||typeof x!=="object")return null;
 const result={};
 for(const key of ["shield","armor","structure"]){
  if(typeof x[key]!=="number"||!Number.isFinite(x[key])||x[key]<0)return null;
  result[key]=x[key];
 }
 return result;
};
function createCombatEvidence({clock=()=>Date.now(),minLossHP=0.01,maxTracked=500}={}){
 if(typeof clock!=="function"||!Number.isFinite(minLossHP)||minLossHP<=0||
  !Number.isSafeInteger(maxTracked)||maxTracked<1)throw Error("invalid combat evidence options");
 const previous=new Map();
 function sample({systemID,scene,links=[],getHealth,getController}={}){
  const system=positive(systemID);
  if(!system||typeof scene?.getEntityByID!=="function"||!Array.isArray(links)||
   typeof getHealth!=="function"||typeof getController!=="function")
   return {status:"NO_NATIVE_SCENE",events:[]};
  const now=clock();
  if(!Number.isFinite(now))return {status:"CLOCK_INVALID",events:[]};
  const players=new Set(Array.from(scene.sessions?.values?.()||[])
   .map(s=>positive(s?._space?.shipID)).filter(Boolean));
  const live=new Map();
  for(const link of links){
   const id=positive(link?.entityID);
   if(!id||players.has(id)||!named(link.pilotID)||Number(link.systemID)!==system||live.has(id))continue;
   const ship=scene.getEntityByID(id);
   if(ship?.kind!=="ship")continue;
   live.set(id,{pilotID:link.pilotID,ship});
  }
  // Real EveJS controller selections may corroborate HP changes, but cannot
  // identify the killer or prove that any particular weapon fired.
  const attackers=new Map();
  for(const [id,{pilotID}] of live){
   try{
    const target=positive(getController(id)?.currentTargetID);
    if(!target||target===id||!live.has(target))continue;
    if(!attackers.has(target))attackers.set(target,[]);
    attackers.get(target).push({pilotID,entityID:id});
   }catch(_error){}
  }
  const events=[];
  for(const [id,{pilotID,ship}] of live){
   let health=null;
   try{health=layers(getHealth(ship));}catch(_error){}
   if(!health)continue;
   const key=system+":"+id;
   const old=previous.get(key);
   if(old&&old.pilotID===pilotID&&now>old.at){
    const lost={shield:Math.max(0,old.health.shield-health.shield),
     armor:Math.max(0,old.health.armor-health.armor),
     structure:Math.max(0,old.health.structure-health.structure)};
    const total=lost.shield+lost.armor+lost.structure;
    if(total>=minLossHP){
     events.push({systemID:system,victimEntityID:id,victimPilotID:pilotID,
      observedAt:now,healthLossHP:Math.round(total*1000)/1000,
      layerLossHP:lost,
      attackerPilotIDs:[...new Set((attackers.get(id)||[]).map(a=>a.pilotID))].sort(),
      attackerEntityIDs:[...new Set((attackers.get(id)||[]).map(a=>a.entityID))].sort((a,b)=>a-b),
      attribution:"CORRELATED_TARGET_ONLY_NOT_KILL_CREDIT"});
    }
   }
   // Bounded by number of live entities and previous samples; a ship whose
   // native entity ID is reused cannot inherit an unrelated pilot's HP.
   if(old||previous.size<maxTracked)
    previous.set(key,{pilotID,at:now,health,attackers:attackers.get(id)||[]});
  }
  if(previous.size>=maxTracked){
   for(const [key,row] of previous)if(row.at<now-3600000)previous.delete(key);
  }
  return {status:"SAMPLED",systemID:system,observedNamedNpcs:live.size,
   damageEvents:events.length,correlatedNpcDamage:events.filter(e=>e.attackerPilotIDs.length).length,
   events:events.slice(0,30)};
 }
 // The EveJS native wreck callback still owns the original shipEntity
 // object, even after it leaves the authoritative scene. The last HP
 // transition can be missed by the periodic sampler during a fast kill.
 // Only a fresh, previous physical scene sample may establish this delta.
 function terminalDamage({systemID,entityID,pilotID,ship,wreckID,getHealth}={}){
  const system=positive(systemID),id=positive(entityID),wreck=positive(wreckID);
  if(!system||!id||!wreck||!named(pilotID)||ship?.nativeNpc!==true||
   ship?.kind!=="ship"||Number(ship.itemID)!==id||typeof getHealth!=="function")
   return {status:"INVALID_NATIVE_TERMINAL"};
  const key=system+":"+id,old=previous.get(key);
  if(!old||old.pilotID!==pilotID)return {status:"NO_PREVIOUS_NATIVE_HP"};
  const now=clock();
  if(!Number.isFinite(now)||now<=old.at||now-old.at>30000)
   return {status:"STALE_TERMINAL_HP"};
  let final=null;
  try{final=layers(getHealth(ship));}catch(_error){}
  if(!final)return {status:"NO_TERMINAL_HP"};
  const lost={shield:Math.max(0,old.health.shield-final.shield),
   armor:Math.max(0,old.health.armor-final.armor),
   structure:Math.max(0,old.health.structure-final.structure)};
  const total=lost.shield+lost.armor+lost.structure;
  // The native death hook proves destruction, but never invents lost HP.
  if(total<minLossHP)return {status:"NO_OBSERVED_TERMINAL_LOSS"};
  previous.delete(key);
  const attackers=old.attackers||[];
  return {status:"NATIVE_TERMINAL_HP_DROP",event:{
   systemID:system,victimEntityID:id,victimPilotID:pilotID,
   observedAt:now,nativeWreckID:wreck,
   healthLossHP:Math.round(total*1000)/1000,layerLossHP:lost,
   attackerPilotIDs:[...new Set(attackers.map(a=>a.pilotID))].sort(),
   attackerEntityIDs:[...new Set(attackers.map(a=>a.entityID))].sort((a,b)=>a-b),
   attribution:"NATIVE_TERMINAL_HP_DELTA_TARGET_CORRELATION_NOT_KILL_CREDIT"
  }};
 }
 return {sample,terminalDamage};
}
function verifyWreck({systemID,npcID,wreckID,scene,links=[],getWreck,getWreckItems}={}){
 const system=positive(systemID),victim=positive(npcID),id=positive(wreckID);
 if(!system||!victim||!id||typeof scene?.getEntityByID!=="function"||
  !Array.isArray(links)||typeof getWreck!=="function"||typeof getWreckItems!=="function")
  return {status:"INVALID"};
 const link=links.find(row=>named(row?.pilotID)&&Number(row.systemID)===system&&
  Number(row.entityID)===victim);
 if(!link)return {status:"UNLINKED_NPC"};
 let row,items;
 try{row=getWreck(id);items=getWreckItems(id);}catch(_error){return {status:"NATIVE_STORE_UNAVAILABLE"};}
 if(!row||Number(row.wreckID)!==id||Number(row.systemID)!==system||
  Number(row.sourceEntityID)!==victim||Number(row.launcherID)!==victim||!Array.isArray(items))
  return {status:"NATIVE_WRECK_UNVERIFIED"};
 const native=scene.getEntityByID(id);
 if(native?.nativeNpcWreck!==true||Number(native.itemID)!==id||
  Number(native.launcherID)!==victim)
  return {status:"WRECK_NOT_PHYSICAL"};
 const valid=items.every(item=>positive(item?.wreckItemID)&&Number(item.wreckID)===id&&
  positive(item?.typeID)&&Number.isFinite(Number(item.quantity))&&Number(item.quantity)>0);
 if(!valid)return {status:"INVALID_STORED_ITEMS"};
 return {status:"PHYSICAL_NATIVE_WRECK_VERIFIED",systemID:system,
  victimEntityID:victim,victimPilotID:link.pilotID,wreckID:id,
  storedItemCount:items.length,storedQuantity:items.reduce((n,item)=>n+Number(item.quantity),0),
  lootStatus:items.length?"ITEMS_STORED":"NATIVE_WRECK_EMPTY"};
}
module.exports={createCombatEvidence,verifyWreck};
