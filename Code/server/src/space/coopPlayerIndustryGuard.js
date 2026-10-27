"use strict";
// Chat 27: fail-closed gate for pinned EveJS *player* industry; no synthetic
// blueprint, item, wallet, material, skill, facility or job authority.
const ACT=Object.freeze({MANUFACTURING:1,RESEARCH_TIME:3,RESEARCH_MATERIAL:4,COPYING:5,INVENTION:8,REACTION:9});
const STATUS=Object.freeze({INSTALLED:1,PAUSED:2,READY:3,DELIVERED:101,CANCELLED:102});
const pos=x=>{const n=Number(x);return Number.isSafeInteger(n)&&n>0?n:0};
const finite=x=>typeof x==="number"&&Number.isFinite(x)&&x>=0;
const deny=(reason)=>({ok:false,reason});
function makePlayerIndustryGuard({
 getSessions,getCharacterRecord,getInventoryItem,getBlueprintByItemID,
 getBlueprintState,getJobByID,quoteIndustryJob,getAvailableMaterials,
 hasCorporationIndustryJobAccess,canTakeFromOwnerLocation,
 canViewOwnerLocation,canUseCorporationWallet,getCharacterWallet,
 getCorporationWalletBalance,getActivity,nowFiletime
}={}){
 const dependencies=[getSessions,getCharacterRecord,getInventoryItem,
  getBlueprintByItemID,getBlueprintState,getJobByID,quoteIndustryJob,
  getAvailableMaterials,hasCorporationIndustryJobAccess,
  canTakeFromOwnerLocation,canViewOwnerLocation,canUseCorporationWallet,
  getCharacterWallet,getCorporationWalletBalance,getActivity,nowFiletime];
 if(dependencies.some(fn=>typeof fn!=="function"))
  throw Error("NATIVE_PLAYER_INDUSTRY_BINDINGS_REQUIRED");
 function actor(session){
  const characterID=pos(session?.characterID||session?.charid),
   accountID=pos(session?.userid),corpID=pos(session?.corporationID||session?.corpid);
  if(!characterID||!accountID||session?.socket?.destroyed===true)
   return deny("INVALID_NATIVE_INDUSTRY_SESSION");
  let active,character;
  try{
   active=getSessions().filter(s=>pos(s?.characterID||s?.charid)===characterID&&
    s?.socket?.destroyed!==true);
   character=getCharacterRecord(characterID);
  }catch{return deny("NATIVE_SESSION_AUTHORITY_UNAVAILABLE")}
  if(active.length!==1||active[0]!==session)
   return deny("DUPLICATE_OR_STALE_NATIVE_SESSION");
  if(pos(character?.accountId||character?.accountID)!==accountID)
   return deny("NATIVE_INDUSTRY_ACCOUNT_MISMATCH");
  // Never trust a client-supplied ownerID or corporate role.
  if(corpID&&pos(character?.corporationID||character?.corporationId)!==corpID)
   return deny("NATIVE_INDUSTRY_CORPORATION_MISMATCH");
  return {ok:true,characterID,corpID};
 }
 function verifyOwner(session,ownerID,actorContext,location,flag,needTake=false){
  const owner=pos(ownerID);
  if(!owner)return deny("INVALID_INDUSTRY_OWNER");
  if(owner===actorContext.characterID)return {ok:true,kind:"character"};
  if(owner!==actorContext.corpID)return deny("FOREIGN_INDUSTRY_OWNER");
  try{
   if(hasCorporationIndustryJobAccess(session,owner)!==true)
    return deny("CORPORATION_FACTORY_ROLE_REQUIRED");
   if(needTake&&canTakeFromOwnerLocation(session,owner,location,flag)!==true)
    return deny("CORPORATION_HANGAR_TAKE_REQUIRED");
   if(!needTake&&canViewOwnerLocation(session,owner,location,flag)!==true)
    return deny("CORPORATION_HANGAR_VIEW_REQUIRED");
  }catch{return deny("CORPORATION_INDUSTRY_AUTHORITY_UNAVAILABLE")}
  return {ok:true,kind:"corporation"};
 }
 function nativeAmount(value){
  return typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
 }
 function checkInstall(session,request){
  const ctx=actor(session);if(!ctx.ok)return ctx;
  const bpID=pos(request?.blueprintID),activityID=pos(request?.activityID),
   facilityID=pos(request?.facilityID),runs=pos(request?.runs);
  if(!bpID||!facilityID||!runs)return deny("INVALID_INDUSTRY_INSTALL_REQUEST");
  if(activityID===ACT.INVENTION)return deny("NATIVE_INVENTION_NOT_IMPLEMENTED");
  if(![1,3,4,5,9].includes(activityID))return deny("NATIVE_ACTIVITY_NOT_SUPPORTED");
  let native;
  try{native=quoteIndustryJob(session,request)}catch{return deny("NATIVE_INDUSTRY_QUOTE_UNAVAILABLE")}
  if(native?.success!==true||!native.quote)return deny("NATIVE_INDUSTRY_QUOTE_REJECTED");
  const quote=native.quote;
  if(pos(quote.activityID)!==activityID||pos(quote.blueprint?.itemID)!==bpID||
   pos(quote.facility?.facilityID)!==facilityID||pos(quote.runs)!==runs)
   return deny("NATIVE_QUOTE_IDENTITY_MISMATCH");
  const ownerID=pos(quote.ownerID),blueprint=quote.blueprint;
  const access=verifyOwner(session,ownerID,ctx,blueprint.locationID,blueprint.flagID,true);
  if(!access.ok)return access;
  let item,state;
  try{
   item=getInventoryItem(bpID);
   state=getBlueprintState(bpID);
  }catch{return deny("NATIVE_BLUEPRINT_STATE_UNAVAILABLE")}
  if(!item||pos(item.categoryID)!==9||pos(item.ownerID)!==ownerID||
   pos(item.locationID)!==pos(blueprint.locationID)||
   pos(item.flagID)!==pos(blueprint.flagID)||pos(item.typeID)!==pos(blueprint.typeID))
   return deny("NATIVE_BLUEPRINT_CUSTODY_MISMATCH");
  if(!state||pos(state.jobID))return deny("BLUEPRINT_ALREADY_INSTALLED");
  if(activityID!==ACT.MANUFACTURING&&state.original!==true)
   return deny("BPC_NOT_VALID_FOR_THIS_NATIVE_ACTIVITY");
  if(state.original!==true&&runs>Number(state.runsRemaining))
   return deny("BPC_INSUFFICIENT_LICENSED_RUNS");
  if(activityID===ACT.COPYING&&(!pos(quote.licensedRuns)||
   pos(quote.licensedRuns)>pos(quote.definition?.maxProductionLimit)))
   return deny("COPY_LICENSED_RUNS_INVALID");
  if(!quote.facility.online||!quote.facility.activities?.[activityID])
   return deny("NATIVE_FACILITY_ACTIVITY_UNAVAILABLE");
  if(!pos(quote.inputLocation?.itemID)||!pos(quote.outputLocation?.itemID)||
   pos(quote.inputLocation.ownerID)!==ownerID||
   pos(quote.outputLocation.ownerID)!==ownerID)
   return deny("NATIVE_INDUSTRY_LOCATION_MISMATCH");
  const input=verifyOwner(session,ownerID,ctx,quote.inputLocation.itemID,quote.inputLocation.flagID,true);
  if(!input.ok)return input;
  const output=verifyOwner(session,ownerID,ctx,quote.outputLocation.itemID,quote.outputLocation.flagID,false);
  if(!output.ok)return output;
  if(!Array.isArray(quote.materials)||!finite(quote.totalCost)||!finite(quote.timeInSeconds)||
   !Number.isFinite(quote.timeInSeconds)||quote.timeInSeconds<=0||
   !finite(quote.cost)||!finite(quote.tax)||!finite(quote.sccSurcharge)||
   Math.abs(quote.cost+quote.tax+quote.sccSurcharge-quote.totalCost)>0.001)
   return deny("NATIVE_INDUSTRY_QUOTE_INVARIANT_FAILED");
  const account=quote.account;
  if(!Array.isArray(account)||pos(account[0])!==ownerID)
   return deny("NATIVE_WALLET_OWNER_MISMATCH");
  if(access.kind==="corporation"&&canUseCorporationWallet(session,ownerID,account[1])!==true)
   return deny("CORPORATION_WALLET_TAKE_REQUIRED");
  let wallet;
  try{wallet=access.kind==="character"?getCharacterWallet(ownerID)?.balance:
   getCorporationWalletBalance(ownerID,account[1]);}
  catch{return deny("NATIVE_WALLET_UNAVAILABLE")}
  if(!finite(wallet)||wallet<quote.totalCost)return deny("NATIVE_INDUSTRY_FUNDS_INSUFFICIENT");
  let physical;
  try{physical=getAvailableMaterials(ownerID,quote.inputLocation)}
  catch{return deny("NATIVE_INPUT_MATERIALS_UNAVAILABLE")}
  if(!physical||typeof physical!=="object")return deny("NATIVE_INPUT_MATERIALS_UNAVAILABLE");
  for(const material of quote.materials){
   const typeID=pos(material?.typeID),qty=Number(material?.quantity);
   if(!typeID||!Number.isSafeInteger(qty)||qty<=0||
    Number(physical[typeID]||0)<qty)return deny("NATIVE_MATERIAL_QUANTITY_MISMATCH");
  }
  if([ACT.MANUFACTURING,ACT.REACTION].includes(activityID)){
   let products;
   try{products=getActivity(quote.definition,activityID)?.products}catch{return deny("PRODUCT_RECIPE_UNAVAILABLE")}
   if(!Array.isArray(products)||!products.length||
    !products.every(p=>pos(p.typeID)&&pos(p.quantity)))
    return deny("NATIVE_PRODUCT_RECIPE_MISSING");
   if(!quote.materials.length||quote.totalCost<=0)
    return deny("UNFUNDED_NATIVE_PRODUCT_QUOTE");
  }
  return {ok:true,kind:"INSTALL",ownerID,characterID:ctx.characterID,
   blueprintID:bpID,activityID,facilityID,runs,materials:quote.materials.map(x=>({
    typeID:pos(x.typeID),quantity:x.quantity})),cost:quote.totalCost,
   account:[ownerID,Number(account[1])],inputLocationID:pos(quote.inputLocation.itemID),
   inputFlagID:Number(quote.inputLocation.flagID),
   outputLocationID:pos(quote.outputLocation.itemID),
   outputFlagID:Number(quote.outputLocation.flagID),
   original:state.original===true};
 }
 function checkDeliver(session,jobID){
  const ctx=actor(session);if(!ctx.ok)return ctx;
  const id=pos(jobID);if(!id)return deny("INVALID_NATIVE_JOB_ID");
  let job,blueprint,state,item;
  try{
   job=getJobByID(id);
   if(job){blueprint=getBlueprintByItemID(job.blueprintID,session);
    state=getBlueprintState(job.blueprintID);item=getInventoryItem(job.blueprintID);}
  }catch{return deny("NATIVE_DELIVERY_STATE_UNAVAILABLE")}
  if(!job)return deny("NATIVE_INDUSTRY_JOB_MISSING");
  if(Number(job.status)!==STATUS.READY)return deny("NATIVE_INDUSTRY_JOB_NOT_READY");
  if(pos(job.jobID)!==id||!pos(job.ownerID)||!pos(job.installerID)||
   !pos(job.blueprintID)||!pos(job.facilityID)||!pos(job.runs))
   return deny("NATIVE_JOB_IDENTITY_INVALID");
  let now;
  try{now=BigInt(nowFiletime());}catch{return deny("NATIVE_FILETIME_UNAVAILABLE")}
  if(now<=0n||!(/^\d+$/.test(String(job.endDate)))||
   BigInt(job.endDate)>now||String(job.pauseDate||""))
   return deny("NATIVE_JOB_TIME_NOT_ELAPSED");
  const access=verifyOwner(session,job.ownerID,ctx,job.outputLocationID,job.outputFlagID,false);
  if(!access.ok)return access;
  if(!blueprint||pos(blueprint.itemID)!==pos(job.blueprintID)||
   pos(blueprint.ownerID)!==pos(job.ownerID)||!item||
   pos(item.ownerID)!==pos(job.ownerID)||
   pos(item.locationID)!==2003||!state||pos(state.jobID)!==id)
   return deny("NATIVE_INSTALLED_BLUEPRINT_CUSTODY_MISMATCH");
  if(![1,3,4,5,9].includes(Number(job.activityID)))
   return deny("NATIVE_DELIVERY_ACTIVITY_UNSUPPORTED");
  if([ACT.RESEARCH_TIME,ACT.RESEARCH_MATERIAL,ACT.COPYING,ACT.REACTION].includes(Number(job.activityID))&&
   state.original!==true)
   return deny("NATIVE_DELIVERY_BLUEPRINT_TYPE_MISMATCH");
  if(state.original!==true&&pos(job.runs)>Number(state.runsRemaining))
   return deny("NATIVE_DELIVERY_BPC_RUNS_EXCEEDED");
  if(!finite(job.totalCost)||job.totalCost<=0||
   !job.materials||typeof job.materials!=="object")
   return deny("NATIVE_PAID_JOB_EVIDENCE_MISSING");
  return {ok:true,kind:"DELIVER",jobID:id,characterID:ctx.characterID,
   ownerID:pos(job.ownerID),blueprintID:pos(job.blueprintID),
   activityID:Number(job.activityID),facilityID:pos(job.facilityID),
   outputLocationID:pos(job.outputLocationID),outputFlagID:Number(job.outputFlagID),
   runs:pos(job.runs),cost:job.totalCost};
 }
 function checkCancel(session,jobID){
  const ctx=actor(session);if(!ctx.ok)return ctx;
  const id=pos(jobID);if(!id)return deny("INVALID_NATIVE_CANCEL_JOB_ID");
  let job,item,state;
  try{
   job=getJobByID(id);
   if(job){
    item=getInventoryItem(job.blueprintID);
    state=getBlueprintState(job.blueprintID);
   }
  }catch{return deny("NATIVE_CANCEL_STATE_UNAVAILABLE")}
  if(!job||pos(job.jobID)!==id||!pos(job.ownerID)||
   !pos(job.blueprintID)||!pos(job.facilityID)||
   !pos(job.blueprintLocationID))
   return deny("NATIVE_CANCEL_JOB_IDENTITY_INVALID");
  // The stock native cancel implementation accepts completed jobs again.
  // Never let a replay restore a blueprint twice or rewrite terminal jobs.
  if(![STATUS.INSTALLED,STATUS.PAUSED,STATUS.READY].includes(Number(job.status)))
   return deny("NATIVE_CANCEL_JOB_NOT_ACTIVE");
  const access=verifyOwner(session,job.ownerID,ctx,
   job.blueprintLocationID,job.blueprintLocationFlagID,false);
  if(!access.ok)return access;
  if(!item||pos(item.itemID)!==pos(job.blueprintID)||
   pos(item.ownerID)!==pos(job.ownerID)||
   pos(item.locationID)!==2003||
   !state||pos(state.jobID)!==id)
   return deny("NATIVE_CANCEL_BLUEPRINT_NOT_INSTALLED");
  return {ok:true,kind:"CANCEL",jobID:id,ownerID:pos(job.ownerID),
   characterID:ctx.characterID,blueprintID:pos(job.blueprintID),
   activityID:Number(job.activityID),facilityID:pos(job.facilityID),
   blueprintLocationID:pos(job.blueprintLocationID),
   blueprintLocationFlagID:Number(job.blueprintLocationFlagID)};
 }
 return {checkInstall,checkDeliver,checkCancel,actor};
}
module.exports={makePlayerIndustryGuard,ACT,STATUS};
