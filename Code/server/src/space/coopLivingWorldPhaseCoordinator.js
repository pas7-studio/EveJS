"use strict";
/**
 * LW-03 phase control plane for the EXISTING 30-second Living World clock.
 *
 * Not a scheduler, game authority, inventory ledger, wallet or executor.
 * This only names and orders the phases already invoked by the world tick.
 * It intentionally does not await promises returned by native phases:
 * the original owner of a native async transaction remains responsible for
 * its own single-flight lock, journal and outcome reconciliation.
 */
const VALID_PHASE=/^[a-z][a-z0-9:-]{0,95}$/;
const loadRegistry=()=>{
 try{return require("./coopLivingWorldPhaseRegistry")}
 catch(error){
  // Installed overlay has .js siblings; source checkout has .cjs.
  if(error?.code!=="MODULE_NOT_FOUND"||
     !String(error.message).includes("Cannot find module './coopLivingWorldPhaseRegistry'"))
   throw error;
  return require("./coopLivingWorldPhaseRegistry");
 }
};
const {classifyPhase,catalog}=loadRegistry();
function createPhaseCoordinator({execute,clock=()=>Date.now(),onCycle=()=>{}}={}){
 if(typeof execute!=="function"||typeof clock!=="function"||
    typeof onCycle!=="function")
  throw Error("LIVING_WORLD_PHASE_COORDINATOR_DEPENDENCIES_REQUIRED");
 let active=false,sequence=0,last=null;
 function snapshot(){
  return {active,sequence,last:last?{
   ...last,phaseNames:last.phaseNames.slice(),
   groups:{...last.groups},unknownNames:last.unknownNames.slice()
  }:null};
 }
 function tick(run){
  if(typeof run!=="function")throw Error("LIVING_WORLD_TICK_CALLBACK_REQUIRED");
  // No second clock and no nested/duplicate phase dispatch if another
  // callback tries to enter the same native owner synchronously.
  if(active)return {status:"REENTRANT_SKIPPED",sequence,nativeMutation:false};
  const startedAt=clock();
  active=true;sequence++;
  const names=[],unknownNames=[],groups=Object.create(null);
  let phaseCount=0,status="COMPLETED";
  const phase=(name,fn)=>{
   if(typeof name!=="string"||!VALID_PHASE.test(name)||typeof fn!=="function")
    throw Error("LIVING_WORLD_PHASE_INVALID");
   phaseCount++;
   const kind=classifyPhase(name);
   const group=kind.group||"unclassified";
   groups[group]=(groups[group]||0)+1;
   if(kind.status==="UNCLASSIFIED"&&unknownNames.length<32)
    unknownNames.push(name);
   // Observability is bounded; execution is NOT truncated.
   if(names.length<128)names.push(name);
   // Preserve exactly the old safeNpcPhase error boundary and sync order.
   return execute(name,fn);
  };
  try{
   const result=run(phase);
   // A promise-returning WHOLE tick would release the physical clock lease
   // before the tick has finished. Only individual native phases may use
   // their existing, separately guarded async execution.
   if(result&&typeof result.then==="function")
    throw Error("LIVING_WORLD_ASYNC_CYCLE_FORBIDDEN");
   return {status:"COMPLETED",sequence,phaseCount};
  }catch(error){
   status="THREW";
   // Do not convert an unhandled world error into a false successful tick.
   throw error;
  }finally{
   active=false;
   let endedAt=startedAt;
   try{endedAt=clock()}catch(_ignored){}
   last=Object.freeze({sequence,status,startedAt,
    durationMs:Number.isFinite(endedAt-startedAt)?
     Math.max(0,endedAt-startedAt):0,phaseCount,
    phaseNames:Object.freeze(names.slice()),
    groups:Object.freeze({...groups}),
    unknownNames:Object.freeze(unknownNames.slice()),
    source:"DISPATCH_ATTEMPTS_NOT_NATIVE_SETTLEMENT"});
   // Operator telemetry is diagnostic only: never change a game outcome.
   try{onCycle(snapshot().last)}catch(_ignored){}
  }
 }
 return Object.freeze({tick,snapshot,phaseCatalog:catalog});
}
module.exports={createPhaseCoordinator};
