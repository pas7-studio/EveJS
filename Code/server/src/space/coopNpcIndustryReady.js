"use strict";
// COOP-032F: proof-only materialization of native computed READY -> persisted READY.
// Does not shorten/forge endDate. No automatic scheduler; no live registration.
const SEP="\u001f",INSTALLED=1,READY=3,INSTALLED_LOCATION=2003;
const TABLES=Object.freeze(["industryJobs","items","industryBlueprintState"]);
const OP=/^npc-manufacture:[A-Za-z0-9_-]{8,90}$/;
const positive=x=>Number.isSafeInteger(x)&&x>0;
const filetime=ms=>BigInt(ms)*10000n+116444736000000000n;
function createNpcIndustryReadyProof({gameStore,verifyNativeOwner,verifyNativeOutput,clock=()=>Date.now()}={}){
 if(!gameStore||typeof gameStore.transact!=="function"||
    typeof verifyNativeOwner!=="function"||typeof verifyNativeOutput!=="function"||typeof clock!=="function")
   throw Error("VERIFIED_NATIVE_GAMESTORE_READINESS_DEPENDENCIES_REQUIRED");
 function markReadyOnce(operationID){
  if(process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1"||process.env.EVEJS_COOP_NATIVE_NPC_TX_PROOF!=="1")
   return {status:"BLOCKED",error:"NATIVE_NPC_SCOPE_PROOF_DISABLED"};
  if(typeof operationID!=="string"||!OP.test(operationID))
   return {status:"BLOCKED",error:"INVALID_OPERATION_ID"};
  try{
   return gameStore.transact(TABLES,tx=>{
    const candidates=tx.scan("industryJobs").filter(row=>row.key.startsWith("jobs"+SEP)&&row.value?.coopOperationID===operationID);
    if(candidates.length!==1)throw Error(candidates.length?"DUPLICATE_OPERATION_JOBS":"JOB_NOT_FOUND");
    const job=candidates[0].value,jobKey="jobs"+SEP+job.jobID;
    if(!positive(job.jobID)||candidates[0].key!==jobKey||
       job.coopOperationID!==operationID||job.activityID!==1||
       !positive(job.ownerID)||!positive(job.stationID)||job.facilityID!==job.stationID||
       !positive(job.blueprintID)||!positive(job.blueprintTypeID)||job.blueprintCopy!==false||
       !positive(job.productTypeID)||!positive(job.runs)||
       job.blueprintLocationID!==job.stationID||
       ![4,115].includes(job.blueprintLocationFlagID)||
       job.outputLocationID!==job.stationID||job.outputFlagID!==4||
       job.pauseDate!==null)throw Error("UNVERIFIED_NATIVE_JOB_IDENTITY");
    const now=clock();
    if(!Number.isSafeInteger(now)||now<=0)throw Error("INVALID_READINESS_CLOCK");
    if(typeof job.startDate!=="string"||!/^\d+$/.test(job.startDate)||
       typeof job.endDate!=="string"||!/^\d+$/.test(job.endDate))
       throw Error("NATIVE_JOB_FILETIME_INVALID");
    const start=BigInt(job.startDate),end=BigInt(job.endDate);
    if(start<=0n||end<=start)throw Error("NATIVE_JOB_FILETIME_INVALID");
    const nowFT=filetime(now);
    if(nowFT<end)throw Error("NATIVE_JOB_NOT_YET_READY");
    let quote;
    try{quote=JSON.parse(job.coopQuoteSignature)}catch{throw Error("UNVERIFIED_NATIVE_QUOTE")}
    const out=quote?.outputs?.length===1?quote.outputs[0]:null;
    if(!out||!positive(out.quantity)||out.typeID!==job.productTypeID||
       quote.ownerID!==job.ownerID||quote.facilityID!==job.stationID||
       quote.blueprintID!==job.blueprintID||quote.productTypeID!==job.productTypeID||
       quote.runs!==job.runs||quote.activityID!==1||
       quote.timeInSeconds!==job.timeInSeconds||
       typeof quote.timeInSeconds!=="number"||!positive(quote.timeInSeconds)||
       BigInt(quote.timeInSeconds)*10000000n!==end-start||
       verifyNativeOwner(job.ownerID,job.stationID)!==true||
       verifyNativeOutput(job,quote)!==true)
       throw Error("NATIVE_READINESS_AUTHORITY_REJECTED");
    const bp=tx.get("items",String(job.blueprintID));
    const state=tx.get("industryBlueprintState","records"+SEP+job.blueprintID);
    if(!bp||bp.itemID!==job.blueprintID||bp.typeID!==job.blueprintTypeID||
       bp.ownerID!==job.ownerID||bp.categoryID!==9||bp.singleton!==1||
       bp.locationID!==INSTALLED_LOCATION||bp.flagID!==job.blueprintLocationFlagID||
       !state||state.original!==true||state.jobID!==job.jobID||
       state.typeID!==job.blueprintTypeID)
      throw Error("NATIVE_READY_BLUEPRINT_CUSTODY_INVALID");
    if(job.status===READY)
      return {status:"ALREADY_READY",jobID:job.jobID,readyAt:job.coopReadyAt??null};
    if(job.status!==INSTALLED)throw Error("NATIVE_READY_STATUS_NOT_INSTALLED");
    const readyAt=String(nowFT);
    tx.put("industryJobs",jobKey,{...job,status:READY,coopReadyAt:readyAt});
    return {status:"READY",jobID:job.jobID,readyAt};
   });
  }catch(error){
   if(gameStore.isPoisoned?.()===true||error?.coopCommitOutcomeUnknown===true||
      /^NATIVE_GAMESTORE_COMMITTED_BUT_CACHE_UNSAFE/.test(String(error?.message)))throw error;
   return {status:"BLOCKED",error:String(error?.message||error)};
  }
 }
 return Object.freeze({mode:"MANUAL_ISOLATED_PROOF_ONLY",supportsNativeReadiness:false,markReadyOnce});
}
module.exports={createNpcIndustryReadyProof,TABLES};
