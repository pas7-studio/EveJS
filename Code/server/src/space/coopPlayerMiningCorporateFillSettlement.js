"use strict";
/**
 * CH24+31 E2B3 — original GameStore atomic CORPORATION SELL fill settlement.
 * Source-only, default OFF, trusted Rust claim and exact native fee oracle.
 * One COMMIT over original character wallet, corp Wallet 1000, original item,
 * native escrow and durable idempotent receipt; never PlaceOrder/FillOrder.
 */
const SEP="\u001f";
const TABLES=Object.freeze(["characters","corporationRuntime","items","marketEscrow","identityState"]);
const pos=n=>Number.isSafeInteger(n)&&n>0;
const safe=n=>Number.isSafeInteger(n)&&n>=0;
const ISK=n=>n/100, FLOOR=1990000000,JOURNAL_FLOOR=5100000000000000;
const cents=n=>{
 if(typeof n!=="number"||!Number.isFinite(n)||n<0)return null;
 const scaled=n*100,whole=Math.round(scaled);
 return safe(whole)&&Math.abs(whole-scaled)<=1e-6?whole:null;
};
const fillKey=(order,cycle)=>"coopPlayerMiningCorpFill"+SEP+order+":"+cycle;
const saleKey=cargo=>"coopPlayerMiningCorpSell"+SEP+cargo;
const corpKey=id=>"corporations"+SEP+id;
const marker=id=>"coop-warehouse:v1:cargo:"+id;
const validOrder=id=>typeof id==="string"&&/^[1-9][0-9]{0,17}$/.test(id)&&
 BigInt(id)+9200000000n<=BigInt(Number.MAX_SAFE_INTEGER);
