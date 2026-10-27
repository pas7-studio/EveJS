"use strict";
// Internal only. No network endpoint, session impersonation or NPC background tick.
const path=require("node:path");
// In checkout the sibling is .cjs; the EveJS overlay installs it as .js.
// Fall back only when the sibling itself is absent. Never hide a transitive
// MODULE_NOT_FOUND in the real refinery implementation.
function nativeRefineryModule(){
 try{return require("./coopNpcRefinery")}
 catch(error){
  if(error?.code!=="MODULE_NOT_FOUND"||
     !String(error.message).includes("Cannot find module './coopNpcRefinery'"))
   throw error;
  return require("./coopNpcRefinery");
 }
}
const {createRefinery}=nativeRefineryModule();
function createLiveRefinery({root=process.env.EVEJS_COOP_NPC_REFINERY_DIR}={}){
 if(process.env.EVEJS_COOP_NPC_REFINERY!=="1")throw Error("NPC_REFINERY_DISABLED");
 if(!root||!path.isAbsolute(root))throw Error("NPC_REFINERY_DIRECTORY_REQUIRED");
 const items=require("../services/inventory/itemStore");
 if(typeof items.refineNpcWarehouseOreAtomic!=="function")throw Error("NATIVE_REFINERY_ITEM_HOOK_MISSING");
 const reprocessing=require("../services/reprocessing/reprocessingRuntime");
 const world=require("./worldData");
 const corp=require("../services/corporation/corporationState");
 const facilities=require("../services/_shared/stationStaticData");
 return createRefinery({directory:root,items,reprocessing,
  getStation:stationID=>world.getStationByID(stationID),
  getCorporation:corporationID=>corp.getCorporationRecord(corporationID),
  isNpcCorporation:corporationID=>corp.isNpcCorporationID(corporationID),
  facilityAvailable:station=>{
   const actual=world.getStationByID(station?.stationID);
   if(!actual||Number(actual.solarSystemID)!==Number(station.solarSystemID))return false;
   // Same authoritative station service availability used by the client.
   const record=facilities.getStationRecord(null,station.stationID);
   return Number(record?.stationID)===Number(station.stationID)&&
     facilities.stationServiceIsEnabledForStationRecord(record,8192)===true;
  }});
}
module.exports={createLiveRefinery};