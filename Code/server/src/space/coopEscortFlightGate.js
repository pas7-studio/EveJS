"use strict";
// COOP-ESCORT Stage C: trusted pre-warp native ISK booking and durable terminal
// physical delivery witness. This module never grants items or pays players.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const pos=x=>Number.isSafeInteger(x)&&x>0;
const keyOK=x=>typeof x==="string"&&/^\d+-\d+-\d+$/.test(x);
const contractOK=x=>typeof x==="string"&&/^escort-[a-zA-Z0-9-]{1,48}$/.test(x);
const equal=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&
 new Set(a).size===a.length&&new Set(b).size===b.length&&a.every(x=>b.includes(x));
const blocked=status=>({status});
const sha=x=>crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
function createEscortFlightGate({root,io=fs,clock=()=>Date.now(),
 authorizeBooking,readManifest,verifyManifest,nativeFunds}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||typeof authorizeBooking!=="function"||
  typeof readManifest!=="function"||typeof verifyManifest!=="function"||
  ["capabilities","reserveAtomic","verifyReservation"].some(x=>typeof nativeFunds?.[x]!=="function"))
  throw Error("ESCORT_FLIGHT_GATE_AUTHORITIES_REQUIRED");
 const dir=path.join(root,"escort-flight-gate");
 const filename=key=>path.join(dir,key+".jsonl");
 function syncDir(){let fd;try{fd=io.openSync(dir,"r");io.fsyncSync(fd);return true}
  catch{return false}finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}}
 function append(key,value,exclusive=false){
  let fd;try{
   io.mkdirSync(dir,{recursive:true});
   const data=Buffer.from(JSON.stringify(value)+"\n");
   if(data.length>4096)return false;
   fd=io.openSync(filename(key),exclusive?"wx":"a",0o600);
   if(io.writeSync(fd,data,0,data.length,null)!==data.length)return false;
   io.fsyncSync(fd);
  }catch{return false}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
  return syncDir();
 }
 function bookingOK(b){
  return b&&contractOK(b.contractID)&&keyOK(b.manifestKey)&&
   [b.systemID,b.fleetID,b.haulerID,b.stationID,b.corporationID,
    b.amountISK].every(pos)&&b.amountISK<=1000000000&&b.amountISK%2===0&&
   (!("playerFleetID" in b)||pos(b.playerFleetID))&&
   Array.isArray(b.characters)&&b.characters.length===2&&
   b.characters.every(pos)&&b.characters[0]<b.characters[1]&&
   typeof b.manifestDigest==="string"&&/^[a-f0-9]{64}$/.test(b.manifestDigest);
 }
 function manifestMatches(b){
  let found;try{found=readManifest(b.manifestKey)}catch{return false}
  const m=found?.record;
  return found?.status==="READY"&&m?.key===b.manifestKey&&sha(m)===b.manifestDigest&&
   m.systemID===b.systemID&&m.fleetID===b.fleetID&&
   m.stationID===b.stationID&&m.corporationID===b.corporationID&&
   equal(m.haulerIDs,[b.haulerID])&&Array.isArray(m.cargo)&&m.cargo.length>0;
 }
 function nativeVerified(b){
  let r;try{r=nativeFunds.verifyReservation(b)}catch{return false}
  return r?.status==="RESERVED"&&r.contractID===b.contractID&&
   r.corporationID===b.corporationID&&r.amountISK===b.amountISK&&
   r.escrowKey===b.contractID&&r.nativeDurable===true;
 }
 function read(manifestKey){
  if(!keyOK(manifestKey))return blocked("FLIGHT_MANIFEST_KEY_INVALID");
  let data;try{data=io.readFileSync(filename(manifestKey),"utf8")}
  catch(e){return blocked(e?.code==="ENOENT"?"FLIGHT_NOT_FOUND":"FLIGHT_JOURNAL_READ_FAILED")}
  if(typeof data!=="string"||data.length>16384||!data.endsWith("\n"))
   return blocked("FLIGHT_JOURNAL_CORRUPT");
  let events;try{events=data.trimEnd().split("\n").map(x=>JSON.parse(x))}
  catch{return blocked("FLIGHT_JOURNAL_CORRUPT")}
  if(events.length<1||events.length>3)return blocked("FLIGHT_JOURNAL_CORRUPT");
  const b=events[0]?.booking;
  if(!bookingOK(b)||b.manifestKey!==manifestKey)return blocked("FLIGHT_JOURNAL_CORRUPT");
  const phases=["FUNDING_PREPARED","FUNDED","DELIVERED"];
  for(let i=0;i<events.length;i++){
   const ev=events[i];
   if(ev?.v!==1||ev.phase!==phases[i]||ev.manifestKey!==manifestKey||
    !Number.isSafeInteger(ev.at)||ev.at<=0)return blocked("FLIGHT_JOURNAL_CORRUPT");
   if(i===0){if(ev.booking!==b)return blocked("FLIGHT_JOURNAL_CORRUPT")}
   else if(ev.booking!==undefined)return blocked("FLIGHT_JOURNAL_CORRUPT");
   if(i===2&&(!ev.delivery||ev.delivery.status!=="DELIVERED"||
     ev.delivery.nativeFullManifestProof?.key!==manifestKey))
     return blocked("FLIGHT_JOURNAL_CORRUPT");
  }
  if(!manifestMatches(b))return blocked("FLIGHT_MANIFEST_CHANGED");
  return {status:"READY",phase:phases[events.length-1],booking:b,
   delivery:events.length===3?events[2].delivery:null};
 }
 function enabled(){return process.env.EVEJS_COOP_ESCORT_ROUTE_GATE==="1"}
 function fundBeforeWarp(route){
  if(!enabled())return blocked("DISABLED");
  const key=route?.manifestKey;
  if(!keyOK(key)||!pos(route.systemID)||!pos(route.fleetID)||
   !pos(route.stationID)||!pos(route.corporationID)||
   !equal(route.haulerIDs,route.haulerIDs?.slice().sort((a,b)=>a-b))||
   route.haulerIDs.length!==1||!pos(route.haulerIDs[0]))
   return blocked("FLIGHT_ROUTE_IDENTITY_INVALID");
  let loaded;try{loaded=readManifest(key)}catch{return blocked("FLIGHT_MANIFEST_UNAVAILABLE")}
  const m=loaded?.record;
  if(loaded?.status!=="READY"||m?.key!==key||
   m.systemID!==route.systemID||m.fleetID!==route.fleetID||
   m.stationID!==route.stationID||m.corporationID!==route.corporationID||
   !equal(m.haulerIDs,route.haulerIDs))
   return blocked("FLIGHT_MANIFEST_NOT_VERIFIED");
  let offer;try{offer=authorizeBooking({manifestKey:key,systemID:m.systemID,
   fleetID:m.fleetID,stationID:m.stationID,corporationID:m.corporationID,
   haulerID:m.haulerIDs[0],cargoIDs:m.cargo.map(x=>x.cargoID)})}
  catch{return blocked("FLIGHT_BOOKING_AUTHORITY_UNAVAILABLE")}
  const b={contractID:offer?.contractID,manifestKey:key,systemID:m.systemID,
   fleetID:m.fleetID,haulerID:m.haulerIDs[0],stationID:m.stationID,
   corporationID:m.corporationID,characters:offer?.characters,
   ...(offer?.playerFleetID!==undefined?{playerFleetID:offer.playerFleetID}:{}),
   amountISK:offer?.amountISK,manifestDigest:sha(m)};
  if(offer?.status!=="AUTHORIZED_NATIVE_ESCORT_BOOKING"||!bookingOK(b)||
   offer?.manifestKey!==key||offer?.systemID!==m.systemID||
   offer?.fleetID!==m.fleetID||offer?.stationID!==m.stationID||
   offer?.corporationID!==m.corporationID||offer?.haulerID!==m.haulerIDs[0])
   return blocked("FLIGHT_BOOKING_NOT_AUTHORIZED");
  let caps;try{caps=nativeFunds.capabilities()}catch{}
  if(caps?.nativeDurable!==true||caps?.atomicDualCredit!==true||
   caps?.durableIdempotency!==true)return blocked("FLIGHT_NATIVE_WALLET_UNAVAILABLE");
  let before;try{before=nativeFunds.verifyReservation(b)}catch{
   return blocked("FLIGHT_RESERVATION_PREFLIGHT_UNAVAILABLE")}
  if(before?.status!=="NOT_FOUND")return blocked("FLIGHT_RESERVATION_NOT_EMPTY");
  // A valid manifest can be funded once only; PREPARED blocks all restarts.
  if(!append(key,{v:1,phase:"FUNDING_PREPARED",manifestKey:key,at:clock(),booking:b},true))
   return blocked("FLIGHT_FUNDING_PREPARE_UNCERTAIN");
  try{nativeFunds.reserveAtomic(b)}catch{}
  if(!nativeVerified(b))return blocked("FLIGHT_NATIVE_RESERVATION_UNCERTAIN_REPAIR_REQUIRED");
  if(!append(key,{v:1,phase:"FUNDED",manifestKey:key,at:clock()}))
   return blocked("FLIGHT_FUNDING_JOURNAL_UNCERTAIN");
  return {status:"FUNDED_BEFORE_WARP",contractID:b.contractID,manifestKey:key};
 }
 function recordDelivered({manifestKey,trip,terminalProof}={}){
  if(!enabled())return blocked("DISABLED");
  const current=read(manifestKey);
  if(current.status!=="READY")return current;
  if(current.phase==="DELIVERED"){
   // Crash after fsynced terminal commit but before native station ACK:
   // re-reading the SAME physical trip/proof is idempotent and cannot
   // generate cargo, corporate debits or a second delivery event.
   const b=current.booking,p=current.delivery?.nativeFullManifestProof;
   if(trip?.manifestID!==manifestKey||trip.systemID!==b.systemID||
    trip.fleetID!==b.fleetID||trip.stationID!==b.stationID||
    trip.corporationID!==b.corporationID||
    !equal(Object.keys(trip.haulers||{}).map(Number),[b.haulerID])||
    terminalProof?.status!=="DELIVERED"||terminalProof.terminal!==true||
    terminalProof.nativeFullManifestProof?.status!=="FULL_NATIVE_CARGO_DELIVERY_VERIFIED"||
    terminalProof.nativeFullManifestProof?.key!==manifestKey||
    terminalProof.nativeFullManifestProof?.stationID!==p?.stationID||
    !equal(terminalProof.nativeFullManifestProof?.haulerIDs,[b.haulerID])||
    !equal(terminalProof.nativeFullManifestProof?.cargoIDs,p?.cargoIDs)||
    terminalProof.nativeFullManifestProof?.stacks!==p?.stacks||
    terminalProof.nativeFullManifestProof?.quantity!==p?.quantity)
    return blocked("FLIGHT_DELIVERY_REPLAY_IDENTITY_CONFLICT");
   return {status:"DURABLE_NATIVE_DELIVERY_RECORDED",manifestKey,
    replayed:true};
  }
  if(current.phase!=="FUNDED")return blocked("FLIGHT_NOT_FUNDED");
  const b=current.booking;
  if(trip?.manifestID!==manifestKey||trip.systemID!==b.systemID||
   trip.fleetID!==b.fleetID||trip.stationID!==b.stationID||
   trip.corporationID!==b.corporationID||
   !equal(Object.keys(trip.haulers||{}).map(Number),[b.haulerID]))
   return blocked("FLIGHT_TERMINAL_TRIP_MISMATCH");
  if(!nativeVerified(b))return blocked("FLIGHT_ESCROW_NO_LONGER_RESERVED");
  let proof;try{proof=verifyManifest({key:manifestKey,systemID:b.systemID,
   fleetID:b.fleetID,stationID:b.stationID,corporationID:b.corporationID,
   haulerIDs:[b.haulerID]})}catch{return blocked("FLIGHT_NATIVE_MANIFEST_UNAVAILABLE")}
  const p=terminalProof?.nativeFullManifestProof;
  let manifest;try{manifest=readManifest(manifestKey)}catch{}
  if(proof?.status!=="FULL_NATIVE_CARGO_DELIVERY_VERIFIED"||
   p?.status!=="FULL_NATIVE_CARGO_DELIVERY_VERIFIED"||
   p?.key!==manifestKey||proof.key!==manifestKey||
   proof.stationID!==b.stationID||!equal(proof.haulerIDs,[b.haulerID])||
   !equal(proof.cargoIDs,manifest?.record?.cargo?.map(x=>x.cargoID))||
   !equal(p.cargoIDs,proof.cargoIDs)||!equal(p.haulerIDs,[b.haulerID])||
   terminalProof?.status!=="DELIVERED"||terminalProof.terminal!==true)
   return blocked("FLIGHT_COMPLETE_NATIVE_DELIVERY_UNVERIFIED");
  // Only the trusted station tick calls this AFTER its real native warp,
  // proximity, dwell and every warehouse receipt. No player RPC path.
  const delivery={status:"DELIVERED",terminal:true,nativeFullManifestProof:{
   status:proof.status,key:proof.key,stationID:proof.stationID,
   haulerIDs:proof.haulerIDs.slice(),cargoIDs:proof.cargoIDs.slice(),
   stacks:proof.stacks,quantity:proof.quantity,convoySaved:false,paidReward:false}};
  if(!append(manifestKey,{v:1,phase:"DELIVERED",manifestKey,at:clock(),delivery}))
   return blocked("FLIGHT_TERMINAL_RECEIPT_UNCERTAIN");
  return {status:"DURABLE_NATIVE_DELIVERY_RECORDED",manifestKey};
 }
 function readFunded(contract){
  if(!contractOK(contract?.contractID)||!keyOK(contract?.manifestKey))
   return blocked("FLIGHT_CONTRACT_IDENTITY_INVALID");
  const state=read(contract.manifestKey);
  if(state.status!=="READY")return state;
  const b=state.booking;
  if(state.phase!=="FUNDED"&&state.phase!=="DELIVERED")
   return blocked("FLIGHT_FUNDING_NOT_COMPLETE");
  if(["contractID","manifestKey","systemID","fleetID","haulerID",
      "stationID","corporationID","amountISK"].some(k=>b[k]!==contract[k])||
   !equal(b.characters,contract.characters))
   return blocked("FLIGHT_CONTRACT_IDENTITY_MISMATCH");
  if(!nativeVerified(b))return blocked("FLIGHT_NATIVE_RESERVATION_NOT_VERIFIED");
  return {status:"NATIVE_PREFUNDED_BOOKING_VERIFIED",contractID:b.contractID};
 }
 function readNativeDelivery(contract){
  const r=readFunded(contract);if(r.status!=="NATIVE_PREFUNDED_BOOKING_VERIFIED")return r;
  const state=read(contract.manifestKey);
  if(state.status!=="READY"||state.phase!=="DELIVERED")
   return blocked("FLIGHT_TERMINAL_DELIVERY_NOT_PERSISTED");
  const b=state.booking;
  let current;try{current=verifyManifest({key:b.manifestKey,systemID:b.systemID,
   fleetID:b.fleetID,stationID:b.stationID,corporationID:b.corporationID,
   haulerIDs:[b.haulerID]})}catch{}
  if(current?.status!=="FULL_NATIVE_CARGO_DELIVERY_VERIFIED"||
   !equal(current.cargoIDs,state.delivery.nativeFullManifestProof.cargoIDs))
   return blocked("FLIGHT_TERMINAL_STOCK_RECHECK_FAILED");
  return JSON.parse(JSON.stringify(state.delivery));
 }
 function readNativeDeliveryForAudit(contract){
  // READ ONLY after real dual-wallet settlement. Cannot be used as a
  // reservation proof, payout trigger, or pre-warp authorization.
  if(!contractOK(contract?.contractID)||!keyOK(contract?.manifestKey))
   return blocked("FLIGHT_CONTRACT_IDENTITY_INVALID");
  const state=read(contract.manifestKey);
  if(state.status!=="READY"||state.phase!=="DELIVERED")
   return blocked("FLIGHT_TERMINAL_DELIVERY_NOT_PERSISTED");
  const b=state.booking;
  if(["contractID","manifestKey","systemID","fleetID","haulerID",
   "stationID","corporationID","amountISK"].some(k=>b[k]!==contract[k])||
   !equal(b.characters,contract.characters))
   return blocked("FLIGHT_CONTRACT_IDENTITY_MISMATCH");
  let payment,stock;try{
   payment=nativeFunds.verifySettlement(contract);
   stock=verifyManifest({key:b.manifestKey,systemID:b.systemID,
    fleetID:b.fleetID,stationID:b.stationID,
    corporationID:b.corporationID,haulerIDs:[b.haulerID]});
  }catch{return blocked("FLIGHT_AUDIT_AUTHORITIES_UNAVAILABLE")}
  if(payment?.status!=="SETTLED"||payment.nativeDurable!==true||
   payment.contractID!==b.contractID||
   payment.corporationID!==b.corporationID||
   payment.amountISK!==b.amountISK||
   !Array.isArray(payment.credits)||payment.credits.length!==2||
   payment.credits.some((x,i)=>x.characterID!==b.characters[i]||
    x.amountISK!==b.amountISK/2))
   return blocked("FLIGHT_AUDIT_WALLET_NOT_SETTLED");
  if(stock?.status!=="FULL_NATIVE_CARGO_DELIVERY_VERIFIED"||
   stock.key!==b.manifestKey||
   !equal(stock.cargoIDs,state.delivery.nativeFullManifestProof.cargoIDs))
   return blocked("FLIGHT_AUDIT_WAREHOUSE_MISMATCH");
  return JSON.parse(JSON.stringify(state.delivery));
 }

 // Disk-backed recovery enumeration. NEVER treats directory presence as proof
 // of payment or of delivery: each candidate is fully replay-verified by read.
 // An unreadable/ambiguous journal poisons the WHOLE pass (no partial payout).
 function listDelivered({systemID=null,maxTrips=64,afterKey=null}={}){
  if(systemID!==null&&!pos(systemID))return blocked("FLIGHT_SCAN_SYSTEM_INVALID");
  if(!Number.isSafeInteger(maxTrips)||maxTrips<1||maxTrips>64)
   return blocked("FLIGHT_SCAN_LIMIT_INVALID");
  if(afterKey!==null&&!keyOK(afterKey))
   return blocked("FLIGHT_SCAN_CURSOR_INVALID");
  let files;
  try{files=io.readdirSync(dir)}
  catch(e){return e?.code==="ENOENT"?
   {status:"READY",manifestKeys:[],hasMore:false,nextAfterKey:null}:
   blocked("FLIGHT_SCAN_READ_UNAVAILABLE")}
  if(!Array.isArray(files)||files.length>512)
   return blocked("FLIGHT_SCAN_CAP_EXCEEDED");
  const names=files.filter(x=>typeof x==="string"&&
   /^\d+-\d+-\d+\.jsonl$/.test(x)).sort();
  if(names.length>512)return blocked("FLIGHT_SCAN_CAP_EXCEEDED");
  const found=[];
  for(const name of names){
   const full=path.join(dir,name);
   // No following an operator-created symlink into another live file.
   let fileInfo;
   try{fileInfo=io.lstatSync(full)}
   catch{return blocked("FLIGHT_SCAN_METADATA_UNAVAILABLE")}
   if(!fileInfo||fileInfo.isSymbolicLink()||!fileInfo.isFile())
    return blocked("FLIGHT_SCAN_NONREGULAR_JOURNAL");
   const key=name.slice(0,-6);
   const state=read(key);
   if(state.status!=="READY")
    return blocked("FLIGHT_SCAN_UNVERIFIED_JOURNAL");
   if(state.phase!=="DELIVERED")continue;
   if(systemID!==null&&state.booking.systemID!==systemID)continue;
   if(afterKey!==null&&key<=afterKey)continue;
   found.push(key);
  }
  // All original journals are validated before any page reaches wallet
  // reconciliation. Later corruption must poison the entire scan.
  const manifestKeys=found.slice(0,maxTrips);
  const hasMore=found.length>manifestKeys.length;
  return {status:"READY",manifestKeys,hasMore,
   nextAfterKey:hasMore?manifestKeys[manifestKeys.length-1]:null};
 }
 return {fundBeforeWarp,recordDelivered,read,readFunded,readNativeDelivery,readNativeDeliveryForAudit,listDelivered};
}
module.exports={createEscortFlightGate};
