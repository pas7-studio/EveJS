"use strict";
/**
 * CH24+31 E2B5: original corporation market PARTIAL UNSOLD RETURN.
 * Requires a SERVER-READ native Rust exclusive CANCEL_LOCKED source row.
 * A completed paid fill is never undone. No buyer wallet mutation.
 * Original source itemID with only remaining units returns to same corp office.
 */
const SEP="\u001f",ORDER=/^[1-9][0-9]{0,17}$/,SHIFT=/^coop-mining-shift:[a-f0-9]{32}$/;
const TABLES=Object.freeze(["items","marketEscrow","corporationRuntime"]);
const pos=x=>Number.isSafeInteger(x)&&x>0;
const validOrder=id=>typeof id==="string"&&ORDER.test(id)&&
 BigInt(id)+9200000000n<=BigInt(Number.MAX_SAFE_INTEGER);
function createCorporateUnsoldReturn({
 gameStore,access,readNativeCancelLock,enabled=()=>process.env.EVEJS_COOP_PLAYER_NPC_MINING_CORP_CANCEL==="1",clock=()=>Date.now()
}={}){
 const atomic=gameStore?.coopAtomicNativeRows;
 if(atomic?.mode!=="SERVER_INTERNAL_FLAGGED"||
  typeof atomic.transact!=="function"||typeof atomic.isPoisoned!=="function"||
  [access?.isMember,access?.canIndustry,access?.canWallet,access?.canTake,
   readNativeCancelLock,enabled,clock].some(x=>typeof x!=="function"))
  throw Error("CORP_UNSOLD_ORIGINAL_NATIVE_AUTHORITIES_REQUIRED");
 const uncertain=new Set(),blocked=reason=>({status:"BLOCKED",reason,
  nativeMutation:false,refundedISK:false});
 function returnRemaining({session,corporationID,operationID,cargoID,orderID}={}){
  if(enabled()!==true)return blocked("CORP_UNSOLD_RETURN_DISABLED");
  if(!validOrder(orderID)||!pos(corporationID)||!pos(cargoID)||
    !SHIFT.test(operationID||"")||!session||
    session.socket?.destroyed===true||!pos(session.characterID)||
    session.corporationID!==corporationID||
    uncertain.has(orderID)||atomic.isPoisoned())
   return blocked("CORP_UNSOLD_SCOPE_OR_OUTCOME_UNKNOWN");
  let proof;
  try{proof=readNativeCancelLock({orderID,cargoID,corporationID});}
  catch{return blocked("CORP_UNSOLD_RUST_LOCK_UNAVAILABLE")}
  if(proof?.verifiedNative!==true||proof.phase!=="CANCEL_LOCKED"||
   proof.cancelled!==false||proof.orderID!==orderID||
   proof.corporationID!==corporationID||proof.cargoID!==cargoID||
   proof.shiftID!==operationID||!pos(proof.sourceItemID)||
   !pos(proof.remainingQuantity)||!pos(proof.stationID)||
   !pos(proof.typeID)||!Number.isSafeInteger(proof.settledCycles)||
   proof.settledCycles<0)
   return blocked("CORP_UNSOLD_RUST_LOCK_INVALID");
  const permitted=receipt=>access.isMember(session,corporationID)===true&&
   access.canIndustry(session,corporationID)===true&&
   access.canWallet(session,corporationID,1000)===true&&
   access.canTake(session,corporationID,receipt.stationID,receipt.originalFlagID)===true;
  let called=false;
  try{
   called=true;
   return atomic.transact(TABLES,tx=>{
    const key="coopPlayerMiningCorpSell"+SEP+cargoID;
    const receipt=tx.get("corporationRuntime",key);
    const escrow=tx.get("marketEscrow",orderID);
    const item=tx.get("items",String(proof.sourceItemID));
    const left=proof.remainingQuantity;
    if(receipt?.version!==1||
      !["ESCROW_BOUND_UNSETTLED","ACTIVE_SELL"].includes(receipt.phase)||
      receipt.operationID!==operationID||receipt.cargoID!==cargoID||
      receipt.orderID!==orderID||receipt.corporationID!==corporationID||
      receipt.itemID!==proof.sourceItemID||
      receipt.typeID!==proof.typeID||receipt.stationID!==proof.stationID||
      !pos(receipt.originalLocationID)||!pos(receipt.originalFlagID)||
      !pos(receipt.quantity)||receipt.quantity<left||
      (receipt.remainingQuantity??receipt.quantity)!==left||
      (receipt.settledCycles??0)!==proof.settledCycles||
      (receipt.lastSettledCycle??0)!==proof.settledCycles||
      escrow?.orderId!==orderID||escrow.isCorp!==true||
      escrow.escrowType!=="sell"||escrow.ownerId!==corporationID||
      escrow.escrowLocationID!==receipt.escrowLocationID||
      escrow.remainingQuantity!==left||
      escrow.sourceItemIDs?.length!==1||
      escrow.sourceItemIDs[0]!==receipt.itemID||
      !["ESCROW_BOUND_UNSETTLED","ACTIVE_SELL"].includes(escrow.phase)||
      item?.itemID!==receipt.itemID||item.ownerID!==corporationID||
      item.locationID!==receipt.escrowLocationID||item.flagID!==4||
      item.typeID!==receipt.typeID||item.quantity!==left||
      item.stacksize!==left||item.singleton!==0||
      item.customInfo!=="coop-warehouse:v1:cargo:"+cargoID)
     throw Error("CORP_UNSOLD_ORIGINAL_PHYSICAL_REMAINDER_MISMATCH");
    if(tx.scan("items").filter(v=>v.value?.customInfo===
       "coop-warehouse:v1:cargo:"+cargoID).length!==1)
     throw Error("CORP_UNSOLD_SOURCE_MARKER_NOT_UNIQUE");
    if(!permitted(receipt))
     throw Error("CORP_UNSOLD_CORPORATE_ROLE_REVOKED");
    const now=clock();if(!pos(now))throw Error("CORP_UNSOLD_CLOCK_INVALID");
    tx.put("items",String(receipt.itemID),{...item,
     locationID:receipt.originalLocationID,flagID:receipt.originalFlagID});
    tx.put("marketEscrow",orderID,{...escrow,
     phase:"RETURNED_UNSOLD",remainingQuantity:0,returnedQuantity:left});
    tx.put("corporationRuntime",key,{...receipt,
     phase:"RETURNED_UNSOLD",remainingQuantity:0,
     returnedQuantity:left,returnedAt:now});
    return {status:"RETURNED_UNSOLD",originalItemID:receipt.itemID,
      orderID,settledCycles:proof.settledCycles,returnedQuantity:left,
      nativeMutation:true,refundedISK:false,realizedRevenueCents:null};
   });
  }catch{
   if(called)uncertain.add(orderID);
   return blocked("CORP_UNSOLD_ATOMIC_RETURN_OUTCOME_UNKNOWN");
  }
 }
 return Object.freeze({returnRemaining,requiresOperatorReconciliation:()=>[...uncertain],
  mode:"CORPORATE_UNSOLD_RETURN_LOCKED",supportsPublicCancel:false});
}
module.exports={createCorporateUnsoldReturn,TABLES};
