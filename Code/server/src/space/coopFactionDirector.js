"use strict";
// Virtual faction strategy: replacement demand and patrol priorities.
// Never creates real ships or modifies EveJS wallets/standing.
const fs=require("node:fs"),path=require("node:path");
const positive=x=>Number.isSafeInteger(Number(x))&&Number(x)>0;
const bounded=x=>Math.max(0,Math.min(10000,Math.floor(Number(x)||0)));
function createFactionDirector({file,clock=()=>Date.now(),buildMinutes=30}){
 if(!file||!Number.isInteger(buildMinutes)||buildMinutes<1)throw Error("invalid faction director settings");
 let state;
 try{state=JSON.parse(fs.readFileSync(file,"utf8"));if(state.version!==1||!state.factions)throw Error("invalid faction state");}
 catch(e){if(e.code!=="ENOENT")throw e;}
 state??={version:1,factions:{},processed:{},lastTickAt:clock()};
 if(!state.processed||typeof state.processed!=="object"||Array.isArray(state.processed))throw Error("invalid saved faction event ledger");
 // Schema v1 extension: retain older saves without resetting earned losses.
 state.chronicle??=[];state.rivalries??={};
 if(!Array.isArray(state.chronicle)||typeof state.rivalries!=="object"||!state.rivalries)
  throw Error("invalid saved faction chronicle");
 const validEvent=x=>typeof x==="string"&&/^[A-Za-z0-9._:-]{1,160}$/.test(x);
 const validFaction=x=>typeof x==="string"&&x.length>0&&x.length<=48&&x.trim()===x;
 const append=(row)=>{state.chronicle.push(row);if(state.chronicle.length>1000)state.chronicle.splice(0,state.chronicle.length-1000);};
 const persist=()=>{
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+".tmp-"+process.pid;
  let fd=null;
  try{
   fd=fs.openSync(temp,"wx",0o600);
   fs.writeFileSync(fd,JSON.stringify(state));
   fs.fsyncSync(fd);
   fs.closeSync(fd);fd=null;
   fs.renameSync(temp,file);
  }finally{
   if(fd!==null)try{fs.closeSync(fd);}catch{}
   try{fs.unlinkSync(temp);}catch(error){if(error.code!=="ENOENT")throw error;}
  }
 };
 const key=(faction,systemID)=>String(faction||"independent").slice(0,48)+"@"+systemID;
 const get=(faction,systemID)=>state.factions[key(faction,systemID)]??={faction:String(faction||"independent"),systemID:Number(systemID),losses:0,replacementDemand:0,readiness:0,threat:0,patrolPriority:0,shipsRebuilt:0};
 function onLoss({eventID,faction,systemID}){
  if(!validEvent(eventID)||!validFaction(faction)||!positive(systemID))return {status:"INVALID"};
  const proof={kind:"CONFIRMED_NPC_LOSS",faction,systemID:Number(systemID)};
  const replay=state.processed[eventID];
  if(replay)return {status:typeof replay!=="object"||JSON.stringify(replay)===JSON.stringify(proof)?"DUPLICATE":"CONFLICT"};
  const previous=structuredClone(state);
  const entry=get(faction,systemID);
  entry.losses=bounded(entry.losses+1);
  entry.replacementDemand=bounded(entry.replacementDemand+1);
  entry.threat=bounded(entry.threat+15);
  entry.patrolPriority=Math.min(100,entry.patrolPriority+20);
  state.factions[key(faction,systemID)]=entry;
  state.processed[eventID]=proof;
  append({eventID,kind:"CONFIRMED_NPC_LOSS",faction:entry.faction,
   systemID:entry.systemID,occurredAt:clock(),losses:entry.losses,replacementDemand:entry.replacementDemand});
  try{persist();}catch(error){state=previous;throw error;}
  return {status:"RECORDED",faction:entry.faction,systemID:entry.systemID};
 }
 // An attack order counts as tension, never as a confirmed kill or conquest.
 // The two faction tags belong to our named NPC layer, not EveJS ownerIDs.
 function onEngagement({eventID,aggressorFaction,defenderFaction,systemID,attackerPilotID,defenderPilotID}={}){
  if(!validEvent(eventID)||!positive(systemID)||!validFaction(aggressorFaction)||
    !validFaction(defenderFaction)||aggressorFaction===defenderFaction||
    !/^coop-pilot-[0-9]{3,}$/.test(String(attackerPilotID))||
    !/^coop-pilot-[0-9]{3,}$/.test(String(defenderPilotID)))return {status:"INVALID"};
  const eventKey=eventID;
  const proof={kind:"NATIVE_ATTACK_ORDER",aggressorFaction,defenderFaction,
   systemID:Number(systemID),attackerPilotID,defenderPilotID};
  const replay=state.processed[eventKey];
  if(replay)return {status:typeof replay!=="object"||JSON.stringify(replay)===JSON.stringify(proof)?"DUPLICATE":"CONFLICT"};
  const previous=structuredClone(state);
  const pair=[String(aggressorFaction).slice(0,48),String(defenderFaction).slice(0,48)].sort();
  const rivalryKey=pair.join("|")+"@"+systemID;
  const rivalry=state.rivalries[rivalryKey]??={factions:pair,systemID:Number(systemID),engagementOrders:0,phase:"CONTACT"};
  rivalry.engagementOrders=bounded(rivalry.engagementOrders+1);
  rivalry.phase=rivalry.engagementOrders>=6?"SUSTAINED_TENSION":
    rivalry.engagementOrders>=3?"ESCALATING":"CONTACT";
  rivalry.lastAt=clock();
  state.rivalries[rivalryKey]=rivalry;
  const defender=get(defenderFaction,systemID);
  defender.threat=bounded(defender.threat+3);
  defender.patrolPriority=Math.min(100,defender.patrolPriority+5);
  state.factions[key(defenderFaction,systemID)]=defender;
  state.processed[eventKey]=proof;
  append({eventID:eventKey,kind:"NATIVE_ATTACK_ORDER",aggressorFaction:pair.includes(aggressorFaction)?aggressorFaction:String(aggressorFaction),
   defenderFaction:String(defenderFaction),attackerPilotID,defenderPilotID,
   systemID:Number(systemID),occurredAt:clock()});
  try{persist();}catch(error){state=previous;throw error;}
  return {status:"RECORDED",phase:rivalry.phase,engagementOrders:rivalry.engagementOrders};
 }
 function recentForSystem(systemID,limit=10){
  if(!positive(systemID))return [];
  const max=Math.max(1,Math.min(50,Math.floor(Number(limit)||10)));
  return structuredClone(state.chronicle.filter(e=>Number(e.systemID)===Number(systemID)).slice(-max).reverse());
 }
 function advance(virtualEconomySystems={}){
  const now=clock(),duration=buildMinutes*60000;
  if(now<state.lastTickAt)return {status:"CLOCK_REWIND",completed:0};
  const steps=Math.min(1440,Math.floor((now-state.lastTickAt)/duration));
  const previous=structuredClone(state);
  let completed=0;
  for(const entry of Object.values(state.factions)){
   const available=bounded(virtualEconomySystems[String(entry.systemID)]?.goods);
   const affordable=Math.floor(available/10);
   const built=Math.min(steps,entry.replacementDemand,affordable);
   if(built){
    entry.replacementDemand-=built;entry.shipsRebuilt=bounded(entry.shipsRebuilt+built);
    entry.readiness=bounded(entry.readiness+built);
    // Commit production into the virtual faction plan only; no physical ship.
    completed+=built;
   }
   entry.patrolPriority=Math.max(0,entry.patrolPriority-Math.floor(steps/3));
   entry.threat=Math.max(0,entry.threat-Math.floor(steps/6));
  }
  if(steps){state.lastTickAt+=steps*duration;try{persist();}catch(error){state=previous;throw error;}}
  return {status:"OK",completed,steps};
 }
 return {onLoss,onEngagement,recentForSystem,advance,snapshot:()=>structuredClone(state)};
}
module.exports={createFactionDirector};
