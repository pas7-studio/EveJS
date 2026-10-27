"use strict";
// Stage I: immutable native mid-route evidence. Observer only; never drives
// ship warp or wallet. Source, immutable original dual signatures and actual
// in-scene positions are independently server-verified for each checkpoint.
const fs=require("node:fs"),path=require("node:path");
const pos=x=>Number.isSafeInteger(x)&&x>0;
const keyOK=x=>typeof x==="string"&&/^\d+-\d+-\d+$/.test(x);
const same=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&
 a.every((x,i)=>x===b[i]);
const vector=x=>x&&["x","y","z"].every(k=>Number.isFinite(x[k]));
const equal=(a,b)=>vector(a)&&vector(b)&&["x","y","z"].every(k=>a[k]===b[k]);
const denied=status=>({status});
const WINDOWS=Object.freeze([[0.20,0.45],[0.55,0.85]]);
const MAX_AGE=15*60*1000;
function createRouteWitness({root,io=fs,clock=()=>Date.now()}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||typeof clock!=="function")
  throw Error("ESCORT_ROUTE_WITNESS_ROOT_REQUIRED");
 const dir=path.join(root,"escort-route-witness");
 const file=(key,stage)=>path.join(dir,key+".stage-"+stage+".json");
 function identity(b,p){
  return keyOK(b?.manifestKey)&&typeof b.contractID==="string"&&
   /^escort-\d+-\d+-\d+$/.test(b.contractID)&&
   [b.systemID,b.fleetID,b.haulerID,b.stationID,b.corporationID,
    b.playerFleetID,b.amountISK].every(pos)&&
   b.amountISK<=1000000000&&b.amountISK%2===0&&
   Array.isArray(b.characters)&&b.characters.length===2&&
   b.characters.every(pos)&&b.characters[0]<b.characters[1]&&
   p?.status==="VERIFIED_NATIVE_ESCORT_DEPARTURE"&&
   p.manifestKey===b.manifestKey&&p.contractID===b.contractID&&
   same(p.characters,b.characters)&&
   Array.isArray(p.shipIDs)&&p.shipIDs.length===2&&
   p.shipIDs.every(pos)&&p.shipIDs[0]!==p.shipIDs[1]&&
   pos(p.at)&&vector(p.origin);
 }
 function readOne(b,p,stage){
  const target=file(b.manifestKey,stage);
  let text;
  try{
   const stat=io.lstatSync(target);
   if(!stat?.isFile()||stat.isSymbolicLink()||stat.nlink!==1)
    return denied("ROUTE_NONREGULAR_OR_LINKED_JOURNAL");
   text=io.readFileSync(target,"utf8");
  }catch(e){return denied(e?.code==="ENOENT"?"ROUTE_CHECKPOINT_NOT_FOUND":
   "ROUTE_CHECKPOINT_READ_UNAVAILABLE")}
  if(typeof text!=="string"||Buffer.byteLength(text)>2048||!text.endsWith("\n"))
   return denied("ROUTE_CHECKPOINT_CORRUPT");
  let x;try{x=JSON.parse(text.trim())}catch{return denied("ROUTE_CHECKPOINT_CORRUPT")}
  if(x?.v!==1||x.phase!=="MID_ROUTE"||x.stage!==stage||
   x.manifestKey!==b.manifestKey||x.contractID!==b.contractID||
   x.systemID!==b.systemID||x.fleetID!==b.fleetID||
   x.haulerID!==b.haulerID||x.stationID!==b.stationID||
   x.corporationID!==b.corporationID||
   x.playerFleetID!==b.playerFleetID||x.amountISK!==b.amountISK||
   !same(x.characters,b.characters)||!same(x.shipIDs,p.shipIDs)||
   !equal(x.origin,p.origin)||!vector(x.destination)||
   !vector(x.hauler)||!Array.isArray(x.pilotPositions)||
   x.pilotPositions.length!==2||!x.pilotPositions.every(vector)||
   x.pilotPositions.some(pt=>Math.hypot(
    pt.x-x.hauler.x,pt.y-x.hauler.y,pt.z-x.hauler.z)>10000)||
   !pos(x.at)||x.at<=p.at||x.at-p.at>MAX_AGE||
   typeof x.progress!=="number"||!Number.isFinite(x.progress)||
   x.progress<WINDOWS[stage-1][0]||x.progress>WINDOWS[stage-1][1])
   return denied("ROUTE_CHECKPOINT_SOURCE_MISMATCH");
  const tripDistance=Math.hypot(
   x.destination.x-p.origin.x,x.destination.y-p.origin.y,
   x.destination.z-p.origin.z);
  if(tripDistance<10000||!Number.isFinite(tripDistance))
   return denied("ROUTE_CHECKPOINT_SOURCE_MISMATCH");
  const dx=x.destination.x-p.origin.x,dy=x.destination.y-p.origin.y,
   dz=x.destination.z-p.origin.z;
  const projected=((x.hauler.x-p.origin.x)*dx+
   (x.hauler.y-p.origin.y)*dy+(x.hauler.z-p.origin.z)*dz)/
   (tripDistance*tripDistance);
  const deviation=Math.hypot(
   x.hauler.x-(p.origin.x+projected*dx),
   x.hauler.y-(p.origin.y+projected*dy),
   x.hauler.z-(p.origin.z+projected*dz));
  if(!Number.isFinite(projected)||Math.abs(projected-x.progress)>0.000001||
   !Number.isFinite(deviation)||deviation>150000)
   return denied("ROUTE_CHECKPOINT_SOURCE_MISMATCH");
  // At short native routes, 10 km NPC proximity alone can be satisfied by a
  // pilot parked at the origin. Require both *recorded* player positions to
  // have progressed independently along the true source-to-target vector.
  for(const pilot of x.pilotPositions){
   const projectedPilot=((pilot.x-p.origin.x)*dx+
    (pilot.y-p.origin.y)*dy+(pilot.z-p.origin.z)*dz)/
    (tripDistance*tripDistance);
   if(!Number.isFinite(projectedPilot)||
    Math.abs(projectedPilot-x.progress)>0.12||
    projectedPilot<Math.max(0.10,WINDOWS[stage-1][0]-0.10))
    return denied("ROUTE_PILOT_PROGRESS_MISMATCH");
  }
  return {status:"VERIFIED_NATIVE_ROUTE_CHECKPOINT",row:x};
 }
 function fsyncStored(manifestKey,stage){
  let fd,dirfd;try{
   fd=io.openSync(file(manifestKey,stage),"r");io.fsyncSync(fd);
   io.closeSync(fd);fd=undefined;
   dirfd=io.openSync(dir,"r");io.fsyncSync(dirfd);
   return true;
  }catch{return false}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}
   if(dirfd!==undefined)try{io.closeSync(dirfd)}catch{}}
 }
 function verify(b,p){
  if(!identity(b,p))return denied("ROUTE_IDENTITY_INVALID");
  const first=readOne(b,p,1);if(first.status!=="VERIFIED_NATIVE_ROUTE_CHECKPOINT")
   return first;
  const second=readOne(b,p,2);if(second.status!=="VERIFIED_NATIVE_ROUTE_CHECKPOINT")
   return second;
  // A written file with lost fsync ACK must never be trusted as durable payout
  // authority until BOTH immutable checkpoint file and parent are re-synced.
  if(!fsyncStored(b.manifestKey,1)||!fsyncStored(b.manifestKey,2))
   return denied("ROUTE_CHECKPOINT_FSYNC_UNCERTAIN");
  if(!equal(first.row.destination,second.row.destination)||
   second.row.at-first.row.at<500||
   second.row.at-first.row.at>MAX_AGE||
   second.row.progress<=first.row.progress)
   return denied("ROUTE_TRANSIT_COVERAGE_INVALID");
  return {status:"VERIFIED_NATIVE_ESCORT_ROUTE_SERVICE",
   manifestKey:b.manifestKey,contractID:b.contractID,
   characters:b.characters.slice(),firstAt:first.row.at,
   secondAt:second.row.at};
 }
 function sample({booking:b,departure:p,scene,station,verifyNativeDuo}={}){
  if(process.env.EVEJS_COOP_ESCORT_ROUTE_WITNESS!=="1")
   return denied("DISABLED");
  if(!identity(b,p)||typeof verifyNativeDuo!=="function")
   return denied("ROUTE_IDENTITY_INVALID");
  if(scene?.systemID!==b.systemID||typeof scene.getEntityByID!=="function"||
   typeof scene.sessions?.values!=="function"||
   station?.stationID!==b.stationID||
   station.corporationID!==b.corporationID||!vector(station.position))
   return denied("ROUTE_NATIVE_SCENE_OR_STATION_UNAVAILABLE");
  const destination=station.position;
  const dx=destination.x-p.origin.x,dy=destination.y-p.origin.y,
   dz=destination.z-p.origin.z;
  const length=Math.hypot(dx,dy,dz);
  if(!Number.isFinite(length)||length<10000)
   return denied("ROUTE_DISTANCE_NOT_ELIGIBLE");
  const npc=scene.getEntityByID(b.haulerID);
  if(npc?.itemID!==b.haulerID||npc.kind!=="ship"||
   npc.nativeNpc!==true||npc.transient===true||!vector(npc.position))
   return denied("ROUTE_NATIVE_HAULER_MISSING");
  const progress=((npc.position.x-p.origin.x)*dx+
   (npc.position.y-p.origin.y)*dy+
   (npc.position.z-p.origin.z)*dz)/(length*length);
  const deviation=Math.hypot(
   npc.position.x-(p.origin.x+progress*dx),
   npc.position.y-(p.origin.y+progress*dy),
   npc.position.z-(p.origin.z+progress*dz));
  if(!Number.isFinite(progress)||!Number.isFinite(deviation)||
   deviation>150000)return denied("ROUTE_NATIVE_PATH_INVALID");
  const stage=WINDOWS.findIndex(([lo,hi])=>progress>=lo&&progress<=hi)+1;
  if(!stage)return denied("ROUTE_NOT_AT_CHECKPOINT");
  const prev=readOne(b,p,stage);
  if(prev.status==="VERIFIED_NATIVE_ROUTE_CHECKPOINT"){
   if(!fsyncStored(b.manifestKey,stage))
    return denied("ROUTE_REPLAY_FSYNC_UNCERTAIN");
   return {status:"NATIVE_ROUTE_CHECKPOINT_ALREADY_RECORDED",stage};
  }
  if(prev.status!=="ROUTE_CHECKPOINT_NOT_FOUND")return prev;
  const earlier=stage===2?readOne(b,p,1):null;
  if(stage===2&&earlier.status!=="VERIFIED_NATIVE_ROUTE_CHECKPOINT")
   return earlier.status==="ROUTE_CHECKPOINT_NOT_FOUND"?
    denied("ROUTE_EARLIER_CHECKPOINT_REQUIRED"):earlier;
  if(stage===2&&!equal(earlier.row.destination,destination))
   return denied("ROUTE_DESTINATION_CHANGED");
  if(stage===2&&!fsyncStored(b.manifestKey,1))
   return denied("ROUTE_EARLIER_CHECKPOINT_FSYNC_UNCERTAIN");
  const now=clock();
  if(!pos(now)||now<=p.at||now-p.at>MAX_AGE||
   (stage===2&&now-earlier.row.at<500))
   return denied("ROUTE_SAMPLE_TIME_INVALID");
  let duo;try{duo=verifyNativeDuo({
   systemID:b.systemID,stationID:b.stationID,
   corporationID:b.corporationID,fleetID:b.playerFleetID,
   manifestKey:b.manifestKey,contractID:b.contractID,
   haulerID:b.haulerID,characters:b.characters.slice()})}
  catch{return denied("ROUTE_NATIVE_DUO_UNAVAILABLE")}
  if(duo?.status!=="VERIFIED_NATIVE_DUO_FLEET"||
   duo.fleetID!==b.playerFleetID||!same(duo.characters,b.characters))
   return denied("ROUTE_NATIVE_FLEET_NOT_VERIFIED");
  const online=[...scene.sessions.values()],pilotPositions=[];
  for(let i=0;i<2;i++){
   const sessions=online.filter(s=>s?.characterID===b.characters[i]&&
    s?.socket?.destroyed!==true&&s?._space?.initialStateSent===true&&
    s._space.systemID===b.systemID&&s._space.shipID===p.shipIDs[i]);
   if(sessions.length!==1)return denied("ROUTE_PILOT_SESSION_NOT_UNIQUE");
   const ship=scene.getEntityByID(p.shipIDs[i]);
   if(ship?.itemID!==p.shipIDs[i]||ship.kind!=="ship"||
    ship.nativeNpc===true||ship.transient===true||!vector(ship.position)||
    Math.hypot(ship.position.x-npc.position.x,
     ship.position.y-npc.position.y,
     ship.position.z-npc.position.z)>10000)
    return denied("ROUTE_PILOT_NOT_ESCORTING_NPC");
   const pilotProgress=((ship.position.x-p.origin.x)*dx+
    (ship.position.y-p.origin.y)*dy+
    (ship.position.z-p.origin.z)*dz)/(length*length);
   if(!Number.isFinite(pilotProgress)||
    Math.abs(pilotProgress-progress)>0.12||
    pilotProgress<Math.max(0.10,WINDOWS[stage-1][0]-0.10))
    return denied("ROUTE_PILOT_PROGRESS_MISMATCH");
   pilotPositions.push({x:ship.position.x,y:ship.position.y,
    z:ship.position.z});
  }
  const row={v:1,phase:"MID_ROUTE",stage,manifestKey:b.manifestKey,
   contractID:b.contractID,systemID:b.systemID,fleetID:b.fleetID,
   haulerID:b.haulerID,stationID:b.stationID,
   corporationID:b.corporationID,playerFleetID:b.playerFleetID,
   amountISK:b.amountISK,characters:b.characters.slice(),
   shipIDs:p.shipIDs.slice(),
   origin:{x:p.origin.x,y:p.origin.y,z:p.origin.z},
   destination:{x:destination.x,y:destination.y,z:destination.z},
   hauler:{x:npc.position.x,y:npc.position.y,z:npc.position.z},
   pilotPositions,progress,at:now};
  let fd,dirfd;
  try{
   io.mkdirSync(dir,{recursive:true});
   const bytes=Buffer.from(JSON.stringify(row)+"\n");
   if(bytes.length>2048)return denied("ROUTE_CHECKPOINT_TOO_LARGE");
   fd=io.openSync(file(b.manifestKey,stage),"wx",0o600);
   if(io.writeSync(fd,bytes,0,bytes.length,null)!==bytes.length)
    return denied("ROUTE_CHECKPOINT_WRITE_UNCERTAIN");
   io.fsyncSync(fd);io.closeSync(fd);fd=undefined;
   dirfd=io.openSync(dir,"r");io.fsyncSync(dirfd);
  }catch{return denied("ROUTE_CHECKPOINT_WRITE_UNCERTAIN")}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}
   if(dirfd!==undefined)try{io.closeSync(dirfd)}catch{}}
  return readOne(b,p,stage).status==="VERIFIED_NATIVE_ROUTE_CHECKPOINT"?
   {status:"NATIVE_ROUTE_CHECKPOINT_DURABLY_RECORDED",stage}:
   denied("ROUTE_CHECKPOINT_RECHECK_UNCERTAIN");
 }
 return Object.freeze({sample,verify});
}
module.exports={createRouteWitness};