function isValidClaim(c){
 return c?.verifiedNative===true&&c.phase==="claimed"&&c.state==="settling"&&
  c.source==="coop-corporation"&&c.is_corp===true&&c.bid===false&&
  validOrder(c.orderID)&&pos(c.cycle)&&pos(c.buyerCharacterID)&&
  pos(c.sellerCorpID)&&c.buyerCharacterID!==c.sellerCorpID&&
  pos(c.stationID)&&pos(c.typeID)&&pos(c.cargoID)&&pos(c.sourceItemID)&&
  pos(c.priceCents)&&pos(c.volumeBefore)&&pos(c.quantity)&&
  c.quantity<=c.volumeBefore&&safe(c.volumeAfter)&&
  c.volumeAfter===c.volumeBefore-c.quantity&&
  c.escrowLocationID===Number(BigInt(c.orderID)+9200000000n);
}
function createCorporateSellFillSettlement({gameStore,readNativeClaim,quoteNativeFees,
 clock=()=>Date.now(),enabled=()=>process.env.EVEJS_COOP_PLAYER_NPC_MINING_CORP_FILL==="1"}={}){
 const atomic=gameStore?.coopAtomicNativeRows;
 if(atomic?.mode!=="SERVER_INTERNAL_FLAGGED"||
  typeof atomic.transact!=="function"||typeof atomic.isPoisoned!=="function"||
  [readNativeClaim,quoteNativeFees,clock,enabled].some(fn=>typeof fn!=="function"))
  throw Error("CORP_FILL_ORIGINAL_NATIVE_AUTHORITIES_REQUIRED");
 const uncertain=new Set();
 const block=reason=>({status:"BLOCKED",reason,nativeMutation:false,
  realizedRevenueCents:null});
 function settle({orderID,cycle}={}){
  if(enabled()!==true)return block("CORP_FILL_DISABLED");
  if(!validOrder(orderID)||!pos(cycle)||uncertain.has(orderID))
   return block("CORP_FILL_ORDER_SCOPE_OR_OUTCOME_UNKNOWN");
  if(atomic.isPoisoned())return block("CORP_FILL_NATIVE_STORE_POISONED");
  let claim,fees;
  try{
   claim=readNativeClaim({orderID,cycle});
   if(!isValidClaim(claim)||claim.orderID!==orderID||claim.cycle!==cycle)
    return block("CORP_FILL_ORIGINAL_RUST_CLAIM_INVALID");
   const total=claim.quantity*claim.priceCents;
   if(!pos(total))return block("CORP_FILL_GROSS_OVERFLOW");
   fees=quoteNativeFees({claim,grossCents:total});
   if(!fees||!safe(fees.transactionTaxCents)||!safe(fees.brokerFeeCents)||
    !safe(fees.transactionTaxCents+fees.brokerFeeCents)||
    fees.transactionTaxCents+fees.brokerFeeCents>total||
    fees.verifiedNative!==true)
    return block("CORP_FILL_NATIVE_FEES_UNATTESTED");
  }catch{return block("CORP_FILL_RUST_OR_FEES_UNAVAILABLE")}
  return commit(claim,fees,orderID,cycle);
 }
 function commit(claim,fees,orderID,cycle){
  let called=false;
  try{
   called=true;
   return atomic.transact(TABLES,tx=>{
    const receiptKey=fillKey(orderID,cycle);
    const existing=tx.get("corporationRuntime",receiptKey);
    const gross=claim.quantity*claim.priceCents,
     totalFees=fees.transactionTaxCents+fees.brokerFeeCents,
     net=gross-totalFees;
    if(existing){
     if(existing.version!==1||existing.phase!=="GAMESTORE_COMMITTED"||
      existing.orderID!==orderID||existing.cycle!==cycle||
      existing.buyerCharacterID!==claim.buyerCharacterID||
      existing.sellerCorpID!==claim.sellerCorpID||
      existing.sourceItemID!==claim.sourceItemID||
      existing.cargoID!==claim.cargoID||
      existing.quantity!==claim.quantity||
      existing.volumeBefore!==claim.volumeBefore||
      existing.volumeAfter!==claim.volumeAfter||
      existing.priceCents!==claim.priceCents||
      existing.grossCents!==gross||
      existing.transactionTaxCents!==fees.transactionTaxCents||
      existing.brokerFeeCents!==fees.brokerFeeCents||
      existing.netRevenueCents!==net||
      !pos(existing.buyerJournalID)||!pos(existing.sellerJournalID)||
      (totalFees>0?!pos(existing.feeJournalID):existing.feeJournalID!==null)||
      !pos(existing.committedAt))
      throw Error("CORP_FILL_COMMITTED_REPLAY_MISMATCH");
     return {...existing,replayed:true,nativeMutation:false};
    }
    const receipt=tx.get("corporationRuntime",saleKey(claim.cargoID));
    const escrow=tx.get("marketEscrow",orderID);
    if(receipt?.version!==1||
     !["ESCROW_BOUND_UNSETTLED","ACTIVE_SELL"].includes(receipt.phase)||
     receipt.orderID!==orderID||receipt.itemID!==claim.sourceItemID||
     receipt.cargoID!==claim.cargoID||receipt.corporationID!==claim.sellerCorpID||
     receipt.typeID!==claim.typeID||receipt.stationID!==claim.stationID||
     receipt.escrowLocationID!==claim.escrowLocationID||
     !pos(receipt.quantity)||receipt.quantity<claim.volumeBefore||
     (receipt.remainingQuantity??receipt.quantity)!==claim.volumeBefore||
     (receipt.lastSettledCycle??0)!==cycle-1||
     escrow?.escrowType!=="sell"||escrow.isCorp!==true||
     escrow.ownerId!==claim.sellerCorpID||
     escrow.orderId!==orderID||escrow.typeId!==claim.typeID||
     escrow.stationId!==claim.stationID||
     escrow.escrowLocationID!==claim.escrowLocationID||
     escrow.remainingQuantity!==claim.volumeBefore||
     escrow.sourceItemIDs?.length!==1||
     escrow.sourceItemIDs[0]!==claim.sourceItemID)
     throw Error("CORP_FILL_ESCROW_CUSTODY_CHANGED");
    const item=tx.get("items",String(claim.sourceItemID));
    if(item?.itemID!==claim.sourceItemID||
     item.ownerID!==claim.sellerCorpID||
     item.locationID!==claim.escrowLocationID||item.flagID!==4||
     item.typeID!==claim.typeID||item.singleton!==0||
     item.quantity!==claim.volumeBefore||item.stacksize!==claim.volumeBefore||
     item.customInfo!==marker(claim.cargoID))
     throw Error("CORP_FILL_ORIGINAL_ITEM_CHANGED");
    if(tx.scan("items").filter(r=>r.value?.customInfo===marker(claim.cargoID)).length!==1)
     throw Error("CORP_FILL_DUPLICATE_SOURCE_CARGO_ID");
    const buyer=tx.get("characters",String(claim.buyerCharacterID));
    const seller=tx.get("corporationRuntime",corpKey(claim.sellerCorpID));
    const wallet=seller?.wallet?.divisions?.["1000"];
    if(!buyer||buyer.characterID!==undefined&&buyer.characterID!==claim.buyerCharacterID||
     !Array.isArray(buyer.walletJournal)||!Array.isArray(buyer.marketTransactions)||
     seller?.corporationID!==claim.sellerCorpID||
     !wallet||!Array.isArray(wallet.journal)||!Array.isArray(wallet.transactions))
     throw Error("CORP_FILL_NATIVE_WALLET_ROWS_MISSING");
    const a=cents(buyer.balance),b=cents(wallet.balance);
    if(a===null||b===null||a<gross||!safe(b+net))
     throw Error("CORP_FILL_BUYER_FUNDS_OR_PRECISION_INVALID");
    const now=clock();if(!pos(now))throw Error("CORP_FILL_CLOCK_INVALID");
    const journal=tx.get("identityState","coopCorpMiningMarketJournal");
    const next=journal?.next??JOURNAL_FLOOR;
    if(!pos(next)||next<JOURNAL_FLOOR||!pos(next+3))
     throw Error("CORP_FILL_JOURNAL_ID_EXHAUSTED");
    const idSet=[next,next+1,next+2];
    if([...buyer.walletJournal,...wallet.journal,
        ...wallet.transactions,...buyer.marketTransactions]
      .some(e=>idSet.includes(e?.transactionID)))
     throw Error("CORP_FILL_JOURNAL_ID_COLLISION");
    let deliveredItemID=claim.sourceItemID;
    if(claim.volumeAfter>0){
     const all=tx.scan("items"),counter=tx.get("identityState","nextItemID");
     if(!pos(counter)||counter<FLOOR||
      all.some(r=>!pos(r.value?.itemID)||r.key!==String(r.value.itemID)))
      throw Error("CORP_FILL_NATIVE_ALLOCATOR_INVALID");
     const highest=Math.max(FLOOR-1,...all.map(r=>r.value.itemID));
     deliveredItemID=Math.max(FLOOR,counter,highest+1);
     if(!pos(deliveredItemID+1)||
        tx.get("items",String(deliveredItemID))!==null)
      throw Error("CORP_FILL_NEW_ITEM_ID_COLLISION");
     tx.put("items",String(claim.sourceItemID),{
      ...item,quantity:claim.volumeAfter,stacksize:claim.volumeAfter});
     tx.put("identityState","nextItemID",deliveredItemID+1);
    }
    const buyerItem={...item,itemID:deliveredItemID,
     ownerID:claim.buyerCharacterID,locationID:claim.stationID,flagID:4,
     quantity:claim.quantity,stacksize:claim.quantity,
     customInfo:"coop-corp-sale:v1:"+orderID+":"+cycle,
     sourceCargoID:claim.cargoID,sourceItemID:claim.sourceItemID};
    tx.put("items",String(deliveredItemID),buyerItem);
    const filetime=String(BigInt(now)*10000n+116444736000000000n);
    const base={transactionDate:filetime,referenceID:receiptKey,
     currency:1,accountKey:1000,sortValue:1,ownerID1:claim.buyerCharacterID,
     ownerID2:claim.sellerCorpID};
    const debit={...base,transactionID:next,entryTypeID:2,
     amount:ISK(-gross),balance:ISK(a-gross),
     description:"Original native corporation SELL purchase"};
    const credit={...base,transactionID:next+1,entryTypeID:2,
     amount:ISK(gross),balance:ISK(b+gross),
     description:"Original native corporation SELL revenue"};
    const fee={...base,transactionID:next+2,entryTypeID:54,
     amount:ISK(-totalFees),balance:ISK(b+net),
     description:"Verified native corporation market taxes and fees"};
    const trade={transactionID:next,transactionDate:filetime,
     typeID:claim.typeID,quantity:claim.quantity,price:ISK(claim.priceCents),
     stationID:claim.stationID,locationID:claim.stationID,
     buyerID:claim.buyerCharacterID,sellerID:claim.sellerCorpID,
     buyerAccountID:1000,sellerAccountID:1000};
    tx.put("characters",String(claim.buyerCharacterID),{...buyer,
     balance:ISK(a-gross),balanceChange:ISK(-gross),
     walletJournal:[debit,...buyer.walletJournal].slice(0,100),
     marketTransactions:[trade,...buyer.marketTransactions].slice(0,2000)});
    tx.put("corporationRuntime",corpKey(claim.sellerCorpID),{...seller,
     wallet:{...seller.wallet,divisions:{...seller.wallet.divisions,"1000":{
      ...wallet,balance:ISK(b+net),
      transactions:[...wallet.transactions,credit,
        ...(totalFees?[fee]:[])].slice(-2000),
      journal:[...wallet.journal,credit,
        ...(totalFees?[fee]:[])].slice(-100)}}}});
    tx.put("marketEscrow",orderID,{...escrow,
     remainingQuantity:claim.volumeAfter,
     phase:claim.volumeAfter?"ACTIVE_SELL":"FULLY_SOLD",
     lastSettledCycle:cycle});
    const priorCycles=receipt.settledCycles??0;
    if(!safe(priorCycles)||priorCycles+1!==cycle)
     throw Error("CORP_FILL_CYCLE_OUT_OF_ORDER");
    tx.put("corporationRuntime",saleKey(claim.cargoID),{...receipt,
     phase:claim.volumeAfter?"ACTIVE_SELL":"FULLY_SOLD",
     lastSettledCycle:cycle,settledCycles:cycle,
     remainingQuantity:claim.volumeAfter});
    const result={version:1,phase:"GAMESTORE_COMMITTED",
     receiptKey,orderID,cycle,buyerCharacterID:claim.buyerCharacterID,
     sellerCorpID:claim.sellerCorpID,cargoID:claim.cargoID,
     sourceItemID:claim.sourceItemID,deliveredItemID,
     stationID:claim.stationID,typeID:claim.typeID,
     quantity:claim.quantity,volumeBefore:claim.volumeBefore,
     volumeAfter:claim.volumeAfter,priceCents:claim.priceCents,
     grossCents:gross,transactionTaxCents:fees.transactionTaxCents,
     brokerFeeCents:fees.brokerFeeCents,netRevenueCents:net,
     buyerJournalID:next,sellerJournalID:next+1,
     feeJournalID:totalFees?next+2:null,
     buyerBeforeCents:a,buyerAfterCents:a-gross,
     sellerBeforeCents:b,sellerAfterCents:b+net,
     committedAt:now,nativeMutation:true};
    tx.put("corporationRuntime",receiptKey,result);
    tx.put("identityState","coopCorpMiningMarketJournal",{next:next+3});
    return result;
   });
  }catch{
   if(called)uncertain.add(orderID);
   return block("CORP_FILL_NATIVE_SETTLEMENT_OUTCOME_UNKNOWN");
  }
 }

 async function settleAsync({orderID,cycle}={}){
  if(enabled()!==true)return block("CORP_FILL_DISABLED");
  if(!validOrder(orderID)||!pos(cycle)||uncertain.has(orderID))
   return block("CORP_FILL_ORDER_SCOPE_OR_OUTCOME_UNKNOWN");
  if(atomic.isPoisoned())return block("CORP_FILL_NATIVE_STORE_POISONED");
  let claim,fees;
  try{
   claim=await readNativeClaim({orderID,cycle});
   if(!isValidClaim(claim)||claim.orderID!==orderID||claim.cycle!==cycle)
    return block("CORP_FILL_ORIGINAL_RUST_CLAIM_INVALID");
   const gross=claim.quantity*claim.priceCents;
   if(!pos(gross))return block("CORP_FILL_GROSS_OVERFLOW");
   fees=await quoteNativeFees({claim,grossCents:gross});
   if(!fees||!safe(fees.transactionTaxCents)||!safe(fees.brokerFeeCents)||
    !safe(fees.transactionTaxCents+fees.brokerFeeCents)||
    fees.transactionTaxCents+fees.brokerFeeCents>gross||
    fees.verifiedNative!==true)
    return block("CORP_FILL_NATIVE_FEES_UNATTESTED");
  }catch{return block("CORP_FILL_RUST_OR_FEES_UNAVAILABLE")}
  return commit(claim,fees,orderID,cycle);
 }
 return Object.freeze({settle,settleAsync,requiresOperatorReconciliation:()=>[...uncertain],
  mode:"CORPORATE_ORIGINAL_FILL_ATOMIC_GATED",
  supportsLiveRustFill:false});
}
module.exports={createCorporateSellFillSettlement,fillKey,isValidClaim,TABLES};
