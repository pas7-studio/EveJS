"use strict";
/**
 * ALIFE-08. Native persistent startup mining fleets.
 *
 * npcEntities.coopMiningFleetSlots is ONLY a durable slot witness; the original
 * nativeNpcStore entity/controller/module/cargo rows remain sole authorities.
 * A PREPARING slot is quarantined after a crash: NEVER guess that it is safe
 * to re-spawn ships, even if no hull currently appears in scene memory.
 */
const MAX_SLOTS=16, MAX_WING=32;
const busy=new Set();
// Slot status used to be invisible: start() was called without a log callback and
// its result was discarded, so a blocked slot looked exactly like a healthy one in
// the event log. One event per real status change, never per scene tick.
const lastSlotStatus=new Map();
function noteSlotStatus(systemID,reports){
 let guard=null;
 try{
  guard={observe:require("./coopObserve"),probe:require("./coopRuntimeProbe")};
 }catch(_error){return;}
 for(const report of reports||[]){
  const key=systemID+"-"+report.slot;
  const signature=[report.status,report.reason||"",
   (report.minerIDs||[]).length,(report.haulerIDs||[]).length].join("|");
  if(lastSlotStatus.get(key)===signature)continue;
  lastSlotStatus.set(key,signature);
  try{
   guard.observe.observe(guard.probe,"living-native-durable-slot",{systemID},{
    status:String(report.status),slot:Number(report.slot)||0,
    reason:report.reason?String(report.reason).slice(0,160):null,
    miners:(report.minerIDs||[]).length,haulers:(report.haulerIDs||[]).length,
    liveMiners:Number.isInteger(report.liveMiners)?report.liveMiners:-1,
    liveHaulers:Number.isInteger(report.liveHaulers)?report.liveHaulers:-1,
    restored:Number(report.restored)||0,controllers:Number(report.controllers)||0,
    reseededFrom:report.reseededFrom?String(report.reseededFrom):null,
    repaired:report.repaired===true,
    recomposed:report.recomposed===true,
   });
  }catch(_error){}
 }
}
const pos=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):0;
const clone=x=>JSON.parse(JSON.stringify(x));
function slotKey(systemID,slot){return systemID+"-"+slot;}
// Stable across restarts, disjoint by system and slot; no virtual ship ID.
function fleetIDForSlot(systemID,slot){
 const id=Number(systemID)*32+Number(slot);
 return pos(systemID)&&Number.isSafeInteger(Number(slot))&&slot>=1&&slot<=MAX_SLOTS&&
   Number.isSafeInteger(id)&&id>0?id:0;
}
function roleMarker(systemID,slot,role){
 return "coop-mining-"+systemID+"-"+slot+"-"+role;
}
function result(status,slot,extra={}){return {status,slot,...extra};}
function readSlot(db,key){
 const r=db.read("npcEntities","/coopMiningFleetSlots/"+key);
 if(r?.success===true)return r.data;
 if(r?.errorMsg==="ENTRY_NOT_FOUND")return null;
 throw Error("ALIFE08_SLOT_READ_UNAVAILABLE:"+String(r?.errorMsg));
}
function saveSlot(db,key,record){
 const data=clone(record);
 if(db.write("npcEntities","/coopMiningFleetSlots/"+key,data)?.success!==true)
   throw Error("ALIFE08_SLOT_WRITE_FAILED");
 const flushed=db.flushTableSync("npcEntities",{log:false});
 if(flushed?.success!==true)throw Error("ALIFE08_SLOT_FLUSH_FAILED");
 const observed=readSlot(db,key);
 if(!observed||JSON.stringify(observed)!==JSON.stringify(data))
   throw Error("ALIFE08_SLOT_READBACK_FAILED");
 return data;
}
function ids(values){
 if(!Array.isArray(values)||values.length>MAX_WING)return null;
 const out=values.map(pos);
 return out.every(Boolean)&&new Set(out).size===out.length?out:null;
}
function markers(store,systemID,slot){
 const all=store.listNativeEntitiesForSystem(systemID);
 if(!Array.isArray(all))throw Error("ALIFE08_NATIVE_ENTITY_LIST_UNAVAILABLE");
 const miners=[],haulers=[],invalid=[];
 for(const e of all){
  const id=pos(e?.entityID),mark=String(e?.operatorKind||"");
  if(!mark.startsWith("coop-mining-"+systemID+"-"+slot+"-"))continue;
  if(mark===roleMarker(systemID,slot,"miner"))miners.push(id);
  else if(mark===roleMarker(systemID,slot,"hauler"))haulers.push(id);
  else invalid.push(id);
 }
 return {miners,haulers,invalid};
}
// A witness can survive a whole scene generation whose ships were never durable:
// the record says ACTIVE, the hulls are gone and nothing will ever match it again.
// That is abandonment, not a crash, and it is provable read-only: no durable row,
// no physical ship, no cargo row and no module row may refer to those IDs.
// Anything a provably absent hull left behind (fitted items, and ore it mined)
// is unreachable by any live ship. It is archived verbatim under the slot's key
// instead of being deleted or silently ignored, so the audit trail survives.
function archiveOrphanRows({db,store,key,entityID}){
 const out={modules:0,cargo:0};
 const modules=store.listNativeModulesForEntity(entityID);
 if(!Array.isArray(modules)||!Array.isArray(store.listNativeCargoForEntity(entityID)))
  throw Error("ALIFE08_ORPHAN_ROW_LIST_UNAVAILABLE:"+entityID);
 const cargo=store.listNativeCargoForEntity(entityID);
 for(const [kind,rows] of [["modules",modules],["cargo",cargo]]){
  if(!rows.length)continue;
  const target="/coopMiningFleetSlotsArchive/"+key+"-"+kind+"-"+entityID+"-"+Date.now();
  if(db.write("npcEntities",target,rows)?.success!==true)
   throw Error("ALIFE08_ORPHAN_ARCHIVE_WRITE_FAILED:"+kind+":"+entityID);
  if(db.flushTableSync("npcEntities",{log:false})?.success!==true)
   throw Error("ALIFE08_ORPHAN_ARCHIVE_FLUSH_FAILED:"+kind+":"+entityID);
  // The archive is durable, so custody can now move: the orphan rows are
  // removed from the live store instead of lingering as unreachable ghosts.
  for(const row of rows){
   const removed=kind==="modules"
    ? store.removeNativeModule(row.moduleID)
    : store.removeNativeCargo(row.cargoID);
   if(removed?.success!==true&&removed!==true)
    throw Error("ALIFE08_ORPHAN_REMOVE_FAILED:"+kind+":"+entityID);
  }
  out[kind]=rows.length;
 }
 return out;
}
function slotIsAbandoned({scene,store,systemID,slot,entityIDs}){
 if(process.env.EVEJS_COOP_NATIVE_MINING_SLOT_RECONCILE!=="1")return false;
 if(!Array.isArray(entityIDs)||!entityIDs.length)return false;
 const found=markers(store,systemID,slot);
 if(found.miners.length||found.haulers.length||found.invalid.length)return false;
 for(const id of entityIDs){
  if(store.getNativeEntity(id)||store.getNativeController(id))return false;
  if(scene?.getEntityByID?.(id))return false;
  if(!Array.isArray(store.listNativeCargoForEntity(id))||
     !Array.isArray(store.listNativeModulesForEntity(id)))
   throw Error("ALIFE08_ORPHAN_ROW_LIST_UNAVAILABLE:"+id);
 }
 return true;
}
// The old witness is archived, never deleted, so an operator can still see what
// the slot claimed before it was re-seeded.
function archiveSlot(db,key,record){
 const data=clone(record);
 if(db.write("npcEntities","/coopMiningFleetSlotsArchive/"+key+"-"+Date.now(),data)?.success!==true)
  throw Error("ALIFE08_SLOT_ARCHIVE_WRITE_FAILED");
 if(db.flushTableSync("npcEntities",{log:false})?.success!==true)
  throw Error("ALIFE08_SLOT_ARCHIVE_FLUSH_FAILED");
 return true;
}
// A runtime fleet record can outlive some or all of its physical ships. Any
// listed ship that is NOT the survivor set and no longer exists (no durable row,
// no physical entity) is simply stale: re-point the record at the ships that
// really exist. A record that still owns a live foreign ship is never touched.
function adoptStaleRuntimeFleet({scene,store,fleet,key,minerIDs,haulerIDs}){
 const listed=[...(fleet.minerEntityIDs||[]),...(fleet.haulerEntityIDs||[])]
  .map(pos).filter(Boolean);
 const target=new Set([...minerIDs,...haulerIDs]);
 const foreign=listed.filter(id=>!target.has(id));
 // No foreign ship at all: the record is merely incomplete (the native tick
 // prunes a ship it has no controller for). Widen it to the verified witness.
 if(!foreign.length){
  fleet.startupKey=key;
  fleet.minerEntityIDs=[...minerIDs];
  fleet.haulerEntityIDs=[...haulerIDs];
  return {adopted:true,detached:[]};
 }
 if(process.env.EVEJS_COOP_NATIVE_MINING_SLOT_RECONCILE!=="1"){
  // Without the reconcile flag a foreign ship is still treated as a real owner.
  if(foreign.some(id=>scene.getEntityByID(id)))return {adopted:false,detached:[]};
 }
 // The witness was verified against the native store and the scene, so it is the
 // authority. A stale record is re-pointed at it; any old hull that is still
 // physically here is only DETACHED (reported, never destroyed).
 const detached=foreign.filter(id=>scene.getEntityByID(id));
 fleet.startupKey=key;
 fleet.minerEntityIDs=[...minerIDs];
 fleet.haulerEntityIDs=[...haulerIDs];
 return {adopted:true,detached};
}
// A slot can lose SOME ships while the rest survive (a hull that was never
// durable, or a failed restore). The survivors keep their cargo and custody, so
// the slot must not be re-seeded wholesale and must not stay blocked forever:
// only the provably missing roles are allocated again, and the witness is merged.
// A missing ID that still owns cargo or modules is never replaced.
function repairPartialSlot({scene,store,systemID,slot,key,db,spawn,ensureState,minerIDs,haulerIDs}){
 if(process.env.EVEJS_COOP_NATIVE_MINING_SLOT_RECONCILE!=="1")return null;
 const aliveMin=minerIDs.filter(id=>store.getNativeEntity(id)||scene.getEntityByID(id));
 const aliveHau=haulerIDs.filter(id=>store.getNativeEntity(id)||scene.getEntityByID(id));
 const missingMin=minerIDs.length-aliveMin.length;
 const missingHau=haulerIDs.length-aliveHau.length;
 if(!missingMin&&!missingHau)return null;
 let archivedModules=0,archivedCargo=0;
 for(const id of [...minerIDs,...haulerIDs]){
  if(aliveMin.includes(id)||aliveHau.includes(id))continue;
  const archived=archiveOrphanRows({db,store,key,entityID:id});
  archivedModules+=archived.modules;
  archivedCargo+=archived.cargo;
 }
 // The scene mining state must exist BEFORE allocating, exactly like a first
 // seed: without it the fresh hulls are created as scene-only actors and their
 // durable rows never reach the store.
 ensureState();
 const born=spawn(slot,{miners:missingMin,haulers:missingHau});
 if(!born?.success||!born.data||born.data.minerSpawnResult?.data?.partialFailure||
     born.data.haulerSpawnResult?.data?.partialFailure)
  throw Error("ALIFE08_PARTIAL_NATIVE_SPAWN");
 const newMin=ids(born.data.minerEntityIDs||[]),newHau=ids(born.data.haulerEntityIDs||[]);
 if(!newMin||!newHau||newMin.length!==missingMin||newHau.length!==missingHau)
  throw Error("ALIFE08_REPAIR_SPAWN_COUNT_MISMATCH");
 const merged={minerEntityIDs:[...aliveMin,...newMin],haulerEntityIDs:[...aliveHau,...newHau]};
 if(merged.minerEntityIDs.length+merged.haulerEntityIDs.length>MAX_WING)
  throw Error("ALIFE08_REPAIR_WING_TOO_LARGE");
 const found=markers(store,systemID,slot);
 const sameSet=(a,b)=>a.length===b.length&&a.every(x=>b.includes(x));
 if(found.invalid.length||!sameSet(found.miners,merged.minerEntityIDs)||
     !sameSet(found.haulers,merged.haulerEntityIDs))
  throw Error("ALIFE08_REPAIR_MARKER_MISMATCH");
 const synced=db.flushTablesSync(["npcEntities","npcRuntimeControllers","npcModules","npcCargo"]);
 if(synced?.success!==true)throw Error("ALIFE08_NATIVE_ACTOR_FLUSH_FAILED");
 const notStored=[...merged.minerEntityIDs,...merged.haulerEntityIDs]
  .filter(id=>!store.getNativeEntity(id));
 if(notStored.length)throw Error("ALIFE08_REPAIR_NOT_IN_STORE:"+notStored.join(","));
 const previous=readSlot(db,key)||{};
 saveSlot(db,key,{...previous,version:1,status:"ACTIVE",systemID,slot,
  fleetID:previous.fleetID||fleetIDForSlot(systemID,slot),
  minerEntityIDs:merged.minerEntityIDs,haulerEntityIDs:merged.haulerEntityIDs,
  repairedAtMs:Date.now(),archivedModules,archivedCargo,
  replacedEntityIDs:[...minerIDs,...haulerIDs].filter(id=>
   !merged.minerEntityIDs.includes(id)&&!merged.haulerEntityIDs.includes(id))});
 return merged;
}
// A durable slot can keep a hull whose class does not match its role. Measured on the
// live world: all three "hauler" slots were Mining Ventures (50 m3 hold) while the
// miners were Hulks and Skiffs, so every strict transfer was refused as "full"
// (needM3 5 243.7 at capacityM3 50) and ore never left the belt.
// The repair is additive and gated by EVEJS_COOP_FLEET_COMPOSITION:
//  - a mis-roled hull with an empty hold is re-marked as an extra MINER: same ship,
//    same entity ID, same modules, same cargo rows;
//  - a real hauler from the composition pool is ADDED for it;
//  - a mis-roled hull that already holds ore is never re-marked, because its cargo
//    would be orphaned: it stays a hauler and a real hauler is added only if the slot
//    has none.
// The result is derived from the REAL marker set, not from the stored witness plus a
// delta. An interrupted attempt (spawn succeeded, witness not yet written) therefore
// converges on the next start instead of accumulating hulls forever - that is exactly
// how the first live attempt ended up with nine miners and six haulers in one slot.
// Nothing is destroyed.
function repairSlotComposition({scene,store,systemID,slot,key,db,spawn,ensureState,
 minerIDs,haulerIDs,log=()=>{}}){
 if(process.env.EVEJS_COOP_FLEET_COMPOSITION!=="1")return null;
 const composition=require("./coopFleetComposition");
 const profileOf=id=>String(store.getNativeController(id)?.profileID||"");
 const same=(a,b)=>a.length===b.length&&a.every(x=>b.includes(x));
 const before=markers(store,systemID,slot);
 if(before.invalid.length)
  throw Error("ALIFE08_RECOMPOSE_MARKER_UNKNOWN:"+before.invalid.join(","));
 const consistent=same(before.miners,minerIDs)&&same(before.haulers,haulerIDs);
 const classified=before.haulers.map(id=>({id,profile:profileOf(id)}));
 for(const row of classified)
  if(!row.profile)throw Error("ALIFE08_RECOMPOSE_PROFILE_UNPROVEN:"+row.id);
 const misRoled=classified.filter(row=>!composition.isHaulerHull(row.profile))
  .map(row=>row.id);
 const realHaulers=classified.length-misRoled.length;
 if(!misRoled.length&&consistent)return null;
 const demotable=misRoled.filter(id=>{
  const cargo=store.listNativeCargoForEntity(id);
  if(!Array.isArray(cargo))throw Error("ALIFE08_RECOMPOSE_CARGO_UNREADABLE:"+id);
  return cargo.length===0;
 });
 const kept=misRoled.filter(id=>!demotable.includes(id));
 // One replacement per demoted hull that the slot cannot already absorb with a real
 // hauler, plus one beside a cargo-holding mis-roled hull only when the slot has no
 // real hauler at all. Zero means "reconcile, do not spawn".
 const addCount=Math.max(0,demotable.length-realHaulers)+
  (kept.length>0&&realHaulers===0?1:0);
 let fresh=[];
 if(addCount>0){
  // The scene mining state must exist BEFORE allocating, exactly like a first seed.
  // NOTE: the pinned wing spawner clamps its miner amount to >= 1, so this allocation
  // also brings one extra miner. That is a real mining hull and it is recorded in the
  // witness below; it is never a reason to spawn again.
  ensureState();
  const born=spawn(slot,{miners:0,haulers:addCount});
  if(!born?.success||!born.data||born.data.haulerSpawnResult?.data?.partialFailure)
   throw Error("ALIFE08_RECOMPOSE_SPAWN_FAILED");
  const list=ids(born.data.haulerEntityIDs||[]);
  if(!list||list.length!==addCount)
   throw Error("ALIFE08_RECOMPOSE_SPAWN_COUNT_MISMATCH:"+String(list&&list.length)+"/"+addCount);
  for(const id of list){
   const profile=profileOf(id);
   if(!composition.isHaulerHull(profile))
    throw Error("ALIFE08_RECOMPOSE_BAD_HAULER_HULL:"+id+":"+profile);
  }
  fresh=list;
 }
 const minerMarker=roleMarker(systemID,slot,"miner");
 for(const id of demotable){
  const entity=store.getNativeEntity(id),controller=store.getNativeController(id);
  if(!entity||!controller||entity.transient===true||controller.transient===true)
   throw Error("ALIFE08_RECOMPOSE_HULL_NOT_DURABLE:"+id);
  if(store.upsertNativeEntity({...entity,operatorKind:minerMarker})?.success!==true ||
     store.upsertNativeController({...controller,operatorKind:minerMarker})?.success!==true)
   throw Error("ALIFE08_RECOMPOSE_REMARK_FAILED:"+id);
 }
 const synced=db.flushTablesSync(["npcEntities","npcRuntimeControllers","npcModules","npcCargo"]);
 if(synced?.success!==true)throw Error("ALIFE08_RECOMPOSE_FLUSH_FAILED");
 // The marker set after the change IS the fleet: an earlier interrupted attempt left
 // real hulls behind, and they are members, not garbage.
 const after=markers(store,systemID,slot);
 if(after.invalid.length||!after.miners.length||!after.haulers.length)
  throw Error("ALIFE08_RECOMPOSE_MARKER_SET_INCOMPLETE");
 const nextMiner=after.miners,nextHauler=after.haulers;
 if(nextMiner.length+nextHauler.length>MAX_WING)
  throw Error("ALIFE08_RECOMPOSE_WING_TOO_LARGE");
 verifyActors({scene,store,systemID,slot,minerIDs:nextMiner,haulerIDs:nextHauler});
 const previous=readSlot(db,key)||{};
 saveSlot(db,key,{...previous,version:1,status:"ACTIVE",systemID,slot,
  fleetID:previous.fleetID||fleetIDForSlot(systemID,slot),
  minerEntityIDs:nextMiner,haulerEntityIDs:nextHauler,recomposedAtMs:Date.now(),
  demotedHaulerIDs:demotable,addedHaulerIDs:fresh,keptMisroledHaulerIDs:kept});
 const reason=demotable.length?"MISROLED_HAULER_DEMOTED":
  kept.length?"MISROLED_HAULER_HOLDS_CARGO":"WITNESS_MARKER_MISMATCH";
 log("ALIFE08 slot "+key+" composed: reason="+reason+" demoted="+demotable.join(",")+
  " addedHaulers="+fresh.join(",")+" miners="+nextMiner.length+
  " haulers="+nextHauler.length);
 try{
  const guard={observe:require("./coopObserve"),probe:require("./coopRuntimeProbe")};
  guard.observe.observe(guard.probe,"living-fleet-slot-recomposed",{systemID},{
   slot:Number(slot)||0,demoted:demotable.length,added:fresh.length,
   keptMisroled:kept.length,demotedEntityIDs:demotable,addedHaulerIDs:fresh,
   minerCount:nextMiner.length,haulerCount:nextHauler.length,reason});
 }catch(_error){}
 return {minerEntityIDs:nextMiner,haulerEntityIDs:nextHauler,demoted:demotable,
  added:fresh,kept};
}
function verifyActors({scene,store,systemID,slot,minerIDs,haulerIDs}){
 const expected=[...minerIDs,...haulerIDs];
 if(new Set(expected).size!==expected.length)throw Error("ALIFE08_DUPLICATE_SHIP_ID");
 const found=markers(store,systemID,slot);
 if(found.invalid.length ||
    found.miners.length!==minerIDs.length ||
    found.haulers.length!==haulerIDs.length ||
    found.miners.some(x=>!minerIDs.includes(x)) ||
    found.haulers.some(x=>!haulerIDs.includes(x)))
  throw Error("ALIFE08_UNEXPECTED_OR_MISSING_MARKED_SHIPS");
 const check=(id,role)=>{
  // One cached bulk read per window instead of a full entity-collection clone
  // per ship: this loop runs for every marked miner and hauler each pass.
  const cache=require("./coopNativeReadCache"+(__filename.endsWith(".js")?"":".cjs")).nativeCache();
  const entity=cache.entityByID(id)||store.getNativeEntity(id),controller=store.getNativeController(id);
  const marker=roleMarker(systemID,slot,role);
  if(!entity||!controller||entity.transient===true||controller.transient===true ||
     entity.nativeNpc!==true||pos(entity.entityID)!==id||
     pos(controller.entityID)!==id||
     pos(entity.systemID)!==systemID||pos(controller.systemID)!==systemID||
     entity.operatorKind!==marker||controller.operatorKind!==marker||
     String(controller.startupRuleID||"")!=="" ||
     pos(entity.ownerID)===0 ||
     !String(controller.profileID||"").trim())
    throw Error("ALIFE08_PERSISTENT_ACTOR_IDENTITY_CONFLICT:"+id);
  const physical=scene.getEntityByID(id);
  if(physical && (physical.kind!=="ship"||physical.nativeNpc!==true||
      pos(physical.itemID)!==id||pos(physical.ownerID)!==pos(entity.ownerID)))
    throw Error("ALIFE08_SCENE_SHIP_ID_OCCUPIED:"+id);
  const cargo=store.listNativeCargoForEntity(id);
  if(!Array.isArray(cargo)||cargo.some(c=>!pos(c.cargoID)||
      pos(c.entityID)!==id||pos(c.ownerID)!==pos(entity.ownerID)||
      c.transient===true))
    throw Error("ALIFE08_CARGO_CUSTODY_CONFLICT:"+id);
  const modules=store.listNativeModulesForEntity(id);
  if(!Array.isArray(modules)||modules.some(m=>!pos(m.moduleID)||
      pos(m.entityID)!==id||m.transient===true))
    throw Error("ALIFE08_MODULE_CUSTODY_CONFLICT:"+id);
 };
 minerIDs.forEach(id=>check(id,"miner"));
 haulerIDs.forEach(id=>check(id,"hauler"));
}
function registerOnce({scene,store,getFleets,register,slot,minerIDs,haulerIDs,originAnchor,log}){
 const existing=getFleets();
 const key=scene.systemID+":"+slot;
 const stableFleetID=fleetIDForSlot(scene.systemID,slot);
 if(!stableFleetID)throw Error("ALIFE09_INVALID_STABLE_FLEET_ID");
 const conflicts=existing.filter(x=>x.startupKey===key||
   Number(x.fleetID)===stableFleetID);
 if(conflicts.length>1)throw Error("ALIFE08_DUPLICATED_RUNTIME_SLOT");
 if(conflicts.length){
  const fleet=conflicts[0];
  if(fleet.startupKey!==key||Number(fleet.fleetID)!==stableFleetID)
    throw Error("ALIFE09_RUNTIME_FLEET_ID_CONFLICT");
  const a=ids(fleet.minerEntityIDs),b=ids(fleet.haulerEntityIDs);
  if(!a||!b||JSON.stringify(a)!==JSON.stringify(minerIDs)||
     JSON.stringify(b)!==JSON.stringify(haulerIDs)){
   const adoption=adoptStaleRuntimeFleet({scene,store:store,fleet,key,minerIDs,haulerIDs});
   if(adoption.adopted){
    if(adoption.detached.length&&typeof log==="function")
     log("ALIFE08 slot "+key+" re-pointed; detached old hulls: "+adoption.detached.join(","));
    return false;
   }
   throw Error("ALIFE08_RUNTIME_FLEET_SLOT_CONFLICT");
  }
  return false;
 }
 const answer=register(slot,{minerEntityIDs:minerIDs,haulerEntityIDs:haulerIDs,originAnchor});
 if(!answer||String(answer.startupKey)!==key||Number(answer.fleetID)!==stableFleetID)
   throw Error("ALIFE08_NATIVE_FLEET_REGISTRATION_UNKNOWN");
 return true;
}
function createService({db,store,nativeService,ensureState,spawn,register,
  getFleets,auditStartupCargo=null,log=()=>{}}={}){
 if(!db||typeof db.read!=="function"||typeof db.write!=="function"||
    typeof db.flushTableSync!=="function"||typeof db.flushTablesSync!=="function"||
    !store||!nativeService||typeof nativeService.materializeStoredNativeController!=="function"||
    typeof ensureState!=="function"||typeof spawn!=="function"||
    typeof register!=="function"||typeof getFleets!=="function")
  throw Error("ALIFE08_AUTHORITIES_REQUIRED");
 // Original persistent haulers with cargo MUST resume the station trip after
 // cold restart instead of restarting the mining state with unresolved ore.
 function resumePendingStationCargo(scene,slot,haulerIDs){
  if(process.env.EVEJS_COOP_NATIVE_STATION_TRIP_RECOVERY!=="1"||
     process.env.EVEJS_COOP_NATIVE_HAUL_MANIFEST!=="1")return false;
  const id=fleetIDForSlot(scene.systemID,slot);
  const live=getFleets().filter(x=>x.startupKey===scene.systemID+":"+slot&&
    Number(x.fleetID)===id);
  if(live.length!==1)throw Error("ALIFE12_RUNTIME_FLEET_TO_RESUME_NOT_UNIQUE");
  // The corporation's own refinery minerals can be loaded into a fleet hauler by
  // the mineral-lift leg. Those rows carry the lift's own journal tag and never a
  // coopHaulFleetID, so they are not ambiguous haul custody: the lift account is
  // their custodian and the fleet must still resume its ore trip.
  const rows=haulerIDs.flatMap(entityID=>{
   const cargo=store.listNativeCargoForEntity(entityID);
   if(!Array.isArray(cargo))throw Error("ALIFE12_NATIVE_HAUL_CARGO_UNAVAILABLE");
   return cargo.filter(x=>!/^coop-mineral-lift:v1:/.test(String(x?.customInfo||"")));
  });
  if(!rows.length)return false;
  if(rows.some(x=>!pos(x.cargoID)||!pos(x.quantity)||
    !haulerIDs.includes(Number(x.entityID))||
    Number(x.coopHaulFleetID)!==id||x.transient===true))
   throw Error("ALIFE12_NATIVE_HAUL_CUSTODY_AMBIGUOUS");
  const fleet=live[0];
  if(fleet.state!=="loaded"&&fleet.state!=="haulereturn"){
   fleet.state="loaded";
   fleet.nextThinkAtMs=0;
  }
  return true;
 }
 function start({scene,fleetCount}={}){
  const systemID=pos(scene?.systemID);
  if(!systemID||!fleetIDForSlot(systemID,1)||
     typeof scene.getEntityByID!=="function"||
     !Number.isSafeInteger(fleetCount)||fleetCount<0||fleetCount>MAX_SLOTS)
   return {status:"BLOCKED",reason:"ALIFE08_INVALID_STARTUP",slots:[]};
  if(process.env.EVEJS_COOP_NATIVE_MINING_FLEET_DURABLE!=="1")
   return {status:"BLOCKED",reason:"ALIFE08_NOT_ENABLED",slots:[]};
  if(process.env.EVEJS_COOP_ALIFE_STARTUP_CARGO_AUDIT==="1"&&typeof auditStartupCargo!=="function")
   return {status:"BLOCKED",reason:"ALIFE13_STARTUP_AUDITOR_UNAVAILABLE",slots:[]};
  if(busy.has(systemID))return {status:"BLOCKED",reason:"ALIFE08_REENTRANT",slots:[]};
  busy.add(systemID);
  const reports=[];
  // Runtime controller lookup is a native authority; when it is not present (for
  // example in a plain unit-test host) the legacy scene-only rule is kept.
  const runtimeControllerOf=(()=>{
   try{
    const registry=require("./npc/npcRegistry");
    return typeof registry.getControllerByEntityID==="function"
     ?registry.getControllerByEntityID:null;
   }catch(_error){return null;}
  })();
  // The native mining tick prunes any ship it has no runtime controller for, so
  // every ship this module vouches for must have one before the slot is declared
  // healthy - freshly spawned ones included.
  const ensureControllers=ids=>{
   let attached=0;
   for(const id of ids){
    const live=scene.getEntityByID(id);
    if(live&&(!runtimeControllerOf||runtimeControllerOf(id)))continue;
    const out=nativeService.materializeStoredNativeController(scene,id,{broadcast:false});
    if(out?.success!==true||pos(scene.getEntityByID(id)?.itemID)!==id)
     throw Error("ALIFE08_NATIVE_CONTROLLER_FAILED:"+id);
    attached++;
   }
   return attached;
  };
  try{
   for(let slot=1;slot<=fleetCount;slot++){
    const key=slotKey(systemID,slot);
    // Allocate and verify one slot's native actors. Used for a brand new slot
    // and for a slot whose previous witness proved abandoned.
    const seedSlot=()=>{
     saveSlot(db,key,{version:1,status:"PREPARING",systemID,slot,createdAtMs:Date.now()});
     // The PREPARING witness is flushed BEFORE any native actor allocation.
     ensureState();
     const born=spawn(slot);
     if(!born?.success||!born.data||born.data.minerSpawnResult?.data?.partialFailure||
         born.data.haulerSpawnResult?.data?.partialFailure)
      throw Error("ALIFE08_PARTIAL_NATIVE_SPAWN");
     const minerIDs=ids(born.data.minerEntityIDs),haulerIDs=ids(born.data.haulerEntityIDs);
     if(!minerIDs||minerIDs.length===0||!haulerIDs||
        minerIDs.length+haulerIDs.length>MAX_WING)
      throw Error("ALIFE08_NATIVE_SPAWN_LIST_INVALID");
     verifyActors({scene,store,systemID,slot,minerIDs,haulerIDs});
     // Flush original native entities, controllers, fitting and cargo first.
     const synced=db.flushTablesSync(["npcEntities","npcRuntimeControllers","npcModules","npcCargo"]);
     if(synced?.success!==true)throw Error("ALIFE08_NATIVE_ACTOR_FLUSH_FAILED");
     verifyActors({scene,store,systemID,slot,minerIDs,haulerIDs});
     const controllers=ensureControllers([...minerIDs,...haulerIDs]);
     const active=saveSlot(db,key,{version:1,status:"ACTIVE",systemID,slot,
      fleetID:fleetIDForSlot(systemID,slot),
      minerEntityIDs:minerIDs,haulerEntityIDs:haulerIDs,originAnchor:born.data.originAnchor||null});
     registerOnce({scene,store,getFleets,register,slot,minerIDs,haulerIDs,log,
      originAnchor:active.originAnchor});
     return result("SPAWNED",slot,{minerIDs,haulerIDs,controllers});
    };
    try{
     const record=readSlot(db,key);
     const discovered=markers(store,systemID,slot);
     if(!record){
      if(discovered.invalid.length||discovered.miners.length||discovered.haulers.length){
       reports.push(result("NEEDS_OPERATOR_REPAIR",slot,{reason:"ORPHAN_NATIVE_SLOT_WITHOUT_MANIFEST"}));
       continue;
      }
      reports.push(seedSlot());
      continue;
     }
     if(record.version!==1||record.status!=="ACTIVE"||
        pos(record.systemID)!==systemID||pos(record.slot)!==slot||
        Number(record.fleetID)!==fleetIDForSlot(systemID,slot)){
      reports.push(result("NEEDS_OPERATOR_REPAIR",slot,{reason:"NONACTIVE_OR_INVALID_SLOT_WITNESS"}));
      continue;
     }
     let minerIDs=ids(record.minerEntityIDs),haulerIDs=ids(record.haulerEntityIDs);
     if(!minerIDs||!minerIDs.length||!haulerIDs||
        minerIDs.length+haulerIDs.length>MAX_WING)
      throw Error("ALIFE08_ACTIVE_MANIFEST_INVALID");
     // A slot whose ships were never durable is not a lost fleet: nothing that
     // could hold cargo exists any more. Archive that witness and seed again.
     if(slotIsAbandoned({scene,store,systemID,slot,entityIDs:[...minerIDs,...haulerIDs]})){
      const orphans=[...minerIDs,...haulerIDs].reduce((acc,id)=>{
       const a=archiveOrphanRows({db,store,key,entityID:id});
       return {modules:acc.modules+a.modules,cargo:acc.cargo+a.cargo};
      },{modules:0,cargo:0});
      archiveSlot(db,key,record);
      log("ALIFE08 slot "+key+" witness archived as abandoned; seeding again");
      reports.push({...seedSlot(),reseededFrom:"ABANDONED_WITNESS",...orphans});
      continue;
     }
     // A slot that lost only some ships keeps the survivors and their cargo.
     const healed=repairPartialSlot({scene,store,systemID,slot,key,db,spawn,ensureState,
      minerIDs,haulerIDs});
     if(healed){
      minerIDs=healed.minerEntityIDs;
      haulerIDs=healed.haulerEntityIDs;
      ensureControllers([...minerIDs,...haulerIDs]);
     }
     // A surviving slot can still be composed wrong: the hull in the hauler role may
     // be a mining hull with a hold far smaller than one ore stack, which no amount
     // of healing fixes. Repair the composition additively (flag-gated).
     const recomposed=repairSlotComposition({scene,store,systemID,slot,key,db,spawn,
      ensureState,minerIDs,haulerIDs,log});
     if(recomposed){
      minerIDs=recomposed.minerEntityIDs;
      haulerIDs=recomposed.haulerEntityIDs;
      ensureControllers([...minerIDs,...haulerIDs]);
     }
     verifyActors({scene,store,systemID,slot,minerIDs,haulerIDs});
     // ALIFE-13: verify ALL original cargo transfers and historical manifests
     // before restoring ANY physical hull or registering a mining state.
     // Empty haulers are not proof that prior warehouse receipts completed.
     if(process.env.EVEJS_COOP_ALIFE_STARTUP_CARGO_AUDIT==="1"){
      const audit=auditStartupCargo({systemID,fleetID:fleetIDForSlot(systemID,slot),
       minerIDs:minerIDs.slice(),haulerIDs:haulerIDs.slice()});
      if(audit?.status!=="OK")throw Error("ALIFE13_STARTUP_ORIGINAL_CARGO_UNRECONCILED:"+
       String(audit?.reason||audit?.status||"UNKNOWN").slice(0,105));
     }
     // Validate ALL native rows before materializing ANY physical ship.
     // Some boot paths materialize a durable ship without registering a runtime
     // controller; the native mining tick then prunes it from its own fleet
     // record and that role silently stops working. Re-attach the controller.
     const restored=ensureControllers([...minerIDs,...haulerIDs]);
     verifyActors({scene,store,systemID,slot,minerIDs,haulerIDs});
     const registered=registerOnce({scene,store,getFleets,register,slot,minerIDs,haulerIDs,log,
      originAnchor:record.originAnchor||null});
     const pendingStationCargo=resumePendingStationCargo(scene,slot,haulerIDs);
     // The witness alone is not proof that the live fleet record still owns the
     // ships: the native tick prunes any actor it has no controller for. Reporting
     // both lists makes a hauler-less fleet visible instead of silently idle.
     const liveRecord=(typeof getFleets==="function"?(getFleets()||[]):[])
      .find(x=>Number(x&&x.fleetID)===fleetIDForSlot(systemID,slot));
     reports.push(result(restored?"RESTORED":registered?"RELINKED":"ALREADY_ACTIVE",slot,{
      minerIDs,haulerIDs,restored,pendingStationCargo,repaired:!!healed,
      recomposed:!!recomposed,
      liveMiners:Array.isArray(liveRecord&&liveRecord.minerEntityIDs)?liveRecord.minerEntityIDs.length:-1,
      liveHaulers:Array.isArray(liveRecord&&liveRecord.haulerEntityIDs)?liveRecord.haulerEntityIDs.length:-1}));
    }catch(error){
     const reason=String(error?.message||error).slice(0,160);
     reports.push(result("NEEDS_OPERATOR_REPAIR",slot,{reason}));
     log("ALIFE08 slot "+key+" blocked: "+reason);
    }
   }
   noteSlotStatus(systemID,reports);
   for(const report of reports){
    const detail=["miners="+(report.minerIDs||[]).length,"haulers="+(report.haulerIDs||[]).length,
     report.controllers!==undefined?"ctrl=+"+report.controllers:"","restored="+(report.restored||0),
     report.reseededFrom||"",report.repaired?"repaired":"",report.reason||""]
     .filter(Boolean).join(" ");
    log("ALIFE08 slot "+systemID+"-"+report.slot+" -> "+report.status+" "+detail);
   }
   return {status:reports.some(x=>x.status==="NEEDS_OPERATOR_REPAIR")?
    "NEEDS_OPERATOR_REPAIR":"OK",systemID,slots:reports};
  }finally{busy.delete(systemID);}
 }
 return Object.freeze({start});
}
function start(args){
 const {scene,spawn,register,getFleets,ensureState,fleetCount}=args||{};
 const db=require("../gameStore"),store=require("./npc/nativeNpcStore");
 const enabled=process.env.EVEJS_COOP_ALIFE_STARTUP_CARGO_AUDIT==="1";
 if(enabled&&[
  "EVEJS_COOP_NATIVE_ATOMIC_ROWS","EVEJS_COOP_NATIVE_HAUL_TRANSFER_ATOMIC",
  "EVEJS_COOP_NATIVE_CARGO_TRANSIENT_ISOLATION","EVEJS_COOP_NATIVE_STATION_TRIP_RECOVERY",
  "EVEJS_COOP_NATIVE_HAUL_MANIFEST","EVEJS_COOP_NPC_STATION_DELIVERY"
 ].some(k=>process.env[k]!=="1"))
  return {status:"BLOCKED",reason:"ALIFE13_REQUIRED_NATIVE_GATES_OFF",slots:[]};
 let auditStartupCargo=null;
 if(enabled){
  try{auditStartupCargo=require("./coopAlifeStartupCargoAudit").createStartupCargoAuditor({
   root:process.env.EVEJS_COOP_NPC_WAREHOUSE_DIR||"/var/lib/evejs/coop-native-warehouse",
   gameStore:db,store,items:require("../services/inventory/itemStore"),
   getNativeEntity:store.getNativeEntity}).audit}
  catch(error){return {status:"BLOCKED",reason:"ALIFE13_NATIVE_AUDITOR_INITIALIZATION_FAILED",slots:[]}}
 }
 return createService({db,store,auditStartupCargo,
   nativeService:require("./npc/nativeNpcService"),
   spawn,register,getFleets,ensureState,log:message=>console.warn("[ALIFE08]",message)
 }).start({scene,fleetCount});
}
// A durable actor outlives the in-memory controller registry: a rebuilt scene
// drops the controller while the persisted row still owns the ship. The stock
// fleet tick prunes any actor it cannot see a controller for, so a fleet quietly
// stops mining while its ships are alive. Re-attach from the store first.
// One hook line calls this; the logic and its tests live here, not in a string.
function healFleetActors(fleetRecord,deps={}){
 const npcService=deps.npcService||require("./npc");
 const store=deps.store||require("./npc/nativeNpcStore");
 let observe=deps.observe||null;
 if(!observe){
  try{observe=require("./coopRuntimeProbe").observe}catch(_error){observe=null}
 }
 const healed=[];
 const actors=[].concat(
  Array.isArray(fleetRecord&&fleetRecord.minerEntityIDs)?fleetRecord.minerEntityIDs:[],
  Array.isArray(fleetRecord&&fleetRecord.haulerEntityIDs)?fleetRecord.haulerEntityIDs:[]);
 for(const entityID of actors){
  const id=Number(entityID)||0;
  if(id<=0)continue;
  if(typeof npcService.getControllerByEntityID==="function"&&npcService.getControllerByEntityID(id))continue;
  const stored=store&&typeof store.getNativeController==="function"?store.getNativeController(id):null;
  if(!stored)continue;
  try{
   npcService.wakeNpcController(id);
  }catch(error){
   if(observe)observe("living-mining-fleet-selfheal-blocked",null,
    {spaceState:{systemID:Number(fleetRecord&&fleetRecord.systemID)||0}},
    {fleetID:Number(fleetRecord&&fleetRecord.fleetID)||0,entityID:id,
     reason:String(error&&error.message||error).slice(0,120)});
   continue;
  }
  if(typeof npcService.getControllerByEntityID!=="function"||!npcService.getControllerByEntityID(id))continue;
  healed.push(id);
  if(observe)observe("living-mining-fleet-selfheal",null,
   {spaceState:{systemID:Number(fleetRecord&&fleetRecord.systemID)||0}},
   {fleetID:Number(fleetRecord&&fleetRecord.fleetID)||0,entityID:id,
    operatorKind:String(stored.operatorKind||"")});
 }
 return healed;
}
// Forensics for a fleet that loses an actor: the stock filter drops an id as soon
// as the in-memory controller is gone, while the persisted row may still own the
// ship. Reporting both authorities per removed id is what turned "miners vanish"
// into a measured cause, so the shape lives here instead of in the hook.
function noteDroppedFleetActors(fleetRecord,deps={}){
 const npcService=deps.npcService||require("./npc");
 const store=deps.store||require("./npc/nativeNpcStore");
 let observe=deps.observe||null;
 if(!observe){
  try{observe=require("./coopRuntimeProbe").observe}catch(_error){observe=null}
 }
 if(!observe)return [];
 const dropped=[];
 const actors=[].concat(
  Array.isArray(fleetRecord&&fleetRecord.minerEntityIDs)?fleetRecord.minerEntityIDs:[],
  Array.isArray(fleetRecord&&fleetRecord.haulerEntityIDs)?fleetRecord.haulerEntityIDs:[]);
 for(const entityID of actors){
  const id=Number(entityID)||0;
  if(id<=0)continue;
  if(typeof npcService.getControllerByEntityID==="function"&&npcService.getControllerByEntityID(id))continue;
  const entity=store&&typeof store.getNativeEntity==="function"?store.getNativeEntity(id):null;
  const controller=store&&typeof store.getNativeController==="function"?store.getNativeController(id):null;
  dropped.push(id);
  observe("living-mining-fleet-pruned",null,
   {spaceState:{systemID:Number(fleetRecord&&fleetRecord.systemID)||0}},
   {fleetID:Number(fleetRecord&&fleetRecord.fleetID)||0,entityID:id,
    storedEntity:Boolean(entity),storedController:Boolean(controller),
    entityTransient:Boolean(entity&&entity.transient===true),
    controllerTransient:Boolean(controller&&controller.transient===true),
    operatorKind:String((controller&&controller.operatorKind)||(entity&&entity.operatorKind)||"")});
 }
 return dropped;
}
module.exports={createService,start,roleMarker,slotKey,fleetIDForSlot,healFleetActors,noteDroppedFleetActors};
