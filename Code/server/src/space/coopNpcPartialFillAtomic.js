"use strict";
/**
 * COOP-047: opt-in native GameStore half of a partial Rust NPC sell fill.
 * Strictly requires a durable Rust claim before touching any wallet or item.
 * This is NOT wired into the live client: its Rust counterpart must be built
 * and tested against a disposable pinned market database first.
 */
const TABLES=Object.freeze(["characters","corporationRuntime","items","identityState","marketEscrow","npcMarketFills"]);
const SEP="\u001f",ESCROW_BASE=9200000000,ITEM_FLOOR=1990000000;
const pos=x=>Number.isSafeInteger(x)&&x>0;
const nonneg=x=>Number.isSafeInteger(x)&&x>=0;
const validOp=x=>typeof x==="string"&&/^npc-manufacture:[0-9a-f]{32}$/.test(x);
const validClaim=x=>typeof x==="string"&&/^npc-partial:[0-9a-f]{32}$/.test(x);
const cents=x=>typeof x==="number"&&Number.isFinite(x)&&x>=0&&
 Number.isSafeInteger(Math.round(x*100))?Math.round(x*100):null;
const isk=x=>x/100;
const integer=x=>typeof x==="string"&&/^[0-9]+$/.test(x)?Number(x):x;
function requireClaim(r,identity,buyerID,maxUnitPriceCents){
 const n=x=>integer(x);
 if(!r||r.source!=="coop-npc"||
    !["settling","open","filled"].includes(r.state)||
    !["claimed","finalized"].includes(r.fill_phase)||
    (r.fill_phase==="claimed"&&r.state!=="settling")||
    (r.fill_phase==="finalized"&&r.state==="settling")||r.is_corp!==true||r.bid!==false||
    !validOp(r.operation_id)||!validClaim(r.claim_key)||
    !pos(n(r.order_id))||!pos(n(r.owner_id))||!pos(n(r.station_id))||
    !pos(n(r.type_id))||!pos(n(r.source_item_id))||!pos(n(r.fill_id))||
    !pos(n(r.buyer_id))||!pos(n(r.fill_quantity))||
    !pos(n(r.remaining_before))||!pos(n(r.price_cents)))
  throw Error("NPC_PARTIAL_RUST_CLAIM_UNVERIFIED");
 const qty=n(r.fill_quantity),remaining=n(r.remaining_before),unit=n(r.price_cents),fillID=n(r.fill_id);
 if(!Number.isSafeInteger(remaining-qty)||qty>remaining||qty>50000||
    unit>100000000||unit>maxUnitPriceCents||!pos(fillID))
  throw Error("NPC_PARTIAL_RUST_QUANTITY_OR_PRICE_INVALID");
 if(r.operation_id!==identity.operationID||r.claim_key!==identity.claimKey||
    n(r.order_id)!==identity.orderID||n(r.owner_id)!==identity.ownerID||
    n(r.station_id)!==identity.stationID||n(r.type_id)!==identity.typeID||
    n(r.source_item_id)!==identity.itemID||
    n(r.buyer_id)!==buyerID||qty!==identity.quantity)
  throw Error("NPC_PARTIAL_RUST_CLAIM_IDENTITY_CHANGED");
 const gross=unit*qty;
 if(!pos(gross)||gross>100000000000)
  throw Error("NPC_PARTIAL_GROSS_OVERFLOW");
 return {quantity:qty,remainingBefore:remaining,remainingAfter:remaining-qty,
  unitPriceCents:unit,fillID,grossCents:gross};
}
function createNpcPartialSettlement({gameStore,market,verifyBuyerSession,verifyNpcCorporation,
 clock=()=>Date.now()}={}){
 if(typeof gameStore?.transact!=="function"||
    ["claimPartialOnce","finalizePartialOnce","inspectPartialClaim"].some(x=>typeof market?.[x]!=="function")||
    typeof verifyBuyerSession!=="function"||typeof verifyNpcCorporation!=="function"||
    typeof clock!=="function")
  throw Error("NPC_PARTIAL_NATIVE_AUTHORITIES_REQUIRED");
 const pending=new Set();
 function enabled(){return process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
  process.env.EVEJS_COOP_NATIVE_NPC_CORP_SETTLEMENT_PROOF==="1"&&
  process.env.EVEJS_COOP_NATIVE_NPC_PARTIAL_FILL==="1";}
 function atomicSettle(claim,buyerID,identity,maxPriceCents){
  const q=requireClaim(claim,identity,buyerID,maxPriceCents);
  if(verifyNpcCorporation(identity.ownerID,identity.stationID)!==true)
   throw Error("NPC_PARTIAL_CORPORATION_NOT_VERIFIED");
  const orderKey=String(identity.orderID),itemKey=String(identity.itemID),
    fillKey="fill"+SEP+q.fillID,corpKey="corporations"+SEP+identity.ownerID;
  return gameStore.transact(TABLES,tx=>{
   const existing=tx.get("npcMarketFills",fillKey);
   if(existing){
    if(existing.phase!=="NATIVE_PARTIAL_COMMITTED"||existing.fillID!==q.fillID||
       existing.claimKey!==identity.claimKey||existing.orderID!==identity.orderID||
       existing.buyerID!==buyerID||existing.sourceItemID!==identity.itemID||
       existing.ownerID!==identity.ownerID||existing.quantity!==identity.quantity||
       existing.grossCents!==q.grossCents||existing.remainingAfter!==q.remainingAfter)
      throw Error("NPC_PARTIAL_FILL_REPLAY_CONFLICT");
    const item=tx.get("items",String(existing.buyerItemID));
    if(!item||item.itemID!==existing.buyerItemID||
       item.ownerID!==buyerID||item.typeID!==identity.typeID||
       item.locationID!==identity.stationID||item.quantity!==identity.quantity||
       item.stacksize!==identity.quantity)
      throw Error("NPC_PARTIAL_REPLAY_DELIVERY_MISSING");
    return {status:"ALREADY_NATIVE_PARTIAL_COMMITTED",fillID:q.fillID,
     buyerItemID:existing.buyerItemID,quantity:q.quantity,
     remainingQuantity:q.remainingAfter,grossCents:q.grossCents};
   }
   if(claim.fill_phase!=="claimed"||claim.state!=="settling")
    throw Error("NPC_PARTIAL_RUST_FINALIZED_WITHOUT_NATIVE_RECEIPT");
   const escrow=tx.get("marketEscrow",orderKey),
     source=tx.get("items",itemKey),
     character=tx.get("characters",String(buyerID)),
     corp=tx.get("corporationRuntime",corpKey);
   if(!escrow||escrow.escrowType!=="sell"||escrow.isCorp!==true||
      escrow.ownerId!==identity.ownerID||escrow.stationId!==identity.stationID||
      escrow.sourceItemID!==identity.itemID||escrow.coopOperationID!==identity.operationID||
      escrow.typeId!==identity.typeID||
      escrow.escrowLocationID!==ESCROW_BASE+identity.orderID||
      escrow.remainingQuantity!==q.remainingBefore)
    throw Error("NPC_PARTIAL_ESCROW_CUSTODY_CONFLICT");
   if(!source||source.itemID!==identity.itemID||source.ownerID!==identity.ownerID||
      source.locationID!==ESCROW_BASE+identity.orderID||
      source.typeID!==identity.typeID||source.flagID!==4||source.singleton!==0||
      source.quantity!==q.remainingBefore||source.stacksize!==q.remainingBefore||
      !/^coop-industry:v1:[0-9]+$/.test(String(source.customInfo||"")))
    throw Error("NPC_PARTIAL_SOURCE_ITEM_CONFLICT");
   const division=corp?.wallet?.divisions?.["1000"];
   if(corp?.corporationID!==identity.ownerID||!division||
      cents(division.balance)===null||!Array.isArray(division.journal)||
      !Array.isArray(division.transactions)||!character||
      Number(character.characterID??character.charID)!==buyerID||
      cents(character.balance)===null||!Array.isArray(character.walletJournal)||
      !Array.isArray(character.marketTransactions))
    throw Error("NPC_PARTIAL_WALLET_AUTHORITY_INVALID");
   const buyerBefore=cents(character.balance),corpBefore=cents(division.balance),
    buyerAfter=buyerBefore-q.grossCents,corpAfter=corpBefore+q.grossCents;
   if(buyerAfter<0)throw Error("NPC_PARTIAL_BUYER_INSUFFICIENT_ISK");
   if(!Number.isSafeInteger(corpAfter)||!Number.isSafeInteger(buyerAfter))
    throw Error("NPC_PARTIAL_WALLET_OVERFLOW");
   if(character.walletJournal.some(x=>x.transactionID===q.fillID)||
      division.journal.some(x=>x.transactionID===q.fillID)||
      division.transactions.some(x=>x.transactionID===q.fillID))
    throw Error("NPC_PARTIAL_WALLET_RECEIPT_COLLISION");
   // The last fill moves the existing source item, while a strict partial
   // fill uses the persisted native identity allocator under this transaction.
   const finalFill=q.remainingAfter===0;
   let buyerItemID=identity.itemID;
   if(!finalFill){
    const counter=tx.get("identityState","nextItemID");
    if(!pos(counter)||counter<ITEM_FLOOR)
     throw Error("NPC_PARTIAL_ITEM_ALLOCATOR_MISSING");
    let maxID=ITEM_FLOOR-1;
    for(const row of tx.scan("items")){
     if(!pos(row.value?.itemID)||String(row.value.itemID)!==row.key)
      throw Error("NPC_PARTIAL_ITEM_KEY_MISMATCH");
     maxID=Math.max(maxID,row.value.itemID);
    }
    buyerItemID=Math.max(counter,maxID+1,ITEM_FLOOR);
    if(!pos(buyerItemID)||!pos(buyerItemID+1)||
       tx.get("items",String(buyerItemID)))
     throw Error("NPC_PARTIAL_NEW_ITEM_ID_UNSAFE");
   }
   const time=clock();
   if(!pos(time))throw Error("NPC_PARTIAL_NATIVE_CLOCK_INVALID");
   const filetime=String(BigInt(time)*10000n+116444736000000000n);
   const journalBase={transactionID:q.fillID,transactionDate:filetime,
    referenceID:identity.orderID,entryTypeID:10,
    ownerID1:buyerID,ownerID2:identity.ownerID,accountKey:1000,currency:1,
    sortValue:1,description:"Native NPC partial market fill "+orderKey};
   const characterNext={...character,balance:isk(buyerAfter),
    balanceChange:isk(-q.grossCents),
    walletJournal:[{...journalBase,amount:isk(-q.grossCents),balance:isk(buyerAfter)},
     ...character.walletJournal].slice(0,100),
    marketTransactions:[{transactionID:q.fillID,transactionDate:filetime,
     typeID:identity.typeID,quantity:q.quantity,price:isk(q.unitPriceCents),
     stationID:identity.stationID,locationID:identity.stationID,
     buyerID,sellerID:identity.ownerID,clientID:identity.ownerID,
     accountID:1000,buyerAccountID:1000,sellerAccountID:1000,
     journalRefID:q.fillID},...character.marketTransactions].slice(0,2000)};
   const corpEntry={...journalBase,amount:isk(q.grossCents),balance:isk(corpAfter)};
   const corpNext={...corp,wallet:{...corp.wallet,divisions:{
    ...corp.wallet.divisions,"1000":{...division,balance:isk(corpAfter),
     journal:[...division.journal,corpEntry].slice(-100),
     transactions:[...division.transactions,corpEntry].slice(-2000)}}}};
   const buyerItem={...source,itemID:buyerItemID,ownerID:buyerID,
    locationID:identity.stationID,flagID:4,quantity:q.quantity,stacksize:q.quantity};
   const escrowItem={...source,quantity:q.remainingAfter,stacksize:q.remainingAfter};
   const escrowNext={...escrow,remainingQuantity:q.remainingAfter};
   const receipt={phase:"NATIVE_PARTIAL_COMMITTED",claimKey:identity.claimKey,
    fillID:q.fillID,orderID:identity.orderID,operationID:identity.operationID,
    buyerID,ownerID:identity.ownerID,stationID:identity.stationID,
    typeID:identity.typeID,sourceItemID:identity.itemID,buyerItemID,
    quantity:q.quantity,unitPriceCents:q.unitPriceCents,grossCents:q.grossCents,
    remainingBefore:q.remainingBefore,remainingAfter:q.remainingAfter,
    buyerBeforeCents:buyerBefore,buyerAfterCents:buyerAfter,
    corpBeforeCents:corpBefore,corpAfterCents:corpAfter,committedAt:time};
   // Same SQLite BEGIN IMMEDIATE transaction across all six native tables.
   if(finalFill){
    tx.put("items",itemKey,buyerItem);
    tx.del("marketEscrow",orderKey);
   }else{
    tx.put("items",itemKey,escrowItem);
    tx.put("items",String(buyerItemID),buyerItem);
    tx.put("identityState","nextItemID",buyerItemID+1);
    tx.put("marketEscrow",orderKey,escrowNext);
   }
   tx.put("characters",String(buyerID),characterNext);
   tx.put("corporationRuntime",corpKey,corpNext);
   tx.put("npcMarketFills",fillKey,receipt);
   return {status:"NATIVE_PARTIAL_COMMITTED",fillID:q.fillID,buyerItemID,
    quantity:q.quantity,remainingQuantity:q.remainingAfter,grossCents:q.grossCents};
  });
 }
 async function purchaseOnce({buyerID,identity,maxPriceCents}={}){
  if(!enabled())return {status:"BLOCKED",error:"NPC_PARTIAL_DISABLED"};
  if(!pos(buyerID)||!identity||!validOp(identity.operationID)||
     !validClaim(identity.claimKey)||!pos(maxPriceCents)||
     [identity.orderID,identity.ownerID,identity.stationID,identity.typeID,
      identity.itemID,identity.quantity].some(x=>!pos(x))||
     identity.quantity>50000)
   return {status:"BLOCKED",error:"NPC_PARTIAL_REQUEST_INVALID"};
  if(verifyBuyerSession(buyerID,identity.stationID)!==true)
   return {status:"BLOCKED",error:"NPC_PARTIAL_BUYER_SESSION_UNVERIFIED"};
  const lock=identity.orderID;
  if(pending.has(lock))return {status:"BLOCKED",error:"NPC_PARTIAL_ORDER_BUSY"};
  pending.add(lock);
  try{
   const claim=await market.claimPartialOnce({buyerID,orderID:identity.orderID,
    operationID:identity.operationID,claimKey:identity.claimKey,
    quantity:identity.quantity});
   const result=atomicSettle(claim,buyerID,identity,maxPriceCents);
   const final=await market.finalizePartialOnce({buyerID,orderID:identity.orderID,
    operationID:identity.operationID,claimKey:identity.claimKey,
    fillID:result.fillID,quantity:identity.quantity});
   if(!final||!["open","filled"].includes(final.state)||
      final.fill_phase!=="finalized"||
      Number(final.fill_id)!==result.fillID||
      Number(final.remaining_after)!==result.remainingQuantity)
    throw Error("NPC_PARTIAL_RUST_FINALIZE_UNCERTAIN");
   const observed=await market.inspectPartialClaim({claimKey:identity.claimKey,
    operationID:identity.operationID});
   if(!observed||observed.fill_phase!=="finalized"||
      Number(observed.fill_id)!==result.fillID||
      Number(observed.remaining_after)!==result.remainingQuantity)
    throw Error("NPC_PARTIAL_RUST_INSPECT_UNCERTAIN");
   return {...result,status:"PURCHASED_PARTIAL"};
  }finally{pending.delete(lock)}
 }
 return Object.freeze({atomicSettle,purchaseOnce,
  mode:"RUST_CLAIMED_NATIVE_PARTIAL",supportsLiveSettlement:false});
}
module.exports={TABLES,createNpcPartialSettlement};
