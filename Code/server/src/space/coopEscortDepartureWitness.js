"use strict";
// P0 pre-warp participation witness. Only existing authenticated native ships,
// the original accepted corporate quote, and a true active native player fleet
// can prove attendance. The witness never moves ISK or changes native cargo.
const fs=require("node:fs"),path=require("node:path");
const pos=n=>Number.isSafeInteger(n)&&n>0;
const keyOK=x=>typeof x==="string"&&/^\d+-\d+-\d+$/.test(x);
const same=(x,y)=>Array.isArray(x)&&Array.isArray(y)&&x.length===y.length&&
 x.every((v,i)=>v===y[i]);
const deny=status=>({status});
function createDepartureWitness({root,io=fs,clock=()=>Date.now()}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||typeof clock!=="function")
  throw Error("ESCORT_DEPARTURE_WITNESS_ROOT_REQUIRED");
 const dir=path.join(root,"escort-departure-witness");
 const filename=key=>path.join(dir,key+".json");
 function identity(b){
  return b&&keyOK(b.manifestKey)&&typeof b.contractID==="string"&&
   /^escort-\d+-\d+-\d+$/.test(b.contractID)&&
   [b.systemID,b.fleetID,b.stationID,b.corporationID,b.haulerID,
    b.playerFleetID,b.amountISK].every(pos)&&b.amountISK%2===0&&
   Array.isArray(b.characters)&&b.characters.length===2&&
   b.characters.every(pos)&&b.characters[0]<b.characters[1];
 }
 function read(manifestKey,booking){
  if(!keyOK(manifestKey)||!identity(booking)||
   booking.manifestKey!==manifestKey)return deny("DEPARTURE_IDENTITY_INVALID");
  let raw;
  const target=filename(manifestKey);
  try{
   // Never follow attacker/operator-created symlinks or device files into
   // unrelated native journals when recovering original on-grid evidence.
   const stat=io.lstatSync(target);
   if(!stat?.isFile()||stat.isSymbolicLink()||stat.nlink!==1)
    return deny("DEPARTURE_NONREGULAR_OR_LINKED_JOURNAL");
   raw=io.readFileSync(target,"utf8");
  }catch(e){return deny(e?.code==="ENOENT"?"DEPARTURE_NOT_RECORDED":
   "DEPARTURE_READ_UNAVAILABLE")}
  if(typeof raw!=="string"||Buffer.byteLength(raw)>2048||!raw.endsWith("\n"))
   return deny("DEPARTURE_RECORD_CORRUPT");
  let r;try{r=JSON.parse(raw.trim())}
  catch{return deny("DEPARTURE_RECORD_CORRUPT")}
  if(r?.v!==1||r.phase!=="SOURCE_ON_GRID"||
   r.manifestKey!==manifestKey||
   r.contractID!==booking.contractID||
   r.systemID!==booking.systemID||r.fleetID!==booking.fleetID||
   r.stationID!==booking.stationID||
   r.corporationID!==booking.corporationID||
   r.haulerID!==booking.haulerID||
   r.playerFleetID!==booking.playerFleetID||
   r.amountISK!==booking.amountISK||
   !same(r.characters,booking.characters)||
   !Array.isArray(r.shipIDs)||r.shipIDs.length!==2||
   r.shipIDs.some(x=>!pos(x))||r.shipIDs[0]===r.shipIDs[1]||
   !pos(r.at)||!Number.isSafeInteger(r.at)||
   !r.origin||!["x","y","z"].every(k=>Number.isFinite(r.origin[k])))

   return deny("DEPARTURE_RECORD_CORRUPT_OR_SOURCE_CHANGED");
  return {status:"VERIFIED_NATIVE_ESCORT_DEPARTURE",
   manifestKey,contractID:r.contractID,at:r.at,
   characters:r.characters.slice(),shipIDs:r.shipIDs.slice(),
   origin:{x:r.origin.x,y:r.origin.y,z:r.origin.z}};
 }
 function readDurable(manifestKey,booking){
  // A read after a crash is not proof that file+directory fsync succeeded.
  // Re-sync the *original* immutable receipt; never replace it or infer
  // a new departure from the current NPC/pilot positions.
  const prior=read(manifestKey,booking);
  if(prior.status!=="VERIFIED_NATIVE_ESCORT_DEPARTURE")return prior;
  let fd,dirfd;
  try{
   fd=io.openSync(filename(manifestKey),"r");io.fsyncSync(fd);
   io.closeSync(fd);fd=undefined;
   dirfd=io.openSync(dir,"r");io.fsyncSync(dirfd);
  }catch{return deny("DEPARTURE_REPLAY_FSYNC_UNCERTAIN_NEEDS_REPAIR")}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}
   if(dirfd!==undefined)try{io.closeSync(dirfd)}catch{}}
  // Check again after resync in case the immutable receipt was modified
  // concurrently by a local repair operation.
  return read(manifestKey,booking);
 }
 function record(booking,scene,verifyNativeDuo){
  if(process.env.EVEJS_COOP_ESCORT_DEPARTURE_WITNESS!=="1")
   return deny("DISABLED");
  if(!identity(booking)||typeof verifyNativeDuo!=="function")
   return deny("DEPARTURE_IDENTITY_INVALID");
  // In all cases, a previously committed witness is immutable. We do not
  // create new evidence on retry after the hauler or its pilots have moved.
  const prior=read(booking.manifestKey,booking);
  if(prior.status==="VERIFIED_NATIVE_ESCORT_DEPARTURE"){
   const durable=readDurable(booking.manifestKey,booking);
   return durable.status==="VERIFIED_NATIVE_ESCORT_DEPARTURE"?
    {status:"DURABLE_ESCORT_DEPARTURE_REPLAY",manifestKey:booking.manifestKey}:
    durable;
  }
  if(prior.status!=="DEPARTURE_NOT_RECORDED")return prior;
  if(scene?.systemID!==booking.systemID||
   typeof scene.getEntityByID!=="function"||
   typeof scene.sessions?.values!=="function")
   return deny("DEPARTURE_SCENE_UNAVAILABLE");
  let duo;try{duo=verifyNativeDuo({
   systemID:booking.systemID,stationID:booking.stationID,
   corporationID:booking.corporationID,manifestKey:booking.manifestKey,
   fleetID:booking.playerFleetID,contractID:booking.contractID,
   haulerID:booking.haulerID,characters:booking.characters.slice()})}
  catch{return deny("DEPARTURE_NATIVE_FLEET_UNAVAILABLE")}
  if(duo?.status!=="VERIFIED_NATIVE_DUO_FLEET"||
   duo.fleetID!==booking.playerFleetID||
   !same(duo.characters,booking.characters))
   return deny("DEPARTURE_NATIVE_FLEET_NOT_VERIFIED");
  const position=x=>x&&["x","y","z"].every(k=>Number.isFinite(x[k]));
  const hauler=scene.getEntityByID(booking.haulerID);
  if(hauler?.kind!=="ship"||hauler.nativeNpc!==true||
   hauler.itemID!==booking.haulerID||
   hauler.transient===true||!position(hauler.position))
   return deny("DEPARTURE_HAULER_NOT_PRESENT");
  const shipIDs=[],online=[...scene.sessions.values()];
  for(const characterID of booking.characters){
   const matching=online.filter(s=>s?.characterID===characterID&&
    s?.socket?.destroyed!==true&&s?._space?.initialStateSent===true&&
    s._space.systemID===booking.systemID&&pos(s._space.shipID));
   if(matching.length!==1)return deny("DEPARTURE_ACTIVE_PILOT_NOT_UNIQUE");
   const id=matching[0]._space.shipID,p=scene.getEntityByID(id);
   if(p?.kind!=="ship"||p.nativeNpc===true||p.itemID!==id||
    p.transient===true||!position(p.position))
    return deny("DEPARTURE_PLAYER_SHIP_NOT_NATIVE");
   if(Math.hypot(p.position.x-hauler.position.x,
    p.position.y-hauler.position.y,
    p.position.z-hauler.position.z)>150000)
    return deny("DEPARTURE_PLAYER_NOT_ON_CONVOY_GRID");
   shipIDs.push(id);
  }
  if(shipIDs[0]===shipIDs[1])return deny("DEPARTURE_DUPLICATE_PLAYER_SHIP");
  const at=clock();
  if(!pos(at))return deny("DEPARTURE_CLOCK_UNAVAILABLE");
  const row={v:1,phase:"SOURCE_ON_GRID",
   manifestKey:booking.manifestKey,contractID:booking.contractID,
   systemID:booking.systemID,fleetID:booking.fleetID,
   stationID:booking.stationID,corporationID:booking.corporationID,
   haulerID:booking.haulerID,playerFleetID:booking.playerFleetID,
   amountISK:booking.amountISK,characters:booking.characters.slice(),shipIDs,
   origin:{x:hauler.position.x,y:hauler.position.y,z:hauler.position.z},at};
  let fd,dirfd;
  try{
   io.mkdirSync(dir,{recursive:true});
   const data=Buffer.from(JSON.stringify(row)+"\n");
   fd=io.openSync(filename(booking.manifestKey),"wx",0o600);
   if(io.writeSync(fd,data,0,data.length,null)!==data.length)
    return deny("DEPARTURE_WRITE_UNCERTAIN");
   io.fsyncSync(fd);io.closeSync(fd);fd=undefined;
   dirfd=io.openSync(dir,"r");io.fsyncSync(dirfd);
  }catch{return deny("DEPARTURE_WRITE_UNCERTAIN_NEEDS_REPAIR")}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{};
   if(dirfd!==undefined)try{io.closeSync(dirfd)}catch{}}
  const final=read(booking.manifestKey,booking);
  return final.status==="VERIFIED_NATIVE_ESCORT_DEPARTURE"?
   {status:"DURABLE_NATIVE_ESCORT_DEPARTURE_WITNESS",
    manifestKey:booking.manifestKey}:deny("DEPARTURE_RECHECK_UNCERTAIN");
 }
 return Object.freeze({record,read,readDurable});
}
module.exports={createDepartureWitness};
