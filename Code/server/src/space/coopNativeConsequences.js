"use strict";
// Player choices affect the authoritative EveJS standingRuntime, not a
// parallel arbitrary reputation score. Native mining aggression is real
// evidence; only a proven player character may receive a standing event.
const fs=require("node:fs"),path=require("node:path");
const positive=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const finite=x=>Number.isFinite(Number(x))?Number(x):0;
function createConsequences({file,apply,clock=()=>Date.now()}){
 if(!file||typeof apply!=="function")throw Error("standing ledger requires file and EveJS callback");
 let state={version:1,events:{},totals:{assault:0,pirateKill:0,defense:0}};
 try{
  const saved=JSON.parse(fs.readFileSync(file,"utf8"));
  if(saved?.version!==1||!saved.events||!saved.totals)throw Error("invalid saved standing ledger");
  state=saved;
 }catch(e){if(e.code!=="ENOENT")throw e;}
 const save=()=>{
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+".tmp-"+process.pid;
  fs.writeFileSync(tmp,JSON.stringify(state));fs.renameSync(tmp,file);
 };
 function applyOnce({key,characterID,ownerID,rawChange,kind,description,systemID}){
  if(!key||!positive(characterID)||!positive(ownerID)||!Number.isFinite(rawChange)||!rawChange)
   return {status:"INVALID"};
  if(state.events[key])return {status:"DUPLICATE",event:state.events[key]};
  // A reserved event deliberately does not retry automatically after a
  // crash: duplicate standing grants would be worse than manual repair.
  const row={key,kind,characterID:Number(characterID),ownerID:Number(ownerID),rawChange,
   systemID:positive(systemID),createdAt:clock(),status:"RESERVED"};
  state.events[key]=row;save();
  try{
   const result=apply(row);
   if(result?.success!==true){
    row.status="REJECTED";row.error=String(result?.errorMsg||"STANDING_CHANGE_FAILED");save();
    return {status:"REJECTED",error:row.error};
   }
   row.status="APPLIED";row.appliedAt=clock();
   state.totals[kind]=(state.totals[kind]||0)+1;save();
   return {status:"APPLIED",event:row};
  }catch(error){
   row.status="UNKNOWN";row.error=String(error.message).slice(0,256);save();
   return {status:"UNKNOWN",error:row.error};
  }
 }
 function onMiningAggression({characterID,ownerID,systemID,fleetID,occurredAt=clock()}){
  if(!positive(characterID)||!positive(ownerID)||!positive(systemID)||!positive(fleetID))
   return {status:"IGNORED_UNATTRIBUTED"};
  // At most one standing penalty per player/fleet/15-minute period.
  const window=Math.floor(finite(occurredAt)/900000);
  return applyOnce({
   key:"mining-assault:"+systemID+":"+fleetID+":"+characterID+":"+window,
   characterID,ownerID,systemID,rawChange:-0.25,kind:"assault",
   description:"Attacked an EveJS mining fleet"
  });
 }
 function onMinerDefense({characterID,ownerID,systemID,wreckID}){
  if(![characterID,ownerID,systemID,wreckID].every(positive))
   return {status:"IGNORED_UNATTRIBUTED"};
  return applyOnce({
   key:"miner-defense:"+wreckID,characterID,ownerID,systemID,
   rawChange:0.18,kind:"defense",
   description:"Stopped an NPC pirate attacking a real mining fleet"
  });
 }
 function onPirateKill({characterID,ownerID,systemID,wreckID}){
  if(![characterID,ownerID,systemID,wreckID].every(positive))
   return {status:"IGNORED_UNATTRIBUTED"};
  // Killing a pirate harms pirate standing. A separate miner-defense
  // reward requires evidence the target was attacking a mining fleet.
  return applyOnce({
   key:"pirate-kill:"+wreckID,characterID,ownerID,systemID,
   rawChange:-0.12,kind:"pirateKill",description:"Destroyed a named pirate NPC"
  });
 }
 return {onMiningAggression,onPirateKill,onMinerDefense,snapshot:()=>structuredClone(state)};
}
let singleton=null;
function getNative(){
 if(!singleton){
  const standing=require("../services/character/standingRuntime");
  singleton=createConsequences({
   file:process.env.EVEJS_COOP_STANDINGS_FILE||"/var/lib/evejs/coop-player-consequences.json",
   apply:row=>standing.applyStandingChanges(row.characterID,[{
    ownerID:row.ownerID,rawChange:row.rawChange,
    eventTypeID:standing.EVENT_STANDING_COMBAT_AGGRESSION,
    applySocial:false,msg:"Living Universe: "+row.description
   }],{disableDerived:true})
  });
 }
 return singleton;
}
function resolveAuthenticatedPlayerID(scene,aggressor){
 const shooterID=positive(aggressor?.itemID);
 const session=Array.from(scene?.sessions?.values?.()||[]).find(session=>
  positive(session?.characterID)&&
  (positive(session?._space?.shipID)===shooterID||
   (String(aggressor?.kind)==="drone"&&positive(aggressor?.ownerID)===positive(session.characterID))));
 return positive(session?.characterID);
}
// Financial or standings consequences need the same native account, active
// hull and global session authority as co-op admission. Never trust an NPC
// pilotCharacterID, caller-supplied killerCharacterID or stale drone owner.
function resolveVerifiedPlayerID(scene,attacker){
 const actorID=positive(attacker?.itemID),systemID=positive(scene?.systemID);
 if(!actorID||!systemID||attacker?.nativeNpc===true||
  !["ship","drone"].includes(attacker?.kind)||
  scene?.getEntityByID?.(actorID)!==attacker||
  typeof scene?.sessions?.values!=="function")return null;
 const presence=require("./coopSessionPresence");
 let authority;
 try{authority=presence.nativeAuthority();}catch{return null;}
 const matches=[];
 for(const session of scene.sessions.values()){
  const characterID=positive(session?.characterID),shipID=positive(session?._space?.shipID);
  if(!characterID||!shipID||positive(session?._space?.systemID)!==systemID||
   session?._space?.initialStateSent!==true||!session?.socket||
   session.socket.destroyed===true)continue;
  const physicalShip=scene.getEntityByID(shipID);
  if(physicalShip?.kind!=="ship"||
   (attacker.kind==="ship"?(shipID!==actorID||physicalShip!==attacker):
    (positive(attacker.ownerID)!==characterID||
     ![attacker.controllerID,attacker.launcherID,attacker.sourceShipID]
      .some(id=>positive(id)===shipID))))continue;
  if(presence.admission(session,physicalShip,()=>scene,authority).status===
   "ADMITTED_NATIVE_SESSION")matches.push(characterID);
 }
 return matches.length===1?matches[0]:null;
}
function informPlayer(scene,characterID,message){
 try{
  const session=Array.from(scene?.sessions?.values?.()||[])
    .find(s=>positive(s?.characterID)===positive(characterID));
  if(session)require("../services/chat/chatHub").sendSystemMessage(session,message);
 }catch(error){console.warn("[CoopConsequences] player notice",error.message);}
}
function noteMiningAggression(scene,fleet,aggressor,occurredAt){
 if(process.env.EVEJS_COOP_PLAYER_CONSEQUENCES!=="1")return {status:"DISABLED"};
 try{
  const resolved=require("../services/mining/miningNpcStandings");
  // NPCs may carry synthetic pilotCharacterIDs. Only a verifiable player
  // session (or their owned drone) may receive a real standing penalty.
  const characterID=resolveVerifiedPlayerID(scene,aggressor);
  if(!characterID)return {status:"IGNORED_NONPLAYER"};
  const victim=(fleet.minerEntityIDs||[]).concat(fleet.haulerEntityIDs||[])
   .map(id=>scene?.getEntityByID(id)).find(Boolean);
  if(!victim)return {status:"NO_FLEET_SHIP"};
  const ids=resolved.resolveEntityOwnerIDs(victim);
  const ownerID=positive(victim.factionID)||positive(victim.corporationID)||ids[0];
  const result=getNative().onMiningAggression({
   characterID,ownerID,systemID:fleet.systemID,
   fleetID:fleet.fleetID,occurredAt
  });
  if(result.status==="APPLIED"||(result.status==="DUPLICATE"&&result.event?.status==="APPLIED"))require("./coopNpcMemory").noteVerified({
   eventID:result.event.key,characterID,systemID:fleet.systemID,kind:"assault",
   entityIDs:[...(fleet.minerEntityIDs||[]),...(fleet.haulerEntityIDs||[])]
  });
  if(result.status==="APPLIED")informPlayer(scene,characterID,
   "[Living Universe] Mining fleet trust decreased after your attack. Future response strength depends on your EveJS standings.");
  if(result.status==="APPLIED")require("./coopRuntimeProbe").observe("living-player-consequence",null,
   {spaceState:{systemID:fleet.systemID}},
   {characterID,ownerID,kind:"assault",rawChange:-0.25});
  return result;
 }catch(error){console.warn("[CoopConsequences] Mining attack",error.message);return {status:"ERROR"};}
}
function noteNativeWreck(systemID,npcID,wreckID,ship,options={},controller=null){
 if(process.env.EVEJS_COOP_PLAYER_CONSEQUENCES!=="1")return {status:"DISABLED"};
 try{
  // ownerCharacterID in EveJS wreck options may denote the *victim*.
  // Never reward a kill without an authenticated, attributable attacker.
  // Both the native wreck and its explicit final attacker must exist in
  // this scene. A killerCharacterID hint is NOT proof of a kill.
  const liveScene=require("./runtime").ensureScene(Number(systemID),{refreshStargates:false});
  const nativeWreck=require("./npc/nativeNpcStore").getNativeWreck(wreckID);
  const physicalWreck=liveScene?.getEntityByID?.(Number(wreckID));
  if(ship?.kind!=="ship"||ship?.nativeNpc!==true||
   Number(ship.itemID)!==Number(npcID)||
   Number(nativeWreck?.systemID)!==Number(systemID)||
   Number(nativeWreck?.sourceEntityID)!==Number(npcID)||
   Number(nativeWreck?.launcherID)!==Number(npcID)||
   physicalWreck?.nativeNpcWreck!==true||
   Number(physicalWreck.itemID)!==Number(wreckID)||
   Number(physicalWreck.launcherID)!==Number(npcID))
   return {status:"IGNORED_UNVERIFIED_NATIVE_WRECK"};
  const characterID=resolveVerifiedPlayerID(liveScene,options.attackerEntity);
  if(!characterID)return {status:"IGNORED_UNATTRIBUTED"};
  if(positive(options.killerCharacterID)&&
   positive(options.killerCharacterID)!==characterID)
   return {status:"IGNORED_ATTACKER_IDENTITY_MISMATCH"};
  const regPath=process.env.EVEJS_COOP_IDENTITY_FILE||"/var/lib/evejs/coop-npc-links.json";
  let saved;
  try{saved=JSON.parse(fs.readFileSync(regPath,"utf8"));}catch(e){if(e.code==="ENOENT")return {status:"UNLINKED"};throw e;}
  const link=Object.values(saved?.links||{}).find(x=>
   Number(x.entityID)===Number(npcID)&&Number(x.systemID)===Number(systemID));
  if(link?.role!=="pirate")return {status:"NO_PIRATE_IDENTITY"};
  const ownerID=positive(ship?.factionID)||positive(ship?.corporationID)||positive(ship?.ownerID);
  const outcome=getNative().onPirateKill({characterID,ownerID,systemID,wreckID});
  if(outcome.status==="APPLIED"||(outcome.status==="DUPLICATE"&&outcome.event?.status==="APPLIED"))
   require("./coopNpcMemory").noteVerified({
    eventID:outcome.event.key,characterID,systemID,kind:"pirateKill",pilotIDs:[link.pilotID]
   });
  if(outcome.status==="APPLIED"){
   const scene=require("./runtime").ensureScene(Number(systemID),{refreshStargates:false});
   informPlayer(scene,characterID,"[Living Universe] Pirate destroyed. Your standing with its owner declined.");
  }
  if(outcome.status==="APPLIED")require("./coopRuntimeProbe").observe("living-player-consequence",null,
   {spaceState:{systemID}},
   {characterID,ownerID,kind:"pirateKill",rawChange:-0.12,pilotID:link.pilotID});
  // An NPC controller's last target is not proof of active defense.
  // Native combat evidence must be supplied via an explicit verified hook
  // before onMinerDefense is authorized; suppress the legacy inferred grant.
  return outcome;
 }catch(error){console.warn("[CoopConsequences] Native NPC wreck",error.message);return {status:"ERROR"};}
}
module.exports={createConsequences,resolveAuthenticatedPlayerID,resolveVerifiedPlayerID,noteMiningAggression,noteNativeWreck};
