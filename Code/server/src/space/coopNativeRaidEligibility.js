"use strict";
// A narrow, auditable permission for a named pirate to attack a GENUINE
// EveJS mining-fleet ship. Never treat arbitrary NPCs, structures or player
// ships as raid targets. Existing two-named-NPC faction rules still apply.
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const named=id=>typeof id==="string"&&/^coop-pilot-[0-9]{3,}$/.test(id);
function isAuthorizedStockMiningRaid({
 systemID,attacker,target,links=[],pilots=[],fleetShips=[]
}={}){
 const system=positive(systemID),sourceID=positive(attacker?.itemID),targetID=positive(target?.itemID);
 if(!system||!sourceID||!targetID||sourceID===targetID||
  attacker?.kind!=="ship"||attacker.nativeNpc!==true||
  target?.kind!=="ship"||target.nativeNpc!==true||
  !Array.isArray(links)||!Array.isArray(pilots)||!Array.isArray(fleetShips))return false;
 // Fleet membership comes ONLY from the current upstream EveJS mining
 // service. A persisted co-op 'miner' label does not grant permission.
 if(!fleetShips.some(x=>Number(x?.id)===targetID&&
  (x?.role==="miner"||x?.role==="hauler")))return false;
 const sourceLinks=links.filter(x=>Number(x?.systemID)===system&&
  Number(x?.entityID)===sourceID&&named(x?.pilotID));
 if(sourceLinks.length!==1||sourceLinks[0].role!=="pirate")return false;
 const targetLinks=links.filter(x=>Number(x?.systemID)===system&&
  Number(x?.entityID)===targetID&&named(x?.pilotID));
 if(targetLinks.length>1)return false;
 // Unnamed stock miners remain valid pirate targets. For a named miner,
 // preserve established faction safety and never attack a friendly ship.
 if(!targetLinks.length)return true;
 const victim=targetLinks[0];
 if(!["miner","hauler"].includes(victim.role)||
  sourceLinks[0].pilotID===victim.pilotID)return false;
 const factions=new Map(pilots.filter(x=>named(x?.id)&&typeof x.faction==="string")
  .map(x=>[x.id,x.faction]));
 const from=factions.get(sourceLinks[0].pilotID),to=factions.get(victim.pilotID);
 return Boolean(from&&to&&from!==to);
}
function liveFleetShips(fleets,scene,systemID=scene?.systemID){
 const seen=new Set(),ships=[],system=positive(systemID);
 if(!system||typeof scene?.getEntityByID!=="function"||!Array.isArray(fleets))return ships;
 for(const fleet of fleets){
  if(positive(fleet?.systemID)!==system)continue;
  for(const [role,key] of [["miner","minerEntityIDs"],["hauler","haulerEntityIDs"]]){
   for(const raw of fleet?.[key]||[]){
    const id=positive(raw),entity=id&&scene.getEntityByID(id);
    if(!id||seen.has(id)||entity?.kind!=="ship"||entity.nativeNpc!==true)continue;
    seen.add(id);ships.push({id,role});
   }
  }
 }
 return ships;
}
module.exports={isAuthorizedStockMiningRaid,liveFleetShips};
