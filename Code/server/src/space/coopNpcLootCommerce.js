"use strict";
// Native NPC loot provenance + physical station logistics. No virtual
// deliveries, teleport, fabricated order, item grant, wallet or sale here.
const fs=require("node:fs"),path=require("node:path");
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
const vec=x=>x&&["x","y","z"].every(k=>Number.isFinite(x[k]));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function createLootCommerce({root,store,sceneForSystem,getController,getStation,
 warp,orbit,clock=()=>Date.now(),maxShips=4,commandCooldownMs=60000}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||!store||
  typeof store.listNativeCargoForEntity!=="function"||
  typeof sceneForSystem!=="function"||typeof getController!=="function"||
  typeof getStation!=="function"||typeof warp!=="function"||
  typeof orbit!=="function"||typeof clock!=="function"||
  !Number.isInteger(maxShips)||maxShips<1||maxShips>20||
  !Number.isInteger(commandCooldownMs)||commandCooldownMs<30000)
  throw Error("INVALID_LOOT_COMMERCE_CONFIG");
 const leases=new Map(),stationReady=new Map();
 function verifiedCargo({pilotID,entityID,cargo}={}){
  const entity=id(entityID),cargoID=id(cargo?.cargoID);
  const sourceID=id(cargo?.sourceWreckItemID),wreckID=id(cargo?.sourceWreckID);
  if(!named(pilotID)||!entity||!cargoID||!sourceID||!wreckID||
   Number(cargo.entityID)!==entity||cargo.singleton===true||
   Number(cargo.moduleID||0)!==0||!id(cargo.ownerID)||
   !id(cargo.typeID)||!Number.isSafeInteger(Number(cargo.quantity))||
   Number(cargo.quantity)<1||cargo.transient===true)return false;
  let tx;
  try{tx=JSON.parse(fs.readFileSync(path.join(root,"tx",String(sourceID)+".json"),"utf8"));}
  catch(_){return false;}
  if(tx?.version!==1||tx.phase!=="SETTLED"||
   Number(tx.itemID)!==sourceID||Number(tx.wreckID)!==wreckID||
   Number(tx.entityID)!==entity||tx.pilotID!==pilotID||
   Number(tx.cargoID)!==cargoID||Number(tx.ownerID)!==Number(cargo.ownerID)||
   Number(tx.typeID)!==Number(cargo.typeID)||!id(tx.quantity)||
   Number(cargo.quantity)>Number(tx.quantity)||
   Number(tx.newCargo?.groupID)!==Number(cargo.groupID)||
   Number(tx.newCargo?.categoryID)!==Number(cargo.categoryID)||
   Number(tx.newCargo?.sourceWreckItemID)!==sourceID||
   Number(tx.newCargo?.sourceWreckID)!==wreckID)
   return false;
  return true;
 }
 function stock({pilotID,entityID}={}){
  if(!named(pilotID)||!id(entityID))return [];
  let cargo;
  try{cargo=store.listNativeCargoForEntity(Number(entityID));}catch(_){return [];}
  if(!Array.isArray(cargo))return [];
  return cargo.filter(row=>verifiedCargo({pilotID,entityID,cargo:row}))
   .sort((a,b)=>Number(a.cargoID)-Number(b.cargoID));
 }
 function tick({assignments=[],blockedIDs=new Set()}={}){
  const orders=[],ready=[],now=clock();
  if(!Array.isArray(assignments)||!Number.isSafeInteger(now)||now<0)
   return {status:"INVALID",orders,ready};
  const identities=new Map(),entities=new Map();
  for(const row of assignments){
   if(!named(row?.pilotID)||!id(row.entityID)||!id(row.systemID))continue;
   const k=row.pilotID,prev=identities.get(k)||new Set();
   prev.add(String(row.entityID)+":"+String(row.systemID));
   identities.set(k,prev);
   const e=String(row.entityID),seen=entities.get(e)||new Set();
   seen.add(k);entities.set(e,seen);
  }
  let processed=0;
  for(const assignment of assignments){
   if(processed>=maxShips)break;
   const pilotID=assignment?.pilotID,entityID=id(assignment?.entityID);
   const systemID=id(assignment?.systemID);
   if(!named(pilotID)||!entityID||!systemID||
    identities.get(pilotID)?.size!==1||entities.get(String(entityID))?.size!==1||
    blockedIDs.has(entityID))continue;
   const cargo=stock({pilotID,entityID});
   if(!cargo.length)continue;
   const scene=sceneForSystem(systemID),ship=scene?.getEntityByID?.(entityID);
   if(Number(scene?.systemID)!==systemID||ship?.kind!=="ship"||
    ship.nativeNpc!==true||Number(ship.itemID)!==entityID||
    ship.session?.characterID||!vec(ship.position)||ship.pendingWarp||
    ship.warpState||String(ship.mode||"").toUpperCase().includes("WARP"))
    continue;
   const players=[...scene.sessions?.values?.()||[]];
   if(players.some(s=>Number(s?._space?.shipID)===entityID))continue;
   let controller;
   try{controller=getController(entityID);}catch(_){continue;}
   if(Number(controller?.entityID)!==entityID||
    Number(controller?.systemID)!==systemID||
    Number(controller?.currentTargetID)>0||
    controller?.manualOrder?.type==="attack")continue;
   const stations=(scene.staticEntities||[]).filter(p=>
    p?.kind==="station"&&id(p.itemID)&&vec(p.position)&&
    Number(getStation(p.itemID)?.solarSystemID)===systemID)
    .sort((a,b)=>dist(ship.position,a.position)-dist(ship.position,b.position)||
     Number(a.itemID)-Number(b.itemID));
   if(!stations.length)continue;
   const station=stations[0],d=dist(ship.position,station.position);
   const key=systemID+":"+entityID;
   const last=leases.get(key)||{};
   leases.set(key,{...last,pilotID,entityID,systemID,
    expiresAt:now+commandCooldownMs+30000});
   processed++;
   if(d<=5000){
    const evidence={pilotID,entityID,systemID,stationID:Number(station.itemID),
     cargoIDs:cargo.map(x=>Number(x.cargoID)),status:"PHYSICALLY_AT_NATIVE_STATION"};
    stationReady.set(key,{...evidence,expiresAt:now+45000});
    ready.push(evidence);
    continue;
   }
   stationReady.delete(key);
   if(last.nextOrderAt>now)continue;
   const warpRequired=d>250000;
   let result;
   try{result=warpRequired?warp(entityID,Number(station.itemID),
    {forceImmediateStart:true}):orbit(entityID,Number(station.itemID),2000);}
   catch(_){result={success:false};}
   leases.set(key,{...last,pilotID,entityID,systemID,
    expiresAt:now+commandCooldownMs+30000,nextOrderAt:now+
    (result?.success===true?commandCooldownMs:30000)});
   if(result?.success===true)
    orders.push({pilotID,entityID,systemID,stationID:Number(station.itemID),
     action:warpRequired?"NATIVE_WARP_TO_STATION":"NATIVE_ORBIT_STATION",
     cargoIDs:cargo.map(x=>Number(x.cargoID)),iskCredited:false});
  }
  for(const [key,l] of leases)if(l.expiresAt<now)leases.delete(key);
  for(const [key,l] of stationReady)if(l.expiresAt<now)stationReady.delete(key);
  return {status:"OK",orders,ready};
 }
 function activeIDs(systemID){
  const now=clock(),system=id(systemID),result=new Set();
  if(!system)return result;
  for(const lease of leases.values())if(lease.systemID===system&&
   lease.expiresAt>=now)result.add(lease.entityID);
  return result;
 }
 function readyFor({pilotID,entityID,systemID,stationID,cargoID}={}){
  const ship=id(entityID),sys=id(systemID),station=id(stationID),cargo=id(cargoID);
  if(!ship||!sys||!station||!cargo||!named(pilotID))return false;
  const entry=stationReady.get(sys+":"+ship);
  if(!entry||entry.expiresAt<clock()||entry.pilotID!==pilotID||
   entry.stationID!==station||!entry.cargoIDs.includes(cargo))return false;
  const live=sceneForSystem(sys)?.getEntityByID?.(ship);
  const scene=sceneForSystem(sys);
  const target=scene?.staticEntities?.find(p=>p.kind==="station"&&
   Number(p.itemID)===station&&vec(p.position));
  if(!live||live.nativeNpc!==true||!vec(live.position)||!target||
   dist(live.position,target.position)>5000)return false;
  return stock({pilotID,entityID:ship}).some(c=>Number(c.cargoID)===cargo);
 }
 return {stock,verifiedCargo,tick,activeIDs,readyFor};
}
module.exports={createLootCommerce};
