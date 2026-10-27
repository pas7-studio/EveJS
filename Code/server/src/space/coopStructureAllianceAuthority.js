"use strict";
// Chat 32: fail-closed native corporate / alliance RPC admission.
// No shadow alliance list, no new wallet or structure state, no item mutations.
const positive=n=>Number.isSafeInteger(Number(n))&&Number(n)>0?Number(n):null;
const mask=value=>{
 try{const b=BigInt(value??0);return b>=0n?b:null}catch{return null}
};
const deny=reason=>({ok:false,reason});
const ok=(extra={})=>({ok:true,reason:"AUTHORITATIVE_NATIVE_MEMBER",...extra});
const EXECUTOR_ACTIONS=new Set([
 "UpdateAlliance","UpdateApplication","DeleteMember","SetPrimeHour",
 "SetCapitalSystem","CancelCapitalSystemTransition","DeclareWarAgainst",
 "SetRelationship","DeleteRelationship","AddAllianceContact",
 "EditAllianceContact","RemoveAllianceContacts","EditContactsRelationshipID",
 "CreateLabel","DeleteLabel","EditLabel","AssignLabels","RemoveLabels",
 "AddBulletin","UpdateBulletin","DeleteBulletin","UpdateBulletinOrder"
]);
const CORP_DIRECTOR_ACTIONS=new Set(["DeclareExecutorSupport"]);
const ALL_MUTATIONS=new Set([...EXECUTOR_ACTIONS,...CORP_DIRECTOR_ACTIONS,"GMForceAcceptApplication"]);
function nativeMembership({session,readCharacter,readCorporation,readMember}={}){
 if(!session||!["function","function","function"].every((t,i)=>
  typeof [readCharacter,readCorporation,readMember][i]===t))
  return deny("NATIVE_MEMBERSHIP_READER_UNAVAILABLE");
 const charID=positive(session.characterID??session.charid);
 const corpID=positive(session.corporationID??session.corpid);
 if(!charID||!corpID||session.socket?.destroyed===true||
    session.socket?.writableEnded===true)return deny("SESSION_IDENTITY_INVALID");
 const character=readCharacter(charID),corporation=readCorporation(corpID);
 if(!character||!corporation||positive(character.characterID??character.charid)!==charID||
   positive(character.corporationID??character.corpid)!==corpID||
   positive(corporation.corporationID)!==corpID||
   corporation.deleted===1||corporation.isNPC===true||
   (corpID>=1000000&&corpID<2000000))
  return deny("NATIVE_CORPORATION_MEMBERSHIP_MISMATCH");
 const member=readMember(corpID,charID);
 if(!member||positive(member.characterID)!==charID)
  return deny("MEMBER_ROLE_RECORD_MISSING");
 const isCEO=positive(corporation.ceoID)===charID;
 const bits=mask(member.roles);
 if(bits===null)return deny("NATIVE_ROLE_RECORD_INVALID");
 return ok({charID,corpID,corporation,member,
   isDirector:isCEO||(bits&1n)===1n,isCEO});
}
function admitAlliance({action,session,readCharacter,readCorporation,
 readMember,readAlliance,readAllianceMembers,readAllianceRuntime,
 readStructure,args=[]}={}){
 if(!ALL_MUTATIONS.has(action))return deny("UNKNOWN_MUTATION");
 // A named GM RPC cannot be authorized by user-controlled isGM/gmrole.
 if(action==="GMForceAcceptApplication")return deny("GM_ONLY_UNVERIFIED");
 const member=nativeMembership({session,readCharacter,readCorporation,readMember});
 if(!member.ok)return member;
 if(typeof readAlliance!=="function"||typeof readAllianceMembers!=="function")
  return deny("ALLIANCE_AUTHORITY_UNAVAILABLE");
 const allianceID=positive(session.allianceID??session.allianceid);
 const alliance=allianceID&&readAlliance(allianceID);
 if(!alliance||positive(alliance.allianceID)!==allianceID||
    alliance.deleted===1||positive(member.corporation.allianceID)!==allianceID)
  return deny("ALLIANCE_MEMBERSHIP_MISMATCH");
 const members=readAllianceMembers(allianceID);
 if(!Array.isArray(members)||!members.includes(member.corpID))
  return deny("ALLIANCE_MEMBER_INDEX_MISMATCH");
 const executorID=positive(alliance.executorCorporationID);
 if(!executorID)return deny("ALLIANCE_EXECUTOR_UNVERIFIED");
 if(action==="DeclareExecutorSupport"){
  if(!member.isDirector)return deny("ALLIANCE_DIRECTOR_REQUIRED");
  const target=positive(args[0]);
  if(!target||!members.includes(target))
   return deny("EXECUTOR_CHOICE_NOT_ALLIANCE_MEMBER");
  return ok({allianceID,corpID:member.corpID});
 }
 if(member.corpID!==executorID||!member.isDirector)
  return deny("EXECUTOR_CORPORATION_DIRECTOR_REQUIRED");
 if(action==="UpdateApplication"){
  const applicantID=positive(args[0]),state=Number(args[2]);
  if(!applicantID||!Number.isSafeInteger(state)||state<0||state>3||
    typeof readAllianceRuntime!=="function"||
    !readAllianceRuntime(allianceID)?.applications?.[String(applicantID)])
   return deny("ALLIANCE_APPLICATION_NOT_DURABLE");
  const applicant=readCorporation(applicantID);
  if(!applicant||positive(applicant.corporationID)!==applicantID)
   return deny("APPLICANT_CORPORATION_NOT_FOUND");
  if(state===2&&positive(applicant.allianceID)===allianceID)
   return deny("ALREADY_ALLIANCE_MEMBER");
 }
 if(action==="DeleteMember"){
  const targetID=positive(args[0]);
  if(!targetID||!members.includes(targetID)||targetID===executorID)
   return deny("ALLIANCE_MEMBER_REMOVAL_INVALID");
  const corp=readCorporation(targetID);
  if(!corp||positive(corp.allianceID)!==allianceID)
   return deny("TARGET_CORPORATION_NOT_IN_ALLIANCE");
 }
 if(action==="DeclareWarAgainst"){
  const targetID=positive(args[0]),structureID=positive(args[1]);
  if(!targetID||targetID===allianceID||!structureID||
    typeof readStructure!=="function")
   return deny("WAR_TARGET_OR_HQ_INVALID");
  const targetAlliance=readAlliance(targetID),targetCorp=readCorporation(targetID);
  if(!targetAlliance&&!targetCorp)return deny("WAR_TARGET_NOT_FOUND");
  if(targetCorp&&positive(targetCorp.allianceID)===allianceID)
   return deny("WAR_AGAINST_OWN_MEMBER");
  const hq=readStructure(structureID);
  if(!hq||positive(hq.structureID)!==structureID||
    positive(hq.ownerCorpID??hq.ownerID)!==executorID||
    hq.destroyedAt||hq.unanchoring||
    !positive(hq.solarSystemID))
   return deny("WAR_HQ_NOT_EXECUTOR_OWNED_ACTIVE");
 }
 return ok({allianceID,corpID:member.corpID,executorID});
}
function admitStructure({session,structure,action,readCharacter,
 readCorporation,readMember}={}){
 if(!["deploy","manage","decommission"].includes(action))
  return deny("UNKNOWN_STRUCTURE_ACTION");
 const member=nativeMembership({session,readCharacter,readCorporation,readMember});
 if(!member.ok)return member;
 const bits=mask(member.member.roles);
 if(action==="deploy"||action==="manage"){
  if(!member.isDirector&&(bits&2048n)!==2048n)
   return deny("STRUCTURE_STATION_MANAGER_REQUIRED");
 }else if(!member.isDirector)return deny("STRUCTURE_DIRECTOR_REQUIRED");
 if(action!=="deploy"){
  if(!structure||!positive(structure.structureID)||
    positive(structure.ownerCorpID??structure.ownerID)!==member.corpID||
    structure.destroyedAt)return deny("STRUCTURE_NATIVE_OWNER_MISMATCH");
 }
 return ok({corpID:member.corpID,charID:member.charID,action});
}
module.exports={admitAlliance,admitStructure,nativeMembership,ALL_MUTATIONS};
