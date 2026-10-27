"use strict";
// COOP-033: provenance-first NPC factory -> native sale -> measured replenishment.
// Synchronous, single-station manual driver. No worker, timer, inventory mint,
// wallet credit, seed order rewrite, API endpoint, or live registration.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const STATES=new Set(["PREPARED","INSTALL_UNKNOWN","INSTALLED","READY","DELIVERY_UNKNOWN","DELIVERED","LIST_UNKNOWN","LISTED","SOLD","REPAIR_REQUIRED"]);
const safeInt=x=>Number.isSafeInteger(x)&&x>0;
const cents=x=>{
 if(typeof x!=="number"||!Number.isFinite(x)||x<0||x>1e12)return null;
 const scaled=x*100,n=Math.round(scaled);
 return Number.isSafeInteger(n)&&Math.abs(scaled-n)<=1e-6?n:null;
};
// The original signed job quote must conserve exact ISK cents BEFORE
// persisting INSTALL_UNKNOWN or asking the atomic GameStore writer to pay.
// Recovery verifies the same cost/tax/total contract on lost acknowledgements.
const quoteCents=q=>{
 const cost=cents(q?.cost),tax=cents(q?.tax),total=cents(q?.totalCost);
 return cost!==null&&tax!==null&&total!==null&&cost+tax===total?
  total:null;
};
// A sale price must be at least one whole cent; rounding a sub-cent quote
// to zero would let a physical native item be considered sold for free.
const saleCents=x=>{
 if(typeof x!=="number"||!Number.isFinite(x)||x<=0||x>1e12)return null;
 const exact=x*100,n=Math.round(exact);
 return Number.isSafeInteger(n)&&n>0&&Math.abs(exact-n)<=1e-7?n:null;
};
const warehouseItem=(item,e,ownerID,stationID)=>Boolean(item&&
 item.itemID===e.itemID&&item.typeID===e.typeID&&
 item.ownerID===ownerID&&item.locationID===stationID&&
 item.flagID===4&&item.singleton===0&&
 Number.isSafeInteger(e.quantity)&&e.quantity>0&&
 item.quantity===e.quantity&&item.stacksize===e.quantity&&
 item.customInfo==="coop-industry:v1:"+e.jobID);
