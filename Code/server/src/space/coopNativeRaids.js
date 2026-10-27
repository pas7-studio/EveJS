"use strict";
// Organic native NPC raids: pirates target real ore-bearing mining ships.
// EveJS handles locking, damage, pursuit, aggression response and wrecks.
// No scripted kills, fake mining, arena bubbles or player-target selection.
const pos=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
// A loaded hauler is preferred over a loaded miner only within this slack of the
// nearest authorized hull, never across an entire solar system.
const HAULER_PREFERENCE_METERS=50000;
// A native order we issued is not a licence to hold a hull forever: an approach
// that never became a warp, or an attack that never acquired a native lock, is
// released after this long so the record has exactly one owner again.
const APPROACH_VERIFY_MS=20000;
const ATTACK_NO_LOCK_MS=90000;
const RELEASE_COOLDOWN_MS=120000;
const valid=p=>!!p&&["x","y","z"].every(k=>Number.isFinite(p[k]));
const range=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
// A hull is really warping only with a native warp state, never with mode GOTO:
// GOTO is the behaviour loop's own subwarp pursuit and it silently wins over an
// issued warp when the hull still holds its previous attack order.
const warping=e=>{const mode=String(e?.mode||"").toUpperCase();
 return mode==="WARP"||Boolean(e?.pendingWarp)||Boolean(e?.warpState)||
  e?.isWarping===true;};
