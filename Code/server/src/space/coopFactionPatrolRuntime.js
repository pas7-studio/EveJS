"use strict";
// Native patrol deployment from faction plans. Bounded, opt-in and scene-owned.
function positive(x){const n=Number(x);return Number.isSafeInteger(n)&&n>0?n:null;}
function createPatrolDirector({spawn,exists,clock=()=>Date.now(),cooldownMs=300000,maxPerSystem=2}){
 if(typeof spawn!=="function"||typeof exists!=="function")throw Error("spawn and exists required");
 if(!Number.isSafeInteger(cooldownMs)||cooldownMs<60000)throw Error("cooldown too short");
 if(!Number.isInteger(maxPerSystem)||maxPerSystem<1||maxPerSystem>6)throw Error("invalid cap");
 const active=new Map(),lastAttempt=new Map();
 function reconcile(systemID,factions){
  const system=positive(systemID);
  if(!system)return {status:"INVALID_SYSTEM"};
  const entries=(factions||[]).filter(f=>positive(f.systemID)===system&&Number(f.patrolPriority)>=20&&Number(f.readiness)>=1)
   .sort((a,b)=>Number(b.patrolPriority)-Number(a.patrolPriority));
  const live=active.get(system)||new Set();
  for(const id of live)if(!exists(system,id))live.delete(id);
  active.set(system,live);
  if(!entries.length)return {status:"NO_DEMAND",active:[...live]};
  if(live.size>=maxPerSystem)return {status:"AT_CAP",active:[...live]};
  if(clock()<(lastAttempt.get(system)||0)+cooldownMs)return {status:"COOLDOWN",active:[...live]};
  lastAttempt.set(system,clock());
  const wanted=Math.min(maxPerSystem-live.size,entries.length);
  const spawned=[];
  for(const faction of entries.slice(0,wanted)){
   const result=spawn(system,faction);
   const id=positive(result?.data?.spawned?.[0]?.entity?.itemID);
   if(result?.success&&id){live.add(id);spawned.push({faction:faction.faction,entityID:id});}
  }
  return {status:spawned.length?"SPAWNED":"FAILED",spawned,active:[...live]};
 }
 return {reconcile,snapshot:()=>Object.fromEntries([...active].map(([id,ships])=>[id,[...ships]]))};
}
module.exports={createPatrolDirector};
