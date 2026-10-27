"use strict";
// CH24+31 C2: native-only READ authorizations for original corporation office
// and warehouse title reconciliation. There is NO sell-order or price writer.
// Source proof and wallet authority always reside in stock EveJS.
function loadModule(name){
 try{return require("./"+name)}
 catch(error){
  if(error?.code!=="MODULE_NOT_FOUND"||
   !String(error.message).includes("Cannot find module './"+name+"'"))throw error;
  return require("./"+name+".cjs");
 }
}
const {createPlayerMiningOreAudit}=loadModule("coopPlayerMiningOreTitle");
const pos=x=>Number.isSafeInteger(x)&&x>0;
const division=x=>Number.isSafeInteger(x)&&x>=115&&x<=121;
const sameOffice=(o,corpID,stationID,folderID)=>
 o&&o.impounded===false&&o.corporationID===corpID&&
 o.stationID===stationID&&o.officeFolderID===folderID&&
 pos(o.officeID)&&pos(o.officeFolderID);
function createNativeMiningOreBindings({gameStore,corporationState,
 corporationRuntime,itemStore,getDockedStation,
 getWarehouseReceipt=null,getHaulerCargo=null,access=null,priceQuote=null}={}){
 if(!gameStore||typeof gameStore.read!=="function"||
  !corporationState||typeof corporationState.getCorporationRecord!=="function"||
  typeof corporationState.isNpcCorporationID!=="function"||
  !corporationRuntime||typeof corporationRuntime.getCorporationOffices!=="function"||
  !itemStore||typeof itemStore.findItemById!=="function"||
  typeof itemStore.findWarehouseItem!=="function"||
  typeof getDockedStation!=="function"||
  (getWarehouseReceipt!==null&&typeof getWarehouseReceipt!=="function")||
  (getHaulerCargo!==null&&typeof getHaulerCargo!=="function")||
  (priceQuote!==null&&typeof priceQuote!=="function"))
  throw Error("MINING_ORE_TRUSTED_NATIVE_READERS_REQUIRED");
 function row(table,path){
  const r=gameStore.read(table,path);
  if(r?.success===true&&r.data!=null)return r.data;
  if(r?.errorMsg==="ENTRY_NOT_FOUND")return null;
  throw Error("MINING_ORE_ORIGINAL_GAMESTORE_READ_UNAVAILABLE");
 }
 function npc(corpID){
  if(!pos(corpID))return false;
  const record=corporationState.getCorporationRecord(corpID);
  return record?.corporationID===corpID&&record.isNPC===true&&
   corporationState.isNpcCorporationID(corpID)===true;
 }
 function player(corpID){
  if(!pos(corpID))return false;
  const record=corporationState.getCorporationRecord(corpID);
  return record?.corporationID===corpID&&record.isNPC===false&&
   !corporationState.isNpcCorporationID(corpID);
 }
 function activeOffice({buyerCorpID,stationID,officeFolderID}={}){
  if(!player(buyerCorpID)||!pos(stationID)||!pos(officeFolderID))return false;
  const offices=corporationRuntime.getCorporationOffices(buyerCorpID);
  if(!Array.isArray(offices))return false;
  return offices.filter(x=>sameOffice(x,buyerCorpID,stationID,officeFolderID)).length===1;
 }
 function verifyOffice({buyerCorpID,stationID,officeFolderID,division:flag,session}={}){
  if(!division(flag)||!activeOffice({buyerCorpID,stationID,officeFolderID})||
     !session||session.socket?.destroyed===true)return false;
  if(getDockedStation(session)!==stationID)return false;
  // Our native player corporation auth revalidates session account, member
  // status and office roles; a client-provided corp ID is never sufficient.
  return access?.isMember?.(session,buyerCorpID)===true&&
   access.canView(session,buyerCorpID,stationID,flag)===true;
 }
 function verifyOfficeReceipt(record){
  return Boolean(record&&division(record.division)&&
   activeOffice({buyerCorpID:record.buyerCorpID,stationID:record.stationID,
    officeFolderID:record.officeFolderID}));
 }
 function readTitleReceipt(cargoID){
  if(!pos(cargoID))return null;
  return row("corporationRuntime","/coopPlayerMiningOreTitle/"+cargoID);
 }
 function readCorporation(corpID){
  if(!pos(corpID))return null;
  return row("corporationRuntime","/corporations/"+corpID);
 }
 function findByCargoID(cargoID){
  if(!pos(cargoID))return null;
  // Original itemStore enforces unique cargo marker, never shadow stock.
  return itemStore.findWarehouseItem({cargoID});
 }
 const audit=createPlayerMiningOreAudit({readTitleReceipt,readCorporation,
  findItemById:id=>pos(id)?itemStore.findItemById(id):null,
  findByCargoID,verifyOfficeReceipt});
 function quoteOre(input){
  // A source or orderbook snapshot alone is not an executable binding offer.
  // Until a trusted native pricing authority is explicitly connected this
  // adapter refuses all paid mutations.
  if(typeof priceQuote!=="function")return null;
  const result=priceQuote(input);
  if(!result||result.verifiedNative!==true||
   !Number.isSafeInteger(result.priceCents)||result.priceCents<=0||
   result.priceCents>100000000000)return null;
  return result;
 }
 function warehouseReceipt(cargoID){
  if(typeof getWarehouseReceipt!=="function"||!pos(cargoID))return null;
  const r=getWarehouseReceipt(cargoID);
  if(r?.version!==1||r?.cargoID!==cargoID||r?.phase!=="COMMITTED"||
   !pos(r.haulerID)||!pos(r.itemID)||!pos(r.quantity)||
   typeof getHaulerCargo!=="function")return null;
  // An fsynced COMMITTED receipt must agree with the CURRENT original
  // nativeNpcStore. No source cargoID may survive the warehouse debit.
  const original=getHaulerCargo(r.haulerID);
  if(!Array.isArray(original)||original.some(c=>c?.cargoID===cargoID))
   return null;
  return r;
 }
 return Object.freeze({
  verifyNpcCorporation:(corpID)=>npc(corpID),
  verifyOffice,verifyOfficeReceipt,readTitleReceipt,readCorporation,
  getWarehouseReceipt:warehouseReceipt,quoteOre,
  verifyTransferredTitle:record=>audit.transferred(record),
  // This is a safe READ binding. The mutation adapter must still receive
  // an authenticated session, native GameStore writer, and explicit flag.
  mode:"ORIGINAL_GAMESTORE_READ_ONLY",
  supportsLiveTransfer:false
 });
}
// Called only by the existing native station-arrival singleton, with no
// player session, order, transaction or ship movement. This is a pure audit.
function createRuntimeTitleVerifier(){
 if(process.env.EVEJS_COOP_PLAYER_NPC_MINING_ORE_TITLE!=="1")return null;
 const gameStore=require("../gameStore"),
  corporationState=require("../services/corporation/corporationState"),
  corporationRuntime=require("../services/corporation/corporationRuntimeState"),
  itemStore=require("../services/inventory/itemStore"),
  location=require("../services/structure/structureLocation");
 const bindings=createNativeMiningOreBindings({gameStore,corporationState,
  corporationRuntime,itemStore,
  getDockedStation:location.getDockedLocationID});
 return record=>bindings.verifyTransferredTitle(record);
}
// Trusted server composition seam. No public RPC is exposed here. Callers
// MUST provide the original fsynced warehouse instance and a native seller
// price authority. An unbound price source cannot create a paid order.
function createTrustedTitleService({gameStore,corporationState,
 corporationRuntime,itemStore,getDockedStation,warehouse,nativeNpcStore,access,
 priceQuote,env=process.env}={}){
 if(!warehouse||typeof warehouse.getReceipt!=="function"||
  typeof nativeNpcStore?.listNativeCargoForEntity!=="function"||
  typeof priceQuote!=="function"||!access||
  ["isMember","canIndustry","canWallet","canView"].some(k=>typeof access[k]!=="function"))
  throw Error("MINING_ORE_TRUSTED_SELLER_AND_WAREHOUSE_REQUIRED");
 const bindings=createNativeMiningOreBindings({gameStore,corporationState,
  corporationRuntime,itemStore,getDockedStation,access,priceQuote,
  getWarehouseReceipt:id=>warehouse.getReceipt(id),
  getHaulerCargo:id=>nativeNpcStore.listNativeCargoForEntity(id)});
 const {createPlayerMiningOreTitle}=loadModule("coopPlayerMiningOreTitle");
 return createPlayerMiningOreTitle({gameStore,access,
  verifyNpcCorporation:(id,row)=>bindings.verifyNpcCorporation(id)&&
   (!row||row.corporationID===id),
  getWarehouseReceipt:bindings.getWarehouseReceipt,
  verifyOffice:bindings.verifyOffice,quoteOre:bindings.quoteOre,
  enabled:()=>env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
   env.EVEJS_COOP_PLAYER_NPC_MINING_ORE_TITLE==="1"});
}
module.exports={createNativeMiningOreBindings,createRuntimeTitleVerifier,
 createTrustedTitleService,sameOffice};
