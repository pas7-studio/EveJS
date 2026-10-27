"use strict";
// Stage E: stable, one-shot authoritative bridge from native station route
// to native-funded escort. No automatic wallet or client override.
const flags=["EVEJS_COOP_ESCORT_CONTRACTS","EVEJS_COOP_ESCORT_ROUTE_GATE",
 "EVEJS_COOP_NATIVE_ATOMIC_ROWS","EVEJS_COOP_NATIVE_ESCORT_WALLET",
 "EVEJS_COOP_NATIVE_HAUL_MANIFEST"];
const pos=x=>Number.isSafeInteger(x)&&x>0;
let installed=null;
const deny=status=>({status});
const enabled=()=>flags.every(k=>process.env[k]==="1");
function makeBinding({runtime,readNativeIncident,recordTerminal=null}={}){
 if(recordTerminal!==null&&typeof recordTerminal!=="function")
  throw Error("ESCORT_REPUTATION_SOURCE_INVALID");
 if(!runtime||typeof readNativeIncident!=="function"||
  ["fundBeforeWarp","recordDelivery","finishAfterRaid","settlePeacefulFlight","refundProvenLoss",
   "readFlight","inspectRefundRecovery","refundWreckedFlight"].some(k=>typeof runtime[k]!=="function")||
  runtime.nativeFunds?.capabilities?.().nativeDurable!==true||
  runtime.nativeFunds?.capabilities?.().atomicDualCredit!==true)
  throw Error("ESCORT_NATIVE_BINDING_AUTHORITIES_REQUIRED");
 return Object.freeze({
  fundBeforeWarp(route){
   if(!enabled())return deny("DISABLED");
   if(!route||![route.systemID,route.fleetID,route.stationID,route.corporationID].every(pos)||
    !Array.isArray(route.haulerIDs)||route.haulerIDs.length!==1||
    !pos(route.haulerIDs[0]))return deny("NATIVE_PREWARP_ROUTE_UNVERIFIED");
   try{return runtime.fundBeforeWarp(route)}
   catch{return deny("NATIVE_PREWARP_FUNDING_UNCERTAIN_REPAIR_REQUIRED")}
  },
  recordDelivered(args){
   if(!enabled())return deny("DISABLED");
   const trip=args?.trip;
   if(!trip||![trip.systemID,trip.fleetID,trip.stationID,trip.corporationID].every(pos)||
    typeof trip.manifestID!=="string"||args?.manifestKey!==trip.manifestID||
    args?.terminalProof?.status!=="DELIVERED"||
    args?.terminalProof?.terminal!==true)
    return deny("NATIVE_TERMINAL_ROUTE_UNVERIFIED");
   try{return runtime.recordDelivery(args)}
   catch{return deny("NATIVE_TERMINAL_WRITE_UNCERTAIN_REPAIR_REQUIRED")}
  },
  recordEscortDeparture(route,scene){
   if(!enabled()||process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT!=="1"||
    process.env.EVEJS_COOP_ESCORT_DEPARTURE_WITNESS!=="1")
    return deny("DISABLED");
   if(!route||typeof route.manifestKey!=="string"||
    !/^\d+-\d+-\d+$/.test(route.manifestKey)||
    ![route.systemID,route.fleetID,route.stationID,route.corporationID]
     .every(pos)||!Array.isArray(route.haulerIDs)||
    route.haulerIDs.length!==1||!pos(route.haulerIDs[0]))
    return deny("DEPARTURE_ROUTE_INVALID");
   if(typeof runtime.recordEscortDeparture!=="function")
    return deny("DEPARTURE_WITNESS_PROVIDER_NOT_WIRED");
   try{return runtime.recordEscortDeparture(route,scene)}
   catch{return deny("DEPARTURE_WITNESS_UNCERTAIN_REPAIR_REQUIRED")}
  },
  readDurableEscortDeparture(manifestKey){
   if(!enabled()||process.env.EVEJS_COOP_ESCORT_NATIVE_WARP_RECOVERY!=="1"||
    typeof runtime.readDurableEscortDeparture!=="function"||
    typeof manifestKey!=="string"||!/^\d+-\d+-\d+$/.test(manifestKey))
    return deny("ESCORT_RECOVERY_PROVENANCE_UNAVAILABLE");
   try{return runtime.readDurableEscortDeparture(manifestKey)}
   catch{return deny("ESCORT_RECOVERY_DURABLE_SOURCE_UNAVAILABLE")}
  },
  recordEscortRouteSample(manifestKey,scene,station){
   if(!enabled()||process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT!=="1"||
    process.env.EVEJS_COOP_ESCORT_DEPARTURE_WITNESS!=="1"||
    process.env.EVEJS_COOP_ESCORT_ROUTE_WITNESS!=="1")
    return deny("DISABLED");
   if(typeof manifestKey!=="string"||!/^\d+-\d+-\d+$/.test(manifestKey)||
    typeof runtime.recordEscortRouteSample!=="function")
    return deny("ROUTE_SAMPLE_AUTHORITY_NOT_WIRED");
   try{return runtime.recordEscortRouteSample(manifestKey,scene,station)}
   catch{return deny("ROUTE_SAMPLE_UNCERTAIN_REPAIR_REQUIRED")}
  },
  recordTerminalAttendance(manifestKey,scene,stock){
   if(!enabled()||process.env.EVEJS_COOP_ESCORT_PEACEFUL_REPLAY!=="1"||
    process.env.EVEJS_COOP_ESCORT_ROUTE_WITNESS!=="1"||
    typeof runtime.recordTerminalAttendance!=="function")
    return deny("DISABLED");
   if(typeof manifestKey!=="string"||!/^\d+-\d+-\d+$/.test(manifestKey))
    return deny("TERMINAL_ATTENDANCE_MANIFEST_INVALID");
   try{return runtime.recordTerminalAttendance(manifestKey,scene,stock)}
   catch{return deny("TERMINAL_ATTENDANCE_WRITE_UNCERTAIN")}
  },
  reconcilePeacefulDeliveries(options){
   if(!enabled()||process.env.EVEJS_COOP_ESCORT_PEACEFUL_REPLAY!=="1"||
    typeof runtime.reconcilePeacefulDeliveries!=="function")
    return deny("DISABLED");
   try{return runtime.reconcilePeacefulDeliveries(options)}
   catch{return deny("PEACEFUL_REPLAY_UNCERTAIN_OPERATOR_REPAIR")}
  },
  settlePeacefulDelivery(manifestKey,scene){
   if(!enabled()||process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT!=="1")
    return deny("DISABLED");
   if(typeof manifestKey!=="string"||!/^\d+-\d+-\d+$/.test(manifestKey))
    return deny("NATIVE_MANIFEST_KEY_INVALID");
   try{return runtime.settlePeacefulFlight(manifestKey,scene)}
   catch{return deny("NATIVE_PEACEFUL_SETTLEMENT_UNCERTAIN_REPAIR_REQUIRED")}
  },
  settleVerifiedNativeRaid(manifestKey){
   if(!enabled())return deny("DISABLED");
   if(typeof manifestKey!=="string"||!/^\d+-\d+-\d+$/.test(manifestKey))
    return deny("NATIVE_SETTLEMENT_MANIFEST_INVALID");
   let flight;try{flight=runtime.readFlight(manifestKey)}
   catch{return deny("NATIVE_FLIGHT_JOURNAL_UNAVAILABLE")}
   if(flight?.status!=="READY"||flight.phase!=="DELIVERED")
    return deny("NATIVE_FLIGHT_DELIVERY_NOT_RECORDED");
   const b=flight.booking;
   let incidents;try{incidents=readNativeIncident()}
   catch{return deny("NATIVE_INCIDENTS_UNAVAILABLE")}
   if(incidents?.status!=="READY"||!Array.isArray(incidents.incidents))
    return deny("NATIVE_INCIDENTS_UNVERIFIED");
   const matches=incidents.incidents.filter(i=>i.systemID===b.systemID&&
    i.targetID===b.haulerID&&i.targetRole==="hauler"&&
    i.status==="PIRATE_WRECK_CONFIRMED"&&i.closed===true&&
    pos(i.pirateID)&&pos(i.nativeWreckID)&&pos(i.duoFleetID)&&
    Array.isArray(i.characters)&&i.characters.length===2&&
    i.characters[0]===b.characters[0]&&i.characters[1]===b.characters[1]&&
    i.key===String(b.systemID)+":"+i.pirateID+":"+b.haulerID);
   if(matches.length!==1)return deny(matches.length?
    "NATIVE_INCIDENT_AMBIGUOUS":"NO_VERIFIED_NATIVE_RAID_TO_SETTLE");
   const i=matches[0];
   const contract={contractID:b.contractID,manifestKey:b.manifestKey,
    systemID:b.systemID,fleetID:b.fleetID,haulerID:b.haulerID,
    stationID:b.stationID,corporationID:b.corporationID,
    pirateID:i.pirateID,incidentKey:i.key,fleetDuoID:i.duoFleetID,
    characters:b.characters.slice(),amountISK:b.amountISK};
   // Read existing real wallet terminal BEFORE any attempt to pay again.
   // This also lets reputation history recover after money COMMIT but before
   // its own fsync; history cannot itself create another wallet credit.
   let paid,refunded;try{
    paid=runtime.nativeFunds.verifySettlement(contract);
    refunded=runtime.nativeFunds.verifyRefund(contract);
   }catch{return deny("NATIVE_SETTLEMENT_WALLET_PREFLIGHT_UNAVAILABLE")}
   if(paid?.status==="SETTLED"){
    if(refunded?.status==="REFUNDED")return deny("NATIVE_SETTLEMENT_TERMINAL_MONEY_CONFLICT");
    if(paid.nativeDurable!==true||paid.contractID!==contract.contractID||
     paid.corporationID!==contract.corporationID||
     paid.amountISK!==contract.amountISK||
     !Array.isArray(paid.credits)||paid.credits.length!==2||
     paid.credits.some((x,i)=>x.characterID!==contract.characters[i]||
      x.amountISK!==contract.amountISK/2))
     return deny("NATIVE_TERMINAL_PAID_RECEIPT_CONFLICT");
    let history={status:"DISABLED"};
    if(recordTerminal)try{history=recordTerminal(contract.contractID)}
    catch{history={status:"NATIVE_HISTORY_WRITE_UNAVAILABLE"}}
    return {status:"ALREADY_NATIVE_SETTLED",contractID:contract.contractID,
     historyStatus:history?.status||"NATIVE_HISTORY_WRITE_UNAVAILABLE"};
   }
   if(!["NOT_FOUND","NOT_SETTLED"].includes(paid?.status)||
      !["NOT_FOUND","NOT_REFUNDED"].includes(refunded?.status))
    return deny("NATIVE_SETTLEMENT_TERMINAL_MONEY_CONFLICT");
   let result;try{result=runtime.finishAfterRaid(contract)}
   catch{return deny("NATIVE_SETTLEMENT_UNCERTAIN_REPAIR_REQUIRED")}
   if(result?.status==="SETTLED"&&recordTerminal){
    let history;try{history=recordTerminal(contract.contractID)}
    catch{history={status:"NATIVE_HISTORY_WRITE_UNAVAILABLE"}}
    return {...result,historyStatus:history?.status||"NATIVE_HISTORY_WRITE_UNAVAILABLE"};
   }
   return result;
  },
  // Recovery scans real FSYNCED flight journals, never a caller-supplied
  // arbitrary contract or in-memory list. Each candidate independently
  // verifies wallet + native combat + warehouse before any money mutation.
  reconcilePendingDeliveries({systemID=null,maxTrips=32}={}){
   if(!enabled()||process.env.EVEJS_COOP_ESCORT_SETTLEMENT_REPLAY!=="1")
    return deny("DISABLED");
   if(systemID!==null&&!pos(systemID))
    return deny("NATIVE_RECONCILE_SYSTEM_INVALID");
   if(!Number.isSafeInteger(maxTrips)||maxTrips<1||maxTrips>32)
    return deny("NATIVE_RECONCILE_LIMIT_INVALID");
   if(typeof runtime.listDeliveredFlights!=="function")
    return deny("NATIVE_RECONCILE_FLIGHT_SOURCE_MISSING");
   let flights;try{flights=runtime.listDeliveredFlights({systemID,maxTrips})}
   catch{return deny("NATIVE_RECONCILE_FLIGHT_SCAN_UNAVAILABLE")}
   if(flights?.status!=="READY"||!Array.isArray(flights.manifestKeys))
    return deny(flights?.status||"NATIVE_RECONCILE_FLIGHT_SCAN_INVALID");
   if(flights.manifestKeys.length>maxTrips)
    return deny("NATIVE_RECONCILE_TOO_MANY_FLIGHTS");
   let paid=0,pending=0,alreadyPaid=0,blocked=0;
   const outcomes=[];
   for(const key of flights.manifestKeys){
    if(typeof key!=="string"||!/^\d+-\d+-\d+$/.test(key))
     return deny("NATIVE_RECONCILE_INVALID_SOURCE_ID");
    const result=this.settleVerifiedNativeRaid(key);
    const status=result?.status||"NATIVE_SETTLEMENT_UNKNOWN";
    outcomes.push({manifestKey:key,status});
    if(status==="SETTLED")paid++;
    else if(status==="ALREADY_NATIVE_SETTLED")alreadyPaid++;
    else if(status==="NO_VERIFIED_NATIVE_RAID_TO_SETTLE")pending++;
    else blocked++;
   }
   return {status:blocked?"NATIVE_RECONCILE_HAS_BLOCKERS":"NATIVE_RECONCILE_CHECKED",
    paid,alreadyPaid,pending,blocked,outcomes};
  },
  refundNativeWreck:manifestKey=>{
   if(!enabled()||process.env.EVEJS_COOP_ESCORT_REFUNDS!=="1")
    return deny("DISABLED");
   if(typeof manifestKey!=="string"||!/^\d+-\d+-\d+$/.test(manifestKey))
    return deny("NATIVE_REFUND_MANIFEST_KEY_INVALID");
   // If corporate refund already committed in native wallet but the
   // reputation fsync failed, retry HISTORY ONLY, never another credit.
   let flight,historyContract;
   try{flight=runtime.readFlight(manifestKey);
    historyContract=runtime.readContract(flight?.booking?.contractID)}
   catch{return deny("NATIVE_REFUND_HISTORY_SOURCE_UNAVAILABLE")}
   if(historyContract?.status==="READY"&&historyContract.phase==="REFUNDED"){
    const c=historyContract.contract;
    let verified;try{verified=runtime.nativeFunds.verifyRefund(c)}
    catch{return deny("NATIVE_REFUND_HISTORY_WALLET_UNAVAILABLE")}
    if(verified?.status!=="REFUNDED"||verified.nativeDurable!==true||
     verified.contractID!==c.contractID||
     verified.corporationID!==c.corporationID||
     verified.amountISK!==c.amountISK)
     return deny("NATIVE_REFUND_HISTORY_WALLET_CONFLICT");
    let history={status:"DISABLED"};
    if(recordTerminal)try{history=recordTerminal(c.contractID)}
    catch{history={status:"NATIVE_HISTORY_WRITE_UNAVAILABLE"}}
    return {status:"ALREADY_NATIVE_REFUNDED",contractID:c.contractID,
     historyStatus:history?.status||"NATIVE_HISTORY_WRITE_UNAVAILABLE"};
   }
   let result;try{result=runtime.refundWreckedFlight(manifestKey)}
   catch{return deny("NATIVE_REFUND_OUTCOME_UNCERTAIN_REPAIR_REQUIRED")}
   if(result?.status==="REFUNDED"&&recordTerminal){
    let history;try{history=recordTerminal(result.contractID)}
    catch{history={status:"NATIVE_HISTORY_WRITE_UNAVAILABLE"}}
    return {...result,historyStatus:history?.status||"NATIVE_HISTORY_WRITE_UNAVAILABLE"};
   }
   return result;
  },
  readFlight:key=>runtime.readFlight(key),
  inspectRefundRecovery:id=>runtime.inspectRefundRecovery(id)
 });
}
const forwarding=Object.freeze({
 fundBeforeWarp:route=>enabled()?(installed?installed.fundBeforeWarp(route):
  deny("ESCORT_NATIVE_RUNTIME_NOT_INSTALLED")):deny("DISABLED"),
 recordDelivered:args=>enabled()?(installed?installed.recordDelivered(args):
  deny("ESCORT_NATIVE_RUNTIME_NOT_INSTALLED")):deny("DISABLED"),
 recordEscortDeparture:(route,scene)=>enabled()?(installed?installed.recordEscortDeparture(route,scene):
  deny("ESCORT_NATIVE_RUNTIME_NOT_INSTALLED")):deny("DISABLED"),
 readDurableEscortDeparture:key=>enabled()?
  (installed?installed.readDurableEscortDeparture(key):
   deny("ESCORT_NATIVE_RUNTIME_NOT_INSTALLED")):deny("DISABLED"),
 recordEscortRouteSample:(key,scene,station)=>enabled()?
  (installed?installed.recordEscortRouteSample(key,scene,station):
   deny("ESCORT_NATIVE_RUNTIME_NOT_INSTALLED")):deny("DISABLED"),
 recordTerminalAttendance:(key,scene,stock)=>enabled()?
  (installed?installed.recordTerminalAttendance(key,scene,stock):
   deny("ESCORT_NATIVE_RUNTIME_NOT_INSTALLED")):deny("DISABLED"),
 reconcilePeacefulDeliveries:options=>enabled()?
  (installed?installed.reconcilePeacefulDeliveries(options):
   deny("ESCORT_NATIVE_RUNTIME_NOT_INSTALLED")):deny("DISABLED"),
 settlePeacefulDelivery:(key,scene)=>enabled()?(installed?installed.settlePeacefulDelivery(key,scene):
  deny("ESCORT_NATIVE_RUNTIME_NOT_INSTALLED")):deny("DISABLED"),
 settleVerifiedNativeRaid:key=>enabled()?(installed?installed.settleVerifiedNativeRaid(key):
  deny("ESCORT_NATIVE_RUNTIME_NOT_INSTALLED")):deny("DISABLED"),
 refundNativeWreck:key=>enabled()?(installed?installed.refundNativeWreck(key):
  deny("ESCORT_NATIVE_RUNTIME_NOT_INSTALLED")):deny("DISABLED"),
 reconcilePendingDeliveries:options=>enabled()?(installed?installed.reconcilePendingDeliveries(options):
  deny("ESCORT_NATIVE_RUNTIME_NOT_INSTALLED")):deny("DISABLED"),
 readFlight:key=>enabled()?(installed?installed.readFlight(key):
  deny("ESCORT_NATIVE_RUNTIME_NOT_INSTALLED")):deny("DISABLED")
});
function routeGate(){return forwarding}
function installServerAuthority({runtime,readNativeIncident,recordTerminal=null}={}){
 if(!enabled())return deny("DISABLED");
 if(installed)return deny("ESCORT_RUNTIME_ALREADY_BOUND");
 try{installed=makeBinding({runtime,readNativeIncident,recordTerminal})}
 catch{return deny("ESCORT_NATIVE_BINDING_AUTHORITIES_REQUIRED")}
 return {status:"ESCORT_NATIVE_RUNTIME_BOUND"};
}
function reconcilePendingDeliveries(options){
 if(!enabled()||process.env.EVEJS_COOP_ESCORT_SETTLEMENT_REPLAY!=="1")
  return deny("DISABLED");
 return installed?installed.reconcilePendingDeliveries(options):
  deny("ESCORT_NATIVE_RUNTIME_NOT_INSTALLED");
}
function reconcilePeacefulDeliveries(options){
 if(!enabled()||process.env.EVEJS_COOP_ESCORT_PEACEFUL_REPLAY!=="1")
  return deny("DISABLED");
 return installed?installed.reconcilePeacefulDeliveries(options):
  deny("ESCORT_NATIVE_RUNTIME_NOT_INSTALLED");
}
function settlement(manifestKey){
 if(!enabled())return deny("DISABLED");
 return installed?installed.settleVerifiedNativeRaid(manifestKey):
  deny("ESCORT_NATIVE_RUNTIME_NOT_INSTALLED");
}
function inspect(){return {status:installed?"ESCORT_NATIVE_RUNTIME_BOUND":
 "ESCORT_NATIVE_RUNTIME_NOT_INSTALLED",enabled:enabled(),
 backend:installed?"IN_PROCESS_NATIVE_ONLY":null}}
module.exports={makeBinding,routeGate,installServerAuthority,settlement,reconcilePendingDeliveries,reconcilePeacefulDeliveries,inspect};
