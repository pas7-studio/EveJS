"use strict";
// Chat 29: read-only matching-escrow consistency proof before any native BUY order refund.
// Never credits wallets or changes Rust orders, native inventory, or SQLite.
const positive=x=>Number.isSafeInteger(x)&&x>0;
const integer=x=>{
 if(typeof x==="number")return Number.isSafeInteger(x)?x:null;
 if(typeof x==="string"&&/^(0|[1-9][0-9]*)$/.test(x)){
  const n=Number(x);return Number.isSafeInteger(n)?n:null;
 }
 return null;
};
const orderID=x=>{
 if(typeof x==="bigint"&&x>0n)return String(x);
 if(typeof x==="number"&&positive(x))return String(x);
 if(typeof x==="string"&&/^[1-9][0-9]*$/.test(x))return x;
 return null;
};
const moneyCents=x=>{
 if(typeof x!=="number"||!Number.isFinite(x)||x<0)return null;
 const rounded=Math.round(x*100);
 if(!Number.isSafeInteger(rounded)||Math.abs(x*100-rounded)>1e-6)return null;
 return rounded;
};
function deny(code){throw Error("COOP_MARKET_CANCEL_"+code);}
function assertMatchingBuyEscrow({order,escrow}={}){
 const row=order?.row;
 const id=orderID(order?.order_id),rowID=orderID(row?.order_id),
  owner=integer(order?.owner_id),station=integer(row?.station_id),
  type=integer(row?.type_id),qty=integer(row?.vol_remaining),
  price=moneyCents(row?.price);
 if(!id||id!==rowID||!positive(owner)||!positive(station)||
    !positive(type)||!positive(qty)||price===null||price<=0||
    row?.bid!==true||order?.is_corp!==false||
    (order?.source!=null&&order.source!=="player")||
    (row?.source!=null&&row.source!=="player"))deny("ORDER_AUTHORITY_INVALID");
 if(!escrow||orderID(escrow.orderId)!==id||
    escrow.escrowType!=="buy"||escrow.isCorp!==false||
    integer(escrow.ownerId)!==owner||integer(escrow.stationId)!==station||
    integer(escrow.typeId)!==type||integer(escrow.remainingQuantity)!==qty)
  deny("ESCROW_IDENTITY_MISSING_OR_CHANGED");
 const escrowPrice=moneyCents(escrow.price),escrowAmount=moneyCents(escrow.escrowAmount),
  total=price*qty;
 if(escrowPrice===null||escrowPrice!==price||
    escrowAmount===null||!Number.isSafeInteger(total)||
    escrowAmount!==total||total<=0)deny("ESCROW_AMOUNT_UNBACKED");
 return Object.freeze({orderID:id,ownerID:owner,stationID:station,
  typeID:type,remainingQuantity:qty,priceCents:price,refundCents:total});
}
function assertCancelledAck({ack,orderID:expected}={}){
 if(!ack||ack.invalidated!==true||ack.state!=="cancelled"||
    orderID(ack.order_id)!==orderID(expected))deny("NATIVE_CANCEL_ACK_UNVERIFIED");
 return true;
}
module.exports={assertMatchingBuyEscrow,assertCancelledAck};
