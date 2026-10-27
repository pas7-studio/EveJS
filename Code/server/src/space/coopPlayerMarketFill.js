"use strict";
// Read-only native P2P market fill admission and exact Rust FillOrder ACK.
// Does not mint items, mutate wallets, modify GameStore or issue Rust orders.
const extension=__filename.endsWith(".cjs")?".cjs":"";
const {assertMatchingBuyEscrow}=require("./coopMarketCancelCustody"+extension);
const {assertSellEscrow}=require("./coopMarketSellCustody"+extension);
const pos=x=>typeof x==="number"&&Number.isSafeInteger(x)&&x>0;
const id=x=>{
 if(typeof x==="bigint")return x>0n?String(x):null;
 if(pos(x))return String(x);
 if(typeof x==="string"&&/^[1-9][0-9]*$/.test(x))return x;
 return null;
};
const cents=x=>{
 if(typeof x!=="number"||!Number.isFinite(x)||x<=0)return null;
 const n=Math.round(x*100);
 return Number.isSafeInteger(n)&&n>0&&Math.abs(x*100-n)<1e-6?n:null;
};
const qty=x=>{
 if(x?.singleton===1)return x.stacksize==null||x.stacksize===1?1:null;
 const n=x?.stacksize??x?.quantity;
 return pos(n)?n:null;
};
function deny(reason){throw Error("COOP_PLAYER_MARKET_FILL_"+reason);}
function originalOrder(order,bookRow,{bid,ownerID,counterpartyID,quantity,price}){
 const row=order?.row||order;
 const nativeID=id(order?.order_id);
 if(!nativeID||id(row?.order_id)!==nativeID||
    id(bookRow?.order_id)!==nativeID||
    !pos(ownerID)||order?.owner_id!==ownerID||
    order?.is_corp!==false||row?.bid!==bid||bookRow?.bid!==bid||
    !pos(counterpartyID)||ownerID===counterpartyID||
    !pos(row?.station_id)||!pos(row?.type_id)||
    row?.station_id!==bookRow?.station_id||
    row?.type_id!==bookRow?.type_id||
    (order.source!=null&&order.source!=="player")||
    (row.source!=null&&row.source!=="player")||
    (bookRow.source!=null&&bookRow.source!=="player"))
   deny("UNAUTHORIZED_OR_STALE_ORIGINAL_ORDER");
 const before=row.vol_remaining;
 if(!pos(before)||before!==bookRow.vol_remaining||
    !pos(quantity)||quantity>before||
    cents(price)===null||cents(row.price)!==cents(price)||
    cents(bookRow.price)!==cents(price)||
    !Number.isSafeInteger(cents(price)*quantity))
   deny("ORDER_VOLUME_OR_PRICE_CHANGED");
 if(bid){
  const minVolume=bookRow.min_volume??1;
  if(!pos(minVolume)||
   !(quantity>=minVolume||(before<minVolume&&quantity===before)))
   deny("NATIVE_MIN_VOLUME_VIOLATION");
 }
 return Object.freeze({orderID:nativeID,ownerID,stationID:row.station_id,
  typeID:row.type_id,bid,priceCents:cents(price),
  volumeBefore:before,filledQuantity:quantity,counterpartyID,
  volumeAfter:before-quantity});
}
function checkSellMatch({order,bookRow,escrow,items,buyerCharacterID,
 tradedQuantity,price}={}){
 const proof=originalOrder(order,bookRow,{bid:false,
  ownerID:order?.owner_id,counterpartyID:buyerCharacterID,
  quantity:tradedQuantity,price});
 try{assertSellEscrow({order,escrow,items})}
 catch(e){deny("SELL_PHYSICAL_ESCROW_UNVERIFIED:"+String(e.message).slice(0,100))}
 return Object.freeze({...proof,sellerSourceLocationID:escrow.escrowLocationID});
}
function checkBuyMatch({order,bookRow,escrow,sellerCharacterID,
 fillableQuantity,price,sourceItem,sourceOrder,sourceEscrow,sourceItems,
 sourceStationID,hangarFlag=4}={}){
 const proof=originalOrder(order,bookRow,{bid:true,
  ownerID:order?.owner_id,counterpartyID:sellerCharacterID,
  quantity:fillableQuantity,price});
 try{assertMatchingBuyEscrow({order,escrow})}
 catch(e){deny("BUY_RESERVE_UNVERIFIED:"+String(e.message).slice(0,100))}
 if(sourceOrder){
  if(id(sourceOrder.order_id)===proof.orderID)
   deny("SELF_MATCHED_ORDER_ID");
  try{
   const sell=assertSellEscrow({order:sourceOrder,escrow:sourceEscrow,
    items:sourceItems,hangarFlag});
   if(sell.ownerID!==sellerCharacterID||
      sell.typeID!==proof.typeID||
      sell.stationID!==sourceStationID||
      sell.remainingQuantity<fillableQuantity)
    deny("SELL_SOURCE_ESCROW_MISMATCH");
  }catch(e){deny("SELL_SOURCE_ESCROW_UNVERIFIED:"+String(e.message).slice(0,100))}
 }else{
  if(!sourceItem||!pos(sourceItem.itemID)||
     sourceItem.ownerID!==sellerCharacterID||
     sourceItem.typeID!==proof.typeID||
     sourceItem.locationID!==sourceStationID||
     sourceItem.flagID!==hangarFlag||
     !pos(qty(sourceItem))||qty(sourceItem)<fillableQuantity)
   deny("SELLER_NATIVE_HANGAR_ITEM_UNAVAILABLE");
 }
 return Object.freeze({...proof,
  sellerSourceLocationID:sourceOrder?
   sourceEscrow.escrowLocationID:sourceStationID});
}
function assertFillAck({proof,ack}={}){
 if(!proof||!Object.isFrozen(proof)||!ack||
   id(ack.order_id)!==proof.orderID||
   ack.owner_id!==proof.ownerID||
   ack.is_corp!==false||
   ack.station_id!==proof.stationID||
   ack.type_id!==proof.typeID||
   ack.bid!==proof.bid||
   ack.filled_quantity!==proof.filledQuantity||
   ack.vol_remaining!==proof.volumeAfter||
   cents(ack.price)!==proof.priceCents||
   ack.state!==(proof.volumeAfter===0?"filled":"open")||
   ack.invalidated!==true)
  deny("RUST_FILL_ACK_NOT_MATCHED");
 return true;
}
module.exports={checkSellMatch,checkBuyMatch,assertFillAck};
