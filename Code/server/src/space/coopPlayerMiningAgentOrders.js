"use strict";
/**
 * CH24+31 D3. Stock EveJS agent UI only: View Mission (1) shows selection,
 * Request Mission (2) cycles among verified fleet+order pairs, Accept (3)
 * confirms ONE session-pinned CAS. No made-up client button IDs or RPC.
 * No second scheduler or stateful source of truth; every order ultimately
 * goes through coopPlayerMiningShiftOrders and the original mining NPC tick.
 */
const pos=x=>Number.isSafeInteger(x)&&x>0;
const COMMAND_PRIORITY=Object.freeze(["MINE","HOLD","HAUL","RETREAT"]);
const SAFE_STATES=new Set(["IDLE","NATIVE_REQUESTED","NATIVE_COMPLETED"]);
const TTL_MS=120000;
function availableCommands(row){
 if(!row||row.version!==1||row.status!=="FUNDED"||
   !pos(row.corporationID)||!pos(row.employerCorpID)||
   !pos(row.systemID)||!pos(row.fleetID)||
   !/^coop-mining-shift:[0-9a-f]{32}$/.test(row.operationID||"")||
   !Number.isSafeInteger(row.commandSeq)||row.commandSeq<0||
   !SAFE_STATES.has(row.commandState))return [];
 if(row.commandState==="NATIVE_COMPLETED"){
  // This is the only HAUL/RETREAT replay gate: the original native tick
  // atomically stored independent warehouse/warp physical evidence.
  if(row.directive==="HAUL"&&
    (row.nativeState===undefined||row.nativeState==="mining"))return ["MINE"];
  if(row.directive==="RETREAT"&&
    (row.nativeState===undefined||row.nativeState==="retreating"))return ["MINE"];
  return [];
 }
 if(row.commandState==="IDLE")
  return row.directive==="MINE"&&
   (row.nativeState===undefined||row.nativeState==="mining")?["MINE"]:[];
 if(row.directive==="MINE"){
  if(["hauling","loaded","haulereturn"].includes(row.nativeState))
   return ["HOLD"]; // safe deferral, never abort original cargo custody
  if(["aggressed","panic"].includes(row.nativeState))
   return ["RETREAT"]; // original NPC combat owns all other actions
  if(row.nativeState!==undefined&&row.nativeState!=="mining")return [];
  return ["HOLD","HAUL","RETREAT"];
 }
 if(row.directive==="HOLD"){
  if(row.nativeState!==undefined&&row.nativeState!=="coop-hold")return [];
  return ["MINE","RETREAT"];
 }
 return []; // HAUL/RETREAT native outcome not independently reconciled yet.
}
function createMiningAgentOrderMenu({assignOrder,access,clock=()=>Date.now(),
 enabled=()=>false,verifyAgentContact=()=>false,observe=()=>{}}={}){
 if([assignOrder,access?.isMember,access?.canIndustry,clock,enabled,
   verifyAgentContact,observe].some(f=>typeof f!=="function"))
  throw Error("MINING_AGENT_ORDER_AUTHORITIES_REQUIRED");
 const selection=new WeakMap();
 const denied=(reason)=>({status:"BLOCKED",reason,actions:[[1,1]]});
 function options({session,agent,rows}){
  if(enabled()!==true||!session||typeof session!=="object"||
   !pos(session.characterID)||!pos(session.userid)||
   !pos(session.corporationID)||session.socket?.destroyed===true||
   !pos(agent?.agentID)||!pos(agent?.stationID)||!pos(agent?.solarSystemID)||
   !pos(agent?.corporationID)||!Array.isArray(rows)||rows.length>128||
   access.isMember(session,session.corporationID)!==true||
   access.canIndustry(session,session.corporationID)!==true||
   verifyAgentContact(session,agent)!==true)return null;
  const result=[],seen=new Set();
  for(const row of rows){
   if(row?.corporationID!==session.corporationID||
      row?.employerCorpID!==agent.corporationID||
      row?.systemID!==agent.solarSystemID)return null;
   if(seen.has(row.fleetID))return null;
   seen.add(row.fleetID);
   for(const command of availableCommands(row))
    result.push({version:1,agentID:agent.agentID,corporationID:row.corporationID,
     systemID:row.systemID,fleetID:row.fleetID,operationID:row.operationID,
     command,expectedSeq:row.commandSeq});
  }
  result.sort((a,b)=>a.fleetID-b.fleetID||
   COMMAND_PRIORITY.indexOf(a.command)-COMMAND_PRIORITY.indexOf(b.command));
  return result.length&&result.length<=384?result:[];
 }
 const signature=x=>[x.agentID,x.corporationID,x.systemID,x.fleetID,
   x.operationID,x.command,x.expectedSeq].join(":");
 function show(selected,index,total,mode){
  const title=selected?"Fleet "+selected.fleetID+" / "+
   selected.command+" / revision "+selected.expectedSeq:"No safe native fleet orders";
  return {status:mode,description:selected?
   title+". "+(index+1)+"/"+total+
   ". Request Mission = next fleet/order; View Mission = inspect; "+
   "Accept = confirm this exact order once. Native haul and retreat "+
   "need physical game-state verification, not an immediate delivery.":title,
   actions:selected?[[2,2],[3,3],[1,1]]:[[1,1]],
   selected};
 }
 function interact({session,agent,rows,actionID}={}){
  const choices=options({session,agent,rows});
  if(choices===null)return denied("CORPORATION_OR_STATION_AUTHORITY_DENIED");
  if(choices.length===0)return {status:"NO_SAFE_ORDER",
   description:"No safe NPC mining order while a native command is pending, hauling or unreconciled.",
   actions:[[1,1]]};
  const now=clock();
  if(!pos(now))return denied("MINING_AGENT_CLOCK_INVALID");
  const previous=selection.get(session),valid=previous&&
   previous.agentID===agent.agentID&&
   previous.corporationID===session.corporationID&&
   previous.characterID===session.characterID&&
   previous.userid===session.userid&&now>=previous.createdAt&&
   now<previous.expiresAt&&choices.some(q=>signature(q)===previous.signature);
  const currentIndex=valid?choices.findIndex(q=>signature(q)===previous.signature):0;
  const view=actionID===null||actionID===undefined||Number(actionID)===1;
  const next=Number(actionID)===2;
  const accept=Number(actionID)===3;
  if(accept){
   if(!valid)return denied("REOPEN_NATIVE_AGENT_TO_CONFIRM_ORDER");
   // A pending native warp/haul ACK is NEVER followed by an automatic retry.
   selection.delete(session);
   let receipt;
   try{receipt=assignOrder({...choices[currentIndex],session});}
   catch{return denied("NATIVE_MINING_ORDER_OUTCOME_UNKNOWN");}
   const status=receipt?.status;
   try{observe("player-mining-agent-order",{
    status:status||"UNKNOWN",systemID:choices[currentIndex].systemID,
    fleetID:choices[currentIndex].fleetID,
    operationID:choices[currentIndex].operationID,
    command:choices[currentIndex].command,characterID:session.characterID});}catch{}
   if(status==="ORDER_QUEUED"||status==="ALREADY_ORDERED")
    return {status,description:"Native "+choices[currentIndex].command+
     " order "+status+". Original mining tick still owns actual ships and cargo.",
     actions:[[1,1]]};
   return denied("NATIVE_ORDER_REFUSED:"+String(receipt?.reason||status||"UNAVAILABLE").slice(0,80));
  }
  if(!view&&!next)return denied("UNSUPPORTED_STOCK_AGENT_ACTION");
  if(next&&!valid)return denied("VIEW_AGENT_BEFORE_SELECTING_COMMAND");
  const index=next?(currentIndex+1)%choices.length:currentIndex;
  const chosen=choices[index];
  // This is only an ephemeral UI selection, never an authoritative
  // dispatch receipt. A restart or relogin requires fresh View.
  selection.set(session,{agentID:agent.agentID,
   corporationID:session.corporationID,characterID:session.characterID,
   userid:session.userid,signature:signature(chosen),
   createdAt:now,expiresAt:now+TTL_MS});
  return show(chosen,index,choices.length,next?"SELECTED":"PREVIEW");
 }
 return Object.freeze({interact,availableCommands,enabled,mode:"STOCK_AGENT_EXPLICIT_SELECTION"});
}
function native(){
 const fleet=require("./coopPlayerMiningFleetTick"),flags=require("./coopFlags");
 const {getDockedLocationID}=require("../services/structure/structureLocation");
 return createMiningAgentOrderMenu({
  assignOrder:fleet.assign,
  access:require("./coopPlayerCorporationAccess"),
  verifyAgentContact:(session,agent)=>getDockedLocationID(session)===agent.stationID,
  enabled:()=>flags.on("EVEJS_COOP_PLAYER_NPC_MINING_ORDERS_UI")&&
   flags.on("EVEJS_COOP_PLAYER_NPC_MINING_COMPANY")&&
   flags.on("EVEJS_COOP_PLAYER_NPC_MINING_AGENT"),
  observe:(event,payload)=>{
   require("./coopObserve").observe(require("./coopRuntimeProbe"),
    event,{systemID:payload.systemID},payload);
  }
 });
}
let singleton;
function handler(){
 if(!singleton)singleton=native();
 return singleton;
}
function enabled(){
 return require("./coopFlags").on("EVEJS_COOP_PLAYER_NPC_MINING_ORDERS_UI");
}
function interact(payload){
 if(!enabled())return null;
 try{return handler().interact(payload)}
 catch{return {status:"BLOCKED",reason:"MINING_AGENT_ORDER_UNAVAILABLE",
  actions:[[1,1]]};}
}
module.exports={createMiningAgentOrderMenu,availableCommands,interact,enabled};