const holdsAttack=c=>String(c?.manualOrder?.type||"").toLowerCase()==="attack";
function createRaids({warp,attack,release=null,clock=()=>Date.now(),cooldownMs=480000,
 approachVerifyMs=APPROACH_VERIFY_MS,attackNoLockMs=ATTACK_NO_LOCK_MS,
 releaseCooldownMs=RELEASE_COOLDOWN_MS,ensurePoint=null,preyScrambled=null,
 gunRange=null}){
 if(typeof warp!=="function"||typeof attack!=="function"||cooldownMs<60000)throw Error("invalid native raid API");
 if(release!==null&&typeof release!=="function")throw Error("invalid native raid release API");
 if(ensurePoint!==null&&typeof ensurePoint!=="function")throw Error("invalid native raid point API");
 if(preyScrambled!==null&&typeof preyScrambled!=="function")throw Error("invalid native raid scramble API");
 if(gunRange!==null&&typeof gunRange!=="function")throw Error("invalid native raid gun range API");
 const leases=new Map();
 // Per-hull throttle for a hull a live wreck claim owns: the stock behavior loop
 // re-acquires its own target after every release.
 const excludedReleasedAt=new Map();
 // One owner per record: only the director that issued an order may release it.
 function releaseOrder(pirateID,reason){
  if(!release)return {released:false,reason:"RELEASE_UNAVAILABLE"};
  let result;
  try{result=release(pirateID,reason);}
  catch(error){return {released:false,reason:"RELEASE_THREW:"+
   String(error&&error.message||error).slice(0,60)};}
  return {released:result?.success===true,reason,
   errorMsg:String(result?.errorMsg||"")};
 }
 function tick({systemID,scene,pirates=[],fleetShips=[],getCargo=()=>[],getController=()=>null,canAttack=()=>true}){
  if(!pos(systemID)||!scene?.getEntityByID)return {status:"SCENE_MISSING",actions:[]};
  const candidates=fleetShips.filter(t=>pos(t.id)&&["miner","hauler"].includes(t.role))
    .map(t=>{
      const ship=scene.getEntityByID(t.id);
      const ore=(getCargo(t.id)||[]).filter(x=>Number(x?.moduleID||0)===0)
       .reduce((n,x)=>n+Math.max(0,Number(x.quantity)||0),0);
      return {...t,ship,ore};
    })
    // A hull in an active warp is not a legal combat target and cannot be caught:
    // chasing it just drags the pirate across the system and beyond its native
    // leash, where the behavior loop clears its combat state. Wait for real prey.
    .filter(t=>t.ship&&t.ore>0&&valid(t.ship.position)&&
     !String(t.ship.mode||"").toUpperCase().includes("WARP")&&
     !t.ship.pendingWarp&&!t.ship.warpState);
  const actions=[];
  // A prey that really reads back as warp-scrambled cannot leave the fight, so
  // its attack order is never released for "no native lock": the lock is exactly
  // what the next weapon cycle acquires. Releasing it is what let shield
  // regeneration win (measured 146.45 -> 225.00 over 5 minutes, 0 wrecks).
  const pinned=targetID=>{
   if(typeof preyScrambled!=="function")return false;
   const id=pos(targetID);
   if(!id)return false;
   try{return preyScrambled(id)===true;}catch(_error){return false;}
  };
  for(const rawID of pirates){
   const id=pos(rawID),ship=id&&scene.getEntityByID(id);
   if(!ship||!valid(ship.position)||String(ship.mode||"").includes("WARP"))continue;
   const key=systemID+":"+id,old=leases.get(key),now=clock();
   if(old&&now<old.nextAt&&scene.getEntityByID(old.targetID))continue;
   const controller=getController(id);
   const activeTarget=pos(controller?.currentTargetID);
   const manual=controller?.manualOrder;
   const manualTarget=pos(manual?.targetID);
   const ownedTarget=old&&pos(old.targetID)?scene.getEntityByID(old.targetID):null;
   const issuedAt=Number(old?.issuedAtMs)||0;
   let pendingRelease=null;
   // An approach that never became a real warp: the native pursuit movement
   // (GOTO) overrode it, so the prey is still across the system. Release our own
   // order instead of re-issuing the same unexecutable command, which is what
   // kept the target fleet in "aggressed" with an empty response wing.
   if(old?.phase==="warp-to-hauler"&&ownedTarget&&valid(ownedTarget.position)&&
      issuedAt>0&&now>=issuedAt+approachVerifyMs&&
      range(ship.position,ownedTarget.position)>250000&&!warping(ship)){
    const released=releaseOrder(id,"APPROACH_NOT_WARPING");
    leases.set(key,{nextAt:now+releaseCooldownMs,targetID:Number(old.targetID),
     targetRole:String(old.targetRole||""),phase:"released",issuedAtMs:now});
    actions.push({pirateID:id,targetID:Number(old.targetID),
     targetRole:String(old.targetRole||""),action:"approach-unflyable",
     distanceMeters:range(ship.position,ownedTarget.position),...released});
    continue;
   }
   // A live native player battle or somebody else's explicit NPC command
   // always takes priority. A passive currentTargetID is NOT proof that
   // our prior warp-to-miner approach has become a weapon attack.
   const playerShipIDs=new Set(Array.from(scene.sessions?.values?.()||[])
     .map(s=>pos(s?._space?.shipID)).filter(Boolean));
   const ownedApproach=old?.phase==="warp-to-hauler"&&
    old.targetID===activeTarget&&Boolean(scene.getEntityByID(activeTarget));
   if(activeTarget&&scene.getEntityByID(activeTarget)){
    // Never steal a naturally acquired native target. Only the target
    // of OUR unfinished warp lease may be promoted to a weapon attack.
    if(!ownedApproach){
     // Our own attack order on a prey that sits beyond the same 250 km boundary
     // the approach uses cannot fire (a turret or missile never reaches 2.5 AU).
     // Release it and re-issue the approach as a real warp in the same tick:
     // releasing alone would send the hull home and end the engagement.
     if(holdsAttack(controller)&&old&&issuedAt>0&&
        Number(old.targetID)===activeTarget){
      const prey=scene.getEntityByID(activeTarget);
      const gap=prey&&valid(prey.position)?range(ship.position,prey.position):Infinity;
      // Beyond the same 250 km boundary the approach uses a turret can never
      // reach: release and re-approach on this re-check. Closer prey keeps its
      // lock window instead (a real warp point needs time to acquire a lock).
      if(gap>250000){
       pendingRelease=releaseOrder(id,"FOR_APPROACH");
       if(!pendingRelease.released){
        actions.push({pirateID:id,targetID:activeTarget,
         targetRole:String(old.targetRole||""),action:"attack-unreachable",
         distanceMeters:gap,...pendingRelease});
        continue;
       }
      }
     }
     if(!pendingRelease)continue;
    }
    if(playerShipIDs.has(activeTarget))continue;
    if(!pendingRelease&&manual?.type==="attack"&&manualTarget===activeTarget)continue;
    if(!pendingRelease&&manual&&manual.type!=="resumeBehavior"&&
      (!ownedApproach||manual.type!=="warp"))continue;
    // Keep native unsolicited combat/retaliation from being hijacked.
    const aggroAt=Number(controller?.lastAggressedAtMs);
    if(Number.isFinite(aggroAt)&&aggroAt>0&&now>=aggroAt&&
      now-aggroAt<120000)continue;
   }else if(manual&&manual.type!=="resumeBehavior"&&
      !(old?.phase==="warp-to-hauler"&&manual.type==="warp")){
    // Our own previous order is still pinned on the hull (manual attack and the
    // native controller never acquired a lock, so currentTargetID stays 0). It is
    // not a rival order: it is ours. One owner per record - release it and decide
    // fresh this tick instead of leaving the hull in an endless GOTO, which is
    // what kept the convoy in "aggressed" with an empty response wing.
    if(!(holdsAttack(controller)&&old&&issuedAt>0))continue;
    const stillFar=ownedTarget&&valid(ownedTarget.position)&&
     range(ship.position,ownedTarget.position)>250000;
    // A near target keeps its attack order for a fair lock window; only then is
    // an order that never acquired a native lock released.
    if(!stillFar&&now<issuedAt+attackNoLockMs)continue;
    if(!stillFar&&pinned(old.targetID)){
     // Held by a real warp point: the prey cannot warp away, the next weapon
     // cycle re-acquires the lock, so the order stays ours instead of being
     // released and re-issued every 90 s.
     leases.set(key,{...old,nextAt:now+15000});
     continue;
    }
    pendingRelease=releaseOrder(id,stillFar?"FOR_APPROACH":"ATTACK_NO_NATIVE_LOCK");
    if(!stillFar){
     leases.set(key,{nextAt:now+releaseCooldownMs,targetID:Number(old.targetID),
      targetRole:String(old.targetRole||""),phase:"released",issuedAtMs:now});
     actions.push({pirateID:id,targetID:Number(old.targetID),
      targetRole:String(old.targetRole||""),action:"attack-no-lock",
      distanceMeters:ownedTarget&&valid(ownedTarget.position)?
       range(ship.position,ownedTarget.position):null,...pendingRelease});
     continue;
    }
    // A release that was refused leaves the order in place: re-tasking would
    // collide with it, so report the exact refusal and stay idle.
    if(!pendingRelease.released){
     actions.push({pirateID:id,targetID:Number(old.targetID),
      targetRole:String(old.targetRole||""),action:"approach-unflyable",
      distanceMeters:range(ship.position,ownedTarget.position),...pendingRelease});
     continue;
    }
    // Released for the approach: fall through and issue the warp below.
   }

   // After an approach, prefer the very same *still authorized* hull.
   // The convoy may move, but the raid should not silently target-hop.
   const authorized=candidates.filter(x=>x.id!==id&&
    canAttack({systemID,pirateID:id,targetID:x.id}));
   // A loaded hauler is the better prize ONLY when it is really here. Sorting by
   // role first sent pirates after a hauler that was 4.4e11 m away (a stuck fleet
   // position) while a loaded miner sat 39 km away - and every hull beyond the
   // native leash is pulled home with its combat state cleared, so the raid could
   // never fire. Distance decides; the role only breaks a near tie.
   const nearestFirst=authorized.slice().sort((a,b)=>
    range(ship.position,a.ship.position)-range(ship.position,b.ship.position)||
    (b.role==="hauler"?1:0)-(a.role==="hauler"?1:0)||
    Number(a.id)-Number(b.id));
   const nearestDistance=nearestFirst.length?range(ship.position,nearestFirst[0].ship.position):Infinity;
   const preferredHauler=nearestFirst.find(x=>x.role==="hauler"&&
    range(ship.position,x.ship.position)<=nearestDistance+HAULER_PREFERENCE_METERS);
   const target=authorized.find(x=>old?.phase==="warp-to-hauler"&&
    x.id===old.targetID)||preferredHauler||nearestFirst[0];
   if(!target)continue;
   const distance=range(ship.position,target.ship.position);
   let result,action,released=pendingRelease,gun=null;
   if(distance>250000){
    // One owner per record: the hull's own previous attack order is released
    // BEFORE the approach. While it stands, the native behaviour loop keeps
    // flying its own subwarp pursuit (mode GOTO) and the issued warp is not the
    // command that moves the ship, so the approach never really flies.
    if(!released&&holdsAttack(controller)&&(old?.phase==="attack"||manualTarget===target.id))
     released=releaseOrder(id,"FOR_APPROACH");
    result=warp(id,target.id,{forceImmediateStart:true,distanceMeters:distance});
    action="warp-to-hauler";
   }else{
    // The hull fights with the range its own fitted weapon really has. A raider
    // parked at its behaviour profile's distance (measured: a blaster cruiser
    // holding an attack order at 9 km and at 2.5 AU) can never hit with a gun
    // whose own maxRange is a few kilometres, so the attack order carries the
    // gun's own range as the hull's engagement distance: the stock loop then
    // orbits at exactly that distance with weapons on. The number comes from the
    // module/charge dogma the stock resolver reads, never from a constant here.
    // A standalone manual `orbit` order is NOT used: it is not an attack intent,
    // so the native NPC hostility invariant treats the prey as friendly and the
    // loop clears the target (measured live: mode STOP, currentTargetID 0).
    if(typeof gunRange==="function"){
     try{gun=gunRange(ship)||null;}catch(_error){gun=null;}
    }
    const optimal=Number(gun&&gun.meters)||0;
    result=attack(id,target.id,{allowWeapons:true,keepLock:true,distanceMeters:distance,
     ...(optimal>0?{engagementRangeMeters:optimal}:{})});
    action="attack";
   }
   // A close attack is also where the real warp point is fitted and engaged: a
   // raider that cannot stop its prey from warping 2.5 AU out of range can never
   // convert fire into a wreck. The outcome is reported with the action, refusal
   // included, so "the prey still escaped" is a measured reason.
   let warpPoint=null;
   if(action==="attack"&&result?.success===true&&typeof ensurePoint==="function"){
    try{warpPoint=ensurePoint({pirateID:id,targetID:target.id,distanceMeters:distance})||null;}
    catch(error){warpPoint={status:"REFUSED",reason:"ENSURE_POINT_THREW:"+
     String(error&&error.message||error).slice(0,60)};}
   }
   // Warping to the convoy is only the approach, not the raid itself:
   // reevaluate soon after landing and issue a genuine weapon attack. An attack
   // lease is re-checked every minute too: the prey can warp 2.5 AU away, and an
   // order that can no longer fire must be released, not held for eight minutes.
   const retryMs=result?.success===true?
    (action==="attack"?Math.min(cooldownMs,60000):15000):60000;
   leases.set(key,{nextAt:now+retryMs,targetID:target.id,targetRole:target.role,
    phase:action,issuedAtMs:now,engagementRangeMeters:Number(gun&&gun.meters)||0});
   if(result?.success===true)actions.push({pirateID:id,targetID:target.id,
    targetRole:target.role,action,distanceMeters:distance,
    ...(gun?{gunRange:gun}:{}),...(released||{}),...(warpPoint?{warpPoint}:{})});
   // A refused native warp used to be silent: the lease was recorded as an
   // approach and 20 s later the hull was released as "not warping", which hid
   // the real reason (a warp the runtime declined). Publish the refusal verbatim.
   else actions.push({pirateID:id,targetID:target.id,targetRole:target.role,
    action:action+"-refused",distanceMeters:distance,
    errorMsg:String(result?.errorMsg||result?.status||""),
    ...(gun?{gunRange:gun}:{}),...(released||{})});
  }
  return {status:"OK",eligibleTargetCount:candidates.length,actions};
 }
 // A hull that a live wreck claim now owns must leave the raid: its lease and
 // its own native order are released here, by the director that issued them
 // (one owner per record). Nothing is released for a hull this director never
 // leased, and a rival owner is never overridden - the order bridge decides.
 function releaseExcluded(ids=[],reason="WRECK_CLAIM_OWNS_HULL",options={}){
  const released=[],force=options?.force===true;
  for(const raw of Array.isArray(ids)?ids:[]){
   const id=pos(raw);
   if(!id)continue;
   const now=clock();
   // The stock behavior loop re-acquires its own target after a release, so a
   // hull whose wreck claim is live is released again, at most every 15 s.
   if(!force&&now-(excludedReleasedAt.get(id)||0)<15000)continue;
   excludedReleasedAt.set(id,now);
   const leaseKey=[...leases.keys()].find(key=>Number(key.split(":")[1])===id);
   const lease=leaseKey?leases.get(leaseKey):null;
   const outcome=releaseOrder(id,reason);
   const targetID=Number(lease?.targetID)||0;
   if(leaseKey)leases.set(leaseKey,{nextAt:now+releaseCooldownMs,targetID,
    targetRole:String(lease?.targetRole||""),phase:"released",issuedAtMs:now});
   released.push({pirateID:id,reason,leaseTargetID:targetID,...outcome});
  }
  return released;
 }
 function activePirateIDs(sceneForSystem){
  const active=new Set();
  const now=clock();
  for(const [key,lease] of leases){
   if(lease.nextAt<=now||lease.phase==="released")continue;
   const [system,id]=key.split(":").map(Number);
   const scene=sceneForSystem(system);
   if(scene?.getEntityByID?.(id)&&scene.getEntityByID(lease.targetID))active.add(id);
  }
  return active;
 }
 return {tick,activePirateIDs,releaseExcluded,snapshot:()=>Array.from(leases,([id,value])=>({id,...value}))};
}
module.exports={createRaids};
