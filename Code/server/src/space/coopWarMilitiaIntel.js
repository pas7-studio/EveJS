"use strict";
// FW-009C: read-only, actor-scoped MILITIA agent front line briefing.
// Never lets the client declare war, move ships, gain ISK or claim victory.
const core=require("./coopFactionWarCore"+(__filename.endsWith(".js")?"":".cjs"));
const {TABLE,KEY:WAR_KEY}=require("./coopFactionWarStore"+
 (__filename.endsWith(".js")?"":".cjs"));
const {KEY:OBJECTIVE_KEY,validate:validateObjective}=
 require("./coopWarObjectiveAdjudicator"+(__filename.endsWith(".js")?"":".cjs"));
const pos=x=>Number.isSafeInteger(x)&&x>0;
function createWarMilitiaIntel({gameStore,env=process.env}={}){
 if(typeof gameStore?.coopAtomicNativeRows?.transact!=="function")
  throw Error("WAR_MILITIA_INTEL_NATIVE_SQL_REQUIRED");
 const read=({characterID,factionID}={})=>{
  if(env.EVEJS_COOP_FACTION_WAR!=="1"||
   env.EVEJS_COOP_FACTION_MILITIA_AGENT!=="1"||
   env.EVEJS_COOP_FACTION_WAR_PLAYER_CAPTURE!=="1"||
   env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1")
   return {status:"DISABLED",text:""};
  if(!pos(characterID)||!pos(factionID))
   return {status:"INVALID_ACTOR",text:""};
  try{
   return gameStore.coopAtomicNativeRows.transact([TABLE],tx=>{
    const war=tx.get(TABLE,WAR_KEY);
    if(!war)return {status:"UNAVAILABLE",text:""};
    core.validateState(war);
    const enlist=war.enlistments[String(characterID)];
    if(enlist?.status!=="ACTIVE"||
     enlist.characterID!==characterID||
     enlist.factionID!==factionID||
     !pos(enlist.enlistedAt))
     return {status:"NOT_ENLISTED",text:""};
    let objective=null;
    try{
     const s=tx.get(TABLE,OBJECTIVE_KEY);
     if(s)objective=validateObjective(s);
    }catch{return {status:"OBJECTIVE_UNAVAILABLE",text:""}}
    const campaigns=Object.values(war.campaigns).filter(c=>{
     const w=war.wars[c?.warID];
     return w?.state==="ACTIVE"&&
      [w.attackerFactionID,w.defenderFactionID].includes(factionID)&&
      ["PREPARING","ASSAULT","OCCUPIED"].includes(c.state)&&
      pos(c.targetSystemID);
    }).sort((a,b)=>a.targetSystemID-b.targetSystemID).slice(0,4);
    if(!campaigns.length)return {status:"OBSERVED",
     text:"[Militia] No currently verified faction-war front lines."};
    const lines=campaigns.map(c=>{
     const w=war.wars[c.warID],
      role=w.attackerFactionID===factionID?"ATTACK":"DEFEND",
      obj=objective?.objectives?.[c.campaignID],
      samples=objective?.captureSeries?.[c.campaignID];
     const progress=obj?.state==="NEUTRALIZED"&&
      pos(samples?.count) ?Math.min(4,samples.count):0;
     const label=obj?.state==="CAPTURED"?"Captured":
      obj?.state==="NEUTRALIZED"?"Structure down, hold 20 km":
      obj?.state==="BOUND"?"Defend / destroy objective":"Objective pending";
     return role+" system "+c.targetSystemID+" ("+c.state+"): "+
      label+"; hold "+progress+"/4.";
    });
    return {status:"OBSERVED",
     text:"[Militia Front] "+lines.join(" ")};
   });
  }catch{return {status:"UNAVAILABLE",text:""}}
 };
 return Object.freeze({read});
}
module.exports={createWarMilitiaIntel};
