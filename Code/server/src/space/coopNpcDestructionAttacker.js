"use strict";
// Only the *native EveJS destruction caller* may supply a final attacker.
// If it does not, no controller target, faction or weapon event may invent one.
const fs=require("node:fs");
const positive=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
// Pure: union two link lists without duplicating a pilot/entity pair.
// FW-074: one hull has one identity, and one pilot flies one hull.
//
// Measured 11:24:26Z on a real war kill: the casualty was recorded, capture-by-force
// followed, and attribution still answered NOT_UNIQUE_NAMED_PIRATE - because the disk
// copy of the link and the live registry both contained the SAME entity under DIFFERENT
// recorded systems (the virtual pilot had walked on), so the stock path counted two
// attacker links and refused "not unique". The merge now collapses per ENTITY (the hull
// is what dies) and per PILOT (a pilot cannot be in two places), keeping the newest
// record, so a stale duplicate can never make a real attacker ambiguous again.
function mergeLinks(...lists){
 const byEntity=new Map(),byPilot=new Map();
 const newer=(candidate,current)=>{
  const a=Number(candidate&&candidate.linkedAt)||0,b=Number(current&&current.linkedAt)||0;
  if(a!==b)return a>b?candidate:current;
  // Same age: prefer the record that still carries a usable position.
  return (Number(candidate&&candidate.systemID)||0)>=(Number(current&&current.systemID)||0)?
   candidate:current;
 };
 for(const list of lists){
  for(const link of Array.isArray(list)?list:[]){
   if(!link||typeof link!=="object")continue;
   const entityID=Number(link.entityID||0),pilotID=String(link.pilotID||"");
   if(entityID>0){
    const current=byEntity.get(entityID);
    byEntity.set(entityID,current?newer(link,current):link);
    continue;
   }
   if(!pilotID)continue;
   const current=byPilot.get(pilotID);
   byPilot.set(pilotID,current?newer(link,current):link);
  }
 }
 // A pilot that somehow holds two hulls is still one pilot: keep the newest binding.
 const byPilotFinal=new Map();
 for(const link of [...byEntity.values(),...byPilot.values()]){
  const pilotID=String(link&&link.pilotID||"");
  if(!pilotID)continue;
  const current=byPilotFinal.get(pilotID);
  byPilotFinal.set(pilotID,current?newer(link,current):link);
 }
 return [...byPilotFinal.values()];
}
// The live registry is authoritative; a missing runtime is simply an empty list.
function liveLinks(){
 try{
  const runtime=require("./coopVirtualWorldRuntime");
  return typeof runtime.identityLinks==="function"?runtime.identityLinks():[];
 }catch(_error){return []}
}
function verify({scene,victim,wreck,options={},links=[]}={}){
 const systemID=positive(scene?.systemID);
 const victimID=positive(victim?.itemID),wreckID=positive(wreck?.wreckID);
 if(!systemID||!victimID||!wreckID||victim?.nativeNpc!==true||
  victim?.kind!=="ship"||Number(wreck.systemID)!==systemID||
  Number(wreck.sourceEntityID)!==victimID||
  Number(wreck.launcherID)!==victimID||!Array.isArray(links))
  return {status:"INVALID_NATIVE_DESTRUCTION"};
 const physicalWreck=scene.getEntityByID?.(wreckID);
 if(physicalWreck?.nativeNpcWreck!==true||
  Number(physicalWreck.itemID)!==wreckID||
  Number(physicalWreck.launcherID)!==victimID)
  return {status:"PHYSICAL_WRECK_MISSING"};
 // FW-048: a war hull's IDENTITY LINK follows its virtual pilot, and the virtual
 // world keeps moving that pilot between systems (x5 time acceleration), while the
 // native hull stays where it was spawned. Measured at 19:59:42Z: a real killed
 // war ship (entity 980000005122, coop-pilot-014) had a link whose systemID had
 // already moved to 30045343, so the strict systemID match answered
 // VICTIM_NOT_NAMED, the stock path then refused NOT_UNIQUE_NAMED_PIRATE, and a
 // real kill earned nothing. Locality is already proven physically: the wreck is
 // in this scene and belongs to THIS entity. A link is therefore accepted by
 // entity identity even when its recorded position is stale; a link whose system
 // still matches wins, and every non-matching system is reported as evidence.
 const linkFor=(entityID)=>{
  const byEntity=links.filter(x=>named(x?.pilotID)&&Number(x.entityID)===Number(entityID));
  return byEntity.find(x=>Number(x.systemID)===systemID)||
   (byEntity.length===1?byEntity[0]:null);
 };
 const v=linkFor(victimID);
 if(!v)return {status:"VICTIM_NOT_NAMED"};
 const stalePosition=Number(v.systemID)!==systemID;
 const base={systemID,victimEntityID:victimID,victimPilotID:v.pilotID,wreckID};
 // This callback executes after native wreck creation. Source attribution
 // remains unproven until the upstream caller explicitly passes the
 // authoritative attackerEntity object used for the death event.
 const attacker=options?.attackerEntity;
 const attackerID=positive(attacker?.itemID);
 if(!attackerID)return {status:"UPSTREAM_ATTACKER_NOT_PROVIDED",...base};
 if(!attacker||attacker.kind!=="ship"||attacker.nativeNpc!==true||
  attackerID===victimID||scene.getEntityByID?.(attackerID)!==attacker)
  return {status:"UPSTREAM_ATTACKER_NOT_NATIVE",...base};
 const playerShips=new Set(Array.from(scene.sessions?.values?.()||[])
  .map(s=>positive(s?._space?.shipID)).filter(Boolean));
 if(playerShips.has(attackerID)||playerShips.has(victimID))
  return {status:"PLAYER_SHIP_EXCLUDED",...base};
 const a=linkFor(attackerID);
 if(!a||a.pilotID===v.pilotID)return {status:"ATTACKER_NOT_NAMED",...base};
 return {status:"NATIVE_DESTRUCTION_ATTACKER_PROVIDED",...base,
  attackerEntityID:attackerID,attackerPilotID:a.pilotID,
  staleLinkPosition:stalePosition||Number(a.systemID)!==systemID,
  attribution:"UPSTREAM_DESTRUCTION_OPTIONS_ATTACKER_ENTITY"};
}
function note(scene,victim,options,wreck){
 if(process.env.EVEJS_COOP_NATIVE_WEAPON_EVIDENCE!=="1")return {status:"DISABLED"};
 try{
  const file=process.env.EVEJS_COOP_IDENTITY_FILE||"/var/lib/evejs/coop-npc-links.json";
  const saved=JSON.parse(fs.readFileSync(file,"utf8"));
  // FW-040: the on-disk file lags the live identity registry, and a war hull whose
  // link is only in memory looked UNNAMED - measured: a real war kill answered
  // NOT_UNIQUE_NAMED_PIRATE because the victim link was not on disk yet, so no
  // attribution, no merit and the HELD bounty could never pay. The live registry is
  // the authority the war system itself uses, so both are merged.
  const links=mergeLinks(Object.values(saved?.links||[]),liveLinks());
  const ext=__filename.endsWith(".cjs")?".cjs":"";
  // FW-024: a PLAYER hull as the upstream attacker is a real war participant
  // only through an ACTIVE militia enlistment against a registered war ship.
  // This branch is the only place a player can earn war merit; it never runs
  // for an NPC attacker and never invents an attribution.
  const playerCharacterID=positive(options?.attackerEntity?.session?.characterID);
  if(playerCharacterID){
   let playerProof;
   try{
    playerProof=require("./coopMilitiaWarPlayer"+ext).native()
     .playerKillProof({scene,victim,options,wreck});
   }catch(error){
    playerProof={status:"UNAVAILABLE",reason:String(error?.message||"PLAYER_KILL_PROOF_FAILED")};
   }
   try{
    require("./coopRuntimeProbe").observe("living-player-war-kill",playerCharacterID,
     {spaceState:{systemID:positive(scene?.systemID)||0}},playerProof);
   }catch{}
   if(playerProof.status!=="PLAYER_NATIVE_WAR_KILL_PROVIDED")return playerProof;
   const pilotID="coop-player-"+playerCharacterID;
   try{
    const ledger=require("./coopWarMeritLedger"+ext)
     .createWarMeritLedger({gameStore:require("../gameStore")});
    const award=ledger.award({pilotID,kind:"warship-kill",
     evidenceKey:"wreck:"+playerProof.wreckID,
     evidence:{wreckID:playerProof.wreckID,victimEntityID:playerProof.victimEntityID,
      attackerEntityID:playerProof.attackerEntityID,characterID:playerCharacterID,
      campaignID:playerProof.campaignID}});
    require("./coopRuntimeProbe").observe("living-player-war-merit",playerCharacterID,
     {spaceState:{systemID:playerProof.systemID}},{status:award.status,pilotID,
      kind:"warship-kill",merit:Number(award.merit)||0,
      meritDelta:Number(award.meritDelta)||0,from:String(award.from||""),
      to:String(award.to||""),rank:String(award.rank||""),
      command:Number(award.command)||0,wreckID:playerProof.wreckID,
      campaignID:playerProof.campaignID,
      evidence:"UPSTREAM_ATTACKER_ENTITY_PLUS_ACTIVE_ENLISTMENT_PLUS_PHYSICAL_WRECK"});
   }catch(error){
    console.warn("[CoopWarMerit]",String(error?.message||"PLAYER_MERIT_UNAVAILABLE"));
   }
   return playerProof;
  }
  let proof=verify({scene,victim,options,wreck,links});
  if(proof.status==="VICTIM_NOT_NAMED"&&
   process.env.EVEJS_COOP_NPC_WRECK_RECOVERY==="1"){
   const fleets=require("../services/mining/miningNpcOperations")
    .getMiningFleetsForSystem(Number(scene?.systemID));
   const ext=__filename.endsWith(".cjs")?".cjs":"";
   proof=require("./coopNpcStockWreckProof"+ext).verifyStockKill({
    scene,victim,options,wreck,links,fleets
   });
  }
  if(proof.status!=="VICTIM_NOT_NAMED"&&proof.status!=="INVALID_NATIVE_DESTRUCTION")
   require("./coopRuntimeProbe").observe("living-native-destruction-attacker",null,
    {spaceState:{systemID:proof.systemID}},proof);
  // FW-009B: only this strict proof may pay war merit, and only for the exact
  // physical wreck it names. A missing or non-native attacker pays nothing.
  if(proof.status==="NATIVE_DESTRUCTION_ATTACKER_PROVIDED"){
   try{
    const ext=__filename.endsWith(".cjs")?".cjs":"";
    require("./coopWarKillMerit"+ext).note({proof,victim,
     emit:(event,characterID,spaceState,detail)=>
      require("./coopRuntimeProbe").observe(event,characterID,spaceState,detail)});
   }catch(error){
    console.warn("[CoopWarKillMerit]",String(error?.message||"UNAVAILABLE"));
   }
  }
  if(process.env.EVEJS_COOP_NPC_WRECK_RECOVERY==="1"&&
   proof.status==="NATIVE_DESTRUCTION_ATTACKER_PROVIDED"){
   try{
    const ext=__filename.endsWith(".cjs")?".cjs":"";
    const received=require("./coopNpcWreckClaims"+ext).getWreckClaims().record({proof,wreck});
    if(received.status!=="KILL_PROOF_RECORDED"&&
       received.status!=="ALREADY_RECORDED")
     console.warn("[CoopNpcWreck] unclaimed native destruction",received.status);
   }catch(error){
    // Authoritative wreck creation already happened; never turn telemetry
    // failure into a retry of native destruction or a fabricated new wreck.
    console.warn("[CoopNpcWreck] durable claim recording failed",String(error?.message||"UNAVAILABLE"));
   }
  }
  return proof;
 }catch(error){
  if(error.code!=="ENOENT")console.warn("[CoopNpcDestructionAttacker] evidence",error.message);
  return {status:"UNAVAILABLE"};
 }
}
module.exports={verify,note,mergeLinks};
