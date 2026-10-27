"use strict";
// Single service to compose Stage A+B+C under real native authorities.
// Requires actual GameStore SQLite bridge; never auto-installs an unsafe provider.
const {createEscortNativeFunds}=require("./coopEscortNativeFunds");
const {createEscortFlightGate}=require("./coopEscortFlightGate");
const {createEscortContractSettlement}=require("./coopEscortContractSettlement");
const {createPeacefulEscortSettlement}=require("./coopEscortPeacefulSettlement");
const {createDepartureWitness}=require("./coopEscortDepartureWitness");
const {createRouteWitness}=require("./coopEscortRouteWitness");
const {createEscortTerminalAttendance}=require("./coopEscortTerminalAttendance");
const pos=n=>Number.isSafeInteger(n)&&n>0;
const equal=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&
 a.every((x,i)=>x===b[i]);
const blocked=status=>({status});
function createEscortRuntime({root,io,clock=()=>Date.now(),atomicRows,isNpcCorporation,
 authorizeBooking,verifyNativeDuo,authorizeOffer,readManifest,verifyManifest,
 readIncidents,readOutcomes,readNativeFailure}={}){
 if([isNpcCorporation,authorizeBooking,verifyNativeDuo,authorizeOffer,
  readManifest,verifyManifest,readIncidents,readOutcomes,readNativeFailure].some(f=>typeof f!=="function")||
  !atomicRows||typeof atomicRows.transact!=="function"||
  atomicRows.mode!=="SERVER_INTERNAL_FLAGGED"||
  typeof atomicRows.isPoisoned!=="function"||atomicRows.isPoisoned()!==false)
  throw Error("ESCORT_RUNTIME_NATIVE_AUTHORITIES_REQUIRED");
 const flags=["EVEJS_COOP_ESCORT_CONTRACTS","EVEJS_COOP_ESCORT_ROUTE_GATE",
  "EVEJS_COOP_NATIVE_ATOMIC_ROWS","EVEJS_COOP_NATIVE_ESCORT_WALLET"];
 const ready=()=>flags.every(k=>process.env[k]==="1")&&atomicRows.isPoisoned()===false;
 const funds=createEscortNativeFunds({atomicRows,isNpcCorporation,clock,
  verifyNativeFailure:readNativeFailure});
 const booking=route=>{
  if(!ready())return blocked("DENIED_NATIVE_RUNTIME_DISABLED");
  let offer,duo;
  try{offer=authorizeBooking(route);
   duo=verifyNativeDuo({systemID:route.systemID,
    stationID:route.stationID,corporationID:route.corporationID,
    cargoIDs:route.cargoIDs,characters:offer?.characters,
    fleetID:offer?.playerFleetID,manifestKey:route.manifestKey,
    haulerID:route.haulerIDs?.[0],contractID:offer?.contractID})}
  catch{return blocked("DENIED_NATIVE_DUO_UNAVAILABLE")}
  if(offer?.status!=="AUTHORIZED_NATIVE_ESCORT_BOOKING"||
   duo?.status!=="VERIFIED_NATIVE_DUO_FLEET"||
   !pos(duo.fleetID)||duo.fleetID!==offer.playerFleetID||
   !Array.isArray(duo.characters)||duo.characters.length!==2||
   !duo.characters.every(pos)||duo.characters[0]>=duo.characters[1]||
   !equal(duo.characters,offer.characters))
   return blocked("DENIED_NATIVE_DUO_NOT_AUTHORIZED");
  return offer;
 };
 const flight=createEscortFlightGate({root,io,clock,authorizeBooking:booking,
  readManifest,verifyManifest,nativeFunds:funds});
 const departure=createDepartureWitness({root,io,clock});
 const routeWitness=createRouteWitness({root,io,clock});
 const terminalWitness=createEscortTerminalAttendance({root,io,clock});
 function recordEscortDeparture(route,scene){
  if(!ready()||process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT!=="1"||
   process.env.EVEJS_COOP_ESCORT_DEPARTURE_WITNESS!=="1")
   return blocked("DISABLED");
  // Native quote + real manifest + signed duo and active player fleet are
  // verified BEFORE corporate escrow; failed on-grid proof cannot fund NPC warp.
  let source;try{source=booking(route)}
  catch{return blocked("DEPARTURE_BOOKING_UNAVAILABLE")}
  if(source?.status!=="AUTHORIZED_NATIVE_ESCORT_BOOKING")
   return blocked("DEPARTURE_BOOKING_NOT_AUTHORIZED");
  return departure.record({
   ...source,manifestKey:route.manifestKey},scene,verifyNativeDuo);
 }

 function readDurableEscortDeparture(manifestKey){
  if(!ready()||process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT!=="1"||
   process.env.EVEJS_COOP_ESCORT_DEPARTURE_WITNESS!=="1"||
   process.env.EVEJS_COOP_ESCORT_ROUTE_WITNESS!=="1"||
   process.env.EVEJS_COOP_ESCORT_NATIVE_WARP_RECOVERY!=="1")
   return blocked("DISABLED");
  let current;try{current=flight.read(manifestKey)}
  catch{return blocked("ESCORT_RECOVERY_FLIGHT_UNAVAILABLE")}
  if(current?.status!=="READY"||current.phase!=="FUNDED"||
   current.booking?.manifestKey!==manifestKey)
   return blocked("ESCORT_RECOVERY_ACTIVE_FUNDED_FLIGHT_NOT_VERIFIED");
  // A file journal can still say FUNDED after another terminal wallet
  // process committed a refund or payout. Re-read original native escrow.
  let reserve;try{reserve=flight.readFunded(current.booking)}
  catch{return blocked("ESCORT_RECOVERY_NATIVE_RESERVATION_UNAVAILABLE")}
  if(reserve?.status!=="NATIVE_PREFUNDED_BOOKING_VERIFIED")
   return blocked("ESCORT_RECOVERY_NATIVE_RESERVATION_NOT_VERIFIED");
  const proof=departure.readDurable(manifestKey,current.booking);
  if(proof.status!=="VERIFIED_NATIVE_ESCORT_DEPARTURE")
   return blocked("ESCORT_RECOVERY_"+proof.status);
  return proof;
 }
 function recordEscortRouteSample(manifestKey,scene,station){
  if(!ready()||process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT!=="1"||
   process.env.EVEJS_COOP_ESCORT_DEPARTURE_WITNESS!=="1"||
   process.env.EVEJS_COOP_ESCORT_ROUTE_WITNESS!=="1")
   return blocked("DISABLED");
  let f;try{f=flight.read(manifestKey)}
  catch{return blocked("ROUTE_FLIGHT_UNAVAILABLE")}
  if(f?.status!=="READY"||f.phase!=="FUNDED"||!f.booking||
   f.booking.manifestKey!==manifestKey)
   return blocked("ROUTE_ACTIVE_FUNDED_FLIGHT_NOT_VERIFIED");
  let reserve;try{reserve=flight.readFunded(f.booking)}
  catch{return blocked("ROUTE_NATIVE_RESERVATION_UNAVAILABLE")}
  if(reserve?.status!=="NATIVE_PREFUNDED_BOOKING_VERIFIED")
   return blocked("ROUTE_NATIVE_RESERVATION_NOT_VERIFIED");
  const p=departure.read(manifestKey,f.booking);
  if(p.status!=="VERIFIED_NATIVE_ESCORT_DEPARTURE")
   return blocked("ROUTE_DEPARTURE_NOT_VERIFIED");
  return routeWitness.sample({booking:f.booking,departure:p,scene,station,
   verifyNativeDuo});
 }
 function verifyLiveService(b,scene){
   const deny=()=>({status:"NO_NATIVE_ESCORT_SERVICE"});
   if(process.env.EVEJS_COOP_ESCORT_DEPARTURE_WITNESS!=="1")
    return deny();
   // The terminal on-grid check is INSUFFICIENT: a pilot could camp at the
   // destination and collect funds without escorting the NPC's departure.
   // Require a durable distinct pre-warp two-pilot source witness as well.
   const departureProof=departure.read(b.manifestKey,b);
   if(departureProof.status!=="VERIFIED_NATIVE_ESCORT_DEPARTURE")
    return deny();
   if(process.env.EVEJS_COOP_ESCORT_ROUTE_WITNESS==="1"&&
    routeWitness.verify(b,departureProof).status!==
     "VERIFIED_NATIVE_ESCORT_ROUTE_SERVICE")return deny();

   if(scene?.systemID!==b.systemID||
    typeof scene.getEntityByID!=="function"||
    typeof scene.sessions?.values!=="function")return deny();
   let duo;try{duo=verifyNativeDuo({
    systemID:b.systemID,stationID:b.stationID,corporationID:b.corporationID,
    fleetID:b.playerFleetID,manifestKey:b.manifestKey,
    contractID:b.contractID,haulerID:b.haulerID,characters:b.characters.slice()});
   }catch{return deny()}
   if(duo?.status!=="VERIFIED_NATIVE_DUO_FLEET"||
    duo.fleetID!==b.playerFleetID||!equal(duo.characters,b.characters))return deny();
   const hauler=scene.getEntityByID(b.haulerID);
   const validPosition=p=>p&&["x","y","z"].every(k=>Number.isFinite(p[k]));
   if(hauler?.kind!=="ship"||hauler.nativeNpc!==true||
    hauler.itemID!==b.haulerID||!validPosition(hauler.position))return deny();
   for(const characterID of b.characters){
    const sessions=[...scene.sessions.values()].filter(x=>
     x?.characterID===characterID&&x?.socket?.destroyed!==true&&
     x?._space?.initialStateSent===true&&
     x._space.systemID===b.systemID&&pos(x._space.shipID));
    if(sessions.length!==1)return deny();
    const player=scene.getEntityByID(sessions[0]._space.shipID);
    if(player?.kind!=="ship"||player.nativeNpc===true||
     player.itemID!==sessions[0]._space.shipID||!validPosition(player.position)||
     Math.hypot(player.position.x-hauler.position.x,
      player.position.y-hauler.position.y,
      player.position.z-hauler.position.z)>150000)return deny();
   }
   return {status:"VERIFIED_NATIVE_ESCORT_SERVICE",characters:b.characters.slice(),
    fleetID:b.playerFleetID,haulerID:b.haulerID,systemID:b.systemID};
  }
 function originalAttendanceProof(b){
  const d=departure.readDurable(b.manifestKey,b);
  if(d.status!=="VERIFIED_NATIVE_ESCORT_DEPARTURE")
   return blocked("PEACEFUL_REPLAY_ORIGINAL_DEPARTURE_NOT_DURABLE");
  const r=routeWitness.verify(b,d);
  if(r.status!=="VERIFIED_NATIVE_ESCORT_ROUTE_SERVICE")
   return blocked("PEACEFUL_REPLAY_ORIGINAL_ROUTE_NOT_DURABLE");
  return {status:"READY",departure:d,route:r};
 }
 function verifyPeacefulService(b,scene){
  // When immutable replay is enabled, EVEN the initial payout must use
  // the same fsynced terminal attendance receipt. Otherwise a lost write
  // ACK could be paid using a live scene and later be impossible to audit.
  if(process.env.EVEJS_COOP_ESCORT_PEACEFUL_REPLAY!=="1")
   return verifyLiveService(b,scene);
  if(process.env.EVEJS_COOP_ESCORT_ROUTE_WITNESS!=="1")
   return blocked("PEACEFUL_REPLAY_STRICT_ROUTE_REQUIRED");
  const proof=originalAttendanceProof(b);
  if(proof.status!=="READY")return blocked("PEACEFUL_REPLAY_ORIGINAL_SERVICE_NOT_DURABLE");
  const f=flight.read(b.manifestKey);
  if(f.status!=="READY"||f.phase!=="DELIVERED")
   return blocked("PEACEFUL_REPLAY_NOT_TERMINALLY_DELIVERED");
  const term=terminalWitness.readDurable(b,proof.departure,proof.route,
   f.delivery?.nativeFullManifestProof);
  if(term.status!=="VERIFIED_NATIVE_ESCORT_TERMINAL_ATTENDANCE")
   return blocked("PEACEFUL_REPLAY_TERMINAL_ATTENDANCE_NOT_DURABLE");
  return {status:"VERIFIED_NATIVE_ESCORT_SERVICE",characters:b.characters.slice(),
   fleetID:b.playerFleetID,haulerID:b.haulerID,systemID:b.systemID};
 }
 const peaceful=createPeacefulEscortSettlement({readFlight:flight.read,
  readNativeDelivery:flight.readNativeDelivery,nativeFunds:funds,
  verifyService:verifyPeacefulService});
 function recordTerminalAttendance(manifestKey,scene,stock){
  if(!ready()||process.env.EVEJS_COOP_ESCORT_PEACEFUL_REPLAY!=="1"||
   process.env.EVEJS_COOP_ESCORT_ROUTE_WITNESS!=="1"||
   process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT!=="1")
   return blocked("DISABLED");
  if(typeof manifestKey!=="string"||!/^\d+-\d+-\d+$/.test(manifestKey))
   return blocked("TERMINAL_ATTENDANCE_MANIFEST_INVALID");
  let f;try{f=flight.read(manifestKey)}
  catch{return blocked("TERMINAL_ATTENDANCE_FLIGHT_UNAVAILABLE")}
  if(f?.status!=="READY"||f.phase!=="FUNDED"||f.booking?.manifestKey!==manifestKey)
   return blocked("TERMINAL_ATTENDANCE_FLIGHT_NOT_FUNDED");
  let reserved;try{reserved=flight.readFunded(f.booking)}
  catch{return blocked("TERMINAL_ATTENDANCE_ESCROW_UNAVAILABLE")}
  if(reserved?.status!=="NATIVE_PREFUNDED_BOOKING_VERIFIED")
   return blocked("TERMINAL_ATTENDANCE_ESCROW_NOT_RESERVED");
  const b=f.booking, proof=originalAttendanceProof(b);
  if(proof.status!=="READY")return proof;
  let original;try{original=verifyManifest({key:manifestKey,
   systemID:b.systemID,fleetID:b.fleetID,stationID:b.stationID,
   corporationID:b.corporationID,haulerIDs:[b.haulerID]})}
  catch{return blocked("TERMINAL_ATTENDANCE_MANIFEST_UNAVAILABLE")}
  if(stock?.status!=="FULL_NATIVE_CARGO_DELIVERY_VERIFIED"||
   original?.status!=="FULL_NATIVE_CARGO_DELIVERY_VERIFIED"||
   stock.key!==manifestKey||original.key!==manifestKey||
   !equal(stock.cargoIDs,original.cargoIDs)||
   !equal(stock.haulerIDs,[b.haulerID])||
   !equal(original.haulerIDs,[b.haulerID]))
   return blocked("TERMINAL_ATTENDANCE_NATIVE_WAREHOUSE_UNVERIFIED");
  return terminalWitness.record({booking:b,departure:proof.departure,
   route:proof.route,stock:original,scene,verifyNativeDuo});
 }
 const contracts=createEscortContractSettlement({root,io,clock,
  authorizeOffer:c=>{
   if(!ready())return blocked("DENIED_NATIVE_RUNTIME_DISABLED");
   // An already-funded immutable native trip, not a newly generated offer.
   const proof=flight.readFunded(c);
   if(proof.status!=="NATIVE_PREFUNDED_BOOKING_VERIFIED")
    return blocked("DENIED_UNFUNDED_NATIVE_ROUTE");
   return authorizeOffer(c);
  },
  readManifest,verifyManifest,readIncidents,readOutcomes,
  readNativeDelivery:c=>{
   const active=flight.readNativeDelivery(c);
   if(active?.status==="DELIVERED")return active;
   // Audit alone can read a paid trip; never use paid receipt as a
   // substitute for RESERVED before first warp or before payout.
   let receipt;try{receipt=funds.verifySettlement(c)}catch{}
   if(receipt?.status==="SETTLED"&&receipt.nativeDurable===true)
    return flight.readNativeDeliveryForAudit(c);
   return active;
  },
  readNativeFailure,nativeFunds:funds,
  readPrefunded:c=>flight.readFunded(c)});
 function fundBeforeWarp(route){
  if(!ready())return blocked("DISABLED");
  if(process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT==="1"){
   if(process.env.EVEJS_COOP_ESCORT_DEPARTURE_WITNESS!=="1")
    return blocked("ESCORT_DURABLE_DEPARTURE_WITNESS_REQUIRED");
   // Even a different trusted server-internal caller cannot fund a peaceful
   // convoy without the same source-linked, fsynced two-pilot departure proof.
   let offer;try{offer=booking(route)}
   catch{return blocked("ESCORT_DEPARTURE_BOOKING_UNAVAILABLE")}
   if(offer?.status!=="AUTHORIZED_NATIVE_ESCORT_BOOKING")
    return blocked("ESCORT_DEPARTURE_BOOKING_NOT_AUTHORIZED");
   const proof=departure.read(route?.manifestKey,{
    ...offer,manifestKey:route?.manifestKey});
   if(proof.status!=="VERIFIED_NATIVE_ESCORT_DEPARTURE")
    return blocked("ESCORT_"+proof.status);
  }
  return flight.fundBeforeWarp(route);
 }
 function recordDelivery(args){
  return ready()?flight.recordDelivered(args):blocked("DISABLED");
 }
 function finishAfterRaid(candidate){
  if(!ready())return blocked("DISABLED");
  if(!candidate||typeof candidate.contractID!=="string")
   return blocked("CONTRACT_ID_INVALID");
  let state=contracts.read(candidate.contractID);
  if(state.status==="CONTRACT_NOT_FOUND"){
   const result=contracts.create(candidate);
   if(result.status!=="OFFERED")return result;
   state=contracts.read(candidate.contractID);
  }
  if(state.status!=="READY")return state;
  if(state.phase==="OFFERED"){
   const funded=contracts.attachPrefunded(candidate.contractID);
   if(funded.status!=="FUNDED")return funded;
   state=contracts.read(candidate.contractID);
  }
  if(state.phase!=="FUNDED")return blocked("CONTRACT_NOT_SETTLEABLE");
  // Stage A independently rechecks durable real pirate/wreck, complete cargo,
  // real participant fleet and native escrow in one atomic dual-credit commit.
  return contracts.settle(candidate.contractID);
 }

 // A destroyed hauler may NEVER reach Stage A's successful-delivery path.
 // Reconstruct that contract exclusively from the original immutable
 // prewarp booking plus the independently journalled native hauler wreck.
 // No trusted wreck -> no Stage A creation, and absolutely no refund.
 function refundWreckedFlight(manifestKey){
  if(!ready()||process.env.EVEJS_COOP_ESCORT_REFUNDS!=="1")
   return blocked("DISABLED");
  if(typeof manifestKey!=="string"||!/^\d+-\d+-\d+$/.test(manifestKey))
   return blocked("NATIVE_REFUND_MANIFEST_KEY_INVALID");
  let state;try{state=flight.read(manifestKey)}
  catch{return blocked("NATIVE_REFUND_FLIGHT_JOURNAL_UNAVAILABLE")}
  if(state?.status!=="READY"||state.phase!=="FUNDED")
   return blocked("NATIVE_REFUND_FLIGHT_NOT_FUNDED_OR_ALREADY_DELIVERED");
  const b=state.booking;
  if(!pos(b?.playerFleetID)||!pos(b?.haulerID)||
   !Array.isArray(b.characters)||b.characters.length!==2)
   return blocked("NATIVE_REFUND_ORIGINAL_DUO_NOT_RECORDED");
  let outcomes;try{outcomes=readOutcomes()}
  catch{return blocked("NATIVE_REFUND_OUTCOME_SOURCE_UNAVAILABLE")}
  if(outcomes?.status!=="READY"||!Array.isArray(outcomes.outcomes))
   return blocked("NATIVE_REFUND_OUTCOME_JOURNAL_UNVERIFIED");
  const eligible=outcomes.outcomes.filter(x=>
   x.systemID===b.systemID&&x.targetID===b.haulerID&&
   pos(x.pirateID)&&x.status==="HAULER_NATIVE_LOSS_VERIFIED"&&
   pos(x.haulerNativeWreckID)&&
   Array.isArray(x.verifiedWarehouseStacks)&&
   x.verifiedWarehouseStacks.length===0&&
   x.key===String(b.systemID)+":"+x.pirateID+":"+b.haulerID);
  if(eligible.length!==1)return blocked(eligible.length?
   "NATIVE_REFUND_AMBIGUOUS_HAULER_LOSS":"NATIVE_REFUND_HAULER_LOSS_NOT_PROVEN");
  const o=eligible[0];
  const c={contractID:b.contractID,manifestKey:b.manifestKey,
   systemID:b.systemID,fleetID:b.fleetID,haulerID:b.haulerID,
   stationID:b.stationID,corporationID:b.corporationID,
   pirateID:o.pirateID,incidentKey:o.key,fleetDuoID:b.playerFleetID,
   characters:b.characters.slice(),amountISK:b.amountISK};
  let loss;try{loss=readNativeFailure(c)}
  catch{return blocked("NATIVE_REFUND_IRREVERSIBLE_LOSS_UNAVAILABLE")}
  if(loss?.status!=="DURABLE_NATIVE_CONVOY_TERMINAL_FAILURE"||
   loss.contractID!==c.contractID||loss.manifestKey!==c.manifestKey||
   loss.corporationID!==c.corporationID||
   loss.failureWitnessID!==o.haulerNativeWreckID||
   loss.reason!=="NATIVE_HAULER_WRECK"||
   loss.nativeDurable!==true||
   loss.deliveryImpossible!==true||loss.noPriorPayout!==true)
   return blocked("NATIVE_REFUND_IRREVERSIBLE_LOSS_NOT_VERIFIED");
  let contract=contracts.read(c.contractID);
  if(contract.status==="CONTRACT_NOT_FOUND"){
   const created=contracts.create(c);
   if(created.status!=="OFFERED")return created;
   contract=contracts.read(c.contractID);
  }
  if(contract.status!=="READY")return contract;
  if(contract.phase==="OFFERED"){
   const ack=contracts.attachPrefunded(c.contractID);
   if(ack.status!=="FUNDED")return ack;
   contract=contracts.read(c.contractID);
  }
  if(contract.phase!=="FUNDED")
   return blocked("NATIVE_REFUND_CONTRACT_NOT_REPLAYABLE");
  return contracts.refund(c.contractID);
 }
 function reconcilePeacefulDeliveries({systemID=null,maxTrips=32,afterKey=null}={}){
  if(!ready()||process.env.EVEJS_COOP_ESCORT_PEACEFUL_REPLAY!=="1"||
   process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT!=="1"||
   process.env.EVEJS_COOP_ESCORT_ROUTE_WITNESS!=="1")
   return blocked("DISABLED");
  if(systemID!==null&&!pos(systemID)||
   !Number.isSafeInteger(maxTrips)||maxTrips<1||maxTrips>32||
   afterKey!==null&&(typeof afterKey!=="string"||!/^[0-9]+-[0-9]+-[0-9]+$/.test(afterKey)))
   return blocked("PEACEFUL_REPLAY_SCAN_OPTIONS_INVALID");
  let entries;try{entries=flight.listDelivered({systemID,maxTrips,afterKey})}
  catch{return blocked("PEACEFUL_REPLAY_FLIGHT_SCAN_UNAVAILABLE")}
  if(entries?.status!=="READY"||!Array.isArray(entries.manifestKeys)||
   entries.manifestKeys.length>maxTrips)
   return blocked(entries?.status||"PEACEFUL_REPLAY_SCAN_INVALID");
  if(entries.hasMore!==undefined&&typeof entries.hasMore!=="boolean"||
     entries.hasMore===true&&(entries.manifestKeys.length===0||
     entries.nextAfterKey!==entries.manifestKeys[entries.manifestKeys.length-1]||
     afterKey!==null&&entries.nextAfterKey<=afterKey))
   return blocked("PEACEFUL_REPLAY_SCAN_INVALID_CURSOR");
  const outcomes=[];let paid=0,alreadyPaid=0,pending=0,blockedCount=0;
  for(const key of entries.manifestKeys){
   if(typeof key!=="string"||!/^\d+-\d+-\d+$/.test(key))
    return blocked("PEACEFUL_REPLAY_MANIFEST_INVALID");
   const r=peaceful.settle(key,null),status=r?.status||"PEACEFUL_REPLAY_UNCERTAIN";
   outcomes.push({manifestKey:key,status});
   if(status==="NATIVE_PEACEFUL_ESCORT_PAID")paid++;
   else if(status==="ALREADY_NATIVE_PAID")alreadyPaid++;
   else if(["NATIVE_ESCORT_SERVICE_NOT_VERIFIED",
     "NATIVE_ESCORT_SERVICE_PROOF_UNAVAILABLE"].includes(status))pending++;
   else blockedCount++;
  }
  return {status:"NATIVE_PEACEFUL_REPLAY_CHECKED",paid,alreadyPaid,
   pending,blocked:blockedCount,outcomes,
   hasMore:entries.hasMore===true,
   nextAfterKey:entries.hasMore===true?entries.nextAfterKey:null};
 }
 function settlePeacefulFlight(manifestKey,scene){
  if(!ready())return blocked("DISABLED");
  return peaceful.settle(manifestKey,scene);
 }
 function refundProvenLoss(contractID){
  if(!ready()||process.env.EVEJS_COOP_ESCORT_REFUNDS!=="1")
   return blocked("DISABLED");
  return contracts.refund(contractID);
 }
 return Object.freeze({fundBeforeWarp,recordDelivery,recordEscortDeparture,readDurableEscortDeparture,recordEscortRouteSample,recordTerminalAttendance,reconcilePeacefulDeliveries,finishAfterRaid,settlePeacefulFlight,
  refundProvenLoss,refundWreckedFlight,readFlight:flight.read,readContract:contracts.read,
  inspectRefundRecovery:contracts.inspectRefundRecovery,
  proof:contracts.proof,nativeFunds:funds,flightGate:flight,contractEngine:contracts});
}
module.exports={createEscortRuntime};
