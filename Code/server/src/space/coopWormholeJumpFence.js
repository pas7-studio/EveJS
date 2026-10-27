"use strict";
// Chat-23: opt-in safety fence for the ORIGINAL wormholeMgr transition.
// The only mass and polarization writer remains native wormholeRuntime.commitJump.
// The file receipt records ambiguous handoffs; it never grants mass, cargo or travel.
const fs = require("node:fs");
const path = require("node:path");
const pos = v => Number.isSafeInteger(v) && v > 0;
const int = v => Number.isSafeInteger(v) && v >= 0;
const abs = p => typeof p === "string" && path.isAbsolute(p) && p !== path.parse(p).root;
const safeJournalName = name => /^wh23-[0-9]+-[0-9]+-[0-9]+\.json$/.test(name);
const validPosition = p => p && ["x", "y", "z"].every(k => typeof p[k] === "number" && Number.isFinite(p[k]));
function createFence({root,fsApi = fs,clock = () => Date.now()} = {}) {
  if (!abs(root)) throw Error("WORMHOLE_JOURNAL_ABSOLUTE_DIR_REQUIRED");
  const ensureDir = () => {
    try {
      fsApi.mkdirSync(root, {recursive:true,mode:0o700});
      if (!fsApi.statSync(root).isDirectory() || fsApi.lstatSync(root).isSymbolicLink())
        throw Error("UNSAFE_DIR");
      const parent=path.dirname(root);
      if (fsApi.lstatSync(parent).isSymbolicLink()) throw Error("UNSAFE_PARENT");
    } catch {throw Error("WORMHOLE_JOURNAL_UNAVAILABLE");}
  };
  const syncDir=()=>{
    let fd;
    try {fd=fsApi.openSync(root,"r");fsApi.fsyncSync(fd);}
    catch {throw Error("WORMHOLE_JOURNAL_DIRSYNC_FAILED");}
    finally {if(fd!==undefined)fsApi.closeSync(fd);}
  };
  function write(record, initial=false){
    ensureDir();
    const name=`wh23-${record.characterID}-${record.pairID}-${record.queuedAtMs}.json`;
    if (!safeJournalName(name)) throw Error("WORMHOLE_JOURNAL_KEY_INVALID");
    const dest=path.join(root,name);
    const temp= initial ? dest : `${dest}.tmp-${process.pid}`;
    let fd;
    try {
      fd=fsApi.openSync(temp,"wx",0o600);
      fsApi.writeFileSync(fd,JSON.stringify(record)+"\n");
      fsApi.fsyncSync(fd);
      fsApi.closeSync(fd);fd=undefined;
      if (!initial)fsApi.renameSync(temp,dest);
      syncDir();
      return true;
    } catch(e) {
      if(fd!==undefined)try{fsApi.closeSync(fd);}catch{}
      // NEVER delete an uncertain initial receipt. An ambiguous write must
      // quarantine rather than permit an apparently fresh second jump.
      if(!initial)try{fsApi.unlinkSync(temp);}catch{}
      throw Error("WORMHOLE_JOURNAL_WRITE_UNCERTAIN:"+String(e?.code||e?.message||e));
    }
  }
  function pendingFor(characterID){
    if(!pos(characterID))return {blocked:true,reason:"WORMHOLE_INVALID_CHARACTER"};
    ensureDir();
    let entries;
    try{entries=fsApi.readdirSync(root).filter(safeJournalName);}
    catch{return {blocked:true,reason:"WORMHOLE_JOURNAL_READ_UNAVAILABLE"};}
    if(entries.length>10000)return {blocked:true,reason:"WORMHOLE_JOURNAL_LIMIT"};
    for(const name of entries){
      if(!name.startsWith(`wh23-${characterID}-`))continue;
      let data;
      try{
        const raw=fsApi.readFileSync(path.join(root,name),"utf8");
        if(Buffer.byteLength(raw)>8192)throw Error("OVERSIZE");
        data=JSON.parse(raw);
      }catch{return {blocked:true,reason:"WORMHOLE_JOURNAL_CORRUPT"};}
      if(data?.version!==1 || data.characterID!==characterID ||
         `wh23-${data.characterID}-${data.pairID}-${data.queuedAtMs}.json`!==name ||
         !["PREPARED","MASS_COMMITTED","ARRIVED"].includes(data.phase))
        return {blocked:true,reason:"WORMHOLE_JOURNAL_CORRUPT"};
      if(data.phase!=="ARRIVED")return {blocked:true,reason:"WORMHOLE_PENDING_OPERATOR_REPAIR"};
    }
    return {blocked:false};
  }
  function complete({session,sourceScene,sourceEndpointID,shipMass,prepareResult,
    wormholeRuntime,wormholeRuntimeState,gameStore,spaceRuntime,
    getActiveShipRecord,buildShipResourceState,jumpSessionToSolarSystem,
    syncSessionSystemWideEffectsForSystem,notifyWormholeJumpCancel}={}){
    const deny = (reason,quarantine=false) => {
      if(quarantine && session)session._wormholeJumpNeedsOperatorRepair=reason;
      if(session)session._wormholeJumpPending=null;
      try{notifyWormholeJumpCancel?.(session);}catch{}
      return {status:quarantine?"NEEDS_OPERATOR_REPAIR":"BLOCKED",reason};
    };
    const charID=Number(session?.characterID), pending=session?._wormholeJumpPending;
    const shipID=Number(session?._space?.shipID);
    const now=clock();
    if(!pos(charID)||!pos(shipID)||!pos(sourceEndpointID)||!pos(shipMass)||
       !pos(now)||pending?.endpointID!==sourceEndpointID||!pos(pending.queuedAtMs) ||
       prepareResult?.success!==true||!pos(prepareResult?.data?.pairID)||
       !sourceScene || !wormholeRuntime || !wormholeRuntimeState || !gameStore ||
       !spaceRuntime || typeof jumpSessionToSolarSystem!=="function")
      return deny("WORMHOLE_JUMP_CONTEXT_INVALID");
    if(session._wormholeJumpNeedsOperatorRepair)return deny("WORMHOLE_SESSION_QUARANTINED",true);
    try{const prior=pendingFor(charID);if(prior.blocked)return deny(prior.reason,true);}
    catch{return deny("WORMHOLE_JOURNAL_UNAVAILABLE",true);}
    const ship=sourceScene.getShipEntityForSession?.(session);
    const endpoint=sourceScene.getEntityByID?.(sourceEndpointID);
    const activeShip=getActiveShipRecord?.(charID);
    const freshMass=Number(buildShipResourceState?.(charID,activeShip)?.mass);
    if(spaceRuntime.getSceneForSession?.(session)!==sourceScene ||
       Number(sourceScene.systemID)!==Number(session?._space?.systemID)||
       ship?.kind!=="ship"||Number(ship.itemID)!==shipID||
       Number(activeShip?.itemID)!==shipID||!pos(freshMass)||
       Math.trunc(freshMass)!==shipMass||
       endpoint?.kind!=="wormhole"||Number(endpoint.itemID)!==sourceEndpointID||
       !validPosition(ship.position)||!validPosition(endpoint.position))
      return deny("WORMHOLE_PHYSICAL_SOURCE_CHANGED");
    const distance=Math.hypot(ship.position.x-endpoint.position.x,
      ship.position.y-endpoint.position.y,ship.position.z-endpoint.position.z) -
      Math.max(0,Number(endpoint.radius)||0);
    if(distance>5000)return deny("WORMHOLE_NOT_IN_RANGE");
    const at=clock();
    const prepared=wormholeRuntime.prepareJump(sourceEndpointID,charID,shipMass,at);
    if(prepared?.success!==true)return deny(prepared?.errorMsg||"WORMHOLE_PREPARE_REJECTED");
    const d=prepared.data, old=prepareResult.data;
    const from=d?.pair?.[d.role],to=d?.pair?.[d.role==="source"?"destination":"source"];
    if(d.pairID!==old.pairID || d.role!==old.role ||
       d.destinationSystemID!==old.destinationSystemID ||
       Number(from?.endpointID)!==sourceEndpointID ||
       Number(from?.systemID)!==Number(sourceScene.systemID)||
       Number(to?.endpointID)!==Number(d.destinationEndpointID)||
       Number(to?.systemID)!==Number(d.destinationSystemID)||
       !pos(d.destinationSystemID)||!pos(d.destinationEndpointID))
      return deny("WORMHOLE_PAIR_OR_DESTINATION_CHANGED");
    const before=wormholeRuntimeState.getStateSnapshot?.()?.pairsByID?.[String(d.pairID)];
    if(before?.state!=="active"||!int(before.remainingMass)||
       !int(before.totalMass)||before.totalMass<before.remainingMass||
       before.remainingMass===0||before.maxJumpMass>0&&shipMass>before.maxJumpMass||
       before.expiresAtMs>0&&before.expiresAtMs<=at)
      return deny("WORMHOLE_MASS_OR_LIFETIME_UNAVAILABLE");
    // One saved receipt before touching native mass. No automatic compensation.
    const receipt={version:1,phase:"PREPARED",characterID:charID,
      shipID,sourceEndpointID,pairID:d.pairID,queuedAtMs:pending.queuedAtMs,
      sourceSystemID:Number(sourceScene.systemID),destinationSystemID:d.destinationSystemID,
      destinationEndpointID:d.destinationEndpointID,shipMass,beforeMass:before.remainingMass,
      atMs:at};
    try{write(receipt,true);}catch{return deny("WORMHOLE_PREPARE_JOURNAL_UNCERTAIN",true);}
    let committed;
    try{committed=wormholeRuntime.commitJump(sourceEndpointID,charID,shipMass,at);}
    catch{return deny("WORMHOLE_NATIVE_MASS_COMMIT_THROWN",true);}
    if(committed?.success!==true)return deny("WORMHOLE_NATIVE_MASS_COMMIT_FAILED",true);
    const after=wormholeRuntimeState.getStateSnapshot?.();
    const pair=after?.pairsByID?.[String(d.pairID)];
    const polar=after?.polarizationByCharacter?.[String(charID)]?.[String(sourceEndpointID)];
    const expectedMass=Math.max(0,before.remainingMass-shipMass);
    if(!pair || pair.remainingMass!==expectedMass ||
       (expectedMass===0 && pair.state!=="collapsed") ||
       (expectedMass>0 && pair.state!=="active") ||
       polar?.endAtMs!==at+300000 || polar?.durationSeconds!==300)
      return deny("WORMHOLE_NATIVE_MASS_READBACK_CONFLICT",true);
    let flushed;
    try{flushed=gameStore.flushTableSync("wormholeRuntimeState",{log:false});}
    catch{return deny("WORMHOLE_NATIVE_MASS_FLUSH_THROWN",true);}
    if(flushed?.success!==true)return deny("WORMHOLE_NATIVE_MASS_FLUSH_UNCERTAIN",true);
    receipt.phase="MASS_COMMITTED";
    try{write(receipt);}catch{return deny("WORMHOLE_COMMIT_JOURNAL_UNCERTAIN",true);}
    // This is native WormholeMgr's generic solar transfer with a real WH anchor,
    // NOT jumpSessionViaStargate nor a fabricated local teleport.
    const spawnState=wormholeRuntime.buildJumpSpawnState(d.pair,d.role,
      {shipMass,nowMs:at,characterID:charID});
    if(spawnState?.anchorType!=="wormhole" ||
       spawnState.anchorID!==d.destinationEndpointID || !validPosition(spawnState.position))
      return deny("WORMHOLE_NATIVE_EXIT_INVALID",true);
    let jump;
    try{jump=jumpSessionToSolarSystem(session,d.destinationSystemID,{spawnStateOverride:spawnState});}
    catch{return deny("WORMHOLE_PHYSICAL_TRANSITION_THROWN",true);}
    if(jump?.success!==true)return deny("WORMHOLE_PHYSICAL_TRANSITION_UNCONFIRMED",true);
    const dst=spaceRuntime.getSceneForSession?.(session),dstShip=dst?.getShipEntityForSession?.(session);
    if(Number(session?._space?.systemID)!==d.destinationSystemID||
       Number(dst?.systemID)!==d.destinationSystemID||
       Number(dstShip?.itemID)!==shipID)
      return deny("WORMHOLE_DESTINATION_SHIP_UNVERIFIED",true);
    receipt.phase="ARRIVED";
    try{write(receipt);}catch{return deny("WORMHOLE_ARRIVAL_JOURNAL_UNCERTAIN",true);}
    session._wormholeJumpPending=null;
    try{syncSessionSystemWideEffectsForSystem?.(session,d.destinationSystemID);}catch{}
    try{wormholeRuntime.syncSceneEntities?.(sourceScene,at);wormholeRuntime.syncSceneEntities?.(dst,at);}catch{}
    return {status:"ARRIVED",pairID:d.pairID,shipID,remainingMass:expectedMass,
      destinationSystemID:d.destinationSystemID,nativeMutation:true};
  }
  return {pendingFor,complete};
}
function getFenceFromEnv(options={}){
  if(process.env.EVEJS_COOP_WORMHOLE_JUMP_FENCE!=="1")return null;
  return createFence({root:process.env.EVEJS_COOP_WORMHOLE_JOURNAL_DIR,...options});
}
function mayBegin(session){
  if(process.env.EVEJS_COOP_WORMHOLE_JUMP_FENCE!=="1")return true;
  try{return getFenceFromEnv().pendingFor(Number(session?.characterID)).blocked===false &&
    !session?._wormholeJumpNeedsOperatorRepair;}
  catch{return false;}
}
function completeWormholeJump(args){
  try{return getFenceFromEnv()?.complete(args) || {status:"DISABLED"};}
  catch(error){
    if(args?.session)args.session._wormholeJumpNeedsOperatorRepair=String(error?.message||error);
    try{args?.notifyWormholeJumpCancel?.(args.session);}catch{}
    return {status:"NEEDS_OPERATOR_REPAIR",reason:"WORMHOLE_FENCE_UNEXPECTED_FAILURE"};
  }
}
module.exports={createFence,getFenceFromEnv,mayBegin,completeWormholeJump};
