"use strict";
/**
 * CH24+31 Stage D1: EXISTING stock Agent contact as a read-only company
 * dispatcher and one explicit Accept -> native MINE order. Not a new mission.
 * No free fleet, agent, corporation, ore, ISK, or second scheduler.
 * Native missions + paid convoy job hook retain priority.
 */
const pos=x=>Number.isSafeInteger(x)&&x>0;
const say=(text,actions=[])=>({success:true,data:{agentSays:[String(text).slice(0,1400),null],
 actions,lastActionInfo:{missionCompleted:0,missionDeclined:0,missionQuit:0,
 missionCantReplay:0}}});
const safe=x=>String(x??"").replace(/[<>\x00-\x1f]/g," ").slice(0,130);
function createMiningAgent({getAgent,getMission,getSessions,getFleetRecords,
 inspectShift,assignOrder,getHirePreview=null,acceptHire=null,
 orderMenu=null,getMarketStatus=null,access,enabled=()=>false}={}){
 if([getAgent,getMission,getSessions,getFleetRecords,inspectShift,assignOrder,
  access?.isMember,access?.canIndustry,enabled].some(x=>typeof x!=="function")||
  (getHirePreview!==null&&typeof getHirePreview!=="function")||
  (acceptHire!==null&&typeof acceptHire!=="function")||
  (orderMenu!==null&&[orderMenu.enabled,orderMenu.interact].some(x=>typeof x!=="function"))||
  (getMarketStatus!==null&&typeof getMarketStatus!=="function"))
  throw Error("PLAYER_MINING_AGENT_NATIVE_AUTHORITIES_REQUIRED");
 function selected({session,agentID}={},options={}){
  if(enabled()!==true||!pos(agentID)||!pos(session?.characterID)||
   !pos(session?.userid)||!pos(session?.corporationID)||
   session.socket?.destroyed===true)return null;
  let agent,mission,online;
  try{agent=getAgent(agentID);mission=getMission(session.characterID,agentID);
   online=getSessions();}catch{return null;}
  if(!agent||agent.agentID!==agentID||!pos(agent.corporationID)||
   !pos(agent.solarSystemID)||!pos(agent.stationID)||
   agent.isInSpace===true||mission||!Array.isArray(online)||
   online.filter(x=>x===session).length!==1||
   online.filter(x=>x.characterID===session.characterID).length!==1)
   return null;
  if(access.isMember(session,session.corporationID)!==true)return null;
  let fleets;
  try{fleets=getFleetRecords(agent.solarSystemID)}catch{return null}
  if(!Array.isArray(fleets)||fleets.length>128)return null;
  const jobs=[],vacant=[];
  for(const f of fleets){
   if(!pos(f?.fleetID)||f.systemID!==agent.solarSystemID||
    f.source!=="startup")continue;
   let row;try{row=inspectShift({systemID:f.systemID,fleetID:f.fleetID})}
   catch{return null;}
   if(!row)vacant.push(f);
   if(row&&row.version===1&&row.status==="FUNDED"&&
    row.corporationID===session.corporationID&&
    row.employerCorpID===agent.corporationID&&
    row.systemID===agent.solarSystemID&&row.fleetID===f.fleetID)
    jobs.push(row);
  }
  if(!jobs.length){
   // Hiring is enabled only by a separate operator wage policy, not
   // inferred from an NPC ship existing. An Agent button never invents ISK.
   if(!getHirePreview||!acceptHire||vacant.length!==1)return null;
   const f=vacant[0];
   let proposal;try{proposal=getHirePreview({session,agentID,
    corporationID:session.corporationID,employerCorpID:agent.corporationID,
    systemID:f.systemID,fleetID:f.fleetID},{view:options.view===true})}
   catch{return null;}
   return proposal?.status==="AVAILABLE"&&proposal.quote?.fleetID===f.fleetID&&
    proposal.quote.corporationID===session.corporationID&&
    proposal.quote.employerCorpID===agent.corporationID?
     {offer:proposal.quote,agent}:null;
  }
  // New D3 stock Agent protocol keeps View read-only, Request Mission as
  // browse/selection, and Accept as explicit server-verified confirmation.
  // OFF by default; legacy D1 one-fleet behavior is unchanged when OFF.
  if(orderMenu?.enabled()===true&&
   access.canIndustry(session,session.corporationID)===true)
   return {menu:jobs,agent};
  // D1 fallback: refuse multi-fleet ambiguity without an authorized selector.
  if(jobs.length!==1)return {blocked:true,message:"Multiple verified mining shifts belong to this agent. No fleet was selected; no command was issued."};
  return {row:jobs[0],agent};
 }
 function display(j,session,detail=""){
  const r=j.row,manager=access.canIndustry(session,r.corporationID)===true;
  const seq=Number.isSafeInteger(r.commandSeq)?r.commandSeq:0;
  const started=r.directive==="MINE"&&r.commandState==="IDLE";
  const canActivate=manager&&(started||
   r.directive==="HOLD"&&r.commandState==="NATIVE_REQUESTED");
  const state="NPC mining fleet "+r.fleetID+" | original system "+r.systemID+
   " | miners "+(Array.isArray(r.minerIDs)?r.minerIDs.length:0)+
   " | haulers "+(Array.isArray(r.haulerIDs)?r.haulerIDs.length:0)+
   " | order "+safe(r.directive)+" | state "+safe(r.commandState)+
   " | revision "+seq+".";
  const money=manager?" Paid wage: "+(r.wageCents/100).toFixed(2)+
   " ISK (shift funding, NOT ore ownership).":"";
  let cashFlow="";
  if(manager&&getMarketStatus){try{
   const report=getMarketStatus({session,corporationID:r.corporationID,
    operationID:r.operationID});
   if(report?.status==="NATIVE_CORPORATE_SELL_UNSUPPORTED"&&
      Number.isSafeInteger(report.verifiedCashOutflowCents)&&
      report.verifiedCashOutflowCents>=0){
    cashFlow=" Verified scoped cash expenses: "+
     (report.verifiedCashOutflowCents/100).toFixed(2)+
     " ISK. Native corporation market SELL unavailable; "+
     "realized revenue and net profit remain unverified.";
   }
  }catch{/* A read-only market status failure must not change NPC orders. */}}
  const controls=manager&&canActivate?
   "\nAccept = request MINE/resume through the original native NPC tick. View = refresh. No automatic ore or ISK payout.":
   "\nView = refresh. Only a corporation industry manager may order the NPC fleet.";
  return say(state+money+cashFlow+controls+(detail?"\n"+safe(detail):""),
    canActivate?[[3,3],[1,1]]:[[1,1]]);
 }
 function doAction({session,agentID,actionID}={}){
  const view=actionID==null||Number(actionID)===1||Number(actionID)===2;
  const j=selected({session,agentID},{view});
  if(!j)return null; // stock missions and other existing agent jobs win
  if(j.blocked)return say(j.message);
  if(j.menu){
   let outcome;
   try{outcome=orderMenu.interact({session,agent:j.agent,rows:j.menu,actionID})}
   catch{return say("Native mining fleet selector unavailable. No order sent.",[[1,1]]);}
   return say(outcome?.description||
    "Native mining order refused: "+safe(outcome?.reason||outcome?.status||"UNAVAILABLE"),
    Array.isArray(outcome?.actions)?outcome.actions:[[1,1]]);
  }
  if(j.offer){
   const q=j.offer,manager=access.canIndustry(session,q.corporationID)===true;
   const intro="NPC employer "+q.employerCorpID+" offers "+q.minerCount+
    " original miners and "+q.haulerCount+" haulers in system "+q.systemID+
    ". Wage for "+q.cycles+" cycles: "+(q.wageCents/100).toFixed(2)+
    " ISK, paid immediately from corporation wallet 1000. "+
    "The employer retains ownership of all ore until a separately funded purchase.";
   if(view)return say(intro+(manager?
    " Accept = hire this exact fleet for that quoted wage. View = renew confirmation.":
    " Your corporation industry manager must approve and fund this hire."),
    manager?[[3,3],[1,1]]:[[1,1]]);
   if(Number(actionID)!==3&&Number(actionID)!==5)
    return say("Only View and Accept are supported; no NPC was hired.",[[1,1]]);
   if(!manager)return say("Corporation industry permission denied.",[[1,1]]);
   let outcome;try{outcome=acceptHire({session,agentID,
    corporationID:q.corporationID,employerCorpID:q.employerCorpID,
    systemID:q.systemID,fleetID:q.fleetID})}
   catch{return say("Native wage payment outcome unknown. Review the corporation wallet before repeating.",[[1,1]]);}
   return say(outcome?.status==="FUNDED"||outcome?.status==="ALREADY_FUNDED"?
    "Native mining shift "+safe(outcome.status)+
    ". Real corporation ISK was processed by the original GameStore. "+
    "Reopen this Agent contact to give the fleet its first command.":
    "Hire not completed: "+safe(outcome?.reason||outcome?.status||"UNAVAILABLE")+
    ". No fictional NPCs or cargo were created.",[[1,1]]);
  }
  if(view)
   return display(j,session);
  if(Number(actionID)!==3&&Number(actionID)!==5)
   return say("This mining agent permits View and Accept only; no native mission was changed.",[[1,1]]);
  const r=j.row;
  if(access.canIndustry(session,r.corporationID)!==true)
   return say("Corporation industry permission denied; no NPC order sent.",[[1,1]]);
  // Repeated Accept cannot cause a second paid shift or cargo write. The
  // original GameStore order CAS is the authority for one command sequence.
  if(r.directive==="MINE"&&r.commandState!=="IDLE"&&r.commandState!=="PENDING")
   return display(j,session,"Mining was already requested; command replay was not sent.");
  if(r.directive!=="HOLD"&&r.directive!=="MINE")
   return display(j,session,"Current command must complete before another request.");
  let result;
  try{result=assignOrder({session,corporationID:r.corporationID,
   systemID:r.systemID,fleetID:r.fleetID,operationID:r.operationID,
   command:"MINE",expectedSeq:r.commandSeq});}
  catch{return say("Native mining order authority unavailable. No NPC order sent.",[[1,1]]);}
  if(result?.status==="ORDER_QUEUED"||
     result?.status==="ALREADY_ORDERED")
   return say("Native mining command "+safe(result.status)+
    ". This proves a durable request only, not mining work, ore delivery or earnings.",
     [[1,1]]);
  return say("Native mining command refused: "+safe(result?.reason||result?.status||"UNAVAILABLE")+
   ". No other fleet was selected.",[[1,1]]);
 }
 function briefing({session,agentID}={}){
  const j=selected({session,agentID},{view:false});
  if(!j||j.blocked)return null;
  if(j.menu)return {"ContentID":null,"Mission Title ID":"NPC Mining Fleet Orders",
   "Mission Briefing ID":"A live native mining fleet order selector is available. "+
    "View Mission previews the selection, Request Mission browses exact "+
    "fleet and order pairs, Accept confirms only the currently previewed "+
    "order. Physical ships and GameStore command revision are rechecked.",
   "Mission Keywords":{},"Mission Image":null,"Decline Time":null,
   "Expiration Time":null,"AcceptTimestamp":null,"Mission ID":null};
  if(j.offer)return {"ContentID":null,"Mission Title ID":"NPC Mining Hire",
   "Mission Briefing ID":"NPC employer "+j.offer.employerCorpID+
    " offers original mining fleet "+j.offer.fleetID+
    " for "+(j.offer.wageCents/100).toFixed(2)+" ISK over "+
    j.offer.cycles+" cycles. Requires a native corporate wallet payment.",
   "Mission Keywords":{},"Mission Image":null,"Decline Time":null,
   "Expiration Time":null,"AcceptTimestamp":null,"Mission ID":null};
  const row=j.row;
  return {"ContentID":null,"Mission Title ID":"NPC Mining Company",
   "Mission Briefing ID":"Funded native corporate mining shift "+row.operationID+
    " in system "+row.systemID+". Current order "+safe(row.directive)+
    ". Native fleet orders are separate from cargo title, station sale and payroll.",
   "Mission Keywords":{},"Mission Image":null,"Decline Time":null,
   "Expiration Time":null,"AcceptTimestamp":null,"Mission ID":null};
 }
 return Object.freeze({doAction,briefing});
}
let singleton;
function native(){
 if(!singleton){
  const access=require("./coopPlayerCorporationAccess"),
   agents=require("../services/agent/agentAuthority"),
   missions=require("../services/agent/agentMissionRuntime"),
   sessions=require("../services/chat/sessionRegistry"),
   mining=require("../services/mining/miningNpcOperations"),
   fleet=require("./coopPlayerMiningFleetTick"),
   hiring=require("./coopPlayerMiningHiring"),
   marketReadiness=require("./coopPlayerMiningMarketReadiness"),
   orderMenu=require("./coopPlayerMiningAgentOrders");
  singleton=createMiningAgent({access,getAgent:agents.getAgentByID,
   getMission:missions.getMissionRecord,getSessions:sessions.getSessions,
   getFleetRecords:id=>mining.getMiningFleetsForSystem(id),
   inspectShift:fleet.inspect,assignOrder:fleet.assign,
   getHirePreview:hiring.preview,acceptHire:hiring.accept,
   getMarketStatus:marketReadiness.inspectNative,orderMenu,
   enabled:()=>process.env.EVEJS_COOP_PLAYER_NPC_MINING_AGENT==="1"&&
    process.env.EVEJS_COOP_PLAYER_NPC_MINING_COMPANY==="1"});
 }
 return singleton;
}
function doAction(args){
 if(process.env.EVEJS_COOP_PLAYER_NPC_MINING_AGENT!=="1")return null;
 try{return native().doAction(args)}catch{
  return null; // stock agent mission remains available
 }
}
function briefing(args){
 if(process.env.EVEJS_COOP_PLAYER_NPC_MINING_AGENT!=="1")return null;
 try{return native().briefing(args)}catch{return null;}
}
module.exports={createMiningAgent,doAction,briefing};
