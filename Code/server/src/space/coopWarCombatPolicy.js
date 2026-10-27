"use strict";
// FW-003B: battle policy is proof-only. Attack orders are not hits or kills.
// Only opposing registered native NPC ships in the same active assault qualify.
const pos=x=>Number.isSafeInteger(x)&&x>0;
const own=(x,k)=>Object.prototype.hasOwnProperty.call(x,k);
function evaluate({warState,fleetState,attacker,target,attackerController,
 targetController,getFactionForCorporation,requireAttackIntent=true}={}){
 const deny=reason=>({status:"BLOCKED",reason});
 if(warState?.version!==1||fleetState?.version!==1||
  !warState.wars||!warState.campaigns||!fleetState.ships||
  typeof getFactionForCorporation!=="function")return deny("WAR_STATE_UNAVAILABLE");
 const a=attacker?.itemID,b=target?.itemID;
 if(!pos(a)||!pos(b)||a===b)return deny("INVALID_SHIP_PAIR");
 const aa=own(fleetState.ships,String(a))?fleetState.ships[String(a)]:null;
 const bb=own(fleetState.ships,String(b))?fleetState.ships[String(b)]:null;
 if(!aa&&!bb)return {status:"NOT_WAR"};
 if(!aa||!bb)return deny("WAR_REGISTERED_TARGET_REQUIRED");
 const system=aa.systemID;
 if(!pos(system)||bb.systemID!==system||aa.entityID!==a||bb.entityID!==b||
  aa.campaignID!==bb.campaignID||aa.warID!==bb.warID||
  aa.factionID===bb.factionID||aa.pilotID===bb.pilotID)
  return deny("WAR_FLEET_IDENTITY_CONFLICT");
 const war=own(warState.wars,aa.warID)?warState.wars[aa.warID]:null,
  c=own(warState.campaigns,aa.campaignID)?warState.campaigns[aa.campaignID]:null;
 if(war?.state!=="ACTIVE"||c?.state!=="ASSAULT"||c.warID!==aa.warID||
  c.targetSystemID!==system||!pos(war.attackerFactionID)||
  !pos(war.defenderFactionID)||war.attackerFactionID===war.defenderFactionID||
  ![war.attackerFactionID,war.defenderFactionID].includes(aa.factionID)||
  ![war.attackerFactionID,war.defenderFactionID].includes(bb.factionID))
  return deny("NO_ACTIVE_NATIVE_ASSAULT");
 for(const [ship,row,ctrl] of [[attacker,aa,attackerController],[target,bb,targetController]]){
  if(ship?.kind!=="ship"||ship.nativeNpc!==true||ship.session?.characterID||
   ship.itemID!==row.entityID||ship.corporationID!==row.corporationID||
   ctrl?.entityID!==row.entityID||ctrl.systemID!==system||
   !pos(row.corporationID)||!pos(row.factionID))
   return deny("NATIVE_SHIP_PROOF_MISMATCH");
  let faction;
  try{faction=getFactionForCorporation(row.corporationID)}catch{return deny("SDE_FACTION_UNAVAILABLE")}
  if(faction!==row.factionID)return deny("SDE_FACTION_MISMATCH");
 }
 if(attacker.corporationID===target.corporationID)
  return deny("FRIENDLY_CORPORATION");
 if(requireAttackIntent){
  const order=attackerController.manualOrder;
  if(order?.type!=="attack"||order.targetID!==b||order.allowWeapons===false)
   return deny("EXPLICIT_ATTACK_ORDER_REQUIRED");
 }
 return {status:"AUTHORIZED",attackerID:a,targetID:b,systemID:system,
  warID:aa.warID,campaignID:aa.campaignID,
  attackingFactionID:aa.factionID,defendingFactionID:bb.factionID};
}
module.exports={evaluate};
