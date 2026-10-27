"use strict";
// LW-04C: enforced preflight wrapper for a FUTURE reviewed live native director.
// Owns no journal, no timer, no SQLite/Rust writer and no independent wallet.
// The original director is always the only executor under its native lock.
const {createIndustryRecoveryFence}=require("./coopNpcIndustryRecoveryFence"+
 (typeof __filename==="string"&&__filename.endsWith(".js")?"":".cjs"));
function createAuditedLiveFactoryDirector({director,native,market,clock,maxEntries}={}){
 if(director?.mode!=="NATIVE_AUTHORITIES_ONLY"||
    director?.supportsLiveRuntime!==true||
    typeof director.tick!=="function"||typeof director.inspect!=="function")
  throw Error("LIVE_FACTORY_ORIGINAL_DIRECTOR_NOT_ATTESTED");
 const fence=createIndustryRecoveryFence({
  director,native,market,clock,maxEntries
 });
 function tick({ownerID,stationID,productTypeIDs=[]}={}){
  // A previous audit result is not reusable: another original NPC could
  // have written a job/receipt before this specific native tick.
  const proof=fence.audit({ownerID,stationID});
  if(proof.status!=="READY")return {
   status:"BLOCKED",reason:"LIVE_FACTORY_RECOVERY_FENCE_NOT_READY",
   detail:proof.reason,operationID:proof.operationID||null,
   nativeMutation:false
  };
  return director.tick({ownerID,stationID,productTypeIDs});
 }
 return Object.freeze({
  tick,inspect:()=>director.inspect(),
  auditBeforeTick:scope=>fence.audit(scope),
  mode:"NATIVE_AUTHORITIES_ONLY",supportsLiveRuntime:true,
  recoveryMode:"READ_ONLY_AUDIT_BEFORE_EACH_NATIVE_TICK"
 });
}
module.exports={createAuditedLiveFactoryDirector};
