"use strict";
// P0: durable, opt-in native trade-stage custody and safe post-crash recovery.
// A temporary EveJS trade container is not a persistent inventory owner.
// Never infer a missing original location or transfer a player's asset to a peer.
const fs=require("node:fs"),path=require("node:path");
const BASE=910000000000,MAX=910999999999;
const DEFAULT_FILE="/var/lib/evejs/coop-native-trade-custody.jsonl";
const id=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
const num=x=>Number.isSafeInteger(Number(x))?Number(x):null;
const validContainer=x=>id(x)&&Number(x)>BASE&&Number(x)<=MAX;
const states=new Set(["PREPARED","STAGED","ABORTED","COMPLETED","RECOVERED"]);
const fields=["key","containerID","itemID","ownerID","locationID","flagID","typeID","stacksize"];
const same=(a,b)=>fields.every(k=>a[k]===b[k]);
function createCustody({file=process.env.EVEJS_COOP_TRADE_CUSTODY_FILE||DEFAULT_FILE,
 io=fs,clock=()=>Date.now()}={}){
 let blocked=null,inventory=null;
 const absolute=typeof file==="string"&&path.isAbsolute(file)&&file.length<500;
 function read(){
  if(!absolute)return {ok:false,reason:"CUSTODY_FILE_NOT_ABSOLUTE"};
  let raw;
  try{raw=io.readFileSync(file,"utf8")}
  catch(e){if(e?.code==="ENOENT")raw="";else return {ok:false,reason:"CUSTODY_JOURNAL_UNAVAILABLE"}}
  if(typeof raw!=="string"||Buffer.byteLength(raw,"utf8")>16*1024*1024||
   (raw.length&&!raw.endsWith("\n")))return {ok:false,reason:"CUSTODY_JOURNAL_CORRUPT"};
  const entries=new Map();let maxOrdinal=0;
  for(const line of raw.split("\n")){
   if(!line)continue;
   let e;try{e=JSON.parse(line)}catch{return {ok:false,reason:"CUSTODY_JOURNAL_CORRUPT"}}
   if(e?.v!==1||!states.has(e.state)||typeof e.key!=="string"||
    !validContainer(e.containerID)||!id(e.itemID)||!id(e.ownerID)||
    !id(e.locationID)||num(e.flagID)===null||
    !id(e.typeID)||!id(e.stacksize)||!Number.isFinite(e.at)||
    e.key!==String(e.containerID)+":"+String(e.itemID)||
    e.locationID===e.containerID)return {ok:false,reason:"CUSTODY_JOURNAL_CORRUPT"};
   const previous=entries.get(e.key);
   if(previous&&(!same(previous,e)||previous.state==="COMPLETED"||
    previous.state==="ABORTED"||previous.state==="RECOVERED"||
    (e.state==="PREPARED"&&previous.state!=="PREPARED")))
    return {ok:false,reason:"CUSTODY_JOURNAL_CONFLICT"};
   if(!previous&&e.state!=="PREPARED")
    return {ok:false,reason:"CUSTODY_JOURNAL_MISSING_INTENT"};
   entries.set(e.key,e);
   maxOrdinal=Math.max(maxOrdinal,e.containerID-BASE);
  }
  return {ok:true,entries,nextOrdinal:maxOrdinal+1};
 }
 function append(e){
  if(!absolute||!states.has(e?.state))return false;
  let fd;
  try{
   io.mkdirSync(path.dirname(file),{recursive:true});
   fd=io.openSync(file,"a",0o600);
   const buffer=Buffer.from(JSON.stringify({v:1,...e,at:clock()})+"\n","utf8");
   if(io.writeSync(fd,buffer,0,buffer.length,null)!==buffer.length)return false;
   io.fsyncSync(fd);
   return true;
  }catch{return false}
  finally{if(fd!==undefined)try{io.closeSync(fd)}catch{}}
 }
 function halt(reason){blocked=reason||"CUSTODY_UNCERTAIN_NEEDS_OPERATOR_REPAIR";
  return {ok:false,reason:blocked};}
 function assertReady(service){
  if(blocked||service?._coopCustodyBlocked)
   throw Error("COOP_TRADE_CUSTODY_BLOCKED: "+(blocked||service._coopCustodyBlocked));
 }
 function details(trade,item,origin){
  const container=id(trade?.tradeContainerID),itemID=id(item?.itemID),
   ownerID=id(origin?.ownerID),locationID=id(origin?.locationID),
   flagID=num(origin?.flagID),typeID=id(item?.typeID),
   stacksize=id(item?.stacksize);
  if(!validContainer(container)||!itemID||!ownerID||!locationID||
   flagID===null||!typeID||!stacksize||!Array.isArray(trade.traders)||
   trade.traders.length!==2||!trade.traders.includes(ownerID)||
   locationID===container)
   throw Error("INVALID_NATIVE_TRADE_STAGE_INTENT");
  return {key:container+":"+itemID,containerID:container,itemID,ownerID,
   locationID,flagID,typeID,stacksize};
 }
 function itemMap(native){
  if(!native||typeof native!=="object"||Array.isArray(native))return null;
  return native;
 }
 function coherent(item,e,where){
  if(!item||id(item.itemID)!==e.itemID||
   id(item.ownerID)!==e.ownerID||id(item.typeID)!==e.typeID||
   id(item.stacksize)!==e.stacksize)return false;
  return where==="origin"?
   id(item.locationID)===e.locationID&&num(item.flagID)===e.flagID:
   id(item.locationID)===e.containerID&&num(item.flagID)===4;
 }
 function pendingForTrade(trade,ledger){
  const container=id(trade?.tradeContainerID);
  return [...ledger.entries.values()].filter(e=>e.containerID===container&&
   ["PREPARED","STAGED"].includes(e.state));
 }
 function start(service,nativeInventory){
  if(!service||!nativeInventory||typeof nativeInventory.getAllItems!=="function"||
   typeof nativeInventory.recoverCoopTradeStaging!=="function")
   return halt("NATIVE_INVENTORY_RECOVERY_UNAVAILABLE");
  inventory=nativeInventory;
  const ledger=read();if(!ledger.ok)return halt(ledger.reason);
  if(ledger.nextOrdinal<1||BASE+ledger.nextOrdinal>MAX)
   return halt("NATIVE_TRADE_CONTAINER_SEQUENCE_EXHAUSTED");
  // Never reuse a container ID that existed in the persistent ledger.
  service._tradeOrdinal=Math.max(Number(service._tradeOrdinal)||1,ledger.nextOrdinal);
  let items;try{items=itemMap(nativeInventory.getAllItems())}catch{return halt("NATIVE_INVENTORY_UNAVAILABLE")}
  if(!items)return halt("NATIVE_INVENTORY_UNAVAILABLE");
  const active=[...ledger.entries.values()].filter(e=>["PREPARED","STAGED"].includes(e.state));
  const byLocation=new Map(),needs=[];
  for(const [key,item] of Object.entries(items)){
   if(!item||!id(item.itemID)||Number(key)!==Number(item.itemID))
    return halt("NATIVE_INVENTORY_ROW_INVALID");
   if(validContainer(item.locationID)){
    const k=String(item.locationID)+":"+String(item.itemID);
    if(byLocation.has(k))return halt("DUPLICATE_STAGED_ROOT");
    byLocation.set(k,item);
   }
  }
  for(const [key,item] of byLocation){
   const e=ledger.entries.get(key);
   if(!e||!["PREPARED","STAGED"].includes(e.state))
    return halt("UNJOURNALED_NATIVE_TRADE_ITEM");
  }
  for(const e of active){
   const item=items[String(e.itemID)];
   if(coherent(item,e,"origin"))continue; // PREPARED before move
   if(!coherent(item,e,"staged"))
    return halt("AMBIGUOUS_NATIVE_TRADE_CUSTODY");
   needs.push({itemID:e.itemID,ownerID:e.ownerID,
    fromLocationID:e.containerID,locationID:e.locationID,flagID:e.flagID,
    typeID:e.typeID,stacksize:e.stacksize});
  }
  if(active.length){
   // One authoritative native items-table write+SQLite flush, or refuse
   // the entire recovery; no series of independently settled moves.
   let outcome;
   try{outcome=nativeInventory.recoverCoopTradeStaging(needs)}
   catch{return halt("NATIVE_TRADE_RECOVERY_UNCERTAIN")}
   if(outcome?.success!==true)return halt("NATIVE_TRADE_RECOVERY_UNCERTAIN");
   for(const e of active)if(!append({...e,state:"RECOVERED"}))
    return halt("CUSTODY_JOURNAL_WRITE_FAILED");
  }
  blocked=null;service._coopCustodyBlocked=null;
  return {ok:true,status:"NATIVE_TRADE_CUSTODY_READY",recovered:active.length,
   moved:needs.length,nextOrdinal:service._tradeOrdinal};
 }
 function beforeStage(service,trade,session,item,origin,quantity){
  assertReady(service);
  if(!inventory)throw Error("NATIVE_TRADE_CUSTODY_NOT_INITIALIZED");
  const e=details(trade,item,origin);
  if(id(session?.characterID)!==e.ownerID||trade.status!=="open"||
   (quantity!==null&&quantity!==undefined&&Number(quantity)!==e.stacksize))
   throw Error("COOP_TRADE_PARTIAL_OR_FOREIGN_STAGE_BLOCKED");
  const l=read();if(!l.ok){halt(l.reason);throw Error(l.reason)}
  if(l.entries.has(e.key)){halt("DUPLICATE_TRADE_STAGE_INTENT");throw Error("DUPLICATE_TRADE_STAGE_INTENT")}
  if(!append({...e,state:"PREPARED"})){
   halt("CUSTODY_JOURNAL_WRITE_FAILED");throw Error("CUSTODY_JOURNAL_WRITE_FAILED");
  }
  return e;
 }
 function afterStage(service,trade,item,roots){
  assertReady(service);
  const l=read();if(!l.ok){halt(l.reason);throw Error(l.reason)}
  const key=String(trade.tradeContainerID)+":"+String(item.itemID),e=l.entries.get(key);
  if(!e||e.state!=="PREPARED"||!Array.isArray(roots)||
   roots.length!==1||Number(roots[0])!==e.itemID){
   halt("NATIVE_TRADE_STAGE_RESULT_UNCERTAIN");
   throw Error("NATIVE_TRADE_STAGE_RESULT_UNCERTAIN");
  }
  if(!append({...e,state:"STAGED"})){
   halt("CUSTODY_JOURNAL_WRITE_FAILED");throw Error("CUSTODY_JOURNAL_WRITE_FAILED");
  }
  return true;
 }
 function beforeComplete(service,trade){
  assertReady(service);
  const ledger=read();
  if(!ledger.ok){halt(ledger.reason);throw Error(ledger.reason)}
  if(!trade||trade.status!=="open"||
   typeof service?._listTradeItems!=="function"){
   halt("NATIVE_TRADE_MANIFEST_UNAVAILABLE");
   throw Error("NATIVE_TRADE_MANIFEST_UNAVAILABLE");
  }
  const entries=pendingForTrade(trade,ledger);
  let roots,items;
  try{roots=service._listTradeItems(trade);items=inventory?.getAllItems()}
  catch{halt("NATIVE_TRADE_MANIFEST_UNAVAILABLE");throw Error("NATIVE_TRADE_MANIFEST_UNAVAILABLE")}
  if(!Array.isArray(roots)||!items||roots.length!==entries.length||
   entries.some(e=>e.state!=="STAGED")||
   new Set(roots.map(x=>id(x?.itemID))).size!==roots.length||
   roots.some(item=>{
    const key=String(trade.tradeContainerID)+":"+String(item?.itemID);
    const e=ledger.entries.get(key);
    return !e||e.state!=="STAGED"||
     !coherent(item,e,"staged")||
     !coherent(items[String(e.itemID)],e,"staged");
   })){
   halt("NATIVE_TRADE_PRECOMMIT_CUSTODY_CHANGED");
   throw Error("NATIVE_TRADE_PRECOMMIT_CUSTODY_CHANGED");
  }
  return {ok:true,roots:roots.length};
 }
 function finishAbort(service,trade){
  assertReady(service);
  const l=read();if(!l.ok){halt(l.reason);throw Error(l.reason)}
  const active=pendingForTrade(trade,l);
  if(!active.length)return true;
  let items;
  try{items=inventory?.getAllItems()}catch{}
  if(!items||active.some(e=>!coherent(items[String(e.itemID)],e,"origin"))){
   halt("NATIVE_ABORT_CUSTODY_UNCERTAIN");throw Error("NATIVE_ABORT_CUSTODY_UNCERTAIN");
  }
  let result;try{result=inventory.recoverCoopTradeStaging([])}catch{}
  if(result?.success!==true){halt("NATIVE_ABORT_FLUSH_UNCERTAIN");throw Error("NATIVE_ABORT_FLUSH_UNCERTAIN")}
  for(const e of active)if(!append({...e,state:"ABORTED"})){
   halt("CUSTODY_JOURNAL_WRITE_FAILED");throw Error("CUSTODY_JOURNAL_WRITE_FAILED");
  }
  return true;
 }
 function finishComplete(service,trade){
  assertReady(service);
  const l=read();if(!l.ok){halt(l.reason);throw Error(l.reason)}
  const active=pendingForTrade(trade,l);
  if(!active.length)return true;
  let items;try{items=inventory?.getAllItems()}catch{}
  if(!items||active.some(e=>{
   const item=items[String(e.itemID)];
   const recipient=trade.traders.find(x=>x!==e.ownerID);
   return !item||id(item.ownerID)!==id(recipient)||
    id(item.locationID)!==id(trade.dockedLocationID)||
    id(item.typeID)!==e.typeID||id(item.stacksize)!==e.stacksize;
  })){
   halt("NATIVE_COMPLETION_CUSTODY_UNCERTAIN");
   throw Error("NATIVE_COMPLETION_CUSTODY_UNCERTAIN");
  }
  for(const e of active)if(!append({...e,state:"COMPLETED"})){
   halt("CUSTODY_JOURNAL_WRITE_FAILED");throw Error("CUSTODY_JOURNAL_WRITE_FAILED");
  }
  return true;
 }
 return {start,read,beforeStage,afterStage,beforeComplete,finishAbort,finishComplete,assertReady,
  status:()=>blocked};
}
let current=null;
const active=()=>process.env.EVEJS_COOP_ATOMIC_TRADE==="1";
function runtime(){
 if(!current)current=createCustody();
 return current;
}
function startup(service,inventory){
 if(!active())return {ok:true,status:"DISABLED"};
 const result=runtime().start(service,inventory);
 if(!result.ok)service._coopCustodyBlocked=result.reason;
 return result;
}
function assertReady(service){if(active())runtime().assertReady(service)}
function beforeStage(service,trade,session,item,origin,quantity){
 if(active())runtime().beforeStage(service,trade,session,item,origin,quantity);
}
function afterStage(service,trade,item,roots){
 if(active())runtime().afterStage(service,trade,item,roots);
}
function beforeComplete(service,trade){if(active())runtime().beforeComplete(service,trade)}
function finishAbort(service,trade){if(active())runtime().finishAbort(service,trade)}
function finishComplete(service,trade){if(active())runtime().finishComplete(service,trade)}
// Only called by the native itemStore on an explicitly opted-in server.
function applyRecovery({changes,readItems,writeItems,buildInventoryItem,
 normalizeInventoryItem,indexDeltaFromChanges,cloneValue,flushItems}={}){
 if(!Array.isArray(changes)||changes.length>10000||
  [readItems,writeItems,buildInventoryItem,normalizeInventoryItem,
   indexDeltaFromChanges,cloneValue,flushItems].some(fn=>typeof fn!=="function"))
  return {success:false,errorMsg:"INVALID_CUSTODY_RECOVERY_DEPS"};
 const original=readItems();
 if(!original||typeof original!=="object"||Array.isArray(original))
  return {success:false,errorMsg:"NATIVE_ITEMS_UNAVAILABLE"};
 const next={...original},updated=[];
 const seen=new Set();
 for(const e of changes){
  if(!id(e.itemID)||seen.has(e.itemID)||!validContainer(e.fromLocationID)||
   !id(e.locationID)||!id(e.ownerID)||!id(e.typeID)||!id(e.stacksize)||num(e.flagID)===null)
   return {success:false,errorMsg:"INVALID_CUSTODY_RESTORE_ENTRY"};
  seen.add(e.itemID);
  const native=normalizeInventoryItem(original[String(e.itemID)]);
  if(!native||id(native.itemID)!==e.itemID||id(native.ownerID)!==e.ownerID||
   id(native.locationID)!==e.fromLocationID||id(native.typeID)!==e.typeID||
   id(native.stacksize)!==e.stacksize)
   return {success:false,errorMsg:"CUSTODY_RESTORE_SOURCE_CHANGED"};
  const restored=buildInventoryItem({...native,locationID:e.locationID,flagID:e.flagID});
  if(id(restored.itemID)!==e.itemID||id(restored.ownerID)!==e.ownerID||
   id(restored.locationID)!==e.locationID||num(restored.flagID)!==e.flagID)
   return {success:false,errorMsg:"CUSTODY_RESTORE_MUTATION_INVALID"};
  next[String(e.itemID)]=restored;
  updated.push({removed:false,previousData:cloneValue(native),item:cloneValue(restored)});
 }
 try{
  if(updated.length&&!writeItems(next,{indexDelta:indexDeltaFromChanges(updated)}))
   return {success:false,errorMsg:"CUSTODY_RESTORE_WRITE_FAILED"};
  if(flushItems()?.success!==true)
   return {success:false,errorMsg:"CUSTODY_RESTORE_FLUSH_UNCERTAIN"};
 }catch{return {success:false,errorMsg:"CUSTODY_RESTORE_UNCERTAIN"}}
 return {success:true,restored:updated.length};
}
module.exports={createCustody,applyRecovery,startup,assertReady,
 beforeStage,afterStage,beforeComplete,finishAbort,finishComplete,BASE,MAX};
