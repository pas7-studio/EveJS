"use strict";
/**
 * LW-04C3A: guarded original NPC manufactured output -> existing native
 * pending Rust sell order. Never calls stock PlaceOrder, never mints items,
 * never settles wallets, and never retries a LIST_UNKNOWN operation.
 *
 * The existing durable native economy director MUST transition DELIVERED to
 * LIST_UNKNOWN *before* invoking its configured original market.listOnce().
 * This admission module does not own/replicate the director's durable log.
 */
const OP=/^npc-manufacture:[0-9a-f]{32}$/;
const POS=n=>Number.isSafeInteger(n)&&n>0;
const NATIVE_MARKET_BASE=9200000000;
const CUSTODY_PHASES=new Set(["DELIVERED","LIST_UNKNOWN","LISTED","SOLD"]);
const deny=(reason,operationID=null)=>({status:"BLOCKED",reason,operationID,
 nativeMutation:false});
function createOriginalNpcRustSellStage({
 director,manufacturing,readRustOrder,getOriginalItem,getOriginalEscrow,
 verifyNativeSeller,env=process.env,clock=()=>Date.now()
}={}){
 if(director?.mode!=="NATIVE_AUTHORITIES_ONLY"||
    director?.supportsLiveRuntime!==false||
    typeof director.inspect!=="function"||typeof director.tick!=="function"||
    manufacturing?.mode!=="MANUAL_ORIGINAL_GAMESTORE_PROOF_ONLY"||
    manufacturing?.supportsLiveRuntime!==false||
    typeof manufacturing.inspect!=="function"||
    [readRustOrder,getOriginalItem,getOriginalEscrow,verifyNativeSeller,clock]
     .some(x=>typeof x!=="function"))
  throw Error("LW04C3_NATIVE_MARKET_ORIGINAL_AUTHORITIES_REQUIRED");
 const busy=new Set();
 const enabled=()=>env.EVEJS_COOP_NATIVE_NPC_ECONOMY==="1"&&
  env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
  env.EVEJS_COOP_NATIVE_NPC_TX_PROOF==="1"&&
  env.EVEJS_COOP_NATIVE_NPC_MANUAL_FACTORY_PROOF==="1"&&
  env.EVEJS_COOP_NATIVE_NPC_MARKET_PENDING==="1"&&
  env.EVEJS_COOP_ALIFE_ECONOMY_ACT!=="1"&&
  env.EVEJS_COOP_NATIVE_NPC_ECONOMY_SCHEDULER!=="1"&&
  env.EVEJS_COOP_NATIVE_NPC_MARKET!=="1";
 function load(ownerID,stationID,operationID){
  const journal=director.inspect();
  if(journal?.version!==1||!journal.entries||typeof journal.entries!=="object"||
     Array.isArray(journal.entries))
   throw Error("LW04C3_DURABLE_JOURNAL_UNAVAILABLE");
  const entry=journal.entries[operationID];
  if(!entry||entry.operationID!==operationID||entry.ownerID!==ownerID||
     entry.stationID!==stationID||!POS(entry.typeID)||
     !POS(entry.itemID)||!POS(entry.quantity)||
     !CUSTODY_PHASES.has(entry.phase)||
     !entry.plan||entry.plan.ownerID!==ownerID||
     entry.plan.stationID!==stationID||entry.plan.productTypeID!==entry.typeID||
     entry.plan.outputQuantity!==entry.quantity)
   throw Error("LW04C3_DURABLE_DELIVERY_SCOPE_INVALID");
  // Director chooses work by station, not operationID. A second in-progress
  // job could be advanced by director.tick while the caller expects a sale
  // for a different item. For this manual path require a unique active job.
  const active=Object.values(journal.entries).filter(e=>
   e?.ownerID===ownerID&&e.stationID===stationID&&e.phase!=="SOLD");
  if(active.length!==1||active[0].operationID!==operationID)
   throw Error("LW04C3_OTHER_STATION_OPERATION_IN_PROGRESS");
  return entry;
 }
 function exactOrder(raw,x){
  const n=v=>typeof v==="number"&&Number.isSafeInteger(v)?v:
   typeof v==="string"&&/^(0|[1-9][0-9]*)$/.test(v)&&
    Number.isSafeInteger(Number(v))?Number(v):null;
  const orderID=n(raw?.order_id),sourceItem=n(raw?.source_item_id);
  const quantity=n(raw?.quantity),remaining=n(raw?.vol_remaining);
  const p=raw?.price,cents=typeof p==="number"&&Number.isFinite(p)&&p>0?
   Math.round(p*100):null;
  if(!POS(orderID)||!POS(NATIVE_MARKET_BASE+orderID)||
     raw?.operation_id!==x.operationID||sourceItem!==x.itemID||
     n(raw?.owner_id)!==x.ownerID||n(raw?.station_id)!==x.stationID||
     n(raw?.type_id)!==x.typeID||quantity!==x.quantity||
     raw?.source!=="coop-npc"||raw.bid!==false||raw.is_corp!==true||
     !POS(cents)||Math.abs(p*100-cents)>1e-7||
     // The original director persists the immutable listing ASK when its
     // market readback first advances DELIVERED -> LISTED. A later Rust
     // repricing is NOT the paid/order-custody proof for that journal.
     (x.phase==="LISTED"&&
      (!POS(x.priceCents)||cents!==x.priceCents))||
     !["pending","open","filled"].includes(raw.state)||
     !Number.isSafeInteger(remaining)||remaining<0||remaining>x.quantity)
   throw Error("LW04C3_RUST_SELL_IDENTITY_INVALID");
  return {orderID,remaining,priceCents:cents,state:raw.state};
 }
 function custody(x,order){
  const escrowLocationID=NATIVE_MARKET_BASE+order.orderID;
  const escrow=getOriginalEscrow(order.orderID);
  if(!escrow||String(escrow.orderId)!==String(order.orderID)||
     escrow.escrowType!=="sell"||escrow.isCorp!==true||
     escrow.ownerId!==x.ownerID||escrow.stationId!==x.stationID||
     escrow.typeId!==x.typeID||escrow.sourceItemID!==x.itemID||
     escrow.coopOperationID!==x.operationID||
     escrow.escrowLocationID!==escrowLocationID||
     escrow.remainingQuantity!==x.quantity||
     escrow.coopSource!=="NATIVE_INDUSTRY")
   throw Error("LW04C3_ORIGINAL_ESCROW_RECEIPT_CHANGED");
  const item=getOriginalItem(x.itemID);
  if(!item||item.itemID!==x.itemID||item.ownerID!==x.ownerID||
     item.typeID!==x.typeID||item.locationID!==escrowLocationID||
     item.flagID!==4||item.singleton!==0||
     item.quantity!==x.quantity||item.stacksize!==x.quantity||
     !/^coop-industry:v1:[0-9]+$/.test(String(item.customInfo||"")))
   throw Error("LW04C3_ORIGINAL_ITEM_ESCROW_CUSTODY_CHANGED");
  // Only an untouched full-stack listing is supported. A partial fill
  // requires a separate audited Rust buyer/wallet and item splitter.
  if(order.remaining!==x.quantity||!["pending","open"].includes(order.state))
   throw Error("LW04C3_PARTIAL_OR_FILLED_ORDER_REQUIRES_SETTLEMENT");
  return {status:order.state==="open"?"NATIVE_SELL_ORDER_ATTESTED":
    "PENDING_NATIVE_ACTIVATION",operationID:x.operationID,
    orderID:order.orderID,sourceItemID:x.itemID,quantity:x.quantity,
    priceCents:order.priceCents,readOnly:true,nativeMutation:false,
    settlementVerified:false};
 }
 async function observe({ownerID,stationID,operationID}={}){
  if(!POS(ownerID)||!POS(stationID)||!OP.test(operationID||""))
   return deny("LW04C3_INVALID_SCOPE",operationID);
  try{
   const entry=load(ownerID,stationID,operationID);
   if(entry.phase==="DELIVERED")return {status:"NOT_LISTED",
    operationID,readOnly:true,nativeMutation:false};
   const raw=await readRustOrder(operationID);
   if(!raw)return deny("LW04C3_RUST_ORDER_UNAVAILABLE",operationID);
   const order=exactOrder(raw,entry);
   // READ ONLY: even a matching open order does NOT authorize clearing a
   // LIST_UNKNOWN journal. An operator must reconcile the existing durable
   // director record before a new issue can occur.
   if(entry.phase==="SOLD")return deny("LW04C3_SALE_SETTLEMENT_NOT_VERIFIED",operationID);
   const result=custody(entry,order);
   const after=load(ownerID,stationID,operationID);
   if(after.phase!==entry.phase||after.itemID!==entry.itemID||
      after.quantity!==entry.quantity||after.orderID!==entry.orderID)
    return deny("LW04C3_JOURNAL_CHANGED_DURING_RUST_READ",operationID);
   return {...result,
    status:entry.phase==="LIST_UNKNOWN"?
     "OPERATOR_RECONCILIATION_REQUIRED":result.status,
    sourcePhase:entry.phase};
  }catch(error){
   return deny("LW04C3_READONLY_RECOVERY_UNAVAILABLE:"+
    String(error?.message||error).slice(0,100),operationID);
  }
 }
 async function listDelivered({ownerID,stationID,operationID}={}){
  if(!enabled())return deny("LW04C3_MANUAL_RUST_LISTING_DISABLED",operationID);
  if(!POS(ownerID)||!POS(stationID)||!OP.test(operationID||""))
   return deny("LW04C3_INVALID_SCOPE",operationID);
  const key=ownerID+":"+stationID;
  if(busy.has(key))return deny("LW04C3_STATION_LISTING_BUSY",operationID);
  busy.add(key);
  try{
   const entry=load(ownerID,stationID,operationID);
   // Never retry the native Rust Reserve/Activate path on an unknown ACK.
   if(entry.phase!=="DELIVERED")
    return deny("LW04C3_NATIVE_JOURNAL_ALREADY_ADVANCED",operationID);
   if(verifyNativeSeller({ownerID,stationID,operationID,
       itemID:entry.itemID,typeID:entry.typeID})!==true)
    return deny("LW04C3_ORIGINAL_NPC_SELLER_UNVERIFIED",operationID);
   const source=manufacturing.inspect({ownerID,stationID,operationID});
   if(source?.status!=="ORIGINAL_DELIVERY_ATTESTED"||
      source.itemID!==entry.itemID||source.quantity!==entry.quantity||
      source.jobID!==entry.jobID)
    return deny("LW04C3_ORIGINAL_DELIVERY_NOT_ATTESTED",operationID);
   const before=getOriginalItem(entry.itemID);
   if(!before||before.locationID!==stationID||
      before.itemID!==entry.itemID||before.typeID!==entry.typeID||
      before.ownerID!==ownerID||before.quantity!==entry.quantity||
      before.stacksize!==entry.quantity||before.flagID!==4)
    return deny("LW04C3_SOURCE_ITEM_NOT_AT_STATION",operationID);
   // The director records LIST_UNKNOWN before executing pending Rust
   // ReserveNpcSellOrder and the original atomic GameStore escrow transfer.
   // It is the ONLY native market writer for this operation.
   let result;
   try{result=await director.tick({ownerID,stationID,
     productTypeIDs:[entry.typeID]});}
   catch(error){return deny("LW04C3_NATIVE_RPC_OUTCOME_UNKNOWN",operationID)}
   if(result?.status!=="LISTED"||result.operationID!==operationID||
      !POS(result.orderID))
    return deny("LW04C3_LIST_OUTCOME_NOT_CONFIRMED",operationID);
   const verified=await observe({ownerID,stationID,operationID});
   if(verified.status!=="NATIVE_SELL_ORDER_ATTESTED"||
      verified.orderID!==result.orderID)
    return deny("LW04C3_LIST_READBACK_NOT_ATTESTED",operationID);
   return {status:"LISTED",operationID,orderID:result.orderID,
    itemID:entry.itemID,quantity:entry.quantity,
    priceCents:verified.priceCents,source:"ORIGINAL_PENDING_RUST_NPC_SELL",
    settlementVerified:false};
  }catch(error){
   return deny("LW04C3_MANUAL_LISTING_UNAVAILABLE:"+
     String(error?.message||error).slice(0,100),operationID);
  }finally{busy.delete(key)}
 }
 return Object.freeze({observe,listDelivered,
  mode:"MANUAL_ORIGINAL_RUST_NPC_SELL_CUSTODY",
  supportsLiveRuntime:false,supportsAutomaticAlife:false});
}
module.exports={createOriginalNpcRustSellStage};
