"use strict";
// PVE-005B-2: read-only original itemStore hangar custody and native
// standing transaction evidence for ONE character's own native mission.
// No item mutation, standing adjustment, payout, mission or replay.
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const qty=item=>Number.isSafeInteger(item?.stacksize)&&item.stacksize>0?item.stacksize:null;
const key=entry=>JSON.stringify([
 Number(entry.fromID),Number(entry.toID),Number(entry.eventTypeID),
 String(entry.eventDateTime),Number(entry.modification),
 String(entry.msg||""),entry.int_1??null,entry.int_2??null,entry.int_3??null
]);
function inventory(items,characterID,stationID,hangarFlag){
 if(!Array.isArray(items)||items.length>10000)return null;
 const ids=new Set(),counts=new Map();
 for(const item of items){
  // Native/GameStore serialization may represent the same numeric itemID
  // as a number or decimal string. Normalize BEFORE checking uniqueness.
  const itemID=id(item?.itemID),typeID=id(item?.typeID);
  if(!itemID||ids.has(itemID)||!typeID||
     item.ownerID!==characterID||item.locationID!==stationID||
     item.flagID!==hangarFlag||qty(item)===null)return null;
  ids.add(itemID);
  const total=(counts.get(typeID)||0)+qty(item);
  if(!Number.isSafeInteger(total))return null;
  counts.set(typeID,total);
 }
 return {counts,ids};
}
function expectedItems(mission,agent,iskDelta){
 const rewards=mission?.rewards||{};
 const base=Number(rewards.isk||0),bonus=Number(rewards.bonusIsk||0);
 if(!Number.isFinite(iskDelta)||!Number.isFinite(base)||!Number.isFinite(bonus)||
    base<0||bonus<0)return null;
 const eps=0.011;
 // Native isMissionBonusRewardAvailable() always permits untimed
 // bonuses, even if bonusIsk=0 and only bonusItemRewards are present.
 // For timed zero-ISK bonuses the wallet journal cannot distinguish
 // bonus availability: refuse to certify inventory without a native
 // transaction-scoped bonus flag rather than silently ignore items.
 const bonusItemRows=Array.isArray(rewards.bonusItemRewards)?
  rewards.bonusItemRewards:[];
 const zeroIskBonus=bonus===0&&bonusItemRows.length>0;
 const interval=Number(rewards.bonusTimeIntervalMinutes||0);
 if(zeroIskBonus&&(!Number.isSafeInteger(interval)||interval<0||
   interval>0))return null;
 const withBonus=zeroIskBonus||
  (bonus>0&&Math.abs(iskDelta-(base+bonus))<eps);
 if(Math.abs(iskDelta-base)>=eps&&!withBonus)return null;
 const entries=[
  ...(Array.isArray(rewards.itemRewards)?rewards.itemRewards:[]),
  ...(withBonus&&Array.isArray(rewards.bonusItemRewards)?rewards.bonusItemRewards:[])
 ];
 const counts=new Map();
 for(const entry of entries){
  const type=id(entry?.typeID),quantity=id(entry?.quantity);
  if(!type||!quantity)return null;
  counts.set(type,(counts.get(type)||0)+quantity);
 }
 return {counts,withBonus};
}
function snapshot({characterID,agentID,mission,getAgent,getItems,getStandingRows,
 getChanges,getHangarFlag}={}){
 const char=id(characterID),aid=id(agentID);
 if(!char||!aid||!mission||[getAgent,getItems,getStandingRows,
  getChanges,getHangarFlag].some(fn=>typeof fn!=="function"))
  return {status:"NATIVE_CUSTODY_API_UNAVAILABLE"};
 try{
  const agent=getAgent(aid);
  if(id(agent?.agentID)!==aid||!id(agent?.corporationID))
   return {status:"NATIVE_CUSTODY_AGENT_UNVERIFIED"};
  const rewardStation=id(mission?.dropoffLocation?.locationID)||
   id(agent.stationID);
  const flag=getHangarFlag();
  if(!Number.isSafeInteger(flag)||flag<0)return {status:"NATIVE_CUSTODY_FLAG_UNAVAILABLE"};
  const definitions=getChanges(agent,mission,"completed");
  if(!Array.isArray(definitions)||definitions.length>10)
   return {status:"NATIVE_STANDING_EXPECTATION_UNAVAILABLE"};
  const direct=definitions.filter(x=>id(x.ownerID)&&
   Number.isFinite(x.rawChange)&&Math.abs(x.rawChange)>1e-9);
  const owners=[...new Set(direct.map(x=>x.ownerID))];
  if(owners.length!==direct.length)
   return {status:"NATIVE_STANDING_EXPECTATION_AMBIGUOUS"};
  const standings={};
  for(const owner of owners){
   const rows=getStandingRows(owner,char);
   if(!Array.isArray(rows)||rows.length>10000||
      rows.some(x=>Number(x.fromID)!==owner||
       Number(x.toID)!==char||!id(x.eventTypeID)||
       typeof x.eventDateTime!=="string"||!Number.isFinite(x.modification)))
    return {status:"NATIVE_STANDING_SOURCE_UNAVAILABLE"};
   standings[owner]=rows.map(x=>({...x}));
  }
  const itemRewards=[...(mission?.rewards?.itemRewards||[]),
   ...(mission?.rewards?.bonusItemRewards||[])];
  const hasItems=itemRewards.length>0;
  if(hasItems&&!rewardStation)return {status:"NATIVE_REWARD_STATION_UNKNOWN"};
  const originalItems=rewardStation?getItems(char,rewardStation,flag):[];
  if(!inventory(originalItems,char,rewardStation||0,flag))
   return {status:"NATIVE_HANGAR_SOURCE_UNAVAILABLE"};
  return {status:"NATIVE_PERSONAL_CUSTODY_SNAPSHOT",
   characterID:char,agentID:aid,corporationID:agent.corporationID,
   missionSequence:id(mission.missionSequence),
   stationID:rewardStation||null,hangarFlag:flag,
   inventory:originalItems.map(x=>({...x})),
   directStanding:direct.map(x=>({ownerID:x.ownerID,eventTypeID:x.eventTypeID,
    rawChange:x.rawChange})),standings};
 }catch{return {status:"NATIVE_CUSTODY_SOURCE_UNAVAILABLE"}}
}
function multiset(rows){
 const counts=new Map();
 for(const row of rows){
  const k=key(row);
  counts.set(k,(counts.get(k)||0)+1);
 }
 return counts;
}
function verify({before,after,mission,characterID,agentID,personalReward}={}){
 const char=id(characterID),aid=id(agentID);
 const fail=status=>({status,characterID:char,agentID:aid});
 if(!char||!aid||before?.status!=="NATIVE_PERSONAL_CUSTODY_SNAPSHOT"||
  after?.status!=="NATIVE_PERSONAL_CUSTODY_SNAPSHOT"||
  before.characterID!==char||after.characterID!==char||
  before.agentID!==aid||after.agentID!==aid||
  before.missionSequence!==id(mission?.missionSequence)||
  after.missionSequence!==before.missionSequence||
  before.corporationID!==after.corporationID||
  before.stationID!==after.stationID||
  before.hangarFlag!==after.hangarFlag||
  personalReward?.status!=="NATIVE_PERSONAL_REWARD_SOURCE_VERIFIED"||
  personalReward.characterID!==char||
  personalReward.agentID!==aid||
  personalReward.missionSequence!==before.missionSequence)
  return fail("NATIVE_PERSONAL_CUSTODY_IDENTITY_MISMATCH");
 const original=inventory(before.inventory,char,before.stationID||0,before.hangarFlag),
  current=inventory(after.inventory,char,after.stationID||0,after.hangarFlag);
 if(!original||!current)return fail("NATIVE_HANGAR_SOURCE_UNAVAILABLE");
 const wanted=expectedItems(mission,null,personalReward.iskDelta);
 if(!wanted)return fail("NATIVE_ITEM_REWARD_CONFIGURATION_UNSUPPORTED");
 const allTypes=new Set([...original.counts.keys(),...current.counts.keys(),...wanted.counts.keys()]);
 for(const type of allTypes){
  const delta=(current.counts.get(type)||0)-(original.counts.get(type)||0);
  if(delta!==(wanted.counts.get(type)||0))
   return fail("NATIVE_REWARD_ITEM_CUSTODY_MISMATCH");
 }
 const originalByID=new Map(before.inventory.map(x=>[id(x.itemID),x]));
 const itemIDs=[];
 for(const item of after.inventory){
  const canonicalID=id(item.itemID);
  const old=originalByID.get(canonicalID);
  if(old&&id(old.typeID)!==id(item.typeID))
   return fail("NATIVE_INVENTORY_ITEM_ID_REUSED");
  if(!old)itemIDs.push(canonicalID);
  if(old&&item.stacksize<old.stacksize)
   return fail("NATIVE_REWARD_HANGAR_SOURCE_DECREMENTED");
 }
 const direct=before.directStanding||[];
 if(JSON.stringify(direct)!==JSON.stringify(after.directStanding))
  return fail("NATIVE_STANDING_EXPECTATION_CHANGED");
 const standingReceipts=[];
 for(const expected of direct){
  const owner=expected.ownerID;
  const beforeRows=before.standings?.[owner],afterRows=after.standings?.[owner];
  if(!Array.isArray(beforeRows)||!Array.isArray(afterRows))
   return fail("NATIVE_STANDING_SOURCE_UNAVAILABLE");
  const previous=multiset(beforeRows),currentCounts=multiset(afterRows);
  for(const [k,v] of previous.entries())
   if((currentCounts.get(k)||0)<v)
    return fail("NATIVE_STANDING_HISTORY_TRUNCATED_OR_CHANGED");
  const newRows=[];
  for(const row of afterRows){
   const k=key(row),old=previous.get(k)||0;
   if(old>0){previous.set(k,old-1);continue}
   newRows.push(row);
  }
  const directRows=newRows.filter(x=>Number(x.eventTypeID)===Number(expected.eventTypeID));
  if(directRows.length!==1||!Number.isFinite(directRows[0].modification)||
      Math.abs(directRows[0].modification)<=1e-9||
      // A loss may not certify a positive mission-standing reward (or vice versa).
      // Native application may scale magnitude, but it cannot invert direction.
      Math.sign(directRows[0].modification)!==Math.sign(expected.rawChange))
   return fail("NATIVE_PERSONAL_STANDING_TRANSACTION_UNVERIFIED");
  standingReceipts.push({ownerID:owner,eventTypeID:Number(expected.eventTypeID),
   eventDateTime:directRows[0].eventDateTime,
   rawModification:directRows[0].modification});
 }
 return {status:"NATIVE_PERSONAL_REWARD_CUSTODY_VERIFIED",
  characterID:char,agentID:aid,missionSequence:before.missionSequence,
  stationID:before.stationID,itemCount:[...wanted.counts.values()].reduce((a,b)=>a+b,0),
  expectedTypes:[...wanted.counts].map(([typeID,quantity])=>({typeID,quantity})),
  newItemIDs:itemIDs,originalStandingTransactions:standingReceipts,
  itemsVerified:true,standingMutationReceiptVerified:true,
  evidence:"ORIGINAL_HANGAR_TYPE_QUANTITY_AND_NATIVE_STANDING_TRANSACTION_DELTAS"};
}
function nativeAdapters(){
 const item=require("../services/inventory/itemStore"),
  agent=require("../services/agent/agentAuthority"),
  standing=require("../services/character/standingRuntime");
 return {getAgent:agent.getAgentByID,
  getItems:(char,station,flag)=>item.listContainerItems(char,station,flag),
  getStandingRows:(owner,char)=>standing.getStandingTransactions(owner,char),
  getChanges:(record,mission,outcome)=>standing.buildMissionOutcomeStandingChanges(record,mission,outcome),
  getHangarFlag:()=>item.ITEM_FLAGS.HANGAR};
}
function captureNative(characterID,agentID,mission){
 try{return snapshot({characterID,agentID,mission,...nativeAdapters()})}
 catch{return {status:"NATIVE_CUSTODY_SOURCE_UNAVAILABLE"}}
}
module.exports={snapshot,verify,captureNative,expectedItems};
