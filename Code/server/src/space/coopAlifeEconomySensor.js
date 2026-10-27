"use strict";
// COOP-042 A-Life native perception adapter: physical scene + named pilot +
// controller + real cargo + real SDE station. No simulation and no side effects.
const pos=x=>Number.isSafeInteger(x)&&x>0;
const vec=x=>x&&["x","y","z"].every(a=>Number.isFinite(x[a]));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function readEconomySnapshot({systemID,scene,links=[],roles=new Map(),
 getController,getStation,getNativeEntity,listNativeCargo,readStationEconomy=()=>null,
 inspectNativeAmmo=()=>null,
 clock=()=>Date.now()}={}){
 const invalid=(reason)=>({authoritativeNative:false,systemID,reason});
 if(!pos(systemID)||Number(scene?.systemID)!==systemID||
    typeof scene?.getEntityByID!=="function"||!Array.isArray(links)||
    !(roles instanceof Map)||typeof getController!=="function"||
    typeof getStation!=="function"||typeof getNativeEntity!=="function"||
    typeof listNativeCargo!=="function"||
    typeof readStationEconomy!=="function"||typeof inspectNativeAmmo!=="function"||
    typeof clock!=="function")
  return invalid("NATIVE_SCENE_SENSOR_DEPENDENCIES");
 const at=clock();
 if(!Number.isSafeInteger(at)||at<0)return invalid("NATIVE_SENSOR_CLOCK_INVALID");
 const stations=[];
 const seen=new Set();
 for(const x of scene.staticEntities||[]){
  const stationID=Number(x?.itemID);
  if(x?.kind!=="station"||!pos(stationID)||!vec(x.position)||seen.has(stationID))continue;
  let native;
  try{native=getStation(stationID)}catch(_error){return invalid("NATIVE_STATION_METADATA_UNAVAILABLE")}
  if(Number(native?.stationID??native?.itemID)!==stationID||
     Number(native.solarSystemID)!==systemID)continue;
  let economy=null;
  try{economy=readStationEconomy(stationID)}catch(_error){economy=null}
  if(economy?.authoritativeNative!==true)economy=null;
  seen.add(stationID);
  stations.push({stationID,systemID,nativeVerified:true,position:x.position,
    radius:Number.isFinite(x.radius)?Math.max(0,x.radius):0,economy});
 }
 const unique=new Map(),collisions=new Set();
 for(const link of links){
  if(!/^coop-pilot-[0-9]{3,}$/.test(String(link?.pilotID||""))||
     !pos(Number(link?.entityID))||Number(link?.systemID)!==systemID)continue;
  const pilotID=link.pilotID,id=Number(link.entityID);
  if(unique.has(pilotID)&&(unique.get(pilotID)?.entityID!==id))collisions.add(pilotID);
  else unique.set(pilotID,{pilotID,entityID:id});
 }
 if(collisions.size)return invalid("NATIVE_PILOT_LINK_COLLISION");
 const ownedHull=new Set(),pilots=[],omitted=[];
 for(const link of [...unique.values()].sort((a,b)=>a.pilotID.localeCompare(b.pilotID))){
  const role=roles.get(link.pilotID);
  if(!["miner","hauler","trader","patrol","pirate"].includes(role))continue;
  if(ownedHull.has(link.entityID))return invalid("NATIVE_ENTITY_LINK_COLLISION");
  ownedHull.add(link.entityID);
  let ship,controller,cargo,native;
  try{
   native=getNativeEntity(link.entityID);
   ship=scene.getEntityByID(link.entityID);
   controller=getController(link.entityID);
   cargo=listNativeCargo(link.entityID);
  }catch(_error){omitted.push({pilotID:link.pilotID,reason:"NATIVE_ACTOR_READ_FAILED"});continue}
  if(!native||Number(native.entityID)!==link.entityID||
     Number(native.systemID)!==systemID||!pos(Number(native.ownerID))||
     ship?.kind!=="ship"||ship.nativeNpc!==true||
     Number(ship.itemID)!==link.entityID||ship.session?.characterID||
     Number(controller?.entityID)!==link.entityID||
     Number(controller?.systemID)!==systemID||!vec(ship.position)||
     !Array.isArray(cargo)||!Number.isFinite(ship.hpRatio)){
   omitted.push({pilotID:link.pilotID,reason:"NATIVE_HULL_OR_CONTROLLER_NOT_VERIFIED"});continue;
  }
  if(cargo.some(i=>Number(i?.entityID)!==link.entityID||
      Number(i?.ownerID)!==Number(native.ownerID)||
      !Number.isSafeInteger(Number(i?.quantity))||Number(i.quantity)<0)){
   omitted.push({pilotID:link.pilotID,reason:"NATIVE_CARGO_PROVENANCE_INVALID"});continue;
  }
  const sorted=[...stations].sort((a,b)=>dist(ship.position,a.position)-dist(ship.position,b.position));
  const nearest=sorted[0]||null;
  const radius=Math.max(0,Number(ship.radius)||0);
  const atStation=Boolean(nearest&&dist(ship.position,nearest.position) <=10000+
     nearest.radius+radius);
  const hp=ship.hpRatio;
  const ore=cargo.filter(i=>Number(i.categoryID)===25).reduce((a,i)=>a+Number(i.quantity),0);
  const ammo=cargo.filter(i=>Number(i.categoryID)===8).reduce((a,i)=>a+Number(i.quantity),0);
  if(!Number.isSafeInteger(ore)||!Number.isSafeInteger(ammo)||hp<0||hp>1){
   omitted.push({pilotID:link.pilotID,reason:"NATIVE_CARGO_OR_HP_INVALID"});continue;
  }
  let ammoState="UNVERIFIED";
  try{const inspected=inspectNativeAmmo(link.entityID,link.pilotID);
   if(["AMMO_EXHAUSTED","AMMO_AVAILABLE","NOT_APPLICABLE"].includes(inspected?.status))
    ammoState=inspected.status;
  }catch(_error){} // No native ammo proof means no resupply intent.
  pilots.push({pilotID:link.pilotID,entityID:link.entityID,systemID,role,
   ownerID:Number(native.ownerID),
   nativeVerified:true,playerControlled:false,health:hp,
   underAttack:Number(controller.currentTargetID)>0||
    controller.manualOrder?.type==="attack",
   inWarp:Boolean(ship.pendingWarp||ship.warpState||
    String(ship.mode||"").toUpperCase().includes("WARP")),
   activeNativeOrder:Boolean(controller.manualOrder&&controller.manualOrder.type!=="idle"),
   cargoOreQuantity:ore,cargoAmmoQuantity:ammo,ammoState,
   stationID:nearest?.stationID||null,atStation});
 }
 return{authoritativeNative:true,systemID,observedAt:at,stations,pilots,omitted,
  source:"NATIVE_SCENE_CONTROLLER_CARGO_SDE"};
}
module.exports={readEconomySnapshot};
