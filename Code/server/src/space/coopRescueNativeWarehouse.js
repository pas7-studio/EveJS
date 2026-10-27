"use strict";
// Stage J native rescued cargo: ownership MOVE, not item GRANT.
// The same itemID is transferred from a real docked player's cargo to the
// actual NPC corporation station inventory in one committed items-row write.
const pos=n=>Number.isSafeInteger(n)&&n>0;
const valid=(x)=>x&&typeof x==="object"&&!Array.isArray(x);
const marker=/^coop-rescue:v1:wreck:(\d+):item:(\d+):cargo:(\d+)$/;
function createRescueWarehouse({atomicRows,isNpcCorporation,readStation,
 readOriginalManifest,clock=()=>Date.now()}={}){
 if([atomicRows,isNpcCorporation,readStation,readOriginalManifest,clock]
   .some(x=>typeof x!=="function"))
  throw Error("RESCUE_WAREHOUSE_AUTHORITIES_REQUIRED");
 function deliver({session,manifestKey,stationID,corporationID,itemID}={}){
  if(process.env.EVEJS_COOP_RESCUE_WAREHOUSE!=="1"||
     process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1")
   return {status:"DISABLED"};
  const characterID=session?.characterID;
  if(![characterID,stationID,corporationID,itemID].every(pos)||
   typeof manifestKey!=="string"||!/^\d+-\d+-\d+$/.test(manifestKey)||
   session?.socket?.destroyed===true||
   Number(session.stationID||session.stationid)!==stationID||
   session?._space?.initialStateSent===true||
   !pos(session.shipid||session.shipID||session._space?.shipID))
   return {status:"RESCUE_NOT_DOCKED_AT_STATION"};
  let st,m;
  try{st=readStation(stationID);m=readOriginalManifest(manifestKey)}
  catch{return {status:"RESCUE_STATION_OR_MANIFEST_UNAVAILABLE"}}
  if(isNpcCorporation(corporationID)!==true||
   st?.stationID!==stationID||
   st?.corporationID!==corporationID||
   m?.status!=="READY"||m.record?.key!==manifestKey||
   m.record?.stationID!==stationID||
   m.record?.corporationID!==corporationID||
   !Array.isArray(m.record.cargo)||!m.record.cargo.length)
   return {status:"RESCUE_AUTHORITY_NOT_CONFIRMED"};
  const shipID=Number(session.shipid||session.shipID||session._space?.shipID);
  try{
   const result=atomicRows(["items","characters"],tx=>{
    const character=tx.get("characters",String(characterID));
    if(!valid(character)||character.characterID!==characterID)
     throw Error("RESCUE_CHARACTER_NOT_PERSISTED");
    if(pos(character.stationID)&&character.stationID!==stationID)
     throw Error("RESCUE_PERSISTED_STATION_MISMATCH");
    const ship=tx.get("items",String(shipID));
    if(!valid(ship)||ship.itemID!==shipID||ship.ownerID!==characterID||
     ship.categoryID!==6)
     throw Error("RESCUE_OWNED_SHIP_NOT_VERIFIED");
    const item=tx.get("items",String(itemID));
    const pieces=marker.exec(String(item?.customInfo||""));
    if(!valid(item)||item.itemID!==itemID||
     item.ownerID!==characterID||item.locationID!==shipID||
     item.flagID!==5||item.singleton!==0||
     !pos(item.typeID)||!pos(item.quantity)||!pieces)
     throw Error("RESCUE_PLAYER_CARGO_NOT_VERIFIED");
    const sourceCargoID=Number(pieces[3]);
    const original=m.record.cargo.filter(x=>
      x.cargoID===sourceCargoID&&x.typeID===item.typeID);
    if(original.length!==1||item.quantity>original[0].quantity)
     throw Error("RESCUE_ORIGINAL_MANIFEST_MISMATCH");
    // Separate audited PARTIAL pickups share one immutable original
    // cargo marker but have distinct native itemIDs and quantities.
    // Moving either item is idempotently secured by its current PLAYER
    // ownership and location, not by forbidding the second genuine stack.
    const delivered=tx.scan("items").filter(x=>
     x.key!==String(itemID)&&
     x.value?.ownerID===corporationID&&
     x.value?.customInfo===item.customInfo&&
     x.value?.locationID===stationID);
    const already=delivered.reduce((n,x)=>n+
     (pos(x.value?.quantity)?x.value.quantity:0),0);
    if(already+item.quantity>original[0].quantity)
     throw Error("RESCUE_WAREHOUSE_SOURCE_QUANTITY_OVERFLOW");
    const moved={...item,ownerID:corporationID,
     locationID:stationID,flagID:4};
    // Same immutable itemID and original source marker, never minting.
    tx.put("items",String(itemID),moved);
    return {status:"NATIVE_RESCUE_WAREHOUSE_COMMITTED",itemID,
     sourceCargoID,typeID:item.typeID,quantity:item.quantity,
     ownerID:corporationID,stationID};
   });
   return result?.status==="NATIVE_RESCUE_WAREHOUSE_COMMITTED"?
    result:{status:"RESCUE_WAREHOUSE_COMMIT_UNVERIFIED"};
  }catch{return {status:"RESCUE_WAREHOUSE_ATOMIC_UNCERTAIN_OR_REJECTED"}}
 }
 return {deliver};
}
let singleton;
function deliverInGame(session,args){
 if(process.env.EVEJS_COOP_RESCUE_WAREHOUSE!=="1")return {status:"DISABLED"};
 try{
  if(!singleton){
   const gameStore=require("../gameStore");
   const npc=require("./npc/nativeNpcStore");
   const manifest=require("./coopNativeHaulManifest").createManifest({
    root:process.env.EVEJS_COOP_NPC_WAREHOUSE_DIR||
      "/var/lib/evejs/coop-native-warehouse",
    store:npc,items:require("../services/inventory/itemStore"),
    getNativeEntity:npc.getNativeEntity});
   singleton=createRescueWarehouse({
    atomicRows:(tables,fn)=>gameStore.coopAtomicNativeRows.transact(tables,fn),
    isNpcCorporation:require("../services/corporation/corporationState").isNpcCorporationID,
    readStation:id=>require("./worldData").getStationByID(id),
    readOriginalManifest:id=>manifest.read(id)});
  }
  return singleton.deliver({session,...args});
 }catch{return {status:"RESCUE_WAREHOUSE_BACKEND_UNAVAILABLE"}}
}
module.exports={createRescueWarehouse,deliverInGame};
