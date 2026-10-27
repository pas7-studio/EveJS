"use strict";
// Authoritative source witness of native EveJS NPC missile launch or successful
// NPC weapon-module activation. An activation is NOT a hit or kill.
const fs=require("node:fs");
const positive=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const validPilot=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
const kinds=new Set(["missile-launch","module-activation"]);
function verify({scene,attacker,target,kind,moduleID=0,chargeTypeID=0,links=[],fleetShips=[],pilots=[]}={}){
 const systemID=positive(scene?.systemID),a=positive(attacker?.itemID),b=positive(target?.itemID);
 if(!systemID||!a||!b||a===b||!kinds.has(kind)||
  attacker.kind!=="ship"||target.kind!=="ship"||
  attacker.nativeNpc!==true||target.nativeNpc!==true||
  scene.getEntityByID?.(a)!==attacker||scene.getEntityByID?.(b)!==target)return {status:"NOT_NATIVE_NPC_WEAPON"};
 const players=new Set(Array.from(scene.sessions?.values?.()||[])
  .map(s=>positive(s?._space?.shipID)).filter(Boolean));
 if(players.has(a)||players.has(b))return {status:"PLAYER_SHIP"};
 const named=id=>links.find(link=>validPilot(link?.pilotID)&&
  Number(link?.systemID)===systemID&&Number(link?.entityID)===id);
 const aggressor=named(a),victim=named(b);
 if(!aggressor||(victim&&aggressor.pilotID===victim.pilotID))
  return {status:"UNLINKED_NPC"};
 const module=positive(moduleID),charge=positive(chargeTypeID);
 if(kind==="module-activation"&&!module)return {status:"MODULE_MISSING"};
 if(kind==="missile-launch"&&!charge)return {status:"MISSILE_TYPE_MISSING"};
 if(victim)return {status:"VERIFIED_NATIVE_WEAPON_EVENT",kind,systemID,
  attackerEntityID:a,attackerPilotID:aggressor.pilotID,
  victimEntityID:b,victimPilotID:victim.pilotID,
  ...(module?{moduleID:module}:{}),...(charge?{chargeTypeID:charge}:{})};
 // A stock mining hull has no named co-op identity, so keep its native
 // weapon witness separate from named-vs-named proof.
 const permitted=require("./coopNativeRaidEligibility").isAuthorizedStockMiningRaid({
  systemID,attacker,target,links,pilots,fleetShips
 });
 if(!permitted||links.some(link=>Number(link?.systemID)===systemID&&
  Number(link?.entityID)===b))return {status:"UNLINKED_NPC"};
 return {status:"VERIFIED_NATIVE_STOCK_FLEET_WEAPON_EVENT",kind,systemID,
  attackerEntityID:a,attackerPilotID:aggressor.pilotID,
  victimEntityID:b,victimRole:fleetShips.find(f=>Number(f.id)===b)?.role,
  ...(module?{moduleID:module}:{}),...(charge?{chargeTypeID:charge}:{})};
}
function noteVerified(scene,attacker,target,{kind,moduleID,chargeTypeID}={}){
 if(process.env.EVEJS_COOP_NATIVE_WEAPON_EVIDENCE!=="1")
  return {status:"DISABLED"};
 try{
  const p=process.env.EVEJS_COOP_IDENTITY_FILE||"/var/lib/evejs/coop-npc-links.json";
  const raw=JSON.parse(fs.readFileSync(p,"utf8"));
  const links=Object.values(raw?.links||{});
  const mining=process.env.EVEJS_COOP_NPC_RAIDS==="1"?
   require("../services/mining/miningNpcOperations"):null;
  const fleetShips=mining?require("./coopNativeRaidEligibility").liveFleetShips(
   mining.getMiningFleetsForSystem(scene.systemID),scene,scene.systemID):[];
  const evidence=verify({scene,attacker,target,kind,moduleID,chargeTypeID,links,fleetShips});
  if(evidence.status==="VERIFIED_NATIVE_WEAPON_EVENT"||
   evidence.status==="VERIFIED_NATIVE_STOCK_FLEET_WEAPON_EVENT")
   require("./coopRuntimeProbe").observe("living-native-weapon-event",null,
    {spaceState:{systemID:evidence.systemID}},evidence);
  return evidence;
 }catch(error){
  if(error?.code!=="ENOENT")console.warn("[CoopWeaponEvidence] native hook",error.message);
  return {status:"UNAVAILABLE"};
 }
}
module.exports={verify,noteVerified};
