"use strict";
// Stage E: opt-in native EveJS provider assembler. The SAME gameStore
// transaction owner writes corporation escrow and both character balances.
// Runtime is never installed without a real operator-approved offer,
// two independent player consents and a live stock EVE fleet.
const {createEscortRuntime}=require("./coopEscortRuntime");
const {createManifest}=require("./coopNativeHaulManifest");
const {createOperations}=require("./coopConvoyOperations");
const {createOutcomes}=require("./coopConvoyOutcomeProof");
const {inSpaceParty}=require("./coopNativeFleetParty");
const pos=x=>Number.isSafeInteger(x)&&x>0;
const same=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&
 a.every((v,i)=>v===b[i]);
const deny=status=>({status});
function createNativeMount({root,gameStore,corporations,npcStore,items,
 sessions,spaceRuntime,fleetRuntime,readAuthorizedOffer,readPilotConsent,
 readNativeFailure,readIncidents=null,readOutcomes=null,clock=()=>Date.now(),
 verifyNativeParty=inSpaceParty}={}){
 if(typeof root!=="string"||!require("node:path").isAbsolute(root)||
  !gameStore||typeof gameStore.coopAtomicNativeRows?.transact!=="function"||
  gameStore.coopAtomicNativeRows.mode!=="SERVER_INTERNAL_FLAGGED"||
  typeof gameStore.coopAtomicNativeRows.isPoisoned!=="function"||
  gameStore.coopAtomicNativeRows.isPoisoned()!==false||
  typeof corporations?.isNpcCorporationID!=="function"||
  typeof npcStore?.getNativeEntity!=="function"||
  typeof npcStore?.listNativeCargoForEntity!=="function"||
  typeof items?.findWarehouseItem!=="function"||
  typeof sessions?.getSessions!=="function"||
  typeof spaceRuntime?.getSceneForSession!=="function"||
  typeof fleetRuntime?.getFleetForCharacter!=="function"||
  typeof fleetRuntime?.getMemberRecord!=="function"||
  [readAuthorizedOffer,readPilotConsent,readNativeFailure,clock,verifyNativeParty]
   .some(f=>typeof f!=="function"))
  throw Error("ESCORT_PINNED_NATIVE_PROVIDER_AUTHORITIES_REQUIRED");
 const manifest=createManifest({root,store:npcStore,items,
  getNativeEntity:npcStore.getNativeEntity,clock});
 // Genuine combat/cargo journals. They remain independently authoritative.
 const inc=readIncidents||(()=>createOperations().snapshot());
 const outcomes=readOutcomes||(()=>createOutcomes({incidents:inc}).snapshot());
 const approved=new Map(); // cache is NOT durable authority; re-read server offer below.
 function approve(route){
  if(!route||typeof route.manifestKey!=="string"||
   !/^\d+-\d+-\d+$/.test(route.manifestKey)||
   ![route.systemID,route.fleetID,route.stationID,route.corporationID]
    .every(pos)||!Array.isArray(route.haulerIDs)||route.haulerIDs.length!==1||
   !pos(route.haulerIDs[0]))return deny("DENIED_PREWARP_ROUTE_INVALID");
  let a,source;try{source=manifest.read(route.manifestKey);a=readAuthorizedOffer(route)}
  catch{return deny("DENIED_NATIVE_OFFER_UNAVAILABLE")}
  if(source?.status!=="READY"||
   source.record.systemID!==route.systemID||
   source.record.fleetID!==route.fleetID||
   source.record.stationID!==route.stationID||
   source.record.corporationID!==route.corporationID||
   !same(source.record.haulerIDs,route.haulerIDs))
   return deny("DENIED_PREWARP_MANIFEST_UNVERIFIED");
  if(a?.status!=="AUTHORIZED_NATIVE_ESCORT_BOOKING"||
   a.manifestKey!==route.manifestKey||
   a.systemID!==route.systemID||a.fleetID!==route.fleetID||
   a.stationID!==route.stationID||a.corporationID!==route.corporationID||
   a.haulerID!==route.haulerIDs[0]||
   !Array.isArray(a.characters)||a.characters.length!==2||
   !a.characters.every(pos)||a.characters[0]>=a.characters[1]||
   !pos(a.playerFleetID)||!pos(a.amountISK)||
   !pos(a.quoteExpiresAt)||a.quoteExpiresAt<=clock()||
   a.amountISK>1000000000||a.amountISK%2!==0||
   typeof a.contractID!=="string"||
   !/^escort-[a-zA-Z0-9-]{1,48}$/.test(a.contractID)||
   corporations.isNpcCorporationID(a.corporationID)!==true)
   return deny("DENIED_NATIVE_APPROVED_OFFER_MISMATCH");
  // Never use the caller's price or identities: they come exclusively from
  // the server-approved persisted offer and native character database.
  approved.set(route.manifestKey,{...a,characters:a.characters.slice()});
  if(approved.size>128)approved.delete(approved.keys().next().value);
  return a;
 }
 function duo({systemID,fleetID,manifestKey,haulerID,contractID,characters}={}){
  let a=approved.get(manifestKey);
  // The in-memory cache is a pre-warp optimization ONLY. After a process
  // restart it is empty, although the exact accepted NPC route, player
  // signatures and escrow are durable. Recovery must reconstruct identity
  // exclusively from the original persisted native cargo manifest and
  // server-side accepted quote, never from a client/caller supplied booking.
  if(!a){
   let source;
   try{source=manifest.read(manifestKey)}
   catch{return deny("NATIVE_DUO_DURABLE_MANIFEST_UNAVAILABLE")}
   const m=source?.record;
   if(source?.status!=="READY"||m?.key!==manifestKey||
    m.systemID!==systemID||!pos(m.fleetID)||
    !pos(m.stationID)||!pos(m.corporationID)||
    !same(m.haulerIDs,[haulerID])||
    !Array.isArray(m.cargo)||m.cargo.length===0)
    return deny("NATIVE_DUO_DURABLE_MANIFEST_MISMATCH");
   try{a=readAuthorizedOffer({manifestKey,systemID:m.systemID,
    fleetID:m.fleetID,stationID:m.stationID,
    corporationID:m.corporationID,haulerIDs:[haulerID]})}
   catch{return deny("NATIVE_DUO_DURABLE_ACCEPTANCE_UNAVAILABLE")}
   if(a?.status!=="AUTHORIZED_NATIVE_ESCORT_BOOKING"||
    a.manifestKey!==manifestKey||a.systemID!==m.systemID||
    a.fleetID!==m.fleetID||a.stationID!==m.stationID||
    a.corporationID!==m.corporationID||a.haulerID!==haulerID||
    !pos(a.amountISK)||a.amountISK>1000000000||
    a.amountISK%2!==0)
    return deny("NATIVE_DUO_DURABLE_ACCEPTANCE_MISMATCH");
  }
  if(a.contractID!==contractID||a.haulerID!==haulerID||
   a.systemID!==systemID||a.playerFleetID!==fleetID||
   !same(a.characters,characters))
   return deny("NATIVE_DUO_OFFER_UNAVAILABLE");
  let consent,online,party;
  try{consent=readPilotConsent({manifestKey,contractID,haulerID,
    systemID,playerFleetID:fleetID,characters:characters.slice()});
   online=sessions.getSessions()}catch{return deny("NATIVE_DUO_CONSENT_UNAVAILABLE")}
  if(consent?.status!=="DURABLE_TWO_PILOT_CONSENT"||
   consent.manifestKey!==manifestKey||
   consent.contractID!==contractID||
   consent.haulerID!==haulerID||
   consent.fleetID!==fleetID||
   !same(consent.characters,characters)||
   !Array.isArray(online))return deny("NATIVE_DUO_CONSENT_NOT_VERIFIED");
  // Unique connected auth session and in-space ship for each real pilot.
  const pilots=characters.map(c=>online.filter(s=>s?.characterID===c&&
   s?.socket?.destroyed!==true&&s?._space?.initialStateSent===true&&
   s._space?.systemID===systemID&&pos(s._space?.shipID)));
  if(pilots.some(p=>p.length!==1))return deny("NATIVE_DUO_ACTIVE_SESSIONS_UNVERIFIED");
  try{party=verifyNativeParty({leaderSession:pilots[0][0],
    peerSession:pilots[1][0],fleetRuntime,spaceRuntime})}
  catch{return deny("NATIVE_DUO_FLEET_UNAVAILABLE")}
  if(party?.ok!==true||party.fleetID!==fleetID||
   party.systemID!==systemID||
   !pos(party.leaderShipID)||!pos(party.peerShipID))
   return deny("NATIVE_DUO_REAL_FLEET_NOT_VERIFIED");
  const scene=spaceRuntime.getSceneForSession(pilots[0][0]);
  const npc=scene?.getEntityByID?.(haulerID);
  if(scene?.systemID!==systemID||npc?.nativeNpc!==true||
   npc.kind!=="ship"||npc.itemID!==haulerID||npc.transient===true)
   return deny("NATIVE_DUO_TARGET_HAULER_MISSING");
  return {status:"VERIFIED_NATIVE_DUO_FLEET",fleetID,
   characters:characters.slice()};
 }
 const readOfferForContract=contract=>{
  let offer;
  try{offer=readAuthorizedOffer({
   manifestKey:contract.manifestKey,systemID:contract.systemID,
   fleetID:contract.fleetID,stationID:contract.stationID,
   corporationID:contract.corporationID,
   haulerIDs:[contract.haulerID]})}catch{return deny("DENIED_NATIVE_OFFER_UNAVAILABLE")}
  if(offer?.status!=="AUTHORIZED_NATIVE_ESCORT_BOOKING"||
   offer.contractID!==contract.contractID||
   offer.manifestKey!==contract.manifestKey||
   offer.corporationID!==contract.corporationID||
   offer.amountISK!==contract.amountISK||
   !same(offer.characters,contract.characters))
   return deny("DENIED_NATIVE_OFFER_IDENTITY_CHANGED");
  return {status:"AUTHORIZED_NATIVE_ESCORT",...contract};
 };
 const runtime=createEscortRuntime({root,clock,
  atomicRows:gameStore.coopAtomicNativeRows,
  isNpcCorporation:corporations.isNpcCorporationID,
  authorizeBooking:approve,verifyNativeDuo:duo,
  authorizeOffer:readOfferForContract,
  readManifest:manifest.read,verifyManifest:manifest.verify,
  readIncidents:inc,readOutcomes:outcomes,readNativeFailure});
 return {runtime,readNativeIncident:inc};
}
// The following loader uses exact native EveJS services, but cannot
// provide authorization. A server-owned offer and consent producer MUST
// supply both callbacks before calling it, otherwise no runtime is installed.
function installPinnedNative({readAuthorizedOffer,readPilotConsent,
 readNativeFailure,root=process.env.EVEJS_COOP_NPC_WAREHOUSE_DIR||
 "/var/lib/evejs/coop-native-warehouse"}={}){
 if(process.env.EVEJS_COOP_ESCORT_RUNTIME_MOUNT!=="1")
  return deny("DISABLED");
 if([readAuthorizedOffer,readPilotConsent,readNativeFailure]
  .some(x=>typeof x!=="function"))
  return deny("NATIVE_OFFER_AND_CONSENT_PRODUCER_NOT_WIRED");
 try{
  const o=createNativeMount({root,readAuthorizedOffer,
   readPilotConsent,readNativeFailure,
   gameStore:require("../gameStore"),
   corporations:require("../services/corporation/corporationState"),
   npcStore:require("./npc/nativeNpcStore"),
   items:require("../services/inventory/itemStore"),
   sessions:require("../services/chat/sessionRegistry"),
   spaceRuntime:require("./runtime"),
   fleetRuntime:require("../services/fleets/fleetRuntime")});
  // The same authoritative native terminal engine is the ONLY history
  // writer. Player chat /events history is read-only; it cannot award XP.
  const reputation=require("./coopEscortReputation").createReputation({
   root:process.env.EVEJS_DATA_ROOT||"/var/lib/evejs",
   readContract:o.runtime.readContract,
   verifySettlement:c=>o.runtime.nativeFunds.verifySettlement(c),
   verifyRefund:c=>o.runtime.nativeFunds.verifyRefund(c),
   readProof:c=>o.runtime.proof(c)});
  return require("./coopEscortNativeBinding").installServerAuthority({
   ...o,
   recordTerminal:contractID=>reputation.recordVerified(contractID)
  });
 }catch{return deny("NATIVE_RUNTIME_MOUNT_UNAVAILABLE")}
}
module.exports={createNativeMount,installPinnedNative};
