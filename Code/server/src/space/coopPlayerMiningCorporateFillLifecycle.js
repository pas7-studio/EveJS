"use strict";
/**
 * CH24+31 E2B4 — trusted ORIGINAL corporate Rust fill lifecycle.
 * No public API, no stock client or market mutation: requires a privately
 * authenticated match supplied by the server-side native orderbook authority.
 * Rust keeps original exclusive order lock until native GameStore receipt
 * and independently verified FinalizeCorpFill + ReleaseCorpFill.
 */
const ORDER=/^[1-9][0-9]{0,17}$/;
const pos=x=>Number.isSafeInteger(x)&&x>0;
const fillKey=(id,cycle)=>"coopPlayerMiningCorpFill\u001f"+id+":"+cycle;
const orderLocation=id=>Number(BigInt(id)+9200000000n);
function createCorporateFillLifecycle({
 marketClient,getTrustedMatch,settlement,token,enabled=()=>process.env.EVEJS_COOP_PLAYER_NPC_MINING_CORP_FILL_LIFECYCLE==="1",observe=()=>{}
}={}){
 if(typeof marketClient?.call!=="function"||
  typeof getTrustedMatch!=="function"||
  typeof settlement?.settle!=="function"&&typeof settlement?.settleAsync!=="function"||
  typeof token!=="string"||token.length<32||token.length>256||
  typeof enabled!=="function"||typeof observe!=="function")
  throw Error("CORP_FILL_LIFECYCLE_NATIVE_AUTHORITIES_REQUIRED");
 const inFlight=new Set(),unknown=new Set(),completed=new Map();
 const blocked=(reason,orderID)=>Object.freeze({
  status:"BLOCKED",reason,orderID,nativeMutation:false,
  realizedRevenueCents:null});
 function verifyMatch(m,orderID,cycle){
  return m?.verifiedNative===true&&m.source==="coop-corporation"&&
   m.is_corp===true&&m.bid===false&&
   m.orderID===orderID&&m.cycle===cycle&&
   pos(m.buyerCharacterID)&&pos(m.sellerCorpID)&&
   m.buyerCharacterID!==m.sellerCorpID&&
   pos(m.volumeBefore)&&pos(m.quantity)&&m.quantity<=m.volumeBefore&&
   pos(m.priceCents)&&
   m.volumeBefore*m.priceCents<=Number.MAX_SAFE_INTEGER;
 }
 function verifyClaim(c,m,orderID,cycle){
  return c?.verifiedNative===true&&c.phase==="claimed"&&
   c.state==="settling"&&c.source==="coop-corporation"&&
   c.is_corp===true&&c.bid===false&&
   c.orderID===orderID&&c.cycle===cycle&&
   c.buyerCharacterID===m.buyerCharacterID&&
   c.sellerCorpID===m.sellerCorpID&&
   c.volumeBefore===m.volumeBefore&&
   c.quantity===m.quantity&&
   c.priceCents===m.priceCents&&
   c.volumeAfter===m.volumeBefore-m.quantity&&
   c.escrowLocationID===orderLocation(orderID)&&
   pos(c.cargoID)&&pos(c.sourceItemID)&&
   pos(c.stationID)&&pos(c.typeID);
 }
 async function processVerifiedMatch({orderID,cycle}={}){
  if(enabled()!==true)return blocked("CORP_FILL_LIFECYCLE_DISABLED",orderID);
  if(typeof orderID!=="string"||!ORDER.test(orderID)||
   BigInt(orderID)+9200000000n>BigInt(Number.MAX_SAFE_INTEGER)||
   !pos(cycle))return blocked("CORP_FILL_MATCH_SCOPE_INVALID",orderID);
  if(unknown.has(orderID))return blocked("CORP_FILL_OUTCOME_UNKNOWN",orderID);
  if(inFlight.has(orderID))return blocked("CORP_FILL_ORDER_ALREADY_IN_FLIGHT",orderID);
  const key=orderID+":"+cycle;
  if(completed.has(key))return {...completed.get(key),replayed:true};
  let m;
  try{m=await getTrustedMatch({orderID,cycle})}
  catch{return blocked("CORP_FILL_NATIVE_MATCH_UNAVAILABLE",orderID)}
  if(!verifyMatch(m,orderID,cycle))
   return blocked("CORP_FILL_NATIVE_MATCH_NOT_ATTESTED",orderID);
  const args={access_token:token,order_id:orderID,cycle,
   buyer_id:m.buyerCharacterID,volume_before:m.volumeBefore,
   filled_quantity:m.quantity,price_cents:m.priceCents};
  inFlight.add(orderID);
  let issued=false;
  try{
   issued=true;
   const one=await marketClient.call("ClaimCorpFill",args);
   const two=await marketClient.call("GetCorpFillClaim",{
    access_token:token,order_id:orderID,cycle});
   if(!verifyClaim(one,m,orderID,cycle)||!verifyClaim(two,m,orderID,cycle)||
      JSON.stringify(one)!==JSON.stringify(two))
    throw Error("CORP_FILL_RUST_CLAIM_CHANGED");
   // Synchronous original GameStore atomic COMMIT. It must obtain its own
   // verified Rust source claim + separately trusted native fee quote.
   const receipt=typeof settlement.settleAsync==="function"?
    await settlement.settleAsync({orderID,cycle}):
    await settlement.settle({orderID,cycle});
   if(!receipt||receipt.phase!=="GAMESTORE_COMMITTED"||
    receipt.orderID!==orderID||receipt.cycle!==cycle||
    receipt.buyerCharacterID!==two.buyerCharacterID||
    receipt.sellerCorpID!==two.sellerCorpID||
    receipt.cargoID!==two.cargoID||
    receipt.sourceItemID!==two.sourceItemID||
    receipt.quantity!==two.quantity||
    receipt.volumeAfter!==two.volumeAfter||
    receipt.priceCents!==two.priceCents||
    receipt.receiptKey!==fillKey(orderID,cycle)||
    !pos(receipt.buyerJournalID)||!pos(receipt.sellerJournalID))
    throw Error("CORP_FILL_NATIVE_GAMESTORE_NOT_COMMITTED");
   const finale=await marketClient.call("FinalizeCorpFill",{
    access_token:token,order_id:orderID,cycle});
   if(finale?.phase!=="finalized"||
    finale.orderID!==orderID||finale.cycle!==cycle||
    finale.receiptKey!==fillKey(orderID,cycle)||
    finale.volumeAfter!==receipt.volumeAfter||
    finale.verifiedGameStore!==true||finale.requiresRelease!==true)
    throw Error("CORP_FILL_NATIVE_FINALIZE_PROOF_INVALID");
   const release=await marketClient.call("ReleaseCorpFill",{
    access_token:token,order_id:orderID,cycle});
   if(release?.phase!=="released"||
      release.orderID!==orderID||release.cycle!==cycle||
      release.receiptKey!==fillKey(orderID,cycle)||
      release.volumeAfter!==receipt.volumeAfter||
      release.state!==(receipt.volumeAfter===0?"filled":"open")||
      release.verifiedGameStore!==true||release.invalidated!==true)
    throw Error("CORP_FILL_NATIVE_RELEASE_PROOF_INVALID");
   const result=Object.freeze({status:"CORP_SELL_FILL_RELEASED",
    orderID,cycle,receiptKey:receipt.receiptKey,
    buyerCharacterID:receipt.buyerCharacterID,
    sellerCorpID:receipt.sellerCorpID,
    deliveredItemID:receipt.deliveredItemID,
    originalSourceItemID:receipt.sourceItemID,
    stationID:receipt.stationID,
    filledQuantity:receipt.quantity,
    remainingQuantity:receipt.volumeAfter,
    verifiedGrossCents:receipt.grossCents,
    verifiedNetRevenueCents:receipt.netRevenueCents,
    nativeMutation:true,realizedRevenueCents:receipt.netRevenueCents});
   completed.set(key,result);
   try{observe("corp-mining-fill-released",result)}catch{}
   return result;
  }catch{
   // Even if Rust's ACK is lost after native COMMIT, do not re-charge
   // the buyer or redispatch the claim automatically. Operator recovery
   // must use independent Rust / original GameStore receipts.
   if(issued)unknown.add(orderID);
   return blocked("CORP_FILL_CLAIM_COMMIT_OR_RELEASE_UNCERTAIN",orderID);
  }finally{inFlight.delete(orderID)}
 }
 return Object.freeze({
  processVerifiedMatch,
  requiresOperatorReconciliation:()=>[...unknown],
  mode:"ORIGINAL_CORP_RUST_ATOMIC_FILL_LIFECYCLE",
  supportsPublicMarket:false
 });
}
module.exports={createCorporateFillLifecycle,fillKey};
