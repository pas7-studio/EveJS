"use strict";
// FW-007B: one durable military handoff ledger in the EXISTING fleet SQL row.
// The scene + native entity, JSON pilot link and SQLite fleet row are not
// a single ACID transaction. Fence intermediate states, do not infer success.
const crypto=require("node:crypto");
const fleet=require("./coopWarFleetRegistry"+(__filename.endsWith(".js")?"":".cjs"));
const warStore=require("./coopFactionWarStore"+(__filename.endsWith(".js")?"":".cjs"));
const treasury=require("./coopWarTreasury"+(__filename.endsWith(".js")?"":".cjs"));
const warCore=require("./coopFactionWarCore"+(__filename.endsWith(".js")?"":".cjs"));
const {readRow}=require("./coopNativeRowPath"+(__filename.endsWith(".js")?"":".cjs"));
const pos=x=>Number.isSafeInteger(x)&&x>0;
const owns=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const key=x=>typeof x==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x);
const phase=new Set(["PREPARED","NATIVE_COMMITTED","COMPLETE","ABORTED"]);
function fingerprint(rows,idKey){
 if(!Array.isArray(rows)||rows.length>2048)return null;
 const seen=new Set();
 const sorted=[];
 for(const v of rows){
  const id=v?.[idKey];
  if(!pos(id)||seen.has(id)||v?.transient===true)return null;
  seen.add(id);sorted.push(v);
 }
 sorted.sort((a,b)=>a[idKey]-b[idKey]);
 return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
function createWarTransferLedger({gameStore,identityRegistry,sceneForSystem,
 nativeStore,getController,clock=()=>Date.now(),env=process.env,
 verifyJournalClosed=()=>false}={}){
 if(typeof gameStore?.coopAtomicNativeRows?.transact!=="function"||
  typeof identityRegistry?.snapshot!=="function"||
  [sceneForSystem,getController,clock].some(x=>typeof x!=="function")||
  typeof verifyJournalClosed!=="function"||
  !nativeStore||["getNativeEntity","listNativeModulesForEntity",
   "listNativeCargoForEntity"].some(x=>typeof nativeStore[x]!=="function"))
  throw Error("WAR_HANDOFF_NATIVE_AUTHORITIES_REQUIRED");
 const enabled=()=>env.EVEJS_COOP_FACTION_WAR==="1"&&
  env.EVEJS_COOP_FACTION_WAR_FLEETS==="1"&&
  env.EVEJS_COOP_FACTION_WAR_NATIVE_TRANSFER==="1"&&
  env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1";
 const transact=fn=>gameStore.coopAtomicNativeRows.transact([fleet.TABLE],fn);
 // FW-041: an ABSENT fleet row is a world that has never registered a warship.
 // There is no hull and therefore no flight: that is CLEAN, not corrupt. Every
 // reader used to call fleet.validate(tx.get(...)) directly, so a fresh world
 // threw FW_FLEET_REGISTRY_INVALID on every gate-staging tick (the phase died
 // before it could even stage a real hull). A row that DOES exist must still
 // validate - real corruption is never reported as "no data".
 function stateIn(tx){
  const raw=tx.get(fleet.TABLE,fleet.KEY);
  if(raw===undefined||raw===null)return null;
  return fleet.validate(raw);
 }
 function inspect(row,systemID,physical){
  try{
   const scene=sceneForSystem(systemID);
   if(scene?.systemID!==systemID||typeof scene.getEntityByID!=="function")
    return null;
   const ship=scene.getEntityByID(row.entityID);
   const native=nativeStore.getNativeEntity(row.entityID),
    c=getController(row.entityID);
   if(physical===true){
    if(ship?.kind!=="ship"||ship.nativeNpc!==true||
     ship.itemID!==row.entityID||ship.session?.characterID||
     ship.corporationID!==row.corporationID||
     native?.entityID!==row.entityID||native.systemID!==systemID||
     native.corporationID!==row.corporationID||
     c?.entityID!==row.entityID||c.systemID!==systemID)return null;
   }else{
    if(ship||native?.systemID===systemID||c?.systemID===systemID)return null;
   }
   return {ship,native,controller:c};
  }catch{return null}
 }
 function identity(row,systemID){
  try{
   const links=identityRegistry.snapshot()?.links;
   const link=links?.[row.pilotID];
   if(!link||link.entityID!==row.entityID||link.systemID!==systemID)
    return false;
   return Object.values(links).filter(x=>x?.entityID===row.entityID||
    x?.pilotID===row.pilotID).length===1;
  }catch{return false}
 }
 function digests(row){
  try{
   const modules=nativeStore.listNativeModulesForEntity(row.entityID),
    cargo=nativeStore.listNativeCargoForEntity(row.entityID);
   return {modules:fingerprint(modules,"moduleID"),
    cargo:fingerprint(cargo,"cargoID")};
  }catch{return {modules:null,cargo:null}}
 }
 function validate(row,entry){
  if(!row||!entry||!key(entry.transferID)||!phase.has(entry.phase)||
   !pos(entry.entityID)||!pos(entry.sourceSystemID)||
   !pos(entry.destinationSystemID)||entry.sourceSystemID===entry.destinationSystemID||
   !key(entry.campaignID)||!key(entry.warID)||!key(entry.pilotID.replace(/^coop-pilot-/,"p"))||
   !/^[a-f0-9]{64}$/.test(entry.modulesHash)||!/^[a-f0-9]{64}$/.test(entry.cargoHash)||
   row.entityID!==entry.entityID||row.pilotID!==entry.pilotID||
   row.campaignID!==entry.campaignID||row.warID!==entry.warID)
   throw Error("WAR_HANDOFF_RECORD_CORRUPT");
 }
 function operation(type,req){
  if(!enabled())return {status:"DISABLED"};
  const id=req?.entityID,transferID=req?.transferID;
  if(!pos(id)||!["BEGIN","NATIVE_COMMIT","FINISH","ABORT","RESTORE"].includes(type)||
   (type==="BEGIN"?(transferID!==undefined&&!key(transferID)):
    !key(transferID)))
   return {status:"BLOCKED",reason:"INVALID_WAR_HANDOFF_COMMAND"};
  return transact(tx=>{
   const s=stateIn(tx);
   const row=s?s.ships[String(id)]:null;
   if(!row)return {status:"BLOCKED",reason:"WAR_HULL_NOT_REGISTERED"};
   if(!s.transfers)s.transfers={};
   if(Object.keys(s.transfers).length>128)
    return {status:"BLOCKED",reason:"WAR_HANDOFF_LEDGER_CAP"};
   const prior=s.transfers[String(id)];
   const timestamp=clock();
   if(!pos(timestamp))throw Error("WAR_HANDOFF_CLOCK_INVALID");
   let entry;
   if(type==="BEGIN"){
    if(prior)return {status:"BLOCKED",reason:"WAR_HANDOFF_ALREADY_RECORDED"};
    const {sourceSystemID:from,destinationSystemID:to}=req;
    if(!pos(from)||!pos(to)||from===to||row.systemID!==from||
     !identity(row,from)||!inspect(row,from,true)||!inspect(row,to,false))
     return {status:"BLOCKED",reason:"WAR_HANDOFF_SOURCE_UNVERIFIED"};
    const w=tx.get(fleet.TABLE,warStore.KEY),
     t=tx.get(fleet.TABLE,treasury.KEY),
     campaign=w?.campaigns?.[row.campaignID],war=w?.wars?.[row.warID],
     funds=t?.reservations?.[campaign?.supplyReservationID];
    // The crossing leg is PREPARING *and* ASSAULT (an attacker that is still
    // outside the contested system is exactly the hull that must cross). Supply
    // follows the ONE rule of the war core: a real HELD escrow, or the campaign's
    // own explicit `paper-supply:<campaignID>` waiver. A waived campaign has NO
    // treasury row at all (nothing was ever reserved), so the escrow proof is
    // replaced - not weakened - by that waiver. A transfer moves no money.
    const waived=warCore.paperSupply(campaign);
    const supplyOk=waived||(t?.version===1&&funds?.status==="HELD"&&
     funds.warID===row.warID&&funds.campaignID===row.campaignID&&
     funds.factionID===row.factionID&&pos(funds.cents));
    if(w?.version!==1||!supplyOk||
     war?.state!=="ACTIVE"||
     !["PREPARING","ASSAULT"].includes(String(campaign?.state))||
     campaign.sourceSystemID!==from||campaign.targetSystemID!==to||
     row.factionID!==war.attackerFactionID)
     return {status:"BLOCKED",reason:"WAR_HANDOFF_CAMPAIGN_OR_FUNDS_UNVERIFIED"};
    const hashes=digests(row);
    if(!hashes.modules||!hashes.cargo)
     return {status:"BLOCKED",reason:"WAR_HANDOFF_CUSTODY_UNVERIFIED"};
    const serial=s.nextTransferSerial===undefined?1:s.nextTransferSerial;
    if(!pos(serial)||serial>=Number.MAX_SAFE_INTEGER-1)
     return {status:"BLOCKED",reason:"WAR_HANDOFF_SERIAL_EXHAUSTED"};
    const issuedID="fw:"+id+":"+from+":"+to+":"+serial;
    if(transferID!==undefined&&transferID!==issuedID)
     return {status:"BLOCKED",reason:"WAR_HANDOFF_SEQUENCE_CONFLICT"};
    s.nextTransferSerial=serial+1;
    entry={transferID:issuedID,entityID:id,pilotID:row.pilotID,
     warID:row.warID,campaignID:row.campaignID,
     sourceSystemID:from,destinationSystemID:to,
     modulesHash:hashes.modules,cargoHash:hashes.cargo,
     phase:"PREPARED",createdAt:timestamp,updatedAt:timestamp};
   }else{
    if(!prior||prior.transferID!==transferID)
     return {status:"BLOCKED",reason:"WAR_HANDOFF_RECEIPT_MISSING"};
    validate(row,prior);
    if(type==="NATIVE_COMMIT"){
     if(prior.phase!=="PREPARED"||row.systemID!==prior.sourceSystemID||
      !identity(row,prior.sourceSystemID)||
      !inspect(row,prior.sourceSystemID,false)||
      !inspect(row,prior.destinationSystemID,true))
      return {status:"BLOCKED",reason:"WAR_HANDOFF_NATIVE_DESTINATION_UNVERIFIED"};
     const hashes=digests(row);
     if(hashes.modules!==prior.modulesHash||hashes.cargo!==prior.cargoHash)
      return {status:"BLOCKED",reason:"WAR_HANDOFF_CUSTODY_CHANGED"};
     row.systemID=prior.destinationSystemID;
     entry={...prior,phase:"NATIVE_COMMITTED",updatedAt:timestamp};
    }else if(type==="FINISH"){
     if(prior.phase!=="NATIVE_COMMITTED"||
      row.systemID!==prior.destinationSystemID||
      !identity(row,prior.destinationSystemID)||
      !inspect(row,prior.destinationSystemID,true)||
      !inspect(row,prior.sourceSystemID,false))
      return {status:"BLOCKED",reason:"WAR_HANDOFF_IDENTITY_NOT_COMMITTED"};
     const hashes=digests(row);
     if(hashes.modules!==prior.modulesHash||hashes.cargo!==prior.cargoHash)
      return {status:"BLOCKED",reason:"WAR_HANDOFF_CUSTODY_CHANGED"};
     entry={...prior,phase:"COMPLETE",updatedAt:timestamp};
    }else if(type==="ABORT"||type==="RESTORE"){
     const expected=type==="ABORT"?"PREPARED":"NATIVE_COMMITTED";
     if(prior.phase!==expected||
      row.systemID!==(type==="ABORT"?prior.sourceSystemID:prior.destinationSystemID)||
      !identity(row,prior.sourceSystemID)||
      !inspect(row,prior.sourceSystemID,true)||
      !inspect(row,prior.destinationSystemID,false))
      return {status:"BLOCKED",reason:"WAR_HANDOFF_SOURCE_NOT_RESTORED"};
     const hashes=digests(row);
     if(hashes.modules!==prior.modulesHash||hashes.cargo!==prior.cargoHash)
      return {status:"BLOCKED",reason:"WAR_HANDOFF_CUSTODY_CHANGED"};
     if(type==="RESTORE")row.systemID=prior.sourceSystemID;
     entry={...prior,phase:"ABORTED",updatedAt:timestamp};
    }
   }
   s.transfers[String(id)]=entry;
   fleet.validate(s);
   tx.put(fleet.TABLE,fleet.KEY,s);
   return {status:entry.phase,transferID:entry.transferID,entityID:id,
    sourceSystemID:entry.sourceSystemID,
    destinationSystemID:entry.destinationSystemID};
  });
 }
 // A prior trip stays fenced until BOTH systems are physically
 // observed, the pilot/cargo/SQL witnesses are still exact, AND the
 // low-level native gate journal has been safely closed or archived.
 // This is the ONLY path that frees a transferred hull for another hop.
 function retire({entityID,transferID}={}){
  if(!enabled())return {status:"DISABLED"};
  if(!pos(entityID)||!key(transferID))
   return {status:"BLOCKED",reason:"INVALID_RETIRE_REQUEST"};
  const current=witness(entityID);
  if(current.status!=="VERIFIED"||
   current.action!=="CLEANUP_JOURNAL"||
   current.transferID!==transferID)
   return {status:"BLOCKED",reason:"TERMINAL_NATIVE_TRANSFER_NOT_VERIFIED"};
  let cleared=false;
  try{cleared=verifyJournalClosed({
   entityID,pilotID:current.pilotID,transferID,
   sourceSystemID:current.sourceSystemID,
   destinationSystemID:current.destinationSystemID
  })===true}catch{}
  if(!cleared)return {status:"BLOCKED",reason:"NATIVE_TRANSFER_JOURNAL_NOT_CLOSED"};
  return transact(tx=>{
   const state=stateIn(tx);
   if(!state)return {status:"BLOCKED",reason:"RETIRE_STATE_CHANGED"};
   const row=state.ships[String(entityID)],
    prior=state.transfers?.[String(entityID)];
   if(!row||!prior||prior.transferID!==transferID||
    !["COMPLETE","ABORTED"].includes(prior.phase))
    return {status:"BLOCKED",reason:"RETIRE_STATE_CHANGED"};
   // Re-read exact durable physical/native proofs before committing the
   // SQL retirement; an old UI witness alone can never close a flight.
   const destination=prior.phase==="COMPLETE"?
    prior.destinationSystemID:prior.sourceSystemID,
    absent=prior.phase==="COMPLETE"?
    prior.sourceSystemID:prior.destinationSystemID;
   const hashes=digests(row);
   if(row.systemID!==destination||!identity(row,destination)||
    !inspect(row,destination,true)||!inspect(row,absent,false)||
    hashes.modules!==prior.modulesHash||
    hashes.cargo!==prior.cargoHash)
    return {status:"BLOCKED",reason:"RETIRE_NATIVE_PROOF_CHANGED"};
   let stillClear=false;
   try{stillClear=verifyJournalClosed({
    entityID,pilotID:prior.pilotID,transferID,
    sourceSystemID:prior.sourceSystemID,
    destinationSystemID:prior.destinationSystemID
   })===true}catch{}
   if(!stillClear)
    return {status:"BLOCKED",reason:"RETIRE_NATIVE_JOURNAL_CHANGED"};
   if(!Array.isArray(state.transferHistory))state.transferHistory=[];
   if(state.transferHistory.length>=512||
    state.transferHistory.some(h=>h.transferID===transferID))
    return {status:"BLOCKED",reason:"TRANSFER_HISTORY_CAP_OR_REPLAY"};
   const retiredAt=clock();
   if(!pos(retiredAt))throw Error("WAR_TRANSFER_RETIRE_CLOCK_INVALID");
   state.transferHistory.push({...prior,retiredAt});
   delete state.transfers[String(entityID)];
   fleet.validate(state);tx.put(fleet.TABLE,fleet.KEY,state);
   return {status:"RETIRED",transferID,entityID,retiredAt,
    historyCount:state.transferHistory.length};
  });
 }
 function auditPersisted(){
  if(!enabled())return {status:"DISABLED",problems:[]};
  let state;
  try{state=transact(stateIn)}
  catch{return {status:"NEEDS_OPERATOR_REPAIR",problems:[{reason:"SQL_FLEET_NOT_READABLE"}]}}
  // No fleet row at all: nothing was ever registered, so nothing can be wrong.
  if(!state)return {status:"CLEAN",problems:[]};
  const problems=[];
  for(const flight of Object.values(state.transfers||{})){
   const ship=state.ships[String(flight.entityID)];
   if(!ship||!["COMPLETE","ABORTED"].includes(flight.phase)){
    problems.push({entityID:flight.entityID,reason:"TRANSFER_IN_FLIGHT"});continue;
   }
   const system=flight.phase==="COMPLETE"?
    flight.destinationSystemID:flight.sourceSystemID;
   const hashes=digests(ship);
   let native,controller;
   try{
    native=nativeStore.getNativeEntity(ship.entityID);
    controller=nativeStore.getNativeController(ship.entityID);
   }catch{}
   if(typeof nativeStore.getNativeController!=="function"||
    ship.systemID!==system||!identity(ship,system)||
    native?.entityID!==ship.entityID||native.systemID!==system||
    native.corporationID!==ship.corporationID||
    controller?.entityID!==ship.entityID||controller.systemID!==system||
    hashes.modules!==flight.modulesHash||
    hashes.cargo!==flight.cargoHash)
    problems.push({entityID:ship.entityID,reason:"COMPLETED_NATIVE_CUSTODY_DRIFT"});
  }
  return {status:problems.length?"NEEDS_OPERATOR_REPAIR":"CLEAN",
   problems:problems.slice(0,50)};
 }
 // Source-backed read-only witness. A witnessed native row is evidence
 // only when BOTH physical scenes are currently loaded; missing scenes are
 // never treated as an absent ship.
 function witness(entityID){
  if(!enabled())return {status:"DISABLED"};
  if(!pos(entityID))return {status:"INVALID_ENTITY"};
  let state;
  try{state=transact(tx=>{const s=stateIn(tx);return s?structuredClone(s):null})}
  catch{return {status:"UNAVAILABLE",reason:"FLEET_SQL_READ_FAILED"}}
  if(!state)return {status:"NO_ACTIVE_TRANSFER"};
  const row=state.ships[String(entityID)],
   flight=state.transfers?.[String(entityID)];
  if(!row||!flight)return {status:"NO_ACTIVE_TRANSFER"};
  try{validate(row,flight)}catch{return {status:"UNSAFE",reason:"CORRUPT_TRANSFER"}}
  const from=flight.sourceSystemID,to=flight.destinationSystemID;
  let fromScene,toScene,entity,controller,links;
  try{
   fromScene=sceneForSystem(from);toScene=sceneForSystem(to);
   entity=nativeStore.getNativeEntity(entityID);
   controller=getController(entityID);
   links=identityRegistry.snapshot()?.links;
  }catch{return {status:"UNSAFE",reason:"NATIVE_READ_FAILED"}}
  if(fromScene?.systemID!==from||toScene?.systemID!==to||
   typeof fromScene.getEntityByID!=="function"||
   typeof toScene.getEntityByID!=="function")
   return {status:"UNSAFE",reason:"PHYSICAL_SCENE_NOT_LOADED"};
  let sourceShip,destinationShip;
  try{
   sourceShip=fromScene.getEntityByID(entityID);
   destinationShip=toScene.getEntityByID(entityID);
  }catch{return {status:"UNSAFE",reason:"SCENE_LOOKUP_FAILED"}}
  if(Boolean(sourceShip)===Boolean(destinationShip))
   return {status:"UNSAFE",reason:sourceShip?"DUPLICATE_PHYSICAL_HULL":"NO_PHYSICAL_HULL"};
  const physicalSystemID=sourceShip?from:to,ship=sourceShip||destinationShip,
   nativeID=entity?.entityID,controllerID=controller?.entityID;
  if(ship?.kind!=="ship"||ship.nativeNpc!==true||
   ship.itemID!==entityID||ship.session?.characterID||
   ship.corporationID!==row.corporationID||
   nativeID!==entityID||controllerID!==entityID||
   entity.systemID!==physicalSystemID||controller.systemID!==physicalSystemID||
   entity.corporationID!==row.corporationID)
   return {status:"UNSAFE",reason:"NATIVE_ENTITY_OR_CONTROLLER_MISMATCH"};
  const link=links?.[flight.pilotID];
  if(!link||link.entityID!==entityID||
   ![from,to].includes(link.systemID)||
   Object.values(links).filter(v=>v?.entityID===entityID||
    v?.pilotID===flight.pilotID).length!==1)
   return {status:"UNSAFE",reason:"PILOT_IDENTITY_CONFLICT"};
  const hashes=digests(row);
  if(hashes.modules!==flight.modulesHash||hashes.cargo!==flight.cargoHash)
   return {status:"UNSAFE",reason:"MODULE_OR_CARGO_FINGERPRINT_CHANGED"};
  let action=null;
  if(flight.phase==="PREPARED"&&row.systemID===from){
   if(physicalSystemID===from&&link.systemID===from)action="ABORT";
   else if(physicalSystemID===to&&link.systemID===from)action="NATIVE_COMMIT";
  }else if(flight.phase==="NATIVE_COMMITTED"&&row.systemID===to){
   if(physicalSystemID===to&&link.systemID===from)action="RELOCATE_PILOT";
   else if(physicalSystemID===to&&link.systemID===to)action="FINISH";
   else if(physicalSystemID===from&&link.systemID===from)action="RESTORE";
  }else if(flight.phase==="COMPLETE"&&row.systemID===to&&
   physicalSystemID===to&&link.systemID===to)action="CLEANUP_JOURNAL";
  else if(flight.phase==="ABORTED"&&row.systemID===from&&
   physicalSystemID===from&&link.systemID===from)action="CLEANUP_JOURNAL";
  if(!action)return {status:"UNSAFE",reason:"UNSUPPORTED_CROSS_STORE_CONFIGURATION"};
  return {status:"VERIFIED",action,entityID,
   transferID:flight.transferID,pilotID:flight.pilotID,
   phase:flight.phase,rowSystemID:row.systemID,
   physicalSystemID,pilotSystemID:link.systemID,
   sourceSystemID:from,destinationSystemID:to,
   modulesHash:hashes.modules,cargoHash:hashes.cargo,
   updatedAt:flight.updatedAt};
 }
 // Explicit administrative intent is recorded BEFORE the authorized
 // action, inside the same durable fleet SQL row. It is an attempted action,
 // not a false claim of completion after a crash between durable owners.
 function recordRecoveryAttempt({entityID,transferID,action,
  witnessHash,principalID,reason}={}){
  if(!enabled())return {status:"DISABLED"};
  if(!pos(entityID)||!key(transferID)||
   !["ABORT","NATIVE_COMMIT","RELOCATE_PILOT","FINISH",
    "RESTORE","CLEANUP_JOURNAL","RETIRE_TRANSFER"].includes(action)||
   typeof principalID!=="string"||
   !/^[A-Za-z0-9_.:@-]{3,100}$/.test(principalID)||
   typeof reason!=="string"||reason.trim().length<12||
   reason.length>240||!/^[a-f0-9]{64}$/.test(witnessHash))
   return {status:"INVALID_ADMIN_AUDIT"};
  const auditID=crypto.createHash("sha256").update(
   [transferID,action,witnessHash,principalID,reason.trim()].join("|")).digest("hex");
  return transact(tx=>{
   const state=stateIn(tx);
   if(!state)return {status:"BLOCKED",reason:"TRANSFER_NO_LONGER_PRESENT"};
   const row=state.ships[String(entityID)],
    flight=state.transfers?.[String(entityID)];
   if(!row||!flight||flight.transferID!==transferID)
    return {status:"BLOCKED",reason:"TRANSFER_NO_LONGER_PRESENT"};
   if(!Array.isArray(state.recoveryAudit))state.recoveryAudit=[];
   const previous=state.recoveryAudit.find(x=>x.id===auditID);
   if(previous)return {status:"ALREADY_RECORDED",auditID};
   const at=clock();
   if(!pos(at))throw Error("WAR_RECOVERY_AUDIT_CLOCK_UNSAFE");
   state.recoveryAudit.push({id:auditID,entityID,transferID,
    action,witnessHash,principalID,reason:reason.trim(),at,
    phaseWhenRequested:flight.phase});
   if(state.recoveryAudit.length>128)
    state.recoveryAudit.splice(0,state.recoveryAudit.length-128);
   fleet.validate(state);
   tx.put(fleet.TABLE,fleet.KEY,state);
   return {status:"RECORDED",auditID};
  });
 }
 // Cheap idle-tick discovery. Only source-confirmed TERMINAL records
 // are eligible for archive; every actual retirement rechecks physical
 // ship, native controller, unique pilot and module/cargo in SQLite tx.
 function terminalCandidates(){
  if(!enabled())return [];
  let state;
  try{
   if(typeof gameStore.read==="function"){
    const r=readRow(gameStore,fleet.TABLE,fleet.KEY);
    if(!r)throw Error("NATIVE_FLEET_CACHE_UNAVAILABLE");
    state=fleet.validate(r);
   }else state=transact(tx=>fleet.validate(tx.get(fleet.TABLE,fleet.KEY)));
  }catch{return []}
  return Object.values(state.transfers||{}).filter(t=>
   t&&["COMPLETE","ABORTED"].includes(t.phase)&&pos(t.entityID)&&
   key(t.transferID)).sort((a,b)=>a.entityID-b.entityID).slice(0,32)
   .map(t=>({entityID:t.entityID,transferID:t.transferID}));
 }
 function pending(){
  if(!enabled())return {status:"DISABLED",pending:[]};
  const state=transact(stateIn);
  // A world with no registered warship has no flight to repair.
  if(!state)return {status:"CLEAN",pending:[]};
  const entries=Object.values(state.transfers||{});
  return {status:entries.some(x=>!["COMPLETE","ABORTED"].includes(x.phase))?
   "NEEDS_OPERATOR_REPAIR":"CLEAN",
   pending:entries.filter(x=>!["COMPLETE","ABORTED"].includes(x.phase))
    .map(x=>({transferID:x.transferID,entityID:x.entityID,phase:x.phase,
     sourceSystemID:x.sourceSystemID,destinationSystemID:x.destinationSystemID}))};
 }
 return Object.freeze({
  begin:request=>operation("BEGIN",request),
  nativeCommit:request=>operation("NATIVE_COMMIT",request),
  finish:request=>operation("FINISH",request),
  abort:request=>operation("ABORT",request),
  restore:request=>operation("RESTORE",request),
  auditPersisted,
  witness,
  recordRecoveryAttempt,
  retire,
  terminalCandidates,
  pending
 });
}
module.exports={createWarTransferLedger,fingerprint};
