"use strict";
// Real EveJS native cargo identity is preserved from miner to hauler.
// A durable PREPARED receipt is mandatory BEFORE native hauler unloading.
// Never credit virtual supply or station inventory unless cargo removal was
// confirmed. An interrupted intent remains visible for operator repair.
const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const mineable=x=>positive(x?.cargoID)&&positive(x?.typeID)&&Number.isSafeInteger(Number(x.quantity))&&Number(x.quantity)>0&&Number(x.moduleID||0)===0;
const haulFlag="coopHaulFleetID";
const load=name=>{try{return require("./"+name)}catch(_error){return require("./"+name+".cjs")}};
const {promote:durableCargo}=load("coopDurableCargoWrite");
const {observe:safeObserve}=load("coopObserve");
const flags=load("coopFlags");
function dependenciesOf(options={}){
 return {store:options.store||require("./npc/nativeNpcStore"),
 probe:options.probe||require("./coopRuntimeProbe"),
 depot:options.depot||(
  flags.on("EVEJS_COOP_NATIVE_HAUL_CARGO")
  ?require("./coopNativeDepot").getNativeDepot():null)};
}
// Chat 16: opt-in, conservative physical custody transfer for persistent NPCs.
// Uses the SAME original nativeNpcStore cargoID and an original GameStore flush.
// It never allocates cargo or credits virtual/station stock. Unknown outcomes
// quarantine both actors instead of replaying a possibly committed transfer.
const strictInFlight=new Set();
// One owner for "this pair needs an operator": the same five flags were
// written by two different failure paths and one of them could drift.
function markHaulRepair(actors,reason){
 for(const actor of actors)if(actor&&typeof actor==="object")actor.coopHaulNeedsOperatorRepair=reason;
}
const integer=x=>typeof x==="number"&&Number.isSafeInteger(x)&&x>0;
const vector=x=>x&&["x","y","z"].every(k=>Number.isFinite(x[k]));
const isWarping=x=>Boolean(x?.isWarping||x?.pendingWarp||x?.warpState||
 String(x?.mode||"").toUpperCase()==="WARP");
