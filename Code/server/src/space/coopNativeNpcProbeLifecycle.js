"use strict";
// EX-03B5: original NPC probe expiry + near-hull recovery lifecycle.
// One original cargoID remains authoritative through IN_SPACE -> EXPIRED
// or IN_SPACE -> RECALLING -> STOWED. Every durable source transition
// synchronously flushes NPC cargo before a physical probe may disappear.
// No synthetic source inventory, refunds or player probe table.
const pos=n=>Number.isSafeInteger(n)&&n>0;
const vec=p=>p&&["x","y","z"].every(k=>typeof p[k]==="number"&&Number.isFinite(p[k]));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function createNativeNpcProbeLifecycle({getNativeEntity,getController,
 listNativeCargoForEntity,upsertNativeCargo,flushNpcCargo,
 removeNativeProbe,refreshNativeCargoProjection,clock=()=>Date.now(),
 flightTtlMs=3600000,maxReturnMeters=2500}={}){
 if([getNativeEntity,getController,listNativeCargoForEntity,upsertNativeCargo,
  flushNpcCargo,removeNativeProbe,refreshNativeCargoProjection,clock]
   .some(fn=>typeof fn!=="function")||
   !Number.isSafeInteger(flightTtlMs)||flightTtlMs<60000||flightTtlMs>3600000||
   !Number.isSafeInteger(maxReturnMeters)||maxReturnMeters<100||maxReturnMeters>10000)
  throw Error("NPC_PROBE_LIFECYCLE_AUTHORITIES_REQUIRED");
 const quarantine=new Set();
 const denied=reason=>({status:"BLOCKED",reason});
 function commit(row, cargoID){
  if(quarantine.has(cargoID))return false;
  let written;
  try{written=upsertNativeCargo(row)}catch{quarantine.add(cargoID);return false}
  if(written?.success!==true){quarantine.add(cargoID);return false}
  let durable;
  try{durable=flushNpcCargo()}catch{quarantine.add(cargoID);return false}
  if(durable?.success!==true){quarantine.add(cargoID);return false}
  return true;
 }
 function tick({scene,entityID,assignments=[],requestRecall=false}={}){
  const now=clock();
  if(!pos(entityID)||!pos(scene?.systemID)||typeof scene.getEntityByID!=="function"||
   !Array.isArray(assignments)||assignments.length>2048||
   !Number.isSafeInteger(now)||now<=0)return denied("NPC_PROBE_LIFECYCLE_CONTEXT");
  const links=assignments.filter(a=>a?.entityID===entityID&&
   a.systemID===scene.systemID&&/^coop-pilot-[0-9]{3,}$/.test(String(a.pilotID||"")));
  if(links.length!==1||assignments.some(a=>a?.pilotID===links[0].pilotID&&
   (a.entityID!==entityID||a.systemID!==scene.systemID)))
   return denied("NPC_PROBE_LIFECYCLE_DURABLE_LINK_MISSING");
  let entity,controller,cargo;
  try{
   entity=getNativeEntity(entityID);controller=getController(entityID);
   cargo=listNativeCargoForEntity(entityID);
  }catch{return denied("NPC_PROBE_LIFECYCLE_SOURCE_UNAVAILABLE")}
  const ship=scene.getEntityByID(entityID);
  if(!entity||entity.entityID!==entityID||entity.systemID!==scene.systemID||
   !pos(entity.ownerID)||!pos(entity.corporationID)||
   !controller||controller.entityID!==entityID||controller.systemID!==scene.systemID||
   !ship||ship.itemID!==entityID||ship.kind!=="ship"||ship.nativeNpc!==true||
   ship.ownerID!==entity.ownerID||ship.corporationID!==entity.corporationID||
   !vec(ship.position)||ship.session?.characterID||ship.isWarping||
   ship.warpState||ship.pendingWarp||!Array.isArray(cargo)||cargo.length>512||
   new Set(cargo.map(c=>c?.cargoID)).size!==cargo.length)
   return denied("NPC_PROBE_LIFECYCLE_NATIVE_AUTHORITY_MISSING");
  const rows=cargo.filter(r=>r?.deployedProbe&&
   ["IN_SPACE","RECALLING","EXPIRED"].includes(r.deployedProbe.status));
  if(rows.length>8)return denied("NPC_PROBE_LIFECYCLE_ORIGINAL_LIMIT");
  for(const row of rows.sort((a,b)=>a.cargoID-b.cargoID)){
   const p=row.deployedProbe;
   if(quarantine.has(row.cargoID))return denied("NPC_PROBE_OPERATOR_REPAIR_REQUIRED");
   if(!pos(row.cargoID)||row.entityID!==entityID||
      row.ownerID!==entity.ownerID||row.quantity!==0||
      row.groupID!==479||row.categoryID!==8||row.singleton===true||
      p.probeID!==row.cargoID||p.entityID!==entityID||
      p.ownerID!==entity.ownerID||p.systemID!==scene.systemID||
      p.typeID!==row.typeID||!vec(p.position)||
      !Number.isSafeInteger(p.launchedAtMs)||p.launchedAtMs>now)
    return denied("NPC_PROBE_LIFECYCLE_RECEIPT_INVALID");
   const physical=scene.getEntityByID(row.cargoID);
   if(physical&&(
    physical.itemID!==row.cargoID||physical.kind!=="probe"||
    physical.ownerID!==entity.ownerID||physical.typeID!==row.typeID||
    physical.nativeNpcProbe!==true||physical.nativeNpcCargoID!==row.cargoID||
    physical.systemID!==scene.systemID||!vec(physical.position)))
    return denied("NPC_PROBE_LIFECYCLE_FOREIGN_ITEM_COLLISION");
   // Expired or recalled cargo is no longer scanned even if a crash left
   // the physical item in-scene. Physical removal is idempotent.
   if(p.status==="EXPIRED"||p.status==="RECALLING"){
    if(physical){
     let removed;
     try{removed=removeNativeProbe(scene.systemID,row.cargoID)}
     catch{return denied("NPC_PROBE_NATIVE_REMOVAL_FAILED")}
     // A successful removal ACK alone is insufficient for a refund.
     // Re-read the live scene: a stale probe must never coexist with
     // a returned original cargo item after an ambiguous native update.
     if(removed?.success!==true||scene.getEntityByID(row.cargoID))
      return denied("NPC_PROBE_NATIVE_REMOVAL_UNCONFIRMED");
    }
    if(p.status==="EXPIRED"){
     if(physical)return {status:"NPC_PROBE_EXPIRED",cargoID:row.cargoID,quantity:0};
     continue; // Durable tombstone is already clean; process other probes.
    }
    // RECALLING is a durable pre-refund fence. No physical probe remains.
    const stowed={...row,quantity:1,deployedProbe:{
     ...p,status:"STOWED",recoveredAtMs:now}};
    if(!commit(stowed,row.cargoID))
     return denied("NPC_PROBE_STOW_DURABILITY_UNCONFIRMED");
    let refreshed;
    try{refreshed=refreshNativeCargoProjection(ship,entityID)}
    catch{return denied("NPC_PROBE_STOW_PROJECTION_FAILED")}
    if(refreshed!==true)return denied("NPC_PROBE_STOW_PROJECTION_FAILED");
    return {status:"NPC_PROBE_RETURNED",cargoID:row.cargoID,quantity:1};
   }
   const expired=now-p.launchedAtMs>=flightTtlMs;
   // Do not refund based on stale/teleported in-memory geometry; the
   // original durable flight position must agree with the scene first.
   const near=physical&&dist(physical.position,p.position)<=1&&
    dist(physical.position,ship.position)<=maxReturnMeters;
   if(!expired&&!(requestRecall===true&&near))
    continue;
   // No free refund on expiry. A probe becomes a durable EXPIRED tombstone
   // with quantity 0, then the same physical item is despawned.
   const transition={...row,deployedProbe:{...p,
    status:expired?"EXPIRED":"RECALLING",
    endedAtMs:now}};
   if(!commit(transition,row.cargoID))
    return denied("NPC_PROBE_END_DURABILITY_UNCONFIRMED");
   return {status:expired?"NPC_PROBE_EXPIRY_COMMITTED":
    "NPC_PROBE_RECALL_COMMITTED",cargoID:row.cargoID,quantity:0};
  }
  return {status:"NO_LIFECYCLE_ACTION",active:rows.length};
 }
 return Object.freeze({tick});
}
module.exports={createNativeNpcProbeLifecycle};
