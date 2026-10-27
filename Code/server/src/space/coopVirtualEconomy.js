"use strict";
// Bounded offline simulation. Virtual resources are NOT EveJS market inventory.
const fs=require("node:fs"),path=require("node:path");
const ROLES=["miner","hauler","patrol","trader","pirate"];
const cap=n=>Math.max(0,Math.min(1000000,Math.floor(Number(n)||0)));
function createEconomy({file,clock=()=>Date.now(),stepMs=60000,maxCatchup=1440,fsApi=fs}){
 if(!file||!Number.isInteger(stepMs)||stepMs<10000||!Number.isInteger(maxCatchup)||maxCatchup<1||maxCatchup>10000)throw Error("invalid economy settings");
 let state,journalPresent=false,persistenceUnverified=false;
 try{
  state=JSON.parse(fsApi.readFileSync(file,"utf8"));
  if(state.version!==1)throw Error("incompatible economy state");
  // nativeDelivered is a durable monotone high-water mark of original
  // depot receipts. Treating a malformed value as zero would re-credit
  // historical cargo on the next syncNativeDeliveries() call.
  // A corrupt tick cursor can mint hours of phantom virtual ore or
  // disable catch-up forever; malformed saved pilots can crash the tick
  // after changing in-memory supply. Refuse incomplete persisted metadata.
  if(!Number.isSafeInteger(state.lastAt)||state.lastAt<0||
     !state.pilots||typeof state.pilots!=="object"||
     Array.isArray(state.pilots)||!Array.isArray(state.events)||
     (state.rolesVersion!==undefined&&
      (!Number.isSafeInteger(state.rolesVersion)||
       state.rolesVersion<0||state.rolesVersion>2)))
   throw Error("ECONOMY_TICK_JOURNAL_INVALID");
  for(const [id,pilot] of Object.entries(state.pilots)){
   if(!id.trim()||id.length>256||id==="prototype"||
      Object.prototype.hasOwnProperty.call(Object.prototype,id)||
      !pilot||typeof pilot!=="object"||Array.isArray(pilot)||
      !ROLES.includes(pilot.role)||
      !Number.isSafeInteger(pilot.cargo)||pilot.cargo<0||
      !Number.isSafeInteger(pilot.credits)||pilot.credits<0||pilot.credits>1000000||
      !Number.isSafeInteger(pilot.completed)||pilot.completed<0)
    throw Error("ECONOMY_TICK_JOURNAL_INVALID");
  }
  if(!state.systems||typeof state.systems!=="object"||Array.isArray(state.systems))
   throw Error("ECONOMY_NATIVE_DELIVERY_CHECKPOINT_INVALID");
  for(const [key,entry] of Object.entries(state.systems)){
   // One real solar system must have exactly one durable virtual inventory.
   // A legacy alias such as "030000142" must be reconciled, not silently
   // mixed with the canonical "30000142" entry.
   const parsed=Number(key);
   if(!Number.isSafeInteger(parsed)||parsed<=0||String(parsed)!==key)
    throw Error("ECONOMY_SYSTEM_KEY_INVALID");
   if(!entry||typeof entry!=="object"||Array.isArray(entry)||
      (Object.prototype.hasOwnProperty.call(entry,"nativeDelivered")&&
       (!Number.isSafeInteger(entry.nativeDelivered)||entry.nativeDelivered<0)))
    throw Error("ECONOMY_NATIVE_DELIVERY_CHECKPOINT_INVALID");
   for(const key of ["ore","goods","demand","security","losses"]){
    const value=entry[key],limit=key==="security"?100:1000000;
    if(!Number.isSafeInteger(value)||value<0||value>limit)
     throw Error("ECONOMY_SYSTEM_BALANCE_INVALID");
   }
  }
  journalPresent=true;
 }catch(e){if(e.code!=="ENOENT")throw e;}
 // An unreliable clock must never leave partially credited native ore or
 // an invalid offline tick cursor in a newly created journal.
 function clockTime(){
  const at=clock();
  if(!Number.isSafeInteger(at)||at<0)throw Error("ECONOMY_CLOCK_INVALID");
  return at;
 }
 if(!state)state={version:1,lastAt:clockTime(),systems:{},pilots:{},events:[]};
 // Supply receipts can be replayed if a second process overwrites the
 // 'nativeDelivered' high-water mark. Every mutator, including simulation
 // and loss events, must share the same durable cross-process write fence.
 function verifyCurrentRead(){
  if(persistenceUnverified)throw Error("ECONOMY_PERSISTENCE_UNVERIFIED");
  try{
   try{
    fsApi.readFileSync(file+".lock","utf8");
    throw Error("ECONOMY_WRITE_IN_PROGRESS");
   }catch(e){if(e?.code!=="ENOENT")throw e;}
   let disk=null;
   try{disk=JSON.parse(fsApi.readFileSync(file,"utf8"));}
   catch(e){if(e?.code!=="ENOENT")throw e;}
   if((disk!==null)!==journalPresent||
      (journalPresent&&JSON.stringify(disk)!==JSON.stringify(state)))
    throw Error("ECONOMY_CONCURRENT_JOURNAL_DRIFT");
  }catch(error){persistenceUnverified=true;throw error;}
 }
 function persist(){
  if(persistenceUnverified)throw Error("ECONOMY_PERSISTENCE_UNVERIFIED");
  const folder=path.dirname(file),lock=file+".lock",tmp=file+".tmp-"+process.pid;
  let lockFd=null,held=false,tmpCreated=false;
  try{
   fsApi.mkdirSync(folder,{recursive:true});
   lockFd=fsApi.openSync(lock,"wx",0o600);held=true;
   fsApi.writeFileSync(lockFd,String(process.pid));fsApi.fsyncSync(lockFd);
   fsApi.closeSync(lockFd);lockFd=null;
   let disk=null;
   try{disk=JSON.parse(fsApi.readFileSync(file,"utf8"));}
   catch(e){if(e?.code!=="ENOENT")throw e;}
   if((disk!==null)!==journalPresent||
      (journalPresent&&JSON.stringify(disk)!==JSON.stringify(stateBeforeMutation)))
    throw Error("ECONOMY_CONCURRENT_JOURNAL_DRIFT");
   // A different writer or an earlier crash may own this PID's temp.
   // Refuse collisions, and never delete evidence we did not create.
   const fd=fsApi.openSync(tmp,"wx",0o600);tmpCreated=true;
   try{fsApi.writeFileSync(fd,JSON.stringify(state));fsApi.fsyncSync(fd);}
   finally{fsApi.closeSync(fd);}
   fsApi.renameSync(tmp,file);
   try{
    const directoryFd=fsApi.openSync(folder,"r");
    try{fsApi.fsyncSync(directoryFd);}finally{fsApi.closeSync(directoryFd);}
   }catch(error){
    if(!["EPERM","EACCES","EISDIR","EINVAL","EBADF"].includes(error?.code))throw error;
   }
   journalPresent=true;
  }catch(error){
   persistenceUnverified=true;
   if(tmpCreated)try{fsApi.unlinkSync(tmp);}catch(_ignored){}
   throw error;
  }finally{
   let releaseError=null;
   if(lockFd!==null)try{fsApi.closeSync(lockFd);}catch(e){releaseError=e;}
   if(held)try{fsApi.unlinkSync(lock);}catch(e){releaseError=releaseError||e;}
   if(releaseError){persistenceUnverified=true;throw releaseError;}
  }
 }
 // The expected disk image is retained *before* any in-memory mutation.
 let stateBeforeMutation=structuredClone(state);
 function beforeMutation(){
  verifyCurrentRead();
  stateBeforeMutation=structuredClone(state);
 }
 function ensure(systemID){const id=String(Number(systemID));return state.systems[id]??={ore:200,goods:100,demand:100,security:50,losses:0};}
 function register(pilots){
   const upgradeRoles=state.rolesVersion!==2;
   for(const [i,p] of pilots.entries()){
     if(!p?.id||!Number.isSafeInteger(Number(p.systemID)))continue;
     ensure(p.systemID);
     state.pilots[p.id]??={role:ROLES[i%ROLES.length],cargo:0,credits:100,completed:0};
     if(upgradeRoles)state.pilots[p.id].role=ROLES[i%ROLES.length];
   }
   // An empty registration is not a durable schema upgrade.
   if(pilots.length)state.rolesVersion=2;
 }
 function addCompleted(agent,quantity){
  // Progress is telemetry, not source-of-truth ore. Saturate before it
  // exceeds Number.MAX_SAFE_INTEGER and poisons the persisted journal.
  agent.completed=Math.min(Number.MAX_SAFE_INTEGER,agent.completed+quantity);
 }
 function step(pilots){
  // Accumulate decisions first, then commit. No negative or infinite balances.
  const ordered=[...pilots].sort((a,b)=>a.id.localeCompare(b.id));
  for(const p of ordered){
   const sys=ensure(p.systemID),agent=state.pilots[p.id];
   if(!agent)continue;
   if(agent.role==="miner"){const produced=Math.min(3,1000000-sys.ore);sys.ore+=produced;addCompleted(agent,produced);}
   if(agent.role==="hauler"){const qty=Math.min(2,sys.ore,1000000-sys.goods);sys.ore-=qty;sys.goods+=qty;agent.credits=cap(agent.credits+qty);addCompleted(agent,qty);}
   if(agent.role==="trader"){const qty=Math.min(2,sys.goods);sys.goods-=qty;sys.demand=cap(sys.demand+qty);agent.credits=cap(agent.credits+qty*3);addCompleted(agent,qty);}
   if(agent.role==="patrol"){sys.security=Math.min(100,sys.security+1);addCompleted(agent,1);}
   if(agent.role==="pirate"){
     const stolen=Math.min(2,sys.goods);
     sys.goods-=stolen;
     agent.credits=cap(agent.credits+stolen*2);
     addCompleted(agent,stolen);
     sys.security=Math.max(0,sys.security-1);
     sys.demand=cap(sys.demand+stolen);
   }
   sys.demand=cap(Math.max(0,sys.demand-1)+(sys.goods<25?1:0));
  }
 }
 // NPC roster is untrusted input. Validate the complete roster BEFORE
 // register() mutates balances or state.pilots, including zero-step ticks.
 // "__proto__" / inherited names otherwise modify Object.prototype.role.
 function canonicalPilotRoster(pilots){
  if(!Array.isArray(pilots))return null;
  const seen=new Set(),result=[];
  try{
   for(const pilot of pilots){
    // Read each untrusted property only once. A getter/proxy can otherwise
    // return a safe ID during validation and "__proto__" during mapping,
    // bypassing the protection and mutating the process-wide prototype.
    const id=pilot?.id,rawSystem=pilot?.systemID;
    const systemID=Number(rawSystem);
    if(typeof id!=="string"||!id.trim()||id.length>256||
       id==="prototype"||Object.prototype.hasOwnProperty.call(Object.prototype,id)||
       seen.has(id)||!Number.isSafeInteger(systemID)||systemID<=0)
     return null;
    seen.add(id);
    result.push({id,systemID});
   }
  }catch(_error){return null;}
  return result;
 }
 function advance(pilots){
  const canonicalPilots=canonicalPilotRoster(pilots);
  if(!canonicalPilots)return {status:"INVALID_PILOTS",steps:0};
  beforeMutation();
  const now=clockTime();if(now<state.lastAt)return {status:"CLOCK_REWIND",steps:0};
  register(canonicalPilots);
  const due=Math.floor((now-state.lastAt)/stepMs);
  const steps=Math.min(due,maxCatchup);
  for(let i=0;i<steps;i++)step(canonicalPilots);
  if(steps){state.lastAt+=steps*stepMs;persist();}
  else if(JSON.stringify(state)!==JSON.stringify(stateBeforeMutation))persist();
  return {status:due>steps?"CATCHUP_REMAINING":"OK",steps,remaining:due-steps};
 }
 function recordLoss(systemID,amount=1){
  // An unverified loss cannot turn native system security into NaN/null
  // or create non-geolocatable phantom economic systems/events.
  const id=Number(systemID),rawAmount=Number(amount);
  if(!Number.isSafeInteger(id)||id<=0||
     !Number.isFinite(rawAmount)||rawAmount<0)
   throw Error("ECONOMY_INVALID_LOSS");
  beforeMutation();
  const at=clockTime(); // Source clock verified before any mutation.
  const s=ensure(id),n=Math.max(1,Math.min(100,Math.floor(rawAmount)));
  s.losses=cap(s.losses+n);s.security=Math.max(0,s.security-n);s.demand=cap(s.demand+n*4);
  const entry={type:"loss",systemID:id,amount:n,at};
  state.events.push(entry);if(state.events.length>100)state.events.shift();persist();return entry;
 }
 function syncNativeDeliveries(totals={}){
  // Validate the entire original depot totals batch before even touching
  // state. A later Symbol/throwing value used to leave early entries credited
  // only in memory; replay then said UNCHANGED despite no durable journal.
  if(!totals||typeof totals!=="object"||Array.isArray(totals))
   return {status:"INVALID_TOTALS",quantity:0};
  const entries=[],seen=new Set();
  try{
   for(const [rawID,total] of Object.entries(totals)){
    const systemID=Number(rawID),count=Number(total);
    if(!Number.isSafeInteger(systemID)||systemID<=0||
       !Number.isSafeInteger(count)||count<0||seen.has(systemID))
     return {status:"INVALID_TOTALS",quantity:0};
    seen.add(systemID);
    entries.push([systemID,count]);
   }
  }catch(_error){return {status:"INVALID_TOTALS",quantity:0};}
  beforeMutation();
  const hasNewDelivery=entries.some(([systemID,count])=>
   count>Number(state.systems[String(systemID)]?.nativeDelivered??0));
  // Shared transaction timestamp, checked before the first ore increment.
  // An unchanged checkpoint does not require the clock at all.
  const at=hasNewDelivery?clockTime():null;
  let accepted=0,modified=false;
  for(const [systemID,count] of entries){
   const existing=state.systems[String(systemID)];
   const before=Math.max(0,Number(existing?.nativeDelivered)||0);
   if(count<=before)continue;
   const sys=ensure(systemID),gained=count-before;
   sys.goods=cap(sys.goods+gained);
   sys.demand=Math.max(0,cap(sys.demand-gained));
   sys.nativeDelivered=count;
   accepted+=gained;modified=true;
   state.events.push({type:"real-ore-delivery",systemID,amount:gained,at});
  }
  // A no-op sync must never change in-memory history without persisting
  // it; otherwise the next read fence flags the same instance as stale.
  if(modified&&state.events.length>100)state.events=state.events.slice(-100);
  if(modified)persist();
  return {status:modified?"UPDATED":"UNCHANGED",quantity:accepted};
 }
 return {advance,recordLoss,syncNativeDeliveries,snapshot:()=>{
  verifyCurrentRead();
  return structuredClone(state);
 }};
}
module.exports={createEconomy};
