"use strict";
// EX-03B18. Preserve the EXACT original ItemStore itemID at NPC death.
// NativeNpcWreckService owns the physical wreck; NO nativeWreckItem grant,
// reallocated cargo, clone, virtual warehouse credit or fake player session.
const POS=x=>Number.isSafeInteger(x)&&x>0;
const marker=/^coop-npc-expedition:v1:container:([1-9]\d*):ship:([1-9]\d*):corp:([1-9]\d*)(?::wreck:([1-9]\d*))?$/;
function parse(s){
 const m=marker.exec(String(s||""));if(!m)return null;
 const x=m.slice(1).map(v=>v===undefined?null:Number(v));
 return x.every(v=>v===null||POS(v))?
 {containerID:x[0],shipID:x[1],corpID:x[2],wreckID:x[3]}:null;
}
function createNpcExpeditionWreckCustody({items,npcStore,gameStore,maxItems=128}={}){
 if(!items||!npcStore||!gameStore||
  ["findItemById","listContainerItems","updateInventoryItem",
   "moveItemToLocation","transferItemToOwnerLocation"].some(k=>typeof items[k]!=="function")||
  ["getNativeWreck","listNativeWrecks"].some(k=>typeof npcStore[k]!=="function")||
  typeof gameStore.flushTableSync!=="function"||!POS(maxItems)||maxItems>512)
  throw Error("EX03_ORIGINAL_WRECK_ITEMSTORE_REQUIRED");
 const deny=errorMsg=>({success:false,errorMsg});
 const flush=()=>{try{return gameStore.flushTableSync("items")?.success===true}catch{return false}};
 const row=id=>{try{return items.findItemById(id)}catch{return null}};
 const cargo=(loc,flag)=>{const x=items.listContainerItems(null,loc,flag);
  return Array.isArray(x)&&x.length<=4096?x:null};
 const original=x=>x&&POS(x.itemID)&&POS(x.typeID)&&POS(x.ownerID)&&POS(x.locationID)&&
  (x.singleton===1&&x.stacksize===1||
   x.singleton===0&&POS(x.stacksize)&&x.quantity===x.stacksize);
 const same=(a,b)=>a&&b&&a.itemID===b.itemID&&a.typeID===b.typeID&&
   a.quantity===b.quantity&&a.stacksize===b.stacksize&&a.singleton===b.singleton;
 function verifiedWreck(wreckID){
  if(!POS(wreckID))return null;
  // Native store unavailability during a death/decay tick must reject this
  // action, not escape into the original NPC scheduler and kill its phase.
  let w;
  try{w=npcStore.getNativeWreck(wreckID)}catch{return null}
  if(!w||w.wreckID!==wreckID||!POS(w.sourceEntityID)||
    !POS(w.corporationID)||w.transient===true)return null;
  return w;
 }
 function list({wreckID}={}){
  const w=verifiedWreck(wreckID);if(!w)return [];
  let source;try{source=cargo(wreckID,items.ITEM_FLAGS.HANGAR)}catch{return []}
  if(!source)return [];
  return source.filter(x=>{
   const r=parse(x.customInfo);
   return original(x)&&r?.wreckID===wreckID&&
    r.shipID===w.sourceEntityID&&
    r.corpID===w.coopNpcExpeditionSourceCorpID&&
    x.ownerID===w.coopNpcExpeditionSourceCorpID&&x.locationID===wreckID&&
    x.flagID===items.ITEM_FLAGS.HANGAR;
  }).map(x=>({...x}));
 }
 function stage({wreckID,shipID,corporationID}={}){
  const w=verifiedWreck(wreckID);
  if(!w||!POS(shipID)||w.sourceEntityID!==shipID)
   return deny("EX03_WRECK_ORIGINAL_SOURCE_MISMATCH");
  let rows,other;
  try{
   // Read every flag: a damaged inventory flag must never hide physical
   // original cargo and let NPC death silently orphan its ItemStore item.
   rows=cargo(shipID,null);
   other=npcStore.listNativeWrecks();
  }catch{return deny("EX03_WRECK_SOURCE_UNAVAILABLE")}
  if(!rows||!Array.isArray(other)||other.length>100000)
   return deny("EX03_WRECK_SOURCE_UNAVAILABLE");
  const candidates=rows.filter(x=>String(x.customInfo||"").startsWith(
   "coop-npc-expedition:v1:"));
  // Even with no current cargo, a previous durable wreck for the same ship
  // means an incomplete earlier death and must never be silently replaced.
  if(other.some(x=>x?.sourceEntityID===shipID&&x.wreckID!==wreckID))
   return deny("EX03_WRECK_PREVIOUS_DEATH_OR_UNBOUNDED");
  if(candidates.length===0)return {success:true,status:"NO_EXPEDITION_LOOT",itemIDs:[]};
  // Ordinary native NPC wrecks without original exploration cargo are NOT
  // blocked by missing expedition-only provenance.
  if(!POS(corporationID)||w.coopNpcExpeditionSourceCorpID!==corporationID)
   return deny("EX03_WRECK_ORIGINAL_SOURCE_MISMATCH");
  if(candidates.length>maxItems)
   return deny("EX03_WRECK_PREVIOUS_DEATH_OR_UNBOUNDED");
  if(candidates.some(x=>{
   const r=parse(x.customInfo);
   return !original(x)||!r||r.wreckID!==null||
     r.shipID!==shipID||r.corpID!==corporationID||
     x.ownerID!==corporationID||x.locationID!==shipID||
     x.flagID!==items.ITEM_FLAGS.CARGO_HOLD;
  })||new Set(candidates.map(x=>x.itemID)).size!==candidates.length)
   return deny("EX03_WRECK_CUSTODY_UNVERIFIED");
  // Crash BEFORE these steps must not erase the source wreck; the original
  // native wreck row is persisted first, before a new ItemStore intent.
  let durable;
  try{durable=gameStore.flushTableSync("npcWrecks")?.success===true}catch{durable=false}
  if(!durable)return deny("EX03_WRECK_SOURCE_NOT_DURABLE");
  const processed=[];
  for(const before of candidates){
   const tag=before.customInfo+":wreck:"+wreckID;
   let result;
   try{result=items.updateInventoryItem(before.itemID,x=>({...x,customInfo:tag}))}
   catch{return deny("EX03_WRECK_ITEM_INTENT_UNCERTAIN")}
   if(result?.success!==true||!flush())
    return deny("EX03_WRECK_ITEM_INTENT_UNCERTAIN");
   const marked=row(before.itemID);
   if(!same(before,marked)||marked.customInfo!==tag||
      marked.locationID!==shipID||marked.ownerID!==corporationID)
    return deny("EX03_WRECK_ITEM_INTENT_CHANGED");
   try{result=items.moveItemToLocation(before.itemID,wreckID,items.ITEM_FLAGS.HANGAR)}
   catch{return deny("EX03_WRECK_ITEM_MOVE_UNCERTAIN")}
   if(result?.success!==true||!flush())
    return deny("EX03_WRECK_ITEM_MOVE_UNCERTAIN");
   const after=row(before.itemID);
   if(!same(before,after)||after.customInfo!==tag||
      after.locationID!==wreckID||after.ownerID!==corporationID||
      after.flagID!==items.ITEM_FLAGS.HANGAR)
    return deny("EX03_WRECK_ORIGINAL_ITEM_MOVED_INCONSISTENTLY");
   processed.push(before.itemID);
  }
  const visible=list({wreckID});
  if(visible.length!==processed.length||
   processed.some(id=>!visible.some(x=>x.itemID===id)))
   return deny("EX03_WRECK_NATIVE_VISIBILITY_UNVERIFIED");
  return {success:true,status:"ORIGINAL_ITEMSTORE_LOOT_IN_WRECK",
    itemIDs:processed,nativeItemMinted:false};
 }
 // EX-03B20: explicit operator-gated forward-only recovery of an original
 // ItemStore durable wreck intent. NEVER create wreck, spawn ship, refund
 // mass, move an untagged item, or choose a different original itemID.
 // A normal A-Life tick must never call this method.
 function reconcile({wreckID,shipID,corporationID,operatorApproved=false}={}){
  if(operatorApproved!==true)
   return deny("EX03_WRECK_OPERATOR_APPROVAL_REQUIRED");
  const w=verifiedWreck(wreckID);
  if(!w||!POS(shipID)||!POS(corporationID)||
   w.sourceEntityID!==shipID||
   w.coopNpcExpeditionSourceCorpID!==corporationID)
   return deny("EX03_WRECK_RECOVERY_SOURCE_MISMATCH");
  let source,held,allWrecks;
  try{
   // Recovery also inspects every flag, refusing corrupted source items
   // rather than incorrectly declaring the wreck fully reconciled.
   source=cargo(shipID,null);
   held=cargo(wreckID,null);
   allWrecks=npcStore.listNativeWrecks();
  }catch{return deny("EX03_WRECK_RECOVERY_SOURCE_UNAVAILABLE")}
  if(!source||!held||!Array.isArray(allWrecks)||
   allWrecks.some(x=>x?.sourceEntityID===shipID&&x.wreckID!==wreckID))
   return deny("EX03_WRECK_RECOVERY_AMBIGUOUS");
  const relevant=source.concat(held).filter(x=>
   String(x?.customInfo||"").startsWith("coop-npc-expedition:v1:"));
  if(relevant.length===0)return {success:true,status:"NO_ORIGINAL_WRECK_CUSTODY"};
  if(relevant.length>maxItems||
   new Set(relevant.map(x=>x.itemID)).size!==relevant.length)
   return deny("EX03_WRECK_RECOVERY_UNBOUNDED");
  const actions=[];
  for(const x of relevant){
   const r=parse(x.customInfo);
   const onShip=x.locationID===shipID&&x.flagID===items.ITEM_FLAGS.CARGO_HOLD;
   const inWreck=x.locationID===wreckID&&x.flagID===items.ITEM_FLAGS.HANGAR;
   // A multi-item death may SIGKILL after transferring the first item but
   // before marking the next. Explicit operator approval can finish ONLY
   // original unmodified provenance still on this same destroyed source hull.
   // Never accept a fresh/untagged item already moved to the wreck.
   const needsIntent=r?.wreckID===null;
   if(!original(x)||!r||r.shipID!==shipID||
      r.corpID!==corporationID||x.ownerID!==corporationID||
      (!onShip&&!inWreck)||
      (needsIntent?!onShip:r.wreckID!==wreckID))
    return deny("EX03_WRECK_RECOVERY_INVALID_ORIGINAL_RECEIPT");
   const exact=row(x.itemID);
   if(!same(x,exact)||exact.customInfo!==x.customInfo||
     exact.locationID!==x.locationID||exact.ownerID!==x.ownerID)
    return deny("EX03_WRECK_RECOVERY_INDEX_DISAGREEMENT");
   actions.push({itemID:x.itemID,move:onShip,needsIntent,
    tag:needsIntent?x.customInfo+":wreck:"+wreckID:x.customInfo,original:x});
  }
  // Confirm both original stock wreck ledger and existing item intents before
  // touching ANY item. The only allowed mutation is ship -> its existing wreck.
  if(!flush())return deny("EX03_WRECK_RECOVERY_ITEMS_NOT_DURABLE");
  try{if(gameStore.flushTableSync("npcWrecks")?.success!==true)
    return deny("EX03_WRECK_RECOVERY_WRECK_NOT_DURABLE")}
  catch{return deny("EX03_WRECK_RECOVERY_WRECK_NOT_DURABLE")}
  const resumed=[];
  for(const act of actions){
   if(act.needsIntent){
    // Per-item durable intent must precede its original-ID location move.
    // Uncertain writes stop the batch: do not infer a successful move.
    let stamped;
    try{
     stamped=items.updateInventoryItem(act.itemID,previous=>{
      if(!same(previous,act.original)||
       previous.customInfo!==act.original.customInfo||
       previous.locationID!==shipID||
       previous.ownerID!==corporationID||
       previous.flagID!==items.ITEM_FLAGS.CARGO_HOLD)
       throw Error("EX03_WRECK_RECOVERY_SOURCE_CHANGED");
      return {...previous,customInfo:act.tag};
     });
    }catch{return deny("EX03_WRECK_RECOVERY_INTENT_UNCERTAIN")}
    if(stamped?.success!==true||!flush())
     return deny("EX03_WRECK_RECOVERY_INTENT_UNCERTAIN");
    const marked=row(act.itemID);
    if(!same(act.original,marked)||
     marked.customInfo!==act.tag||
     marked.locationID!==shipID||marked.ownerID!==corporationID||
     marked.flagID!==items.ITEM_FLAGS.CARGO_HOLD)
     return deny("EX03_WRECK_RECOVERY_INTENT_CHANGED");
   }
   if(act.move){
    let changed;
    try{changed=items.moveItemToLocation(act.itemID,wreckID,
      items.ITEM_FLAGS.HANGAR)}
    catch{return deny("EX03_WRECK_RECOVERY_MOVE_UNCERTAIN")}
    if(changed?.success!==true||!flush())
     return deny("EX03_WRECK_RECOVERY_MOVE_UNCERTAIN");
   }
   const after=row(act.itemID);
   if(!same(act.original,after)||after.locationID!==wreckID||
      after.flagID!==items.ITEM_FLAGS.HANGAR||
      after.ownerID!==corporationID||
      after.customInfo!==act.tag)
    return deny("EX03_WRECK_RECOVERY_IDENTITY_CHANGED");
   resumed.push(act.itemID);
  }
  const visible=list({wreckID});
  if(resumed.some(id=>!visible.some(x=>x.itemID===id)))
   return deny("EX03_WRECK_RECOVERY_VISIBILITY_UNCONFIRMED");
  return {success:true,status:"ORIGINAL_WRECK_CUSTODY_RECOVERED",
   itemIDs:resumed,movedCount:actions.filter(x=>x.move).length,
   stampedCount:actions.filter(x=>x.needsIntent).length,
   nativeItemMinted:false};
 }
 function claim({characterID,wreckID,itemID,destinationLocationID,
   destinationFlagID,quantity}={}){
  const w=verifiedWreck(wreckID);
  if(!w||!POS(itemID)||!POS(characterID))
   return {status:"NOT_EXPEDITION_ITEM"};
  const originalRow=row(itemID),r=parse(originalRow?.customInfo);
  if(!r||r.wreckID!==wreckID||r.shipID!==w.sourceEntityID||
    r.corpID!==w.coopNpcExpeditionSourceCorpID||
    originalRow.locationID!==wreckID)
   return {status:"NOT_EXPEDITION_ITEM"};
  if(!POS(destinationLocationID)||destinationFlagID!==items.ITEM_FLAGS.CARGO_HOLD||
    !original(originalRow)||
    originalRow.ownerID!==w.coopNpcExpeditionSourceCorpID||
    originalRow.flagID!==items.ITEM_FLAGS.HANGAR||
    !list({wreckID}).some(x=>x.itemID===itemID))
   return {status:"HANDLED",...deny("EX03_WRECK_CLAIM_SOURCE_INVALID")};
  // No partial stack splits: the exact original itemID must be the claimed ID.
  const available=originalRow.singleton===1?1:originalRow.stacksize;
  if(quantity!==null&&quantity!==undefined&&quantity!==available)
   return {status:"HANDLED",...deny("EX03_WRECK_WHOLE_ORIGINAL_ITEM_REQUIRED")};
  const target=row(destinationLocationID);
  if(!target||target.itemID!==destinationLocationID||
    target.ownerID!==characterID||!POS(target.typeID))
   return {status:"HANDLED",...deny("EX03_WRECK_DESTINATION_NOT_CHARACTER_OWNED")};
  let result;
  try{result=items.transferItemToOwnerLocation(itemID,characterID,
    destinationLocationID,items.ITEM_FLAGS.CARGO_HOLD)}
  catch{return {status:"HANDLED",...deny("EX03_WRECK_TRANSFER_UNCERTAIN")}}
  if(result?.success!==true||!flush())
   return {status:"HANDLED",...deny("EX03_WRECK_TRANSFER_UNCERTAIN")};
  const after=row(itemID);
  if(!same(originalRow,after)||after.ownerID!==characterID||
    after.locationID!==destinationLocationID||
    after.flagID!==items.ITEM_FLAGS.CARGO_HOLD||
    after.customInfo!==originalRow.customInfo)
   return {status:"HANDLED",...deny("EX03_WRECK_TRANSFER_UNCERTAIN")};
  return {status:"HANDLED",success:true,data:{
   quantity:available,changes:[...((result.data?.changes)||[])]},originalItemID:itemID,
   nativeItemMinted:false};
 }
 function canDestroy(wreckID){
  const w=verifiedWreck(wreckID);
  if(!w)return false;
  // Never delete a live native wreck when original ItemStore cannot be read,
  // or when a corrupt/partial tag may hide custody from public inventory.
  let present,unresolved;
  try{
   // Read ALL flags. A damaged item can have the wrong flag but must never
   // become invisible to the expiry guard and be silently destroyed.
   present=cargo(wreckID,null);
   unresolved=cargo(w.sourceEntityID,null);
  }catch{return false}
  if(!present||!unresolved)return false;
  if(present.some(x=>String(x?.customInfo||"").startsWith(
   "coop-npc-expedition:v1:")))return false;
  // After a crash following the persistent intent, the original item may
  // still sit in the destroyed source hull. The wreck then cannot expire.
  // Even an apparently valid but mismatched marker is ambiguous on the
  // destroyed original hull. Fail closed; never expire it as empty.
  if(unresolved.some(x=>String(x?.customInfo||"").startsWith(
   "coop-npc-expedition:v1:")))return false;
  return true;
 }
 return Object.freeze({stage,reconcile,list,claim,canDestroy});
}
module.exports={createNpcExpeditionWreckCustody,parse};
