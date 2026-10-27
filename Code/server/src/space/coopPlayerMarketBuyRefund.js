"use strict";
// Original EVEJS GameStore BUY escrow refund. No Rust order changes here.
// A terminal Rust order readback is required for an irreversible wallet credit.
// Unknown outcomes remain blocked; replay never issues a second credit.
// Reuse the same original paid BUY reserve debit authority used for both
// Rust order binding and seller settlement. Refund cannot accept a weaker
// receipt than the payout that previously consumed its escrow.
const {validDebitReceipt}=require("./coopPlayerMarketBuyReserve"+
 (__filename.endsWith(".cjs")?".cjs":""));
const TABLES=Object.freeze(["characters","marketEscrow","playerMarketFills","identityState"]);
const pos=x=>typeof x==="number"&&Number.isSafeInteger(x)&&x>0;
const nonneg=x=>typeof x==="number"&&Number.isSafeInteger(x)&&x>=0;
const id=x=>typeof x==="string"&&/^[1-9][0-9]*$/.test(x);
const cents=x=>{
 if(typeof x!=="number"||!Number.isFinite(x)||x<0)return null;
 const n=Math.round(x*100);
 return nonneg(n)&&Math.abs(x*100-n)<=1e-6?n:null;
};
const isk=x=>x/100;
const refundKey=id=>"buy-refund:"+id;
const flags=["EVEJS_COOP_PLAYER_MARKET_BUY_REFUND",
 "EVEJS_COOP_PLAYER_MARKET_BUY_RESERVE","EVEJS_COOP_PLAYER_MARKET_ATOMIC",
 "EVEJS_COOP_NATIVE_ATOMIC_ROWS","EVEJS_COOP_RUST_P2P_CLAIM",
 "EVEJS_COOP_PLAYER_MARKET_FILL_GUARD",
 "EVEJS_COOP_PLAYER_MARKET_SETTLEMENT_FENCE"];
