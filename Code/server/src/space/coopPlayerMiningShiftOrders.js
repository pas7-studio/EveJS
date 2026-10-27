"use strict";
/**
 * CH24+31 Stage B: no new scheduler. The *original* miningNpcOperations tick
 * is the sole ship/asteroid/hauling executor; this module gates its tick with
 * a funded, native GameStore-backed corporation directive.
 *
 * DISPATCH_UNKNOWN is a permanent fence until operator recovery. A native
 * order acknowledgement never proves asteroid depletion, delivery or income.
 */
const SEP="\u001f";
const CORP=id=>"corporations"+SEP+id;
const CONTRACT=id=>"coopPlayerMiningShift"+SEP+id;
const FLEET_INDEX=(systemID,fleetID)=>"coopPlayerMiningFleet"+SEP+systemID+":"+fleetID;
const TABLES=["corporationRuntime"];
const COMMANDS=new Set(["MINE","HAUL","HOLD","RETREAT"]);
const VALID_STATES=new Set(["IDLE","PENDING","ISSUING","NATIVE_REQUESTED","NATIVE_COMPLETED","DISPATCH_UNKNOWN"]);
const pos=x=>Number.isSafeInteger(x)&&x>0;
const sameIDs=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&
 a.every((x,i)=>pos(x)&&x===b[i])&&new Set(a).size===a.length;
const sameFleet=(row,fleet)=>row&&fleet&&row.systemID===fleet.systemID&&
 row.fleetID===fleet.fleetID&&row.employerCorpID===fleet.ownerID&&
 sameIDs(row.minerIDs,fleet.minerIDs)&&sameIDs(row.haulerIDs,fleet.haulerIDs);