// One owner for the question "did the ore really become the hauler's cargo?".
// Both transfer paths ask it after the commit, so the strict and the normal
// path cannot drift apart again: the normal path used to accept a row that had
// the right cargoID but the wrong entity, owner, quantity or transience flag,
// and then removed the ore from the miner. A non-null result is a reason the
// caller must treat as "commit not proven"; the ore must stay where it was.
function verifyLoad({store,haulerID,minerID,cargoID,quantity,typeID,ownerID,fleetID,strict=false}={}){
 const rows=typeof store.listNativeCargo==="function"?store.listNativeCargo():
  (store.listNativeCargoForEntity?store.listNativeCargoForEntity(haulerID):[]);
 const hits=(Array.isArray(rows)?rows:[]).filter(x=>Number(x?.cargoID)===Number(cargoID));
 if(hits.length!==1)return "CARGO_ROW_MISSING_OR_DUPLICATED";
 const row=hits[0];
 if(Number(row.entityID)!==Number(haulerID))return "CARGO_ON_WRONG_ENTITY";
 if(Number(row.quantity)!==Number(quantity))return "CARGO_QUANTITY_CHANGED";
 if(row.transient===true)return "CARGO_STILL_TRANSIENT";
 if(strict&&row.transient!==false)return "CARGO_TRANSIENT_UNKNOWN";
 if(typeof store.listNativeCargoForEntity==="function"&&
    store.listNativeCargoForEntity(minerID).some(x=>Number(x?.cargoID)===Number(cargoID)))
  return "CARGO_STILL_ON_MINER";
 if(strict){
  if(Number(row.ownerID)!==Number(ownerID))return "CARGO_OWNER_CHANGED";
  if(Number(row.typeID)!==Number(typeID))return "CARGO_TYPE_CHANGED";
  if(Number(row[haulFlag])!==Number(fleetID))return "CARGO_FLEET_UNSET";
  if(Number(row.coopHaulFromMinerID)!==Number(minerID))return "CARGO_SOURCE_UNSET";
 }
 return null;
}
function strictTransferCargo(scene,fleet,miner,options,store,probe){
 const stop=(reason,uncertain=false,hauler=null,cargoID=0)=>{
  if(uncertain){
   miner.coopHaulNeedsOperatorRepair=reason;
   miner.coopHaulCargoNeedsOperatorRepair=reason;
   miner.coopMiningCargoNeedsOperatorRepair=reason;
   fleet.coopHaulCargoNeedsOperatorRepair=reason;
   markHaulRepair([fleet,hauler],reason);
  }
  safeObserve(probe,"living-haul-custody-blocked",
   {itemID:miner.itemID,systemID:scene?.systemID},
   {fleetID:fleet?.fleetID,cargoID,reason,operatorRepairRequired:uncertain,nativeMutation:false});
  return 0;
 };
 if(!flags.on("EVEJS_COOP_NATIVE_HAUL_CARGO")||
  !flags.on("EVEJS_COOP_NPC_STATION_DELIVERY")||
  !flags.on("EVEJS_COOP_NATIVE_MINING_CYCLE_ATOMIC"))
  return stop("HAUL_NATIVE_PERSISTENCE_FLAGS_REQUIRED");
 const atomicRequired=flags.on("EVEJS_COOP_NATIVE_MINING_FLEET_DURABLE")&&
   typeof fleet?.startupKey==="string"&&fleet.startupKey.length>0;
 if(atomicRequired&&!flags.on("EVEJS_COOP_NATIVE_HAUL_TRANSFER_ATOMIC"))
  return stop("ALIFE10_ATOMIC_HAUL_REQUIRED",true);
 const systemID=Number(scene?.systemID),fleetID=Number(fleet?.fleetID);
 const minerID=Number(miner?.itemID),minerOwner=Number(miner?.ownerID);
 if(![systemID,fleetID,minerID,minerOwner].every(integer)||
  !Array.isArray(fleet?.minerEntityIDs)||!fleet.minerEntityIDs.includes(minerID)||
  !Array.isArray(fleet?.haulerEntityIDs)||fleet.haulerEntityIDs.length<1||
  fleet.haulerEntityIDs.length>32||new Set(fleet.haulerEntityIDs).size!==fleet.haulerEntityIDs.length||
  Number(fleet.systemID)!==systemID||miner?.kind!=="ship"||miner?.nativeNpc!==true||
  miner.transient!==false||miner.coopHaulNeedsOperatorRepair||
  fleet.coopHaulNeedsOperatorRepair||
  scene.getEntityByID?.(minerID)!==miner||isWarping(miner)||
  miner.destroyed===true||miner.isDestroyed===true||!vector(miner.position))
  return stop("HAUL_MINER_NOT_PHYSICALLY_ATTESTED");
 if(typeof store.getNativeEntity!=="function"||
  typeof store.listNativeCargoForEntity!=="function"||
  typeof store.listNativeCargo!=="function"||
  typeof store.upsertNativeCargo!=="function"||
  typeof store.buildNativeCargoItems!=="function")
  return stop("HAUL_NATIVE_STORE_UNAVAILABLE");
 const originalMiner=store.getNativeEntity(minerID);
 if(!originalMiner||Number(originalMiner.entityID)!==minerID||
  Number(originalMiner.ownerID)!==minerOwner||Number(originalMiner.systemID)!==systemID||
  originalMiner.transient!==false)return stop("HAUL_MINER_NATIVE_IDENTITY_CONFLICT");
 const resolveType=options.resolveItemByTypeID||
  require("../services/inventory/itemTypeRegistry").resolveItemByTypeID;
 if(typeof resolveType!=="function")return stop("HAUL_SDE_UNAVAILABLE");
 let source,all;
 try{source=store.listNativeCargoForEntity(minerID);all=store.listNativeCargo();}
 catch(_){return stop("HAUL_CARGO_PREIMAGE_UNAVAILABLE");}
 if(!Array.isArray(source)||!Array.isArray(all)||source.length>1000||
  !Array.isArray(miner.nativeCargoItems))return stop("HAUL_CARGO_PREIMAGE_INVALID");
 const cached=new Map(miner.nativeCargoItems.map(x=>[Number(x?.itemID),x]));
 const seen=new Set(),cargo=[];
 for(const item of source){
  const key=Number(item?.cargoID),local=cached.get(key);
  if(!integer(key)||seen.has(key)||!integer(Number(item?.typeID))||
    !integer(Number(item?.quantity))||Number(item?.quantity)>1000000000||
    Number(item?.entityID)!==minerID||Number(item?.ownerID)!==minerOwner||
    Number(item?.moduleID||0)!==0||item.transient!==false||
    Number(item?.categoryID)!==25||
    Number(item?.coopHaulFleetID||0)!==0||
    !local||Number(local.typeID)!==Number(item.typeID)||
    Number(local.quantity)!==Number(item.quantity)||
    all.filter(x=>Number(x?.cargoID)===key).length!==1)
   return stop("HAUL_SOURCE_CARGO_IDENTITY_CONFLICT");
  seen.add(key);
  const ore=resolveType(Number(item.typeID));
  const volume=Number(ore?.volume);
  if(!ore||Number(ore.typeID)!==Number(item.typeID)||
     Number(ore.categoryID)!==25||!Number.isFinite(volume)||volume<=0)
   return stop("HAUL_ORE_VOLUME_UNVERIFIED");
  cargo.push({item,volume:volume*Number(item.quantity),unit:volume});
 }
 if(!cargo.length){
  if(miner.nativeCargoItems.some(x=>Number(x?.moduleID||0)===0))
   return stop("HAUL_LOCAL_CARGO_WITHOUT_NATIVE_SOURCE",true);
  return 0;
 }
 const db=atomicRequired?null:(options.database||require("../gameStore"));
 if(!atomicRequired&&(!db||typeof db.setTransientPath!=="function"||
  typeof db.flushTableSync!=="function"))return stop("HAUL_GAMESTORE_UNAVAILABLE");
 let totalMoved=0,quantity=0,count=0;
 // Pick the first physical, in-range hull that can take the WHOLE stack. When no hull
 // can, the largest free hold is used for what physically fits: a Mining Venture
 // could never take an 8 000 m3 stack, and refusing forever is how ore sat in the
 // belt while the world mined 93 cycles. A partial move is still one atomic cargo
 // transaction (source quantity down, a NEW cargo row on the hauler, one receipt),
 // never an invented item and never a merge of two different stacks.
 // Every hauler that is not chosen leaves a reason: the loop used to fall through
 // silently, so a fleet could report "loaded" with nothing moved and no way to
 // tell whether the hull was out of range, full, warping or unresolvable in SDE.
 for(const {item,volume,unit} of cargo){
  let selected=null,why="",skipped=[],partialUnits=0,bestFree=0,bestShip=null;
  const owned=tripOwnedHaulers(fleet);
  for(const haulerID of fleet.haulerEntityIDs){
   if(!integer(haulerID)||haulerID===minerID){skipped.push({haulerID,why:"invalid-id"});continue;}
   if(owned&&owned.has(Number(haulerID))){skipped.push({haulerID,why:"delivery-trip-owns-hull"});continue;}
   const ship=scene.getEntityByID(haulerID),native=store.getNativeEntity(haulerID);
   if(!ship||ship.itemID!==haulerID||ship.kind!=="ship")why="ship-missing";
   else if(ship.nativeNpc!==true||ship.transient!==false)why="not-durable-native";
   else if(ship.coopHaulNeedsOperatorRepair)why="needs-repair";
   else if(ship.destroyed===true||ship.isDestroyed===true)why="destroyed";
   else if(isWarping(ship))why="warping";
   else if(!vector(ship.position))why="no-position";
   else if(Number(ship.ownerID)!==minerOwner)why="owner-mismatch";
   else if(!native||Number(native.entityID)!==haulerID||
    Number(native.ownerID)!==minerOwner||Number(native.systemID)!==systemID||
    native.transient!==false)why="native-identity";
   if(why){skipped.push({haulerID,why});why="";continue;}
   const range=Math.max(0,Math.hypot(
    miner.position.x-ship.position.x,miner.position.y-ship.position.y,
    miner.position.z-ship.position.z)-Math.max(0,Number(miner.radius)||0)-
    Math.max(0,Number(ship.radius)||0));
   if(!Number.isFinite(range)||range>2500){
    skipped.push({haulerID,why:"out-of-range",rangeMeters:Number.isFinite(range)?Math.round(range):null});
    continue;
   }
   const hull=resolveType(Number(ship.typeID));
   const capacity=Number(options.resolveCargoCapacityM3?
    options.resolveCargoCapacityM3(ship,hull):hull?.capacity);
   if(!Number.isFinite(capacity)||capacity<=0){
    skipped.push({haulerID,why:"no-capacity",typeID:Number(ship.typeID)||0});continue;
   }
   const existing=store.listNativeCargoForEntity(haulerID);
   if(!Array.isArray(existing)||existing.length>1000){
    skipped.push({haulerID,why:"cargo-unreadable"});continue;
   }
   let used=0,valid=true,badRow=null;
   // Measured 2026-10-27: the hold carried the fleet's own lift-tagged minerals, and the
   // whole hold was declared invalid (why "cargo-invalid", usedM3 0) so the hauler could
   // never load again. Those rows legitimately belong to the CORPORATION - the same owner
   // as the hauler itself - not to the miner's owner, so the custody rule is "not another
   // party's cargo", not "exactly the miner's owner".
   const allowedOwners=new Set([Number(minerOwner),Number(ship.ownerID)]);
   for(const row of existing){
    const type=resolveType(Number(row?.typeID));
    const unit=Number(type?.volume);
    // Each predicate is evaluated once and reported, so a refusal always names the exact
    // condition instead of a generic "invalid" (measured: a row that looked perfect in
    // every printed field was still refused).
    const rowCargoID=Number(row?.cargoID);
    const rowQuantity=Number(row?.quantity);
    const rowReadable=integer(rowCargoID)&&integer(rowQuantity)&&
      row?.transient===false&&Number.isFinite(unit)&&unit>0;
    const rowOurs=Number(row?.entityID)===haulerID&&
      allowedOwners.has(Number(row?.ownerID));
    if(!rowReadable||!rowOurs){
     valid=false;
     badRow={cargoID:rowCargoID||0,quantity:Number.isFinite(rowQuantity)?rowQuantity:null,
      typeID:Number(row?.typeID)||0,ownerID:Number(row?.ownerID)||0,
      entityID:Number(row?.entityID)||0,haulerID,
      owners:[...allowedOwners].map(x=>Number(x)||0),
      transient:row?.transient===true,unit:Number.isFinite(unit)?unit:null,
      rowReadable,rowOurs,integerCargoID:integer(rowCargoID),
      integerQuantity:integer(rowQuantity)};
     break;
    }
    used+=unit*Number(row.quantity);
   }
   if(valid&&Number.isFinite(used)&&used+volume<=capacity+1e-6){selected=ship;break;}
   if(valid&&Number.isFinite(used)){
    const free=capacity-used;
    if(free>bestFree){bestFree=free;bestShip=ship;}
    if(free>0&&unit>0)partialUnits=Math.max(partialUnits,
     Math.floor((free-1e-6)/unit));
   }
   skipped.push({haulerID,why:valid?"full":"cargo-invalid",
    badRow,
    usedM3:Number.isFinite(used)?Math.round(used*100)/100:null,
    capacityM3:Math.round(capacity*100)/100,needM3:Math.round(volume*1000)/1000});
  }
  // Only the atomic mover can split a stack, and only down to whole units.
  let maxQuantity=null;
  if(!selected&&atomicRequired&&bestShip&&partialUnits>0){
   selected=bestShip;
   maxQuantity=partialUnits;
  }
  if(!selected){
   safeObserve(probe,"living-haul-no-hauler",{itemID:miner.itemID,systemID},
    {fleetID,minerID,cargoID:Number(item.cargoID),quantity:Number(item.quantity),
     volumeM3:Math.round(volume*1000)/1000,haulers:fleet.haulerEntityIDs.length,
     skipped:skipped.slice(0,8)});
   continue; // Leave the original persistent cargo on the miner.
  }
  const cargoID=Number(item.cargoID),key=systemID+":"+cargoID;
  if(strictInFlight.has(key))return stop("HAUL_TRANSFER_REENTRANT",true,selected,cargoID);
  strictInFlight.add(key);
  try{
   if(atomicRequired){
    // Keep all upstream physical range, capacity, and original ore type guards.
    // Only the final native cargo reparent is made transactional.
    const atomic=options.atomicMover||require("./coopNativeHaulTransferAtomic");
    const result=atomic.transfer({scene,fleet,miner,hauler:selected,cargoID,maxQuantity});
    if(result?.status!=="COMMITTED")
     return stop("ALIFE10_"+String(result?.reason||result?.status||"UNKNOWN"),true,selected,cargoID);
    const movedQty=Number(result.quantity);
    const expected=movedQty>0&&movedQty<=Number(item.quantity)?
     movedQty*unit:NaN;
    if(!Number.isSafeInteger(movedQty)||movedQty<=0||
       movedQty>Number(item.quantity)||!Number.isFinite(result.volumeM3)||
       Math.abs(result.volumeM3-expected)>1e-6)
     return stop("ALIFE10_AFTER_COMMIT_VOLUME_CONFLICT",true,selected,cargoID);
    if(result.partial===true?Number(result.sourceCargoID)!==cargoID:
       (movedQty!==Number(item.quantity)||Number(result.cargoID)!==cargoID))
     return stop("ALIFE10_AFTER_COMMIT_IDENTITY_CONFLICT",true,selected,cargoID);
    totalMoved+=result.volumeM3;quantity+=movedQty;count++;
   }else{
    const updated={...item,cargoID,entityID:selected.itemID,
     ownerID:minerOwner,transient:false,[haulFlag]:fleetID,
     coopHaulFromMinerID:minerID,coopHaulSystemID:Number(scene.systemID),
     coopHaulLoadedAt:Date.now()};
    const promoted=durableCargo({store,database:options.database,cargoID,row:updated});
    // An unsuccessful ACK does not establish that nothing was written.
    if(promoted.status==="UPSERT_REJECTED"||promoted.status==="UPSERT_UNCERTAIN")
     return stop("HAUL_SOURCE_MOVE_UNCERTAIN",true,selected,cargoID);
    if(promoted.status!== "DURABLE")
     return stop("HAUL_SOURCE_FLUSH_UNCERTAIN",true,selected,cargoID);
    const unproven=verifyLoad({store,haulerID:selected.itemID,minerID,cargoID,
     quantity:item.quantity,typeID:item.typeID,ownerID:minerOwner,fleetID,strict:true});
    if(unproven)return stop("HAUL_POSTCOMMIT_IDENTITY_UNKNOWN",true,selected,cargoID);
    miner.nativeCargoItems=miner.nativeCargoItems.filter(x=>Number(x.itemID)!==cargoID);
    selected.nativeCargoItems=store.buildNativeCargoItems(selected.itemID);
    totalMoved+=volume;quantity+=Number(item.quantity);count++;
   }
  }catch(_){return stop("HAUL_TRANSFER_OUTCOME_UNKNOWN",true,selected,cargoID);}
  finally{strictInFlight.delete(key);}
 }
 if(count){
  safeObserve(probe,"living-hauler-loaded",{itemID:miner.itemID,systemID},
   {fleetID,minerID,stacks:count,cargoQuantity:quantity,volumeM3:totalMoved,
    verifiedNativeCargo:true});
 }
 return totalMoved;
}
 // The delivery trip OWNS the hulls it declared: a manifest is an immutable
 // pre-warp snapshot, so ore loaded into a hull that is already flying that route
 // can never be part of it (measured live: every new load turned the pending trip
 // into ALIFE12_UNDECLARED_HAUL_CARGO and the fleet never returned to mining).
 // Returns the set of hauler IDs the active trip holds.
 function tripOwnedHaulers(fleet){
  const trip=fleet?.coopStationArrival;
  if(!trip||typeof trip!=="object")return null;
  const ids=Object.keys(trip.haulers&&typeof trip.haulers==="object"?trip.haulers:{})
   .map(Number).filter(x=>Number.isSafeInteger(x)&&x>0);
  return ids.length?new Set(ids):null;
 }
