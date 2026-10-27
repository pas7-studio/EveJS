"use strict";
// COOP-053: READ-ONLY cross-DB recovery audit. Never clears lock,
// changes journal, reclaims a Rust order, or issues a wallet transaction.
const pos=n=>Number.isSafeInteger(n)&&n>0;
const nn=n=>Number.isSafeInteger(n)&&n>=0;
const numeric=n=>typeof n==="string"&&/^(0|[1-9][0-9]*)$/.test(n)?Number(n):n;
const keyOk=k=>typeof k==="string"&&/^npc-corpbuy:[0-9a-f]{32}$/.test(k);
const hold=(reason,claimKey)=>({status:"HOLD_MANUAL",reason,claimKey});
function validEntry(id,e){
 const k=e?.buyerCorpID+":"+e?.orderID;
 return id===k&&["PREPARED","SETTLED"].includes(e?.phase)&&
  keyOk(e.claimKey)&&pos(e.buyerCorpID)&&pos(e.orderID)&&
  pos(e.sellerID)&&pos(e.stationID)&&pos(e.typeID)&&
  pos(e.quantity)&&e.quantity<=50000&&
  pos(e.unitPriceCents)&&e.unitPriceCents<=100000000&&
  e.quantity*e.unitPriceCents<=100000000000&&
  nn(e.minReserveCents)&&e.sellerID!==e.buyerCorpID;
}
function verifyRust(r,e){
 if(!r||r.claim_key!==e.claimKey||r.source!=="player"||
    r.is_corp!==false||r.bid!==false||
    !["settling","filled"].includes(r.state)||
    (r.state==="settling"&&r.fill_phase!=="claimed")||
    (r.state==="filled"&&r.fill_phase!=="finalized")||
    numeric(r.order_id)!==e.orderID||
    numeric(r.buyer_corp_id)!==e.buyerCorpID||
    numeric(r.owner_id)!==e.sellerID||
    numeric(r.station_id)!==e.stationID||
    numeric(r.type_id)!==e.typeID||
    numeric(r.quantity)!==e.quantity||
    numeric(r.price_cents)!==e.unitPriceCents||
    !pos(numeric(r.fill_id)))return false;
 if(r.state==="settling")
  return r.history_recorded===false&&
   numeric(r.vol_remaining)===e.quantity;
 return r.history_recorded===true&&
   typeof r.history_day==="string"&&
   /^\d{4}-\d{2}-\d{2}$/.test(r.history_day)&&
   numeric(r.vol_remaining)===0;
}
function verifyReceipt(r,e,fillID){
 if(r?.phase!=="NATIVE_NPC_BUY_COMMITTED"||
    r.claimKey!==e.claimKey||r.fillID!==fillID||
    r.orderID!==e.orderID||r.buyerCorpID!==e.buyerCorpID||
    r.sellerID!==e.sellerID||r.stationID!==e.stationID||
    r.typeID!==e.typeID||r.quantity!==e.quantity||
    r.priceCents!==e.unitPriceCents||
    r.grossCents!==e.quantity*e.unitPriceCents||
    !nn(r.taxCents)||r.taxCents>r.grossCents||
    !nn(r.netCents)||r.netCents!==r.grossCents-r.taxCents||
    r.taxPolicy!=="EVEJS_NATIVE_MARKET_RULES"||
    !pos(r.itemID)||!pos(r.committedAt)||
    // Read-only recovery must hold the same financial standard as the
    // native transactional replay; never suggest finalizing fake paid rows.
    !nn(r.buyerBeforeCents)||!nn(r.buyerAfterCents)||
    !nn(r.sellerBeforeCents)||!nn(r.sellerAfterCents)||
    r.buyerBeforeCents<r.grossCents||
    r.buyerAfterCents!==r.buyerBeforeCents-r.grossCents||
    !nn(r.sellerBeforeCents+r.grossCents)||
    r.sellerAfterCents!==r.sellerBeforeCents+r.netCents||
    r.taxTransactionID!==(r.taxCents>0?fillID+100000000000000:null))
    return false;
 return true;
}
async function auditNativeNpcBuyerRecovery({journal,inspectRustClaim,
 listGameStoreReceipts,lockPresent=false}={}){
 if(journal?.version!==1||!journal.entries||
    typeof journal.entries!=="object"||Array.isArray(journal.entries)||
    typeof inspectRustClaim!=="function"||
    typeof listGameStoreReceipts!=="function"||
    typeof lockPresent!=="boolean")
  throw Error("NPC_BUY_RECOVERY_AUTHORITIES_REQUIRED");
 const entries=Object.entries(journal.entries);
 if(entries.length>5000)throw Error("NPC_BUY_RECOVERY_JOURNAL_CAP");
 // Preclassify ALL duplicate keys before consulting any native authority:
 // otherwise the first occurrence could advertise a recovery action.
 const countByClaim=new Map(),out=[];
 for(const [,e] of entries){
  if(keyOk(e?.claimKey))
   countByClaim.set(e.claimKey,(countByClaim.get(e.claimKey)||0)+1);
 }
 for(const [id,e] of entries){
  if(!validEntry(id,e)||countByClaim.get(e.claimKey)>1){
   out.push({id,...hold("JOURNAL_IDENTITY_CONFLICT",e?.claimKey)});
   continue;
  }
  let rust,receipts;
  try{
   [rust,receipts]=await Promise.all([
    inspectRustClaim(e.claimKey),listGameStoreReceipts(e.claimKey)
   ]);
  }catch{
   out.push({id,...hold("AUTHORITATIVE_DB_UNAVAILABLE",e.claimKey)});
   continue;
  }
  if(!Array.isArray(receipts)||receipts.length>1){
   out.push({id,...hold("GAMESTORE_RECEIPTS_AMBIGUOUS",e.claimKey)});
   continue;
  }
  const receipt=receipts[0]||null;
  if(rust===null){
   out.push({id,...(receipt?hold("GAMESTORE_RECEIPT_WITHOUT_RUST_CLAIM",e.claimKey):
    e.phase==="PREPARED"?{
     status:"RETRY_SAME_CLAIM",claimKey:e.claimKey,
     reason:"EXPLICIT_RUST_CLAIM_ABSENT",requiresOperator:true
    }:hold("JOURNAL_SETTLED_BUT_RUST_CLAIM_MISSING",e.claimKey))});
   continue;
  }
  if(!verifyRust(rust,e)){
   out.push({id,...hold("RUST_CLAIM_IDENTITY_OR_HISTORY_CONFLICT",e.claimKey)});
   continue;
  }
  const fillID=numeric(rust.fill_id);
  if(receipt&&!verifyReceipt(receipt,e,fillID)){
   out.push({id,...hold("GAMESTORE_RECEIPT_IDENTITY_OR_TAX_CONFLICT",e.claimKey)});
   continue;
  }
  if(e.phase==="SETTLED"&&(!receipt||rust.state!=="filled"||
     e.fillID!==fillID||e.itemID!==receipt.itemID)){
   out.push({id,...hold("SETTLED_JOURNAL_DIVERGED_FROM_NATIVE",e.claimKey)});
   continue;
  }
  if(rust.state==="filled"&&!receipt){
   out.push({id,...hold("RUST_FINALIZED_WITHOUT_GAMESTORE_RECEIPT",e.claimKey)});
   continue;
  }
  if(rust.state==="settling"&&!receipt){
   out.push({id,status:"RESUME_GAMESTORE_SAME_CLAIM",
    claimKey:e.claimKey,fillID,requiresOperator:true});
   continue;
  }
  if(rust.state==="settling"&&receipt){
   out.push({id,status:"FINALIZE_RUST_SAME_CLAIM",
    claimKey:e.claimKey,fillID,requiresOperator:true});
   continue;
  }
  if(rust.state==="filled"&&receipt&&e.phase==="PREPARED"){
   out.push({id,status:"ACK_JOURNAL_SAME_CLAIM",
    claimKey:e.claimKey,fillID,itemID:receipt.itemID,
    quantity:receipt.quantity,requiresOperator:true,
    historyDay:rust.history_day});
   continue;
  }
  if(rust.state==="filled"&&receipt&&e.phase==="SETTLED"){
   out.push({id,status:"CONSISTENT",claimKey:e.claimKey,
    fillID,historyDay:rust.history_day,requiresOperator:false});
   continue;
  }
  out.push({id,...hold("UNRECOGNIZED_CROSS_DB_STATE",e.claimKey)});
 }
 return Object.freeze({status:out.some(x=>x.status==="HOLD_MANUAL")?
  "HOLD_MANUAL":lockPresent?"LOCK_PRESENT_OPERATOR_REQUIRED":"AUDITED",
  lockPresent,changed:false,entries:out,
  note:"Read-only evidence classification. Never delete lock or issue a new claimKey automatically."});
}
module.exports={auditNativeNpcBuyerRecovery};
