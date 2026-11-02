"use strict";
// Best-effort, append-only native telemetry. Never modify gameplay state.
// Missing configuration or an unwritable volume MUST be visible in container
// logs, rather than silently misreported as a missing EVE client.
const fs = require("node:fs");
const path = require("node:path");
const {randomUUID}=require("node:crypto");
// Unique for this Node process boot, not user-supplied or a game state ID.
const runtimeRunID=randomUUID();
let lastWarning = "";
// Opt-in, additive subscribers (e.g. the ALIFE news digest). They receive the
// exact record that was appended, can never change it, and are isolated so a
// broken listener cannot stop telemetry.
const subscribers = new Set();
function subscribe(listener) {
  if (typeof listener !== "function") return () => {};
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}
function positive(value){const n=Number(value);return Number.isSafeInteger(n)&&n>0?n:null;}
function describe(session,ship){
  return {
    characterID:positive(session?.characterID),
    shipID:positive(ship?.itemID||session?._space?.shipID||session?.shipid),
    systemID:positive(ship?.spaceState?.systemID||session?._space?.systemID||session?.solarsystemid),
    clientID:positive(session?.clientID),
  };
}
function warnOnce(code){
  const marker=String(code||"UNKNOWN");
  if(lastWarning===marker)return;
  lastWarning=marker;
  try { console.warn("[CoopProbe] BLOCKED_TELEMETRY_"+marker+"; inspect effective EVEJS_COOP_EVENTS_FILE and /var/lib/evejs mount"); }catch(_ignored){}
}
// The event file is the only durable trace of what the world did, and nothing ever trimmed it:
// measured on the play stack, /var/lib/evejs/coop-events.jsonl reached 368 MB / 402 291 lines and
// the data volume 4.2 GB. Bounded rotation keeps the recent history readable without letting the
// file grow forever: when it passes the cap it becomes `<file>.1` (replacing the previous one) and
// a fresh file starts. Cap via EVEJS_COOP_EVENTS_MAX_MB (default 128, 0 disables rotation).
let lastRotateCheckAt=0;
// One open descriptor per event file instead of open/write/close for every record: measured on the
// play stack at ~220 events/min, every one of them opened the file, wrote, closed it and asked the
// filesystem for the same directory again. The descriptor is reopened only after a rotation or an
// IO error, so a record is still written before observe() returns - the durability contract is the
// same, only the syscalls are gone.
const openFiles=new Map();
const ensuredDirs=new Set();
function ensureDirectory(destination){
  const dir=path.dirname(destination);
  if(ensuredDirs.has(dir))return;
  fs.mkdirSync(dir,{recursive:true});
  ensuredDirs.add(dir);
}
function closeFile(destination){
  const entry=openFiles.get(destination);
  if(!entry)return;
  openFiles.delete(destination);
  try{fs.closeSync(entry.fd);}catch(_error){/* already gone */}
}
function openFile(destination){
  const existing=openFiles.get(destination);
  if(existing)return existing;
  ensureDirectory(destination);
  const fd=fs.openSync(destination,"a");
  let ino=0;
  try{ino=fs.fstatSync(fd).ino;}catch(_error){ino=0;}
  const entry={fd,ino,checkedAt:0};
  openFiles.set(destination,entry);
  return entry;
}
// A descriptor survives an external rename or delete: writes would quietly land in the old inode and
// the new file would never appear. Re-validating the path costs one stat every few seconds, not one
// per record. EVEJS_COOP_EVENTS_REVALIDATE_MS=0 makes every write re-validate (tests, small volumes).
function revalidateIntervalMs(){
  const raw=Number(process.env.EVEJS_COOP_EVENTS_REVALIDATE_MS??5000);
  return Number.isFinite(raw)&&raw>=0?raw:5000;
}
function fileStillOurs(destination,entry){
  const interval=revalidateIntervalMs();
  const now=Date.now();
  if(interval>0&&now-entry.checkedAt<interval)return true;
  entry.checkedAt=now;
  try{
    const stat=fs.statSync(destination);
    if(entry.ino&&stat.ino&&stat.ino!==entry.ino)return false;
    return true;
  }catch(_error){
    return false;
  }
}
function writeRecord(destination,line){
  let entry=openFile(destination);
  if(!fileStillOurs(destination,entry)){
    closeFile(destination);
    entry=openFile(destination);
  }
  try{
    fs.writeSync(entry.fd,line,undefined,"utf8");
  }catch(error){
    // A stale descriptor (rotation, external truncation) must not lose the record: reopen once.
    closeFile(destination);
    const retried=openFile(destination);
    fs.writeSync(retried.fd,line,undefined,"utf8");
  }
}
process.once("exit",()=>{for(const destination of [...openFiles.keys()])closeFile(destination);});
function rotateIfNeeded(destination){
  const capMb=Number(process.env.EVEJS_COOP_EVENTS_MAX_MB??128);
  if(!Number.isFinite(capMb)||capMb<=0)return false;
  const now=Date.now();
  if(now-lastRotateCheckAt<60000)return false;
  lastRotateCheckAt=now;
  try{
    const size=fs.statSync(destination).size;
    if(size<capMb*1024*1024)return false;
    // The descriptor points at the old inode after a rename, so it is dropped first.
    closeFile(destination);
    fs.renameSync(destination,destination+".1");
    return true;
  }catch(_error){return false}
}

function observe(event,session,ship,extra={}){
  // Evaluating at event time is intentional: environment may be configured
  // after module preload in local tests or startup plugins.
  const destination=process.env.EVEJS_COOP_EVENTS_FILE;
  if(typeof destination!=="string"||!destination.trim()){
    warnOnce("CONFIG");
    return false;
  }
  try {
    const record={
      at:new Date().toISOString(),
      event,
      ...describe(session,ship),
      ...extra,
      // Reserved final key: callers cannot counterfeit a prior process run.
      runtimeRunID,
    };
    rotateIfNeeded(destination);
    writeRecord(destination,JSON.stringify(record)+"\n");
    lastWarning="";
    // Listeners get the record after it is durable; failures are isolated.
    for(const listener of subscribers){
      try{listener(record);}catch(_ignored){}
    }
    return true;
  } catch(err) {
    // Optional diagnostics must NEVER interrupt login, disconnect or combat.
    // Log only the error code, not potentially sensitive filesystem paths.
    warnOnce("WRITE_"+(String(err?.code||"UNKNOWN").replace(/[^A-Z0-9_]/g,"_").slice(0,40)));
    return false;
  }
}
module.exports={observe,subscribe,rotateIfNeeded,closeAll:()=>{for(const destination of [...openFiles.keys()])closeFile(destination);}};