"use strict";
// EX-03B15: run source-native analyzer turns, original ItemStore loot pickup,
// and physically witnessed corporate warehouse return inside the existing
// 30-second A-Life phase. No timer, spawned cargo, new wallet or fictive warp.
const POS=x=>Number.isSafeInteger(x)&&x>0;
const vec=x=>x&&["x","y","z"].every(k=>typeof x[k]==="number"&&Number.isFinite(x[k]));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const receipt=s=>typeof s==="string"&&
 /^coop-npc-expedition:v1:container:[1-9]\d*:ship:[1-9]\d*:corp:[1-9]\d*$/.test(s);
function createNpcExpeditionOperations({nativeStore,getController,itemStore,gameStore,
 getStation,getStationsForSystem,isNpcCorporation,siteService,hackingService,typeHasEffectName,
 resolveItemByTypeID,orderBridge,warpToPoint,clock=()=>Date.now()}={}){
 if(!nativeStore||!itemStore||!gameStore||!siteService||
  !hackingService||typeof hackingService.nativeNpcTurn!=="function"||
  [getController,getStation,getStationsForSystem,isNpcCorporation,typeHasEffectName,
   resolveItemByTypeID,warpToPoint,clock].some(f=>typeof f!=="function")||
  typeof siteService.listMaterializedUniverseSiteContentEntities!=="function"||
  !orderBridge||typeof orderBridge.issue!=="function"||
  typeof orderBridge.blocked!=="function")
  throw Error("EX03_NATIVE_HACKING_AND_ITEM_CUSTODY_AUTHORITIES_REQUIRED");
 const {createNpcExpeditionLoot}=require("./coopNpcExpeditionLoot");
 const stable=new Map(),returnOrders=new Map(),quarantine=new Set();
 const loot=createNpcExpeditionLoot({
  nativeStore,itemStore,gameStore,getController,getStation,
  isNpcCorporation,
  isNativeSiteOwner:(owner,target)=>owner===1&&target?.ownerID===1,
  verifyNativeArrival:({scene,entityID,ship,controller,stationID})=>{
   const station=scene.getEntityByID?.(stationID);
   if(!station||station.kind!=="station"||station.itemID!==stationID||
      !vec(station.position)||ship.mode==="WARP"||
      ship.pendingWarp||ship.warpState||ship.isWarping||
      controller?.entityID!==entityID||
      Math.max(0,dist(ship.position,station.position)-
       Math.max(0,Number(ship.radius)||0)-
       Math.max(0,Number(station.radius)||0))>2500){
    stable.delete(entityID+":"+stationID);return false;
   }
   const key=entityID+":"+stationID,now=clock();
   if(!stable.has(key)){stable.set(key,now);return false}
   return now-stable.get(key)>=2000;
  },clock
 });
 function pilot(scene,links,id){
  const unique=links.filter(x=>x?.entityID===id&&
    x.systemID===scene.systemID&&/^coop-pilot-[0-9]{3,}$/.test(x.pilotID||""));
  if(unique.length!==1)return null;
  if(links.some(x=>x?.pilotID===unique[0].pilotID&&
    (x.entityID!==id||x.systemID!==scene.systemID)))return null;
  try{
   const entity=scene.getEntityByID(id),native=nativeStore.getNativeEntity(id);
   const ctrl=getController(id);
   if(!entity||entity.itemID!==id||entity.kind!=="ship"||
      entity.nativeNpc!==true||entity.session?.characterID||
      !vec(entity.position)||entity.pendingWarp||entity.warpState||
      entity.isWarping||entity.transient===true||
      !native||native.entityID!==id||native.systemID!==scene.systemID||
      native.corporationID!==entity.corporationID||
      native.ownerID!==entity.ownerID||!POS(native.corporationID)||
      !ctrl||ctrl.entityID!==id||ctrl.systemID!==scene.systemID)
    return null;
   return {entity,native,ctrl,link:unique[0]};
  }catch{return null}
 }
 function issue({scene,id,action,execute}){
  try{
   if(orderBridge.blocked({entityID:id,systemID:scene.systemID,owner:"EXPEDITION"}))
    return {success:false,errorMsg:"EX03_NATIVE_ORDER_LEASED"};
   return orderBridge.issue({entityID:id,systemID:scene.systemID,
    owner:"EXPEDITION",action,execute});
  }catch{
   quarantine.add(id);
   return {success:false,errorMsg:"EX03_NATIVE_ORDER_OUTCOME_UNKNOWN"};
  }
 }
 function tick({scene,assignments=[],tips=[],flags={}}={}){
  if(!POS(scene?.systemID)||!Array.isArray(assignments)||!Array.isArray(tips))
   return {status:"BLOCKED",reason:"EX03_OPERATIONS_SOURCE_MISSING"};
  let stations;
  try{stations=getStationsForSystem(scene.systemID)}catch{return {status:"BLOCKED",reason:"EX03_STATION_SOURCE_UNAVAILABLE"}}
  if(!Array.isArray(stations))return {status:"BLOCKED",reason:"EX03_STATION_SOURCE_INVALID"};
  let hacked=0,picked=0,delivered=0,orderedReturn=0,blocked=0;
  // Bounded source-proven scout cohort. No unscanned site knowledge.
  for(const tip of tips.filter(t=>t?.systemID===scene.systemID).slice(0,16)){
   const link=assignments.find(x=>x?.pilotID===tip.scoutPilotID);
   if(!link||quarantine.has(link.entityID)){blocked++;continue}
   const p=pilot(scene,assignments,link.entityID);
   if(!p||p.native.corporationID!==tip.corpID){blocked++;continue}
   let sourceSite;
   try{sourceSite=scene.getEntityByID(tip.siteID)}catch{blocked++;continue}
   if(!sourceSite||sourceSite.itemID!==tip.siteID||
      !vec(sourceSite.position)||dist(sourceSite.position,p.entity.position)>150000)
    continue;
   let contents;
   try{contents=siteService.listMaterializedUniverseSiteContentEntities(scene,{siteID:tip.siteID})}
   catch{blocked++;continue}
   if(!Array.isArray(contents))continue;
   const containers=contents.filter(x=>x?.dungeonMaterializedContainer===true&&
    x.dungeonMaterializedSiteContent===true&&POS(x.itemID)&&
    scene.getEntityByID(x.itemID)===x).slice(0,8);
   for(const target of containers){
    if(!vec(target.position)||dist(target.position,p.entity.position)>10000)continue;
    if(target.dungeonSiteContentHackingState!==2 && flags.hack===true){
     let modules;
     try{modules=nativeStore.listNativeModulesForEntity(link.entityID)}
     catch{blocked++;continue}
     const m=Array.isArray(modules)?modules.find(m=>{
      if(m?.entityID!==link.entityID||m.ownerID!==p.native.ownerID||
       m.categoryID!==7||m.moduleState?.online!==true)return false;
      try{
       const kind=String(target.dungeonSiteContentAnalyzer||"").toLowerCase();
       const type=resolveItemByTypeID(m.typeID);
       const name=String(m.itemName||type?.name||"").toLowerCase();
       return typeHasEffectName(m.typeID,"doHacking")===true&&
        (name.includes(kind+" analyzer")||name.includes("integrated analyzer"));
      }catch{return false}
     }):null;
     if(m){
      const result=issue({scene,id:link.entityID,action:"expedition-hack",
       execute:()=>{
        const data=hackingService.nativeNpcTurn({scene,entityID:link.entityID,
         targetID:target.itemID,moduleID:m.moduleID});
        return data?.status==="BLOCKED"?{success:false,errorMsg:data.reason||"EX03_HACK_REJECTED"}:
         {success:true,data};
       }});
      if(result?.success===true&&
         result.data?.status==="NATIVE_NPC_HACK_SUCCESS")hacked++;
      else if(result?.success!==true)blocked++;
     }
    }
    if(target.dungeonSiteContentHackingState===2 && flags.loot===true){
     let items;
     try{items=itemStore.listContainerItems(null,target.itemID)}
     catch{blocked++;continue}
     if(Array.isArray(items)){
      for(const item of items.slice(0,1)){
       const result=loot.collect({scene,entityID:link.entityID,assignments,
        containerID:target.itemID,itemID:item.itemID});
       if(result.status==="NATIVE_ORIGINAL_LOOT_IN_SHIP")picked++;
       else blocked++;
      }
     }
    }
   }
  }
  if(flags.loot===true){
   // The same original itemID remains in native ItemStore while travelling.
   const ownedIDs=new Set(assignments.filter(a=>a?.systemID===scene.systemID)
    .map(a=>a.entityID));
   for(const id of [...ownedIDs].slice(0,32)){
    const p=pilot(scene,assignments,id);if(!p||quarantine.has(id))continue;
    let cargo;
    try{cargo=itemStore.listContainerItems(p.native.corporationID,id,
      itemStore.ITEM_FLAGS.CARGO_HOLD)}
    catch{blocked++;continue}
    if(!Array.isArray(cargo))continue;
    const originals=cargo.filter(x=>receipt(x?.customInfo)).slice(0,4);
    if(!originals.length)continue;
    const station=stations.find(s=>POS(s?.stationID)&&
      (s.corporationID===p.native.corporationID||s.ownerID===p.native.corporationID)&&
      getStation(s.stationID)?.stationID===s.stationID);
    if(!station){blocked++;continue}
    let entity;
    try{entity=scene.getEntityByID(station.stationID)}catch{blocked++;continue}
    if(!entity||entity.kind!=="station"||!vec(entity.position)){blocked++;continue}
    const gap=Math.max(0,dist(p.entity.position,entity.position)-
     Math.max(0,Number(p.entity.radius)||0)-Math.max(0,Number(entity.radius)||0));
    if(gap<=2500){
     for(const item of originals){
      const result=loot.deliver({scene,entityID:id,assignments,
       stationID:station.stationID,itemID:item.itemID});
      if(result.status==="NATIVE_ORIGINAL_LOOT_IN_CORPORATE_WAREHOUSE")delivered++;
     }
    }else if(!returnOrders.has(id+":"+station.stationID)){
     const result=issue({scene,id,action:"expedition-loot-return",
      execute:()=>warpToPoint(id,{...entity.position},
       {reason:"coop-npc-expedition-loot-return",scheduleWake:true})});
     if(result?.success===true){
      returnOrders.set(id+":"+station.stationID,clock());orderedReturn++;
     }else blocked++;
    }
   }
  }
  return {status:"EX03_NATIVE_OPERATIONS_TICK",hacked,picked,delivered,
   orderedReturn,blocked,nativeLootMinted:false};
 }
 return Object.freeze({tick,inspectLoot:itemID=>loot.inspectReceipt(itemID)});
}
module.exports={createNpcExpeditionOperations};
