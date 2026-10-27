"use strict";
// Original Rust PlaceOrder is not transactional with GameStore. Reserve first,
// verify original GetOrder second, bind native escrow last; never auto-refund
// an unknown outcome or repeat a PlaceOrder with a new operation ID.
const {begin,bind}=require("./coopPlayerMarketBuyReserve"+(__filename.endsWith(".cjs")?".cjs":""));
const id=x=>typeof x==="string"&&/^[1-9][0-9]*$/.test(x);
async function place({client,quote,store={begin,bind}}={}){
 if(typeof client?.call!=="function"||
    typeof store?.begin!=="function"||typeof store?.bind!=="function")
  throw Error("P2P_BUY_RESERVE_ORIGINAL_RUST_DAEMON_REQUIRED");
 const pending=store.begin(quote);
 if(pending?.kind!=="P2P_BUY_RESERVE"||
    pending?.phase!=="RESERVED"||!pending?.operationID)
  throw Error("P2P_BUY_RESERVE_NATIVE_COMMIT_UNVERIFIED");
 const reply=await client.call("PlaceOrder",{
  owner_id:pending.buyerID,is_corp:false,
  station_id:pending.stationID,type_id:pending.typeID,
  price:pending.priceCents/100,quantity:pending.quantity,
  min_volume:pending.minVolume,duration_days:pending.durationDays,
  range_value:pending.orderRange,bid:true,source:"player"
 });
 const orderID=String(reply?.order_id??"");
 if(!id(orderID)||reply?.station_id!==pending.stationID||
    reply?.type_id!==pending.typeID)
  throw Error("P2P_BUY_RESERVE_RUST_PLACE_ACK_UNVERIFIED");
 // An ACK alone never proves the order is really stored under the
 // expected native Rust identity. Never create escrow without GetOrder.
 const order=await client.call("GetOrder",{order_id:orderID});
 if(String(order?.order_id??"")!==orderID)
  throw Error("P2P_BUY_RESERVE_RUST_ORDER_READBACK_MISMATCH");
 const bound=store.bind(pending,order);
 if(bound?.phase!=="BOUND"||bound.orderID!==orderID)
  throw Error("P2P_BUY_RESERVE_NATIVE_BIND_UNVERIFIED");
 return {order,receipt:bound};
}
module.exports={place};
