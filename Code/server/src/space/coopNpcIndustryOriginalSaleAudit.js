"use strict";
// LW-04C3B: READ ONLY original Rust NPC buyer fill + GameStore/ItemStore
// corporation settlement auditor. Reuses COOP-035 whole fill and COOP-047
// partial fill receipts. NEVER credits an NPC wallet or moves native items.
const OP=/^npc-manufacture:[0-9a-f]{32}$/;
const KEY=/^npc-partial:[0-9a-f]{32}$/;
const POS=n=>Number.isSafeInteger(n)&&n>0;
const NN=n=>Number.isSafeInteger(n)&&n>=0;
const MAX=1000;
const deny=(reason,operationID=null)=>Object.freeze({status:"BLOCKED",reason,
 operationID,readOnly:true,nativeMutation:false});
const num=x=>typeof x==="number"&&Number.isSafeInteger(x)?x:
 typeof x==="string"&&/^(0|[1-9][0-9]*)$/.test(x)&&
 Number.isSafeInteger(Number(x))?Number(x):null;
function createOriginalNpcSaleSettlementAudit({director,listNativeReceipts,
 inspectRustFill,getNativeWalletEvidence,getOriginalItem,getOriginalEscrow,
 getRustOrder,maxFills=128}={}){
 if(typeof director?.inspect!=="function"||
   [listNativeReceipts,inspectRustFill,getNativeWalletEvidence,
    getOriginalItem,getOriginalEscrow,getRustOrder].some(fn=>typeof fn!=="function")||
   !POS(maxFills)||maxFills>MAX)
  throw Error("LW04C3B_ORIGINAL_FINANCIAL_READ_AUTHORITIES_REQUIRED");
 const load=(ownerID,stationID,operationID,orderID)=>{
  const journal=director.inspect();
  if(journal?.version!==1||!journal.entries||typeof journal.entries!=="object")
   throw Error("LW04C3B_SOURCE_JOURNAL_UNAVAILABLE");
  const entry=journal.entries[operationID];
  if(!entry||entry.operationID!==operationID||
     entry.ownerID!==ownerID||entry.stationID!==stationID||
     entry.orderID!==orderID||!POS(entry.jobID)||!POS(entry.itemID)||
     !POS(entry.typeID)||!POS(entry.quantity)||
     !["LISTED","SOLD"].includes(entry.phase))
   throw Error("LW04C3B_PRODUCER_OPERATION_UNVERIFIED");
  const own=Object.values(journal.entries).filter(x=>x?.operationID===operationID);
  if(own.length!==1)throw Error("LW04C3B_DUPLICATE_SOURCE_OPERATION");
  return JSON.parse(JSON.stringify(entry));
 };
 function originalWallet(r,proof){
  if(proof?.verifiedNative!==true||
     proof.source!=="ORIGINAL_CHARACTER_AND_CORPORATION_WALLET_JOURNALS"||
     proof.transactionID!==r.fillID||
     proof.ownerID!==r.ownerID||proof.buyerID!==r.buyerID||
     proof.orderID!==r.orderID||proof.buyerDebitCents!==r.grossCents||
     proof.corporateCreditCents!==r.grossCents)
   throw Error("LW04C3B_ORIGINAL_WALLET_RECEIPT_MISMATCH");
 }
 function sourceBuyerItem(r,e){
  const id=r.buyerItemID??r.itemID;
  const item=getOriginalItem(id);
  if(!item||item.itemID!==id||item.ownerID!==r.buyerID||
     item.locationID!==r.stationID||item.flagID!==4||
     item.typeID!==r.typeID||item.singleton!==0||
     item.quantity!==r.quantity||item.stacksize!==r.quantity||
     item.customInfo!=="coop-industry:v1:"+e.jobID)
   throw Error("LW04C3B_ORIGINAL_BUYER_ITEM_NOT_ATTESTED");
  return id;
 }
 function verifyReceipt(r,e,orderID){
  const partial=r?.phase==="NATIVE_PARTIAL_COMMITTED";
  if(!partial&&r?.phase!=="NATIVE_COMMITTED")
   throw Error("LW04C3B_UNKNOWN_NATIVE_FILL_PHASE");
  const fill=r.fillID,gross=r.grossCents,
   unit=partial?r.unitPriceCents:r.priceCents;
  if(!POS(fill)||!POS(r.buyerID)||!POS(r.ownerID)||
     !POS(r.quantity)||!POS(unit)||unit>100000000||
     !POS(gross)||gross!==r.quantity*unit||
     !Number.isSafeInteger(gross)||
     !NN(r.buyerBeforeCents)||!NN(r.buyerAfterCents)||
     !NN(r.corpBeforeCents)||!NN(r.corpAfterCents)||
     r.buyerBeforeCents-gross!==r.buyerAfterCents||
     r.corpBeforeCents+gross!==r.corpAfterCents||
     r.operationID!==e.operationID||r.orderID!==orderID||
     r.ownerID!==e.ownerID||r.stationID!==e.stationID||
     r.typeID!==e.typeID||!POS(r.committedAt))
   throw Error("LW04C3B_NATIVE_RECEIPT_IDENTITY_OR_ISK_INVALID");
  if(partial){
   if(!KEY.test(r.claimKey)||r.sourceItemID!==e.itemID||
      !POS(r.buyerItemID)||!POS(r.remainingBefore)||
      !NN(r.remainingAfter)||r.remainingBefore-r.quantity!==r.remainingAfter)
    throw Error("LW04C3B_NATIVE_PARTIAL_REMAINING_INVALID");
  }else if(r.coopSource!=="NATIVE_INDUSTRY"||
      r.itemID!==e.itemID||r.quantity!==e.quantity)
   throw Error("LW04C3B_NATIVE_FULL_FILL_SOURCE_INVALID");
  return {mode:partial?"partial":"whole",fillID:fill,claimKey:partial?r.claimKey:null,
   buyerID:r.buyerID,quantity:r.quantity,remainingBefore:partial?r.remainingBefore:e.quantity,
   remainingAfter:partial?r.remainingAfter:0,priceCents:unit,grossCents:gross,
   itemID:sourceBuyerItem(r,e)};
 }
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 async function audit({ownerID,stationID,operationID,orderID}={}){
  if(!POS(ownerID)||!POS(stationID)||!POS(orderID)||!OP.test(operationID||""))
   return deny("LW04C3B_SCOPE_INVALID",operationID);
  try{
   const entry=load(ownerID,stationID,operationID,orderID);
   const read=await Promise.all([listNativeReceipts(orderID),getRustOrder(operationID)]);
   const receipts=read[0],beforeOrder=read[1];
   if(!Array.isArray(receipts)||receipts.length>maxFills)
    throw Error("LW04C3B_GAMESTORE_RECEIPTS_UNAVAILABLE_OR_OVER_BUDGET");
   // Native receipt scans have no guaranteed row iteration order. Restore
   // original decreasing remainingBefore order without editing the source
   // array; subsequent contiguous conservation checks still reject gaps,
   // duplicate fills and mixed whole/partial provenance.
   const chronological=receipts.slice().sort((a,b)=>
    (b?.remainingBefore??entry.quantity)-(a?.remainingBefore??entry.quantity)||
    (a?.committedAt??0)-(b?.committedAt??0)||
    (a?.fillID??0)-(b?.fillID??0));
   if(!beforeOrder||beforeOrder.operation_id!==operationID||
      num(beforeOrder.order_id)!==orderID||
      num(beforeOrder.owner_id)!==ownerID||
      num(beforeOrder.station_id)!==stationID||
      num(beforeOrder.source_item_id)!==entry.itemID||
      num(beforeOrder.type_id)!==entry.typeID||
      beforeOrder.source!=="coop-npc"||beforeOrder.is_corp!==true||
      beforeOrder.bid!==false||!["open","filled","settling"].includes(beforeOrder.state)||
      !NN(num(beforeOrder.vol_remaining))||
      num(beforeOrder.vol_remaining)>entry.quantity)
    throw Error("LW04C3B_RUST_ORDER_SOURCE_CHANGED");
   const seenFill=new Set(),seenClaim=new Set(),reviewed=[];
   let remaining=entry.quantity,gross=0;
   for(const row of chronological){
    const f=verifyReceipt(row,entry,orderID);
    if(seenFill.has(f.fillID)||f.claimKey&&seenClaim.has(f.claimKey))
     throw Error("LW04C3B_DUPLICATE_NATIVE_FILL");
    seenFill.add(f.fillID);
    if(f.claimKey)seenClaim.add(f.claimKey);
    if(f.remainingBefore!==remaining||
       (f.mode==="whole"&&reviewed.length!==0))
     throw Error("LW04C3B_FILL_SEQUENCE_NOT_CONSERVED");
    const rust=await inspectRustFill({operationID,orderID,
     mode:f.mode,claimKey:f.claimKey,fillID:f.fillID});
    if(!rust||rust.operation_id!==operationID||
       num(rust.order_id)!==orderID||
       num(rust.fill_id)!==f.fillID||
       num(rust.buyer_id)!==f.buyerID||
       (f.mode==="partial"?rust.fill_phase!=="finalized":
         rust.fill_phase!=null&&rust.fill_phase!=="finalized")||
       !["open","filled"].includes(rust.state)||
       f.mode==="partial"&&(rust.claim_key!==f.claimKey||
         num(rust.remaining_after)!==f.remainingAfter)||
       f.mode==="whole"&&rust.state!=="filled")
     throw Error("LW04C3B_RUST_FILL_NOT_FINALIZED");
    originalWallet(row,await getNativeWalletEvidence(f.fillID,row));
    remaining=f.remainingAfter;
    gross+=f.grossCents;
    if(!Number.isSafeInteger(gross)||gross>1000000000000)
     throw Error("LW04C3B_REVENUE_OVERFLOW");
    reviewed.push(f);
   }
   if(num(beforeOrder.vol_remaining)!==remaining)
    throw Error("LW04C3B_RUST_REMAINING_NOT_CONSERVED");
   if(remaining>0){
    if(beforeOrder.state!=="open"||entry.phase==="SOLD")
     throw Error("LW04C3B_RUST_OPEN_STATE_CONFLICT");
    const escrow=getOriginalEscrow(orderID);
    const source=getOriginalItem(entry.itemID);
    if(!escrow||escrow.coopOperationID!==operationID||
       escrow.sourceItemID!==entry.itemID||
       escrow.ownerId!==ownerID||escrow.stationId!==stationID||
       escrow.remainingQuantity!==remaining||
       source?.ownerID!==ownerID||source.locationID!==9200000000+orderID||
       source.quantity!==remaining||source.stacksize!==remaining)
     throw Error("LW04C3B_REMAINING_ESCROW_NOT_ATTESTED");
   }else if(receipts.length>0){
    if(beforeOrder.state!=="filled"||
       getOriginalEscrow(orderID)!=null)
     throw Error("LW04C3B_RUST_FILLED_OR_ESCROW_STALE");
   }
   const after=load(ownerID,stationID,operationID,orderID);
   const again=await getRustOrder(operationID);
   if(!same(entry,after)||!same(beforeOrder,again))
    throw Error("LW04C3B_AUTHORITY_CHANGED_DURING_READ");
   return Object.freeze({status:remaining===0&&reviewed.length>0?
    "ORIGINAL_FULL_SALE_ATTESTED":reviewed.length?
    "ORIGINAL_PARTIAL_SALE_ATTESTED":"ORIGINAL_ORDER_AWAITING_BUYER",
    operationID,orderID,ownerID,stationID,quantity:entry.quantity,
    soldQuantity:entry.quantity-remaining,remainingQuantity:remaining,
    revenueCents:gross,fillIDs:reviewed.map(x=>x.fillID),
    proof:"RUST_FINALIZED_GAMESTORE_BUYER_ITEM_AND_CORP_WALLET",
    nativeMutation:false,readOnly:true,
    journalAlreadySold:entry.phase==="SOLD"});
  }catch(error){
   return deny("LW04C3B_FINANCIAL_AUDIT_UNAVAILABLE:"+
    String(error?.message||error).slice(0,100),operationID);
  }
 }
 return Object.freeze({audit,mode:"ORIGINAL_NATIVE_RUST_FINANCIAL_RECEIPT_AUDIT",
  supportsLiveRuntime:false,supportsNativeMutation:false});
}
module.exports={createOriginalNpcSaleSettlementAudit};
