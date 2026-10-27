"use strict";
/**
 * COOP-035: whole-stack native NPC corporate purchase, first provable slice.
 * Cross-DB protocol: durable Rust CLAIM -> atomic GameStore buyer+corp+item+
 * escrow+receipt -> idempotent Rust FINALIZE. Never uses normal character-seller.
 * No live registration; exact producer-owned item; no mint/split, no partial fill.
 */
const crypto=require("node:crypto");
const TABLES=Object.freeze(["characters","corporationRuntime","items","marketEscrow","npcMarketFills"]);
const ESCROW_BASE=9200000000;
const pos=x=>Number.isSafeInteger(x)&&x>0;
// Existing native wallet balances are authoritative. A sub-cent balance
// indicates unverified currency state: do not round it while moving items
// or crediting the corporate market ledger.
const cents=x=>{
 if(typeof x!=="number"||!Number.isFinite(x)||x<0)return null;
 const scaled=x*100,whole=Math.round(scaled);
 return Number.isSafeInteger(whole)&&Math.abs(scaled-whole)<=1e-6?
  whole:null;
};
const isk=c=>Math.round(c)/100;
const isSalvage=x=>typeof x==="string"&&/^npc-salvage:[0-9a-f]{32}$/.test(x);
const validID=x=>typeof x==="string"&&
 (/^npc-manufacture:[0-9a-f]{32}$/.test(x)||isSalvage(x));
const salvageMarker=(wreckID,sourceCargoID)=>
 "coop-salvage-rival:v1:"+wreckID+":"+sourceCargoID;
