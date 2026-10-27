"use strict";
// Native NPC-on-NPC cooperative scouting. Builds intent from real, in-scene
// named pirate hulls and *stock EveJS mining-fleet* targets. Never orders combat.
// Physical proximity is a provisional grid witness, NOT a cloak/sensor scan.
const integer=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
const position=p=>!!p&&["x","y","z"].every(k=>Number.isFinite(p[k]));
const meters=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function createSquadDirector({clock=()=>Date.now(),relayDelayMs=15000,
 reportTtlMs=60000,maxRangeMeters=180000,maxAttackers=2,maxTeams=64}={}){
 if(typeof clock!=="function"||!Number.isSafeInteger(relayDelayMs)||relayDelayMs<1000||
  !Number.isSafeInteger(reportTtlMs)||reportTtlMs<15000||relayDelayMs>=reportTtlMs||
  !Number.isSafeInteger(maxRangeMeters)||maxRangeMeters<1000||maxRangeMeters>200000||
  !Number.isInteger(maxAttackers)||maxAttackers<1||maxAttackers>3||
  !Number.isInteger(maxTeams)||maxTeams<1||maxTeams>200)
  throw Error("INVALID_SQUAD_CONFIG");
 const teams=new Map();
 const validShip=(scene,id)=>{
  const ship=scene.getEntityByID(id);
  return ship?.kind==="ship"&&ship.nativeNpc===true&&
   Number(ship.itemID)===id&&!ship.session?.characterID&&
   !String(ship.mode||"").toUpperCase().includes("WARP")&&
   !ship.pendingWarp&&!ship.warpState&&position(ship.position)?ship:null;
 };
 function observe({systemID,scene,pirates=[],pilots=[],fleetShips=[],canAttack=()=>false}={}){
  const sys=integer(systemID),now=clock();
  if(!sys||Number(scene?.systemID)!==sys||typeof scene.getEntityByID!=="function"||
   !Array.isArray(pirates)||!Array.isArray(pilots)||!Array.isArray(fleetShips)||
   typeof canAttack!=="function"||
   !Number.isSafeInteger(now)||now<0)return {status:"INVALID",teams:[]};
  const priorTeams=new Map(teams);
  for(const [key,team] of teams)if(team.expiresAt<now||team.systemID===sys)teams.delete(key);
  const factions=new Map(pilots.filter(p=>named(p?.id)&&typeof p.faction==="string"&&
   p.faction.length>0&&p.faction.length<80).map(p=>[p.id,p.faction]));
  const countPilot=new Map(),countShip=new Map();
  for(const p of pirates){
   if(!named(p?.pilotID)||!integer(p.entityID)||Number(p.systemID)!==sys)continue;
   countPilot.set(p.pilotID,(countPilot.get(p.pilotID)||0)+1);
   countShip.set(Number(p.entityID),(countShip.get(Number(p.entityID))||0)+1);
  }
  const byFaction=new Map();
  for(const p of pirates){
   const entityID=integer(p?.entityID),faction=factions.get(p?.pilotID);
   if(!entityID||!faction||p?.role!=="pirate"||Number(p.systemID)!==sys||
    countPilot.get(p.pilotID)!==1||countShip.get(entityID)!==1)continue;
   const ship=validShip(scene,entityID);
   if(!ship)continue;
   if(!byFaction.has(faction))byFaction.set(faction,[]);
   byFaction.get(faction).push({pilotID:p.pilotID,entityID,ship});
  }
  const targets=[],ids=new Set();
  for(const row of fleetShips.slice(0,120)){
   const targetID=integer(row?.id);
   if(!targetID||ids.has(targetID)||!["miner","hauler"].includes(row?.role))continue;
   ids.add(targetID);
   const ship=validShip(scene,targetID);
   if(ship)targets.push({targetID,targetRole:row.role,ship});
  }
  const visible=[];
  for(const [faction,members] of byFaction){
   if(members.length<2)continue;
   for(const target of targets)for(const pilot of members){
    const distance=meters(pilot.ship.position,target.ship.position);
    if(distance<=maxRangeMeters)visible.push({faction,members,target,
     scout:pilot,distance});
   }
  }
  const stillScout=c=>{
   const prior=priorTeams.get(sys+":"+c.faction);
   return prior?.targetID===c.target.targetID&&
    prior.scoutID===c.scout.entityID&&prior.expiresAt>=now?0:1;
  };
  visible.sort((a,b)=>a.faction.localeCompare(b.faction)||
   (a.target.targetRole==="hauler"?0:1)-(b.target.targetRole==="hauler"?0:1)||
   stillScout(a)-stillScout(b)||
   a.distance-b.distance||a.target.targetID-b.target.targetID||
   a.scout.pilotID.localeCompare(b.scout.pilotID));
  const next=new Map(),summary=[];
  for(const candidate of visible){
   const {faction,members,target,scout}=candidate,key=sys+":"+faction;
   if(next.has(key)||teams.size+next.size>=maxTeams)continue;
   const attackerIDs=members.filter(p=>{
    if(p.entityID===scout.entityID)return false;
    try{return canAttack({systemID:sys,pirateID:p.entityID,
      targetID:target.targetID})===true;}catch(_error){return false;}
   }).sort((a,b)=>meters(a.ship.position,target.ship.position)-
      meters(b.ship.position,target.ship.position)||a.pilotID.localeCompare(b.pilotID))
    .slice(0,maxAttackers).map(p=>p.entityID);
   if(!attackerIDs.length)continue;
   const prior=priorTeams.get(key);
   const continuing=prior?.witnessLost!==true&&prior?.scoutID===scout.entityID&&
    prior.targetID===target.targetID&&prior.firstSeenAt<=now&&
    prior.expiresAt>=now&&meters(prior.position,target.ship.position)<=100000;
   const team={systemID:sys,faction,scoutID:scout.entityID,
    scoutPilotID:scout.pilotID,attackerIDs,targetID:target.targetID,
    targetRole:target.targetRole,
    firstSeenAt:continuing?prior.firstSeenAt:now,
    lastSeenAt:now,expiresAt:now+reportTtlMs,
    position:{...target.ship.position},witnessLost:false};
   next.set(key,team);
   summary.push({systemID:sys,scoutID:team.scoutID,
    attackerIDs:[...team.attackerIDs],targetID:team.targetID,
    readyAt:team.firstSeenAt+relayDelayMs});
  }
  // A temporarily lost witness must not instantly turn the same coordinated
  // pirates into unrestricted solo hunters. Hold the old team until TTL;
  // permit() still refuses any order if the physical scout cannot testify.
  for(const [key,old] of priorTeams)if(old.systemID===sys&&
   !next.has(key)&&old.expiresAt>=now&&
   validShip(scene,old.targetID)&&teams.size+next.size<maxTeams)
    next.set(key,{...old,witnessLost:true});
  for(const [key,value] of next)teams.set(key,value);
  return {status:"OK",teams:summary};
 }
 function permit({systemID,scene,pirateID,targetID}={}){
  const sys=integer(systemID),attacker=integer(pirateID),target=integer(targetID),now=clock();
  if(!sys||!attacker||!target||Number(scene?.systemID)!==sys||
   typeof scene.getEntityByID!=="function"||!Number.isSafeInteger(now))
   return {allowed:false,reason:"INVALID_NATIVE_CONTEXT"};
  const all=[...teams.values()].filter(t=>t.systemID===sys&&
   (t.scoutID===attacker||t.attackerIDs.includes(attacker)));
  if(!all.length)return {allowed:true,reason:"SOLO_NATIVE_POLICY"};
  const team=all[0];
  if(attacker===team.scoutID)return {allowed:false,reason:"SCOUT_WITNESS_ONLY"};
  if(team.targetID!==target)return {allowed:false,reason:"SQUAD_TARGET_RESERVED"};
  if(team.witnessLost)return {allowed:false,reason:"NO_CURRENT_WITNESS"};
  if(now<team.firstSeenAt+relayDelayMs)
   return {allowed:false,reason:"RELAY_IN_FLIGHT"};
  if(now<team.lastSeenAt||now>team.expiresAt)
   return {allowed:false,reason:"REPORT_EXPIRED"};
  const scout=validShip(scene,team.scoutID),prey=validShip(scene,target);
  const recipient=validShip(scene,attacker);
  if(!scout||!prey||!recipient||
   meters(scout.position,prey.position)>maxRangeMeters||
   meters(team.position,prey.position)>100000)
   return {allowed:false,reason:"NATIVE_WITNESS_LOST"};
  return {allowed:true,reason:"SCOUT_RELAY_CONFIRMED",report:{
   sourcePilotID:team.scoutPilotID,sourceEntityID:team.scoutID,
   recipientEntityID:attacker,targetID:target,targetRole:team.targetRole,
   systemID:sys,position:{...team.position},observedAt:team.lastSeenAt,
   firstSeenAt:team.firstSeenAt}};
 }
 function activeScoutIDs(systemID){
  const sys=integer(systemID),now=clock(),result=new Set();
  if(!sys)return result;
  for(const team of teams.values())if(team.systemID===sys&&
   team.witnessLost!==true&&team.expiresAt>=now)result.add(team.scoutID);
  return result;
 }
 function snapshot(){return [...teams.values()].map(t=>({...t,
  position:{...t.position},attackerIDs:[...t.attackerIDs]}));}
 return {observe,permit,activeScoutIDs,snapshot};
}
module.exports={createSquadDirector};
