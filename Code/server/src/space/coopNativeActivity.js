"use strict";
// Read-only physical-EveJS evidence sampler. It never orders, spawns, damages,
// teleports or credits a native NPC. In-memory baselines do not survive reboot.
const positive=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const position=x=>x&&["x","y","z"].every(k=>typeof x[k]==="number"&&Number.isFinite(x[k]));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function createActivity({clock=()=>Date.now(),minMovementMeters=100,maxEntities=500}={}){
 if(typeof clock!=="function"||!Number.isFinite(minMovementMeters)||minMovementMeters<=0||
  !Number.isSafeInteger(maxEntities)||maxEntities<1)throw Error("invalid native activity options");
 const prior=new Map();
 function sample({systemID,scene,links=[],getCargo=()=>[],getController=()=>null}={}){
  const system=positive(systemID);
  if(!system||typeof scene?.getEntityByID!=="function"||
   !Array.isArray(links)||typeof getCargo!=="function"||typeof getController!=="function")
   return {status:"NO_NATIVE_SCENE",systemID:system||null};
  const at=clock();
  if(!Number.isFinite(at))return {status:"CLOCK_INVALID",systemID:system};
  const result={status:"SAMPLED",systemID:system,observedAt:at,physicalNpcShips:0,
   observedMovement:0,oreGrowth:0,loadedOreShips:0,engagedNativeNpcs:0,
   evidence:[]};
  const used=new Set();
  const playerShipIDs=new Set(Array.from(scene.sessions?.values?.()||[])
   .map(session=>positive(session?._space?.shipID)).filter(Boolean));
  for(const link of links){
   const entityID=positive(link?.entityID);
   if(!entityID||playerShipIDs.has(entityID)||Number(link?.systemID)!==system||used.has(entityID)||
    !/^coop-pilot-[0-9]{3,}$/.test(String(link?.pilotID||"")))continue;
   used.add(entityID);
   const ship=scene.getEntityByID(entityID);
   if(ship?.kind!=="ship"||!position(ship.position))continue;
   const key=system+":"+entityID;
   const old=prior.get(key);
   const previous=old?.pilotID===link.pilotID?old:null;
   // Never treat stale pre-restart coords or unchanged samples as movement.
   const moved=previous&&at>previous.at&&distance(previous.position,ship.position)>=minMovementMeters;
   let ore=null;
   try{
    const cargo=getCargo(entityID);
    if(Array.isArray(cargo))ore=cargo.filter(x=>Number(x?.moduleID)===0&&positive(x?.typeID))
      .reduce((n,x)=>n+Math.max(0,Number(x.quantity)||0),0);
   }catch(error){ /* no cargo claim on failed EveJS inventory read */ }
   let target=null;
   try{
    const id=positive(getController(entityID)?.currentTargetID);
    if(id&&id!==entityID&&scene.getEntityByID(id))target=id;
   }catch(error){ /* no combat claim on failed EveJS controller read */ }
   result.physicalNpcShips++;
   if(ore!==null&&ore>0)result.loadedOreShips++;
   const growth=previous&&at>previous.at&&ore!==null&&previous.ore!==null&&ore>previous.ore;
   if(moved)result.observedMovement++;
   if(growth)result.oreGrowth++;
   if(target)result.engagedNativeNpcs++;
   if(moved||growth||target){
    result.evidence.push({pilotID:link.pilotID,entityID,role:String(link.role||"unknown").slice(0,24),
     ...(moved?{movementMeters:Math.round(distance(previous.position,ship.position))}:{}),
     ...(growth?{newOreQuantity:ore,oreDelta:ore-previous.ore}:{}),
     ...(target?{nativeTargetID:target}: {})});
   }
   // Only one bounded latest sample per physical ship. Never retain ship objects.
   if(previous||prior.size<maxEntities)prior.set(key,{at,pilotID:link.pilotID,position:{...ship.position},ore});
  }
  if(prior.size>=maxEntities){
   const cutoff=at-60*60*1000;
   for(const [id,p] of prior)if(p.at<cutoff)prior.delete(id);
  }
  // We report native target selection, not inflicted damage or a kill.
  result.evidence=result.evidence.slice(0,20);
  return result;
 }
 return {sample};
}
module.exports={createActivity};
