"use strict";
// Read-only: observe ACTUAL native loaded-charge stock deltas, never infer
// combat damage/hits from target locks or create/debit any game item.
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
function createAmmoWitness({store,maxShips=150,maxEvents=15}={}){
 if(!store||typeof store.getNativeEntity!=="function"||
  typeof store.listNativeCargoForEntity!=="function"||
  typeof store.listNativeModulesForEntity!=="function"||
  !Number.isInteger(maxShips)||maxShips<1||maxShips>1000||
  !Number.isInteger(maxEvents)||maxEvents<1||maxEvents>100)
  throw Error("INVALID_NATIVE_AMMO_WITNESS");
 const snapshots=new Map();
 function sample({scene,assignments=[]}={}){
  const systemID=id(scene?.systemID),events=[];
  if(!systemID||typeof scene.getEntityByID!=="function"||
   !Array.isArray(assignments))return {status:"INVALID_NATIVE_SCENE",events};
  const seen=new Set(),shipCount=new Map();
  for(const row of assignments)if(id(row?.entityID)&&id(row?.systemID)===systemID)
   shipCount.set(Number(row.entityID),(shipCount.get(Number(row.entityID))||0)+1);
  for(const a of assignments.slice(0,maxShips)){
   const entityID=id(a?.entityID),pilotID=a?.pilotID;
   if(!entityID||!named(pilotID)||Number(a.systemID)!==systemID||
    seen.has(entityID)||shipCount.get(entityID)!==1)continue;
   seen.add(entityID);
   const ship=scene.getEntityByID(entityID),native=store.getNativeEntity(entityID);
   if(ship?.nativeNpc!==true||ship.kind!=="ship"||
    Number(ship.itemID)!==entityID||ship.session?.characterID||
    !native||Number(native.entityID)!==entityID||
    Number(native.systemID)!==systemID||!id(native.ownerID)){
    snapshots.delete(entityID);continue;
   }
   const ownerID=Number(native.ownerID);
   const modules=store.listNativeModulesForEntity(entityID),
    cargo=store.listNativeCargoForEntity(entityID);
   if(!Array.isArray(modules)||!Array.isArray(cargo))continue;
   const moduleIDs=new Set(modules.filter(m=>Number(m.entityID)===entityID&&
    Number(m.ownerID)===ownerID&&Number(m.categoryID)===7&&id(m.moduleID))
    .map(m=>Number(m.moduleID)));
   const active=new Map();
   for(const item of cargo){
    const cargoID=id(item?.cargoID),moduleID=id(item?.moduleID);
    if(!cargoID||!moduleID||!moduleIDs.has(moduleID)||
     Number(item.entityID)!==entityID||
     Number(item.ownerID)!==ownerID||
     Number(item.categoryID)!==8||!id(item.typeID)||
     !Number.isSafeInteger(Number(item.quantity))||
     Number(item.quantity)<1||item.transient===true)continue;
    active.set(cargoID,{cargoID,moduleID,typeID:Number(item.typeID),
     quantity:Number(item.quantity)});
   }
   const previous=snapshots.get(entityID);
   if(previous&&previous.ownerID===ownerID&&
    previous.pilotID===pilotID&&previous.systemID===systemID){
    for(const [cargoID,before] of previous.charges){
     const after=active.get(cargoID);
     if(after&&(after.typeID!==before.typeID||
      after.moduleID!==before.moduleID))continue;
     if(!moduleIDs.has(before.moduleID))continue;
     const remaining=after?.quantity||0;
     if(remaining>=before.quantity)continue;
     if(events.length>=maxEvents)break;
     events.push({status:"NATIVE_CHARGE_STOCK_DECREASED",
      pilotID,systemID,entityID,cargoID,
      moduleID:before.moduleID,typeID:before.typeID,
      before:before.quantity,after:remaining,
      unitsDebited:before.quantity-remaining,
      source:"NATIVE_NPC_CARGO_STORE",observedShot:false});
    }
   }
   snapshots.set(entityID,{systemID,pilotID,ownerID,charges:active});
  }
  while(snapshots.size>maxShips)snapshots.delete(snapshots.keys().next().value);
  return {status:"OK",events};
 }
 return {sample};
}
module.exports={createAmmoWitness};
