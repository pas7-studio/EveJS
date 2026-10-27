"use strict";
// EX-03B: read-only, native-store-backed NPC probe scanner hardware preflight.
// Nothing here launches probes, mutates original cargo or forges a scan.
// Scanner probes belong to original nativeNpcStore records, never a player
// character or client RPC. A later launch writer must preserve the cargoID.
const positive=n=>Number.isSafeInteger(n)&&n>0;
const finiteVector=p=>p&&["x","y","z"].every(k=>typeof p[k]==="number"&&Number.isFinite(p[k]));
const pilotName=s=>typeof s==="string"&&/^coop-pilot-[0-9]{3,}$/.test(s);
const SCANNER_LAUNCHER_GROUP=481;
const SCANNER_PROBE_GROUP=479;
function createNpcProbeHardware({getNativeEntity,getController,listNativeModulesForEntity,
 listNativeCargoForEntity,getCompatibleProbeChargeTypeIDs}={}) {
 if([getNativeEntity,getController,listNativeModulesForEntity,
     listNativeCargoForEntity,getCompatibleProbeChargeTypeIDs]
    .some(fn=>typeof fn!=="function"))throw Error("NPC_PROBE_NATIVE_AUTHORITIES_REQUIRED");
 function check({scene,entityID,assignments=[]}={}){
  const fail=(reason)=>({status:"BLOCKED",reason,ready:false});
  if(!positive(scene?.systemID)||typeof scene.getEntityByID!=="function"||
     !positive(entityID)||!Array.isArray(assignments)||assignments.length>2048)
   return fail("INVALID_NATIVE_SCENE");
  const names=assignments.filter(a=>a?.entityID===entityID&&
   a.systemID===scene.systemID&&pilotName(a.pilotID));
  if(names.length!==1||assignments.some(a=>a?.pilotID===names[0].pilotID&&
    (a.entityID!==entityID||a.systemID!==scene.systemID)))
   return fail("DURABLE_NPC_PILOT_UNVERIFIED");
  let entity,controller,modules,cargo;
  try{
   entity=getNativeEntity(entityID);controller=getController(entityID);
   modules=listNativeModulesForEntity(entityID);
   cargo=listNativeCargoForEntity(entityID);
  }catch{return fail("NATIVE_STORE_UNAVAILABLE")}
  const ship=scene.getEntityByID(entityID);
  if(!ship||ship.itemID!==entityID||ship.nativeNpc!==true||
     ship.kind!=="ship"||ship.transient===true||
     !finiteVector(ship.position)||ship.isWarping||
     ship.pendingWarp||ship.warpState||
     String(ship.mode||"").toUpperCase().includes("WARP")||
     (positive(ship.systemID)&&ship.systemID!==scene.systemID)||
     !entity||entity.entityID!==entityID||entity.systemID!==scene.systemID||
     entity.transient===true||!positive(entity.ownerID)||
     !positive(entity.corporationID)||ship.ownerID!==entity.ownerID||
     ship.corporationID!==entity.corporationID||
     !controller||controller.entityID!==entityID||controller.systemID!==scene.systemID||
     !Array.isArray(modules)||!Array.isArray(cargo)||modules.length>256||cargo.length>512)
   return fail("NATIVE_SHIP_OR_STORE_MISMATCH");
  const launchers=modules.filter(m=>m?.entityID===entityID&&
   m?.ownerID===entity.ownerID&&positive(m.moduleID)&&
   m.groupID===SCANNER_LAUNCHER_GROUP&&m.categoryID===7&&
   positive(m.flagID)&&m.transient!==true&&
   m.moduleState?.online===true&&
   m.moduleState?.incapacitated!==true);
  if(!launchers.length)return fail("NATIVE_SCANNER_LAUNCHER_NOT_FITTED");
  if(launchers.length>8||new Set(launchers.map(x=>x.moduleID)).size!==launchers.length)
   return fail("NATIVE_SCANNER_LAUNCHER_AMBIGUOUS");
  for(const launcher of launchers.sort((a,b)=>a.moduleID-b.moduleID)){
   let compatible;
   try{compatible=getCompatibleProbeChargeTypeIDs(launcher.typeID)}catch{
    return fail("NATIVE_CHARGE_COMPATIBILITY_UNAVAILABLE");
   }
   if(!Array.isArray(compatible)||!compatible.length)continue;
   const types=new Set(compatible.filter(positive));
   const charges=cargo.filter(c=>c?.moduleID===launcher.moduleID&&
    c.entityID===entityID&&c.ownerID===entity.ownerID&&
    c.groupID===SCANNER_PROBE_GROUP&&c.categoryID===8&&
    positive(c.cargoID)&&types.has(c.typeID)&&
    c.transient!==true&&c.singleton!==true&&c.quantity===1&&
    (c.deployedProbe==null||(
     c.deployedProbe.status==="STOWED"&&
     c.deployedProbe.probeID===c.cargoID&&
     c.deployedProbe.entityID===entityID&&
     c.deployedProbe.ownerID===entity.ownerID&&
     c.deployedProbe.typeID===c.typeID&&
     positive(c.deployedProbe.systemID)&&
     Number.isSafeInteger(c.deployedProbe.launchedAtMs)&&
     c.deployedProbe.launchedAtMs>0&&
     Number.isSafeInteger(c.deployedProbe.recoveredAtMs)&&
     c.deployedProbe.recoveredAtMs>=c.deployedProbe.launchedAtMs)));
   if(!charges.length)continue;
   if(new Set(charges.map(x=>x.cargoID)).size!==charges.length)
    return fail("NATIVE_SCANNER_CHARGE_ID_AMBIGUOUS");
   // A positive readiness report is still NOT permission to launch or debit.
   // Return only proof of original, finite source inventory. Native world
   // mutation must be separately transactional and idempotent.
   return {status:"NATIVE_SCANNER_HARDWARE_READY",ready:true,
    systemID:scene.systemID,entityID,pilotID:names[0].pilotID,
    ownerID:entity.ownerID,corporationID:entity.corporationID,
    launcherID:launcher.moduleID,launcherTypeID:launcher.typeID,
    probeTypeIDs:[...new Set(charges.map(c=>c.typeID))],
    availableUnits:charges.reduce((n,c)=>n+c.quantity,0),
    originalCargoIDs:charges.map(c=>c.cargoID)};
  }
  return fail("NATIVE_COMPATIBLE_PROBE_CHARGES_MISSING");
 }
 return Object.freeze({check});
}
module.exports={createNpcProbeHardware,SCANNER_LAUNCHER_GROUP,SCANNER_PROBE_GROUP};
