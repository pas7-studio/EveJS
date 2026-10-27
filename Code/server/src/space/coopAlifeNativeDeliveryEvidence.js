"use strict";
// Native manifest completion is ALREADY authored by the physical warehouse.
// This observer validates that proof; it NEVER deposits cargo, grants items,
// changes ISK, orders a ship or claims the observer caused the settlement.
const positive=x=>Number.isSafeInteger(x)&&x>0;
function verifyFullNativeDelivery(trip,proof){
 const block=reason=>({status:"BLOCKED",reason});
 if(!trip||!positive(trip.systemID)||!positive(trip.fleetID)||
   !positive(trip.stationID)||!positive(trip.corporationID)||
   !positive(trip.startedAt)||typeof trip.manifestID!=="string"||
   trip.manifestID!==[trip.systemID,trip.fleetID,trip.startedAt].join("-")||
   !trip.haulers||typeof trip.haulers!=="object"||
   !Array.isArray(trip.expectedCargoIDs))
  return block("NATIVE_DELIVERY_TRIP_UNVERIFIED");
 const haulerIDs=Object.keys(trip.haulers).map(Number).sort((a,b)=>a-b);
 const cargoIDs=trip.expectedCargoIDs.slice().sort((a,b)=>a-b);
 if(!haulerIDs.length||haulerIDs.length>32||
   !cargoIDs.length||cargoIDs.length>1000||
   !haulerIDs.every(positive)||!cargoIDs.every(positive)||
   new Set(haulerIDs).size!==haulerIDs.length||
   new Set(cargoIDs).size!==cargoIDs.length)
  return block("NATIVE_DELIVERY_CARGO_IDENTITY_AMBIGUOUS");
 if(proof?.status!=="FULL_NATIVE_CARGO_DELIVERY_VERIFIED"||
   proof.key!==trip.manifestID||
   proof.stationID!==trip.stationID||
   !Array.isArray(proof.haulerIDs)||!Array.isArray(proof.cargoIDs)||
   proof.haulerIDs.length!==haulerIDs.length||
   proof.cargoIDs.length!==cargoIDs.length||
   !haulerIDs.every((x,i)=>proof.haulerIDs.slice().sort((a,b)=>a-b)[i]===x)||
   !cargoIDs.every((x,i)=>proof.cargoIDs.slice().sort((a,b)=>a-b)[i]===x)||
   proof.stacks!==cargoIDs.length||
   !positive(proof.quantity)||proof.convoySaved!==false||
   proof.paidReward!==false)
  return block("NATIVE_DELIVERY_MANIFEST_PROOF_CONFLICT");
 // This stable identity can be deduplicated across restarts by readers.
 return {status:"NATIVE_FULL_MANIFEST_WITNESSED",
  eventID:"alife-native-delivery:"+trip.manifestID,
  manifestID:trip.manifestID,systemID:trip.systemID,
  fleetID:trip.fleetID,stationID:trip.stationID,
  corporationID:trip.corporationID,
  haulerIDs,cargoIDs,stacks:proof.stacks,quantity:proof.quantity,
  proof:"WAREHOUSE_COMMITTED_AND_NATIVE_ITEMSTORE_VERIFIED",
  nativeMutation:false,iskCredited:false,paidReward:false};
}
module.exports={verifyFullNativeDelivery};
