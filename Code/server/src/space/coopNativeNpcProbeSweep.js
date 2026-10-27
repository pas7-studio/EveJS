"use strict";
// EX-03B4: opt-in bounded NPC probe geometry sweeps. Does NOT read the
// system's private site catalog. Each move is a durable modification of the
// SAME original npcCargo flight receipt, before the original live probe moves.
// One probe per tick -> four probes must physically cover a point for native
// certainty. No duplicated entities, item transfer, synthetic scan or timer.
const positive=n=>Number.isSafeInteger(n)&&n>0;
const vec=p=>p&&["x","y","z"].every(k=>typeof p[k]==="number"&&Number.isFinite(p[k]));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function spiral(n){
 if(n===0)return [0,0];
 const ring=Math.ceil((Math.sqrt(n+1)-1)/2);
 let x=ring,y=-ring,index=(2*ring-1)**2;
 const segments=[[0,1,2*ring],[ -1,0,2*ring],[0,-1,2*ring],[1,0,2*ring]];
 for(const [dx,dy,count] of segments)for(let i=0;i<count;i++){
  if(index++===n)return[x,y];x+=dx;y+=dy;
 }
 return [0,0];
}
function createNativeNpcProbeSweep({getNativeEntity,getController,
 listNativeCargoForEntity,upsertNativeCargo,flushNpcCargo,relocateNativeProbe,clock=()=>Date.now(),
 maxSteps=32,cellSpacingMeters=2e10}={}){
 if([getNativeEntity,getController,listNativeCargoForEntity,
   upsertNativeCargo,flushNpcCargo,relocateNativeProbe,clock].some(x=>typeof x!=="function")||
   !Number.isSafeInteger(maxSteps)||maxSteps<2||maxSteps>64||
   !Number.isFinite(cellSpacingMeters)||cellSpacingMeters<1e9||
   cellSpacingMeters>1e11)throw Error("NPC_PROBE_SWEEP_NATIVE_AUTHORITIES_REQUIRED");
 const quarantine=new Set();
 const denied=reason=>({status:"BLOCKED",reason,moved:0});
 function tick({scene,entityID,assignments=[],scanHasPerfectProof=false}={}){
  const now=clock();
  if(scanHasPerfectProof===true)return {status:"SCAN_FOUND",moved:0};
  if(!positive(entityID)||!positive(scene?.systemID)||
     !Array.isArray(assignments)||assignments.length>2048||
     !Number.isSafeInteger(now)||now<=0||
     typeof scene.getEntityByID!=="function")return denied("INVALID_SWEEP_SCENE");
  const links=assignments.filter(a=>a?.entityID===entityID&&
   a.systemID===scene.systemID&&typeof a.pilotID==="string"&&
   /^coop-pilot-[0-9]{3,}$/.test(a.pilotID));
  if(links.length!==1||assignments.some(a=>a?.pilotID===links[0].pilotID&&
    (a.entityID!==entityID||a.systemID!==scene.systemID)))
   return denied("SWEEP_PILOT_UNVERIFIED");
  let native,controller,cargo;
  try{native=getNativeEntity(entityID);controller=getController(entityID);
   cargo=listNativeCargoForEntity(entityID)}
  catch{return denied("SWEEP_STORE_UNAVAILABLE")}
  const ship=scene.getEntityByID(entityID);
  if(!ship||ship.itemID!==entityID||ship.kind!=="ship"||
   ship.nativeNpc!==true||ship.session?.characterID||
   !vec(ship.position)||ship.pendingWarp||ship.isWarping||ship.warpState||
   !native||native.entityID!==entityID||native.systemID!==scene.systemID||
   !positive(native.ownerID)||!positive(native.corporationID)||
   ship.ownerID!==native.ownerID||ship.corporationID!==native.corporationID||
   !controller||controller.entityID!==entityID||
   controller.systemID!==scene.systemID||!Array.isArray(cargo)||
   cargo.length>512)return denied("SWEEP_NATIVE_SHIP_UNVERIFIED");
  if(quarantine.size)return denied("SWEEP_OPERATOR_REPAIR_REQUIRED");
  const flights=cargo.filter(row=>row?.deployedProbe?.status==="IN_SPACE");
  if(flights.length<4||flights.length>8||
     new Set(flights.map(x=>x.cargoID)).size!==flights.length)
   return denied("SWEEP_ORIGINAL_FOUR_TO_EIGHT_PROBES_REQUIRED");
  const origin=flights[0]?.deployedProbe?.originPosition;
  if(!vec(origin))return denied("SWEEP_ORIGIN_UNVERIFIED");
  for(const row of flights){
   const p=row.deployedProbe,physical=scene.getEntityByID(p?.probeID);
   if(row.entityID!==entityID||row.ownerID!==native.ownerID||
      row.quantity!==0||row.singleton===true||row.transient===true||
      p.probeID!==row.cargoID||p.entityID!==entityID||
      p.ownerID!==native.ownerID||p.systemID!==scene.systemID||
      !vec(p.position)||!vec(p.originPosition)||
      dist(p.originPosition,origin)>0.01||
      !Number.isSafeInteger(p.sweepStep)||p.sweepStep<0||p.sweepStep>maxSteps||
      !Number.isSafeInteger(p.launchedAtMs)||p.launchedAtMs>now||
      now-p.launchedAtMs>3600000||
      !physical||physical.itemID!==row.cargoID||physical.kind!=="probe"||
      physical.nativeNpcProbe!==true||
      physical.nativeNpcCargoID!==row.cargoID||
      physical.ownerID!==native.ownerID||physical.typeID!==row.typeID||
      physical.systemID!==scene.systemID||!vec(physical.position))
     return denied("SWEEP_ORIGINAL_PHYSICAL_PROBE_INVALID");
   // Source-first motion may have been interrupted by a crash. Only the
   // original sealed physical probe may be projected to its durable location.
   if(dist(physical.position,p.position)>1){
    let relocated;
    try{relocated=relocateNativeProbe({scene,row})}
    catch{return denied("SWEEP_NATIVE_VISIBILITY_REFRESH_FAILED")}
    return relocated?.success===true?
     {status:"SWEEP_GEOMETRY_RECONCILED",moved:0,originalCargoID:row.cargoID}:
     denied("SWEEP_NATIVE_VISIBILITY_REFRESH_UNCONFIRMED");
   }
  }
  const next=flights.slice().sort((a,b)=>
   a.deployedProbe.sweepStep-b.deployedProbe.sweepStep||a.cargoID-b.cargoID)[0];
  if(quarantine.has(next.cargoID))return denied("SWEEP_OPERATOR_REPAIR_REQUIRED");
  const step=next.deployedProbe.sweepStep+1;
  if(step>maxSteps)return {status:"SWEEP_COMPLETE",moved:0};
  // Spiral is strictly a function of public ship-launch location and
  // previous original probe receipt. It cannot learn any secret signature.
  const [dx,dz]=spiral(step);
  const position={x:origin.x+dx*cellSpacingMeters,
   y:origin.y,z:origin.z+dz*cellSpacingMeters};
  if(!vec(position)||Math.max(Math.abs(position.x),Math.abs(position.y),
    Math.abs(position.z))>2e13)return denied("SWEEP_POSITION_OUTSIDE_BOUNDS");
  const changed={...next,deployedProbe:{...next.deployedProbe,
   sweepStep:step,position}};
  let write;
  try{write=upsertNativeCargo(changed)}
  catch{quarantine.add(next.cargoID);return denied("SWEEP_CARGO_UPDATE_FAILED")}
  if(write?.success!==true){quarantine.add(next.cargoID);
   return denied("SWEEP_CARGO_UPDATE_FAILED")}
  let flush;
  try{flush=flushNpcCargo()}catch{quarantine.add(next.cargoID);
   return denied("SWEEP_CARGO_DURABILITY_UNCONFIRMED")}
  if(flush?.success!==true){quarantine.add(next.cargoID);
   return denied("SWEEP_CARGO_DURABILITY_UNCONFIRMED")}
  const live=scene.getEntityByID(next.cargoID);
  if(!live||live.nativeNpcProbe!==true||live.nativeNpcCargoID!==next.cargoID||
   live.ownerID!==native.ownerID||live.typeID!==next.typeID||
   !vec(live.position))return {status:"SWEEP_PENDING_RECONCILIATION",moved:0};
  let relocated;
  try{relocated=relocateNativeProbe({scene,row:changed})}
  catch{return {status:"SWEEP_PENDING_RECONCILIATION",moved:0,
   originalCargoID:next.cargoID}}
  if(relocated?.success!==true)
   return {status:"SWEEP_PENDING_RECONCILIATION",moved:0,
    originalCargoID:next.cargoID};
  return {status:"SWEEP_ORIGINAL_PROBE_MOVED",moved:1,
   originalCargoID:next.cargoID,sweepStep:step};
 }
 return Object.freeze({tick});
}
module.exports={createNativeNpcProbeSweep};
