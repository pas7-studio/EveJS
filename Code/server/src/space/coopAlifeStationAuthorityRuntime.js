"use strict";
// COOP-043 pinned EveJS production read adapter. Explicit opt-in, never writes.
// Rust GetOrders is authoritative; never substitute seed, virtual market or cash.
const {createStationAuthority}=require("./coopAlifeStationAuthority");
function parseTargets(json){
 if(typeof json!=="string"||json.length>1500)throw Error("ALIFE_ECONOMY_PRODUCTS_INVALID");
 let values;try{values=JSON.parse(json)}catch{throw Error("ALIFE_ECONOMY_PRODUCTS_INVALID")}
 if(!Array.isArray(values)||values.length<1||values.length>8)
  throw Error("ALIFE_ECONOMY_PRODUCTS_INVALID");
 const ids=new Set();
 return values.map(p=>{
  if(!Number.isSafeInteger(p?.typeID)||p.typeID<=0||
     !Number.isSafeInteger(p?.targetStock)||p.targetStock<0||
     p.targetStock>50000||ids.has(p.typeID))throw Error("ALIFE_ECONOMY_PRODUCTS_INVALID");
  ids.add(p.typeID);return{typeID:p.typeID,targetStock:p.targetStock};
 });
}
function createRuntimeStationAuthority({products,clock=()=>Date.now(),deps,rpcTimeoutMs=5000}={}){
 if(!Array.isArray(products)||!deps||!Number.isSafeInteger(rpcTimeoutMs)||
    rpcTimeoutMs<1000||rpcTimeoutMs>15000)throw Error("NATIVE_ALIFE_RUNTIME_AUTHORITY_REQUIRED");
 const {
  worldData,itemStore,industryStatic,industryParity,gameStore,marketClient
 }=deps;
 if(!worldData?.getStationByID||!itemStore?.listOwnedItems||
  !itemStore?.findItemById||!itemStore?.getItemMutationVersion||
  !industryStatic?.getFacilityPayloadByID||
  !industryStatic?.getBlueprintDefinitionByProductTypeID||
  !industryParity?.buildIndustryActivityMaterials||
  typeof gameStore?.read!=="function"||typeof marketClient?.call!=="function")
  throw Error("NATIVE_ALIFE_RUNTIME_READER_DEPENDENCIES");
 const read=(table,path)=>{const r=gameStore.read(table,path);
  if(r?.success!==true||r.data==null)throw Error("NATIVE_ALIFE_READ_FAILED:"+table+":"+path);
  return r.data};
 return createStationAuthority({
  products,clock,
  // Direct GameStore reads, NOT getCorporationRecord/getCorporationRuntime:
  // those upstream getters may initialize and persist defaults on a read.
  getCorporation:id=>read("corporations","/records/"+id),
  getCorporationRuntime:id=>read("corporationRuntime","/corporations/"+id),
  getStation:id=>worldData.getStationByID(id),
  getFacility:id=>industryStatic.getFacilityPayloadByID(id),
  listOwnedItems:id=>itemStore.listOwnedItems(id),
  listJobs:id=>Object.values(read("industryJobs","/jobs")),
  listEscrow:()=>Object.values(read("marketEscrow","/")),
  getEscrowItem:id=>itemStore.findItemById(id),
  getDefinition:id=>industryStatic.getBlueprintDefinitionByProductTypeID(id),
  // The stock getBlueprintState creates a new BPO state if absent.
  // Economic perception must never seed/modify a blueprint.
  getBlueprintState:id=>read("industryBlueprintState","/records/"+id),
  getMaterials:(def,activity,runs,params)=>
   industryParity.buildIndustryActivityMaterials(def,activity,runs,params),
  getOrders:(regionID,typeID)=>{
   let timeout;
   return Promise.race([
    Promise.resolve().then(()=>marketClient.call("GetOrders",{region_id:regionID,type_id:typeID})),
    new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error("NATIVE_RUST_ORDERBOOK_TIMEOUT")),rpcTimeoutMs);})
   ]).finally(()=>clearTimeout(timeout));
  },
  getItemVersion:()=>itemStore.getItemMutationVersion()
 });
}
module.exports={parseTargets,createRuntimeStationAuthority};
