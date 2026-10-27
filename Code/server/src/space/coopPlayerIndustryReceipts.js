"use strict";
// Pure native-store receipts for Chat 27. Never mint, debit or transfer items.
const {ACT,STATUS}=require("./coopPlayerIndustryGuard" + (__filename.endsWith(".cjs") ? ".cjs" : ".js"));
const id=x=>{const n=Number(x);return Number.isSafeInteger(n)&&n>0?n:0};
const nonneg=x=>typeof x==="number"&&Number.isFinite(x)&&x>=0;
function makePlayerIndustryReceipts({
 getJobByID,getBlueprintState,getInventoryItem,listContainerItems,
 getWalletBalance,getBlueprintDefinitionByTypeID,getIndustryActivity
}={}){
 const api=[getJobByID,getBlueprintState,getInventoryItem,listContainerItems,
  getWalletBalance,getBlueprintDefinitionByTypeID,getIndustryActivity];
 if(api.some(fn=>typeof fn!=="function"))throw Error("NATIVE_INDUSTRY_RECEIPT_BINDINGS_REQUIRED");
 function list(ownerID,locationID,flagID){
  const rows=listContainerItems(ownerID,locationID,flagID);
  if(!Array.isArray(rows))throw Error("NATIVE_ITEMS_UNAVAILABLE");
  const seen=new Set();
  return rows.map(row=>{
   if(!id(row?.itemID)||!id(row?.typeID)||!id(row?.ownerID)||
    id(row.ownerID)!==id(ownerID)||id(row.locationID)!==id(locationID)||
    Number(row.flagID)!==Number(flagID)||seen.has(row.itemID))
    throw Error("NATIVE_ITEM_IDENTITY_INVALID");
   seen.add(row.itemID);
   const quantity=Number(row.singleton)===1?1:Number(row.stacksize??row.quantity);
   if(!Number.isSafeInteger(quantity)||quantity<=0)
    throw Error("NATIVE_ITEM_QUANTITY_INVALID");
   return {itemID:id(row.itemID),typeID:id(row.typeID),
    categoryID:Number(row.categoryID),quantity,ownerID:id(row.ownerID)};
  });
 }
 const totals=rows=>{
  const ret=new Map();
  for(const row of rows)ret.set(row.typeID,(ret.get(row.typeID)||0)+row.quantity);
  return ret;
 };
 function capture(proof){
  if(proof?.kind==="INSTALL"){
   return {kind:"INSTALL",wallet:Number(getWalletBalance(proof.ownerID,proof.account)),
    materials:list(proof.ownerID,proof.inputLocationID,proof.inputFlagID),
    blueprint:getInventoryItem(proof.blueprintID),
    blueprintState:getBlueprintState(proof.blueprintID)};
  }
  if(proof?.kind==="DELIVER"){
   const job=getJobByID(proof.jobID);
   if(!job||id(job.jobID)!==id(proof.jobID)||Number(job.status)!==STATUS.READY)
    throw Error("NATIVE_JOB_NOT_READY_AT_CAPTURE");
   return {kind:"DELIVER",job:{...job},output:list(proof.ownerID,
    proof.outputLocationID,proof.outputFlagID),
    blueprint:{...getInventoryItem(proof.blueprintID)},
    blueprintState:{...getBlueprintState(proof.blueprintID)}};
  }
  if(proof?.kind==="CANCEL"){
   const job=getJobByID(proof.jobID);
   const bp=getInventoryItem(proof.blueprintID);
   const state=getBlueprintState(proof.blueprintID);
   if(!job||id(job.jobID)!==id(proof.jobID)||
    ![STATUS.INSTALLED,STATUS.PAUSED,STATUS.READY].includes(Number(job.status))||
    !bp||id(bp.ownerID)!==id(proof.ownerID)||
    id(bp.locationID)!==2003||id(state?.jobID)!==id(proof.jobID))
    throw Error("NATIVE_CANCEL_CUSTODY_UNAVAILABLE");
   return {kind:"CANCEL",job:{...job},blueprint:{...bp},
    blueprintState:{...state}};
  }
  throw Error("INVALID_NATIVE_INDUSTRY_RECEIPT_ACTION");
 }
 function verifyInstall({proof,nativeResult,before}){
  if(before?.kind!=="INSTALL"||nativeResult?.success!==true||
   !id(nativeResult?.data?.jobID)||!nonneg(before.wallet))
   return false;
  const job=getJobByID(nativeResult.data.jobID);
  if(!job||id(job.jobID)!==id(nativeResult.data.jobID)||
   id(job.blueprintID)!==id(proof.blueprintID)||
   id(job.ownerID)!==id(proof.ownerID)||
   id(job.installerID)!==id(proof.characterID)||
   id(job.facilityID)!==id(proof.facilityID)||
   Number(job.activityID)!==Number(proof.activityID)||
   id(job.runs)!==id(proof.runs)||Number(job.status)!==STATUS.INSTALLED||
   Number(job.totalCost)!==Number(proof.cost))return false;
  for(const material of proof.materials||[]){
   if(Number(job.materials?.[String(material.typeID)])!==Number(material.quantity))
    return false;
  }
  const bp=getInventoryItem(proof.blueprintID),
   state=getBlueprintState(proof.blueprintID);
  if(!bp||id(bp.ownerID)!==id(proof.ownerID)||id(bp.locationID)!==2003||
   id(state?.jobID)!==id(job.jobID))return false;
  const remaining=list(proof.ownerID,proof.inputLocationID,proof.inputFlagID);
  const pre=totals(before.materials),post=totals(remaining);
  if(!Array.isArray(proof.materials))return false;
  for(const m of proof.materials){
   if(!id(m.typeID)||!id(m.quantity)||
    (pre.get(id(m.typeID))||0)-(post.get(id(m.typeID))||0)!==id(m.quantity))
    return false;
  }
  const afterWallet=Number(getWalletBalance(proof.ownerID,proof.account));
  return nonneg(afterWallet)&&Math.abs((before.wallet-afterWallet)-proof.cost)<0.000001;
 }
 function verifyDeliver({proof,nativeResult,before}){
  if(before?.kind!=="DELIVER"||nativeResult?.success!==true)return false;
  const job=getJobByID(proof.jobID);
  if(!job||id(job.jobID)!==id(proof.jobID)||
   Number(job.status)!==STATUS.DELIVERED||
   id(job.completedCharacterID)!==id(proof.characterID)||
   id(job.ownerID)!==id(proof.ownerID))return false;
  const after=list(proof.ownerID,proof.outputLocationID,proof.outputFlagID);
  const activityID=Number(proof.activityID);
  if([ACT.MANUFACTURING,ACT.REACTION].includes(activityID)){
   const definition=getBlueprintDefinitionByTypeID(job.blueprintTypeID);
   const activity=getIndustryActivity(definition,activityID);
   if(!activity||!Array.isArray(activity.products)||!activity.products.length)return false;
   const expected=new Map();
   for(const product of activity.products){
    if(!id(product.typeID)||!id(product.quantity))return false;
    expected.set(id(product.typeID),(expected.get(id(product.typeID))||0)+
     id(product.quantity)*id(job.runs));
   }
   const oldTotal=totals(before.output),newTotal=totals(after);
   for(const [typeID,qty] of expected)if((newTotal.get(typeID)||0)-
    (oldTotal.get(typeID)||0)!==qty)return false;
  }else if(activityID===ACT.COPYING){
   const existing=new Set(before.output.map(item=>item.itemID));
   const copied=after.filter(item=>!existing.has(item.itemID)&&
    item.itemID!==id(proof.blueprintID)&&
    id(item.typeID)===id(job.blueprintTypeID)&&item.categoryID===9);
   if(copied.length!==id(job.runs))return false;
   for(const item of copied){
    const state=getBlueprintState(item.itemID);
    if(state?.original!==false||id(state.runsRemaining)!==id(job.licensedRuns)||
     Number(state.materialEfficiency)!==Number(before.blueprintState.materialEfficiency)||
     Number(state.timeEfficiency)!==Number(before.blueprintState.timeEfficiency))
     return false;
   }
  }else if([ACT.RESEARCH_MATERIAL,ACT.RESEARCH_TIME].includes(activityID)){
   const state=getBlueprintState(proof.blueprintID),bp=getInventoryItem(proof.blueprintID);
   if(!bp||id(bp.locationID)!==id(before.job.blueprintLocationID)||
    state?.original!==true||id(state.jobID))return false;
   const level=activityID===ACT.RESEARCH_MATERIAL?"materialEfficiency":"timeEfficiency";
   const step=activityID===ACT.RESEARCH_MATERIAL?1:2,max=activityID===ACT.RESEARCH_MATERIAL?10:20;
   if(Number(state[level])!==Math.min(max,Number(before.blueprintState[level])+step*id(job.runs)))
    return false;
  }else return false;
  const current=getBlueprintState(proof.blueprintID),
   bp=getInventoryItem(proof.blueprintID);
  if(current&&id(current.jobID)===id(job.jobID))return false;
  if(before.blueprintState?.original===true||
   Number(before.blueprintState?.runsRemaining)>id(job.runs)){
   if(!bp||id(bp.ownerID)!==id(proof.ownerID)||
    id(bp.locationID)!==id(job.blueprintLocationID)||
    Number(bp.flagID)!==Number(job.blueprintLocationFlagID))
    return false;
  }else if(bp||current)return false;
  return true;
 }
 function verifyCancel({proof,nativeResult,before}={}){
  if(before?.kind!=="CANCEL"||nativeResult?.success!==true||
   id(nativeResult?.data?.jobID)!==id(proof?.jobID))
   return false;
  const job=getJobByID(proof.jobID),bp=getInventoryItem(proof.blueprintID),
   state=getBlueprintState(proof.blueprintID);
  if(!job||id(job.jobID)!==id(proof.jobID)||
   Number(job.status)!==STATUS.CANCELLED||
   id(job.ownerID)!==id(proof.ownerID)||
   id(job.completedCharacterID)!==id(proof.characterID)||
   id(job.blueprintID)!==id(proof.blueprintID)||
   !bp||id(bp.itemID)!==id(proof.blueprintID)||
   id(bp.ownerID)!==id(proof.ownerID)||
   id(bp.locationID)!==id(before.job.blueprintLocationID)||
   Number(bp.flagID)!==Number(before.job.blueprintLocationFlagID)||
   !state||id(state.jobID)||
   id(before.blueprint.locationID)!==2003||
   id(before.blueprintState.jobID)!==id(proof.jobID))
   return false;
  // This verifies original job transition, original blueprint owner/location,
  // and the exact native actor. No compensation or free materials are minted.
  return true;
 }
 function captureHandoff({fromOwnerID,toOwnerID,sourceLocationID,sourceFlagID,
  destinationLocationID,destinationFlagID,typeID,quantity}={}){
  if(!id(fromOwnerID)||!id(toOwnerID)||fromOwnerID===toOwnerID||
   !id(sourceLocationID)||!id(destinationLocationID)||!id(typeID)||
   !id(quantity))throw Error("INVALID_NATIVE_HANDOFF");
  return {fromOwnerID,toOwnerID,sourceLocationID,sourceFlagID,
   destinationLocationID,destinationFlagID,typeID,quantity,
   sender:list(fromOwnerID,sourceLocationID,sourceFlagID),
   receiver:list(toOwnerID,destinationLocationID,destinationFlagID)};
 }
 function verifyHandoff({before,nativeTransferResult}={}){
  if(!before||nativeTransferResult?.success!==true)return false;
  const sender=list(before.fromOwnerID,before.sourceLocationID,before.sourceFlagID),
   receiver=list(before.toOwnerID,before.destinationLocationID,before.destinationFlagID);
  const typeID=id(before.typeID),qty=id(before.quantity);
  if(!typeID||!qty)return false;
  const oldSender=totals(before.sender).get(typeID)||0;
  const newSender=totals(sender).get(typeID)||0;
  const oldReceiver=totals(before.receiver).get(typeID)||0;
  const newReceiver=totals(receiver).get(typeID)||0;
  return oldSender-newSender===qty&&newReceiver-oldReceiver===qty;
 }
 return {capture,verifyInstall,verifyDeliver,verifyCancel,captureHandoff,verifyHandoff};
}
module.exports={makePlayerIndustryReceipts};
