"use strict";
// Chat 36: read-only, opt-in Conduit Loop authorization using ORIGINAL SDE
// worldData and ORIGINAL persisted character standings. Never creates gates,
// ships, standings, wormholes, filaments, NPCs, loot or a second jump service.
const POCHVEN_REGION_ID=10000070;
const TRIGLAVIAN_FACTION_ID=500026;
const HOME_STANDING=6;
const HOME=new Set(["Archee","Kino","Niarja"]);
const POCHVEN_SYSTEMS=new Set([
 "Senda","Wirashoda","Ala","Vale","Archee","Angymonne","Ichoriya",
 "Kaunokka","Arvasaras","Sakenta","Komo","Ignebaener","Otela",
 "Kino","Nalvula","Konola","Krirald","Otanuomi","Urhinichi",
 "Nani","Skarkon","Raravoss","Niarja","Harva","Tunudan",
 "Kuharah","Ahtila"
]);
// Real inventory type group IDs for hulls forbidden at Conduit stargates.
// A missing SDE hull group is NOT guessed into an allowed class.
const CAPITAL_GROUPS=new Set([30,485,513,547,659,883,902,1538]);
// The pinned SDE exposes positive, verifiable ship groups; unsupported
// classes are quarantined instead of assuming an unknown hull is subcapital.
const SUPPORTED_SUBCAPITAL_GROUPS=new Set([
 25,26,27,28,29,31,237,324,358,380,419,420,463,540,541,
 830,831,832,833,834,893,894,898,900,906,963,1022,1201,
 1283,1305,1527,1534,1972
]);
const pos=v=>Number.isSafeInteger(v)&&v>0;
const num=v=>typeof v==="number"&&Number.isFinite(v)?v:NaN;
const id=v=>pos(v)?v:null;
const deny=(reason,extra={})=>({allowed:false,reason,...extra});
const nativeName=system=>{
 const name=system?.solarSystemName??system?.name;
 return typeof name==="string"?name.trim():"";
};
function evaluate({session,sourceGate,destinationGate,worldData,
 getRawStanding,activeShip,resolveItemByTypeID}={}){
 const characterID=id(session?.characterID),sourceID=id(session?._space?.systemID);
 const sourceShipID=id(session?._space?.shipID),persistedShipID=id(activeShip?.itemID);
 const sourceGateID=id(sourceGate?.itemID),destinationGateID=id(destinationGate?.itemID);
 if(!characterID||!sourceID||!sourceShipID||persistedShipID!==sourceShipID||
   !sourceGateID||!destinationGateID||!worldData||
   typeof worldData.getSolarSystemByID!=="function"||
   typeof worldData.getStargatesForSystem!=="function")
  return deny("NATIVE_SOURCE_UNVERIFIED");
 const destID=id(destinationGate?.solarSystemID);
 if(!destID||destID===sourceID||sourceGate.solarSystemID!==sourceID||
   sourceGate.destinationID!==destinationGateID||
   destinationGate.destinationID!==sourceGateID||
   (pos(sourceGate.destinationSolarSystemID)&&sourceGate.destinationSolarSystemID!==destID)||
   (pos(destinationGate.destinationSolarSystemID)&&destinationGate.destinationSolarSystemID!==sourceID))
  return deny("NATIVE_GATE_PAIR_UNVERIFIED");
 let sourceSystem,destinationSystem,sourceGates,destinationGates;
 try{
  sourceSystem=worldData.getSolarSystemByID(sourceID);
  destinationSystem=worldData.getSolarSystemByID(destID);
  sourceGates=worldData.getStargatesForSystem(sourceID);
  destinationGates=worldData.getStargatesForSystem(destID);
 }catch{return deny("NATIVE_TOPOLOGY_UNAVAILABLE");}
 if(!sourceSystem||!destinationSystem||!Array.isArray(sourceGates)||
    !Array.isArray(destinationGates)||
    !sourceGates.some(x=>x?.itemID===sourceGateID&&x?.destinationID===destinationGateID)||
    !destinationGates.some(x=>x?.itemID===destinationGateID&&x?.destinationID===sourceGateID))
  return deny("NATIVE_TOPOLOGY_UNVERIFIED");
 const fromRegion=id(sourceSystem.regionID),toRegion=id(destinationSystem.regionID);
 if(!fromRegion||!toRegion)return deny("NATIVE_REGION_UNVERIFIED");
 if(fromRegion!==POCHVEN_REGION_ID&&toRegion!==POCHVEN_REGION_ID)
  return {allowed:true,reason:"NON_POCHVEN_NATIVE_GATE",sourceID,destID};
 if(fromRegion!==POCHVEN_REGION_ID||toRegion!==POCHVEN_REGION_ID)
  return deny("POCHVEN_NOT_REACHABLE_BY_KSPACE_GATE");
 const sourceName=nativeName(sourceSystem),destName=nativeName(destinationSystem);
 if(!POCHVEN_SYSTEMS.has(sourceName)||!POCHVEN_SYSTEMS.has(destName)||
    sourceName===destName)
  return deny("POCHVEN_SDE_SYSTEM_IDENTITY_UNVERIFIED");
 if(typeof resolveItemByTypeID!=="function"||!pos(activeShip.typeID))
  return deny("POCHVEN_NATIVE_SHIP_TYPE_UNAVAILABLE");
 let itemType;
 try{itemType=resolveItemByTypeID(activeShip.typeID);}catch{return deny("POCHVEN_NATIVE_SHIP_TYPE_UNAVAILABLE");}
 if(!itemType||itemType.typeID!==activeShip.typeID||
    itemType.categoryID!==6||!pos(itemType.groupID))
  return deny("POCHVEN_NATIVE_HULL_CLASS_UNVERIFIED");
 if(CAPITAL_GROUPS.has(itemType.groupID))return deny("POCHVEN_CAPITAL_CONDUIT_FORBIDDEN");
 if(!SUPPORTED_SUBCAPITAL_GROUPS.has(itemType.groupID))
  return deny("POCHVEN_HULL_GROUP_NOT_VERIFIED_SUBCAPITAL");
 if(HOME.has(destName)){
  if(typeof getRawStanding!=="function")return deny("POCHVEN_STANDINGS_UNAVAILABLE");
  let standing;
  try{standing=num(getRawStanding(characterID,TRIGLAVIAN_FACTION_ID));}
  catch{return deny("POCHVEN_STANDINGS_UNAVAILABLE");}
  if(!Number.isFinite(standing)||standing<HOME_STANDING)
   return deny("POCHVEN_HOME_REQUIRES_6_RAW_TRIGLAVIAN_STANDING");
 }
 return {allowed:true,reason:"POCHVEN_NATIVE_CONDUIT_ALLOWED",sourceID,destID,
   classification:HOME.has(destName)?"home":"border-or-internal"};
}
function allowJump(ctx){return evaluate(ctx).allowed===true;}
module.exports={evaluate,allowJump,POCHVEN_REGION_ID,TRIGLAVIAN_FACTION_ID,HOME_STANDING};
