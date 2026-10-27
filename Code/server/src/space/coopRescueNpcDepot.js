"use strict";
// Real rival NPC trader salvage -> real NPC corporation station inventory.
// A physical native ship must arrive and dwell; cargo row is consumed in the
// SAME SQLite transaction which transfers its quantity into one native item.
const pos=n=>Number.isSafeInteger(n)&&n>0;
const point=x=>x&&["x","y","z"].every(k=>Number.isFinite(x[k]));
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function createRescueNpcDepot({getCargo,getStations,atomicRows,
 warpToPoint,orbit,getMetadata,clock=()=>Date.now()}={}){
 if([getCargo,getStations,atomicRows,warpToPoint,orbit,
  getMetadata,clock].some(f=>typeof f!=="function"))
  throw Error("RESCUE_RIVAL_DEPOT_AUTHORITIES_REQUIRED");
 const arrivals=new Map(),retry=new Map();
 function tick({scene,candidates=[],blockedIDs=new Set()}={}){
  if(process.env.EVEJS_COOP_RESCUE_NPC_RIVALS!=="1"||
   process.env.EVEJS_COOP_RESCUE_ATOMIC!=="1")
   return {status:"DISABLED",events:[]};
  if(!pos(scene?.systemID)||!Array.isArray(candidates))
   return {status:"SCENE_UNAVAILABLE",events:[]};
  const now=clock(),events=[];
  for(const candidate of candidates){
   if(candidate?.role!=="trader"||!pos(candidate.entityID)||
    !pos(candidate.corporationID)||blockedIDs.has(candidate.entityID))
    continue;
   const ship=scene.getEntityByID?.(candidate.entityID);
   if(ship?.nativeNpc!==true||ship.kind!=="ship"||
    ship.itemID!==candidate.entityID||!point(ship.position)||
    ship.mode==="WARP"||ship.pendingWarp||ship.warpState)continue;
   let rows,stations;
   try{rows=getCargo(candidate.entityID);stations=getStations(scene.systemID)}
   catch{continue}
   const cargo=(Array.isArray(rows)?rows:[]).filter(x=>
    x.entityID===candidate.entityID&&
    x.ownerID===candidate.corporationID&&
    x.coopRescueRivalSalvage===true&&
    pos(x.sourceCargoID)&&pos(x.sourceWreckItemID)&&
    pos(x.sourceWreckID)&&pos(x.cargoID)&&pos(x.quantity));
   if(!cargo.length)continue;
   const choices=(Array.isArray(stations)?stations:[]).filter(x=>
    x.corporationID===candidate.corporationID&&
    x.solarSystemID===scene.systemID&&pos(x.stationID))
    .sort((a,b)=>a.stationID-b.stationID);
   const station=choices[0];
   if(!station)continue;
   const physical=scene.staticEntities?.find(x=>
    x.kind==="station"&&x.itemID===station.stationID);
   if(!physical||!point(physical.position))continue;
   const key=candidate.entityID+":"+station.stationID;
   if((retry.get(key)||0)>now)continue;
   const range=dist(ship.position,physical.position);
   if(range>2500){
    arrivals.delete(key);
    const outcome=range>250000?
     warpToPoint(candidate.entityID,physical.position):
     orbit(candidate.entityID,station.stationID,1400);
    retry.set(key,now+(outcome?.success?30000:60000));
    if(outcome?.success)events.push({status:"NATIVE_RIVAL_RETURNING_STOCK",
     entityID:candidate.entityID,stationID:station.stationID});
    continue;
   }
   const first=arrivals.get(key);
   if(!first){arrivals.set(key,now);continue}
   if(now-first<2500)continue;
   const original=cargo[0];
   let done;
   try{done=atomicRows(["npcCargo","npcEntities","items","identityState"],tx=>{
    const entity=tx.get("npcEntities","entities\u001f"+candidate.entityID);
    const root=tx.get("npcCargo","cargo");
    const row=root?.[String(original.cargoID)];
    if(entity?.entityID!==candidate.entityID||
     entity.corporationID!==candidate.corporationID||
     entity.systemID!==scene.systemID||entity.transient===true||
     !row||row.cargoID!==original.cargoID||
     row.entityID!==candidate.entityID||
     row.sourceCargoID!==original.sourceCargoID||
     row.sourceWreckID!==original.sourceWreckID||
     row.sourceWreckItemID!==original.sourceWreckItemID||
     row.quantity!==original.quantity)
     throw Error("RIVAL_DEPOT_SOURCE_CHANGED");
    const meta=getMetadata(row.typeID,row.itemName),id=
     tx.get("identityState","nextItemID");
    if(!pos(id)||!pos(id+1)||tx.get("items",String(id))||
     meta?.typeID!==row.typeID||!Number.isFinite(meta.volume))
     throw Error("RIVAL_DEPOT_INVENTORY_UNAVAILABLE");
    const tag="coop-rescue-npc:v1:wreck:"+row.sourceWreckID+
     ":item:"+row.sourceWreckItemID+":cargo:"+row.sourceCargoID;
    if(tx.scan("items").some(x=>x.value?.customInfo===tag))
     throw Error("RIVAL_DEPOT_ALREADY_CREDITED");
    const item={itemID:id,ownerID:candidate.corporationID,
     locationID:station.stationID,flagID:4,
     typeID:row.typeID,quantity:row.quantity,stacksize:row.quantity,
     singleton:0,groupID:meta.groupID||0,categoryID:meta.categoryID||0,
     itemName:meta.name||row.itemName||"Recovered ore",
     customInfo:tag,volume:meta.volume,
     mass:meta.mass||0,capacity:meta.capacity||0,radius:meta.radius||0};
    const updated={...root};delete updated[String(row.cargoID)];
    tx.put("npcCargo","cargo",updated);
    tx.put("identityState","nextItemID",id+1);
    tx.put("items",String(id),item);
    return {itemID:id,sourceCargoID:row.sourceCargoID,
     quantity:row.quantity};
   })}catch{retry.set(key,now+60000);continue}
   if(done?.itemID){
    arrivals.delete(key);
    events.push({status:"NATIVE_RIVAL_CORP_STOCK_COMMITTED",
     entityID:candidate.entityID,stationID:station.stationID,
     corporationID:candidate.corporationID,...done,
     quantityCreated:0,iskCreated:0});
   }
  }
  while(retry.size>512)retry.delete(retry.keys().next().value);
  return {status:"READY",events};
 }
 return {tick};
}
module.exports={createRescueNpcDepot};
