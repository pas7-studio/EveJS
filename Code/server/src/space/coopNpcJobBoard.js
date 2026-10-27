"use strict";
// COOP-048: native job discovery and opt-in facade over existing verified
// Opportunity Board and paid Escort authorities. NEVER owns wallet writes.
// Reuse source event IDs; no fake tasks, prices, fleet or mission rewards.
const POS=x=>Number.isSafeInteger(x)&&x>0;
const ID=x=>typeof x==="string"&&/^(raid|convoy)-\d+-\d+-\d+$/.test(x);
const MAX=20;
const deny=(status,message)=>({status,message:"[Co-op Jobs] "+(message||status)});
function createJobBoard({listEvents,readEvent,readQuote,readAcceptance,delegate,clock=()=>Date.now()}={}){
 if([listEvents,readEvent,readQuote,readAcceptance,delegate,clock].some(x=>typeof x!=="function"))
  throw Error("NATIVE_JOB_BOARD_AUTHORITIES_REQUIRED");
 function verify(event){
  const now=clock();
  if(!Number.isSafeInteger(now)||now<=0||!event||!ID(event.id)||
   event.source!=="NATIVE_VERIFIED"||event.phase!=="ACTIVE"||
   !POS(event.systemID)||!POS(event.entityID)||
   !POS(event.createdAt)||!POS(event.expiresAt)||
   event.createdAt>now||event.expiresAt<=now||
   !["RAID","CONVOY"].includes(event.type))return null;
  if(event.id.startsWith("raid-")!== (event.type==="RAID"))return null;
  if(event.type==="CONVOY"&&!["PREPARING","EN_ROUTE"].includes(event.stage))
   return null;
  return event;
 }
 function inspect(raw){
  const e=verify(raw);
  if(!e)return null;
  const type=e.type==="CONVOY"?"TRADE_ESCORT":
   e.title.toLowerCase().includes("miner")?"MINER_RESCUE":"CONVOY_RESCUE";
  let quote=null,quoteStatus="NO_FUNDED_QUOTE";
  if(type==="TRADE_ESCORT"&&e.stage==="PREPARING"){
   let r;try{r=readQuote(e.id)}catch{return {event:e,type,status:"NATIVE_QUOTE_UNAVAILABLE",quote:null}};
   if(r?.status==="READY"){
    const q=r.quote;
    if(q?.eventID===e.id&&q.systemID===e.systemID&&q.haulerID===e.entityID&&
     q.stationID===e.stationID&&POS(q.corporationID)&&POS(q.amountISK)&&
     q.amountISK%2===0&&q.amountISK<=1000000000&&
     POS(q.expiresAt)&&q.expiresAt>clock()&&
     typeof q.contractID==="string"&&/^escort-[a-zA-Z0-9-]{1,48}$/.test(q.contractID)){
     quote={amountISK:q.amountISK,contractID:q.contractID,corporationID:q.corporationID};
     quoteStatus="QUOTE_VERIFIED_NOT_RESERVED";
    }else quoteStatus="QUOTE_PROVENANCE_INVALID";
   }else if(r?.status!=="PRICED_ESCORT_NATIVE_AUTHORITY_UNAVAILABLE"&&r?.status!=="NOT_FOUND"){
    quoteStatus="NATIVE_QUOTE_UNAVAILABLE";
   }
  }
  return {event:e,type,status:quoteStatus,quote};
 }
 function browse({all=false,systemID,filter="all"}={}){
  let result;try{result=listEvents({all,systemID,limit:MAX})}
  catch{return {status:"JOB_SOURCE_UNAVAILABLE",jobs:[]}};
  if(result?.status!=="READY"||!Array.isArray(result.events)||
   result.events.length>MAX)return {status:"JOB_SOURCE_UNTRUSTED",jobs:[]};
  const jobs=[];
  for(const event of result.events){
   const job=inspect(event);
   if(!job)continue;
   if(filter==="escort"&&job.type!=="TRADE_ESCORT")continue;
   if(filter==="miner"&&job.type!=="MINER_RESCUE")continue;
   if(filter==="rescue"&&job.type==="TRADE_ESCORT")continue;
   jobs.push(job);
  }
  return {status:"READY",jobs};
 }
 function get(eventID){
  if(!ID(eventID))return {status:"INVALID_JOB_ID"};
  let r;try{r=readEvent(eventID)}
  catch{return {status:"JOB_SOURCE_UNAVAILABLE"}}
  if(r?.status!=="READY")return {status:"JOB_NOT_AVAILABLE"};
  const job=inspect(r.event);
  return job?{status:"READY",job}:{status:"JOB_NOT_AVAILABLE"};
 }
 function forward(session,operation,eventID){
  let r;try{r=delegate({session,command:"events",argumentText:
   operation+(eventID?" "+eventID:"")})}
  catch{return deny("NATIVE_EVENT_ACTION_UNAVAILABLE")}
  return r&&typeof r.status==="string"&&typeof r.message==="string"?
   {status:r.status,message:r.message}:deny("NATIVE_EVENT_ACTION_UNAVAILABLE");
 }
 function handleChat({session,argumentText=""}={}){
  if(process.env.EVEJS_COOP_NPC_JOBS!=="1")return deny("DISABLED","Job Board is disabled.");
  if(!POS(session?.characterID)||session?.socket?.destroyed===true)
   return deny("UNAUTHENTICATED","Select a connected native character.");
  const args=String(argumentText).trim().split(/\s+/).filter(Boolean);
  const op=(args.shift()||"list").toLowerCase();
  const systemID=Number(session?._space?.systemID||session?.solarSystemID||session?.solarsystemid);
  if(op==="list"||op==="all"||op==="escort"||op==="miner"||op==="rescue"){
   if(op!=="all"&&!POS(systemID))
    return deny("NATIVE_SYSTEM_UNKNOWN","Current native solar system is unavailable.");
   const filter=["escort","miner","rescue"].includes(op)?op:
    ["escort","miner","rescue"].includes(args[0])?args[0]:"all";
   const r=browse({all:op==="all",systemID,filter});
   if(r.status!=="READY")return deny(r.status);
   if(!r.jobs.length)return {status:"READY",message:"[Co-op Jobs] No verified matching native work. No tasks or ISK were generated."};
   return {status:"READY",message:"[Co-op Jobs] Real native opportunities:\n"+
    r.jobs.slice(0,8).map(j=>j.event.id+" | "+j.type+" | system "+j.event.systemID+
     " | "+(j.quote?j.quote.amountISK.toLocaleString("en-US")+" ISK quoted (NOT RESERVED)":
      "UNPAID / NOT FUNDED")+
     " | /jobs info "+j.event.id).join("\n")};
  }
  if(op==="info"){
   const r=get(args[0]);
   if(r.status!=="READY")return deny(r.status);
   const j=r.job,e=j.event;
   return {status:"READY",message:"[Co-op Jobs] "+j.type+" | "+e.id+
    "\nSystem "+e.systemID+(POS(e.stationID)?" | station "+e.stationID:"")+
    " | ship "+e.entityID+"\n"+e.summary+
    "\n"+(j.quote?"Native NPC corporate quote: "+j.quote.amountISK+
      " ISK total, "+(j.quote.amountISK/2)+" ISK per pilot. "+
      "QUOTE ONLY — not reserved until native pre-warp funding.":
     "No verified paid contract; voluntary response only. Status: "+j.status)+
    "\n"+(j.quote?"For 2 real fleet pilots: /jobs interest "+e.id+
      ", /jobs volunteer "+e.id+", /jobs accept "+e.id:
      "To respond without a payment promise: /jobs interest "+e.id)};
  }
  if(op==="active"){
   const r=browse({all:true});
   if(r.status!=="READY")return deny(r.status);
   const signed=[];
   for(const j of r.jobs){
    if(!j.quote)continue;
    let a;try{a=readAcceptance(j.event.id)}catch{continue}
    if(a?.status==="DURABLE_TWO_PILOT_PAID_ACCEPTANCE"&&
      Array.isArray(a.characters)&&a.characters.includes(session.characterID)&&
      a.contractID===j.quote.contractID&&a.amountISK===j.quote.amountISK)
     signed.push(j.event.id+" | SIGNED (escrow/departure not established)");
   }
   return {status:"READY",message:"[Co-op Jobs] "+(signed.length?
    signed.join("\n"):"No signed native offers in currently visible active events.")};
  }
  if(op==="interest"||op==="volunteer"||op==="accept"){
   const r=get(args[0]);
   if(r.status!=="READY")return deny(r.status);
   if(op==="accept"&&(!r.job.quote||r.job.event.stage!=="PREPARING"))
    return deny("NO_VERIFIED_PAID_QUOTE",
     "Native funded-capable escort quote unavailable; refusing financial acceptance.");
   if(op==="volunteer"||op==="accept"){
    if(!POS(systemID)||systemID!==r.job.event.systemID)
     return deny("NATIVE_SYSTEM_MISMATCH","Travel to the actual NPC system first.");
   }
   return forward(session,op,r.job.event.id);
  }
  if(op==="watch"&&["local","all","off"].includes(args[0])){
   return forward(session,"watch",args[0]);
  }
  if(op==="history")return forward(session,"history");
  return {status:"HELP",message:"[Co-op Jobs] /jobs list|all|escort|miner|rescue | /jobs info <id> | /jobs interest <id> | /jobs volunteer <id> | /jobs accept <id> | /jobs active | /jobs history | /jobs watch local|all|off"};
 }
 return Object.freeze({browse,get,handleChat});
}
let singleton;
function handleChat(opts){
 if(process.env.EVEJS_COOP_NPC_JOBS!=="1")return deny("DISABLED","Job Board is disabled.");
 try{
  if(!singleton){
   const board=require("./coopWorldOpportunityBoard");
   const priced=require("./coopEscortPricedOffers");
   singleton=createJobBoard({
    listEvents:({all,systemID,limit})=>{
     // Existing board exports only readNativeEvent; its singleton public
     // list must be used so /jobs reads the SAME native events as /events.
     return board.listNativeEvents({all,systemID,limit});
    },
    readEvent:board.readNativeEvent,
    readQuote:priced.readVisibleQuote,
    readAcceptance:priced.readNativeAccepted,
    delegate:board.handleChat
   });
  }
  return singleton.handleChat(opts);
 }catch{return deny("NATIVE_JOB_BOARD_UNAVAILABLE")}
}
module.exports={createJobBoard,handleChat};