function proof(order,reason){
 const row=order?.row||order;
 const orderID=String(order?.order_id??"");
 if(!id(orderID)||String(row?.order_id)!==orderID||
    !["cancelled","expired"].includes(reason)||
    order?.state!==reason||
    order?.source!=="player"||order?.is_corp!==false||
    row?.bid!==true||!pos(order.owner_id)||
    !pos(row.station_id)||!pos(row.type_id)||
    !pos(row.vol_remaining)||!pos(row.vol_entered??row.vol_remaining)||
    row.vol_remaining>(row.vol_entered??row.vol_remaining)||
    cents(row.price)===null||!pos(cents(row.price)))
  throw Error("P2P_BUY_REFUND_RUST_TERMINAL_ORDER_UNVERIFIED");
 const remainingCents=cents(row.price)*row.vol_remaining;
 if(!pos(remainingCents))
  throw Error("P2P_BUY_REFUND_AMOUNT_OVERFLOW");
 return {orderID,reason,buyerID:order.owner_id,
  stationID:row.station_id,typeID:row.type_id,
  volumeRemaining:row.vol_remaining,priceCents:cents(row.price),
  remainingCents};
}
function assertBound(tx,p){
 const escrow=tx.get("marketEscrow",p.orderID);
 if(!escrow||escrow.orderId!==p.orderID||
    escrow.escrowType!=="buy"||escrow.isCorp!==false||
    escrow.ownerId!==p.buyerID||
    escrow.stationId!==p.stationID||escrow.typeId!==p.typeID||
    cents(escrow.price)!==p.priceCents||
    escrow.remainingQuantity!==p.volumeRemaining||
    cents(escrow.escrowAmount)!==p.remainingCents||
    typeof escrow.coopReserveReceiptKey!=="string"||
    typeof escrow.coopReserveOperationID!=="string")
  throw Error("P2P_BUY_REFUND_NATIVE_ESCROW_NOT_FUNDED");
 const original=tx.get("playerMarketFills",escrow.coopReserveReceiptKey);
 if(!validDebitReceipt(original)||
    original.phase!=="BOUND"||
    original.key!==escrow.coopReserveReceiptKey||
    original.orderID!==p.orderID||
    original.operationID!==escrow.coopReserveOperationID||
    original.buyerID!==p.buyerID||
    original.stationID!==p.stationID||
    original.typeID!==p.typeID||
    original.priceCents!==p.priceCents||
    !pos(original.quantity)||original.quantity<p.volumeRemaining||
    original.reservedCents!==original.priceCents*original.quantity||
    !nonneg(original.spentCents??0)||
    !nonneg(original.filledQuantity??0)||
    (original.filledQuantity??0)!==original.quantity-p.volumeRemaining||
    (original.spentCents??0)!==
      original.priceCents*(original.filledQuantity??0)||
    original.reservedCents!==(original.spentCents??0)+p.remainingCents||
    (original.remainingReserveCents??original.reservedCents)!==
      p.remainingCents||
    !nonneg(original.brokerCents)||!nonneg(original.sccCents)||
    original.totalCents!==original.reservedCents+
      original.brokerCents+original.sccCents||
    !nonneg(original.buyerAfterCents)||
    !nonneg(original.buyerBeforeCents)||
    original.buyerBeforeCents-original.buyerAfterCents!==original.totalCents)
  throw Error("P2P_BUY_REFUND_DURABLE_ORIGINAL_RESERVE_NOT_VERIFIED");
 return original;
}
function createBuyRefund({gameStore,clock=()=>Date.now()}={}){
 if(typeof gameStore?.transact!=="function"||typeof clock!=="function")
  throw Error("P2P_BUY_REFUND_GAMESTORE_REQUIRED");
 function enabled(){return flags.every(x=>process.env[x]==="1")}
 function preflight(order){
  if(!enabled())throw Error("P2P_BUY_REFUND_FLAGS_DISABLED");
  if(order?.state!=="open")
   throw Error("P2P_BUY_REFUND_OPEN_ORDER_REQUIRED");
  const p=proof({...order,state:"cancelled"},"cancelled");
  return gameStore.transact(["marketEscrow","playerMarketFills"],tx=>
   Boolean(assertBound(tx,p)));
 }
 function refund(order,reason){
  if(!enabled())throw Error("P2P_BUY_REFUND_FLAGS_DISABLED");
  const p=proof(order,reason),key=refundKey(p.orderID);
  return gameStore.transact(TABLES,tx=>{
   const past=tx.get("playerMarketFills",key);
   if(past){
    if(past.kind!=="P2P_BUY_REFUND"||past.key!==key||
       past.reason!==reason||past.orderID!==p.orderID||
       past.buyerID!==p.buyerID||
       past.stationID!==p.stationID||past.typeID!==p.typeID||
       past.priceCents!==p.priceCents||
       past.volumeRemaining!==p.volumeRemaining||
       past.refundCents!==p.remainingCents||
       past.phase!=="GAMESTORE_COMMITTED"||
       !nonneg(past.walletBeforeCents)||
       !nonneg(past.walletAfterCents)||
       !nonneg(past.walletBeforeCents+past.refundCents)||
       past.walletAfterCents!==past.walletBeforeCents+past.refundCents||
       !pos(past.originalReservedCents)||!nonneg(past.spentCents)||
       past.originalReservedCents!==past.spentCents+past.refundCents||
       !pos(past.journalID)||past.journalID<5000000000000000||
       !pos(past.committedAt))
     throw Error("P2P_BUY_REFUND_REPLAY_IDENTITY_CONFLICT");
    const reserved=tx.get("playerMarketFills",past.reserveReceiptKey);
    // A refunded reserve must preserve its ORIGINAL paid debit proof;
    // compare the immutable witness without requiring a current wallet
    // balance, which may have changed after a legitimate refund.
    if(!reserved||reserved.phase!=="REFUNDED"||
       !validDebitReceipt({...reserved,phase:"BOUND"})||
       reserved.orderID!==p.orderID||
       reserved.key!==past.reserveReceiptKey||
       reserved.operationID!==past.reserveOperationID||
       reserved.buyerID!==p.buyerID||
       reserved.stationID!==p.stationID||
       reserved.typeID!==p.typeID||
       reserved.priceCents!==p.priceCents||
       reserved.quantity-reserved.filledQuantity!==p.volumeRemaining||
       reserved.spentCents!==reserved.priceCents*reserved.filledQuantity||
       reserved.closedReason!==reason||
       reserved.closedAt!==past.committedAt||
       reserved.refundedCents!==past.refundCents||
       reserved.remainingReserveCents!==0||
       reserved.spentCents!==past.spentCents||
       reserved.reservedCents!==past.originalReservedCents||
       reserved.reservedCents!==reserved.spentCents+reserved.refundedCents||
       past.journalID<=reserved.journalIDs[2])
     throw Error("P2P_BUY_REFUND_COMMITTED_RESERVE_EVIDENCE_MISSING");
    if(tx.get("marketEscrow",p.orderID)!==null)
     throw Error("P2P_BUY_REFUND_REPLAY_ESCROW_STILL_EXISTS");
    return {...past,replayed:true};
   }
   const reserve=assertBound(tx,p);
   const buyer=tx.get("characters",String(p.buyerID));
   const embedded=buyer?.characterID??buyer?.charID;
   if(!buyer||(embedded!==undefined&&embedded!==null&&
        Number(embedded)!==p.buyerID)||
      !Array.isArray(buyer.walletJournal)||
      !Array.isArray(buyer.marketTransactions))
    throw Error("P2P_BUY_REFUND_NATIVE_WALLET_UNVERIFIED");
   const before=cents(buyer.balance),after=before+p.remainingCents;
   if(before===null||!nonneg(after))
    throw Error("P2P_BUY_REFUND_WALLET_PRECISION_OVERFLOW");
   const sequence=tx.get("identityState","coopP2PMarketJournal");
   const next=sequence?.next??5000000000000000;
   if(!pos(next)||next<5000000000000000||
      !pos(next+1)||next+1>Number.MAX_SAFE_INTEGER||
      buyer.walletJournal.some(x=>x?.transactionID===next))
    throw Error("P2P_BUY_REFUND_WALLET_JOURNAL_ID_INVALID");
   const at=clock();
   if(!pos(at))throw Error("P2P_BUY_REFUND_CLOCK_INVALID");
   const when=String(BigInt(at)*10000n+116444736000000000n);
   const entry={
    transactionID:next,transactionDate:when,
    entryTypeID:42,amount:isk(p.remainingCents),balance:isk(after),
    referenceID:p.stationID,ownerID1:p.stationID,ownerID2:p.buyerID,
    currency:1,accountKey:1000,sortValue:1,
    description:"Original P2P BUY escrow "+reason+" refund "+key
   };
   const receipt={kind:"P2P_BUY_REFUND",phase:"GAMESTORE_COMMITTED",
    key,orderID:p.orderID,reason,buyerID:p.buyerID,
    stationID:p.stationID,typeID:p.typeID,
    priceCents:p.priceCents,volumeRemaining:p.volumeRemaining,
    refundCents:p.remainingCents,
    walletBeforeCents:before,walletAfterCents:after,
    reserveReceiptKey:reserve.key,reserveOperationID:reserve.operationID,
    originalReservedCents:reserve.reservedCents,
    spentCents:reserve.spentCents??0,
    journalID:next,committedAt:at};
   tx.put("characters",String(p.buyerID),{
    ...buyer,balance:isk(after),balanceChange:isk(p.remainingCents),
    walletJournal:[entry,...buyer.walletJournal].slice(0,100)
   });
   tx.put("playerMarketFills",reserve.key,{
    ...reserve,phase:"REFUNDED",
    refundedCents:p.remainingCents,
    remainingReserveCents:0,
    closedReason:reason,
    closedAt:at
   });
   tx.put("playerMarketFills",key,receipt);
   tx.del("marketEscrow",p.orderID);
   tx.put("identityState","coopP2PMarketJournal",{next:next+1});
   return receipt;
  });
 }
 return Object.freeze({preflight,refund});
}
let single=null;
function active(){
 if(!single)single=createBuyRefund({gameStore:
  require("../gameStore").coopAtomicNativeRows});
 return single;
}
module.exports={createBuyRefund,refund:(order,reason)=>active().refund(order,reason),
 preflight:order=>active().preflight(order)};
