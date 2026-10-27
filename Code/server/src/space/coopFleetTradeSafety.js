"use strict";
// P0: use STOCK EveJS station-to-station two-party trade. No direct
// inventory write, ship clone, wallet grant, or synthetic transfer.
// Fail closed on stale pre-confirmation state for actual fleet members.
const id=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
function check({trade,session,peerSession,items=[],getItem,
 isTradable,containedItems=()=>[],fleetRuntime,getDockedLocationID}={}){
 const party=require("./coopNativeFleetParty").membership({
  leaderSession:session,peerSession,fleetRuntime});
 if(!party.ok)return {ok:false,reason:"NOT_AUTHORIZED_NATIVE_FLEET"};
 if(!trade||trade.status!=="open"||!Array.isArray(trade.traders)||
  trade.traders.length!==2||!trade.traders.includes(party.leaderCharacterID)||
  !trade.traders.includes(party.peerCharacterID)||
  !Number.isSafeInteger(trade.tradeContainerID)||
  !id(trade.dockedLocationID))
  return {ok:false,reason:"TRADE_NOT_OPEN"};
 if(typeof getDockedLocationID!=="function"||
  id(getDockedLocationID(session))!==id(trade.dockedLocationID)||
  id(getDockedLocationID(peerSession))!==id(trade.dockedLocationID))
  return {ok:false,reason:"NOT_DOCKED_TOGETHER"};
 if(typeof getItem!=="function"||typeof isTradable!=="function"||
  !Array.isArray(items))return {ok:false,reason:"NATIVE_INVENTORY_UNAVAILABLE"};
 const amount=trade.moneyOffers||[];
 // Stock EveJS transfers ISK before items without an atomic commit;
 // restrict the co-op gift path to zero ISK rather than risk debited
 // wallets and partially moved ships/items on an item transfer error.
 if(!Array.isArray(amount)||amount.length!==2||
  amount.some(v=>!Number.isFinite(v)||v!==0))
  return {ok:false,reason:"MIXED_MONEY_TRADE_NOT_ATOMIC"};
 const roots=new Set();
 const activeIDs=new Set([session.activeShipID,peerSession.activeShipID,
  session?._space?.shipID,peerSession?._space?.shipID].map(id).filter(Boolean));
 const allItems=new Set();
 for(const candidate of items){
  const itemID=id(candidate?.itemID);
  if(!itemID||roots.has(itemID))
   return {ok:false,reason:"INVALID_OR_DUPLICATED_TRADE_ITEM"};
  roots.add(itemID);
  const native=getItem(itemID);
  if(!native||id(native.itemID)!==itemID||
   !trade.traders.includes(id(native.ownerID))||
   id(native.locationID)!==id(trade.tradeContainerID)||
   activeIDs.has(itemID)||!isTradable(native))
   return {ok:false,reason:"STALE_OR_UNTRADABLE_NATIVE_ITEM"};
  const descendants=containedItems(itemID);
  if(!Array.isArray(descendants))
   return {ok:false,reason:"NATIVE_CARGO_UNAVAILABLE"};
  const inventory=[native,...descendants];
  for(const entry of inventory){
   const childID=id(entry?.itemID);
   if(!childID||allItems.has(childID)||
    id(entry.ownerID)!==id(native.ownerID)||
    activeIDs.has(childID))
    return {ok:false,reason:"INVALID_NESTED_SHIP_OWNERSHIP"};
   allItems.add(childID);
  }
 }
 return {ok:true,status:"NATIVE_DOCKED_FLEET_TRADE_READY",
  fleetID:party.fleetID,itemCount:allItems.size,rootCount:roots.size,
  shipTransferRequiresInactiveHull:true};
}
module.exports={check};
