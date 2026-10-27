"use strict";
// FW-003B: shared live GameStore view for native combat and damage hostility.
// Synchronous read-only cache reads (never SQLite transactions in the hot
// projectile path), invalidated by existing GameStore atomic commit bridge.
const moduleName=x=>require("./"+x+(__filename.endsWith(".js")?"":".cjs"));
const war=moduleName("coopFactionWarStore"),fleet=moduleName("coopWarFleetRegistry");
const warCore=moduleName("coopFactionWarCore"),fleetCore=moduleName("coopWarFleetRegistry");
const {evaluate}=moduleName("coopWarCombatPolicy");
const {readRow}=moduleName("coopNativeRowPath");
const pos=x=>Number.isSafeInteger(x)&&x>0;
function combatEnabled(env=process.env){
 return env.EVEJS_COOP_FACTION_WAR==="1"&&
  env.EVEJS_COOP_FACTION_WAR_FLEETS==="1"&&
  env.EVEJS_COOP_FACTION_WAR_COMBAT==="1"&&
  env.EVEJS_COOP_NPC_ORDER_ARBITER==="1"||
  env.EVEJS_COOP_FACTION_WAR==="1"&&
  env.EVEJS_COOP_FACTION_WAR_FLEETS==="1"&&
  env.EVEJS_COOP_FACTION_WAR_COMBAT==="1"&&
  env.EVEJS_COOP_ALIFE==="1";
}
function ammoEnabled(env=process.env){
 return env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
  env.EVEJS_COOP_NPC_STRICT_AMMO==="1"&&
  env.EVEJS_COOP_NPC_AMMO_DURABLE_CYCLE==="1"&&
  env.EVEJS_COOP_NPC_BANK_ATOMIC==="1"&&
  env.EVEJS_COOP_NPC_BANK_OUTCOME_WITNESS==="1";
}
function createWarCombatAuthority({gameStore,getController,getNativeEntity,
 getFactionForCorporation,entityCache=null,env=process.env}={}){
 if(typeof gameStore?.read!=="function"||
  [getController,getNativeEntity,getFactionForCorporation].some(x=>typeof x!=="function"))
  throw Error("WAR_COMBAT_NATIVE_AUTHORITIES_REQUIRED");
 function snapshots(){
  try{
   const a=readRow(gameStore,war.TABLE,war.KEY),
    b=readRow(gameStore,fleet.TABLE,fleet.KEY);
   if(!a||!b)return null;
   warCore.validateState(a);fleetCore.validate(b);
   return {warState:a,fleetState:b};
  }catch{return null}
 }
 function evaluatePair(attacker,target,{requireAttackIntent=true,proof=null}={}){
  const state=proof||snapshots();
  if(!state)return {status:"BLOCKED",reason:"WAR_SNAPSHOT_UNAVAILABLE"};
  const a=attacker?.itemID,b=target?.itemID;
  if(!pos(a)||!pos(b)||a===b)return {status:"BLOCKED",reason:"INVALID_WAR_PAIR"};
  try{
   // One bulk read per cache window instead of two full collection clones per
   // pair: identity facts (corporationID, systemID) are stable inside a tick.
   const lookup=typeof entityCache==="function"?entityCache:getNativeEntity;
   const ar=lookup(a),br=lookup(b);
   if(!ar||!br||ar.entityID!==a||br.entityID!==b||
    !pos(ar.corporationID)||!pos(br.corporationID)||
    ar.corporationID!==attacker.corporationID||
    br.corporationID!==target.corporationID||
    ar.systemID!==br.systemID)return {status:"BLOCKED",reason:"NATIVE_STORE_IDENTITY_MISMATCH"};
   const ac=getController(a),bc=getController(b);
   return evaluate({...state,attacker,target,
    attackerController:ac,targetController:bc,
    getFactionForCorporation,requireAttackIntent});
  }catch{return {status:"BLOCKED",reason:"NATIVE_WAR_PROOF_UNAVAILABLE"}}
 }
 function allowsNativeEngagement(attacker,target){
  if(!combatEnabled(env)||!ammoEnabled(env))return false;
  return evaluatePair(attacker,target).status==="AUTHORIZED";
 }
 return Object.freeze({snapshots,evaluatePair,allowsNativeEngagement});
}
let singleton=null;
function native(){
 if(!singleton)singleton=createWarCombatAuthority({
  gameStore:require("../gameStore"),
  getController:id=>require("./npc/npcRegistry").getControllerByEntityID(id),
  getNativeEntity:id=>require("./npc/nativeNpcStore").getNativeEntity(id),
  entityCache:id=>require("./coopNativeReadCache").nativeCache().entityByID(id),
  getFactionForCorporation:id=>
   require("../services/faction/factionState").getFactionIDForCorporation(id)
 });
 return singleton;
}
function nativeWarCombatVerdict(attacker,target){
 if(process.env.EVEJS_COOP_FACTION_WAR!=="1"||
  process.env.EVEJS_COOP_FACTION_WAR_FLEETS!=="1")return {status:"NOT_WAR"};
 try{
  const a=native();
  const s=a.snapshots();
  if(!s)return {status:"BLOCKED",reason:"WAR_SNAPSHOT_UNAVAILABLE"};
  const first=s.fleetState.ships[String(attacker?.itemID)],
   second=s.fleetState.ships[String(target?.itemID)];
  if(!first&&!second)return {status:"NOT_WAR"};
  if(!combatEnabled()||!ammoEnabled())return {status:"BLOCKED",reason:"WAR_COMBAT_FLAGS_INCOMPLETE"};
  return a.evaluatePair(attacker,target,{proof:s});
 }catch{return {status:"BLOCKED",reason:"WAR_NATIVE_AUTHORITY_UNAVAILABLE"}}
}
module.exports={combatEnabled,ammoEnabled,createWarCombatAuthority,nativeWarCombatVerdict};
