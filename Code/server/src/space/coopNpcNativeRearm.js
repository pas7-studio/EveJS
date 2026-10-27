"use strict";
// Native market-funded NPC charge fitting. A bought cargo stack is bound to
// ONE already-fitted real module; no charge mint, fabricated ship repair,
// synthetic weapon or player wallet action.
const fs=require("node:fs"),path=require("node:path");
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
const vec=p=>p&&["x","y","z"].every(k=>Number.isFinite(p[k]));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function createNativeRearm({store,registry,sceneForSystem,getController,getStation,
 resolveType,compatible,verifyCombatCharge,root,clock=()=>Date.now()}={}){
 if(!store||!["getNativeEntity","listNativeModulesForEntity",
  "listNativeCargoForEntity","upsertNativeCargo","buildNativeCargoItems",
  "buildNativeFittedItems"].every(k=>typeof store[k]==="function")||
  typeof registry?.snapshot!=="function"||
  typeof sceneForSystem!=="function"||typeof getController!=="function"||
  typeof getStation!=="function"||typeof resolveType!=="function"||
  typeof compatible!=="function"||typeof verifyCombatCharge!=="function"||
  typeof root!=="string"||!path.isAbsolute(root)||typeof clock!=="function")
  throw Error("INVALID_NPC_NATIVE_REARM_DEPENDENCIES");
 const locks=new Set(),moduleLocks=new Set();
 const receiptPath=cargoID=>path.join(root,"purchases",String(cargoID)+".json");
 const lockPath=cargoID=>path.join(root,"rearm-locks",String(cargoID)+".lock");
 // Distinct cargo stacks must never be loaded into the same native weapon
 // concurrently, including across independent adapter instances/processes.
 const moduleLockPath=(shipID,moduleID)=>path.join(root,"rearm-module-locks",
  String(shipID)+"-"+String(moduleID)+".lock");
 function receiptFor(cargo,pilotID,entityID,systemID){
  if(!id(cargo?.cargoID)||!id(cargo?.typeID)||!id(cargo?.quantity)||
   !id(entityID)||!id(systemID)||!named(pilotID))return null;
  let r;
  try{r=JSON.parse(fs.readFileSync(receiptPath(cargo.cargoID),"utf8"));}
  catch(_){return null;}
  if(r?.version!==1||r.phase!=="SETTLED"||
   r.source!=="EVEJS_SEED_MARKET"||r.pilotID!==pilotID||
   Number(r.entityID)!==entityID||Number(r.systemID)!==systemID||
   Number(r.cargoID)!==Number(cargo.cargoID)||
   Number(r.typeID)!==Number(cargo.typeID)||
   Number(r.quantity)!==Number(cargo.quantity)||
   !id(r.stationID)||typeof r.marketOrderID!=="string"||
   !/^[0-9]+$/.test(r.marketOrderID)||
   !Number.isFinite(Number(r.price))||Number(r.price)<=0)
   return null;
  return r;
 }
 function liveContext({pilotID,entityID,systemID,stationID}={}){
  const shipID=id(entityID),system=id(systemID),station=id(stationID);
  if(!named(pilotID)||!shipID||!system||!station)return null;
  const link=registry.snapshot()?.links?.[pilotID];
  if(Number(link?.entityID)!==shipID||Number(link?.systemID)!==system)return null;
  if(Object.values(registry.snapshot()?.links||{}).filter(x=>
   Number(x?.entityID)===shipID&&Number(x?.systemID)===system).length!==1)
   return null;
  const scene=sceneForSystem(system),ship=scene?.getEntityByID?.(shipID);
  const pos=scene?.staticEntities?.find(e=>e?.kind==="station"&&
   Number(e.itemID)===station&&vec(e.position));
  const worldStation=getStation(station),native=store.getNativeEntity(shipID);
  if(Number(scene?.systemID)!==system||ship?.kind!=="ship"||
   ship.nativeNpc!==true||Number(ship.itemID)!==shipID||
   ship.session?.characterID||ship.pendingWarp||ship.warpState||
   String(ship.mode||"").toUpperCase().includes("WARP")||
   !vec(ship.position)||!pos||
   distance(ship.position,pos.position)>
    5000+Math.max(0,Number(ship.radius)||0)+Math.max(0,Number(pos.radius)||0)||
   Number(worldStation?.solarSystemID)!==system||
   Number(worldStation?.stationID||worldStation?.itemID)!==station||
   !native||Number(native.entityID)!==shipID||
   Number(native.ownerID)<=0||Number(native.systemID)!==system||
   [...scene.sessions?.values?.()||[]].some(s=>Number(s?._space?.shipID)===shipID))
   return null;
  const controller=getController(shipID);
  if(Number(controller?.entityID)!==shipID||
   Number(controller?.systemID)!==system||
   Number(controller?.currentTargetID)>0||
   controller.manualOrder?.type==="attack"||
   (Number(controller.lastAggressorID)>0&&
     clock()-Number(controller.lastAggressedAtMs||0)>=0&&
     clock()-Number(controller.lastAggressedAtMs||0)<120000))
   return null;
  const modules=store.listNativeModulesForEntity(shipID),
   cargo=store.listNativeCargoForEntity(shipID);
  if(!Array.isArray(modules)||!Array.isArray(cargo))return null;
  return {ship,scene,native,modules,cargo,shipID,system,station};
 }
 function candidates({pilotID,entityID,systemID,stationID,allowedTypes=[]}={}){
  const ctx=liveContext({pilotID,entityID,systemID,stationID});
  if(!ctx||!Array.isArray(allowedTypes))return {status:"NO_NATIVE_STATION_OR_SHIP"};
  const types=[...new Set(allowedTypes.map(id).filter(Boolean))].slice(0,24);
  if(!types.length)return {status:"NO_ALLOWLISTED_CHARGES"};
  const modules=ctx.modules.filter(m=>Number(m.entityID)===ctx.shipID&&
   Number(m.ownerID)===Number(ctx.native.ownerID)&&id(m.moduleID)&&
   id(m.flagID)&&Number(m.categoryID)===7&&
   m.moduleState?.online!==false&&m.moduleState?.isOnline!==false)
   .sort((a,b)=>Number(a.moduleID)-Number(b.moduleID));
  const slotCount=new Map();
  for(const m of modules)slotCount.set(m.moduleID,
   (slotCount.get(m.moduleID)||0)+1);
  for(const m of modules){
   if(slotCount.get(m.moduleID)!==1)continue;
   // Never displace actual loaded charges. A weapon with no real fitting
   // does not get an invented module or new synthetic capability.
   if(ctx.cargo.some(c=>Number(c.moduleID)===Number(m.moduleID)))continue;
   for(const typeID of types){
    const type=resolveType(typeID);
    if(Number(type?.categoryID)!==8||
     !Number.isFinite(Number(type.volume))||Number(type.volume)<0||
     compatible(m,typeID)!==true)continue;
    const purchased=ctx.cargo.filter(c=>Number(c.entityID)===ctx.shipID&&
     Number(c.ownerID)===Number(ctx.native.ownerID)&&
     Number(c.moduleID||0)===0&&Number(c.typeID)===typeID&&
     c.singleton!==true&&id(c.quantity)&&
     receiptFor(c,pilotID,ctx.shipID,ctx.system));
    if(purchased.length){
     purchased.sort((a,b)=>Number(a.cargoID)-Number(b.cargoID));
     return {status:"REARM_READY",moduleID:Number(m.moduleID),
      typeID,cargoID:Number(purchased[0].cargoID),stationID:ctx.station};
    }
    return {status:"REARM_NEEDS_PURCHASE",moduleID:Number(m.moduleID),
     typeID,stationID:ctx.station};
   }
  }
  return {status:"NO_NATIVE_UNLOADED_COMPATIBLE_MODULE"};
 }
 function load({pilotID,entityID,systemID,stationID,cargoID,moduleID}={}){
  const shipID=id(entityID),cargoKey=id(cargoID),moduleKey=id(moduleID);
  if(!shipID||!cargoKey||!moduleKey)return {status:"INVALID_REARM_REQUEST"};
  const moduleLease=shipID+":"+moduleKey;
  if(locks.has(cargoKey)||moduleLocks.has(moduleLease))
   return {status:"NATIVE_REARM_BUSY"};
  locks.add(cargoKey);moduleLocks.add(moduleLease);
  let descriptor=null,moduleDescriptor=null,cargoOwned=false,moduleOwned=false;
  try{
   fs.mkdirSync(path.dirname(lockPath(cargoKey)),{recursive:true});
   descriptor=fs.openSync(lockPath(cargoKey),"wx",0o600);
   cargoOwned=true;
   fs.writeFileSync(descriptor,JSON.stringify({version:1,pid:process.pid,
    at:clock(),cargoID:cargoKey,moduleID:moduleKey}));
   fs.fsyncSync(descriptor);
   fs.mkdirSync(path.dirname(moduleLockPath(shipID,moduleKey)),{recursive:true});
   moduleDescriptor=fs.openSync(moduleLockPath(shipID,moduleKey),"wx",0o600);
   moduleOwned=true;
   fs.writeFileSync(moduleDescriptor,JSON.stringify({version:1,pid:process.pid,
    at:clock(),shipID,moduleID:moduleKey,cargoID:cargoKey}));
   fs.fsyncSync(moduleDescriptor);
  }catch(_){
   if(moduleDescriptor!==null){try{fs.closeSync(moduleDescriptor);}catch(_){}}
   if(descriptor!==null){try{fs.closeSync(descriptor);}catch(_){}}
   if(moduleOwned){try{fs.unlinkSync(moduleLockPath(shipID,moduleKey));}catch(_){}}
   if(cargoOwned){try{fs.unlinkSync(lockPath(cargoKey));}catch(_){}}
   locks.delete(cargoKey);moduleLocks.delete(moduleLease);
   return {status:"NATIVE_REARM_LOCK_UNSAFE"};
  }
  try{
   const ctx=liveContext({pilotID,entityID,systemID,stationID});
   if(!ctx)return {status:"NO_NATIVE_STATION_OR_SHIP"};
   const modules=ctx.modules.filter(m=>Number(m.moduleID)===moduleKey&&
    Number(m.entityID)===shipID&&
    Number(m.ownerID)===Number(ctx.native.ownerID)&&
    Number(m.categoryID)===7&&id(m.flagID)&&
    m.moduleState?.online!==false);
   if(modules.length!==1)return {status:"NATIVE_MODULE_NOT_UNIQUE"};
   const module=modules[0],matches=ctx.cargo.filter(c=>Number(c.cargoID)===cargoKey);
   if(matches.length!==1)return {status:"NATIVE_PURCHASED_CARGO_MISSING"};
   const row=matches[0],receipt=receiptFor(row,pilotID,shipID,ctx.system);
   if(!receipt||Number(receipt.stationID)!==ctx.station||
    Number(row.ownerID)!==Number(ctx.native.ownerID)||
    row.singleton===true||row.transient===true||
    Number(row.categoryID)!==8||!id(row.quantity)||
    compatible(module,Number(row.typeID))!==true)
    return {status:"NATIVE_PURCHASE_RECEIPT_NOT_VERIFIED"};
   const allLoaded=ctx.cargo.filter(c=>Number(c.moduleID)===moduleKey);
   if(Number(row.moduleID)===moduleKey&&allLoaded.length===1){
    if(Number(row.flagID)!==Number(module.flagID))
     return {status:"NATIVE_REARM_OUTCOME_UNVERIFIED"};
    // After a crash or cache failure, a stored moduleID alone does not
    // attest that the real fitted weapon can see and consume this charge.
    const cachedCargo=store.buildNativeCargoItems(shipID),
     cachedFitted=store.buildNativeFittedItems(shipID);
    if(!Array.isArray(cachedCargo)||!Array.isArray(cachedFitted))
     return {status:"NATIVE_REARM_CACHE_UNVERIFIED"};
    ctx.ship.nativeCargoItems=cachedCargo;ctx.ship.fittedItems=cachedFitted;
    const exactlyOne=cachedCargo.filter(c=>Number(c.itemID)===cargoKey&&
     Number(c.moduleID)===moduleKey&&Number(c.typeID)===Number(row.typeID)&&
     Number(c.quantity)===Number(row.quantity)&&
     Number(c.ownerID)===Number(row.ownerID));
    const fitted=cachedFitted.filter(m=>Number(m.itemID)===moduleKey);
    const charge=fitted.length===1&&verifyCombatCharge(ctx.ship,fitted[0]);
    if(exactlyOne.length!==1||!charge||Number(charge.itemID)!==cargoKey||
       Number(charge.typeID)!==Number(row.typeID))
     return {status:"NATIVE_REARM_COMBAT_VISIBILITY_UNVERIFIED"};
    return {status:"ALREADY_LOADED",cargoID:cargoKey,moduleID:moduleKey};
   }
   if(Number(row.moduleID||0)!==0||allLoaded.length)
    return {status:"NATIVE_MODULE_ALREADY_LOADED"};
   const update={...row,moduleID:moduleKey,flagID:Number(module.flagID)};
   const result=store.upsertNativeCargo(update,{transient:false});
   const latest=store.listNativeCargoForEntity(shipID).filter(c=>
    Number(c.cargoID)===cargoKey);
   if(latest.length!==1||Number(latest[0].moduleID)!==moduleKey||
    Number(latest[0].typeID)!==Number(row.typeID)||
    Number(latest[0].quantity)!==Number(row.quantity)||
    Number(latest[0].ownerID)!==Number(row.ownerID))
    return {status:"NATIVE_REARM_OUTCOME_UNVERIFIED"};
   const items=store.buildNativeCargoItems(shipID),
    fitted=store.buildNativeFittedItems(shipID);
   if(!Array.isArray(items)||!Array.isArray(fitted))
    return {status:"NATIVE_REARM_CACHE_UNVERIFIED"};
   ctx.ship.nativeCargoItems=items;
   ctx.ship.fittedItems=fitted;
   const fittedModule=fitted.find(m=>Number(m.itemID)===moduleKey);
   const charge=fittedModule&&verifyCombatCharge(ctx.ship,fittedModule);
   if(!charge||Number(charge.itemID)!==cargoKey||
    Number(charge.typeID)!==Number(row.typeID))
    return {status:"NATIVE_REARM_COMBAT_VISIBILITY_UNVERIFIED"};
   return {status:"NATIVE_NPC_CHARGE_LOADED",pilotID,
    entityID:shipID,systemID:ctx.system,cargoID:cargoKey,
    moduleID:moduleKey,typeID:Number(row.typeID),
    quantity:Number(row.quantity),source:"REAL_EVEJS_SEEDED_PURCHASE",
    nativeModuleVisible:true,iskGranted:false,
    cargoItemsCreated:0};
  }catch(error){
   return {status:"NATIVE_REARM_REPAIR_REQUIRED",
    reason:String(error?.message||error).slice(0,100)};
  }finally{
   try{fs.closeSync(moduleDescriptor);}catch(_){}
   try{fs.closeSync(descriptor);}catch(_){}
   if(moduleOwned){try{fs.unlinkSync(moduleLockPath(shipID,moduleKey));}catch(_){}}
   if(cargoOwned){try{fs.unlinkSync(lockPath(cargoKey));}catch(_){}}
   locks.delete(cargoKey);moduleLocks.delete(moduleLease);
  }
 }
 return {candidates,load,receiptFor};
}
module.exports={createNativeRearm};
