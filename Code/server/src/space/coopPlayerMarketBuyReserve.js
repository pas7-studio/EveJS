"use strict";
// P0: native BUY reserve custody proof. This is a GameStore escrow, not
// a parallel wallet or a Rust transaction. The pending reserve is never
// automatically refunded after an uncertain PlaceOrder outcome.
const {randomUUID}=require("node:crypto");
const TABLES=Object.freeze(["characters","identityState","playerMarketFills","marketEscrow"]);
const positive=n=>typeof n==="number"&&Number.isSafeInteger(n)&&n>0;
const natural=n=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
const orderID=id=>typeof id==="string"&&/^[1-9][0-9]*$/.test(id);
const toCents=n=>{
 if(typeof n!=="number"||!Number.isFinite(n)||n<0)return null;
 const value=n*100,c=Math.round(value);
 return natural(c)&&Math.abs(value-c)<0.000001?c:null;
};
const isk=n=>n/100;
const keyFor=operationID=>"buy-reserve:"+operationID;
// Original reserve is an immutable native wallet debit witness, not an
// escrow authorization merely because its operation ID and amount match.
// Verify its persisted exact-cent arithmetic before binding/reusing a BUY.
function validDebitReceipt(r){
 if(!r||r.kind!=="P2P_BUY_RESERVE"||
    !["RESERVED","BOUND"].includes(r.phase)||
    typeof r.operationID!=="string"||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.operationID)||
    r.key!==keyFor(r.operationID)||
    !positive(r.buyerID)||!positive(r.stationID)||!positive(r.typeID)||
    !positive(r.quantity)||!positive(r.minVolume)||
    r.minVolume>r.quantity||!positive(r.durationDays)||
    !natural(r.orderRange)||!positive(r.priceCents)||
    !natural(r.brokerCents)||!natural(r.sccCents)||
    !positive(r.reservedCents)||!positive(r.totalCents)||
    r.reservedCents!==r.priceCents*r.quantity||
    !natural(r.reservedCents+r.brokerCents+r.sccCents)||
    r.totalCents!==r.reservedCents+r.brokerCents+r.sccCents||
    !natural(r.buyerBeforeCents)||!natural(r.buyerAfterCents)||
    r.buyerBeforeCents<r.totalCents||
    r.buyerAfterCents!==r.buyerBeforeCents-r.totalCents||
    !Array.isArray(r.journalIDs)||r.journalIDs.length!==3||
    !positive(r.journalIDs[0])||r.journalIDs[0]<5000000000000000||
    r.journalIDs.some((v,i)=>!positive(v)||
      (i>0&&v!==r.journalIDs[0]+i))||
    !positive(r.createdAt)||
    (r.phase==="RESERVED"&&r.orderID!==null)||
    (r.phase==="BOUND"&&!orderID(r.orderID)))return false;
 return true;
}
function requireQuote(quote){
 if(!quote||!positive(quote.buyerID)||!positive(quote.stationID)||
    !positive(quote.typeID)||!positive(quote.quantity)||
    !positive(quote.minVolume)||quote.minVolume>quote.quantity||
    !positive(quote.durationDays)||!Number.isSafeInteger(quote.orderRange)||
    quote.orderRange<0)
  throw Error("P2P_BUY_RESERVE_ORIGINAL_QUOTE_INVALID");
 const priceCents=toCents(quote.price),
  brokerCents=toCents(quote.brokerFee),
  sccCents=toCents(quote.sccSurcharge);
 if(!positive(priceCents)||brokerCents===null||sccCents===null)
  throw Error("P2P_BUY_RESERVE_PRICE_OR_FEE_INVALID");
 const reservedCents=priceCents*quote.quantity;
 const totalCents=reservedCents+brokerCents+sccCents;
 if(!positive(reservedCents)||!positive(totalCents)||
    !Number.isSafeInteger(totalCents))
  throw Error("P2P_BUY_RESERVE_ISK_OVERFLOW");
 return Object.freeze({...quote,priceCents,brokerCents,sccCents,
   reservedCents,totalCents});
}
function createBuyReserve({gameStore,makeID=randomUUID,clock=()=>Date.now()}={}){
 if(typeof gameStore?.transact!=="function"||
    typeof makeID!=="function"||typeof clock!=="function")
  throw Error("P2P_BUY_RESERVE_NATIVE_GAMESTORE_REQUIRED");
 function enabled(){
  return [
   "EVEJS_COOP_PLAYER_MARKET_BUY_RESERVE",
   "EVEJS_COOP_PLAYER_MARKET_ATOMIC",
   "EVEJS_COOP_NATIVE_ATOMIC_ROWS",
   "EVEJS_COOP_RUST_P2P_CLAIM",
   "EVEJS_COOP_PLAYER_MARKET_FILL_GUARD",
   "EVEJS_COOP_PLAYER_MARKET_SETTLEMENT_FENCE"
  ].every(k=>process.env[k]==="1");
 }
 function begin(quote){
  if(!enabled())throw Error("P2P_BUY_RESERVE_FLAGS_DISABLED");
  const q=requireQuote(quote);
  const operationID=makeID();
  if(typeof operationID!=="string"||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationID))
   throw Error("P2P_BUY_RESERVE_OPERATION_ID_REQUIRED");
  const key=keyFor(operationID);
  return gameStore.transact(TABLES,tx=>{
   if(tx.get("playerMarketFills",key))
    throw Error("P2P_BUY_RESERVE_OPERATION_ALREADY_EXISTS");
   for(const entry of tx.scan("playerMarketFills")){
    if(entry.value?.kind==="P2P_BUY_RESERVE"&&
       entry.value?.phase==="RESERVED"&&entry.value?.buyerID===q.buyerID)
     throw Error("P2P_BUY_RESERVE_UNRESOLVED_OPERATION_FOR_BUYER");
   }
   const wallet=tx.get("characters",String(q.buyerID));
   // Pinned EveJS addresses original character wallet rows by the
   // GameStore key. An embedded characterID is optional, but any explicit
   // ID must match the authenticated original buyer before debiting ISK.
   const embeddedID=wallet?.characterID??wallet?.charID;
   if(!wallet||
      (embeddedID!==undefined&&embeddedID!==null&&
       Number(embeddedID)!==q.buyerID)||
      !Array.isArray(wallet.walletJournal)||
      !Array.isArray(wallet.marketTransactions))
    throw Error("P2P_BUY_RESERVE_WALLET_AUTHORITY_UNAVAILABLE");
   const before=toCents(wallet.balance);
   if(before===null||before<q.totalCents)
    throw Error("P2P_BUY_RESERVE_FUNDS_INSUFFICIENT");
   const after=before-q.totalCents;
   const sequence=tx.get("identityState","coopP2PMarketJournal");
   const next=sequence?.next??5000000000000000;
   if(!positive(next)||next<5000000000000000||
      !positive(next+3)||next+3>Number.MAX_SAFE_INTEGER)
    throw Error("P2P_BUY_RESERVE_WALLET_JOURNAL_OVERFLOW");
   const at=clock();
   if(!positive(at))throw Error("P2P_BUY_RESERVE_CLOCK_INVALID");
   const time=String(BigInt(at)*10000n+116444736000000000n);
   const amounts=[
    {id:next,amount:q.reservedCents,entryTypeID:42,description:"P2P original BUY reserve"},
    {id:next+1,amount:q.brokerCents,entryTypeID:46,description:"P2P original BUY broker fee"},
    {id:next+2,amount:q.sccCents,entryTypeID:149,description:"P2P original BUY SCC surcharge"}
   ];
   const used=new Set(wallet.walletJournal.map(e=>e?.transactionID));
   if(amounts.some(e=>used.has(e.id)))
    throw Error("P2P_BUY_RESERVE_JOURNAL_ID_COLLISION");
   let running=before;
   const entries=[];
   for(const a of amounts){
    if(a.amount===0)continue;
    running-=a.amount;
    entries.unshift({
      transactionID:a.id,transactionDate:time,entryTypeID:a.entryTypeID,
      amount:isk(-a.amount),balance:isk(running),
      referenceID:q.stationID,ownerID1:q.buyerID,ownerID2:q.stationID,
      currency:1,accountKey:1000,sortValue:1,
      description:a.description+" "+operationID
    });
   }
   if(running!==after)throw Error("P2P_BUY_RESERVE_BALANCE_CONSERVATION");
   const receipt={
    kind:"P2P_BUY_RESERVE",phase:"RESERVED",
    key,operationID,buyerID:q.buyerID,stationID:q.stationID,
    typeID:q.typeID,quantity:q.quantity,minVolume:q.minVolume,
    durationDays:q.durationDays,orderRange:q.orderRange,
    priceCents:q.priceCents,brokerCents:q.brokerCents,
    sccCents:q.sccCents,reservedCents:q.reservedCents,
    totalCents:q.totalCents,buyerBeforeCents:before,
    buyerAfterCents:after,journalIDs:amounts.map(a=>a.id),
    createdAt:at,orderID:null
   };
   tx.put("characters",String(q.buyerID),{
    ...wallet,balance:isk(after),balanceChange:isk(-q.totalCents),
    walletJournal:[...entries,...wallet.walletJournal].slice(0,100)
   });
   tx.put("identityState","coopP2PMarketJournal",{next:next+3});
   tx.put("playerMarketFills",key,receipt);
   return receipt;
  });
 }
 function bind(receipt,order){
  if(!enabled())throw Error("P2P_BUY_RESERVE_FLAGS_DISABLED");
  if(!receipt||receipt.kind!=="P2P_BUY_RESERVE"||
     typeof receipt.operationID!=="string"||
     !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.operationID))
   throw Error("P2P_BUY_RESERVE_RECEIPT_INVALID");
  const id=String(order?.order_id??"");
  const row=order?.row;
  if(!orderID(id)||!row||String(row.order_id)!==id||
     order.owner_id!==receipt.buyerID||order.is_corp!==false||
     order.source!=="player"||order.state!=="open"||
     row.bid!==true||row.station_id!==receipt.stationID||
     row.type_id!==receipt.typeID||
     row.vol_remaining!==receipt.quantity||
     row.min_volume!==receipt.minVolume||
     row.duration_days!==receipt.durationDays||
     row.range_value!==receipt.orderRange||
     toCents(row.price)!==receipt.priceCents)
   throw Error("P2P_BUY_RESERVE_RUST_ORDER_NOT_VERIFIED");
  return gameStore.transact(["playerMarketFills","marketEscrow"],tx=>{
   const original=tx.get("playerMarketFills",receipt.key);
   if(!validDebitReceipt(receipt)||!validDebitReceipt(original)||
      original.kind!=="P2P_BUY_RESERVE"||
      original.buyerBeforeCents!==receipt.buyerBeforeCents||
      original.buyerAfterCents!==receipt.buyerAfterCents||
      original.createdAt!==receipt.createdAt||
      JSON.stringify(original.journalIDs)!==JSON.stringify(receipt.journalIDs)||
      original.operationID!==receipt.operationID||
      original.buyerID!==receipt.buyerID||
      original.stationID!==receipt.stationID||
      original.typeID!==receipt.typeID||
      original.quantity!==receipt.quantity||
      original.priceCents!==receipt.priceCents||
      original.minVolume!==receipt.minVolume||
      original.durationDays!==receipt.durationDays||
      original.orderRange!==receipt.orderRange||
      original.brokerCents!==receipt.brokerCents||
      original.sccCents!==receipt.sccCents||
      original.reservedCents!==receipt.reservedCents||
      original.totalCents!==receipt.totalCents)
    throw Error("P2P_BUY_RESERVE_COMMITTED_DEBIT_NOT_FOUND");
   if(original.phase==="BOUND"){
    if(original.orderID!==id)throw Error("P2P_BUY_RESERVE_BOUND_TO_OTHER_ORDER");
    const escrow=tx.get("marketEscrow",id);
    if(!escrow||escrow.orderId!==id||
       escrow.ownerId!==original.buyerID||escrow.isCorp!==false||
       escrow.escrowType!=="buy"||
       escrow.stationId!==original.stationID||
       escrow.typeId!==original.typeID||
       escrow.remainingQuantity!==original.quantity||
       toCents(escrow.price)!==original.priceCents||
       escrow.coopReserveOperationID!==original.operationID||
       escrow.coopReserveReceiptKey!==original.key||
       toCents(escrow.escrowAmount)!==original.reservedCents)
     throw Error("P2P_BUY_RESERVE_ESCROW_RECEIPT_MISMATCH");
    return {...original,replayed:true};
   }
   if(original.phase!=="RESERVED"||original.orderID!==null)
    throw Error("P2P_BUY_RESERVE_UNRECONCILED_STATE");
   for(const entry of tx.scan("playerMarketFills")){
    if(entry.key!==receipt.key&&
      entry.value?.kind==="P2P_BUY_RESERVE"&&entry.value?.orderID===id)
     throw Error("P2P_BUY_RESERVE_ORDER_ID_ALREADY_BOUND");
   }
   if(tx.get("marketEscrow",id)!==null)
    throw Error("P2P_BUY_RESERVE_EXISTING_ESCROW_CONFLICT");
   const escrow={
    orderId:id,ownerId:receipt.buyerID,isCorp:false,escrowType:"buy",
    typeId:receipt.typeID,stationId:receipt.stationID,
    price:isk(receipt.priceCents),remainingQuantity:receipt.quantity,
    escrowAmount:isk(receipt.reservedCents),
    coopReserveOperationID:receipt.operationID,
    coopReserveReceiptKey:receipt.key,
    createdAt:new Date(receipt.createdAt).toISOString(),
    updatedAt:new Date(receipt.createdAt).toISOString()
   };
   const updated={...original,phase:"BOUND",orderID:id};
   tx.put("marketEscrow",id,escrow);
   tx.put("playerMarketFills",receipt.key,updated);
   return updated;
  });
 }
 function assertExisting(ownerOrders,buyerID){
  if(!enabled())throw Error("P2P_BUY_RESERVE_FLAGS_DISABLED");
  if(!positive(buyerID)||!Array.isArray(ownerOrders))
   throw Error("P2P_BUY_RESERVE_EXISTING_ORDERS_UNAVAILABLE");
  const rows=ownerOrders.filter(order=>order?.state==="open"&&order?.row?.bid===true);
  if(rows.some(order=>order.owner_id!==buyerID||order.is_corp!==false||
      order.source!=="player"||!orderID(String(order.order_id))))
   throw Error("P2P_BUY_RESERVE_UNVERIFIED_EXISTING_RUST_ORDER");
  return gameStore.transact(["playerMarketFills","marketEscrow"],tx=>{
   for(const order of rows){
    const id=String(order.order_id),escrow=tx.get("marketEscrow",id);
    const receipt=escrow?.coopReserveReceiptKey?
     tx.get("playerMarketFills",escrow.coopReserveReceiptKey):null;
    if(!escrow||escrow.orderId!==id||escrow.ownerId!==buyerID||
       escrow.isCorp!==false||escrow.escrowType!=="buy"||
       escrow.stationId!==order.row.station_id||
       escrow.typeId!==order.row.type_id||
       !validDebitReceipt(receipt)||
       receipt.phase!=="BOUND"||receipt.orderID!==id||
       receipt.buyerID!==buyerID||
       receipt.operationID!==escrow.coopReserveOperationID||
       escrow.coopReserveReceiptKey!==receipt.key||
       toCents(escrow.price)!==receipt.priceCents||
       toCents(order.row.price)!==receipt.priceCents||
       // A funded Rust BUY cannot silently change the accepted original
       // minVolume/duration/range. Some pinned order readers omit
       // vol_entered; when supplied, it must match the funded quantity.
       order.row.min_volume!==receipt.minVolume||
       order.row.duration_days!==receipt.durationDays||
       order.row.range_value!==receipt.orderRange||
       (order.row.vol_entered!==undefined&&
        order.row.vol_entered!==receipt.quantity)||
       escrow.remainingQuantity!==order.row.vol_remaining||
       !positive(escrow.remainingQuantity)||
       escrow.remainingQuantity>receipt.quantity||
       toCents(escrow.escrowAmount)!==
        receipt.priceCents*escrow.remainingQuantity||
       // A partially filled Rust BUY is still funded only when its
       // original durable debit and paid quantity reconcile EXACTLY
       // with native escrow. Never trust an arbitrary BOUND receipt.
       !natural(receipt.filledQuantity??0)||
       (receipt.filledQuantity??0)!==
        receipt.quantity-escrow.remainingQuantity||
       !natural(receipt.spentCents??0)||
       (receipt.spentCents??0)!==
        receipt.priceCents*(receipt.quantity-escrow.remainingQuantity)||
       (receipt.remainingReserveCents??receipt.reservedCents)!==
        receipt.priceCents*escrow.remainingQuantity||
       receipt.reservedCents!==
        (receipt.spentCents??0)+
        (receipt.remainingReserveCents??receipt.reservedCents))
     throw Error("P2P_BUY_RESERVE_LEGACY_OR_UNFUNDED_BUY_ORDER");
   }
   return true;
  });
 }
 function inspect(operationID){
  if(typeof operationID!=="string"||!operationID)
   throw Error("P2P_BUY_RESERVE_OPERATION_ID_REQUIRED");
  return gameStore.transact(["playerMarketFills"],tx=>
    tx.get("playerMarketFills",keyFor(operationID)));
 }
 return Object.freeze({begin,bind,inspect,assertExisting});
}
let runtime=null;
function active(){
 if(!runtime)runtime=createBuyReserve({gameStore:
  require("../gameStore").coopAtomicNativeRows});
 return runtime;
}
module.exports={createBuyReserve,requireQuote,validDebitReceipt,
 begin:q=>active().begin(q),bind:(receipt,order)=>active().bind(receipt,order),
 inspect:id=>active().inspect(id),
 assertExisting:(orders,id)=>active().assertExisting(orders,id)};
