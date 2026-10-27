"use strict";
/**
 * CH24+31 E2B1 — original corporation-owned SELL escrow BIND.
 *
 * Source-only: requires an independently attested PREPARED_UNPUBLISHED
 * original Rust corporate SELL intent. This upstream state does not yet
 * exist; active OPEN orders are forbidden before native custody.
 * It NEVER publishes a market order, creates
 * a new item/owner/ISK, records a fill, or pays revenue. Until a safe Rust
 * reserve-before-publish protocol exists this must remain OFF.
 */
const SEP="\u001f",TABLES=Object.freeze(["items","corporationRuntime","marketEscrow"]);
const pos=x=>Number.isSafeInteger(x)&&x>0;
const money=x=>Number.isSafeInteger(x)&&x>=0;
const SHIFT=/^coop-mining-shift:[0-9a-f]{32}$/;
const ORDER=/^[1-9][0-9]{0,17}$/;
const MARKET_ESCROW_LOCATION_BASE=9200000000n;
const KEY=id=>"coopPlayerMiningCorpSell"+SEP+id;
const TITLE=id=>"coopPlayerMiningOreTitle"+SEP+id;
const ITEM=id=>String(id);
const ESCROW=id=>String(id);
const originalLocation=id=>{
 if(typeof id!=="string"||!ORDER.test(id))return null;
 const location=BigInt(id)+MARKET_ESCROW_LOCATION_BASE;
 return location<=BigInt(Number.MAX_SAFE_INTEGER)?Number(location):null;
};
function createOriginalCorporateSellCustody({gameStore,access,readiness,verifyNativeSellOrder,
 readCancelProof,clock=()=>Date.now(),enabled=()=>process.env.EVEJS_COOP_PLAYER_NPC_MINING_CORP_SELL_ESCROW==="1"}={}){
 const atomic=gameStore?.coopAtomicNativeRows;
 if(atomic?.mode!=="SERVER_INTERNAL_FLAGGED"||
  typeof atomic.transact!=="function"||typeof atomic.isPoisoned!=="function"||
  [access?.isMember,access?.canIndustry,access?.canWallet,access?.canTake,
   readiness?.inspect,verifyNativeSellOrder,readCancelProof,clock,enabled]
   .some(x=>typeof x!=="function"))
  throw Error("CORP_SELL_ORIGINAL_NATIVE_AUTHORITIES_REQUIRED");
 const uncertain=new Set();
 const denied=(reason)=>({status:"BLOCKED",reason,nativeMutation:false,
  marketOrderCreated:false,realizedRevenueCents:null});
 function role({session,corporationID,stationID,division}){
  return pos(session?.characterID)&&session?.socket?.destroyed!==true&&
   session.corporationID===corporationID&&
   access.isMember(session,corporationID)===true&&
   access.canIndustry(session,corporationID)===true&&
   access.canWallet(session,corporationID,1000)===true&&
   access.canTake(session,corporationID,stationID,division)===true;
 }
 function validAttestedOrder({proof,orderID,corporationID,ore}){
  const o=proof?.order;
  return proof?.verifiedNative===true&&
   proof?.phase==="PREPARED_UNPUBLISHED"&&proof.isPublished===false&&
   proof.totalFilled===0&&proof.totalPaidCents===0&&
   proof.orderID===orderID&&o?.order_id===orderID&&
   o.is_corp===true&&o.owner_id===corporationID&&
   o.bid===false&&o.station_id===ore.stationID&&
   o.type_id===ore.typeID&&o.vol_remaining===ore.quantity&&
   o.vol_entered===ore.quantity&&
   o.source==="coop-corporation"&&pos(o.price_cents)&&
   !o.escrowed&&o.state==="prepared";
 }
 function scope({session,corporationID,operationID,cargoID,orderID}){
  if(enabled()!==true)return {error:"CORP_SELL_CUSTODY_DISABLED"};
  if(!pos(corporationID)||!pos(cargoID)||!SHIFT.test(operationID||"")||
   typeof orderID!=="string"||!ORDER.test(orderID)||
   !originalLocation(orderID))
   return {error:"CORP_SELL_SCOPE_INVALID"};
  if(uncertain.has(cargoID))return {error:"CORP_SELL_OUTCOME_UNKNOWN"};
  if(atomic.isPoisoned())return {error:"CORP_SELL_NATIVE_ATOMIC_STORE_POISONED"};
  let quote;try{
   quote=readiness.inspect({session,corporationID,operationID,cargoIDs:[cargoID]});
  }catch{return {error:"CORP_SELL_ORIGINAL_READ_UNAVAILABLE"}}
  if(quote?.status!=="NATIVE_CORPORATE_SELL_UNSUPPORTED"||
    !Array.isArray(quote.originalCorporateOre)||
    quote.originalCorporateOre.length!==1||
    quote.originalCorporateOre[0]?.cargoID!==cargoID||
    quote.marketOrderCreated!==false)return {error:"CORP_SELL_ORIGINAL_CUSTODY_UNVERIFIED"};
  const ore=quote.originalCorporateOre[0];
  if(!role({session,corporationID,stationID:ore.stationID,division:ore.division}))
   return {error:"CORP_SELL_CORPORATE_ROLE_REVOKED"};
  return {ore};
 }
 function reserve(input={}){
  const {session,corporationID,operationID,cargoID,orderID}=input;
  const validated=scope(input);
  if(validated.error)return denied(validated.error);
  const ore=validated.ore,escrowLocationID=originalLocation(orderID);
  let proof;
  try{proof=verifyNativeSellOrder({orderID,corporationID,operationID,cargoID,ore});}
  catch{return denied("CORP_SELL_NATIVE_ORDER_WITNESS_UNAVAILABLE")}
  if(!validAttestedOrder({proof,orderID,corporationID,ore}))
   return denied("CORP_SELL_NATIVE_ORDER_NOT_ATTESTED");
  let called=false;
  try{
   const now=clock();if(!pos(now))return denied("CORP_SELL_CLOCK_INVALID");
   called=true;
   const result=atomic.transact(TABLES,tx=>{
    if(!role({session,corporationID,stationID:ore.stationID,division:ore.division})||
       validAttestedOrder({proof,orderID,corporationID,ore})!==true)
     throw Error("CORP_SELL_AUTHORITY_CHANGED");
    const receipt=tx.get("corporationRuntime",KEY(cargoID));
    if(receipt)throw Error("CORP_SELL_ORIGINAL_CARGO_ALREADY_RESERVED");
    const title=tx.get("corporationRuntime",TITLE(cargoID));
    if(title?.status!=="COMMITTED"||title.shiftID!==operationID||
     title.buyerCorpID!==corporationID||
     title.itemID!==ore.itemID||title.typeID!==ore.typeID||
     title.quantity!==ore.quantity||
     title.stationID!==ore.stationID||
     title.officeFolderID!==ore.officeFolderID||
     title.division!==ore.division)
     throw Error("CORP_SELL_ORIGINAL_TITLE_CHANGED");
    const original=tx.get("items",ITEM(ore.itemID));
    if(original?.itemID!==ore.itemID||original.ownerID!==corporationID||
       original.locationID!==ore.officeFolderID||
       original.flagID!==ore.division||original.singleton!==0||
       original.typeID!==ore.typeID||original.stacksize!==ore.quantity||
       original.quantity!==ore.quantity||
       original.customInfo!=="coop-warehouse:v1:cargo:"+cargoID)
     throw Error("CORP_SELL_ITEM_CHANGED");
    // No other corporate item/order may accidentally share this original
    // Rust order-derived location. Never silently mix two owners in escrow.
    const physicalRows=tx.scan("items");
    if(physicalRows.filter(r=>r.value?.customInfo===
      "coop-warehouse:v1:cargo:"+cargoID).length!==1)
     throw Error("CORP_SELL_DUPLICATE_ORIGINAL_CARGO_MARKER");
    if(tx.get("marketEscrow",ESCROW(orderID))!==null||
       physicalRows.some(r=>r.value?.locationID===escrowLocationID))
     throw Error("CORP_SELL_ORDER_OR_LOCATION_ALREADY_OCCUPIED");
    if(tx.scan("corporationRuntime").some(r=>String(r.key).startsWith(
       "coopPlayerMiningCorpSell"+SEP)&&
       (r.value?.itemID===ore.itemID||r.value?.orderID===orderID)))
     throw Error("CORP_SELL_DUPLICATE_NATIVE_ITEM_OR_ORDER");
    const captured={version:1,phase:"ESCROW_BOUND_UNSETTLED",
     operationID,cargoID,itemID:ore.itemID,typeID:ore.typeID,
     quantity:ore.quantity,corporationID,
     sellerRepresentativeCharacterID:session.characterID,stationID:ore.stationID,
     originalLocationID:ore.officeFolderID,originalFlagID:ore.division,
     escrowLocationID,orderID,createdAt:now,
     marketRevenueCents:null,marketOrderCreated:false};
    const escrow={orderId:orderID,escrowType:"sell",
     ownerId:corporationID,isCorp:true,
     typeId:ore.typeID,stationId:ore.stationID,
     escrowLocationID,remainingQuantity:ore.quantity,
     sourceItemIDs:[ore.itemID],phase:"ESCROW_BOUND_UNSETTLED"};
    tx.put("items",ITEM(ore.itemID),{...original,
     locationID:escrowLocationID,flagID:4});
    tx.put("marketEscrow",ESCROW(orderID),escrow);
    tx.put("corporationRuntime",KEY(cargoID),captured);
    return {status:"ESCROW_BOUND_UNSETTLED",receipt:captured,
     nativeMutation:true,marketOrderCreated:false,realizedRevenueCents:null};
   });
   return result;
  }catch(e){
   if(called)uncertain.add(cargoID);
   return denied("CORP_SELL_NATIVE_ESCROW_COMMIT_UNCERTAIN");
  }
 }
 function returnUnsold(input={}){
  const {session,corporationID,operationID,cargoID,orderID}=input;
  if(enabled()!==true)return denied("CORP_SELL_CUSTODY_DISABLED");
  if(!pos(corporationID)||!pos(cargoID)||!SHIFT.test(operationID||"")||
   !ORDER.test(orderID||"")||atomic.isPoisoned()||uncertain.has(cargoID))
   return denied("CORP_SELL_RETURN_SCOPE_INVALID_OR_UNCERTAIN");
  // Must check an ORIGINAL Rust terminal cancellation/expiry response,
  // and absence of any fill. Never trust a client-supplied cancelled flag.
  let cancellation;
  try{cancellation=readCancelProof({orderID,corporationID,cargoID});}
  catch{return denied("CORP_SELL_CANCEL_PROOF_UNAVAILABLE")}
  if(cancellation?.verifiedNative!==true||
   cancellation.orderID!==orderID||cancellation.ownerID!==corporationID||
   !["CANCELLED","EXPIRED"].includes(cancellation.phase)||
   cancellation.totalFilled!==0||cancellation.totalPaidCents!==0)
   return denied("CORP_SELL_ORIGINAL_MARKET_CANCEL_NOT_PROVEN");
  let called=false;
  try{
   called=true;
   return atomic.transact(TABLES,tx=>{
    const receipt=tx.get("corporationRuntime",KEY(cargoID));
    const stored=tx.get("marketEscrow",ESCROW(orderID));
    const item=receipt&&tx.get("items",ITEM(receipt.itemID));
    if(receipt?.phase!=="ESCROW_BOUND_UNSETTLED"||
      receipt.cargoID!==cargoID||receipt.orderID!==orderID||
      receipt.corporationID!==corporationID||
      receipt.operationID!==operationID||
      stored?.orderId!==orderID||stored.isCorp!==true||
      stored.escrowType!=="sell"||
      stored.ownerId!==corporationID||
      stored.remainingQuantity!==receipt.quantity||
      stored.escrowLocationID!==receipt.escrowLocationID||
      !Array.isArray(stored.sourceItemIDs)||
      stored.sourceItemIDs.length!==1||
      stored.sourceItemIDs[0]!==receipt.itemID||
      item?.itemID!==receipt.itemID||
      item.ownerID!==corporationID||
      item.locationID!==receipt.escrowLocationID||
      item.flagID!==4||item.quantity!==receipt.quantity||
      item.stacksize!==receipt.quantity||
      item.typeID!==receipt.typeID||
      item.customInfo!=="coop-warehouse:v1:cargo:"+cargoID)
      throw Error("CORP_SELL_REFUND_CUSTODY_UNVERIFIED");
    if(!role({session,corporationID,stationID:receipt.stationID,
       division:receipt.originalFlagID}))
      throw Error("CORP_SELL_REFUND_ROLE_REVOKED");
    tx.put("items",ITEM(receipt.itemID),{...item,
      locationID:receipt.originalLocationID,
      flagID:receipt.originalFlagID});
    // We preserve the original marketEscrow key as a terminal tombstone:
    // no other order can reuse that ID, including after restart.
    tx.put("marketEscrow",ESCROW(orderID),{...stored,
     phase:"RETURNED_UNFILLED",remainingQuantity:0});
    tx.put("corporationRuntime",KEY(cargoID),{
     ...receipt,phase:"RETURNED_UNFILLED",
     returnedAt:clock()});
    return {status:"RETURNED_UNFILLED",nativeMutation:true,
      originalItemID:receipt.itemID,marketOrderCreated:false,
      realizedRevenueCents:null};
   });
  }catch{
   if(called)uncertain.add(cargoID);
   return denied("CORP_SELL_RETURN_COMMIT_UNCERTAIN");
  }
 }
 return Object.freeze({reserve,returnUnsold,mode:"CORPORATE_ORIGINAL_SELL_ESCROW_ONLY",
  requiresOperatorReconciliation:()=>[...uncertain],supportsLiveOrderPlacement:false});
}
module.exports={createOriginalCorporateSellCustody,originalLocation,TABLES};
