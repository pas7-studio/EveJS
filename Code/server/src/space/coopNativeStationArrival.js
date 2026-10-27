"use strict";
// Source-of-truth physical station arrival gate for NPC mining haulers.
// A warp order or elapsed timer is NEVER proof of an arrival or a delivery.
const fs = require("node:fs");
const path = require("node:path");
const {createWarehouse} = require("./coopNativeWarehouse");
// A refused sale used to be silent: the fleet deposited the cargo and went back
// to mining with no record of why no ISK arrived. Telemetry is the only way an
// operator learns that, so the decision is reported once per trip.
const observeGuard=()=>{try{return require("./coopObserve")}catch(_error){return require("./coopObserve")}};
// The resolver deploys as .js next to this file, but is stored as .cjs in the
// orchestration repo, so resolve either spelling instead of keeping a stale copy.
function loadEconomyDestination(){
 try{return require("./coopEconomyDestination");}
 catch(error){return require("./coopEconomyDestination");}
}
const pos = value => Number.isSafeInteger(Number(value)) && Number(value)>0 ? Number(value) : 0;
const vector = value => value && ["x","y","z"].every(k => typeof value[k]==="number" && Number.isFinite(value[k]));
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const truthy = result => result===true || (result && result.success===true);
const pause = status => ({status,terminal:false});
const DEADLINE_MS = 15*60*1000;
const ARRIVAL_DWELL_MS = 2000;
const MAX_SURFACE_GAP_METERS = 2500;
// A hull that is flying a real delivery route must not be dragged home by a fleet
// retreat: the trip, not the retreat, owns its movement. Measured live: after a
// pirate raid the whole fleet was warped back to its off-grid origin 1.9e11 m from
// the station with an active, acknowledged trip, so the arrival gate could never
// pass and the fleet sat in "loaded" until the deadline.
const REWARP_ABOVE_METERS = 50_000;
const REWARP_RETRY_MS = 60_000;
const rewarpAt = new Map();
function createStationArrival({getStations, getStation, getCorporation, isNpcCorporation,
 getNativeEntity, getScene, store, items, flush, warpToPoint, root, probe={observe:()=>{}},clock=()=>Date.now(),warehouse=null,verifyTransferredTitle=null,manifest=null,escortGate=null,destinationOracle=null,warpFence=null,beforeDeposit=null,ingressSnapshot=null,tripJournal=null,deliveryEvidence=null}={}){
 if(typeof getStations!=="function"||typeof getStation!=="function"||
    typeof getCorporation!=="function"||typeof isNpcCorporation!=="function"||
    typeof getNativeEntity!=="function"||typeof getScene!=="function"||
    !store||!items||typeof flush!=="function"||typeof warpToPoint!=="function"||!root)
  throw Error("STATION_ARRIVAL_DEPENDENCIES_REQUIRED");
 const isValidStation=(scene, station, systemID) => {
  const id=pos(station?.stationID),corp=pos(station?.corporationID||station?.ownerID);
  if(!id||!corp||Number(station.solarSystemID)!==systemID||
     isNpcCorporation(corp)!==true||!getCorporation(corp))return null;
  const canonical=getStation(id);
  if(!canonical||Number(canonical.stationID)!==id||
    Number(canonical.solarSystemID)!==systemID||
    Number(canonical.corporationID||canonical.ownerID)!==corp)return null;
  const point=(scene?.staticEntities||[]).find(e=>e.kind==="station"&&Number(e.itemID)===id);
  if(!point||!vector(point.position))return null;
  return {stationID:id,corporationID:corp,systemID,position:{...point.position},radius:Math.max(0,Number(point.radius)||0)};
 };
 const findShip=(scene,id,systemID)=>{
  const ship=scene?.getEntityByID?.(id);
  if(!ship||ship.kind!=="ship"||ship.nativeNpc!==true||Number(ship.itemID)!==id||
    Number(scene.systemID)!==systemID)return null;
  const durable=getNativeEntity(id);
  return durable&&Number(durable.entityID||durable.itemID)===id&&
     Number(durable.systemID)===systemID&&ship.transient!==true&&durable.transient!==true?ship:null;
 };
 const stableAt=(ship,point)=>{
  if(!ship||!vector(ship.position)||ship.mode==="WARP"||ship.pendingWarp||ship.warpState||
      ship.isWarping===true)return false;
  return Math.max(0,distance(ship.position,point.position)-
    Math.max(0,Number(ship.radius)||0)-point.radius)<=MAX_SURFACE_GAP_METERS;
 };
 const arrivals=new Map(),activeNativeEscortWarps=new Map();
 // The same native warp the departure used, re-issued to a hull the trip still
 // owns. Never a teleport: the ship really flies, and the arrival gate below still
 // demands a physical arrival plus dwell before anything is deposited.
 function rewarpStalledHauler(point,ship,haulerID,index){
  if(process.env.EVEJS_COOP_NATIVE_STATION_REWARP!=="1")return null;
  if(!ship||!vector(ship.position)||ship.mode==="WARP"||ship.pendingWarp||
   ship.warpState||ship.sessionlessWarpIngress)return null;
  const gap=Math.max(0,distance(ship.position,point.position)-
   Math.max(0,Number(ship.radius)||0)-point.radius);
  if(!(gap>REWARP_ABOVE_METERS))return null;
  const now=clock(),key=String(haulerID);
  if(now-(rewarpAt.get(key)||0)<REWARP_RETRY_MS)return null;
  rewarpAt.set(key,now);
  const target={...point.position,x:point.position.x+750+Math.max(0,Number(index)||0)*100};
  let ack=null;
  try{ack=warpToPoint(haulerID,target,{forceImmediateStart:true,
   broadcastWarpStartToVisibleSessions:true,visibilitySuppressMs:250,
   ingressDurationMs:2500});}
  catch(error){ack={success:false,errorMsg:String(error?.message||error).slice(0,120)};}
  const accepted=ack===true||(ack&&ack.success===true);
  try{probe.observe("living-npc-station-trip-rewarp",null,
   {spaceState:{systemID:Number(point.systemID)||0}},
   {haulerID,gapMeters:Math.round(gap),accepted,
    errorMsg:accepted?"":String((ack&&(ack.errorMsg||ack.error))||"UNKNOWN").slice(0,120)});}
  catch(_error){/* telemetry must never break the route */}
  return accepted?"TRIP_REWARP_ISSUED":null;
 }
 // A sold row leaves the hull through a REAL market fill, but it never becomes a
// station item, so the warehouse receipt the route journal reads could never prove
// it: after a restart the trip looked like its cargo had changed and the fleet sat
// in "loaded" forever. The fill is recorded as its own durable receipt, under the
// same receipts directory, naming the exact cargo row and the exact quantity the
// market paid for in that settled trade.
function recordSaleReceipt({root,probe,systemID,cargoID,haulerID,typeID,quantity,
 stationID,corporationID,fleetID,marketQuantity,isk,at}={}){
 const id=pos(cargoID);
 if(typeof root!=="string"||!path.isAbsolute(root)||!id||!pos(haulerID)||
    !pos(typeID)||!pos(quantity)||!pos(stationID)||!pos(corporationID)||
    !pos(fleetID)||!Number.isFinite(Number(marketQuantity))||
    Number(marketQuantity)!==Number(quantity))return {status:"SALE_RECEIPT_INVALID"};
 const dir=path.join(root,"receipts");
 const file=path.join(dir,id+".json");
 let prior=null;
 try{prior=JSON.parse(fs.readFileSync(file,"utf8"))}catch(_error){prior=null}
 if(prior&&(Number(prior.cargoID)!==id||String(prior.source)!=="NPC_MARKET_FILL"))
  return {status:"SALE_RECEIPT_FOREIGN"};
 if(prior&&(Number(prior.haulerID)!==pos(haulerID)||Number(prior.typeID)!==pos(typeID)||
    Number(prior.fleetID)!==pos(fleetID)||Number(prior.corporationID)!==pos(corporationID)))
  return {status:"SALE_RECEIPT_IDENTITY_CONFLICT"};
 // Fills are attributed to the station that paid for them: a route can only prove the
 // units that left the hull during ITS visit, so the receipt keeps one entry per fill
 // instead of a single running total.
 const priorFills=Array.isArray(prior&&prior.fills)?prior.fills.filter(x=>
  pos(x&&x.stationID)&&pos(x&&x.quantity)).map(x=>({stationID:pos(x.stationID),
  quantity:pos(x.quantity),at:Number(x.at)||0})):[];
 const record={version:1,phase:"COMMITTED",source:"NPC_MARKET_FILL",
  sequence:(Number(prior&&prior.sequence)||0)+1,
  cargoID:id,haulerID:pos(haulerID),typeID:pos(typeID),
  quantity:(Number(prior&&prior.quantity)||0)+pos(quantity),
  fills:[...priorFills,{stationID:pos(stationID),quantity:pos(quantity),at:Number(at)||0}],
  systemID:pos(systemID),fleetID:pos(fleetID),stationID:pos(stationID),
  corporationID:pos(corporationID),marketQuantity:Number(marketQuantity),
  isk:(Number(prior&&prior.isk)||0)+(Number.isFinite(Number(isk))?Number(isk):0),
  at:Number(at)};
 try{
  fs.mkdirSync(dir,{recursive:true});
  const tmp=file+".tmp-"+process.pid;
  const fd=fs.openSync(tmp,"w",0o600);
  try{fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd)}
  finally{fs.closeSync(fd)}
  fs.renameSync(tmp,file);
  return {status:"SALE_RECEIPT_WRITTEN",cargoID:id,sequence:record.sequence};
 }catch(error){
  try{probe?.observe?.("living-npc-station-sale-receipt-failed",null,
   {spaceState:{systemID:pos(systemID)}},{fleetID:pos(fleetID),cargoID:id,
   status:String(error?.code||error?.message||"UNKNOWN").slice(0,80)})}catch(_error){}
  return {status:"SALE_RECEIPT_UNWRITTEN"};
 }
}
const warehouseBlockedAt=new Map();
// cargoID -> quantity BEFORE the fill was requested, per station:hauler. The sale
// settles asynchronously, so the tick that reads SOLD already sees an emptied hull.
const saleBaseline=new Map();
  const saleSkippedNoted=new Set();
 const strictMotion=()=>escortEnabled&&
  process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT==="1"&&
  process.env.EVEJS_COOP_ESCORT_ROUTE_WITNESS==="1"&&
  process.env.EVEJS_COOP_ESCORT_NATIVE_WARP_OBSERVER==="1";
 // Crash-recovery is read-only provenance reconstruction, never a rewarp.
 // Source comes from the protected original cargo, fsynced WARP_ACK, funded
 // flight, signed departure, and the NPC's *current* native ingress state.
 function recoverNativeMotion(entity,now,proposedIngress=null){
  if(!strictMotion()||
   process.env.EVEJS_COOP_ESCORT_NATIVE_WARP_RECOVERY!=="1"||
   typeof durableWarpFence?.inspectSource!=="function"||
   typeof durableWarpFence?.inspect!=="function"||
   typeof escortGate?.readFlight!=="function"||
   typeof escortGate?.readDurableEscortDeparture!=="function")
   return pause("ESCORT_NATIVE_RECOVERY_DISABLED");
  const id=Number(entity?.itemID),ingress=proposedIngress||entity?.sessionlessWarpIngress;
  if(!pos(id)||entity?.kind!=="ship"||entity.nativeNpc!==true||
   entity.transient===true||!vector(entity.position)||
   !vector(ingress?.origin)||!vector(ingress?.targetPoint)||
   !Number.isFinite(now)||!Number.isFinite(ingress?.startTimeMs)||
   !Number.isFinite(ingress?.travelCompleteAtMs)||
   now<ingress.startTimeMs||now>ingress.travelCompleteAtMs||
   ingress.travelCompleteAtMs-ingress.startTimeMs>30000||
   ingress.travelCompleteAtMs-ingress.startTimeMs<6000)
   return pause("ESCORT_NATIVE_RECOVERY_NOT_ACTIVE_INGRESS");
  const durable=getNativeEntity(id),systemID=pos(durable?.systemID);
  if(!systemID||pos(durable?.entityID||durable?.itemID)!==id||
   durable.transient===true)
   return pause("ESCORT_NATIVE_RECOVERY_HAULER_NOT_DURABLE");
  let scene;try{scene=getScene(systemID)}
  catch{return pause("ESCORT_NATIVE_RECOVERY_SCENE_UNAVAILABLE")}
  if(scene?.systemID!==systemID||scene.getEntityByID?.(id)!==entity)
   return pause("ESCORT_NATIVE_RECOVERY_ENTITY_MISMATCH");
  let cargo;try{cargo=store.listNativeCargoForEntity(id)}
  catch{return pause("ESCORT_NATIVE_RECOVERY_CARGO_UNAVAILABLE")}
  if(!Array.isArray(cargo)||!cargo.length||
   cargo.some(x=>x?.transient===true||x?.entityID!==id||
    !pos(x.cargoID)||!pos(x.coopHaulFleetID)||
    !pos(x.quantity)||Number(x.moduleID||0)!==0))
   return pause("ESCORT_NATIVE_RECOVERY_CARGO_NOT_ORIGINAL");
  const fleetID=pos(cargo[0].coopHaulFleetID);
  if(cargo.some(x=>x.coopHaulFleetID!==fleetID))
   return pause("ESCORT_NATIVE_RECOVERY_CARGO_FLEET_MISMATCH");
  const cargoIDs=cargo.map(x=>x.cargoID).sort((a,b)=>a-b);
  if(new Set(cargoIDs).size!==cargoIDs.length||cargoIDs.length>1000)
   return pause("ESCORT_NATIVE_RECOVERY_CARGO_DUPLICATE");
  let source;try{source=durableWarpFence.inspectSource({
   systemID,fleetID,haulerID:id,cargoIDs})}
  catch{return pause("ESCORT_NATIVE_RECOVERY_WARP_SOURCE_UNAVAILABLE")}
  if(source?.status!=="WARP_SOURCE_ALREADY_DISPATCHED"||
   source.phase!=="WARP_ACK_CONFIRMED"||
   typeof source.manifestKey!=="string")
   return pause("ESCORT_NATIVE_RECOVERY_WARP_NOT_CONFIRMED");
  const key=source.manifestKey;
  let fence,flight,departure;try{
   fence=durableWarpFence.inspect(key);
   flight=escortGate.readFlight(key);
   departure=escortGate.readDurableEscortDeparture(key);
  }catch{return pause("ESCORT_NATIVE_RECOVERY_PROVENANCE_UNAVAILABLE")}
  const b=flight?.booking,w=fence?.booking;
  if(fence?.status!=="READY"||fence.phase!=="WARP_ACK_CONFIRMED"||
   flight?.status!=="READY"||flight.phase!=="FUNDED"||
   departure?.status!=="VERIFIED_NATIVE_ESCORT_DEPARTURE"||
   !b||!w||b.manifestKey!==key||w.manifestKey!==key||
   b.contractID!==w.contractID||b.contractID!==departure.contractID||
   b.systemID!==systemID||w.systemID!==systemID||
   b.fleetID!==fleetID||w.fleetID!==fleetID||
   b.haulerID!==id||w.haulerID!==id||
   b.stationID!==w.stationID||
   b.corporationID!==w.corporationID||
   !Array.isArray(b.characters)||b.characters.length!==2||
   b.characters[0]!==departure.characters?.[0]||
   b.characters[1]!==departure.characters?.[1]||
   !vector(departure.origin)||
   !Array.isArray(w.cargoIDs)||w.cargoIDs.length!==cargoIDs.length||
   w.cargoIDs.some((x,i)=>x!==cargoIDs[i]))
   return pause("ESCORT_NATIVE_RECOVERY_PROVENANCE_MISMATCH");
  const station=isValidStation(scene,getStation(b.stationID),systemID);
  if(!station||station.corporationID!==b.corporationID||
   distance(ingress.origin,departure.origin)>1||
   distance(ingress.targetPoint,{
    ...station.position,x:station.position.x+750})>1)
   return pause("ESCORT_NATIVE_RECOVERY_PHYSICAL_WARP_MISMATCH");
  return {status:"ESCORT_NATIVE_RECOVERY_VERIFIED",manifestKey:key,
   systemID,fleetID,stationID:b.stationID,
   corporationID:b.corporationID,entity,ingress,
   // Immutable references are checked on every subsequent scene callback.
   booking:b,origin:{...departure.origin},
   destination:{...station.position}};
 }
 function restoreNativeIngress(entity,stored){
  // Called ONLY from pinned nativeNpcService materialization AFTER original
  // entity is reconstructed and registered in the same real SpaceScene.
  if(!strictMotion()||
   process.env.EVEJS_COOP_ESCORT_NATIVE_WARP_RECOVERY!=="1"||
   process.env.EVEJS_COOP_ESCORT_NATIVE_INGRESS_SNAPSHOT!=="1"||
   !nativeIngressSnapshot||typeof nativeIngressSnapshot.readDurable!=="function")
   return pause("ESCORT_INGRESS_RESTORE_DISABLED");
  if(!entity||entity.sessionlessWarpIngress||entity.kind!=="ship"||
   entity.nativeNpc!==true||entity.transient===true||
   !vector(entity.position)||!stored||
   pos(stored.entityID)!==pos(entity.itemID)||
   stored.transient===true)
   return pause("ESCORT_INGRESS_RESTORE_NOT_FRESH_ENTITY");
  const now=clock(),id=pos(entity.itemID);
  let cargo;try{cargo=store.listNativeCargoForEntity(id)}
  catch{return pause("ESCORT_INGRESS_RESTORE_CARGO_UNAVAILABLE")}
  if(!Array.isArray(cargo)||!cargo.length||
   cargo.some(x=>!pos(x?.cargoID)||!pos(x.coopHaulFleetID)||
    x.entityID!==id||x.transient===true||!pos(x.quantity)||
    Number(x.moduleID||0)!==0))
   return pause("ESCORT_INGRESS_RESTORE_CARGO_INVALID");
  const fleetID=pos(cargo[0].coopHaulFleetID);
  if(cargo.some(x=>x.coopHaulFleetID!==fleetID))
   return pause("ESCORT_INGRESS_RESTORE_CARGO_FLEET_CONFLICT");
  const ids=cargo.map(x=>x.cargoID).sort((a,b)=>a-b);
  if(ids.length>1000||new Set(ids).size!==ids.length)
   return pause("ESCORT_INGRESS_RESTORE_CARGO_AMBIGUOUS");
  let source;try{source=durableWarpFence?.inspectSource({
   systemID:pos(stored.systemID),fleetID,haulerID:id,cargoIDs:ids})}
  catch{return pause("ESCORT_INGRESS_RESTORE_WARP_SOURCE_UNAVAILABLE")}
  if(source?.status!=="WARP_SOURCE_ALREADY_DISPATCHED"||
   source.phase!=="WARP_ACK_CONFIRMED")
   return pause("ESCORT_INGRESS_RESTORE_ACK_NOT_CONFIRMED");
  let flight;try{flight=escortGate?.readFlight?.(source.manifestKey)}
  catch{return pause("ESCORT_INGRESS_RESTORE_FLIGHT_UNAVAILABLE")}
  const b=flight?.booking;
  if(flight?.status!=="READY"||flight.phase!=="FUNDED"||
   !b||b.manifestKey!==source.manifestKey||
   b.systemID!==pos(stored.systemID)||b.fleetID!==fleetID||
   b.haulerID!==id)return pause("ESCORT_INGRESS_RESTORE_FLIGHT_INVALID");
  let snap;try{snap=nativeIngressSnapshot.readDurable({
   manifestKey:b.manifestKey,contractID:b.contractID,
   systemID:b.systemID,fleetID:b.fleetID,haulerID:b.haulerID,
   stationID:b.stationID,corporationID:b.corporationID,cargoIDs:ids})}
  catch{return pause("ESCORT_INGRESS_RESTORE_SNAPSHOT_UNAVAILABLE")}
  if(snap?.status!=="VERIFIED_NATIVE_INGRESS_SNAPSHOT")
   return pause("ESCORT_INGRESS_RESTORE_SNAPSHOT_NOT_DURABLE");
  const row=snap.row;
  if(!vector(stored.position)||distance(stored.position,row.origin)>1||
   distance(entity.position,row.origin)>1||
   !Number.isSafeInteger(now)||now<=row.startTimeMs||
   now>=row.travelCompleteAtMs-500)
   return pause("ESCORT_INGRESS_RESTORE_POSITION_OR_TIME_MISMATCH");
  const ingress={startTimeMs:row.startTimeMs,
   travelCompleteAtMs:row.travelCompleteAtMs,
   completeAtMs:row.completeAtMs,
   durationMs:row.travelCompleteAtMs-row.startTimeMs,
   completionHoldMs:row.completeAtMs-row.travelCompleteAtMs,
   lastUpdateAtMs:now,
   origin:{...row.origin},targetPoint:{...row.targetPoint}};
  const verified=recoverNativeMotion(entity,now,ingress);
  if(verified.status!=="ESCORT_NATIVE_RECOVERY_VERIFIED")
   return pause("ESCORT_INGRESS_RESTORE_"+verified.status);
  // This resumes ONLY the original physical interpolation; no call to
  // warpToPoint, wallet funding, manifest or cargo authority.
  entity.sessionlessWarpIngress=ingress;
  entity.mode="WARP";
  entity.targetPoint={...ingress.targetPoint};
  return {status:"ESCORT_ORIGINAL_NATIVE_INGRESS_RESTORED",
   manifestKey:b.manifestKey,haulerID:id};
 }
 // Rebuild ONLY the in-memory terminal delivery pointer after native
 // materialization restored the same original WARP. Never create a warp or
 // a new manifest; the original immutable ingress and native wallet must be
 // verified independently, not inferred from a fleet's runtime flags.
 function resumeNativeDelivery(scene,fleet,now){
  if(!strictMotion()||
   process.env.EVEJS_COOP_ESCORT_NATIVE_DELIVERY_RECOVERY!=="1"||
   process.env.EVEJS_COOP_ESCORT_NATIVE_INGRESS_SNAPSHOT!=="1"||
   process.env.EVEJS_COOP_ESCORT_NATIVE_WARP_RECOVERY!=="1"||
   typeof nativeIngressSnapshot?.readDurable!=="function")
   return pause("ESCORT_DELIVERY_RESUME_DISABLED");
  if(fleet?.coopStationArrival||fleet?.coopEscortWarpOutcomeUncertain)
   return pause("ESCORT_DELIVERY_RESUME_EXISTING_OR_UNCERTAIN_TRIP");
  const systemID=pos(scene?.systemID),fleetID=pos(fleet?.fleetID),
   ids=fleet?.haulerEntityIDs;
  if(!systemID||!fleetID||pos(fleet?.systemID)!==systemID||
   !Array.isArray(ids)||ids.length!==1||!pos(ids[0]))
   return pause("ESCORT_DELIVERY_RESUME_FLEET_NOT_ORIGINAL");
  const id=pos(ids[0]),ship=findShip(scene,id,systemID);
  if(!ship||!ship.sessionlessWarpIngress||ship.mode!=="WARP"||
   !vector(ship.position)||!Number.isSafeInteger(now))
   return pause("ESCORT_DELIVERY_RESUME_NO_ACTIVE_PHYSICAL_WARP");
  const proof=recoverNativeMotion(ship,now);
  if(proof.status!=="ESCORT_NATIVE_RECOVERY_VERIFIED")
   return pause("ESCORT_DELIVERY_RESUME_"+proof.status);
  const b=proof.booking;
  if(!b||b.fleetID!==fleetID||b.systemID!==systemID||
   b.haulerID!==id||b.manifestKey!==proof.manifestKey||
   b.stationID!==proof.stationID||b.corporationID!==proof.corporationID)
   return pause("ESCORT_DELIVERY_RESUME_ORIGINAL_BOOKING_MISMATCH");
  let cargo;try{cargo=store.listNativeCargoForEntity(id)}
  catch{return pause("ESCORT_DELIVERY_RESUME_CARGO_UNAVAILABLE")}
  if(!Array.isArray(cargo)||!cargo.length||
   cargo.some(c=>c.entityID!==id||c.transient===true||
    !pos(c.cargoID)||!pos(c.quantity)||pos(c.coopHaulFleetID)!==fleetID||
    Number(c.moduleID||0)!==0))
   return pause("ESCORT_DELIVERY_RESUME_CARGO_MISMATCH");
  const cargoIDs=cargo.map(c=>pos(c.cargoID)).sort((a,b)=>a-b);
  if(cargoIDs.length>1000||new Set(cargoIDs).size!==cargoIDs.length)
   return pause("ESCORT_DELIVERY_RESUME_CARGO_AMBIGUOUS");
  let snapshot;try{snapshot=nativeIngressSnapshot.readDurable({
   manifestKey:b.manifestKey,contractID:b.contractID,systemID,fleetID,
   haulerID:id,stationID:b.stationID,corporationID:b.corporationID,
   cargoIDs})}
  catch{return pause("ESCORT_DELIVERY_RESUME_SNAPSHOT_UNAVAILABLE")}
  if(snapshot?.status!=="VERIFIED_NATIVE_INGRESS_SNAPSHOT")
   return pause("ESCORT_DELIVERY_RESUME_ORIGINAL_SNAPSHOT_NOT_DURABLE");
  const row=snapshot.row,ingress=ship.sessionlessWarpIngress;
  if(!row||row.manifestKey!==b.manifestKey||
   row.startTimeMs!==ingress.startTimeMs||
   row.travelCompleteAtMs!==ingress.travelCompleteAtMs||
   row.completeAtMs!==ingress.completeAtMs||
   !vector(ingress.origin)||!vector(ingress.targetPoint)||
   distance(row.origin,ingress.origin)>1||
   distance(row.targetPoint,ingress.targetPoint)>1||
   now>=row.travelCompleteAtMs||now<row.startTimeMs)
   return pause("ESCORT_DELIVERY_RESUME_PHYSICAL_SNAPSHOT_MISMATCH");
  const trip={stationID:b.stationID,corporationID:b.corporationID,
   systemID,fleetID,startedAt:row.startTimeMs,
   haulers:{[id]:{arrivedAt:0}},
   manifestID:b.manifestKey,expectedCargoIDs:cargoIDs.slice(),
   recoveredFromOriginalNativeIngress:true};
  // This is an in-memory pointer to the *same* real cargo and contract.
  // Do not rewrite the warp fence, alter a native ship, or debit an item.
  fleet.coopStationArrival=trip;
  return {status:"ESCORT_ORIGINAL_NATIVE_DELIVERY_RESUMED",
   manifestKey:b.manifestKey,haulerID:id,terminal:false};
 }
 // Only true confirmed NPC warps can be sampled. Never infer position from
 // timer, navigation commands, forecast points or player RPC.
 function noteNativeMotion(entity,now){
  if(!strictMotion()||entity?.nativeNpc!==true||!pos(entity.itemID)||
   !Number.isFinite(now)||!entity.sessionlessWarpIngress)
   return pause("ESCORT_NATIVE_MOTION_DISABLED_OR_NOT_WARPING");
  let active=activeNativeEscortWarps.get(Number(entity.itemID));
  if(!active){
   const recovered=recoverNativeMotion(entity,now);
   if(recovered.status!=="ESCORT_NATIVE_RECOVERY_VERIFIED")
    return recovered.status==="ESCORT_NATIVE_RECOVERY_DISABLED"?
     pause("ESCORT_NATIVE_MOTION_NOT_REGISTERED"):recovered;
   active={recovered:true,manifestKey:recovered.manifestKey,
    systemID:recovered.systemID,fleetID:recovered.fleetID,
    stationID:recovered.stationID,corporationID:recovered.corporationID,
    entity:recovered.entity,ingress:recovered.ingress,
    origin:recovered.origin,destination:recovered.destination};
   activeNativeEscortWarps.set(Number(entity.itemID),active);
  }
  const trip=active.recovered?{
   manifestID:active.manifestKey,systemID:active.systemID,
   fleetID:active.fleetID,stationID:active.stationID,
   corporationID:active.corporationID,
   haulers:{[entity.itemID]:{arrivedAt:0}}
  }:active.fleet?.coopStationArrival;
  if(!trip||(!active.recovered&&trip!==active.trip)||
   trip.manifestID!==active.manifestKey||
   trip.systemID!==active.systemID||trip.fleetID!==active.fleetID||
   !Object.prototype.hasOwnProperty.call(trip.haulers,String(entity.itemID)))
   return pause("ESCORT_NATIVE_MOTION_TRIP_NOT_ACTIVE");
  if(active.recovered&&(active.entity!==entity||
   active.ingress!==entity.sessionlessWarpIngress||
   !vector(active.ingress?.origin)||!vector(active.ingress?.targetPoint)||
   distance(active.ingress.origin,active.origin)>1||
   distance(active.ingress.targetPoint,{
    ...active.destination,x:active.destination.x+750})>1||
   !Number.isFinite(active.ingress.startTimeMs)||
   !Number.isFinite(active.ingress.travelCompleteAtMs)||
   now<active.ingress.startTimeMs||now>active.ingress.travelCompleteAtMs))
   return pause("ESCORT_NATIVE_RECOVERY_INGRESS_CHANGED");
  let scene;try{scene=getScene(active.systemID)}
  catch{return pause("ESCORT_NATIVE_MOTION_SCENE_UNAVAILABLE")}
  if(scene?.systemID!==active.systemID||
   scene.getEntityByID?.(Number(entity.itemID))!==entity||
   (active.recovered&&!findShip(scene,Number(entity.itemID),active.systemID)))
   return pause("ESCORT_NATIVE_MOTION_ENTITY_NOT_CURRENT");
  const point=isValidStation(scene,getStation(trip.stationID),trip.systemID);
  if(!point||point.corporationID!==trip.corporationID||
   (active.recovered&&distance(point.position,active.destination)>1))
   return pause("ESCORT_NATIVE_MOTION_STATION_CHANGED");
  if(typeof escortGate?.recordEscortRouteSample!=="function")
   return pause("ESCORT_NATIVE_MOTION_AUTHORITY_UNAVAILABLE");
  try{return escortGate.recordEscortRouteSample(trip.manifestID,scene,point)}
  catch{return pause("ESCORT_NATIVE_MOTION_SAMPLE_UNAVAILABLE")}
 }

 const nativeIngressSnapshot=process.env.EVEJS_COOP_ESCORT_NATIVE_INGRESS_SNAPSHOT==="1"?
  (ingressSnapshot||require("./coopEscortNativeIngressSnapshot").createNativeIngressSnapshot({root,clock})):null;
 const manifestEnabled=process.env.EVEJS_COOP_NATIVE_HAUL_MANIFEST==="1";
 const escortEnabled=process.env.EVEJS_COOP_ESCORT_ROUTE_GATE==="1";
 const durableWarpFence=escortEnabled&&process.env.EVEJS_COOP_ESCORT_WARP_FENCE==="1"?
  (warpFence||require("./coopEscortWarpFence").createWarpFence({root,clock})):null;
 const manifestDirector=manifestEnabled?
  (manifest||require("./coopNativeHaulManifest").createManifest({root,store,items,getNativeEntity,clock})):null;
 const recoverEnabled=manifestEnabled&&!escortEnabled&&
  process.env.EVEJS_COOP_NATIVE_STATION_TRIP_RECOVERY==="1"&&
  process.env.EVEJS_COOP_NATIVE_MINING_FLEET_DURABLE==="1";
 const routeJournal=recoverEnabled?(tripJournal||
  require("./coopNativeStationTripJournal").createJournal({
   root,manifest:manifestDirector,store,items,getNativeEntity,clock})):null;
 // The arrival gate is three independent facts: a real station point in this
 // scene, a durable hauler physically sitting on it, and a dwell. A bare
 // `ARRIVAL_NOT_VERIFIED` hid which one failed, so the same closure now names
 // the exact term. It stays READ-ONLY and the deposit gate stays a strict boolean.
 const explainArrival=args=>{
  const scene=getScene(args.systemID),point=scene&&isValidStation(scene,getStation(args.stationID),args.systemID);
  const ship=scene&&findShip(scene,args.haulerID,args.systemID);
  const active=arrivals.get(args.haulerID);
  // ONE clock for the dwell. The trip loop measures it on the native tick clock it
  // was handed (`now`), which can run ahead of the wall clock; comparing it against
  // Date.now() made a physically arrived hauler report DWELL_PENDING forever
  // (measured: arrivedAtMs 2 041 ms ahead of the event time, gap 0 m).
  const at=pos(args.nowMs)||clock();
  // The trip itself just proved stability + dwell before it asks for a deposit,
  // so a vanished in-memory record must not block a physically arrived hauler:
  // accept the trip's own arrivedAt only together with a live stability check.
  const dwelled=Boolean((active&&active.fleetID===args.fleetID&&active.stationID===args.stationID&&
      active.arrivedAt>0&&at-active.arrivedAt>=ARRIVAL_DWELL_MS)||
    (pos(args.arrivedAtMs)&&at-Number(args.arrivedAtMs)>=ARRIVAL_DWELL_MS));
  const warping=Boolean(ship&&(ship.mode==="WARP"||ship.pendingWarp||ship.warpState||
    ship.isWarping===true));
  const gapMeters=ship&&vector(ship.position)&&point?
   Math.round(Math.max(0,distance(ship.position,point.position)-
    Math.max(0,Number(ship.radius)||0)-point.radius)):null;
  const term=!scene?"SCENE_UNAVAILABLE":
   !point?"STATION_NOT_VALID_IN_SCENE":
   !ship?"HAULER_NOT_DURABLE_IN_SCENE":
   point.stationID!==args.stationID?"STATION_ID_MISMATCH":
   warping?"HAULER_WARPING":
   gapMeters===null?"HAULER_POSITION_UNKNOWN":
   gapMeters>MAX_SURFACE_GAP_METERS?"SURFACE_GAP_TOO_LARGE":
   !dwelled?"DWELL_PENDING":"VERIFIED";
  return {ok:term==="VERIFIED",term,gapMeters,
   maxSurfaceGapMeters:MAX_SURFACE_GAP_METERS,mode:String(ship?.mode||""),warping,
   arrivedAtMs:pos(args.arrivedAtMs)||0,
   activeArrivedAt:Number(active?.arrivedAt||0)||0,dwellMs:ARRIVAL_DWELL_MS,dwelled};
 };
 const factory=warehouse||createWarehouse({root,store,items,flush,getStation,getCorporation,isNpcCorporation,verifyTransferredTitle,
  explainArrival,
  verifyArrival:args=>explainArrival(args).ok,
  verifyDurableCargo:(cargo,args)=>cargo.transient!==true&&
      Number(cargo.entityID)===args.haulerID&&Number(cargo.coopHaulFleetID)===args.fleetID&&
      Number(cargo.coopHaulFromMinerID)>0});
 // Restore route only from original source and a fsynced warp acknowledgement.
 // Position/dwell are rechecked by tick; recovery itself NEVER calls warp.
 function recover(scene,fleet,now=clock()){
  if(!routeJournal)return pause("RECOVERY_DISABLED");
  const systemID=pos(scene?.systemID),fleetID=pos(fleet?.fleetID),
   haulers=fleet?.haulerEntityIDs;
  if(!systemID||systemID!==pos(fleet?.systemID)||!fleetID||
     typeof fleet?.startupKey!=="string"||
     !/^\d+:\d+$/.test(fleet.startupKey)||
     !Array.isArray(haulers)||!haulers.length||
     haulers.some(id=>!pos(id)||!findShip(scene,id,systemID)))
   return pause("ALIFE12_RUNTIME_FLEET_UNVERIFIED");
  if(fleet.coopStationArrival)return pause("ROUTE_ALREADY_ACTIVE");
  const outcome=routeJournal.recover({systemID,fleetID,haulerIDs:haulers.slice()});
  if(outcome?.status==="NO_PENDING_TRIP")return {status:"NO_PENDING_TRIP",terminal:false};
  if(outcome?.status!=="RECOVERED_NATIVE_TRIP")
   // The deadline evidence travels with the refusal: without it the caller cannot
   // tell a route that is simply young from one that is dead and must be closed.
   // The journal's OWN status travels too: the prefixed string above is a report,
   // and start() must still be able to recognise ROUTE_SUPERSEDED / ROUTE_EXPIRED.
   // Measured live: a superseded manifest (all rows accounted, the hull carrying
   // undeclared ore) lost that identity here, so start() answered the same string
   // on every tick and the fleet sat in "loaded" for 20 minutes.
   return {...pause("ALIFE12_"+String(outcome?.reason||outcome?.status||"RECOVERY_UNVERIFIED")),
    journalStatus:String(outcome?.status||""),journalReason:String(outcome?.reason||""),
    ...(outcome?.trip?{trip:outcome.trip}:{}),
    ...(outcome?.overdue?{overdue:outcome.overdue}:{}),
    ...(outcome?.abandonable?{abandonable:outcome.abandonable}:{})};
  const trip=outcome.trip;  const station=isValidStation(scene,getStation(trip.stationID),systemID);
  // A trip whose station, fleet or start time cannot be proven is operator repair.
  // A trip that merely ran past its deadline is an expired route: report it so the
  // caller can record the expiry durably and plan a new trip with the ore it still
  // carries. Never pretend it arrived.
  if(!station||station.corporationID!==trip.corporationID||
     trip.systemID!==systemID||trip.fleetID!==fleetID||
     !Number.isSafeInteger(trip.startedAt)||trip.startedAt<=0||
     !Number.isFinite(now)||now<trip.startedAt)
   return pause("ALIFE12_RECOVERED_STATION_OR_DEADLINE_INVALID");
  if(now-trip.startedAt>DEADLINE_MS)
   return {status:"ROUTE_EXPIRED",terminal:false,trip};
  fleet.coopStationArrival=trip;
  for(const id of haulers)
   arrivals.set(Number(id),{fleetID,stationID:station.stationID,arrivedAt:0});
  return {status:"RECOVERED_EN_ROUTE",terminal:false,stationID:station.stationID,
   manifestID:trip.manifestID,nativeMutation:false,warpOrdered:false};
 }
 function start(scene,fleet,now=clock(),options={}){
  const systemID=pos(scene?.systemID),fleetID=pos(fleet?.fleetID);
  if(escortEnabled&&(!durableWarpFence||
   ["inspectSource","prepare","confirm"].some(k=>typeof durableWarpFence[k]!=="function")))
   return pause("ESCORT_DURABLE_WARP_FENCE_REQUIRED");
  if(escortEnabled&&process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT==="1"&&
   (process.env.EVEJS_COOP_ESCORT_DEPARTURE_WITNESS!=="1"||
    typeof escortGate?.recordEscortDeparture!=="function"))
   return pause("ESCORT_DURABLE_DEPARTURE_WITNESS_REQUIRED");
  if(escortEnabled&&process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT==="1"&&
   process.env.EVEJS_COOP_ESCORT_ROUTE_WITNESS==="1"&&
   (process.env.EVEJS_COOP_ESCORT_NATIVE_WARP_OBSERVER!=="1"||
    typeof escortGate?.recordEscortRouteSample!=="function"))
   return pause("ESCORT_NATIVE_MOTION_OBSERVER_REQUIRED");
  if(process.env.EVEJS_COOP_ESCORT_NATIVE_INGRESS_SNAPSHOT==="1"&&
   (!strictMotion()||
    process.env.EVEJS_COOP_ESCORT_NATIVE_WARP_RECOVERY!=="1"||
    typeof durableWarpFence?.inspect!=="function"||
    typeof escortGate?.readDurableEscortDeparture!=="function"||
    !nativeIngressSnapshot||
    typeof nativeIngressSnapshot.record!=="function"))
   return pause("ESCORT_NATIVE_INGRESS_SNAPSHOT_AUTHORITIES_REQUIRED");
  if(escortEnabled&&(!manifestEnabled||
    typeof escortGate?.fundBeforeWarp!=="function"||
    typeof escortGate?.recordDelivered!=="function"))
   return pause("ESCORT_ROUTE_GATE_UNAVAILABLE");
  if(!systemID||systemID!==pos(fleet?.systemID)||!fleetID||!Array.isArray(fleet.haulerEntityIDs)||
     !fleet.haulerEntityIDs.length)return pause("INVALID_FLEET");
  if(fleet.coopEscortWarpOutcomeUncertain)
   return pause("ESCORT_WARP_OUTCOME_NEEDS_OPERATOR_REPAIR");
  if(fleet.coopStationArrival)return pause("ROUTE_ALREADY_ACTIVE");
  const ships=fleet.haulerEntityIDs.map(pos).filter(Boolean);
  if(ships.length!==fleet.haulerEntityIDs.length||new Set(ships).size!==ships.length)return pause("INVALID_HAULERS");
  if(ships.some(id=>!findShip(scene,id,systemID)))return pause("HAULER_NOT_DURABLE");
  const candidates=(getStations(systemID)||[])
    .map(s=>isValidStation(scene,s,systemID)).filter(Boolean)
    .sort((a,b)=>a.stationID-b.stationID);
  if(!candidates.length)return pause("NO_NATIVE_NPC_STATION");
  const cargo=ships.flatMap(id=>(store.listNativeCargoForEntity(id)||[]).filter(row=>
   pos(row.cargoID)&&pos(row.typeID)&&pos(row.quantity)&&Number(row.coopHaulFleetID)===fleetID));
  if(cargo.some(row=>row.transient===true))return pause("CARGO_NOT_DURABLE");
  if(routeJournal){
   const previous=recover(scene,fleet,now);
   // A trip that ran past its deadline and whose cargo no longer matches the hull is
   // a stale route: close it durably and plan a fresh manifest from what the ships
   // really carry. A fresh trip re-verifies the hull, and every warehouse or sale
   // receipt keeps its grip on the ore, so nothing is dropped and nothing is faked.
   const staleOverdue=previous.status!=="NO_PENDING_TRIP"&&
    previous.status!=="ROUTE_EXPIRED"&&previous.overdue&&
    pos(previous.overdue.manifestID?1:0)&&Number.isFinite(Number(previous.overdue.startedAt));
   // A PREPARED route with no departure ack is not in flight, so it is closed as
   // soon as the departure attempt is provably over instead of waiting out the
   // whole route deadline. Measured: after every restart the fleet lost 15 minutes
   // to such a manifest while its haulers were already at the station.
   const stalePrepared=!staleOverdue&&previous.abandonable&&
    pos(previous.abandonable.manifestID?1:0)&&
    String(previous.status||"").includes("PREPARED_BUT_WARP_UNCONFIRMED");
   if(stalePrepared){
    const abandoned=routeJournal.abandon({manifestKey:String(previous.abandonable.manifestID),
     systemID,fleetID,now});
    if(!["ROUTE_ABANDONED","ALREADY_ABANDONED"].includes(abandoned?.status))
     return pause("ALIFE12_"+String(abandoned?.reason||abandoned?.status||"ABANDON_UNVERIFIED"));
    noteRouteStatus(fleet,"ROUTE_ABANDONED_STALE_PREPARED");
   }else if(staleOverdue){
    const key=String(previous.overdue.manifestID);
    const done=["ROUTE_ABANDONED","ALREADY_ABANDONED","ROUTE_EXPIRED","ALREADY_EXPIRED"];
    // A PREPARED manifest with no departure ack can never be expired, so it is
    // closed as ABANDONED first (the journal refuses that when a real ack exists,
    // and then the ordinary expiry below still applies). Measured: 30000144 sat in
    // "loaded" on 30000144-960004609-1793061051055 for five hours, ack absent,
    // while every tick reported ALIFE12_PREPARED_BUT_WARP_UNCONFIRMED and the
    // fleet mined nothing at all.
    let closed=typeof routeJournal.abandon==="function"
     ? routeJournal.abandon({manifestKey:key,systemID,fleetID,now})
     : null;
    if(!done.includes(closed?.status))
     closed=routeJournal.expire({manifestKey:key,systemID,fleetID,now});
    if(!done.includes(closed?.status))
     return pause("ALIFE12_"+String(closed?.reason||closed?.status||"EXPIRY_UNVERIFIED"));
    noteRouteStatus(fleet,closed.status==="ROUTE_ABANDONED"||closed.status==="ALREADY_ABANDONED"
     ?"ROUTE_ABANDONED_STALE_PREPARED":"ROUTE_EXPIRED_STALE_CARGO");
   }else if(previous.status==="ROUTE_EXPIRED"||
    previous.status==="ROUTE_SUPERSEDED"||
    previous.journalStatus==="ROUTE_EXPIRED"||previous.journalStatus==="ROUTE_SUPERSEDED"){
    // The route outlived its deadline, or the hull carries ore the manifest never
    // declared while every declared row is already proven. Record that durably,
    // then plan a new trip: the ore is still aboard and the ships are alive, and a
    // closed route must not strand the fleet in "loaded" forever.
    const key=String(previous.trip?.manifestID||previous.overdue?.manifestID||"");
    if(!/^\d+-\d+-\d+$/.test(key))return pause("ALIFE12_SUPERSEDED_ROUTE_IDENTITY_UNVERIFIED");
    const expired=routeJournal.expire({manifestKey:key,
     systemID,fleetID,now});
    if(!["ROUTE_EXPIRED","ALREADY_EXPIRED"].includes(expired?.status))
     return pause("ALIFE12_"+String(expired?.reason||expired?.status||"EXPIRY_UNVERIFIED"));
    noteRouteStatus(fleet,"ROUTE_EXPIRED_REPLANNED");
   }else if(previous.status!=="NO_PENDING_TRIP")return previous;
  }
  if(!cargo.length)return {status:"NO_ORE_TO_DELIVER",terminal:true};
  // The fleet picks the station that really pays for the ore it carries. The
  // buyer list is the live seed book of the fleet's own region, capped by the
  // remaining volume, so no station is ever preferred by ID. Without a known
  // book we keep the plain physical route and say so in telemetry.
  let destination=candidates[0],economy=null;
  if(destinationOracle){
   try{
    const ship=findShip(scene,ships[0],systemID);
    const measured=candidates.map(candidate=>({...candidate,distanceMeters:
     ship&&vector(ship.position)&&vector(candidate.position)?
      Math.round(distance(ship.position,candidate.position)):null}));
    economy=destinationOracle.decide({cargo,candidates:measured,systemID});
    if(economy?.status==="CHOSEN"){
     const picked=candidates.find(candidate=>candidate.stationID===economy.stationID);
     if(picked)destination=picked;
     else economy={...economy,status:"CHOSEN_STATION_NOT_PHYSICAL"};
    }
   }catch(error){economy={status:"ORACLE_FAILED",reason:String(error?.message||error).slice(0,80)};}
   if(typeof probe?.observe==="function")
    probe.observe("living-economy-destination",null,{spaceState:{systemID}},{
     fleetID,status:economy?.status||"UNKNOWN",regionID:economy?.regionID||0,
     stationID:destination.stationID,
     chosenRevenue:economy?.revenue||0,filled:economy?.filled||0,
     unfilled:economy?.unfilled||0,totalQuantity:economy?.totalQuantity||0,
     cargoTypes:economy?.cargoTypes||[],
     top:(economy?.ranked||[]).slice(0,3).map(entry=>({stationID:entry.stationID,
      revenue:entry.revenue,filled:entry.filled,unfilled:entry.unfilled}))
    });
  }
  if(strictMotion()){
   const first=scene.getEntityByID?.(ships[0]);
   if(!vector(first?.position)||distance(first.position,destination.position)<10000)
    return pause("ESCORT_ROUTE_TOO_SHORT_FOR_WITNESS");
  }
   if(escortEnabled){
   if(ships.length!==1)return pause("ESCORT_REQUIRES_ONE_NATIVE_HAULER");
   let source;try{source=durableWarpFence.inspectSource({systemID,fleetID,haulerID:ships[0],cargoIDs:cargo.map(x=>Number(x.cargoID))})}
   catch{return pause("ESCORT_WARP_FENCE_SOURCE_UNAVAILABLE")}
   if(source?.status!=="WARP_SOURCE_CLEAR")return pause("ESCORT_"+(source?.status||"WARP_FENCE_UNVERIFIED"));
  }
  // Flush existing physical NPC entities and native cargo before moving.
  for(const name of ["npcEntities","npcCargo"]){if(!flush(name)?.success)return pause("PERSISTENCE_UNCERTAIN");}
  // Real NPC cargo + native hauler must be observed BEFORE an escort offer.
  // Consent is a prerequisite, not permission to create funds or warp:
  // the independent native Stage E binding still authorizes both.
  let preparingEventID=null,approvedDepartPilots=null;
  // Paid escort NEVER departs without discoverable source and an explicit
  // independently priced, two-character contract acceptance. Optional native
  // NPC routes remain unchanged with the paid escort flag OFF.
  if(escortEnabled&&(
   process.env.EVEJS_COOP_OPPORTUNITY_BOARD!=="1"||
   process.env.EVEJS_COOP_EVENT_VOLUNTEERS!=="1"||
   process.env.EVEJS_COOP_ESCORT_PAID_ACCEPT!=="1"))
   return pause("ESCORT_DISCOVERY_AND_PAID_CONSENT_REQUIRED");
  if(escortEnabled&&process.env.EVEJS_COOP_OPPORTUNITY_BOARD==="1"){
   if(process.env.EVEJS_COOP_EVENT_VOLUNTEERS!=="1")
    return pause("ESCORT_VOLUNTEER_GATE_DISABLED");
   let event;try{event=require("./coopWorldOpportunityBoard")
    .noteNativeConvoyPreparing(scene,fleet,destination.stationID,
     cargo.map(x=>Number(x.cargoID)))}
   catch{return pause("ESCORT_PREPARING_SOURCE_UNAVAILABLE")}
   if(!["EVENT_PUBLISHED","NATIVE_PREPARING_EVENT_READY"].includes(event?.status)||
    typeof event.id!=="string")
    return pause("ESCORT_"+(event?.status||"PREPARING_EVENT_FAILED"));
   preparingEventID=event.id;
   fleet.coopEscortPredepartureEventID=preparingEventID;
   // Native corporation quote must be durably prepared while the original
   // source cargo and source NPC still exist; never accept client pricing.
   let quoted;try{quoted=require("./coopEscortPricedOffers")
    .offerFromNative({eventID:preparingEventID,route:{
     systemID,fleetID,stationID:destination.stationID,
     corporationID:destination.corporationID,haulerID:ships[0],
     cargoIDs:cargo.map(x=>Number(x.cargoID)).sort((a,b)=>a-b)
    }})}
   catch{return pause("ESCORT_NATIVE_CORPORATE_QUOTE_UNAVAILABLE")}
   if(!["NATIVE_QUOTE_DURABLY_PREPARED","NATIVE_QUOTE_READY"].includes(quoted?.status))
    return pause("ESCORT_"+(quoted?.status||"PAID_QUOTE_NOT_VERIFIED"));
   let duo;try{duo=require("./coopEscortVolunteers")
    .readVerifiedNativePair(preparingEventID)}
   catch{return pause("ESCORT_VOLUNTEER_RECEIPT_UNAVAILABLE")}
   if(duo?.status!=="VERIFIED_NATIVE_DUO_VOLUNTEER"||
    duo.eventID!==preparingEventID||
    duo.systemID!==systemID||duo.entityID!==ships[0]||
    !Array.isArray(duo.pilots)||duo.pilots.length!==2||
    duo.pilots.some(x=>!pos(x.characterID)||!pos(x.shipID)))
    return pause("ESCORT_AWAITING_TWO_NATIVE_VOLUNTEERS");
   let paid;try{paid=require("./coopEscortPricedOffers")
    .readNativeAccepted(preparingEventID)}
   catch{return pause("ESCORT_PAID_ACCEPTANCE_READER_UNAVAILABLE")}
   if(paid?.status!=="DURABLE_TWO_PILOT_PAID_ACCEPTANCE"||
    paid.eventID!==preparingEventID||
    paid.quote?.systemID!==systemID||
    paid.quote?.fleetID!==fleetID||
    paid.quote?.stationID!==destination.stationID||
    paid.quote?.corporationID!==destination.corporationID||
    paid.quote?.haulerID!==ships[0]||
    paid.characters?.length!==2||
    paid.characters[0]!==duo.pilots[0].characterID||
    paid.characters[1]!==duo.pilots[1].characterID||
    paid.fleetID!==duo.fleetID)
    return pause("ESCORT_AWAITING_TWO_PAID_ACCEPTANCES");
   approvedDepartPilots=duo.pilots.map(x=>({characterID:x.characterID,shipID:x.shipID}));
  }
  // Fast, non-writing source grid proof BEFORE persisting the native cargo
  // manifest. Full durable actor/escrow authority is still rechecked in Stage
  // E before debit; this preflight avoids orphan manifest on absent pilots.
  if(escortEnabled&&process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT==="1"){
   const npc=scene.getEntityByID?.(ships[0]);
   const onGrid=p=>p&&["x","y","z"].every(k=>Number.isFinite(p[k]));
   const sessions=typeof scene.sessions?.values==="function"?
    [...scene.sessions.values()]:null;
   if(!Array.isArray(approvedDepartPilots)||approvedDepartPilots.length!==2||
    !Array.isArray(sessions)||!onGrid(npc?.position))
    return pause("ESCORT_DEPARTURE_ON_GRID_PREFLIGHT_UNAVAILABLE");
   for(const pilot of approvedDepartPilots){
    const active=sessions.filter(x=>x?.characterID===pilot.characterID&&
     x?.socket?.destroyed!==true&&x?._space?.initialStateSent===true&&
     x._space.systemID===systemID&&x._space.shipID===pilot.shipID);
    if(active.length!==1)return pause("ESCORT_DEPARTURE_PILOT_NOT_AT_SOURCE");
    const ship=scene.getEntityByID?.(pilot.shipID);
    if(ship?.itemID!==pilot.shipID||ship.kind!=="ship"||
     ship.nativeNpc===true||ship.transient===true||
     !onGrid(ship.position)||
     Math.hypot(ship.position.x-npc.position.x,
      ship.position.y-npc.position.y,
      ship.position.z-npc.position.z)>150000)
     return pause("ESCORT_DEPARTURE_PILOT_NOT_ON_NPC_GRID");
   }
  }
  let manifestProof=null;
  if(manifestDirector){
   manifestProof=manifestDirector.prepare({systemID,fleetID,stationID:destination.stationID,
    corporationID:destination.corporationID,startedAt:now,haulerIDs:ships});
   if(manifestProof?.status!=="MANIFEST_DURABLY_PREPARED")
    return pause(manifestProof?.status||"MANIFEST_PREPARE_UNAVAILABLE");
  }
  let fundedEscortContractID=null;
  if(escortEnabled){
   if(!manifestProof?.key)return pause("ESCORT_PREWARP_MANIFEST_REQUIRED");
   const originalRoute={manifestKey:manifestProof.key,systemID,fleetID,
    stationID:destination.stationID,corporationID:destination.corporationID,
    haulerIDs:ships.slice()};
   if(process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT==="1"){
    let witness;try{witness=escortGate.recordEscortDeparture(originalRoute,scene)}
    catch{return pause("ESCORT_DEPARTURE_WITNESS_UNAVAILABLE")}
    if(!["DURABLE_NATIVE_ESCORT_DEPARTURE_WITNESS",
     "DURABLE_ESCORT_DEPARTURE_REPLAY"].includes(witness?.status))
     return pause("ESCORT_"+(witness?.status||"DEPARTURE_WITNESS_BLOCKED"));
   }
   let funded;try{funded=escortGate.fundBeforeWarp({
    manifestKey:manifestProof.key,systemID,fleetID,stationID:destination.stationID,
    corporationID:destination.corporationID,haulerIDs:ships.slice()
   })}catch{return pause("ESCORT_PREWARP_FUNDING_UNAVAILABLE")}
   if(funded?.status!=="FUNDED_BEFORE_WARP"||
      funded.manifestKey!==manifestProof.key||typeof funded.contractID!=="string")
    return pause("ESCORT_"+(funded?.status||"FUNDING_UNVERIFIED"));
   fundedEscortContractID=funded.contractID;
   // A native warp ACK can be lost after the ship physically moved.
   // Until ALL warp results are explicitly accepted, forbid an in-process retry.
   let intent;try{intent=durableWarpFence.prepare({
    manifestKey:manifestProof.key,contractID:funded.contractID,
    systemID,fleetID,haulerID:ships[0],stationID:destination.stationID,
    corporationID:destination.corporationID,cargoIDs:manifestProof.cargoIDs.slice()})}
   catch{return pause("ESCORT_WARP_INTENT_UNAVAILABLE")}
   if(intent?.status!=="DURABLE_WARP_PREPARED")
    return pause("ESCORT_"+(intent?.status||"WARP_INTENT_UNVERIFIED"));
   fleet.coopEscortWarpOutcomeUncertain=true;
  }
  const result={stationID:destination.stationID,corporationID:destination.corporationID,
   systemID,fleetID,startedAt:now,haulers:Object.fromEntries(ships.map(id=>[id,{arrivedAt:0}]))};
  if(manifestProof){
   result.manifestID=manifestProof.key;
   result.expectedCargoIDs=manifestProof.cargoIDs;
  }
  fleet.coopStationArrival=result; // In-memory intent is never proof of inventory.
  // A hauler that is ALREADY physically at this station needs no warp, and the
  // native warp refuses one that close (measured WARP_DISTANCE_TOO_CLOSE every
  // time a new trip was planned while the haulers sat at the station after the
  // previous trip expired, which deadlocked the fleet in "loaded" for good).
  // Nothing departs, so nothing is acknowledged as a departure either.
  let warpedHaulers=0;
  for(const [index,id] of ships.entries()){
   // A hauler that is ALREADY physically at this station needs no warp, and the
   // native warp refuses one that close (measured WARP_DISTANCE_TOO_CLOSE every
   // time a new trip was planned while the haulers sat at the station after the
   // previous trip expired, which deadlocked the fleet in "loaded" for good).
   // Nothing departs, so nothing is acknowledged as a departure either.
   if(stableAt(findShip(scene,id,systemID),destination)){
    arrivals.set(id,{fleetID,stationID:destination.stationID,arrivedAt:0});
    continue;
   }
   const target={...destination.position,x:destination.position.x+750+index*100};
   const sceneBeat=Math.max(250,Math.min(5000,Number(scene._tickIntervalMs)||1000));
   const realIngress=strictMotion()?
    Math.min(30000,Math.max(6000,sceneBeat*6)):0;
   let ack,warpError=null;
   try{ack=warpToPoint(id,target,{forceImmediateStart:true,
    broadcastWarpStartToVisibleSessions:true,visibilitySuppressMs:250,
    ingressDurationMs:Math.max(250,Number(options.ingressDurationMs)||250,
     realIngress)});}catch(error){ack=null;warpError=String(error?.message||error).slice(0,120);}
   if(!truthy(ack)){
    // The native runtime refuses a warp that is too short. A hauler that close to
    // its own station is already nearly there, so it flies the last kilometres with
    // a real subwarp approach and is not counted as a departing hull. Measured:
    // WARP_DISTANCE_TOO_CLOSE deadlocked every new trip while the haulers sat at
    // the station after the previous trip expired.
    if(String(ack?.errorMsg||ack?.error||warpError||"").includes("WARP_DISTANCE_TOO_CLOSE")){
     try{scene.followShipEntity(findShip(scene,id,systemID),destination.stationID,1_000,
      {queueHistorySafeContract:true,suppressFreshAcquireReplay:true});}
     catch(_error){/* the stock movement retries on the next tick */}
     arrivals.set(id,{fleetID,stationID:destination.stationID,arrivedAt:0});
     continue;
    }
    delete fleet.coopStationArrival;    for(const raw of ships)arrivals.delete(raw);
    // A rejected warp is the difference between "the fleet is working" and
    // "the fleet is silently stuck", so it must never be swallowed.
    const rejection={fleetID,haulerID:id,stationID:destination.stationID,
     systemID,errorMsg:String(ack?.errorMsg||ack?.error||warpError||"").slice(0,120),
     ackKeys:ack&&typeof ack==="object"?Object.keys(ack).slice(0,8):[]};
    noteRouteStatus(fleet,"WARP_COMMAND_FAILED");
    if(typeof probe?.observe==="function")
     probe.observe("living-npc-station-warp-rejected",null,{spaceState:{systemID}},rejection);
    return pause("WARP_COMMAND_FAILED");}
   arrivals.set(id,{fleetID,stationID:destination.stationID,arrivedAt:0});
   warpedHaulers+=1;
  }
  // Only a real departure can be acknowledged: a trip that started with every hull
  // already at the station has no departure to witness.
  if(routeJournal&&manifestProof&&warpedHaulers>0){
   const ack=routeJournal.confirm({manifestKey:manifestProof.key,systemID,fleetID,
    stationID:destination.stationID,corporationID:destination.corporationID,
    haulerIDs:ships.slice(),cargoIDs:manifestProof.cargoIDs.slice(),startedAt:now});
   if(!["DURABLE_DEPARTURE_CONFIRMED","ALREADY_CONFIRMED"].includes(ack?.status)){
    fleet.coopStationTripNeedsOperatorRepair="ALIFE12_WARP_ACK_DURABILITY_UNCERTAIN";
    result.coopStationTripNeedsOperatorRepair=true;
    return pause("ALIFE12_WARP_ACK_DURABILITY_UNCERTAIN");
   }
  }
  if(escortEnabled){
   let committed;try{committed=durableWarpFence.confirm(manifestProof.key)}
   catch{return pause("ESCORT_WARP_ACK_JOURNAL_UNAVAILABLE")}
   if(committed?.status!=="DURABLE_WARP_ACK_CONFIRMED")
    return pause("ESCORT_"+(committed?.status||"WARP_ACK_UNVERIFIED"));
  }
  let snapshotStatus="NOT_REQUIRED";
  if(strictMotion()&&process.env.EVEJS_COOP_ESCORT_NATIVE_INGRESS_SNAPSHOT==="1"){
   // File is created only AFTER the actual durable native WARP_ACK. A
   // server crash before it is written leaves no guessed recovery authority.
   if(ships.length!==1) snapshotStatus="INGRESS_SNAPSHOT_NEEDS_ONE_HAULER";
   else{
    const current=scene.getEntityByID?.(ships[0]);
    const nativeIngress=current?.sessionlessWarpIngress;
    let fence,source;try{
     fence=durableWarpFence.inspect(manifestProof.key);
     source=escortGate?.readDurableEscortDeparture?.(manifestProof.key);
    }catch{}
    let recorded;try{recorded=nativeIngressSnapshot?.record?.({
     booking:{manifestKey:manifestProof.key,contractID:fundedEscortContractID,
      systemID,fleetID,haulerID:ships[0],stationID:destination.stationID,
      corporationID:destination.corporationID,cargoIDs:manifestProof.cargoIDs.slice().sort((a,b)=>a-b)},
     ingress:nativeIngress,verifiedAck:fence,source,at:clock()})}
    catch{recorded={status:"INGRESS_SNAPSHOT_WRITE_UNAVAILABLE"}}
    snapshotStatus=recorded?.status||"INGRESS_SNAPSHOT_WRITE_UNAVAILABLE";
   }
  }
  if(strictMotion()){
   for(const id of ships)activeNativeEscortWarps.set(id,{
    fleet,trip:result,manifestKey:result.manifestID,systemID,fleetID});
  }
  let preparingNoticeStatus="NOT_REQUIRED";
  if(escortEnabled){
   delete fleet.coopEscortWarpOutcomeUncertain;
   if(preparingEventID){
    let close;try{close=require("./coopWorldOpportunityBoard")
     .noteNativePreparingDeparted(scene,fleet,preparingEventID,result)}
    catch{close={status:"PREPARING_DEPARTURE_WRITE_UNCERTAIN"}}
    preparingNoticeStatus=close?.status||"PREPARING_DEPARTURE_WRITE_UNCERTAIN";
    if(preparingNoticeStatus==="NATIVE_PREPARING_EVENT_CLOSED")
     delete fleet.coopEscortPredepartureEventID;
   }
  }
  probe.observe("living-npc-station-warp-requested",null,{spaceState:{systemID}},
   {fleetID,stationID:destination.stationID,haulers:ships.length});
  // Publish the actual native started convoy; no promise of a paid contract.
  if(process.env.EVEJS_COOP_OPPORTUNITY_BOARD==="1"){
   try{require("./coopWorldOpportunityBoard").noteNativeConvoy(
    scene,fleet,{status:"EN_ROUTE",stationID:destination.stationID})}
   catch(error){console.warn("[CoopOpportunityBoard] convoy",String(error?.message||error).slice(0,120))}
  }
  return {status:"EN_ROUTE",terminal:false,stationID:destination.stationID,
   ...(escortEnabled?{predepartureNoticeStatus:preparingNoticeStatus,
    ingressSnapshotStatus:snapshotStatus}:{})};
 }
 function tick(scene,fleet,now=clock()){
  const trip=fleet?.coopStationArrival;
  if(fleet?.coopStationTripNeedsOperatorRepair||
     trip?.coopStationTripNeedsOperatorRepair)
   return pause("ALIFE12_TRIP_JOURNAL_NEEDS_OPERATOR_REPAIR");
  if(escortEnabled&&fleet?.coopEscortWarpOutcomeUncertain)
   return pause("ESCORT_WARP_OUTCOME_NEEDS_OPERATOR_REPAIR");
  if(!trip)return pause("ROUTE_NOT_STARTED");
  if(Number(scene?.systemID)!==trip.systemID||Number(fleet?.fleetID)!==trip.fleetID)
   return pause("FLEET_MISMATCH");
  // A warp may have succeeded while the informational notice fsync ACK
  // failed. Retry ONLY closing the notice; never warp or debit again.
  if(fleet?.coopEscortPredepartureEventID&&
    process.env.EVEJS_COOP_OPPORTUNITY_BOARD==="1"){
   try{const closed=require("./coopWorldOpportunityBoard")
    .noteNativePreparingDeparted(scene,fleet,
     fleet.coopEscortPredepartureEventID,trip);
    if(closed?.status==="NATIVE_PREPARING_EVENT_CLOSED")
     delete fleet.coopEscortPredepartureEventID;
   }catch{/* informational repair remains pending, cargo route unaffected */}
  }
  // A trip that outlived its deadline can never be "waited out": the old code paused
  // here on every tick, so the fleet stayed in "loaded" forever and stopped mining
  // (measured live after a restart mid-haul). Close the route durably and drop the
  // in-memory trip, so the next tick plans a fresh one with the ore still aboard.
  if(now-trip.startedAt>DEADLINE_MS){
   const expired=routeJournal?routeJournal.expire({manifestKey:trip.manifestID,
    systemID:trip.systemID,fleetID:trip.fleetID,now}):{status:"ROUTE_EXPIRED"};
   if(!["ROUTE_EXPIRED","ALREADY_EXPIRED"].includes(expired?.status))
    return pause("ALIFE12_"+String(expired?.reason||expired?.status||"EXPIRY_UNVERIFIED"));
   for(const [haulerID,record] of arrivals)
    if(record&&Number(record.fleetID)===Number(trip.fleetID))arrivals.delete(haulerID);
   delete fleet.coopStationArrival;
   return {status:"ROUTE_EXPIRED_REPLANNED",terminal:false,expired:true};
  }
  const point=isValidStation(scene,getStation(trip.stationID),trip.systemID);
  if(!point||point.corporationID!==trip.corporationID)return pause("STATION_IDENTITY_CHANGED");
  // Trusted native server tick only: observe the physical NPC + both real
  // members at two distinct mid-route checkpoints. Observer cannot grant ISK,
  // create cargo or warp; missing evidence will deny only opt-in payout.
  if(escortEnabled&&trip.manifestID&&
   process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT==="1"&&
   process.env.EVEJS_COOP_ESCORT_ROUTE_WITNESS==="1"){
   let routeNote;try{routeNote=escortGate?.recordEscortRouteSample?.(
    trip.manifestID,scene,point)}
   catch{routeNote={status:"ROUTE_SAMPLE_UNAVAILABLE"}}
   if(routeNote?.status==="NATIVE_ROUTE_CHECKPOINT_DURABLY_RECORDED")
    probe.observe("living-npc-escort-route-checkpoint",null,
     {spaceState:{systemID:trip.systemID}},
     {fleetID:trip.fleetID,manifestKey:trip.manifestID,
      checkpoint:routeNote.stage});
  }
  let stackCount=0,oreQuantity=0;
  for(const rawID of Object.keys(trip.haulers)){
   const id=Number(rawID),ship=findShip(scene,id,trip.systemID);
   // A headless scene has no session ticker to land a warp. Without this the
   // hauler stays in WARP forever, the trip silently times out and the whole
   // haul is lost. Finish only a warp whose own clock already elapsed.
   if(ship)require("./coopStuckWarpRecovery").release(ship,scene,now);
   if(!ship){
    // Missing in-scene ship is NOT loss evidence. Only the authoritative
    // native wreck/outcome journal can release existing corporate escrow.
    if(escortEnabled&&trip.manifestID&&
     process.env.EVEJS_COOP_ESCORT_REFUNDS==="1"&&
     typeof escortGate?.refundNativeWreck==="function"){
     let refund;try{refund=escortGate.refundNativeWreck(trip.manifestID)}
     catch{refund={status:"NATIVE_REFUND_OUTCOME_UNCERTAIN_REPAIR_REQUIRED"}}
     if(refund?.status==="REFUNDED"){
      for(const raw of Object.keys(trip.haulers)){
       arrivals.delete(Number(raw));activeNativeEscortWarps.delete(Number(raw));
      }
      delete fleet.coopStationArrival;
      return {status:"ESCORT_NATIVE_HAULER_LOSS_REFUNDED",terminal:true,
       contractID:refund.contractID,
       amountISK:refund.amountISK,earnedPlayerISK:0};
     }
    }
    return pause("HAULER_LOST_OR_NOT_DURABLE");
   }
   const arrival=trip.haulers[id];
   if(!stableAt(ship,point)){
    // A retreat or a scene swap can drag a hull that is flying a real delivery
    // route back to the fleet's off-grid origin, AU-scale from the station, while
    // its acknowledged trip is still live. The trip still owns that hull, so it
    // re-flies it with the same native warp; the arrival gate is unchanged.
    if(rewarpStalledHauler(point,ship,id,Object.keys(trip.haulers).indexOf(String(id)))==="TRIP_REWARP_ISSUED")
     return pause("TRIP_REWARP_ISSUED");
    arrival.arrivedAt=0;
    arrivals.set(id,{fleetID:trip.fleetID,stationID:trip.stationID,arrivedAt:0});
    return pause("AWAITING_PHYSICAL_ARRIVAL");}
   if(!arrival.arrivedAt){arrival.arrivedAt=now;
    arrivals.set(id,{fleetID:trip.fleetID,stationID:trip.stationID,arrivedAt:now});
    return pause("ARRIVAL_DWELL_PENDING");}
   if(now-arrival.arrivedAt<ARRIVAL_DWELL_MS)return pause("ARRIVAL_DWELL_PENDING");
   const cargo=(store.listNativeCargoForEntity(id)||[]).filter(row=>
    pos(row.cargoID)&&Number(row.coopHaulFleetID)===trip.fleetID&&Number(row.moduleID||0)===0);
   if(manifestDirector&&(!trip.manifestID||!Array.isArray(trip.expectedCargoIDs)))
    return pause("MANIFEST_TRIP_CONTEXT_MISSING");
   if(manifestDirector&&cargo.some(item=>!trip.expectedCargoIDs.includes(Number(item.cargoID))))
    return pause("MANIFEST_NEW_UNDECLARED_CARGO");
   // Sell like a player standing at the station: a real bid at or above the
   // merchant's own floor is filled through the guarded native trader, and only
   // the remainder is deposited. The sale is asynchronous (market RPC), so the
   // arrival pauses until it settles instead of blocking the native tick.
   let sale=null;
   // The pre-sale snapshot key is used again AFTER the sale block (the settled fill
   // is recorded per hauler), so it must not be block-scoped: "baselineKey is not
   // defined" threw out of the whole native mining tick and no ore was ever
   // deposited, which kept the fleet in "loaded" and the belt empty.
   const baselineKey=Number(trip.stationID)+":"+Number(id);
   if(typeof beforeDeposit==="function"&&cargo.length){
    if(!saleBaseline.has(baselineKey))
     saleBaseline.set(baselineKey,new Map(cargo.map(row=>
      [Number(row.cargoID),Number(row.quantity)])));
    try{sale=beforeDeposit({scene,systemID:trip.systemID,stationID:trip.stationID,
     fleetID:trip.fleetID,haulerID:id,corporationID:trip.corporationID,
     cargoIDs:cargo.map(row=>Number(row.cargoID)),
     types:[...new Set(cargo.map(row=>Number(row.typeID)))]});}
    catch(error){sale={status:"SALE_ERROR",
     reason:String(error?.message||error).slice(0,90)};}
    if(sale?.status==="PENDING")return pause("MARKET_SALE_PENDING");
    if(sale?.status==="SOLD")
     probe.observe("living-npc-station-sold",null,{spaceState:{systemID:trip.systemID}},
      {fleetID:trip.fleetID,haulerID:id,stationID:trip.stationID,
       ...sale,earnedPlayerISK:0,marketCurrency:"NPC_LEDGER_ONLY_NOT_EVEJS_PLAYER_WALLET"});
    else if(sale&&sale.status!=="PENDING"){
     // One report per real trip: the same fleet may visit the same station again
     // with different cargo and must be able to tell us again.
     const key="sale-skipped:"+trip.fleetID+":"+trip.stationID+":"+
      (trip.manifestID||cargo.map(row=>Number(row.cargoID)).join(","));
     observeGuard().noteOnce(saleSkippedNoted,key,probe,
      "living-npc-station-sale-skipped",{systemID:trip.systemID},
      {fleetID:trip.fleetID,stationID:trip.stationID,
       status:String(sale.status||"NO_STATUS"),
       reason:String(sale.reason||"").slice(0,90),
       cargoIDs:cargo.map(row=>Number(row.cargoID)).slice(0,32),
       depositOnly:true});
    }
   }
   // Re-read: a settled sale really removed the sold stacks from the hull.
   const deliverable=sale?.status==="SOLD"?
    (store.listNativeCargoForEntity(id)||[]).filter(row=>
     pos(row.cargoID)&&Number(row.coopHaulFleetID)===trip.fleetID&&
     Number(row.moduleID||0)===0):cargo;
   if(sale?.status==="SOLD"){
    // The market paid for exactly the quantity that left the hull. A row counts as
    // sold only when its own decrease equals a settled quantity of its own type: no
    // inference, no averaging, no invented row.
    const soldByType=new Map();
    for(const entry of Array.isArray(sale.sold)?sale.sold:[]){
     const typeID=pos(entry?.typeID),quantity=pos(entry?.quantity);
     if(typeID&&quantity)soldByType.set(typeID,(soldByType.get(typeID)||0)+quantity);
    }
    const remaining=new Map();
    for(const row of deliverable)remaining.set(Number(row.cargoID),Number(row.quantity));
    // Prefer the snapshot taken when the fill was requested; the hull may already be
    // empty by the time the asynchronous settlement is readable.
    const beforeMap=saleBaseline.get(baselineKey)||null;
    const sourceRows=beforeMap?cargo.filter(row=>beforeMap.has(Number(row.cargoID)))
     .map(row=>({...row,quantity:beforeMap.get(Number(row.cargoID))})):cargo;
    const moved=sourceRows.map(row=>({row,left:Number(row.quantity)-
     (remaining.has(Number(row.cargoID))?remaining.get(Number(row.cargoID)):0)}))
     .filter(entry=>entry.left>0);
    // A sale receipt is the proof that a row is GONE. A partly sold row is still on
    // the hull, so it must never get a receipt: the next trip will declare it.
    const fullySold=moved.filter(entry=>entry.left===Number(entry.row.quantity));
    const movedByType=new Map();
    for(const entry of moved)movedByType.set(Number(entry.row.typeID),
     (movedByType.get(Number(entry.row.typeID))||0)+entry.left);
    let reconciled=soldByType.size>0;
    for(const [typeID,quantity] of soldByType)
     if((movedByType.get(typeID)||0)!==quantity)reconciled=false;
    if(reconciled&&fullySold.length){
     const ownerCorporationID=pos(moved[0].row.ownerID);
     for(const entry of fullySold){
      if(pos(entry.row.ownerID)!==ownerCorporationID)continue;
      const receipt=recordSaleReceipt({root,probe,systemID:trip.systemID,
       cargoID:entry.row.cargoID,haulerID:id,typeID:entry.row.typeID,
       quantity:entry.left,stationID:trip.stationID,
       corporationID:ownerCorporationID,fleetID:trip.fleetID,
       marketQuantity:entry.left,
       isk:sale.sold.find(x=>Number(x.typeID)===Number(entry.row.typeID))?.isk||0,
       at:Number(clock())});
      if(receipt.status!=="SALE_RECEIPT_WRITTEN"&&
         receipt.status!=="SALE_RECEIPT_ALREADY_PRESENT")continue;
     }
    }else if(fullySold.length){
     const key=trip.fleetID+":"+trip.stationID+":SALE_NOT_RECONCILED";
     observeGuard().noteOnce(saleSkippedNoted,key,probe,
      "living-npc-station-sale-unreconciled",{systemID:trip.systemID},
      {fleetID:trip.fleetID,stationID:trip.stationID,
       soldByType:[...soldByType.entries()].slice(0,8),
       movedByType:[...movedByType.entries()].slice(0,8)});
    }
   }
   for(const item of deliverable){
    // The settled fill is fully recorded: the next visit starts its own snapshot.
    saleBaseline.delete(baselineKey);
    // The ore belongs to the fleet corporation (the seller), not to the station
    // operator. Crediting the station would claim title to cargo it never owned, so
    // the deposit goes into the OWNER’s own hangar at that station: the receipt
    // names the corporation that provably owned this very row, and the stored item is
    // granted under that same owner. Measured live: the station corporation never
    // matched and every remainder was blocked as ORIGINAL_CARGO_OWNER_MISMATCH.
    const ownerCorporationID=pos(item.ownerID);
    const ownerProven=ownerCorporationID>0&&deliverable.every(row=>pos(row.ownerID)===ownerCorporationID);
    if(!ownerProven){
     const key=trip.fleetID+":"+Number(item.cargoID)+":DEPOSIT_OWNER_UNPROVEN";
     const now=Date.now();
     if(now-(warehouseBlockedAt.get(key)||0)>=120000){
      warehouseBlockedAt.set(key,now);
      probe.observe("living-npc-warehouse-blocked",null,{spaceState:{systemID:trip.systemID}},
       {fleetID:trip.fleetID,cargoID:item.cargoID,reason:"DEPOSIT_OWNER_UNPROVEN"});
     }
     continue;
    }
    const result=factory.deposit({cargoID:Number(item.cargoID),haulerID:id,
      fleetID:trip.fleetID,systemID:trip.systemID,stationID:trip.stationID,
      corporationID:ownerCorporationID,arrivedAtMs:arrival.arrivedAt,nowMs:now});
    if(!["COMMITTED","ALREADY_COMMITTED"].includes(result.status)){
     // A blocked deposit is retried every native tick, so an unthrottled event
     // floods the log (230 lines a minute) and hides every other signal.
     const key=trip.fleetID+":"+Number(item.cargoID)+":"+String(result.status);
     const now=Date.now();
     if(now-(warehouseBlockedAt.get(key)||0)>=120000){
      warehouseBlockedAt.set(key,now);
      probe.observe("living-npc-warehouse-blocked",null,{spaceState:{systemID:trip.systemID}},
       {fleetID:trip.fleetID,cargoID:item.cargoID,reason:result.status,
        ...(result.detail?{detail:result.detail}:{})});
     }
     return pause("WAREHOUSE_"+result.status);
    }
    stackCount++;oreQuantity+=Number(item.quantity);
   }
   if(typeof store.buildNativeCargoItems==="function")ship.nativeCargoItems=store.buildNativeCargoItems(id);
   if(sale?.status==="SOLD"&&Array.isArray(sale.sold)&&sale.sold.length){
    // A settled market fill is its own durable proof (native order id, ledger
    // balance and the trader's transaction journal), so it replaces the
    // warehouse receipt for exactly those stacks.
    trip.soldStacks=(trip.soldStacks||0)+sale.sold.length;
    trip.soldQuantity=(trip.soldQuantity||0)+sale.sold.reduce((sum,entry)=>
     sum+Math.max(0,Number(entry.quantity)||0),0);
    trip.soldISK=Math.round(((trip.soldISK||0)+sale.sold.reduce((sum,entry)=>
     sum+Math.max(0,Number(entry.quantity)||0)*Math.max(0,Number(entry.price)||0),0))*100)/100;
   }
  }
  // No cargo remaining is evidence of completion only if at least one
  // previously committed source receipt exists in this trip.
  // With a durable full native manifest, a crash/failed notification may
  // follow the LAST committed warehouse debit but precede this in-memory
  // counter update. The cargo is then correctly empty on the next tick.
  // The *full* manifest proof, NOT an empty hull, must decide completion.
  if(!stackCount&&!trip.completedStackCount&&!trip.soldStacks&&!manifestDirector)
   return pause("EMPTY_DELIVERY_NOT_PROVEN");
  trip.completedStackCount=(trip.completedStackCount||0)+stackCount;
  let manifestVerified=null,alifeDeliveryWitness=null;
  if(manifestDirector){
   manifestVerified=manifestDirector.verify({key:trip.manifestID,systemID:trip.systemID,
    fleetID:trip.fleetID,stationID:trip.stationID,corporationID:trip.corporationID,
    haulerIDs:Object.keys(trip.haulers).map(Number)});
   if(manifestVerified?.status!=="FULL_NATIVE_CARGO_DELIVERY_VERIFIED")
    return pause(manifestVerified?.status||"MANIFEST_FULL_CARGO_UNVERIFIED");
   alifeDeliveryWitness=(deliveryEvidence||require("./coopAlifeNativeDeliveryEvidence"))
    .verifyFullNativeDelivery(trip,manifestVerified);
   if(alifeDeliveryWitness?.status!=="NATIVE_FULL_MANIFEST_WITNESSED")
    return pause(alifeDeliveryWitness?.reason||"ALIFE_NATIVE_DELIVERY_PROOF_UNVERIFIED");
   // Reconcile ALL committed cargo stacks rather than just stacks observed
   // on this tick. Never synthesize inventory or a new warehouse receipt.
   stackCount=alifeDeliveryWitness.stacks;
   oreQuantity=alifeDeliveryWitness.quantity;
  }
  if(stackCount)probe.observe("living-npc-station-delivered",null,{spaceState:{systemID:trip.systemID}},
   {fleetID:trip.fleetID,stationID:trip.stationID,stacks:stackCount,oreQuantity});
  let terminalAttendanceStatus="NOT_REQUIRED";
  if(escortEnabled&&process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT==="1"&&
   process.env.EVEJS_COOP_ESCORT_PEACEFUL_REPLAY==="1"){
   // Persist authentic terminal presence BEFORE committing the final native
   // delivery journal. The cargo must already be warehouse-reconciled and
   // original full-manifest proof independently verified. An unavailable
   // pilot cannot be granted a fictitious receipt after restart.
   try{
    const proof=escortGate?.recordTerminalAttendance?.(
     trip.manifestID,scene,manifestVerified);
    terminalAttendanceStatus=proof?.status||"TERMINAL_ATTENDANCE_NOT_WIRED";
   }catch{terminalAttendanceStatus="TERMINAL_ATTENDANCE_UNCERTAIN_REPAIR_REQUIRED"}
  }
  if(escortEnabled){
   const terminal={status:"DELIVERED",terminal:true,nativeFullManifestProof:manifestVerified};
   let written;try{written=escortGate.recordDelivered({
    manifestKey:trip.manifestID,trip,terminalProof:terminal
   })}catch{return pause("ESCORT_TERMINAL_JOURNAL_UNAVAILABLE")}
   if(written?.status!=="DURABLE_NATIVE_DELIVERY_RECORDED"||
     written.manifestKey!==trip.manifestID)
    return pause("ESCORT_"+(written?.status||"TERMINAL_WRITE_BLOCKED"));
  }
  if(process.env.EVEJS_COOP_OPPORTUNITY_BOARD==="1"){
   try{require("./coopWorldOpportunityBoard").noteNativeConvoyOutcome(
    scene,trip,{status:"DELIVERED",terminal:true})}
   catch(error){console.warn("[CoopOpportunityBoard] arrival",String(error?.message||error).slice(0,120))}
  }
  let escortSettlement=null;
  if(escortEnabled){
   try{escortSettlement=process.env.EVEJS_COOP_ESCORT_PEACEFUL_PAYOUT==="1"?
    (typeof escortGate?.settlePeacefulDelivery==="function"?
     escortGate.settlePeacefulDelivery(trip.manifestID,scene):
     {status:"ESCORT_PEACEFUL_SETTLEMENT_NOT_WIRED"}):
    (typeof escortGate?.settleVerifiedNativeRaid==="function"?
     escortGate.settleVerifiedNativeRaid(trip.manifestID):
     {status:"ESCORT_SETTLEMENT_NOT_WIRED"})}
   catch{escortSettlement={status:"ESCORT_SETTLEMENT_UNCERTAIN_REPAIR_REQUIRED"}}
  }
  // A-Life SETTLE is a read-only observation of the native warehouse's
  // already-COMMITTED manifest. Failure to append telemetry cannot re-debit
  // items, trigger a repeat settlement or block physical cargo ownership.
  if(alifeDeliveryWitness){try{
   probe.observe("alife-native-delivery-settled",null,
    {spaceState:{systemID:trip.systemID}},alifeDeliveryWitness);
  }catch(error){console.warn("[CoopALifeDelivery] telemetry",String(error?.message||error).slice(0,80));}}
  for(const raw of Object.keys(trip.haulers)){
   arrivals.delete(Number(raw));activeNativeEscortWarps.delete(Number(raw));
  }
  delete fleet.coopStationArrival;
  return {status:"DELIVERED",terminal:true,stacks:stackCount,quantity:oreQuantity,
   ...(trip.soldStacks?{soldStacks:trip.soldStacks,soldQuantity:trip.soldQuantity||0,
    soldISK:trip.soldISK||0,marketCurrency:"NPC_LEDGER_ONLY_NOT_EVEJS_PLAYER_WALLET"}:{}),
   ...(escortEnabled?{escortSettlementStatus:escortSettlement?.status||"UNAVAILABLE",
    terminalAttendanceStatus}:{}),
   ...(manifestVerified?{nativeFullManifestProof:manifestVerified}:{})};
 }
 // Read-only: what the trip machinery would answer for this fleet RIGHT NOW.
 // recover() only reads the journal, the manifests and the live scene; it never
 // warps, never writes and never creates a route. This is how a fleet that sits in
 // "loaded" says which status is blocking it instead of being inferred.
 function diagnoseTrip(scene,fleet,now=clock()){
  const systemID=pos(scene?.systemID),fleetID=pos(fleet?.fleetID);
  const out={systemID,fleetID,state:String(fleet?.state||""),
   hasActiveTrip:Boolean(fleet?.coopStationArrival),
   loadedUntilMs:Number(fleet?.loadedUntilMs||0)||0,
   startupKey:String(fleet?.startupKey||""),
   haulers:Array.isArray(fleet?.haulerEntityIDs)?fleet.haulerEntityIDs.length:0,
   haulersDurable:Array.isArray(fleet?.haulerEntityIDs)&&
    fleet.haulerEntityIDs.every(id=>findShip(scene,id,systemID)),
   journalEnabled:Boolean(routeJournal),manifestEnabled:Boolean(manifestDirector)};
  if(!routeJournal)return {...out,status:"RECOVERY_DISABLED"};
  try{out.recover=recover(scene,fleet,now)}
  catch(error){out.recover={status:"DIAGNOSE_FAILED",reason:String(error?.message||error).slice(0,95)}}
  try{out.manifest=manifestDirector?.read?.(String(fleet?.coopStationArrival?.manifestID||""))||null}
  catch(_error){out.manifest=null}
  return out;
 }
 return {start,tick,recover,resumeNativeDelivery,noteNativeMotion,restoreNativeIngress,verify:stableAt,warehouse:factory,manifest:manifestDirector,
  explainArrival,diagnoseTrip,oracle:destinationOracle};}
