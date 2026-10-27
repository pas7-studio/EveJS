"use strict";
/**
 * COOP-034: native NPC production item -> pending Rust sell order -> atomic
 * GameStore item + escrow row -> Rust activation. Default OFF, no auto launch.
 *
 * Rust must implement idempotent ReserveNpcSellOrder/GetNpcSellOrder/
 * ActivateNpcSellOrder; stock PlaceOrder is deliberately NEVER used.
 */
const ESCROW_BASE=9200000000;
const good=x=>Number.isSafeInteger(x)&&x>0;
const OP=/^npc-manufacture:[0-9a-f]{32}$/;
function createNpcPendingMarketEscrow({
 call,gameStore,getNativeItem,getNativeEscrow,verifyNativeCorporation,
 verifyStation,resolvePrice,clock=()=>Date.now(),maxQuantity=50000
}={}){
 if(typeof call!=="function"||typeof gameStore?.coopAtomicNativeRows?.transact!=="function"||
    [getNativeItem,getNativeEscrow,verifyNativeCorporation,verifyStation,resolvePrice,clock]
      .some(x=>typeof x!=="function")||
    !Number.isSafeInteger(maxQuantity)||maxQuantity<1||maxQuantity>1000000)
  throw Error("NPC_PENDING_ESCROW_NATIVE_DEPENDENCIES_REQUIRED");
 const inFlight=new Set();
 function flag(){return process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
   process.env.EVEJS_COOP_NATIVE_NPC_MARKET_PENDING==="1"}
 function checkReq(x){
  if(!x||!OP.test(x.operationID)||![x.ownerID,x.stationID,x.itemID,x.typeID,x.quantity]
     .every(good)||x.quantity>maxQuantity)return false;
  return verifyNativeCorporation(x.ownerID)===true&&verifyStation(x.stationID,x.ownerID)===true;
 }
 function checkItem(x,item,locationID=x.stationID){
  return Boolean(item&&item.itemID===x.itemID&&item.ownerID===x.ownerID&&
    item.typeID===x.typeID&&item.quantity===x.quantity&&
    item.stacksize===x.quantity&&item.singleton===0&&
    item.locationID===locationID&&item.flagID===4&&
    /^coop-industry:v1:[0-9]+$/.test(String(item.customInfo||"")));
 }
 function price(x){
  const p=resolvePrice(x);
  // Rust sells in integer cents. Never turn a positive sub-cent quote into
  // a free order or silently round a different price from the native quote.
  if(typeof p!=="number"||!Number.isFinite(p)||p<=0||p>1000000)
   throw Error("NPC_MARKET_PRICE_UNVERIFIED");
  const exact=p*100,whole=Math.round(exact);
  if(!Number.isSafeInteger(whole)||whole<1||
     Math.abs(exact-whole)>1e-7)
   throw Error("NPC_MARKET_PRICE_UNVERIFIED");
  return whole/100;
 }
 function sameOrder(row,x,p,state){
  return Boolean(row&&row.operation_id===x.operationID&&Number(row.source_item_id)===x.itemID&&
   Number(row.owner_id)===x.ownerID&&Number(row.station_id)===x.stationID&&
   Number(row.type_id)===x.typeID&&Number(row.quantity)===x.quantity&&
   Number(row.price)===p&&row.bid===false&&row.is_corp===true&&
   // Manufacturing and NPC salvage use the same Rust pending sell API.
   // A foreign-source or already consumed order is NOT a reserve receipt
   // for this original physical output stack.
   row.source==="coop-npc"&&Number(row.vol_remaining)===x.quantity&&
   (state===null||row.state===state)&&good(Number(row.order_id)));
 }
 function receipt(x,orderID){
  const item=getNativeItem(x.itemID),esc=getNativeEscrow(orderID);
  return checkItem(x,item,ESCROW_BASE+orderID)&&
   esc&&String(esc.orderId)===String(orderID)&&esc.escrowType==="sell"&&
   esc.isCorp===true&&esc.ownerId===x.ownerID&&esc.stationId===x.stationID&&
   esc.typeId===x.typeID&&esc.sourceItemID===x.itemID&&esc.remainingQuantity===x.quantity&&
   esc.escrowLocationID===ESCROW_BASE+orderID&&esc.coopOperationID===x.operationID;
 }
 async function listOnce(x={}){
  if(!flag())return {status:"BLOCKED",error:"NPC_PENDING_MARKET_DISABLED"};
  if(!checkReq(x))return {status:"BLOCKED",error:"NPC_MARKET_IDENTITY_UNVERIFIED"};
  if(inFlight.has(x.operationID))return {status:"BLOCKED",error:"NPC_MARKET_OPERATION_BUSY"};
  inFlight.add(x.operationID);
  try{
   const p=price(x),before=getNativeItem(x.itemID);
   if(!checkItem(x,before))return {status:"BLOCKED",error:"NPC_MARKET_UNBACKED_SOURCE"};
   // Reserve is idempotent by operation ID in Rust, and pending is never visible
   // to market clients or market matching. No RPC after a failed reserve result.
   const pending=await call("ReserveNpcSellOrder",{
    operation_id:x.operationID,source_item_id:String(x.itemID),owner_id:x.ownerID,
    is_corp:true,station_id:x.stationID,type_id:x.typeID,quantity:x.quantity,
    price:p,bid:false,wallet_division:1000
   });
   if(!sameOrder(pending,x,p,"pending"))return {status:"BLOCKED",error:"NPC_RUST_PENDING_ORDER_NOT_VERIFIED"};
   const orderID=Number(pending.order_id);
   if(!good(orderID)||!good(ESCROW_BASE+orderID))
     return {status:"BLOCKED",error:"NPC_MARKET_ESCROW_LOCATION_UNSAFE"};
   const escrowLocationID=ESCROW_BASE+orderID;
   // Physical item and sell escrow metadata become durable in ONE sqlite txn.
   // This only touches the exact produced stack; no item splitting or minting.
   gameStore.coopAtomicNativeRows.transact(["items","marketEscrow"],tx=>{
    const item=tx.get("items",String(x.itemID));
    const existing=tx.get("marketEscrow",String(orderID));
    if(existing){
     if(existing.orderId!==String(orderID)||existing.coopOperationID!==x.operationID||
        existing.sourceItemID!==x.itemID||existing.ownerId!==x.ownerID||
        existing.escrowLocationID!==escrowLocationID||!checkItem(x,item,escrowLocationID))
       throw Error("NPC_NATIVE_ESCROW_RECEIPT_CONFLICT");
     return {status:"ALREADY_ESCROWED"};
    }
    if(!checkItem(x,item))throw Error("NPC_NATIVE_SOURCE_CHANGED");
    const now=new Date(clock()).toISOString();
    tx.put("items",String(x.itemID),{...item,locationID:escrowLocationID});
    tx.put("marketEscrow",String(orderID),{
     orderId:String(orderID),escrowType:"sell",ownerId:x.ownerID,isCorp:true,
     typeId:x.typeID,stationId:x.stationID,escrowLocationID,
     remainingQuantity:x.quantity,createdAt:now,updatedAt:now,
     sourceItemID:x.itemID,coopOperationID:x.operationID,coopSource:"NATIVE_INDUSTRY"
    });
    return {status:"ESCROWED"};
   });
   if(!receipt(x,orderID))return {status:"BLOCKED",error:"NPC_NATIVE_ESCROW_AFTER_COMMIT_UNVERIFIED"};
   const activated=await call("ActivateNpcSellOrder",{
    operation_id:x.operationID,order_id:String(orderID),source_item_id:String(x.itemID)
   });
   if(!sameOrder(activated,x,p,"open"))
    return {status:"BLOCKED",error:"NPC_RUST_ACTIVATION_UNVERIFIED"};
   const observed=await call("GetNpcSellOrder",{operation_id:x.operationID});
   if(!sameOrder(observed,x,p,"open")||Number(observed.order_id)!==orderID||
      !receipt(x,orderID))return {status:"BLOCKED",error:"NPC_MARKET_LISTING_NOT_RECONCILED"};
   return {status:"LISTED",orderID,operationID:x.operationID,ownerID:x.ownerID,
    stationID:x.stationID,typeID:x.typeID,sourceItemID:x.itemID,
    nativeEscrowVerified:true};
  }finally{inFlight.delete(x.operationID)}
 }
 // Any failed/ambiguous RPC is handled by the coordinator's LIST_UNKNOWN journal.
 // No automatic recovery or second Reserve call is exposed here.
 return Object.freeze({listOnce,mode:"MANUAL_NPC_PENDING_MARKET_ONLY",supportsLiveMarket:false});
}
module.exports={createNpcPendingMarketEscrow,ESCROW_BASE};
