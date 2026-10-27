"use strict";
// Living Universe tactics: issue genuine EveJS orders to already-living NPCs.
// No NPC spawning, fake HP changes, scripted kills or imaginary warp positions.
const positive=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const pos=x=>x&&["x","y","z"].every(k=>Number.isFinite(Number(x[k])));
const meters=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
const inWarp=ship=>String(ship?.mode||"").toUpperCase().includes("WARP")||
 Boolean(ship?.pendingWarp||ship?.warpState||ship?.isWarping);

function createTactics({
 clock=()=>Date.now(),warpToPoint,warpToEntity,attack,resumeBehavior,stopOrder,
 maxResponders=2,callCooldownMs=120000,retreatCooldownMs=300000,
 authorizePlayerDefense=()=>false,aggressionFor=()=>null,notify=()=>{}
}){
 if([warpToPoint,warpToEntity,attack,resumeBehavior,stopOrder].some(x=>typeof x!=="function")||
  !Number.isInteger(maxResponders)||maxResponders<1||maxResponders>3||
  typeof authorizePlayerDefense!=="function"||
  callCooldownMs<30000||retreatCooldownMs<60000)throw Error("invalid native NPC tactics");
 const calls=new Map(),retreats=new Map(),retreatCooldowns=new Map(),responses=new Map();
 const fresh=(id,map,ms)=>!map.has(id)||clock()-map.get(id)>=ms;
 function tick({systemID,scene,assignments=[],controllers={},health,waypoints=[],isScrambled=()=>false,additionalResponders=()=>0}={}){
  const system=positive(systemID);
  if(!system||Number(scene?.systemID)!==system||
     typeof scene?.getEntityByID!=="function"||typeof health!=="function"||
     !Array.isArray(assignments)||!controllers||typeof controllers!=="object")
   return {status:"NO_NATIVE_SCENE",events:[],engagedIDs:[]};
  const now=clock(),events=[],present=new Map();
  if(!Number.isSafeInteger(now)||now<0)return {status:"INVALID_CLOCK",events:[],engagedIDs:[]};
  const pilotCounts=new Map(),entityCounts=new Map();
  for(const a of assignments){
   if(named(a?.pilotID))pilotCounts.set(a.pilotID,(pilotCounts.get(a.pilotID)||0)+1);
   if(positive(a?.entityID))entityCounts.set(Number(a.entityID),(entityCounts.get(Number(a.entityID))||0)+1);
  }
  const sessions=[...(scene.sessions?.values?.()||[])];
  const playerShips=new Map();
  for(const session of sessions){
   const id=positive(session?._space?.shipID);
   if(!id||!positive(session?.characterID)||session?._space?.initialStateSent!==true||
      session?.socket?.destroyed===true||Number(session?._space?.systemID)!==system)continue;
   if(!playerShips.has(id))playerShips.set(id,[]);
   playerShips.get(id).push(session);
  }
  function nativeController(id){
   const c=controllers[id];
   return c&&Number(c.entityID)===id&&Number(c.systemID)===system?c:null;
  }
  for(const a of assignments){
   const id=positive(a?.entityID),ship=id&&scene.getEntityByID(id);
   if(!id||!named(a?.pilotID)||pilotCounts.get(a.pilotID)!==1||
      entityCounts.get(id)!==1||Number(a.systemID)!==system||
      typeof a.faction!=="string"||!a.faction||
      !ship||ship.kind!=="ship"||ship.nativeNpc!==true||
      Number(ship.itemID)!==id||ship.session?.characterID||playerShips.has(id)||
      !pos(ship.position)||!nativeController(id)||
      (positive(ship.systemID)&&Number(ship.systemID)!==system))continue;
   present.set(id,{...a,entityID:id,ship});
  }
  function attackerContext(id){
   const ship=id&&scene.getEntityByID(id);
   if(!id||!ship||Number(ship.itemID)!==id||ship.kind!=="ship"||
      !pos(ship.position)||(positive(ship.systemID)&&Number(ship.systemID)!==system))return null;
   if(ship.nativeNpc===true&&(!ship.session?.characterID)&&!playerShips.has(id))
    return {ship,kind:"npc"};
   const holders=playerShips.get(id)||[];
   if(ship.nativeNpc!==true&&holders.length===1&&
      Number(ship.pilotCharacterID||ship.characterID||holders[0].characterID)===
       Number(holders[0].characterID))return {ship,kind:"player",session:holders[0]};
   return null;
  }
  function canReinforce(victim,helper,attackerID,attacker){
   const context=attackerContext(attackerID);
   if(!context||context.ship!==attacker||!present.has(helper.entityID)||
      !nativeController(helper.entityID)||inWarp(helper.ship))return false;
   const attackerLink=present.get(attackerID);
   if(attackerLink?.faction===helper.faction)return false;
   if(context.kind==="player"){
    try{return authorizePlayerDefense({systemID:system,scene,
      victim: victim?.ship,helper:helper.ship,attacker,
      session:context.session,witnessedAggression:witnessedFor(victim)})===true;}catch(_error){return false;}
   }
   return true;
  }
  // The last VERIFIED player attack on this exact victim, if any. It only fills
  // the gap when the native controller did not record an aggressor.
  function witnessedFor(victim){
   try{return aggressionFor({systemID:system,victimEntityID:Number(victim?.entityID),nowMs:now})||null}
   catch(_error){return null}
  }
  const engaged=new Set();
  // The true EveJS warp must finish before the NPC can stand down.
  // Holding after arrival avoids immediate suicidal re-engagement.
  for(const [id,state] of retreats){
   if(state.systemID!==system)continue;
   const ship=present.get(id)?.ship;
   if(!ship||ship!==state.shipRef){retreats.delete(id);continue;}
   const warping=inWarp(ship);
   if(warping)state.sawWarp=true;
   // Native ACK is not warp arrival. We require the SAME physical hull at
   // the real intended station/gate position before stopping its controller.
   const arrived=!warping&&pos(ship.position)&&
      meters(ship.position,state.destination)<=100000&&
      meters(state.origin,state.destination)>150000;
   if(state.phase==="warping"&&arrived&&now>=state.at+10000){
    const stopped=stopOrder(id);
    if(stopped?.success){
     state.phase="holding";state.holdUntil=now+90000;
     events.push({kind:"npc-tactical-standdown",systemID:system,entityID:id});
    }
   }
   if(state.phase==="holding"&&now>=state.holdUntil){
    const resumed=resumeBehavior(id);
    if(resumed?.success){
     retreats.delete(id);
     events.push({kind:"npc-tactical-recovered",systemID:system,entityID:id});
    }
   }
   if(retreats.has(id))engaged.add(id);
  }
  // Continue a previous rescue after physical warp-in. Do not duplicate
  // a warp or assign another target to the same rescue ship.
  for(const [id,aid] of responses){
   if(aid.systemID!==system)continue;
   const helper=present.get(id),target=scene.getEntityByID(aid.attackerID);
   const victim=present.get(aid.victimID);
   if(!helper||helper.ship!==aid.helperRef||!victim||
      victim.ship!==aid.victimRef||target!==aid.attackerRef||
      !canReinforce(victim,helper,aid.attackerID,target)||now>=aid.expiresAt){
    // Do not clear an unrelated order if authority was lost or the target ID
    // was recycled. Another director may own the ship now.
    responses.delete(id);continue;
   }
   engaged.add(id);
   if(!pos(helper.ship.position)||!pos(target.position)||inWarp(helper.ship))continue;
   if(meters(helper.ship.position,target.position)>250000){
    if(now>=aid.nextAt){
     const result=warpToEntity(id,aid.attackerID,{forceImmediateStart:true,broadcastWarpStartToVisibleSessions:true});
     aid.nextAt=now+(result?.success?30000:60000);
     if(result?.success)events.push({kind:"reinforcement-warp",systemID:system,responderID:id,targetID:aid.attackerID,victimID:aid.victimID});
    }
   }else if(aid.phase!=="attack"&&now>=aid.nextAt){
    const result=attack(id,aid.attackerID,{allowWeapons:true,keepLock:true});
    aid.nextAt=now+(result?.success?120000:30000);
    if(result?.success){
     aid.phase="attack";
     events.push({kind:"reinforcement-attack",systemID:system,responderID:id,targetID:aid.attackerID,victimID:aid.victimID});
    }
   }
  }
  let rescueCalls=0;
  for(const victim of present.values()){
   const c=nativeController(victim.entityID);
   if(!c||retreats.has(victim.entityID))continue;
   // A native controller does not always record a player aggressor. The damage
   // witness fills exactly that gap and nothing else: same victim, same system,
   // verified session, fresh window.
   const witnessed=witnessedFor(victim),nativeAggressor=positive(c.lastAggressorID);
   const attackerID=nativeAggressor||positive(witnessed?.attackerShipID),source=attackerContext(attackerID);
   const attacker=source?.ship;
   const aggroAt=Number(c.lastAggressedAtMs)||Number(witnessed?.atMs)||0;
   if(attacker&&attackerID&&!nativeAggressor&&witnessed)
    events.push({kind:"npc-defence-from-witness",systemID:system,entityID:victim.entityID,
     attackerID,characterID:witnessed.characterID});
   if(!attacker||!attackerID||aggroAt<=0||now-aggroAt>120000||aggroAt>now)continue;
   const allyAttacker=present.get(attackerID);
   if(allyAttacker&&allyAttacker.faction===victim.faction)continue;
   const ratio=health(victim.ship);
   const danger=ratio&&Number.isFinite(ratio.armor)&&Number.isFinite(ratio.structure)&&
     (ratio.structure<0.72||ratio.armor<0.28);
   // Retreat to a REAL station or stargate that is far from the attacker.
   // On scramble or no suitable anchor, keep native combat running.
   if(danger&&!isScrambled(victim.ship)&&!engaged.has(victim.entityID)&&
     fresh(victim.entityID,retreatCooldowns,retreatCooldownMs)&&pos(attacker.position)){
    const safe=waypoints.filter(p=>["station","stargate"].includes(p.kind)&&
      pos(p.position)&&meters(p.position,attacker.position)>500000)
      .sort((a,b)=>meters(b.position,attacker.position)-meters(a.position,attacker.position))[0];
    if(safe&&meters(victim.ship.position,safe.position)>150000&&!inWarp(victim.ship)){
     const result=warpToPoint(victim.entityID,safe.position,{
      forceImmediateStart:true,broadcastWarpStartToVisibleSessions:true});
     if(result?.success){
      retreatCooldowns.set(victim.entityID,now);
      retreats.set(victim.entityID,{at:now,systemID:system,phase:"warping",holdUntil:0,
       shipRef:victim.ship,origin:{...victim.ship.position},
       destination:{...safe.position},sawWarp:false});
      engaged.add(victim.entityID);
      events.push({kind:"npc-retreat",systemID:system,entityID:victim.entityID,
       pilotID:victim.pilotID,attackerID,destinationID:safe.id});
     }
    }
   }
   // Same-faction escorts defend actual victims. Pirates help pirates;
   // security patrols defend miners, haulers and traders.
   const key=system+":"+victim.entityID+":"+attackerID;
   if(rescueCalls>=2||!fresh(key,calls,callCooldownMs))continue;
   // A documented repeat aggressor may draw ONE additional existing patrol;
   // never spawn a defender or override EveJS's native combat and warp.
   let bonus=0;
   try{bonus=additionalResponders(victim,attackerID,scene)===1?1:0;}catch(error){console.warn("[CoopNpcTactics] memory lookup",error.message);}
   const helpers=[...present.values()].filter(helper=>{
    if(helper.entityID===victim.entityID||helper.entityID===attackerID||
      helper.faction!==victim.faction||engaged.has(helper.entityID)||responses.has(helper.entityID))return false;
    if(victim.role==="pirate")return helper.role==="pirate";
    return helper.role==="patrol";
   }).filter(helper=>{
     const hc=nativeController(helper.entityID);
     const manual=String(hc?.manualOrder?.type||"").toLowerCase();
     return !!hc&&!positive(hc.currentTargetID)&&
      (!manual||manual==="resumebehavior")&&
      !(positive(hc.lastAggressorID)&&
        now-(Number(hc.lastAggressedAtMs)||0)<120000)&&
      pos(helper.ship.position)&&pos(attacker.position)&&
      canReinforce(victim,helper,attackerID,attacker);
   })
     .sort((a,b)=>meters(a.ship.position,attacker.position)-meters(b.ship.position,attacker.position))
     .slice(0,Math.min(3,maxResponders+bonus));
   let mobilized=0;
   for(const helper of helpers){
    const far=meters(helper.ship.position,attacker.position)>250000;
    const action=far
     ?warpToEntity(helper.entityID,attackerID,{forceImmediateStart:true,broadcastWarpStartToVisibleSessions:true})
     :attack(helper.entityID,attackerID,{allowWeapons:true,keepLock:true});
    if(action?.success!==true)continue;
    responses.set(helper.entityID,{systemID:system,victimID:victim.entityID,
     attackerID,helperRef:helper.ship,victimRef:victim.ship,attackerRef:attacker,
     expiresAt:now+180000,nextAt:now+(far?30000:120000),
     phase:far?"approach":"attack"});
    engaged.add(helper.entityID);mobilized++;
    events.push({kind:far?"reinforcement-warp":"reinforcement-attack",systemID:system,
     responderID:helper.entityID,victimID:victim.entityID,targetID:attackerID});
   }
   if(mobilized){
    calls.set(key,now);
    rescueCalls++;
    events.push({kind:"npc-help-request",systemID:system,entityID:victim.entityID,
     pilotID:victim.pilotID,attackerID,responders:mobilized});
   }
  }
  // Bound process-local incident memory on busy long-running worlds.
  if(calls.size>1000)for(const [key,time] of calls)if(now-time>callCooldownMs)calls.delete(key);
  if(retreatCooldowns.size>1000)for(const [key,time] of retreatCooldowns)if(now-time>retreatCooldownMs)retreatCooldowns.delete(key);
  for(const e of events)try{notify(e);}catch(error){console.warn("[CoopNpcTactics] notify",error.message);}
  return {status:"OK",events,engagedIDs:[...engaged]};
 }
 function activeIDs(){return new Set(
  [...responses.keys()].filter(id=>responses.get(id).expiresAt>clock())
   .concat([...retreats.keys()])
 );}
 return {tick,activeIDs,snapshot:()=>({
  rescuers:[...responses].map(([id,s])=>({entityID:id,systemID:s.systemID,
   victimID:s.victimID,attackerID:s.attackerID,phase:s.phase,
   nextAt:s.nextAt,expiresAt:s.expiresAt})),
  retreats:[...retreats].map(([id,s])=>({entityID:id,systemID:s.systemID,
   at:s.at,phase:s.phase,holdUntil:s.holdUntil,sawWarp:s.sawWarp}))
 })};
}
module.exports={createTactics};
