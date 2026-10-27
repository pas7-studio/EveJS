"use strict";
// Narrow exception to vanilla EveJS "NPCs are friendly" rule.
// Only two genuinely named, linked native ships from different factions,
// with a *current native attack intent*, may engage. Never auto-aggro.
const fs=require("node:fs");
const positive=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
function validPair({attacker,target,attackerController,targetController,links=[],pilots=[]}={}){
 const attackerID=positive(attacker?.itemID),targetID=positive(target?.itemID);
 if(!attackerID||!targetID||attackerID===targetID||
  attacker?.kind!=="ship"||target?.kind!=="ship"||
  attacker.nativeNpc!==true||target.nativeNpc!==true||
  !attackerController||!targetController)return false;
 // Virtual faction tags never override the actual native corporation.
 const attackerCorp=positive(attacker.corporationID),targetCorp=positive(target.corporationID);
 if(attackerCorp&&targetCorp&&attackerCorp===targetCorp)return false;
 const sourceSystem=positive(attackerController.systemID),targetSystem=positive(targetController.systemID);
 if(!sourceSystem||sourceSystem!==targetSystem||
  Number(attackerController.entityID)!==attackerID||
  Number(targetController.entityID)!==targetID)return false;
 const explicitAttack=attackerController.manualOrder?.type==="attack"&&
  Number(attackerController.manualOrder.targetID)===targetID;
 const hitAt=Number(attackerController.lastAggressedAtMs);
 const elapsed=Date.now()-hitAt;
 // Do not preserve a stale revenge permission indefinitely.
 const nativeRetaliation=Number(attackerController.lastAggressorID)===targetID&&
  Number.isFinite(hitAt)&&hitAt>0&&elapsed>=0&&elapsed<=5*60000;
 if(!explicitAttack&&!nativeRetaliation)return false;
 const pair=links.filter(x=>named(x?.pilotID)&&Number(x.systemID)===sourceSystem&&
  (Number(x.entityID)===attackerID||Number(x.entityID)===targetID));
 if(pair.length!==2)return false;
 const source=pair.find(x=>Number(x.entityID)===attackerID);
 const victim=pair.find(x=>Number(x.entityID)===targetID);
 if(!source||!victim||source.pilotID===victim.pilotID)return false;
 const factions=new Map(pilots.filter(x=>named(x?.id)&&typeof x.faction==="string")
  .map(x=>[x.id,x.faction]));
 const fa=factions.get(source.pilotID),fb=factions.get(victim.pilotID);
 if(!fa||!fb||fa===fb)return false;
 return true;
}
let cache=null;
function allowsNativeEngagement(attacker,target){
 // A registered warship cannot inherit a virtual pirate faction's legacy
 // attack permission. Active native war always gets the first verdict.
 if(process.env.EVEJS_COOP_FACTION_WAR==="1"&&
    process.env.EVEJS_COOP_FACTION_WAR_FLEETS==="1"){
  try{
   const war=require("./coopWarCombatAuthority").nativeWarCombatVerdict(attacker,target);
   if(war.status!=="NOT_WAR")return war.status==="AUTHORIZED";
  }catch{return false;}
 }
 if(process.env.EVEJS_COOP_RIVAL_NPC_COMBAT!=="1")return false;
 try{
  const registry=require("./npc/npcRegistry");
  const a=positive(attacker?.itemID),b=positive(target?.itemID);
  if(!a||!b||a===b)return false;
  const attackerController=registry.getControllerByEntityID(a);
  const targetController=registry.getControllerByEntityID(b);
  if(!attackerController||!targetController)return false;
  const aggressionAge=Date.now()-Number(attackerController.lastAggressedAtMs);
  if(!(attackerController.manualOrder?.type==="attack"&&
   Number(attackerController.manualOrder.targetID)===b)&&
   !(Number(attackerController.lastAggressorID)===b&&
     Number.isFinite(aggressionAge)&&aggressionAge>=0&&aggressionAge<=5*60000))return false;
  const now=Date.now(),file=process.env.EVEJS_COOP_IDENTITY_FILE||
   "/var/lib/evejs/coop-npc-links.json",worldFile=process.env.EVEJS_COOP_VIRTUAL_STATE_FILE||
   "/var/lib/evejs/coop-virtual-world.json";
  if(!cache||cache.file!==file||cache.worldFile!==worldFile||now-cache.loadedAt>2500){
   // Never use stale faction or identity data after a failed reload.
   cache=null;
   const saved=JSON.parse(fs.readFileSync(file,"utf8"));
   const world=JSON.parse(fs.readFileSync(worldFile,"utf8"));
   if(saved?.version!==1||!saved.links||world?.version!==1||
    !Array.isArray(world.pilots))return false;
   cache={file,worldFile,loadedAt:now,
    links:Object.values(saved.links),pilots:world.pilots};
  }
  const namedAllowed=validPair({attacker,target,attackerController,targetController,
   links:cache.links,pilots:cache.pilots});
  if(namedAllowed)return true;
  // The standard native EveJS combat policy treats NPC->NPC as friendly.
  // The stock mining-fleet hull may not have a co-op named identity.
  // Permit ONLY a linked pirate with an actual native attack order against
  // an authoritative mining fleet member; never globally allow NPC duels.
  if(process.env.EVEJS_COOP_NPC_RAIDS!=="1"||
   positive(attackerController.systemID)!==positive(targetController.systemID)||
   Number(attackerController.entityID)!==a||
   Number(targetController.entityID)!==b)return false;
  if(attackerController.manualOrder?.type!=="attack"||
   Number(attackerController.manualOrder.targetID)!==b)return false;
  if(!cache.links.some(x=>Number(x.systemID)===Number(attackerController.systemID)&&
   Number(x.entityID)===a&&x.role==="pirate"))return false;
  const fleetRecords=require("../services/mining/miningNpcOperations")
   .getMiningFleetsForSystem(Number(attackerController.systemID))||[];
  const fleetShips=[];
  for(const fleet of fleetRecords){
   if(Number(fleet?.systemID)!==Number(attackerController.systemID))continue;
   for(const [role,key] of [["miner","minerEntityIDs"],["hauler","haulerEntityIDs"]]){
    if((fleet[key]||[]).some(id=>Number(id)===b))
     fleetShips.push({id:b,role});
   }
  }
  return require("./coopNativeRaidEligibility").isAuthorizedStockMiningRaid({
   systemID:attackerController.systemID,attacker,target,
   links:cache.links,pilots:cache.pilots,fleetShips
  });
 }catch(error){
  cache=null;
  if(error?.code!=="ENOENT")console.warn("[CoopNpcHostility] unavailable",error.message);
  return false;
 }
}
module.exports={validPair,allowsNativeEngagement};
