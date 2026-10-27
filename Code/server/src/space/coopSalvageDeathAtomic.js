"use strict";
// Stage J: original NPC cargo rows are MOVED into the wreck, never copied.
// Single coopAtomicNativeRows SQLite transaction on npcCargo + npcWreckItems.
// The original native IDs remain in sourceCargoID, not in guessed type-only loot.
const pos=x=>Number.isSafeInteger(x)&&x>0;
const deny=status=>({status});
function createNativeDeathMove({atomic,getNativeCargo,getNativeWreckItems}={}){
 if(typeof atomic?.transact!=="function"||
  typeof getNativeCargo!=="function"||typeof getNativeWreckItems!=="function")
  throw Error("SALVAGE_DEATH_NATIVE_AUTHORITIES_REQUIRED");
 function move({wreckRecord,originalCargo,preparedWreckItems}={}){
  if(process.env.EVEJS_COOP_SALVAGE_NATIVE_DEATH!=="1"||
   process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1")
   return deny("DISABLED");
  if(!pos(wreckRecord?.wreckID)||!pos(wreckRecord?.sourceEntityID)||
   !pos(wreckRecord.systemID)||wreckRecord.transient===true||
   !Array.isArray(originalCargo)||!originalCargo.length||
   originalCargo.length>1000||!Array.isArray(preparedWreckItems)||
   preparedWreckItems.length!==originalCargo.length)
   return deny("SALVAGE_DEATH_INVALID_OR_TRANSIENT");
  const seen=new Set(),seenWreck=new Set();
  for(let i=0;i<originalCargo.length;i++){
   const c=originalCargo[i],w=preparedWreckItems[i];
   seen.add(c?.itemID);seenWreck.add(w?.wreckItemID);
   if(!pos(c?.itemID)||!pos(c.typeID)||!pos(c.quantity)||
    !pos(w?.wreckItemID)||w.typeID!==c.typeID||
    w.quantity!==c.quantity||w.wreckID!==wreckRecord.wreckID||
    w.sourceCargoID!==c.itemID||w.sourceKind!=="cargo"||
    w.transient===true)
    return deny("SALVAGE_DEATH_PREPARED_IDENTITY_MISMATCH");
  }
  if(seen.size!==originalCargo.length||seenWreck.size!==originalCargo.length)
   return deny("SALVAGE_DEATH_DUPLICATE_SOURCE");
  try{
   return atomic.transact(["npcCargo","npcWreckItems"],tx=>{
    // On pinned EveJS these two collections are single top-level JSON keys,
    // *not* independently allocated item table rows.
    const cargo=tx.get("npcCargo","cargo"),wrecks=tx.get("npcWreckItems","items");
    if(!cargo||typeof cargo!=="object"||Array.isArray(cargo)||
     !wrecks||typeof wrecks!=="object"||Array.isArray(wrecks))
     throw Error("SALVAGE_NATIVE_TABLE_SHAPE_CHANGED");
    const stock=Object.values(cargo).filter(x=>x&&
     x.entityID===wreckRecord.sourceEntityID);
    if(stock.length!==originalCargo.length||
     stock.some(x=>!seen.has(x.cargoID))||
     Object.values(wrecks).some(w=>w&&
      (w.wreckID===wreckRecord.wreckID||
       seen.has(w.sourceCargoID))))
     throw Error("SALVAGE_CARGO_DUPLICATED_OR_CHANGED");
    const nextCargo={...cargo},nextWrecks={...wrecks};
    for(let i=0;i<originalCargo.length;i++){
     const o=originalCargo[i],native=cargo[String(o.itemID)];
     if(!native||native.cargoID!==o.itemID||
      native.entityID!==wreckRecord.sourceEntityID||
      native.typeID!==o.typeID||native.quantity!==o.quantity||
      wrecks[String(preparedWreckItems[i].wreckItemID)])
      throw Error("SALVAGE_NATIVE_SOURCE_IDENTITY_CHANGED");
     delete nextCargo[String(o.itemID)];
     nextWrecks[String(preparedWreckItems[i].wreckItemID)]=
      {...preparedWreckItems[i]};
    }
    tx.put("npcCargo","cargo",nextCargo);
    tx.put("npcWreckItems","items",nextWrecks);
    return {status:"SALVAGE_NATIVE_CARGO_TO_WRECK_COMMITTED",
     wreckID:wreckRecord.wreckID,sourceEntityID:wreckRecord.sourceEntityID,
     cargoIDs:originalCargo.map(x=>x.itemID),
     wreckItemIDs:preparedWreckItems.map(x=>x.wreckItemID)};
   });
  }catch(e){return deny("SALVAGE_DEATH_NATIVE_ATOMIC_UNCERTAIN:"+String(e?.message||e).slice(0,90))}
 }
 return {move};
}
function movePinned(args){
 try{
  const store=require("./npc/nativeNpcStore");
  return createNativeDeathMove({
   atomic:require("../gameStore").coopAtomicNativeRows,
   getNativeCargo:store.listNativeCargoForEntity,
   getNativeWreckItems:store.listNativeWreckItemsForWreck
  }).move(args);
 }catch{return deny("SALVAGE_NATIVE_DEATH_PROVIDER_UNAVAILABLE")}
}
module.exports={createNativeDeathMove,movePinned};
