"use strict";
// Stage J: one SQLite COMMIT consumes a real NPC wreck item and creates a
// provenance-tagged *unique* native player cargo stack. Never call stock
// grantItemToCharacterLocation before removing the source.
const pos=n=>Number.isSafeInteger(n)&&n>0;
const isObject=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const fail=m=>{throw Error("COOP_RESCUE_"+m)};
const clone=x=>JSON.parse(JSON.stringify(x));
const token=(wreckID,wreckItemID,cargoID)=>
 "coop-rescue:v1:wreck:"+wreckID+":item:"+wreckItemID+":cargo:"+cargoID;
function createNativeRescueTransfer({atomicRows,readWreck,getMetadata,
 refreshWreck,clock=()=>Date.now()}={}){
 if([atomicRows,readWreck,getMetadata,refreshWreck,clock].some(x=>typeof x!=="function"))
  throw Error("RESCUE_NATIVE_ATOMIC_AUTHORITIES_REQUIRED");
 function transfer({characterID,wreckID,wreckItemID,destinationLocationID,
  destinationFlagID,quantity=null}={}){
  if(process.env.EVEJS_COOP_RESCUE_ATOMIC!=="1"||
   process.env.EVEJS_COOP_RESCUE_PROVENANCE!=="1")
   return {success:false,errorMsg:"COOP_RESCUE_ATOMIC_DISABLED"};
  if(![characterID,wreckID,wreckItemID,destinationLocationID].every(pos)||
   destinationFlagID!==5||(quantity!==null&&
    (!pos(quantity)||quantity>2147483647)))
   return {success:false,errorMsg:"COOP_RESCUE_DESTINATION_INVALID"};
  const wreck=readWreck(wreckID);
  if(!wreck||wreck.wreckID!==wreckID||!pos(wreck.sourceEntityID)||
   !pos(wreck.systemID)||wreck.transient===true)
   return {success:false,errorMsg:"COOP_RESCUE_WRECK_UNVERIFIED"};
  let result;
  try{
   result=atomicRows(["npcWreckItems","npcCargo","items","identityState","characters"],tx=>{
    const chr=tx.get("characters",String(characterID));
    if(!isObject(chr))fail("CHARACTER_NOT_FOUND");
    const dest=tx.get("items",String(destinationLocationID));
    // Only cargo on the authenticated character's actual owned ship.
    // Corporate hangars, drones, MTUs and arbitrary stations are excluded.
    if(!isObject(dest)||dest.itemID!==destinationLocationID||
     dest.ownerID!==characterID||dest.categoryID!==6)
     fail("PLAYER_SHIP_CARGO_REQUIRED");
    const root=tx.get("npcWreckItems","items");
    if(!isObject(root))fail("WRECK_ITEMS_UNAVAILABLE");
    const item=root[String(wreckItemID)];
    if(!isObject(item)||item.wreckItemID!==wreckItemID||
     item.wreckID!==wreckID||item.sourceKind!=="cargo"||
     !pos(item.sourceCargoID)||!pos(item.sourceOriginalQuantity)||
     !pos(item.typeID)||
     !pos(item.quantity)||item.singleton===true||
     !Number.isSafeInteger(item.quantity)||item.transient===true)
     fail("ORIGINAL_CARGO_NOT_VERIFIED");
    const originalCargo=tx.get("npcCargo","cargo");
    if(!isObject(originalCargo)||originalCargo[String(item.sourceCargoID)])
     fail("ORIGINAL_HAULER_CARGO_STILL_EXISTS");
    const amount=quantity===null?item.quantity:quantity;
    if(!pos(amount)||amount>item.quantity||amount>2147483647)
     fail("QUANTITY_INVALID");
    const meta=getMetadata(item.typeID,item.itemName);
    if(meta?.typeID!==item.typeID||!Number.isFinite(meta.volume)||
     meta.volume<0||!pos(item.sourceCargoID))
     fail("NATIVE_ITEM_METADATA_UNVERIFIED");
    const id=tx.get("identityState","nextItemID");
    if(!pos(id)||!pos(id+1)||tx.get("items",String(id)))
     fail("GLOBAL_ITEM_ID_NOT_AVAILABLE");
    const priorSame=tx.scan("items").filter(x=>
      x.value?.customInfo===token(wreckID,wreckItemID,item.sourceCargoID));
    const credited=priorSame.reduce((n,x)=>n+(pos(x.value?.quantity)?
      x.value.quantity:0),0);
    // Full and PARTIAL salvage are both supported, with immutable source
    // conservation. Any unaccounted cargo or restored source blocks.
    if(credited+item.quantity!==item.sourceOriginalQuantity)
     fail("SOURCE_QUANTITY_CONSERVATION_FAILED");
    // Keep client-compatible unique item schema and source marker.
    const granted={itemID:id,ownerID:characterID,
     locationID:destinationLocationID,flagID:5,
     typeID:item.typeID,groupID:meta.groupID||0,
     categoryID:meta.categoryID||0,itemName:meta.name||item.itemName||"Cargo",
     quantity:amount,stacksize:amount,singleton:0,
     customInfo:token(wreckID,wreckItemID,item.sourceCargoID),
     mass:Number(meta.mass)||0,volume:meta.volume,
     capacity:Number(meta.capacity)||0,radius:Number(meta.radius)||0};
    const remaining=item.quantity-amount;
    const next=clone(root);
    if(remaining===0)delete next[String(wreckItemID)];
    else next[String(wreckItemID)]={...item,quantity:remaining};
    tx.put("npcWreckItems","items",next);
    tx.put("identityState","nextItemID",id+1);
    tx.put("items",String(id),granted);
    return {item:granted,source:clone(item),remaining,amount};
   });
  }catch(error){return {success:false,
    errorMsg:error?.message?.startsWith("COOP_RESCUE_")?error.message:
    "COOP_RESCUE_NATIVE_TRANSACTION_UNCERTAIN_REPAIR_REQUIRED"}}
  if(!result?.item||!pos(result.item.itemID))
   return {success:false,errorMsg:"COOP_RESCUE_NATIVE_COMMIT_UNVERIFIED"};
  let refreshed=false;
  try{const r=refreshWreck(wreck.systemID,wreckID);
   refreshed=r===true||r?.success===true}catch{}
  // A post-COMMIT display error must NEVER cause retry/duplicate credit.
  return {success:true,data:{quantity:result.amount,
   itemID:result.item.itemID,sourceCargoID:result.source.sourceCargoID,
   sourceWreckItemID:wreckItemID,committed:true,displayRefreshPending:!refreshed,
   changes:[{removed:result.remaining===0,
    previousData:{itemID:wreckItemID,locationID:wreckID,
     typeID:result.source.typeID,quantity:result.source.quantity},
    item:result.remaining?{itemID:wreckItemID,
     quantity:result.remaining,typeID:result.source.typeID,
     locationID:wreckID}:null},
    {removed:false,item:result.item}]}};
 }
 return {transfer};
}
let singleton;
function transfer(options){
 if(process.env.EVEJS_COOP_RESCUE_ATOMIC!=="1")
  return {success:false,errorMsg:"COOP_RESCUE_ATOMIC_DISABLED"};
 try{
  if(!singleton){
   const store=require("../gameStore"),npc=require("./npc/nativeNpcStore");
   const nativeService=require("./npc/nativeNpcWreckService");
   const items=require("../services/inventory/itemStore");
   singleton=createNativeRescueTransfer({
    atomicRows:(tables,fn)=>store.coopAtomicNativeRows.transact(tables,fn),
    readWreck:npc.getNativeWreck,
    getMetadata:items.getItemMetadata,
    refreshWreck:nativeService.refreshNativeWreckRuntimeEntity
   });
  }
  return singleton.transfer(options);
 }catch{return {success:false,errorMsg:"COOP_RESCUE_NATIVE_PROVIDER_UNAVAILABLE"}}
}
module.exports={createNativeRescueTransfer,transfer,token};
