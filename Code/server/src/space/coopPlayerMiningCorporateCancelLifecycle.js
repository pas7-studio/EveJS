"use strict";
/**
 * E2B5 private original native corporate unsold cancellation lifecycle.
 * Caller provides a genuine corporate officer session; all price/volume/
 * remaining identity originates in Rust locked source, never from the UI.
 * Public corporate market activation remains OFF.
 */
const pos=x=>Number.isSafeInteger(x)&&x>0;
const validOrder=id=>typeof id==="string"&&/^[1-9][0-9]{0,17}$/.test(id)&&
 BigInt(id)+9200000000n<=BigInt(Number.MAX_SAFE_INTEGER);
function createCorporateCancelLifecycle({
 marketClient,unsoldReturn,token,enabled=()=>process.env.EVEJS_COOP_PLAYER_NPC_MINING_CORP_CANCEL==="1",observe=()=>{}
}={}){
 if(typeof marketClient?.call!=="function"||
  typeof unsoldReturn?.returnRemaining!=="function"||
  typeof token!=="string"||token.length<32||token.length>256||
  typeof enabled!=="function"||typeof observe!=="function")
  throw Error("CORP_CANCEL_LIFECYCLE_ORIGINAL_NATIVE_AUTHORITIES_REQUIRED");
 const unknown=new Set(),inFlight=new Set(),completed=new Map();
 const blocked=(reason,orderID)=>Object.freeze({status:"BLOCKED",reason,orderID,
  nativeMutation:false,refundedISK:false});
 const equal=(a,b,orderID,corporationID,cargoID,operationID)=>{
  return a?.verifiedNative===true&&a.phase==="CANCEL_LOCKED"&&
   a.cancelled===false&&a.orderID===orderID&&
   a.corporationID===corporationID&&a.cargoID===cargoID&&
   a.shiftID===operationID&&
   pos(a.sourceItemID)&&pos(a.stationID)&&pos(a.typeID)&&
   pos(a.remainingQuantity)&&Number.isSafeInteger(a.settledCycles)&&
   a.settledCycles>=0&&
   b?.verifiedNative===true&&b.phase===a.phase&&b.orderID===orderID&&
   b.corporationID===a.corporationID&&b.cargoID===a.cargoID&&
   b.shiftID===a.shiftID&&b.sourceItemID===a.sourceItemID&&
   b.remainingQuantity===a.remainingQuantity&&
   b.settledCycles===a.settledCycles&&b.stationID===a.stationID&&
   b.typeID===a.typeID;
 };
 async function cancelOriginalUnsold({session,corporationID,operationID,cargoID,orderID}={}){
  if(enabled()!==true)return blocked("CORP_CANCEL_LIFECYCLE_DISABLED",orderID);
  if(!validOrder(orderID)||!pos(corporationID)||!pos(cargoID)||
    typeof operationID!=="string"||!/^coop-mining-shift:[a-f0-9]{32}$/.test(operationID)||
    !pos(session?.characterID)||session.corporationID!==corporationID||
    session.socket?.destroyed===true)
   return blocked("CORP_CANCEL_SCOPE_INVALID",orderID);
  if(unknown.has(orderID))return blocked("CORP_CANCEL_OUTCOME_UNKNOWN",orderID);
  if(inFlight.has(orderID))return blocked("CORP_CANCEL_ALREADY_IN_FLIGHT",orderID);
  if(completed.has(orderID))return {...completed.get(orderID),replayed:true};
  inFlight.add(orderID);
  let issued=false;
  const args={access_token:token,order_id:orderID};
  try{
   issued=true;
   const a=await marketClient.call("LockCorpSellCancel",args);
   const b=await marketClient.call("GetCorpSellCancel",args);
   if(!equal(a,b,orderID,corporationID,cargoID,operationID))
    throw Error("CORP_CANCEL_RUST_EXCLUSIVE_LOCK_CHANGED");
   const receipt=unsoldReturn.returnRemaining({session,corporationID,
     operationID,cargoID,orderID});
   if(receipt?.status!=="RETURNED_UNSOLD"||
    receipt.orderID!==orderID||receipt.originalItemID!==a.sourceItemID||
    receipt.returnedQuantity!==a.remainingQuantity||
    receipt.settledCycles!==a.settledCycles||
    receipt.refundedISK!==false)
    throw Error("CORP_CANCEL_NATIVE_UNSOLD_RETURN_NOT_COMMITTED");
   const done=await marketClient.call("FinalizeCorpSellCancel",args);
   if(done?.phase!=="CANCELLED"||
      done.orderID!==orderID||done.corporationID!==corporationID||
      done.sourceItemID!==a.sourceItemID||
      done.remainingReturned!==receipt.returnedQuantity||
      done.settledCycles!==receipt.settledCycles||
      done.verifiedGameStore!==true)
    throw Error("CORP_CANCEL_ORIGINAL_RUST_FINALIZE_PROOF_INVALID");
   const result=Object.freeze({
    status:"CORP_CANCELLED_UNSOLD_RETURNED",orderID,cargoID,
    originalItemID:receipt.originalItemID,
    returnedQuantity:receipt.returnedQuantity,
    previousSettledCycles:receipt.settledCycles,
    refundedISK:false,originalBuyerFillsPreserved:true,
    nativeMutation:true
   });
   completed.set(orderID,result);
   try{observe("corp-mining-unsold-returned",result)}catch{}
   return result;
  }catch{
   if(issued)unknown.add(orderID);
   return blocked("CORP_CANCEL_LOCK_RETURN_OR_FINALIZE_UNKNOWN",orderID);
  }finally{inFlight.delete(orderID)}
 }
 return Object.freeze({cancelOriginalUnsold,
  requiresOperatorReconciliation:()=>[...unknown],
  mode:"ORIGINAL_CORPORATE_CANCEL_LOCKED",
  supportsPublicCancel:false});
}
module.exports={createCorporateCancelLifecycle};
