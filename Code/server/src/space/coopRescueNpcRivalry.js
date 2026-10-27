"use strict";
// Actual NPC rivalry over original rescue wreck cargo. Independent NPC
// corporation must move a living native ship into range, then take the SAME
// item players would have taken. No shadow economy and no generated ore.
const pos=n=>Number.isSafeInteger(n)&&n>0;
const vec=x=>x&&["x","y","z"].every(k=>Number.isFinite(x[k]));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function createRescueRivalry({getWrecks,getWreckItems,readVerifiedLoss,atomicRows,
 warpToEntity,orbit,readController,clock=()=>Date.now()}={}){
 if([getWrecks,getWreckItems,readVerifiedLoss,atomicRows,warpToEntity,orbit,
  readController,clock].some(x=>typeof x!=="function"))
  throw Error("RESCUE_RIVAL_NATIVE_AUTHORITIES_REQUIRED");
 const nextAt=new Map();
 function tick({scene,candidates=[],blockedIDs=new Set()}={}){
  if(process.env.EVEJS_COOP_RESCUE_NPC_RIVALS!=="1"||
   process.env.EVEJS_COOP_RESCUE_ATOMIC!=="1"||
   process.env.EVEJS_COOP_RESCUE_PROVENANCE!=="1")
   return {status:"DISABLED",orders:[]};
  if(!pos(scene?.systemID)||typeof scene.getEntityByID!=="function"||
   !Array.isArray(candidates)||!(blockedIDs instanceof Set))
   return {status:"RESCUE_RIVAL_SCENE_INVALID",orders:[]};
  const now=clock(),orders=[];
  if(!pos(now))return {status:"RESCUE_RIVAL_CLOCK_INVALID",orders};
  let wrecks,witness;try{
   wrecks=getWrecks();witness=readVerifiedLoss();
  }catch{return {status:"RESCUE_RIVAL_WRECK_SOURCE_UNAVAILABLE",orders}};
  if(witness?.status!=="READY"||!Array.isArray(witness.outcomes))
   return {status:"RESCUE_RIVAL_NATIVE_LOSS_UNAVAILABLE",orders};
  if(!Array.isArray(wrecks))return {status:"RESCUE_RIVAL_WRECK_SOURCE_UNAVAILABLE",orders};
  for(const wreck of wrecks.filter(w=>w.systemID===scene.systemID&&
    pos(w.wreckID)&&pos(w.sourceEntityID)&&w.transient!==true)
    .sort((a,b)=>a.wreckID-b.wreckID).slice(0,40)){
   const losses=witness.outcomes.filter(x=>x.systemID===scene.systemID&&
    x.targetID===wreck.sourceEntityID&&
    x.status==="HAULER_NATIVE_LOSS_VERIFIED"&&
    x.haulerNativeWreckID===wreck.wreckID);
   if(losses.length!==1)continue;
   const physical=scene.getEntityByID(wreck.wreckID);
   if(physical?.nativeNpcWreck!==true||
    physical.itemID!==wreck.wreckID||!vec(physical.position))continue;
   let items;try{items=getWreckItems(wreck.wreckID)}
   catch{continue}
   const cargo=(Array.isArray(items)?items:[]).filter(x=>
    x.wreckID===wreck.wreckID&&x.sourceKind==="cargo"&&
    pos(x.sourceCargoID)&&pos(x.sourceOriginalQuantity)&&
    pos(x.wreckItemID)&&pos(x.quantity)&&
    x.quantity<=x.sourceOriginalQuantity);
   if(!cargo.length)continue;
   const eligible=candidates.filter(x=>x?.role==="trader"&&
    pos(x.entityID)&&!blockedIDs.has(x.entityID)&&
    x.systemID===scene.systemID&&
    pos(x.corporationID)&&x.corporationID!==wreck.corporationID)
    .sort((a,b)=>a.entityID-b.entityID);
   for(const a of eligible){
    const key=a.entityID+":"+wreck.wreckID;
    if((nextAt.get(key)||0)>now)continue;
    const ship=scene.getEntityByID(a.entityID);
    const ctrl=readController(a.entityID);
    if(ship?.kind!=="ship"||ship.nativeNpc!==true||
     ship.itemID!==a.entityID||!vec(ship.position)||
     ctrl?.entityID!==a.entityID||ctrl.systemID!==scene.systemID||
     pos(ctrl.currentTargetID)||ctrl.manualOrder?.type==="attack"||
     ship.pendingWarp||ship.warpState||ship.mode==="WARP")continue;
    const meters=dist(ship.position,physical.position);
    if(meters>2500){
     const out=meters>=250000?
      warpToEntity(a.entityID,wreck.wreckID):
      orbit(a.entityID,wreck.wreckID,1200);
     nextAt.set(key,now+(out?.success===true?30000:60000));
     if(out?.success===true)orders.push({status:"NATIVE_RIVAL_APPROACHING",
      entityID:a.entityID,wreckID:wreck.wreckID,
      movement:meters>=250000?"WARP":"ORBIT"});
     break;
    }
    let taken;
    try{taken=atomicRows(["npcWreckItems","npcCargo","npcEntities"],tx=>{
     const entity=tx.get("npcEntities","entities\u001f"+a.entityID);
     if(entity?.entityID!==a.entityID||
      entity.systemID!==scene.systemID||
      entity.corporationID!==a.corporationID||
      entity.transient===true)throw Error("RIVAL_ENTITY_IDENTITY_CHANGED");
     const source=tx.get("npcWreckItems","items");
     const row=source?.[String(cargo[0].wreckItemID)];
     if(!row||row.wreckID!==wreck.wreckID||
      row.sourceCargoID!==cargo[0].sourceCargoID||
      row.typeID!==cargo[0].typeID||row.quantity!==cargo[0].quantity||
      !pos(row.sourceOriginalQuantity))
      throw Error("RIVAL_WRECK_SOURCE_CHANGED");
     const root=tx.get("npcCargo","cargo"),
      nextID=tx.get("npcCargo","nextCargoID");
     // A wreck may be visible before stock NPC destruction removes the
     // original hauler cargo. Never duplicate it in a rival's ship.
     if(root?.[String(row.sourceCargoID)])
      throw Error("RIVAL_ORIGINAL_HAULER_STILL_OWNS_SOURCE");
     if(!root||typeof root!=="object"||!pos(nextID)||
      root[String(row.sourceCargoID)]||root[String(nextID)])
      throw Error("RIVAL_CARGO_IDENTITY_CONFLICT");
     // Source cargoID and original quantity are immutable provenance, but
     // a NEW native cargoID is allocated for the salvage ship's real hold.
     const dest={cargoID:nextID,entityID:a.entityID,
      ownerID:a.corporationID,typeID:row.typeID,
      quantity:row.quantity,singleton:false,
      groupID:row.groupID||0,categoryID:row.categoryID||0,
      itemName:row.itemName||"Salvaged cargo",flagID:5,
      sourceCargoID:row.sourceCargoID,
      sourceWreckItemID:row.wreckItemID,
      sourceWreckID:wreck.wreckID,
      sourceOriginalQuantity:row.sourceOriginalQuantity,
      coopRescueRivalSalvage:true};
     const updated={...root,[String(nextID)]:dest};
     const remaining={...source};delete remaining[String(row.wreckItemID)];
     tx.put("npcWreckItems","items",remaining);
     tx.put("npcCargo","cargo",updated);
     tx.put("npcCargo","nextCargoID",nextID+1);
     return {cargoID:nextID,quantity:row.quantity,
      sourceCargoID:row.sourceCargoID};
    })}catch{
     nextAt.set(key,now+60000);break;
    }
    if(taken?.cargoID){
     nextAt.set(key,now+300000);
     orders.push({status:"NATIVE_RIVAL_CARGO_CAPTURED",
      entityID:a.entityID,wreckID:wreck.wreckID,
      ...taken,corporationID:a.corporationID,iskCreated:0});
    }
    break;
   }
   if(orders.length)break;
  }
  while(nextAt.size>512)nextAt.delete(nextAt.keys().next().value);
  return {status:"READY",orders};
 }
 return {tick};
}
module.exports={createRescueRivalry};
