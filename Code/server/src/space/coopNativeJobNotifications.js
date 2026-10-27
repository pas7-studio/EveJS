"use strict";
// Native EVEmail: tell opted-in pilots about a REAL corporate priced convoy
// and an ACTUAL SDE agent they can contact through the stock EVE client.
// Claim-before-send gives at-most-once dispatch even on lost mail ACK.
const fs=require("node:fs"),path=require("node:path");
const pos=x=>Number.isSafeInteger(x)&&x>0;
const ID=x=>typeof x==="string"&&/^convoy-\d+-\d+-\d+$/.test(x);
const blocked=status=>({status,sent:0});
function createJobNotifications({root,io=fs,clock=()=>Date.now(),
 readEvent,agentsForCorporation,getSessions,watch,sendNativeMail}={}){
 if(typeof root!=="string"||!path.isAbsolute(root)||[
  clock,readEvent,agentsForCorporation,getSessions,watch,sendNativeMail
 ].some(x=>typeof x!=="function"))throw Error("NATIVE_JOB_MAIL_AUTHORITIES_REQUIRED");
 const dir=path.join(root,"coop-opportunities","native-job-agent-mail");
 function claimPath(eventID,characterID){
  return path.join(dir,eventID+"-"+characterID+".json");
 }
 function readClaim(eventID,characterID){
  let data;try{data=io.readFileSync(claimPath(eventID,characterID),"utf8")}
  catch(e){return {status:e?.code==="ENOENT"?"NOT_FOUND":"CLAIM_READ_UNAVAILABLE"}}
  if(typeof data!=="string"||data.length>1024||!data.endsWith("\n"))
   return {status:"CLAIM_CORRUPT"};
  let row;try{row=JSON.parse(data.trim())}
  catch{return {status:"CLAIM_CORRUPT"}}
  if(row?.v!==1||row.eventID!==eventID||row.characterID!==characterID||
   !pos(row.at)||!["PREPARED","SENT"].includes(row.state)||
   row.state==="SENT"&&!pos(row.messageID))
   return {status:"CLAIM_CORRUPT"};
  return {status:row.state==="SENT"?"ALREADY_SENT":"SEND_UNCERTAIN"};
 }
 function claim(eventID,characterID){
  // A completed durable claim is an ordinary duplicate, not an error.
  const previous=readClaim(eventID,characterID);
  if(previous.status!=="NOT_FOUND")return previous;
  const file=claimPath(eventID,characterID);
  let fd,dirfd;
  try{
   io.mkdirSync(dir,{recursive:true});
   const contents=Buffer.from(JSON.stringify({v:1,eventID,characterID,
    state:"PREPARED",at:clock()})+"\n");
   fd=io.openSync(file,"wx",0o600);
   if(io.writeSync(fd,contents,0,contents.length,null)!==contents.length)
    return {status:"CLAIM_WRITE_UNCERTAIN"};
   io.fsyncSync(fd);io.closeSync(fd);fd=undefined;
   dirfd=io.openSync(dir,"r");io.fsyncSync(dirfd);
   return {status:"CLAIMED"};
  }catch(e){
   return e?.code==="EEXIST"?readClaim(eventID,characterID):
    {status:"CLAIM_WRITE_UNCERTAIN"};
  }finally{
   if(fd!==undefined)try{io.closeSync(fd)}catch{}
   if(dirfd!==undefined)try{io.closeSync(dirfd)}catch{}
  }
 }
 function markSent(eventID,characterID,messageID){
  if(!pos(messageID))return false;
  if(readClaim(eventID,characterID).status!=="SEND_UNCERTAIN")return false;
  const target=claimPath(eventID,characterID),temp=target+".sent.tmp";
  let fd,dirfd;
  try{
   const contents=Buffer.from(JSON.stringify({v:1,eventID,characterID,
    state:"SENT",at:clock(),messageID})+"\n");
   fd=io.openSync(temp,"wx",0o600);
   if(io.writeSync(fd,contents,0,contents.length,null)!==contents.length)
    return false;
   io.fsyncSync(fd);io.closeSync(fd);fd=undefined;
   io.renameSync(temp,target);
   dirfd=io.openSync(dir,"r");io.fsyncSync(dirfd);
   return readClaim(eventID,characterID).status==="ALREADY_SENT";
  }catch{return false}
  finally{
   if(fd!==undefined)try{io.closeSync(fd)}catch{}
   if(dirfd!==undefined)try{io.closeSync(dirfd)}catch{}
  }
 }
 function notify(q){
  if(process.env.EVEJS_COOP_NATIVE_JOB_AGENT!=="1"||
   process.env.EVEJS_COOP_OPPORTUNITY_MAIL!=="1")
   return blocked("DISABLED");
  const now=clock();
  if(!ID(q?.eventID)||!pos(q?.systemID)||!pos(q?.stationID)||
   !pos(q?.haulerID)||!pos(q?.corporationID)||!pos(q?.amountISK)||
   q.amountISK>1000000000||q.amountISK%2!==0||
   !pos(q.expiresAt)||q.expiresAt<=now)return blocked("INVALID_NATIVE_QUOTE");
  let e,agents,sessions;
  try{
   e=readEvent(q.eventID);
   agents=agentsForCorporation(q.corporationID);
   sessions=getSessions();
  }catch{return blocked("NATIVE_JOB_NOTICE_AUTHORITIES_UNAVAILABLE")}
  const event=e?.event;
  if(e?.status!=="READY"||event?.id!==q.eventID||
   event?.phase!=="ACTIVE"||event?.stage!=="PREPARING"||
   event?.type!=="CONVOY"||event?.source!=="NATIVE_VERIFIED"||
   event?.systemID!==q.systemID||event?.stationID!==q.stationID||
   event?.entityID!==q.haulerID||event.expiresAt!==q.expiresAt)
   return blocked("NATIVE_EVENT_QUOTE_MISMATCH");
  if(!Array.isArray(agents)||!Array.isArray(sessions))
   return blocked("NATIVE_AGENT_OR_SESSION_UNAVAILABLE");
  const matches=agents.filter(a=>pos(a?.agentID)&&a.corporationID===q.corporationID&&
   a.solarSystemID===q.systemID&&pos(a.stationID)&&a.isInSpace!==true)
   .sort((a,b)=>a.agentID-b.agentID);
  if(!matches.length)return blocked("NO_REAL_SDE_CORPORATE_AGENT");
  const agent=matches[0],name=String(agent.ownerName||"corporate agent")
   .replace(/[<>\x00-\x1f]/g," ").slice(0,80);
  const body="Verified NPC convoy preparing in solar system "+q.systemID+
   " for station "+q.stationID+".\n"+
   "Corporate quote: "+q.amountISK.toLocaleString("en-US")+
   " ISK total, two pilots (not reserved or guaranteed).\n"+
   "In the game, open the Agents list and contact "+name+
   " (agent ID "+agent.agentID+", station "+agent.stationID+"). "+
   "Use the agent dialogue's native Accept button. Both pilots must consent "+
   "independently in an actual fleet. The server reserves ISK only at genuine "+
   "prewarp funding; completed cargo delivery is separately verified.";
  let sent=0,uncertain=0;const seen=new Set();
  for(const s of sessions){
   const id=s?.characterID,system=s?._space?.systemID;
   if(!pos(id)||seen.has(id)||s?.socket?.destroyed===true)continue;
   seen.add(id);
   let sub;try{sub=watch(id)}catch{uncertain++;continue}
   if(sub?.status!=="READY"||sub.mode==="off"||
    sub.mode==="local"&&system!==q.systemID||
    !["local","all"].includes(sub.mode))continue;
   const receipt=claim(q.eventID,id);
   if(receipt.status==="ALREADY_SENT")continue;
   if(receipt.status!=="CLAIMED"){uncertain++;continue}
   let ack;try{ack=sendNativeMail(id,{title:"Corporate Escort: "+name,body,
    eventID:q.eventID,agentID:agent.agentID})}catch{uncertain++;continue}
   if(ack?.success===true&&pos(Number(ack.messageID))&&
    markSent(q.eventID,id,Number(ack.messageID)))sent++;
   else uncertain++;
  }
  return {status:uncertain?"MAIL_PARTIAL_OR_UNCERTAIN":"NATIVE_AGENT_MAIL_DISPATCHED",
   sent,uncertain,agentID:agent.agentID};
 }
 return Object.freeze({notify});
}
let singleton;
function notifyNativeQuote(quote){
 if(process.env.EVEJS_COOP_NATIVE_JOB_AGENT!=="1"||
  process.env.EVEJS_COOP_OPPORTUNITY_MAIL!=="1")return blocked("DISABLED");
 try{
  if(!singleton){
   const agents=require("../services/agent/agentAuthority");
   const board=require("./coopWorldOpportunityBoard");
   const registry=require("../services/chat/sessionRegistry");
   const mail=require("../services/mail/mailState");
   singleton=createJobNotifications({
    root:process.env.EVEJS_DATA_ROOT||"/var/lib/evejs",
    readEvent:board.readNativeEvent,
    agentsForCorporation:agents.listAgentsByCorporationID,
    getSessions:registry.getSessions,
    watch:characterID=>board.readNativeWatch(characterID),
    sendNativeMail:(characterID,m)=>mail.sendMail({
     senderID:mail.resolveWelcomeSenderID(),toCharacterIDs:[characterID],
     saveSenderCopy:false,title:m.title,body:m.body
    })
   });
  }
  return singleton.notify(quote);
 }catch{return blocked("NATIVE_JOB_NOTICE_UNAVAILABLE")}
}
module.exports={createJobNotifications,notifyNativeQuote};