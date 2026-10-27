"use strict";
// Opt-in cross-system movement of ONE authoritative native EveJS NPC ship.
// Preserve its entityID, modules, cargo and HP; never run via a fake session.
// Synchronous journal plus compensating rollback; still requires live QA
// before the feature flag may be enabled on a production server.
const fs=require("node:fs"),path=require("node:path");
const validID=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
const positive=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const vector=p=>p&&["x","y","z"].every(k=>Number.isFinite(p[k]));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const clone=x=>JSON.parse(JSON.stringify(x));
const itemsSignature=x=>JSON.stringify(x.map(v=>clone(v))
 .sort((a,b)=>Number(a.cargoID||a.moduleID)-Number(b.cargoID||b.moduleID)));
function createNativeGateTransfer({sceneForSystem,getGate,store,service,getController,
 registry,journalDir="/var/lib/evejs/coop-native-transfers",clock=()=>Date.now(),isScrambled=()=>false}={}){
 if(typeof sceneForSystem!=="function"||typeof getGate!=="function"||!store||!service||
  typeof getController!=="function"||typeof isScrambled!=="function"||
  typeof registry?.relocate!=="function"||
  typeof service.dematerializeNativeController!=="function"||
  typeof service.materializeStoredNativeController!=="function"||
  !["getNativeEntity","getNativeController","listNativeModulesForEntity",
   "listNativeCargoForEntity","upsertNativeEntity","upsertNativeController",
   "upsertNativeModule","upsertNativeCargo"]
   .every(k=>typeof store[k]==="function"))throw Error("native gate transfer dependencies required");
 const journalFile=id=>path.join(journalDir,id+".json");
 // Crash-persistent intent. A partial temporary write is a repair blocker.
 const syncDir=()=>{const fd=fs.openSync(journalDir,"r");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
 const safeDirectory=()=>{
  fs.mkdirSync(journalDir,{recursive:true});
  const st=fs.lstatSync(journalDir);
  if(!st.isDirectory()||st.isSymbolicLink())throw Error("NATIVE_GATE_JOURNAL_DIRECTORY_UNSAFE");
 };
 let journalCounter=0;
 const save=(id,value)=>{
  safeDirectory();
  const final=journalFile(id),temp=final+".tmp-"+process.pid+"-"+(++journalCounter);
  let fd=null;
  try{
   fd=fs.openSync(temp,"wx",0o600);fs.writeFileSync(fd,JSON.stringify(value));
   fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
   fs.renameSync(temp,final);syncDir();
  }finally{if(fd!==null)fs.closeSync(fd);}
 };
 const remove=id=>{
  safeDirectory();
  try{fs.unlinkSync(journalFile(id));syncDir();}
  catch(e){if(e.code!=="ENOENT")throw e;}
 };
 const write=(method,record)=>{
  const result=store[method](record,{transient:record.transient===true});
  if(result?.success!==true)throw Error(method+" failed: "+String(result?.errorMsg||"UNKNOWN"));
 };
 const physical=(scene,id)=>scene?.getEntityByID?.(id)||null;
 function rollback(entry){
  const id=entry.entityID,source=sceneForSystem(entry.sourceSystemID),
   dest=sceneForSystem(entry.destinationSystemID);
  const destShip=physical(dest,id);
  if(destShip){
   const c=getController(id);
   if(!c||Number(c.systemID)!==entry.destinationSystemID)throw Error("DESTINATION_CONTROLLER_INCONSISTENT");
   const removed=service.dematerializeNativeController(c,{persistState:false,broadcast:true});
   if(removed?.success!==true||physical(dest,id))throw Error("DESTINATION_DEMATERIALIZE_FAILED");
  }
  write("upsertNativeEntity",entry.restoreEntity);
  write("upsertNativeController",entry.restoreController);
  // Restore original native module and cargo rows, preserving their
  // exact IDs and quantities even after a crash during transient writes.
  for(const row of entry.restoreModules)write("upsertNativeModule",row);
  for(const row of entry.restoreCargo)write("upsertNativeCargo",row);
  if(!physical(source,id)){
   const restored=service.materializeStoredNativeController(source,id,{broadcast:true});
   if(restored?.success!==true||!physical(source,id))throw Error("SOURCE_REMATERIALIZE_FAILED");
  }
  const linked=registry.snapshot().links?.[entry.pilotID];
  if(!linked||Number(linked.systemID)!==entry.sourceSystemID||
   Number(linked.entityID)!==id)throw Error("SOURCE_IDENTITY_REGISTRY_INCONSISTENT");
  return {success:true,entityID:id,systemID:entry.sourceSystemID,rolledBack:true};
 }
 function recoverPending(){
  let names=[];
  try{names=fs.readdirSync(journalDir).filter(x=>/^coop-pilot-[0-9]{3,}\.json$/.test(x));}
  catch(e){if(e.code==="ENOENT")return {status:"CLEAN",recovered:0};throw e;}
  if(names.length!==fs.readdirSync(journalDir).length)
   return {status:"NEEDS_OPERATOR_REPAIR",recovered:0,
    pending:[{error:"NATIVE_GATE_UNKNOWN_OR_TEMP_JOURNAL_FILES"}]};
  if(!names.length)return {status:"CLEAN",recovered:0};
  const pending=[],recovered=[];
  for(const filename of names){
   let entry;
   try{entry=JSON.parse(fs.readFileSync(path.join(journalDir,filename),"utf8"));}
   catch(e){pending.push({file:filename,error:"CORRUPT_JOURNAL"});continue;}
   if(!validID(entry.pilotID)||!positive(entry.entityID)||
    !positive(entry.sourceSystemID)||!positive(entry.destinationSystemID)||
    !entry.restoreEntity||!entry.restoreController||
    !Array.isArray(entry.restoreModules)||!Array.isArray(entry.restoreCargo)){
    pending.push({file:filename,error:"INVALID_JOURNAL"});continue;
   }
   const native=store.getNativeEntity(entry.entityID),link=registry.snapshot().links?.[entry.pilotID];
   const destination=sceneForSystem(entry.destinationSystemID);
   if(Number(link?.systemID)===entry.destinationSystemID&&
    Number(native?.systemID)===entry.destinationSystemID&&
    physical(destination,entry.entityID)){
    try{remove(entry.pilotID);recovered.push({pilotID:entry.pilotID,status:"COMMITTED_ALREADY"});}
    catch(e){pending.push({file:filename,error:"JOURNAL_CLEANUP_FAILED"});}
    continue;
   }
   try{rollback(entry);remove(entry.pilotID);
    recovered.push({pilotID:entry.pilotID,status:"ROLLED_BACK_TO_SOURCE"});}
   catch(e){pending.push({file:filename,error:String(e.message).slice(0,100)});}
  }
  return {status:pending.length?"NEEDS_OPERATOR_REPAIR":"RECOVERED",
   recovered:recovered.length,pending,entries:recovered};
 }
 function transfer({pilotID,entityID,gate,sourceScene,ship,controller}={}){
  const id=positive(entityID),source=positive(gate?.sourceSystemID),
   dest=positive(gate?.destinationSystemID);
  if(!validID(pilotID)||!id||!source||!dest||source===dest||
   Number(gate?.sourceGateID)<=0||Number(gate?.destinationGateID)<=0||
   !sourceScene||Number(sourceScene.systemID)!==source||
   sourceScene!==sceneForSystem(source)||physical(sourceScene,id)!==ship||
   ship?.nativeNpc!==true||ship.kind!=="ship"||ship.session?.characterID||
   !vector(ship.position)||!controller||Number(controller.entityID)!==id||
   Number(controller.systemID)!==source||Number(controller.currentTargetID)>0||
   controller.manualOrder?.type==="attack"||isScrambled(ship)||
   ship.activeModuleEffects?.size>0||String(ship.mode||"").toUpperCase().includes("WARP"))
   return {success:false,errorMsg:"NATIVE_GATE_PREFLIGHT_REJECTED"};
  const gateFrom=getGate(gate.sourceGateID),gateTo=getGate(gate.destinationGateID);
  if(!gateFrom||!gateTo||
   Number(gateFrom.itemID)!==Number(gate.sourceGateID)||
   Number(gateTo.itemID)!==Number(gate.destinationGateID)||
   Number(gateFrom.solarSystemID)!==source||
   Number(gateTo.solarSystemID)!==dest||
   Number(gateFrom.destinationID)!==Number(gate.destinationGateID)||
   Number(gateTo.destinationID)!==Number(gate.sourceGateID))
   return {success:false,errorMsg:"RECIPROCAL_STARGATE_NOT_VERIFIED"};
  const sourceGate=sourceScene.staticEntities?.find(x=>Number(x.itemID)===Number(gate.sourceGateID)&&x.kind==="stargate");
  const gateSurfaceDistance=sourceGate&&vector(sourceGate.position)
   ?Math.max(0,dist(ship.position,sourceGate.position)-
     Math.max(0,Number(ship.radius)||0)-
     Math.max(0,Number(sourceGate.radius)||0))
   :Infinity;
  // Same physical jump range as pinned EveJS transitions.js (2500 m).
  if(!sourceGate||!vector(sourceGate.position)||gateSurfaceDistance>2500)
   return {success:false,errorMsg:"NPC_NOT_AT_PHYSICAL_GATE"};
  const destinationScene=sceneForSystem(dest);
  const destinationGate=destinationScene?.staticEntities?.find(x=>
   Number(x.itemID)===Number(gate.destinationGateID)&&x.kind==="stargate");
  if(!destinationGate||!vector(destinationGate.position)||physical(destinationScene,id))
   return {success:false,errorMsg:"DESTINATION_NATIVE_SCENE_UNAVAILABLE"};
  const priorLink=registry.snapshot().links?.[pilotID];
  if(Number(priorLink?.entityID)!==id||Number(priorLink?.systemID)!==source)
   return {success:false,errorMsg:"SOURCE_IDENTITY_MISMATCH"};
  const beforeEntity=store.getNativeEntity(id),beforeController=store.getNativeController(id);
  if(Number(beforeEntity?.systemID)!==source||Number(beforeController?.systemID)!==source)
   return {success:false,errorMsg:"SOURCE_NATIVE_RECORD_MISMATCH"};
  const originalModules=clone(store.listNativeModulesForEntity(id)||[]),
   originalCargo=clone(store.listNativeCargoForEntity(id)||[]);
  const moduleSig=itemsSignature(originalModules),
   cargoSig=itemsSignature(originalCargo);
  if(fs.existsSync(journalFile(pilotID)))
   return {success:false,errorMsg:"UNRESOLVED_NATIVE_TRANSFER_JOURNAL"};
  const entry={version:1,pilotID,entityID:id,sourceSystemID:source,
   destinationSystemID:dest,startedAt:clock(),phase:"PREPARED",
   restoreEntity:clone(beforeEntity),restoreController:clone(beforeController),
   restoreModules:originalModules,restoreCargo:originalCargo};
  try{save(pilotID,entry);}
  catch(error){return {success:false,errorMsg:"TRANSFER_JOURNAL_NOT_WRITABLE"};}
  try{
   const removed=service.dematerializeNativeController(controller,{persistState:true,broadcast:true});
   if(removed?.success!==true||physical(sourceScene,id))throw Error("SOURCE_DEMATERIALIZE_FAILED");
   // The store now carries the authoritative final state captured by EveJS.
   entry.restoreEntity=clone(store.getNativeEntity(id));
   entry.restoreController=clone(store.getNativeController(id));
   if(Number(entry.restoreEntity?.systemID)!==source||
    Number(entry.restoreController?.systemID)!==source)throw Error("DEMATERIALIZE_STATE_MISSING");
   entry.phase="SOURCE_REMOVED";save(pilotID,entry);
   const point={...destinationGate.position};
   // Do not materialize on the center of a gate model.
   point.x+=20000;
   write("upsertNativeEntity",{...entry.restoreEntity,systemID:dest,
    position:point,targetPoint:point,velocity:{x:0,y:0,z:0},
    speedFraction:0,mode:"STOP",targetEntityID:0});
   write("upsertNativeController",{...entry.restoreController,
    systemID:dest,anchorKind:"stargate",anchorID:Number(gate.destinationGateID),
    homePosition:point,currentTargetID:0,preferredTargetID:0,
    lastAggressorID:0,manualOrder:null,returningHome:false,nextThinkAtMs:0});
   entry.phase="DESTINATION_RECORDS_WRITTEN";save(pilotID,entry);
   const materialized=service.materializeStoredNativeController(destinationScene,id,{broadcast:true});
   if(materialized?.success!==true||physical(sourceScene,id)||
    !physical(destinationScene,id)||Number(store.getNativeEntity(id)?.systemID)!==dest||
    Number(store.getNativeController(id)?.systemID)!==dest)
    throw Error("DESTINATION_NATIVE_MATERIALIZATION_FAILED");
   if(itemsSignature(store.listNativeModulesForEntity(id)||[])!==moduleSig||
    itemsSignature(store.listNativeCargoForEntity(id)||[])!==cargoSig)
    throw Error("NATIVE_FITTING_OR_CARGO_CHANGED");
   const moved=registry.relocate(pilotID,source,id,dest);
   if(moved.status!=="RELOCATED")throw Error("DURABLE_IDENTITY_RELOCATION_FAILED:"+moved.status);
   // A successful relocation must NOT be rolled back merely because
   // journal cleanup or the final journal update fails.
   entry.phase="COMMITTED";
   try{save(pilotID,entry);}catch(_ignored){}
   try{remove(pilotID);}catch(_ignored){/* recoverPending clears later */}
   return {success:true,entityID:id,systemID:dest,
    verifiedSourceAbsent:true,verifiedDestinationPresent:true,
    preservedCargo:true,preservedModules:true};
  }catch(error){
   try{rollback(entry);remove(pilotID);
    return {success:false,errorMsg:String(error.message).slice(0,100),rolledBack:true};}
   catch(recoveryError){
    try{entry.phase="NEEDS_OPERATOR_REPAIR";save(pilotID,entry);}catch(_ignored){}
    return {success:false,errorMsg:"NATIVE_TRANSFER_REPAIR_REQUIRED",
     reason:String(recoveryError.message).slice(0,100)};
   }
  }
 }
 return {transfer,recoverPending};
}
module.exports={createNativeGateTransfer};
