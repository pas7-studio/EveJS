"use strict";
// FW-003: trusted read-only native GameStore/SDE/scene identity proof for
// registering existing NPC warships. Never spawns or transfers a hull.
const pos=x=>Number.isSafeInteger(x)&&x>0;
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
const core=require("./coopFactionWarCore"+(__filename.endsWith(".js")?"":".cjs"));
const {KEY:WAR_STATE_KEY,TABLE}=require("./coopFactionWarStore"+(__filename.endsWith(".js")?"":".cjs"));
function createWarFleetNativeProofs({sceneForSystem,getController,getNativeEntity,
 assignments,getFactionForCorporation,confirmDestroyed=()=>false}={}){
 if([sceneForSystem,getController,getNativeEntity,assignments,
   getFactionForCorporation,confirmDestroyed].some(x=>typeof x!=="function"))
  throw Error("FW_NATIVE_FLEET_PROOFS_REQUIRED");
 function native(details){
  if(!pos(details?.entityID)||!pos(details?.systemID)||!named(details.pilotID)||
   !pos(details.corporationID)||!pos(details.factionID))return null;
  try{
   const scene=sceneForSystem(details.systemID),ship=scene?.getEntityByID?.(details.entityID),
    record=getNativeEntity(details.entityID),controller=getController(details.entityID);
   if(scene?.systemID!==details.systemID||ship?.kind!=="ship"||
    ship.nativeNpc!==true||ship.itemID!==details.entityID||
    ship.session?.characterID||record?.entityID!==details.entityID||
    record.systemID!==details.systemID||
    record.corporationID!==details.corporationID||
    ship.corporationID!==details.corporationID||
    controller?.entityID!==details.entityID||controller.systemID!==details.systemID||
    getFactionForCorporation(details.corporationID)!==details.factionID)return null;
   const all=assignments();
   if(!Array.isArray(all)||all.length>10000)return null;
   const matches=all.filter(x=>x?.pilotID===details.pilotID||
    x?.entityID===details.entityID);
   // Both the persisted identity registry and the virtual-world bridge
   // may report the very same native link. Exact duplicates are fine;
   // conflicting ship / pilot / system associations are never fine.
   const unique=new Set(matches.map(x=>x.pilotID+":"+x.entityID+":"+x.systemID));
   if(unique.size!==1||matches[0].pilotID!==details.pilotID||
    matches[0].entityID!==details.entityID||
    matches[0].systemID!==details.systemID)return null;
   return {ship,record,controller};
  }catch{return null}
 }
 function verifyNativeShip(details){
  const v=native(details);
  if(!v)return false;
  const c=v.controller,m=String(v.ship.mode||"").toUpperCase();
  return !c.manualOrder&&!c.currentTargetID&&
   !v.ship.pendingWarp&&!v.ship.warpState&&!v.ship.isWarping&&m!=="WARP";
 }
 function verifyCampaign(d,tx){
  if(typeof tx?.get!=="function")return false;
  try{
   const s=tx.get(TABLE,WAR_STATE_KEY);
   if(!s)return false;
   core.validateState(s);
   const campaign=s.campaigns[d.campaignID],war=s.wars[d.warID];
   if(war?.state!=="ACTIVE"||campaign?.warID!==d.warID||
      !["PREPARING","ASSAULT"].includes(campaign.state))return false;
   // Defenders are genuine native ships in the besieged target system.
   // They must join the same battle, not masquerade as attackers.
   if(d.factionID===war.defenderFactionID)
    return d.systemID===campaign.targetSystemID;
   if(d.factionID!==war.attackerFactionID)return false;
   // Attackers initially form in their controlled source. No implicit
   // teleportation into the target system from a virtual campaign.
   const expected=campaign.state==="PREPARING"?
    campaign.sourceSystemID:campaign.targetSystemID;
   return d.systemID===expected;
  }catch{return false}
 }
 function verifyRelease(d){
  const v=native(d);
  if(!v){
   // Absence is not a destruction witness: missing scenes on headless
   // startup do not release persisted warship custody.
   try{return confirmDestroyed(d)===true}catch{return false}
  }
  const c=v.controller,m=String(v.ship.mode||"").toUpperCase();
  return !c.manualOrder&&!c.currentTargetID&&!v.ship.pendingWarp&&
   !v.ship.warpState&&!v.ship.isWarping&&m!=="WARP";
 }
 return Object.freeze({verifyNativeShip,verifyCampaign,verifyRelease});
}
module.exports={createWarFleetNativeProofs};
