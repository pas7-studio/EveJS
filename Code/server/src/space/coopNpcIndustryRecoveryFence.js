"use strict";
/**
 * LW-04C1: bounded, read-only recovery fence before admitting a live NPC
 * manufacturing director. Does not write to GameStore/ItemStore/Rust, replay
 * operations, run a timer, mint stock or settle wallets.
 *
 * A successful read is NOT proof of a live transaction implementation.
 * Original ACT still requires a separate audited supportsLiveRuntime:true
 * director. This fence prevents an unsafe director from claiming readiness
 * while its own durable journal or original native custody is ambiguous.
 */
const POS=x=>Number.isSafeInteger(x)&&x>0;
const COUNT=x=>Number.isSafeInteger(x)&&x>=0;
const ID=/^npc-manufacture:[0-9a-f]{32}$/;
const PHASES=new Set(["PREPARED","INSTALL_UNKNOWN","INSTALLED","READY",
 "DELIVERY_UNKNOWN","DELIVERED","LIST_UNKNOWN","LISTED","SOLD",
 "REPAIR_REQUIRED"]);
const BAD=new Set(["INSTALL_UNKNOWN","DELIVERY_UNKNOWN","LIST_UNKNOWN",
 "REPAIR_REQUIRED"]);
const cents=v=>{
 if(typeof v!=="number"||!Number.isFinite(v)||v<=0||v>1e12)return null;
 const raw=v*100,num=Math.round(raw);
 return Number.isSafeInteger(num)&&num>0&&Math.abs(raw-num)<1e-7?num:null;
};
const blocked=(reason,operationID=null)=>({status:"BLOCKED",reason,
 operationID,nativeMutation:false,readOnly:true});
