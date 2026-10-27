"use strict";
// Source-first player mining custody on the exact native mining cycle.
// The journal fences uncertain outcomes; it does NOT make two GameStore writes ACID.
const fs=require("node:fs"),path=require("node:path");
const good=x=>Number.isSafeInteger(x)&&x>0;
const quantity=x=>Number.isSafeInteger(x)&&x>=0;
const kinds=new Set(["ore","ice","gas"]);
const flags={ore:new Set([5,134,182]),ice:new Set([5,134,181]),gas:new Set([5,134,135])};
function clampCritical(source,result){
 if(!source||!result||!quantity(source.remainingQuantity)||
  !quantity(result.normalQuantity)||!quantity(result.wastedQuantity)||
  !quantity(result.criticalHitQuantity))return false;
 const residual=Math.max(0,source.remainingQuantity-result.normalQuantity-result.wastedQuantity);
 result.criticalHitQuantity=Math.min(result.criticalHitQuantity,residual);
 result.criticalHitVolume=result.criticalHitQuantity*Number(source.unitVolume);
 return true;
}
function netGrant(changes,characterID,shipID,flagID,typeID){
 if(!Array.isArray(changes))return null;
 let net=0;
 const portion=row=>{
  if(!row||Number(row.ownerID)!==characterID||Number(row.locationID)!==shipID||
   Number(row.flagID)!==flagID||Number(row.typeID)!==typeID)return 0;
  if(!good(Number(row.itemID)))return null;
  const q=Number(row.singleton)===1?1:Number(row.stacksize??row.quantity);
  return good(q)?q:null;
 };
 for(const change of changes){
  const before=portion(change?.previousData??change?.previousState);
  const after=change?.removed===true?0:portion(change?.item);
  if(before===null||after===null)return null;
  net+=after-before;
  if(!Number.isSafeInteger(net))return null;
 }
 return net;
}
function settle(input={}){
 const {scene,entity,droneEntity,sourceModuleID,targetEntity,mineableState,miningResult,transferredQuantity,
  destinationFlagID,availableVolume,cycleBoundaryMs,readState,debit,credit,onCredit}=input;
 const failed=reason=>({success:false,stopReason:"cargo",reason});
 if(process.env.EVEJS_COOP_PLAYER_MINING_CUSTODY!=="1")return failed("PLAYER_MINING_CUSTODY_DISABLED");
 const session=entity?.session,characterID=Number(session?.characterID),shipID=Number(entity?.itemID),
  rockID=Number(targetEntity?.itemID),systemID=Number(scene?.systemID),
  moduleID=Number(droneEntity?.itemID??sourceModuleID);
 const before=Number(mineableState?.remainingQuantity),typeID=Number(mineableState?.yieldTypeID),
  vol=Number(mineableState?.unitVolume),normal=Number(miningResult?.normalQuantity),
  waste=Number(miningResult?.wastedQuantity),critical=Number(miningResult?.criticalHitQuantity),
  transferred=Number(transferredQuantity),consumed=normal+waste+critical;
 if(![characterID,shipID,rockID,systemID,typeID,moduleID,cycleBoundaryMs,destinationFlagID].every(good)||
  ![before,normal,waste,critical,transferred,consumed].every(quantity)||
  !kinds.has(mineableState?.yieldKind)||!flags[mineableState.yieldKind].has(destinationFlagID)||
  !Number.isFinite(vol)||vol<=0||!Number.isFinite(availableVolume)||availableVolume<0||
  transferred!==normal+critical||consumed>before||consumed<=0||
  transferred*vol>availableVolume+1e-7||
  typeof readState!=="function"||typeof debit!=="function"||typeof credit!=="function"||
  typeof scene?.getEntityByID!=="function"||scene.getEntityByID(shipID)!==entity||
  scene.getEntityByID(rockID)!==targetEntity||entity?.kind!=="ship"||entity.nativeNpc===true||
  (entity.ownerID!=null&&Number(entity.ownerID)!==characterID)||
  (entity.characterID!=null&&Number(entity.characterID)!==characterID)||
  (entity.pilotCharacterID!=null&&Number(entity.pilotCharacterID)!==characterID)||
  Number(session?._space?.shipID)!==shipID||Number(session?._space?.systemID)!==systemID||
  session?._space?.initialStateSent!==true||session?.socket?.destroyed===true||
  (session?.activeShipID!=null&&Number(session.activeShipID)!==shipID)||
  !scene.sessions?.values||
  Array.from(scene.sessions.values()).filter(s=>s?.socket?.destroyed!==true&&
   s?._space?.initialStateSent===true&&
   (Number(s.characterID)===characterID||Number(s?._space?.shipID)===shipID)).length!==1||
  !Array.from(scene.sessions.values()).includes(session)||
  (droneEntity!=null&&(!good(Number(droneEntity.itemID))||
   scene.getEntityByID(Number(droneEntity.itemID))!==droneEntity||
   Number(droneEntity.ownerID)!==characterID||
   Number(droneEntity.controllerID)!==shipID||
   Number(droneEntity.targetID)!==rockID))||
  targetEntity.dungeonMaterializedSiteContent===true||
  targetEntity.dungeonSiteContentMissionObjectiveTarget===true||
  Number(targetEntity.dungeonSiteInstanceID||0)>0)
  return failed("PLAYER_MINING_SOURCE_OR_OWNER_UNVERIFIED");
 const current=readState();
 if(!current||Number(current.remainingQuantity)!==before||
    Number(current.yieldTypeID)!==typeID||current.yieldKind!==mineableState.yieldKind)
  return failed("PLAYER_MINING_SOURCE_CHANGED");
 const root=process.env.EVEJS_COOP_PLAYER_MINING_JOURNAL_DIR;
 if(!root||!path.isAbsolute(root))return failed("PLAYER_MINING_JOURNAL_REQUIRED");
 let dir;
 try{dir=fs.realpathSync(root);if(fs.lstatSync(root).isSymbolicLink()||
    !fs.statSync(dir).isDirectory())throw Error("Unsafe journal directory");}
 catch(_){return failed("PLAYER_MINING_JOURNAL_UNAVAILABLE");}
 const stem=`player24-${systemID}-${rockID}-${shipID}-${moduleID}-${cycleBoundaryMs}`;
 const file=path.join(dir,stem+".json"),lock=path.join(dir,"player24.writer.lock");
 const record={version:1,status:"PREPARED",systemID,rockID,shipID,moduleID,characterID,typeID,
  destinationFlagID,beforeRock:before,afterRock:before-consumed,normal,waste,critical,
  transferred,cycleBoundaryMs};
 let lockFD,complete=false;
 function syncDir(){if(process.platform!=="win32"){
  const fd=fs.openSync(dir,"r");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 }}
 function write(status){const temporary=file+".tmp-"+process.pid;
  const fd=fs.openSync(temporary,"wx",0o600);
  try{fs.writeFileSync(fd,JSON.stringify({...record,status})+"\n");fs.fsyncSync(fd);}
  finally{fs.closeSync(fd);}
  fs.renameSync(temporary,file);syncDir();
 }
 try{
  lockFD=fs.openSync(lock,"wx",0o600);
  fs.writeFileSync(lockFD,JSON.stringify({pid:process.pid,at:Date.now()}));
  fs.fsyncSync(lockFD);syncDir();
  const entries=fs.readdirSync(dir);
  if(entries.length>20000||entries.some(x=>x.startsWith("player24-")&&x.includes(".tmp-")))
   return failed("PLAYER_MINING_JOURNAL_REPAIR_REQUIRED");
  // An unresolved source or ship fence blocks all other pilots/cycles.
  for(const name of entries){
   const match=/^player24-(\d+)-(\d+)-(\d+)-(\d+)-(\d+)\.json$/.exec(name);
   if(!match||Number(match[1])!==systemID||
      (Number(match[2])!==rockID&&Number(match[3])!==shipID))continue;
   const old=JSON.parse(fs.readFileSync(path.join(dir,name),"utf8"));
   if(old.version!==1||old.status!=="COMMITTED"||
      !good(old.rockID)||!good(old.shipID)||!quantity(old.afterRock)||
      (Number(match[2])===rockID&&before>old.afterRock)||name===stem+".json")
    return failed("PLAYER_MINING_JOURNAL_REPAIR_REQUIRED");
  }
  write("PREPARED");
  let source;
  try{source=debit();}catch(_){write("UNCERTAIN");return failed("PLAYER_MINING_DEBIT_UNKNOWN");}
  const after=readState();
  if(source?.success!==true||!after||Number(after.remainingQuantity)!==record.afterRock||
     Number(after.yieldTypeID)!==typeID){
   write("UNCERTAIN");return failed("PLAYER_MINING_DEBIT_NOT_CONFIRMED");
  }
  write("DEBITED");
  let grant=null;
  if(transferred>0){
   try{grant=credit();}catch(_){write("UNCERTAIN");return failed("PLAYER_MINING_CARGO_UNKNOWN");}
   if(grant?.success!==true||!grant.data||Number(grant.data.quantity)!==transferred||
      netGrant(grant.data.changes,characterID,shipID,destinationFlagID,typeID)!==transferred){
    write("UNCERTAIN");return failed("PLAYER_MINING_CARGO_UNVERIFIED");
   }
  }
  write("COMMITTED");complete=true;
  if(transferred>0&&typeof onCredit==="function"){
   try{onCredit(grant.data.changes);}catch(_){/* committed transfer: never retry */}
  }
  return {success:true,deltaResult:source,receipt:{systemID,rockID,shipID,characterID,
   typeID,moduleID,destinationFlagID,quantity:transferred,depletedQuantity:consumed,cycleBoundaryMs}};
 }catch(_){return failed("PLAYER_MINING_JOURNAL_IO_UNKNOWN");}
 finally{
  if(lockFD!==undefined){
   try{fs.closeSync(lockFD);}catch(_){complete=false;}
   if(complete||!fs.existsSync(file)){
    // If the file is absent no native mutation occurred. On every other
    // failure keep the lock: even PREPARED may have been debited on disk.
    try{fs.unlinkSync(lock);syncDir();}catch(_){/* operator repair */}
   }
  }
 }
}
module.exports={clampCritical,netGrant,settle};
