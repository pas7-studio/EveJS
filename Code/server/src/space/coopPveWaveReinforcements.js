"use strict";
// PVE-003A: physically rally EXISTING ships from an ALREADY spawned native
// dungeon encounter wave. Never spawn another wave or mutate mission state.
const suffix=__filename.endsWith(".cjs")?".cjs":"";
const {siteEntries}=require("./coopPveNativeSiteDefense"+suffix);
const id=n=>Number.isSafeInteger(n)&&n>0?n:null;
const pos=p=>p&&["x","y","z"].every(k=>typeof p[k]==="number"&&Number.isFinite(p[k]));
const meters=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const inWarp=e=>String(e?.mode||"").toUpperCase().includes("WARP")||
 Boolean(e?.pendingWarp||e?.warpState||e?.isWarping);
const occupied=c=>Boolean(c?.currentTargetID)||
 Boolean(c?.manualOrder?.type)&&String(c.manualOrder.type).toLowerCase()!=="resumebehavior";
function createWaveReinforcements({
 clock=()=>Date.now(),getNativeEntity,getController,resolveVerifiedPlayer,
 warpToEntity,attack,notify=()=>{},maxPending=512
}={}){
 if([clock,getNativeEntity,getController,resolveVerifiedPlayer,warpToEntity,attack,notify]
    .some(fn=>typeof fn!=="function")||
    !Number.isSafeInteger(maxPending)||maxPending<1||maxPending>4096)
  throw Error("INVALID_NATIVE_WAVE_REINFORCEMENTS");
 const requests=new Map();
 function tick({systemID,scene,instances=[],excludedIDs=[]}={}){
  const result={status:"NO_VALID_NATIVE_WAVES",sites:0,warpOrders:0,attackOrders:0,events:[]};
  const now=clock();
  if(!id(systemID)||!Number.isSafeInteger(now)||now<=0||
     scene?.systemID!==systemID||typeof scene.getEntityByID!=="function"||
     !Array.isArray(excludedIDs)||excludedIDs.length>1024||
     !(scene.sessions instanceof Map))
   return {...result,status:"INVALID_NATIVE_CONTEXT"};
  if(requests.size>=maxPending)return {...result,status:"REQUEST_FENCE_CAP_REACHED"};
  const proof=siteEntries(systemID,scene,instances);
  if(proof.status!=="OK")return {...result,status:proof.status};
  if(!proof.sites.length)return result;
  result.sites=proof.sites.length;
  const excluded=new Set(excludedIDs);
  const liveSessions=[...scene.sessions.values()].filter(s=>s?.socket&&s.socket.destroyed!==true&&
    s?._space?.initialStateSent===true&&s._space.systemID===systemID&&id(s.characterID));
  function player(attackerID){
   const ship=id(attackerID)&&scene.getEntityByID(attackerID);
   if(!ship||ship.itemID!==attackerID||ship.kind!=="ship"||ship.nativeNpc===true||!pos(ship.position))
    return null;
   const holders=liveSessions.filter(s=>s._space?.shipID===attackerID);
   if(holders.length!==1||liveSessions.filter(s=>s.characterID===holders[0].characterID).length!==1)return null;
   try{if(resolveVerifiedPlayer(scene,ship)!==holders[0].characterID)return null;}catch{return null;}
   return ship;
  }
  function defender(site,entityID){
   if(!id(entityID)||excluded.has(entityID))return null;
   const source=proof.owners.get(entityID);
   if(source?.length!==1||source[0].site!==site)return null;
   const ownership=source[0],wave=instances.find(x=>x?.instanceID===site.instanceID)
      ?.spawnState?.encounterStatesByKey?.[ownership.encounterKey];
   if(!wave||wave.spawnedAtMs!==ownership.spawnedAtMs||
      !Number.isSafeInteger(wave.waveIndex)||wave.waveIndex<1||
      id(wave.completedAtMs))return null;
   const ship=scene.getEntityByID(entityID),record=getNativeEntity(entityID),c=getController(entityID);
   if(!ship||ship.kind!=="ship"||ship.itemID!==entityID||ship.nativeNpc!==true||
      ship.session?.characterID||ship.systemID&&ship.systemID!==systemID||!pos(ship.position)||
      !record||record.entityID!==entityID||record.systemID!==systemID||
      record.nativeNpc!==true||record.transient!==true||
      !id(record.corporationID)||record.corporationID!==ship.corporationID||
      !id(record.typeID)||record.typeID!==ship.typeID||
      !Number.isSafeInteger(record.createdAtMs)||record.createdAtMs<=0||
      record.createdAtMs>wave.spawnedAtMs+2000||
      wave.spawnedAtMs-record.createdAtMs>120000||
      !c||c.entityID!==entityID||c.systemID!==systemID||
      c.runtimeKind!=="nativeCombat")return null;
   return {ship,c,wave,encounterKey:ownership.encounterKey};
  }
  // A previously ACKed native warp is not physical arrival. Require the same
  // source hull and live native attacker AFTER a long actual displacement.
  for(const [key,req] of requests){
   if(req.systemID!==systemID||req.phase!=="WARP_ACCEPTED")continue;
   const site=proof.sites.find(s=>s.instanceID===req.instanceID&&s.siteID===req.siteID);
   const helper=site&&defender(site,req.helperID),
     victim=site&&defender(site,req.victimID),enemy=player(req.targetID);
   const aggression=victim?.c,last=victim?.c?.lastAggressedAtMs;
   if(!helper||!victim||!enemy||aggression.lastAggressorID!==req.targetID||
      !Number.isSafeInteger(last)||last<=0||last>now||now-last>120000||
      now>req.at+180000){
    req.phase="ABORTED";continue;
   }
   if(inWarp(helper.ship)){req.sawWarp=true;continue;}
   if(now<req.at+10000||occupied(helper.c)||!pos(req.origin)||
      meters(helper.ship.position,req.origin)<=150000||
      meters(helper.ship.position,enemy.position)>200000||
      meters(victim.ship.position,enemy.position)>250000)continue;
   // The original physical warp ACK AND observed position change are required.
   req.phase="ATTACK_ISSUING";
   let out;
   try{out=attack(req.helperID,req.targetID,{allowWeapons:true,keepLock:true})}
   catch{out=null}
   req.phase=out?.success===true?"ATTACK_ACCEPTED":
     out?.success===false?"ATTACK_REJECTED":"OUTCOME_UNKNOWN";
   if(req.phase==="ATTACK_ACCEPTED"){
    result.attackOrders++;
    result.events.push({status:"NATIVE_REINFORCEMENT_ATTACK_ACK",systemID,
      instanceID:req.instanceID,siteID:req.siteID,helperID:req.helperID,
      targetID:req.targetID,sourceEncounterKey:req.sourceEncounterKey});
   }else if(req.phase==="OUTCOME_UNKNOWN"){
    result.events.push({status:"NATIVE_REINFORCEMENT_ATTACK_OUTCOME_UNKNOWN",
      systemID,instanceID:req.instanceID,siteID:req.siteID,helperID:req.helperID});
   }
  }
  // Only a distinct ALREADY SPAWNED authored encounter wave may dispatch a
  // physical same-site helper. Never call triggerSiteEncounter/spawnNpcBatch.
  for(const site of proof.sites){
   if(result.warpOrders>=2)break;
   const live=site.defenderIDs.map(entityID=>defender(site,entityID)).filter(Boolean);
   for(const victim of live){
    if(result.warpOrders>=2)break;
    const targetID=id(victim.c.lastAggressorID),at=victim.c.lastAggressedAtMs;
    if(!targetID||!Number.isSafeInteger(at)||at<=0||at>now||now-at>120000)continue;
    const enemy=player(targetID);
    if(!enemy||meters(victim.ship.position,enemy.position)>250000)continue;
    const helpers=live.filter(h=>h.ship.itemID!==victim.ship.itemID&&
      h.encounterKey!==victim.encounterKey&&
      h.ship.corporationID&&h.ship.corporationID===victim.ship.corporationID&&
      !occupied(h.c)&&!inWarp(h.ship)&&
      meters(h.ship.position,enemy.position)>250000&&
      meters(h.ship.position,enemy.position)<=2000000)
      .sort((a,b)=>meters(a.ship.position,enemy.position)-meters(b.ship.position,enemy.position));
    for(const helper of helpers){
     const helperID=helper.ship.itemID,key=site.instanceID+":"+helperID;
     if(requests.has(key))continue; // unknown outcomes are NEVER retried.
     if(requests.size>=maxPending){result.status="REQUEST_FENCE_CAP_REACHED";break;}
     const req={phase:"WARP_ISSUING",systemID,instanceID:site.instanceID,siteID:site.siteID,
      helperID,victimID:victim.ship.itemID,targetID,sourceEncounterKey:helper.encounterKey,
      origin:{...helper.ship.position},at:now,sawWarp:false};
     requests.set(key,req); // re-entrant native callbacks cannot issue twice
     let out;
     try{out=warpToEntity(helperID,targetID,
       {forceImmediateStart:true,broadcastWarpStartToVisibleSessions:true})}
     catch{out=null}
     req.phase=out?.success===true?"WARP_ACCEPTED":
       out?.success===false?"WARP_REJECTED":"OUTCOME_UNKNOWN";
     if(req.phase==="WARP_ACCEPTED"){
      result.warpOrders++;
      result.events.push({status:"NATIVE_REINFORCEMENT_WARP_ACK",systemID,
       instanceID:site.instanceID,siteID:site.siteID,helperID,targetID,
       sourceEncounterKey:helper.encounterKey});
     }else if(req.phase==="OUTCOME_UNKNOWN"){
      result.events.push({status:"NATIVE_REINFORCEMENT_WARP_OUTCOME_UNKNOWN",systemID,
       instanceID:site.instanceID,siteID:site.siteID,helperID});
     }
     break;
    }
   }
  }
  if(result.warpOrders||result.attackOrders)result.status="NATIVE_REINFORCEMENTS_ORDERED";
  else if(result.events.length)result.status="OUTCOME_UNKNOWN";
  else if(result.status==="NO_VALID_NATIVE_WAVES")result.status="OBSERVED_NATIVE_WAVES";
  for(const e of result.events)try{notify(e)}catch{}
  return result;
 }
 return {tick,snapshot:()=>[...requests].map(([key,value])=>({key,...value}))};
}
module.exports={createWaveReinforcements};
