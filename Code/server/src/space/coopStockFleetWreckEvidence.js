"use strict";
// Never create a wreck or loot. Verify a stock EveJS mining ship
// destroyed by the native engine against its real fleet membership,
// physical wreck entity and persisted native wreck inventory.
const positive=n=>Number.isSafeInteger(Number(n))&&Number(n)>0?Number(n):null;
function verifyStockFleetWreck({systemID,ship,wreckID,scene,
 fleets=[],getWreck,getWreckItems}={}){
 const system=positive(systemID),shipID=positive(ship?.itemID),wreck=positive(wreckID);
 if(!system||!shipID||!wreck||!Array.isArray(fleets)||
  ship.kind!=="ship"||ship.nativeNpc!==true||
  Number(scene?.systemID)!==system||
  typeof scene?.getEntityByID!=="function"||
  typeof getWreck!=="function"||typeof getWreckItems!=="function")
  return {status:"INVALID_STOCK_WRECK"};
 // Native ship may have left the scene after death; never infer
 // stock-fleet membership from a role label or a stored co-op name.
 const membership=[];
 for(const fleet of fleets){
  if(Number(fleet?.systemID)!==system)continue;
  for(const [role,key] of [["miner","minerEntityIDs"],["hauler","haulerEntityIDs"]]){
   if((fleet?.[key]||[]).some(id=>Number(id)===shipID))membership.push(role);
  }
 }
 if(membership.length!==1)return {status:"NOT_ACTIVE_NATIVE_STOCK_FLEET"};
 let row,items;
 try{row=getWreck(wreck);items=getWreckItems(wreck);}
 catch(_error){return {status:"NATIVE_WRECK_STORE_UNAVAILABLE"};}
 if(!row||!Array.isArray(items)||
  Number(row.wreckID)!==wreck||Number(row.systemID)!==system||
  Number(row.sourceEntityID)!==shipID||Number(row.launcherID)!==shipID)
  return {status:"STOCK_WRECK_NOT_VERIFIED"};
 const physical=scene.getEntityByID(wreck);
 if(physical?.nativeNpcWreck!==true||Number(physical.itemID)!==wreck||
  Number(physical.launcherID)!==shipID)return {status:"STOCK_WRECK_NOT_PHYSICAL"};
 if(!items.every(item=>positive(item?.wreckItemID)&&Number(item.wreckID)===wreck&&
  positive(item.typeID)&&Number.isFinite(Number(item.quantity))&&Number(item.quantity)>0))
  return {status:"INVALID_STOCK_WRECK_ITEMS"};
 return {status:"PHYSICAL_NATIVE_STOCK_FLEET_WRECK_VERIFIED",
  systemID:system,victimEntityID:shipID,victimRole:membership[0],
  wreckID:wreck,storedItemCount:items.length,
  storedQuantity:items.reduce((n,item)=>n+Number(item.quantity),0),
  lootStatus:items.length?"ITEMS_STORED":"NATIVE_WRECK_EMPTY",
  attribution:"REAL_NATIVE_MINING_FLEET_MEMBERSHIP_AND_WRECK_STORE"};
}
module.exports={verifyStockFleetWreck};
