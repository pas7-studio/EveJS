"use strict";
// COOP-048: native NPC corporation buys ONE verified full remaining player ask.
// Rust claims the order; one GameStore transaction transfers real item + ISK.
// Manual, default OFF, never schedules itself or impersonates a player session.
const TABLES=Object.freeze(["corporationRuntime","characters","items","marketEscrow","npcMarketFills"]);
const SEP="\u001f",ESCROW_BASE=9200000000;
const pos=x=>Number.isSafeInteger(x)&&x>0;
const nonneg=x=>Number.isSafeInteger(x)&&x>=0;
const validKey=x=>typeof x==="string"&&/^npc-corpbuy:[0-9a-f]{32}$/.test(x);
const toInt=x=>typeof x==="string"&&/^(0|[1-9][0-9]*)$/.test(x)?Number(x):x;
// Native wallets must already be canonical to the cent. Rounding an
// existing balance during an atomic buy silently destroys or invents ISK.
const cents=x=>{
 if(typeof x!=="number"||!Number.isFinite(x)||x<0)return null;
 const scaled=x*100,whole=Math.round(scaled);
 return Number.isSafeInteger(whole)&&Math.abs(scaled-whole)<=1e-6?
  whole:null;
};
const isk=x=>x/100;
function createNpcCorporateBuyer({gameStore,market,verifyBuyerCorporation,verifyPlayerSeller,
 quoteSellerTax,clock=()=>Date.now()}={}){
 if(typeof gameStore?.transact!=="function"||
  ["claimOnce","finalizeOnce","inspectClaim"].some(x=>typeof market?.[x]!=="function")||
  [verifyBuyerCorporation,verifyPlayerSeller,quoteSellerTax,clock].some(x=>typeof x!=="function"))
  throw Error("NPC_CORP_BUY_NATIVE_AUTHORITIES_REQUIRED");
 const busy=new Set();
 function enabled(){return process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
   process.env.EVEJS_COOP_NPC_BUY_PLAYER_ASK==="1";}
 function validateClaim(claim,request){
  const n=toInt;
  if(!claim||claim.source!=="player"||
     !((claim.state==="settling"&&claim.fill_phase==="claimed")||
       (claim.state==="filled"&&claim.fill_phase==="finalized"))||
     claim.is_corp!==false||
     claim.bid!==false||claim.claim_key!==request.claimKey||
     !pos(n(claim.fill_id))||!pos(n(claim.order_id))||
     !pos(n(claim.owner_id))||!pos(n(claim.buyer_corp_id))||
     !pos(n(claim.station_id))||!pos(n(claim.type_id))||
     !pos(n(claim.quantity))||!pos(n(claim.price_cents)))
   throw Error("NPC_CORP_BUY_RUST_CLAIM_UNVERIFIED");
  const fillID=n(claim.fill_id),sellerID=n(claim.owner_id),
   quantity=n(claim.quantity),priceCents=n(claim.price_cents);
  if(n(claim.order_id)!==request.orderID||sellerID!==request.sellerID||
     n(claim.buyer_corp_id)!==request.buyerCorpID||
     n(claim.station_id)!==request.stationID||
     n(claim.type_id)!==request.typeID||quantity!==request.quantity||
     quantity>50000||priceCents>request.maxUnitPriceCents||
     priceCents>100000000)
   throw Error("NPC_CORP_BUY_RUST_IDENTITY_CHANGED");
  const grossCents=quantity*priceCents;
  if(!pos(grossCents)||grossCents>100000000000)
   throw Error("NPC_CORP_BUY_COST_OVERFLOW");
  return {fillID,sellerID,quantity,priceCents,grossCents};
 }
 function atomicSettle(claim,request){
  const {fillID,sellerID,quantity,priceCents,grossCents}=validateClaim(claim,request);
  if(verifyBuyerCorporation(request.buyerCorpID,request.stationID)!==true||
     verifyPlayerSeller(sellerID,request.stationID)!==true)
   throw Error("NPC_CORP_BUY_OWNER_PROOF_INVALID");
  const corpKey="corporations"+SEP+request.buyerCorpID;
  const fillKey="corp-buy"+SEP+fillID,orderKey=String(request.orderID);
  return gameStore.transact(TABLES,tx=>{
   const previous=tx.get("npcMarketFills",fillKey);
   if(previous){
    if(previous.phase!=="NATIVE_NPC_BUY_COMMITTED"||
       previous.claimKey!==request.claimKey||previous.fillID!==fillID||
       previous.orderID!==request.orderID||previous.buyerCorpID!==request.buyerCorpID||
       previous.sellerID!==sellerID||previous.stationID!==request.stationID||
       previous.typeID!==request.typeID||previous.quantity!==quantity||
       previous.priceCents!==priceCents||previous.grossCents!==grossCents||
       !nonneg(previous.taxCents)||previous.taxCents>grossCents||
       !nonneg(previous.netCents)||
       previous.netCents!==grossCents-previous.taxCents||
       previous.taxPolicy!=="EVEJS_NATIVE_MARKET_RULES"||
       !pos(previous.itemID)||
       // A replay is only proof of a settled purchase when the original
       // native buyer debit and seller net credit conserve exact ISK cents.
       // Current wallets may have changed since settlement; verify receipt
       // pre/post witnesses, never charge or move the item again.
       !nonneg(previous.buyerBeforeCents)||
       !nonneg(previous.buyerAfterCents)||
       !nonneg(previous.sellerBeforeCents)||
       !nonneg(previous.sellerAfterCents)||
       previous.buyerBeforeCents<grossCents||
       previous.buyerAfterCents!==previous.buyerBeforeCents-grossCents||
       !nonneg(previous.sellerBeforeCents+grossCents)||
       previous.sellerAfterCents!==previous.sellerBeforeCents+previous.netCents||
       previous.taxTransactionID!==(previous.taxCents>0?
        fillID+100000000000000:null)||
       !pos(previous.committedAt))
     throw Error("NPC_CORP_BUY_RECEIPT_REPLAY_CONFLICT");
    // A valid committed receipt remains valid if a later consumer used the
    // purchased goods. Never replay wallets or reissue a physical item.
    return {status:"ALREADY_NATIVE_COMMITTED",fillID,
     itemID:previous.itemID,quantity,grossCents};
   }
   if(claim.state!=="settling"||claim.fill_phase!=="claimed")
    throw Error("NPC_CORP_BUY_RUST_FINALIZED_WITHOUT_GAMESTORE_RECEIPT");
   const escrow=tx.get("marketEscrow",orderKey),
    corporation=tx.get("corporationRuntime",corpKey),
    seller=tx.get("characters",String(sellerID));
   if(!escrow||String(escrow.orderId)!==orderKey||
      escrow.escrowType!=="sell"||escrow.isCorp!==false||
      escrow.ownerId!==sellerID||escrow.stationId!==request.stationID||
      escrow.typeId!==request.typeID||escrow.remainingQuantity!==quantity||
      escrow.escrowLocationID!==ESCROW_BASE+request.orderID)
    throw Error("NPC_CORP_BUY_ESCROW_SCOPE_INVALID");
   // Stock player escrow can contain more than one stack. This first release
   // safely supports ONE exact source stack; complex cases fail closed.
   const matched=tx.scan("items").filter(({key,value})=>
    value?.ownerID===sellerID&&value.locationID===escrow.escrowLocationID&&
    value.flagID===4);
   if(matched.length!==1)throw Error("NPC_CORP_BUY_SINGLE_ESCROW_STACK_REQUIRED");
   const {key:itemKey,value:item}=matched[0];
   if(String(item.itemID)!==itemKey||item.typeID!==request.typeID||
      item.singleton!==0||item.quantity!==quantity||item.stacksize!==quantity||
      !pos(item.itemID)||!pos(item.categoryID)||item.categoryID===9)
    throw Error("NPC_CORP_BUY_PHYSICAL_STACK_UNVERIFIED");
   const division=corporation?.wallet?.divisions?.["1000"];
   // Pinned native EveJS stores character rows by key. No embedded
   // characterID is guaranteed, so bind identity to the original keyed
   // GameStore read plus the Rust claim and verified physical escrow.
   // If the row DOES contain an embedded ID, it must agree exactly.
   const sellerEmbedded=seller?.characterID??seller?.charID;
   if(corporation?.corporationID!==request.buyerCorpID||!division||
     !Array.isArray(division.journal)||!Array.isArray(division.transactions)||
     cents(division.balance)===null||!seller||
     (sellerEmbedded!==undefined&&sellerEmbedded!==null&&
      Number(sellerEmbedded)!==sellerID)||
     cents(seller.balance)===null||
     !Array.isArray(seller.walletJournal)||!Array.isArray(seller.marketTransactions))
    throw Error("NPC_CORP_BUY_NATIVE_WALLET_INVALID");
   const buyerBefore=cents(division.balance),sellerBefore=cents(seller.balance);
   // Quote exactly the seller's real marketRules context, not an NPC flat tax.
   // Both gross credit and transaction tax debit commit in this same SQLite tx.
   const tax=quoteSellerTax({sellerID,stationID:request.stationID,grossCents});
   const taxCents=tax?.taxCents,netCents=grossCents-taxCents;
   if(tax?.policy!=="EVEJS_NATIVE_MARKET_RULES"||
      tax.sellerID!==sellerID||tax.stationID!==request.stationID||
      tax.grossCents!==grossCents||!nonneg(taxCents)||
      taxCents>grossCents||!nonneg(netCents))
    throw Error("NPC_CORP_BUY_NATIVE_SELLER_TAX_UNVERIFIED");
   const buyerAfter=buyerBefore-grossCents,sellerGross=sellerBefore+grossCents,
    sellerAfter=sellerGross-taxCents;
   if(buyerAfter<request.minReserveCents)
    throw Error("NPC_CORP_BUY_ISK_RESERVE_OR_FUNDS_EXCEEDED");
   if(!nonneg(buyerAfter)||!nonneg(sellerGross)||!nonneg(sellerAfter))
    throw Error("NPC_CORP_BUY_WALLET_OVERFLOW");
   // The tax gets its own stable ledger ID, distinct from the gross fill.
   const taxTransactionID=fillID+100000000000000;
   if(!pos(taxTransactionID)||
      division.transactions.some(r=>r?.transactionID===fillID)||
      division.journal.some(r=>r?.transactionID===fillID)||
      seller.walletJournal.some(r=>[fillID,taxTransactionID].includes(r?.transactionID)))
    throw Error("NPC_CORP_BUY_WALLET_TRANSACTION_COLLISION");
   const at=clock();if(!pos(at))throw Error("NPC_CORP_BUY_CLOCK_INVALID");
   const filetime=String(BigInt(at)*10000n+116444736000000000n);
   const base={transactionID:fillID,transactionDate:filetime,
    referenceID:request.orderID,entryTypeID:2,accountKey:1000,currency:1,
    sortValue:1,ownerID1:request.buyerCorpID,ownerID2:sellerID,
    description:"Native NPC corporation purchase "+orderKey};
   const debit={...base,amount:isk(-grossCents),balance:isk(buyerAfter)};
   const credit={...base,entryTypeID:2,amount:isk(grossCents),
    balance:isk(sellerGross)};
   const taxDebit={...base,transactionID:taxTransactionID,
    entryTypeID:54,amount:isk(-taxCents),balance:isk(sellerAfter),
    ownerID1:request.stationID,ownerID2:sellerID,
    description:"Transaction tax for native NPC market sale "+orderKey};
   const corpNext={...corporation,wallet:{...corporation.wallet,divisions:{
    ...corporation.wallet.divisions,"1000":{...division,balance:isk(buyerAfter),
     journal:[...division.journal,debit].slice(-100),
     transactions:[...division.transactions,debit].slice(-2000)}}}};
   const sellerNext={...seller,balance:isk(sellerAfter),
    balanceChange:isk(netCents),
    walletJournal:[...(taxCents>0?[taxDebit]:[]),credit,
      ...seller.walletJournal].slice(0,100),
    marketTransactions:[{transactionID:fillID,transactionDate:filetime,
     typeID:request.typeID,quantity,price:isk(priceCents),
     stationID:request.stationID,locationID:request.stationID,
     buyerID:request.buyerCorpID,sellerID,clientID:request.buyerCorpID,
     accountID:1000,buyerAccountID:1000,sellerAccountID:1000,journalRefID:fillID},
      ...seller.marketTransactions].slice(0,2000)};
   const moved={...item,ownerID:request.buyerCorpID,
    locationID:request.stationID,flagID:4};
   const receipt={phase:"NATIVE_NPC_BUY_COMMITTED",claimKey:request.claimKey,
    fillID,orderID:request.orderID,buyerCorpID:request.buyerCorpID,
    sellerID,stationID:request.stationID,typeID:request.typeID,itemID:item.itemID,
    quantity,priceCents,grossCents,taxCents,netCents,
    taxPolicy:"EVEJS_NATIVE_MARKET_RULES",
    taxTransactionID:taxCents>0?taxTransactionID:null,
    buyerBeforeCents:buyerBefore,
    buyerAfterCents:buyerAfter,sellerBeforeCents:sellerBefore,
    sellerAfterCents:sellerAfter,committedAt:at};
   tx.put("corporationRuntime",corpKey,corpNext);
   tx.put("characters",String(sellerID),sellerNext);
   tx.put("items",itemKey,moved);
   tx.del("marketEscrow",orderKey);
   tx.put("npcMarketFills",fillKey,receipt);
   return {status:"NATIVE_NPC_BUY_COMMITTED",fillID,itemID:item.itemID,
    quantity,grossCents,taxCents,netCents};
  });
 }
 async function purchaseOnce(request={}){
  if(!enabled())return {status:"BLOCKED",reason:"NPC_CORP_BUY_DISABLED"};
  if(!request||!validKey(request.claimKey)||
     [request.buyerCorpID,request.sellerID,request.stationID,
      request.typeID,request.orderID,request.quantity,
      request.maxUnitPriceCents].some(x=>!pos(x))||
     request.quantity>50000||request.maxUnitPriceCents>100000000||
     !nonneg(request.minReserveCents)||request.sellerID===request.buyerCorpID)
   return {status:"BLOCKED",reason:"NPC_CORP_BUY_REQUEST_INVALID"};
  if(verifyBuyerCorporation(request.buyerCorpID,request.stationID)!==true||
     verifyPlayerSeller(request.sellerID,request.stationID)!==true)
   return {status:"BLOCKED",reason:"NPC_CORP_BUY_AUTHORITY_UNVERIFIED"};
  const lock=request.orderID;
  if(busy.has(lock))return {status:"BLOCKED",reason:"NPC_CORP_BUY_ORDER_BUSY"};
  busy.add(lock);
  try{
   const claim=await market.claimOnce({
    claimKey:request.claimKey,orderID:request.orderID,
    buyerCorpID:request.buyerCorpID,quantity:request.quantity,
    sellerID:request.sellerID});
   const result=atomicSettle(claim,request);
   const final=await market.finalizeOnce({claimKey:request.claimKey,
    orderID:request.orderID,buyerCorpID:request.buyerCorpID,fillID:result.fillID});
   if(final?.state!=="filled"||final.fill_phase!=="finalized"||
      final.history_recorded!==true||
      typeof final.history_day!=="string"||
      !/^\d{4}-\d{2}-\d{2}$/.test(final.history_day)||
      Number(final.fill_id)!==result.fillID||Number(final.vol_remaining)!==0)
    throw Error("NPC_CORP_BUY_RUST_FINALIZE_UNCERTAIN");
   const observed=await market.inspectClaim({claimKey:request.claimKey});
   if(observed?.state!=="filled"||observed.fill_phase!=="finalized"||
      observed.history_recorded!==true||
      observed.history_day!==final.history_day||
      Number(observed.fill_id)!==result.fillID||Number(observed.vol_remaining)!==0)
    throw Error("NPC_CORP_BUY_RUST_INSPECT_UNCERTAIN");
   return {...result,status:"NPC_PURCHASED_PLAYER_GOODS"};
  }finally{busy.delete(lock)}
 }
 return Object.freeze({purchaseOnce,atomicSettle,
  mode:"RUST_CLAIM_PLAYER_FULL_ESCROW",supportsLiveSettlement:false});
}
module.exports={TABLES,createNpcCorporateBuyer};
