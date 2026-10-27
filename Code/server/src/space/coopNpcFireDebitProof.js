"use strict";
// Fail-closed authoritative preflight for the existing pinned EveJS fire-cycle
// debit. No invented shot, no shadow inventory and no write side effects.
const positive=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
function createFireDebitProof({store,compatible,env=process.env}={}){
 if(typeof compatible!=="function")
  compatible=require("./npc/npcCapabilityResolver").isNpcChargeCompatibleWithModule;
 if(!store||["getNativeEntity","listNativeModulesForEntity",
  "listNativeCargoForEntity"].some(k=>typeof store[k]!=="function"))
  throw Error("INVALID_NATIVE_FIRE_PROOF_DEPENDENCIES");
 function verify({entity,moduleItem,chargeItem,quantity=1}={}){
  if(env.EVEJS_COOP_NPC_STRICT_AMMO!=="1"||
   entity?.nativeNpc!==true||entity?.kind!=="ship")
   return {allowed:true,status:"LEGACY_UNCHANGED"};
  const entityID=positive(entity.itemID),moduleID=positive(moduleItem?.itemID),
   cargoID=positive(chargeItem?.itemID),requested=positive(quantity);
  if(!entityID||!moduleID||!cargoID||!requested||
   !positive(chargeItem?.typeID)||!positive(entity.ownerID))
   return {allowed:false,status:"NATIVE_FIRE_IDENTITY_MISSING"};
  try{
   const ship=store.getNativeEntity(entityID);
   if(!ship||Number(ship.entityID)!==entityID||
    Number(ship.ownerID)!==Number(entity.ownerID)||
    !positive(ship.systemID))
    return {allowed:false,status:"NATIVE_FIRE_SHIP_NOT_VERIFIED"};
   const modules=store.listNativeModulesForEntity(entityID);
   const cargo=store.listNativeCargoForEntity(entityID);
   if(!Array.isArray(modules)||!Array.isArray(cargo))
    return {allowed:false,status:"NATIVE_FIRE_INVENTORY_UNAVAILABLE"};
   const fitted=modules.filter(m=>Number(m.moduleID)===moduleID);
   if(fitted.length!==1||Number(fitted[0].entityID)!==entityID||
    Number(fitted[0].ownerID)!==Number(ship.ownerID)||
    Number(fitted[0].categoryID)!==7||
    Number(fitted[0].flagID)!==Number(moduleItem.flagID))
    return {allowed:false,status:"NATIVE_FIRE_MODULE_NOT_VERIFIED"};
   const rows=cargo.filter(x=>Number(x.cargoID)===cargoID);
   if(rows.length!==1)return {allowed:false,status:"NATIVE_FIRE_CARGO_MISSING"};
   const row=rows[0];
   // A native charge row is bound to its turret by `moduleID`; the native cargo
   // writer does not stamp `flagID` on cargo at all. Demanding that optional
   // field made every strict-ammo turret cycle fail as a forged charge, so a
   // fully loaded real warship could activate a module and never apply damage.
   // The flag is still enforced whenever the row really carries one.
   const rowFlag=row.flagID;
   if(Number(row.entityID)!==entityID||
    Number(row.ownerID)!==Number(ship.ownerID)||
    Number(row.categoryID)!==8||
    Number(row.moduleID)!==moduleID||
    Number(row.typeID)!==Number(chargeItem.typeID)||
    (rowFlag!==undefined&&rowFlag!==null&&
     Number(rowFlag)!==Number(moduleItem.flagID))||
    compatible(fitted[0],Number(row.typeID))!==true||
    !Number.isSafeInteger(Number(row.quantity))||
    Number(row.quantity)<requested||
    Number(row.quantity)!==Number(chargeItem.quantity??chargeItem.stacksize))
    return {allowed:false,status:"NATIVE_FIRE_STALE_OR_FORGED_CHARGE"};
   return {allowed:true,status:"NATIVE_FIRE_CARGO_VERIFIED",
    cargoID,moduleID,quantity:Number(row.quantity)};
  }catch(_){return {allowed:false,status:"NATIVE_FIRE_PROOF_UNAVAILABLE"};}
 }
 function verifyBank({entity,entries=[],quantity=1}={}){
  if(env.EVEJS_COOP_NPC_STRICT_AMMO!=="1"||
   entity?.nativeNpc!==true||entity?.kind!=="ship")
   return {allowed:true,status:"LEGACY_UNCHANGED"};
  if(!Array.isArray(entries)||!entries.length||entries.length>16)
   return {allowed:false,status:"NATIVE_FIRE_EMPTY_BANK"};
  const seenModules=new Set(),seenCargo=new Set();
  for(const row of entries){
   const m=positive(row?.moduleItem?.itemID),
    c=positive(row?.chargeItem?.itemID);
   if(!m||!c||seenModules.has(m)||seenCargo.has(c))
    return {allowed:false,status:"NATIVE_FIRE_BANK_DUPLICATE"};
   seenModules.add(m);seenCargo.add(c);
   const result=verify({entity,moduleItem:row.moduleItem,
    chargeItem:row.chargeItem,quantity});
   if(!result.allowed)return result;
  }
  return {allowed:true,status:"NATIVE_FIRE_BANK_VERIFIED",
   weaponCount:seenModules.size};
 }
 return {verify,verifyBank};
}
function verify(args={}){
 const entity=args.entity;
 if(process.env.EVEJS_COOP_NPC_STRICT_AMMO!=="1"||
  entity?.nativeNpc!==true||entity?.kind!=="ship")
  return {allowed:true,status:"LEGACY_UNCHANGED"};
 try{return createFireDebitProof({
  store:require("./npc/nativeNpcStore")
 }).verify(args);}
 catch(_){return {allowed:false,status:"NATIVE_FIRE_PROOF_UNAVAILABLE"};}
}
function verifyBank(args={}){
 const entity=args.entity;
 if(process.env.EVEJS_COOP_NPC_STRICT_AMMO!=="1"||
  entity?.nativeNpc!==true||entity?.kind!=="ship")
  return {allowed:true,status:"LEGACY_UNCHANGED"};
 try{return createFireDebitProof({
  store:require("./npc/nativeNpcStore")
 }).verifyBank(args);}
 catch(_){return {allowed:false,status:"NATIVE_FIRE_PROOF_UNAVAILABLE"};}
}
module.exports={createFireDebitProof,verify,verifyBank};
