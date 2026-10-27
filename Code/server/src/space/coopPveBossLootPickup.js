"use strict";
// PVE-004B: a strictly READ-ONLY link between an original native boss
// wreck receipt and a separately verified ORIGINAL itemStore cargo pickup.
// Never transfer, mint, reroll or reserve an item here.
const id=x=>Number.isSafeInteger(x)&&x>0?x:null;
function verify({args,nativePickup,bossWitness,currentWreck}={}){
 if(!args||!nativePickup)return {status:"INVALID_BOSS_LOOT_PICKUP"};
 if(nativePickup.status!=="VERIFIED_NATIVE_LOOT_PICKUP")
  return {status:"NATIVE_PICKUP_NOT_VERIFIED"};
 if(!bossWitness)return {status:"NO_SOURCE_VERIFIED_BOSS_WRECK"};
 const wreck=args.wreck,boss=bossWitness,before=args.sourceBefore;
 const systemID=id(args.scene?.systemID),wreckID=id(wreck?.wreckID),
  itemID=id(args.wreckItemID),characterID=id(args.characterID),
  destinationID=id(args.destinationLocationID),typeID=id(before?.typeID),
  original=Array.isArray(boss.originalItems)?boss.originalItems:null;
 if(!systemID||!wreckID||!itemID||!characterID||!destinationID||!typeID||
    !id(boss.instanceID)||!id(boss.siteID)||!id(boss.bossEntityID)||
    !id(boss.bossTypeID)||!original||original.length>512||
    new Set(original.map(x=>x?.wreckItemID)).size!==original.length||
    original.some(x=>!id(x?.wreckItemID)||!id(x?.typeID)||
      !Number.isSafeInteger(x.quantity)||x.quantity<1)||
    boss.systemID!==systemID||boss.wreckID!==wreckID||
    !currentWreck||currentWreck.wreckID!==wreckID||
    currentWreck.systemID!==systemID||currentWreck.transient!==true||
    currentWreck.sourceEntityID!==boss.bossEntityID||
    currentWreck.launcherID!==boss.bossEntityID||
    currentWreck.sourceTypeID!==boss.bossTypeID||
    wreck?.wreckID!==currentWreck.wreckID||
    wreck?.sourceEntityID!==currentWreck.sourceEntityID||
    wreck?.systemID!==currentWreck.systemID||
    before?.wreckID!==wreckID||before?.wreckItemID!==itemID||
    nativePickup.wreckID!==wreckID||nativePickup.sourceEntityID!==boss.bossEntityID||
    nativePickup.systemID!==systemID||nativePickup.wreckItemID!==itemID||
    nativePickup.characterID!==characterID||nativePickup.shipID!==destinationID||
    nativePickup.destinationLocationID!==destinationID||
    nativePickup.typeID!==typeID)
  return {status:"BOSS_LOOT_SOURCE_MISMATCH"};
 const originalRow=original.find(x=>x.wreckItemID===itemID);
 if(!originalRow||originalRow.typeID!==typeID||
    Number(originalRow.singleton===true)!==
     Number(before.singleton===true||before.singleton===1)||
    !Number.isSafeInteger(before.quantity)||before.quantity<1||
    before.quantity>originalRow.quantity)
  return {status:"ITEM_NOT_IN_ORIGINAL_BOSS_LOOT"};
 const quantity=nativePickup.quantity,remaining=nativePickup.remainingQuantity;
 if(!Number.isSafeInteger(quantity)||quantity<1||
    !Number.isSafeInteger(remaining)||remaining<0||
    before.quantity-quantity!==remaining||
    quantity>originalRow.quantity||
    args.requestedQuantity!==quantity||
    args.availableQuantity!==before.quantity)
  return {status:"BOSS_LOOT_QUANTITY_MISMATCH"};
 // Source debit + exact destination delta were already verified by
 // coopNativeLootPickupEvidence.verify. A previous stack of the same type
 // cannot pass as a new loot item.
 return {status:"ORIGINAL_BOSS_ITEM_PICKUP_VERIFIED",
  systemID,instanceID:boss.instanceID,siteID:boss.siteID,
  bossEntityID:boss.bossEntityID,bossTypeID:boss.bossTypeID,
  wreckID,wreckItemID:itemID,typeID,characterID,
  shipID:destinationID,quantity,remainingQuantity:remaining,
  evidence:"BOSS_NATIVE_WRECK_MANIFEST_AND_SOURCE_DEBIT_AND_DESTINATION_DELTA"};
}
function createObserver({
 getBossWreck,getNativeWreck,observe=()=>true,settle=()=>({status:"DISABLED"}),maxReceipts=4096
}={}){
 if([getBossWreck,getNativeWreck,observe,settle].some(f=>typeof f!=="function")||
    !Number.isSafeInteger(maxReceipts)||maxReceipts<1||maxReceipts>100000)
  throw Error("INVALID_BOSS_LOOT_OBSERVER");
 const emitted=new Set();
 function note(args,nativePickup){
  if(nativePickup?.status!=="VERIFIED_NATIVE_LOOT_PICKUP")
   return {status:"NATIVE_PICKUP_NOT_VERIFIED"};
  let boss=null,wreck=null;
  try{
   boss=getBossWreck(args?.wreck?.wreckID);
   if(!boss)return {status:"NO_SOURCE_VERIFIED_BOSS_WRECK"};
   wreck=getNativeWreck(args.wreck.wreckID);
  }catch{return {status:"BOSS_LOOT_AUTHORITY_UNAVAILABLE"}}
  const verified=verify({args,nativePickup,bossWitness:boss,currentWreck:wreck});
  if(verified.status!=="ORIGINAL_BOSS_ITEM_PICKUP_VERIFIED")return verified;
  // Durable source-before claim pre-dates the ORIGINAL native inventory
  // grant; never acknowledge settled without authenticated native debit.
  let claim=null;
  try{claim=settle({verified,sourceBefore:args.sourceBefore})}
  catch{return {status:"BOSS_LOOT_DURABLE_CLAIM_UNCONFIRMED"}}
  if(!claim||!["DISABLED","BOSS_LOOT_CLAIM_SETTLED"].includes(claim.status))
   return {status:"BOSS_LOOT_DURABLE_CLAIM_UNCONFIRMED"};
  // Exact source slice is unique: the same pre-debit quantity cannot
  // legitimately be credited to a second player. This is telemetry
  // deduplication, not a durable transfer/transaction lock.
  const key=[
   verified.wreckID,verified.wreckItemID,args.sourceBefore.quantity,
   verified.remainingQuantity
  ].join(":");
  if(emitted.has(key))return {status:"ALREADY_REPORTED_BOSS_PICKUP"};
  if(emitted.size>=maxReceipts)return {status:"BOSS_LOOT_OBSERVER_CAP_REACHED"};
  let observed=false;
  try{observed=observe(verified)===true}catch{}
  if(!observed)return {status:"BOSS_LOOT_TELEMETRY_NOT_RECORDED"};
  emitted.add(key);
  return verified;
 }
 return {note,snapshot:()=>({emitted:emitted.size})};
}
let singleton=null;
function note(args,nativePickup){
 if(process.env.EVEJS_COOP_PVE_BOSS_LOOT_PICKUP!=="1"||
    process.env.EVEJS_COOP_PVE_NATIVE_BOSSES!=="1"||
    process.env.EVEJS_COOP_PVE_SITE_DEFENSE!=="1"||
    process.env.EVEJS_COOP_NATIVE_LOOT_EVIDENCE!=="1")
  return {status:"DISABLED"};
 if(!singleton){
  singleton=createObserver({
   getBossWreck:id=>require("./coopVirtualWorldRuntime")
    .witnessedNativeBossWreck(id),
   getNativeWreck:id=>require("./npc/nativeNpcStore").getNativeWreck(id),
   settle:payload=>require("./coopPveBossLootClaim").settle(payload),
   observe:row=>require("./coopRuntimeProbe").observe(
    "living-pve-native-boss-loot-pickup",null,
    {spaceState:{systemID:row.systemID}},row)
  });
 }
 return singleton.note(args,nativePickup);
}
module.exports={verify,createObserver,note};
