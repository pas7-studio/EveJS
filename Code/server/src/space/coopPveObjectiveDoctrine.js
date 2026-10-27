"use strict";
// PVE-003B. Physical objective defense policy ONLY; native dungeon service
// keeps structure HP, original waves, kill/progression, wrecks and reward truth.
const suffix=__filename.endsWith(".cjs")?".cjs":"";
const {siteEntries}=require("./coopPveNativeSiteDefense"+suffix);
const id=x=>Number.isSafeInteger(x)&&x>0?x:null;
const pos=p=>p&&["x","y","z"].every(k=>Number.isFinite(p[k]));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const warping=e=>Boolean(e?.pendingWarp||e?.warpState||e?.isWarping)||
 String(e?.mode||"").toUpperCase().includes("WARP");
const busy=c=>Boolean(c?.currentTargetID)||
 Boolean(c?.manualOrder?.type)&&
 String(c.manualOrder.type).toLowerCase()!=="resumebehavior";
const safeRatios=r=>r&&Number.isFinite(r.armor)&&Number.isFinite(r.structure)&&
 r.armor>=0&&r.armor<=1&&r.structure>=0&&r.structure<=1;
function createObjectiveDoctrine({
 clock=()=>Date.now(),getNativeEntity,getController,resolveVerifiedPlayer,
 getHealth,getStructureHP,isScrambled,attack,warpToPoint,orbit,notify=()=>{},
 maxOrdersPerTick=3,maxReceipts=1024
}={}){
 if([clock,getNativeEntity,getController,resolveVerifiedPlayer,getHealth,getStructureHP,
  isScrambled,attack,warpToPoint,orbit,notify].some(x=>typeof x!=="function")||
  !Number.isSafeInteger(maxOrdersPerTick)||maxOrdersPerTick<1||maxOrdersPerTick>4||
  !Number.isSafeInteger(maxReceipts)||maxReceipts<1||maxReceipts>4096)
  throw Error("INVALID_PVE_OBJECTIVE_DOCTRINE");
 const orders=new Map();
 function tick({systemID,scene,instances=[],excludedIDs=[],waypoints=[]}={}){
  const result={status:"NO_SOURCE_OBJECTIVES",sites:0,objectives:0,orders:0,events:[]};
  const now=clock();
  if(!id(systemID)||!Number.isSafeInteger(now)||now<=0||
    scene?.systemID!==systemID||typeof scene.getEntityByID!=="function"||
    !(scene.staticEntitiesByID instanceof Map)||!(scene.sessions instanceof Map)||
    !Array.isArray(excludedIDs)||excludedIDs.length>1024||
    !Array.isArray(waypoints)||waypoints.length>512)
   return {...result,status:"INVALID_NATIVE_CONTEXT"};
  if(orders.size>=maxReceipts)return {...result,status:"ORDER_FENCE_CAP_REACHED"};
  const original=siteEntries(systemID,scene,instances);
  if(original.status!=="OK")return {...result,status:original.status};
  const excluded=new Set(excludedIDs);
  const activePlayers=[...scene.sessions.values()].filter(s=>s?.socket&&
    s.socket.destroyed!==true&&s?._space?.initialStateSent===true&&
    s._space.systemID===systemID&&id(s.characterID));
  const verifiedPlayer=entityID=>{
   const ship=id(entityID)&&scene.getEntityByID(entityID);
   if(!ship||ship.kind!=="ship"||ship.itemID!==entityID||
      ship.nativeNpc===true||!pos(ship.position))return null;
   const holders=activePlayers.filter(s=>s?._space?.shipID===entityID);
   if(holders.length!==1||
      activePlayers.filter(s=>s.characterID===holders[0].characterID).length!==1)
    return null;
   try{if(resolveVerifiedPlayer(scene,ship)!==holders[0].characterID)return null}
   catch{return null}
   return ship;
  };
  const npc=(site,entityID)=>{
   if(!id(entityID)||excluded.has(entityID))return null;
   const owner=original.owners.get(entityID);
   if(owner?.length!==1||owner[0].site!==site)return null;
   const ship=scene.getEntityByID(entityID),native=getNativeEntity(entityID),
    controller=getController(entityID);
   if(!ship||ship.itemID!==entityID||ship.kind!=="ship"||
      ship.nativeNpc!==true||ship.session?.characterID||
      (id(ship.systemID)&&ship.systemID!==systemID)||!pos(ship.position)||
      !native||native.entityID!==entityID||native.systemID!==systemID||
      native.nativeNpc!==true||native.transient!==true||
      native.typeID!==ship.typeID||!id(native.typeID)||
      !id(native.corporationID)||native.corporationID!==ship.corporationID||
      !Number.isSafeInteger(native.createdAtMs)||native.createdAtMs<=0||
      native.createdAtMs>owner[0].spawnedAtMs+2000||
      owner[0].spawnedAtMs-native.createdAtMs>120000||
      !controller||controller.entityID!==entityID||controller.systemID!==systemID||
      controller.runtimeKind!=="nativeCombat")return null;
   return {ship,controller,owner:owner[0]};
  };
  // The actual native dungeon site creator marks killable structures with
  // these exact properties and retains structure IDs in original spawned
  // encounter entries. Objective marker/container is NOT a combat target.
  const objectives=new Map();
  for(const site of original.sites){
   const instance=instances.find(x=>x?.instanceID===site.instanceID);
   if(!instance)continue;
   const states=instance.spawnState?.encounterStatesByKey||{};
   for(const [key,wave] of Object.entries(states)){
    if(!wave||!id(wave.spawnedAtMs)||!Array.isArray(wave.spawnedEntityIDs)||
       wave.spawnedEntityIDs.length>96||!key)continue;
    for(const entityID of wave.spawnedEntityIDs){
     if(!id(entityID)||original.owners.get(entityID)?.length!==1||
        !scene.staticEntitiesByID.has(entityID))continue;
     const obj=scene.staticEntitiesByID.get(entityID);
     if(!obj||obj.itemID!==entityID||obj.kind!=="siteKillableStructure"||
        obj.runtimeKind!=="missionCombatStructure"||
        obj.dungeonMaterializedSiteContent!==true||
        obj.dungeonMaterializedKillableStructure!==true||
        obj.dungeonSiteInstanceID!==site.instanceID||
        obj.dungeonSiteID!==site.siteID||obj.dungeonEncounterKey!==key||
        scene.getEntityByID(entityID)!==obj||
        !pos(obj.position)||!id(obj.typeID)||!id(obj.structureHP)||
        obj.conditionState?.incapacitated===true)continue;
     let hp=null;
     try{hp=getStructureHP(obj)}catch{hp=null}
     if(!Number.isFinite(hp)||hp<=0)continue;
     const owner=original.owners.get(entityID)[0];
     if(owner.site!==site||owner.encounterKey!==key)continue;
     const item=objectives.get(site.instanceID)||[];
     item.push(obj);objectives.set(site.instanceID,item);
    }
   }
  }
  for(const site of original.sites){
   const structures=objectives.get(site.instanceID)||[];
   if(!structures.length)continue;
   result.sites++;result.objectives+=structures.length;
   const members=site.defenderIDs.map(entityID=>npc(site,entityID)).filter(Boolean);
   if(!members.length)continue;
   // Native defender received a real player aggression notification while
   // already guarding an original killable structure. This does NOT claim
   // the structure itself was hit.
   for(const member of members){
    if(result.orders>=maxOrdersPerTick)break;
    const entityID=member.ship.itemID,controller=member.controller;
    const attackerID=id(controller.lastAggressorID),at=controller.lastAggressedAtMs;
    const attacker=attackerID&&verifiedPlayer(attackerID);
    const structure=structures.find(o=>dist(o.position,member.ship.position)<=150000&&
      (!attacker||dist(attacker.position,o.position)<=250000));
    if(!structure)continue;
    const key=site.instanceID+":"+entityID;
    if(orders.has(key))continue; // all uncertain/accepted ACKs fenced
    const recent=attacker&&Number.isSafeInteger(at)&&at>0&&at<=now&&now-at<=120000;
    if(!recent){
     // HOLD = no order when there is no authentic player near the site.
     // REGROUP = actual native orbit around the source-authenticated
     // destructible objective, not a generated or decorative marker.
     if(busy(controller)||warping(member.ship)||
        dist(member.ship.position,structure.position)<20000||
        dist(member.ship.position,structure.position)>120000)continue;
     const arrivals=activePlayers.map(s=>verifiedPlayer(s._space.shipID))
      .filter(p=>p&&dist(p.position,structure.position)<=200000);
     if(!arrivals.length)continue;
     const receipt={phase:"REGROUP_ISSUING",systemID,instanceID:site.instanceID,
      siteID:site.siteID,entityID,objectiveID:structure.itemID,at:now};
     orders.set(key,receipt);
     let ack;
     try{ack=orbit(entityID,structure.itemID,15000,{wakeController:true})}
     catch{ack=null}
     receipt.phase=ack?.success===true?"REGROUP_ORBIT_ACCEPTED":
      ack?.success===false?"REGROUP_REJECTED":"OUTCOME_UNKNOWN";
     if(receipt.phase==="REGROUP_ORBIT_ACCEPTED"){
      result.orders++;
      result.events.push({status:"NATIVE_OBJECTIVE_REGROUP_ORBIT_ACK",...receipt});
     }else if(receipt.phase==="OUTCOME_UNKNOWN"){
      result.events.push({status:"NATIVE_OBJECTIVE_REGROUP_UNKNOWN",...receipt});
     }
     continue;
    }
    let health;
    try{health=getHealth(member.ship)}catch{health=null}
    if(!safeRatios(health))continue;
    if(health.structure<0.72||health.armor<0.28){
     let scrambled=true;try{scrambled=isScrambled(member.ship)!==false}catch{}
     if(scrambled||warping(member.ship))continue;
     const exits=waypoints.filter(w=>["station","stargate"].includes(w?.kind)&&
       id(w?.id)&&pos(w?.position)&&dist(w.position,attacker.position)>500000&&
       dist(w.position,member.ship.position)>150000)
       .sort((a,b)=>dist(b.position,attacker.position)-dist(a.position,attacker.position));
     if(!exits.length)continue;
     const home=exits[0];
     const receipt={phase:"RETREAT_ISSUING",systemID,instanceID:site.instanceID,
      siteID:site.siteID,entityID,objectiveID:structure.itemID,attackerID,at:now,
      anchorID:home.id};
     orders.set(key,receipt);
     let ack;
     try{ack=warpToPoint(entityID,home.position,
       {forceImmediateStart:true,broadcastWarpStartToVisibleSessions:true})}
     catch{ack=null}
     receipt.phase=ack?.success===true?"RETREAT_WARP_ACCEPTED":
      ack?.success===false?"RETREAT_REJECTED":"OUTCOME_UNKNOWN";
     if(receipt.phase==="RETREAT_WARP_ACCEPTED"){
      result.orders++;
      result.events.push({status:"NATIVE_OBJECTIVE_RETREAT_WARP_ACK",...receipt});
     }else if(receipt.phase==="OUTCOME_UNKNOWN"){
      result.events.push({status:"NATIVE_OBJECTIVE_RETREAT_UNKNOWN",...receipt});
     }
     continue;
    }
    // DEFEND: an existing ID-verified NPC can attack the verified
    // aggressor while next to the *actual* source-owned objective.
    if(busy(controller)||warping(member.ship)||
       dist(member.ship.position,attacker.position)>250000)continue;
    const receipt={phase:"DEFEND_ISSUING",systemID,instanceID:site.instanceID,
     siteID:site.siteID,entityID,objectiveID:structure.itemID,attackerID,at:now};
    orders.set(key,receipt);
    let ack;
    try{ack=attack(entityID,attackerID,{allowWeapons:true,keepLock:true})}
    catch{ack=null}
    receipt.phase=ack?.success===true?"DEFEND_ATTACK_ACCEPTED":
     ack?.success===false?"DEFEND_REJECTED":"OUTCOME_UNKNOWN";
    if(receipt.phase==="DEFEND_ATTACK_ACCEPTED"){
     result.orders++;
     result.events.push({status:"NATIVE_OBJECTIVE_DEFEND_ATTACK_ACK",...receipt});
    }else if(receipt.phase==="OUTCOME_UNKNOWN"){
     result.events.push({status:"NATIVE_OBJECTIVE_DEFEND_UNKNOWN",...receipt});
    }
   }
  }
  result.status=result.orders?"NATIVE_OBJECTIVE_ORDERS_ACCEPTED":
   result.events.length?"OUTCOME_UNKNOWN":result.objectives?"OBSERVED_NATIVE_OBJECTIVES":"NO_SOURCE_OBJECTIVES";
  for(const e of result.events)try{notify(e)}catch{}
  return result;
 }
 return {tick,activeIDs:()=>new Set([...orders.values()].map(x=>x.entityID)),
  snapshot:()=>[...orders].map(([key,value])=>({key,...value}))};
}
module.exports={createObjectiveDoctrine};
