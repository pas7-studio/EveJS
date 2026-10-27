"use strict";
// Stage J: original NPC salvage station stock -> existing Rust pending sell
// order -> original native item moved to market escrow in ONE GameStore txn.
// Never calls stock PlaceOrder, invents wallet revenue or retries unknown RPCs.
const crypto=require("node:crypto");
// Checkout siblings are .cjs; the pinned EveJS overlay installs them as .js.
// Never mask a transitive dependency failure by falling back to a stale file.
function loadNpcPendingEscrow(){
 try{return require("./coopNpcPendingMarketEscrow")}
 catch(error){
  if(error?.code!=="MODULE_NOT_FOUND"||
   !String(error.message).includes("Cannot find module './coopNpcPendingMarketEscrow'"))
   throw error;
  return require("./coopNpcPendingMarketEscrow");
 }
}
const {ESCROW_BASE}=loadNpcPendingEscrow();
const good=n=>Number.isSafeInteger(n)&&n>0;
const safe=n=>Number.isSafeInteger(n)&&n>=0;
const blocked=reason=>({status:"BLOCKED",reason});
const key="coopSalvageMarketOps";
const clone=x=>JSON.parse(JSON.stringify(x));
function createSalvagePendingMarket({atomic,call,getItem,getEscrow,
 readJournal,readWitness,isNpcCorporation,verifyStation,
 resolvePriceCents,readOps=null,readFill=null,readCorp=null,
 clock=()=>Date.now(),maxQuantity=50000}={}){
 if(typeof atomic?.transact!=="function"||
  [call,getItem,getEscrow,readJournal,readWitness,isNpcCorporation,
   verifyStation,resolvePriceCents,clock].some(x=>typeof x!=="function")||
  !good(maxQuantity)||maxQuantity>1000000)
  throw Error("STAGE_J_NATIVE_MARKET_AUTHORITIES_REQUIRED");
 const inFlight=new Set();
 const enabled=()=>process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
  process.env.EVEJS_COOP_NATIVE_NPC_MARKET_PENDING==="1"&&
  process.env.EVEJS_COOP_SALVAGE_NATIVE_MARKET==="1"&&
  atomic.mode==="SERVER_INTERNAL_FLAGGED"&&atomic.isPoisoned?.()===false;
 const marker=(wreckID,cargoID)=>
  "coop-salvage-rival:v1:"+wreckID+":"+cargoID;
 function journalFor(j,wreckID){
  const p=j?.moves?.[String(wreckID)];
  return j?.version===1&&j.moves&&typeof j.moves==="object"&&
   !Array.isArray(j.moves)&&p?.v===1&&
   p.state==="NPC_STOCK_DELIVERED"&&p.wreckItemID===wreckID&&
   good(p.wreckID)&&good(p.sourceCargoID)&&good(p.npcCargoID)&&
   good(p.entityID)&&good(p.corporationID)&&good(p.stationID)&&
   good(p.nativeItemID)&&/^\d+-\d+-\d+$/.test(String(p.manifestKey))?p:null;
 }
 function proof(wreckID){
  const j=readJournal(),p=journalFor(j,wreckID);
  if(!p)return null;
  const witness=readWitness(p.manifestKey),r=witness?.record;
  const rows=r?.rows?.filter(x=>x.wreckItemID===wreckID);
  if(witness?.status!=="READY"||r.manifestKey!==p.manifestKey||
   r.wreckID!==p.wreckID||r.stationID!==p.stationID||
   r.corporationID!==p.corporationID||
   !Array.isArray(rows)||rows.length!==1||
   rows[0].cargoID!==p.sourceCargoID||!good(rows[0].typeID)||
   !good(rows[0].quantity)||rows[0].quantity>maxQuantity||
   isNpcCorporation(p.corporationID)!==true||
   verifyStation(p.stationID,p.corporationID)!==true)
   return null;
  return {...clone(p),typeID:rows[0].typeID,quantity:rows[0].quantity};
 }
 function matches(p,item,locationID=p.stationID){
  return item?.itemID===p.nativeItemID&&
   item.ownerID===p.corporationID&&
   item.locationID===locationID&&item.flagID===4&&
   item.typeID===p.typeID&&item.quantity===p.quantity&&
   item.stacksize===p.quantity&&item.singleton===0&&
   item.customInfo===marker(p.wreckItemID,p.sourceCargoID);
 }
 function operationID(p){
  return "npc-salvage:"+crypto.createHash("sha256")
   .update([p.manifestKey,p.wreckID,p.wreckItemID,
    p.nativeItemID,p.sourceCargoID,p.corporationID,p.stationID].join(":"))
   .digest("hex").slice(0,32);
 }
 function ledger(tx){
  const raw=tx.get("corporationRuntime",key);
  if(raw===null)return {version:1,bySource:{}};
  if(raw?.version!==1||!raw.bySource||
   typeof raw.bySource!=="object"||Array.isArray(raw.bySource)||
   Object.keys(raw.bySource).length>10000)
   throw Error("SALVAGE_MARKET_OPS_CORRUPT");
  return raw;
 }
 function sourceInTx(tx,p){
  const j=tx.get("corporationRuntime","coopSalvageRivalMoves");
  const original=journalFor(j,p.wreckItemID);
  if(!original||Object.keys(p).some(k=>
   k in original&&original[k]!==p[k]))
   throw Error("SALVAGE_MARKET_ORIGINAL_RECEIPT_CHANGED");
  const current=tx.get("items",String(p.nativeItemID));
  if(!matches(p,current))throw Error("SALVAGE_MARKET_ORIGINAL_ITEM_CHANGED");
  const all=tx.scan("items");
  if(all.filter(x=>x.value?.customInfo===
   marker(p.wreckItemID,p.sourceCargoID)).length!==1)
   throw Error("SALVAGE_MARKET_DUPLICATED_ORIGINAL_STOCK");
  const cargo=tx.get("npcCargo","cargo");
  if(!cargo||typeof cargo!=="object"||Array.isArray(cargo)||
   Object.values(cargo).some(x=>x?.sourceWreckItemID===p.wreckItemID))
   throw Error("SALVAGE_MARKET_ORIGINAL_NPC_CARGO_CONFLICT");
  if(tx.scan("marketEscrow").some(x=>
   x.value?.sourceItemID===p.nativeItemID||
   x.value?.coopOperationID===operationID(p)))
   throw Error("SALVAGE_MARKET_ORIGINAL_ALREADY_ESCROWED");
  return current;
 }
 function sameOrder(row,p,price,state){
  return Boolean(row&&row.operation_id===operationID(p)&&
   Number(row.source_item_id)===p.nativeItemID&&
   Number(row.owner_id)===p.corporationID&&
   Number(row.station_id)===p.stationID&&
   Number(row.type_id)===p.typeID&&
   Number(row.quantity)===p.quantity&&
   Number(row.price)===price&&row.bid===false&&row.is_corp===true&&
   row.source==="coop-npc"&&
   (state!=="pending"&&state!=="open"||
    Number(row.vol_remaining)===p.quantity)&&
   row.state===state&&good(Number(row.order_id)));
 }
 function escrowed(p,orderID){
  const esc=getEscrow(orderID),item=getItem(p.nativeItemID);
  return Boolean(matches(p,item,ESCROW_BASE+orderID)&&
   esc&&String(esc.orderId)===String(orderID)&&
   esc.escrowType==="sell"&&esc.isCorp===true&&
   esc.ownerId===p.corporationID&&esc.stationId===p.stationID&&
   esc.typeId===p.typeID&&esc.remainingQuantity===p.quantity&&
   esc.sourceItemID===p.nativeItemID&&
   esc.escrowLocationID===ESCROW_BASE+orderID&&
   esc.coopOperationID===operationID(p)&&
   esc.coopSource==="NATIVE_SALVAGE");
 }
 function inspect(wreckID){
  if(!good(wreckID))return blocked("SALVAGE_MARKET_WRECK_ID_INVALID");
  const p=proof(wreckID);
  if(!p)return blocked("SALVAGE_MARKET_ORIGINAL_WITNESS_UNVERIFIED");
  const item=getItem(p.nativeItemID);
  if(!matches(p,item))return blocked("SALVAGE_MARKET_WAREHOUSE_NOT_VERIFIED");
  return {status:"NATIVE_SALVAGE_STOCK_ELIGIBLE",wreckItemID:wreckID,
   nativeItemID:p.nativeItemID,quantity:p.quantity,typeID:p.typeID,
   stationID:p.stationID,corporationID:p.corporationID};
 }
 async function listOnce(wreckID){
  if(!enabled())return blocked("SALVAGE_MARKET_DISABLED");
  if(!good(wreckID))return blocked("SALVAGE_MARKET_WRECK_ID_INVALID");
  if(inFlight.has(wreckID))return blocked("SALVAGE_MARKET_BUSY");
  inFlight.add(wreckID);
  try{
   let p;
   try{p=proof(wreckID)}catch{return blocked("SALVAGE_MARKET_ORIGINAL_UNAVAILABLE")}
   if(!p||!matches(p,getItem(p.nativeItemID)))
    return blocked("SALVAGE_MARKET_ORIGINAL_NOT_VERIFIED");
   let cents;
   try{cents=resolvePriceCents({typeID:p.typeID,stationID:p.stationID,
    ownerID:p.corporationID,quantity:p.quantity,wreckItemID:p.wreckItemID})}
   catch{return blocked("SALVAGE_MARKET_PRICE_UNAVAILABLE")}
   if(!good(cents)||cents>100000000||!safe(cents*p.quantity))
    return blocked("SALVAGE_MARKET_PRICE_NOT_ATTESTED");
   const price=cents/100,op=operationID(p),now=clock();
   if(!good(now))return blocked("SALVAGE_MARKET_CLOCK_INVALID");
   // Durable one-shot intent BEFORE any external Rust RPC. After any
   // failure, explicit operator reconciliation is required, not a retry.
   try{
    const prepared=atomic.transact(
     ["items","marketEscrow","corporationRuntime","npcCargo"],tx=>{
      const ops=ledger(tx),old=ops.bySource[String(wreckID)];
      if(old)return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
       operationID:old.operationID,phase:old.phase};
      sourceInTx(tx,p);
      if(Object.keys(ops.bySource).length>=10000)
       throw Error("SALVAGE_MARKET_OPERATION_CAP");
      ops.bySource[String(wreckID)]={v:1,phase:"PREPARED",
       operationID:op,priceCents:cents,at:now,...clone(p)};
      tx.put("corporationRuntime",key,ops);
      return {status:"PREPARED"};
     });
    if(prepared.status!=="PREPARED")return prepared;
   }catch{return blocked("SALVAGE_MARKET_PREPARE_UNCERTAIN")}
   let pending;
   try{pending=await call("ReserveNpcSellOrder",{
    operation_id:op,source_item_id:String(p.nativeItemID),
    owner_id:p.corporationID,is_corp:true,
    station_id:p.stationID,type_id:p.typeID,
    quantity:p.quantity,price,bid:false,wallet_division:1000
   })}catch{return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
    operationID:op,phase:"RUST_RESERVE_UNKNOWN"}}
   if(!sameOrder(pending,p,price,"pending"))
    return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
     operationID:op,phase:"RUST_RESERVE_NOT_VERIFIED"};
   const orderID=Number(pending.order_id);
   if(!good(orderID)||!good(ESCROW_BASE+orderID))
    return blocked("SALVAGE_MARKET_ESCROW_LOCATION_UNSAFE");
   try{
    atomic.transact(["items","marketEscrow","corporationRuntime","npcCargo"],tx=>{
     const ops=ledger(tx),entry=ops.bySource[String(wreckID)];
     if(entry?.phase!=="PREPARED"||entry.operationID!==op||
      entry.nativeItemID!==p.nativeItemID||entry.priceCents!==cents)
      throw Error("SALVAGE_MARKET_INTENT_CHANGED");
     const item=sourceInTx(tx,p);
     if(tx.get("marketEscrow",String(orderID)))
      throw Error("SALVAGE_MARKET_ORDER_ESCROW_EXISTS");
     const loc=ESCROW_BASE+orderID;
     tx.put("items",String(p.nativeItemID),{...item,locationID:loc});
     tx.put("marketEscrow",String(orderID),{
      orderId:String(orderID),escrowType:"sell",
      ownerId:p.corporationID,isCorp:true,typeId:p.typeID,
      stationId:p.stationID,escrowLocationID:loc,
      remainingQuantity:p.quantity,sourceItemID:p.nativeItemID,
      coopOperationID:op,coopSource:"NATIVE_SALVAGE",
      createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()
     });
     entry.phase="ESCROWED";entry.orderID=orderID;
     tx.put("corporationRuntime",key,ops);
    });
   }catch{return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
    operationID:op,phase:"ESCROW_COMMIT_UNKNOWN"}}
   if(!escrowed(p,orderID))
    return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
     operationID:op,phase:"ESCROW_READBACK_UNKNOWN"};
   let activated,observed;
   try{
    activated=await call("ActivateNpcSellOrder",{
     operation_id:op,order_id:String(orderID),
     source_item_id:String(p.nativeItemID)});
    if(!sameOrder(activated,p,price,"open"))
     throw Error("RUST_ACTIVATION_IDENTITY_UNVERIFIED");
    observed=await call("GetNpcSellOrder",{operation_id:op});
   }catch{return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
    operationID:op,phase:"RUST_ACTIVATION_UNKNOWN"}}
   if(!sameOrder(observed,p,price,"open")||
    Number(observed.order_id)!==orderID||!escrowed(p,orderID))
    return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
     operationID:op,phase:"RUST_ORDER_READBACK_UNKNOWN"};
   try{
    atomic.transact(["corporationRuntime"],tx=>{
     const ops=ledger(tx),entry=ops.bySource[String(wreckID)];
     if(entry?.phase!=="ESCROWED"||entry.operationID!==op||
      entry.orderID!==orderID)throw Error("SALVAGE_MARKET_LISTED_JOURNAL_CONFLICT");
     entry.phase="LISTED";
     tx.put("corporationRuntime",key,ops);
    });
   }catch{return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
    operationID:op,phase:"LISTED_JOURNAL_UNKNOWN"}}
   return {status:"NATIVE_SALVAGE_MARKET_LISTED",operationID:op,
    orderID,sourceItemID:p.nativeItemID,quantity:p.quantity,
    ownerID:p.corporationID,stationID:p.stationID,
    nativeEscrowVerified:true,walletCredited:false};
  }finally{inFlight.delete(wreckID)}
 }

 // Durable restart reconciliation. This does NOT reissue Reserve on an
 // unknown acknowledgement. Rust is first queried by the original operation
 // ID. A confirmed, still pending Rust reservation may be completed using
 // the same GameStore source transaction. The same rule applies to Activate:
 // re-read native Rust before an idempotent activation for a proven escrow.
 async function reconcile(wreckID){
  if(!enabled())return blocked("SALVAGE_MARKET_DISABLED");
  if(!good(wreckID)||typeof readOps!=="function")
   return blocked("SALVAGE_MARKET_RECONCILIATION_AUTHORITY_UNAVAILABLE");
  if(inFlight.has(wreckID))return blocked("SALVAGE_MARKET_BUSY");
  inFlight.add(wreckID);
  try{
   let ops,entry,p;
   try{
    ops=readOps();
    entry=ops?.bySource?.[String(wreckID)];
    p=proof(wreckID);
   }catch{return blocked("SALVAGE_MARKET_RECONCILIATION_SOURCE_UNAVAILABLE")}
   if(ops?.version!==1||!entry||!p||
    entry.operationID!==operationID(p)||entry.nativeItemID!==p.nativeItemID||
    entry.corporationID!==p.corporationID||entry.stationID!==p.stationID||
    entry.typeID!==p.typeID||entry.quantity!==p.quantity||
    !good(entry.priceCents)||entry.priceCents>100000000)
    return blocked("SALVAGE_MARKET_RECONCILIATION_IDENTITY_CONFLICT");
   const op=entry.operationID,price=entry.priceCents/100;
   if(entry.phase==="SOLD")return {status:"NATIVE_SALVAGE_ALREADY_SOLD",operationID:op};
   if(entry.phase==="NATIVE_SALE_COMMITTED"){
    if(typeof readFill!=="function"||typeof readCorp!=="function")
     return blocked("SALVAGE_MARKET_FINANCE_RECONCILIATION_AUTHORITY_UNAVAILABLE");
    let filled,receipt,item,corp;
    try{
     filled=await call("GetNpcSellClaim",{operation_id:op});
     receipt=readFill(entry.orderID);item=getItem(p.nativeItemID);
     corp=readCorp(p.corporationID);
    }catch{return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",phase:"RUST_FILL_READ_UNKNOWN",operationID:op}}
    const journal=corp?.wallet?.divisions?.["1000"]?.journal;
    const txlog=corp?.wallet?.divisions?.["1000"]?.transactions;
    const at=(rows)=>Array.isArray(rows)&&rows.some(x=>x.transactionID===entry.fillID&&
     x.salvageContractID===undefined&&x.amount===receipt?.grossCents/100);
    if(!["settling","filled"].includes(filled?.state)||
     Number(filled.order_id)!==entry.orderID||
     Number(filled.fill_id)!==entry.fillID||
     Number(filled.buyer_id)!==entry.buyerID||
     receipt?.phase!=="NATIVE_COMMITTED"||
     receipt.coopSource!=="NATIVE_SALVAGE"||
     receipt.operationID!==op||receipt.fillID!==entry.fillID||
     receipt.buyerID!==entry.buyerID||receipt.itemID!==p.nativeItemID||
     receipt.ownerID!==p.corporationID||receipt.orderID!==entry.orderID||
     receipt.grossCents!==entry.grossCents||
     item?.ownerID!==entry.buyerID||item.locationID!==p.stationID||
     getEscrow(entry.orderID)!==null||
     corp?.corporationID!==p.corporationID||!at(journal)||!at(txlog))
     return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
      phase:"NATIVE_RUST_WALLET_FILL_MISMATCH",operationID:op};
    // SQLite already paid the buyer and corporation. If the process died
    // before Rust Finalize, retry ONLY the idempotent Rust finalization with
    // the original signed claim and durable native fill receipt. Never
    // replay the actual item or wallet mutation.
    if(filled.state==="settling"){
     try{
      const finalized=await call("FinalizeNpcSellOrder",{
       operation_id:op,order_id:String(entry.orderID),
       buyer_id:String(entry.buyerID),fill_id:String(entry.fillID)});
      if(finalized?.state!=="filled"||
       Number(finalized.order_id)!==entry.orderID||
       Number(finalized.fill_id)!==entry.fillID||
       Number(finalized.buyer_id)!==entry.buyerID)
       throw Error("RUST_RECOVERY_FINALIZE_ACK_CONFLICT");
      filled=await call("GetNpcSellClaim",{operation_id:op});
     }catch{return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
      phase:"RUST_PAID_FINALIZE_UNKNOWN",operationID:op}}
     if(filled?.state!=="filled"||
      Number(filled.order_id)!==entry.orderID||
      Number(filled.fill_id)!==entry.fillID||
      Number(filled.buyer_id)!==entry.buyerID)
      return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
       phase:"RUST_PAID_FINALIZE_READBACK_UNKNOWN",operationID:op};
    }
    try{
     atomic.transact(["corporationRuntime","npcMarketFills"],tx=>{
      const state=ledger(tx),e=state.bySource[String(wreckID)];
      const same=tx.get("npcMarketFills","order"+String.fromCharCode(31)+entry.orderID);
      if(e?.phase!=="NATIVE_SALE_COMMITTED"||e.operationID!==op||
       e.fillID!==entry.fillID||same?.fillID!==entry.fillID||
       same.buyerID!==entry.buyerID||same.grossCents!==entry.grossCents)
       throw Error("SALVAGE_MARKET_FINAL_RECEIPT_CHANGED");
      e.phase="SOLD";e.rustFinalizedAt=clock();
      tx.put("corporationRuntime",key,state);
     });
    }catch{return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",phase:"SOLD_SEAL_UNKNOWN",operationID:op}}
    return {status:"NATIVE_SALVAGE_SOLD_RECOVERED",operationID:op};
   }
   if(!["PREPARED","ESCROWED","LISTED"].includes(entry.phase))
    return blocked("SALVAGE_MARKET_UNSUPPORTED_RECOVERY_STATE");
   let rust;
   try{rust=await call("GetNpcSellOrder",{operation_id:op})}
   catch{return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
    phase:"RUST_ORDER_READ_UNKNOWN",operationID:op}}
   if(!["pending","open","settling","filled"].some(state=>sameOrder(rust,p,price,state)))
    return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
     phase:"RUST_ORIGINAL_ORDER_CONFLICT",operationID:op};
   const orderID=Number(rust.order_id);
   if(!good(orderID)||!good(ESCROW_BASE+orderID))
    return blocked("SALVAGE_MARKET_RECOVERY_ORDER_ID_UNSAFE");
   if(entry.phase==="LISTED"){
    if(orderID!==entry.orderID||!["open","settling","filled"].includes(rust.state))
     return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
      phase:"RUST_LISTED_ORDER_CHANGED",operationID:op};
    if(rust.state!=="open")return {status:"NATIVE_SALVAGE_BUYER_SETTLEMENT_IN_PROGRESS",
     orderID,operationID:op};
    return escrowed(p,orderID)?{status:"NATIVE_SALVAGE_ALREADY_LISTED",orderID,operationID:op}:
     {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
      phase:"LISTED_ESCROW_READBACK_MISMATCH",operationID:op};
   }
   if(entry.phase==="PREPARED"){
    if(rust.state!=="pending")return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
     phase:"RUST_RESERVED_STATE_CONFLICT",operationID:op};
    try{
     atomic.transact(["items","marketEscrow","corporationRuntime","npcCargo"],tx=>{
      const state=ledger(tx),e=state.bySource[String(wreckID)];
      if(e?.phase!=="PREPARED"||e.operationID!==op||
       e.priceCents!==entry.priceCents||e.nativeItemID!==p.nativeItemID)
       throw Error("SALVAGE_MARKET_RECOVERY_INTENT_CHANGED");
      const item=sourceInTx(tx,p);
      if(tx.get("marketEscrow",String(orderID)))
       throw Error("SALVAGE_MARKET_RECOVERY_ESCROW_EXISTS");
      const loc=ESCROW_BASE+orderID,now=new Date(clock()).toISOString();
      tx.put("items",String(p.nativeItemID),{...item,locationID:loc});
      tx.put("marketEscrow",String(orderID),{
       orderId:String(orderID),escrowType:"sell",
       ownerId:p.corporationID,isCorp:true,typeId:p.typeID,
       stationId:p.stationID,escrowLocationID:loc,
       remainingQuantity:p.quantity,sourceItemID:p.nativeItemID,
       coopOperationID:op,coopSource:"NATIVE_SALVAGE",
       createdAt:now,updatedAt:now
      });
      e.phase="ESCROWED";e.orderID=orderID;
      tx.put("corporationRuntime",key,state);
     });
    }catch{return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
     phase:"ESCROW_RECOVERY_COMMIT_UNKNOWN",operationID:op}}
   }else if(entry.orderID!==orderID){
    return blocked("SALVAGE_MARKET_RECOVERY_ESCROW_IDENTITY_CONFLICT");
   }
   if(!escrowed(p,orderID))
    return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
     phase:"ESCROW_RECOVERY_READBACK_UNKNOWN",operationID:op};
   if(rust.state==="pending"){
    // The same Rust operation/order pair is idempotent; re-observe next tick
    // if the ACK disappears rather than guessing an activation succeeded.
    try{const activated=await call("ActivateNpcSellOrder",{
     operation_id:op,order_id:String(orderID),
     source_item_id:String(p.nativeItemID)});
     if(!sameOrder(activated,p,price,"open"))
      return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
       phase:"RUST_RECOVERY_ACTIVATION_UNKNOWN",operationID:op};
    }catch{return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
     phase:"RUST_RECOVERY_ACTIVATION_UNKNOWN",operationID:op}}
   }else if(rust.state!=="open"){
    return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
     phase:"RUST_EARLY_SETTLEMENT_CONFLICT",operationID:op};
   }
   try{rust=await call("GetNpcSellOrder",{operation_id:op})}
   catch{return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
    phase:"RUST_RECOVERY_OPEN_READ_UNKNOWN",operationID:op}}
   if(!sameOrder(rust,p,price,"open")||Number(rust.order_id)!==orderID||
    !escrowed(p,orderID))
    return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
     phase:"NATIVE_RUST_REOPEN_CONFLICT",operationID:op};
   try{
    atomic.transact(["corporationRuntime"],tx=>{
     const state=ledger(tx),e=state.bySource[String(wreckID)];
     if(e?.phase!=="ESCROWED"||e.orderID!==orderID||
      e.operationID!==op||e.nativeItemID!==p.nativeItemID)
      throw Error("SALVAGE_MARKET_LISTED_SEAL_CONFLICT");
     e.phase="LISTED";tx.put("corporationRuntime",key,state);
    });
   }catch{return {status:"SALVAGE_MARKET_RECONCILIATION_REQUIRED",
    phase:"LISTED_RECOVERY_SEAL_UNKNOWN",operationID:op}}
   return {status:"NATIVE_SALVAGE_LISTED_RECOVERED",orderID,operationID:op};
  }finally{inFlight.delete(wreckID)}
 }

 return Object.freeze({inspect,listOnce,reconcile,
  mode:"SOURCE_BACKED_SALVAGE_PENDING_MARKET",
  supportsAutoListing:true,supportsVerifiedSales:false});
}
module.exports={createSalvagePendingMarket};
