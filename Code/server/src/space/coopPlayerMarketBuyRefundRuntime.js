"use strict";
// Rust is the sole order state authority; GameStore is the sole ISK
// authority. Never infer cancellation from an RPC timeout. Independent
// GetOrder terminal readback is required before native wallet credit.
const native=require("./coopPlayerMarketBuyRefund"+(__filename.endsWith(".cjs")?".cjs":""));
const orderID=x=>typeof x==="string"&&/^[1-9][0-9]*$/.test(x);
function checkSame(before,after,state){
 const a=before?.row||before,b=after?.row||after;
 if(!orderID(String(before?.order_id??""))||
    String(after?.order_id)!==String(before?.order_id)||
    before.owner_id!==after.owner_id||
    before.is_corp!==false||after.is_corp!==false||
    before.source!=="player"||after.source!=="player"||
    a?.bid!==true||b?.bid!==true||
    a?.station_id!==b?.station_id||
    a?.type_id!==b?.type_id||
    a?.vol_remaining!==b?.vol_remaining||
    a?.price!==b?.price||
    after.state!==state)
  throw Error("P2P_BUY_REFUND_ORIGINAL_RUST_TERMINAL_READBACK_MISMATCH");
 return after;
}
function createBuyRefundRuntime({store=native}={}){
 if(typeof store?.refund!=="function"||typeof store?.preflight!=="function")
  throw Error("P2P_BUY_REFUND_NATIVE_STORE_REQUIRED");
 async function cancel({client,order}={}){
  if(typeof client?.call!=="function"||order?.state!=="open")
   throw Error("P2P_BUY_REFUND_CANCEL_ORIGINAL_RUST_REQUIRED");
  store.preflight(order); // Before any Rust state change, verify real funds.
  const order_id=String(order.order_id);
  const ack=await client.call("CancelOrder",{order_id});
  if(String(ack?.order_id)!==order_id||
     ack?.state!=="cancelled"||ack?.invalidated!==true)
   throw Error("P2P_BUY_REFUND_ORIGINAL_CANCEL_ACK_NOT_CONFIRMED");
  const observed=await client.call("GetOrder",{order_id});
  return store.refund(checkSame(order,observed,"cancelled"),"cancelled");
 }
 async function expire({client,order}={}){
  if(typeof client?.call!=="function"||order?.state!=="expired")
   throw Error("P2P_BUY_REFUND_EXPIRY_EVENT_REQUIRED");
  const order_id=String(order.order_id);
  const observed=await client.call("GetOrder",{order_id});
  return store.refund(checkSame(order,observed,"expired"),"expired");
 }
 return Object.freeze({cancel,expire});
}
const current=createBuyRefundRuntime();
module.exports={createBuyRefundRuntime,cancel:args=>current.cancel(args),
 expire:args=>current.expire(args)};
