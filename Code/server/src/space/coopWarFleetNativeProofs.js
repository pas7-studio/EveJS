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
 // FW-110: custody follows the pilot's PROVEN physical ship.
 //
 // MEASURED on the play stack 2026-10-30: a restart re-materialized the front fleet with new
 // entity ids while the registry kept the old ones, so 6 pilots were permanently PILOT_IN_USE
 // and 4 rows pointed at pilots with no link at all. `verifyRelease` cannot decide that case:
 // the old hull is neither present in a scene nor destroyed with a wreck, and absence is
 // deliberately not a destruction witness. This is NOT a destruction claim - it is the much
 // stronger statement that the same pilot provably flies exactly ONE other real ship right
 // now, so custody of the old hull cannot be theirs. Anything ambiguous stays refused.
 function verifyReplacement(details){
  if(!pos(details?.entityID)||!named(details?.pilotID)||!pos(details?.currentEntityID))
   return false;
  if(Number(details.currentEntityID)===Number(details.entityID))return false;
  let rows=[];
  try{rows=assignments()||[]}catch{return false}
  // One pilot may appear in several authorities at once (an order lease AND the identity
  // link both name the same hull), so uniqueness is counted in HULLS, not in rows. Two
  // different hulls for one pilot is still ambiguous and still refused.
  const mine=rows.filter(r=>r&&r.pilotID===details.pilotID&&pos(r.entityID));
  const hulls=[...new Set(mine.map(r=>Number(r.entityID)))];
  if(hulls.length!==1)return false;
  const currentID=hulls[0];
  if(currentID!==Number(details.currentEntityID))return false;
  // The successor must be a real hull NOW. A live scene ship is the strongest form; a
  // durable native record with its own controller is accepted as well, because a headless
  // front can hold the record before the scene is rebuilt after a restart.
  try{
   const now=mine.find(r=>Number(r.entityID)===currentID)||{};
   const scene=pos(now.systemID)?sceneForSystem(Number(now.systemID)):null;
   const ship=scene&&typeof scene.getEntityByID==="function"
    ?scene.getEntityByID(currentID):null;
   if(ship&&ship.kind==="ship"&&Number(ship.itemID)===currentID)return true;
   const record=getNativeEntity(currentID);
   const controller=getController(currentID);
   return Boolean(record&&Number(record.entityID)===currentID&&
    controller&&Number(controller.entityID)===currentID);
  }catch{return false}
 }
 return Object.freeze({verifyNativeShip,verifyCampaign,verifyRelease,verifyReplacement});
}
module.exports={createWarFleetNativeProofs};
