"use strict";
// PVE-004A: a source-authored, already spawned UNIQUE boss; original NPC
// combat, death, wreck and loot are authoritative. No spawns/item grants.
const {siteEntries}=require("./coopPveNativeSiteDefense");
const id=n=>Number.isSafeInteger(n)&&n>0?n:null;
const point=p=>p&&["x","y","z"].every(k=>Number.isFinite(p[k]));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const occupied=c=>Boolean(c?.currentTargetID)||
 Boolean(c?.manualOrder?.type)&&
 String(c.manualOrder.type).toLowerCase()!=="resumebehavior";
const phaseFor=h=>h<=.3?"LAST_STAND":h<=.65?"PRESSURE":"GUARD";
const BOSS_TAGS=new Set(["boss","overseer","officer","commander"]);
function explicitBoss(wave){
 const tags=Array.isArray(wave?.lootTags)?wave.lootTags:[];
 return tags.some(t=>typeof t==="string"&&BOSS_TAGS.has(t.toLowerCase().trim()))||
  /(?:^|[^a-z])(overseer|officer|boss)(?:$|[^a-z])/i.test(String(wave?.label||""));
}
function createNativeBossDirector({clock=()=>Date.now(),getNativeEntity,getController,
 resolveVerifiedPlayer,getHealth,issueAttack,listWrecks,listWreckItems,notify=()=>{},
 maxTracked=512}={}){
 if([clock,getNativeEntity,getController,resolveVerifiedPlayer,getHealth,
  issueAttack,listWrecks,listWreckItems,notify].some(f=>typeof f!=="function")||
  !Number.isSafeInteger(maxTracked)||maxTracked<1||maxTracked>4096)
  throw Error("INVALID_NATIVE_BOSS_DIRECTOR");
 const seen=new Map(),orders=new Map();
 function tick({systemID,scene,instances=[],excludedIDs=[]}={}){
  const now=clock(),out={status:"NO_AUTHORED_BOSS",bosses:0,orders:0,
   wrecksVerified:0,itemsVerified:0,events:[]};
  if(!id(systemID)||!Number.isSafeInteger(now)||now<=0||
    scene?.systemID!==systemID||typeof scene.getEntityByID!=="function"||
    !(scene.sessions instanceof Map)||!Array.isArray(instances)||
    !Array.isArray(excludedIDs)||excludedIDs.length>1024)
   return {...out,status:"INVALID_NATIVE_CONTEXT"};
  if(seen.size>=maxTracked||orders.size>=maxTracked*2)
   return {...out,status:"BOSS_RECEIPT_CAP_REACHED"};
  const authority=siteEntries(systemID,scene,instances);
  if(authority.status!=="OK")return {...out,status:authority.status};
  const excluded=new Set(excludedIDs);
  const sessions=[...scene.sessions.values()].filter(s=>s?.socket&&
   s.socket.destroyed!==true&&s?._space?.initialStateSent===true&&
   s._space.systemID===systemID&&id(s.characterID));
  function player(attackerID){
   const ship=id(attackerID)&&scene.getEntityByID(attackerID);
   if(!ship||ship.kind!=="ship"||ship.itemID!==attackerID||
      ship.nativeNpc===true||!point(ship.position))return null;
   const holders=sessions.filter(s=>s._space.shipID===attackerID);
   if(holders.length!==1||sessions.filter(s=>s.characterID===holders[0].characterID).length!==1)
    return null;
   try{if(resolveVerifiedPlayer(scene,ship)!==holders[0].characterID)return null}
   catch{return null}
   return ship;
  }
  const candidates=[];
  for(const site of authority.sites){
   const instance=instances.find(x=>x?.instanceID===site.instanceID);
   const waves=instance?.spawnState?.encounterStatesByKey||{};
   for(const [key,wave] of Object.entries(waves)){
    if(!key||!explicitBoss(wave)||!id(wave?.spawnedAtMs)||
       !Array.isArray(wave.spawnedEntityIDs)||wave.spawnedEntityIDs.length>96)continue;
    // A label for a GROUP is not authority to arbitrarily pick one member.
    // Only a single physical native ship in a boss-tagged original wave qualifies.
    const authenticated=[];
    let ambiguous=false;
    for(const entityID of wave.spawnedEntityIDs){
     if(!id(entityID)){ambiguous=true;break}
     const ownership=authority.owners.get(entityID);
     if(ownership?.length!==1||ownership[0].site!==site||
        ownership[0].encounterKey!==key){ambiguous=true;break}
     const ship=scene.getEntityByID(entityID);
     if(ship?.kind==="ship"){
      if(ship.nativeNpc!==true){ambiguous=true;break}
      authenticated.push({entityID,ship});
     }
    }
    if(ambiguous||authenticated.length!==1){
     // An original destroyed boss may have NO live ship. Its original
     // encounter key is still useful only for a previous native witness.
     const hist=seen.get(site.instanceID+":"+key);
     if(hist&&authenticated.length===0&&hist.systemID===systemID)
      candidates.push({site,key,wave,history:hist});
     continue;
    }
    const {entityID,ship}=authenticated[0];
    if(excluded.has(entityID))continue;
    const original=getNativeEntity(entityID),controller=getController(entityID);
    if(ship.itemID!==entityID||ship.session?.characterID||
       (id(ship.systemID)&&ship.systemID!==systemID)||!point(ship.position)||
       !original||original.entityID!==entityID||original.systemID!==systemID||
       original.nativeNpc!==true||original.transient!==true||
       original.typeID!==ship.typeID||!id(original.typeID)||
       !id(original.corporationID)||original.corporationID!==ship.corporationID||
       !Number.isSafeInteger(original.createdAtMs)||original.createdAtMs<=0||
       original.createdAtMs>wave.spawnedAtMs+2000||
       wave.spawnedAtMs-original.createdAtMs>120000||
       !controller||controller.entityID!==entityID||controller.systemID!==systemID||
       controller.runtimeKind!=="nativeCombat")continue;
    let health=null;
    try{health=getHealth(ship)}catch{}
    if(!health||!Number.isFinite(health.shield)||!Number.isFinite(health.armor)||
       !Number.isFinite(health.structure)||[health.shield,health.armor,health.structure]
        .some(v=>v<0||v>1))continue;
    const ratio=Math.min(health.armor,health.structure);
    const historyKey=site.instanceID+":"+key;
    let history=seen.get(historyKey);
    if(history&&(history.entityID!==entityID||history.typeID!==ship.typeID||
        history.bornAtMs!==original.createdAtMs||
        history.profileID!==(original.profileID||null)||
        history.lootTableID!==(original.lootTableID||null)))continue; // no recycled hull
    if(!history){
     history={systemID,instanceID:site.instanceID,siteID:site.siteID,
      encounterKey:key,entityID,typeID:ship.typeID,bornAtMs:original.createdAtMs,
      profileID:original.profileID||null,lootTableID:original.lootTableID||null,
      spawnedAtMs:wave.spawnedAtMs,peakPhase:0,wreckVerified:false};
     seen.set(historyKey,history);
    }
    candidates.push({site,key,wave,ship,controller,health,history});
   }
  }
  // An original dungeon may complete and leave listActiveInstances
  // immediately after the boss dies. Preserve the ALREADY VERIFIED live
  // native boss's identity for observational wreck reconciliation only.
  // This cannot admit an unwitnessed boss after process restart.
  const queued=new Set(candidates.map(c=>c.history));
  for(const history of seen.values())
   if(history.systemID===systemID&&!queued.has(history)&&!history.wreckVerified)
    candidates.push({history});
  if(!candidates.length)return out;
  let wrecks=null;
  for(const cand of candidates){
   const hist=cand.history;
   if(!cand.ship){
    if(hist.wreckVerified)continue;
    if(getNativeEntity(hist.entityID)||scene.getEntityByID(hist.entityID))continue;
    if(wrecks===null){
     try{wrecks=listWrecks()}catch{wrecks=[]}
     if(!Array.isArray(wrecks)||wrecks.length>10000)return {...out,
      status:"INVALID_NATIVE_WRECK_SOURCE"};
    }
    const matching=wrecks.filter(w=>w?.sourceEntityID===hist.entityID&&
     w.systemID===systemID&&w.launcherID===hist.entityID&&
     w.sourceTypeID===hist.typeID&&w.transient===true&&
     (!hist.profileID||w.profileID===hist.profileID)&&
     (!hist.lootTableID||w.lootTableID===hist.lootTableID)&&
     id(w.wreckID)&&Number.isSafeInteger(w.createdAtMs)&&
     w.createdAtMs>=hist.spawnedAtMs);
    if(matching.length!==1){
     if(matching.length>1)out.events.push({status:"BOSS_WRECK_SOURCE_AMBIGUOUS",
      instanceID:hist.instanceID,entityID:hist.entityID});
     continue;
    }
    const wreck=matching[0],liveWreck=scene.getEntityByID(wreck.wreckID);
    if(!liveWreck||liveWreck.itemID!==wreck.wreckID||liveWreck.nativeNpcWreck!==true)
     continue;
    let items=null;
    try{items=listWreckItems(wreck.wreckID)}catch{items=null}
    if(!Array.isArray(items)||items.length>512)continue;
    if(new Set(items.map(x=>x?.wreckItemID)).size!==items.length||
       items.some(x=>!id(x?.wreckItemID)||x.wreckID!==wreck.wreckID||
       !id(x.typeID)||!Number.isSafeInteger(x.quantity)||x.quantity<1||
       x.locationID!==wreck.wreckID))continue;
    // Store the exact original native inventory rows BEFORE any player
    // removes them. This is read-only source provenance, never an item grant.
    hist.initialWreckItems=items.map(item=>({
     wreckItemID:item.wreckItemID,typeID:item.typeID,
     quantity:item.quantity,singleton:item.singleton===true||
      item.singleton===1
    }));
    hist.wreckVerified=true;hist.wreckID=wreck.wreckID;
    out.wrecksVerified++;out.itemsVerified+=items.length;
    out.events.push({status:items.length?
      "ORIGINAL_BOSS_WRECK_WITH_ITEMS_VERIFIED":"ORIGINAL_BOSS_WRECK_EMPTY_VERIFIED",
     systemID,instanceID:hist.instanceID,siteID:hist.siteID,
     bossEntityID:hist.entityID,wreckID:wreck.wreckID,itemCount:items.length,
     itemIDs:items.map(x=>x.wreckItemID)});
    continue;
   }
   out.bosses++;
   const phase=phaseFor(Math.min(cand.health.armor,cand.health.structure)),
    level=phase==="LAST_STAND"?3:phase==="PRESSURE"?2:1;
   if(level>hist.peakPhase){
    hist.peakPhase=level;
    out.events.push({status:"NATIVE_BOSS_HP_PHASE_OBSERVED",systemID,
     instanceID:hist.instanceID,siteID:hist.siteID,bossEntityID:hist.entityID,
     phase,armor:cand.health.armor,structure:cand.health.structure});
   }
   if(level<2||out.orders>=2||occupied(cand.controller))continue;
   const targetID=id(cand.controller.lastAggressorID),
    at=cand.controller.lastAggressedAtMs,target=targetID&&player(targetID);
   if(!target||!Number.isSafeInteger(at)||at<=0||at>now||now-at>120000||
      distance(target.position,cand.ship.position)>250000)continue;
   const orderKey=hist.instanceID+":"+hist.entityID+":"+phase;
   if(orders.has(orderKey))continue;
   const receipt={phase:"ISSUING",at:now,entityID:hist.entityID,systemID};
   orders.set(orderKey,receipt);
   let result;
   try{result=issueAttack(hist.entityID,targetID,
     {allowWeapons:true,keepLock:true})}catch{result=null}
   receipt.phase=result?.success===true?"ATTACK_ACCEPTED":
    result?.success===false?"ATTACK_REJECTED":"OUTCOME_UNKNOWN";
   if(receipt.phase==="ATTACK_ACCEPTED"){
    out.orders++;
    out.events.push({status:"NATIVE_BOSS_ATTACK_ORDER_ACK",systemID,
     instanceID:hist.instanceID,bossEntityID:hist.entityID,phase,targetID});
   }else if(receipt.phase==="OUTCOME_UNKNOWN")
    out.events.push({status:"NATIVE_BOSS_ATTACK_OUTCOME_UNKNOWN",systemID,
     instanceID:hist.instanceID,bossEntityID:hist.entityID,phase});
  }
  out.status=out.wrecksVerified?"ORIGINAL_BOSS_WRECK_WITNESSED":
   out.orders?"NATIVE_BOSS_ATTACK_ORDERED":out.bosses?"NATIVE_BOSS_OBSERVED":"BOSS_DEATH_PENDING";
  for(const event of out.events)try{notify(event)}catch{}
  return out;
 }
 function witnessedWreck(wreckID){
  if(!id(wreckID))return null;
  const matches=[...seen.values()].filter(row=>
   row.wreckVerified===true&&row.wreckID===wreckID);
  if(matches.length!==1)return null;
  const row=matches[0];
  return {systemID:row.systemID,instanceID:row.instanceID,
   siteID:row.siteID,encounterKey:row.encounterKey,
   bossEntityID:row.entityID,bossTypeID:row.typeID,
   profileID:row.profileID,lootTableID:row.lootTableID,
   wreckID:row.wreckID,originalItems:(row.initialWreckItems||[])
    .map(item=>({...item}))};
 }
 function confirmNativeWreck({systemID,scene,entityID,wreckID}={}){
  if(!id(systemID)||!id(entityID)||!id(wreckID)||
     scene?.systemID!==systemID)return {status:"INVALID_NATIVE_BOSS_DEATH_HOOK"};
  if(![...seen.values()].some(row=>row.systemID===systemID&&
     row.entityID===entityID))
   return {status:"NO_PREVIOUS_LIVE_BOSS_WITNESS"};
  // Native destruction callback fires after source item rows and wreck spawn.
  tick({systemID,scene,instances:[],excludedIDs:[]});
  const witness=witnessedWreck(wreckID);
  return witness?.bossEntityID===entityID&&witness.systemID===systemID?
   {status:"ORIGINAL_BOSS_WRECK_CONFIRMED",witness}:
   {status:"BOSS_WRECK_NATIVE_SOURCE_UNVERIFIED"};
 }
 return {tick,witnessedWreck,confirmNativeWreck,
  activeIDs:()=>new Set([...seen.values()].map(x=>x.entityID)),
  snapshot:()=>[...seen.values()].map(x=>({...x}))};
}
module.exports={createNativeBossDirector,explicitBoss,phaseFor};
