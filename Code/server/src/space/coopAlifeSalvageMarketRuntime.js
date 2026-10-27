"use strict";
// No timer: called by coopVirtualWorldRuntime's existing 30-second A-Life loop.
// The only sale writer remains coopSalvageNpcPendingMarket + native Rust.
// Real witness files and GameStore are read without seeding records.
const fs=require("node:fs"),path=require("node:path");
// Source .cjs modules become .js siblings in the deployed EveJS overlay.
const siblingSuffix=typeof __filename==="string"&&__filename.endsWith(".js")?"":".cjs";
const {createAlifeSalvageMarket}=require("./coopAlifeSalvageMarket"+siblingSuffix);
let instance=null,busy=false;
function createBindings({gameStore,itemStore,marketClient,worldData,
 getEscrow,root,systems}={}){
 if(!gameStore?.coopAtomicNativeRows||
  [itemStore?.findItemById,marketClient?.call,worldData?.getStationByID,
   getEscrow,systems].some(x=>typeof x!=="function")||
  typeof root!=="string"||!path.isAbsolute(root))
  throw Error("SALVAGE_MARKET_RUNTIME_NATIVE_DEPENDENCIES_REQUIRED");
 const atomic=gameStore.coopAtomicNativeRows;
 if(atomic.mode!=="SERVER_INTERNAL_FLAGGED"||atomic.isPoisoned?.()!==false)
  throw Error("SALVAGE_MARKET_GAMESTORE_NOT_AUTHORITATIVE");
 const read=(table,key,allowEmpty=false)=>{
  const response=gameStore.read(table,"/"+key);
  if(allowEmpty&&response?.errorMsg==="ENTRY_NOT_FOUND")return null;
  if(!response?.success)throw Error("SALVAGE_MARKET_NATIVE_READ_FAILED:"+table);
  return response.data;
 };
 const readJournal=()=>read("corporationRuntime","coopSalvageRivalMoves",true)||
  {version:1,moves:{}};
 const readOps=()=>read("corporationRuntime","coopSalvageMarketOps",true)||
  {version:1,bySource:{}};
 const readCorp=id=>read("corporationRuntime","corporations/"+id);
 const readWitness=key=>{
  if(!/^\d+-\d+-\d+$/.test(String(key)))return {status:"INVALID"};
  let raw;
  try{raw=fs.readFileSync(path.join(root,"salvage-provenance",key+".json"),"utf8")}
  catch{return {status:"UNAVAILABLE"}}
  if(typeof raw!=="string"||raw.length>131072||!raw.endsWith("\n"))
   return {status:"CORRUPT"};
  let record;try{record=JSON.parse(raw)}catch{return {status:"CORRUPT"}}
  if(record?.v!==1||record.manifestKey!==key||
   !Array.isArray(record.rows)||record.rows.length<1||record.rows.length>1000)
   return {status:"CORRUPT"};
  return {status:"READY",record};
 };
 const isNpcCorporation=id=>{
  const corp=read("corporations","records/"+id);
  const runtime=readCorp(id);
  return corp?.corporationID===id&&corp.isNPC===true&&
   runtime?.corporationID===id;
 };
 const verifyStation=(id,owner)=>{
  const s=worldData.getStationByID(id);
  return s?.stationID===id&&Number.isSafeInteger(s.solarSystemID)&&
   s.solarSystemID>0&&isNpcCorporation(owner);
 };
 const marketFactory=priceCents=>
  require("./coopSalvageNpcPendingMarket"+siblingSuffix).createSalvagePendingMarket({
   atomic,call:(method,params)=>marketClient.call(method,params),
   getItem:id=>itemStore.findItemById(id),
   getEscrow:id=>getEscrow(id)||null,
   readJournal,readOps,readWitness,readCorp,
   readFill:id=>read("npcMarketFills",
    "order"+String.fromCharCode(31)+id,true),
   isNpcCorporation,verifyStation,resolvePriceCents:()=>priceCents
  });
 return {readJournal,readOps,marketFactory,
  getStation:id=>worldData.getStationByID(id),
  getOrders:params=>marketClient.call("GetOrders",params),systems};
}
async function advance({systems,root=null,deps=null}={}){
 if(process.env.EVEJS_COOP_ALIFE_SALVAGE_MARKET!=="1"||
    process.env.EVEJS_COOP_SALVAGE_NATIVE_MARKET!=="1")return {status:"DISABLED"};
 if(busy)return {status:"BUSY"};
 busy=true;
 try{
  if(!instance){
   const native=deps||{
    gameStore:require("../gameStore"),
    itemStore:require("../services/inventory/itemStore"),
    marketClient:require("../services/market/marketDaemonClient").marketDaemonClient,
    worldData:require("./worldData"),
    getEscrow:require("../services/market/marketEscrowState").getEscrowRecord
   };
   instance=createAlifeSalvageMarket(createBindings({
    ...native,systems,
    root:root||process.env.EVEJS_COOP_NPC_WAREHOUSE_DIR||
     "/var/lib/evejs/coop-native-warehouse"
   }));
  }
  return await instance.tick();
 }finally{busy=false}
}
module.exports={createBindings,advance};
