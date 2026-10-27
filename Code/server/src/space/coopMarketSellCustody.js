"use strict";
// Read-only custody proof for native player SELL cancellations/expiries.
// Only EveJS itemStore and Rust/marketEscrow are authoritative. Never mint items.
const pos=x=>typeof x==="number"&&Number.isSafeInteger(x)&&x>0;
const i64=x=>{
 if(typeof x==="bigint")return x>0n?String(x):null;
 if(pos(x))return String(x);
 if(typeof x==="string"&&/^[1-9][0-9]*$/.test(x))return x;
 return null;
};
const quantity=item=>{
 if(item?.singleton===1)return item.stacksize===1||item.stacksize==null?1:null;
 const value=item?.stacksize??item?.quantity;
 return pos(value)?value:null;
};
function deny(reason){throw Error("COOP_MARKET_SELL_CUSTODY_"+reason);}
function assertSellEscrow({order,escrow,items,hangarFlag=4}={}){
 const row=order?.row||order;
 const id=i64(order?.order_id),rowID=i64(row?.order_id),escrowID=i64(escrow?.orderId);
 if(!id||id!==rowID||id!==escrowID)deny("ORDER_ID_MISMATCH");
 const owner=order?.owner_id,station=row?.station_id,type=row?.type_id,remaining=row?.vol_remaining;
 if(!pos(owner)||!pos(station)||!pos(type)||!pos(remaining)||
    row?.bid!==false||order?.is_corp!==false||
    (order?.source!=null&&order.source!=="player")||
    (row?.source!=null&&row.source!=="player"))deny("NATIVE_SELL_ORDER_INVALID");
 // Original EveJS maps a Rust order ID to a numeric synthetic item location.
 // Reject IDs that cannot be mapped bijectively in JS (otherwise two
 // distinct i64 order IDs can alias one inventory container).
 const expectedLocation=BigInt(id)+9200000000n;
 if(expectedLocation>BigInt(Number.MAX_SAFE_INTEGER)||
    escrow?.escrowLocationID!==Number(expectedLocation))
  deny("UNSAFE_OR_COLLIDING_ESCROW_LOCATION");
 if(!escrow||escrow.escrowType!=="sell"||escrow.isCorp!==false||
    escrow.ownerId!==owner||escrow.stationId!==station||
    escrow.typeId!==type||escrow.remainingQuantity!==remaining||
    !pos(escrow.escrowLocationID)||!pos(hangarFlag))
  deny("ESCROW_IDENTITY_OR_QUANTITY_MISMATCH");
 if(!Array.isArray(items)||items.length===0||items.length>10000)
  deny("PHYSICAL_ESCROW_EMPTY_OR_UNAVAILABLE");
 const seen=new Set(),snapshots=[];
 let total=0;
 for(const item of items){
  const q=quantity(item);
  if(!pos(item?.itemID)||seen.has(item.itemID)||item.ownerID!==owner||
     item.locationID!==escrow.escrowLocationID||
     item.flagID!==hangarFlag||item.typeID!==type||!q||
     !Number.isSafeInteger(total+q))deny("PHYSICAL_ITEM_CUSTODY_MISMATCH");
  seen.add(item.itemID);
  total+=q;
  snapshots.push(Object.freeze({itemID:item.itemID,typeID:type,quantity:q}));
 }
 if(total!==remaining)deny("PHYSICAL_ESCROW_QUANTITY_MISMATCH");
 return Object.freeze({orderID:id,ownerID:owner,stationID:station,
  typeID:type,escrowLocationID:escrow.escrowLocationID,
  hangarFlag,remainingQuantity:total,items:Object.freeze(snapshots)});
}
function assertSellReturned({proof,remainingItems,findItemById}={}){
 if(!proof||!Object.isFrozen(proof)||!pos(proof.ownerID)||
    !Array.isArray(proof.items)||proof.items.length===0||
    !Array.isArray(remainingItems)||typeof findItemById!=="function")
  deny("RESTORE_PROOF_UNAVAILABLE");
 // Fail closed before the native escrow row is removed. The same original
 // item IDs and quantities must be in the seller's native station hangar.
 if(remainingItems.length!==0)deny("PHYSICAL_ESCROW_NOT_EMPTY_AFTER_RETURN");
 for(const expected of proof.items){
  let item;
  try{item=findItemById(expected.itemID)}catch{deny("RESTORED_ITEM_READ_UNAVAILABLE")}
  if(!item||item.itemID!==expected.itemID||
     item.ownerID!==proof.ownerID||item.locationID!==proof.stationID||
     item.flagID!==proof.hangarFlag||item.typeID!==proof.typeID||
     quantity(item)!==expected.quantity)
   deny("ORIGINAL_ITEM_NOT_RESTORED");
 }
 return true;
}
module.exports={assertSellEscrow,assertSellReturned};
