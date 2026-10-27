"use strict";
// LW-04C3B: original EveJS wallet journal witness after COOP-035/047.
// Read-only: NO Rust claim/finalize, GameStore transact, credit or refund.
// A receipt missing from the original bounded journals is UNVERIFIED,
// even when a synthetic outstanding balance happens to match.
const POS=n=>Number.isSafeInteger(n)&&n>0;
const CENTS=n=>{
 if(typeof n!=="number"||!Number.isFinite(n)||n<0)return null;
 const raw=n*100,integer=Math.round(raw);
 return Number.isSafeInteger(integer)&&Math.abs(raw-integer)<1e-6?integer:null;
};
function createOriginalNpcWalletReceiptWitness({getCorporation,getCharacter}={}){
 if(typeof getCorporation!=="function"||typeof getCharacter!=="function")
  throw Error("LW04C3B_ORIGINAL_WALLET_READERS_REQUIRED");
 const invalid=()=>({verifiedNative:false});
 function verify(fillID,receipt){
  if(!POS(fillID)||receipt?.fillID!==fillID||
     !POS(receipt.ownerID)||!POS(receipt.buyerID)||
     !POS(receipt.orderID)||!POS(receipt.grossCents)||
     !Number.isSafeInteger(receipt.grossCents)||
     !Number.isSafeInteger(receipt.buyerAfterCents)||
     !Number.isSafeInteger(receipt.corpAfterCents)||
     receipt.buyerAfterCents<0||receipt.corpAfterCents<0)
   return invalid();
  try{
   const corp=getCorporation(receipt.ownerID),char=getCharacter(receipt.buyerID);
   const division=corp?.wallet?.divisions?.["1000"];
   const sellerRows=division?.transactions,buyerRows=char?.walletJournal,
    trades=char?.marketTransactions;
   if(corp?.corporationID!==receipt.ownerID||
      Number(char?.characterID??char?.charID)!==receipt.buyerID||
      !Array.isArray(sellerRows)||!Array.isArray(buyerRows)||
      !Array.isArray(trades)||!Array.isArray(division.journal))
    return invalid();
   const one=(rows)=>{const found=rows.filter(x=>x?.transactionID===fillID);
    return found.length===1?found[0]:null;};
   const seller=one(sellerRows),sellerJournal=one(division.journal),
    buyer=one(buyerRows),trade=one(trades);
   if(!seller||!sellerJournal||!buyer||!trade)return invalid();
   const corpAmount=CENTS(seller.amount),journalAmount=CENTS(sellerJournal.amount);
   const debit=typeof buyer.amount==="number"?CENTS(-buyer.amount):null;
   const postBuyer=CENTS(buyer.balance),postCorp=CENTS(seller.balance);
   if(corpAmount!==receipt.grossCents||journalAmount!==receipt.grossCents||
      debit!==receipt.grossCents||
      postBuyer!==receipt.buyerAfterCents||
      postCorp!==receipt.corpAfterCents||
      CENTS(sellerJournal.balance)!==receipt.corpAfterCents||
      seller.referenceID!==receipt.orderID||
      sellerJournal.referenceID!==receipt.orderID||
      buyer.referenceID!==receipt.orderID||
      trade.journalRefID!==fillID||
      trade.sellerID!==receipt.ownerID||
      trade.buyerID!==receipt.buyerID||
      trade.stationID!==receipt.stationID||
      trade.typeID!==receipt.typeID||
      trade.quantity!==receipt.quantity)
    return invalid();
   const currentCorp=CENTS(division.balance),currentBuyer=CENTS(char.balance);
   if(currentCorp===null||currentBuyer===null)return invalid();
   // The buyer may have spent more ISK since settlement: do not compare
   // the current balance to historical post-transaction receipts.
   return Object.freeze({verifiedNative:true,transactionID:fillID,
    ownerID:receipt.ownerID,buyerID:receipt.buyerID,orderID:receipt.orderID,
    buyerDebitCents:receipt.grossCents,
    corporateCreditCents:receipt.grossCents,
    source:"ORIGINAL_CHARACTER_AND_CORPORATION_WALLET_JOURNALS"});
  }catch(_error){return invalid()}
 }
 return Object.freeze({verify,mode:"READ_ONLY_NATIVE_NPC_WALLET_WITNESS",
  supportsNativeMutation:false});
}
module.exports={createOriginalNpcWalletReceiptWitness};
