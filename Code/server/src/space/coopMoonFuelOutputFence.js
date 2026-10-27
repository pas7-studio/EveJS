"use strict";
// Native Metenox hourly fuel and online fuel are charged by upstream before
// any native output grant. No atomic material settlement exists in the pin.
// This fail-closed gate is opt-in. Do not silently burn fuel for a fictional yield.
const CODE="MOON_NATIVE_INVENTORY_OUTPUT_SETTLEMENT_UNAVAILABLE";
function denyOnline() { return {success:false,errorMsg:CODE,fuelResult:null}; }
function denyFuelCycle(structure,profile,nowMs,offlineAutoMoonService) {
  if (typeof offlineAutoMoonService !== "function") throw Error("MOON_NATIVE_OFFLINE_API_UNAVAILABLE");
  return offlineAutoMoonService(structure,profile,nowMs,{
    starved:false,nativeOutputSettlementBlocked:true,lastFailedAt:nowMs
  });
}
module.exports={CODE,denyOnline,denyFuelCycle};
