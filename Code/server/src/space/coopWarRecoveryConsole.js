"use strict";
// FW-007C: privileged in-process repair surface; NEVER expose to EveJS
// clients or let callers choose a file path or a destination system.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const pos=x=>Number.isSafeInteger(x)&&x>0;
const safeName=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
const hash=x=>crypto.createHash("sha256").update(x).digest("hex");
function createWarRecoveryConsole({ledger,identityRegistry,authorizeOperator,
 journalDir="/var/lib/evejs/coop-war-native-transfers",
 env=process.env,io=fs,clock=()=>Date.now()}={}){
 if(!ledger||["witness","nativeCommit","finish","abort","restore","recordRecoveryAttempt","retire"]
  .some(k=>typeof ledger[k]!=="function")||
  typeof identityRegistry?.relocate!=="function"||
  typeof authorizeOperator!=="function"||
  typeof clock!=="function"||typeof journalDir!=="string"||
  !path.isAbsolute(journalDir)||
  ["lstatSync","readFileSync","readdirSync","renameSync","mkdirSync",
   "openSync","fsyncSync","closeSync"].some(k=>typeof io[k]!=="function"))
  throw Error("WAR_RECOVERY_PRIVILEGED_DEPENDENCIES_REQUIRED");
 let busy=false;
 const enabled=()=>env.EVEJS_COOP_WAR_RECOVERY_ADMIN==="1"&&
  env.EVEJS_COOP_FACTION_WAR_NATIVE_TRANSFER==="1"&&
  env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1";
 function permit(operator,permission,entityID,action){
  if(!operator||!pos(entityID))return false;
  try{
   // A trusted server caller MUST bind operator to an authenticated
   // admin identity. A self-reported character name is never sufficient.
   return authorizeOperator({operator,permission,entityID,action})===true;
  }catch{return false}
 }
 function journal(w){
  if(!safeName(w?.pilotID))return {status:"UNSAFE",reason:"PILOT_FILENAME_INVALID"};
  try{
   const dir=io.lstatSync(journalDir);
   if(!dir.isDirectory()||dir.isSymbolicLink())
    return {status:"UNSAFE",reason:"JOURNAL_DIRECTORY_UNSAFE"};
   const names=io.readdirSync(journalDir);
   if(names.length>500||names.some(n=>!/^coop-pilot-[0-9]{3,}\.json$/.test(n)))
    return {status:"UNSAFE",reason:"UNKNOWN_OR_PARTIAL_JOURNAL_FILES"};
   const file=path.join(journalDir,w.pilotID+".json");
   if(!names.includes(w.pilotID+".json"))return {status:"ABSENT",hash:"none"};
   const stat=io.lstatSync(file);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)
    return {status:"UNSAFE",reason:"JOURNAL_FILE_UNSAFE"};
   const raw=io.readFileSync(file,"utf8"),entry=JSON.parse(raw);
   if(entry?.version!==1||entry.pilotID!==w.pilotID||
    entry.entityID!==w.entityID||
    entry.sourceSystemID!==w.sourceSystemID||
    entry.destinationSystemID!==w.destinationSystemID||
    !["PREPARED","SOURCE_REMOVED","DESTINATION_RECORDS_WRITTEN",
     "COMMITTED","NEEDS_OPERATOR_REPAIR"].includes(entry.phase))
    return {status:"UNSAFE",reason:"JOURNAL_WITNESS_MISMATCH"};
   return {status:"PRESENT",hash:hash(raw),file,phase:entry.phase};
  }catch(e){
   if(e?.code==="ENOENT")return {status:"ABSENT",hash:"none"};
   return {status:"UNSAFE",reason:"JOURNAL_NOT_READABLE"};
  }
 }
 function inspectInternal(id){
  let w;
  try{w=ledger.witness(id)}
  catch{return {status:"UNSAFE",reason:"WITNESS_EVALUATION_FAILED"}}
  if(w?.status==="NO_ACTIVE_TRANSFER")return {status:"CLEAN",entityID:id};
  if(w?.status!=="VERIFIED")return {status:"UNSAFE",
   reason:w?.reason||w?.status||"WITNESS_UNAVAILABLE"};
  const j=journal(w);
  if(j.status==="UNSAFE")return {status:"UNSAFE",reason:j.reason};
  // A closed native journal is NOT permission to erase transfer
  // evidence. Retire the terminal SQL record into permanent bounded
  // history as a separate explicit, audited action.
  const action=w.action==="CLEANUP_JOURNAL"&&j.status==="ABSENT"?
   "RETIRE_TRANSFER":w.action;
  const normalized={entityID:w.entityID,transferID:w.transferID,pilotID:w.pilotID,
   phase:w.phase,rowSystemID:w.rowSystemID,physicalSystemID:w.physicalSystemID,
   pilotSystemID:w.pilotSystemID,sourceSystemID:w.sourceSystemID,
   destinationSystemID:w.destinationSystemID,modulesHash:w.modulesHash,
   cargoHash:w.cargoHash,updatedAt:w.updatedAt,
   journalHash:j.hash,journalStatus:j.status,journalPhase:j.phase||null};
  return {status:"REVIEW_REQUIRED",action,...normalized,
   witness:hash(JSON.stringify(normalized))};
 }
 function review({entityID,operator}={}){
  if(!enabled())return {status:"DISABLED"};
  if(!permit(operator,"INSPECT",entityID,"INSPECT"))
   return {status:"FORBIDDEN"};
  return inspectInternal(entityID);
 }
 function archive(w,stamp){
  const j=journal(w);
  if(j.status!=="PRESENT")return {status:"BLOCKED",reason:"JOURNAL_NO_LONGER_PRESENT"};
  const destinationDir=journalDir+".recovered";
  try{
   io.mkdirSync(destinationDir,{recursive:true});
   const destStat=io.lstatSync(destinationDir);
   if(!destStat.isDirectory()||destStat.isSymbolicLink())
    return {status:"BLOCKED",reason:"RECOVERY_ARCHIVE_UNSAFE"};
   const dest=path.join(destinationDir,w.pilotID+"."+stamp+"."+j.hash.slice(0,16)+".json");
   try{io.lstatSync(dest);return {status:"BLOCKED",reason:"ARCHIVE_DESTINATION_EXISTS"}}
   catch(e){if(e?.code!=="ENOENT")throw e}
   io.renameSync(j.file,dest);
   for(const dir of [journalDir,destinationDir]){
    const fd=io.openSync(dir,"r");
    try{io.fsyncSync(fd)}finally{io.closeSync(fd)}
   }
   return {status:"ARCHIVED",archiveName:path.basename(dest)};
  }catch{return {status:"NEEDS_OPERATOR_REPAIR",reason:"JOURNAL_ARCHIVE_OUTCOME_UNCERTAIN"}}
 }
 function apply({entityID,operator,action,expectedWitness,reason}={}){
  if(!enabled())return {status:"DISABLED"};
  if(!pos(entityID)||typeof expectedWitness!=="string"||
   !/^[0-9a-f]{64}$/.test(expectedWitness)||
   typeof reason!=="string"||reason.trim().length<12||
   reason.length>240)return {status:"INVALID_REPAIR_REQUEST"};
  if(!permit(operator,"APPLY",entityID,action))return {status:"FORBIDDEN"};
  if(busy)return {status:"REPAIR_IN_PROGRESS"};
  busy=true;
  try{
   const w=inspectInternal(entityID);
   if(w.status!=="REVIEW_REQUIRED"||w.action!==action||
    w.witness!==expectedWitness)
    return {status:"STALE_OR_UNSAFE_REPAIR_WITNESS",observation:w.status};
   // No destination, fleet, pilot or cargo fields are accepted from the
   // caller: all mutation arguments derive from the fresh native witness.
   const req={entityID,transferID:w.transferID};
   // Durable native fleet audit is required before any SQL/JSON/FS
   // mutation. This cannot be a best-effort post-action console log.
   let audit;
   try{
    audit=ledger.recordRecoveryAttempt({
     ...req,action,witnessHash:expectedWitness,
     principalID:operator?.principalID,reason:reason.trim()
    });
   }catch{return {status:"AUDIT_OUTCOME_UNKNOWN_RECHECK_REQUIRED"}}
   if(!["RECORDED","ALREADY_RECORDED"].includes(audit?.status))
    return {status:"AUDIT_REQUIRED",reason:audit?.reason||audit?.status};
   let result;
   try{
    if(action==="ABORT")result=ledger.abort(req);
    else if(action==="NATIVE_COMMIT")result=ledger.nativeCommit(req);
    else if(action==="FINISH")result=ledger.finish(req);
    else if(action==="RESTORE")result=ledger.restore(req);
    else if(action==="RETIRE_TRANSFER")result=ledger.retire(req);
    else if(action==="RELOCATE_PILOT")
     result=identityRegistry.relocate(
      // Pilot identity must come from a re-read native witness, not request.
      w.pilotID,w.sourceSystemID,entityID,w.destinationSystemID);
    else if(action==="CLEANUP_JOURNAL")
     result=archive(w,clock());
    else return {status:"INVALID_REPAIR_ACTION"};
   }catch{return {status:"OUTCOME_UNKNOWN_RECHECK_REQUIRED"}}
   if(action==="RELOCATE_PILOT"&&result?.status!=="RELOCATED")
    return {status:"BLOCKED",reason:result?.status||"IDENTITY_RELOCATION_FAILED"};
   if(action==="CLEANUP_JOURNAL"&&result?.status!=="ARCHIVED")
    return result||{status:"OUTCOME_UNKNOWN_RECHECK_REQUIRED"};
   const expected={ABORT:"ABORTED",RESTORE:"ABORTED",
    NATIVE_COMMIT:"NATIVE_COMMITTED",FINISH:"COMPLETE",
    RELOCATE_PILOT:"RELOCATED",CLEANUP_JOURNAL:"ARCHIVED",
    RETIRE_TRANSFER:"RETIRED"}[action];
   if(result?.status!==expected)
    return {status:"BLOCKED",reason:result?.reason||result?.status||"REPAIR_REJECTED"};
   const after=inspectInternal(entityID);
   return {status:"REPAIR_STEP_APPLIED",action,entityID,
    nextStatus:after.status,nextAction:after.action||null,
    audit:{reason:reason.trim(),at:clock(),witness:expectedWitness}};
  }finally{busy=false}
 }
 return Object.freeze({review,apply});
}
module.exports={createWarRecoveryConsole};
