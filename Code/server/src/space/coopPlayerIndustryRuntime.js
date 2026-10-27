"use strict";
// Native player industry RPC bridge. One EveJS industry writer, not an economy fork.
// At-most-once native action (unknown => operator repair); feature defaults OFF.
const path=require("node:path");

const DENIED="COOP_NATIVE_PLAYER_INDUSTRY_DENIED";
const SETTLED="NATIVE_INDUSTRY_OPERATION_SETTLED";
const pos=value=>Number.isSafeInteger(Number(value))&&Number(value)>0;

function createIndustryRuntime({guard,receipts,fence}={}){
 if(!guard||typeof guard.checkInstall!=="function"||
    typeof guard.checkDeliver!=="function"||
    typeof guard.checkCancel!=="function"||
    !receipts||typeof receipts.capture!=="function"||
    typeof receipts.verifyInstall!=="function"||
    typeof receipts.verifyDeliver!=="function"||
    typeof receipts.verifyCancel!=="function"||
    !fence||typeof fence.execute!=="function")
  throw Error("COOP_INDUSTRY_NATIVE_AUTHORITIES_REQUIRED");

 function run({session,request,jobID,nativeExecute,readPreviousJob,kind}={}){
  if(typeof nativeExecute!=="function")
   throw Error("COOP_INDUSTRY_NATIVE_CALLBACK_REQUIRED");
  const proof=kind==="INSTALL"?guard.checkInstall(session,request):
   kind==="DELIVER"?guard.checkDeliver(session,jobID):
   kind==="CANCEL"?guard.checkCancel(session,jobID):null;
  if(!proof||proof.ok!==true)
   throw Error(DENIED+":"+String(proof?.reason||"INVALID_OPERATION"));
  if(proof.kind!==kind||!pos(proof.characterID)||!pos(proof.ownerID))
   throw Error(DENIED+":INVALID_AUTHORITY_PROOF");
  let confirmedResult=null;
  const outcome=fence.execute({
   proof,
   captureNative:current=>receipts.capture(current),
   nativeExecute:()=>{
    confirmedResult=nativeExecute();
    return confirmedResult;
   },
   verifyNative:args=>kind==="INSTALL"?
    receipts.verifyInstall(args):kind==="DELIVER"?
    receipts.verifyDeliver(args):receipts.verifyCancel(args),
   readPreviousJob
  });
  if(outcome?.status!==SETTLED||
    confirmedResult?.success!==true)
   throw Error(DENIED+":"+String(outcome?.status||"UNKNOWN_NATIVE_RESULT"));
  // Return original native result to original EveJS payload builder, never
  // recompose items, money, blueprint or industry job records.
  if(kind==="INSTALL"&&(!pos(outcome.nativeJobID)||
    Number(confirmedResult?.data?.jobID)!==Number(outcome.nativeJobID)))
   throw Error(DENIED+":NATIVE_JOB_RECEIPT_MISMATCH");
  if(["DELIVER","CANCEL"].includes(kind)&&
    Number(outcome.nativeJobID)!==Number(jobID))
   throw Error(DENIED+":NATIVE_JOB_ACTION_RECEIPT_MISMATCH");
  return confirmedResult;
 }
 return Object.freeze({
  install:(session,request,nativeInstall,readPreviousJob)=>run({
   kind:"INSTALL",session,request,
   nativeExecute:()=>nativeInstall(session,request),readPreviousJob
  }),
  deliver:(session,jobID,nativeDeliver)=>run({
   kind:"DELIVER",session,jobID,
   nativeExecute:()=>nativeDeliver(session,jobID)
  }),
  cancel:(session,jobID,nativeCancel)=>run({
   kind:"CANCEL",session,jobID,
   nativeExecute:()=>nativeCancel(session,jobID)
  })
 });
}

