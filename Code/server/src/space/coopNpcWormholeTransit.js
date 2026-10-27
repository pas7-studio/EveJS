"use strict";
// EX-03B16: ONE original NPC hull crosses a source-native wormhole.
// Native wormholeRuntime owns pair mass, collapse, exit pose and polarization.
// Original nativeNpcService moves SAME hull/module/cargo IDs. Durable journal
// must commit BEFORE mass mutation. An uncertain outcome is NOT replayed.
const fs=require("node:fs"),path=require("node:path");
const POS=x=>Number.isSafeInteger(x)&&x>0;
const vec=x=>x&&["x","y","z"].every(k=>typeof x[k]==="number"&&Number.isFinite(x[k]));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const clone=x=>JSON.parse(JSON.stringify(x));
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
const ident=x=>JSON.stringify(x.map(clone).sort((a,b)=>
 Number(a.cargoID||a.moduleID)-Number(b.cargoID||b.moduleID)));
function createNpcWormholeTransit({store,service,registry,gameStore,
 wormholes,wormholeState,sceneForSystem,root,clock=()=>Date.now(),fsApi=fs}={}){
 if(!path.isAbsolute(root||"")||!store||!service||!registry||!gameStore||
  !wormholes||!wormholeState||
  [sceneForSystem,clock].some(f=>typeof f!=="function")||
  ["prepareJump","commitJump","buildJumpSpawnState"].some(k=>typeof wormholes[k]!=="function")||
  typeof wormholeState.getStateSnapshot!=="function"||
  typeof gameStore.flushTableSync!=="function"||
  typeof registry.relocate!=="function"||typeof registry.snapshot!=="function"||
  typeof service.dematerializeNativeController!=="function"||
  typeof service.materializeStoredNativeController!=="function"||
  ["getNativeEntity","getNativeController","listNativeModulesForEntity",
   "listNativeCargoForEntity","upsertNativeEntity","upsertNativeController"]
   .some(k=>typeof store[k]!=="function"))
  throw Error("EX03_ORIGINAL_WORMHOLE_AND_NPC_AUTHORITIES_REQUIRED");
 const pending=new Set();
 const refuse=reason=>({status:"BLOCKED",reason,nativeMassRefunded:false});
 function directory(){
  fsApi.mkdirSync(root,{recursive:true,mode:0o700});
  if(!fsApi.statSync(root).isDirectory()||fsApi.lstatSync(root).isSymbolicLink()||
    fsApi.lstatSync(path.dirname(root)).isSymbolicLink())
   throw Error("EX03_WORMHOLE_JOURNAL_UNSAFE");
 }
 function syncDir(){const fd=fsApi.openSync(root,"r");try{fsApi.fsyncSync(fd)}finally{fsApi.closeSync(fd)}}
 const filename=(pilot,when,pair)=>"ex03-wh-"+pilot+"-"+when+"-"+pair+".json";
 function write(ticket,initial=false){
  directory();
  const dest=path.join(root,filename(ticket.pilotID,ticket.startedAt,ticket.pairID));
  const temp=initial?dest:dest+".tmp-"+process.pid;
  let fd;
  try{
   fd=fsApi.openSync(temp,"wx",0o600);
   fsApi.writeFileSync(fd,JSON.stringify(ticket)+"\n");
   fsApi.fsyncSync(fd);fsApi.closeSync(fd);fd=undefined;
   if(!initial)fsApi.renameSync(temp,dest);
   syncDir();
  }finally{if(fd!==undefined)try{fsApi.closeSync(fd)}catch{}}
 }
 function pendingFor(pilot){
  try{
   directory();
   const files=fsApi.readdirSync(root);
   if(files.length>10000||files.some(x=>
    !/^ex03-wh-coop-pilot-[0-9]{3,}-[0-9]+-[0-9]+\.json$/.test(x)))
    return {blocked:true,reason:"EX03_WORMHOLE_JOURNAL_UNKNOWN_FILES"};
   for(const name of files.filter(x=>x.startsWith("ex03-wh-"+pilot+"-"))){
    const data=JSON.parse(fsApi.readFileSync(path.join(root,name),"utf8"));
    if(data?.version!==1||data.pilotID!==pilot||
      filename(data.pilotID,data.startedAt,data.pairID)!==name||
      !["PREPARED","MASS_COMMITTED","SOURCE_DEMATERIALIZED",
       "DESTINATION_RECORDS","ARRIVED","NEEDS_OPERATOR_REPAIR"].includes(data.phase))
     return {blocked:true,reason:"EX03_WORMHOLE_JOURNAL_CORRUPT"};
    if(data.phase!=="ARRIVED")
     return {blocked:true,reason:"EX03_WORMHOLE_REPAIR_REQUIRED"};
   }
   return {blocked:false};
  }catch{return {blocked:true,reason:"EX03_WORMHOLE_JOURNAL_UNREADABLE"}}
 }
 function cross({pilotID,entityID,scene,endpointID,assignments=[]}={}){
  if(!named(pilotID)||!POS(entityID)||!POS(scene?.systemID)||!POS(endpointID)||
    !Array.isArray(assignments)||assignments.length>2048||
    !POS(clock())||sceneForSystem(scene.systemID)!==scene)
   return refuse("EX03_WORMHOLE_CONTEXT_INVALID");
  if(pending.has(pilotID))return refuse("EX03_WORMHOLE_TRANSIT_ACTIVE");
  const matches=assignments.filter(x=>x?.pilotID===pilotID&&
   x.entityID===entityID&&x.systemID===scene.systemID);
  if(matches.length!==1||assignments.some(x=>x?.pilotID===pilotID&&
    (x.entityID!==entityID||x.systemID!==scene.systemID)))
   return refuse("EX03_WORMHOLE_DURABLE_IDENTITY_MISSING");
  const prior=pendingFor(pilotID);
  if(prior.blocked)return refuse(prior.reason);
  let ship,sourceEndpoint,native,controller,mods,cargo;
  try{
   ship=scene.getEntityByID(entityID);sourceEndpoint=scene.getEntityByID(endpointID);
   native=store.getNativeEntity(entityID);controller=store.getNativeController(entityID);
   mods=store.listNativeModulesForEntity(entityID);
   cargo=store.listNativeCargoForEntity(entityID);
  }catch{return refuse("EX03_WORMHOLE_NATIVE_SOURCE_UNAVAILABLE")}
  if(!ship||ship.kind!=="ship"||ship.itemID!==entityID||
   ship.nativeNpc!==true||ship.session?.characterID||
   ship.isWarping||ship.warpState||ship.pendingWarp||
   String(ship.mode||"").toUpperCase().includes("WARP")||
   !vec(ship.position)||!POS(ship.mass)||
   !native||native.entityID!==entityID||native.systemID!==scene.systemID||
   native.ownerID!==ship.ownerID||native.corporationID!==ship.corporationID||
   !controller||controller.entityID!==entityID||
   controller.systemID!==scene.systemID||
   controller.manualOrder?.type==="attack"||
   !Array.isArray(mods)||mods.length>256||!Array.isArray(cargo)||cargo.length>512||
   !sourceEndpoint||sourceEndpoint.kind!=="wormhole"||
   sourceEndpoint.itemID!==endpointID||!vec(sourceEndpoint.position)||
   Math.max(0,distance(ship.position,sourceEndpoint.position)-
    Math.max(0,Number(ship.radius)||0)-
    Math.max(0,Number(sourceEndpoint.radius)||0))>5000)
   return refuse("EX03_WORMHOLE_NATIVE_SHIP_OR_ENDPOINT_INVALID");
  const link=registry.snapshot()?.links?.[pilotID];
  if(link?.entityID!==entityID||link.systemID!==scene.systemID)
   return refuse("EX03_WORMHOLE_REGISTRY_MISMATCH");
  const mass=Math.trunc(ship.mass),now=clock();
  let prepared;
  try{prepared=wormholes.prepareJump(endpointID,entityID,mass,now)}
  catch{return refuse("EX03_WORMHOLE_PREPARE_FAILED")}
  const d=prepared?.data;
  if(prepared?.success!==true||!POS(d?.pairID)||!POS(d?.destinationEndpointID)||
     !POS(d?.destinationSystemID)||d.destinationSystemID===scene.systemID)
   return refuse("EX03_WORMHOLE_PREPARE_REFUSED");
  const otherScene=sceneForSystem(d.destinationSystemID);
  const otherEndpoint=otherScene?.getEntityByID?.(d.destinationEndpointID);
  if(!otherScene||!otherEndpoint||otherEndpoint.kind!=="wormhole"||
    otherEndpoint.itemID!==d.destinationEndpointID||
    !vec(otherEndpoint.position)||otherScene.getEntityByID(entityID))
   return refuse("EX03_WORMHOLE_REAL_DESTINATION_MISSING");
  const pair=d.pair,sourcePart=pair?.[d.role],otherPart=
   pair?.[d.role==="source"?"destination":"source"];
  if(sourcePart?.endpointID!==endpointID||
    sourcePart.systemID!==scene.systemID||
    otherPart?.endpointID!==d.destinationEndpointID||
    otherPart.systemID!==d.destinationSystemID||
    otherEndpoint.wormholePairID!==d.pairID||
    sourceEndpoint.wormholePairID!==d.pairID)
   return refuse("EX03_WORMHOLE_PAIR_SOURCE_MISMATCH");
  const before=wormholeState.getStateSnapshot()?.pairsByID?.[String(d.pairID)];
  if(before?.state!=="active"||!POS(before.remainingMass)||
    before.maxJumpMass>0&&mass>before.maxJumpMass)
   return refuse("EX03_WORMHOLE_MASS_OR_PAIR_UNAVAILABLE");
  // Snapshot providers may return a live reference; freeze the pre-debit
  // primitive BEFORE calling native commitJump (which mutates the same pair).
  const beforeMass=before.remainingMass;
  const pose=wormholes.buildJumpSpawnState(pair,d.role,{
   shipMass:mass,characterID:entityID,nowMs:now});
  if(pose?.anchorType!=="wormhole"||pose.anchorID!==d.destinationEndpointID||
    !vec(pose.position))
   return refuse("EX03_WORMHOLE_NATIVE_EXIT_UNAVAILABLE");
  const ticket={version:1,phase:"PREPARED",startedAt:now,
   pilotID,entityID,sourceSystemID:scene.systemID,
   destinationSystemID:d.destinationSystemID,
   sourceEndpointID:endpointID,destinationEndpointID:d.destinationEndpointID,
   pairID:d.pairID,mass,sourceCargoIDs:cargo.map(x=>x.cargoID),
   sourceModuleIDs:mods.map(x=>x.moduleID)};
  pending.add(pilotID);
  let massIssued=false;
  try{
   write(ticket,true);
   massIssued=true;
   const result=wormholes.commitJump(endpointID,entityID,mass,now);
   if(result?.success!==true)throw Error("EX03_ORIGINAL_MASS_COMMIT_FAILED");
   if(gameStore.flushTableSync("wormholeRuntimeState")?.success!==true)
    throw Error("EX03_ORIGINAL_MASS_DURABILITY_UNCONFIRMED");
   const after=wormholeState.getStateSnapshot();
   const state=after?.pairsByID?.[String(d.pairID)];
   const polar=after?.polarizationByCharacter?.[String(entityID)]?.[String(endpointID)];
   if(!state||state.remainingMass!==Math.max(0,beforeMass-mass)||
    !POS(polar?.endAtMs)||polar.endAtMs<=now)
    throw Error("EX03_ORIGINAL_MASS_OR_POLARIZATION_UNCONFIRMED");
   ticket.phase="MASS_COMMITTED";write(ticket);
   const beforeEntity=clone(native),beforeController=clone(controller);
   const modSig=ident(mods),cargoSig=ident(cargo);
   const gone=service.dematerializeNativeController(controller,{
    persistState:true,broadcast:true});
   if(gone?.success!==true||scene.getEntityByID(entityID))
    throw Error("EX03_SOURCE_NATIVE_DEMATERIALIZATION_FAILED");
   ticket.phase="SOURCE_DEMATERIALIZED";write(ticket);
   const fromStore=store.getNativeEntity(entityID),fromController=store.getNativeController(entityID);
   if(fromStore?.systemID!==scene.systemID||fromController?.systemID!==scene.systemID)
    throw Error("EX03_NATIVE_DEMATERIALIZED_STATE_UNVERIFIED");
   if(store.upsertNativeEntity({...fromStore,systemID:d.destinationSystemID,
       position:{...pose.position},targetPoint:{...pose.position},
       velocity:{x:0,y:0,z:0},speedFraction:0,mode:"STOP",
       targetEntityID:0})?.success!==true||
      store.upsertNativeController({...fromController,
       systemID:d.destinationSystemID,anchorKind:"wormhole",
       anchorID:d.destinationEndpointID,homePosition:{...pose.position},
       currentTargetID:0,preferredTargetID:0,lastAggressorID:0,
       manualOrder:null,returningHome:false,nextThinkAtMs:0})?.success!==true)
    throw Error("EX03_NATIVE_DESTINATION_RECORD_FAILED");
   for(const table of ["npcEntities","npcRuntimeControllers"])
    if(gameStore.flushTableSync(table)?.success!==true)
     throw Error("EX03_NATIVE_TRANSFER_DURABILITY_UNCONFIRMED");
   ticket.phase="DESTINATION_RECORDS";write(ticket);
   const entered=service.materializeStoredNativeController(otherScene,entityID,{broadcast:true});
   if(entered?.success!==true||scene.getEntityByID(entityID)||
    !otherScene.getEntityByID(entityID)||
    store.getNativeEntity(entityID)?.systemID!==d.destinationSystemID||
    ident(store.listNativeModulesForEntity(entityID)||[])!==modSig||
    ident(store.listNativeCargoForEntity(entityID)||[])!==cargoSig)
    throw Error("EX03_ORIGINAL_NPC_TRANSFER_IDENTITY_UNCONFIRMED");
   const changed=registry.relocate(pilotID,scene.systemID,entityID,d.destinationSystemID);
   if(changed?.status!=="RELOCATED")
    throw Error("EX03_DURABLE_PILOT_RELOCATION_UNCONFIRMED");
   ticket.phase="ARRIVED";write(ticket);
   return {status:"NATIVE_NPC_WORMHOLE_ARRIVED",entityID,
    destinationSystemID:d.destinationSystemID,originalPairID:d.pairID,
    nativeMassRefunded:false,preservedCargo:true,preservedModules:true};
  }catch(error){
   // If a synchronous boundary threw AFTER mass may have mutated,
   // do not rollback/retry the original mass and do not mint a ship.
   if(massIssued){
    ticket.phase="NEEDS_OPERATOR_REPAIR";
    try{write(ticket)}catch{}
   }
   return {status:"NEEDS_OPERATOR_REPAIR",
    reason:String(error?.message||error).slice(0,120),nativeMassRefunded:false};
  }finally{pending.delete(pilotID)}
 }
 return Object.freeze({cross,inspectPilot:pendingFor});
}
module.exports={createNpcWormholeTransit};
