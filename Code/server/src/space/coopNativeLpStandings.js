"use strict";
// Read-only native EveJS standings gate for static LP store offers.
// No LP, ISK, inventory, missions or standings are written by this adapter.
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):0;
function normalizeRule(entry,fallbackOwner){
 if(typeof entry==="number" || (typeof entry==="string" && entry.trim()!=="")){
  const value=Number(entry);
  return {ownerID:id(fallbackOwner),value};
 }
 if(Array.isArray(entry)&&entry.length===2&&
   !Array.isArray(entry[0])&&typeof entry[0]!=="object")
  return {ownerID:id(entry[0]),value:Number(entry[1])};
 if(entry&&typeof entry==="object"&&!Array.isArray(entry))
  return {ownerID:id(entry.ownerID??entry.owner_id??entry.corpID??fallbackOwner),
    value:Number(entry.value??entry.minStanding??entry.standing)};
 return null;
}
function parse(requirements,corpID){
 if(requirements===null||requirements===undefined||requirements===false||
   requirements===""||requirements===0)return {ok:true,rules:[]};
 const inputs=Array.isArray(requirements)?
   (requirements.length===2&&!Array.isArray(requirements[0])&&
      (typeof requirements[0]!=="object"||requirements[0]===null)?
      [requirements]:requirements) : [requirements];
 if(inputs.length===0)return {ok:true,rules:[]};
 const rules=[];
 for(const input of inputs){
  const rule=normalizeRule(input,corpID);
  if(!rule||!rule.ownerID||!Number.isFinite(rule.value)||
    rule.value< -10||rule.value>10)
   return {ok:false,errorMsg:"UNSUPPORTED_STANDING_REQUIREMENT",rules:[]};
  rules.push(rule);
 }
 return {ok:true,rules};
}
function check({requirements,characterID,corpID,standingRuntime}={}){
 const normalizedCharacterID=id(characterID);
 const rules=parse(requirements,id(corpID));
 if(!rules.ok)return {ok:false,errorMsg:rules.errorMsg};
 if(!rules.rules.length)return {ok:true,requirements:0};
 if(!normalizedCharacterID||!standingRuntime||
   typeof standingRuntime.getCharacterEffectiveStanding!=="function")
  return {ok:false,errorMsg:"STANDING_DATA_UNAVAILABLE"};
 for(const rule of rules.rules){
  const result=standingRuntime.getCharacterEffectiveStanding(
    normalizedCharacterID,rule.ownerID);
  const effective=Number(result&&result.standing);
  if(!result||!Number.isFinite(effective))
   return {ok:false,errorMsg:"STANDING_DATA_UNAVAILABLE"};
  if(effective<rule.value)
   return {ok:false,errorMsg:"STANDING_REQUIREMENT_NOT_MET",
    ownerID:rule.ownerID,required:rule.value,actual:effective};
 }
 return {ok:true,requirements:rules.rules.length};
}
module.exports={check,parse};
