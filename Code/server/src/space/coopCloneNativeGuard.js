"use strict";
// Chat 34: pure native authority preflight; not a clone/implant inventory writer.
// Unsafe and ambiguous native state must never be promoted into a success.
const positive=x=>{const n=Number(x);return Number.isSafeInteger(n)&&n>0?n:0};
const validTime=x=>typeof x==="string"&&/^\d{1,20}$/.test(x);
const deny=(reason,extra={})=>({ok:false,reason,...extra});
const FT=116444736000000000n;
const HOUR=36000000000n;
const cloneList=record=>Array.isArray(record?.jumpClones)?record.jumpClones:[];
const activeImplants=record=>Array.isArray(record?.implants)?record.implants:[];
function validateUniqueImplants(record){
 const usedItems=new Set(),clones=cloneList(record);
 const cloneIDs=new Set();
 const lists=[activeImplants(record)];
 for(const clone of clones){
  const cid=positive(clone?.jumpCloneID??clone?.cloneID??clone?.itemID);
  if(!cid||positive(clone.ownerID)!==positive(record.characterID)||
   cloneIDs.has(cid)||!positive(clone.locationID))
   return deny("NATIVE_CLONE_IDENTITY_INVALID");
  cloneIDs.add(cid);
  lists.push(Array.isArray(clone.implants)?clone.implants:[]);
 }
 for(const implants of lists){
  const slots=new Set();
  for(const entry of implants){
   const item=positive(entry?.itemID??entry?.implantID??entry?.sourceItemID),
    slot=positive(entry?.slot??entry?.implantness??entry?.implantSlot),
    type=positive(entry?.typeID??entry?.implantTypeID);
   if(!item||!slot||!type)return deny("NATIVE_IMPLANT_IDENTITY_AMBIGUOUS");
   if(usedItems.has(item))return deny("DUPLICATE_NATIVE_IMPLANT_ITEM");
   if(slots.has(slot))return deny("DUPLICATE_NATIVE_IMPLANT_SLOT");
   usedItems.add(item);slots.add(slot);
  }
 }
 return {ok:true,cloneIDs,implantItemIDs:usedItems};
}
function createCloneGuard({
 getSessions,getCharacterRecord,getActiveShip,getInventoryItem,
 getStationByID,getStructureByID,canDockAtStructure,hasCloneService,
 getCharacterCloneLimit,getCloneCooldownHours,getWalletBalance,
 getImplantTypeInfo,validateImplantItem,getBoosterTypeInfo,validateBoosterItem,
 getOwnedShipsAtLocation,getHomeStationCandidateIDs,getNativeSchoolHQStationID,
 getCloneInstallationFee,
 getCloneActivationFee,verifyDeathEvent,isAuthorizedAdmin,
 nowFiletime=()=>String(BigInt(Date.now())*10000n+FT),
 isCapsuleShip
}={}){
 const deps=[getSessions,getCharacterRecord,getActiveShip,getInventoryItem,
  getStationByID,getStructureByID,canDockAtStructure,hasCloneService,
  getCharacterCloneLimit,getCloneCooldownHours,getWalletBalance,
  getImplantTypeInfo,validateImplantItem,getBoosterTypeInfo,validateBoosterItem,
  getOwnedShipsAtLocation,getHomeStationCandidateIDs,getNativeSchoolHQStationID,
  getCloneInstallationFee,
  getCloneActivationFee,verifyDeathEvent,isAuthorizedAdmin,nowFiletime,isCapsuleShip];
 if(deps.some(fn=>typeof fn!=="function"))throw Error("NATIVE_CLONE_BINDINGS_REQUIRED");
 function actor(session){
  const charID=positive(session?.characterID),userID=positive(session?.userid);
  if(!charID||!userID||session?.socket?.destroyed===true)
   return deny("INVALID_NATIVE_CLONE_SESSION");
  let sessions,record,ship;
  try{sessions=getSessions();record=getCharacterRecord(charID);ship=getActiveShip(charID);}
  catch{return deny("NATIVE_CLONE_AUTHORITY_UNAVAILABLE")}
  if(!Array.isArray(sessions)||sessions.filter(s=>
   positive(s?.characterID)===charID&&s?.socket?.destroyed!==true).length!==1||
   !sessions.includes(session))return deny("DUPLICATE_OR_STALE_NATIVE_SESSION");
  if(!record||positive(record.characterID)!==charID||
   positive(record.accountId??record.accountID)!==userID)
   return deny("NATIVE_CLONE_ACCOUNT_MISMATCH");
  if(!ship||positive(ship.ownerID)!==charID||
   positive(ship.itemID)!==positive(record.activeShipID??record.activeShipId))
   return deny("ACTIVE_NATIVE_SHIP_IDENTITY_MISMATCH");
  const check=validateUniqueImplants(record);
  if(!check.ok)return check;
  return {ok:true,charID,record,ship,...check};
 }
 function stationPlace(locationID,session,requireCloneService=true){
  const id=positive(locationID);if(!id)return deny("INVALID_CLONE_LOCATION");
  let station,structure;
  try{station=getStationByID(id);structure=getStructureByID(id)}
  catch{return deny("CLONE_LOCATION_AUTHORITY_UNAVAILABLE")}
  if(station&&structure)return deny("AMBIGUOUS_CLONE_LOCATION");
  if(station&&positive(station.stationID)===id&&positive(station.solarSystemID))
   return {ok:true,kind:"station",locationID:id,solarSystemID:positive(station.solarSystemID)};
  if(structure&&positive(structure.structureID)===id&&positive(structure.solarSystemID)){
   let allowed=false,online=false;
   try{
    allowed=canDockAtStructure(session,structure)===true;
    online=hasCloneService(session,structure)===true;
   }catch{return deny("NATIVE_CLONE_SERVICE_UNAVAILABLE")}
   if(!allowed||(requireCloneService&&!online))
    return deny("CLONE_STRUCTURE_ACCESS_DENIED");
   return {ok:true,kind:"structure",locationID:id,solarSystemID:positive(structure.solarSystemID)};
  }
  return deny("CLONE_LOCATION_NOT_FOUND");
 }
 function origin(ctx,session){
  const locationID=positive(session?.stationid??session?.stationID??
   session?.structureid??session?.structureID);
  if(!locationID)return deny("CHARACTER_NOT_DOCKED");
  const place=stationPlace(locationID,session,false);
  if(!place.ok)return place;
  if(place.kind==="station"&&positive(ctx.record.stationID)!==locationID)
   return deny("NATIVE_DOCKED_STATION_MISMATCH");
  if(place.kind==="structure"&&positive(ctx.record.structureID)!==locationID)
   return deny("NATIVE_DOCKED_STRUCTURE_MISMATCH");
  return place;
 }
 function assertCooldown(record,charID,required){
  if(!required)return {ok:true};
  const last=String(record.timeLastCloneJump??"0");
  if(!validTime(last))return deny("INVALID_NATIVE_CLONE_FILETIME");
  let now,hours;
  try{now=BigInt(nowFiletime());hours=Number(getCloneCooldownHours(charID))}
  catch{return deny("NATIVE_CLONE_COOLDOWN_UNAVAILABLE")}
  if(now<=FT||!Number.isFinite(hours)||hours<0||hours>24)
   return deny("INVALID_NATIVE_CLONE_COOLDOWN");
  if(BigInt(last)>now+HOUR)return deny("FUTURE_NATIVE_CLONE_JUMP_TIME");
  if(BigInt(last)>0n&&BigInt(last)+BigInt(Math.ceil(hours*3600))*10000000n>now)
   return deny("NATIVE_CLONE_COOLDOWN_ACTIVE");
  return {ok:true,nowFiletime:String(now)};
 }
 function jump(session,{cloneID,destLocationID,confirmed=false}={}){
  const ctx=actor(session);if(!ctx.ok)return ctx;
  const src=origin(ctx,session);if(!src.ok)return src;
  const id=positive(cloneID),dest=positive(destLocationID);
  if(!id||!dest)return deny("INVALID_CLONE_JUMP_TARGET");
  const clones=cloneList(ctx.record);
  const target=clones.find(x=>positive(x?.jumpCloneID??x?.cloneID??x?.itemID)===id);
  if(!target||positive(target.ownerID)!==ctx.charID||
   positive(target.locationID)!==dest)return deny("NATIVE_JUMP_CLONE_NOT_OWNED_OR_MISSING");
  let targetPlace;
  if(target.locationKind==="ship")return deny("SHIP_VAT_TARGET_REQUIRES_NATIVE_BAY_ATTESTATION");
  targetPlace=stationPlace(dest,session,true);if(!targetPlace.ok)return targetPlace;
  if(target.locationKind!==targetPlace.kind)
   return deny("CLONE_LOCATION_KIND_MISMATCH");
  const existingAtOrigin=clones.find(x=>
   positive(x.locationID)===src.locationID&&positive(x.jumpCloneID)!==id);
  if(existingAtOrigin&&confirmed!==true)return deny("NATIVE_CLONE_REPLACEMENT_CONFIRM_REQUIRED");
  if(targetPlace.kind==="structure"&&confirmed!==true)
   return deny("NATIVE_STRUCTURE_JUMP_CONFIRM_REQUIRED");
  const cooldown=assertCooldown(ctx.record,ctx.charID,
   src.locationID!==dest||target.locationKind==="ship");
  if(!cooldown.ok)return cooldown;
  // Pinned jumpSessionToStation moves the currently ACTIVE native ship to the
  // destination. Never teleport a fitted ship instead of leaving it parked.
  let capsule;
  try{capsule=isCapsuleShip(ctx.ship)===true}
  catch{return deny("NATIVE_CAPSULE_TYPE_UNAVAILABLE")}
  if(!capsule)return deny("NON_CAPSULE_CLONE_JUMP_UNSAFE_SHIP_TELEPORT");
  let ships;
  try{ships=getOwnedShipsAtLocation(ctx.charID,src.locationID)}
  catch{return deny("SOURCE_SHIP_CUSTODY_UNAVAILABLE")}
  if(!Array.isArray(ships)||ships.some(s=>
   !positive(s?.itemID)||positive(s.ownerID)!==ctx.charID||
   positive(s.locationID)!==src.locationID))
   return deny("SOURCE_SHIP_CUSTODY_UNVERIFIED");
  const distinctIDs=new Set(ships.map(s=>positive(s.itemID)));
  if(distinctIDs.size!==ships.length)return deny("SOURCE_SHIP_DUPLICATED");
  let balance,fee;
  try{balance=Number(getWalletBalance(ctx.charID));
   fee=Number(getCloneActivationFee(session));}
  catch{return deny("NATIVE_CLONE_WALLET_UNAVAILABLE")}
  if(!Number.isFinite(balance)||balance<0||!Number.isFinite(fee)||fee<0||
   balance<fee)return deny("NATIVE_CLONE_ACTIVATION_FEE_UNFUNDED");
  return {ok:true,kind:"CLONE_JUMP",characterID:ctx.charID,cloneID:id,
   sourceLocationID:src.locationID,destinationLocationID:dest,
   originalShipID:positive(ctx.ship.itemID),targetImplants:(target.implants||[]).map(x=>positive(x.itemID)),
   sourceParkedShips:ships.map(s=>({itemID:positive(s.itemID),locationID:src.locationID,ownerID:ctx.charID,
    flagID:Number(s.flagID),quantity:Number(s.quantity??s.stacksize??1)})),
   previousLastJump:String(ctx.record.timeLastCloneJump??"0"),
   previousCloneIDs:clones.map(x=>positive(x.jumpCloneID)),
   previousActiveImplants:activeImplants(ctx.record).map(x=>positive(x.itemID)),
   startedAtFiletime:cooldown.nowFiletime||String(nowFiletime()),
   walletBefore:balance,activationFee:fee,remote:src.locationID!==dest};
 }
 function installClone(session,{cost}={}){
  const ctx=actor(session);if(!ctx.ok)return ctx;
  const place=origin(ctx,session);if(!place.ok)return place;
  const access=stationPlace(place.locationID,session,true);if(!access.ok)return access;
  const clones=cloneList(ctx.record);
  const limit=Number(getCharacterCloneLimit(ctx.charID));
  if(!Number.isSafeInteger(limit)||limit<0||limit>20)
   return deny("NATIVE_CLONE_SKILL_LIMIT_INVALID");
  if(clones.length>=limit)return deny("NATIVE_CLONE_SKILL_LIMIT");
  if(clones.some(x=>positive(x.locationID)===place.locationID))
   return deny("CLONE_ALREADY_AT_LOCATION");
  let due,wallet;
  try{due=Number(getCloneInstallationFee(session));
   wallet=Number(getWalletBalance(ctx.charID));}
  catch{return deny("NATIVE_CLONE_INSTALL_QUOTE_UNAVAILABLE")}
  if(cost!==undefined&&Number(cost)!==due)
   return deny("CLONE_INSTALL_FEE_QUOTE_MISMATCH");
  if(!Number.isFinite(due)||due<0||!Number.isFinite(wallet)||wallet<due)
   return deny("NATIVE_CLONE_INSTALL_FEE_UNFUNDED");
  return {ok:true,kind:"INSTALL_CLONE",characterID:ctx.charID,
   locationID:place.locationID,previousCloneIDs:clones.map(x=>positive(x.jumpCloneID)),
   walletBefore:wallet,cost:due};
 }
 function homeStation(session,{stationID,allowRemote=false}={}){
  const ctx=actor(session);if(!ctx.ok)return ctx;
  const id=positive(stationID),place=stationPlace(id,session);
  if(!id||!place.ok||place.kind!=="station")return deny("INVALID_NATIVE_HOME_STATION");
  let candidates;
  try{candidates=getHomeStationCandidateIDs(session)}
  catch{return deny("HOME_STATION_CANDIDATES_UNAVAILABLE")}
  if(!Array.isArray(candidates)||!candidates.map(positive).includes(id))
   return deny("HOME_STATION_NOT_NATIVE_CANDIDATE");
  const previous=positive(ctx.record.homeStationID||ctx.record.cloneStationID);
  if(previous===id)return deny("HOME_STATION_ALREADY_SELECTED");
  const current=origin(ctx,session);
  if(!current.ok&&current.reason!=="CHARACTER_NOT_DOCKED")return current;
  let schoolHQID;
  try{schoolHQID=positive(getNativeSchoolHQStationID(session,ctx.record))}
  catch{return deny("NATIVE_SCHOOL_HQ_UNAVAILABLE")}
  const remote=id!==positive(current.locationID)&&id!==schoolHQID;
  if(remote&&allowRemote!==true)return deny("REMOTE_HOME_STATION_CONFIRM_REQUIRED");
  if(remote){
   const until=String(ctx.record.nextRemoteHomeStationChangeTime??"0");
   if(!validTime(until))return deny("INVALID_HOME_STATION_COOLDOWN");
   let now;try{now=BigInt(nowFiletime())}catch{return deny("NATIVE_CLOCK_UNAVAILABLE")}
   if(now<=FT||BigInt(until)>now)return deny("REMOTE_HOME_STATION_COOLDOWN_ACTIVE");
  }
  return {ok:true,kind:"HOME_STATION",characterID:ctx.charID,
   homeStationID:id,previousHomeStationID:previous,remote};
 }
 function consume(session,{itemID,kind}={}){
  const ctx=actor(session);if(!ctx.ok)return ctx;
  const id=positive(itemID);
  if(!id||!["IMPLANT","BOOSTER"].includes(kind))
   return deny("INVALID_CHARACTER_CONSUMABLE");
  let item,validation,info;
  try{
   item=getInventoryItem(id);
   validation=kind==="IMPLANT"?validateImplantItem(ctx.charID,id,{session}):
    validateBoosterItem(ctx.charID,id,null,{session});
   info=kind==="IMPLANT"?getImplantTypeInfo(item?.typeID):
    getBoosterTypeInfo(item?.typeID);
  }catch{return deny("NATIVE_CONSUMABLE_VALIDATION_UNAVAILABLE")}
  if(!item||positive(item.ownerID)!==ctx.charID||
   !positive(item.itemID)||!positive(item.typeID)||!info||
   validation?.success!==true)return deny("NATIVE_CONSUMABLE_ACCESS_DENIED");
  if(ctx.implantItemIDs.has(id))return deny("IMPLANT_ALREADY_PRESENT_IN_CLONE_STATE");
  if(kind==="IMPLANT"){
   const slot=positive(info.slot);if(!slot)return deny("IMPLANT_SLOT_INVALID");
   if(activeImplants(ctx.record).some(x=>positive(x.slot)===slot))
    return deny("IMPLANT_SLOT_OCCUPIED");
  }
  return {ok:true,kind,characterID:ctx.charID,itemID:id,typeID:positive(item.typeID),
   slot:positive(info.slot??info.boosterness),previousImplants:activeImplants(ctx.record).map(x=>positive(x.itemID)),
   previousBoosters:(Array.isArray(ctx.record.boosters)?ctx.record.boosters:[]).map(x=>positive(x.itemID))};
 }
 function privilegedReset(session,{kind}={}){
  const ctx=actor(session);if(!ctx.ok)return ctx;
  if(!["CLONE_COOLDOWN_RESET","REMOTE_HOME_COOLDOWN_RESET"].includes(kind))
   return deny("UNKNOWN_NATIVE_COOLDOWN_RESET");
  let allowed=false;
  try{allowed=isAuthorizedAdmin(session,ctx.charID)===true}
  catch{return deny("NATIVE_ADMIN_AUTHORITY_UNAVAILABLE")}
  if(!allowed)return deny("PLAYER_COOLDOWN_RESET_FORBIDDEN");
  return {ok:true,kind,characterID:ctx.charID,adminOnly:true};
 }
 function podDeath(session,{deathEventID}={}){
  const ctx=actor(session);if(!ctx.ok)return ctx;
  if(typeof deathEventID!=="string"||!/^[a-zA-Z0-9_.:-]{1,120}$/.test(deathEventID))
   return deny("NATIVE_POD_DEATH_EVENT_REQUIRED");
  let isNative=false;
  try{isNative=verifyDeathEvent(ctx.charID,deathEventID,positive(ctx.ship.itemID))===true}
  catch{return deny("NATIVE_POD_DEATH_EVENT_UNVERIFIED")}
  if(!isNative)return deny("NATIVE_POD_DEATH_EVENT_UNVERIFIED");
  return {ok:true,kind:"POD_DEATH",deathEventID,characterID:ctx.charID,
   activeImplants:activeImplants(ctx.record).map(x=>({itemID:positive(x.itemID),typeID:positive(x.typeID)})),
   jumpClones:cloneList(ctx.record).map(x=>positive(x.jumpCloneID)),
   homeStationID:positive(ctx.record.homeStationID||ctx.record.cloneStationID)};
 }
 return {actor,installClone,jump,homeStation,consume,podDeath,privilegedReset,
  validateUniqueImplants};
}
module.exports={createCloneGuard,validateUniqueImplants,FT,HOUR};
