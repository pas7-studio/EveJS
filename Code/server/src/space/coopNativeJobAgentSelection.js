"use strict";
// Durable, actor-bound selection of a genuine NPC job for native agent UI.
// The client supplies a button ID, NOT an event ID. Never silently rebind it.
const fs=require("node:fs"),path=require("node:path");
const pos=x=>Number.isSafeInteger(x)&&x>0;
const valid=x=>typeof x==="string"&&/^convoy-\d+-\d+-\d+$/.test(x);
function createNativeJobSelection({root,io=fs,clock=()=>Date.now()}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||typeof clock!=="function")
  throw Error("NATIVE_AGENT_SELECTION_AUTHORITIES_REQUIRED");
 const dir=path.join(root,"coop-opportunities","native-agent-selections");
 const file=(characterID,agentID)=>path.join(dir,characterID+"-"+agentID+".json");
 const deny=status=>({status});
 function read(characterID,agentID){
  if(!pos(characterID)||!pos(agentID))return deny("INVALID_ACTOR");
  let data;try{data=io.readFileSync(file(characterID,agentID),"utf8")}
  catch(e){return deny(e?.code==="ENOENT"?"NOT_FOUND":"SELECTION_READ_UNAVAILABLE")}
  if(typeof data!=="string"||data.length>1024||!data.endsWith("\n"))
   return deny("SELECTION_CORRUPT");
  let row;try{row=JSON.parse(data.trim())}catch{return deny("SELECTION_CORRUPT")}
  if(row?.v!==1||row.characterID!==characterID||row.agentID!==agentID||
   !valid(row.eventID)||!pos(row.createdAt)||!pos(row.expiresAt)||
   row.expiresAt<=row.createdAt||row.expiresAt-row.createdAt>86400000)
   return deny("SELECTION_CORRUPT");
  return {status:row.expiresAt<=clock()?"EXPIRED":"READY",
   eventID:row.eventID,expiresAt:row.expiresAt};
 }
 function pin(characterID,agentID,eventID,expiresAt){
  if(!pos(characterID)||!pos(agentID)||!valid(eventID)||
   !pos(expiresAt)||expiresAt<=clock()||expiresAt-clock()>86400000)
   return deny("INVALID_SELECTION");
  const old=read(characterID,agentID);
  if(old.status==="READY")
   return old.eventID===eventID?{status:"SELECTED",eventID}:
    deny("SELECTION_ALREADY_BOUND");
  if(!["NOT_FOUND","EXPIRED"].includes(old.status))return old;
  const target=file(characterID,agentID),temp=target+".tmp";
  const value={v:1,characterID,agentID,eventID,createdAt:clock(),expiresAt};
  let fd,dd;
  try{
   io.mkdirSync(dir,{recursive:true});
   if(old.status==="EXPIRED"){
    // Existing target is checked, then replaced; stale or ambiguous temp
    // blocks further changes rather than guessing if a write committed.
    fd=io.openSync(temp,"wx",0o600);
   }else fd=io.openSync(target,"wx",0o600);
   const buf=Buffer.from(JSON.stringify(value)+"\n");
   if(buf.length>1024||io.writeSync(fd,buf,0,buf.length,null)!==buf.length)
    return deny("SELECTION_WRITE_UNCERTAIN");
   io.fsyncSync(fd);io.closeSync(fd);fd=undefined;
   if(old.status==="EXPIRED")io.renameSync(temp,target);
   dd=io.openSync(dir,"r");io.fsyncSync(dd);
  }catch{return deny("SELECTION_WRITE_UNCERTAIN_NEEDS_REPAIR")}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{};
   if(dd!==undefined)try{io.closeSync(dd)}catch{}}
  const stored=read(characterID,agentID);
  return stored.status==="READY"&&stored.eventID===eventID?
   {status:"SELECTED",eventID}:deny("SELECTION_RECHECK_UNCERTAIN");
 }
 return Object.freeze({read,pin});
}
module.exports={createNativeJobSelection};