"use strict";
// FW-007B: conservative multi-durable-owner military transfer saga.
// EveJS scene/nativeStore, JSON pilot registry, and SQLite warship registry
// cannot commit atomically. An unresolved phase ALWAYS blocks further travel.
const {createWarTransferLedger}=require("./coopWarTransferLedger"+
 (__filename.endsWith(".js")?"":".cjs"));
const {createNativeGateTransfer}=require("./coopNativeGateTransfer"+
 (__filename.endsWith(".js")?"":".cjs"));
const pos=x=>Number.isSafeInteger(x)&&x>0;
const flag=env=>env.EVEJS_COOP_FACTION_WAR_NATIVE_TRANSFER==="1"&&
 env.EVEJS_COOP_FACTION_WAR_GATE_APPROACH==="1"&&
 env.EVEJS_COOP_FACTION_WAR==="1"&&
 env.EVEJS_COOP_FACTION_WAR_FLEETS==="1"&&
 env.EVEJS_COOP_WAR_TREASURY==="1"&&
 env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
 env.EVEJS_COOP_DURABLE_NPC_SHIPS==="1"&&
 env.EVEJS_COOP_NATIVE_GATE_APPROACH==="1"&&
 env.EVEJS_COOP_NATIVE_GATE_TRANSFER==="1"&&
 (env.EVEJS_COOP_ALIFE==="1"||env.EVEJS_COOP_NPC_ORDER_ARBITER==="1");
