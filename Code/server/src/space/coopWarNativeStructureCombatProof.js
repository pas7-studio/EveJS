"use strict";
// FW-009B native combat-path-exclusive receipt after original persisted
// structure killmail. ADMIN damage can set destroyedAt; it cannot grant
// this witness. Never creates killmail, damage, rewards or structure loot.
const {TABLE}=require("./coopFactionWarStore"+
 (__filename.endsWith(".js")?"":".cjs"));
const {KEY:OBJECTIVE_KEY,validate:validateObjectives}=
 require("./coopWarObjectiveAdjudicator"+(__filename.endsWith(".js")?"":".cjs"));
const {KEY:WAR_KEY}=require("./coopFactionWarStore"+
 (__filename.endsWith(".js")?"":".cjs"));
const {validateState:validateWar}=require("./coopFactionWarCore"+
 (__filename.endsWith(".js")?"":".cjs"));
const KEY="coop-faction-war\u001fstructure-killmail-v1",POS=x=>Number.isSafeInteger(x)&&x>0;
const DAMAGE=x=>typeof x==="number"&&Number.isFinite(x)&&x>0;
const empty=()=>({version:1,byStructure:{},byKillID:{}});
function validate(s){
 if(!s||s.version!==1||!s.byStructure||typeof s.byStructure!=="object"||
  Array.isArray(s.byStructure)||!s.byKillID||typeof s.byKillID!=="object"||
  Array.isArray(s.byKillID)||Object.keys(s.byStructure).length>128||
  Object.keys(s.byKillID).length>128)
  throw Error("WAR_NATIVE_STRUCTURE_COMBAT_LEDGER_INVALID");
 for(const [id,x] of Object.entries(s.byStructure)){
  if(!POS(Number(id))||String(Number(id))!==id||
   x?.structureID!==Number(id)||!POS(x.killID)||
   s.byKillID[String(x.killID)]!==x.structureID||
   !POS(x.systemID)||!POS(x.ownerCorporationID)||
   !POS(x.attackerCorporationID)||!POS(x.attackerFactionID)||
   !POS(x.typeID)||!POS(x.destroyedAt)||!POS(x.recordedAt)||
   !DAMAGE(x.damageTaken)||!DAMAGE(x.finalDamageDone)||
   x.proofID!=="structure-kill:"+x.killID)
   throw Error("WAR_NATIVE_STRUCTURE_COMBAT_RECEIPT_CORRUPT");
 }
 return s;
}
function createWarStructureCombatProof({gameStore,getNativeKillmail,
 getNativeStructure,getFactionForCorporation,
 clock=()=>Date.now(),env=process.env}={}){
 if(typeof gameStore?.coopAtomicNativeRows?.transact!=="function"||
  [getNativeKillmail,getNativeStructure,getFactionForCorporation,clock]
   .some(fn=>typeof fn!=="function"))
  throw Error("WAR_NATIVE_STRUCTURE_KILLMAIL_AUTHORITIES_REQUIRED");
 const enabled=()=>env.EVEJS_COOP_FACTION_WAR==="1"&&
  env.EVEJS_COOP_FACTION_WAR_FLEETS==="1"&&
  env.EVEJS_COOP_FACTION_WAR_NATIVE_OBJECTIVES==="1"&&
  env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1";
 const transact=fn=>gameStore.coopAtomicNativeRows.transact([TABLE],fn);
 function nativeMatch({killID,structureID,systemID,ownerCorporationID,
  attackerCorporationID,typeID,damageTaken,finalDamageDone}){
  try{
   const k=getNativeKillmail(killID);
   return k?.killID===killID&&k.solarSystemID===systemID&&
    k.victimCorporationID===ownerCorporationID&&
    k.victimShipTypeID===typeID&&
    k.finalCorporationID===attackerCorporationID&&
    Number.isFinite(k.victimDamageTaken)&&k.victimDamageTaken>=damageTaken&&
    Number.isFinite(k.finalDamageDone)&&k.finalDamageDone>=finalDamageDone&&
    k.victimDamageTaken>0&&k.finalDamageDone>0;
  }catch{return false}
 }
 function noteFromNativeKillmail({targetEntity,destroyResult,record,
  attackerEntity}={}){
  if(!enabled())return {status:"DISABLED"};
  const id=targetEntity?.itemID,killID=record?.killID,
   corp=targetEntity?.ownerCorpID||targetEntity?.corporationID,
   attackerCorp=record?.finalCorporationID;
  if(targetEntity?.kind!=="structure"||!POS(id)||!POS(killID)||
   !POS(targetEntity?.typeID)||!POS(targetEntity?.systemID)||
   !POS(corp)||!POS(attackerCorp)||
   destroyResult?.success!==true||
   !POS(attackerEntity?.itemID)||
   !Number.isFinite(record?.victimDamageTaken)||
   record.victimDamageTaken<=0||
   !Number.isFinite(record.finalDamageDone)||record.finalDamageDone<=0)
   return {status:"BLOCKED",reason:"NOT_NATIVE_STRUCTURAL_COMBAT_KILL"};
  return transact(tx=>{
   // Replay of an already committed original combat kill remains
   // idempotent even after a campaign becomes OCCUPIED or the native
   // structure has been salvaged. Never regenerate a new victim event.
   const previous=validate(tx.get(TABLE,KEY)||empty()).byStructure[String(id)];
   if(previous){
    const same=previous.killID===killID&&
     previous.systemID===targetEntity.systemID&&
     previous.ownerCorporationID===corp&&
     previous.typeID===targetEntity.typeID&&
     previous.attackerCorporationID===attackerCorp&&
     nativeMatch(previous);
    return same?{status:"DUPLICATE",receipt:{...previous}}:
     {status:"BLOCKED",reason:"STRUCTURE_KILLMAIL_REPLAY_CONFLICT"};
   }
   const war=tx.get(TABLE,WAR_KEY),
    objectiveState=tx.get(TABLE,OBJECTIVE_KEY);
   if(!war||!objectiveState)
    return {status:"BLOCKED",reason:"NO_BOUND_WAR_STRUCTURE"};
   validateWar(war);validateObjectives(objectiveState);
   const matches=Object.values(objectiveState.objectives).filter(o=>
    o.structureID===id&&o.systemID===targetEntity.systemID&&
    o.ownerCorporationID===corp&&o.typeID===targetEntity.typeID&&
    o.state==="BOUND");
   if(matches.length!==1)
    return {status:"BLOCKED",reason:"STRUCTURE_NOT_PREBOUND_TO_ASSAULT"};
   const o=matches[0],campaign=war.campaigns[o.campaignID],
    w=war.wars[o.warID];
   if(w?.state!=="ACTIVE"||campaign?.state!=="ASSAULT"||
    campaign.warID!==o.warID||
    campaign.targetSystemID!==o.systemID||
    w.defenderFactionID!==o.ownerFactionID)
    return {status:"BLOCKED",reason:"OBJECTIVE_CAMPAIGN_CHANGED"};
   let native,faction;
   try{
    native=getNativeStructure(id);
    faction=getFactionForCorporation(attackerCorp);
   }catch{return {status:"BLOCKED",reason:"STRUCTURE_OR_ATTACKER_SDE_UNAVAILABLE"}}
   if(native?.structureID!==id||native.solarSystemID!==o.systemID||
    native.ownerCorpID!==o.ownerCorporationID||
    native.typeID!==o.typeID||
    !POS(native.destroyedAt)||native.destroyedAt<o.boundAt||
    faction!==w.attackerFactionID||
    attackerEntity.corporationID!==attackerCorp||
    !nativeMatch({killID,structureID:id,
     systemID:o.systemID,ownerCorporationID:corp,
     attackerCorporationID:attackerCorp,typeID:o.typeID,
     damageTaken:record.victimDamageTaken,
     finalDamageDone:record.finalDamageDone}))
    return {status:"BLOCKED",reason:"STORED_NATIVE_COMBAT_KILLMAIL_UNVERIFIED"};
   const row=validate(tx.get(TABLE,KEY)||empty());
   if(row.byKillID[String(killID)]||Object.keys(row.byStructure).length>=128)
    return {status:"BLOCKED",reason:"STRUCTURE_KILLMAIL_ID_OR_CAP"};
   const recordedAt=clock();
   if(!POS(recordedAt)||recordedAt<o.boundAt)
    return {status:"BLOCKED",reason:"KILLMAIL_CLOCK_BEFORE_BIND"};
   const e={structureID:id,killID,proofID:"structure-kill:"+killID,
    systemID:o.systemID,ownerCorporationID:corp,
    attackerCorporationID:attackerCorp,
    attackerFactionID:faction,typeID:o.typeID,
    destroyedAt:native.destroyedAt,recordedAt,
    damageTaken:record.victimDamageTaken,
    finalDamageDone:record.finalDamageDone};
   row.byStructure[String(id)]=e;row.byKillID[String(killID)]=id;
   validate(row);tx.put(TABLE,KEY,row);
   return {status:"RECORDED",receipt:{...e},campaignID:o.campaignID};
  });
 }
 function verifyNativeCombatDestruction({structureID,systemID,
  campaignID,warID,combatProofID,ownerCorporationID,typeID,
  boundAt,proofTx}={}){
  if(!enabled()||!POS(structureID)||!POS(systemID)||
   !POS(ownerCorporationID)||!POS(typeID)||!POS(boundAt)||
   typeof proofTx?.get!=="function")return false;
  const row=validate(proofTx.get(TABLE,KEY)||empty()),
   rec=row.byStructure[String(structureID)];
  if(!rec||rec.proofID!==combatProofID||
   rec.systemID!==systemID||rec.ownerCorporationID!==ownerCorporationID||
   rec.typeID!==typeID||rec.destroyedAt<boundAt)return false;
  const obj=proofTx.get(TABLE,OBJECTIVE_KEY);
  if(obj?.objectives?.[campaignID]?.structureID!==structureID||
   obj.objectives[campaignID].warID!==warID)return false;
  return nativeMatch(rec);
 }
 function receiptForStructure(structureID){
  if(!enabled())return {status:"DISABLED"};
  if(!POS(structureID))return {status:"INVALID_STRUCTURE"};
  return transact(tx=>{
   const row=validate(tx.get(TABLE,KEY)||empty()),
    receipt=row.byStructure[String(structureID)];
   if(!receipt)return {status:"NO_NATIVE_COMBAT_RECEIPT"};
   if(!nativeMatch(receipt))
    return {status:"STORED_KILLMAIL_SOURCE_DRIFT"};
   return {status:"VERIFIED",receipt:{...receipt}};
  });
 }
 return Object.freeze({noteFromNativeKillmail,verifyNativeCombatDestruction,
  receiptForStructure});
}
// The pinned stock killmailTracker calls only this opt-in native server
// entrypoint AFTER its real `createKillmailRecord` commits. No admin
// command, game chat, player RPC or simulated damage can invoke it.
let runtimeSingleton=null;
function native(){
 if(!runtimeSingleton){
  runtimeSingleton=createWarStructureCombatProof({
   gameStore:require("../gameStore"),
   getNativeKillmail:id=>
    require("../services/killmail/killmailState").getKillmailRecord(id),
   getNativeStructure:id=>
    require("../services/structure/structureState").getStructureByID(id),
   getFactionForCorporation:id=>
    require("../services/faction/factionState").getFactionIDForCorporation(id)
  });
 }
 return runtimeSingleton;
}
function noteNativeStructureKill(payload){
 if(process.env.EVEJS_COOP_FACTION_WAR_NATIVE_OBJECTIVES!=="1")
  return {status:"DISABLED"};
 return native().noteFromNativeKillmail(payload);
}
module.exports={KEY,empty,validate,createWarStructureCombatProof,
 noteNativeStructureKill};

