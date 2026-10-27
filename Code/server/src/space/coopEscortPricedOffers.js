"use strict";
// Price-bound, dual explicit native consent. Chat cannot mint a quote, debit
// ISK or choose a recipient. An accepted offer is not yet a reservation.
const fs=require("node:fs"),path=require("node:path");
const pos=x=>Number.isSafeInteger(x)&&x>0;
const eventKey=x=>typeof x==="string"&&/^convoy-\d+-\d+-\d+$/.test(x);
const quoteKey=x=>typeof x==="string"&&/^escort-\d+-\d+-\d+$/.test(x);
const same=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&
 a.every((x,i)=>x===b[i]);
const fail=status=>({status});
function createPricedOffers({root,io=fs,clock=()=>Date.now(),readEvent,
 authorizeNativeQuote,readDuoVolunteers,verifyLiveAcceptingPilot,readManifest}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||
  [clock,readEvent,authorizeNativeQuote,readDuoVolunteers,
   verifyLiveAcceptingPilot,readManifest].some(x=>typeof x!=="function"))
  throw Error("ESCORT_PRICED_OFFER_AUTHORITIES_REQUIRED");
 const dir=path.join(root,"coop-opportunities","priced-escorts");
 const quoteFile=id=>path.join(dir,id+".quote.json");
 const acceptFile=(id,c)=>path.join(dir,id+".pilot-"+c+".json");
 const pairFile=id=>path.join(dir,id+".accepted.json");
 function load(file){
  let s;try{s=io.readFileSync(file,"utf8")}
  catch(e){return fail(e?.code==="ENOENT"?"NOT_FOUND":"PERSISTED_READ_UNAVAILABLE")}
  if(typeof s!=="string"||s.length>4096||!s.endsWith("\n"))
   return fail("PERSISTED_RECORD_CORRUPT");
  try{return {status:"READY",value:JSON.parse(s.trim())}}
  catch{return fail("PERSISTED_RECORD_CORRUPT")}
 }
 function write(file,record){
  let fd;try{
   io.mkdirSync(dir,{recursive:true});
   const bytes=Buffer.from(JSON.stringify(record)+"\n");
   if(bytes.length>4096)return fail("PERSISTED_RECORD_TOO_LONG");
   fd=io.openSync(file,"wx",0o600);
   if(io.writeSync(fd,bytes,0,bytes.length,null)!==bytes.length)
    return fail("PERSISTED_WRITE_UNCERTAIN");
   io.fsyncSync(fd);
  }catch{return fail("PERSISTED_EXISTS_OR_WRITE_UNCERTAIN")}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
  let directory;try{directory=io.openSync(dir,"r");io.fsyncSync(directory)}
  catch{return fail("PERSISTED_DIRECTORY_SYNC_UNCERTAIN")}
  finally{if(directory!==undefined)try{io.closeSync(directory)}catch{}}
  return {status:"DURABLY_WRITTEN"};
 }
 function quoteFromNative({eventID,route}={}){
  if(process.env.EVEJS_COOP_ESCORT_PAID_ACCEPT!=="1")return fail("DISABLED");
  if(!eventKey(eventID)||!route||![route.systemID,route.fleetID,
   route.stationID,route.corporationID,route.haulerID].every(pos)||
   !Array.isArray(route.cargoIDs)||!route.cargoIDs.length||
   !route.cargoIDs.every(pos)||new Set(route.cargoIDs).size!==route.cargoIDs.length)
   return fail("NATIVE_QUOTE_ROUTE_INVALID");
  const existing=readQuote(eventID);
  if(existing.status==="READY"){
   const q=existing.quote;
   return q.systemID===route.systemID&&q.fleetID===route.fleetID&&
    q.stationID===route.stationID&&q.corporationID===route.corporationID&&
    q.haulerID===route.haulerID&&same(q.cargoIDs,route.cargoIDs.slice().sort((a,b)=>a-b))?
    {status:"NATIVE_QUOTE_READY",quote:q}:fail("NATIVE_QUOTE_ROUTE_CONFLICT");
  }
  if(existing.status!=="NOT_FOUND")return existing;
  let event,approved;
  try{event=readEvent(eventID);approved=authorizeNativeQuote({event,route})}
  catch{return fail("NATIVE_QUOTE_AUTHORITY_UNAVAILABLE")}
  const e=event?.event,now=clock();
  if(event?.status!=="READY"||e?.id!==eventID||
   e.phase!=="ACTIVE"||e.stage!=="PREPARING"||e.type!=="CONVOY"||
   e.systemID!==route.systemID||e.entityID!==route.haulerID||
   e.stationID!==route.stationID||!pos(e.expiresAt)||e.expiresAt<=now)
   return fail("NATIVE_PREPARING_EVENT_UNVERIFIED");
  const contractID="escort-"+route.systemID+"-"+route.fleetID+"-"+Math.min(...route.cargoIDs);
  if(!quoteKey(contractID)||eventID!=="convoy-"+route.systemID+"-"+route.fleetID+"-"+Math.min(...route.cargoIDs))
   return fail("NATIVE_QUOTE_IDENTITY_CONFLICT");
  if(approved?.status!=="AUTHORIZED_NATIVE_CORPORATION_ESCORT_QUOTE"||
   approved.eventID!==eventID||approved.contractID!==contractID||
   approved.systemID!==route.systemID||approved.fleetID!==route.fleetID||
   approved.stationID!==route.stationID||
   approved.corporationID!==route.corporationID||
   approved.haulerID!==route.haulerID||
   !same(approved.cargoIDs,route.cargoIDs.slice().sort((a,b)=>a-b))||
   !pos(approved.amountISK)||approved.amountISK>1000000000||
   approved.amountISK%2!==0||approved.nativeCorporationBalanceVerified!==true)
   return fail("NATIVE_CORPORATE_QUOTE_NOT_AUTHORIZED");
  const quote={v:1,eventID,contractID,systemID:route.systemID,
   fleetID:route.fleetID,stationID:route.stationID,
   corporationID:route.corporationID,haulerID:route.haulerID,
   cargoIDs:route.cargoIDs.slice().sort((a,b)=>a-b),
   amountISK:approved.amountISK,createdAt:now,expiresAt:e.expiresAt};
  const saved=write(quoteFile(eventID),quote);
  return saved.status==="DURABLY_WRITTEN"?
   {status:"NATIVE_QUOTE_DURABLY_PREPARED",quote}:saved;
 }
 function readQuote(eventID){
  if(!eventKey(eventID))return fail("INVALID_EVENT_ID");
  const r=load(quoteFile(eventID));
  if(r.status!=="READY")return r;
  const q=r.value;
  if(q?.v!==1||q.eventID!==eventID||
   q.contractID!=="escort-"+q.systemID+"-"+q.fleetID+"-"+q.cargoIDs?.[0]||
   !quoteKey(q.contractID)||
   ![q.systemID,q.fleetID,q.stationID,q.corporationID,q.haulerID,
    q.amountISK,q.createdAt,q.expiresAt].every(pos)||
   q.amountISK>1000000000||q.amountISK%2!==0||
   q.expiresAt<=q.createdAt||
   !Array.isArray(q.cargoIDs)||q.cargoIDs.length===0||
   q.cargoIDs.some((x,i)=>!pos(x)||(i>0&&q.cargoIDs[i-1]>=x)))
   return fail("NATIVE_QUOTE_CORRUPT");
  return {status:"READY",quote:q};
 }
 function readAccepted(eventID){
  const r=readQuote(eventID);if(r.status!=="READY")return r;
  const x=load(pairFile(eventID));
  if(x.status!=="READY")return x;
  const p=x.value,q=r.quote;
  if(p?.v!==1||p.eventID!==eventID||p.contractID!==q.contractID||
   p.amountISK!==q.amountISK||!pos(p.fleetID)||
   !Array.isArray(p.characters)||p.characters.length!==2||
   !p.characters.every(pos)||p.characters[0]>=p.characters[1]||
   !pos(p.acceptedAt)||p.acceptedAt>q.expiresAt)
   return fail("NATIVE_ACCEPTANCE_CORRUPT");
  for(const c of p.characters){
   const a=load(acceptFile(eventID,c));
   if(a.status!=="READY"||a.value?.eventID!==eventID||
    a.value.contractID!==q.contractID||
    a.value.amountISK!==q.amountISK||
    a.value.characterID!==c||a.value.fleetID!==p.fleetID)
    return fail("NATIVE_ACCEPTANCE_PILOT_RECEIPT_MISSING_OR_CORRUPT");
  }
  return {status:"DURABLE_TWO_PILOT_PAID_ACCEPTANCE",
   eventID,contractID:p.contractID,amountISK:p.amountISK,
   fleetID:p.fleetID,characters:p.characters.slice(),quote:q};
 }
 function accept(session,eventID){
  if(process.env.EVEJS_COOP_ESCORT_PAID_ACCEPT!=="1")return fail("DISABLED");
  const read=readQuote(eventID);
  if(read.status!=="READY")return fail("NATIVE_PRICED_OFFER_NOT_READY");
  const q=read.quote,now=clock();
  if(!pos(now)||q.expiresAt<=now)return fail("NATIVE_PRICED_OFFER_EXPIRED");
  let duo,pilot;
  try{duo=readDuoVolunteers(eventID);
   pilot=verifyLiveAcceptingPilot({session,eventID,quote:q,volunteers:duo})}
  catch{return fail("NATIVE_PAID_ACCEPT_AUTHORITIES_UNAVAILABLE")}
  if(duo?.status!=="VERIFIED_NATIVE_DUO_VOLUNTEER"||
   duo.eventID!==eventID||duo.systemID!==q.systemID||
   duo.entityID!==q.haulerID||!pos(duo.fleetID)||
   !Array.isArray(duo.pilots)||duo.pilots.length!==2||
   duo.pilots[0].characterID>=duo.pilots[1].characterID||
   pilot?.status!=="VERIFIED_NATIVE_ESCORT_ACCEPTOR"||
   !pos(pilot.characterID)||pilot.characterID!==session?.characterID||
   pilot.fleetID!==duo.fleetID||pilot.systemID!==q.systemID||
   !duo.pilots.some(x=>x.characterID===pilot.characterID&&
    x.shipID===pilot.shipID))
   return fail("PAID_ACCEPT_NEEDS_VERIFIED_NATIVE_DUO");
  const c=pilot.characterID,own=load(acceptFile(eventID,c));
  if(own.status==="NOT_FOUND"){
   const r=write(acceptFile(eventID,c),{v:1,eventID,contractID:q.contractID,
    amountISK:q.amountISK,characterID:c,fleetID:duo.fleetID,
    shipID:pilot.shipID,acceptedAt:now});
   if(r.status!=="DURABLY_WRITTEN")return r;
  }else if(own.status!=="READY"||own.value?.eventID!==eventID||
   own.value?.contractID!==q.contractID||
   own.value?.amountISK!==q.amountISK||
   own.value?.fleetID!==duo.fleetID||
   own.value?.shipID!==pilot.shipID)
   return fail("PAID_ACCEPT_DUPLICATE_IDENTITY_CONFLICT");
  const pair=readAccepted(eventID);
  if(pair.status==="DURABLE_TWO_PILOT_PAID_ACCEPTANCE")return pair;
  if(pair.status!=="NOT_FOUND")return pair;
  const characters=duo.pilots.map(x=>x.characterID);
  for(const char of characters){
   const ack=load(acceptFile(eventID,char));
   const witness=duo.pilots.find(x=>x.characterID===char);
   if(ack.status==="NOT_FOUND")return {status:"WAITING_FOR_OTHER_PAID_ACCEPTOR",
    eventID,contractID:q.contractID,amountISK:q.amountISK};
   if(ack.status!=="READY"||
    ack.value?.eventID!==eventID||
    ack.value?.contractID!==q.contractID||
    ack.value?.amountISK!==q.amountISK||
    ack.value?.characterID!==char||
    ack.value?.shipID!==witness.shipID||
    ack.value?.fleetID!==duo.fleetID)
    return fail("PAID_ACCEPT_PILOT_IDENTITY_CHANGED");
  }
  const stored=write(pairFile(eventID),{v:1,eventID,
   contractID:q.contractID,amountISK:q.amountISK,
   fleetID:duo.fleetID,characters,acceptedAt:now});
  if(stored.status!=="DURABLY_WRITTEN")return stored;
  return readAccepted(eventID);
 }
 function acceptedForManifest({manifestKey,systemID,fleetID,stationID,
  corporationID,haulerID}={}){
  if(typeof manifestKey!=="string"||!/^\d+-\d+-\d+$/.test(manifestKey))
   return fail("MANIFEST_KEY_INVALID");
  let m;try{m=readManifest(manifestKey)}catch{return fail("MANIFEST_SOURCE_UNAVAILABLE")}
  const x=m?.record;
  // Missing optional route fields are sourced ONLY from the native persisted
  // manifest. Explicit supplied fields must still match exactly.
  if(m?.status!=="READY"||x?.key!==manifestKey)return fail("ACCEPTED_MANIFEST_MISMATCH");
  systemID=systemID===undefined?x.systemID:systemID;
  fleetID=fleetID===undefined?x.fleetID:fleetID;
  stationID=stationID===undefined?x.stationID:stationID;
  corporationID=corporationID===undefined?x.corporationID:corporationID;
  haulerID=haulerID===undefined?x.haulerIDs?.[0]:haulerID;
  if(x.systemID!==systemID||x.fleetID!==fleetID||
   x.stationID!==stationID||x.corporationID!==corporationID||
   !same(x.haulerIDs,[haulerID])||
   !Array.isArray(x.cargo)||x.cargo.length===0)
   return fail("ACCEPTED_MANIFEST_MISMATCH");
  const ids=x.cargo.map(y=>y.cargoID).sort((a,b)=>a-b);
  if(ids.some(y=>!pos(y)))return fail("ACCEPTED_MANIFEST_CARGO_INVALID");
  const eventID="convoy-"+systemID+"-"+fleetID+"-"+ids[0];
  const r=readAccepted(eventID);if(r.status!=="DURABLE_TWO_PILOT_PAID_ACCEPTANCE")
   return fail("PAID_DUO_ACCEPTANCE_NOT_COMPLETE");
  const q=r.quote;
  // Quote expiry is enforced at FIRST NATIVE RESERVE by the authoritative
  // booking gate. After real funded departure, read-only offer provenance must
  // still be verifiable for late physical delivery/settlement.
  if(q.systemID!==systemID||q.fleetID!==fleetID||
   q.stationID!==stationID||q.corporationID!==corporationID||
   q.haulerID!==haulerID||!same(q.cargoIDs,ids))
   return fail("ACCEPTED_QUOTE_SOURCE_MISMATCH");
  return {status:"AUTHORIZED_NATIVE_ESCORT_BOOKING",
   eventID,contractID:q.contractID,manifestKey,systemID,fleetID,
   stationID,corporationID,haulerID,amountISK:q.amountISK,
   characters:r.characters,playerFleetID:r.fleetID,
   quoteExpiresAt:q.expiresAt};
 }
 return {quoteFromNative,readQuote,accept,readAccepted,acceptedForManifest};
}
// Optional server-side API. No caller can enable payout merely by typing
// /events accept: an operator-installed trusted quote authority is mandatory.
let authority=null;
function installServerAuthority(api){
 if(process.env.EVEJS_COOP_ESCORT_PAID_ACCEPT!=="1")return fail("DISABLED");
 if(authority)return fail("PRICED_ESCORT_AUTHORITY_ALREADY_INSTALLED");
 if(!api||["quoteFromNative","readQuote","accept","readAccepted",
  "acceptedForManifest"].some(k=>typeof api[k]!=="function"))
  return fail("PRICED_ESCORT_NATIVE_AUTHORITY_REQUIRED");
 authority=api;return {status:"PRICED_ESCORT_NATIVE_AUTHORITY_INSTALLED"};
}
function offerFromNative(route){
 const result=authority?authority.quoteFromNative(route):
  fail("PRICED_ESCORT_NATIVE_AUTHORITY_UNAVAILABLE");
 if(["NATIVE_QUOTE_DURABLY_PREPARED","NATIVE_QUOTE_READY"].includes(result?.status)&&
  process.env.EVEJS_COOP_NATIVE_JOB_AGENT==="1"&&
  process.env.EVEJS_COOP_OPPORTUNITY_MAIL==="1"){
  // Also dispatch on a verified replay of the ORIGINAL persisted quote:
  // the process may have crashed after storing it but before EVEmail dispatch.
  // Mail has a durable per-character/event pre-send claim, so a recheck
  // cannot send duplicates or create a fresh priced offer.
  // Notification never changes price, cargo provenance or escrow.
  try{require("./coopNativeJobNotifications").notifyNativeQuote(result.quote)}
  catch{/* Native mail is optional; contract remains source of truth. */}
 }
 return result;
}
function readVisibleQuote(eventID){
 return authority?authority.readQuote(eventID):fail("PRICED_ESCORT_NATIVE_AUTHORITY_UNAVAILABLE");
}
function acceptInGame(session,eventID){
 return authority?authority.accept(session,eventID):
  fail("PRICED_ESCORT_NATIVE_AUTHORITY_UNAVAILABLE");
}
function approvedForManifest(route){
 return authority?authority.acceptedForManifest(route):
  fail("PRICED_ESCORT_NATIVE_AUTHORITY_UNAVAILABLE");
}
function readNativeAccepted(eventID){
 return authority?authority.readAccepted(eventID):
  fail("PRICED_ESCORT_NATIVE_AUTHORITY_UNAVAILABLE");
}
function consentForManifest({manifestKey,contractID,haulerID,systemID,
 playerFleetID,characters}={}){
 if(!authority)return fail("PRICED_ESCORT_NATIVE_AUTHORITY_UNAVAILABLE");
 if(typeof manifestKey!=="string"||!/^\d+-\d+-\d+$/.test(manifestKey))
  return fail("MANIFEST_KEY_INVALID");
 // Look up original route through its authentic prewarp manifest.
 // The caller must supply station, corporation and NPC fleet from the
 // same immutable source; they are not inferred from the chat session.
 const route=arguments[0];
 const a=authority.acceptedForManifest(route);
 if(a.status!=="AUTHORIZED_NATIVE_ESCORT_BOOKING"||
  a.contractID!==contractID||a.haulerID!==haulerID||
  a.systemID!==systemID||a.playerFleetID!==playerFleetID||
  !same(a.characters,characters))
  return fail("PRICED_DUO_CONSENT_NOT_VERIFIED");
 return {status:"DURABLE_TWO_PILOT_CONSENT",manifestKey,
  contractID,haulerID,systemID,fleetID:playerFleetID,
  characters:a.characters.slice()};
}

module.exports={createPricedOffers,installServerAuthority,offerFromNative,
 readVisibleQuote,acceptInGame,approvedForManifest,readNativeAccepted,consentForManifest};
