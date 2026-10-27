"use strict";
// Read-only evidence evaluator; all numbers MUST come from real native
// queue snapshots, native clone authority, and separately observed client ETAs.
// Never use this evaluator as a source of SP, skill levels or clone entitlement.
const FILETIME_TICKS_PER_MINUTE = 600000000n;
const int = v => Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):0;
function auditPilot({characterID,accountID,globalRate,omega,primary,secondary,
 queueSnapshot,observedClientEndTime,observedClientCloneGrade}={}) {
 const character=int(characterID),account=int(accountID);
 const rate=Number(globalRate),p=Number(primary),s=Number(secondary);
 if(!character||!account||!Number.isFinite(rate)||rate<=0||
  !Number.isFinite(p)||p<=0||!Number.isFinite(s)||s<=0||
  typeof omega!=="boolean")return {status:"NATIVE_SKILL_EVIDENCE_INVALID"};
 const entry=queueSnapshot?.currentEntry;
 if(!queueSnapshot || Number(queueSnapshot.characterID)!==character ||
  queueSnapshot.active!==true||!entry)return {status:"NATIVE_QUEUE_NOT_ACTIVE"};
 const reported=Number(entry.skillPointsPerMinute);
 const expected=(p+s/2)*rate*(omega?1:0.5);
 if(!Number.isFinite(reported)||Math.abs(expected-reported)>1e-7)
  return {status:"SERVER_SP_RATE_MISMATCH",expected,reported};
 let start,end,clientEnd;
 try{
  start=BigInt(entry.trainingStartTime);end=BigInt(entry.trainingEndTime);
  clientEnd=observedClientEndTime==null?null:BigInt(observedClientEndTime);
 }catch{return {status:"NATIVE_QUEUE_TIMESTAMP_INVALID"};}
 const from=Number(entry.trainingStartSP),to=Number(entry.trainingDestinationSP);
 if(start<=0n||end<start||!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||to<from)
  return {status:"NATIVE_QUEUE_TIMESTAMP_INVALID"};
 const expectedDuration=BigInt(Math.floor((to-from)/reported*Number(FILETIME_TICKS_PER_MINUTE)));
 if(end-start!==expectedDuration)
  return {status:"SERVER_QUEUE_ETA_MISMATCH"};
 if(observedClientCloneGrade==null||clientEnd==null)
  return {status:"CLIENT_ETA_NOT_OBSERVED",nativeExpectedRate:reported};
 if((omega?"omega":"alpha")!==String(observedClientCloneGrade).toLowerCase())
  return {status:"CLIENT_CLONE_GRADE_MISMATCH"};
 const delta=clientEnd>end?clientEnd-end:end-clientEnd;
 if(delta>FILETIME_TICKS_PER_MINUTE)return {status:"CLIENT_ETA_MISMATCH",differenceMinutes:Number(delta/FILETIME_TICKS_PER_MINUTE)};
 return {status:"NATIVE_AND_CLIENT_ETA_ALIGNED",nativeExpectedRate:reported};
}
function auditTwoPilots(pilots){
 if(!Array.isArray(pilots)||pilots.length!==2||
  !int(pilots[0]?.characterID)||!int(pilots[1]?.characterID)||
  int(pilots[0].characterID)===int(pilots[1].characterID)||
  !int(pilots[0]?.accountID)||!int(pilots[1]?.accountID)||
  int(pilots[0].accountID)===int(pilots[1].accountID))
  return {status:"TWO_INDEPENDENT_CHARACTERS_NOT_PROVED"};
 const outcomes=pilots.map(auditPilot);
 return {status:outcomes.every(x=>x.status==="NATIVE_AND_CLIENT_ETA_ALIGNED")?
  "TWO_NATIVE_AND_CLIENT_ETAS_ALIGNED":"TWO_PILOT_EVIDENCE_INCOMPLETE",outcomes};
}
module.exports={auditPilot,auditTwoPilots};
