"use strict";
// COOP-059: durable, original terminal two-pilot attendance. Written ONLY on
// trusted native station tick after actual full-manifest warehouse verification.
// Never a wallet, warp, client RPC or ad-hoc "claim attendance" mechanism.
const fs=require("node:fs"),path=require("node:path");
const pos=x=>Number.isSafeInteger(x)&&x>0;
const vec=p=>p&&["x","y","z"].every(k=>Number.isFinite(p[k]));
const same=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const deny=status=>({status});
function createEscortTerminalAttendance({root,io=fs,clock=()=>Date.now()}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||!io?.openSync||
  !io?.lstatSync||typeof clock!=="function")
  throw Error("ESCORT_TERMINAL_ATTENDANCE_ROOT_REQUIRED");
 const dir=path.join(root,"escort-terminal-attendance");
 const keyOK=k=>typeof k==="string"&&/^\d+-\d+-\d+$/.test(k);
 const filename=k=>path.join(dir,k+".json");
 function valid(b,d,r,stock){
  return keyOK(b?.manifestKey)&&/^escort-[A-Za-z0-9-]{1,48}$/.test(b.contractID||"")&&
   [b.systemID,b.fleetID,b.haulerID,b.stationID,b.corporationID,b.playerFleetID,b.amountISK].every(pos)&&
   b.amountISK%2===0&&Array.isArray(b.characters)&&b.characters.length===2&&
   b.characters.every(pos)&&b.characters[0]<b.characters[1]&&
   d?.status==="VERIFIED_NATIVE_ESCORT_DEPARTURE"&&
   d.manifestKey===b.manifestKey&&d.contractID===b.contractID&&
   same(d.characters,b.characters)&&same(d.shipIDs,d.shipIDs?.filter(pos))&&
   d.shipIDs.length===2&&d.shipIDs[0]!==d.shipIDs[1]&&
   pos(d.at)&&vec(d.origin)&&
   r?.status==="VERIFIED_NATIVE_ESCORT_ROUTE_SERVICE"&&
   r.manifestKey===b.manifestKey&&r.contractID===b.contractID&&
   same(r.characters,b.characters)&&pos(r.firstAt)&&pos(r.secondAt)&&r.secondAt>r.firstAt&&
   stock?.status==="FULL_NATIVE_CARGO_DELIVERY_VERIFIED"&&
   stock.key===b.manifestKey&&stock.stationID===b.stationID&&
   same(stock.haulerIDs,[b.haulerID])&&Array.isArray(stock.cargoIDs)&&
   stock.cargoIDs.length>0&&stock.cargoIDs.every(pos)&&
   new Set(stock.cargoIDs).size===stock.cargoIDs.length;
 }
 function inspect(b,d,r,stock){
  if(!valid(b,d,r,stock))return deny("TERMINAL_ORIGINAL_PROOF_INVALID");
  let raw;try{
   const st=io.lstatSync(filename(b.manifestKey));
   if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)
    return deny("TERMINAL_ATTENDANCE_NONREGULAR_OR_LINKED");
   raw=io.readFileSync(filename(b.manifestKey),"utf8");
  }catch(e){return deny(e?.code==="ENOENT"?
   "TERMINAL_ATTENDANCE_NOT_FOUND":"TERMINAL_ATTENDANCE_READ_UNAVAILABLE")}
  if(typeof raw!=="string"||Buffer.byteLength(raw)>3072||!raw.endsWith("\n"))
   return deny("TERMINAL_ATTENDANCE_CORRUPT");
  let x;try{x=JSON.parse(raw.trim())}
  catch{return deny("TERMINAL_ATTENDANCE_CORRUPT")}
  if(x?.v!==1||x.phase!=="ORIGINAL_STATION_DUO_ON_GRID"||
   x.manifestKey!==b.manifestKey||x.contractID!==b.contractID||
   x.systemID!==b.systemID||x.fleetID!==b.fleetID||
   x.haulerID!==b.haulerID||x.stationID!==b.stationID||
   x.corporationID!==b.corporationID||x.playerFleetID!==b.playerFleetID||
   x.amountISK!==b.amountISK||!same(x.characters,b.characters)||
   !same(x.shipIDs,d.shipIDs)||!same(x.cargoIDs,stock.cargoIDs)||
   x.sourceAt!==d.at||x.firstRouteAt!==r.firstAt||
   x.secondRouteAt!==r.secondAt||!pos(x.at)||x.at<r.secondAt||
   !Array.isArray(x.pilotPositions)||x.pilotPositions.length!==2||
   !x.pilotPositions.every(vec)||!vec(x.haulerPosition)||
   !vec(x.stationPosition)||!x.pilotPositions.every(p=>
    Math.hypot(p.x-x.haulerPosition.x,p.y-x.haulerPosition.y,
     p.z-x.haulerPosition.z)<=150000&&
    Math.hypot(p.x-x.stationPosition.x,p.y-x.stationPosition.y,
     p.z-x.stationPosition.z)<=150000))
   return deny("TERMINAL_ATTENDANCE_SOURCE_MISMATCH");
  return {status:"VERIFIED_NATIVE_ESCORT_TERMINAL_ATTENDANCE",
   manifestKey:b.manifestKey,characters:b.characters.slice(),
   playerFleetID:b.playerFleetID,at:x.at,shipIDs:x.shipIDs.slice()};
 }
 function readDurable(b,d,r,stock){
  const original=inspect(b,d,r,stock);
  if(original.status!=="VERIFIED_NATIVE_ESCORT_TERMINAL_ATTENDANCE")return original;
  let fd,dd;
  try{
   fd=io.openSync(filename(b.manifestKey),"r");io.fsyncSync(fd);
   io.closeSync(fd);fd=undefined;
   dd=io.openSync(dir,"r");io.fsyncSync(dd);
  }catch{return deny("TERMINAL_ATTENDANCE_FSYNC_UNCERTAIN")}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}
   if(dd!==undefined)try{io.closeSync(dd)}catch{}}
  return inspect(b,d,r,stock);
 }
 function record({booking:b,departure:d,route:r,stock,scene,verifyNativeDuo}={}){
  if(process.env.EVEJS_COOP_ESCORT_PEACEFUL_REPLAY!=="1"||
   process.env.EVEJS_COOP_ESCORT_ROUTE_WITNESS!=="1")
   return deny("DISABLED");
  if(!valid(b,d,r,stock)||typeof verifyNativeDuo!=="function")
   return deny("TERMINAL_ORIGINAL_PROOF_INVALID");
  // Replay does NOT regenerate attendance: an existing immutable receipt
  // must match and be re-synced before being considered payment authority.
  const existing=inspect(b,d,r,stock);
  if(existing.status==="VERIFIED_NATIVE_ESCORT_TERMINAL_ATTENDANCE")
   return readDurable(b,d,r,stock);
  if(existing.status!=="TERMINAL_ATTENDANCE_NOT_FOUND")return existing;
  const station=(scene?.staticEntities||[]).find(x=>
   x?.itemID===b.stationID&&x.kind==="station"&&vec(x.position));
  const hauler=scene?.getEntityByID?.(b.haulerID);
  if(scene?.systemID!==b.systemID||!station||
   hauler?.kind!=="ship"||hauler.nativeNpc!==true||
   hauler.itemID!==b.haulerID||!vec(hauler.position)||
   Math.hypot(hauler.position.x-station.position.x,
    hauler.position.y-station.position.y,
    hauler.position.z-station.position.z)>150000)
   return deny("TERMINAL_NATIVE_STATION_OR_HAULER_UNVERIFIED");
  let duo;try{duo=verifyNativeDuo({
   systemID:b.systemID,stationID:b.stationID,
   corporationID:b.corporationID,fleetID:b.playerFleetID,
   manifestKey:b.manifestKey,contractID:b.contractID,
   haulerID:b.haulerID,characters:b.characters.slice()
  })}catch{return deny("TERMINAL_NATIVE_DUO_UNAVAILABLE")}
  if(duo?.status!=="VERIFIED_NATIVE_DUO_FLEET"||
   duo.fleetID!==b.playerFleetID||!same(duo.characters,b.characters))
   return deny("TERMINAL_NATIVE_DUO_UNVERIFIED");
  if(typeof scene?.sessions?.values!=="function")
   return deny("TERMINAL_NATIVE_SESSIONS_UNAVAILABLE");
  const sessions=[...scene.sessions.values()],pilotPositions=[];
  for(let i=0;i<2;i++){
   const active=sessions.filter(x=>x?.characterID===b.characters[i]&&
    x?.socket?.destroyed!==true&&x?._space?.initialStateSent===true&&
    x._space.systemID===b.systemID&&x._space.shipID===d.shipIDs[i]);
   if(active.length!==1)return deny("TERMINAL_NATIVE_PILOT_SESSION_NOT_UNIQUE");
   const ship=scene.getEntityByID(d.shipIDs[i]);
   if(ship?.kind!=="ship"||ship.itemID!==d.shipIDs[i]||
    ship.nativeNpc===true||ship.transient===true||!vec(ship.position)||
    Math.hypot(ship.position.x-hauler.position.x,
     ship.position.y-hauler.position.y,
     ship.position.z-hauler.position.z)>150000||
    Math.hypot(ship.position.x-station.position.x,
     ship.position.y-station.position.y,
     ship.position.z-station.position.z)>150000)
    return deny("TERMINAL_NATIVE_PILOT_NOT_AT_DESTINATION");
   pilotPositions.push({x:ship.position.x,y:ship.position.y,z:ship.position.z});
  }
  const at=clock();
  if(!pos(at)||at<r.secondAt||at<d.at)
   return deny("TERMINAL_TIME_INVALID");
  const row={v:1,phase:"ORIGINAL_STATION_DUO_ON_GRID",
   manifestKey:b.manifestKey,contractID:b.contractID,
   systemID:b.systemID,fleetID:b.fleetID,
   haulerID:b.haulerID,stationID:b.stationID,
   corporationID:b.corporationID,playerFleetID:b.playerFleetID,
   amountISK:b.amountISK,characters:b.characters.slice(),
   shipIDs:d.shipIDs.slice(),cargoIDs:stock.cargoIDs.slice(),
   sourceAt:d.at,firstRouteAt:r.firstAt,secondRouteAt:r.secondAt,at,
   stationPosition:{...station.position},haulerPosition:{...hauler.position},
   pilotPositions};
  let fd,dd;
  try{
   io.mkdirSync(dir,{recursive:true});
   const bytes=Buffer.from(JSON.stringify(row)+"\n");
   if(bytes.length>3072)return deny("TERMINAL_ATTENDANCE_TOO_LARGE");
   fd=io.openSync(filename(b.manifestKey),"wx",0o600);
   if(io.writeSync(fd,bytes,0,bytes.length,null)!==bytes.length)
    return deny("TERMINAL_ATTENDANCE_WRITE_UNCERTAIN");
   io.fsyncSync(fd);io.closeSync(fd);fd=undefined;
   dd=io.openSync(dir,"r");io.fsyncSync(dd);
  }catch{return deny("TERMINAL_ATTENDANCE_WRITE_UNCERTAIN")}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}
   if(dd!==undefined)try{io.closeSync(dd)}catch{}}
  return readDurable(b,d,r,stock);
 }
 return Object.freeze({record,inspect,readDurable});
}
module.exports={createEscortTerminalAttendance};
