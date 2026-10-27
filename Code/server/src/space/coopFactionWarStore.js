"use strict";
// FW-001: one atomic GameStore record; external proofs must be supplied by
// trusted server adapters. No public chat or client payload bypasses proof.
// The overlay deploys .cjs sources as .js; source-level tests load .cjs.
const fs=require("node:fs"),path=require("node:path");
const core=require("./coopFactionWarCore"+(fs.existsSync(path.join(__dirname,"coopFactionWarCore.js"))?".js":".cjs"));
const TABLE="corporationRuntime", KEY="coop-faction-war\u001fstate-v1";
function createFactionWarStore({gameStore,proofs,clock=()=>Date.now()}={}){
 if(typeof gameStore?.coopAtomicNativeRows?.transact!=="function"||!proofs||typeof proofs!=="object"||
  typeof clock!=="function")throw Error("FW_NATIVE_AUTHORITIES_REQUIRED");
 let busy=false;
 function execute(command){
  if(process.env.EVEJS_COOP_FACTION_WAR!=="1"||
   process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1")return {status:"DISABLED"};
  if(busy)return {status:"BLOCKED",reason:"FW_REENTRANT_MUTATION"};
  busy=true;
  try{
   return gameStore.coopAtomicNativeRows.transact([TABLE],tx=>{
    const before=tx.get(TABLE,KEY)||core.empty();
    const outcome=core.transition(before,command,{now:clock(),proofs});
    if(outcome.status!=="APPLIED")return {status:outcome.status,
     ...(outcome.reason?{reason:outcome.reason}:{}),
     ...(outcome.receipt?{receipt:outcome.receipt}:{})};
    tx.put(TABLE,KEY,outcome.state);
    return {status:"APPLIED",receipt:outcome.receipt};
   });
  }finally{busy=false;}
 }
 function snapshot(){
  // Read through the same transactional keyspace as execute. The ordinary
  // JSON-path read API can have different nesting/flush semantics.
  return gameStore.coopAtomicNativeRows.transact([TABLE],tx=>{
   const current=tx.get(TABLE,KEY)||core.empty();
   core.validateState(current);return structuredClone(current);
  });
 }
 return {execute,snapshot};
}
module.exports={TABLE,KEY,createFactionWarStore};
