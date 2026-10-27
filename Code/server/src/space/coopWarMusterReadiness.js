"use strict";
// FW-003C: prove an existing physical patrol NPC has a genuine native fitted
// weapon and usable *loaded* ammo (or real charge-optional turret). Pure read:
// never generates hulls, repairs, cargo, charges, or a wallet transfer.
const pos=x=>Number.isSafeInteger(x)&&x>0;
const FAMILIES=new Set(["missileLauncher","projectileTurret","hybridTurret","precursorTurret","laserTurret"]);
function createWarMusterReadiness({store,resolveFamily,isOptional,compatible}={}){
 if(!store||["getNativeEntity","listNativeModulesForEntity","listNativeCargoForEntity"]
  .some(k=>typeof store[k]!=="function")||
  [resolveFamily,isOptional,compatible].some(fn=>typeof fn!=="function"))
  throw Error("WAR_MUSTER_NATIVE_AMMO_AUTHORITIES_REQUIRED");
 function inspect({entityID,ship,systemID,corporationID}={}){
  const fail=reason=>({ready:false,reason});
  if(!pos(entityID)||!pos(systemID)||!pos(corporationID)||
   ship?.kind!=="ship"||ship.nativeNpc!==true||ship.itemID!==entityID||
   ship.corporationID!==corporationID||ship.session?.characterID)
   return fail("PHYSICAL_WAR_HULL_NOT_VERIFIED");
  try{
   const native=store.getNativeEntity(entityID);
   if(native?.entityID!==entityID||native.systemID!==systemID||
    native.corporationID!==corporationID||!pos(native.ownerID)||
    !pos(ship.ownerID)||ship.ownerID!==native.ownerID)
    return fail("NATIVE_WAR_OWNER_MISMATCH");
   const modules=store.listNativeModulesForEntity(entityID),
    cargo=store.listNativeCargoForEntity(entityID);
   if(!Array.isArray(modules)||!Array.isArray(cargo)||
    modules.length>128||cargo.length>2048)return fail("WAR_FITTING_UNAVAILABLE");
   const seen=new Set();
   let armed=0;
   for(const m of modules){
    if(m?.entityID!==entityID||m.ownerID!==native.ownerID||
     !pos(m.moduleID)||seen.has(m.moduleID))return fail("WAR_FITTING_IDENTITY_CONFLICT");
    seen.add(m.moduleID);
    if(m.categoryID!==7||!pos(m.typeID)||!pos(m.flagID)||
     m.moduleState?.online===false||m.moduleState?.isOnline===false)continue;
    const item={...m,itemID:m.moduleID};
    const family=resolveFamily(item);
    if(!FAMILIES.has(family))continue;
    if(isOptional(item)===true&&family!=="missileLauncher"){
     armed++;continue;
    }
    const charges=cargo.filter(c=>c?.moduleID===m.moduleID);
    if(charges.length!==1)continue;
    const c=charges[0];
    if(!pos(c.cargoID)||c.entityID!==entityID||
     c.ownerID!==native.ownerID||c.categoryID!==8||
     !pos(c.typeID)||!pos(c.quantity)||c.transient===true)continue;
    if(compatible(m,c.typeID)===true)armed++;
   }
   return armed>0?{ready:true,armedModuleCount:armed}:
    fail("WAR_NO_NATIVE_LOADED_WEAPON");
  }catch{return fail("WAR_NATIVE_READ_UNAVAILABLE")}
 }
 return Object.freeze({inspect});
}
module.exports={createWarMusterReadiness};
