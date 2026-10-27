"use strict";
// Two PHYSICAL stages, each a single actual native SQLite transaction:
// wreck -> authentic nearby player's SHIP CARGO -> corp station warehouse.
// Never remote-warp cargo or mint items in a stage without a live authority.
const pos=x=>Number.isSafeInteger(x)&&x>0;
const deny=status=>({status});
const marker=(k,c,w)=>"coop-salvage:v1:"+k+":"+c+":"+w;
const journalKey="coopSalvageMoves";
const receiptKey=a=>a.manifestKey+":"+a.cargoID;
function createNativeSalvageTransfer({atomic,readWitness,readManifest,
 readOriginalWreckItem,listNativeItems,buildInventoryItem,
 verifyPickupPresence,verifyDocking,readMoveJournal}={}){
 if(typeof atomic?.transact!=="function"||
  [readWitness,readManifest,readOriginalWreckItem,listNativeItems,
   buildInventoryItem,verifyPickupPresence,verifyDocking,readMoveJournal]
   .some(f=>typeof f!=="function"))
  throw Error("SALVAGE_NATIVE_SQLITE_AUTHORITIES_REQUIRED");
 function source(args){
  if(!/^\d+-\d+-\d+$/.test(String(args?.manifestKey))||
   ![args.cargoID,args.wreckItemID,args.stationID,args.corporationID,
    args.quantity,args.expectedWreckID,args.characterID,args.shipID].every(pos))
   return deny("SALVAGE_NATIVE_IDENTITY_INVALID");
  let witness,manifest;
  try{witness=readWitness(args.manifestKey);manifest=readManifest(args.manifestKey)}
  catch{return deny("SALVAGE_ORIGINAL_SOURCE_UNAVAILABLE")}
  const r=witness?.record,m=manifest?.record;
  if(witness?.status!=="READY"||r?.manifestKey!==args.manifestKey||
   manifest?.status!=="READY"||m?.key!==args.manifestKey||
   r.wreckID!==args.expectedWreckID||
   r.stationID!==args.stationID||m.stationID!==args.stationID||
   r.corporationID!==args.corporationID||
   m.corporationID!==args.corporationID||
   !r.rows?.some(x=>x.cargoID===args.cargoID&&
    x.wreckItemID===args.wreckItemID&&x.quantity===args.quantity&&
    m.cargo?.some(c=>c.cargoID===x.cargoID&&
     c.typeID===x.typeID&&c.quantity>=x.quantity)))
   return deny("SALVAGE_ORIGINAL_PROVENANCE_UNVERIFIED");
  return {status:"READY",row:r.rows.find(x=>
   x.cargoID===args.cargoID&&x.wreckItemID===args.wreckItemID)};
 }
 function inspect(args){
  const a=source(args);if(a.status!=="READY")return a;
  const label=marker(args.manifestKey,args.cargoID,args.wreckItemID);
  let items,wreck,journal;
  try{items=listNativeItems();wreck=readOriginalWreckItem(args.wreckItemID);
   journal=readMoveJournal()}
  catch{return deny("SALVAGE_NATIVE_ITEM_READ_UNAVAILABLE")}
  if(!Array.isArray(items))return deny("SALVAGE_NATIVE_ITEM_READ_UNAVAILABLE");
  const matching=items.filter(x=>x?.customInfo===label);
  const receipt=journal?.moves?.[receiptKey(args)];
  if(journal&&journal.version!==1)return deny("SALVAGE_RECEIPT_LEDGER_CORRUPT");
  if(receipt&&(receipt.manifestKey!==args.manifestKey||
   receipt.cargoID!==args.cargoID||receipt.wreckItemID!==args.wreckItemID||
   receipt.wreckID!==args.expectedWreckID||
   receipt.quantity!==args.quantity||receipt.characterID!==args.characterID||
   receipt.shipID!==args.shipID||receipt.stationID!==args.stationID||
   receipt.corporationID!==args.corporationID))
   return deny("SALVAGE_RECEIPT_IDENTITY_CONFLICT");
  if(matching.length===0)return wreck&&!receipt?
   deny("NOT_FOUND"):deny("SALVAGE_SOURCE_DISAPPEARED_NO_RECEIPT");
  if(!receipt)return deny("SALVAGE_ATOMIC_RECEIPT_NOT_FOUND");
  if(matching.length!==1)return deny("SALVAGE_DUPLICATED_NATIVE_STOCK");
  const item=matching[0];
  if(wreck||receipt.nativeItemID!==item.itemID||
   !pos(item.itemID)||item.typeID!==a.row.typeID||
   item.quantity!==args.quantity||item.stacksize!==args.quantity||
   item.singleton!==0)
   return deny("SALVAGE_NATIVE_ITEM_CUSTODY_CONFLICT");
  const base={manifestKey:args.manifestKey,cargoID:args.cargoID,
   wreckID:args.expectedWreckID,wreckItemID:args.wreckItemID,
   stationID:args.stationID,corporationID:args.corporationID,
   quantity:args.quantity,nativeWarehouseItemID:item.itemID,
   sourceDebited:true,nativeDurable:true};
  if(receipt.state==="PLAYER_CARGO"&&
   item.ownerID===args.characterID&&item.locationID===args.shipID&&
   item.flagID===5)return {status:"SALVAGE_NATIVE_PLAYER_CARGO",...base};
  if(receipt.state==="DELIVERED"&&
   item.ownerID===args.corporationID&&item.locationID===args.stationID&&
   item.flagID===4)
   return {status:"ATOMIC_NATIVE_ITEM_MOVED",...base,
    destinationCredited:true};
  return deny("SALVAGE_NATIVE_ITEM_LOCATION_CONFLICT");
 }
 function pickup(args){
  if(process.env.EVEJS_COOP_SALVAGE_ATOMIC_TRANSFER!=="1"||
   process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1")
   return deny("DISABLED");
  const evidence=source(args);if(evidence.status!=="READY")return evidence;
  const existing=inspect(args);
  if(["SALVAGE_NATIVE_PLAYER_CARGO","ATOMIC_NATIVE_ITEM_MOVED"].includes(existing.status))
   return existing;
  if(existing.status!=="NOT_FOUND")return existing;
  let physical;
  try{physical=verifyPickupPresence(args)}
  catch{return deny("SALVAGE_PLAYER_WRECK_PRESENCE_UNAVAILABLE")}
  if(physical?.status!=="LIVE_NATIVE_WRECK_PICKUP_VERIFIED"||
   physical.characterID!==args.characterID||
   physical.shipID!==args.shipID||
   physical.wreckID!==args.expectedWreckID||
   physical.distanceMeters>2500||physical.distanceMeters<0)
   return deny("SALVAGE_WRECK_PICKUP_OUT_OF_RANGE");
  const label=marker(args.manifestKey,args.cargoID,args.wreckItemID);
  try{
   const result=atomic.transact(["npcWreckItems","npcWrecks","items","identityState","corporationRuntime"],tx=>{
    const records=tx.get("npcWreckItems","items");
    const wrecks=tx.get("npcWrecks","wrecks");
    const actual=records?.[String(args.wreckItemID)];
    const wreck=wrecks?.[String(args.expectedWreckID)];
    if(!actual||actual.wreckID!==args.expectedWreckID||
     actual.sourceKind!=="cargo"||
     actual.sourceCargoID!==args.cargoID||
     actual.typeID!==evidence.row.typeID||
     actual.quantity!==args.quantity||actual.singleton===true||
     wreck?.wreckID!==args.expectedWreckID||
     wreck.systemID!==physical.systemID||
     wreck.sourceEntityID!==physical.haulerID)
     throw Error("SALVAGE_NATIVE_WRECK_PROVENANCE_CHANGED");
    if(Object.values(records).some(x=>x!==actual&&
     x?.sourceCargoID===args.cargoID))
     throw Error("SALVAGE_DUPLICATE_NATIVE_CARGO");
    const all=tx.scan("items");
    const journal=tx.get("corporationRuntime",journalKey)||{version:1,moves:{}};
    if(journal.version!==1||!journal.moves||
     typeof journal.moves!=="object"||
     Object.keys(journal.moves).length>10000||
     journal.moves[receiptKey(args)])
     throw Error("SALVAGE_ATOMIC_JOURNAL_EXISTS_OR_CORRUPT");
    if(all.some(x=>x.value?.customInfo===label))
     throw Error("SALVAGE_NATIVE_STOCK_ALREADY_CREATED");
    const nextID=tx.get("identityState","nextItemID");
    if(!pos(nextID))throw Error("SALVAGE_ID_ALLOCATOR_MISSING");
    const maximum=all.reduce((n,x)=>Math.max(n,Number(x.value?.itemID)||0),0);
    const itemID=Math.max(nextID,maximum+1);
    if(!pos(itemID)||!Number.isSafeInteger(itemID+1))
     throw Error("SALVAGE_ID_COLLISION");
    const item=buildInventoryItem({itemID,typeID:actual.typeID,
     itemName:actual.itemName,ownerID:args.characterID,
     locationID:args.shipID,flagID:5,
     quantity:args.quantity,stacksize:args.quantity,singleton:0,
     customInfo:label});
    if(item?.itemID!==itemID||item.typeID!==actual.typeID||
     item.ownerID!==args.characterID||item.locationID!==args.shipID||
     item.flagID!==5||item.quantity!==args.quantity||
     item.stacksize!==args.quantity||item.singleton!==0||
     item.customInfo!==label)
     throw Error("SALVAGE_PLAYER_CARGO_ITEM_INVALID");
    const remaining={...records};
    delete remaining[String(args.wreckItemID)];
    tx.put("npcWreckItems","items",remaining);
    tx.put("identityState","nextItemID",itemID+1);
    tx.put("items",String(itemID),item);
    journal.moves[receiptKey(args)]={v:1,manifestKey:args.manifestKey,
     cargoID:args.cargoID,wreckItemID:args.wreckItemID,
     wreckID:args.expectedWreckID,characterID:args.characterID,
     shipID:args.shipID,stationID:args.stationID,
     corporationID:args.corporationID,quantity:args.quantity,
     nativeItemID:itemID,state:"PLAYER_CARGO"};
    tx.put("corporationRuntime",journalKey,journal);
    return {status:"SALVAGE_NATIVE_PICKUP_COMMITTED",itemID};
   });
   if(result?.status!=="SALVAGE_NATIVE_PICKUP_COMMITTED")
    return deny("SALVAGE_NATIVE_PICKUP_UNCERTAIN");
  }catch{return deny("SALVAGE_NATIVE_PICKUP_UNCERTAIN")}
  const confirmed=inspect(args);
  return confirmed.status==="SALVAGE_NATIVE_PLAYER_CARGO"?confirmed:
   deny("SALVAGE_PICKUP_COMMITTED_NEEDS_RECONCILIATION");
 }
 function deliver(args){
  if(process.env.EVEJS_COOP_SALVAGE_ATOMIC_TRANSFER!=="1"||
   process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1")
   return deny("DISABLED");
  const current=inspect(args);
  if(current.status==="ATOMIC_NATIVE_ITEM_MOVED")return current;
  if(current.status!=="SALVAGE_NATIVE_PLAYER_CARGO")return current;
  let dock;try{dock=verifyDocking(args)}
  catch{return deny("SALVAGE_DOCKED_NATIVE_SOURCE_UNAVAILABLE")}
  if(dock?.status!=="LIVE_NATIVE_DOCKED_DELIVERY_VERIFIED"||
   dock.characterID!==args.characterID||dock.shipID!==args.shipID||
   dock.stationID!==args.stationID)
   return deny("SALVAGE_PLAYER_NOT_PHYSICALLY_DOCKED");
  try{
   const result=atomic.transact(["items","corporationRuntime"],tx=>{
    const old=tx.get("items",String(current.nativeWarehouseItemID));
    const journal=tx.get("corporationRuntime",journalKey);
    const receipt=journal?.moves?.[receiptKey(args)];
    // The earlier inspect() read was outside this SQLite transaction.
    // Check ALL immutable pickup identities again before moving ownership:
    // another writer may have changed the receipt or cargo since inspect().
    if(receipt?.v!==1||receipt.state!=="PLAYER_CARGO"||
     receipt.manifestKey!==args.manifestKey||
     receipt.cargoID!==args.cargoID||
     receipt.wreckItemID!==args.wreckItemID||
     receipt.wreckID!==args.expectedWreckID||
     receipt.characterID!==args.characterID||
     receipt.shipID!==args.shipID||
     receipt.stationID!==args.stationID||
     receipt.corporationID!==args.corporationID||
     receipt.quantity!==args.quantity||
     receipt.nativeItemID!==current.nativeWarehouseItemID)
     throw Error("SALVAGE_ATOMIC_PICKUP_RECEIPT_CHANGED");
    const tag=marker(args.manifestKey,args.cargoID,args.wreckItemID);
    const matches=tx.scan("items").filter(x=>x.value?.customInfo===tag);
    if(matches.length!==1||
     matches[0].key!==String(current.nativeWarehouseItemID)||
     !old||old.itemID!==current.nativeWarehouseItemID||
     old.customInfo!==tag||
     old.ownerID!==args.characterID||old.locationID!==args.shipID||
     old.flagID!==5||old.quantity!==args.quantity||
     old.stacksize!==args.quantity||old.singleton!==0||
     old.typeID!==source(args).row?.typeID)
     throw Error("SALVAGE_NATIVE_PLAYER_HOLD_CHANGED");
    const next={...old,ownerID:args.corporationID,
     locationID:args.stationID,flagID:4};
    tx.put("items",String(old.itemID),next);
    receipt.state="DELIVERED";
    tx.put("corporationRuntime",journalKey,journal);
    return {status:"SALVAGE_NATIVE_DELIVERY_COMMITTED"};
   });
   if(result?.status!=="SALVAGE_NATIVE_DELIVERY_COMMITTED")
    return deny("SALVAGE_NATIVE_DELIVERY_UNCERTAIN");
  }catch{return deny("SALVAGE_NATIVE_DELIVERY_UNCERTAIN")}
  const checked=inspect(args);
  return checked.status==="ATOMIC_NATIVE_ITEM_MOVED"?checked:
   deny("SALVAGE_DELIVERY_COMMITTED_NEEDS_RECONCILIATION");
 }
 return {pickup,deliver,inspect,marker};
}
module.exports={createNativeSalvageTransfer,marker};
