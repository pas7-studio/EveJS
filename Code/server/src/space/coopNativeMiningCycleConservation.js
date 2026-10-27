"use strict";
// ALIFE-06. Conservative same-tick custody gate, NOT a cross-table atomic transaction.
// A pre-existing journal record in PREPARED/DEBITED/UNCERTAIN state needs operator review.
const fs = require("node:fs");
const path = require("node:path");
const inflight = new Set();
// A callback may synchronously trigger another mining cycle in this process.
// The same rock or hull must not enter a second source/cargo mutation even
// when the second cycle uses a different rock/ship pair.
const inflightRocks = new Set();
const inflightShips = new Set();
const integer = x => Number.isSafeInteger(Number(x)) && Number(x) > 0;
function fail(entity, reason) {
  if (entity && typeof entity === "object") {
    entity.coopMiningCargoNeedsOperatorRepair = reason;
    entity.coopMiningCargoLastError = reason;
  }
  return {success:false,stopReason:"cargo",reason};
}
function atomicSave(file, record) {
  const temp = file + "." + process.pid + ".tmp";
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(record) + "\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);fd=undefined;
    fs.renameSync(temp, file);
    // Windows cannot always fsync directory handles; lack of fsync here
    // is a KNOWN crash-durability limitation, not a durable transaction.
    if (process.platform !== "win32") {
      const dirfd = fs.openSync(path.dirname(file), "r");
      try {fs.fsyncSync(dirfd);} finally {fs.closeSync(dirfd);}
    }
  } finally {
    if (fd!==undefined) fs.closeSync(fd);
    try {fs.unlinkSync(temp);} catch (_) {}
  }
}
function settle(input) {
  const {scene,entity,targetEntity,mineableState,miningResult,transferredQuantity,
    cycleBoundaryMs,debit,credit,readState} = input || {};
  if (!entity) return fail(entity,"ALIFE06_REPAIR_REQUIRED");
  if (entity.coopMiningCargoNeedsOperatorRepair)
    return {success:false,stopReason:"cargo",reason:entity.coopMiningCargoNeedsOperatorRepair};
  if (process.env.EVEJS_COOP_NATIVE_MINING_CARGO_INTEGRITY !== "1")
    return fail(entity,"ALIFE06_CARGO_STRICT_REQUIRED");
  const dir = process.env.EVEJS_COOP_MINING_CYCLE_JOURNAL_DIR;
  if (!dir || !path.isAbsolute(dir)) return fail(entity,"ALIFE06_JOURNAL_DIR_REQUIRED");
  const systemID = Number(scene && scene.systemID), shipID = Number(entity.itemID);
  const rockID = Number(targetEntity && targetEntity.itemID);
  const oreTypeID = Number(mineableState && mineableState.yieldTypeID);
  const before = Number(mineableState && mineableState.remainingQuantity);
  const normal = Number(miningResult && miningResult.normalQuantity);
  const wasted = Number(miningResult && miningResult.wastedQuantity);
  const qty = Number(transferredQuantity);
  const consumed = normal + wasted;
  // The native miningState writer explicitly skips dungeon materialized
  // resource entities; those cannot back persistent cargo after a restart.
  if (targetEntity && (targetEntity.dungeonMaterializedSiteContent === true ||
      targetEntity.dungeonSiteContentMissionObjectiveTarget === true ||
      Number(targetEntity.dungeonSiteInstanceID || 0) > 0))
    return fail(entity,"ALIFE06_SOURCE_NOT_PERSISTED");
  if (![systemID,shipID,rockID,oreTypeID].every(integer) ||
      ![before,normal,wasted,qty,consumed].every(Number.isSafeInteger) ||
      before<=0 || consumed<=0 || consumed>before ||
      normal<0 || wasted<0 || qty<0 || qty>1000000000 ||
      qty<normal || !Number.isSafeInteger(Number(cycleBoundaryMs)) ||
      Number(cycleBoundaryMs)<=0 ||
      typeof debit!=="function" || typeof credit!=="function" ||
      typeof readState!=="function")
    return fail(entity,"ALIFE06_INVALID_YIELD");
  let root;
  try {
    root=fs.realpathSync(dir);
    if (!fs.statSync(root).isDirectory() || fs.lstatSync(dir).isSymbolicLink())
      throw Error("not a real directory");
  }catch (_) {return fail(entity,"ALIFE06_JOURNAL_UNAVAILABLE");}
  const key = "alife06-"+systemID+"-"+rockID+"-"+shipID;
  const file = path.join(root,key+".json");
  const rockKey = systemID+":"+rockID, shipKey = systemID+":"+shipID;
  // In-flight source or hull is a transient conflict, NOT a damaged
  // transaction. Do not persist an operator-repair latch on the other NPC.
  if (inflight.has(key)||inflightRocks.has(rockKey)||inflightShips.has(shipKey))
    return {success:false,stopReason:"cargo",reason:"ALIFE06_CYCLE_REENTRANT"};
  inflight.add(key);inflightRocks.add(rockKey);inflightShips.add(shipKey);
  let prior, record;
  try {
    // A failed miner/rock pair must quarantine either participant, including
    // after restart when the miner switches target or another miner arrives.
    for (const entry of fs.readdirSync(root)) {
      const match=/^alife06-(\d+)-(\d+)-(\d+)\.json$/.exec(entry);
      if (!match || Number(match[1])!==systemID ||
          (Number(match[2])!==rockID && Number(match[3])!==shipID)) continue;
      const witness=JSON.parse(fs.readFileSync(path.join(root,entry),"utf8"));
      if (witness.status!=="COMMITTED")
        return fail(entity,"ALIFE06_UNRESOLVED_SOURCE_OR_SHIP");
    }
    try { prior=JSON.parse(fs.readFileSync(file,"utf8")); }
    catch (error) { if (error.code!=="ENOENT") throw error; }
    if (prior && (prior.status!=="COMMITTED" ||
        prior.systemID!==systemID || prior.rockID!==rockID ||
        prior.shipID!==shipID || before>prior.afterRock))
      return fail(entity,"ALIFE06_JOURNAL_CONFLICT");
    record={version:1,status:"PREPARED",systemID,shipID,rockID,oreTypeID,
      beforeRock:before,afterRock:before-consumed,normal,wasted,qty,
      cycleBoundaryMs:Number(cycleBoundaryMs)};
    atomicSave(file,record);
    let deltaResult;
    try {deltaResult=debit();}
    catch (_) {atomicSave(file,{...record,status:"UNCERTAIN",reason:"DEBIT_THROW"});return fail(entity,"ALIFE06_DEBIT_UNKNOWN");}
    if (!deltaResult || deltaResult.success!==true) {
      atomicSave(file,{...record,status:"UNCERTAIN",reason:"DEBIT_REJECTED"});
      return fail(entity,"ALIFE06_DEBIT_REJECTED");
    }
    const observed=readState();
    if (!observed || Number(observed.remainingQuantity)!==record.afterRock ||
        Number(observed.yieldTypeID)!==oreTypeID) {
      atomicSave(file,{...record,status:"UNCERTAIN",reason:"DEBIT_READBACK"});
      return fail(entity,"ALIFE06_DEBIT_READBACK");
    }
    atomicSave(file,{...record,status:"DEBITED"});
    if (qty>0) {
      let credited;
      try {credited=credit();}
      catch (_) {atomicSave(file,{...record,status:"UNCERTAIN",reason:"CARGO_THROW"});return fail(entity,"ALIFE06_CARGO_UNKNOWN");}
      if (credited!==true) {
        atomicSave(file,{...record,status:"UNCERTAIN",reason:"CARGO_REJECTED"});
        return fail(entity,"ALIFE06_CARGO_REJECTED");
      }
    }
    atomicSave(file,{...record,status:"COMMITTED"});
    return {success:true,deltaResult,receipt:{systemID,shipID,rockID,oreTypeID,qty,
      consumed,cycleBoundaryMs:Number(cycleBoundaryMs)}};
  } catch (_) {
    return fail(entity,"ALIFE06_JOURNAL_IO_UNKNOWN");
  } finally {
    inflight.delete(key);inflightRocks.delete(rockKey);inflightShips.delete(shipKey);
  }
}
module.exports={settle};
