"use strict";
// Evidence-only rescue eligibility/custody. NEVER materializes wreck items,
// grants loot, changes native warehouse or pays a rescue reward.
const pos=x=>Number.isSafeInteger(x)&&x>0;
const unique=xs=>new Set(xs).size===xs.length;
function createRescue({readManifest,readNativeWreck,readWreckContents,
 verifyNativeWarehouse,readHaulerOutcome}={}){
 if([readManifest,readNativeWreck,readWreckContents,verifyNativeWarehouse,
  readHaulerOutcome].some(x=>typeof x!=="function"))
  throw Error("ESCORT_RESCUE_NATIVE_AUTHORITIES_REQUIRED");
 function proof({manifestKey,haulerID,systemID,stationID,corporationID,
  nativeWreckID}={}){
  if(process.env.EVEJS_COOP_ESCORT_RESCUE!=="1")return {status:"DISABLED"};
  if(typeof manifestKey!=="string"||!/^\d+-\d+-\d+$/.test(manifestKey)||
   ![haulerID,systemID,stationID,corporationID,nativeWreckID].every(pos))
   return {status:"RESCUE_IDENTITY_INVALID"};
  let manifest,outcome,wreck,contents,warehouse;
  try{manifest=readManifest(manifestKey);outcome=readHaulerOutcome({
    systemID,haulerID,nativeWreckID});
   wreck=readNativeWreck({systemID,haulerID,nativeWreckID});
   contents=readWreckContents(nativeWreckID);
   warehouse=verifyNativeWarehouse({manifestKey,stationID,corporationID});
  }catch{return {status:"RESCUE_NATIVE_PROOF_SOURCE_UNAVAILABLE"}}
  const m=manifest?.record;
  if(manifest?.status!=="READY"||m?.key!==manifestKey||
   m.systemID!==systemID||m.stationID!==stationID||
   m.corporationID!==corporationID||!Array.isArray(m.haulerIDs)||
   !m.haulerIDs.includes(haulerID)||!Array.isArray(m.cargo)||!m.cargo.length)
   return {status:"RESCUE_MANIFEST_UNVERIFIED"};
  if(outcome?.status!=="NATIVE_HAULER_LOSS_VERIFIED"||
   outcome.nativeWreckID!==nativeWreckID||outcome.haulerID!==haulerID||
   wreck?.status!=="NATIVE_WRECK_VERIFIED"||
   wreck.wreckID!==nativeWreckID||wreck.destroyedHaulerID!==haulerID||
   wreck.systemID!==systemID)
   return {status:"RESCUE_WRECK_PROVENANCE_UNVERIFIED"};
  const missing=m.cargo.filter(x=>x.haulerID===haulerID);
  if(!missing.length||missing.some(x=>![x.cargoID,x.typeID,x.quantity].every(pos))||
   !unique(missing.map(x=>x.cargoID)))return {status:"RESCUE_CARGO_MANIFEST_INVALID"};
  // Only native wreck contents explicitly linked to each original cargo ID
  // are salvageable. Do not infer provenance from same item type alone.
  if(contents?.status!=="NATIVE_WRECK_CONTENTS_VERIFIED"||
   contents.wreckID!==nativeWreckID||!Array.isArray(contents.rows))
   return {status:"RESCUE_WRECK_ITEMS_UNVERIFIED"};
  const surviving=missing.map(x=>{
   const matches=contents.rows.filter(y=>y.sourceCargoID===x.cargoID&&
    y.typeID===x.typeID&&pos(y.itemID)&&pos(y.quantity)&&y.quantity<=x.quantity);
   return matches.length===1?matches[0]:null;
  }).filter(Boolean);
  if(!surviving.length)return {status:"NATIVE_CARGO_ALL_LOST_NO_RESCUE"};
  const match=surviving.map(y=>({
   cargoID:y.sourceCargoID,typeID:y.typeID,quantity:y.quantity,
   wreckItemID:y.itemID
  }));
  if(!unique(match.map(x=>x.wreckItemID)))
   return {status:"RESCUE_ITEM_CUSTODY_AMBIGUOUS"};
  // Actual native itemStore source→destination receipt required before
  // confirming recovery. Missing or partial recovery remains "available".
  const recovered=warehouse?.status==="NATIVE_RESCUE_STOCK_VERIFIED"&&
   warehouse.stationID===stationID&&warehouse.ownerID===corporationID&&
   Array.isArray(warehouse.items)&&match.every(x=>
    warehouse.items.filter(y=>y.sourceWreckItemID===x.wreckItemID&&
      y.sourceCargoID===x.cargoID&&y.typeID===x.typeID&&
      y.quantity===x.quantity&&pos(y.nativeWarehouseItemID)).length===1);
  return {status:recovered?"NATIVE_RESCUE_CARGO_DELIVERED":"NATIVE_RESCUE_AVAILABLE",
   manifestKey,nativeWreckID,systemID,stationID,
   survivingStacks:match.length,
   survivingQuantity:match.reduce((n,x)=>n+x.quantity,0),
   cargoIDs:match.map(x=>x.cargoID),
   rewardISK:0,paid:false};
 }
 return {proof};
}
module.exports={createRescue};