let runtimeDirector;
function getRuntimeDirector(){
 if(runtimeDirector)return runtimeDirector;
 const worldData=require("./worldData"),store=require("./npc/nativeNpcStore");
 const nativeItems=require("../services/inventory/itemStore");
 const repo=require("../gameStore");
 const corporations=require("../services/corporation/corporationState");
 const runtime=require("./runtime");
 if(process.env.EVEJS_COOP_ESCORT_ROUTE_GATE==="1"&&
    process.env.EVEJS_COOP_ESCORT_RUNTIME_MOUNT==="1"){
   const binding=require("./coopEscortNativeBootstrap").installNativeEscorts();
   if(binding?.status!=="ESCORT_NATIVE_RUNTIME_BOUND")
    console.warn("[CoopEscort] native paid runtime not installed:",binding?.status||"UNAVAILABLE");
 }
 runtimeDirector=createStationArrival({
  getStations:worldData.getStationsForSystem,getStation:worldData.getStationByID,
  getCorporation:corporations.getCorporationRecord,isNpcCorporation:corporations.isNpcCorporationID,
  getNativeEntity:store.getNativeEntity,getScene:id=>runtime.getScene?.(id)||runtime.ensureScene(id),
  store,items:nativeItems,flush:table=>repo.flushTableSync(table),
  // A durable native hauler has no session, so the session-bound
  // space/runtime.warpToPoint() silently rejects it. Use the same sessionless
  // NPC warp the stock mining code uses, otherwise every station trip failed
  // with WARP_COMMAND_FAILED and the ore never left the belt.
  warpToPoint:(id,p,opts)=>require("./npc/npcRuntime").warpToPoint(id,p,opts),
  root:process.env.EVEJS_COOP_NPC_WAREHOUSE_DIR||"/var/lib/evejs/coop-native-warehouse",
  probe:require("./coopRuntimeProbe"),
  // Audit only: original GameStore + ItemStore + live rented office witness.
  // OFF by default, NEVER authorizes or performs an ore title mutation.
  verifyTransferredTitle:process.env.EVEJS_COOP_PLAYER_NPC_MINING_ORE_TITLE==="1"?
   require("./coopPlayerMiningOreNativeBindings").createRuntimeTitleVerifier():null,
  // Option A: sell at the station before the warehouse takes the cargo.
  beforeDeposit:process.env.EVEJS_COOP_NPC_MARKET_SELL_ON_ARRIVAL==="1"?
   args=>require("./coopVirtualWorldRuntime").sellOnArrival(args):null,
  destinationOracle:process.env.EVEJS_COOP_ECONOMY_DESTINATION==="1"?
   loadEconomyDestination().createDestinationOracle({
    call:(method,params)=>require("../services/market/marketDaemonClient")
     .marketDaemonClient.call(method,params),
    getOreTypes:systemID=>require("../services/mining/miningVisuals")
     .getSolarSystemOreTypeRecords(systemID),
    getSystemRegion:systemID=>worldData.getSolarSystemByID(systemID),
    probe:require("./coopRuntimeProbe")}):null,
  escortGate:process.env.EVEJS_COOP_ESCORT_ROUTE_GATE==="1"?
   require("./coopEscortNativeBinding").routeGate():null});
 return runtimeDirector;
}
// Which ore this system should prefer, from real belt ore crossed with real
// buyers. Read-only: it advises the next haul, it never spawns or moves a ship.
// Stage E1: read-only ORIGINAL fsynced warehouse receipt. Never builds a
// scene, schedules a haul, or materializes stock for the completion gate.
function getOriginalWarehouseReceipt(cargoID){
 if(process.env.EVEJS_COOP_NPC_STATION_DELIVERY!=="1"||
   !Number.isSafeInteger(cargoID)||cargoID<=0||!runtimeDirector)return null;
 try{return runtimeDirector.warehouse?.getReceipt?.(cargoID)||null}
 catch{return null;}
}
// Read-only: the three terms of the arrival gate for one hauler of the LIVE
// director (its own `arrivals` map, scene and station). Never warps, deposits
// or creates a scene; a missing director is reported instead of being built.
function diagnoseArrival(args){
 if(!runtimeDirector||typeof runtimeDirector.explainArrival!=="function")
  return {status:"NO_LIVE_DIRECTOR"};
 try{return runtimeDirector.explainArrival(args||{})}
 catch(error){return {status:"DIAGNOSE_FAILED",reason:String(error?.message||error).slice(0,95)}}
}
// Read-only: the live director's own answer for one fleet's trip state.
function diagnoseTrip({systemID,fleetID}={}){
 if(!runtimeDirector||typeof runtimeDirector.diagnoseTrip!=="function")
  return {status:"NO_LIVE_DIRECTOR"};
 try{
  const runtime=require("./runtime");
  const scene=runtime.scenes instanceof Map?runtime.scenes.get(Number(systemID)):null;
  const operations=require("../services/mining/miningNpcOperations");
  const fleet=(operations.getMiningFleetsForSystem(Number(systemID))||[])
   .find(row=>Number(row?.fleetID)===Number(fleetID));
  if(!scene)return {status:"SCENE_NOT_IN_MEMORY"};
  if(!fleet)return {status:"FLEET_NOT_FOUND"};
  return runtimeDirector.diagnoseTrip(scene,fleet);
 }catch(error){return {status:"DIAGNOSE_FAILED",reason:String(error?.message||error).slice(0,95)}}
}
function observePreferredOre({systemID,reason="periodic"}={}){
 if(process.env.EVEJS_COOP_ECONOMY_DESTINATION!=="1")return null;
 const director=getRuntimeDirector();
 return director.oracle?.observePreferredOre?.({systemID,reason})||null;
}
function routeFromHaul(scene,fleet,runtime,now,ingressDurationMs){
 if(process.env.EVEJS_COOP_NPC_STATION_DELIVERY!=="1")return pause("DISABLED");
 const result=getRuntimeDirector().start(scene,fleet,now,{ingressDurationMs});
 if(result.status==="NO_ORE_TO_DELIVER")fleet.coopStationNoCargo=true;
 if(result.status!=="EN_ROUTE"&&result.status!=="NO_ORE_TO_DELIVER"&&
  result.status!=="ROUTE_ALREADY_ACTIVE")
  noteRouteStatus(fleet,result.status);
 return result;
}
// A stalled haul used to be completely silent. One event per fleet and status
// per two minutes makes the physical blocker visible without log spam.
const routeStatusAt=new Map();
function noteRouteStatus(fleet,status){
 const fleetID=pos(fleet?.fleetID),now=Date.now(),key=fleetID+":"+status;
 if(!fleetID||now-(routeStatusAt.get(key)||0)<120000)return;
 routeStatusAt.set(key,now);
 try{
  require("./coopRuntimeProbe").observe("living-npc-station-route",null,
   {spaceState:{systemID:pos(fleet?.systemID)}},{fleetID,status,
    fleetState:String(fleet?.state||""),haulers:(fleet?.haulerEntityIDs||[]).length});
 }catch(_error){/* diagnostics must never break the native route */}
}
function noteNativeMotion(entity,now){
 if(!runtimeDirector||process.env.EVEJS_COOP_ESCORT_NATIVE_WARP_OBSERVER!=="1")
  return pause("ESCORT_NATIVE_MOTION_NOT_INSTALLED");
 return runtimeDirector.noteNativeMotion(entity,now);
}
function restoreNativeIngress(entity,record){
 if(process.env.EVEJS_COOP_ESCORT_NATIVE_INGRESS_SNAPSHOT!=="1"||
    process.env.EVEJS_COOP_ESCORT_NATIVE_WARP_RECOVERY!=="1")
  return pause("ESCORT_INGRESS_RESTORE_DISABLED");
 // Native service may call this during boot; do not create any physical NPC
 // order. Existing runtime is used if mounted, otherwise only read-only
 // source-authority bootstrap via getRuntimeDirector is permitted.
 try{return getRuntimeDirector().restoreNativeIngress(entity,record)}
 catch{return pause("ESCORT_INGRESS_RESTORE_AUTHORITY_UNAVAILABLE")}
}
function checkReturn(scene,fleet,now,director=null){
 const run=director||getRuntimeDirector();
 if(process.env.EVEJS_COOP_NPC_STATION_DELIVERY!=="1")return pause("DISABLED");
 // Recover before the predeparture retry branch: a crash must NEVER
 // mistake the already-confirmed original NPC warp for a new departure.
 if(process.env.EVEJS_COOP_ESCORT_NATIVE_DELIVERY_RECOVERY==="1"&&
   !fleet?.coopStationArrival&&Array.isArray(fleet?.haulerEntityIDs)&&
   fleet.haulerEntityIDs.length===1){
  const id=pos(fleet.haulerEntityIDs[0]);
  const live=id?scene?.getEntityByID?.(id):null;
  if(live?.nativeNpc===true&&live.sessionlessWarpIngress){
   if(typeof run.resumeNativeDelivery!=="function")
    return pause("ESCORT_DELIVERY_RESUME_AUTHORITY_UNAVAILABLE");
   let recovered;try{recovered=run.resumeNativeDelivery(scene,fleet,now)}
   catch{return pause("ESCORT_DELIVERY_RESUME_UNCERTAIN_NEEDS_REPAIR")}
   if(recovered?.status!=="ESCORT_ORIGINAL_NATIVE_DELIVERY_RESUMED")
    return pause(recovered?.status||"ESCORT_DELIVERY_RESUME_UNVERIFIED");
   // A stale A-Life no-cargo hint cannot terminate a separately proven
   // original, still-loaded native haul with signed cargo custody.
   delete fleet.coopStationNoCargo;
  }
 }
 if(fleet?.coopStationNoCargo){delete fleet.coopStationNoCargo;return {status:"NO_CARGO",terminal:true};}
 if(process.env.EVEJS_COOP_ESCORT_ROUTE_GATE==="1"&&
    fleet?.coopEscortPredepartureEventID&&!fleet?.coopStationArrival){
   return run.start(scene,fleet,now);
 }
 // Nothing is physically in flight, so there is nothing left to wait for. This
 // is also the self-healing exit for a fleet that stalled without any trip.
 if(!fleet?.coopStationArrival){
  if(process.env.EVEJS_COOP_NATIVE_STATION_TRIP_RECOVERY==="1"&&
     typeof run.recover==="function"&&typeof fleet?.startupKey==="string"){
   const rec=run.recover(scene,fleet,now);
   if(rec?.status!=="NO_PENDING_TRIP"&&rec?.status!=="RECOVERY_DISABLED"&&
      rec?.status!=="RECOVERED_EN_ROUTE")return rec;
  }
  if(!fleet?.coopStationArrival){
   noteRouteStatus(fleet,"NO_ACTIVE_TRIP");
   return {status:"NO_ACTIVE_TRIP",terminal:true};
  }
 }
 // Dwell and physical-arrival waits are progress, not blockers.
 const arrival=run.tick(scene,fleet,now);
 if(arrival?.terminal!==true&&arrival?.status!=="AWAITING_PHYSICAL_ARRIVAL"&&
  arrival?.status!=="ARRIVAL_DWELL_PENDING")noteRouteStatus(fleet,arrival?.status||"UNKNOWN");
 return arrival;
}
module.exports={createStationArrival,routeFromHaul,checkReturn,observePreferredOre,noteNativeMotion,restoreNativeIngress,getOriginalWarehouseReceipt,diagnoseArrival,diagnoseTrip};