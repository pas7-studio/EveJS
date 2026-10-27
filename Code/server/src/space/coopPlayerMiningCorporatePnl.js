"use strict";
/**
 * CH24+31 E2B7 native mining corporation P&L — source-only, read-only.
 *
 * No invented sales, price estimates, or ISK changes. An accrued SALE is
 * recognized only on a separately authenticated original Rust RELEASED
 * witness and its original GameStore wallet + physical-item receipt.
 *
 * Purchased but unsold ore is an asset at verified acquisition cost.
 * Wages are period costs. Gross cash profit and realized cost-basis P&L
 * intentionally differ when inventory remains unsold.
 */
const SEP="\u001f",OP=/^coop-mining-shift:[a-f0-9]{32}$/;
const POS=x=>Number.isSafeInteger(x)&&x>0,NONNEG=x=>Number.isSafeInteger(x)&&x>=0;
const iskCents=x=>{
 if(typeof x!=="number"||!Number.isFinite(x))return null;
 const y=x*100,n=Math.round(y);
 return Number.isSafeInteger(n)&&Math.abs(y-n)<1e-6?n:null;
};
const add=(a,b)=>{const r=a+b;if(!Number.isSafeInteger(r))throw Error("MINING_PL_OVERFLOW");return r};
const grouping=(name,id)=>name==null?"/"+id:"/"+name+(id==null?"":"/"+id);
const entryAmount=(row,id,ref,amount)=>{
 return row?.transactionID===id&&row.referenceID===ref&&
  row.accountKey===1000&&row.ownerID1!=null&&
  iskCents(row.amount)===amount;
};
function createMiningCorporatePnl({
 gameStore,access,readNativeReleased,findOriginalItemById,enabled=()=>false
}={}){
 if(typeof gameStore?.read!=="function"||typeof readNativeReleased!=="function"||
   typeof findOriginalItemById!=="function"||
  [access?.isMember,access?.canIndustry,access?.canWallet,enabled]
   .some(f=>typeof f!=="function"))
  throw Error("MINING_PL_ORIGINAL_AUTHORITIES_REQUIRED");
 const blocked=(reason)=>Object.freeze({status:"BLOCKED",reason,
  realizedRevenueCents:null,netOperatingProfitCents:null,
  cashProfitCents:null,originalWalletMutation:false});
 function read(table,group,id){
  const response=gameStore.read(table,grouping(group,id));
  if(response?.success===true&&response.data!=null)return response.data;
  if(response?.errorMsg==="ENTRY_NOT_FOUND")return null;
  throw Error("MINING_PL_GAMESTORE_READ_UNAVAILABLE");
 }
 const group=(name)=>{
  const data=read("corporationRuntime",name,null);
  if(data===null)return {};
  if(!data||typeof data!=="object"||Array.isArray(data)||
   Object.keys(data).length>30000)throw Error("MINING_PL_GROUP_INVALID");
  return data;
 };
 function walletRow(corp,id){
  return corp?.corporationID===id?corp.wallet?.divisions?.["1000"]:null;
 }
 function verifiedPeer(wallet,id,owner,other,amount,after){
  if(!wallet||!Array.isArray(wallet.journal)||!Array.isArray(wallet.transactions)||
   !NONNEG(after))return false;
  const check=row=>entryAmount(row,id,id,amount)&&
   row.ownerID1===owner&&row.ownerID2===other&&
   iskCents(row.balance)===after;
  const j=wallet.journal.filter(x=>x.transactionID===id),
    t=wallet.transactions.filter(x=>x.transactionID===id);
  return j.length===1&&t.length===1&&check(j[0])&&check(t[0]);
 }
 function verifiedFill(wallet,buyer,corp,r){
  if(!wallet||!Array.isArray(wallet.journal)||!Array.isArray(wallet.transactions)||
   !POS(r.buyerJournalID)||!POS(r.sellerJournalID)||!NONNEG(r.grossCents)||
   !NONNEG(r.netRevenueCents))return false;
  const id=r.receiptKey,find=(a,key)=>a.filter(v=>v?.transactionID===key);
  const credit=wallet.journal.filter(x=>x?.transactionID===r.sellerJournalID);
  const txn=find(wallet.transactions,r.sellerJournalID);
  const check=x=>entryAmount(x,r.sellerJournalID,id,r.grossCents)&&
   x.ownerID1===buyer&&x.ownerID2===corp;
  if(credit.length!==1||txn.length!==1||!check(credit[0])||!check(txn[0]))
   return false;
  const fee=add(r.transactionTaxCents,r.brokerFeeCents);
  if(fee===0)return r.feeJournalID===null;
  if(!POS(r.feeJournalID))return false;
  const f=wallet.journal.filter(x=>x?.transactionID===r.feeJournalID),
   ft=find(wallet.transactions,r.feeJournalID);
  const checkFee=x=>entryAmount(x,r.feeJournalID,id,-fee)&&
   x.ownerID1===buyer&&x.ownerID2===corp;
  return f.length===1&&ft.length===1&&checkFee(f[0])&&checkFee(ft[0]);
 }
 async function inspect({session,corporationID,operationID}={}){
  if(enabled()!==true)return blocked("MINING_PL_DISABLED");
  if(!POS(session?.characterID)||session.socket?.destroyed===true||
   !POS(corporationID)||session.corporationID!==corporationID||
   !OP.test(operationID||"")||
   access.isMember(session,corporationID)!==true||
   access.canIndustry(session,corporationID)!==true||
   access.canWallet(session,corporationID,1000)!==true)
   return blocked("MINING_PL_CORPORATE_AUTHORITY_DENIED");
  try{
   const shift=read("corporationRuntime","coopPlayerMiningShift",operationID);
   if(shift?.version!==1||shift.status!=="FUNDED"||
    shift.operationID!==operationID||shift.corporationID!==corporationID||
    !POS(shift.employerCorpID)||shift.employerCorpID===corporationID||
    !POS(shift.wageCents)||!NONNEG(shift.buyerAfterCents)||
    !NONNEG(shift.employerAfterCents))
    return blocked("MINING_PL_REAL_PAID_SHIFT_MISSING");
   const company=read("corporationRuntime","corporations",corporationID);
   const employer=read("corporationRuntime","corporations",shift.employerCorpID);
   const corpWallet=walletRow(company,corporationID),
    employerWallet=walletRow(employer,shift.employerCorpID);
   if(!verifiedPeer(corpWallet,operationID,corporationID,shift.employerCorpID,
      -shift.wageCents,shift.buyerAfterCents)||
      !verifiedPeer(employerWallet,operationID,shift.employerCorpID,corporationID,
      shift.wageCents,shift.employerAfterCents))
    return blocked("MINING_PL_ORIGINAL_WAGES_NOT_IN_WALLET");

   const titles=Object.values(group("coopPlayerMiningOreTitle"))
    .filter(v=>v?.shiftID===operationID);
   if(titles.length>500)return blocked("MINING_PL_TOO_MANY_CARGO_ITEMS");
   const sales=group("coopPlayerMiningCorpSell"),
     fills=group("coopPlayerMiningCorpFill");
   let orePurchases=0,realizedGross=0,fees=0,netRevenue=0,
     realizedCost=0,inventoryCost=0,soldUnits=0,unsoldUnits=0;
   const usedCargo=new Set(),usedOrders=new Set(),
     accountedFills=new Set(),cargo=[];
   for(const title of titles){
    const id=title?.cargoID;
    if(title.version!==1||title.status!=="COMMITTED"||
     title.shiftID!==operationID||!POS(id)||usedCargo.has(id)||
     title.operationID!=="coop-mining-ore-title:v1:"+operationID+":"+id||
     title.buyerCorpID!==corporationID||
     title.sourceCorpID!==shift.employerCorpID||
     !POS(title.itemID)||!POS(title.typeID)||!POS(title.stationID)||
     !POS(title.quantity)||!POS(title.priceCents)||
     !NONNEG(title.buyerAfterCents)||!NONNEG(title.sourceAfterCents))
     return blocked("MINING_PL_ORIGINAL_CARGO_TITLE_INVALID");
    if(!verifiedPeer(corpWallet,title.operationID,corporationID,shift.employerCorpID,
         -title.priceCents,title.buyerAfterCents)||
       !verifiedPeer(employerWallet,title.operationID,shift.employerCorpID,corporationID,
         title.priceCents,title.sourceAfterCents))
     return blocked("MINING_PL_ORIGINAL_ORE_PAYMENT_NOT_VERIFIED");
    usedCargo.add(id);orePurchases=add(orePurchases,title.priceCents);
    const sale=sales[String(id)];
    let orderedFills=[],sold=0,localGross=0,localFees=0,localNet=0;
    if(sale){
     if(sale.version!==1||sale.cargoID!==id||
      sale.corporationID!==corporationID||sale.operationID!==operationID||
      sale.itemID!==title.itemID||sale.typeID!==title.typeID||
      sale.stationID!==title.stationID||sale.quantity!==title.quantity||
      typeof sale.orderID!=="string"||!/^[1-9][0-9]{0,17}$/.test(sale.orderID)||
      usedOrders.has(sale.orderID))
      return blocked("MINING_PL_ORIGINAL_SALE_SOURCE_CONFLICT");
     usedOrders.add(sale.orderID);
     orderedFills=Object.values(fills).filter(r=>r?.orderID===sale.orderID);
     if(orderedFills.length>1000)return blocked("MINING_PL_TOO_MANY_FILLS");
     orderedFills.sort((a,b)=>a.cycle-b.cycle);
     let remaining=title.quantity,cycle=0;
     for(const r of orderedFills){
      cycle++;
      if(r.version!==1||r.phase!=="GAMESTORE_COMMITTED"||
       r.receiptKey!=="coopPlayerMiningCorpFill"+SEP+sale.orderID+":"+cycle||
       r.cycle!==cycle||r.cargoID!==id||
       r.orderID!==sale.orderID||r.sellerCorpID!==corporationID||
       r.sourceItemID!==title.itemID||r.typeID!==title.typeID||
       r.stationID!==title.stationID||!POS(r.buyerCharacterID)||
       r.volumeBefore!==remaining||!POS(r.quantity)||
       r.quantity>remaining||r.volumeAfter!==remaining-r.quantity||
       !POS(r.priceCents)||r.grossCents!==r.quantity*r.priceCents||
       !NONNEG(r.transactionTaxCents)||!NONNEG(r.brokerFeeCents)||
       r.netRevenueCents!==r.grossCents-
         (r.transactionTaxCents+r.brokerFeeCents)||
       !NONNEG(r.netRevenueCents)||!POS(r.committedAt)||
       !verifiedFill(corpWallet,r.buyerCharacterID,corporationID,r))
       return blocked("MINING_PL_ORIGINAL_FILL_OR_ISK_UNVERIFIED");
      // Read the real buyer charge too, not just the seller's balance.
      const person=read("characters",null,r.buyerCharacterID);
      // gameStore.read path for a root table is "/<id>", not "//<id>".
      if(!person||!Array.isArray(person.walletJournal)||
       person.walletJournal.filter(e=>e?.transactionID===r.buyerJournalID&&
        e.ownerID1===r.buyerCharacterID&&e.ownerID2===corporationID&&
        entryAmount(e,r.buyerJournalID,r.receiptKey,-r.grossCents))
        .length!==1)
       return blocked("MINING_PL_ORIGINAL_BUYER_DEBIT_NOT_VERIFIED");
      const original=await readNativeReleased({
       orderID:sale.orderID,cycle,corporationID,cargoID:id});
      if(original?.verifiedNative!==true||original.phase!=="released"||
       original.orderID!==sale.orderID||original.cycle!==cycle||
       original.nativeReceiptKey!==r.receiptKey||
       original.ack?.phase!=="released"||
       original.ack.receiptKey!==r.receiptKey||
       original.ack.volumeAfter!==r.volumeAfter||
       original.ack.verifiedGameStore!==true)
       return blocked("MINING_PL_ORIGINAL_RUST_FILL_NOT_RELEASED");
      accountedFills.add(String(sale.orderID)+":"+cycle);
      localGross=add(localGross,r.grossCents);
      localNet=add(localNet,r.netRevenueCents);
      localFees=add(localFees,add(r.transactionTaxCents,r.brokerFeeCents));
      sold=add(sold,r.quantity);remaining=r.volumeAfter;
     }
     const returned=sale.phase==="RETURNED_UNSOLD"?
       sale.returnedQuantity:0;
     const unsold=title.quantity-sold;
     if(!NONNEG(unsold)||sold>title.quantity||
      (sale.settledCycles??0)!==cycle||
      (sale.lastSettledCycle??0)!==cycle||
      (sale.phase==="RETURNED_UNSOLD"
       ?returned!==unsold||sale.remainingQuantity!==0
       :sale.phase==="FULLY_SOLD"
       ?unsold!==0||sale.remainingQuantity!==0
       :!["ACTIVE_SELL","ESCROW_BOUND_UNSETTLED"].includes(sale.phase)||
         (sale.remainingQuantity??sale.quantity)!==unsold))
      return blocked("MINING_PL_ORIGINAL_INVENTORY_NOT_CONSERVED");
    }
    // Exact integer cost-basis apportionment, rounded only once per cargo.
    const unsoldQty=title.quantity-sold;
    if(unsoldQty>0){
     const item=findOriginalItemById(title.itemID),
      folder=sale&&sale.phase!=="RETURNED_UNSOLD"?
        sale.escrowLocationID:title.officeFolderID,
      flag=sale&&sale.phase!=="RETURNED_UNSOLD"?4:title.division;
     if(!POS(folder)||!POS(flag)||item?.itemID!==title.itemID||
        item.ownerID!==corporationID||item.locationID!==folder||
        item.flagID!==flag||item.typeID!==title.typeID||
        item.quantity!==unsoldQty||item.stacksize!==unsoldQty||
        item.singleton!==0||item.customInfo!==
           "coop-warehouse:v1:cargo:"+id)
      return blocked("MINING_PL_ORIGINAL_UNSOLD_INVENTORY_NOT_PRESENT");
    }
    const cogs=Number(BigInt(title.priceCents)*BigInt(sold)/BigInt(title.quantity));
    const remainingBasis=title.priceCents-cogs;
    realizedCost=add(realizedCost,cogs);inventoryCost=add(inventoryCost,remainingBasis);
    realizedGross=add(realizedGross,localGross);
    netRevenue=add(netRevenue,localNet);
    fees=add(fees,localFees);soldUnits=add(soldUnits,sold);
    unsoldUnits=add(unsoldUnits,title.quantity-sold);
    cargo.push(Object.freeze({cargoID:id,itemID:title.itemID,
     purchasedQuantity:title.quantity,soldQuantity:sold,
     remainingQuantity:title.quantity-sold,
     acquisitionCostCents:title.priceCents,costOfSoldOreCents:cogs,
     inventoryCostCents:remainingBasis,
     realizedGrossCents:localGross,realizedNetRevenueCents:localNet,
     marketFeesCents:localFees}));
   }
   for(const receipt of Object.values(fills))
    if(receipt?.sellerCorpID===corporationID&&usedOrders.has(receipt.orderID)&&
     !accountedFills.has(String(receipt.orderID)+":"+receipt.cycle))
     return blocked("MINING_PL_UNACCOUNTED_CORPORATE_FILL");
   const grossProfit=netRevenue-realizedCost,
    operatingProfit=grossProfit-shift.wageCents,
    cashProfit=netRevenue-shift.wageCents-orePurchases;
   return Object.freeze({
    status:"VERIFIED_REALIZED_MINING_PL",corporationID,operationID,
    basis:"ORIGINAL_RUST_RELEASED_FILLED_ONLY",currency:"ISK_CENTS",
    revenueGrossCents:realizedGross,marketFeesCents:fees,
    realizedRevenueCents:netRevenue,
    wagesPaidCents:shift.wageCents,orePurchasedCents:orePurchases,
    costOfOreSoldCents:realizedCost,
    remainingOreInventoryCostCents:inventoryCost,
    grossProfitCents:grossProfit,netOperatingProfitCents:operatingProfit,
    cashProfitCents:cashProfit,totalSoldOreUnits:soldUnits,
    totalUnsoldOreUnits:unsoldUnits,cargo,
    excludedUnverifiedOverheads:true,
    originalWalletMutation:false
   });
  }catch{return blocked("MINING_PL_NATIVE_SOURCE_OR_RUST_READ_FAILED")}
 }
 return Object.freeze({inspect,mode:"ORIGINAL_MINING_CORP_REALIZED_PL_ONLY"});
}
module.exports={createMiningCorporatePnl,iskCents};
