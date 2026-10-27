"use strict";
// Read-only evidence from the actual shared EveJS solar-system scene.
// "Same system" and "reciprocal visibility" are separate observations.
function positive(v){const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:null;}
function snapshot(scene){
 if(!scene?.sessions||typeof scene.sessions.values!=="function")return {status:"NO_SCENE",pilots:[]};
 const systemID=positive(scene.systemID);
 if(!systemID)return {status:"NO_SCENE",pilots:[],mutualVisibility:false};
 // A reconnect can briefly leave a stale old session in EveJS scene.
 // Never count disconnected/not-yet-Ballpark-ready ghost sessions as
 // a second actual co-op pilot or use their stale visibility cache.
 const activeSessions=[...scene.sessions.values()].filter(s=>
  positive(s?.characterID)&&positive(s?._space?.shipID)&&
  s?._space?.initialStateSent===true&&s?.socket?.destroyed!==true);
 const pilots=activeSessions.filter(s=>
  positive(s?._space?.systemID)===systemID).map(s=>{
   const shipID=positive(s._space.shipID);
   const ship=scene.getEntityByID?.(shipID);
   const physicalOwner=positive(ship?.pilotCharacterID??ship?.characterID);
   return {
    characterID:positive(s.characterID),shipID,
    shipExists:ship?.kind==="ship"&&Number(ship.itemID)===shipID&&
     (!physicalOwner||physicalOwner===positive(s.characterID)),
    visibleEntityIDs:s._space.visibleDynamicEntityIDs instanceof Set?
     s._space.visibleDynamicEntityIDs:null
   };
  });
 const byIdentity=new Map(),byShip=new Map();
 for(const p of pilots){
  if(byIdentity.has(p.characterID)||activeSessions.filter(s=>
   positive(s.characterID)===p.characterID).length!==1)
   return {status:"DUPLICATE_ACTIVE_CHARACTER_SESSION",
    pilots:[],mutualVisibility:false};
  byIdentity.set(p.characterID,p);
  // Two characters cannot establish co-op by claiming one physical hull.
  // Even an active wrong-system session in this scene makes custody ambiguous.
  if(byShip.has(p.shipID)||activeSessions.filter(s=>
   positive(s._space?.shipID)===p.shipID).length!==1)
   return {status:"DUPLICATE_ACTIVE_SHIP_OWNER",
    pilots:[],mutualVisibility:false};
  byShip.set(p.shipID,p.characterID);
 }
 const rows=[...byIdentity.values()].map(p=>({
  characterID:p.characterID,shipID:p.shipID,shipExists:p.shipExists,
  // null means no authoritative visibility set; do not fabricate a PASS.
  visiblePeerIDs:[...byIdentity.values()].filter(other=>other.characterID!==p.characterID&&p.visibleEntityIDs?.has(other.shipID)).map(other=>other.characterID),
  visibilityKnown:p.visibleEntityIDs instanceof Set
 }));
 const shared=rows.length>=2&&rows.every(p=>p.shipExists);
 const mutual=shared&&rows.length===2&&rows.every(p=>p.visiblePeerIDs.length===1);
 return {status:shared?"TWO_PILOTS_IN_SCENE":rows.length===1?"ONE_PILOT":"NOT_READY",pilots:rows,mutualVisibility:mutual};
}
function observe(session,ship,reason="presence"){
 try{
  const scene=require("./runtime").getSceneForSession(session);
  const state=snapshot(scene);
  require("./coopRuntimeProbe").observe("coop-shared-scene",session,ship,{reason,...state});
  return state;
 }catch(error){console.warn("[CoopDuoPresence]",error.message);return {status:"ERROR"};}
}
module.exports={snapshot,observe};
