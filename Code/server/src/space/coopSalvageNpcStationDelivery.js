"use strict";
// A-Life physical NPC salvage return: real NPC cargo -> real station itemStore.
// Same cargoID/ship/owner and native rival ACID pickup receipt. No virtual stock.
const positive=x=>Number.isSafeInteger(x)&&x>0;
const vec=p=>p&&["x","y","z"].every(k=>Number.isFinite(p[k]));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
function createNpcSalvageDelivery({atomic,readNativeCargo,readRivalJournal,
 readNativeItems,readNativeEntity,getController,getStation,buildInventoryItem,
 warp,orbit,clock=()=>Date.now()}={}){
 if(typeof atomic?.transact!=="function"||
  [readNativeCargo,readRivalJournal,readNativeItems,readNativeEntity,getController,
   getStation,buildInventoryItem,warp,orbit,clock]
   .some(f=>typeof f!=="function"))
  throw Error("SALVAGE_RIVAL_STATION_NATIVE_AUTHORITIES_REQUIRED");
 const cooldown=new Map();
 function tick({scene,assignments=[],blockedIDs=new Set()}={}){
  if(process.env.EVEJS_COOP_ALIFE_SALVAGE_RIVALS!=="1"||
   process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1")
   return {status:"DISABLED",orders:[],deliveries:[]};
  const systemID=scene?.systemID,now=clock();
  if(!positive(systemID)||typeof scene.getEntityByID!=="function"||
   !Array.isArray(assignments)||!(blockedIDs instanceof Set))
   return {status:"INVALID",orders:[],deliveries:[]};
  let journal;try{journal=readRivalJournal()}
  catch{return {status:"RIVAL_JOURNAL_UNAVAILABLE",orders:[],deliveries:[]}}
  if(journal?.version!==1||!journal.moves||
   Object.keys(journal.moves).length>10000)
   return {status:"RIVAL_JOURNAL_CORRUPT",orders:[],deliveries:[]};
  const orders=[],deliveries=[];
  const nativeStations=(scene.staticEntities||[]).filter(x=>
   x?.kind==="station"&&positive(x.itemID)&&vec(x.position)&&
   getStation(x.itemID)?.solarSystemID===systemID);
  if(!nativeStations.length)return {status:"NO_NATIVE_STATION",orders,deliveries};
  for(const a of assignments){
   if(orders.length||deliveries.length)break;
   if(!/^coop-pilot-[0-9]{3,}$/.test(String(a?.pilotID))||
    !positive(a.entityID)||a.systemID!==systemID||
    blockedIDs.has(a.entityID)||
    assignments.filter(x=>x.entityID===a.entityID).length!==1)
    continue;
   let cargo,ship,controller;try{
    cargo=readNativeCargo(a.entityID);
    ship=readNativeEntity(a.entityID);
    controller=getController(a.entityID);
   }catch{continue}
   const live=scene.getEntityByID(a.entityID);
   if(!Array.isArray(cargo)||ship?.entityID!==a.entityID||
    ship.systemID!==systemID||!positive(ship.corporationID)||
    live?.kind!=="ship"||live.nativeNpc!==true||
    live.itemID!==a.entityID||!vec(live.position)||
    controller?.entityID!==a.entityID||
    controller.systemID!==systemID||
    controller.currentTargetID>0||
    controller.manualOrder?.type==="attack")
    continue;
   const found=cargo.filter(c=>positive(c?.cargoID)&&
    positive(c?.sourceWreckItemID)&&positive(c?.sourceCargoID)&&
    c.entityID===a.entityID&&c.ownerID===ship.ownerID&&
    c.singleton===false&&positive(c.quantity)&&
    journal.moves[String(c.sourceWreckItemID)]?.state==="NPC_CARGO"&&
    journal.moves[String(c.sourceWreckItemID)].npcCargoID===c.cargoID&&
    journal.moves[String(c.sourceWreckItemID)].entityID===a.entityID&&
    journal.moves[String(c.sourceWreckItemID)].sourceCargoID===c.sourceCargoID&&
    journal.moves[String(c.sourceWreckItemID)].corporationID===ship.corporationID);
   if(!found.length)continue;
   const stock=found[0];
   const station=nativeStations.slice().sort((x,y)=>
    distance(live.position,x.position)-distance(live.position,y.position)||
    x.itemID-y.itemID)[0];
   const d=distance(live.position,station.position);
   const lease=systemID+":"+a.entityID;
   if(cooldown.get(lease)>now)continue;
   if(d>5000){
    let acknowledged;
    try{acknowledged=d>150000?warp(a.entityID,station.itemID):
     orbit(a.entityID,station.itemID,1500)}
    catch{acknowledged={success:false}}
    cooldown.set(lease,now+(acknowledged?.success===true?60000:30000));
    if(acknowledged?.success===true)
     orders.push({pilotID:a.pilotID,entityID:a.entityID,
      stationID:station.itemID,action:d>150000?
       "NATIVE_RIVAL_WARP_TO_STATION":"NATIVE_RIVAL_ORBIT_STATION",
      sourceCargoID:stock.sourceCargoID});
    continue;
   }
   try{
    const result=atomic.transact(
     ["npcCargo","items","identityState","corporationRuntime"],tx=>{
      const cargoRows=tx.get("npcCargo","cargo"),rivals=
       tx.get("corporationRuntime","coopSalvageRivalMoves");
      const original=cargoRows?.[String(stock.cargoID)],proof=
       rivals?.moves?.[String(stock.sourceWreckItemID)];
      // The rival's real pickup journal and the original cargo row must
      // agree on the SAME source wreck, manifest, NPC and corporation.
      // Preflight reads are not authority: inspect again under GameStore.
      if(!original||original.cargoID!==stock.cargoID||
       original.entityID!==a.entityID||
       original.ownerID!==ship.ownerID||original.flagID!==5||
       original.singleton!==false||
       original.sourceCargoID!==stock.sourceCargoID||
       original.sourceWreckItemID!==stock.sourceWreckItemID||
       original.sourceWreckID!==stock.sourceWreckID||
       original.salvageManifestKey!==stock.salvageManifestKey||
       original.quantity!==stock.quantity||
       original.typeID!==stock.typeID||
       !positive(original.typeID)||!positive(original.quantity)||
       !positive(original.sourceWreckID)||
       !/^\d+-\d+-\d+$/.test(String(original.salvageManifestKey))||
       rivals?.version!==1||!rivals.moves||
       typeof rivals.moves!=="object"||Array.isArray(rivals.moves)||
       proof?.v!==1||proof.state!=="NPC_CARGO"||
       proof.wreckID!==original.sourceWreckID||
       proof.manifestKey!==original.salvageManifestKey||
       proof.wreckItemID!==original.sourceWreckItemID||
       proof.npcCargoID!==stock.cargoID||
       proof.sourceCargoID!==stock.sourceCargoID||
       proof.entityID!==a.entityID||
       proof.corporationID!==ship.corporationID)
       throw Error("SALVAGE_RIVAL_ORIGINAL_CARGO_NOT_VERIFIED");
      const current=tx.get("identityState","nextItemID");
      const all=tx.scan("items");
      const maximum=all.reduce((n,x)=>
       Math.max(n,Number(x.value?.itemID)||0),0);
      if(!positive(current))
       throw Error("SALVAGE_RIVAL_ITEM_ALLOCATOR_UNAVAILABLE");
      const itemID=Math.max(current,maximum+1);
      if(!positive(itemID)||!Number.isSafeInteger(itemID+1))
       throw Error("SALVAGE_RIVAL_ITEM_ID_INVALID");
      const customInfo="coop-salvage-rival:v1:"+
       stock.sourceWreckItemID+":"+stock.sourceCargoID;
      if(all.some(x=>x.value?.customInfo===customInfo))
       throw Error("SALVAGE_RIVAL_STOCK_DUPLICATE");
      const item=buildInventoryItem({itemID,
       typeID:stock.typeID,itemName:stock.itemName,
       ownerID:ship.corporationID,locationID:station.itemID,
       flagID:4,quantity:stock.quantity,stacksize:stock.quantity,
       singleton:0,customInfo});
      if(item?.itemID!==itemID||item.ownerID!==ship.corporationID||
       item.locationID!==station.itemID||item.flagID!==4||
       item.typeID!==stock.typeID||item.quantity!==stock.quantity||
       item.stacksize!==stock.quantity||item.singleton!==0||
       item.customInfo!==customInfo)
       throw Error("SALVAGE_RIVAL_NATIVE_ITEM_BUILD_MISMATCH");
      const next={...cargoRows};delete next[String(stock.cargoID)];
      tx.put("npcCargo","cargo",next);
      tx.put("items",String(itemID),item);
      tx.put("identityState","nextItemID",itemID+1);
      proof.state="NPC_STOCK_DELIVERED";proof.nativeItemID=itemID;
      proof.stationID=station.itemID;
      tx.put("corporationRuntime","coopSalvageRivalMoves",rivals);
      return {status:"ALIFE_SALVAGE_RIVAL_STOCK_COMMITTED",
       nativeStockItemID:itemID,sourceCargoID:stock.sourceCargoID};
     });
    if(result?.status==="ALIFE_SALVAGE_RIVAL_STOCK_COMMITTED"){
     // The SQLite commit can succeed while cache/index reconciliation fails.
     // Only the read-back of the same native source and station item is
     // a CONFIRMED delivery. Uncertain outcomes are never retried blindly.
     let finalCargo,finalJournal,finalItems;
     try{
      finalCargo=readNativeCargo(a.entityID);
      finalJournal=readRivalJournal();
      finalItems=readNativeItems();
     }catch{}
     const receipt=finalJournal?.moves?.[String(stock.sourceWreckItemID)];
     const tag="coop-salvage-rival:v1:"+
      stock.sourceWreckItemID+":"+stock.sourceCargoID;
     const matches=Array.isArray(finalItems)?
      finalItems.filter(x=>x?.customInfo===tag):[];
     const confirmed=Array.isArray(finalCargo)&&
      !finalCargo.some(x=>x?.cargoID===stock.cargoID)&&
      finalJournal?.version===1&&
      receipt?.state==="NPC_STOCK_DELIVERED"&&
      receipt.nativeItemID===result.nativeStockItemID&&
      receipt.stationID===station.itemID&&
      receipt.entityID===a.entityID&&
      receipt.corporationID===ship.corporationID&&
      matches.length===1&&
      matches[0].itemID===result.nativeStockItemID&&
      matches[0].ownerID===ship.corporationID&&
      matches[0].locationID===station.itemID&&
      matches[0].flagID===4&&
      matches[0].typeID===stock.typeID&&
      matches[0].quantity===stock.quantity&&
      matches[0].stacksize===stock.quantity&&
      matches[0].singleton===0;
     deliveries.push({...result,
      status:confirmed?"ALIFE_SALVAGE_RIVAL_STOCK_CONFIRMED":
       "ALIFE_SALVAGE_RIVAL_COMMITTED_NEEDS_RECONCILIATION",
      pilotID:a.pilotID,entityID:a.entityID,
      stationID:station.itemID,corporationID:ship.corporationID});
     cooldown.set(lease,now+60000);
    }
   }catch{cooldown.set(lease,now+60000)}
  }
  if(cooldown.size>512)for(const [k,t] of cooldown)
   if(now>t+3600000)cooldown.delete(k);
  return {status:"READY",orders,deliveries};
 }
 return {tick};
}
module.exports={createNpcSalvageDelivery};