let nativeRuntime=null;
let nativeRoot=null;
function native(){
 if(process.env.EVEJS_COOP_PLAYER_INDUSTRY_GUARD!=="1")
  throw Error(DENIED+":GUARD_NOT_ENABLED");
 const file=process.env.EVEJS_COOP_PLAYER_INDUSTRY_JOURNAL_FILE;
 if(!file||!path.isAbsolute(file)||file===path.parse(file).root||
    /(?:^|[\\/])(?:tmp|temp)(?:[\\/]|$)/i.test(file))
  throw Error(DENIED+":PERSISTENT_JOURNAL_PATH_REQUIRED");
 if(nativeRuntime){
  if(nativeRoot!==file)throw Error(DENIED+":JOURNAL_ROOT_CHANGED");
  return nativeRuntime;
 }
 // These are original EveJS stores and role/identity decisions. They remain
 // the only native item, wallet, facility, job and blueprint authorities.
 const industry=require("../services/industry/industryRuntimeState");
 const items=require("../services/inventory/itemStore");
 const sessions=require("../services/chat/sessionRegistry");
 const characters=require("../services/character/characterState");
 const wallets=require("../services/account/walletState");
 const corpWallets=require("../services/corporation/corpWalletState");
 const access=require("../services/industry/industryAccess");
 const statics=require("../services/industry/industryStaticData");
 const parity=require("../services/industry/industryParityHelpers");
 const serviceHelpers=require("../services/_shared/serviceHelpers");
 const {makePlayerIndustryGuard}=require("./coopPlayerIndustryGuard");
 const {makePlayerIndustryReceipts}=require("./coopPlayerIndustryReceipts");
 const {makePlayerIndustryFence}=require("./coopPlayerIndustryFence");
 const getWalletBalance=(ownerID,account)=>{
  if(!Array.isArray(account)||Number(account[0])!==Number(ownerID))
   throw Error("NATIVE_INDUSTRY_ACCOUNT_OWNER_MISMATCH");
  return characters.getCharacterRecord(ownerID)?
   wallets.getCharacterWallet(ownerID)?.balance:
   corpWallets.getCorporationWalletBalance(ownerID,account[1]);
 };
 const bindings={
  getSessions:sessions.getSessions,
  getCharacterRecord:characters.getCharacterRecord,
  getInventoryItem:items.findItemById,
  getBlueprintByItemID:industry.getBlueprintByItemID,
  getBlueprintState:industry.getBlueprintState,
  getJobByID:industry.getJobByID,
  quoteIndustryJob:industry.quoteIndustryJob,
  getAvailableMaterials:industry.resolveAvailableMaterials,
  hasCorporationIndustryJobAccess:access.hasCorporationIndustryJobAccess,
  canTakeFromOwnerLocation:access.canTakeFromOwnerLocation,
  canViewOwnerLocation:access.canViewOwnerLocation,
  canUseCorporationWallet:access.canUseCorporationWallet,
  getCharacterWallet:wallets.getCharacterWallet,
  getCorporationWalletBalance:corpWallets.getCorporationWalletBalance,
  getActivity:parity.getIndustryActivity,
  nowFiletime:serviceHelpers.currentFileTime,
  listContainerItems:items.listContainerItems,
  getWalletBalance,
  getBlueprintDefinitionByTypeID:statics.getBlueprintDefinitionByTypeID,
  getIndustryActivity:parity.getIndustryActivity
 };
 // Journal is opened only on first guarded RPC. Failed construction cannot
 // leave a partially enabled runtime that skips preflight.
 const guard=makePlayerIndustryGuard(bindings);
 const receipts=makePlayerIndustryReceipts(bindings);
 const fence=makePlayerIndustryFence({file});
 nativeRuntime=createIndustryRuntime({guard,receipts,fence});
 nativeRoot=file;
 return nativeRuntime;
}
function install({session,request,nativeInstall,readPreviousJob}={}){
 return native().install(session,request,nativeInstall,readPreviousJob);
}
function deliver({session,jobID,nativeDeliver}={}){
 return native().deliver(session,jobID,nativeDeliver);
}
function cancel({session,jobID,nativeCancel}={}){
 return native().cancel(session,jobID,nativeCancel);
}
module.exports={createIndustryRuntime,install,deliver,cancel};
