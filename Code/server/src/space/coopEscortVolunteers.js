"use strict";
// Voluntary TWO-pilot native event interest. This does not join fleets,
// pay ISK, spawn objects, or count as an accepted FUNDED escort contract.
const fs=require("node:fs"),path=require("node:path");
const pos=x=>Number.isSafeInteger(x)&&x>0;
const KEY=x=>typeof x==="string"&&/^(raid|convoy)-\d+-\d+-\d+$/.test(x);
function createVolunteers({root,io=fs,clock=()=>Date.now(),readEvent,readInterest,
 getSessions,getScene,fleetRuntime}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||
  [clock,readEvent,readInterest,getSessions,getScene].some(fn=>typeof fn!=="function")||
  typeof fleetRuntime?.getFleetForCharacter!=="function"||
  typeof fleetRuntime?.getMemberRecord!=="function")throw Error("NATIVE_VOLUNTEER_AUTHORITIES_REQUIRED");
 const dir=path.join(root,"coop-opportunities","volunteers");
 const file=(eventID,char)=>path.join(dir,eventID+"-"+char+".json");
 const pairFile=eventID=>path.join(dir,eventID+"-duo.json");
 const block=s=>({status:s});
 function durableNew(p,value){
  let fd;try{
   io.mkdirSync(path.dirname(p),{recursive:true});
   const buf=Buffer.from(JSON.stringify(value)+"\n");
   if(buf.length>2048)return false;
   fd=io.openSync(p,"wx",0o600);
   if(io.writeSync(fd,buf,0,buf.length,null)!==buf.length)return false;
   io.fsyncSync(fd);
  }catch{return false}finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
  let d;try{d=io.openSync(dir,"r");io.fsyncSync(d);return true}
  catch{return false}finally{if(d!==undefined)try{io.closeSync(d)}catch{}}
 }
 function load(p){
  let text;try{text=io.readFileSync(p,"utf8")}
  catch(e){return block(e?.code==="ENOENT"?"NOT_FOUND":"READ_UNAVAILABLE")}
  if(typeof text!=="string"||text.length>2048||!text.endsWith("\n"))return block("CORRUPT");
  try{return {status:"READY",value:JSON.parse(text.trim())}}catch{return block("CORRUPT")}
 }
 function party(session,event){
  let sessions;try{sessions=getSessions()}catch{return null}
  if(!Array.isArray(sessions)||!sessions.includes(session)||
   session?.socket?.destroyed===true||session?._space?.initialStateSent!==true||
   session?._space?.systemID!==event.systemID)return null;
  const id=session.characterID,shipID=session._space.shipID;
  if(!pos(id)||!pos(shipID))return null;
  let fleet,scene;try{fleet=fleetRuntime.getFleetForCharacter(id);
   scene=getScene(event.systemID,session)}catch{return null}
  if(!fleet||!pos(fleet.fleetID)||!(fleet.members instanceof Map)||
   fleet.members.size!==2||!fleet.members.has(id)||
   !fleetRuntime.getMemberRecord(fleet,id)||
   scene?.systemID!==event.systemID||
   typeof scene.getEntityByID!=="function"||
   typeof scene.sessions?.values!=="function")return null;
  const inScene=[...scene.sessions.values()];
  if(!inScene.includes(session))return null;
  const npc=scene.getEntityByID(event.entityID);
  if(npc?.kind!=="ship"||npc.nativeNpc!==true||
   npc.transient===true||npc.itemID!==event.entityID)return null;
  const pilots=[];
  for(const char of [...fleet.members.keys()].sort((a,b)=>a-b)){
   if(!pos(char)||!fleetRuntime.getMemberRecord(fleet,char))return null;
   const possible=sessions.filter(x=>x?.characterID===char&&inScene.includes(x)&&
    x.socket?.destroyed!==true&&x._space?.initialStateSent===true&&
    x._space?.systemID===event.systemID&&pos(x._space?.shipID));
   if(possible.length!==1)return null;
   const peer=possible[0],ship=scene.getEntityByID(peer._space.shipID);
   if(!ship||ship.kind!=="ship"||ship.nativeNpc===true||
    ship.itemID!==peer._space.shipID)return null;
   pilots.push({characterID:char,shipID:peer._space.shipID});
  }
  return pilots.length===2?{fleetID:fleet.fleetID,pilots}:null;
 }
 function status(eventID){
  if(!KEY(eventID))return block("INVALID_EVENT_ID");
  const d=load(pairFile(eventID));
  if(d.status!=="READY")return d;
  const p=d.value;
  if(p?.v!==1||p.eventID!==eventID||!pos(p.fleetID)||
   !pos(p.systemID)||!pos(p.entityID)||!pos(p.at)||
   !Array.isArray(p.pilots)||p.pilots.length!==2||
   p.pilots[0]?.characterID>=p.pilots[1]?.characterID||
   p.pilots.some(x=>!pos(x.characterID)||!pos(x.shipID)))
   return block("VOLUNTEER_JOURNAL_CORRUPT");
  return {status:"VERIFIED_NATIVE_DUO_VOLUNTEER",...p};
 }
 function volunteer(session,eventID){
  if(process.env.EVEJS_COOP_EVENT_VOLUNTEERS!=="1")return block("DISABLED");
  if(!KEY(eventID))return block("INVALID_EVENT_ID");
  let event;try{const read=readEvent(eventID);event=read?.event;
   if(read?.status!=="READY")return block("EVENT_NOT_AVAILABLE")}
  catch{return block("EVENT_SOURCE_UNAVAILABLE")}
  const now=clock();
  if(event.phase!=="ACTIVE"||event.expiresAt<=now)return block("EVENT_EXPIRED");
  const p=party(session,event);
  if(!p)return block("NOT_TWO_AUTHENTIC_NATIVE_PILOTS");
  const self=session.characterID;
  let interested;try{interested=readInterest(self,eventID)}
  catch{return block("INTEREST_PROOF_UNAVAILABLE")}
  if(interested?.status!=="INTEREST_RECORDED")return block("OPT_IN_INTEREST_REQUIRED");
  const prior=status(eventID);
  if(prior.status==="VERIFIED_NATIVE_DUO_VOLUNTEER")
   return block("DUO_ALREADY_CONFIRMED");
  if(prior.status!=="NOT_FOUND")return prior;
  const record={v:1,eventID,characterID:self,systemID:event.systemID,
   entityID:event.entityID,fleetID:p.fleetID,shipID:session._space.shipID,at:now};
  const old=load(file(eventID,self));
  if(old.status==="NOT_FOUND"){
   if(!durableNew(file(eventID,self),record))return block("CONSENT_WRITE_UNCERTAIN");
  }else if(old.status!=="READY"||old.value?.characterID!==self||
   old.value?.fleetID!==p.fleetID||old.value?.shipID!==record.shipID)
   return block("CONSENT_CHANGED_OR_CORRUPT");
  const accept=[];
  for(const pilot of p.pilots){
   const d=load(file(eventID,pilot.characterID));
   if(d.status==="NOT_FOUND")return {status:"WAITING_FOR_OTHER_VOLUNTEER",eventID};
   if(d.status!=="READY"||d.value?.v!==1||
    d.value.eventID!==eventID||d.value.characterID!==pilot.characterID||
    d.value.shipID!==pilot.shipID||d.value.fleetID!==p.fleetID||
    d.value.systemID!==event.systemID||d.value.entityID!==event.entityID)
    return block("VOLUNTEER_IDENTITY_CHANGED");
   accept.push(pilot);
  }
  const receipt={v:1,eventID,systemID:event.systemID,entityID:event.entityID,
   fleetID:p.fleetID,pilots:accept,at:now,
   scope:"VOLUNTEER_ONLY_NOT_CONTRACT_NOT_WARP_NOT_PAID"};
  if(!durableNew(pairFile(eventID),receipt))return block("PAIR_CONFIRMATION_UNCERTAIN");
  return {status:"VERIFIED_NATIVE_DUO_VOLUNTEER",eventID,
   fleetID:p.fleetID,characters:accept.map(x=>x.characterID),
   note:"Both pilots opted in; real NPC/fleet checked. Paid contract not accepted."};
 }
 return {volunteer,status};
}
let singleton;
function nativeVoluntaryOptIn(session,eventID,board){
 if(process.env.EVEJS_COOP_EVENT_VOLUNTEERS!=="1")return {status:"DISABLED"};
 try{
  if(!singleton){
   if(!board||typeof board.readEvent!=="function"||typeof board.readInterest!=="function")
    return {status:"NATIVE_BOARD_NOT_WIRED"};
   const sessions=require("../services/chat/sessionRegistry");
   const scenes=require("./runtime");
   const fleets=require("../services/fleets/fleetRuntime");
   singleton=createVolunteers({root:process.env.EVEJS_DATA_ROOT||"/var/lib/evejs",
    readEvent:id=>board.readEvent(id),readInterest:(characterID,id)=>board.readInterest(characterID,id),
    getSessions:()=>sessions.getSessions(),
    getScene:(_systemID,s)=>scenes.getSceneForSession(s),
    fleetRuntime:fleets});
  }
  return singleton.volunteer(session,eventID);
 }catch{return {status:"NATIVE_VOLUNTEER_GATE_UNAVAILABLE"}}
}
// Read-only persisted voluntary receipt. Native route still must have its own
// separate server-owned contract/wallet authority before debiting corporate ISK.
function readVerifiedNativePair(eventID){
 try{
  const verifier=createVolunteers({
   root:process.env.EVEJS_DATA_ROOT||"/var/lib/evejs",
   readEvent:()=>({status:"UNAVAILABLE"}),
   readInterest:()=>({status:"UNAVAILABLE"}),
   getSessions:()=>[],getScene:()=>null,
   fleetRuntime:{getFleetForCharacter:()=>null,getMemberRecord:()=>null}});
  return verifier.status(eventID);
 }catch{return {status:"NATIVE_DUO_RECEIPT_UNAVAILABLE"}}
}
module.exports={createVolunteers,nativeVoluntaryOptIn,readVerifiedNativePair};