const same=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
function createIndustryRecoveryFence({
 director,native,market,clock=()=>Date.now(),maxEntries=512
}={}){
 if(typeof director?.inspect!=="function"||
    ["getJob","getItem","getIndustryDebit"].some(k=>typeof native?.[k]!=="function")||
    ["getOrder","getSaleEvidence","getWalletEntry"].some(k=>typeof market?.[k]!=="function")||
    typeof clock!=="function"||
    !Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>2000)
  throw Error("NPC_INDUSTRY_RECOVERY_FENCE_DEPENDENCIES_REQUIRED");
 const read=(fn,...args)=>{
  const value=fn(...args);
  if(value&&typeof value.then==="function")
   throw Error("NPC_INDUSTRY_RECOVERY_ASYNC_AUTHORITY_UNSUPPORTED");
  return value;
 };
 function audit({ownerID,stationID}={}){
  if(!POS(ownerID)||!POS(stationID))
   return blocked("NPC_INDUSTRY_RECOVERY_SCOPE_INVALID");
  try{
   const now=clock();
   if(!COUNT(now))return blocked("NPC_INDUSTRY_RECOVERY_CLOCK_INVALID");
   const before=read(director.inspect);
   if(before?.version!==1||!before.entries||
      typeof before.entries!=="object"||Array.isArray(before.entries)||
      !before.history||typeof before.history!=="object"||
      Array.isArray(before.history))
    return blocked("NPC_INDUSTRY_RECOVERY_JOURNAL_INVALID");
   const entries=Object.entries(before.entries);
   if(entries.length>maxEntries)
    return blocked("NPC_INDUSTRY_RECOVERY_JOURNAL_BUDGET_EXCEEDED");
   let scoped=0,prepared=0,verified=0,listed=0,sold=0;
   for(const [key,e] of entries){
    if(!ID.test(key)||e?.operationID!==key||!PHASES.has(e.phase)||
       !POS(e.ownerID)||!POS(e.stationID)||!POS(e.typeID)||
       !COUNT(e.createdAt)||e.createdAt>now)
     return blocked("NPC_INDUSTRY_RECOVERY_ENTRY_CORRUPT",key);
    if(e.ownerID!==ownerID||e.stationID!==stationID)continue;
    scoped++;
    if(!e.plan||e.plan.ownerID!==ownerID||
       e.plan.stationID!==stationID||
       e.plan.productTypeID!==e.typeID||
       !POS(e.plan.blueprintItemID)||!POS(e.plan.outputQuantity))
     return blocked("NPC_INDUSTRY_RECOVERY_PLAN_CHANGED",key);
    // Never perform a second native write while an ambiguous previous
    // SQLite or Rust result has not been reconciled by its original owner.
    if(BAD.has(e.phase))
     return blocked("NPC_INDUSTRY_RECOVERY_OUTCOME_UNKNOWN",key);
    const job=read(native.getJob,key);
    if(e.phase==="PREPARED"){
     // PREPARED is before the journal transitions to INSTALL_UNKNOWN.
     // A native job already present means journal and SQLite disagree.
     if(job)return blocked("NPC_INDUSTRY_RECOVERY_PREPARED_HAS_JOB",key);
     prepared++;continue;
    }
    if(!job||!POS(job.jobID)||job.coopOperationID!==key||
       job.ownerID!==ownerID||
       (job.stationID??job.facilityID)!==stationID||
       job.activityID!==1||job.blueprintID!==e.plan.blueprintItemID||
       job.productTypeID!==e.typeID||
       e.jobID!==job.jobID||
       ![1,2,3,4].includes(job.status))
     return blocked("NPC_INDUSTRY_RECOVERY_JOB_NOT_ATTESTED",key);
    const debit=read(native.getIndustryDebit,job.jobID);
    if(!debit||debit.verifiedNative!==true||
       debit.jobID!==job.jobID||debit.ownerID!==ownerID||
       !POS(debit.transactionID)||!COUNT(debit.amountCents)||
       debit.amountCents!==e.installCostCents)
     return blocked("NPC_INDUSTRY_RECOVERY_DEBIT_NOT_ATTESTED",key);
    if(e.phase==="INSTALLED"||e.phase==="READY"){
     if(e.phase==="INSTALLED"&&![1,2,3].includes(job.status)||
        e.phase==="READY"&&job.status!==3)
      return blocked("NPC_INDUSTRY_RECOVERY_JOB_PHASE_CONFLICT",key);
     verified++;continue;
    }
    if(job.status!==4||!POS(e.itemID)||!POS(e.quantity)||
       e.quantity!==e.plan.outputQuantity||
       job.coopDelivery?.operationID!==key||
       job.coopDelivery?.itemID!==e.itemID||
       job.coopDelivery?.quantity!==e.quantity)
     return blocked("NPC_INDUSTRY_RECOVERY_DELIVERY_RECEIPT_INVALID",key);
    if(e.phase==="DELIVERED"){
     const item=read(native.getItem,e.itemID);
     if(!item||item.itemID!==e.itemID||item.typeID!==e.typeID||
        item.ownerID!==ownerID||item.locationID!==stationID||
        item.flagID!==4||item.singleton!==0||
        item.quantity!==e.quantity||item.stacksize!==e.quantity||
        item.customInfo!=="coop-industry:v1:"+job.jobID)
      return blocked("NPC_INDUSTRY_RECOVERY_HANGAR_ITEM_MISSING",key);
     verified++;continue;
    }
    const order=read(market.getOrder,e.orderID);
    if(!POS(e.orderID)||!order||order.orderID!==e.orderID||
       order.ownerID!==ownerID||order.stationID!==stationID||
       order.typeID!==e.typeID||order.sourceItemID!==e.itemID||
       order.originalQuantity!==e.quantity||
       order.nativeEscrowVerified!==true)
     return blocked("NPC_INDUSTRY_RECOVERY_MARKET_ESCROW_INVALID",key);
    if(e.phase==="LISTED"){
     if(!COUNT(order.remainingQuantity)||order.remainingQuantity>e.quantity)
      return blocked("NPC_INDUSTRY_RECOVERY_LISTED_QUANTITY_INVALID",key);
     listed++;verified++;continue;
    }
    if(e.phase!=="SOLD"||order.remainingQuantity!==0)
     return blocked("NPC_INDUSTRY_RECOVERY_SOLD_ORDER_NOT_CLOSED",key);
    const fills=read(market.getSaleEvidence,e.orderID);
    if(!Array.isArray(fills)||fills.length>10000)
     return blocked("NPC_INDUSTRY_RECOVERY_SALES_UNAVAILABLE",key);
    const used=new Set();
    let qty=0,priceSum=0;
    for(const fill of fills){
     const price=cents(fill?.price);
     if(!fill||fill.orderID!==e.orderID||fill.ownerID!==ownerID||
        fill.typeID!==e.typeID||!POS(fill.quantity)||
        !POS(fill.transactionID)||price===null||
        fill.nativeWalletSettled!==true||used.has(fill.transactionID))
      return blocked("NPC_INDUSTRY_RECOVERY_FILL_UNVERIFIED",key);
     used.add(fill.transactionID);
     const wallet=read(market.getWalletEntry,fill.transactionID);
     const amount=price*fill.quantity;
     if(!Number.isSafeInteger(amount)||!wallet||
        wallet.verifiedNative!==true||
        wallet.transactionID!==fill.transactionID||
        wallet.ownerID!==ownerID||wallet.orderID!==e.orderID||
        wallet.amountCents!==amount)
      return blocked("NPC_INDUSTRY_RECOVERY_WALLET_UNVERIFIED",key);
     qty+=fill.quantity;priceSum+=amount;
     if(!Number.isSafeInteger(qty)||!Number.isSafeInteger(priceSum))
      return blocked("NPC_INDUSTRY_RECOVERY_SETTLEMENT_OVERFLOW",key);
    }
    if(qty!==e.quantity||e.soldQuantity!==qty||
       e.revenueCents!==priceSum)
     return blocked("NPC_INDUSTRY_RECOVERY_SALE_CONSERVATION_FAILED",key);
    sold++;verified++;
   }
   // The source journal can change while inspecting native SQLite/Rust. A
   // second identical read is mandatory, not an assumption of stable custody.
   const after=read(director.inspect);
   if(!same(before,after))
    return blocked("NPC_INDUSTRY_RECOVERY_JOURNAL_CHANGED_DURING_READ");
   return {status:"READY",ownerID,stationID,scoped,prepared,verified,
    listed,sold,readOnly:true,nativeMutation:false,
    proof:"ORIGINAL_DIRECTOR_JOURNAL_AND_NATIVE_RECEIPTS_READ_ONLY"};
  }catch(error){
   return blocked("NPC_INDUSTRY_RECOVERY_AUTHORITY_UNAVAILABLE:"+
    String(error?.message||error).slice(0,100));
  }
 }
 return Object.freeze({audit,mode:"ORIGINAL_NATIVE_MANUFACTURING_RECOVERY_FENCE",
  supportsNativeMutation:false});
}
module.exports={createIndustryRecoveryFence};