const copy=x=>JSON.parse(JSON.stringify(x));
// The orchestration checkout stores modules as .cjs, but the pinned EveJS
// installer deploys the SAME sources as server/src/space/*.js. Resolve the
// deployed native sibling first, and only fall back on an absent sibling in
// local tests. Never swallow a missing transitive dependency as a fallback.
function loadEconomySibling(name){
 try{return require("./"+name)}
 catch(error){
  if(error?.code!=="MODULE_NOT_FOUND"||
     !String(error.message).includes("Cannot find module './"+name+"'"))
   throw error;
  return require("./"+name+".cjs");
 }
}
const {calculateNativeDemand}=loadEconomySibling("coopNpcDemandAuthority");
const {reconcileUnknown}=loadEconomySibling("coopNpcEconomyUnknownRecovery");
const isOperation=x=>typeof x==="string"&&/^npc-manufacture:[0-9a-f]{32}$/.test(x);
const closed=x=>x==="SOLD";
function createDirector({file,planner,native,market,observe,clock=()=>Date.now(),maxActive=2,maxStock=50000,minReorderMs=60000,
 saleAudit=null,authorizeSoldOperator=null}={}){
 if(typeof file!=="string"||!path.isAbsolute(file)||!planner||typeof planner.plan!=="function"||
  !native||["quote","installOnce","markReadyOnce","deliverOnce","getJob","getItem","getIndustryDebit"].some(k=>typeof native[k]!=="function")||
  !market||["listOnce","getOrder","getSaleEvidence","getWalletEntry"].some(k=>typeof market[k]!=="function")||
  !observe||["getOwner","getStation","snapshot"].some(k=>typeof observe[k]!=="function")||
 (saleAudit!==null&&typeof saleAudit?.audit!=="function")||
 (authorizeSoldOperator!==null&&typeof authorizeSoldOperator!=="function")||
 ((saleAudit===null)!==(authorizeSoldOperator===null))||
  typeof clock!=="function"||!Number.isSafeInteger(maxActive)||maxActive<1||maxActive>2||
  !Number.isSafeInteger(maxStock)||maxStock<1||maxStock>1000000||
  !Number.isSafeInteger(minReorderMs)||minReorderMs<10000)throw Error("NPC_ECONOMY_NATIVE_AUTHORITIES_REQUIRED");
 const lock=file+".lock";
 function load(){try{const state=JSON.parse(fs.readFileSync(file,"utf8"));
  if(state?.version!==1||!state.entries||typeof state.entries!=="object"||Array.isArray(state.entries)||
     !state.history||typeof state.history!=="object")throw Error("NPC_ECONOMY_JOURNAL_CORRUPT");
  for(const [id,e] of Object.entries(state.entries))if(!isOperation(id)||e.operationID!==id||!STATES.has(e.phase))
    throw Error("NPC_ECONOMY_JOURNAL_CORRUPT");return state;
 }catch(e){if(e.code==="ENOENT")return {version:1,entries:{},history:{}};throw e;}}
 function save(state){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+".tmp-"+process.pid+"-"+crypto.randomUUID();let fd;
  try{fd=fs.openSync(tmp,"wx",0o600);fs.writeFileSync(fd,JSON.stringify(state));fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
   fs.renameSync(tmp,file);try{const d=fs.openSync(path.dirname(file),"r");try{fs.fsyncSync(d)}finally{fs.closeSync(d)}}
   catch(e){if(process.platform!=="win32"||!["EPERM","EINVAL","ENOTSUP","EBADF","EISDIR"].includes(e.code))throw e;}}
  finally{if(fd!==null&&fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp)}catch(e){if(e.code!=="ENOENT")throw e}}}
 function exclusive(fn){fs.mkdirSync(path.dirname(file),{recursive:true});let fd;
  try{fd=fs.openSync(lock,"wx",0o600)}catch{return {status:"ECONOMY_LOCKED"}};
  const release=()=>{fs.closeSync(fd);try{fs.unlinkSync(lock)}catch{}};
  try{const result=fn();if(result&&typeof result.then==="function")return result.finally(release);
   release();return result;
  }catch(error){release();throw error;}}
 function halt(reason,operationID){return {status:"BLOCKED",reason,operationID}}
 function validateContext(ownerID,stationID){if(!safeInt(ownerID)||!safeInt(stationID))return false;
  const o=observe.getOwner(ownerID),s=observe.getStation(stationID);
  return Boolean(o&&o.corporationID===ownerID&&o.isNpc===true&&
   s&&s.stationID===stationID&&safeInt(s.solarSystemID));}
 function snapshot(ownerID,stationID){const s=observe.snapshot(ownerID,stationID);
  if(!s||s.authoritativeNative!==true||s.ownerID!==ownerID||s.stationID!==stationID||
    !Array.isArray(s.items)||!Array.isArray(s.orders)||!Array.isArray(s.jobs)||
    !s.targets||typeof s.targets!=="object"||!Array.isArray(s.demandReceipts))throw Error("NATIVE_ECONOMY_SNAPSHOT_UNVERIFIED");
  for(const v of [...s.items,...s.orders,...s.jobs])if(!v||!safeInt(v.typeID)||!Number.isSafeInteger(v.quantity)||v.quantity<0)
    throw Error("NATIVE_ECONOMY_NEGATIVE_QUANTITY");
  // The journal observes native production output. Status 4 is already
  // DELIVERED and MUST NOT remain in the WIP stock accounting forever.
  // Treat missing/ambiguous statuses as unverified, never as free future stock.
  for(const j of s.jobs){
   // Stock status 100 COMPLETED is not proof of delivery. It cannot
   // silently trigger a new paid job until native custody is reconciled.
   if(j.status===100)throw Error("NATIVE_COMPLETED_JOB_RECONCILIATION_REQUIRED");
   if(!Number.isSafeInteger(j.status)||![1,2,3,4,101,102,103].includes(j.status)||
      j.ownerID!==ownerID||j.stationID!==stationID||
      [1,2,3].includes(j.status)&&(!safeInt(j.jobID)||j.activityID!==1))
    throw Error("NATIVE_ECONOMY_JOB_PROVENANCE_UNVERIFIED");
  }
  for(const v of s.demandReceipts)if(!v||!safeInt(v.typeID)||!Number.isSafeInteger(v.quantity)||v.quantity<1||
    !v.authoritativeNative||!v.receiptID||!Number.isSafeInteger(v.at)||
    !["NATIVE_MARKET_FILL","NATIVE_WEAPON_CONSUMPTION","NATIVE_NPC_PURCHASE"].includes(v.source)||
    v.ownerID!==ownerID||v.stationID!==stationID)throw Error("NATIVE_ECONOMY_DEMAND_NOT_ATTESTED");
  if(s.demandReceipts.length>2000||new Set(s.demandReceipts.map(x=>x.receiptID)).size!==s.demandReceipts.length)
    throw Error("NATIVE_ECONOMY_DEMAND_RECEIPT_REPLAY");
  return s;
 }
 function demand(s,typeID){
  const base=s.targets[String(typeID)];
  if(!Number.isSafeInteger(base)||base<0||base>maxStock)
   throw Error("NATIVE_ECONOMY_TARGET_INVALID");
  const {target,physicalConsumed,marketFill,npcPurchased}=calculateNativeDemand({
   receipts:s.demandReceipts,ownerID:s.ownerID,stationID:s.stationID,typeID,
   base,maxStock,now:clock()
  });
  // Buying transfers stock; only a verified physical debit raises demand.
  const sum=(rows,field)=>rows.filter(x=>x.typeID===typeID&&
     x.ownerID===s.ownerID&&x.stationID===s.stationID)
   .reduce((a,x)=>a+x[field],0);
  const stored=sum(s.items,"quantity"),listed=sum(s.orders,"quantity"),
   inFlight=sum(s.jobs.filter(j=>[1,2,3].includes(j.status)),"quantity");
  const total=stored+listed+inFlight;
  if(!Number.isSafeInteger(total)||total<0)
   throw Error("NATIVE_ECONOMY_STOCK_INVALID");
  return {target,stored,listed,inFlight,physicalConsumed,marketFill,npcPurchased,
   shortage:Math.max(0,target-total)};
 }
 function receipt(job,r){return Boolean(job&&r&&safeInt(job.jobID)&&job.coopOperationID===r.operationID&&
  job.status===4&&r.jobID===job.jobID&&r.status==="DELIVERED"&&safeInt(r.itemID)&&
  Number.isSafeInteger(r.quantity)&&r.quantity>0&&
  r.quantity===job.coopDelivery?.quantity&&r.itemID===job.coopDelivery?.itemID);
 }
 function stepEntry(state,e,ownerID,stationID){const id=e.operationID;
  if(e.ownerID!==ownerID||e.stationID!==stationID)return halt("OPERATION_STATION_IDENTITY_MISMATCH",id);
  if(["INSTALL_UNKNOWN","DELIVERY_UNKNOWN"].includes(e.phase)){
   const recovered=reconcileUnknown({entry:e,native});
   if(!recovered.ok)return halt(recovered.reason,id);
   Object.assign(e,recovered.patch);save(state);
   return {status:recovered.status,operationID:id,...recovered.patch};
  }
  if(["LIST_UNKNOWN","REPAIR_REQUIRED"].includes(e.phase))return halt("OUTCOME_UNKNOWN_OPERATOR_RECONCILIATION",id);
  const job=()=>native.getJob(id);
  if(e.phase==="PREPARED"){
   const q=native.quote(e.plan);
   if(!q||q.verifiedNative!==true||quoteCents(q)===null||q.ownerID!==ownerID||
     q.blueprintID!==e.plan.blueprintItemID||q.productTypeID!==e.typeID||q.facilityID!==stationID)
    return halt("UNVERIFIED_CANONICAL_QUOTE",id);
   e.phase="INSTALL_UNKNOWN";e.quote=copy(q);save(state);
   const r=native.installOnce(e.plan,q,id),j=job();
   if(!["INSTALLED","ALREADY_INSTALLED"].includes(r?.status)||!safeInt(r.jobID)||
      j?.jobID!==r.jobID||j?.ownerID!==ownerID||j?.coopOperationID!==id||
      j?.productTypeID!==e.typeID||j?.blueprintID!==e.plan.blueprintItemID)
      return halt("INSTALL_OUTCOME_UNKNOWN",id);
   const debit=native.getIndustryDebit(j.jobID);
   if(!debit||debit.verifiedNative!==true||debit.ownerID!==ownerID||debit.jobID!==j.jobID||
      debit.amountCents!==cents(q.totalCost))return halt("NATIVE_INDUSTRY_ISK_DEBIT_UNVERIFIED",id);
   e.phase="INSTALLED";e.jobID=j.jobID;e.installCostCents=cents(q.totalCost);save(state);
   return {status:"INSTALLED",operationID:id,jobID:j.jobID};
  }
  if(e.phase==="INSTALLED"){
   const j=job();if(j?.jobID!==e.jobID||j.ownerID!==ownerID||j.coopOperationID!==id)return halt("JOB_IDENTITY_CHANGED",id);
   // Native PAUSED=2 reserves output; neither redeliver nor double-charge.
   if(j.status===2)return {status:"WAITING_FOR_NATIVE_RESUME",operationID:id};
   if(j.status===1){const r=native.markReadyOnce(id);
    if(r?.status==="BLOCKED"&&/NOT_YET_READY/.test(String(r.error)))return {status:"WAITING_FOR_NATIVE_TIMER",operationID:id};
    if(!["READY","ALREADY_READY"].includes(r?.status))return halt("NATIVE_READY_NOT_VERIFIED",id);
   }else if(j.status!==3)return halt("NATIVE_JOB_STATUS_INVALID",id);
   if(job()?.status!==3)return halt("NATIVE_READY_NOT_PERSISTED",id);
   e.phase="READY";save(state);return {status:"READY",operationID:id};
  }
  if(e.phase==="READY"){
   if(job()?.status!==3)return halt("NATIVE_READY_NOT_PERSISTED",id);
   e.phase="DELIVERY_UNKNOWN";save(state);
   const r=native.deliverOnce(id),j=job();
   if(!receipt(j,{...r,operationID:id,jobID:e.jobID}))return halt("DELIVERY_OUTCOME_UNKNOWN",id);
   const item=native.getItem(r.itemID);
   if(!warehouseItem(item,{...e,itemID:r.itemID,quantity:r.quantity},
      ownerID,stationID))
    return halt("DELIVERY_ITEM_IDENTITY_UNKNOWN",id);
   e.phase="DELIVERED";e.itemID=item.itemID;e.quantity=item.quantity;save(state);
   return {status:"DELIVERED",operationID:id,itemID:e.itemID,quantity:e.quantity};
  }
  if(e.phase==="DELIVERED"){
   const item=native.getItem(e.itemID);
   if(!warehouseItem(item,e,ownerID,stationID))
      return halt("NATIVE_OUTPUT_NO_LONGER_AVAILABLE",id);
   e.phase="LIST_UNKNOWN";save(state);
   const rpc=market.listOnce({operationID:id,ownerID,stationID,itemID:e.itemID,typeID:e.typeID,quantity:e.quantity});
   const verified=r=>{
   const order=r?.orderID?market.getOrder(r.orderID):null;
   if(r?.status!=="LISTED"||!safeInt(r.orderID)||!order||order.orderID!==r.orderID||
      order.ownerID!==ownerID||order.stationID!==stationID||order.typeID!==e.typeID||
      order.sourceItemID!==e.itemID||order.originalQuantity!==e.quantity||
      order.nativeEscrowVerified!==true)return halt("NATIVE_MARKET_LIST_OUTCOME_UNKNOWN",id);
   e.phase="LISTED";e.orderID=r.orderID;e.priceCents=saleCents(order.price);
   if(e.priceCents===null)return halt("NATIVE_MARKET_PRICE_INVALID",id);
   save(state);return {status:"LISTED",operationID:id,orderID:e.orderID};
   };
   return rpc&&typeof rpc.then==="function"?rpc.then(verified):verified(rpc);
  }
  if(e.phase==="LISTED"){
   // With COOP-035/047 source receipts wired, the legacy market projection
   // is NOT sufficient to mark an NPC corporation paid. Require operator
   // finalization under this same durable journal lock and original audit.
   if(saleAudit!==null)return halt("ORIGINAL_NATIVE_SOLD_OPERATOR_AUDIT_REQUIRED",id);
   const order=market.getOrder(e.orderID),sales=market.getSaleEvidence(e.orderID);
   // A paid receipt for an order ID is NOT proof of this factory stack.
   // Re-attest the original listing identity on every read before SOLD.
   // The order's asking price is immutable for this director: repricing
   // requires a separate original Rust/escrow operation and new evidence.
   if(!order||order.orderID!==e.orderID||order.ownerID!==ownerID||
      order.stationID!==stationID||order.typeID!==e.typeID||
      order.sourceItemID!==e.itemID||
      order.originalQuantity!==e.quantity||
      !safeInt(e.priceCents)||saleCents(order.price)!==e.priceCents||
      order.nativeEscrowVerified!==true||!Array.isArray(sales))
    return halt("NATIVE_SALE_ORIGINAL_ORDER_CUSTODY_DRIFT",id);
   if(!Number.isSafeInteger(order.remainingQuantity)||order.remainingQuantity<0||
      order.remainingQuantity>e.quantity)return halt("NATIVE_SALE_REMAINING_INVALID",id);
   const filled=sales.reduce((sum,x)=>{
    const unitCents=saleCents(x?.price);
    // A native ASK cannot legitimately settle BELOW its original listed
    // minimum price; a better buyer bid may pay above the ask.
    // Also reject products beyond the safe integer-cent ledger range.
    const expected=unitCents===null?null:unitCents*x.quantity;
    if(!x||x.orderID!==e.orderID||x.ownerID!==ownerID||x.typeID!==e.typeID||
       !safeInt(x.quantity)||!safeInt(x.transactionID)||unitCents===null||
       unitCents<e.priceCents||!Number.isSafeInteger(expected)||expected<=0||
       x.nativeWalletSettled!==true)
       throw Error("NATIVE_SALE_LEDGER_INVALID");
    const wallet=market.getWalletEntry(x.transactionID);
    if(!wallet||wallet.verifiedNative!==true||wallet.transactionID!==x.transactionID||
       wallet.ownerID!==ownerID||wallet.orderID!==e.orderID||wallet.amountCents!==expected)
       throw Error("NATIVE_SALE_WALLET_NOT_SETTLED");
    return sum+x.quantity;
   },0);
   if(new Set(sales.map(x=>x.transactionID)).size!==sales.length||filled+order.remainingQuantity!==e.quantity)
    return halt("NATIVE_MARKET_QUANTITY_NOT_CONSERVED",id);
   if(filled===0)return {status:"LISTED_AWAITING_BUYER",operationID:id};
   if(order.remainingQuantity>0)return {status:"PARTIALLY_SOLD",operationID:id,filled,remaining:order.remainingQuantity};
   const revenue=sales.reduce((sum,x)=>sum+saleCents(x.price)*x.quantity,0);
   if(!Number.isSafeInteger(revenue)||revenue<0)return halt("NATIVE_SALE_REVENUE_INVALID",id);
   e.phase="SOLD";e.revenueCents=revenue;e.soldQuantity=filled;save(state);
   return {status:"SOLD",operationID:id,revenueCents:revenue,productionCostCents:e.installCostCents};
  }
  return {status:"ALREADY_SOLD",operationID:id};
 }
 function tick({ownerID,stationID,productTypeIDs=[]}={}){
  if(process.env.EVEJS_COOP_NATIVE_NPC_ECONOMY!=="1")return {status:"NPC_ECONOMY_DISABLED"};
  return exclusive(()=>{
   if(!validateContext(ownerID,stationID))return halt("NPC_OWNER_OR_STATION_UNVERIFIED");
   const state=load(),active=Object.values(state.entries).filter(e=>!closed(e.phase)&&
     e.ownerID===ownerID&&e.stationID===stationID);
   // Unknown native writes must never be bypassed by subsequent installs.
   const unsafe=active.find(e=>["LIST_UNKNOWN","REPAIR_REQUIRED"].includes(e.phase));
   if(unsafe)return halt("OUTCOME_UNKNOWN_OPERATOR_RECONCILIATION",unsafe.operationID);
   // Native receipts are inspected read-only before any other station action.
   // Never repeat a paid install or a delivered inventory grant after lost ACK.
   const recoverable=active.filter(e=>["INSTALL_UNKNOWN","DELIVERY_UNKNOWN"].includes(e.phase))
    .sort((a,b)=>a.createdAt-b.createdAt||a.operationID.localeCompare(b.operationID));
   if(recoverable.length)return stepEntry(state,recoverable[0],ownerID,stationID);
   const working=active.filter(e=>e.phase!=="LISTED")
    .sort((a,b)=>a.createdAt-b.createdAt||a.operationID.localeCompare(b.operationID));
   if(working.length)return stepEntry(state,working[0],ownerID,stationID);
   let listingResult=null;
   const listed=active.filter(e=>e.phase==="LISTED").sort((a,b)=>
    (a.lastPolledAt||0)-(b.lastPolledAt||0)||a.createdAt-b.createdAt||
    a.operationID.localeCompare(b.operationID));
   if(listed.length){
    listingResult=stepEntry(state,listed[0],ownerID,stationID);
    if(listingResult?.status==="BLOCKED"||listingResult?.status==="SOLD")
     return listingResult;
    listed[0].lastPolledAt=clock();save(state);
   }
   if(Object.keys(state.entries).length>50000)return halt("ECONOMY_JOURNAL_CAP_REACHED");
   const s=snapshot(ownerID,stationID);
   const selected=[...new Set(productTypeIDs)].sort((a,b)=>a-b).filter(safeInt);
   if(!selected.length||selected.length>8)return halt("PRODUCT_ALLOWLIST_REQUIRED");
   const shortage={},target={},stock={};
   for(const type of selected){const d=demand(s,type);shortage[type]=d.shortage;
     target[type]=d.target;stock[type]=d.listed;}
   if(selected.every(t=>!shortage[t]))
    return listingResult||{status:"SUFFICIENT_NATIVE_STOCK",shortage};
   // Cool down per product, not per station: a non-selling ask must not
   // suppress an unrelated item with a verified shortage.
   const available=selected.filter(t=>shortage[t]>0&&
    (!Number.isFinite(state.history[ownerID+":"+stationID+":"+t])||
      clock()-state.history[ownerID+":"+stationID+":"+t]>=minReorderMs));
   if(!available.length)return listingResult||{status:"NPC_ECONOMY_REORDER_COOLDOWN"};

   const p=planner.plan({ownerID,stationID,productTypeIDs:available,targetStock:target,
    marketStock:stock,maxJobs:Math.min(maxActive,2)});
   // A verified Rust sale poll is meaningful gameplay even if the station
   // has no new job to install. Don't erase PARTIALLY_SOLD / waiting-for-buyer
   // with a separate planner NO_JOB result; no extra financial action occurs.
   if(p?.status!=="PLAN_READY"||!Array.isArray(p.jobs)||!p.jobs.length)
    return listingResult||{status:"NO_NATIVE_FACTORY_JOB",blocked:p?.blocked||[]};
   const j=p.jobs[0];if(!safeInt(j.blueprintItemID)||!safeInt(j.productTypeID)||j.ownerID!==ownerID||
     j.stationID!==stationID||!available.includes(j.productTypeID)||j.outputQuantity>maxStock)
     return halt("PLANNER_JOB_CONTEXT_INVALID");
   const operationID="npc-manufacture:"+crypto.randomUUID().replace(/-/g,"");
   state.entries[operationID]={operationID,phase:"PREPARED",ownerID,stationID,typeID:j.productTypeID,
    plan:copy(j),createdAt:clock()};state.history[ownerID+":"+stationID+":"+j.productTypeID]=clock();save(state);
   return {status:"PREPARED",operationID,productTypeID:j.productTypeID,shortage:shortage[j.productTypeID]};
  });
 }
 // LW-04C4: one native fsynced source-of-truth SOLD transition, never a
 // new Rust order, wallet credit, item delivery or second scheduler.
 // The configured saleAudit is a captured trusted authority, not proof
 // furnished by a client or admin command. No public API is registered.
 async function confirmSoldOnce({ownerID,stationID,operationID,operatorGrant}={}){
  if(saleAudit===null||
     process.env.EVEJS_COOP_NATIVE_NPC_SOLD_FINALIZE_PROOF!=="1"||
     process.env.EVEJS_COOP_NATIVE_NPC_ECONOMY!=="1")
   return halt("NATIVE_SOLD_OPERATOR_FINALIZATION_DISABLED",operationID);
  if(!safeInt(ownerID)||!safeInt(stationID)||!isOperation(operationID))
   return halt("NATIVE_SOLD_SCOPE_INVALID",operationID);
  return exclusive(async()=>{
   // Authenticate only against the server-injected operator authority.
   // An empty grant or source UI status is never an authorization token.
   let authorized=false;
   try{
    const result=authorizeSoldOperator({operatorGrant,ownerID,
     stationID,operationID});
    if(result&&typeof result.then==="function")
     return halt("NATIVE_SOLD_ASYNC_AUTHORIZATION_UNSUPPORTED",operationID);
    authorized=result===true;
   }catch(_error){return halt("NATIVE_SOLD_OPERATOR_AUTHORITY_UNAVAILABLE",operationID);}
   if(!authorized)return halt("NATIVE_SOLD_OPERATOR_NOT_AUTHORIZED",operationID);
   if(!validateContext(ownerID,stationID))
    return halt("NPC_OWNER_OR_STATION_UNVERIFIED",operationID);
   const before=load(),e=before.entries[operationID];
   if(!e||e.operationID!==operationID||
      e.ownerID!==ownerID||e.stationID!==stationID||!safeInt(e.orderID)||
      !safeInt(e.quantity)||!safeInt(e.jobID)||!safeInt(e.itemID))
    return halt("NATIVE_SOLD_ORIGINAL_ENTRY_MISSING",operationID);
   // A retried operator action after fsync is a harmless status read.
   // Do not rerun a Rust transaction, wallet debit or the audit.
   if(e.phase==="SOLD"){
    if(!Number.isSafeInteger(e.revenueCents)||e.revenueCents<=0||
       e.soldQuantity!==e.quantity||
       e.settlementProof!=="RUST_FINALIZED_GAMESTORE_BUYER_ITEM_AND_CORP_WALLET"||
       !Array.isArray(e.settlementFillIDs)||!e.settlementFillIDs.length||
       !e.settlementFillIDs.every(safeInt)||
       new Set(e.settlementFillIDs).size!==e.settlementFillIDs.length)
     return halt("NATIVE_SOLD_PREVIOUS_RECEIPT_INVALID",operationID);
    return {status:"ALREADY_SOLD",operationID,orderID:e.orderID,
     revenueCents:e.revenueCents,soldQuantity:e.soldQuantity,
     settlementFillIDs:[...e.settlementFillIDs],nativeMutation:false};
   }
   if(e.phase!=="LISTED")
    return halt("NATIVE_SOLD_NOT_LISTED",operationID);
   const unchanged=copy(e);
   let proof;
   try{
    proof=await saleAudit.audit({ownerID,stationID,operationID,
     orderID:e.orderID});
   }catch(_error){return halt("NATIVE_SOLD_AUDIT_UNAVAILABLE",operationID);}
   if(proof?.status!=="ORIGINAL_FULL_SALE_ATTESTED"||
      proof.readOnly!==true||proof.nativeMutation!==false||
      proof.proof!=="RUST_FINALIZED_GAMESTORE_BUYER_ITEM_AND_CORP_WALLET"||
      proof.ownerID!==ownerID||proof.stationID!==stationID||
      proof.operationID!==operationID||proof.orderID!==e.orderID||
      proof.quantity!==e.quantity||proof.soldQuantity!==e.quantity||
      proof.remainingQuantity!==0||
      !Number.isSafeInteger(proof.revenueCents)||proof.revenueCents<=0||
      !Array.isArray(proof.fillIDs)||proof.fillIDs.length<1||
      proof.fillIDs.length>128||!proof.fillIDs.every(safeInt)||
      new Set(proof.fillIDs).size!==proof.fillIDs.length)
    return halt("NATIVE_SOLD_ORIGINAL_FINANCE_NOT_ATTESTED",operationID);
   // The original audit compares Rust order and director journal before
   // and after asynchronous reads. Confirm the persisted entry again before
   // this single source-journal fsync.
   const now=load(),current=now.entries[operationID];
   if(!current||JSON.stringify(current)!==JSON.stringify(unchanged))
    return halt("NATIVE_SOLD_JOURNAL_CHANGED_DURING_AUDIT",operationID);
   const at=clock();
   if(!Number.isSafeInteger(at)||at<=0)
    return halt("NATIVE_SOLD_CLOCK_UNVERIFIED",operationID);
   current.phase="SOLD";
   current.revenueCents=proof.revenueCents;
   current.soldQuantity=proof.soldQuantity;
   current.settlementFillIDs=[...proof.fillIDs];
   current.settlementProof=proof.proof;
   current.soldAt=at;
   save(now);
   return {status:"SOLD",operationID,orderID:current.orderID,
    revenueCents:current.revenueCents,soldQuantity:current.soldQuantity,
    productionCostCents:current.installCostCents,
    settlementFillIDs:[...current.settlementFillIDs],
    nativeMutation:false,durableJournalUpdate:true};
  });
 }
 function inspect(){const s=load();return copy({version:s.version,entries:s.entries,history:s.history});}
 return Object.freeze({tick,inspect,confirmSoldOnce,
  mode:"NATIVE_AUTHORITIES_ONLY",supportsLiveRuntime:false});
}
module.exports={createDirector};