const blocked=(reason,skipNativeTick=false)=>({status:"BLOCKED",reason,skipNativeTick,nativeMutation:false});
function createShiftOrders({gameStore,access,getFleet,verifyNativeFleet,
 clock=()=>Date.now(),enabled=()=>false,observe=()=>{},
 completionEnabled=()=>false,captureHaul=()=>null,
 captureRetreat=()=>null,verifyCompletion=()=>null}={}){
 if(typeof gameStore?.read!=="function"||
    gameStore?.coopAtomicNativeRows?.mode!=="SERVER_INTERNAL_FLAGGED"||
    typeof gameStore.coopAtomicNativeRows.transact!=="function"||
    typeof gameStore.coopAtomicNativeRows.isPoisoned!=="function"||
    [access?.isMember,access?.canIndustry,getFleet,verifyNativeFleet,clock,enabled,observe,
     completionEnabled,captureHaul,captureRetreat,verifyCompletion]
     .some(x=>typeof x!=="function"))
   throw Error("PLAYER_MINING_ORDERS_AUTHORITIES_REQUIRED");
 const atomic=gameStore.coopAtomicNativeRows;
 function txDo(action){return atomic.transact(TABLES,action);}
 // Native GameStore read-only access avoids BEGIN IMMEDIATE + PRAGMA FULL on
 // every stock NPC think (including fleets with no corporate shift). Writes
 // still use the original guarded atomic GameStore transaction exclusively.
 function readOnly(path){
  const result=gameStore.read("corporationRuntime",path);
  if(result?.success===true&&result.data!=null)return result.data;
  if(result?.errorMsg==="ENTRY_NOT_FOUND")return null;
  throw Error("MINING_SHIFT_NATIVE_READ_UNAVAILABLE");
 }
 function lookup(systemID,fleetID){
  if(!pos(systemID)||!pos(fleetID))throw Error("MINING_SHIFT_INVALID_FLEET_REFERENCE");
  const index=readOnly("/coopPlayerMiningFleet/"+systemID+":"+fleetID);
  if(!index)return null;
  if(index.version!==1||!pos(index.corporationID)||!pos(index.employerCorpID)||
     index.systemID!==systemID||index.fleetID!==fleetID||
     typeof index.operationID!=="string"||
     !/^coop-mining-shift:[0-9a-f]{32}$/.test(index.operationID))
   throw Error("MINING_SHIFT_INDEX_CORRUPT");
  const row=readOnly("/coopPlayerMiningShift/"+index.operationID);
  if(!row||row.version!==1||row.status!=="FUNDED"||
     row.operationID!==index.operationID||row.corporationID!==index.corporationID||
     row.employerCorpID!==index.employerCorpID||row.systemID!==systemID||
     row.fleetID!==fleetID||!COMMANDS.has(row.directive)||
     !VALID_STATES.has(row.commandState)||!Number.isSafeInteger(row.commandSeq)||
     row.commandSeq<0||row.commandSeq>1000000)
   throw Error("MINING_SHIFT_BINDING_CORRUPT");
  return structuredClone(row);
 }
 function assign({session,corporationID,systemID,fleetID,operationID,command,expectedSeq}={}){
  if(enabled()!==true)return blocked("MINING_COMPANY_DISABLED");
  if(!pos(corporationID)||!pos(systemID)||!pos(fleetID)||
    typeof operationID!=="string"||!COMMANDS.has(command)||
    !Number.isSafeInteger(expectedSeq)||expectedSeq<0)
    return blocked("INVALID_NATIVE_SHIFT_COMMAND");
  const authorized=()=>access.isMember(session,corporationID)===true&&
   access.canIndustry(session,corporationID)===true;
  if(!authorized())return blocked("NATIVE_CORPORATION_PERMISSION_DENIED");
  if(atomic.isPoisoned())return blocked("NATIVE_ATOMIC_STORE_POISONED",true);
  try{
   const fleet=getFleet({systemID,fleetID});
   if(!fleet||verifyNativeFleet(fleet)!==true)
    return blocked("PHYSICAL_NATIVE_FLEET_UNVERIFIED",true);
   return txDo(tx=>{
    if(!authorized())throw Error("NATIVE_CORPORATION_PERMISSION_REVOKED");
    const index=tx.get("corporationRuntime",FLEET_INDEX(systemID,fleetID));
    const row=tx.get("corporationRuntime",CONTRACT(operationID));
    if(index?.operationID!==operationID||!sameFleet(row,fleet)||
      row.corporationID!==corporationID||row.status!=="FUNDED")
      throw Error("MINING_SHIFT_CUSTODY_MISMATCH");
    if(!COMMANDS.has(row.directive)||!VALID_STATES.has(row.commandState))
      throw Error("MINING_SHIFT_COMMAND_RECORD_CORRUPT");
    if(row.commandSeq!==expectedSeq)throw Error("MINING_SHIFT_STALE_COMMAND_SEQUENCE");
    if(row.commandState==="ISSUING"||row.commandState==="DISPATCH_UNKNOWN")
      throw Error("MINING_SHIFT_PENDING_NATIVE_OUTCOME");
    if(row.commandState==="PENDING")
      throw Error("MINING_SHIFT_PREVIOUS_COMMAND_PENDING");
    // Unknown completion of a real HAUL/RETREAT must never be overwritten.
    // No second order can be issued until an independent original-native
    // arrival/recovery receipt is introduced in a later stage.
    if(row.commandState==="NATIVE_REQUESTED"&&
       ["HAUL","RETREAT"].includes(row.directive)&&row.directive!==command)
      throw Error("MINING_SHIFT_PREVIOUS_NATIVE_ORDER_ACTIVE");
    const nativePhase=fleet.state;
    if(["hauling","loaded","haulereturn"].includes(nativePhase)&&
       command!=="HOLD")
      throw Error("MINING_SHIFT_PHYSICAL_CARGO_TRANSIT_ACTIVE");
    if(command==="HAUL"&&nativePhase!=="mining")
      throw Error("MINING_SHIFT_HAUL_NOT_READY_IN_NATIVE_PHASE");
    if(command==="RETREAT"&&
       !["mining","coop-hold","aggressed","panic"].includes(nativePhase))
      throw Error("MINING_SHIFT_RETREAT_NOT_SAFE_IN_NATIVE_PHASE");
    if(command==="MINE"&&row.directive==="HOLD"&&
       row.commandState==="NATIVE_REQUESTED"&&nativePhase!=="coop-hold")
      throw Error("MINING_SHIFT_HOLD_NOT_YET_PHYSICALLY_ENFORCED");
    if(row.directive===command&&row.commandState!=="IDLE")
      return {status:"ALREADY_ORDERED",command,commandSeq:row.commandSeq};
    const next={...row,directive:command,commandSeq:row.commandSeq+1,
     commandState:"PENDING",commandAt:clock(),requestedByCharacterID:session.characterID};
    if(!pos(next.commandAt))throw Error("MINING_SHIFT_CLOCK_INVALID");
    tx.put("corporationRuntime",CONTRACT(operationID),next);
    return {status:"ORDER_QUEUED",command,commandSeq:next.commandSeq,
     nativeMutation:false};
   });
  }catch(error){return blocked(String(error?.message||error).slice(0,120),true);}
 }
 function dispatch({fleet,native}={}){
  if(enabled()!==true)return {status:"DISABLED",skipNativeTick:false,nativeMutation:false};
  if(!pos(fleet?.systemID)||!pos(fleet?.fleetID)||!native||
     ["deactivate","startHaul","retreat","canResume","hasOriginalMinerCargo"].some(k=>typeof native[k]!=="function"))
    return blocked("MINING_SHIFT_DISPATCH_DEPENDENCIES",true);
  if(atomic.isPoisoned())return blocked("NATIVE_ATOMIC_STORE_POISONED",true);
  let row;
  try{row=lookup(fleet.systemID,fleet.fleetID)}
  catch(error){return blocked(String(error?.message||error).slice(0,120),true);}
  if(!row)return {status:"UNCONTRACTED",skipNativeTick:false,nativeMutation:false};
  if(!sameFleet(row,fleet)||verifyNativeFleet(fleet)!==true)
   return blocked("MINING_SHIFT_NATIVE_FLEET_CHANGED",true);
  if(row.commandState==="ISSUING"||row.commandState==="DISPATCH_UNKNOWN")
   return blocked("MINING_SHIFT_NATIVE_OUTCOME_UNKNOWN",true);
  const phase=fleet.state;
  const safetyTransit=["hauling","loaded","haulereturn"].includes(phase);
  // The native aggression/response phase always owns a threatened fleet.
  // Peaceful company commands cannot cancel an already-active NPC defense.
  if(["aggressed","panic"].includes(phase)&&row.directive!=="RETREAT")
   return {status:"NATIVE_COMBAT_PRIORITY",skipNativeTick:false,nativeMutation:false};
  const skip=(status,nativeMutation=false)=>({status,command:row.directive,
   commandSeq:row.commandSeq,skipNativeTick:true,nativeMutation});
  if(row.commandState==="IDLE")return {status:"NATIVE_MINING_UNMODIFIED",
   skipNativeTick:false,nativeMutation:false};
  if(row.commandState==="NATIVE_REQUESTED"&&completionEnabled()===true&&
     ["HAUL","RETREAT"].includes(row.directive)){
   let evidence=null;
   try{evidence=verifyCompletion({row,fleet});}catch{}
   if(evidence&&evidence.version===1&&evidence.commandSeq===row.commandSeq&&
      evidence.kind===(row.directive==="HAUL"?
       "ORIGINAL_WAREHOUSE_DELIVERY":"ORIGINAL_FLEET_WARP_ARRIVED")){
    try{
     const now=clock();
     if(!pos(now))throw Error("MINING_SHIFT_COMPLETION_CLOCK_INVALID");
     const completed=txDo(tx=>{
      const current=tx.get("corporationRuntime",CONTRACT(row.operationID));
      if(!current||current.commandSeq!==row.commandSeq||
        current.directive!==row.directive||
        current.commandState!=="NATIVE_REQUESTED"||
        !sameFleet(current,fleet))
       throw Error("MINING_SHIFT_COMPLETION_CAS_CHANGED");
      tx.put("corporationRuntime",CONTRACT(row.operationID),{
       ...current,commandState:"NATIVE_COMPLETED",
       completedAt:now,completionProof:structuredClone(evidence)});
      return {status:"NATIVE_COMPLETED",skipNativeTick:false,
       command:row.directive,commandSeq:row.commandSeq,
       nativeMutation:false,completionProof:evidence.kind};
     });
     try{observe("player-mining-native-completed",{
      status:"NATIVE_COMPLETED",operationID:row.operationID,
      systemID:row.systemID,fleetID:row.fleetID,
      command:row.directive,proof:evidence.kind});}catch{}
     return completed;
    }catch{return blocked("MINING_SHIFT_COMPLETION_COMMIT_UNCERTAIN",true);}
   }
  }
  if(row.commandState==="NATIVE_COMPLETED")
   return {status:"NATIVE_COMPLETION_PREVIOUSLY_PROVEN",
    skipNativeTick:false,nativeMutation:false};
  if(row.commandState==="NATIVE_REQUESTED"){
   if(row.directive==="HOLD"){
    if(safetyTransit)return {status:"SAFE_HAUL_COMPLETION_PENDING",skipNativeTick:false,nativeMutation:false};
    try{
     if(native.deactivate()!==true)return blocked("NATIVE_MINING_STOP_NOT_PROVEN",true);
     fleet.state="coop-hold";
    }catch{return blocked("NATIVE_MINING_STOP_UNKNOWN",true);}
    return skip("HOLD_ENFORCED");
   }
   // A successfully REQUESTED native haul/retreat is NEVER retried by a
   // resurrected runtime; the native cargo/trip recovery owns continuation.
   return {status:"NATIVE_ORDER_PREVIOUSLY_REQUESTED",
    skipNativeTick:row.directive==="RETREAT"||phase==="coop-hold",
    nativeMutation:false};
  }
  if(row.commandState!=="PENDING")return blocked("MINING_SHIFT_COMMAND_STATE_INVALID",true);
  // Safe completion of already-started custody transitions wins over new
  // HOLD/HAUL/MINE; do not stop midway through the existing native haul.
  if(safetyTransit&&row.directive!=="RETREAT")
   return {status:"SAFE_HAUL_COMPLETION_PENDING",skipNativeTick:false,nativeMutation:false};
  if(row.directive==="HAUL"){
   if(phase!=="mining")return blocked("MINING_SHIFT_NOT_READY_FOR_HAUL",false);
   if(native.hasOriginalMinerCargo()!==true)
    return {status:"WAITING_FOR_ORIGINAL_MINER_CARGO",skipNativeTick:false,nativeMutation:false};
  }
  if(row.directive==="MINE"&&phase!=="mining"&&native.canResume()!==true)
   return blocked("MINING_SHIFT_RESUME_NOT_SAFE",true);
  // Capture immutable ORIGINAL physical cargo IDs and original retreat
  // destination BEFORE requesting any native movement. Without these
  // witnesses later return-time/position checks could clear a foreign trip.
  let originalCargo=null,retreatAnchor=null,retreatDepartureShipIDs=null;
  if(completionEnabled()===true){
   try{
    if(row.directive==="HAUL")originalCargo=captureHaul({fleet});
    if(row.directive==="RETREAT"){
     const departure=captureRetreat({fleet});
     retreatAnchor=departure?.origin;
     retreatDepartureShipIDs=departure?.departureShipIDs;
    }
   }catch{return blocked("MINING_SHIFT_COMPLETION_SOURCE_UNAVAILABLE",true);}
   if(row.directive==="HAUL"&&(!Array.isArray(originalCargo)||
     originalCargo.length===0||originalCargo.length>256))
    return blocked("MINING_SHIFT_SOURCE_CARGO_NOT_ATTESTED",true);
   if(row.directive==="RETREAT"&&(!retreatAnchor||
     !Array.isArray(retreatDepartureShipIDs)||
     retreatDepartureShipIDs.length===0||
     !["x","y","z"].every(k=>typeof retreatAnchor[k]==="number"&&
      Number.isFinite(retreatAnchor[k]))))
    return blocked("MINING_SHIFT_RETREAT_ORIGIN_NOT_ATTESTED",true);
  }
  // Durable intent must be committed BEFORE the first native command. If
  // the process dies after this point we never fire the command a second time.
  try{
   txDo(tx=>{
    const current=tx.get("corporationRuntime",CONTRACT(row.operationID));
    if(!current||current.commandSeq!==row.commandSeq||current.directive!==row.directive||
      current.commandState!=="PENDING")throw Error("MINING_SHIFT_COMMAND_CHANGED");
    tx.put("corporationRuntime",CONTRACT(row.operationID),{
      ...current,commandState:"ISSUING",issuedAt:clock(),
      ...(originalCargo?{originalCargo:structuredClone(originalCargo)}:{}),
      ...(retreatAnchor?{retreatAnchor:{...retreatAnchor},
       retreatDepartureShipIDs:[...retreatDepartureShipIDs]}:{})});
   });
  }catch(error){return blocked("MINING_SHIFT_COMMAND_FENCE_FAILED:"+String(error?.message||error).slice(0,65),true);}
  let accepted=false,uncertain=false;
  try{
   if(row.directive==="HOLD"){
    accepted=native.deactivate()===true;
    if(accepted)fleet.state="coop-hold";
   }else if(row.directive==="MINE"){
    fleet.state="mining";fleet.nextThinkAtMs=0;accepted=true;
   }else if(row.directive==="HAUL"){
    accepted=native.startHaul()===true;
   }else if(row.directive==="RETREAT"){
    // Original native retreat issues warp, deactivates miners and retains
    // the same ships/cargo. Count is an ATTEMPT witness, not landing proof.
    accepted=native.retreat()===row.minerIDs.length+row.haulerIDs.length;
   }
  }catch{uncertain=true;}
  let resultStatus="DISPATCH_UNKNOWN";
  try{
   txDo(tx=>{
    const current=tx.get("corporationRuntime",CONTRACT(row.operationID));
    if(!current||current.commandSeq!==row.commandSeq||current.commandState!=="ISSUING")
      throw Error("MINING_SHIFT_ISSUE_RECEIPT_CHANGED");
    resultStatus=!uncertain&&accepted?"NATIVE_REQUESTED":"DISPATCH_UNKNOWN";
    tx.put("corporationRuntime",CONTRACT(row.operationID),{
     ...current,commandState:resultStatus,nativeRequestedAt:clock()});
   });
  }catch{return blocked("MINING_SHIFT_NATIVE_OUTCOME_UNKNOWN",true);}
  try{observe("player-mining-shift-dispatch",{operationID:row.operationID,
   systemID:row.systemID,fleetID:row.fleetID,command:row.directive,
   status:resultStatus});}catch{}
  if(resultStatus!=="NATIVE_REQUESTED")return blocked("MINING_SHIFT_NATIVE_OUTCOME_UNKNOWN",true);
  return {status:"NATIVE_ORDER_REQUESTED",command:row.directive,
   commandSeq:row.commandSeq,skipNativeTick:row.directive==="HOLD"||row.directive==="RETREAT",
   nativeMutation:true,proof:"ORIGINAL_NATIVE_COMMAND_CALLED_NOT_ARRIVAL_OR_ORE_PROOF"};
 }
 return Object.freeze({assign,dispatch,lookup,mode:"ORIGINAL_NATIVE_FLEET_TICK_ONLY"});
}
module.exports={createShiftOrders,sameFleet,COMMANDS};
