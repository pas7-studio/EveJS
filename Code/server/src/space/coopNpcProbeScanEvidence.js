"use strict";
// EX-03B: strict READ-ONLY native NPC probe scan proof. No launcher firing,
// inventory mutation, or scan-coordinate omniscience. Scans require >=4
// ORIGINAL nativeNpcStore probe cargo IDs, flight receipts and physical probes.
// Flight receipts are NOT generated here: until a durable launch writer exists,
// this module is deliberately unable to produce any positive scan proof.
const positive=n=>Number.isSafeInteger(n)&&n>0;
const finite=n=>typeof n==="number"&&Number.isFinite(n);
const vec=p=>p&&["x","y","z"].every(k=>finite(p[k]));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const pilot=s=>typeof s==="string"&&/^coop-pilot-[0-9]{3,}$/.test(s);
const siteIdentity=s=>JSON.stringify([s.siteID,s.targetID??null,s.siteKind??null,
 s.family??null,s.typeID??null,s.instanceID??null,s.pairID??null,
 s.actualPosition?.x,s.actualPosition?.y,s.actualPosition?.z]);
function fields(row){
 if(!row||row.type!=="object"||row.name!=="util.KeyVal"||
    row.args?.type!=="dict"||!Array.isArray(row.args.entries))return null;
 const arr=row.args.entries;
 if(arr.some(x=>!Array.isArray(x)||x.length!==2||typeof x[0]!=="string")||
    new Set(arr.map(x=>x[0])).size!==arr.length)return null;
 return Object.fromEntries(arr);
}
function scanPosition(raw){
 if(!raw||raw.type!=="list"||!Array.isArray(raw.items)||raw.items.length!==3)return null;
 const p=raw.items.map(x=>finite(x)?x:x?.type==="real"&&finite(x.value)?x.value:NaN);
 return p.every(finite)?{x:p[0],y:p[1],z:p[2]}:null;
}
function createNpcProbeScanEvidence({getNativeEntity,getController,listNativeModulesForEntity,
 listNativeCargoForEntity,getCompatibleProbeChargeTypeIDs,resolveProbeRangeContract,
 scanNativeResults,listNativeSites,clock=()=>Date.now(),maxProbes=8,maxAgeMs=3600000}={}) {
 if([getNativeEntity,getController,listNativeModulesForEntity,listNativeCargoForEntity,
    getCompatibleProbeChargeTypeIDs,resolveProbeRangeContract,scanNativeResults,listNativeSites,clock]
    .some(fn=>typeof fn!=="function")||
    !Number.isSafeInteger(maxProbes)||maxProbes<4||maxProbes>8||
    !Number.isSafeInteger(maxAgeMs)||maxAgeMs<60000||maxAgeMs>3600000)
  throw Error("NPC_NATIVE_PROBE_SCAN_AUTHORITIES_REQUIRED");
 const refuse=reason=>({status:"BLOCKED",reason,proofs:[],probeCount:0});
 function scan({scene,entityID,assignments=[]}={}){
  const now=clock();
  if(!positive(entityID)||!positive(scene?.systemID)||
     typeof scene.getEntityByID!=="function"||!Array.isArray(assignments)||
     assignments.length>2048||!Number.isSafeInteger(now)||now<=0)
   return refuse("INVALID_NATIVE_PROBE_CONTEXT");
  const identity=assignments.filter(x=>x?.entityID===entityID&&
    x.systemID===scene.systemID&&pilot(x.pilotID));
  if(identity.length!==1||assignments.some(x=>x.pilotID===identity[0].pilotID&&
     (x.entityID!==entityID||x.systemID!==scene.systemID)))
   return refuse("NPC_SCANNER_DURABLE_PILOT_MISSING");
  let entity,controller,mods,cargo;
  try{
   entity=getNativeEntity(entityID);controller=getController(entityID);
   mods=listNativeModulesForEntity(entityID);
   cargo=listNativeCargoForEntity(entityID);
  }catch{return refuse("NPC_SCANNER_NATIVE_STORE_UNAVAILABLE")}
  const ship=scene.getEntityByID(entityID);
  if(!ship||ship.itemID!==entityID||ship.kind!=="ship"||ship.nativeNpc!==true||
    !vec(ship.position)||ship.session?.characterID||ship.pilotCharacterID>0||
    ship.pendingWarp||ship.warpState||ship.isWarping||
    String(ship.mode||"").toUpperCase().includes("WARP")||
    !entity||entity.entityID!==entityID||entity.systemID!==scene.systemID||
    !positive(entity.ownerID)||!positive(entity.corporationID)||
    entity.ownerID!==ship.ownerID||entity.corporationID!==ship.corporationID||
    entity.transient===true||ship.transient===true||
    !controller||controller.entityID!==entityID||controller.systemID!==scene.systemID||
    !Array.isArray(mods)||mods.length>256||!Array.isArray(cargo)||cargo.length>512)
   return refuse("NPC_SCANNER_SHIP_NOT_AUTHORITATIVE");
  const originals=[];
  const seen=new Set();
  for(const row of cargo){
   if(!row||row.entityID!==entityID||row.ownerID!==entity.ownerID||
      !positive(row.cargoID)||row.groupID!==479||row.categoryID!==8||
      row.transient===true||row.singleton===true||row.quantity!==0||!row.deployedProbe)continue;
   const flight=row.deployedProbe;
   if(flight.status!=="IN_SPACE"||flight.probeID!==row.cargoID||
      flight.entityID!==entityID||flight.systemID!==scene.systemID||
      flight.ownerID!==entity.ownerID||flight.typeID!==row.typeID||
      !positive(row.moduleID)||!Number.isSafeInteger(flight.launchedAtMs)||
      flight.launchedAtMs>now||now-flight.launchedAtMs>maxAgeMs||
      !vec(flight.position)||!positive(flight.rangeStep)||flight.rangeStep>8||!finite(flight.scanRange)||
      flight.scanRange<=0)continue;
   const launcher=mods.find(m=>m.moduleID===row.moduleID&&m.entityID===entityID&&
       m.ownerID===entity.ownerID&&m.groupID===481&&m.categoryID===7&&
       m.moduleState?.online===true&&m.transient!==true);
   if(!launcher)return refuse("NPC_SCANNER_LAUNCHER_NOT_OWNED");
   let compatible,range;
   try{
    compatible=getCompatibleProbeChargeTypeIDs(launcher.typeID);
    range=resolveProbeRangeContract(row.typeID,flight.rangeStep,flight.scanRange);
   }catch{return refuse("NPC_SCANNER_STATIC_DATA_UNAVAILABLE")}
   if(!Array.isArray(compatible)||!compatible.includes(row.typeID)||
      !range||range.rangeStep!==flight.rangeStep||
      !finite(range.scanRange)||range.scanRange<=0||
      Math.abs(range.scanRange-flight.scanRange)>0.001)
    return refuse("NPC_SCANNER_PROBE_RANGE_OR_TYPE_UNVERIFIED");
   const physical=scene.getEntityByID(flight.probeID);
   if(!physical||physical.itemID!==flight.probeID||physical.kind!=="probe"||
      physical.nativeNpcProbe!==true||physical.nativeNpcCargoID!==row.cargoID||
      physical.typeID!==row.typeID||physical.ownerID!==entity.ownerID||
      physical.systemID!==scene.systemID||
      !vec(physical.position)||dist(physical.position,flight.position)>1||
      seen.has(flight.probeID))return refuse("NPC_SCANNER_PHYSICAL_PROBE_UNVERIFIED");
   seen.add(flight.probeID);
   originals.push({probeID:flight.probeID,typeID:row.typeID,
     pos:[physical.position.x,physical.position.y,physical.position.z],
     destination:[physical.position.x,physical.position.y,physical.position.z],
     scanRange:range.scanRange,rangeStep:range.rangeStep,state:1});
  }
  if(originals.length<4)return refuse("NPC_SCANNER_FOUR_ORIGINAL_PROBES_REQUIRED");
  if(originals.length>maxProbes)return refuse("NPC_SCANNER_TOO_MANY_ACTIVE_PROBES");
  let result,sites;
  try{
   // Use the EXACT pinned native probe coverage and certainty calculation.
   result=scanNativeResults(scene.systemID,new Map(originals.map(p=>[p.probeID,p])));
   sites=listNativeSites(scene.systemID);
  }catch{return refuse("NPC_SCANNER_NATIVE_SCAN_FAILED")}
  if(!Array.isArray(result?.results)||!Array.isArray(sites)||sites.length>2048)
   return refuse("NPC_SCANNER_NATIVE_RESULT_INVALID");
  const proofs=[],used=new Set();
  for(const scanRow of result.results.slice(0,64)){
   const entry=fields(scanRow);
   if(!entry||entry.certainty!==1)continue;
   const target=String(entry.id||"").trim().toUpperCase();
   const matches=sites.filter(s=>positive(s?.siteID)&&vec(s?.actualPosition)&&
      String(s.targetID||"").trim().toUpperCase()===target&&
      (s.solarSystemID===scene.systemID||s.systemID===scene.systemID));
   if(matches.length!==1)continue;
   const site=matches[0],p=scanPosition(entry.pos);
   if(!p||dist(p,site.actualPosition)>0.1||used.has(site.siteID)||
      entry.itemID!=null&&entry.itemID!==site.itemID)continue;
   used.add(site.siteID);
   proofs.push({siteID:site.siteID,systemID:scene.systemID,
     targetID:site.targetID,siteFingerprint:siteIdentity(site),
     actualPosition:{...site.actualPosition},scoutEntityID:entityID,
     pilotID:identity[0].pilotID,corporationID:entity.corporationID,
     nativeScanCertainty:1,originalProbeCount:originals.length,
     source:"ORIGINAL_PHYSICAL_NPC_PROBE_SCAN"});
  }
  return {status:"NATIVE_PROBE_SCANNED",proofs,probeCount:originals.length,
   nativeWalletMutation:false,nativeLootGranted:false};
 }
 return Object.freeze({scan});
}
module.exports={createNpcProbeScanEvidence};
