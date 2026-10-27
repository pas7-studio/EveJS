"use strict";
// Read-only witness AFTER a native wreck-item transfer. No grants or retries.
// It cannot repair an already ambiguous native grant/source debit transaction.
const positive=n=>Number.isSafeInteger(Number(n))&&Number(n)>0?Number(n):null;
function quantityOf(item){
 if(!item||typeof item!=="object")return null;
 if(item.singleton===true||Number(item.singleton)===1)return 1;
 const n=Number(item.stacksize??item.quantity);
 return Number.isSafeInteger(n)&&n>0?n:null;
}
function destinationDelta(changes,character,destination,type){
 if(!Array.isArray(changes))return null;
 const portion=row=>{
  if(!row||Number(row.ownerID)!==character||
   Number(row.locationID)!==destination||Number(row.typeID)!==type)return 0;
  return positive(row.itemID)?quantityOf(row):null;
 };
 let total=0;
 for(const change of changes){
  const before=portion(change?.previousData??change?.previousState);
  const after=change?.removed===true?0:portion(change?.item);
  if(before===null||after===null)return null;
  total+=after-before;
  if(!Number.isSafeInteger(total))return null;
 }
 return total;
}
function verify({scene,wreck,characterID,wreckItemID,destinationLocationID,sourceBefore,sourceAfter,
 availableQuantity,requestedQuantity,grantResult}={}){
 const systemID=positive(scene?.systemID),wreckID=positive(wreck?.wreckID);
 const character=positive(characterID),item=positive(wreckItemID),destination=positive(destinationLocationID);
 const available=positive(availableQuantity),taken=positive(requestedQuantity);
 if(!systemID||!wreckID||!character||!item||!destination||!available||!taken||
  taken>available||Number(wreck?.systemID)!==systemID||
  !sourceBefore||Number(sourceBefore.wreckItemID)!==item||
  Number(sourceBefore.wreckID)!==wreckID||!positive(sourceBefore.typeID)||
  ((sourceBefore.singleton===true||Number(sourceBefore.singleton)===1)?available!==1:Number(sourceBefore.quantity)!==available)||
  typeof scene?.getEntityByID!=="function")
  return {status:"INVALID_LOOT_WITNESS"};
 if(grantResult?.success!==true)return {status:"NATIVE_GRANT_NOT_CONFIRMED"};
 // Source debit takes precedence over missing client session or telemetry.
 const expected=available-taken;
 if(expected===0&&sourceAfter!=null)
  return {status:"NATIVE_LOOT_SOURCE_NOT_REMOVED"};
 if(expected>0&&(!sourceAfter||Number(sourceAfter.wreckItemID)!==item||
  Number(sourceAfter.wreckID)!==wreckID||
  Number(sourceAfter.typeID)!==Number(sourceBefore.typeID)||
  (sourceBefore.ownerID!=null&&Number(sourceAfter.ownerID)!==Number(sourceBefore.ownerID))||
  Number(sourceAfter.quantity)!==expected))
  return {status:"NATIVE_LOOT_SOURCE_NOT_DECREMENTED"};
 const type=Number(sourceBefore.typeID);
 // Verify actual per-inventory-row net increase, not just an RPC success flag
 // or another pre-existing stack of the same type in the player's hold.
 if(Number(grantResult?.data?.quantity)!==taken||
  destinationDelta(grantResult?.data?.changes,character,destination,type)!==taken)
  return {status:"NATIVE_GRANT_DESTINATION_UNVERIFIED"};
 const nativeWreck=scene.getEntityByID(wreckID);
 if(nativeWreck?.nativeNpcWreck!==true||Number(nativeWreck.itemID)!==wreckID||
  Number(nativeWreck.launcherID)!==Number(wreck.sourceEntityID))
  return {status:"NO_PHYSICAL_NATIVE_WRECK"};
 const sessions=Array.from(scene.sessions?.values?.()||[]);
 const matching=sessions.filter(s=>{
  const shipID=positive(s?._space?.shipID);
  if(Number(s?.characterID)!==character||!shipID||
   Number(s?._space?.systemID)!==systemID||
   s?._space?.initialStateSent!==true||s?.socket?.destroyed===true||
   (s.activeShipID!=null&&Number(s.activeShipID)!==shipID))return false;
  const ship=scene.getEntityByID(shipID);
  if(ship?.kind!=="ship"||positive(ship.itemID)!==shipID||
   (ship.session!=null&&ship.session!==s))return false;
  for(const ownerField of ["ownerID","characterID","pilotCharacterID"]){
   if(ship[ownerField]!=null&&positive(ship[ownerField])!==character)return false;
  }
  return true;
 });
 if(matching.length!==1)return {status:"NO_UNIQUE_AUTHENTICATED_SPACE_LOOTER"};
 const session=matching[0],shipID=positive(session._space.shipID);
 if(sessions.some(s=>s!==session&&s?.socket?.destroyed!==true&&
  s?._space?.initialStateSent===true&&
  (Number(s?.characterID)===character||Number(s?._space?.shipID)===shipID)))
  return {status:"NO_UNIQUE_AUTHENTICATED_SPACE_LOOTER"};
 // In-space loot can only be proved as deposited in this very physical hold.
 // Other destination kinds require their own native custody/rights witness.
 if(destination!==shipID)return {status:"NATIVE_GRANT_DESTINATION_UNVERIFIED"};
 return {status:"VERIFIED_NATIVE_LOOT_PICKUP",systemID,wreckID,
  sourceEntityID:positive(wreck.sourceEntityID),characterID:character,shipID,
  destinationLocationID:destination,clientID:positive(session.clientID),
  wreckItemID:item,typeID:positive(sourceBefore.typeID),quantity:taken,
  remainingQuantity:expected,
  evidence:"NATIVE_GRANT_NET_INVENTORY_DELTA_PLUS_PHYSICAL_WRECK_AND_SOURCE_DEBIT"};
}
function note(args){
 if(process.env.EVEJS_COOP_NATIVE_LOOT_EVIDENCE!=="1")return {status:"DISABLED"};
 const result=verify(args);
 if(result.status==="NATIVE_LOOT_SOURCE_NOT_REMOVED"||
    result.status==="NATIVE_LOOT_SOURCE_NOT_DECREMENTED"){
  const guard=require("./coopNativeLootQuarantine").quarantine({
   wreckID:args?.wreck?.wreckID,wreckItemID:args?.wreckItemID,reason:result.status
  });
  result.quarantineStatus=guard.status;
  if(guard.status==="QUARANTINE_STORAGE_UNSAFE")
   console.warn("[CoopNativeLoot] quarantine cannot persist; fail-closed item transfers",guard.reason||"");
 }
 if(result.status==="VERIFIED_NATIVE_LOOT_PICKUP"||
    result.status==="NATIVE_LOOT_SOURCE_NOT_REMOVED"||
    result.status==="NATIVE_LOOT_SOURCE_NOT_DECREMENTED"){
  let recorded=false;
  try{
   recorded=require("./coopRuntimeProbe").observe("living-native-loot-pickup",null,
    {spaceState:{systemID:args?.scene?.systemID}},{...result,
     ...(result.status!=="VERIFIED_NATIVE_LOOT_PICKUP"?{
      wreckID:positive(args?.wreck?.wreckID),
      wreckItemID:positive(args?.wreckItemID)}:{})})===true;
  }catch(error){
   console.warn("[CoopNativeLoot] telemetry",String(error?.code||"UNAVAILABLE"));
  }
  if(!recorded&&result.status==="VERIFIED_NATIVE_LOOT_PICKUP")
   return {...result,status:"TELEMETRY_NOT_RECORDED",nativeTransferVerified:true};
 }
 // Follow the existing authoritative native transfer, AFTER generic
 // source debit + real destination delta are independently verified.
 // Boss-specific evidence is read-only; it must never replay the grant.
 if(result.status==="VERIFIED_NATIVE_LOOT_PICKUP"&&
    process.env.EVEJS_COOP_PVE_BOSS_LOOT_PICKUP==="1"){
  try{require("./coopPveBossLootPickup").note(args,result);}
  catch(error){console.warn("[CoopPveBossLoot] observer",String(error?.code||"UNAVAILABLE"));}
 }
 return result;
}
module.exports={verify,note,destinationDelta};
