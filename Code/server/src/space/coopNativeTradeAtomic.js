"use strict";
// Pure all-or-nothing plan for EveJS's EXISTING native items table.
// No new item IDs, no split stacks, no wallet mutations, no new economy.
const id = v => Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : null;
function plan({trade,roots,items,activeShipIDs=[]}={}) {
  const fail = reason => ({ok:false,reason});
  if (!trade || trade.status !== 'open' || !id(trade.tradeContainerID) || !id(trade.dockedLocationID) ||
      !Array.isArray(trade.traders) || trade.traders.length !== 2 ||
      !trade.traders.every(id) || trade.traders[0] === trade.traders[1]) return fail('INVALID_TRADE');
  if (!Array.isArray(trade.moneyOffers) || trade.moneyOffers.length !== 2 ||
      trade.moneyOffers.some(x=>typeof x !== 'number' || !Number.isFinite(x) || x !== 0)) return fail('NONZERO_ISK_NOT_ATOMIC');
  if (!Array.isArray(roots) || !items || typeof items !== 'object' || Array.isArray(items) ||
      !Array.isArray(activeShipIDs)) return fail('INVALID_NATIVE_ITEMS');
  const original = new Map();
  for (const [key,item] of Object.entries(items)) {
    if (!id(key) || !item || id(item.itemID) !== Number(key)) return fail('INVALID_NATIVE_ROW');
    original.set(Number(key),item);
  }
  const expectedRoots = [...original.values()].filter(x=>Number(x.locationID)===Number(trade.tradeContainerID))
    .map(x=>Number(x.itemID)).sort((a,b)=>a-b);
  const offered = roots.map(x=>id(x?.itemID)).sort((a,b)=>a-b);
  if (offered.some(x=>!x) || offered.length !== new Set(offered).size ||
      offered.length !== expectedRoots.length || offered.some((x,i)=>x!==expectedRoots[i]))
    return fail('TRADE_MANIFEST_CHANGED');
  const children = new Map();
  for (const item of original.values()) {
    const loc=Number(item.locationID);
    if (!children.has(loc)) children.set(loc,[]);
    children.get(loc).push(item);
  }
  const active = new Set(activeShipIDs.map(id).filter(Boolean));
  const seen = new Set(), updates=[];
  for (const rootID of offered) {
    const root = original.get(rootID);
    const sender=id(root?.ownerID);
    if (!sender || !trade.traders.includes(sender) || active.has(rootID)) return fail('INVALID_TRADE_ROOT');
    const recipient=trade.traders.find(x=>x!==sender);
    const queue=[root];
    for(let i=0;i<queue.length;i++) {
      if (i >= 10000) return fail('NESTED_CARGO_LIMIT');
      const item=queue[i], itemID=id(item?.itemID);
      if(!itemID || seen.has(itemID) || id(item.ownerID)!==sender || active.has(itemID))
        return fail('INVALID_NESTED_CUSTODY');
      if (!id(item.typeID) || !id(item.locationID) ||
          !Number.isSafeInteger(Number(item.stacksize)) || Number(item.stacksize)<=0 ||
          ![0,1,2].includes(Number(item.singleton||0))) return fail('INVALID_NATIVE_QUANTITY');
      seen.add(itemID);
      const isRoot=itemID===rootID;
      const expectedLoc=isRoot?Number(trade.tradeContainerID):Number(item.locationID);
      if (Number(item.locationID)!==expectedLoc) return fail('INVALID_NATIVE_LOCATION');
      // The ROOT moves to docked hangar; fitted modules/cargo retain their
      // locationID and flagID inside the same unique physical ship ID.
      updates.push({itemID,previous:item,ownerID:recipient,
        locationID:isRoot?Number(trade.dockedLocationID):Number(item.locationID),
        flagID:isRoot?4:Number(item.flagID)});
      for(const child of children.get(itemID)||[]) queue.push(child);
    }
  }
  return {ok:true,changes:updates,rootCount:offered.length};
}
function assertZeroMoney(trade, service){
 if(!Array.isArray(trade?.moneyOffers)||trade.moneyOffers.length!==2||
    trade.moneyOffers.some(x=>typeof x!=='number'||!Number.isFinite(x)||x!==0)){
   service._resetOfferState(trade);
   service._throwTradeError('Native atomic trade requires zero ISK; wallet settlement is not atomic.');
 }
}
function commitNative({trade,roots,activeShipIDs,readItems,writeItems,
 normalizeInventoryItem,buildInventoryItem,indexDeltaFromChanges,cloneValue,readCharacters,flushItems}={}){
 if(typeof readItems!=='function'||typeof writeItems!=='function'||typeof readCharacters!=='function'||typeof flushItems!=='function'||
    typeof normalizeInventoryItem!=='function'||typeof buildInventoryItem!=='function'||
    typeof indexDeltaFromChanges!=='function'||typeof cloneValue!=='function')
   return {success:false,errorMsg:'NATIVE_INVENTORY_UNAVAILABLE'};
 const original=readItems();
 const characters=readCharacters();
 if(!characters||!Array.isArray(trade?.traders)||!trade.traders.every(x=>characters[String(x)]&&id(characters[String(x)].shipID)))
   return {success:false,errorMsg:'NATIVE_CHARACTER_STATE_UNAVAILABLE'};
 const actualActive=[...activeShipIDs,...trade.traders.map(x=>characters[String(x)].shipID)];
 const result=plan({trade,roots,items:original,activeShipIDs:actualActive});
 if(!result.ok)return {success:false,errorMsg:result.reason};
 const next={...original},changes=[];
 for(const change of result.changes){
   const prev=normalizeInventoryItem(change.previous);
   if(!prev)return {success:false,errorMsg:'INVALID_TRADE_ITEM'};
   const modified=buildInventoryItem({...prev,
     ownerID:change.ownerID,locationID:change.locationID,flagID:change.flagID});
   if(modified.itemID!==change.itemID||modified.ownerID!==change.ownerID||
      modified.locationID!==change.locationID||modified.flagID!==change.flagID)
     return {success:false,errorMsg:'INVALID_TRADE_MUTATION'};
   next[String(change.itemID)]=modified;
   changes.push({removed:false,previousData:cloneValue(prev),item:cloneValue(modified)});
 }
 // One repository write; all native owners and nested cargo update together.
 try{
   if(changes.length&&!writeItems(next,{indexDelta:indexDeltaFromChanges(changes)}))
     return {success:false,errorMsg:'TRADE_ATOMIC_WRITE_FAILED'};
   // GameStore.write schedules asynchronous persistence. Force the native
   // SQLite items-table flush BEFORE telling clients trade was completed.
   if(changes.length&&flushItems()?.success!==true)
     return {success:false,errorMsg:'TRADE_PERSISTENCE_UNCERTAIN_NEEDS_REPAIR'};
 }catch(_error){return {success:false,errorMsg:'TRADE_ATOMIC_WRITE_FAILED'};}
 return {success:true,data:{changes}};
}
module.exports={plan,assertZeroMoney,commitNative};