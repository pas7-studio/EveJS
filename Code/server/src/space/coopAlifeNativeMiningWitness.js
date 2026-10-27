"use strict";
// ALIFE-04: factual physical mining proof for the original EveJS stock mining
// fleet. This observer never invokes a controller order, creates ore, moves
// cargo, chooses an asteroid, or grants any items/ISK.
const id=v=>Number.isSafeInteger(v)&&v>0;
const isInt=v=>Number.isSafeInteger(v)&&v>=0;
function createNativeMiningWitness({maxMiners=12,maxGapMs=300000}={}){
 if(!Number.isSafeInteger(maxMiners)||maxMiners<1||maxMiners>64||
  !Number.isSafeInteger(maxGapMs)||maxGapMs<30000||maxGapMs>900000)
  throw Error("NATIVE_MINING_WITNESS_CONFIG_INVALID");
 const baseline=new Map();
 function tick({scene,fleets,getNativeEntity,listNativeCargo,
  isMineableStaticEntity,getMineableState,now=Date.now()}={}){
  const out=(status,results=[])=>({status,results,confirmed:results.filter(
   x=>x.status==="NATIVE_ORE_GROWTH_CONFIRMED").length});
  if(!id(scene?.systemID)||typeof scene.getEntityByID!=="function"||
   typeof scene.getTargetsForEntity!=="function"||
   !Array.isArray(fleets)||fleets.length>64||
   [getNativeEntity,listNativeCargo,isMineableStaticEntity,getMineableState]
    .some(f=>typeof f!=="function")||
   !isInt(now)||now===0)return out("NATIVE_MINING_WITNESS_CONTEXT_INVALID");
  const sourceFleets=fleets.filter(f=>f?.source==="startup"||f?.source==="gm");
  if(!sourceFleets.length)return out("NO_NATIVE_MINING_FLEET");
  const requested=sourceFleets.reduce((n,f)=>n+
   (Array.isArray(f.minerEntityIDs)?f.minerEntityIDs.length:100),0);
  if(requested>maxMiners)return out("NATIVE_MINING_PROOF_BUDGET_EXCEEDED");
  const results=[],tracked=new Set();
  for(const f of sourceFleets){
   if(!id(f.fleetID)||f.systemID!==scene.systemID||
    !Array.isArray(f.minerEntityIDs)||f.minerEntityIDs.some(x=>!id(x))||
    new Set(f.minerEntityIDs).size!==f.minerEntityIDs.length){
    results.push({status:"NATIVE_MINING_FLEET_IDENTITY_INVALID",
     fleetID:id(f.fleetID)?f.fleetID:null});continue;
   }
   for(const entityID of f.minerEntityIDs){
    const key=scene.systemID+":"+f.fleetID+":"+entityID;
    tracked.add(key);
    const fail=(reason)=>{baseline.delete(key);
     results.push({systemID:scene.systemID,fleetID:f.fleetID,
      entityID,status:reason,proof:"NONE"});};
    if(f.state!=="mining"){fail("NATIVE_MINING_FLEET_NOT_MINING");continue}
    let ship,native,cargo,targets;
    try{
     ship=scene.getEntityByID(entityID);
     native=getNativeEntity(entityID);
     cargo=listNativeCargo(entityID);
     targets=scene.getTargetsForEntity(ship);
    }catch{fail("NATIVE_MINING_SNAPSHOT_UNAVAILABLE");continue}
    if(ship?.kind!=="ship"||ship.nativeNpc!==true||
     ship.session?.characterID||Number(ship.itemID)!==entityID||
     !native||native.entityID!==entityID||
     native.systemID!==scene.systemID||!id(native.ownerID)||
     native.transient===true||ship.transient===true||
     [...scene.sessions?.values?.()||[]].some(s=>Number(s?._space?.shipID)===entityID)){
     fail("NATIVE_MINING_DURABLE_HULL_NOT_VERIFIED");continue;
    }
    if(!Array.isArray(cargo)||!Array.isArray(targets)){
     fail("NATIVE_MINING_CARGO_OR_LOCKS_UNAVAILABLE");continue;
    }
    const ore=cargo.filter(c=>Number(c?.categoryID)===25);
    const quantities=new Map();
    let invalid=false;
    for(const c of ore){
     if(!id(c?.cargoID)||!id(c?.typeID)||c.entityID!==entityID||
      c.ownerID!==native.ownerID||c.transient===true||
      Number(c.moduleID||0)!==0||!isInt(c.quantity)||
      quantities.has(c.cargoID)){invalid=true;break}
     quantities.set(c.cargoID,c.quantity);
    }
    if(invalid){fail("NATIVE_MINING_ORE_CUSTODY_INVALID");continue}
    const effects=ship.activeModuleEffects;
    if(!(effects instanceof Map)){
     fail("NATIVE_MINING_EFFECTS_UNAVAILABLE");continue;
    }
    // An NPC combat controller target of zero is NOT an extraction blocker.
    // Native EveJS mining targets are scene locks + module effect targetIDs.
    const active=[...effects.entries()].filter(([moduleID,fx])=>
     id(moduleID)&&id(Number(fx?.targetID)));
    const mineable=[];
    for(const [moduleID,fx] of active){
     const targetID=Number(fx.targetID);
     const rock=scene.getEntityByID(targetID);
     let state=null,eligible=false;
     try{
      eligible=rock?.itemID===targetID&&isMineableStaticEntity(rock)===true;
      if(eligible)state=getMineableState(scene,targetID);
     }catch{eligible=false}
     if(eligible&&state&&isInt(state.remainingQuantity))
      mineable.push({moduleID,targetID});
    }
    if(!mineable.length){fail("NATIVE_MINING_ACTIVE_ROCK_EFFECT_MISSING");continue}
    if(new Set(mineable.map(x=>x.targetID)).size!==1){
     fail("NATIVE_MINING_ACTIVE_ROCK_TARGET_AMBIGUOUS");continue;
    }
    const targetID=mineable[0].targetID;
    if(!targets.includes(targetID)){
     fail("NATIVE_MINING_ROCK_NOT_TARGET_LOCKED");continue;
    }
    const assigned=f.assignedAsteroidIDsByMinerID?.[entityID];
    if(assigned!=null&&Number(assigned)!==targetID){
     fail("NATIVE_MINING_FLEET_TARGET_CONFLICT");continue;
    }
    const previous=baseline.get(key);
    let status="NATIVE_MINING_ACTIVE_NO_YIELD_DELTA",delta=0,cargoIDs=[];
    if(previous&&now>previous.at&&now-previous.at<=maxGapMs&&
     previous.ownerID===native.ownerID&&previous.targetID===targetID){
     for(const [cargoID,quantity] of quantities){
      const growth=quantity-(previous.cargo.get(cargoID)||0);
      if(growth>0){delta+=growth;cargoIDs.push(cargoID)}
     }
     if(delta>0&&Number.isSafeInteger(delta))
      status="NATIVE_ORE_GROWTH_CONFIRMED";
     else if([...previous.cargo].some(([id,qty])=>
      (quantities.get(id)||0)<qty))status="NATIVE_ORE_CARGO_MOVED_OR_DECREASED";
    }
    baseline.set(key,{at:now,ownerID:native.ownerID,targetID,cargo:quantities});
    results.push({systemID:scene.systemID,fleetID:f.fleetID,entityID,
     nativeOwnerID:native.ownerID,targetID,moduleIDs:mineable.map(x=>x.moduleID),
     cargoIDs,quantityDelta:status==="NATIVE_ORE_GROWTH_CONFIRMED"?delta:0,
     status,proof:status==="NATIVE_ORE_GROWTH_CONFIRMED"?
      "TWO_SAMPLES_NATIVE_LOCK_EFFECT_CARGOID_DELTA":"NO_YIELD_PROOF"});
   }
  }
  for(const [key,previous] of baseline)
   if(!tracked.has(key)||now-previous.at>maxGapMs)baseline.delete(key);
  return out("OBSERVED",results);
 }
 return {tick};
}
module.exports={createNativeMiningWitness};
