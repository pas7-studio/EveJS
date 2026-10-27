"use strict";
// P0 native player BUY escrow payee: original wallet reserve is the ONLY
// source of seller ISK. No buyer debit, no synthetic balance or item mint.
// First supported native SELLER source: one full hangar stack, one BUY fill.
const {validDebitReceipt}=require("./coopPlayerMarketBuyReserve"+
 (__filename.endsWith(".cjs")?".cjs":""));
const TABLES=Object.freeze(["characters","items","marketEscrow","identityState","playerMarketFills"]);
const pos=n=>typeof n==="number"&&Number.isSafeInteger(n)&&n>0;
const safe=n=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
const cents=n=>{
 if(typeof n!=="number"||!Number.isFinite(n)||n<0)return null;
 const v=n*100,k=Math.round(v);
 return safe(k)&&Math.abs(v-k)<=1e-6?k:null;
};
const key=t=>"p2p:"+t.orderID+":"+t.cycle;
const money=n=>n/100;
const reserveID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// A committed BUY payout proves that one original, actually funded BUY
// reserve paid this seller. The witness is required both for Rust release
// and idempotent crash replay (which must never re-credit seller ISK).
function validPaidReceipt(r,proof,ticket,amounts){
 if(!r||r.kind!=="P2P_BUY_PAID"||r.phase!=="GAMESTORE_COMMITTED"||
    r.key!==key(ticket)||r.orderID!==ticket.orderID||
    r.cycle!==ticket.cycle||r.buyerID!==proof.ownerID||
    r.sellerID!==proof.counterpartyID||
    r.stationID!==proof.stationID||r.typeID!==proof.typeID||
    r.quantity!==proof.filledQuantity||
    r.volumeBefore!==proof.volumeBefore||
    r.volumeAfter!==proof.volumeAfter||
    r.priceCents!==proof.priceCents||
    r.grossCents!==amounts.gross||
    !pos(r.sourceItemID)||r.itemID!==r.sourceItemID||
    !reserveID.test(r.reserveOperationID)||
    r.reserveReceiptKey!=="buy-reserve:"+r.reserveOperationID||
    r.reserveBeforeCents!==amounts.reserveBefore||
    r.reserveAfterCents!==amounts.reserveAfter||
    !safe(r.buyerBeforeCents)||!safe(r.buyerAfterCents)||
    r.buyerBeforeCents!==r.buyerAfterCents||
    !safe(r.taxCents)||r.taxCents>amounts.gross||
    !safe(r.sellerBeforeCents)||!safe(r.sellerAfterCents)||
    !safe(r.sellerBeforeCents+amounts.gross)||
    r.sellerAfterCents!==r.sellerBeforeCents+amounts.gross-r.taxCents||
    !pos(r.committedAt))return false;
 return true;
}
function validate(proof,sourceItemID){
 if(!proof||!Object.isFrozen(proof)||proof.bid!==true||
    typeof proof.orderID!=="string"||!/^[1-9][0-9]*$/.test(proof.orderID)||
    !pos(proof.ownerID)||!pos(proof.counterpartyID)||
    proof.ownerID===proof.counterpartyID||
    !pos(proof.stationID)||!pos(proof.typeID)||!pos(proof.priceCents)||
    !pos(proof.volumeBefore)||!pos(proof.filledQuantity)||
    proof.filledQuantity>proof.volumeBefore||
    proof.volumeAfter!==proof.volumeBefore-proof.filledQuantity||
    !pos(sourceItemID)||proof.sellerSourceLocationID!==proof.stationID)
  throw Error("P2P_BUY_PAY_ORIGINAL_ORDER_AND_SELLER_SOURCE_INVALID");
 const gross=proof.priceCents*proof.filledQuantity,
  reserveBefore=proof.priceCents*proof.volumeBefore,
  reserveAfter=proof.priceCents*proof.volumeAfter;
 if(!pos(gross)||!pos(reserveBefore)||!safe(reserveAfter))
  throw Error("P2P_BUY_PAY_PRICE_OR_VOLUME_OVERFLOW");
 return {gross,reserveBefore,reserveAfter};
}
function assertBound(tx,proof,amounts){
 const escrow=tx.get("marketEscrow",proof.orderID);
 if(!escrow||escrow.orderId!==proof.orderID||
    escrow.ownerId!==proof.ownerID||escrow.isCorp!==false||
    escrow.escrowType!=="buy"||escrow.stationId!==proof.stationID||
    escrow.typeId!==proof.typeID||cents(escrow.price)!==proof.priceCents||
    escrow.remainingQuantity!==proof.volumeBefore||
    cents(escrow.escrowAmount)!==amounts.reserveBefore||
    typeof escrow.coopReserveReceiptKey!=="string"||
    typeof escrow.coopReserveOperationID!=="string")
  throw Error("P2P_BUY_PAY_FUNDED_ESCROW_UNVERIFIED");
 const reserve=tx.get("playerMarketFills",escrow.coopReserveReceiptKey);
 if(!validDebitReceipt(reserve)||
    reserve.phase!=="BOUND"||reserve.orderID!==proof.orderID||
    reserve.operationID!==escrow.coopReserveOperationID||
    reserve.key!==escrow.coopReserveReceiptKey||
    reserve.buyerID!==proof.ownerID||
    reserve.stationID!==proof.stationID||
    reserve.typeID!==proof.typeID||
    reserve.priceCents!==proof.priceCents||
    !pos(reserve.quantity)||reserve.quantity<proof.volumeBefore||
    reserve.reservedCents!==reserve.priceCents*reserve.quantity||
    !safe(reserve.spentCents??0)||
    !safe(reserve.filledQuantity??0)||
    (reserve.filledQuantity??0)!==reserve.quantity-proof.volumeBefore||
    (reserve.spentCents??0)!==reserve.priceCents*(reserve.filledQuantity??0)||
    (reserve.remainingReserveCents??reserve.reservedCents)!==amounts.reserveBefore||
    reserve.reservedCents!==(reserve.spentCents??0)+amounts.reserveBefore||
    !safe(reserve.brokerCents)||!safe(reserve.sccCents)||
    reserve.totalCents!==reserve.reservedCents+reserve.brokerCents+reserve.sccCents||
    !safe(reserve.buyerBeforeCents)||!safe(reserve.buyerAfterCents)||
    reserve.buyerBeforeCents-reserve.buyerAfterCents!==reserve.totalCents)
  throw Error("P2P_BUY_PAY_ORIGINAL_NATIVE_RESERVE_RECEIPT_MISSING");
 return {escrow,reserve};
}
function preflightOriginal({order,bookRow,escrow,sellerCharacterID,
 fillableQuantity,price,sourceItem,sourceStationID}={}){
 if(!sourceItem||sourceItem.singleton!==0||
    sourceItem.quantity!==fillableQuantity||
    sourceItem.stacksize!==fillableQuantity)
  throw Error("P2P_BUY_PAY_FULL_DIRECT_SELLER_STACK_REQUIRED");
 const ext=__filename.endsWith(".cjs")?".cjs":"";
 const {checkBuyMatch}=require("./coopPlayerMarketFill"+ext);
 const proof=checkBuyMatch({order,bookRow,escrow,sellerCharacterID,
  fillableQuantity,price,sourceItem,sourceStationID,hangarFlag:4});
 active().preflight({proof,sourceItemID:sourceItem.itemID});
 return proof;
}
function createBuySettlement({gameStore,clock=()=>Date.now()}={}){
 if(typeof gameStore?.transact!=="function"||typeof clock!=="function")
  throw Error("P2P_BUY_PAY_NATIVE_GAMESTORE_REQUIRED");
 function enabled(){
  return ["EVEJS_COOP_PLAYER_MARKET_BUY_RESERVE",
    "EVEJS_COOP_PLAYER_MARKET_ATOMIC",
    "EVEJS_COOP_NATIVE_ATOMIC_ROWS",
    "EVEJS_COOP_RUST_P2P_CLAIM",
    "EVEJS_COOP_PLAYER_MARKET_FILL_GUARD",
    "EVEJS_COOP_PLAYER_MARKET_SETTLEMENT_FENCE"
  ].every(x=>process.env[x]==="1");
 }
 function preflight({proof,sourceItemID}={}){
  if(!enabled())throw Error("P2P_BUY_PAY_FLAGS_DISABLED");
  const amounts=validate(proof,sourceItemID);
  return gameStore.transact(["marketEscrow","playerMarketFills","items"],tx=>{
   assertBound(tx,proof,amounts);
   const item=tx.get("items",String(sourceItemID));
   if(!item||item.itemID!==sourceItemID||
      item.ownerID!==proof.counterpartyID||
      item.locationID!==proof.stationID||item.flagID!==4||
      item.typeID!==proof.typeID||item.singleton!==0||
      item.quantity!==proof.filledQuantity||
      item.stacksize!==proof.filledQuantity)
    throw Error("P2P_BUY_PAY_EXACT_ORIGINAL_SELLER_STACK_REQUIRED");
   return true;
  });
 }
 function settle({ticket,proof,sourceItemID,tax}={}){
  if(!enabled())throw Error("P2P_BUY_PAY_FLAGS_DISABLED");
  if(!ticket||ticket.orderID!==proof?.orderID||!pos(ticket.cycle))
   throw Error("P2P_BUY_PAY_RUST_TICKET_INVALID");
  const amounts=validate(proof,sourceItemID);
  const taxCents=cents(tax);
  if(taxCents===null||taxCents>amounts.gross)
   throw Error("P2P_BUY_PAY_SALES_TAX_INVALID");
  const receiptKey=key(ticket);
  return gameStore.transact(TABLES,tx=>{
   const previous=tx.get("playerMarketFills",receiptKey);
   if(previous){
    if(!validPaidReceipt(previous,proof,ticket,amounts)||
       previous.sourceItemID!==sourceItemID||
       previous.taxCents!==taxCents)
     throw Error("P2P_BUY_PAY_REPLAY_IDENTITY_CONFLICT");
    return {...previous,replayed:true};
   }
   const {escrow,reserve}=assertBound(tx,proof,amounts);
   const item=tx.get("items",String(sourceItemID));
   if(!item||item.itemID!==sourceItemID||
      item.ownerID!==proof.counterpartyID||
      item.locationID!==proof.stationID||
      item.flagID!==4||item.typeID!==proof.typeID||
      item.singleton!==0||item.quantity!==proof.filledQuantity||
      item.stacksize!==proof.filledQuantity)
    throw Error("P2P_BUY_PAY_EXACT_ORIGINAL_SELLER_STACK_REQUIRED");
   const seller=tx.get("characters",String(proof.counterpartyID));
   const buyer=tx.get("characters",String(proof.ownerID));
   // Original GameStore characters are keyed by character ID; an
   // embedded ID is optional, but must never contradict the native key.
   const sellerEmbedded=seller?.characterID??seller?.charID;
   const buyerEmbedded=buyer?.characterID??buyer?.charID;
   if(!seller||!buyer||
      (sellerEmbedded!==undefined&&sellerEmbedded!==null&&
       Number(sellerEmbedded)!==proof.counterpartyID)||
      (buyerEmbedded!==undefined&&buyerEmbedded!==null&&
       Number(buyerEmbedded)!==proof.ownerID)||
      !Array.isArray(seller.walletJournal)||
      !Array.isArray(seller.marketTransactions)||
      !Array.isArray(buyer.marketTransactions)||
      !Array.isArray(buyer.walletJournal))
    throw Error("P2P_BUY_PAY_NATIVE_CHARACTER_ACCOUNTS_MISSING");
   const sellerBefore=cents(seller.balance),buyerBefore=cents(buyer.balance);
   if(sellerBefore===null||buyerBefore===null||
      !safe(sellerBefore+amounts.gross)||
      !safe(sellerBefore+amounts.gross-taxCents))
    throw Error("P2P_BUY_PAY_NATIVE_WALLET_PRECISION_INVALID");
   const sellerAfter=sellerBefore+amounts.gross-taxCents;
   const seq=tx.get("identityState","coopP2PMarketJournal");
   const next=seq?.next??5000000000000000;
   if(!pos(next)||next<5000000000000000||!pos(next+3)||
      next+3>Number.MAX_SAFE_INTEGER)
    throw Error("P2P_BUY_PAY_JOURNAL_ID_EXHAUSTED");
   const at=clock();
   if(!pos(at))throw Error("P2P_BUY_PAY_CLOCK_UNAVAILABLE");
   const when=String(BigInt(at)*10000n+116444736000000000n);
   const journal={
    transactionDate:when,referenceID:proof.orderID,
    currency:1,accountKey:1000,sortValue:1,
    ownerID1:proof.ownerID,ownerID2:proof.counterpartyID
   };
   const credit={...journal,transactionID:next,entryTypeID:2,
    amount:money(amounts.gross),balance:money(sellerBefore+amounts.gross),
    description:"Original funded BUY seller proceeds "+receiptKey};
   const taxEntry={...journal,transactionID:next+1,entryTypeID:54,
    amount:money(-taxCents),balance:money(sellerAfter),
    ownerID1:proof.stationID,ownerID2:proof.counterpartyID,
    description:"Original funded BUY seller sales tax "+receiptKey};
   const existing=[...seller.walletJournal,...buyer.walletJournal,
    ...seller.marketTransactions,...buyer.marketTransactions];
   if(existing.some(e=>e?.transactionID===next||e?.transactionID===next+1||e?.transactionID===next+2))
    throw Error("P2P_BUY_PAY_NATIVE_TRANSACTION_ID_COLLISION");
   const trade={transactionDate:when,typeID:proof.typeID,
    quantity:proof.filledQuantity,price:money(proof.priceCents),
    stationID:proof.stationID,locationID:proof.stationID,
    buyerID:proof.ownerID,sellerID:proof.counterpartyID,
    accountID:1000,buyerAccountID:1000,sellerAccountID:1000};
   const result={
    kind:"P2P_BUY_PAID",phase:"GAMESTORE_COMMITTED",key:receiptKey,
    orderID:ticket.orderID,cycle:ticket.cycle,buyerID:proof.ownerID,
    sellerID:proof.counterpartyID,stationID:proof.stationID,
    typeID:proof.typeID,sourceItemID,itemID:sourceItemID,
    quantity:proof.filledQuantity,
    volumeBefore:proof.volumeBefore,volumeAfter:proof.volumeAfter,
    priceCents:proof.priceCents,grossCents:amounts.gross,taxCents,
    buyerBeforeCents:buyerBefore,buyerAfterCents:buyerBefore,
    sellerBeforeCents:sellerBefore,sellerAfterCents:sellerAfter,
    reserveOperationID:reserve.operationID,
    reserveReceiptKey:reserve.key,
    reserveBeforeCents:amounts.reserveBefore,
    reserveAfterCents:amounts.reserveAfter,
    committedAt:at
   };
   tx.put("items",String(sourceItemID),{
    ...item,ownerID:proof.ownerID,locationID:proof.stationID,flagID:4
   });
   tx.put("characters",String(proof.counterpartyID),{
    ...seller,balance:money(sellerAfter),
    balanceChange:money(amounts.gross-taxCents),
    walletJournal:[...(taxCents>0?[taxEntry]:[]),credit,
      ...seller.walletJournal].slice(0,100),
    marketTransactions:[{...trade,transactionID:next,
      clientID:proof.ownerID,journalRefID:next},
      ...seller.marketTransactions].slice(0,2000)
   });
   tx.put("characters",String(proof.ownerID),{
    ...buyer,
    marketTransactions:[{...trade,transactionID:next+2,
      clientID:proof.counterpartyID,journalRefID:-1},
      ...buyer.marketTransactions].slice(0,2000)
   });
   if(proof.volumeAfter===0){
    tx.del("marketEscrow",proof.orderID);
   }else{
    tx.put("marketEscrow",proof.orderID,{
     ...escrow,remainingQuantity:proof.volumeAfter,
     escrowAmount:money(amounts.reserveAfter)
    });
   }
   tx.put("playerMarketFills",reserve.key,{
    ...reserve,phase:proof.volumeAfter===0?"SPENT":"BOUND",
    spentCents:(reserve.spentCents??0)+amounts.gross,
    filledQuantity:(reserve.filledQuantity??0)+proof.filledQuantity,
    remainingReserveCents:amounts.reserveAfter
   });
   tx.put("playerMarketFills",receiptKey,result);
   tx.put("identityState","coopP2PMarketJournal",{next:next+3});
   return result;
  });
 }
 function requireReceipt(ticket,proof){
  if(!enabled())throw Error("P2P_BUY_PAY_FLAGS_DISABLED");
  const amounts=validate(proof,1);
  const receiptKey=key(ticket);
  return gameStore.transact(["playerMarketFills"],tx=>{
   const r=tx.get("playerMarketFills",receiptKey);
   if(!validPaidReceipt(r,proof,ticket,amounts))
    throw Error("P2P_BUY_PAY_DURABLE_COMMITTED_RECEIPT_REQUIRED");
   return r;
  });
 }
 return Object.freeze({preflight,settle,requireReceipt});
}
let current=null;
function active(){
 if(!current)current=createBuySettlement({
  gameStore:require("../gameStore").coopAtomicNativeRows
 });
 return current;
}
module.exports={createBuySettlement,preflightOriginal,
 preflight:args=>active().preflight(args),
 settle:args=>active().settle(args),
 requireReceipt:(ticket,proof)=>active().requireReceipt(ticket,proof)};
