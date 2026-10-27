"use strict";
// A wreck claim is only recoverable while the physical native wreck entity is
// in the scene. A restart drops that entity while the durable native wreck row
// (and its stored loot) survives, so this module decides, per claim, between
// two honest outcomes only:
//   1. RESTORE - re-spawn the *same* native wreck entity from the durable
//      native row through the stock spawnNativeWreck path, then let the normal
//      recovery/custody legs run;
//   2. CLOSE   - the row is gone, decayed, empty or the native spawn refused:
//      close the claim with an explicit reason and the measured lost loot.
// It never creates a wreck, never moves an item, never grants cargo or ISK.
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const named=x=>typeof x==="string"&&/^coop-pilot-[0-9]{3,}$/.test(x);
const REASON=/^[A-Z][A-Z0-9_:.-]{2,90}$/;
function measureLoot(items){
 const rows=Array.isArray(items)?items.filter(x=>x&&id(x.wreckItemID)):[];
 const typeIDs=[];
 let quantity=0;
 for(const row of rows){
  const single=row.singleton===true;
  const qty=single?1:Number(row.quantity);
  if(!Number.isSafeInteger(qty)||qty<0)continue;
  quantity+=qty;
  const typeID=id(row.typeID);
  if(typeID&&!typeIDs.includes(typeID))typeIDs.push(typeID);
 }
 return {stacks:rows.length,quantity,typeIDs:typeIDs.slice(0,64)};
}
// Pure decision for one claim. `physical` is the live scene entity, `wreck` the
// durable native wreck row, `items` the durable stored wreck items.
function planClaim({claim,physical,wreck,items,nowMs,bootAgeMs,graceMs=120000}={}){
 const wreckID=id(claim?.wreckID),systemID=id(claim?.systemID),
  shipID=id(claim?.attackerEntityID);
 if(!wreckID||!systemID||!shipID||!named(claim?.attackerPilotID)||
  !id(claim?.sourceEntityID)||!Number.isSafeInteger(nowMs))
  return {action:"INVALID",reason:"INVALID_CLAIM"};
 if(physical?.nativeNpcWreck===true&&Number(physical.itemID)===wreckID)
  return {action:"KEEP",reason:"PHYSICAL_WRECK_PRESENT",wreckID};
 if(Number.isFinite(bootAgeMs)&&bootAgeMs<graceMs)
  return {action:"WAIT",reason:"BOOT_GRACE",wreckID};
 const loot=measureLoot(items);
 if(!wreck)return {action:"CLOSE",reason:"WRECK_ROW_ABSENT",wreckID,loot:null,
  lootMeasurable:false};
 if(Number(wreck.wreckID)!==wreckID||Number(wreck.systemID)!==systemID||
  Number(wreck.sourceEntityID)!==Number(claim.sourceEntityID)||
  Number(wreck.launcherID)!==Number(claim.sourceEntityID))
  return {action:"CLOSE",reason:"WRECK_ROW_MISMATCH",wreckID,loot};
 const expiresAtMs=Number(wreck.expiresAtMs);
 if(Number.isFinite(expiresAtMs)&&expiresAtMs>0&&nowMs>=expiresAtMs)
  return {action:"CLOSE",reason:"WRECK_DECAYED",wreckID,loot};
 if(loot.stacks===0)return {action:"CLOSE",reason:"WRECK_HAS_NO_STORED_ITEMS",
  wreckID,loot};
 return {action:"RESTORE",reason:"DURABLE_ROW_WITHOUT_PHYSICAL_ENTITY",
  wreckID,loot};
}
function reconcile({systemID,scene,claims=[],store,nowMs,bootAgeMs,graceMs=120000,
 restore,close,maxPerTick=2}={}){
 const system=id(systemID);
 if(!system||!Array.isArray(claims)||!store||
  typeof store.getNativeWreck!=="function"||
  typeof store.listNativeWreckItemsForWreck!=="function"||
  typeof restore!=="function"||typeof close!=="function"||
  !Number.isSafeInteger(nowMs)||!Number.isSafeInteger(maxPerTick)||
  maxPerTick<1||maxPerTick>10)
  return {status:"INVALID_NATIVE_INPUT",results:[]};
 const results=[];
 for(const claim of claims.slice(0,200)){
  if(results.length>=maxPerTick)break;
  if(Number(claim?.systemID)!==system)continue;
  const wreckID=id(claim?.wreckID);
  if(!wreckID)continue;
  const physical=typeof scene?.getEntityByID==="function"?
   scene.getEntityByID(wreckID):null;
  const wreck=store.getNativeWreck(wreckID);
  const items=store.listNativeWreckItemsForWreck(wreckID);
  const plan=planClaim({claim,physical,wreck,items,nowMs,bootAgeMs,graceMs});
  if(plan.action==="KEEP"||plan.action==="WAIT"||plan.action==="INVALID"){
   results.push({...plan,status:plan.action});
   continue;
  }
  if(plan.action==="RESTORE"){
   let native=null,error=null;
   try{native=restore({systemID:system,wreckID,wreck});}
   catch(e){error=String(e?.message||e);}
   if(native?.success===true){
    results.push({status:"RESTORED",wreckID,systemID:system,
     reason:"NATIVE_WRECK_ENTITY_RESTORED_FROM_DURABLE_ROW",loot:plan.loot,
     pilotID:claim.attackerPilotID,hunterID:Number(claim.attackerEntityID),
     nativeSource:"STOCK_SPAWN_NATIVE_WRECK"});
    continue;
   }
   const refused=String(native?.errorMsg||error||"UNKNOWN").toUpperCase()
    .replace(/[^A-Z0-9_]/g,"_").slice(0,40);
   const reason=("RESTORE_REFUSED_"+refused).slice(0,90);
   const closed=close({wreckID,reason,loot:plan.loot});
   results.push({status:"CLOSED",wreckID,systemID:system,reason,loot:plan.loot,
    pilotID:claim.attackerPilotID,hunterID:Number(claim.attackerEntityID),
    closeStatus:String(closed?.status||"")});
   continue;
  }
  if(!REASON.test(plan.reason))
   return {status:"INVALID_NATIVE_INPUT",results};
  const closed=close({wreckID,reason:plan.reason,loot:plan.loot});
  results.push({status:"CLOSED",wreckID,systemID:system,reason:plan.reason,
   loot:plan.loot,lootMeasurable:plan.lootMeasurable!==false,
   pilotID:claim.attackerPilotID,hunterID:Number(claim.attackerEntityID),
   closeStatus:String(closed?.status||"")});
 }
 return {status:"OK",results};
}
module.exports={measureLoot,planClaim,reconcile};
