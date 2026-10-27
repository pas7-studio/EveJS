"use strict";
/**
 * ALIFE-07. One authoritative SQLite commit for the source asteroid and
 * original nativeNpcStore cargo. No second item/currency authority.
 * Strict opt-in; only persistent NPCs in a single GameStore owner process.
 */
const crypto = require("node:crypto");
const SEP = "\u001f";
const MAX_QTY = 1000000000;
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const integer = value => Number.isSafeInteger(Number(value)) && Number(value) >= 0;
const clone = value => JSON.parse(JSON.stringify(value));

// Blocking has two very different meanings and both used to overwrite the same
// field, so the original reason was lost and a pure configuration refusal looked
// exactly like an uncertain native mutation:
//  - the co-op rules are not enabled (or the rock/ship is not durable): nothing
//    was read or written, so the hull stays usable and must NOT be marked for
//    operator repair - otherwise enabling the flags later can never start the loop;
//  - a real custody question (yield, identities, post-commit readback): keep the
//    first reason verbatim and require an operator.
const CONFIG_ONLY = new Set([
  "ALIFE07_ATOMIC_FLAGS_REQUIRED",
  "ALIFE07_PERSISTENT_NPC_REQUIRED",
  "ALIFE07_PERSISTENT_ROCK_REQUIRED",
]);
// The store can also refuse *before* the transaction begins: it will not mix a
// durable write with transient cache cargo, or a table is not cached, or a flush
// is still in flight. Nothing was journaled and nothing was written, so those are
// the same class as a missing flag - and marking a hull for operator repair here
// produced a clear/re-block loop (measured: 52 repair-cleared events in 5 min on a
// world whose image predated the cargo contract).
const PRE_MUTATION = /NATIVE_TRANSIENT_STATE_UNSAFE|NATIVE_GAMESTORE_TABLE_UNAVAILABLE|NATIVE_GAMESTORE_PERSISTENCE_NOT_QUIESCENT|NATIVE_GAMESTORE_ATOMIC_REENTRANT|ALIFE07_MINING_ATOMIC_DISABLED|NATIVE_GAMESTORE_ATOMIC_DISABLED/;
function blocked(entity, reason) {
  if (entity && typeof entity === "object") {
    if (CONFIG_ONLY.has(reason) || PRE_MUTATION.test(String(reason || ""))) {
      entity.coopMiningCargoLastError = reason;
    } else {
      entity.coopMiningCargoNeedsOperatorRepair =
        entity.coopMiningCargoNeedsOperatorRepair || reason;
      entity.coopMiningCargoLastError = reason;
    }
  }
  return {success:false,stopReason:"cargo",reason};
}
// A durable hull can carry a sticky "needs operator repair" marker from a commit
// that was refused *before* anything was written: the atomic store refuses while
// the native npcCargo table still has transient paths
// (NATIVE_TRANSIENT_STATE_UNSAFE), which happens in assertTables/flush, i.e. ahead
// of the journal and the SQLite transaction. Such a marker is not an uncertain
// custody state, and leaving it set stops the hull forever - across restarts, so
// the world would never mine again. Only that exact pre-mutation refusal is
// cleared; every other marker still requires an operator.
const PRE_MUTATION_BLOCK = /^ALIFE07_ATOMIC_COMMIT_UNKNOWN_OR_REJECTED.*NATIVE_TRANSIENT_STATE_UNSAFE/;
function clearProvablePreMutationBlock(entity) {
  const reason = String(entity.coopMiningCargoNeedsOperatorRepair || "");
  if (!reason || !PRE_MUTATION_BLOCK.test(reason)) return false;
  entity.coopMiningCargoNeedsOperatorRepair = undefined;
  entity.coopMiningCargoLastError = undefined;
  console.warn("[CoopNativeMiningAtomic] cleared pre-mutation block: " + reason);
  try {
    require("./coopRuntimeProbe").observe("living-mining-cargo-repair-cleared", null,
      {spaceState: {systemID: Number(entity.systemID) || 0}},
      {status: "CLEARED", reason, shipID: Number(entity.itemID) || 0, nativeMutation: false});
  } catch (_error) { /* telemetry never authorizes custody */ }
  return true;
}

