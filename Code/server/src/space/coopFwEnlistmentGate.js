"use strict";
// Chat 35. Optional authority guard for PINNED native Direct Enlistment.
// Native characterState, corporationRuntimeState and standingRuntime own ALL state.
// No wallets, standings, faction VP or systems are changed here.
const DIRECT_FACTIONS = Object.freeze([500001, 500002, 500003, 500004, 500010, 500011]);
const ALLOWED = new Set(DIRECT_FACTIONS);
const DIRECTOR_ROLE = 1n;
const POS = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const parseFiletime = v => {
  try {
    if (v === null || v === undefined || v === "") return 0n;
    if (typeof v === "number" && !Number.isSafeInteger(v)) return null;
    const n = BigInt(v);
    return n >= 0n ? n : null;
  } catch (_) { return null; }
};
const valid = () => ({ok:true});
const refuse = error => ({ok:false,error});
function validateDirect({session, factionID, characterID, character, corporation, corpRuntime, standing, nowFiletime}) {
  const charID=POS(characterID),corpID=POS(session && (session.corporationID || session.corpid));
  if (!charID || charID!==POS(session && (session.characterID || session.charid)) || !corpID ||
      !character || !corporation || POS(corporation.corporationID)!==corpID)
    return refuse("FW_CHARACTER_CORPORATION_MISMATCH");
  const recordedCorp=POS(character.corporationID || character.corpid);
  if (recordedCorp && recordedCorp!==corpID) return refuse("FW_CHARACTER_CORPORATION_MISMATCH");
  if (!ALLOWED.has(factionID) || !Number.isSafeInteger(factionID))
    return refuse("FW_UNSUPPORTED_MILITIA_FACTION");
  const present=POS(character.directFactionID);
  if (present && present!==factionID) return refuse("FW_RETIRE_BEFORE_REENLIST");
  // Native FW treats 0.0 base standing as eligible, NOT effective Social/Diplomacy standing.
  if (typeof standing!=="number" || !Number.isFinite(standing) || standing < 0)
    return refuse("FW_RAW_FACTION_STANDING_TOO_LOW");
  const now=parseFiletime(nowFiletime),until=parseFiletime(character.directEnlistmentCooldownTimestamp);
  if (now===null || now<=0n || until===null) return refuse("FW_COOLDOWN_UNVERIFIABLE");
  if (until>now) return refuse("FW_DIRECT_ENLISTMENT_COOLDOWN_ACTIVE");
  // Pinned corp runtime defaults to [] when no Direct Enlistment factions
  // were authorized. For PLAYER corps, [] is not permission for ALL factions.
  // NPC starter corps are not player-administered and may enlist on standing.
  const approved=corpRuntime && corpRuntime.fw && corpRuntime.fw.allowedEnlistmentFactions;
  if (corporation.isNPC!==true) {
    if (approved!==undefined && approved!==null && !Array.isArray(approved))
      return refuse("FW_CORP_ENLISTMENT_POLICY_UNVERIFIABLE");
    if(!Array.isArray(approved) || !approved.includes(factionID))
      return refuse("FW_CORP_ENLISTMENT_FACTION_DENIED");
  }
  return valid();
}
function validateRetire({session, characterID, character}) {
  if(!character || !POS(characterID) || POS(characterID)!==POS(session && (session.characterID || session.charid)))
    return refuse("FW_CHARACTER_NOT_FOUND");
  if(!POS(character.directFactionID)) return refuse("FW_NOT_DIRECTLY_ENLISTED");
  return valid();
}
function parseMask(v) {
  try {
    if (typeof v === 'number' && !Number.isSafeInteger(v)) return null;
    if (v===null || v===undefined || v==="") return 0n;
    const n=BigInt(v);return n>=0n?n:null;
  }catch(_){return null;}
}
function validateCorpPolicy({session, corporation, member, factions}) {
  const corpID=POS(session && (session.corporationID || session.corpid));
  const charID=POS(session && (session.characterID || session.charid));
  if(!charID || !corpID || !corporation || POS(corporation.corporationID)!==corpID || corporation.isNPC===true)
    return refuse("FW_CORP_OWNER_NOT_AUTHORIZED");
  if(!Array.isArray(factions) || factions.length>DIRECT_FACTIONS.length ||
     new Set(factions).size!==factions.length ||
     factions.some(f=>typeof f!=="number" || !Number.isSafeInteger(f) || !ALLOWED.has(f)))
    return refuse("FW_CORP_FACTION_LIST_INVALID");
  // Persisted CEO/member authority, NEVER session role masks alone.
  if(POS(corporation.ceoID)===charID) return valid();
  if(!member || POS(member.characterID)!==charID || POS(member.corporationID)!==corpID)
    return refuse("FW_CORP_DIRECTOR_REQUIRED");
  const mask=parseMask(member.roles);
  if(mask===null || (mask & DIRECTOR_ROLE)!==DIRECTOR_ROLE) return refuse("FW_CORP_DIRECTOR_REQUIRED");
  return valid();
}
function nativeDependencies() {
  // Lazy to avoid import side effects on startup and keep pinned module ownership.
  const characterState=require("../services/character/characterState");
  const corporationState=require("../services/corporation/corporationState");
  const corpRuntime=require("../services/corporation/corporationRuntimeState");
  const standings=require("../services/character/standingRuntime");
  const time=require("../services/_shared/serviceHelpers");
  const errors=require("../common/machoErrors");
  return {characterState,corporationState,corpRuntime,standings,time,errors};
}
function raiseIfDenied(result, deps) {
  if(result.ok) return true;
  // Real client-facing failure; never silently convert an illegal operation into success.
  if(typeof deps?.errors?.throwWrappedUserError==="function")
    deps.errors.throwWrappedUserError("CustomNotify",{notify:`Faction Warfare operation denied: ${result.error}`});
  throw Error(result.error);
}
function assertDirect(session, characterID, factionID, deps=nativeDependencies()) {
  const corpID=POS(session && (session.corporationID || session.corpid));
  const character=deps.characterState.getCharacterRecord(characterID);
  const nativeCorp=deps.corporationState.getCorporationRecord(corpID);
  const corporation=nativeCorp ? {...nativeCorp,
    isNPC: nativeCorp.isNPC===true ||
      (typeof deps.corporationState.isNpcCorporationID==="function" &&
        deps.corporationState.isNpcCorporationID(corpID)===true)} : null;
  const standing=deps.standings.getCharacterRawStanding(characterID,factionID);
  const corpRuntime=deps.corpRuntime.getCorporationRuntime(corpID);
  return raiseIfDenied(validateDirect({session,characterID,factionID,character,corporation,corpRuntime,standing,
    nowFiletime:deps.time.currentFileTime()}),deps);
}
function assertRetire(session, characterID, deps=nativeDependencies()) {
  return raiseIfDenied(validateRetire({session,characterID,character:deps.characterState.getCharacterRecord(characterID)}),deps);
}
function assertCorpPolicy(session, factions, deps=nativeDependencies()) {
  const corpID=POS(session && (session.corporationID || session.corpid));
  const charID=POS(session && (session.characterID || session.charid));
  return raiseIfDenied(validateCorpPolicy({session,factions,
    corporation:deps.corporationState.getCorporationRecord(corpID),
    member:deps.corpRuntime.getCorporationMember(corpID,charID)}),deps);
}
function verifyPersistedDirect(character, factionID) {
  if(!character || !ALLOWED.has(factionID) || POS(character.directFactionID)!==factionID ||
     POS(character.warFactionID)!==factionID) return refuse("FW_CHARACTER_ENLISTMENT_WRITE_UNCONFIRMED");
  return valid();
}
function verifyPersistedRetire(character, corpFactionID, nowFiletime) {
  if(!character || POS(character.directFactionID) ||
     POS(character.warFactionID)!==POS(corpFactionID))return refuse("FW_CHARACTER_RETIREMENT_WRITE_UNCONFIRMED");
  const until=parseFiletime(character.directEnlistmentCooldownTimestamp), now=parseFiletime(nowFiletime);
  if(until===null || now===null || until<=now)
    return refuse("FW_RETIREMENT_COOLDOWN_WRITE_UNCONFIRMED");
  return valid();
}
function verifyPersistedCorpPolicy(runtime, factions) {
  const current=runtime && runtime.fw && runtime.fw.allowedEnlistmentFactions;
  if(!Array.isArray(current) || !Array.isArray(factions) ||
     current.length!==factions.length || current.some((f,i)=>f!==factions[i]))
    return refuse("FW_CORPORATE_POLICY_WRITE_UNCONFIRMED");
  return valid();
}
function assertPersistedDirect(session, characterID, factionID, deps=nativeDependencies()) {
 return raiseIfDenied(verifyPersistedDirect(deps.characterState.getCharacterRecord(characterID),factionID),deps);
}
function assertPersistedRetire(session, characterID, corpFactionID, deps=nativeDependencies()) {
 return raiseIfDenied(verifyPersistedRetire(deps.characterState.getCharacterRecord(characterID),corpFactionID,
   deps.time.currentFileTime()),deps);
}
function assertPersistedCorpPolicy(session, factions, deps=nativeDependencies()) {
 const corpID=POS(session && (session.corporationID || session.corpid));
 return raiseIfDenied(verifyPersistedCorpPolicy(deps.corpRuntime.getCorporationRuntime(corpID),factions),deps);
}
module.exports={DIRECT_FACTIONS,parseFiletime,parseMask,validateDirect,validateRetire,validateCorpPolicy,
  assertDirect,assertRetire,assertCorpPolicy,verifyPersistedDirect,verifyPersistedRetire,
  verifyPersistedCorpPolicy,assertPersistedDirect,assertPersistedRetire,assertPersistedCorpPolicy};
