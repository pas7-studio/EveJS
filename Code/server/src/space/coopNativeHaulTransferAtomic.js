"use strict";
/**
 * ALIFE-10. Move the ORIGINAL native ore cargoID from a persistent miner to a
 * persistent hauler in one original GameStore npcCargo SQLite transaction.
 * No new item, ore or ID. A receipt is written in the SAME npcCargo SQL commit.
 */
const crypto=require("node:crypto");
const pos=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):0;
const sha=value=>crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const receiptKey=id=>"coopNativeHaulTransfer:"+id;
const mark=(actor,reason)=>{if(actor&&typeof actor==="object"){
 actor.coopHaulCargoNeedsOperatorRepair=reason;
 actor.coopHaulCargoLastError=reason;
}};
const failed=(miner,hauler,fleet,reason)=>{
 for(const actor of [miner,hauler,fleet])mark(actor,reason);
 // ALIFE-07 recognizes this native mining guard. Do not mine more ore into a
 // stranded ship while its original hauling custody is unresolved.
 if(miner&&typeof miner==="object")
  miner.coopMiningCargoNeedsOperatorRepair=reason;
 return {status:"NEEDS_OPERATOR_REPAIR",reason,quantity:0,volumeM3:0};
};
function createAtomicHaulMover({gameStore,nativeStore,resolveType,clock=()=>Date.now()}={}){
 if(!gameStore||!nativeStore||typeof resolveType!=="function")
  throw Error("ALIFE10_NATIVE_AUTHORITIES_REQUIRED");
 function transfer({scene,fleet,miner,hauler,cargoID,maxQuantity}={}){
  if(miner?.coopHaulCargoNeedsOperatorRepair||hauler?.coopHaulCargoNeedsOperatorRepair||
     fleet?.coopHaulCargoNeedsOperatorRepair)
   return {status:"NEEDS_OPERATOR_REPAIR",reason:"ALIFE10_REPAIR_ALREADY_REQUIRED",volumeM3:0};
  if(process.env.EVEJS_COOP_NATIVE_HAUL_TRANSFER_ATOMIC!=="1"||
     process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1"||
     process.env.EVEJS_COOP_NATIVE_MINING_FLEET_DURABLE!=="1"||
     process.env.EVEJS_COOP_NATIVE_HAUL_CARGO!=="1"||
     process.env.EVEJS_COOP_NPC_STATION_DELIVERY!=="1")
   return {status:"BLOCKED_FLAGS",volumeM3:0};
  const systemID=pos(scene?.systemID),minerID=pos(miner?.itemID),
    haulerID=pos(hauler?.itemID),fleetID=pos(fleet?.fleetID),id=pos(cargoID);
  const parts=String(fleet?.startupKey||"").split(":"),
    slot=pos(parts[1]),validSlot=parts.length===2&&parts[0]===String(systemID)&&
      slot>0&&slot<=16&&fleetID===systemID*32+slot;
  if(!systemID||!minerID||!haulerID||!fleetID||!id||minerID===haulerID||
     pos(fleet?.systemID)!==systemID||!validSlot||
     !Array.isArray(fleet?.minerEntityIDs)||!fleet.minerEntityIDs.includes(minerID)||
     !Array.isArray(fleet?.haulerEntityIDs)||!fleet.haulerEntityIDs.includes(haulerID)||
     miner?.kind!=="ship"||hauler?.kind!=="ship"||
     miner.nativeNpc!==true||hauler.nativeNpc!==true||
     miner.transient===true||hauler.transient===true||
     scene.getEntityByID(minerID)!==miner||scene.getEntityByID(haulerID)!==hauler)
   return failed(miner,hauler,fleet,"ALIFE10_PHYSICAL_FLEET_IDENTITY_INVALID");
  // This exported atomic writer can be called independently of the high-level
  // hauler selector. A valid fleet and source cargo are not proof that two
  // ships are physically close enough to transfer the original item.
  const vec=p=>p&&["x","y","z"].every(k=>typeof p[k]==="number"&&Number.isFinite(p[k]));
  const inWarp=ship=>Boolean(ship.isWarping||ship.pendingWarp||ship.warpState||
    String(ship.mode||"").toUpperCase().includes("WARP"));
  const radius=ship=>ship.radius===undefined||ship.radius===null?0:
    typeof ship.radius==="number"&&Number.isFinite(ship.radius)&&ship.radius>=0?
      ship.radius:NaN;
  const separation=vec(miner.position)&&vec(hauler.position)?
   Math.hypot(miner.position.x-hauler.position.x,
    miner.position.y-hauler.position.y,
    miner.position.z-hauler.position.z)-
    radius(miner)-radius(hauler):NaN;
  if(inWarp(miner)||inWarp(hauler)||!Number.isFinite(separation)||
     Math.max(0,separation)>2500)
   // Normal NPC motion is transient. Never quarantine a healthy hull just
   // because it was out of range during a legitimate world tick.
   return {status:"BLOCKED_PHYSICAL_RANGE",reason:"ALIFE10_SHIPS_NOT_COLOCATED",
    quantity:0,volumeM3:0};
  const minerRow=nativeStore.getNativeEntity(minerID),
    haulerRow=nativeStore.getNativeEntity(haulerID),
    minerController=nativeStore.getNativeController(minerID),
    haulerController=nativeStore.getNativeController(haulerID);
  const prefix="coop-mining-"+systemID+"-"+slot+"-";
  if([minerRow,haulerRow,minerController,haulerController].some(x=>!x||x.transient===true)||
     pos(minerRow?.ownerID)!==pos(miner.ownerID)||
     pos(haulerRow?.ownerID)!==pos(hauler.ownerID)||
     !pos(miner.ownerID)||!pos(hauler.ownerID)||
     pos(minerRow?.systemID)!==systemID||pos(haulerRow?.systemID)!==systemID||
     pos(minerController?.systemID)!==systemID||
     pos(haulerController?.systemID)!==systemID||
     minerRow.operatorKind!==prefix+"miner"||
     minerController.operatorKind!==prefix+"miner"||
     haulerRow.operatorKind!==prefix+"hauler"||
     haulerController.operatorKind!==prefix+"hauler")
   return failed(miner,hauler,fleet,"ALIFE10_ORIGINAL_NATIVE_ACTORS_NOT_PROVEN");
  const sourceList=nativeStore.listNativeCargoForEntity(minerID);
  const haulerList=nativeStore.listNativeCargoForEntity(haulerID);
  if(!Array.isArray(sourceList)||!Array.isArray(haulerList)||
     haulerList.some(x=>pos(x.cargoID)===id))
   return failed(miner,hauler,fleet,"ALIFE10_SOURCE_CARGO_AMBIGUOUS");
  const found=sourceList.filter(x=>pos(x?.cargoID)===id);
  if(found.length!==1)
   return failed(miner,hauler,fleet,"ALIFE10_SOURCE_NOT_IN_MINER");
  const before=found[0],typeID=pos(before.typeID),quantity=pos(before.quantity);
  if(pos(before.cargoID)!==id||pos(before.entityID)!==minerID||
     pos(before.ownerID)!==pos(miner.ownerID)||!typeID||!quantity||
     Number(before.moduleID||0)!==0||before.transient===true||
     before.coopHaulFleetID!=null)
   return failed(miner,hauler,fleet,"ALIFE10_SOURCE_CUSTODY_INVALID");
  const type=resolveType(typeID),volumePerUnit=Number(type?.volume);
  if(!type||pos(type.typeID)!==typeID||
     !Number.isFinite(volumePerUnit)||volumePerUnit<=0||
     !Number.isFinite(quantity*volumePerUnit)||quantity*volumePerUnit<=0)
   return failed(miner,hauler,fleet,"ALIFE10_SOURCE_VOLUME_UNPROVEN");
  const timestamp=Number(clock());
  if(!Number.isSafeInteger(timestamp)||timestamp<=0)
   return failed(miner,hauler,fleet,"ALIFE10_TIMESTAMP_INVALID");
  // A hauler that physically cannot hold the whole stack moves what fits, in the SAME
  // single transaction: the source row keeps its original cargoID with the remainder
  // and the moved units become ONE new cargo row on the hauler. Never an invented
  // item, never a merge, never a second receipt for the same destination row.
  const requested=Number(maxQuantity);
  const wantsPartial=maxQuantity!==undefined&&maxQuantity!==null;
  if(wantsPartial&&(!Number.isSafeInteger(requested)||requested<=0))
   return failed(miner,hauler,fleet,"ALIFE10_PARTIAL_QUANTITY_INVALID");
  const partial=wantsPartial&&requested<quantity;
  const movedQuantity=partial?requested:quantity;
  const remaining=quantity-movedQuantity;
  let destinationID=id;
  if(partial){
   if(typeof nativeStore.allocateCargoID!=="function")
    return failed(miner,hauler,fleet,"ALIFE10_CARGO_ALLOCATOR_UNAVAILABLE");
   // The native allocator answers {success, data}; a test double may answer the id.
   const allocated=nativeStore.allocateCargoID();
   destinationID=pos(allocated&&typeof allocated==="object"?
    (allocated.success===true?allocated.data:0):allocated);
   const allCargo=typeof nativeStore.listNativeCargo==="function"?
    nativeStore.listNativeCargo():null;
   if(!destinationID||destinationID===id||!Array.isArray(allCargo)||
      allCargo.some(x=>pos(x?.cargoID)===destinationID))
    return failed(miner,hauler,fleet,"ALIFE10_CARGO_ID_ALLOCATION_CONFLICT");
  }
  const after={...before,cargoID:destinationID,entityID:haulerID,ownerID:pos(hauler.ownerID),
    transient:false,quantity:movedQuantity,coopHaulFleetID:fleetID,coopHaulFromMinerID:minerID,
    coopHaulOriginalOwnerID:pos(miner.ownerID),coopHaulSystemID:systemID,
    coopHaulLoadedAt:timestamp,
    ...(partial?{coopHaulSplitFromCargoID:id,coopHaulSplitRemaining:remaining}:{})};
  const remainder=partial?{...before,quantity:remaining}:null;
  const beforeHash=sha(before),afterHash=sha(after);
  const proof={version:1,status:"COMMITTED",cargoID:destinationID,systemID,fleetID,
    minerID,haulerID,sourceOwnerID:pos(miner.ownerID),
    haulerOwnerID:pos(hauler.ownerID),typeID,quantity:movedQuantity,beforeHash,afterHash,
    loadedAt:timestamp,partial,sourceCargoID:id,remainingQuantity:remaining};
  const authority=gameStore.coopAtomicNativeRows;
  if(!authority||typeof authority.transact!=="function")
   return failed(miner,hauler,fleet,"ALIFE10_NATIVE_SQLITE_AUTHORITY_UNAVAILABLE");
  let outcome;
  try{
   outcome=authority.transact(["npcCargo"],tx=>{
    const old=tx.get("npcCargo",receiptKey(destinationID));
    if(old)throw Error("ALIFE10_CARGO_TRANSFER_ALREADY_WITNESSED");
    const root=tx.get("npcCargo","cargo");
    if(!root||typeof root!=="object"||Array.isArray(root))
     throw Error("ALIFE10_NATIVE_CARGO_ROOT_UNAVAILABLE");
    const actual=root[String(id)];
    if(!actual||sha(actual)!==beforeHash||
       pos(actual.entityID)!==minerID||pos(actual.ownerID)!==pos(miner.ownerID))
     throw Error("ALIFE10_SOURCE_CARGO_CAS_CONFLICT");
    const nextRoot={...root};
    if(partial){
     if(nextRoot[String(destinationID)]||Object.keys(nextRoot).includes(String(destinationID)))
      throw Error("ALIFE10_DESTINATION_CARGO_ID_TAKEN");
     nextRoot[String(id)]=remainder;
     nextRoot[String(destinationID)]=after;
    }else nextRoot[String(id)]=after;
    // The next owner/location and an immutable receipt become visible together.
    tx.put("npcCargo","cargo",nextRoot);
    tx.put("npcCargo",receiptKey(destinationID),proof);
    return proof;
   });
  }catch(error){
   return failed(miner,hauler,fleet,"ALIFE10_ATOMIC_OUTCOME_UNKNOWN_OR_REJECTED:"+String(error?.message||error).slice(0,90));
  }
  // Commit succeeded. Read original native records; do not ever compensate
  // by minting or writing a second cargo row.
  try{
   const haulerCargo=nativeStore.listNativeCargoForEntity(haulerID),
     minerCargo=nativeStore.listNativeCargoForEntity(minerID);
   const moved=(haulerCargo||[]).filter(x=>pos(x.cargoID)===destinationID);
   const still=(minerCargo||[]).filter(x=>pos(x.cargoID)===id);
   const sourceOk=partial?
     (still.length===1&&Number(still[0].quantity)===remaining&&sha(still[0])===sha(remainder)):
     still.length===0;
   if(!Array.isArray(minerCargo)||moved.length!==1||!sourceOk||sha(moved[0])!==afterHash||
      outcome?.cargoID!==destinationID||outcome?.afterHash!==afterHash)
    return failed(miner,hauler,fleet,"ALIFE10_POSTCOMMIT_CUSTODY_READBACK_FAILED");
   if(typeof nativeStore.buildNativeCargoItems!=="function")
    return failed(miner,hauler,fleet,"ALIFE10_POSTCOMMIT_CARGO_BUILDER_MISSING");
   const rebuilt=nativeStore.buildNativeCargoItems(haulerID);
   if(!Array.isArray(rebuilt)||rebuilt.filter(x=>pos(x?.itemID)===destinationID).length!==1)
    return failed(miner,hauler,fleet,"ALIFE10_POSTCOMMIT_CARGO_BUILD_INVALID");
   // Update both in-memory ships only after ALL source/readback checks pass.
   const minerLocal=Array.isArray(miner.nativeCargoItems)?miner.nativeCargoItems:[];
   miner.nativeCargoItems=partial?
    minerLocal.map(x=>pos(x?.itemID)===id?{...x,quantity:remaining}:x):
    minerLocal.filter(x=>pos(x?.itemID)!==id);
   hauler.nativeCargoItems=rebuilt;
   return {status:"COMMITTED",cargoID:destinationID,sourceCargoID:id,fleetID,
     partial,quantity:movedQuantity,remainingQuantity:remaining,
     volumeM3:movedQuantity*volumePerUnit,receipt:outcome};
  }catch(error){
   return failed(miner,hauler,fleet,"ALIFE10_POSTCOMMIT_READBACK_UNKNOWN:"+String(error?.message||error).slice(0,80));
  }
 }
 return Object.freeze({transfer});
}
let live;
function transfer(args){
 if(!live)live=createAtomicHaulMover({
  gameStore:require("../gameStore"),
  nativeStore:require("./npc/nativeNpcStore"),
  resolveType:require("../services/inventory/itemTypeRegistry").resolveItemByTypeID,
 });
 return live.transfer(args);
}
module.exports={createAtomicHaulMover,transfer,receiptKey};
