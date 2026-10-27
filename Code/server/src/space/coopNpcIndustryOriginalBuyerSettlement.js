"use strict";
// LW-04C3B: manual original NPC manufacturer buyer settlement bridge.
// All Rust claims, original GameStore wallet debits/credits, ItemStore transfer
// and durable receipts remain owned by existing COOP-035/047 adapters.
// Never mints/credits directly, never impersonates a player or schedules AI.
const OP=/^npc-manufacture:[0-9a-f]{32}$/,CLAIM=/^npc-partial:[0-9a-f]{32}$/;
const POS=n=>Number.isSafeInteger(n)&&n>0;
const reject=(reason,operationID)=>({status:"BLOCKED",reason,operationID,
 nativeMutation:false});
function createOriginalNpcIndustryBuyerSettlement({
 director,whole,partial,saleAudit,getOriginalItem,getOriginalEscrow,
 getRustOrder,verifyAuthenticatedBuyer,verifyNativePartialClaimKey,env=process.env
}={}){
 if(typeof director?.inspect!=="function"||
    whole?.mode!=="WHOLE_STACK_PROOF_ONLY"||
    whole?.supportsLiveSettlement!==false||
    typeof whole.purchaseOnce!=="function"||
    partial?.mode!=="RUST_CLAIMED_NATIVE_PARTIAL"||
    partial?.supportsLiveSettlement!==false||
    typeof partial.purchaseOnce!=="function"||
    typeof saleAudit?.audit!=="function"||
    [getOriginalItem,getOriginalEscrow,getRustOrder,
     verifyAuthenticatedBuyer,verifyNativePartialClaimKey].some(x=>typeof x!=="function"))
  throw Error("LW04C3B_ORIGINAL_RUST_BUYER_SETTLEMENT_AUTHORITIES_REQUIRED");
 const active=new Set(),repair=new Set();
 const enabled=mode=>env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
  env.EVEJS_COOP_NATIVE_NPC_CORP_SETTLEMENT_PROOF==="1"&&
  env.EVEJS_COOP_NATIVE_NPC_MANUAL_FACTORY_PROOF==="1"&&
  env.EVEJS_COOP_NATIVE_NPC_ECONOMY==="1"&&
  (mode==="whole"||env.EVEJS_COOP_NATIVE_NPC_PARTIAL_FILL==="1")&&
  env.EVEJS_COOP_ALIFE_ECONOMY_ACT!=="1"&&
  env.EVEJS_COOP_NATIVE_NPC_ECONOMY_SCHEDULER!=="1"&&
  env.EVEJS_COOP_NATIVE_NPC_MARKET!=="1";
 function entry({operationID,ownerID,stationID,orderID}){
  const j=director.inspect();
  const e=j?.version===1&&j?.entries?.[operationID];
  if(!e||e.operationID!==operationID||e.ownerID!==ownerID||
     e.stationID!==stationID||e.orderID!==orderID||
     e.phase!=="LISTED"||!POS(e.itemID)||!POS(e.typeID)||
     !POS(e.quantity))throw Error("LW04C3B_NATIVE_FACTORY_LISTED_SOURCE_REQUIRED");
  return e;
 }
 async function purchase({mode,operationID,ownerID,stationID,orderID,buyerID,
  quantity,claimKey,maxPriceCents}={}){
  if(!["whole","partial"].includes(mode)||!OP.test(operationID||"")||
     !POS(ownerID)||!POS(stationID)||!POS(orderID)||!POS(buyerID)||
     !POS(quantity)||!POS(maxPriceCents)||maxPriceCents>100000000||
     (mode==="partial"&&!CLAIM.test(claimKey||""))||
     mode==="whole"&&claimKey!=null)
   return reject("LW04C3B_REQUEST_INVALID",operationID);
  if(!enabled(mode))return reject("LW04C3B_MANUAL_FINANCE_DISABLED",operationID);
  const lock=ownerID+":"+stationID+":"+orderID;
  if(active.has(lock))return reject("LW04C3B_BUYER_FILL_IN_PROGRESS",operationID);
  if(repair.has(lock))return reject("LW04C3B_OPERATOR_RECOVERY_REQUIRED",operationID);
  active.add(lock);
  try{
   if(verifyAuthenticatedBuyer({buyerID,stationID,operationID,
      orderID})!==true)return reject("LW04C3B_NATIVE_BUYER_SESSION_REQUIRED",operationID);
   if(mode==="partial"&&verifyNativePartialClaimKey({claimKey,buyerID,
      ownerID,stationID,operationID,orderID,quantity})!==true)
    return reject("LW04C3B_PARTIAL_CLAIM_BINDING_UNVERIFIED",operationID);
   const e=entry({operationID,ownerID,stationID,orderID});
   const book=await getRustOrder(operationID);
   const remaining=Number(book?.vol_remaining),id=Number(book?.order_id);
   if(book?.operation_id!==operationID||id!==orderID||
      Number(book?.owner_id)!==ownerID||
      Number(book?.station_id)!==stationID||
      Number(book?.source_item_id)!==e.itemID||
      Number(book?.type_id)!==e.typeID||
      book?.state!=="open"||book?.source!=="coop-npc"||
      book.is_corp!==true||book.bid!==false||
      !POS(remaining)||remaining>e.quantity||
      quantity>remaining||
      (mode==="whole"&&(quantity!==remaining||remaining!==e.quantity)))
    return reject("LW04C3B_RUST_ORIGINAL_OPEN_ORDER_UNVERIFIED",operationID);
   const escrow=getOriginalEscrow(orderID),item=getOriginalItem(e.itemID);
   if(!escrow||escrow.coopOperationID!==operationID||
      escrow.ownerId!==ownerID||escrow.stationId!==stationID||
      escrow.sourceItemID!==e.itemID||escrow.remainingQuantity!==remaining||
      escrow.escrowType!=="sell"||escrow.isCorp!==true||
      escrow.escrowLocationID!==9200000000+orderID||
      item?.itemID!==e.itemID||item.ownerID!==ownerID||
      item.typeID!==e.typeID||item.locationID!==escrow.escrowLocationID||
      item.flagID!==4||item.singleton!==0||
      item.quantity!==remaining||item.stacksize!==remaining)
    return reject("LW04C3B_GAMESTORE_ESCROW_CUSTODY_UNVERIFIED",operationID);
   const identity={operationID,orderID,ownerID,stationID,
    typeID:e.typeID,itemID:e.itemID,quantity,
    ...(mode==="partial"?{claimKey}:{})};
   // The COOP-035/047 native adapters exclusively own the GameStore/Rust
   // mutations; both require their own authenticated buyer/session proof.
   const native=await (mode==="whole"?whole:partial)
    .purchaseOnce({buyerID,identity,maxPriceCents});
   if(native?.status!==(mode==="whole"?"PURCHASED":"PURCHASED_PARTIAL")||
      !POS(native.fillID)){
    // COOP-035/047 may already have a durable Rust CLAIM or SQLite COMMIT
    // when a transport layer reports a non-success result. The wrapper
    // cannot prove no native write occurred: hold until operator audit.
    repair.add(lock);
    return reject("LW04C3B_ORIGINAL_SETTLEMENT_NOT_CONFIRMED",operationID);
   }
   // Original payment may have COMMITTED. If the audit fails, never send a
   // second claim to repair it. Retain an operator hold until real sources
   // are reconciled. This is NOT another GameStore writer.
   const result=await saleAudit.audit({ownerID,stationID,operationID,orderID});
   const verified=mode==="whole"?
    result?.status==="ORIGINAL_FULL_SALE_ATTESTED"&&
     result.remainingQuantity===0:
    ["ORIGINAL_FULL_SALE_ATTESTED",
     "ORIGINAL_PARTIAL_SALE_ATTESTED"].includes(result?.status);
   if(!verified||!result.fillIDs?.includes(native.fillID)){
    repair.add(lock);
    return reject("LW04C3B_PAYMENT_COMMITTED_AUDIT_REQUIRED",operationID);
   }
   return {status:"ORIGINAL_NATIVE_PAYMENT_ATTESTED",mode,operationID,
    orderID,fillID:native.fillID,buyerID,
    soldQuantity:result.soldQuantity,remainingQuantity:result.remainingQuantity,
    revenueCents:result.revenueCents,readOnlyConfirmation:true,
    originalGameStoreAndRustSettled:true};
  }catch(error){
   // Claims may be durable after network or ACK failure. Never repeat
   // a payout with a new fill ID on this process/operation.
   repair.add(lock);
   return reject("LW04C3B_NATIVE_SETTLEMENT_OUTCOME_UNKNOWN:"+
    String(error?.message||error).slice(0,100),operationID);
  }finally{active.delete(lock)}
 }
 return Object.freeze({purchase,repairRequired:()=>[...repair],
  mode:"MANUAL_ORIGINAL_NPC_FACTORY_BUYER_FINANCE",
  supportsLiveRuntime:false,supportsAutomaticAlife:false});
}
module.exports={createOriginalNpcIndustryBuyerSettlement};
