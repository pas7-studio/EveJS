"use strict";
// COOP-048: genuine peaceful-delivery base wage, independent of pirate wrecks.
// This has NO client-facing API. Caller must be the trusted native terminal
// station route (or operator-authorized recovery after native proof).
const POS=x=>Number.isSafeInteger(x)&&x>0;
const SAME=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&
 a.every((x,i)=>x===b[i]);
const deny=status=>({status});
function createPeacefulEscortSettlement({readFlight,readNativeDelivery,verifyService,nativeFunds}={}){
 if(typeof readFlight!=="function"||typeof readNativeDelivery!=="function"||
  typeof verifyService!=="function"||
  ["capabilities","verifyReservation","verifySettlement","settleAtomic"].some(x=>
   typeof nativeFunds?.[x]!=="function"))
  throw Error("PEACEFUL_ESCORT_NATIVE_AUTHORITIES_REQUIRED");
 function settlementReceipt(c){
  let paid;try{paid=nativeFunds.verifySettlement(c)}
  catch{return deny("NATIVE_SETTLEMENT_PROOF_UNAVAILABLE")}
  if(paid?.status==="NOT_SETTLED"||paid?.status==="NOT_FOUND")
   return deny("NOT_SETTLED");
  if(paid?.status!=="SETTLED"||paid.nativeDurable!==true||
   paid.escrowConsumed!==true||paid.contractID!==c.contractID||
   paid.corporationID!==c.corporationID||paid.amountISK!==c.amountISK||
   !Array.isArray(paid.credits)||paid.credits.length!==2||
   paid.credits.some((x,i)=>x.characterID!==c.characters[i]||
    x.amountISK!==c.amountISK/2))
   return deny("NATIVE_SETTLEMENT_RECEIPT_MISMATCH");
  return {status:"ALREADY_NATIVE_PAID",contractID:c.contractID};
 }
 function settle(manifestKey,scene){
  if(process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT!=="1")
   return deny("DISABLED");
  if(typeof manifestKey!=="string"||!/^\d+-\d+-\d+$/.test(manifestKey))
   return deny("NATIVE_MANIFEST_KEY_INVALID");
  let f;try{f=readFlight(manifestKey)}
  catch{return deny("NATIVE_FLIGHT_JOURNAL_UNAVAILABLE")}
  if(f?.status!=="READY"||f.phase!=="DELIVERED"||!f.delivery||
   f.delivery.status!=="DELIVERED"||f.delivery.terminal!==true)
   return deny("NATIVE_TERMINAL_DELIVERY_UNVERIFIED");
  const b=f.booking;
  if(!b||b.manifestKey!==manifestKey||
   typeof b.contractID!=="string"||!/^escort-[a-zA-Z0-9-]{1,48}$/.test(b.contractID)||
   ![b.systemID,b.fleetID,b.haulerID,b.stationID,b.corporationID,
     b.amountISK,b.playerFleetID].every(POS)||b.amountISK%2!==0||
   b.amountISK>1000000000||
   !Array.isArray(b.characters)||b.characters.length!==2||
   !b.characters.every(POS)||b.characters[0]>=b.characters[1])
   return deny("NATIVE_ESCORT_BOOKING_UNTRUSTED");
  const c={contractID:b.contractID,manifestKey,corporationID:b.corporationID,
   amountISK:b.amountISK,characters:b.characters.slice()};
  let caps;try{caps=nativeFunds.capabilities()}
  catch{return deny("NATIVE_FUNDS_AUTHORITY_UNAVAILABLE")}
  if(caps?.nativeDurable!==true||caps?.atomicDualCredit!==true||
   caps?.durableIdempotency!==true)return deny("NATIVE_FUNDS_NOT_ATOMIC");
  // A prior native atomic payout may have succeeded before its ACK was lost.
  const already=settlementReceipt(c);
  if(already.status==="ALREADY_NATIVE_PAID")return already;
  if(already.status!=="NOT_SETTLED")return already;
  let funds;try{funds=nativeFunds.verifyReservation(c)}
  catch{return deny("NATIVE_RESERVATION_PROOF_UNAVAILABLE")}
  if(funds?.status!=="RESERVED"||funds.nativeDurable!==true||
   funds.escrowKey!==b.contractID||funds.contractID!==b.contractID||
   funds.amountISK!==b.amountISK||funds.corporationID!==b.corporationID)
   return deny("NATIVE_ESCROW_NOT_RESERVED");
  let delivery;try{delivery=readNativeDelivery(c)}
  catch{return deny("NATIVE_DELIVERY_RECHECK_UNAVAILABLE")}
  const proof=delivery?.nativeFullManifestProof,original=f.delivery.nativeFullManifestProof;
  if(delivery?.status!=="DELIVERED"||delivery.terminal!==true||
   proof?.status!=="FULL_NATIVE_CARGO_DELIVERY_VERIFIED"||
   proof.key!==manifestKey||!POS(proof.stationID)||proof.stationID!==b.stationID||
   !SAME(proof.haulerIDs,[b.haulerID])||
   !Array.isArray(proof.cargoIDs)||proof.cargoIDs.length<1||
   proof.cargoIDs.some(x=>!POS(x))||
   !SAME(proof.cargoIDs,original?.cargoIDs)||
   !SAME(proof.haulerIDs,original?.haulerIDs))
   return deny("NATIVE_FULL_WAREHOUSE_DELIVERY_UNVERIFIED");
  let service;try{service=verifyService(b,scene)}
  catch{return deny("NATIVE_ESCORT_SERVICE_PROOF_UNAVAILABLE")}
  if(service?.status!=="VERIFIED_NATIVE_ESCORT_SERVICE"||
   !SAME(service.characters,b.characters)||service.fleetID!==b.playerFleetID||
   service.haulerID!==b.haulerID||service.systemID!==b.systemID)
   return deny("NATIVE_ESCORT_SERVICE_NOT_VERIFIED");
  let result;try{
   result=nativeFunds.settleAtomic({contractID:b.contractID,
    corporationID:b.corporationID,amountISK:b.amountISK,
    credits:b.characters.map(characterID=>({characterID,amountISK:b.amountISK/2}))});
  }catch{
   // Do not blindly retry a possibly committed native transaction.
   const ack=settlementReceipt(c);
   return ack.status==="ALREADY_NATIVE_PAID"?ack:
    deny("NATIVE_PAYOUT_UNCERTAIN_OPERATOR_REPAIR_REQUIRED");
  }
  if(result?.status!=="SETTLED"||result.contractID!==b.contractID)
   return deny("NATIVE_PAYOUT_ACK_UNCERTAIN_OPERATOR_REPAIR_REQUIRED");
  const verified=settlementReceipt(c);
  return verified.status==="ALREADY_NATIVE_PAID"?
   {status:"NATIVE_PEACEFUL_ESCORT_PAID",contractID:b.contractID,
    amountISK:b.amountISK,characters:b.characters.slice()}:
   deny("NATIVE_PAYOUT_RECHECK_UNCERTAIN_OPERATOR_REPAIR_REQUIRED");
 }
 return Object.freeze({settle});
}
module.exports={createPeacefulEscortSettlement};