function verifySalvageOriginal(tx,identity,escrow,item){
 const op=identity.operationID;
 if(!isSalvage(op))throw Error("SALVAGE_SETTLEMENT_OPERATION_INVALID");
 const ops=tx.get("corporationRuntime","coopSalvageMarketOps");
 if(ops?.version!==1||!ops.bySource||
  typeof ops.bySource!=="object"||Array.isArray(ops.bySource))
  throw Error("SALVAGE_SETTLEMENT_ORIGINAL_JOURNAL_MISSING");
 const entry=Object.values(ops.bySource).filter(x=>x?.operationID===op);
 if(entry.length!==1||entry[0].phase!=="LISTED"||
  entry[0].nativeItemID!==identity.itemID||
  entry[0].corporationID!==identity.ownerID||
  entry[0].stationID!==identity.stationID||
  entry[0].typeID!==identity.typeID||
  entry[0].quantity!==identity.quantity||
  entry[0].orderID!==identity.orderID)
  throw Error("SALVAGE_SETTLEMENT_ORIGINAL_OPERATION_CONFLICT");
 const a=entry[0],r=tx.get("corporationRuntime","coopSalvageRivalMoves");
 const pickup=r?.moves?.[String(a.wreckItemID)];
 if(r?.version!==1||!pickup||pickup.v!==1||
  pickup.state!=="NPC_STOCK_DELIVERED"||
  pickup.manifestKey!==a.manifestKey||
  pickup.wreckID!==a.wreckID||
  pickup.wreckItemID!==a.wreckItemID||
  pickup.sourceCargoID!==a.sourceCargoID||
  pickup.npcCargoID!==a.npcCargoID||
  pickup.entityID!==a.entityID||
  pickup.corporationID!==identity.ownerID||
  pickup.stationID!==identity.stationID||
  pickup.nativeItemID!==identity.itemID)
  throw Error("SALVAGE_SETTLEMENT_ORIGINAL_RECEIPT_CONFLICT");
 const expected="npc-salvage:"+crypto.createHash("sha256")
  .update([a.manifestKey,a.wreckID,a.wreckItemID,
   a.nativeItemID,a.sourceCargoID,a.corporationID,a.stationID].join(":"))
  .digest("hex").slice(0,32);
 if(expected!==op||escrow.coopSource!=="NATIVE_SALVAGE"||
  item.customInfo!==salvageMarker(a.wreckItemID,a.sourceCargoID))
  throw Error("SALVAGE_SETTLEMENT_SOURCE_MARKER_CONFLICT");
 // Read the same native source table inside the finance transaction:
 // a second row carrying this salvage provenance must not survive a sale.
 if(tx.scan("items").filter(x=>
  x.value?.customInfo===salvageMarker(a.wreckItemID,a.sourceCargoID))
  .length!==1)
  throw Error("SALVAGE_SETTLEMENT_DUPLICATE_SOURCE_ITEM");
 return {entry:a,sourceKey:String(a.wreckItemID),ops};
}
function createNpcCorporateSettlement({gameStore,market,verifyBuyerSession,verifyNpcCorporation,
 clock=()=>Date.now()}={}){
 if(typeof gameStore?.transact!=="function"||
   ["claimOnce","finalizeOnce","inspectClaim"].some(k=>typeof market?.[k]!=="function")||
   typeof verifyBuyerSession!=="function"||typeof verifyNpcCorporation!=="function"||
   typeof clock!=="function")throw Error("NPC_CORPORATE_SETTLEMENT_AUTHORITIES_REQUIRED");
 const active=new Set();
 function gate(){return process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
   process.env.EVEJS_COOP_NATIVE_NPC_CORP_SETTLEMENT_PROOF==="1"}
 function requireClaim(order,buyer,identity,maxPriceCents){
  if(isSalvage(identity?.operationID)&&
   process.env.EVEJS_COOP_SALVAGE_NATIVE_MARKET!=="1")
   throw Error("SALVAGE_SETTLEMENT_DISABLED");
  if(!order||order.source!=="coop-npc"||!["settling","filled"].includes(order.state)||
   !validID(order.operation_id)||!pos(Number(order.order_id))||
   !pos(Number(order.source_item_id))||!pos(Number(order.owner_id))||
   !pos(Number(order.station_id))||!pos(Number(order.type_id))||
   !pos(Number(order.quantity))||order.quantity>50000||
   !pos(Number(order.buyer_id))||Number(order.buyer_id)!==buyer||
   order.is_corp!==true||order.bid!==false||!pos(Number(order.fill_id))||
   !Number.isSafeInteger(Number(order.price_cents))||Number(order.price_cents)<=0||
   order.price_cents>100000000||order.fill_id===undefined)throw Error("NPC_RUST_CLAIM_NOT_CANONICAL");
  if(order.operation_id!==identity.operationID||
   Number(order.order_id)!==identity.orderID||
   Number(order.owner_id)!==identity.ownerID||
   Number(order.station_id)!==identity.stationID||
   Number(order.type_id)!==identity.typeID||
   Number(order.quantity)!==identity.quantity||
   Number(order.source_item_id)!==identity.itemID)
   throw Error("NPC_RUST_CLAIM_IDENTITY_MISMATCH");
  if(!Number.isSafeInteger(maxPriceCents)||maxPriceCents<=0||
     Number(order.price_cents)>maxPriceCents)throw Error("NPC_RUST_PRICE_EXCEEDS_PLAYER_LIMIT");
  if(verifyNpcCorporation(identity.ownerID,identity.stationID)!==true)
   throw Error("NPC_SELLER_NOT_VERIFIED");
  return {fillID:Number(order.fill_id),priceCents:Number(order.price_cents),
   grossCents:Number(order.price_cents)*identity.quantity};
 }
 function atomicSettle(order,buyerID,identity,maxPriceCents=Number(order?.price_cents)){
  const {fillID,priceCents,grossCents}=requireClaim(order,buyerID,identity,maxPriceCents);
  if(!Number.isSafeInteger(grossCents)||grossCents<=0||grossCents>100000000000)
   throw Error("NPC_CORPORATE_GROSS_COST_INVALID");
  const orderKey=String(identity.orderID),itemKey=String(identity.itemID);
  const fillKey="order"+String.fromCharCode(31)+orderKey;
  return gameStore.transact(TABLES,tx=>{
   const prior=tx.get("npcMarketFills",fillKey);
   if(prior!==null&&prior!==undefined){
    // A journal row is not evidence of an already-paid original item unless
    // the full immutable receipt and cent-conservation ledger both verify.
    // Do not re-debit the buyer or require the item to remain unconsumed:
    // legitimate replay may happen after the buyer has used the goods.
    const source=isSalvage(identity.operationID)?"NATIVE_SALVAGE":"NATIVE_INDUSTRY";
    const walletProof=[prior.buyerBeforeCents,prior.buyerAfterCents,
      prior.corpBeforeCents,prior.corpAfterCents];
    if(prior.phase!=="NATIVE_COMMITTED"||
       prior.fillID!==fillID||prior.orderID!==identity.orderID||
       prior.operationID!==identity.operationID||
       prior.coopSource!==source||prior.buyerID!==buyerID||
       prior.ownerID!==identity.ownerID||prior.stationID!==identity.stationID||
       prior.typeID!==identity.typeID||prior.itemID!==identity.itemID||
       prior.quantity!==identity.quantity||prior.priceCents!==priceCents||
       prior.grossCents!==grossCents||
       walletProof.some(x=>!Number.isSafeInteger(x)||x<0)||
       prior.buyerBeforeCents<grossCents||
       prior.buyerAfterCents!==prior.buyerBeforeCents-grossCents||
       !Number.isSafeInteger(prior.corpBeforeCents+grossCents)||
       prior.corpAfterCents!==prior.corpBeforeCents+grossCents||
       !pos(prior.committedAt))
     throw Error("NPC_CORPORATE_FILL_REPLAY_CONFLICT");
    return {status:"ALREADY_NATIVE_COMMITTED",fillID,orderID:identity.orderID,
      buyerID,itemID:identity.itemID,quantity:identity.quantity,grossCents};
   }
   if(order.state!=="settling")throw Error("NPC_MARKET_FILLED_WITHOUT_NATIVE_RECEIPT");
   const escrow=tx.get("marketEscrow",orderKey);
   const item=tx.get("items",itemKey);
   const corpKey="corporations"+String.fromCharCode(31)+identity.ownerID;
   const corp=tx.get("corporationRuntime",corpKey);
   const character=tx.get("characters",String(buyerID));
   if(!escrow||escrow.escrowType!=="sell"||escrow.isCorp!==true||
      escrow.ownerId!==identity.ownerID||escrow.stationId!==identity.stationID||
      escrow.sourceItemID!==identity.itemID||escrow.coopOperationID!==identity.operationID||
      escrow.remainingQuantity!==identity.quantity||
      escrow.escrowLocationID!==ESCROW_BASE+identity.orderID)
    throw Error("NPC_MARKET_NATIVE_ESCROW_MISSING");
   if(!item||item.itemID!==identity.itemID||item.ownerID!==identity.ownerID||
      item.typeID!==identity.typeID||item.locationID!==ESCROW_BASE+identity.orderID||
      item.flagID!==4||item.singleton!==0||item.quantity!==identity.quantity||
      item.stacksize!==identity.quantity)
    throw Error("NPC_MARKET_OUTPUT_CUSTODY_INVALID");
   // Manufacturing and original NPC salvage share the same native wallet
   // settlement, but never the same provenance authority.
   const salvage=isSalvage(identity.operationID);
   if(!salvage&&!/^coop-industry:v1:[0-9]+$/.test(String(item.customInfo||"")))
    throw Error("NPC_MARKET_OUTPUT_CUSTODY_INVALID");
   const original=salvage?verifySalvageOriginal(tx,identity,escrow,item):null;
   if(!character||Number(character.characterID??character.charID??buyerID)!==buyerID||
      !Number.isFinite(character.balance)||cents(character.balance)===null||
      cents(character.balance)<grossCents)throw Error("NPC_BUYER_INSUFFICIENT_FUNDS");
   const division=corp?.wallet?.divisions?.["1000"];
   if(corp?.corporationID!==identity.ownerID||!division||
      cents(division.balance)===null||!Array.isArray(division.journal)||
      !Array.isArray(division.transactions)||!Array.isArray(character.walletJournal)||
      !Array.isArray(character.marketTransactions))
     throw Error("NPC_CORPORATE_WALLET_INVALID");
   const oldBuyer=cents(character.balance),oldCorp=cents(division.balance);
   if(oldBuyer===null||oldCorp===null)throw Error("NPC_WALLET_AMOUNT_INVALID");
   const nextBuyer=oldBuyer-grossCents,nextCorp=oldCorp+grossCents;
   if(nextBuyer<0||!Number.isSafeInteger(nextCorp))
     throw Error("NPC_CORPORATE_WALLET_OVERFLOW");
   const now=clock();if(!Number.isSafeInteger(now)||now<=0)throw Error("NPC_LEDGER_CLOCK_INVALID");
   const filetime=String(BigInt(now)*10000n+116444736000000000n);
   const journalBase={transactionID:fillID,transactionDate:filetime,referenceID:identity.orderID,
    entryTypeID:10,ownerID1:buyerID,ownerID2:identity.ownerID,accountKey:1000,
    currency:1,sortValue:1,description:"Native NPC market order "+orderKey};
   if(character.walletJournal.some(r=>r.transactionID===fillID)||
      division.journal.some(r=>r.transactionID===fillID)||
      division.transactions.some(r=>r.transactionID===fillID))
      throw Error("NPC_LEDGER_FILL_ID_COLLISION");
   const buyerAfter={...character,balance:isk(nextBuyer),balanceChange:isk(-grossCents),
     walletJournal:[{...journalBase,amount:isk(-grossCents),balance:isk(nextBuyer)},
       ...character.walletJournal].slice(0,100),
     marketTransactions:[{transactionID:fillID,transactionDate:filetime,typeID:identity.typeID,
      quantity:identity.quantity,price:isk(priceCents),stationID:identity.stationID,
      locationID:identity.stationID,buyerID,sellerID:identity.ownerID,clientID:identity.ownerID,
      accountID:1000,buyerAccountID:1000,sellerAccountID:1000,journalRefID:fillID},
      ...character.marketTransactions].slice(0,2000)};
   const corpEntry={...journalBase,amount:isk(grossCents),balance:isk(nextCorp)};
   const corpAfter={...corp,wallet:{...corp.wallet,divisions:{...corp.wallet.divisions,
      "1000":{...division,balance:isk(nextCorp),
       journal:[...division.journal,corpEntry].slice(-100),
       transactions:[...division.transactions,corpEntry].slice(-2000)}}}};
   const delivered={...item,ownerID:buyerID,locationID:identity.stationID};
   const receipt={phase:"NATIVE_COMMITTED",fillID,orderID:identity.orderID,operationID:identity.operationID,
    coopSource:salvage?"NATIVE_SALVAGE":"NATIVE_INDUSTRY",
    itemID:identity.itemID,buyerID,ownerID:identity.ownerID,stationID:identity.stationID,
    typeID:identity.typeID,quantity:identity.quantity,priceCents,grossCents,
    buyerBeforeCents:oldBuyer,buyerAfterCents:nextBuyer,
    corpBeforeCents:oldCorp,corpAfterCents:nextCorp,committedAt:now};
   // All four source-of-truth transitions plus the idempotency receipt commit together.
   tx.put("characters",String(buyerID),buyerAfter);
   tx.put("corporationRuntime",corpKey,corpAfter);
   tx.put("items",itemKey,delivered);
   tx.del("marketEscrow",orderKey);
   tx.put("npcMarketFills",fillKey,receipt);
   if(original){
    const e=original.entry;
    e.phase="NATIVE_SALE_COMMITTED";
    e.fillID=fillID;e.buyerID=buyerID;e.grossCents=grossCents;
    e.saleCommittedAt=now;
    tx.put("corporationRuntime","coopSalvageMarketOps",original.ops);
   }
   return {status:"NATIVE_COMMITTED",fillID,orderID:identity.orderID,buyerID,
    itemID:identity.itemID,quantity:identity.quantity,grossCents};
  });
 }
 // A sale is SOLD only after the Rust fill was finalized and independently
 // read back. Native wallet+item COMMIT is never confused with Rust success.
 function confirmSalvageSold(identity,buyerID,fillID){
  if(!isSalvage(identity.operationID))return;
  const key="order"+String.fromCharCode(31)+identity.orderID;
  gameStore.transact(["corporationRuntime","npcMarketFills"],tx=>{
   const paid=tx.get("npcMarketFills",key);
   const ops=tx.get("corporationRuntime","coopSalvageMarketOps");
   const entries=Object.values(ops?.bySource||{}).filter(e=>
    e?.operationID===identity.operationID);
   if(paid?.phase!=="NATIVE_COMMITTED"||
    paid.coopSource!=="NATIVE_SALVAGE"||paid.fillID!==fillID||
    paid.buyerID!==buyerID||paid.itemID!==identity.itemID||
    paid.operationID!==identity.operationID||
    ops?.version!==1||entries.length!==1||
    entries[0].fillID!==fillID||entries[0].buyerID!==buyerID||
    entries[0].orderID!==identity.orderID)
    throw Error("SALVAGE_RUST_FINALIZED_NATIVE_RECEIPT_CONFLICT");
   const entry=entries[0];
   if(entry.phase==="SOLD")return {status:"ALREADY_SOLD"};
   if(entry.phase!=="NATIVE_SALE_COMMITTED")
    throw Error("SALVAGE_RUST_FINALIZED_PHASE_CONFLICT");
   const now=clock();if(!Number.isSafeInteger(now)||now<=0)
    throw Error("SALVAGE_FINALIZE_CLOCK_INVALID");
   entry.phase="SOLD";entry.rustFinalizedAt=now;
   tx.put("corporationRuntime","coopSalvageMarketOps",ops);
   return {status:"NATIVE_SALVAGE_SOLD"};
  });
 }
 async function purchaseOnce({buyerID,identity,maxPriceCents}={}){
  if(!gate())return {status:"BLOCKED",error:"NPC_CORPORATE_SETTLEMENT_DISABLED"};
  // A disabled salvage market must not leave a Rust order claimed by a
  // buyer. Check BEFORE the external claim, not only in atomicSettle.
  if(isSalvage(identity?.operationID)&&
   process.env.EVEJS_COOP_SALVAGE_NATIVE_MARKET!=="1")
   return {status:"BLOCKED",error:"SALVAGE_SETTLEMENT_DISABLED"};
  if(!pos(buyerID)||!Number.isSafeInteger(maxPriceCents)||maxPriceCents<=0||
     !identity||!validID(identity.operationID)||
     [identity.orderID,identity.ownerID,identity.stationID,
      identity.typeID,identity.itemID,identity.quantity].some(x=>!pos(x))||
     identity.quantity>50000)return {status:"BLOCKED",error:"NPC_CORPORATE_PURCHASE_INVALID"};
  if(verifyBuyerSession(buyerID,identity.stationID)!==true)
    return {status:"BLOCKED",error:"NPC_BUYER_SESSION_OR_DOCK_INVALID"};
  const key=identity.orderID;
  if(active.has(key))return {status:"BLOCKED",error:"NPC_PURCHASE_BUSY"};
  active.add(key);
  try{
   // Claim is durable and idempotent in Rust; only ONE buyer can win per order.
   // A mid-flight crash leaves Rust SETTLING and invisible to other buyers.
   const order=await market.claimOnce({orderID:key,buyerID,operationID:identity.operationID});
   const receipt=atomicSettle(order,buyerID,identity,maxPriceCents);
   const final=await market.finalizeOnce({orderID:key,buyerID,
      operationID:identity.operationID,fillID:receipt.fillID});
   if(final?.state!=="filled"||Number(final.order_id)!==key||
      Number(final.buyer_id)!==buyerID||Number(final.fill_id)!==receipt.fillID||
      Number(final.vol_remaining)!==0)
     throw Error("NPC_RUST_FILL_FINALIZE_UNCERTAIN");
   const observed=await market.inspectClaim({orderID:key,operationID:identity.operationID});
   if(observed?.state!=="filled"||Number(observed.fill_id)!==receipt.fillID||
      Number(observed.buyer_id)!==buyerID)
     throw Error("NPC_RUST_FILL_ACK_UNCERTAIN");
   confirmSalvageSold(identity,buyerID,receipt.fillID);
   return {...receipt,status:"PURCHASED"};
  }finally{active.delete(key)}
 }
 return Object.freeze({purchaseOnce,atomicSettle,mode:"WHOLE_STACK_PROOF_ONLY",
  supportsLiveSettlement:false});
}
module.exports={createNpcCorporateSettlement,TABLES};
