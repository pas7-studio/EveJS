"use strict";
// FW-001: pure, fail-closed faction-war state transitions. No wallet, ship,
// ownerID, standing, structure or native combat mutation is permitted here.
const VERSION=1, MAX_EVENTS=10000, MAX_HISTORY=500;
const POS=x=>Number.isSafeInteger(x)&&x>0;
const KEY=x=>typeof x==="string"&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(x);
const clone=x=>structuredClone(x);
const own=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
const empty=()=>({version:VERSION,wars:{},territories:{},campaigns:{},enlistments:{},processed:{},history:[]});
const deny=(reason)=>({status:"BLOCKED",reason});
function validateState(s){
 if(!s||s.version!==VERSION||!["wars","territories","campaigns","enlistments","processed"].every(k=>
  s[k]&&typeof s[k]==="object"&&!Array.isArray(s[k]))||!Array.isArray(s.history)||
  s.history.length>MAX_HISTORY||Object.keys(s.processed).length>MAX_EVENTS)
  throw Error("FW_STATE_INVALID_OR_UNSUPPORTED");
 return true;
}
function transition(source,command,{now=Date.now(),proofs={}}={}){
 validateState(source);
 if(!command||!KEY(command.eventID)||typeof command.type!=="string"||
  !Number.isSafeInteger(now)||now<=0)return deny("INVALID_COMMAND");
 const signature=JSON.stringify(command),old=own(source.processed,command.eventID)?source.processed[command.eventID]:null;
 if(old)return old.signature===signature?{status:"DUPLICATE",receipt:clone(old.receipt),state:source}:
  deny("EVENT_ID_CONFLICT");
 if(Object.keys(source.processed).length>=MAX_EVENTS)return deny("EVENT_LEDGER_CAP_REACHED");
 const state=clone(source), verify=(name,details)=>{
  try{return proofs[name]?.(details)===true}catch{return false}
 };
 const {type,eventID}=command;
 let receipt;
 if(type==="DECLARE_WAR"){
  const {warID,attackerFactionID:a,defenderFactionID:b}=command;
  if(!KEY(warID)||!POS(a)||!POS(b)||a===b||own(state.wars,warID))return deny("INVALID_WAR");
  if(Object.values(state.wars).some(w=>w.state==="ACTIVE"&&
   ((w.attackerFactionID===a&&w.defenderFactionID===b)||
    (w.attackerFactionID===b&&w.defenderFactionID===a))))return deny("WAR_ALREADY_ACTIVE");
  if(!verify("declaration",{warID,attackerFactionID:a,defenderFactionID:b}))return deny("NATIVE_WAR_AUTHORITY_MISSING");
  state.wars[warID]={warID,attackerFactionID:a,defenderFactionID:b,state:"ACTIVE",declaredAt:now};
  receipt={warID,state:"ACTIVE"};
 }else if(type==="REGISTER_TERRITORY"){
  const {systemID,ownerFactionID}=command,existing=state.territories[String(systemID)];
  if(!POS(systemID)||!POS(ownerFactionID)||existing)return deny("TERRITORY_ALREADY_REGISTERED_OR_INVALID");
  if(!verify("territory",{systemID,ownerFactionID}))return deny("NATIVE_TERRITORY_AUTHORITY_MISSING");
  state.territories[String(systemID)]={systemID,originalOwnerFactionID:ownerFactionID,
   militaryControllerFactionID:ownerFactionID,state:"SECURE",revision:1,changedAt:now};
  receipt={systemID,militaryControllerFactionID:ownerFactionID,revision:1};
 }else if(type==="START_CAMPAIGN"){
  const {campaignID,warID,sourceSystemID,targetSystemID,supplyReservationID}=command;
  const war=state.wars[warID],src=state.territories[String(sourceSystemID)],
   dst=state.territories[String(targetSystemID)];
  if(!KEY(campaignID)||!KEY(warID)||!KEY(supplyReservationID)||
   own(state.campaigns,campaignID)||!POS(sourceSystemID)||!POS(targetSystemID)||
   sourceSystemID===targetSystemID||war?.state!=="ACTIVE"||
   src?.militaryControllerFactionID!==war.attackerFactionID||
   dst?.militaryControllerFactionID!==war.defenderFactionID||
   Object.values(state.campaigns).some(c=>c.targetSystemID===targetSystemID&&
    ["PREPARING","ASSAULT"].includes(c.state)))return deny("CAMPAIGN_PREREQUISITES_NOT_MET");
  const detail={campaignID,warID,attackerFactionID:war.attackerFactionID,
   sourceSystemID,targetSystemID,supplyReservationID};
  if(!verify("adjacency",detail)||!verify("supply",detail))return deny("NATIVE_ROUTE_OR_SUPPLY_UNVERIFIED");
  state.campaigns[campaignID]={...detail,state:"PREPARING",startedAt:now,
   objectiveEvidence:[],revision:1};
  state.territories[String(targetSystemID)]={...dst,state:"CONTESTED",revision:dst.revision+1,changedAt:now};
  receipt={campaignID,state:"PREPARING",targetSystemID};
 }else if(type==="BEGIN_ASSAULT"){
  const c=state.campaigns[command.campaignID];
  if(!c||c.state!=="PREPARING")return deny("CAMPAIGN_NOT_PREPARING");
  if(!verify("deployment",{campaign:c,proofID:command.proofID}))return deny("NATIVE_FLEET_DEPLOYMENT_UNVERIFIED");
  c.state="ASSAULT";c.revision++;c.assaultAt=now;
  receipt={campaignID:c.campaignID,state:c.state};
 }else if(type==="RECORD_OBJECTIVE"){
  const c=state.campaigns[command.campaignID];
  if(!c||c.state!=="ASSAULT"||!KEY(command.proofID)||
   !KEY(command.objectiveID))return deny("INVALID_ASSAULT_OBJECTIVE");
  if(!verify("objective",{campaign:c,objectiveID:command.objectiveID,
   proofID:command.proofID}))return deny("NATIVE_OBJECTIVE_UNVERIFIED");
  if(c.objectiveEvidence.some(x=>x.objectiveID===command.objectiveID))return deny("OBJECTIVE_ALREADY_RECORDED");
  if(c.objectiveEvidence.length>=32)return deny("OBJECTIVE_CAP_REACHED");
  c.objectiveEvidence.push({objectiveID:command.objectiveID,proofID:command.proofID,at:now});
  c.revision++;receipt={campaignID:c.campaignID,objectiveID:command.objectiveID};
 }else if(type==="CAPTURE_TERRITORY"){
  const c=state.campaigns[command.campaignID],war=c&&state.wars[c.warID],
   dst=c&&state.territories[String(c.targetSystemID)];
  if(!c||c.state!=="ASSAULT"||war?.state!=="ACTIVE"||
   dst?.militaryControllerFactionID!==war.defenderFactionID||
   !c.objectiveEvidence.length||!KEY(command.proofID))return deny("CAPTURE_PREREQUISITES_NOT_MET");
  if(!verify("capture",{campaign:c,war,territory:dst,proofID:command.proofID}))
   return deny("NATIVE_CAPTURE_UNVERIFIED");
  // Military control ONLY. Never alter SDE ownerID/station rights.
  state.territories[String(c.targetSystemID)]={...dst,
   militaryControllerFactionID:war.attackerFactionID,state:"OCCUPIED",
   revision:dst.revision+1,changedAt:now};
  c.state="OCCUPIED";c.revision++;c.captureProofID=command.proofID;
  receipt={campaignID:c.campaignID,systemID:c.targetSystemID,
   militaryControllerFactionID:war.attackerFactionID,
   territoryRevision:dst.revision+1,mode:"MILITARY_CONTROL_ONLY"};
 }else if(type==="END_WAR"){
  const war=state.wars[command.warID];
  if(!war||war.state!=="ACTIVE"||!KEY(command.proofID))return deny("WAR_NOT_ACTIVE");
  if(!verify("ceasefire",{war,proofID:command.proofID}))return deny("CEASEFIRE_UNVERIFIED");
  war.state="ENDED";war.endedAt=now;
  for(const c of Object.values(state.campaigns))if(c.warID===war.warID&&
   ["PREPARING","ASSAULT"].includes(c.state)){
    c.state="CANCELLED";c.revision++;
    const dst=state.territories[String(c.targetSystemID)];
    if(dst?.state==="CONTESTED")state.territories[String(c.targetSystemID)]={...dst,
     state:"SECURE",revision:dst.revision+1,changedAt:now};
   }
  receipt={warID:war.warID,state:"ENDED"};
 }else if(type==="ENLIST"){
  const {characterID,factionID,agentID}=command;
  if(!POS(characterID)||!POS(factionID)||!POS(agentID)||
   state.enlistments[String(characterID)]?.status==="ACTIVE")return deny("ENLISTMENT_UNAVAILABLE");
  if(!verify("enlistment",{characterID,factionID,agentID}))return deny("NATIVE_AGENT_ENLISTMENT_UNVERIFIED");
  const previous=state.enlistments[String(characterID)];
  if(previous?.cooldownUntil>now)return deny("ENLISTMENT_COOLDOWN");
  state.enlistments[String(characterID)]={characterID,factionID,status:"ACTIVE",rank:0,
   enlistedAt:now,cooldownUntil:0};
  receipt={characterID,factionID,status:"ACTIVE"};
 }else if(type==="LEAVE_MILITIA"){
  const e=state.enlistments[String(command.characterID)];
  if(!e||e.status!=="ACTIVE"||!KEY(command.proofID))return deny("NOT_ENLISTED");
  if(!verify("leave",{enlistment:e,proofID:command.proofID}))return deny("NATIVE_AGENT_LEAVE_UNVERIFIED");
  e.status="LEFT";e.leftAt=now;e.cooldownUntil=now+24*3600000;
  receipt={characterID:e.characterID,status:e.status,cooldownUntil:e.cooldownUntil};
 }else return deny("UNKNOWN_WAR_COMMAND");
 const result={status:"APPLIED",type,eventID,...receipt};
 state.processed[eventID]={signature,receipt:result};
 state.history.push({eventID,type,at:now,...receipt});
 if(state.history.length>MAX_HISTORY)state.history.splice(0,state.history.length-MAX_HISTORY);
 validateState(state);
 return {status:"APPLIED",receipt:result,state};
}
// The ONE definition of "this campaign's supply was explicitly waived": the
// opening writes exactly `paper-supply:<campaignID>` when the operator disabled
// funding (EVEJS_COOP_WAR_REQUIRE_FUNDING=0). Such a campaign may fly and fight,
// but no escrow exists, so no bounty can ever be paid from it. Every other id
// must be a real HELD treasury reservation.
const paperSupplyID=campaignID=>"paper-supply:"+String(campaignID||"");
const paperSupply=campaign=>
 campaign?.supplyReservationID===paperSupplyID(campaign?.campaignID);
// A full-state writer must never erase a record it never saw.
//
// Every war phase here does read -> change one thing -> write the WHOLE state, and the
// write is not conditional, so a phase that read a moment before another one wrote puts
// its older copy back. MEASURED on the live world: the opening published "war opened"
// every 30 seconds while the durable row kept answering with four campaigns, because the
// freshly opened campaign was erased by the next phase's stale copy.
//
// Wars and campaigns are never deleted by any phase - they change state (ENDED,
// CANCELLED, EXPIRED) - so keeping the stored records the caller does not carry is
// lossless. Territories are deliberately NOT merged: releasing ground is a real
// bootstrap action and must still be able to remove one.
function mergeWarRecords(before,next){
 if(!before||!next)return next;
 const merge=(left,right)=>Object.assign({},left||{},right||{});
 return Object.assign({},next,{
  wars:merge(before.wars,next.wars),
  campaigns:merge(before.campaigns,next.campaigns),
 });
}

module.exports={VERSION,MAX_EVENTS,empty,validateState,transition,
 paperSupply,paperSupplyID,mergeWarRecords};