function transferCargo(scene,fleet,miner,options={}){
 try{
  if(!scene||!positive(miner?.itemID)||!positive(fleet?.fleetID))return 0;
  const {store,probe}=dependenciesOf(options);
  const durableRequired=flags.on("EVEJS_COOP_NATIVE_MINING_FLEET_DURABLE")&&
    miner?.transient===false&&typeof fleet?.startupKey==="string"&&
    fleet.startupKey.length>0;
  if(durableRequired||flags.on("EVEJS_COOP_NATIVE_HAUL_TRANSFER_GUARD"))
   return strictTransferCargo(scene,fleet,miner,options,store,probe);
  const owned=tripOwnedHaulers(fleet);
  const hauler=(fleet.haulerEntityIDs||[]).map(id=>scene.getEntityByID(Number(id)))
    .find(x=>x?.kind==="ship"&&positive(x.itemID)&&x.itemID!==miner.itemID&&
     !(owned&&owned.has(Number(x.itemID))));
  if(!hauler)return 0;
  const items=(store.listNativeCargoForEntity(miner.itemID)||[]).filter(mineable);
  let moved=0,quantity=0,volume=0;
  for(const item of items){
   const cached=(miner.nativeCargoItems||[]).find(x=>Number(x.itemID)===Number(item.cargoID));
   const amount=Number(item.quantity);
   // Restart resilience: a transient hauler's haul cargo is persisted too when
   // the adoption feature is on, so a restart can re-attach it to the next
   // hauler of the same slot instead of losing the ore. Without the flag the
   // conservative behaviour is unchanged.
   const durable=flags.on("EVEJS_COOP_NPC_STATION_DELIVERY")&&
     (hauler.transient!==true||flags.on("EVEJS_COOP_HAUL_CARGO_ADOPTION"));
   const next={...item,transient:durable?false:item.transient,entityID:Number(hauler.itemID),
    ownerID:positive(hauler.ownerID)||positive(item.ownerID)||0,
    [haulFlag]:Number(fleet.fleetID),coopHaulFromMinerID:Number(miner.itemID),
    coopHaulSystemID:Number(fleet.systemID),coopHaulLoadedAt:Date.now()};
   if(durable){
    // Promotes the SAME cargoID and removes its previous transient marker
    // before synchronous durability, never creating a second ore stack.
    const promoted=durableCargo({store,database:options.database,
     cargoID:item.cargoID,row:next});
    if(promoted.status!=="DURABLE"){
     safeObserve(probe,"living-hauler-cargo-persist-failed",
      {itemID:hauler.itemID,systemID:fleet.systemID},
      {fleetID:fleet.fleetID,cargoID:item.cargoID,status:promoted.status});
     continue;
    }
   }else if(!store.upsertNativeCargo(next,{transient:hauler.transient===true})?.success)continue;
   const unproven=verifyLoad({store,haulerID:hauler.itemID,minerID:miner.itemID,
    cargoID:item.cargoID,quantity:item.quantity,typeID:item.typeID,
    ownerID:next.ownerID,fleetID:next[haulFlag]});
   if(unproven){
    safeObserve(probe,"living-hauler-cargo-persist-failed",
     {itemID:hauler.itemID,systemID:fleet.systemID},
     {fleetID:fleet.fleetID,cargoID:item.cargoID,status:unproven});
    continue;
   }
   miner.nativeCargoItems=(miner.nativeCargoItems||[]).filter(x=>Number(x.itemID)!==Number(item.cargoID));
   quantity+=amount;volume+=amount*Math.max(0,Number(cached?.volume)||0);moved++;
  }
  if(moved){
   hauler.nativeCargoItems=store.buildNativeCargoItems(hauler.itemID);
   safeObserve(probe,"living-hauler-loaded",{itemID:hauler.itemID,systemID:fleet.systemID},
    {fleetID:fleet.fleetID,minerID:miner.itemID,haulerID:hauler.itemID,
     stacks:moved,cargoQuantity:quantity,volumeM3:volume});
  }
  return volume;
 }catch(error){
  if(miner?.transient===false&&flags.on("EVEJS_COOP_NATIVE_MINING_FLEET_DURABLE")){
   const reason="ALIFE10_UNEXPECTED_HAUL_OUTCOME";
   miner.coopMiningCargoNeedsOperatorRepair=reason;
   miner.coopHaulNeedsOperatorRepair=reason;
   fleet.coopHaulNeedsOperatorRepair=reason;
  }
  console.warn("[CoopHaul] transfer",error.message);return 0;
 }
}
function unloadCargo(scene,fleet,options={}){
 try{
  if(!scene||!positive(fleet?.fleetID)||!positive(fleet?.systemID)||
     positive(scene.systemID)!==positive(fleet.systemID))
   return {status:"INVALID",stacks:0};
  const {store,probe,depot}=dependenciesOf(options);
  // No depot -> no removal. Do not silently destroy NPC ore.
  if(!depot||typeof depot.prepare!=="function"||typeof depot.commit!=="function")
   return {status:"BLOCKED_DEPOT_UNAVAILABLE",stacks:0};
  let stacks=0,quantity=0,volumeM3=0,blocked=0;
  for(const rawID of fleet.haulerEntityIDs||[]){
   const hauler=scene.getEntityByID(Number(rawID));
   if(hauler?.kind!=="ship")continue;
   const haulerID=positive(hauler.itemID),ownerID=positive(hauler.ownerID);
   // Fleet membership is not corporate title. The live ship must be the
   // original requested hauler with an attested native corporate owner.
   if(!haulerID||haulerID!==positive(rawID)||!ownerID||
      hauler.coopHaulNeedsOperatorRepair){blocked++;continue;}
   // "Unknown" is not an empty hold. A failed native inventory adapter
   // must not make original ore silently disappear from the unloading plan.
   const before=store.listNativeCargoForEntity(haulerID);
   if(!Array.isArray(before)){blocked++;continue;}
   // Do not silently omit corrupt siblings tagged for the same fleet:
   // partial unload would credit good stacks while stranding suspicious ore.
   const manifest=before.filter(x=>Number(x?.[haulFlag])===Number(fleet.fleetID));
   const seenCargoIDs=new Set();
   if(manifest.some(item=>{
    const id=positive(item?.cargoID);
    if(!id||seenCargoIDs.has(id))return true;
    seenCargoIDs.add(id);
    return !mineable(item)||Number(item.entityID)!==haulerID||
      positive(item.ownerID)!==ownerID||
      Number(item.coopHaulSystemID)!==Number(fleet.systemID)||
      !positive(item.coopHaulFromMinerID)||item.transient!==false;
   })){blocked++;continue;}
   for(const item of manifest){
    const delivery={cargoID:Number(item.cargoID),typeID:Number(item.typeID),
      quantity:Number(item.quantity),fromMinerID:positive(item.coopHaulFromMinerID),
      haulerID:Number(hauler.itemID)};
    let prepared;
    try{prepared=depot.prepare({systemID:fleet.systemID,fleetID:fleet.fleetID,item:delivery});}
    catch(error){console.warn("[CoopHaul] cannot durably prepare",error.message);blocked++;continue;}
    if(prepared?.status!=="PREPARED"){blocked++;continue;}
    const cached=(hauler.nativeCargoItems||[]).find(x=>Number(x.itemID)===Number(item.cargoID));
    const removed=store.removeNativeCargo(item.cargoID);
    if(!removed?.success){blocked++;continue;}
    // The virtual depot journal is durable. A native cargo deletion that
    // exists only in memory is NOT a durable debit: after a server restart
    // the original cargoID would reappear alongside the committed credit.
    // Flush original npcCargo BEFORE verifying absence or depot.commit().
    let durableSourceDebit=false;
    try{
     const database=options.database||require("../gameStore");
     durableSourceDebit=database?.flushTableSync?.("npcCargo")?.success===true;
    }catch(error){
     console.warn("[CoopHaul] native cargo debit flush uncertain",error.message);
    }
    if(!durableSourceDebit){blocked++;continue;}
    // A mutation ACK is not proof of physical source debit. Require a
    // verified native cargo inventory array after removal; null/errors
    // leave the durable PREPARED intent for operator reconciliation.
    const after=store.listNativeCargoForEntity(hauler.itemID);
    if(!Array.isArray(after)||after.some(x=>
       Number(x?.cargoID)===Number(item.cargoID))){blocked++;continue;}
    // When the store supports global enumeration, also refuse a cargoID
    // silently moved to another hauler while removeNativeCargo returned OK.
    if(typeof store.listNativeCargo==="function"){
     const all=store.listNativeCargo();
     if(!Array.isArray(all)||all.some(x=>
        Number(x?.cargoID)===Number(item.cargoID))){blocked++;continue;}
    }
    let committed;
    try{committed=depot.commit({systemID:fleet.systemID,fleetID:fleet.fleetID,item:delivery});}
    catch(error){console.warn("[CoopHaul] NEEDS_REPAIR: removed cargo with pending receipt",error.message);blocked++;continue;}
    if(committed?.status!=="COMMITTED"){blocked++;continue;}
    stacks++;quantity+=delivery.quantity;volumeM3+=delivery.quantity*Math.max(0,Number(cached?.volume)||0);
   }
   hauler.nativeCargoItems=store.buildNativeCargoItems(hauler.itemID);
  }
  if(stacks)safeObserve(probe,"living-hauler-delivered",{systemID:fleet.systemID},
    {fleetID:fleet.fleetID,stacks,quantity,volumeM3,destination:"durable-virtual-depot",blocked});
  return {status:blocked?"NEEDS_REPAIR":stacks?"DELIVERED":"NO_CARGO",stacks,quantity,volumeM3,blocked};
 }catch(error){console.warn("[CoopHaul] unload",error.message);return {status:"ERROR",stacks:0};}
}
module.exports={transferCargo,unloadCargo,haulFlag};
