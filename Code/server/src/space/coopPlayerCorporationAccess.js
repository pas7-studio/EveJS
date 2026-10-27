"use strict";
// CH31: authorization from native corporation/character ownership and persisted
// member role state, never fleet membership or client session role snapshots.
// Read-only guard. The original native itemStore/industry/wallet own all writes.
const pos = x => Number.isSafeInteger(x) && x > 0;
const integer = x => typeof x === "number" && Number.isSafeInteger(x) ? x :
  (typeof x === "string" && /^(0|[1-9][0-9]*)$/.test(x) && Number.isSafeInteger(Number(x)) ? Number(x) : 0);
const mask = value => {
  try {const v=BigInt(value ?? 0);return v>=0n?v:0n;} catch (_) {return 0n;}
};
const CORP_HANGARS=new Set([115,116,117,118,119,120,121]);
const TAKE={115:8192n,116:16384n,117:32768n,118:65536n,119:131072n,120:262144n,121:524288n};
const QUERY={115:1048576n,116:2097152n,117:4194304n,118:8388608n,119:16777216n,120:33554432n,121:67108864n};
const WALLETS={1000:134217728n,1001:268435456n,1002:536870912n,1003:1073741824n,1004:2147483648n,1005:4294967296n,1006:8589934592n};
const FACTORY=1024n;
const BP_MASK=1024n|1125899906842624n|2251799813685248n;
// Native characterState.getCharacterRecord(id) returns a record keyed by id;
// it does NOT guarantee an embedded characterID. Confirm account+session
// identity, and verify the optional field only when actually present.
function selectedCharacter(session){
  const id=integer(session?.characterID),alias=integer(session?.charid);
  if(id&&alias&&id!==alias)return 0;
  return id||alias;
}
function authenticatedCharacter(session,id,record){
  if(!pos(id)||selectedCharacter(session)!==id||!record||
    session?.socket?.destroyed===true)return false;
  const account=integer(session?.userid),owner=integer(record.accountId??record.accountID);
  if(!pos(account)||!pos(owner)||account!==owner)return false;
  const embedded=record.characterID??record.charID;
  if(embedded!==undefined&&embedded!==null&&integer(embedded)!==id)return false;
  return true;
}
function createAuthority({getCorporation,getMember,getCharacter,getOffices,getDockedStation,getItem,getDirectorRole,getPersonnelRole,getRentRole,getRuntime}={}){
  if([getCorporation,getMember,getCharacter,getOffices,getDockedStation,getItem,getDirectorRole,getPersonnelRole,getRentRole,getRuntime]
    .some(x=>typeof x!=="function"))throw Error("CH31_NATIVE_CORPORATION_AUTHORITIES_REQUIRED");
  function actor(session,corpID){
    const id=selectedCharacter(session),corp=integer(corpID);
    if(!pos(id)||!pos(corp)||integer(session?.corporationID??session?.corpid)!==corp)return null;
    const record=getCorporation(corp),char=getCharacter(id),member=getMember(corp,id);
    if(!record||record.isNPC!==false||integer(record.corporationID)!==corp||
      !authenticatedCharacter(session,id,char)||integer(char.corporationID)!==corp||
      !member||integer(member.characterID)!==id||integer(member.corporationID)!==corp)return null;
    const directorMask=mask(getDirectorRole());
    if(directorMask===0n)return null;
    const isCEO=integer(record.ceoID)===id&&member.isCEO===true;
    const global=mask(member.roles);
    return {id,corp,record,member,isDirector:isCEO||(global&directorMask)===directorMask,global};
  }
  const isMember=(session,corpID)=>Boolean(actor(session,corpID));
  const canIndustry=(session,corpID)=>{const a=actor(session,corpID);return Boolean(a&&(a.isDirector||(a.global&FACTORY)===FACTORY));};
  const canBlueprint=(session,corpID)=>{const a=actor(session,corpID);return Boolean(a&&(a.isDirector||(a.global&BP_MASK)!==0n));};
  function rolesAt(a,locationID){
    const station=integer(locationID);
    if(!pos(station))return 0n;
    if(station===integer(a.record.stationID))return a.global|mask(a.member.rolesAtHQ);
    if(station===integer(a.member.baseID))return a.global|mask(a.member.rolesAtBase);
    return a.global|mask(a.member.rolesAtOther);
  }
  function canView(session,corpID,locationID,flagID){
    const a=actor(session,corpID);if(!a)return false;
    if(a.isDirector)return true;
    const flag=integer(flagID);
    if(flag===62)return (a.global&FACTORY)===FACTORY;
    if(CORP_HANGARS.has(flag))return (rolesAt(a,locationID)&QUERY[flag])===QUERY[flag];
    return false;
  }
  function canTake(session,corpID,locationID,flagID){
    const a=actor(session,corpID);if(!a)return false;
    if(a.isDirector)return true;
    const flag=integer(flagID);
    if(flag===62)return (a.global&FACTORY)===FACTORY;
    if(CORP_HANGARS.has(flag))return (rolesAt(a,locationID)&TAKE[flag])===TAKE[flag];
    // Corp-owned hulls, direct station assets, unknown flags must have a director.
    return false;
  }
  function canWallet(session,corpID,key){
    const a=actor(session,corpID),role=WALLETS[integer(key)];
    return Boolean(a&&(a.isDirector||Boolean(role&&(a.global&role)===role)));
  }
  function canRent(session,corpID){const a=actor(session,corpID),role=mask(getRentRole());
    return Boolean(a&&(a.isDirector||(role!==0n&&(a.global&role)===role)));}
  function canManageMembers(session,corpID){const a=actor(session,corpID);return Boolean(a?.isDirector);}
  function canRecruit(session,corpID){const a=actor(session,corpID),role=mask(getPersonnelRole());
    return Boolean(a&&(a.isDirector||(role!==0n&&(a.global&role)===role)));}
  function canExecuteActions(session,corpID,actions){
    if(!canManageMembers(session,corpID)||!Array.isArray(actions))return false;
    // Native ExecuteActions cash/share grants are not cross-wallet-atomic and
    // carry no durable idempotency key. Fail closed until Chat 01 binds a
    // true native atomic cash/share transfer with replay receipts.
    return actions.every(a=>a&&!(integer(a.verb)===4&&[6,7].includes(integer(a.property))));
  }
  function canUpdateApplication(session,corpID,applicationID,characterID,status){
    const corp=integer(corpID),appID=integer(applicationID),target=integer(characterID),st=integer(status);
    if(!pos(corp)||!pos(appID)||!pos(target))return false;
    const runtime=getRuntime(corp),application=runtime?.applications?.[String(appID)];
    if(!application||integer(application.applicationID)!==appID||
      integer(application.corporationID)!==corp||integer(application.characterID)!==target||
      application.deleted===true)return false;
    const previous=integer(application.status);
    if([4,5,6].includes(st))return canRecruit(session,corp)&&[0,1,5].includes(previous);
    if(!authenticatedCharacter(session,target,getCharacter(target)))return false;
    if(st===2||st===3)return [6,8].includes(previous);
    if(st===7||st===1)return [0,1].includes(previous);
    return false;
  }
  function officeAt(corpID,locationID){
    const corp=integer(corpID),loc=integer(locationID);
    const offices=getOffices(corp);
    if(!pos(corp)||!pos(loc)||!Array.isArray(offices))return null;
    return offices.find(office=>office&&!office.impounded&&
      pos(integer(office.stationID))&&
      [office.officeID,office.officeFolderID,office.itemID].some(v=>integer(v)===loc))||null;
  }
  function rootStation(item){
    let current=item;const visited=new Set();
    for(let i=0;i<15;i++){
      if(!current)return 0;
      const id=integer(current.itemID),location=integer(current.locationID);
      if(!pos(id)||!pos(location)||visited.has(id))return 0;
      visited.add(id);
      const parent=getItem(location);
      if(!parent)return location;
      current=parent;
    }
    return 0;
  }
  function authorizeInventoryMove({session,sourceItemDescriptor,destination}={}){
    if(sourceItemDescriptor?.sourceKind==="nativeWreck")return true; // stock wreck rights still required
    if(sourceItemDescriptor?.sourceKind!=="inventory"||!sourceItemDescriptor.item||!destination)return false;
    const item=sourceItemDescriptor.item,owner=integer(item.ownerID),id=selectedCharacter(session);
    if(!authenticatedCharacter(session,id,getCharacter(id))||!pos(owner)||!pos(integer(item.itemID)))return false;
    const corporation=getCorporation(owner);
    if(owner!==id){
      // No fleet membership or stale session permits taking corp or foreign personal assets.
      if(!corporation||corporation.isNPC!==false||!actor(session,owner))return false;
      const office=officeAt(owner,item.locationID);
      if(!office||!canTake(session,owner,office.stationID,item.flagID))return false;
    }
    const destFlag=integer(destination.flagID);
    if(CORP_HANGARS.has(destFlag)){
      const corpID=integer(session?.corporationID??session?.corpid),a=actor(session,corpID);
      const office=officeAt(corpID,destination.locationID);
      if(!a||!office||integer(getDockedStation(session))!==integer(office.stationID))return false;
      // Donation into the same real station: no remote item teleport from another station.
      const sourceRoot=rootStation(item);
      if(sourceRoot!==integer(office.stationID)&&
         !(owner===corpID&&officeAt(corpID,item.locationID)?.stationID===office.stationID))return false;
    }
    return true;
  }
  return Object.freeze({isMember,canIndustry,canBlueprint,canView,canTake,canWallet,
    authorizeInventoryMove,canRent,canManageMembers,canRecruit,canExecuteActions,canUpdateApplication,mode:"NATIVE_PLAYER_CORPORATION_READ_ONLY"});
}
function nativeAuthority(){
 const runtime=require("../services/corporation/corporationRuntimeState");
 const corp=require("../services/corporation/corporationState");
 const character=require("../services/character/characterState");
 const inventory=require("../services/inventory/itemStore");
 const location=require("../services/structure/structureLocation");
 return createAuthority({getCorporation:corp.getCorporationRecord,
  getMember:runtime.getCorporationMember,getCharacter:character.getCharacterRecord,
  getOffices:runtime.getCorporationOffices,getDockedStation:location.getDockedLocationID,
  getItem:inventory.findItemById,getDirectorRole:()=>runtime.CORP_ROLE_DIRECTOR,
  getPersonnelRole:()=>runtime.CORP_ROLE_PERSONNEL_MANAGER,
  getRentRole:()=>runtime.CORP_ROLE_CAN_RENT_OFFICE,getRuntime:runtime.getCorporationRuntime});
}
const delegation={};
for(const key of ["isMember","canIndustry","canBlueprint","canView","canTake","canWallet","authorizeInventoryMove","canRent","canManageMembers","canRecruit","canExecuteActions","canUpdateApplication"]){
 delegation[key]=(...args)=>{try{return nativeAuthority()[key](...args)===true;}catch(_){return false;}};
}
module.exports={createAuthority,...delegation};
