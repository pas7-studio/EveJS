"use strict";
/**
 * LW-04C2: manual, stage-at-a-time use of the ORIGINAL native GameStore
 * industry transaction kernels. This is NOT a live/A-Life director, market
 * authority, scheduler, or second persistent source of items/ISK.
 *
 * Only the existing GameStore-owned COOP-032D/E/F transactor can debit
 * native materials, BPO and corporation wallet, persist READY, or deliver
 * the ItemStore output. Production never mounts this executor automatically.
 */
const POS=v=>Number.isSafeInteger(v)&&v>0;
const ID=/^npc-manufacture:[0-9a-f]{32}$/;
const STAGES=new Set(["INSTALL","MARK_READY","DELIVER","INSPECT"]);
const blocked=(reason,stage,operationID)=>({status:"BLOCKED",reason,stage,
 operationID,nativeMutation:false});
function createOriginalManufacturingStageExecutor({
 native,env=process.env,assertOriginalGameStore,clock=()=>Date.now()
}={}){
 if(native?.mode!=="MANUAL_NATIVE_GAMESTORE_ONLY"||
    native.supportsLiveRuntime!==false||
    ["quote","installOnce","markReadyOnce","deliverOnce","getJob",
     "getItem","getIndustryDebit"].some(k=>typeof native?.[k]!=="function")||
    typeof assertOriginalGameStore!=="function"||typeof clock!=="function")
  throw Error("LW04C2_ORIGINAL_MANUAL_NATIVE_AUTHORITIES_REQUIRED");
 const inFlight=new Set(),quarantined=new Set();
 function enabled(){
  return env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
   env.EVEJS_COOP_NATIVE_NPC_TX_PROOF==="1"&&
   env.EVEJS_COOP_NATIVE_NPC_MANUAL_FACTORY_PROOF==="1"&&
   env.EVEJS_COOP_ALIFE_ECONOMY_ACT!=="1"&&
   env.EVEJS_COOP_NATIVE_NPC_ECONOMY_SCHEDULER!=="1"&&
   env.EVEJS_COOP_NATIVE_NPC_MARKET!=="1";
 }
 function safeRead(method,...args){
  const out=method(...args);
  if(out&&typeof out.then==="function")
   throw Error("LW04C2_ASYNC_GAMESTORE_AUTHORITY_UNSUPPORTED");
  return out;
 }
 function verifyJournal(job,ownerID,stationID,operationID){
  if(!job||!POS(job.jobID)||job.coopOperationID!==operationID||
     job.ownerID!==ownerID||job.stationID!==stationID||
     job.facilityID!==stationID||job.activityID!==1||
     !POS(job.blueprintID)||!POS(job.productTypeID)||
     ![1,2,3,4].includes(job.status))
   throw Error("LW04C2_ORIGINAL_JOB_IDENTITY_CHANGED");
  const debit=safeRead(native.getIndustryDebit,job.jobID);
  if(!debit||debit.verifiedNative!==true||debit.jobID!==job.jobID||
     debit.ownerID!==ownerID||!Number.isSafeInteger(debit.amountCents)||
     debit.amountCents<0||Number(job.totalCost)<0||
     Math.round(job.totalCost*100)!==debit.amountCents)
   throw Error("LW04C2_ORIGINAL_WALLET_DEBIT_NOT_ATTESTED");
  return job;
 }
 function inspect({ownerID,stationID,operationID}){
  const job=safeRead(native.getJob,operationID);
  if(!job)return {status:"NO_JOB",stage:"INSPECT",operationID,
   nativeMutation:false};
  verifyJournal(job,ownerID,stationID,operationID);
  if(job.status!==4)return {status:"ORIGINAL_JOB_ATTESTED",stage:"INSPECT",
   operationID,jobID:job.jobID,jobStatus:job.status,nativeMutation:false};
  const receipt=job.coopDelivery;
  if(!receipt||!POS(receipt.itemID)||!POS(receipt.quantity)||
     receipt.operationID!==operationID)
   throw Error("LW04C2_DELIVERY_RECEIPT_UNVERIFIED");
  const item=safeRead(native.getItem,receipt.itemID);
  // An already escrowed/sold output is not a duplicate production event,
  // but this manual executor must NOT guess it is still in the hangar.
  if(!item||item.itemID!==receipt.itemID||
     item.typeID!==job.productTypeID||item.ownerID!==ownerID||
     item.locationID!==stationID||item.flagID!==4||item.singleton!==0||
     item.quantity!==receipt.quantity||item.stacksize!==receipt.quantity||
     item.customInfo!=="coop-industry:v1:"+job.jobID)
   throw Error("LW04C2_ORIGINAL_OUTPUT_CUSTODY_UNVERIFIED");
  return {status:"ORIGINAL_DELIVERY_ATTESTED",stage:"INSPECT",
   operationID,jobID:job.jobID,itemID:item.itemID,
   quantity:item.quantity,nativeMutation:false};
 }
 function run({ownerID,stationID,operationID,stage,plan}={}){
  if(!POS(ownerID)||!POS(stationID)||!ID.test(operationID||"")||
     !STAGES.has(stage))return blocked("LW04C2_INVALID_ORIGINAL_REQUEST",stage,operationID);
  const key=ownerID+":"+stationID;
  if(stage!=="INSPECT"&&!enabled())
   return blocked("LW04C2_MANUAL_NATIVE_FINANCE_DISABLED",stage,operationID);
  if(inFlight.has(key))return blocked("LW04C2_ORIGINAL_STATION_BUSY",stage,operationID);
  if(quarantined.has(key))return blocked("LW04C2_STATION_QUARANTINED",stage,operationID);
  inFlight.add(key);
  try{
   // This witness must be supplied by the original GameStore owner and
   // confirm a quiescent, unpoisoned, single-writer in-process transactor.
   // A UI/virtual economy sensor, arbitrary SQLite handle or fake player
   // session is not a valid capability.
   const authority=safeRead(assertOriginalGameStore,{
    ownerID,stationID,operationID,stage,now:clock()});
   if(authority?.status!=="READY"||
      authority.singleWriter!==true||authority.unpoisoned!==true||
      authority.originalGameStore!==true)
    return blocked("LW04C2_NATIVE_GAMESTORE_NOT_QUIESCENT",stage,operationID);
   const job=safeRead(native.getJob,operationID);
   if(job){
    const before=inspect({ownerID,stationID,operationID});
    if(stage==="INSPECT")return before;
    if(stage==="INSTALL")return {...before,status:"ALREADY_INSTALLED",
     stage,nativeMutation:false};
    if(stage==="MARK_READY"){
     if(job.status===3||job.status===4)
      return {...before,status:"ALREADY_READY",stage,nativeMutation:false};
     if(job.status===2)return blocked("LW04C2_JOB_PAUSED",stage,operationID);
     if(job.status!==1)return blocked("LW04C2_JOB_NOT_INSTALLED",stage,operationID);
    }
    if(stage==="DELIVER"){
     if(job.status===4)return {...before,status:"ALREADY_DELIVERED",
      stage,nativeMutation:false};
     if(job.status!==3)return blocked("LW04C2_JOB_NOT_READY",stage,operationID);
    }
   }else{
    if(stage==="INSPECT")return {status:"NO_JOB",stage,operationID,nativeMutation:false};
    if(stage!=="INSTALL")return blocked("LW04C2_JOB_NOT_FOUND",stage,operationID);
    if(!plan||plan.ownerID!==ownerID||plan.stationID!==stationID||
       plan.facilityID!==stationID||!POS(plan.blueprintItemID)||
       !POS(plan.productTypeID)||!POS(plan.outputQuantity))
     return blocked("LW04C2_PLAN_SCOPE_INVALID",stage,operationID);
   }
   let outcome;
   if(stage==="INSTALL"){
    // Quote comes exclusively from the original EveJS/SDE pricing authority.
    // Client, A-Life and planner cannot provide or round a payment amount.
    const quote=safeRead(native.quote,plan);
    if(!quote||quote.verifiedNative!==true||
       quote.ownerID!==ownerID||quote.facilityID!==stationID||
       quote.blueprintID!==plan.blueprintItemID||
       quote.productTypeID!==plan.productTypeID)
     return blocked("LW04C2_ORIGINAL_QUOTE_UNVERIFIED",stage,operationID);
    outcome=safeRead(native.installOnce,plan,quote,operationID);
   }else if(stage==="MARK_READY")outcome=safeRead(native.markReadyOnce,operationID);
   else outcome=safeRead(native.deliverOnce,operationID);
   if(outcome?.status==="BLOCKED"&&
      !/OUTCOME_UNKNOWN|COMMITTED_BUT_CACHE_UNSAFE|POISONED/.test(
       String(outcome.error||outcome.reason||"")))
    return {...blocked("LW04C2_NATIVE_STAGE_REJECTED",stage,operationID),
     detail:String(outcome.error||outcome.reason||"REJECTED").slice(0,100)};
   if(!outcome||!["INSTALLED","ALREADY_INSTALLED","READY",
    "ALREADY_READY","DELIVERED","ALREADY_DELIVERED"].includes(outcome.status))
    throw Error("LW04C2_NATIVE_STAGE_OUTCOME_UNKNOWN");
   const after=inspect({ownerID,stationID,operationID});
   const expected=stage==="INSTALL"?[1,2,3,4]:
    stage==="MARK_READY"?[3,4]:[4];
   if(!expected.includes(safeRead(native.getJob,operationID)?.status))
    throw Error("LW04C2_NATIVE_READBACK_STATUS_INVALID");
   if(stage==="DELIVER"&&after.status!=="ORIGINAL_DELIVERY_ATTESTED")
    throw Error("LW04C2_DELIVERY_NOT_ATTESTED");
   return {status:outcome.status,stage,operationID,
    jobID:after.jobID,itemID:after.itemID||null,
    quantity:after.quantity||null,
    nativeMutation:["INSTALLED","READY","DELIVERED"].includes(outcome.status),
    proof:"ORIGINAL_GAMESTORE_AND_ITEMSTORE_READBACK_NOT_LIVE_E2E"};
  }catch(error){
   // An exception after the native kernel may mean COMMIT happened; never
   // retry it, mark the station unsafe until operator replay from source.
   quarantined.add(key);
   return {status:"NEEDS_OPERATOR_REPAIR",stage,operationID,
    reason:String(error?.message||error).slice(0,110),nativeMutation:false};
  }finally{inFlight.delete(key)}
 }
 return Object.freeze({run,
  inspect:scope=>run({...scope,stage:"INSPECT"}),
  status:()=>({quarantined:[...quarantined],active:[...inFlight]}),
  mode:"MANUAL_ORIGINAL_GAMESTORE_PROOF_ONLY",
  supportsLiveRuntime:false,supportsAutomaticAlife:false});
}
module.exports={createOriginalManufacturingStageExecutor};
