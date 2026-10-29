"use strict";
// Durable virtual-to-physical NPC identity registry.
// The game engine is authoritative: records NEVER restore ships directly.
const fs=require("node:fs"),path=require("node:path");
function validID(x){return typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);}
function positive(x){const v=Number(x);return Number.isSafeInteger(v)&&v>0?v:null;}
function createRegistry({file,exists,clock=()=>Date.now()}){
 if(!file||typeof exists!=="function")throw Error("file and exists required");
 // When the experimental native military transfer is enabled an orphan
 // identity-write temp file is a crash signal, not permission to respawn.
 if(process.env.EVEJS_COOP_FACTION_WAR_NATIVE_TRANSFER==="1"){
  const dir=path.dirname(file),base=path.basename(file)+".tmp-";
  try{
   if(fs.readdirSync(dir).some(name=>name.startsWith(base)))
    throw Error("WAR_IDENTITY_UNRESOLVED_TEMP_WRITE");
  }catch(e){if(e.code!=="ENOENT")throw e;}
 }
 let state={version:1,links:{}};
 try{const raw=JSON.parse(fs.readFileSync(file,"utf8"));if(raw?.version!==1||!raw.links||typeof raw.links!=="object")throw Error("invalid registry");state=raw;}
 catch(err){if(err.code!=="ENOENT")throw err;}
 // Native transfers depend on this JSON identity surviving a process crash.
 // This is still a separate durable owner from SQLite, hence transfer fences.
 let nonce=0;
 // Links deleted SINCE the last persist: a merge must not bring them back.
 const removedLinks=new Set();
 let loadedStamp = null; // the file as this owner last saw it; refresh() compares
 const persist=()=>{
  // Several owners write this file (the world, the market trader, the co-op loop) and each
  // used to REPLACE it with its own copy. Measured 2026-10-30: a hull linked by the loop was
  // dropped by the next write from the market side and every crossing then failed
  // SOURCE_IDENTITY_MISMATCH. Merge with what is really on disk instead of overwriting it:
  // this owner always refreshes before it mutates, so its own view is the newest for its keys.
  let onDisk={};
  try{onDisk=JSON.parse(fs.readFileSync(file,"utf8")).links||{};}catch(_error){onDisk={};}
  const merged={...onDisk,...state.links};
  for(const id of removedLinks)delete merged[id];
  removedLinks.clear();
  state={version:1,links:merged};
  const dir=path.dirname(file);
  fs.mkdirSync(dir,{recursive:true});
  const tmp=file+".tmp-"+process.pid+"-"+(++nonce);
  let fd=null;
  try{
   fd=fs.openSync(tmp,"wx",0o600);
   fs.writeFileSync(fd,JSON.stringify(state));fs.fsyncSync(fd);
   fs.closeSync(fd);fd=null;
   fs.renameSync(tmp,file);
   if(typeof stamp==="function")loadedStamp=stamp();
   try{
    const dirfd=fs.openSync(dir,"r");
    try{fs.fsyncSync(dirfd);}finally{fs.closeSync(dirfd);}
   }catch(error){
    // Windows installations may reject directory fd fsync. Keep legacy
    // non-war NPC registry working, but require strict durability for war.
    if(process.env.EVEJS_COOP_FACTION_WAR_NATIVE_TRANSFER==="1"||
     !["EINVAL","ENOTSUP","EISDIR","EPERM"].includes(error?.code))
     throw error;
   }
  }finally{if(fd!==null)fs.closeSync(fd);}
 };
 // More than one owner reads this file (the world, the market trader, the co-op loop), and
 // each kept its own copy of the state. Measured 2026-10-30: the co-op linked a hull, the
 // market trader still had the file as it was at boot and refused every sale NO_IDENTITY_LINK -
 // and the next write from either side silently dropped the other's link.
 // refresh() re-reads the file when it really changed, so a reader never acts on a stale copy.
 function stamp(){
  try{const s=fs.statSync(file);return s.size + ":" + s.mtimeMs;}catch(_error){return null}
 }
 loadedStamp=stamp();
 function refresh(){
  const nowStamp=stamp();
  if(nowStamp===loadedStamp)return false;
  try{
   const raw=JSON.parse(fs.readFileSync(file,"utf8"));
   if(raw?.version!==1||!raw.links||typeof raw.links!=="object")return false;
   state=raw;loadedStamp=nowStamp;
   return true;
  }catch(_error){return false}
 }
 function get(id){
  refresh();
  const e=state.links[id];
  if(!e)return null;
  if(!positive(e.entityID)||!positive(e.systemID)||!exists(e.systemID,e.entityID))return null;
  return {...e};
 }
 function link(pilot,systemID,entityID){
  refresh();
  if(!validID(pilot?.id)||!positive(systemID)||!positive(entityID))throw Error("invalid materialization link");
  const existing=get(pilot.id);
  if(existing){
   // Older worlds were created before occupation tracking existed.
   // Migrate metadata without replacing a still-living physical ship.
   if(!existing.role&&pilot.role){
    const previous=state.links[pilot.id].role;
    state.links[pilot.id].role=String(pilot.role).slice(0,24);
    try{persist()}catch(error){
     state.links[pilot.id].role=previous;throw error;
    }
    return {...state.links[pilot.id]};
   }
   return existing;
  }
  const e={pilotID:pilot.id,name:String(pilot.name||pilot.id).slice(0,96),faction:String(pilot.faction||"independent").slice(0,48),role:String(pilot.role||"").slice(0,24),durable:pilot.durable===true,systemID:Number(systemID),entityID:Number(entityID),linkedAt:clock()};
  state.links[pilot.id]=e;
  try{persist()}catch(error){delete state.links[pilot.id];throw error;}
  return {...e};
 }
 // A finished shift frees the pilot. The physical ship stays alive as a spare;
 // only the identity link is dropped, and only when it still points at the exact
 // entity the caller means. Without this a long-lived world spends one resident
 // per station trip and every later sale dies with no free identity.
 function release(pilotID,options={}){
  refresh();
  if(!validID(pilotID))return {status:"INVALID_PILOT"};
  const record=state.links[pilotID];
  if(!record)return {status:"NOT_LINKED"};
  const expected=positive(options?.expectedEntityID);
  if(expected&&Number(record.entityID)!==expected)return {status:"ENTITY_MISMATCH"};
  delete state.links[pilotID];
  removedLinks.add(pilotID);
  try{persist();}
  catch(error){state.links[pilotID]=record;throw error;}
  return {status:"RELEASED",pilotID,entityID:Number(record.entityID),
   systemID:Number(record.systemID)};
 }
 // Only update durable identity AFTER the same native ship physically
 // exists in the destination and is absent from its former EveJS scene.
 function relocate(pilotID,fromSystemID,entityID,toSystemID){
  refresh();
  const source=positive(fromSystemID),id=positive(entityID),dest=positive(toSystemID);
  if(!validID(pilotID)||!source||!id||!dest||source===dest)
   return {status:"INVALID"};
  const record=state.links[pilotID];
  if(!record||Number(record.systemID)!==source||Number(record.entityID)!==id)
   return {status:"STALE_SOURCE"};
  if(exists(source,id))return {status:"SOURCE_STILL_PHYSICAL"};
  if(!exists(dest,id))return {status:"DESTINATION_NOT_PHYSICAL"};
  const old={...record};
  state.links[pilotID]={...record,systemID:dest,relocatedAt:clock()};
  try{persist();}
  catch(error){state.links[pilotID]=old;throw error;}
  return {status:"RELOCATED",...state.links[pilotID]};
 }
 function prune(){
  const before={...state.links};
  let removed=0;
  for(const [id,e] of Object.entries(state.links)){
   if(!positive(e.systemID)||!positive(e.entityID)||!exists(e.systemID,e.entityID)){
    delete state.links[id];removed++;
   }
  }
  if(removed)try{persist()}catch(error){state.links=before;throw error;}
  return removed;
 }
 return {get,link,release,relocate,prune,refresh,snapshot:()=>{refresh();return structuredClone(state)}};
}
module.exports={createRegistry};
