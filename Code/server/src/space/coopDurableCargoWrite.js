"use strict";
// One owner for the dangerous sequence that makes a native cargo row survive a
// process restart: write it as an ordinary row, clear the transient marker on
// its exact path, then fsync the table. Callers decide what a failure means;
// this module never moves inventory, never grants stock and never touches ISK.
//
// Why a helper: the same three steps were duplicated in the strict and the
// normal miner->hauler transfer, and an interrupted copy is exactly how ore
// used to disappear across a restart.
const positive=v=>{const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:0;};
const TABLE="npcCargo";
const PATH_PREFIX="/cargo/";
function promote({store,database,cargoID,row}={}){
 let deps={store,database};
 if(!deps.store){
  try{deps.store=require("./npc/nativeNpcStore")}
  catch(_error){return {status:"STORE_UNAVAILABLE"}}
 }
 if(!deps.database){
  try{deps.database=require("../gameStore")}
  catch(_error){return {status:"DATABASE_UNAVAILABLE"}}
 }
 const id=positive(cargoID||row?.cargoID);
 if(!id)return {status:"INVALID_CARGO_ID"};
 if(!row||typeof row!=="object")return {status:"INVALID_ROW"};
 let ack;
 try{ack=deps.store.upsertNativeCargo({...row,cargoID:id},{transient:true})}
 catch(error){return {status:"UPSERT_UNCERTAIN",detail:String(error?.message||error).slice(0,120)}}
 // An unsuccessful ACK does not establish that nothing was written.
 if(ack?.success!==true)
  return {status:"UPSERT_REJECTED",detail:String(ack?.errorMsg||"NONE")};
 try{
  deps.database.setTransientPath(TABLE,PATH_PREFIX+id,false);
  const flushed=deps.database.flushTableSync(TABLE);
  if(flushed?.success!==true)
   return {status:"FLUSH_FAILED",detail:String(flushed?.errorMsg||"NONE")};
 }catch(error){
  return {status:"FLUSH_FAILED",detail:String(error?.message||error).slice(0,120)};
 }
 return {status:"DURABLE",cargoID:id};
}
module.exports={promote};
