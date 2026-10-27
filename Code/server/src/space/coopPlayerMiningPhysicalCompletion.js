"use strict";
/**
 * CH24+31 Stage E1: READ-ONLY physical completion of original native
 * HAUL/RETREAT. Original GameStore CAS decides if/when command is completed.
 * No wallclock-only completion; native warp/haul ACK is NOT delivery proof.
 */
const pos=x=>Number.isSafeInteger(x)&&x>0;
const finite=x=>typeof x==="number"&&Number.isFinite(x);
const goodPoint=p=>p&&finite(p.x)&&finite(p.y)&&finite(p.z)&&
 Math.max(Math.abs(p.x),Math.abs(p.y),Math.abs(p.z))<1e16;
const samePoint=(a,b)=>goodPoint(a)&&goodPoint(b)&&
 a.x===b.x&&a.y===b.y&&a.z===b.z;
const MAX_STACKS=256;
function createPhysicalCompletionOracle({store,warehouseReceipt,findWarehouseItem,
 maxArrivalMeters=2500}={}){
 if(!store||typeof store.listNativeCargoForEntity!=="function"||
  typeof warehouseReceipt!=="function"||
  typeof findWarehouseItem!=="function"||
  !finite(maxArrivalMeters)||maxArrivalMeters<=0||maxArrivalMeters>5000)
  throw Error("PLAYER_MINING_PHYSICAL_COMPLETION_AUTHORITIES_REQUIRED");
 const cargoFor=id=>store.listNativeCargoForEntity(id);
 function captureHaul({fleet}={}){
  if(!fleet||!pos(fleet.ownerID)||!Array.isArray(fleet.minerIDs)||
   !Array.isArray(fleet.haulerIDs)||!fleet.haulerIDs.length)return null;
  const results=[],seen=new Set();
  try{
   for(const minerID of fleet.minerIDs){
    if(!pos(minerID))return null;
    const cargo=cargoFor(minerID);
    if(!Array.isArray(cargo))return null;
    for(const item of cargo){
     if(!pos(item?.cargoID)||!pos(item.typeID)||!pos(item.quantity)||
      item.entityID!==minerID||item.ownerID!==fleet.ownerID||
      item.transient!==false||Number(item.moduleID||0)!==0||
      seen.has(item.cargoID))return null;
     seen.add(item.cargoID);
     results.push({cargoID:item.cargoID,typeID:item.typeID,
      quantity:item.quantity,minerID});
     if(results.length>MAX_STACKS)return null;
    }
   }
  }catch{return null}
  return results.length?results.sort((a,b)=>a.cargoID-b.cargoID):null;
 }
 function captureRetreat({fleetRecord,scene,fleet}={}){
  const point=fleetRecord?.originAnchor?.position;
  if(!goodPoint(point)||typeof scene?.getEntityByID!=="function"||
    !fleet||scene.systemID!==fleet.systemID||
    fleetRecord?.systemID!==fleet.systemID||fleetRecord?.fleetID!==fleet.fleetID||
    !Array.isArray(fleet.minerIDs)||!Array.isArray(fleet.haulerIDs))
   return null;
  const departureShipIDs=[],seen=new Set();
  for(const id of [...fleet.minerIDs,...fleet.haulerIDs]){
   if(!pos(id)||seen.has(id))return null;
   seen.add(id);
   const ship=scene.getEntityByID(id);
   if(!ship||ship.itemID!==id||ship.kind!=="ship"||
    ship.nativeNpc!==true||ship.transient===true||
    ship.isWarping===true||ship.pendingWarp||ship.warpState||
    ship.sessionlessWarpIngress||!goodPoint(ship.position))return null;
   const p=ship.position;
   const dist=(p.x-point.x)**2+(p.y-point.y)**2+(p.z-point.z)**2;
   if(!finite(dist))return null;
   if(dist>maxArrivalMeters*maxArrivalMeters)departureShipIDs.push(id);
  }
  // Already-at-origin cannot be mistaken for proof of a genuine retreat.
  if(!departureShipIDs.length)return null;
  return {origin:{x:point.x,y:point.y,z:point.z},departureShipIDs};
 }
 function haul({row,fleetRecord,fleet}={}){
  if(row?.directive!=="HAUL"||row.commandState!=="NATIVE_REQUESTED"||
   !pos(row.issuedAt)||!pos(row.nativeRequestedAt)||
   !Array.isArray(row.originalCargo)||row.originalCargo.length===0||
   row.originalCargo.length>MAX_STACKS||
   !fleet||fleetRecord?.fleetID!==row.fleetID||
   fleetRecord.systemID!==row.systemID||
   fleetRecord.state!=="mining"||
   !pos(fleetRecord.lastHauledAtMs)||
   fleetRecord.lastHauledAtMs<row.issuedAt)return null;
  const expected=new Set(),haulers=new Set(fleet.haulerIDs);
  if(haulers.size!==fleet.haulerIDs.length||!haulers.size)return null;
  for(const item of row.originalCargo){
   if(!pos(item?.cargoID)||!pos(item.typeID)||!pos(item.quantity)||
    !fleet.minerIDs.includes(item.minerID)||expected.has(item.cargoID))return null;
   expected.add(item.cargoID);
  }
  // All original miners AND haulers have relinquished the same cargo IDs.
  for(const entityID of [...fleet.minerIDs,...fleet.haulerIDs]){
   let live;try{live=cargoFor(entityID)}catch{return null}
   if(!Array.isArray(live)||live.some(x=>expected.has(x?.cargoID)))return null;
  }
  const proofs=[];
  for(const item of row.originalCargo){
   let receipt,stack;
   try{
    receipt=warehouseReceipt(item.cargoID);
    if(receipt?.version!==1||receipt.phase!=="COMMITTED"||
     receipt.cargoID!==item.cargoID||receipt.typeID!==item.typeID||
     receipt.quantity!==item.quantity||
     receipt.corporationID!==row.employerCorpID||
     receipt.systemID!==row.systemID||receipt.fleetID!==row.fleetID||
     !haulers.has(receipt.haulerID)||!pos(receipt.stationID)||
     !pos(receipt.itemID)||!pos(receipt.at)||
     receipt.at<row.issuedAt||receipt.updatedAt<receipt.at)return null;
    stack=findWarehouseItem({ownerID:row.employerCorpID,
     stationID:receipt.stationID,cargoID:item.cargoID});
   }catch{return null}
   if(!stack||stack.itemID!==receipt.itemID||stack.typeID!==item.typeID||
    stack.quantity!==item.quantity||stack.stacksize!==item.quantity||
    stack.ownerID!==row.employerCorpID||stack.locationID!==receipt.stationID||
    stack.flagID!==4||stack.singleton!==0||
    stack.customInfo!=="coop-warehouse:v1:cargo:"+item.cargoID)return null;
   proofs.push({cargoID:item.cargoID,itemID:stack.itemID,
    haulerID:receipt.haulerID,stationID:receipt.stationID});
  }
  return {kind:"ORIGINAL_WAREHOUSE_DELIVERY",version:1,
   commandSeq:row.commandSeq,originalCargo:proofs,
   lastHauledAtMs:fleetRecord.lastHauledAtMs};
 }
 function retreat({row,fleetRecord,fleet,scene}={}){
  if(row?.directive!=="RETREAT"||row.commandState!=="NATIVE_REQUESTED"||
   !pos(row.issuedAt)||!pos(row.nativeRequestedAt)||
   !goodPoint(row.retreatAnchor)||
   !Array.isArray(row.retreatDepartureShipIDs)||
   !row.retreatDepartureShipIDs.length||
   row.retreatDepartureShipIDs.some(id=>!pos(id)||
    ![...fleet.minerIDs,...fleet.haulerIDs].includes(id))||
   new Set(row.retreatDepartureShipIDs).size!==row.retreatDepartureShipIDs.length||
   !fleetRecord||!fleet||
   fleetRecord.fleetID!==row.fleetID||fleetRecord.systemID!==row.systemID||
   !samePoint(fleetRecord.originAnchor?.position,row.retreatAnchor)||
   !["retreating","depleted"].includes(fleetRecord.state)||
   scene?.systemID!==row.systemID||
   typeof scene?.getEntityByID!=="function")return null;
  const ids=[...fleet.minerIDs,...fleet.haulerIDs];
  if(!ids.length||new Set(ids).size!==ids.length)return null;
  const distanceSq=maxArrivalMeters*maxArrivalMeters;
  const ships=[];
  for(const id of ids){
   const entity=scene.getEntityByID(id);
   if(!entity||entity.itemID!==id||entity.kind!=="ship"||
    entity.nativeNpc!==true||entity.transient===true||
    entity.isWarping===true||entity.pendingWarp||entity.warpState||
    entity.sessionlessWarpIngress||
    String(entity.mode||"").toUpperCase()==="WARP"||
    !goodPoint(entity.position))return null;
   const p=entity.position,a=row.retreatAnchor;
   const d2=(p.x-a.x)**2+(p.y-a.y)**2+(p.z-a.z)**2;
   if(!finite(d2)||d2>distanceSq)return null;
   ships.push(id);
  }
  return {kind:"ORIGINAL_FLEET_WARP_ARRIVED",version:1,
   commandSeq:row.commandSeq,shipIDs:ships,
   origin:{...row.retreatAnchor},maxArrivalMeters};
 }
 function verify({row,fleet,fleetRecord,scene}={}){
  if(!row||!fleet||row.corporationID===row.employerCorpID||
   row.systemID!==fleet.systemID||row.fleetID!==fleet.fleetID||
   row.employerCorpID!==fleet.ownerID||
   row.minerIDs?.length!==fleet.minerIDs?.length||
   row.haulerIDs?.length!==fleet.haulerIDs?.length||
   !row.minerIDs.every((x,i)=>x===fleet.minerIDs[i])||
   !row.haulerIDs.every((x,i)=>x===fleet.haulerIDs[i]))return null;
  return row.directive==="HAUL"?haul({row,fleetRecord,fleet}):
   row.directive==="RETREAT"?retreat({row,fleetRecord,fleet,scene}):null;
 }
 return Object.freeze({captureHaul,captureRetreat,verify,
  mode:"ORIGINAL_CARGO_AND_WARP_PROOF_READ_ONLY"});
}
module.exports={createPhysicalCompletionOracle,goodPoint};
