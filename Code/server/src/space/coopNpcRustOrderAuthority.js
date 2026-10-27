"use strict";
// COOP-050: pinned EveJS Rust market returns a public OrderRow in GetOrders,
// then OwnerOrderRow with NESTED .row in GetOrder. Never infer owner from book.
const safe=n=>Number.isSafeInteger(n)&&n>0;
const decimal=v=>{
 if(typeof v==="number")return Number.isSafeInteger(v)?v:null;
 if(typeof v==="string"&&/^(0|[1-9][0-9]*)$/.test(v)){
  const n=Number(v);return Number.isSafeInteger(n)?n:null;
 }
 return null;
};
const cents=v=>{
 if(typeof v!=="number"||!Number.isFinite(v)||v<=0||
    v>1000000)return null;
 // Public OrderRow and private OwnerOrderRow must agree on an ORIGINAL
 // whole-cent price. Rounding 1.254 ISK into 125 cents fabricates a valid
 // player ASK quote and may authorize NPC corporate spend at a changed price.
 const scaled=v*100,n=Math.round(scaled);
 return Number.isSafeInteger(n)&&n>0&&Math.abs(scaled-n)<=1e-7?n:null;
};
const deny=reason=>({ok:false,reason});
function decodeNativeGetOrder(raw){
 // Explicitly require the upstream OwnerOrderRow schema; no untrusted
 // flattened fallback that would hide server contract drift.
 const r=raw?.row;
 const id=decimal(r?.order_id),owner=decimal(raw?.owner_id),
  station=decimal(r?.station_id),type=decimal(r?.type_id),
  quantity=decimal(r?.vol_remaining),price=cents(r?.price);
 if(!safe(id)||!safe(owner)||!safe(station)||!safe(type)||
    !safe(quantity)||!safe(price)||raw?.source!=="player"||
    r?.source!=="player"||raw?.is_corp!==false||
    raw?.state!=="open"||r?.bid!==false)
   return deny("NATIVE_OWNER_ORDER_ROW_INVALID");
 return {ok:true,order_id:id,owner_id:owner,station_id:station,
  type_id:type,vol_remaining:quantity,price:r.price,
  price_cents:price,source:"player",is_corp:false,state:"open",bid:false};
}
function verifyNativeBookAsk(book,detail,{stationID,typeID}={}){
 // Only OrderRow is present in GetOrders. It has no owner/state/is_corp.
 // Fetch OwnerOrderRow separately and match ALL immutable public fields.
 const id=decimal(book?.order_id),station=decimal(book?.station_id),
  type=decimal(book?.type_id),quantity=decimal(book?.vol_remaining),
  price=cents(book?.price);
 if(book?.source!=="player"||book?.bid!==false||
    !safe(id)||!safe(station)||!safe(type)||!safe(quantity)||
    !safe(price)||station!==stationID||type!==typeID)
  return deny("RUST_PUBLIC_ORDER_ROW_INVALID");
 const d=decodeNativeGetOrder(detail);
 if(!d.ok)return d;
 if(d.order_id!==id||d.station_id!==station||d.type_id!==type||
    d.vol_remaining!==quantity||d.price_cents!==price)
  return deny("RUST_BOOK_OWNER_ORDER_DRIFT");
 return {...d,ok:true};
}
function normalizeNativeOrderForCoordinator(raw){
 // Preserve actual native state on later retries: SETTLING/FILLED may be
 // correct only if the coordinator already persisted the same claim key.
 const r=raw?.row;
 const order=decimal(r?.order_id),owner=decimal(raw?.owner_id),
  station=decimal(r?.station_id),type=decimal(r?.type_id),
  quantity=decimal(r?.vol_remaining),price=cents(r?.price);
 if(!safe(order)||!safe(owner)||!safe(station)||!safe(type)||
    quantity===null||quantity<0||!safe(price)||
    raw?.source!=="player"||r?.source!=="player"||
    raw?.is_corp!==false||r?.bid!==false||
    !["open","settling","filled"].includes(raw?.state))
  throw Error("RUST_NATIVE_GET_ORDER_SCHEMA_DRIFT");
 if(raw.state==="open"&&quantity===0)
  throw Error("RUST_NATIVE_OPEN_ORDER_EMPTY");
 if(raw.state==="filled"&&quantity!==0)
  throw Error("RUST_NATIVE_FILLED_ORDER_HAS_STOCK");
 return {source:"player",state:raw.state,is_corp:false,bid:false,
  order_id:order,owner_id:owner,station_id:station,type_id:type,
  vol_remaining:quantity,price:r.price};
}
module.exports={decodeNativeGetOrder,verifyNativeBookAsk,
 normalizeNativeOrderForCoordinator};