function createWarGateHandoff({gameStore,identityRegistry,sceneForSystem,
 getGate,nativeStore,service,getController,isScrambled,clock=()=>Date.now(),
 journalDir="/var/lib/evejs/coop-war-native-transfers",env=process.env,
 nativeTransferFactory=createNativeGateTransfer}={}){
 if(typeof identityRegistry?.relocate!=="function"||
  typeof identityRegistry.snapshot!=="function"||
  [sceneForSystem,getGate,getController,isScrambled,clock]
   .some(x=>typeof x!=="function")||
  typeof nativeTransferFactory!=="function"||
  !service||!nativeStore)throw Error("WAR_NATIVE_TRANSFER_AUTHORITIES_REQUIRED");
 // Only an absent original native journal permits a later hop. Any
 // orphan temp, symlink, unreadable directory or pending other transfer
 // makes this a repair case; it is NEVER interpreted as success.
 function journalClosed({pilotID}={}){
  if(!/^coop-pilot-[0-9]{3,}$/.test(String(pilotID)))return false;
  const fs=require("node:fs");
  try{
   const st=fs.lstatSync(journalDir);
   if(!st.isDirectory()||st.isSymbolicLink())return false;
   const names=fs.readdirSync(journalDir);
   if(names.length>500||
    names.some(n=>!/^coop-pilot-[0-9]{3,}\\.json$/.test(n)))return false;
   return !names.includes(pilotID+".json");
  }catch{return false}
 }
 const ledger=createWarTransferLedger({
  gameStore,identityRegistry,sceneForSystem,nativeStore,getController,clock,env,
  verifyJournalClosed:journalClosed
 });
 let active=null;
 const facade={
  snapshot:()=>identityRegistry.snapshot(),
  relocate(pilotID,from,entityID,to){
   if(!active||active.pilotID!==pilotID||
    active.entityID!==entityID||active.sourceSystemID!==from||
    active.destinationSystemID!==to)
    return {status:"WAR_HANDOFF_NOT_PREPARED"};
   const receipt={transferID:active.transferID,entityID};
   const commit=ledger.nativeCommit(receipt);
   if(commit.status!=="NATIVE_COMMITTED")
    throw Error("WAR_FLEET_SQL_RELOCATION_UNVERIFIED");
   const linked=identityRegistry.relocate(pilotID,from,entityID,to);
   if(linked?.status!=="RELOCATED")
    throw Error("WAR_PILOT_JSON_RELOCATION_UNVERIFIED");
   const complete=ledger.finish(receipt);
   if(complete.status!=="COMPLETE")
    throw Error("WAR_HANDOFF_COMPLETE_UNVERIFIED");
   return linked;
  }
 };
 const nativeTransfer=nativeTransferFactory({
  sceneForSystem,getGate,store:nativeStore,service,getController,
  registry:facade,journalDir,clock,isScrambled
 });
 function auditStartup(){
  if(!flag(env))return {status:"DISABLED"};
  // Never let the stock recovery roll back a ship whose military fleet
  // ledger may already have committed its destination. Require inspected
  // operator recovery rather than guessing a physical path after a crash.
  const pending=ledger.pending();
  if(pending.status!=="CLEAN")return pending;
  // COMPLETE in the SQL ledger is not enough to accept a crash recovery.
  // Verify persisted native controller, ship, cargo and pilot location first.
  const audit=ledger.auditPersisted();
  if(audit.status!=="CLEAN")return audit;
  // On startup the physical scenes may not yet have been restored.
  // Running stock rollback here could remove a correctly committed
  // destination hull. Audit the fsynced journal without mutating it.
  // Operator recovery must separately reconcile scene/SQL/JSON first.
  let names=[];
  try{names=require("node:fs").readdirSync(journalDir)}
  catch(e){if(e?.code!=="ENOENT")
   return {status:"NEEDS_OPERATOR_REPAIR",problems:["TRANSFER_JOURNAL_NOT_READABLE"]}}
  if(names.length)return {status:"NEEDS_OPERATOR_REPAIR",
   problems:["UNRESOLVED_NATIVE_TRANSFER_FILES"],count:names.length};
  return {status:"CLEAN"};
 }
 function transfer({pilotID,entityID,gate,sourceScene,ship,controller}={}){
  if(!flag(env))return {success:false,errorMsg:"WAR_HANDOFF_DISABLED"};
  if(active)return {success:false,errorMsg:"WAR_HANDOFF_ACTIVE"};
  const from=gate?.sourceSystemID,to=gate?.destinationSystemID;
  if(!pos(entityID)||!pos(from)||!pos(to)||from===to||
   !/^coop-pilot-[0-9]{3,}$/.test(String(pilotID))||
   sourceScene?.systemID!==from||ship?.itemID!==entityID||
   controller?.entityID!==entityID)
   return {success:false,errorMsg:"WAR_HANDOFF_INVALID_REQUEST"};
  // Old terminal handoff is archived only after a fresh, fully
  // consistent source/destination/pilot/cargo/journal witness.
  const previous=ledger.witness(entityID);
  if(previous.status==="VERIFIED"&&
   previous.action==="CLEANUP_JOURNAL"){
   if(previous.physicalSystemID!==from)
    return {success:false,errorMsg:"WAR_HANDOFF_OLD_DESTINATION_MISMATCH"};
   const retired=ledger.retire({
    entityID,transferID:previous.transferID});
   if(retired.status!=="RETIRED")
    return {success:false,errorMsg:retired.reason||
     "WAR_HANDOFF_PREVIOUS_TRANSFER_NOT_RETIRED"};
  }else if(previous.status!=="NO_ACTIVE_TRANSFER")
   return {success:false,errorMsg:"WAR_HANDOFF_PREVIOUS_STATE_UNVERIFIED"};
  const start=ledger.begin({entityID,
   sourceSystemID:from,destinationSystemID:to});
  if(start.status!=="PREPARED")
   return {success:false,errorMsg:start.reason||"WAR_HANDOFF_PREPARE_FAILED"};
  const transferID=start.transferID;
  if(typeof transferID!=="string")
   return {success:false,errorMsg:"WAR_HANDOFF_TRANSFER_ID_MISSING"};
  active={transferID,entityID,sourceSystemID:from,
   destinationSystemID:to,pilotID};
  let answer;
  try{answer=nativeTransfer.transfer({pilotID,entityID,gate,
   sourceScene,ship,controller});}
  catch{return {success:false,errorMsg:"WAR_NATIVE_TRANSFER_OUTCOME_UNKNOWN"}}
  finally{active=null}
  // All downstream acknowledgements must agree with the persisted SQL.
  if(answer?.success===true){
   try{
    const remains=ledger.pending();
    if(remains.status!=="CLEAN"||answer.entityID!==entityID||
     answer.systemID!==to||answer.verifiedSourceAbsent!==true||
     answer.verifiedDestinationPresent!==true||
     answer.preservedCargo!==true||answer.preservedModules!==true)
     return {success:false,errorMsg:"WAR_HANDOFF_COMPLETE_NOT_CONFIRMED"};
   }catch{return {success:false,errorMsg:"WAR_HANDOFF_STATE_UNAVAILABLE"}}
   return answer;
  }
  // Native transfer could have rolled back, or failed at preflight.
  // Only exact source physical + cargo + pilot proof can release a pending
  // fleet transfer. Else its SQL state remains a durable quarantine.
  try{
   const aborted=ledger.abort({transferID,entityID});
   if(aborted.status!=="ABORTED"){
    const restored=ledger.restore({transferID,entityID});
    if(restored.status!=="ABORTED")
     return {success:false,errorMsg:"WAR_HANDOFF_NEEDS_OPERATOR_REPAIR"};
   }
  }catch{return {success:false,errorMsg:"WAR_HANDOFF_NEEDS_OPERATOR_REPAIR"}}
  return {success:false,errorMsg:answer?.errorMsg||"WAR_NATIVE_TRANSFER_NOT_APPLIED"};
 }
 // On each EXISTING A-Life tick, archive only fully proven terminal
 // flights. A failed/corrupt/cargo-drifted flight is left quarantined for
 // authenticated recovery; it is NEVER auto-rolled-back or reissued.
 function retireCompleted({max=2}={}){
  if(!flag(env))return {status:"DISABLED",retired:[]};
  if(!Number.isSafeInteger(max)||max<1||max>4)
   return {status:"INVALID_LIMIT",retired:[]};
  let candidates;
  try{candidates=ledger.terminalCandidates()}
  catch{return {status:"NATIVE_SQL_UNAVAILABLE",retired:[]}}
  const retired=[],blocked=[];
  for(const row of candidates.slice(0,max)){
   let result;
   try{result=ledger.retire(row)}
   catch{return {status:"NATIVE_RETIRE_OUTCOME_UNKNOWN",retired,blocked}}
   if(result?.status==="RETIRED"){
    retired.push({entityID:row.entityID,transferID:row.transferID,
     historyCount:result.historyCount});
   }else blocked.push({entityID:row.entityID,
    reason:result?.reason||result?.status||"NOT_VERIFIED"});
  }
  return {status:blocked.length?"PARTIAL":"OBSERVED",retired,blocked};
 }
 function recovery({authorizeOperator,io}={}){
  if(typeof authorizeOperator!=="function")
   throw Error("WAR_RECOVERY_TRUSTED_OPERATOR_AUTH_REQUIRED");
  return require("./coopWarRecoveryConsole"+
   (__filename.endsWith(".js")?"":".cjs")).createWarRecoveryConsole({
    ledger,identityRegistry,authorizeOperator,journalDir,env,
    ...(io?{io}:{})
   });
 }
 return Object.freeze({transfer,auditStartup,pending:ledger.pending,
  retireCompleted,recovery});
}
module.exports={createWarGateHandoff,flag};
