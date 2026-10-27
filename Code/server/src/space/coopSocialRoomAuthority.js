"use strict";
// Chat 39 — read-only membership proof for existing EveJS scoped XMPP rooms.
// Never grants local/fleet/corp privileges from client-only session values.
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):0;
function verifyScopedRoom({session,record,getCharacter,getCorporation,
 getAlliance,getAllianceMembers,getFleetForCharacter}={}){
 const kind=record?.type;
 if(!["corp","alliance","fleet"].includes(kind))return {ok:true,reason:"NON_SCOPED_NATIVE"};
 const charID=id(session?.characterID||session?.charid);
 const entityID=id(record?.entityID);
 if(!charID||!entityID||session?.socket?.destroyed===true)
  return {ok:false,reason:"NO_SELECTED_CHARACTER"};
 if(typeof getCharacter!=="function")return {ok:false,reason:"CHARACTER_AUTHORITY_MISSING"};
 const character=getCharacter(charID);
 if(!character||id(character.characterID??character.charid)!==charID)
  return {ok:false,reason:"CHARACTER_RECORD_MISMATCH"};
 const realCorporationID=id(character.corporationID??character.corpid);
 const suppliedCorporationID=id(session.corporationID??session.corpid);
 if(!realCorporationID||!suppliedCorporationID||realCorporationID!==suppliedCorporationID)
  return {ok:false,reason:"STALE_CORPORATION_SESSION"};
 if(kind==="corp"){
  if(realCorporationID!==entityID||typeof getCorporation!=="function")
   return {ok:false,reason:"CORPORATION_ROOM_MISMATCH"};
  const corp=getCorporation(realCorporationID);
  return corp&&id(corp.corporationID)===entityID&&corp.deleted!==1
   ?{ok:true,reason:"NATIVE_CORPORATION_MEMBER"}
   :{ok:false,reason:"CORPORATION_RECORD_MISSING"};
 }
 if(kind==="alliance"){
  if(typeof getCorporation!=="function"||typeof getAlliance!=="function"||
    typeof getAllianceMembers!=="function")
   return {ok:false,reason:"ALLIANCE_AUTHORITY_MISSING"};
  const corp=getCorporation(realCorporationID),alliance=getAlliance(entityID);
  const members=getAllianceMembers(entityID);
  if(id(session.allianceID??session.allianceid)!==entityID||
   !corp||id(corp.corporationID)!==realCorporationID||
   id(corp.allianceID)!==entityID||!alliance||
   id(alliance.allianceID)!==entityID||alliance.deleted===1||
   !Array.isArray(members)||!members.includes(realCorporationID))
   return {ok:false,reason:"STALE_ALLIANCE_MEMBERSHIP"};
  return {ok:true,reason:"NATIVE_ALLIANCE_MEMBER"};
 }
 if(typeof getFleetForCharacter!=="function")
  return {ok:false,reason:"FLEET_AUTHORITY_MISSING"};
 const fleet=getFleetForCharacter(charID);
 if(id(session.fleetid??session.fleetID)!==entityID||
  !fleet||id(fleet.fleetID)!==entityID||
  !(fleet.members instanceof Map)||!fleet.members.has(charID))
  return {ok:false,reason:"STALE_FLEET_MEMBERSHIP"};
 return {ok:true,reason:"NATIVE_FLEET_MEMBER"};
}
module.exports={verifyScopedRoom};
