"use strict";
// Narrow stock NPC mining ship kill proof for post-raid salvage navigation.
// Must be called from the authoritative native destruction callback, never
// from raid intent, target lock or a world-tick inference.
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
function verifyStockKill({scene,victim,wreck,options={},links=[],fleets=[]}={}){
 const systemID=id(scene?.systemID),victimID=id(victim?.itemID),
  wreckID=id(wreck?.wreckID),attacker=options?.attackerEntity,
  attackerID=id(attacker?.itemID);
 if(!systemID||!victimID||!wreckID||Number(wreck.systemID)!==systemID||
  Number(wreck.sourceEntityID)!==victimID||
  Number(wreck.launcherID)!==victimID||
  victim.kind!=="ship"||victim.nativeNpc!==true||
  !Array.isArray(links)||!Array.isArray(fleets))
  return {status:"INVALID_STOCK_KILL_CONTEXT"};
 const physical=scene.getEntityByID?.(wreckID);
 if(physical?.nativeNpcWreck!==true||Number(physical.itemID)!==wreckID||
  Number(physical.launcherID)!==victimID)
  return {status:"NATIVE_WRECK_NOT_PHYSICAL"};
 if(!attackerID)return {status:"UPSTREAM_ATTACKER_NOT_PROVIDED"};
 if(attacker?.nativeNpc!==true||attacker?.kind!=="ship"||
  attackerID===victimID||scene.getEntityByID?.(attackerID)!==attacker)
  return {status:"ATTACKER_NOT_NATIVE"};
 if([...scene.sessions?.values?.()||[]].some(s=>
  Number(s?._space?.shipID)===attackerID||
  Number(s?._space?.shipID)===victimID))
  return {status:"PLAYER_SHIP_EXCLUDED"};
 if(links.some(l=>Number(l.entityID)===victimID&&
  Number(l.systemID)===systemID))
  return {status:"NAMED_VICTIM_USE_STANDARD_PROOF"};
 const attackerLinks=links.filter(l=>named(l?.pilotID)&&
  Number(l.systemID)===systemID&&Number(l.entityID)===attackerID&&
  l.role==="pirate");
 if(attackerLinks.length!==1)return {status:"NOT_UNIQUE_NAMED_PIRATE"};
 const stock=[];
 for(const fleet of fleets){
  if(Number(fleet?.systemID)!==systemID)continue;
  if((fleet.minerEntityIDs||[]).some(x=>Number(x)===victimID))
   stock.push({id:victimID,role:"miner"});
  if((fleet.haulerEntityIDs||[]).some(x=>Number(x)===victimID))
   stock.push({id:victimID,role:"hauler"});
 }
 if(stock.length!==1)return {status:"STOCK_FLEET_MEMBERSHIP_MISSING"};
 const ext=__filename.endsWith(".cjs")?".cjs":"";
 const {isAuthorizedStockMiningRaid}=require("./coopNativeRaidEligibility"+ext);
 if(!isAuthorizedStockMiningRaid({systemID,attacker,target:victim,
  links,pilots:[],fleetShips:stock}))
  return {status:"NATIVE_STOCK_RAID_NOT_AUTHORIZED"};
 return {status:"NATIVE_DESTRUCTION_ATTACKER_PROVIDED",
  victimEntityID:victimID,wreckID,systemID,
  attackerEntityID:attackerID,attackerPilotID:attackerLinks[0].pilotID,
  victimClass:"UNNAMED_NATIVE_STOCK_MINING_FLEET",
  attribution:"UPSTREAM_DESTRUCTION_OPTIONS_ATTACKER_ENTITY_PLUS_NATIVE_FLEET_MEMBERSHIP"};
}
module.exports={verifyStockKill};