// A zero-quantity cycle still settles the rock (all waste), but it must not look
// like ore was produced, so `quantity` is reported verbatim and the verdict only
// counts it when it is positive.
function noteSettled(scene, entity, detail) {
  try {
    require("./coopRuntimeProbe").observe("living-mining-cycle-settled", null,
      {spaceState: {systemID: Number(detail.systemID) || 0}},
      {status: "COMMITTED", ...detail});
  } catch (_error) { /* telemetry never authorizes custody */ }
}

function createAtomicMiningSettler({gameStore,nativeStore,resolveType}={}) {
  if (!gameStore || !nativeStore || typeof resolveType !== "function")
    throw Error("ALIFE07_NATIVE_AUTHORITIES_REQUIRED");

  function settle(input) {
    const {scene,entity,targetEntity,mineableState,miningResult,transferredQuantity,
      cycleBoundaryMs,moduleItem,commitScene,readState} = input || {};
    if (entity) clearProvablePreMutationBlock(entity);
    if (!entity || entity.coopMiningCargoNeedsOperatorRepair)
      return blocked(entity, entity && entity.coopMiningCargoNeedsOperatorRepair
        ? "ALIFE07_REPAIR_REQUIRED:" + String(entity.coopMiningCargoNeedsOperatorRepair)
        : "ALIFE07_REPAIR_REQUIRED");
    if (process.env.EVEJS_COOP_NATIVE_MINING_CYCLE_ATOMIC !== "1" ||
        process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS !== "1" ||
        process.env.EVEJS_COOP_NATIVE_MINING_CARGO_INTEGRITY !== "1" ||
        process.env.EVEJS_COOP_NATIVE_MINING_CYCLE_CONSERVATION !== "1")
      return blocked(entity,"ALIFE07_ATOMIC_FLAGS_REQUIRED");
    // The native fleet spawner currently creates transient ships by default.
    // A transient ship/cargo has no stable source after restart: reject it.
    if (entity.transient === true)
      return blocked(entity,"ALIFE07_PERSISTENT_NPC_REQUIRED");
    if (targetEntity && (targetEntity.dungeonMaterializedSiteContent === true ||
        targetEntity.dungeonSiteContentMissionObjectiveTarget === true ||
        Number(targetEntity.dungeonSiteInstanceID || 0) > 0))
      return blocked(entity,"ALIFE07_PERSISTENT_ROCK_REQUIRED");

    const systemID=Number(scene?.systemID), rockID=Number(targetEntity?.itemID);
    const shipID=Number(entity.itemID), ownerID=Number(entity.ownerID ??
      entity.pilotCharacterID ?? entity.characterID), oreTypeID=Number(mineableState?.yieldTypeID);
    const moduleID=Number(moduleItem?.itemID), before=Number(mineableState?.remainingQuantity);
    const normal=Number(miningResult?.normalQuantity), wasted=Number(miningResult?.wastedQuantity);
    const quantity=Number(transferredQuantity), consumed=quantity+wasted;
    // A cycle boundary is a millisecond instant, but the runtime hands it over as
    // a float (effect timing math), so a strict safe-integer check rejected every
    // real cycle with ALIFE07_YIELD_INVALID:cycleBoundaryMs. Round it once; the
    // value is only used to build the journal operation key.
    const cycleRaw = Number(cycleBoundaryMs);
    const cycle = Number.isFinite(cycleRaw) ? Math.round(cycleRaw) : NaN;
    // Every refusal names the input that failed. A single ALIFE07_YIELD_INVALID
    // for eleven different checks meant a stuck fleet with no way to tell whether
    // the ship id, the ore type, the owner or the scene preimage was wrong.
    const invalid = field => blocked(entity, "ALIFE07_YIELD_INVALID:" + field);
    if (!scene || typeof scene.getEntityByID !== "function")
      return invalid("scene");
    if (!positive(systemID)) return invalid("systemID");
    if (!positive(rockID)) return invalid("rockID");
    if (!positive(shipID)) return invalid("shipID");
    if (!positive(ownerID)) return invalid("ownerID");
    if (!positive(oreTypeID)) return invalid("oreTypeID");
    if (!positive(moduleID)) return invalid("moduleID");
    if (!positive(cycle)) return invalid("cycleBoundaryMs");
    if (!integer(before)) return invalid("remainingQuantity");
    if (!integer(normal)) return invalid("normalQuantity");
    if (!integer(wasted)) return invalid("wastedQuantity");
    if (!integer(quantity)) return invalid("transferredQuantity");
    if (!integer(consumed)) return invalid("consumed");
    if (consumed <= 0) return invalid("consumedZero");
    if (consumed > before) return invalid("consumedOverRock");
    if (quantity > MAX_QTY || normal > MAX_QTY || wasted > MAX_QTY)
      return invalid("quantityOverLimit");
    if (quantity < normal) return invalid("quantityBelowNormal");
    if (scene.getEntityByID(rockID) !== targetEntity)
      return invalid("sceneRockIdentity");
    if (typeof commitScene !== "function") return invalid("commitScene");
    if (typeof readState !== "function") return invalid("readState");
    const snapshot=readState();
    if (!snapshot || ![before,before-consumed].includes(Number(snapshot.remainingQuantity)) ||
        Number(snapshot.yieldTypeID)!==oreTypeID)
      return blocked(entity,"ALIFE07_SCENE_PREIMAGE_CONFLICT");
    const type=resolveType(oreTypeID);
    if (!type || Number(type.typeID)!==oreTypeID)
      return blocked(entity,"ALIFE07_TYPE_UNRESOLVED");
    const cargoList=entity.nativeCargoItems;
    if (cargoList!=null && !Array.isArray(cargoList))
      return blocked(entity,"ALIFE07_LOCAL_CARGO_INVALID");
    const oreEntries=(cargoList||[]).filter(c=>Number(c?.typeID)===oreTypeID &&
      Number(c?.moduleID||0)===0);
    if (oreEntries.length>1) return blocked(entity,"ALIFE07_DUPLICATE_LOCAL");
    const local=oreEntries[0]||null;
    const cargoID=local?Number(local.itemID):0;
    if (local && (!positive(cargoID) ||
        Number(local.ownerID)!==ownerID || Number(local.locationID)!==shipID ||
        !integer(local.quantity) || Number(local.quantity)>MAX_QTY))
      return blocked(entity,"ALIFE07_LOCAL_IDENTITY_CONFLICT");

    const op=[systemID,rockID,shipID,moduleID,cycle].join(":");
    const fingerprint=crypto.createHash("sha256")
      .update(JSON.stringify([op,oreTypeID,before,normal,wasted,quantity])).digest("hex");
    const opKey="coopMiningCycle:"+crypto.createHash("sha256").update(op).digest("hex");
    const authority=gameStore.coopAtomicNativeRows;
    if (!authority || typeof authority.transact!=="function")
      return blocked(entity,"ALIFE07_GAMESTORE_BRIDGE_UNAVAILABLE");

    // Reserve the original native cargo ID via the ORIGINAL allocator, never a
    // second ID source. The reserved counter is flushed by the GameStore atomic
    // adapter before the two-table transaction. Unused gaps are harmless.
    let reservedID=0;
    if (!local && quantity>0) {
      try {
        const issued=nativeStore.allocateCargoID({transient:false});
        if (!issued?.success || !positive(issued.data))
          return blocked(entity,"ALIFE07_NATIVE_ALLOCATOR_REJECTED");
        reservedID=Number(issued.data);
      }catch(_){return blocked(entity,"ALIFE07_NATIVE_ALLOCATOR_UNKNOWN");}
    }

    let receipt;
    try {
      receipt=authority.transact(["miningRuntimeState","npcCargo"],tx=>{
        const prior=tx.get("miningRuntimeState",opKey);
        if (prior) {
          if (prior.fingerprint!==fingerprint || prior.status!=="COMMITTED")
            throw Error("ALIFE07_OPERATION_REPLAY_CONFLICT");
          if (Number(prior.quantity)>0) {
            const priorCargo=tx.get("npcCargo","cargo");
            if (!priorCargo || !priorCargo[String(prior.cargoID)] ||
                Number(priorCargo[String(prior.cargoID)].quantity)!==Number(prior.nextCargo))
              throw Error("ALIFE07_REPLAY_CARGO_MOVED_OR_DIVERGED");
          }
          return {...prior,replayed:true};
        }
        if (Number(snapshot.remainingQuantity)!==before)
          throw Error("ALIFE07_NONREPLAY_SCENE_STALE");
        const rockKey="systems"+SEP+systemID;
        const systemRow=tx.get("miningRuntimeState",rockKey);
        if (systemRow!==null &&
            (!systemRow || typeof systemRow!=="object" ||
             Array.isArray(systemRow) || (systemRow.entities!=null &&
             (typeof systemRow.entities!=="object" || Array.isArray(systemRow.entities)))))
          throw Error("ALIFE07_SOURCE_LAYOUT_INVALID");
        const current=systemRow?.entities?.[String(rockID)]||null;
        if (current && (!integer(current.remainingQuantity) ||
            Number(current.remainingQuantity)!==before ||
            Number(current.yieldTypeID)!==oreTypeID ||
            Number(current.entityID)!==rockID))
          throw Error("ALIFE07_SOURCE_CAS_CONFLICT");
        // A missing source record means a never-mined native asteroid baseline,
        // not permission to reset a previously depleted source.
        if (!current && (!positive(mineableState.originalQuantity) ||
            Number(mineableState.originalQuantity)!==before))
          throw Error("ALIFE07_UNPERSISTED_SOURCE_NOT_BASELINE");
        const cargoRoot=tx.get("npcCargo","cargo");
        if (!cargoRoot || typeof cargoRoot!=="object" || Array.isArray(cargoRoot))
          throw Error("ALIFE07_NATIVE_CARGO_LAYOUT_INVALID");
        const byType=Object.values(cargoRoot).filter(c=>c &&
          Number(c.entityID)===shipID && Number(c.moduleID||0)===0 &&
          Number(c.typeID)===oreTypeID);
        if (byType.length !== (local?1:0))
          throw Error("ALIFE07_CARGO_SOURCE_CAS_CONFLICT");
        const original=local?byType[0]:null;
        if (original && (Number(original.cargoID)!==cargoID ||
            Number(original.ownerID)!==ownerID ||
            Number(original.quantity)!==Number(local.quantity) ||
            original.transient===true))
          throw Error("ALIFE07_CARGO_OWNER_OR_QUANTITY_CONFLICT");
        const targetCargoID=quantity>0?(original?cargoID:reservedID):0;
        if (quantity>0 && (!positive(targetCargoID) ||
            (!original && cargoRoot[String(targetCargoID)])))
          throw Error("ALIFE07_CARGO_ID_COLLISION");
        const nextCargo=quantity>0?(original?Number(original.quantity):0)+quantity:0;
        if (!integer(nextCargo) || nextCargo>MAX_QTY)
          throw Error("ALIFE07_CARGO_OVERFLOW");
        const now=Number(cycleBoundaryMs);
        const nextRock={...(current||mineableState),entityID:rockID,
          yieldTypeID:oreTypeID,remainingQuantity:before-consumed,updatedAtMs:now};
        const nextCargoRow=original?
          {...original,quantity:nextCargo}:
          {cargoID:targetCargoID,entityID:shipID,ownerID,moduleID:0,
            typeID:oreTypeID,groupID:Number(type.groupID)||0,
            categoryID:Number(type.categoryID)||0,itemName:String(type.name||""),
            quantity:nextCargo,singleton:false,transient:false};
        const prepared={version:1,status:"COMMITTED",fingerprint,op,
          systemID,shipID,rockID,ownerID,oreTypeID,moduleID,
          beforeRock:before,afterRock:before-consumed,cargoID:targetCargoID,
          beforeCargo:original?Number(original.quantity):0,nextCargo,
          quantity,normal,wasted,cycleBoundaryMs:now};
        tx.put("miningRuntimeState",rockKey,{
          ...(systemRow||{}),entities:{...(systemRow?.entities||{}),[String(rockID)]:nextRock}});
        if (quantity>0)
          tx.put("npcCargo","cargo",{...cargoRoot,[String(targetCargoID)]:nextCargoRow});
        tx.put("miningRuntimeState",opKey,prepared);
        return prepared;
      });
    }catch(error){
      return blocked(entity,"ALIFE07_ATOMIC_COMMIT_UNKNOWN_OR_REJECTED:"+String(error?.message||error).slice(0,105));
    }

    // The SQLite transaction has committed. From now on *never* compensate
    // by minting/debiting again. Reconcile scene and local views only.
    try {
      const source=gameStore.read("miningRuntimeState",
        "/systems/"+systemID+"/entities/"+rockID);
      const cargo=receipt.quantity>0?nativeStore.listNativeCargoForEntity(shipID)
        .filter(c=>Number(c?.cargoID)===Number(receipt.cargoID)):[];
      const cargoValid=receipt.quantity===0 || (cargo.length===1 &&
        Number(cargo[0].ownerID)===ownerID &&
        Number(cargo[0].typeID)===oreTypeID &&
        Number(cargo[0].quantity)===receipt.nextCargo);
      if (!source?.success || Number(source.data?.remainingQuantity)!==receipt.afterRock ||
          Number(source.data?.yieldTypeID)!==oreTypeID || !cargoValid)
        return blocked(entity,"ALIFE07_POSTCOMMIT_SOURCE_READBACK_UNKNOWN");

      const currentScene=readState();
      let deltaResult;
      if (Number(currentScene?.remainingQuantity)===receipt.beforeRock) {
        deltaResult=commitScene(); // Native asteroid visuals, NOT another source write.
      }else if(Number(currentScene?.remainingQuantity)===receipt.afterRock) {
        deltaResult={success:true,data:{depleted:receipt.afterRock===0,replayed:true}};
      }else{
        return blocked(entity,"ALIFE07_POSTCOMMIT_SCENE_DIVERGED");
      }
      if (!deltaResult?.success)
        return blocked(entity,"ALIFE07_POSTCOMMIT_SCENE_FAILED");
      if (receipt.quantity===0) return {success:true,deltaResult,receipt};
      const updated=(Array.isArray(entity.nativeCargoItems)?entity.nativeCargoItems:[])
        .filter(c=>Number(c?.typeID)===oreTypeID && Number(c?.moduleID||0)===0);
      if (updated.length>1) return blocked(entity,"ALIFE07_POSTCOMMIT_DUPLICATE_LOCAL");
      const old=updated[0];
      if (old && Number(old.itemID)!==receipt.cargoID)
        return blocked(entity,"ALIFE07_POSTCOMMIT_LOCAL_ID_CONFLICT");
      const localRow={itemID:receipt.cargoID,ownerID,locationID:shipID,moduleID:0,
        typeID:oreTypeID,groupID:Number(type.groupID)||0,
        categoryID:Number(type.categoryID)||0,quantity:receipt.nextCargo,
        stacksize:receipt.nextCargo,singleton:0,flagID:5,
        itemName:String(type.name||"type "+oreTypeID),
        volume:Math.max(0,Number(type.volume)||0)};
      if (old) Object.assign(old,localRow);
      else if (Array.isArray(entity.nativeCargoItems)) entity.nativeCargoItems.push(localRow);
      else entity.nativeCargoItems=[localRow];
      // The one product proof of a mining cycle: this native transaction really
      // took ore off the rock and really put it in the hull. Everything else we can
      // observe (module active, lock held, cycle attempted) is an input.
      noteSettled(scene, entity, {
        shipID,rockID,systemID,moduleID,oreTypeID,
        quantity,wasted,beforeRock:receipt.beforeRock,afterRock:receipt.afterRock,
        cargoID:receipt.cargoID,nextCargo:receipt.nextCargo,
        replayed:receipt.replayed===true,
      });
      return {success:true,deltaResult,receipt};
    }catch(_){return blocked(entity,"ALIFE07_POSTCOMMIT_RECONCILIATION_UNKNOWN");}
  }
  return Object.freeze({settle});
}

let live;
function settle(input) {
  if (!live) live=createAtomicMiningSettler({
    gameStore:require("../gameStore"),
    nativeStore:require("./npc/nativeNpcStore"),
    resolveType:require("../services/inventory/itemTypeRegistry").resolveItemByTypeID,
  });
  return live.settle(input);
}
module.exports={createAtomicMiningSettler,settle};
