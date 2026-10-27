"use strict";
// EX-02/03: read-only native scouting and limited same-corp rendezvous.
// NO alternative scanner, new loop, site spawns, inventory or wallet grants.
function loadCompetition() {
 try {return require("./coopNpcExpeditionCompetition");}
 catch(e) {
  if(e?.code!=="MODULE_NOT_FOUND" ||
     !String(e.message).includes("Cannot find module './coopNpcExpeditionCompetition'"))throw e;
  return require("./coopNpcExpeditionCompetition.cjs");
 }
}
const {createExpeditionCompetition}=loadCompetition();
const pos=n=>Number.isSafeInteger(n)&&n>0;
const vector=p=>p&&["x","y","z"].every(k=>typeof p[k]==="number"&&Number.isFinite(p[k]));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const named=p=>typeof p==="string"&&/^coop-pilot-[0-9]{3,}$/.test(p);
function createExpeditionDirector({listNativeSites,getNativeEntity,getController,
 orderBridge,warpToPoint,nativeProbeScan=null,isNativeProbeScout=null,clock=()=>Date.now(),intelTtlMs=600000,
 maxSitesPerTick=32,maxPilotsPerTick=32,maxOrdersPerTick=1}={}) {
 if((nativeProbeScan!==null&&typeof nativeProbeScan!=="function")||
    (isNativeProbeScout!==null&&typeof isNativeProbeScout!=="function")||
    [listNativeSites,getNativeEntity,getController,warpToPoint].some(f=>typeof f!=="function")||
    !orderBridge||typeof orderBridge.issue!=="function"||
    typeof orderBridge.blocked!=="function"||typeof clock!=="function"||
    !Number.isSafeInteger(intelTtlMs)||intelTtlMs<60000||intelTtlMs>3600000||
    !Number.isSafeInteger(maxSitesPerTick)||maxSitesPerTick<1||maxSitesPerTick>64||
    !Number.isSafeInteger(maxPilotsPerTick)||maxPilotsPerTick<2||maxPilotsPerTick>64||
    !Number.isSafeInteger(maxOrdersPerTick)||maxOrdersPerTick<1||maxOrdersPerTick>3)
  throw Error("NPC_EXPEDITION_NATIVE_AUTHORITIES_REQUIRED");
 const intel=new Map(),pending=new Map(),uncertainOrders=new Set();
 let physicallyReady=[];
 // EX-03B10: bounded, rotating hardware checks avoid starvation when the
 // genuinely equipped scout is beyond the ordinary per-tick patrol cap.
 let scannerCursor=0;
 const SCANNER_PREFLIGHT_BUDGET=128;
 let currentScene=null,currentAssignments=[],currentCatalog=null;
 const nativeSite=(systemID,siteID,fresh=false)=>{
  let sites;
  try{sites=!fresh&&currentScene?.systemID===systemID&&currentCatalog?currentCatalog:listNativeSites(systemID)}catch{return null}
  if(!Array.isArray(sites)||sites.length>2048)return null;
  const found=sites.filter(s=>s&&s.siteID===siteID&&
   (s.systemID===systemID||s.solarSystemID===systemID)&&vector(s.actualPosition));
  if(found.length!==1)return null;
  let physical=null;
  try{physical=currentScene?.systemID===systemID?
   currentScene.getEntityByID?.(siteID):null}catch{return null}
  if(!physical||physical.itemID!==siteID||!vector(physical.position)||
     distance(physical.position,found[0].actualPosition)>1)return null;
  return {...found[0],systemID};
 };
 const readPilot=(scene,entityID,assignments)=>{
  const matches=assignments.filter(a=>a?.entityID===entityID&&
   a.systemID===scene.systemID&&named(a.pilotID));
  if(matches.length!==1||assignments.some(a=>a?.pilotID===matches[0].pilotID&&
   (a.entityID!==entityID||a.systemID!==scene.systemID)))return null;
  // EX-03B12: a native store or scene lookup is a fallible authority.
  // It may reject THIS hull but must never abort the entire A-Life tick.
  let ship,c,n;
  try{
   ship=scene.getEntityByID?.(entityID);
   c=getController(entityID);
   n=getNativeEntity(entityID);
  }catch{return null}
  if(!ship||ship.kind!=="ship"||ship.nativeNpc!==true||ship.itemID!==entityID||
    ship.session?.characterID||!vector(ship.position)||
    (pos(ship.systemID)&&ship.systemID!==scene.systemID)||
    !n||n.entityID!==entityID||n.systemID!==scene.systemID||
    !pos(n.corporationID)||n.transient===true||ship.transient===true||
    ship.corporationID!==n.corporationID||
    !c||c.entityID!==entityID||c.systemID!==scene.systemID)
   return null;
  return {pilotID:matches[0].pilotID,entityID,systemID:scene.systemID,
   corpID:n.corporationID,ship};
 };
 const competition=createExpeditionCompetition({
  clock,resolveNativeSite:nativeSite,
  resolveNativeNpcPilot:(systemID,entityID)=>{
   if(currentScene?.systemID!==systemID)return null;
   const p=readPilot(currentScene,entityID,currentAssignments);
   return p?{...p,durableLinkVerified:true,nativeControllerVerified:true}:null;
  }
 });
 // A scene can change between the first site read and the original
 // competition's second physical witness read. Never let a transient
 // native getter exception abort every NPC in the existing 30-second tick.
 const safeObserve=args=>{
  try{return competition.observe(args)}
  catch{return {status:"NATIVE_SCENE_WITNESS_UNAVAILABLE"}}
 };
 const key=(systemID,siteID,corpID)=>systemID+":"+siteID+":"+corpID;
 const fingerprint=s=>JSON.stringify([s.siteID,s.targetID??null,s.siteKind??null,
  s.family??null,s.typeID??null,s.instanceID??null,s.pairID??null,
  s.actualPosition.x,s.actualPosition.y,s.actualPosition.z]);
 function tick({scene,assignments=[],roles={}}={}){
  // Never expose a previous tick's scout/site operation witness.
  physicallyReady=[];
  const now=clock();
  if(!pos(scene?.systemID)||typeof scene.getEntityByID!=="function"||
     !Number.isSafeInteger(now)||now<=0||!Array.isArray(assignments)||
     assignments.length>2048||!roles||typeof roles!=="object")
   return {status:"NO_TRUSTED_NATIVE_SCENE",observed:0,orders:0};
  currentScene=scene;currentAssignments=assignments;
  // EX-03B9: apply the native role gate before the per-tick cap.
  // Otherwise 32 earlier miners/haulers can starve every fitted scout,
  // even though all of them are valid named durable NPC pilots.
  const candidateIDs=[...new Set(assignments.filter(a=>
   pos(a?.entityID)&&named(a?.pilotID)&&roles[a.pilotID]==="patrol")
   .map(a=>a.entityID))].sort((a,b)=>a-b);
  // Scanner admission must happen BEFORE filling the ordinary pilot budget.
  // Otherwise a valid scanner behind 32 un-equipped patrols never ticks.
  // Only original native hardware may admit a scout. A missing authority or
  // a failing store lookup is not permission to scan with a virtual pilot.
  const equipped=[];
  if(nativeProbeScan&&isNativeProbeScout&&candidateIDs.length){
   const checks=Math.min(candidateIDs.length,SCANNER_PREFLIGHT_BUDGET);
   for(let step=0;step<checks;step++){
    const id=candidateIDs[(scannerCursor+step)%candidateIDs.length];
    let admitted=false;
    try{admitted=isNativeProbeScout(id,scene.systemID)===true}
    catch{continue}
    if(!admitted)continue;
    const pilot=readPilot(scene,id,assignments);
    if(!pilot)continue;
    equipped.push(pilot);
    if(equipped.length>=2)break;
   }
   // Advance a FULL bounded window even if two scouts were admitted early.
   // This makes every patrol eligible eventually, with no new timer.
   scannerCursor=(scannerCursor+checks)%candidateIDs.length;
  }
  const all=[...equipped],selected=new Set(equipped.map(p=>p.entityID));
  for(const id of candidateIDs){
   if(all.length>=maxPilotsPerTick)break;
   if(selected.has(id))continue;
   const pilot=readPilot(scene,id,assignments);
   if(pilot)all.push(pilot);
  }
  let sites;
  try{sites=listNativeSites(scene.systemID)}catch{
   return {status:"NATIVE_SITE_CATALOG_UNAVAILABLE",observed:0,orders:0};
  }
  if(!Array.isArray(sites)||sites.length>2048)
   return {status:"NATIVE_SITE_CATALOG_INVALID",observed:0,orders:0};
  currentCatalog=sites;
  const candidates=sites.filter(s=>pos(s?.siteID)&&vector(s?.actualPosition))
   .slice(0,maxSitesPerTick).map(s=>nativeSite(scene.systemID,s.siteID)).filter(Boolean);
  let observed=0,observedPlayers=0,contested=0,orders=0,blocked=0;
  let scoutWarpOrders=0,patrolWarpOrders=0,scoutOnGridVerified=0;
  for(const [id,row] of intel)if(row.at>now||now-row.at>intelTtlMs)intel.delete(id);
  for(const [id,row] of pending)if(row.at>now||now-row.at>intelTtlMs)pending.delete(id);
  for(const site of candidates){
   // Native player sessions are competition witnesses, NEVER NPC intel sources.
   const seenPlayerShips=new Set();
   for(const session of [...(scene.sessions?.values?.()||[])].slice(0,32)){
    const shipID=session?._space?.shipID;
    if(!pos(shipID)||seenPlayerShips.has(shipID))continue;
    seenPlayerShips.add(shipID);
    let candidate;
    try{candidate=scene.getEntityByID(shipID)}catch{continue}
    if(!candidate||!vector(candidate.position)||
       distance(candidate.position,site.actualPosition)>150000)continue;
    const witness=safeObserve({scene,siteID:site.siteID,shipID});
    if(witness.status==="NATIVE_SITE_OBSERVED")observedPlayers++;
    if(witness.contested===true&&witness.status==="NATIVE_SITE_OBSERVED")contested++;
   }
   for(const pilot of all){
   if(distance(pilot.ship.position,site.actualPosition)>150000)continue;
   const result=safeObserve({scene,siteID:site.siteID,shipID:pilot.entityID});
   if(!["NATIVE_SITE_OBSERVED","ALREADY_OBSERVED"].includes(result.status))continue;
   if(result.status==="NATIVE_SITE_OBSERVED")observed++;
   if(result.contested===true&&result.status==="NATIVE_SITE_OBSERVED")contested++;
   const id=key(scene.systemID,site.siteID,pilot.corpID),stamp=fingerprint(site),old=intel.get(id);
   if(!old||old.fingerprint!==stamp){
    if(!old&&intel.size>=512)continue;
    intel.set(id,{siteID:site.siteID,systemID:scene.systemID,corpID:pilot.corpID,
     scoutPilotID:pilot.pilotID,fingerprint:stamp,at:now});
   }
   }
  }
  // EX-03B: remote site coordinates are admitted ONLY after a real native
  // source probeScanRuntime result, backed by original NPC cargo flight
  // receipts and in-scene probe entities. No synthetic catalog discovery.
  let remoteScans=0;
  // EX-03B10: the scan cohort was admitted by original native scanner
  // equipment BEFORE the ordinary patrol cap; never fall back to scanning
  // unverified patrols if the hardware authority is missing or fails.
  if(nativeProbeScan)for(const scout of equipped){
   let scan;
   try{scan=nativeProbeScan({scene,entityID:scout.entityID,assignments})}
   catch{continue}
   if(scan?.status!=="NATIVE_PROBE_SCANNED"||!Array.isArray(scan.proofs))continue;
   for(const proof of scan.proofs.slice(0,16)){
    if(proof?.source!=="ORIGINAL_PHYSICAL_NPC_PROBE_SCAN"||
       proof.nativeScanCertainty!==1||proof.originalProbeCount<4||
       proof.systemID!==scene.systemID||proof.scoutEntityID!==scout.entityID||
       proof.pilotID!==scout.pilotID||proof.corporationID!==scout.corpID)
     continue;
    const matches=sites.filter(site=>site?.siteID===proof.siteID&&
       vector(site.actualPosition)&&
       (site.systemID===scene.systemID||site.solarSystemID===scene.systemID)&&
       site.targetID===proof.targetID);
    if(matches.length!==1)continue;
    const site=matches[0],stamp=fingerprint(site);
    if(stamp!==proof.siteFingerprint||
       !vector(proof.actualPosition)||
       distance(site.actualPosition,proof.actualPosition)>0.1)continue;
    const id=key(scene.systemID,site.siteID,scout.corpID);
    const old=intel.get(id);
    if(!old&&intel.size>=512)continue;
    if(!old||old.fingerprint!==stamp){
     intel.set(id,{siteID:site.siteID,systemID:scene.systemID,
      corpID:scout.corpID,scoutPilotID:scout.pilotID,
      fingerprint:stamp,source:"NATIVE_PROBE_SCAN",at:now});
     remoteScans++;
    }
   }
  }
  // Scout must have personally arrived on the original grid. Other native
  // same-corp patrol hulls can then approach; never leak player bookmarks.
  for(const [id,tip] of intel){
   if(orders>=maxOrdersPerTick)break;
   if(tip.systemID!==scene.systemID)continue;
   const site=tip.source==="NATIVE_PROBE_SCAN"?
    sites.find(s=>s?.siteID===tip.siteID&&
     (s.solarSystemID===scene.systemID||s.systemID===scene.systemID)&&
     vector(s.actualPosition)):nativeSite(tip.systemID,tip.siteID);
   if(!site||fingerprint(site)!==tip.fingerprint){intel.delete(id);continue}
   const scout=all.find(p=>p.pilotID===tip.scoutPilotID&&p.corpID===tip.corpID);
   if(!scout){blocked++;continue}
   // EX-03B11: a perfect original scan must send the equipped scout itself
   // to the site BEFORE summoning any same-corp patrol. Previously the
   // rendezvous loop skipped the scout, so it could never arrive and hack.
   // Followers require the scout's physically witnessed on-grid arrival.
   let scoutWarpFirst=false;
   if(tip.source==="NATIVE_PROBE_SCAN"){
    const scoutDistance=distance(scout.ship.position,site.actualPosition);
    if(scoutDistance>150000)scoutWarpFirst=true;
    else{
     const liveSite=nativeSite(tip.systemID,tip.siteID,true);
     if(!liveSite||fingerprint(liveSite)!==tip.fingerprint){blocked++;continue}
     const witness=safeObserve({scene,siteID:tip.siteID,shipID:scout.entityID});
     if(witness.status!=="NATIVE_SITE_OBSERVED"&&witness.status!=="ALREADY_OBSERVED"){
      blocked++;continue;
     }
     scoutOnGridVerified++;
    }
   }
   // Native operations may proceed ONLY with this tick's verified on-grid
   // scout witness and original site entity; never with a cached scan alone.
   if(tip.source==="NATIVE_PROBE_SCAN"&&!scoutWarpFirst&&
      distance(scout.ship.position,site.actualPosition)<=150000&&
      nativeSite(tip.systemID,tip.siteID,true)&&physicallyReady.length<64)
    physicallyReady.push({systemID:tip.systemID,siteID:tip.siteID,
     corpID:tip.corpID,scoutPilotID:scout.pilotID});
   const warpCandidates=scoutWarpFirst?[scout]:all;
   for(const p of warpCandidates){
    if(orders>=maxOrdersPerTick)break;
    if((p.pilotID===scout.pilotID&&!scoutWarpFirst)||p.corpID!==tip.corpID)continue;
    const d=distance(p.ship.position,site.actualPosition);
    if(d<150000||d>2e13)continue;
    const moveKey=p.entityID+":"+id;
    if(uncertainOrders.has(moveKey)||uncertainOrders.size>=512){blocked++;continue}
    if(pending.get(moveKey)?.fingerprint===tip.fingerprint)continue;
    if(pending.size>=512){blocked++;continue;}
    let unavailable=false;
    try{unavailable=orderBridge.blocked({entityID:p.entityID,systemID:scene.systemID,owner:"EXPEDITION"})!==false}
    catch{unavailable=true}
    if(unavailable){blocked++;continue}
    let result;
    try{result=orderBridge.issue({entityID:p.entityID,systemID:scene.systemID,
     owner:"EXPEDITION",action:scoutWarpFirst?
      "expedition-scout-rendezvous":"expedition-rendezvous",execute:()=>{
      // Re-read original native signatures immediately before a remote warp.
      // Remote coordinates are only allowed for an existing perfect scan.
      const live=tip.source==="NATIVE_PROBE_SCAN"?
       (()=>{try{
        const matches=listNativeSites(tip.systemID).filter(s=>
         s?.siteID===tip.siteID&&
         (s.solarSystemID===tip.systemID||s.systemID===tip.systemID)&&
         vector(s.actualPosition));
        return matches.length===1?matches[0]:null;
       }catch{return null}})():nativeSite(tip.systemID,tip.siteID,true);
      const native=readPilot(scene,p.entityID,assignments);
      if(!live||fingerprint(live)!==tip.fingerprint||!native||native.corpID!==tip.corpID)
       return {success:false,errorMsg:"EXPEDITION_NATIVE_INTEL_STALE"};
      return warpToPoint(p.entityID,{...live.actualPosition},
       {reason:scoutWarpFirst?"coop-npc-expedition-scout":"coop-npc-expedition",
        scheduleWake:true});
     }})}catch{
      // An exception after a bridge issued native warp is ambiguous:
      // fence this hull+intel until operator inspection, never replay.
      uncertainOrders.add(moveKey);blocked++;continue
     }
    if(result?.success===true){
     pending.set(moveKey,{fingerprint:tip.fingerprint,at:now});orders++;
     if(scoutWarpFirst)scoutWarpOrders++;else patrolWarpOrders++;
    }else{
     if(result?.errorMsg==="COOP_NPC_ORDER_REPAIR_REQUIRED")uncertainOrders.add(moveKey);
     blocked++;
    }
   }
  }
  return {status:"NATIVE_EXPEDITION_TICK",observed,observedPlayers,contested,remoteScans,orders,blocked,
   scoutWarpOrders,patrolWarpOrders,scoutOnGridVerified,
   source:"LOCAL_NATIVE_SITE_WITNESS",nativeLootGranted:false,nativeWalletMutation:false};
 }
 function snapshot(){
  return {tips:[...intel.values()].map(t=>({...t,fingerprint:"[REDACTED]"})),
   pending:pending.size,unknownOrderOutcomes:uncertainOrders.size};
 }
 function operations(){return physicallyReady.map(x=>({...x}));}
 return Object.freeze({tick,snapshot,operations});
}
module.exports={createExpeditionDirector};
