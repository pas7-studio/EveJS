"use strict";
// P0: native GameStore atomic multi-stack FULL and PARTIAL SELL settlement.
// No parallel inventory, wallet, or market; all effects via the pinned
// GameStore coopAtomicNativeRows.transact(...) with one durable SQLite COMMIT.
// Pre-funded BUY and linked cross-orders deliberately fail closed.
const TABLES=Object.freeze(["characters","items","marketEscrow","identityState","playerMarketFills"]);
const pos=n=>typeof n==="number"&&Number.isSafeInteger(n)&&n>0;
const safe=n=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
const cents=n=>{
 if(typeof n!=="number"||!Number.isFinite(n)||n<0)return null;
 const v=n*100,k=Math.round(v);
 return Number.isSafeInteger(k)&&Math.abs(k-v)<=1e-6?k:null;
};
const isk=n=>n/100;
const ITEM_FLOOR=1990000000;
const MAX_STACKS=10000;
function sourceIDs({sourceItemID,sourceItemIDs}){
 const ids=sourceItemIDs===undefined?[sourceItemID]:sourceItemIDs;
 if(!Array.isArray(ids)||ids.length===0||ids.length>MAX_STACKS||
    ids.some(id=>!pos(id))||new Set(ids).size!==ids.length)
  throw Error("P2P_ATOMIC_ORIGINAL_SOURCE_SET_INVALID");
 const sorted=[...ids].sort((a,b)=>a-b);
 if(sourceItemID!==undefined&&sourceItemID!==sorted[0])
  throw Error("P2P_ATOMIC_SOURCE_IDENTITY_MISMATCH");
 return sorted;
}
function receiptDeliveries(record){
 if(Array.isArray(record.deliveries))return record.deliveries;
 if(pos(record.itemID)&&pos(record.sourceItemID)&&
    pos(record.quantity))return [{sourceItemID:record.sourceItemID,
       itemID:record.itemID,quantity:record.quantity}];
 return null;
}
function checkDeliveries(record,expectedSources,expectedQuantity){
 // Only historical receipts with BOTH modern fields absent may use
 // single-stack fallback. A new multi-stack receipt cannot downgrade
 // by deleting/nulling its deliveries array while keeping sourceItemIDs.
 const hasSources=Object.prototype.hasOwnProperty.call(record,"sourceItemIDs"),
  hasDeliveryField=Object.prototype.hasOwnProperty.call(record,"deliveries");
 if(hasSources!==hasDeliveryField||
    (hasSources&&(!Array.isArray(record.sourceItemIDs)||
      !Array.isArray(record.deliveries))))return false;
 const deliveries=receiptDeliveries(record);
 const hasOriginalDeliveryWitness=Array.isArray(record.deliveries);
 if(!Array.isArray(expectedSources)||expectedSources.length===0||
    expectedSources.length>MAX_STACKS||
    expectedSources.some((x,i)=>!pos(x)||
      (i>0&&x<=expectedSources[i-1]))||
    !Array.isArray(deliveries)||deliveries.length<1||
    deliveries.length>expectedSources.length||
    deliveries[0].itemID!==record.itemID||
    expectedSources[0]!==record.sourceItemID)return false;
 const sources=new Set(expectedSources),seen=new Set(),dest=new Set();
 let sum=0;
 for(const [index,d] of deliveries.entries()){
  // The original multi-stack writer consumes escrow in sorted source-ID
  // order. A durable receipt cannot substitute a different physical stack
  // or omit its before/after custody witnesses during release/replay.
  // Keep the old pre-multistack single-item receipt fallback compatible.
  if(hasOriginalDeliveryWitness&&
     (d?.sourceItemID!==expectedSources[index]||
      !pos(d.sourceBefore)||!safe(d.sourceAfter)))return false;
  if(!pos(d?.sourceItemID)||!sources.has(d.sourceItemID)||
     seen.has(d.sourceItemID)||!pos(d.itemID)||dest.has(d.itemID)||
     !pos(d.quantity)||!Number.isSafeInteger(sum+d.quantity))return false;
  if(d.sourceBefore!==undefined||d.sourceAfter!==undefined){
   if(!pos(d.sourceBefore)||!safe(d.sourceAfter)||
      d.sourceBefore-d.quantity!==d.sourceAfter||
      (d.sourceAfter===0)!==(d.itemID===d.sourceItemID))
    return false;
  }
  seen.add(d.sourceItemID);dest.add(d.itemID);sum+=d.quantity;
 }
 return sum===expectedQuantity&&
  expectedSources.every(x=>seen.has(x)||record.volumeAfter>0);
}
// The receipt is the final release gate after original SQLite COMMIT.
// Preserve all wallet and fee arithmetic as finite, nonnegative integer
// cents; a merely conserving negative balance is not proof of payment.
function validPaidReceipt(r,gross){
 if(!r||!pos(gross)||!safe(r.taxCents)||r.taxCents>gross||
    !safe(r.buyerBeforeCents)||!safe(r.buyerAfterCents)||
    !safe(r.sellerBeforeCents)||!safe(r.sellerAfterCents)||
    r.buyerBeforeCents<gross||
    r.buyerAfterCents!==r.buyerBeforeCents-gross||
    !safe(r.sellerBeforeCents+gross)||
    r.sellerAfterCents!==r.sellerBeforeCents+gross-r.taxCents||
    !pos(r.committedAt))return false;
 return true;
}
const receiptKey=t=>"p2p:"+t.orderID+":"+t.cycle;
function checkTicket(ticket,proof){
 if(!ticket||!proof||!Object.isFrozen(proof)||ticket.orderID!==proof.orderID||
    typeof proof.orderID!=="string"||!/^[1-9][0-9]*$/.test(proof.orderID)||
    !pos(ticket.cycle)||!pos(proof.ownerID)||!pos(proof.counterpartyID)||
    proof.bid!==false||proof.ownerID===proof.counterpartyID||
    !pos(proof.stationID)||!pos(proof.typeID)||
    !pos(proof.filledQuantity)||!pos(proof.volumeBefore)||
    !pos(proof.priceCents)||!pos(proof.sellerSourceLocationID)||
    proof.filledQuantity>proof.volumeBefore||
    !safe(proof.volumeAfter)||
    proof.volumeAfter!==proof.volumeBefore-proof.filledQuantity)
  throw Error("P2P_ATOMIC_ORIGINAL_SELL_VOLUME_PROOF_INVALID");
 const escrowLocation=BigInt(proof.orderID)+9200000000n;
 if(escrowLocation>BigInt(Number.MAX_SAFE_INTEGER)||
    Number(escrowLocation)!==proof.sellerSourceLocationID)
  throw Error("P2P_ATOMIC_UNSAFE_ESCROW_LOCATION");
 const gross=proof.priceCents*proof.filledQuantity;
 if(!pos(gross))throw Error("P2P_ATOMIC_GROSS_OVERFLOW");
 return gross;
}
function createAtomicSell({gameStore,clock=()=>Date.now()}={}){
 if(typeof gameStore?.transact!=="function"||typeof clock!=="function")
  throw Error("P2P_ATOMIC_NATIVE_GAMESTORE_REQUIRED");
 function enabled(){
  return process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
   process.env.EVEJS_COOP_PLAYER_MARKET_ATOMIC==="1"&&
   process.env.EVEJS_COOP_PLAYER_MARKET_FILL_GUARD==="1"&&
   process.env.EVEJS_COOP_PLAYER_MARKET_SETTLEMENT_FENCE==="1"&&
   process.env.EVEJS_COOP_RUST_P2P_CLAIM==="1";
 }
 function settle({ticket,proof,tax,sourceItemID,sourceItemIDs}={}){
  if(!enabled())throw Error("P2P_ATOMIC_FLAGS_DISABLED");
  const gross=checkTicket(ticket,proof),taxCents=cents(tax);
  if(taxCents===null||taxCents>gross)
   throw Error("P2P_ATOMIC_TAX_OR_SOURCE_INVALID");
  const origins=sourceIDs({sourceItemID,sourceItemIDs});
  const buyer=proof.counterpartyID,seller=proof.ownerID,key=receiptKey(ticket);
  return gameStore.transact(TABLES,tx=>{
   const existing=tx.get("playerMarketFills",key);
   if(existing){
    if(existing.phase!=="GAMESTORE_COMMITTED"||existing.key!==key||
       existing.orderID!==ticket.orderID||existing.cycle!==ticket.cycle||
       existing.buyerID!==buyer||existing.sellerID!==seller||
       existing.sourceItemID!==origins[0]||!pos(existing.itemID)||
       !checkDeliveries(existing,origins,proof.filledQuantity)||
       (existing.sourceItemIDs!==undefined&&
        JSON.stringify(existing.sourceItemIDs)!==JSON.stringify(origins))||
       existing.quantity!==proof.filledQuantity||
       existing.volumeBefore!==proof.volumeBefore||
       existing.volumeAfter!==proof.volumeAfter||
       existing.partial!==(proof.volumeAfter>0)||
       existing.stationID!==proof.stationID||existing.typeID!==proof.typeID||
       existing.priceCents!==proof.priceCents||existing.taxCents!==taxCents||
       existing.grossCents!==gross||
       !validPaidReceipt(existing,gross))
     throw Error("P2P_ATOMIC_COMMITTED_RECEIPT_REPLAY_CONFLICT");
    // A player may already have sold/used their received item. Never
    // require it to remain in the hangar and never replay wallet movement.
    return {...existing,replayed:true};
   }
   const escrow=tx.get("marketEscrow",ticket.orderID);
   if(!escrow||String(escrow.orderId)!==ticket.orderID||
      escrow.escrowType!=="sell"||escrow.isCorp!==false||
      escrow.ownerId!==seller||escrow.stationId!==proof.stationID||
      escrow.typeId!==proof.typeID||
      escrow.remainingQuantity!==proof.volumeBefore||
      escrow.escrowLocationID!==proof.sellerSourceLocationID)
    throw Error("P2P_ATOMIC_ESCROW_UNVERIFIED");
   const allItems=tx.scan("items");
   const stacks=allItems.filter(({value})=>
    value?.ownerID===seller&&value.locationID===proof.sellerSourceLocationID&&
    value.flagID===4).sort((a,b)=>a.value.itemID-b.value.itemID);
   if(stacks.length!==origins.length||
      stacks.some((e,i)=>e.key!==String(origins[i])))
    throw Error("P2P_ATOMIC_PHYSICAL_ESCROW_SET_UNVERIFIED");
   let originalQuantity=0;
   for(const {key:stackKey,value:item} of stacks){
    if(!pos(item?.itemID)||String(item.itemID)!==stackKey||
       item.typeID!==proof.typeID||item.singleton!==0||
       !pos(item.quantity)||item.quantity!==item.stacksize||
       !pos(item.categoryID)||
       !Number.isSafeInteger(originalQuantity+item.quantity))
     throw Error("P2P_ATOMIC_ORIGINAL_STACK_CUSTODY_INVALID");
    originalQuantity+=item.quantity;
   }
   if(originalQuantity!==proof.volumeBefore)
    throw Error("P2P_ATOMIC_ESCROW_PHYSICAL_QUANTITY_MISMATCH");
   const buyerRow=tx.get("characters",String(buyer)),
    sellerRow=tx.get("characters",String(seller));
   // Vanilla EveJS character rows are addressed by their authoritative
   // GameStore key; the JSON record need not embed characterID/charID.
   // Keep rejecting an explicitly conflicting ID before any item/ISK write.
   const buyerEmbedded=buyerRow?.characterID??buyerRow?.charID;
   const sellerEmbedded=sellerRow?.characterID??sellerRow?.charID;
   if(!buyerRow||!sellerRow||
      (buyerEmbedded!==undefined&&buyerEmbedded!==null&&
       Number(buyerEmbedded)!==buyer)||
      (sellerEmbedded!==undefined&&sellerEmbedded!==null&&
       Number(sellerEmbedded)!==seller)||
      !Array.isArray(buyerRow.walletJournal)||!Array.isArray(sellerRow.walletJournal)||
      !Array.isArray(buyerRow.marketTransactions)||
      !Array.isArray(sellerRow.marketTransactions))
    throw Error("P2P_ATOMIC_CHARACTER_WALLET_AUTHORITY_MISSING");
   const buyerBefore=cents(buyerRow.balance),sellerBefore=cents(sellerRow.balance);
   if(buyerBefore===null||sellerBefore===null||buyerBefore<gross||
      !safe(sellerBefore+gross-taxCents))
    throw Error("P2P_ATOMIC_WALLET_FUNDS_OR_PRECISION_INVALID");
   const buyerAfter=buyerBefore-gross,sellerAfter=sellerBefore+gross-taxCents;
   const seed=tx.get("identityState","coopP2PMarketJournal");
   const next=seed?.next??5000000000000000;
   if(!pos(next)||next<5000000000000000||
      !pos(next+3)||next+3>Number.MAX_SAFE_INTEGER)
    throw Error("P2P_ATOMIC_JOURNAL_ID_EXHAUSTED");
   const ids=[next,next+1,next+2];
   const prev=[...buyerRow.walletJournal,...sellerRow.walletJournal,
    ...buyerRow.marketTransactions,...sellerRow.marketTransactions];
   if(prev.some(x=>ids.includes(x?.transactionID)))
    throw Error("P2P_ATOMIC_JOURNAL_ID_COLLISION");
   const at=clock();
   if(!pos(at))throw Error("P2P_ATOMIC_CLOCK_INVALID");
   const time=String(BigInt(at)*10000n+116444736000000000n);
   const base={transactionDate:time,referenceID:ticket.orderID,
    currency:1,accountKey:1000,sortValue:1,ownerID1:buyer,ownerID2:seller,
    description:"Native player-to-player market fill "+key};
   const buyerEntry={...base,transactionID:ids[0],entryTypeID:2,
    amount:isk(-gross),balance:isk(buyerAfter)};
   const sellerEntry={...base,transactionID:ids[1],entryTypeID:2,
    amount:isk(gross),balance:isk(sellerBefore+gross)};
   const taxEntry={...base,transactionID:ids[2],entryTypeID:54,
    amount:isk(-taxCents),balance:isk(sellerAfter),
    ownerID1:proof.stationID,ownerID2:seller,
    description:"Native market transaction tax "+key};
   const trade={transactionID:ids[0],transactionDate:time,
    typeID:proof.typeID,quantity:proof.filledQuantity,
    price:isk(proof.priceCents),stationID:proof.stationID,
    locationID:proof.stationID,buyerID:buyer,sellerID:seller,
    accountID:1000,buyerAccountID:1000,sellerAccountID:1000};
   const buyerNext={...buyerRow,balance:isk(buyerAfter),balanceChange:isk(-gross),
    walletJournal:[buyerEntry,...buyerRow.walletJournal].slice(0,100),
    marketTransactions:[{...trade,clientID:seller,journalRefID:ids[0]},
     ...buyerRow.marketTransactions].slice(0,2000)};
   const sellerNext={...sellerRow,balance:isk(sellerAfter),
    balanceChange:isk(gross-taxCents),
    walletJournal:[...(taxCents>0?[taxEntry]:[]),sellerEntry,
     ...sellerRow.walletJournal].slice(0,100),
    marketTransactions:[{...trade,transactionID:ids[1],
     clientID:buyer,journalRefID:ids[1]},
     ...sellerRow.marketTransactions].slice(0,2000)};
   const partial=proof.volumeAfter>0;
   let remaining=proof.filledQuantity,splitRequired=false;
   const consume=[];
   for(const {value:item} of stacks){
    if(remaining===0)break;
    const take=Math.min(item.quantity,remaining);
    if(take<item.quantity)splitRequired=true;
    consume.push({item,take});
    remaining-=take;
   }
   if(remaining!==0)throw Error("P2P_ATOMIC_SOURCE_CONSUMPTION_MISMATCH");
   let nextItemID=null;
   if(splitRequired){
    const counter=tx.get("identityState","nextItemID");
    if(!pos(counter)||counter<ITEM_FLOOR)
     throw Error("P2P_ATOMIC_NATIVE_ITEM_ALLOCATOR_MISSING");
    let maxID=ITEM_FLOOR-1;
    for(const row of allItems){
     if(!pos(row.value?.itemID)||String(row.value.itemID)!==row.key)
      throw Error("P2P_ATOMIC_ITEM_IDENTITY_INDEX_UNSAFE");
     maxID=Math.max(maxID,row.value.itemID);
    }
    nextItemID=Math.max(counter,maxID+1,ITEM_FLOOR);
    if(!pos(nextItemID)||!pos(nextItemID+1)||
       tx.get("items",String(nextItemID))!==null)
     throw Error("P2P_ATOMIC_NATIVE_ITEM_ID_EXHAUSTED");
   }
   const deliveries=[];
   for(const {item,take} of consume){
    const split=take<item.quantity;
    const buyerItemID=split?nextItemID:item.itemID;
    const moved={...item,itemID:buyerItemID,ownerID:buyer,
     locationID:proof.stationID,flagID:4,
     quantity:take,stacksize:take};
    if(split){
     tx.put("items",String(item.itemID),{
      ...item,quantity:item.quantity-take,stacksize:item.quantity-take
     });
     tx.put("items",String(buyerItemID),moved);
    }else{
     tx.put("items",String(item.itemID),moved);
    }
    deliveries.push(Object.freeze({sourceItemID:item.itemID,
     itemID:buyerItemID,quantity:take,
     sourceBefore:item.quantity,sourceAfter:item.quantity-take}));
   }
   if(splitRequired)tx.put("identityState","nextItemID",nextItemID+1);
   let deliveredTotal=0;
   for(const entry of deliveries)deliveredTotal+=entry.quantity;
   if(deliveredTotal!==proof.filledQuantity)
    throw Error("P2P_ATOMIC_DELIVERY_CONSERVATION_FAILED");
   const result={key,phase:"GAMESTORE_COMMITTED",orderID:ticket.orderID,
    cycle:ticket.cycle,buyerID:buyer,sellerID:seller,
    stationID:proof.stationID,typeID:proof.typeID,
    itemID:deliveries[0].itemID,sourceItemID:origins[0],
    sourceItemIDs:origins,deliveries,partial,
    volumeBefore:proof.volumeBefore,volumeAfter:proof.volumeAfter,
    quantity:proof.filledQuantity,priceCents:proof.priceCents,
    grossCents:gross,taxCents,
    buyerBeforeCents:buyerBefore,buyerAfterCents:buyerAfter,
    sellerBeforeCents:sellerBefore,sellerAfterCents:sellerAfter,
    committedAt:at};
   tx.put("characters",String(buyer),buyerNext);
   tx.put("characters",String(seller),sellerNext);
   if(partial){
    tx.put("marketEscrow",ticket.orderID,{
     ...escrow,remainingQuantity:proof.volumeAfter
    });
   }else{
    tx.del("marketEscrow",ticket.orderID);
   }
   tx.put("identityState","coopP2PMarketJournal",{next:next+3});
   tx.put("playerMarketFills",key,result);
   return result;
  });
 }
 function requireReceipt(ticket,proof){
  checkTicket(ticket,proof);
  const key=receiptKey(ticket);
  return gameStore.transact(["playerMarketFills"],tx=>{
   const receipt=tx.get("playerMarketFills",key);
   if(!receipt||receipt.key!==key||receipt.phase!=="GAMESTORE_COMMITTED"||
      receipt.orderID!==ticket.orderID||receipt.cycle!==ticket.cycle||
      receipt.buyerID!==proof.counterpartyID||receipt.sellerID!==proof.ownerID||
      receipt.quantity!==proof.filledQuantity||
       receipt.volumeBefore!==proof.volumeBefore||
       receipt.volumeAfter!==proof.volumeAfter||
       receipt.partial!==(proof.volumeAfter>0)||
       receipt.stationID!==proof.stationID||
       receipt.typeID!==proof.typeID||
       !pos(receipt.itemID)||!pos(receipt.sourceItemID)||
       !checkDeliveries(receipt,
        receipt.sourceItemIDs??[receipt.sourceItemID],
        proof.filledQuantity)||
      receipt.priceCents!==proof.priceCents||
      receipt.grossCents!==proof.priceCents*proof.filledQuantity||
      !validPaidReceipt(receipt,receipt.grossCents))
    throw Error("P2P_ATOMIC_DURABLE_NATIVE_RECEIPT_REQUIRED");
   return receipt;
  });
 }
 return Object.freeze({settle,requireReceipt});
}
let single=null;
function active(){
 if(!single)single=createAtomicSell({
  gameStore:require("../gameStore").coopAtomicNativeRows
 });
 return single;
}
module.exports={createAtomicSell,receiptKey,
 settle:args=>active().settle(args),
 requireReceipt:(ticket,proof)=>active().requireReceipt(ticket,proof)};
