"use strict";
// Recover ONLY co-op named NPCs with durable native EveJS entity/controller
// records. Called after gate-transfer journal recovery but BEFORE registry
// pruning, so persisted identity can be reconciled to the same native ship.
// Legacy transient-only NPCs cannot be restored; never fake success for them.
const positive=x=>{const n=Number(x);return Number.isSafeInteger(n)&&n>0?n:null};
const validShip=(ship,id)=>Boolean(ship&&ship.kind==="ship"&&
 ship.nativeNpc===true&&positive(ship.itemID)===id);
function restoreNamedShips({registry,store,service,sceneForSystem,lostShips=[],maxLinks=100,allowRelocation=false}={}){
 if(typeof registry?.snapshot!=="function"||typeof store?.getNativeEntity!=="function"||
  typeof store?.getNativeController!=="function"||
  typeof service?.materializeStoredNativeController!=="function"||
  typeof sceneForSystem!=="function")throw Error("NATIVE_RESTORE_DEPENDENCY_MISSING");
 const links=Object.values(registry.snapshot()?.links||{});
 if(links.length>maxLinks)return {status:"NEEDS_OPERATOR_REPAIR",
  reason:"TOO_MANY_LINKS",recovered:0,alreadyPhysical:0,legacyTransient:0,errors:[]};
 const stats={status:"OK",recovered:0,alreadyPhysical:0,
  legacyTransient:0,confirmedLosses:0,errors:[]};
 const ids=new Set();
 for(const link of links){
  const id=positive(link?.entityID),systemID=positive(link?.systemID);
  const pilotID=String(link?.pilotID||"");
  if(!id||!systemID||!/^coop-pilot-[0-9]{3,}$/.test(pilotID)||
   ids.has(id)){
   stats.errors.push({pilotID,entityID:id,reason:"INVALID_OR_DUPLICATE_LINK"});
   continue;
  }
  ids.add(id);
  const entity=store.getNativeEntity(id),controller=store.getNativeController(id);
  // A link created before durable-mode activation references a transient
  // EveJS ship that was never saved. Leave normal stale-link recovery alone.
  if(!entity&&!controller){
   const lost=Array.isArray(lostShips)&&lostShips.some(loss=>
    loss?.pilotID===pilotID&&positive(loss.shipID)===id&&
    positive(loss.systemID)===systemID&&positive(loss.wreckID)&&
    positive(loss.lostAt)&&positive(link.linkedAt)&&
    Number(loss.lostAt)>=Number(link.linkedAt));
   if(lost)stats.confirmedLosses++;
   else if(link.durable===true)stats.errors.push({pilotID,entityID:id,
    reason:"DURABLE_NATIVE_RECORD_MISSING"});
   else stats.legacyTransient++;
   continue;
  }
  if(!entity||!controller){
   stats.errors.push({pilotID,entityID:id,reason:"PARTIAL_NATIVE_RECORD"});
   continue;
  }
  if(entity.transient===true||controller.transient===true){
   // Still-live transient ships may be handled by ordinary reconciliation.
   stats.legacyTransient++;
   continue;
  }
  if(positive(entity.entityID)!==id||positive(controller.entityID)!==id||
   entity.nativeNpc!==true||positive(entity.systemID)!==positive(controller.systemID)){
   stats.errors.push({pilotID,entityID:id,reason:"NATIVE_RECORD_IDENTITY_CONFLICT"});
   continue;
  }
  // The durable record owns the ship's own location; the identity link is the
  // derived index. A record whose entity and controller agree with each other
  // but not with the link is a STALE LINK (the hull really relocated), not a
  // second ship and not a licence to steal another pilot's record. It may only
  // be reconciled when an operator opts in, and only through the registry's own
  // precondition-checked relocate(), which persists the new system afterwards.
  const recordSystemID=positive(entity.systemID);
  let destination=systemID;
  if(recordSystemID!==systemID){
   if(allowRelocation!==true){
    stats.errors.push({pilotID,entityID:id,reason:"NATIVE_RECORD_IDENTITY_CONFLICT"});
    continue;
   }
   if(typeof registry?.relocate!=="function"){
    stats.errors.push({pilotID,entityID:id,reason:"NATIVE_RECORD_RELOCATION_UNSUPPORTED"});
    continue;
   }
   destination=recordSystemID;
  }
  try{
   const scene=sceneForSystem(destination);
   if(!scene||positive(scene.systemID)!==destination||
    typeof scene.getEntityByID!=="function")
    throw Error("DESTINATION_NATIVE_SCENE_NOT_READY");
   const current=scene.getEntityByID(id);
   if(current){
    if(!validShip(current,id))throw Error("ENTITY_ID_OCCUPIED_BY_FOREIGN_SHIP");
    stats.alreadyPhysical++;
   }else{
    const result=service.materializeStoredNativeController(scene,id,{broadcast:false});
    if(result?.success!==true||!validShip(scene.getEntityByID(id),id))
     throw Error(String(result?.errorMsg||"NATIVE_RESTORE_NOT_PHYSICAL").slice(0,100));
    stats.recovered++;
   }
   if(destination!==systemID){
    const moved=registry.relocate(pilotID,systemID,id,destination);
    if(moved?.status!=="RELOCATED"){
     stats.errors.push({pilotID,entityID:id,
      reason:"NATIVE_RECORD_RELOCATION_REFUSED:"+String(moved?.status||"UNKNOWN")});
     continue;
    }
    stats.relocated=(Number(stats.relocated)||0)+1;
   }
  }catch(error){
   stats.errors.push({pilotID,entityID:id,
    reason:String(error?.message||error).slice(0,120)});
  }
 }
 if(stats.errors.length)stats.status="NEEDS_OPERATOR_REPAIR";
 return stats;
}
module.exports={restoreNamedShips};
