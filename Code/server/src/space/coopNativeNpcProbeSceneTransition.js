"use strict";
// EX-03B6: project an ALREADY-DURABLE original NPC probe geometry change
// through native scene removal/addition, which refreshes bubble visibility.
// NEVER allocate probe IDs, write cargo, or read hidden site locations.
const positive=n=>Number.isSafeInteger(n)&&n>0;
const vec=p=>p&&["x","y","z"].every(k=>typeof p[k]==="number"&&Number.isFinite(p[k]));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function createNativeNpcProbeSceneTransition({removeDynamicEntity,buildProbeSceneEntity}={}){
 if(typeof removeDynamicEntity!=="function"||
    typeof buildProbeSceneEntity!=="function")throw Error("NPC_PROBE_NATIVE_SCENE_AUTHORITIES_REQUIRED");
 function move({scene,row}={}){
  const fail=reason=>({success:false,status:"BLOCKED",reason});
  const p=row?.deployedProbe,id=row?.cargoID;
  if(!positive(id)||!positive(scene?.systemID)||!p||
    p.status!=="IN_SPACE"||p.probeID!==id||p.systemID!==scene.systemID||
    p.entityID!==row.entityID||p.ownerID!==row.ownerID||
    p.typeID!==row.typeID||row.quantity!==0||row.singleton===true||
    !positive(p.ownerID)||!positive(p.typeID)||!vec(p.position)||
    typeof scene.getEntityByID!=="function"||
    typeof scene.spawnDynamicEntity!=="function")
   return fail("NPC_PROBE_SCENE_DURABLE_RECEIPT_REQUIRED");
  let entity=scene.getEntityByID(id);
  if(entity){
   if(entity.itemID!==id||entity.kind!=="probe"||
      entity.nativeNpcProbe!==true||entity.nativeNpcCargoID!==id||
      entity.ownerID!==row.ownerID||entity.typeID!==row.typeID||
      entity.systemID!==scene.systemID||!vec(entity.position))
    return fail("NPC_PROBE_SCENE_FOREIGN_ID_COLLISION");
   if(distance(entity.position,p.position)<=1)
    return {success:true,status:"ALREADY_PROJECTED",cargoID:id};
   let removed;
   try{removed=removeDynamicEntity(scene.systemID,id,
      {allowSessionOwned:false,broadcast:true})}
   catch{return fail("NPC_PROBE_SCENE_REMOVE_FAILED")}
   if(removed?.success!==true||scene.getEntityByID(id))
    return fail("NPC_PROBE_SCENE_REMOVE_UNCONFIRMED");
  }
  // The only permissible new object has the SAME original durable cargoID.
  let candidate;
  try{
   candidate=buildProbeSceneEntity({probeID:id,typeID:row.typeID,
    pos:[p.position.x,p.position.y,p.position.z],
    destination:[p.position.x,p.position.y,p.position.z],
    rangeStep:p.rangeStep,scanRange:p.scanRange,state:1},
    {ownerID:row.ownerID,systemID:scene.systemID});
  }catch{return fail("NPC_PROBE_SCENE_BUILD_FAILED")}
  if(!candidate||candidate.itemID!==id||candidate.kind!=="probe"||
    candidate.ownerID!==row.ownerID||candidate.typeID!==row.typeID||
    candidate.systemID!==scene.systemID||!vec(candidate.position)||
    distance(candidate.position,p.position)>1)
   return fail("NPC_PROBE_SCENE_BUILD_IDENTITY_MISMATCH");
  candidate.nativeNpcProbe=true;
  candidate.nativeNpcCargoID=id;
  let spawned;
  try{spawned=scene.spawnDynamicEntity(candidate,{broadcast:true})}
  catch{return fail("NPC_PROBE_SCENE_SPAWN_FAILED")}
  const actual=scene.getEntityByID(id);
  if(spawned?.success!==true||!actual||actual.itemID!==id||
    actual.kind!=="probe"||actual.nativeNpcProbe!==true||
    actual.nativeNpcCargoID!==id||actual.ownerID!==row.ownerID||
    actual.typeID!==row.typeID||actual.systemID!==scene.systemID||
    !vec(actual.position)||
    distance(actual.position,p.position)>1)
   return fail("NPC_PROBE_SCENE_SPAWN_UNCONFIRMED");
  return {success:true,status:"NATIVE_SCENE_BROADCAST_REPLACED",cargoID:id};
 }
 return Object.freeze({move});
}
module.exports={createNativeNpcProbeSceneTransition};
