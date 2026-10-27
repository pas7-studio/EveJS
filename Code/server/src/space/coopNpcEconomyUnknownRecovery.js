"use strict";
// Read-only crash reconciliation for the EXISTING NPC manufacturing journal.
// Only trust exact persisted native job, debit and item receipts. Never replay
// a potentially committed native write, market listing or wallet transfer.
const pos=x=>Number.isSafeInteger(x)&&x>0;
// Source wallet/quote amounts must ALREADY be exact integer cents. Do
// not invent missing cents when interpreting persisted crash receipts.
const cents=x=>{
 if(typeof x!=="number"||!Number.isFinite(x)||x<0||x>1e12)return null;
 const scaled=x*100,whole=Math.round(scaled);
 return Number.isSafeInteger(whole)&&Math.abs(scaled-whole)<=1e-6?
  whole:null;
};
function quotedPayment(e,job){
 const quote=e.quote,total=cents(quote?.totalCost),
  base=cents(quote?.cost),tax=cents(quote?.tax);
 if(total===null||base===null||tax===null||base+tax!==total||
    quote.verifiedNative!==true||
    quote.ownerID!==e.ownerID||quote.facilityID!==e.stationID||
    quote.blueprintID!==e.plan.blueprintItemID||
    quote.productTypeID!==e.typeID||
    job.coopQuoteSignature!==JSON.stringify(quote)||
    cents(job.totalCost)!==total)return null;
 return total;
}
const blocked=reason=>({ok:false,reason});
function reconcileUnknown({entry,native}={}){
 if(!entry||!native||![
  "INSTALL_UNKNOWN","DELIVERY_UNKNOWN"].includes(entry.phase))
  return blocked("UNKNOWN_ECONOMY_PHASE_NOT_RECONCILABLE");
 const e=entry,id=e.operationID,plan=e.plan;
 if(typeof id!=="string"||!/^npc-manufacture:[0-9a-f]{32}$/.test(id)||
   !pos(e.ownerID)||!pos(e.stationID)||!pos(e.typeID)||
   !plan||plan.ownerID!==e.ownerID||plan.stationID!==e.stationID||
   plan.productTypeID!==e.typeID||!pos(plan.blueprintItemID)||
   !pos(plan.outputQuantity)||!pos(plan.runs)||
   typeof native.getJob!=="function"||typeof native.getItem!=="function"||
   typeof native.getIndustryDebit!=="function")
  return blocked("NATIVE_RECOVERY_CONTEXT_UNVERIFIED");
 try{
  const job=native.getJob(id);
  if(!job||!pos(job.jobID)||job.coopOperationID!==id||
    job.ownerID!==e.ownerID||job.stationID!==e.stationID||
    job.facilityID!==e.stationID||job.activityID!==1||
    job.blueprintID!==plan.blueprintItemID||
    job.productTypeID!==e.typeID||job.runs!==plan.runs||
    job.outputLocationID!==e.stationID||job.outputFlagID!==4)
   return blocked("NATIVE_RECOVERY_JOB_NOT_ATTESTED");
  if(e.phase==="INSTALL_UNKNOWN"){
   const amount=quotedPayment(e,job);
   if(amount===null||![1,2,3].includes(job.status))
    return blocked("NATIVE_RECOVERY_INSTALL_QUOTE_OR_STATUS_INVALID");
   const debit=native.getIndustryDebit(job.jobID);
   if(!debit||debit.verifiedNative!==true||debit.jobID!==job.jobID||
      debit.ownerID!==e.ownerID||debit.amountCents!==amount||
      !pos(debit.transactionID))
    return blocked("NATIVE_RECOVERY_INDUSTRY_DEBIT_NOT_ATTESTED");
   return {ok:true,status:"RECOVERED_INSTALLED",patch:{phase:"INSTALLED",
    jobID:job.jobID,installCostCents:amount}};
  }
  // A DELIVERED item is NOT proof a manufacturing job was fully paid.
  // Re-attest the same original quote, exact cost/tax and signed job
  // before recognizing the lost delivery acknowledgement.
  const amount=quotedPayment(e,job);
  if(job.jobID!==e.jobID||job.status!==4||
     !Number.isSafeInteger(e.installCostCents)||e.installCostCents<0||
     amount===null||e.installCostCents!==amount)
   return blocked("NATIVE_RECOVERY_DELIVERY_JOB_NOT_ATTESTED");
  const paid=native.getIndustryDebit(job.jobID);
  if(!paid||paid.verifiedNative!==true||paid.jobID!==job.jobID||
     paid.ownerID!==e.ownerID||paid.amountCents!==e.installCostCents||
     !pos(paid.transactionID))
   return blocked("NATIVE_RECOVERY_INDUSTRY_DEBIT_NOT_ATTESTED");
  const receipt=job.coopDelivery;
  if(!receipt||receipt.operationID!==id||
     !pos(receipt.itemID)||receipt.typeID!==e.typeID||
     receipt.quantity!==plan.outputQuantity||!pos(receipt.quantity))
   return blocked("NATIVE_RECOVERY_DELIVERY_RECEIPT_INVALID");
  const item=native.getItem(receipt.itemID);
  if(!item||item.itemID!==receipt.itemID||item.typeID!==e.typeID||
     item.ownerID!==e.ownerID||item.locationID!==e.stationID||
     item.flagID!==4||item.quantity!==receipt.quantity||
     item.stacksize!==receipt.quantity||item.singleton!==0||
     item.customInfo!=="coop-industry:v1:"+job.jobID)
   return blocked("NATIVE_RECOVERY_DELIVERY_ITEM_NOT_ATTESTED");
  return {ok:true,status:"RECOVERED_DELIVERED",patch:{phase:"DELIVERED",
   itemID:item.itemID,quantity:item.quantity}};
 }catch(_){return blocked("NATIVE_RECOVERY_READ_UNAVAILABLE");}
}
module.exports={reconcileUnknown};
