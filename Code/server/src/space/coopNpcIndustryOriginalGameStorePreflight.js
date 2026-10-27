"use strict";
// LW-04C2: source-only preflight using the ALREADY CLAIMED original GameStore
// single SQLite writer. Actual quiescence/PRAGMA FULL/cache invalidation
// must still be enforced INSIDE coopGameStoreAtomic.transact on every write.
// A preflight is neither an exclusive lease nor permission for live A-Life.
const POS=x=>Number.isSafeInteger(x)&&x>0;
function createOriginalGameStorePreflight({
 gameStore,itemStore,env=process.env,clock=()=>Date.now()
}={}){
 if(typeof gameStore?.read!=="function"||
    gameStore?.coopAtomicNativeRows?.mode!=="SERVER_INTERNAL_FLAGGED"||
    typeof gameStore?.coopAtomicNativeRows?.transact!=="function"||
    typeof gameStore?.coopAtomicNativeRows?.isPoisoned!=="function"||
    typeof itemStore?.findItemById!=="function"||
    typeof clock!=="function")
  throw Error("LW04C2_GAMESTORE_SINGLE_NATIVE_WRITER_REQUIRED");
 function assertOriginalGameStore({ownerID,stationID,operationID,stage,now}={}){
  if(!POS(ownerID)||!POS(stationID)||typeof operationID!=="string"||
     !/^npc-manufacture:[0-9a-f]{32}$/.test(operationID)||
     !Number.isSafeInteger(now)||now<0)
   return {status:"BLOCKED",reason:"LW04C2_NATIVE_PREFLIGHT_SCOPE_INVALID"};
  if(env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1"||
     env.EVEJS_COOP_NATIVE_NPC_TX_PROOF!=="1"||
     env.EVEJS_COOP_NATIVE_NPC_MANUAL_FACTORY_PROOF!=="1"||
     env.EVEJS_COOP_ALIFE_ECONOMY_ACT==="1")
   return {status:"BLOCKED",reason:"LW04C2_ORIGINAL_MANUAL_FLAGS_DISABLED"};
  if(gameStore.coopAtomicNativeRows.isPoisoned())
   return {status:"BLOCKED",reason:"LW04C2_ORIGINAL_GAMESTORE_POISONED"};
  const jobs=gameStore.read("industryJobs","/jobs");
  const corp=gameStore.read("corporationRuntime","/corporations/"+ownerID);
  if(jobs?.success!==true||!jobs.data||typeof jobs.data!=="object"||
     corp?.success!==true||corp.data?.corporationID!==ownerID||
     !corp.data.wallet?.divisions?.["1000"]||
     !Number.isFinite(corp.data.wallet.divisions["1000"].balance))
   return {status:"BLOCKED",reason:"LW04C2_ORIGINAL_GAMESTORE_ROWS_UNAVAILABLE"};
  if(gameStore.coopAtomicNativeRows.isPoisoned())
   return {status:"BLOCKED",reason:"LW04C2_ORIGINAL_GAMESTORE_POISONED"};
  return {status:"READY",singleWriter:true,originalGameStore:true,
   unpoisoned:true,nativeMutation:false,
   proof:"ORIGINAL_GAMESTORE_OWNER_PREFLIGHT_NOT_AN_ATOMIC_LEASE"};
 }
 return Object.freeze({assertOriginalGameStore,
  mode:"ORIGINAL_NATIVE_SINGLE_WRITER_PREFLIGHT",
  supportsLiveRuntime:false});
}
module.exports={createOriginalGameStorePreflight};
