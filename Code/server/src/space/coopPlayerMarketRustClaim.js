"use strict";
// Native market RPC adapter: the original Rust daemon remains sole order writer.
// Claim is durable in market.sqlite before EveJS wallet/item transfer. A lost
// reply is UNKNOWN; do not auto-retry fills or pay ISK without the journal.
const {assertFillAck}=require("./coopPlayerMarketFill"+(__filename.endsWith(".cjs")?".cjs":""));
const positive=n=>typeof n==="number"&&Number.isSafeInteger(n)&&n>0;
const id=x=>typeof x==="string"&&/^[1-9][0-9]*$/.test(x);
function details(ticket,proof){
 if(!ticket||!proof||!Object.isFrozen(proof)||
    !id(ticket.orderID)||ticket.orderID!==proof.orderID||
    !positive(ticket.cycle)||!positive(proof.ownerID)||
    !positive(proof.counterpartyID)||proof.counterpartyID===proof.ownerID||
    !positive(proof.filledQuantity)||!positive(proof.volumeBefore)||
    !positive(proof.priceCents)||proof.volumeBefore<proof.filledQuantity)
  throw Error("P2P_RUST_CLAIM_NATIVE_TICKET_INVALID");
 const buyer=proof.bid?proof.ownerID:proof.counterpartyID;
 const seller=proof.bid?proof.counterpartyID:proof.ownerID;
 return {order_id:proof.orderID,cycle:ticket.cycle,
  buyer_id:buyer,seller_id:seller,
  volume_before:proof.volumeBefore,
  filled_quantity:proof.filledQuantity,
  price_cents:proof.priceCents};
}
async function claim({ticket,proof,client}={}){
 if(typeof client?.call!=="function")
  throw Error("P2P_RUST_MARKET_DAEMON_REQUIRED");
 const request=details(ticket,proof);
 const ack=await client.call("ClaimPlayerFill",request);
 if(ack?.order_id!==request.order_id||ack.cycle!==request.cycle||
    ack.phase!=="claimed"||ack.buyer_id!==request.buyer_id||
    ack.seller_id!==request.seller_id||
    ack.volume_before!==request.volume_before||
    ack.filled_quantity!==request.filled_quantity||
    ack.volume_after!==request.volume_before-request.filled_quantity)
  throw Error("P2P_RUST_CLAIM_RECEIPT_UNVERIFIED");
 return ack;
}
async function finalize({ticket,proof,client}={}){
 if(typeof client?.call!=="function")throw Error("P2P_RUST_MARKET_DAEMON_REQUIRED");
 const request=details(ticket,proof);
 const ack=await client.call("FinalizePlayerFill",{
  order_id:request.order_id,cycle:request.cycle,
  buyer_id:request.buyer_id,seller_id:request.seller_id
 });
 assertFillAck({proof,ack});
 if(ack.release_pending!==true)
  throw Error("P2P_RUST_FINALIZE_REQUIRES_LOCKED_RELEASE_PENDING");
 return ack;
}
async function release({ticket,proof,client,receipt}={}){
 if(typeof client?.call!=="function")
  throw Error("P2P_RUST_MARKET_DAEMON_REQUIRED");
 const d=details(ticket,proof);
 const key="p2p:"+ticket.orderID+":"+ticket.cycle;
 const gross=d.price_cents*d.filled_quantity,
  nonneg=x=>typeof x==="number"&&Number.isSafeInteger(x)&&x>=0;
 // The exported native Rust release adapter is a final safety boundary,
 // even for callers outside the normal double-witness runtime. It must
 // never turn a paid receipt from another item, station or fill cycle
 // into authority to unlock this original Rust order.
 if(!receipt||receipt.key!==key||
    receipt.phase!=="GAMESTORE_COMMITTED"||
    receipt.orderID!==d.order_id||receipt.cycle!==d.cycle||
    receipt.buyerID!==d.buyer_id||receipt.sellerID!==d.seller_id||
    receipt.stationID!==proof.stationID||receipt.typeID!==proof.typeID||
    !positive(receipt.itemID)||!positive(receipt.sourceItemID)||
    receipt.quantity!==d.filled_quantity||
    receipt.volumeBefore!==proof.volumeBefore||
    receipt.volumeAfter!==proof.volumeAfter||
    (proof.bid===false&&receipt.partial!==(proof.volumeAfter>0))||
    receipt.priceCents!==d.price_cents||
    !positive(gross)||receipt.grossCents!==gross||
    !nonneg(receipt.taxCents)||receipt.taxCents>gross||
    !nonneg(receipt.buyerBeforeCents)||
    !nonneg(receipt.buyerAfterCents)||
    !nonneg(receipt.sellerBeforeCents)||
    !nonneg(receipt.sellerAfterCents)||
    !nonneg(receipt.sellerBeforeCents+gross)||
    receipt.sellerAfterCents!==receipt.sellerBeforeCents+gross-receipt.taxCents||
    (proof.bid===false&&
      (receipt.buyerBeforeCents<gross||
       receipt.buyerAfterCents!==receipt.buyerBeforeCents-gross))||
    (proof.bid===true&&
      (receipt.kind!=="P2P_BUY_PAID"||
       receipt.buyerBeforeCents!==receipt.buyerAfterCents||
       !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.reserveOperationID)||
       receipt.reserveReceiptKey!=="buy-reserve:"+receipt.reserveOperationID||
       !nonneg(receipt.reserveBeforeCents)||
       !nonneg(receipt.reserveAfterCents)||
       receipt.reserveBeforeCents-receipt.reserveAfterCents!==gross))||
    !positive(receipt.committedAt))
  throw Error("P2P_RUST_RELEASE_DURABLE_NATIVE_RECEIPT_REQUIRED");
 const response=await client.call("ReleasePlayerFill",{
  order_id:d.order_id,cycle:d.cycle,buyer_id:d.buyer_id,
  seller_id:d.seller_id,native_receipt_key:key
 });
 if(response?.order_id!==d.order_id||response.cycle!==d.cycle||
    response.phase!=="released"||response.native_receipt_key!==key||
    response.state!==(proof.volumeAfter===0?"filled":"open")||
    response.ack?.order_id!==d.order_id||
    response.ack?.release_pending!==true)
  throw Error("P2P_RUST_RELEASE_ACK_UNVERIFIED");
 return response;
}
async function readClaim({ticket,client}={}){
 if(typeof client?.call!=="function"||!id(ticket?.orderID)||
   !positive(ticket.cycle))throw Error("P2P_RUST_READ_CLAIM_INVALID");
 return client.call("GetPlayerFillClaim",
  {order_id:ticket.orderID,cycle:ticket.cycle});
}
module.exports={details,claim,finalize,release,readClaim};
