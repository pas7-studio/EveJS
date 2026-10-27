"use strict";
/**
 * LW-04E. MANUAL original GameStore atomic NPC corp warehouse procurement.
 * No new source of ISK, items, IDs, player sessions or periodic AI scheduler.
 * Only an entire unmerged warehouse ore ItemStore row can change owner.
 * The native GameStore single writer makes custody, two wallets and immutable
 * transfer receipt one transaction, with idempotency keyed by source cargoID.
 */
const SEP="\u001f";
const TABLES=Object.freeze(["items","corporationRuntime"]);
const POS=x=>Number.isSafeInteger(x)&&x>0;
const NN=x=>Number.isSafeInteger(x)&&x>=0;
const KEY=cargoID=>"coopWarehouseTitleTransfer"+SEP+cargoID;
const CORP=id=>"corporations"+SEP+id;
const OP=(cargoID,buyerID)=>"coop-warehouse-title:v1:"+cargoID+":"+buyerID;
const cents=x=>{
 if(typeof x!=="number"||!Number.isFinite(x)||x<0)return null;
 const n=Math.round(x*100);
 return Number.isSafeInteger(n)&&Math.abs(n-x*100)<1e-7?n:null;
};
const isk=x=>x/100;
const blocked=(reason,op)=>({status:"BLOCKED",reason,operationID:op,nativeMutation:false});
function createOriginalWarehouseTitleTransfer({
 gameStore,itemStore,verifySourceGrant,verifyNpcOwner,
 verifyStation,authorizeTransfer,quoteTransfer,clock=()=>Date.now(),
 env=process.env
}={}){
 if(gameStore?.coopAtomicNativeRows?.mode!=="SERVER_INTERNAL_FLAGGED"||
    typeof gameStore.coopAtomicNativeRows.transact!=="function"||
    typeof gameStore.coopAtomicNativeRows.isPoisoned!=="function"||
    typeof itemStore?.findItemById!=="function"||
    [verifySourceGrant,verifyNpcOwner,verifyStation,
     authorizeTransfer,quoteTransfer,clock].some(fn=>typeof fn!=="function"))
  throw Error("LW04E_ORIGINAL_SINGLE_WRITER_AND_TRUSTED_GRANTS_REQUIRED");
 const busy=new Set(),held=new Set();
 function gate(){
  return env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
   env.EVEJS_COOP_NATIVE_WAREHOUSE_TITLE_TRANSFER_PROOF==="1"&&
   env.EVEJS_COOP_NATIVE_NPC_CORP_TRANSFER_PAYMENT_PROOF==="1"&&
   env.EVEJS_COOP_ALIFE_ECONOMY_ACT!=="1"&&
   env.EVEJS_COOP_NATIVE_NPC_MARKET!=="1"&&
   env.EVEJS_COOP_NATIVE_NPC_ECONOMY_SCHEDULER!=="1";
 }
 function ownedOriginal(item,who,station,type,quantity,cargoID){
  return item?.itemID>0&&POS(item.itemID)&&item.ownerID===who&&
    item.locationID===station&&item.flagID===4&&item.singleton===0&&
    item.typeID===type&&item.quantity===quantity&&
    item.stacksize===quantity&&
    item.customInfo==="coop-warehouse:v1:cargo:"+cargoID;
 }
 function receipts(corp,ownerID,transactionID,amountCents,afterCents,otherOwner){
  const rows=corp?.wallet?.divisions?.["1000"];
  if(corp?.corporationID!==ownerID||!Array.isArray(rows?.transactions)||
      !Array.isArray(rows?.journal)||cents(rows.balance)===null)
   return false;
  const match=x=>x?.transactionID===transactionID;
  const tx=rows.transactions.filter(match),journal=rows.journal.filter(match);
  return tx.length===1&&journal.length===1&&
   [tx[0],journal[0]].every(x=>x.referenceID===transactionID&&
    x.ownerID1===ownerID&&x.ownerID2===otherOwner&&
    cents(Math.abs(x.amount))===Math.abs(amountCents)&&
    (amountCents<0?x.amount<0:x.amount>0)&&
    cents(x.balance)===afterCents&&x.accountKey===1000);
 }
 function once({cargoID,oreItemID,sourceOwnerID,buyerOwnerID,
  stationID,typeID,quantity,maxPriceCents,operatorGrant}={}){
  const operationID=OP(cargoID,buyerOwnerID);
  if(![cargoID,oreItemID,sourceOwnerID,buyerOwnerID,stationID,
       typeID,quantity,maxPriceCents].every(POS)||
      sourceOwnerID===buyerOwnerID||quantity>1000000000||
      maxPriceCents>100000000000)
   return blocked("LW04E_ORIGINAL_TRANSFER_SCOPE_INVALID",operationID);
  if(!gate())return blocked("LW04E_ORIGINAL_TRANSFER_DISABLED",operationID);
  if(busy.has(cargoID)||held.has(cargoID))
   return blocked(held.has(cargoID)?"LW04E_OPERATOR_REPAIR_REQUIRED":
     "LW04E_SOURCE_CARGO_BUSY",operationID);
  busy.add(cargoID);
  let issuedNativeWrite=false;
  try{
   if(gameStore.coopAtomicNativeRows.isPoisoned())
    return blocked("LW04E_ORIGINAL_GAMESTORE_POISONED",operationID);
   // Grants and price are server-owned synchronous authorities. Never accept
   // a client-supplied price, anonymous grant, or implicit free item transfer.
   if(verifyNpcOwner(sourceOwnerID)!==true||
      verifyNpcOwner(buyerOwnerID)!==true||
      verifyStation({stationID,sourceOwnerID,buyerOwnerID})!==true||
      authorizeTransfer({operatorGrant,sourceOwnerID,buyerOwnerID,
       cargoID,oreItemID,stationID,quantity})!==true)
    return blocked("LW04E_UNAUTHORIZED_OR_NON_NPC_TRANSFER",operationID);
   const grant=verifySourceGrant({cargoID,stationID,sourceOwnerID,
    oreItemID,typeID,quantity});
   if(grant?.phase!=="COMPLETED"||grant.cargoID!==cargoID||
      grant.ownerID!==sourceOwnerID||grant.stationID!==stationID||
      grant.typeID!==typeID||grant.quantity!==quantity||
      grant.oreItemID!==oreItemID||
      grant.sourceCustomInfo!=="coop-warehouse:v1:cargo:"+cargoID||
      !POS(grant.completedAt)||
      !NN(grant.before)||grant.after-grant.before!==quantity)
    return blocked("LW04E_NATIVE_STATION_GRANT_NOT_ATTESTED",operationID);
   const quote=quoteTransfer({cargoID,oreItemID,sourceOwnerID,
    buyerOwnerID,stationID,typeID,quantity});
   if(quote?.verifiedNative!==true||quote.operationID!==operationID||
      quote.ownerID!==sourceOwnerID||quote.buyerOwnerID!==buyerOwnerID||
      quote.stationID!==stationID||quote.itemID!==oreItemID||
      quote.typeID!==typeID||quote.quantity!==quantity||
      !POS(quote.priceCents)||quote.priceCents>maxPriceCents||
      !Number.isSafeInteger(quote.priceCents)||
      quote.priceCents>100000000000)
    return blocked("LW04E_ORIGINAL_CORPORATE_PRICE_UNVERIFIED",operationID);
   // The preimage is checked INSIDE the native GameStore transaction.
   // An already committed transfer has changed the owner and may already
   // have been refined; a preflight against the OLD owner would incorrectly
   // deny idempotent replay after restart. Never pre-read as a substitute
   // for transactional source CAS.
   const now=clock();
   if(!POS(now))return blocked("LW04E_ORIGINAL_CLOCK_UNVERIFIED",operationID);
   issuedNativeWrite=true;
   const receipt=gameStore.coopAtomicNativeRows.transact(TABLES,tx=>{
    const previous=tx.get("corporationRuntime",KEY(cargoID));
    if(previous){
     if(previous.version!==1||previous.phase!=="COMMITTED"||
        previous.operationID!==operationID||previous.cargoID!==cargoID||
        previous.itemID!==oreItemID||previous.typeID!==typeID||
        previous.stationID!==stationID||previous.quantity!==quantity||
        previous.sourceOwnerID!==sourceOwnerID||
        previous.buyerOwnerID!==buyerOwnerID||
        previous.priceCents!==quote.priceCents||
        !POS(previous.committedAt))
      throw Error("LW04E_PREVIOUS_TRANSFER_CONFLICT");
     const seller=tx.get("corporationRuntime",CORP(sourceOwnerID));
     const buyer=tx.get("corporationRuntime",CORP(buyerOwnerID));
     if(!receipts(seller,sourceOwnerID,operationID,
          quote.priceCents,previous.sellerAfterCents,buyerOwnerID)||
        !receipts(buyer,buyerOwnerID,operationID,
          -quote.priceCents,previous.buyerAfterCents,sourceOwnerID))
      throw Error("LW04E_PRIOR_WALLET_RECEIPTS_CHANGED");
     // A previously transferred ore item might have been REFINED.
     // Never mint or reassign an item on an idempotent receipt replay.
     return {status:"ALREADY_TRANSFERRED",receipt:previous};
    }
    const item=tx.get("items",String(oreItemID));
    if(!ownedOriginal(item,sourceOwnerID,stationID,typeID,quantity,cargoID))
     throw Error("LW04E_ORIGINAL_ITEM_CUSTODY_CHANGED");
    if(tx.scan("items").filter(x=>x.value?.customInfo===
       "coop-warehouse:v1:cargo:"+cargoID).length!==1)
     throw Error("LW04E_ORIGINAL_CARGO_PROVENANCE_NOT_UNIQUE");
    const seller=tx.get("corporationRuntime",CORP(sourceOwnerID));
    const buyer=tx.get("corporationRuntime",CORP(buyerOwnerID));
    const src=seller?.wallet?.divisions?.["1000"],
      dst=buyer?.wallet?.divisions?.["1000"];
    if(seller?.corporationID!==sourceOwnerID||
       buyer?.corporationID!==buyerOwnerID||
       !Array.isArray(src?.journal)||!Array.isArray(src?.transactions)||
       !Array.isArray(dst?.journal)||!Array.isArray(dst?.transactions))
     throw Error("LW04E_ORIGINAL_CORPORATION_WALLETS_UNAVAILABLE");
    const beforeSeller=cents(src.balance),beforeBuyer=cents(dst.balance);
    if(beforeSeller===null||beforeBuyer===null||
       beforeBuyer<quote.priceCents||
       !Number.isSafeInteger(beforeSeller+quote.priceCents))
     throw Error("LW04E_NATIVE_BUYER_INSUFFICIENT_ISK");
    for(const w of [src,dst]){
     if(w.transactions.some(x=>x.transactionID===operationID)||
        w.journal.some(x=>x.transactionID===operationID))
      throw Error("LW04E_NATIVE_WALLET_TRANSACTION_ID_COLLISION");
    }
    const sellerAfter=beforeSeller+quote.priceCents;
    const buyerAfter=beforeBuyer-quote.priceCents;
    const entry=(self,other,amountCents,afterCents)=>({
     transactionID:operationID,referenceID:operationID,
     ownerID1:self,ownerID2:other,accountKey:1000,
     entryTypeID:10,currency:1,sortValue:1,
     amount:isk(amountCents),balance:isk(afterCents),
     description:"Native NPC station ore procurement "+cargoID,
     transactionDate:String(BigInt(now)*10000n+116444736000000000n)
    });
    const paidSeller=entry(sourceOwnerID,buyerOwnerID,quote.priceCents,sellerAfter);
    const paidBuyer=entry(buyerOwnerID,sourceOwnerID,-quote.priceCents,buyerAfter);
    src.balance=isk(sellerAfter);dst.balance=isk(buyerAfter);
    src.journal=[...src.journal,paidSeller].slice(-100);
    src.transactions=[...src.transactions,paidSeller].slice(-2000);
    dst.journal=[...dst.journal,paidBuyer].slice(-100);
    dst.transactions=[...dst.transactions,paidBuyer].slice(-2000);
    const record={version:1,phase:"COMMITTED",operationID,cargoID,
     itemID:oreItemID,typeID,quantity,stationID,
     sourceOwnerID,buyerOwnerID,priceCents:quote.priceCents,
     sellerBeforeCents:beforeSeller,sellerAfterCents:sellerAfter,
     buyerBeforeCents:beforeBuyer,buyerAfterCents:buyerAfter,
     sourceCustomInfo:item.customInfo,committedAt:now};
    tx.put("items",String(oreItemID),{...item,ownerID:buyerOwnerID});
    tx.put("corporationRuntime",CORP(sourceOwnerID),seller);
    tx.put("corporationRuntime",CORP(buyerOwnerID),buyer);
    tx.put("corporationRuntime",KEY(cargoID),record);
    return {status:"TITLE_TRANSFERRED",receipt:record};
   });
   if(receipt?.status!=="TITLE_TRANSFERRED"&&
      receipt?.status!=="ALREADY_TRANSFERRED")
    throw Error("LW04E_NATIVE_TRANSACTION_OUTCOME_UNKNOWN");
   return {...receipt,operationID,cargoID,ownerID:buyerOwnerID,
    originalItemID:oreItemID,nativeMutation:receipt.status==="TITLE_TRANSFERRED",
    originalGameStoreAtomic:true};
  }catch(error){
   // No unsafe retry after the native SQLite transaction may have reached
   // COMMIT, even if the GameStore cache is poisoned or the ACK is lost.
   if(issuedNativeWrite)held.add(cargoID);
   return blocked("LW04E_NATIVE_CUSTODY_OR_COMMIT_UNCERTAIN:"+
    String(error?.message||error).slice(0,110),operationID);
  }finally{busy.delete(cargoID)}
 }
 return Object.freeze({transferOnce:once,
  mode:"MANUAL_ORIGINAL_GAMESTORE_WAREHOUSE_TITLE_ONLY",
  supportsLiveRuntime:false,supportsAutomaticAlife:false,
  requiresOperatorReconciliation:()=>[...held],
  tables:TABLES});
}
module.exports={createOriginalWarehouseTitleTransfer,TABLES};
