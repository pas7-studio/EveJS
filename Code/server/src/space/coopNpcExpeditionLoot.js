"use strict";
// EX-03B15: ORIGINAL dungeon ItemStore loot -> original NPC ship itemID
// -> native corporate station hangar. Never create, clone or split itemIDs.
// The source item itself carries a durable provenance marker BEFORE transfer.
const POS=x=>Number.isSafeInteger(x)&&x>0;
const vec=p=>p&&["x","y","z"].every(k=>typeof p[k]==="number"&&Number.isFinite(p[k]));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const marker=(containerID,shipID,corpID)=>
 "coop-npc-expedition:v1:container:"+containerID+":ship:"+shipID+":corp:"+corpID;
const parseMarker=s=>{
 const m=/^coop-npc-expedition:v1:container:([1-9]\d*):ship:([1-9]\d*):corp:([1-9]\d*)(?::wreck:([1-9]\d*))?$/.exec(s);
 if(!m)return null;const n=m.slice(1).map(v=>v===undefined?null:Number(v));
 return n.every(v=>v===null||POS(v))?
  {containerID:n[0],shipID:n[1],corpID:n[2],wreckID:n[3]}:null;
};
function createNpcExpeditionLoot({nativeStore,itemStore,gameStore,getController,
 getStation,isNpcCorporation,isNativeSiteOwner,verifyNativeArrival,
 clock=()=>Date.now(),maxRangeMeters=2500}={}){
 if(!nativeStore||!itemStore||!gameStore||
  ["getNativeEntity"].some(k=>typeof nativeStore[k]!=="function")||
  ["findItemById","listContainerItems","transferItemToOwnerLocation",
   "moveItemToLocation","updateInventoryItem"].some(k=>typeof itemStore[k]!=="function")||
  typeof gameStore.flushTableSync!=="function"||
  [getController,getStation,isNpcCorporation,isNativeSiteOwner,verifyNativeArrival,clock]
   .some(f=>typeof f!=="function")||
  !Number.isSafeInteger(maxRangeMeters)||maxRangeMeters<500||maxRangeMeters>10000)
  throw Error("EX03_ORIGINAL_ITEMSTORE_AND_NATIVE_SHIP_REQUIRED");
 const quarantined=new Set(),busy=new Set();
 const deny=reason=>({status:"BLOCKED",reason,nativeItemMinted:false});
 function authority({scene,entityID,assignments}){
  if(!POS(entityID)||!POS(scene?.systemID)||typeof scene.getEntityByID!=="function"||
   !Array.isArray(assignments)||assignments.length>2048)return null;
  const links=assignments.filter(a=>a?.entityID===entityID&&
   a.systemID===scene.systemID&&
   typeof a.pilotID==="string"&&/^coop-pilot-[0-9]{3,}$/.test(a.pilotID));
  if(links.length!==1||assignments.some(a=>a?.pilotID===links[0].pilotID&&
   (a.entityID!==entityID||a.systemID!==scene.systemID)))return null;
  let ship,native,controller;
  try{
   ship=scene.getEntityByID(entityID);
   native=nativeStore.getNativeEntity(entityID);
   controller=getController(entityID);
  }catch{return null}
  if(!ship||ship.itemID!==entityID||ship.kind!=="ship"||ship.nativeNpc!==true||
   ship.session?.characterID||ship.pilotCharacterID>0||
   ship.isWarping||ship.pendingWarp||ship.warpState||
   String(ship.mode||"").toUpperCase().includes("WARP")||
   !vec(ship.position)||ship.transient===true||
   !native||native.entityID!==entityID||native.systemID!==scene.systemID||
   !POS(native.ownerID)||!POS(native.corporationID)||
   native.transient===true||native.corporationID!==ship.corporationID||
   native.ownerID!==ship.ownerID||
   !controller||controller.entityID!==entityID||
   controller.systemID!==scene.systemID||
   isNpcCorporation(native.corporationID)!==true)return null;
  return {ship,native,controller};
 }
 function inspect(itemID){
  try{return itemStore.findItemById(itemID)}catch{return null}
 }
 function originalUnit(item){
  return Boolean(item&&POS(item.itemID)&&POS(item.typeID)&&POS(item.ownerID)&&
   POS(item.locationID)&&
   (item.singleton===1?
    item.stacksize===1:
    item.singleton===0&&POS(item.stacksize)&&
     item.quantity===item.stacksize&&item.stacksize<=1000000000));
 }
 function flush(){try{return gameStore.flushTableSync("items")?.success===true}catch{return false}}
 function lock(itemID,act){
  if(quarantined.has(itemID))return deny("EX03_LOOT_OPERATOR_REPAIR_REQUIRED");
  if(busy.has(itemID))return deny("EX03_LOOT_ITEM_BUSY");
  busy.add(itemID);
  try{return act()}catch{
   quarantined.add(itemID);
   return deny("EX03_LOOT_NATIVE_WRITE_OUTCOME_UNCERTAIN");
  }finally{busy.delete(itemID)}
 }
 function collect({scene,entityID,assignments=[],containerID,itemID}={}){
  const ctx=authority({scene,entityID,assignments});
  if(!ctx||!POS(containerID)||!POS(itemID)||!POS(clock()))
   return deny("EX03_LOOT_NATIVE_SOURCE_MISSING");
  let container;
  try{container=scene.getEntityByID(containerID)}catch{return deny("EX03_LOOT_SCENE_UNAVAILABLE")}
  if(!container||container.itemID!==containerID||
   container.dungeonMaterializedContainer!==true||
   container.dungeonMaterializedSiteContent!==true||
   container.dungeonSiteContentHackingState!==2||
   !vec(container.position)||
   Math.max(0,distance(ctx.ship.position,container.position)-
    Math.max(0,Number(container.radius)||0)-
    Math.max(0,Number(ctx.ship.radius)||0))>maxRangeMeters)
   return deny("EX03_LOOT_NOT_HACKED_OR_OUT_OF_RANGE");
  return lock(itemID,()=>{
   const before=inspect(itemID);
   if(!originalUnit(before)||before.locationID!==containerID||
      before.customInfo!==""&&before.customInfo!==null&&before.customInfo!==undefined||
      isNativeSiteOwner(before.ownerID,container)!==true)
    return deny("EX03_LOOT_ORIGINAL_ITEM_UNVERIFIED");
   const inContainer=itemStore.listContainerItems(null,containerID);
   if(!Array.isArray(inContainer)||inContainer.filter(x=>x.itemID===itemID).length!==1)
    return deny("EX03_LOOT_ITEM_NOT_IN_ORIGINAL_CONTAINER");
   const tag=marker(containerID,entityID,ctx.native.corporationID);
   // Durable intent written onto the SAME original ItemStore item row.
   // After SIGKILL the authoritative item still lives in either container
   // or ship; it is never represented by a second allocated cargoID.
   // The original source writeItemCustomInfo() bypasses byID index invalidation.
   // updateInventoryItem() writes the SAME row while updating the native index.
   const stamp=itemStore.updateInventoryItem(itemID,old=>({...old,customInfo:tag}));
   if(stamp?.success!==true){quarantined.add(itemID);return deny("EX03_LOOT_INTENT_UNCERTAIN")}
   if(!flush()){quarantined.add(itemID);return deny("EX03_LOOT_INTENT_NOT_DURABLE")}
   const marked=inspect(itemID);
   if(!marked||marked.itemID!==itemID||marked.locationID!==containerID||
    marked.ownerID!==before.ownerID||marked.typeID!==before.typeID||
    marked.stacksize!==before.stacksize||marked.customInfo!==tag){
    quarantined.add(itemID);return deny("EX03_LOOT_INTENT_SOURCE_CHANGED");
   }
   // Native ItemStore whole-item move: itemID is never reallocated.
   const moved=itemStore.transferItemToOwnerLocation(
    itemID,ctx.native.corporationID,entityID,itemStore.ITEM_FLAGS.CARGO_HOLD);
   if(moved?.success!==true){quarantined.add(itemID);return deny("EX03_LOOT_PICKUP_UNCERTAIN")}
   if(!flush()){quarantined.add(itemID);return deny("EX03_LOOT_PICKUP_NOT_DURABLE")}
   const after=inspect(itemID);
   if(!after||after.itemID!==itemID||after.ownerID!==ctx.native.corporationID||
    after.locationID!==entityID||after.flagID!==itemStore.ITEM_FLAGS.CARGO_HOLD||
    after.stacksize!==before.stacksize||after.typeID!==before.typeID||
    after.customInfo!==tag){
    quarantined.add(itemID);return deny("EX03_LOOT_PICKUP_SOURCE_CHANGED");
   }
   return {status:"NATIVE_ORIGINAL_LOOT_IN_SHIP",itemID,
    shipID:entityID,corporationID:ctx.native.corporationID,
    nativeItemMinted:false};
  });
 }
 function deliver({scene,entityID,assignments=[],stationID,itemID}={}){
  const ctx=authority({scene,entityID,assignments});
  if(!ctx||!POS(stationID)||!POS(itemID))
   return deny("EX03_LOOT_NATIVE_DELIVERY_CONTEXT_MISSING");
  return lock(itemID,()=>{
   const before=inspect(itemID),receipt=parseMarker(before?.customInfo);
   if(!originalUnit(before)||!receipt||receipt.shipID!==entityID||
    receipt.corpID!==ctx.native.corporationID||
    before.locationID!==entityID||before.ownerID!==ctx.native.corporationID||
    before.flagID!==itemStore.ITEM_FLAGS.CARGO_HOLD)
    return deny("EX03_LOOT_ORIGINAL_SHIP_CUSTODY_MISSING");
   const station=getStation(stationID);
   if(!station||station.stationID!==stationID||
    station.solarSystemID!==scene.systemID||
    (station.corporationID||station.ownerID)!==ctx.native.corporationID||
    verifyNativeArrival({scene,entityID,ship:ctx.ship,controller:ctx.controller,
     stationID,corporationID:ctx.native.corporationID})!==true)
    return deny("EX03_LOOT_NATIVE_STATION_ARRIVAL_MISSING");
   const moved=itemStore.moveItemToLocation(itemID,stationID,itemStore.ITEM_FLAGS.HANGAR);
   if(moved?.success!==true){quarantined.add(itemID);return deny("EX03_LOOT_WAREHOUSE_MOVE_UNCERTAIN")}
   if(!flush()){quarantined.add(itemID);return deny("EX03_LOOT_WAREHOUSE_NOT_DURABLE")}
   const after=inspect(itemID);
   if(!after||after.itemID!==itemID||after.ownerID!==before.ownerID||
    after.locationID!==stationID||after.flagID!==itemStore.ITEM_FLAGS.HANGAR||
    after.typeID!==before.typeID||after.stacksize!==before.stacksize||
    after.customInfo!==before.customInfo){
    quarantined.add(itemID);return deny("EX03_LOOT_WAREHOUSE_CUSTODY_CHANGED");
   }
   return {status:"NATIVE_ORIGINAL_LOOT_IN_CORPORATE_WAREHOUSE",
    itemID,stationID,corporationID:ctx.native.corporationID,
    nativeItemMinted:false};
  });
 }
 // Read-only restart reconstruction: do not mutate uncertain original rows
 // or "repair" by allocating item IDs. Operators can inspect the same tag.
 function inspectReceipt(itemID,{scene=null}={}){
  if(!POS(itemID))return {status:"BLOCKED",reason:"EX03_LOOT_ID_INVALID"};
  const item=inspect(itemID),receipt=parseMarker(item?.customInfo);
  if(!item||!receipt||!originalUnit(item))
   return {status:"BLOCKED",reason:"EX03_LOOT_ORIGINAL_RECEIPT_NOT_FOUND"};
  let phase=item.locationID===receipt.shipID&&
   item.ownerID===receipt.corpID&&item.flagID===itemStore.ITEM_FLAGS.CARGO_HOLD?
    "IN_SHIP":item.ownerID===receipt.corpID&&
   item.flagID===itemStore.ITEM_FLAGS.HANGAR?"IN_WAREHOUSE":
    item.locationID===receipt.containerID?"INTENT_UNRESOLVED":"OPERATOR_REPAIR";
  // The original NPC wreck service drops nativeNpcStore cargo, NOT these
  // separately owned ItemStore rows. A destroyed NPC must never silently
  // appear to have a safely delivered or retrievable ship cargo item.
  if(receipt.wreckID!==null){
   let w;
   try{w=nativeStore.getNativeWreck(receipt.wreckID)}catch{w=null}
   if(item.locationID===receipt.wreckID&&item.ownerID===receipt.corpID&&
     item.flagID===itemStore.ITEM_FLAGS.HANGAR&&w?.wreckID===receipt.wreckID&&
     w.sourceEntityID===receipt.shipID&&
     w.coopNpcExpeditionSourceCorpID===receipt.corpID)
    phase="IN_NATIVE_WRECK";
   else {
    // A whole original item may already have been legitimately claimed into
    // an original player-owned ship. Verify that SAME player owns that ship.
    let destination=null;
    try{destination=itemStore.findItemById(item.locationID)}catch{}
    phase=w?.sourceEntityID===receipt.shipID&&
     w.coopNpcExpeditionSourceCorpID===receipt.corpID&&
     item.ownerID!==receipt.corpID&&POS(item.ownerID)&&
     destination?.itemID===item.locationID&&
     destination.ownerID===item.ownerID&&
     item.flagID===itemStore.ITEM_FLAGS.CARGO_HOLD?
      "CLAIMED_BY_PLAYER":"NEEDS_OPERATOR_REPAIR";
   }
  }
  if(phase==="IN_SHIP"){
   let native,physical=null;
   try{
    native=nativeStore.getNativeEntity(receipt.shipID);
    if(scene)physical=scene.getEntityByID(receipt.shipID);
   }catch{native=null}
   if(!native||native.entityID!==receipt.shipID||
      native.corporationID!==receipt.corpID||native.transient===true||
      (scene&&(!physical||physical.kind!=="ship"||
       physical.nativeNpc!==true||physical.itemID!==receipt.shipID)))
    phase="NEEDS_OPERATOR_REPAIR";
  }
  return {status:phase,itemID,originalContainerID:receipt.containerID,
   shipID:receipt.shipID,corporationID:receipt.corpID};
 }
 return Object.freeze({collect,deliver,inspectReceipt});
}
module.exports={createNpcExpeditionLoot,parseMarker};
