"use strict";
// Native-only bridge to the COOP-032D/E/F transaction kernels. No auto scheduler.
// Source checkout stores .cjs; the pinned installer deploys siblings as .js.
const siblingSuffix=typeof __filename==="string"&&__filename.endsWith(".js")?"":".cjs";
const {createNpcIndustryScopedProof}=require("./coopNpcIndustryGameStoreScope"+siblingSuffix);
const {createNpcIndustryReadyProof}=require("./coopNpcIndustryReady"+siblingSuffix);
const pos=x=>Number.isSafeInteger(x)&&x>0;
// Read-only industry payment evidence must match canonical original wallet
// cents: rounding an existing journal amount would forge a paid witness.
const signedCents=x=>{
 if(typeof x!=="number"||!Number.isFinite(x))return null;
 const scaled=x*100,whole=Math.round(scaled);
 return Number.isSafeInteger(whole)&&Math.abs(scaled-whole)<=1e-6?
  whole:null;
};
const nonnegCents=x=>typeof x==="number"&&x>=0?signedCents(x):null;
function createNativeIndustryBindings({gameStore,itemStore,resolveCanonicalQuote,
 verifyNativeQuote,verifyNativeOwner,verifyNativeOutput,verifyNativeIdFloor,
 buildNativeOutputItem,clock=()=>Date.now()}={}){
 if(typeof gameStore?.read!=="function"||typeof gameStore?.coopAtomicNativeRows?.transact!=="function"||
  typeof itemStore?.findItemById!=="function"||
  [resolveCanonicalQuote,verifyNativeQuote,verifyNativeOwner,verifyNativeOutput,
   verifyNativeIdFloor,buildNativeOutputItem].some(fn=>typeof fn!=="function"))
  throw Error("NPC_INDUSTRY_NATIVE_BINDINGS_REQUIRED");
 const tx=gameStore.coopAtomicNativeRows;
 const scope=createNpcIndustryScopedProof({gameStore:tx,verifyNativeQuote,verifyNativeOwner,
  verifyNativeOutput,verifyNativeIdFloor,buildNativeOutputItem,clock});
 const readiness=createNpcIndustryReadyProof({gameStore:tx,verifyNativeOwner,verifyNativeOutput,clock});
 function read(table,key){const result=gameStore.read(table,key);
  if(result?.success!==true)throw Error("NATIVE_INDUSTRY_GAMESTORE_READ_FAILED:"+table+":"+key);
  return result.data;
 }
 function getJob(operationID){
  if(typeof operationID!=="string"||!/^npc-manufacture:[A-Za-z0-9_-]{8,90}$/.test(operationID))return null;
  const jobs=read("industryJobs","/jobs");
  if(!jobs||typeof jobs!=="object")throw Error("NATIVE_INDUSTRY_JOBS_MISSING");
  const matches=Object.entries(jobs).filter(([id,job])=>job?.coopOperationID===operationID);
  if(matches.length>1)throw Error("NATIVE_INDUSTRY_DUPLICATE_OPERATION");
  if(!matches.length)return null;
  const [id,job]=matches[0];
  if(!pos(job?.jobID)||String(job.jobID)!==id||!pos(job?.ownerID)||!pos(job?.blueprintID))
   throw Error("NATIVE_INDUSTRY_JOB_KEY_OR_OWNER_INVALID");
  return structuredClone(job);
 }
 function getItem(itemID){if(!pos(itemID))return null;
  const item=itemStore.findItemById(itemID);
  if(!item)return null;
  if(item.itemID!==itemID)throw Error("NATIVE_INDUSTRY_ITEM_ID_MISMATCH");
  return structuredClone(item);
 }
 function getIndustryDebit(jobID){
  if(!pos(jobID))return null;
  const jobs=read("industryJobs","/jobs");
  const job=jobs?.[String(jobID)];
  if(!job||job.jobID!==jobID||!pos(job.ownerID)||typeof job.coopOperationID!=="string")return null;
  const corp=read("corporationRuntime","/corporations/"+job.ownerID);
  const division=corp?.wallet?.divisions?.["1000"];
  if(corp?.corporationID!==job.ownerID||!Array.isArray(division?.transactions))return null;
  const matches=division.transactions.filter(row=>row?.transactionID===jobID);
  if(matches.length!==1)throw Error("NATIVE_INDUSTRY_DEBIT_DUPLICATE_OR_MISSING");
  const r=matches[0],expected=nonnegCents(job.totalCost),
   actual=signedCents(r.amount),balance=nonnegCents(r.balance);
  if(expected===null||actual===null||balance===null||
     r.entryTypeID!==10||r.ownerID1!==job.ownerID||
     r.referenceID!==jobID||r.accountKey!==1000||
     actual!==-expected)
   throw Error("NATIVE_INDUSTRY_DEBIT_MISMATCH");
  return {verifiedNative:true,jobID,ownerID:job.ownerID,amountCents:expected,
   transactionID:r.transactionID};
 }
 function quote(plan){const q=resolveCanonicalQuote(plan);
  if(!q||verifyNativeQuote(plan,q)!==true||verifyNativeOwner(plan.ownerID,plan.stationID)!==true)
   return null;
  return {...structuredClone(q),verifiedNative:true};
 }
 return Object.freeze({quote,getJob,getItem,getIndustryDebit,
  installOnce:(plan,q,id)=>scope.installOnce(plan,q,id),
  markReadyOnce:id=>readiness.markReadyOnce(id),deliverOnce:id=>scope.deliverOnce(id),
  mode:"MANUAL_NATIVE_GAMESTORE_ONLY",supportsLiveRuntime:false});
}
module.exports={createNativeIndustryBindings};
