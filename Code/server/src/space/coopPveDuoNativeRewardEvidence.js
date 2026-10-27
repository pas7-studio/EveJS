"use strict";
// PVE-005B. Read-only evidence from the ORIGINAL agent, wallet, LP,
// standings and native personal mission history. Never pay, retry, roll
// back or manufacture a mission reward. Capture both sides synchronously.
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const num=x=>typeof x==="number"&&Number.isFinite(x)?x:null;
const pennies=x=>Number.isFinite(x)?Math.round((x+Number.EPSILON)*100):null;
const seq=x=>id(x);
const str=x=>x==null?"":String(x).trim();
function historyMatch(h,mission,agentID){
 return h&&seq(h.missionSequence)===seq(mission?.missionSequence)&&
  id(h.agentID)===id(agentID)&&
  str(h.contentID)===str(mission?.contentID)&&
  str(h.missionTemplateID)===str(mission?.missionTemplateID)&&
  h.runtimeStatus==="completed";
}
function capture({characterID,agentID,getWallet,getJournal,getLP,getAgent,
 getMissionState,getStanding}={}){
 const char=id(characterID),agent=id(agentID);
 if(!char||!agent||[getWallet,getJournal,getLP,getAgent,getMissionState,
  getStanding].some(fn=>typeof fn!=="function"))
  return {status:"REWARD_SOURCE_APIS_UNAVAILABLE"};
 try{
  const authority=getAgent(agent);
  const corporationID=id(authority?.corporationID);
  if(id(authority?.agentID)!==agent||!corporationID)
   return {status:"REWARD_AGENT_CORPORATION_UNKNOWN"};
  const wallet=getWallet(char),history=getMissionState(char);
  const journal=getJournal(char),lp=getLP(char,corporationID);
  if(!wallet||!Number.isFinite(wallet.balance)||
     !Array.isArray(journal)||journal.length>10000||
     !history||!Array.isArray(history.history)||
     !Number.isSafeInteger(lp)||lp<0)
   return {status:"REWARD_NATIVE_SNAPSHOT_UNAVAILABLE"};
  const standingOwnerIDs=[id(authority.agentID),corporationID,
   id(authority.factionID)].filter(Boolean);
  const uniqueStandingIDs=[...new Set(standingOwnerIDs)];
  const standings={};
  for(const owner of uniqueStandingIDs){
   const raw=getStanding(char,owner);
   if(!Number.isFinite(raw))return {status:"REWARD_STANDING_SOURCE_UNAVAILABLE"};
   standings[owner]=raw;
  }
  const journalIds=journal.map(row=>id(row?.transactionID));
  if(journalIds.some(x=>!x)||new Set(journalIds).size!==journalIds.length)
   return {status:"REWARD_NATIVE_JOURNAL_AMBIGUOUS"};
  return {status:"NATIVE_REWARD_SNAPSHOT",characterID:char,agentID:agent,
   corporationID,isk:wallet.balance,lp,
   journal:journal.map(row=>({...row})),
   history:history.history.map(row=>({...row})),standings};
 }catch{return {status:"REWARD_NATIVE_SNAPSHOT_UNAVAILABLE"}}
}
function assess({before,after,mission,characterID,agentID,nativeResult,
 personalMissionRemaining}={}){
 const char=id(characterID),agent=id(agentID);
 const response={status:"NATIVE_REWARD_EVIDENCE_UNVERIFIED",
  characterID:char,agentID:agent};
 if(!char||!agent||before?.status!=="NATIVE_REWARD_SNAPSHOT"||
  after?.status!=="NATIVE_REWARD_SNAPSHOT"||
  before.characterID!==char||after.characterID!==char||
  before.agentID!==agent||after.agentID!==agent||
  before.corporationID!==after.corporationID||
  !id(mission?.missionSequence)||id(mission.agentID)!==agent)
  return {...response,status:"NATIVE_REWARD_SOURCE_MISMATCH"};
 if(nativeResult?.success!==true||personalMissionRemaining!==null)
  return {...response,status:"NATIVE_PERSONAL_MISSION_NOT_CLEARED"};
 const historyBefore=before.history.filter(row=>historyMatch(row,mission,agent));
 const historyAfter=after.history.filter(row=>historyMatch(row,mission,agent));
 if(historyBefore.length!==0||historyAfter.length!==1)
  return {...response,status:"PERSONAL_NATIVE_MISSION_HISTORY_NOT_NEW"};
 const oldIds=new Set(before.journal.map(row=>row.transactionID));
 const newEntries=after.journal.filter(row=>!oldIds.has(row.transactionID));
 const expectedEntries= newEntries.filter(row=>id(row?.referenceID)===agent&&
  Number(row?.entryTypeID)===3&&id(row.ownerID1)===before.corporationID&&
  id(row.ownerID2)===char&&
  typeof row.description==="string"&&
  row.description.startsWith("Agent mission reward:"));
 if(expectedEntries.length!==1)
  return {...response,status:"NATIVE_ISK_MISSION_JOURNAL_NOT_UNIQUE"};
 const entry=expectedEntries[0],earned=pennies(entry.amount),
  balanceDelta=pennies(after.isk-before.isk);
 if(earned===null||balanceDelta===null||earned<0||
    balanceDelta!==earned||pennies(entry.balance)!==pennies(after.isk))
  return {...response,status:"NATIVE_ISK_LEDGER_BALANCE_MISMATCH"};
 const rewards=mission.rewards||{};
 const base=num(rewards.isk??0),bonus=num(rewards.bonusIsk??0);
 if(base===null||bonus===null||base<0||bonus<0||
    ![pennies(base),pennies(base+bonus)].includes(earned))
  return {...response,status:"NATIVE_ISK_REWARD_AMOUNT_MISMATCH"};
 const targetLP=Number(rewards.loyaltyPoints||0);
 const actualLP=after.lp-before.lp;
 if(!Number.isSafeInteger(targetLP)||targetLP<0||
    !Number.isSafeInteger(actualLP)||actualLP!==targetLP)
  return {...response,status:"NATIVE_LP_BALANCE_MISMATCH"};
 const beforeStanding=before.standings||{},afterStanding=after.standings||{};
 const ids=Object.keys(beforeStanding);
 if(ids.length===0||ids.length!==Object.keys(afterStanding).length||
  ids.some(owner=>!Object.prototype.hasOwnProperty.call(afterStanding,owner)||
   !Number.isFinite(beforeStanding[owner])||
   !Number.isFinite(afterStanding[owner])))
  return {...response,status:"NATIVE_STANDING_SNAPSHOT_MISMATCH"};
 const standings=ids.map(owner=>({ownerID:Number(owner),
  before:beforeStanding[owner],after:afterStanding[owner],
  observedDelta:afterStanding[owner]-beforeStanding[owner]}));
 return {...response,status:"NATIVE_PERSONAL_REWARD_SOURCE_VERIFIED",
  missionSequence:seq(mission.missionSequence),
  corporationID:before.corporationID,historyAdded:true,
  originalMissionJournalTransactionID:entry.transactionID,
  iskDelta:earned/100,lpDelta:actualLP,
  standings,
  // No native item reward inventory witness: item grants may be valid,
  // but this report MUST NOT assert physical reward item custody.
  itemsVerified:false,standingMutationReceiptVerified:false,
  evidence:"SOURCE_NATIVE_WALLET_JOURNAL_AND_LP_BALANCE_AND_PERSONAL_MISSION_HISTORY"};
}
function nativeAdapters(){
 const wallet=require("../services/account/walletState"),
  lp=require("../services/corporation/lpWalletState"),
  agent=require("../services/agent/agentAuthority"),
  state=require("../services/agent/missionRuntimeState"),
  standing=require("../services/character/standingRuntime");
 return {getWallet:char=>wallet.getCharacterWallet(char),
  getJournal:char=>wallet.getCharacterWalletJournal(char),
  getLP:(char,corp)=>lp.getCharacterWalletLPBalance(char,corp),
  getAgent:agentID=>agent.getAgentByID(agentID),
  getMissionState:char=>state.getCharacterStateSnapshot(char),
  getStanding:(char,owner)=>standing.getCharacterRawStanding(char,owner)};
}
function snapshot(characterID,agentID){
 try{return capture({characterID,agentID,...nativeAdapters()})}
 catch{return {status:"REWARD_NATIVE_SNAPSHOT_UNAVAILABLE"}}
}
module.exports={capture,assess,snapshot,historyMatch};
