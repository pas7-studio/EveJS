"use strict";
/**
 * COOP-032B: native GameStore SQLite transaction proof, OFFLINE ONLY.
 * NO imports of player handlers, no fabricated session. Call only on a
 * disposable / exclusively stopped gamestore.sqlite with a verified quote.
 * No hot-cache reconciliation exists: never enable as a live runtime adapter.
 */
const SEP="\u001f";
const JOB_ID_START=970000000000000;
const INSTALLED_LOCATION=2003;
const MAX_RUN_SECONDS=30*86400;
const pos=x=>Number.isSafeInteger(Number(x))&&Number(x)>0?Number(x):null;
// Persisted native wallet balances and market quotes must already be exact
// cents. Rounding existing balances/quotes while atomically moving original
// minerals or blueprint custody silently destroys or invents ISK.
const exactCents=x=>{
 if(typeof x!=="number"||!Number.isFinite(x)||x<0||x>1e12)return null;
 const scaled=x*100,whole=Math.round(scaled);
 return Number.isSafeInteger(whole)&&Math.abs(scaled-whole)<=1e-6?
  whole:null;
};
const roundCents=x=>exactCents(x);
const safeMoney=x=>exactCents(x)!==null;
const tableNames=Object.freeze(['items','corporationRuntime','industryBlueprintState','industryJobs']);
function validateInput(plan,quote,operationID){
 if(typeof operationID!=="string"||!/^npc-manufacture:[A-Za-z0-9_-]{8,90}$/.test(operationID))throw Error('INVALID_OPERATION_ID');
 if(!plan||!quote||!pos(plan.ownerID)||!pos(plan.stationID)||!pos(plan.blueprintItemID)||!pos(plan.blueprintTypeID)||
   !pos(plan.productTypeID)||!pos(plan.facilityID)||!pos(plan.systemID)||!pos(plan.runs)||plan.runs>100||!pos(plan.outputQuantity)||
   !Array.isArray(plan.materials)||plan.materials.length===0)throw Error('INVALID_NATIVE_PLAN');
 if(plan.facilityID!==plan.stationID)throw Error('FACILITY_STATION_MISMATCH');
 const seen=new Set();
 for(const m of plan.materials){if(!pos(m.typeID)||!pos(m.quantity)||seen.has(m.typeID))throw Error('INVALID_MATERIAL_BILL');seen.add(m.typeID)}
 if(!safeMoney(quote.totalCost)||!safeMoney(quote.cost)||!safeMoney(quote.tax)||
    exactCents(quote.cost)+exactCents(quote.tax)!==exactCents(quote.totalCost)||
    !pos(quote.timeInSeconds)||quote.timeInSeconds>MAX_RUN_SECONDS||
    Number(quote.activityID)!==1||Number(quote.runs)!==plan.runs||
    Number(quote.ownerID)!==plan.ownerID||Number(quote.blueprintID)!==plan.blueprintItemID||
    Number(quote.facilityID)!==plan.facilityID||Number(quote.productTypeID)!==plan.productTypeID)
    throw Error('NATIVE_QUOTE_MISMATCH');
 if(!Array.isArray(quote.outputs)||quote.outputs.length!==1||Number(quote.outputs[0].typeID)!==plan.productTypeID||
    Number(quote.outputs[0].quantity)!==plan.outputQuantity)throw Error('QUOTED_PRODUCT_MISMATCH');
 const actual=Array.isArray(quote.materials)?quote.materials:[];
 if(actual.length!==plan.materials.length||plan.materials.some(m=>!actual.some(a=>Number(a.typeID)===m.typeID&&Number(a.quantity)===m.quantity)))throw Error('QUOTED_MATERIALS_MISMATCH');
 return true;
}
function createOfflineAtomicInstaller({db,offlineExclusive=false,verifyNativeQuote,verifyNativeOwner,clock=()=>Date.now(),faultAt=null}={}){
 if(!offlineExclusive||!db||typeof db.exec!=="function"||typeof db.prepare!=="function"||
   typeof verifyNativeQuote!=="function"||typeof verifyNativeOwner!=="function")
   throw Error('OFFLINE_EXCLUSIVE_VERIFIED_NATIVE_DEPENDENCIES_REQUIRED');
 const select=(table,key)=>{
  // Identifiers strictly internal constants, not user SQL.
  if(!tableNames.includes(table))throw Error('TABLE_NOT_ALLOWLISTED');
  const row=db.prepare(`SELECT json FROM "${table}" WHERE key=?`).get(String(key));
  return row?JSON.parse(row.json):null;
 };
 const put=(table,key,obj)=>{
  if(!tableNames.includes(table))throw Error('TABLE_NOT_ALLOWLISTED');
  db.prepare(`INSERT INTO "${table}"(key,json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json`).run(String(key),JSON.stringify(obj));
 };
 const del=(table,key)=>db.prepare(`DELETE FROM "${table}" WHERE key=?`).run(String(key));
 const rowKey=(prefix,id)=>prefix+SEP+String(id);
 const listItems=()=>db.prepare('SELECT key,json FROM "items"').all().map(x=>({key:x.key,item:JSON.parse(x.json)}));
 const findOperation=operationID=>db.prepare('SELECT json FROM "industryJobs" WHERE key LIKE ?').all('jobs'+SEP+'%')
    .map(x=>JSON.parse(x.json)).find(x=>x.coopOperationID===operationID)||null;
 function getJobByOperation(operationID){if(!/^npc-manufacture:[A-Za-z0-9_-]{8,90}$/.test(operationID))return null;return findOperation(operationID)}
 function installOnce(plan,quote,operationID){
  validateInput(plan,quote,operationID);
  if(verifyNativeOwner(plan.ownerID,plan.stationID)!==true||verifyNativeQuote(plan,quote)!==true)
   return {status:'UNVERIFIED_NATIVE_AUTHORITY'};
  let begun=false;
  try{
   db.exec('BEGIN IMMEDIATE');begun=true;
   if(faultAt==='AFTER_BEGIN')throw Error('TEST_FAULT_AFTER_BEGIN');
   const prev=findOperation(operationID);
   if(prev){
    if(prev.coopQuoteSignature!==JSON.stringify(quote)||prev.ownerID!==plan.ownerID||prev.blueprintID!==plan.blueprintItemID||prev.facilityID!==plan.facilityID||prev.productTypeID!==plan.productTypeID||prev.runs!==plan.runs)
     throw Error('OPERATION_IDENTITY_CONFLICT');
    db.exec('COMMIT');begun=false;
    return {status:'ALREADY_INSTALLED',jobID:prev.jobID,job:prev};
   }
   const originalBPO=select('items',plan.blueprintItemID);
   const stateKey=rowKey('records',plan.blueprintItemID);
   const state=select('industryBlueprintState',stateKey);
   if(!originalBPO||originalBPO.itemID!==plan.blueprintItemID||originalBPO.typeID!==plan.blueprintTypeID||
      originalBPO.categoryID!==9||originalBPO.ownerID!==plan.ownerID||originalBPO.locationID!==plan.stationID||
      ![4,115].includes(originalBPO.flagID)||originalBPO.singleton!==1||
      !state||state.original!==true||state.jobID!=null||state.typeID!==plan.blueprintTypeID)
      throw Error('BLUEPRINT_INVALID_OR_BUSY');
   const grouped=listItems();
   for(const row of grouped){if(row.key!==String(row.item.itemID))throw Error('NATIVE_ITEM_KEY_MISMATCH');}
   const reductions=[];
   for(const mat of plan.materials){
    let remaining=mat.quantity;
    const candidates=grouped.filter(x=>x.item.typeID===mat.typeID&&x.item.ownerID===plan.ownerID&&x.item.locationID===plan.stationID&&
        x.item.flagID===4&&x.item.singleton===0&&
        Number.isSafeInteger(x.item.quantity)&&x.item.quantity>0&&
        x.item.stacksize===x.item.quantity)
      .sort((a,b)=>Number(a.item.itemID)-Number(b.item.itemID));
    for(const item of candidates){
     if(remaining===0)break;
     const removed=Math.min(remaining,item.item.quantity);
     reductions.push({key:item.key,source:item.item,removed});remaining-=removed;
    }
    if(remaining!==0)throw Error('INSUFFICIENT_NATIVE_MINERALS');
   }
   const corpKey=rowKey('corporations',plan.ownerID),corp=select('corporationRuntime',corpKey);
   const division=corp?.wallet?.divisions?.['1000'];
   if(!corp||Number(corp.corporationID)!==plan.ownerID||!division||!safeMoney(division.balance))throw Error('CORPORATE_WALLET_MISSING');
   const amount=roundCents(quote.totalCost),balance=roundCents(division.balance);
   if(balance<amount)throw Error('CORPORATE_WALLET_INSUFFICIENT');
   const meta=select('industryJobs','_meta');
   if(!meta||!pos(meta.nextJobID))throw Error('NATIVE_JOB_SEQUENCE_MISSING');
   const jobID=Math.max(JOB_ID_START,meta.nextJobID);
   if(!Number.isSafeInteger(jobID+1)||select('industryJobs',rowKey('jobs',jobID)))throw Error('NATIVE_JOB_ID_CONFLICT');
   if(faultAt==='AFTER_VALIDATION')throw Error('TEST_FAULT_AFTER_VALIDATION');
   for(const line of reductions){
    const balanceQty=line.source.quantity-line.removed;
    if(balanceQty===0)del('items',line.key);
    else put('items',line.key,{...line.source,quantity:balanceQty,stacksize:balanceQty});
   }
   if(faultAt==='AFTER_MATERIALS')throw Error('TEST_FAULT_AFTER_MATERIALS');
   const now=clock();if(!Number.isSafeInteger(now)||now<=0)throw Error('INVALID_CLOCK');
   const filetime=(BigInt(now)*10000n+116444736000000000n);
   if(amount>0){
    const next=(balance-amount)/100;
    const entry={transactionID:jobID,transactionDate:String(filetime),referenceID:jobID,entryTypeID:10,
      ownerID1:plan.ownerID,ownerID2:0,accountKey:1000,amount:-amount/100,balance:next,
      description:`NPC industry install ${operationID}`,currency:1,sortValue:1};
    division.balance=next;
    division.journal=[...(division.journal||[]),entry].slice(-100);
    division.transactions=[...(division.transactions||[]),entry].slice(-2000);
    put('corporationRuntime',corpKey,corp);
   }
   if(faultAt==='AFTER_WALLET')throw Error('TEST_FAULT_AFTER_WALLET');
   const blueprintLocationFlagID=originalBPO.flagID;
   put('items',plan.blueprintItemID,{...originalBPO,locationID:INSTALLED_LOCATION});
   put('industryBlueprintState',stateKey,{...state,jobID,updatedAt:now});
   const job={activityID:1,jobID,blueprintID:plan.blueprintItemID,blueprintTypeID:plan.blueprintTypeID,
     blueprintCopy:false,blueprintLocationID:plan.stationID,blueprintLocationFlagID,facilityID:plan.facilityID,
     ownerID:plan.ownerID,status:1,installerID:0,completedCharacterID:0,solarSystemID:plan.systemID,
     stationID:plan.stationID,startDate:String(filetime),endDate:String(filetime+BigInt(quote.timeInSeconds)*10000000n),pauseDate:null,
     runs:plan.runs,licensedRuns:1,successfulRuns:0,cost:Number(quote.cost),tax:Number(quote.tax),totalCost:Number(quote.totalCost),
     timeInSeconds:Number(quote.timeInSeconds),probability:1,productTypeID:plan.productTypeID,
     optionalTypeID:null,optionalTypeID2:null,outputLocationID:plan.stationID,outputFlagID:4,
     inputLocationID:plan.stationID,inputFlagID:4,account:['cash',1000],
     materials:Object.fromEntries(plan.materials.map(x=>[String(x.typeID),x.quantity])),
     // LW-04D original input custody: record the exact SOURCE ItemStore item
     // IDs and consumed amounts INSIDE the existing single SQLite transaction.
     // No new item, allocator, wallet, or material transfer. This proves
     // WHICH owned physical mineral stacks paid for this BPO install.
     coopMaterialDebits:reductions.map(line=>({
      itemID:line.source.itemID,typeID:line.source.typeID,
      ownerID:line.source.ownerID,stationID:line.source.locationID,
      beforeQuantity:line.source.quantity,consumedQuantity:line.removed,
      afterQuantity:line.source.quantity-line.removed,
      sourceCustomInfo:line.source.customInfo??null
     })),
     coopOperationID:operationID,
     coopQuoteSignature:JSON.stringify(quote)};
   put('industryJobs',rowKey('jobs',jobID),job);
   put('industryJobs','_meta',{...meta,nextJobID:jobID+1,lastUpdatedAt:new Date(now).toISOString()});
   if(faultAt==='BEFORE_COMMIT')throw Error('TEST_FAULT_BEFORE_COMMIT');
   db.exec('COMMIT');begun=false;
   return {status:'INSTALLED',jobID,job};
  }catch(e){if(begun){try{db.exec('ROLLBACK')}catch{}}
   return {status:'BLOCKED',error:String(e.message||e)};}
 }
 return {installOnce,getJobByOperation,mode:'OFFLINE_ONLY',supportsAtomicInstall:false};
}
module.exports={createOfflineAtomicInstaller,validateInput};