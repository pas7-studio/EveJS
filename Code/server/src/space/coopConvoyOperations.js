"use strict";
// Read-only native incident linkage. No quests, grants, NPC orders or combat.
// Every state change requires a real native raid order or verified applied
// player damage + exact physical scene/session/fleet evidence.
const fs=require("node:fs"),path=require("node:path");
const DEFAULT="/var/lib/evejs/coop-native-convoy-incidents.jsonl";
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):0;
const isPos=p=>p&&["x","y","z"].every(k=>Number.isFinite(p[k]));
const STATES=new Set(["APPROACH","UNDER_ATTACK","PLAYER_HIT","DUO_INTERVENED","PIRATE_WRECK_CONFIRMED"]);
const keyOf=({systemID,pirateID,targetID})=>[systemID,pirateID,targetID].join(":");
function createOperations({file=process.env.EVEJS_COOP_CONVOY_INCIDENTS_FILE||DEFAULT,
 io=fs,clock=()=>Date.now(),maxBytes=8*1024*1024}={}){
 let loaded=false,blocked=null,incidents=new Map();
 function deny(reason){blocked=reason;return {status:reason};}
 function ensure(){
  if(blocked)return {status:blocked};
  if(loaded)return {status:"READY"};
  if(typeof file!=="string"||!path.isAbsolute(file)||file.length>500)
   return deny("CONVOY_JOURNAL_PATH_INVALID");
  let data;try{data=io.readFileSync(file,"utf8")}
  catch(e){if(e?.code==="ENOENT")data="";else return deny("CONVOY_JOURNAL_READ_FAILED")}
  if(typeof data!=="string"||Buffer.byteLength(data)>maxBytes||
   (data.length>0&&!data.endsWith("\n")))return deny("CONVOY_JOURNAL_CORRUPT");
  let parsed=new Map();
  for(const line of data.split("\n")){
   if(!line)continue;
   let ev;try{ev=JSON.parse(line)}catch{return deny("CONVOY_JOURNAL_CORRUPT")}
   if(ev?.v!==1||!STATES.has(ev.state)||!id(ev.systemID)||
    !id(ev.pirateID)||!id(ev.targetID)||ev.pirateID===ev.targetID||
    ev.key!==keyOf(ev)||!Number.isFinite(ev.at)||ev.at<0)
    return deny("CONVOY_JOURNAL_CORRUPT");
   let incident=parsed.get(ev.key);
   if(!incident){
    if(!["APPROACH","UNDER_ATTACK"].includes(ev.state))return deny("CONVOY_JOURNAL_BAD_SEQUENCE");
    incident={key:ev.key,systemID:ev.systemID,pirateID:ev.pirateID,
     targetID:ev.targetID,targetRole:ev.targetRole,status:ev.state,
     contributions:new Map(),duoFleetID:0,closed:false,events:0};
    if(!["miner","hauler"].includes(incident.targetRole))return deny("CONVOY_JOURNAL_CORRUPT");
    parsed.set(ev.key,incident);
   }else{
    if(incident.closed||ev.targetRole!==incident.targetRole)return deny("CONVOY_JOURNAL_BAD_SEQUENCE");
    if(ev.state==="APPROACH"){
     if(incident.status!=="APPROACH")return deny("CONVOY_JOURNAL_BAD_SEQUENCE");
    }
    if(ev.state==="UNDER_ATTACK"){
     if(!["APPROACH","UNDER_ATTACK"].includes(incident.status))return deny("CONVOY_JOURNAL_BAD_SEQUENCE");
     incident.status="UNDER_ATTACK";
    }
    if(ev.state==="PLAYER_HIT"){
     if(incident.status==="APPROACH"||!id(ev.characterID)||!id(ev.shipID)||
      !id(ev.fleetID)||incident.contributions.has(ev.characterID))
      return deny("CONVOY_JOURNAL_BAD_SEQUENCE");
     incident.contributions.set(ev.characterID,{shipID:ev.shipID,fleetID:ev.fleetID});
    }
    if(ev.state==="DUO_INTERVENED"){
     if(!id(ev.fleetID)||!Array.isArray(ev.characters)||ev.characters.length!==2||
      !id(ev.characters[0])||!id(ev.characters[1])||
      ev.characters[0]===ev.characters[1]||incident.duoFleetID)
      return deny("CONVOY_JOURNAL_BAD_SEQUENCE");
     const all=ev.characters.every(c=>incident.contributions.get(c)?.fleetID===ev.fleetID);
     if(!all)return deny("CONVOY_JOURNAL_BAD_SEQUENCE");
     incident.duoFleetID=ev.fleetID;
    }
    if(ev.state==="PIRATE_WRECK_CONFIRMED"){
     if(incident.status==="APPROACH"||!id(ev.nativeWreckID))
      return deny("CONVOY_JOURNAL_BAD_SEQUENCE");
     incident.closed=true;incident.status="PIRATE_WRECK_CONFIRMED";
     incident.nativeWreckID=ev.nativeWreckID;
    }
   }
   incident.events++;
  }
  incidents=parsed;loaded=true;
  return {status:"READY"};
 }
 function append(event){
  const now=clock();if(!Number.isFinite(now)||now<0)return deny("CONVOY_CLOCK_INVALID");
  const payload=JSON.stringify({v:1,...event,at:now})+"\n";
  let fd;
  try{
   if(Buffer.byteLength(payload)>4096)return deny("CONVOY_EVENT_TOO_LARGE");
   io.mkdirSync(path.dirname(file),{recursive:true});
   fd=io.openSync(file,"a",0o600);
   const bytes=Buffer.from(payload);
   if(io.writeSync(fd,bytes,0,bytes.length,null)!==bytes.length)
    return deny("CONVOY_JOURNAL_WRITE_UNCERTAIN");
   io.fsyncSync(fd);
  }catch{return deny("CONVOY_JOURNAL_WRITE_UNCERTAIN")}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
  loaded=false;return ensure();
 }
 function ship(scene,entityID){
  const e=scene?.getEntityByID?.(entityID);
  return e?.kind==="ship"&&e.nativeNpc===true&&
   id(e.itemID)===entityID&&isPos(e.position)?e:null;
 }
 function realPlayers(scene){
  return new Set(Array.from(scene?.sessions?.values?.()||[])
   .map(s=>id(s?._space?.shipID)).filter(Boolean));
 }
 function raid({scene,action}={}){
  const ready=ensure();if(ready.status!=="READY")return ready;
  const systemID=id(scene?.systemID),pirateID=id(action?.pirateID),
   targetID=id(action?.targetID),targetRole=action?.targetRole;
  if(!systemID||!pirateID||!targetID||pirateID===targetID||
   !["miner","hauler"].includes(targetRole)||
   !["warp-to-hauler","attack"].includes(action?.action)||
   !ship(scene,pirateID)||!ship(scene,targetID)||
   realPlayers(scene).has(pirateID)||realPlayers(scene).has(targetID))
   return {status:"NO_VERIFIED_NATIVE_CONVOY_RAID"};
  const key=keyOf({systemID,pirateID,targetID}),old=incidents.get(key);
  if(old?.closed)return {status:"NATIVE_INCIDENT_ALREADY_CLOSED",key};
  if(old&&old.targetRole!==targetRole)return deny("CONVOY_NATIVE_TARGET_DRIFT");
  const state=action.action==="attack"?"UNDER_ATTACK":"APPROACH";
  if(old&&(old.status!=="APPROACH"||state==="APPROACH"))
   return {status:"NATIVE_INCIDENT_ALREADY_RECORDED",key};
  const res=append({key,systemID,pirateID,targetID,targetRole,state});
  return res.status==="READY"?{status:"NATIVE_CONVOY_INCIDENT_RECORDED",key,phase:state}:res;
 }
 function livePilot(scene,receipt){
  if(!scene?.sessions||!id(receipt?.characterID)||!id(receipt?.shipID))return null;
  const matches=[...scene.sessions.values()].filter(s=>
   id(s?.characterID)===receipt.characterID);
  if(matches.length!==1)return null;
  const s=matches[0],space=s?._space;
  if(s.socket?.destroyed===true||space?.initialStateSent!==true||
   id(space.systemID)!==id(scene.systemID)||
   id(space.shipID)!==receipt.shipID)return null;
  const entity=scene.getEntityByID?.(receipt.shipID);
  if(entity?.kind!=="ship"||entity.nativeNpc===true||
   id(entity.itemID)!==receipt.shipID)return null;
  return s;
 }
 function wreckProof(scene,pirateID){
  if(!(scene?.dynamicEntities instanceof Map))return 0;
  for(const w of scene.dynamicEntities.values()){
   if(w?.nativeNpcWreck===true&&id(w.itemID)&&
    id(w.launcherID)===pirateID&&
    scene.getEntityByID?.(id(w.itemID))===w)return id(w.itemID);
  }
  return 0;
 }
 function damage({scene,receipt,fleetRuntime}={}){
  const ready=ensure();if(ready.status!=="READY")return ready;
  if(receipt?.status!=="APPLIED_NATIVE_PLAYER_DAMAGE"||
   receipt.source!=="NATIVE_KILLMAIL_TRACKER_NOTE_DAMAGE"||
   !(Number(receipt.appliedDamage)>0)||
   id(receipt.systemID)!==id(scene?.systemID)||
   !id(receipt.victimEntityID)||!livePilot(scene,receipt)||
   !fleetRuntime||typeof fleetRuntime.getFleetForCharacter!=="function"||
   typeof fleetRuntime.getMemberRecord!=="function")
   return {status:"NO_VERIFIED_NATIVE_PLAYER_INTERVENTION"};
  const pirateID=id(receipt.victimEntityID);
  if(receipt.victimProof==="LIVE_NATIVE_SHIP"){
   if(!ship(scene,pirateID))return {status:"NATIVE_PIRATE_NOT_PRESENT"};
  }else if(receipt.victimProof==="TERMINAL_NATIVE_WRECK"){
   if(!wreckProof(scene,pirateID))return {status:"NATIVE_PIRATE_WRECK_UNVERIFIED"};
  }else return {status:"NATIVE_PIRATE_IDENTITY_UNVERIFIED"};
  const matches=[...incidents.values()].filter(i=>
   i.systemID===id(scene.systemID)&&i.pirateID===pirateID&&
   !i.closed&&i.status!=="APPROACH");
  if(matches.length!==1)return {status:"NO_UNIQUE_ACTIVE_CONVOY_INCIDENT"};
  const incident=matches[0],characterID=id(receipt.characterID);
  let fleet;try{fleet=fleetRuntime.getFleetForCharacter(characterID)}catch{return {status:"FLEET_UNAVAILABLE"}}
  const fleetID=id(fleet?.fleetID);
  if(!fleetID||fleet.members?.size!==2||!fleet.members.has(characterID)||
   !fleetRuntime.getMemberRecord(fleet,characterID))
   return {status:"NOT_AUTHENTIC_NATIVE_DUO"};
  if(!incident.contributions.has(characterID)){
   const res=append({key:incident.key,systemID:incident.systemID,
    pirateID:incident.pirateID,targetID:incident.targetID,
    targetRole:incident.targetRole,state:"PLAYER_HIT",
    characterID,shipID:id(receipt.shipID),fleetID});
   if(res.status!=="READY")return res;
  }
  const current=incidents.get(incident.key);
  let newlyConfirmedDuo=false,newlyConfirmedWreck=false;
  if(!current.duoFleetID){
   const peers=[...current.contributions.entries()].filter(([char,info])=>
    info.fleetID===fleetID&&fleet.members.has(char)&&
    fleetRuntime.getMemberRecord(fleet,char)&&
    [...scene.sessions.values()].some(s=>id(s?.characterID)===char&&
     livePilot(scene,{characterID:char,shipID:info.shipID})));
   if(peers.length===2){
    const characters=peers.map(x=>x[0]).sort((a,b)=>a-b);
    const res=append({key:incident.key,systemID:incident.systemID,
     pirateID:incident.pirateID,targetID:incident.targetID,
     targetRole:incident.targetRole,state:"DUO_INTERVENED",
     fleetID,characters});
    if(res.status!=="READY")return res;
    newlyConfirmedDuo=true;
   }
  }
  if(receipt.victimProof==="TERMINAL_NATIVE_WRECK"){
   const nativeWreckID=wreckProof(scene,pirateID);
   const res=append({key:incident.key,systemID:incident.systemID,
    pirateID:incident.pirateID,targetID:incident.targetID,
    targetRole:incident.targetRole,state:"PIRATE_WRECK_CONFIRMED",nativeWreckID});
   if(res.status!=="READY")return res;
   newlyConfirmedWreck=true;
  }
  return {status:"NATIVE_CONVOY_INTERVENTION_RECORDED",key:incident.key,
   duoConfirmed:!!incidents.get(incident.key)?.duoFleetID,
   duoFleetID:incidents.get(incident.key)?.duoFleetID||0,
   newlyConfirmedDuo,newlyConfirmedWreck,
   pirateWreckConfirmed:!!incidents.get(incident.key)?.closed};
 }
 function snapshot(){
  const r=ensure();if(r.status!=="READY")return r;
  return {status:"READY",incidents:[...incidents.values()].map(i=>({
   key:i.key,systemID:i.systemID,pirateID:i.pirateID,targetID:i.targetID,
   targetRole:i.targetRole,status:i.status,duoFleetID:i.duoFleetID,
   characters:[...i.contributions.keys()].sort((a,b)=>a-b),
   nativeWreckID:i.nativeWreckID||0,closed:i.closed
  }))};
 }
 return {raid,damage,snapshot,status:()=>blocked};
}
let singleton;
function instance(){if(!singleton)singleton=createOperations();return singleton}
function noteRaid(scene,action){
 if(process.env.EVEJS_COOP_CONVOY_OPERATIONS!=="1")return {status:"DISABLED"};
 try{return instance().raid({scene,action})}
 catch{return {status:"NATIVE_CONVOY_OPERATION_UNAVAILABLE"}}
}
function noteDamage(scene,receipt,fleetRuntime){
 if(process.env.EVEJS_COOP_CONVOY_OPERATIONS!=="1")return {status:"DISABLED"};
 let result;
 try{result=instance().damage({scene,receipt,fleetRuntime})}
 catch{return {status:"NATIVE_CONVOY_OPERATION_UNAVAILABLE"}}
 // A real PIRATE_WRECK_CONFIRMED may arrive AFTER native warehouse delivery
 // and the original NPC fleet might already have completed its route.
 // Reconcile only after an independently recorded native duo + wreck event;
 // never let arbitrary combat RPCs or chat messages choose a paid contract.
 if(result?.status==="NATIVE_CONVOY_INTERVENTION_RECORDED"&&
    result.duoConfirmed===true&&result.pirateWreckConfirmed===true&&
    (result.newlyConfirmedWreck===true||result.newlyConfirmedDuo===true)&&
    process.env.EVEJS_COOP_ESCORT_SETTLEMENT_REPLAY==="1"){
   let resultOfReplay;
   try{resultOfReplay=require("./coopEscortNativeBinding")
    .reconcilePendingDeliveries({systemID:Number(scene?.systemID),maxTrips:32})}
   catch{resultOfReplay={status:"NATIVE_RECONCILE_EVENT_HOOK_UNAVAILABLE"}}
   return {...result,escortSettlementReconciliation:resultOfReplay?.status||
    "NATIVE_RECONCILE_UNKNOWN"};
 }
 return result;
}
module.exports={createOperations,noteRaid,noteDamage};
