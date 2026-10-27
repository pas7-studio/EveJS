"use strict";
// Exact native multi-stack original player SELL fills. Atomic GameStore COMMIT
// first; Rust finalize keeps the order locked; release needs two durable
// witnesses: the native SQLite receipt and the fsynced settlement journal.
const ext=__filename.endsWith(".cjs")?".cjs":"";
const store=require("./coopPlayerMarketAtomicSettlement"+ext);
const buyStore=require("./coopPlayerMarketBuySettlement"+ext);
const rust=require("./coopPlayerMarketRustClaim"+ext);
const fence=require("./coopPlayerMarketSettlementFence"+ext);
function enabled(){
 return process.env.EVEJS_COOP_PLAYER_MARKET_ATOMIC==="1"&&
  process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
  process.env.EVEJS_COOP_PLAYER_MARKET_FILL_GUARD==="1"&&
  process.env.EVEJS_COOP_PLAYER_MARKET_SETTLEMENT_FENCE==="1"&&
  process.env.EVEJS_COOP_RUST_P2P_CLAIM==="1";
}
function createAtomicRuntime({atomicStore=store,atomicBuyStore=buyStore,rustAPI=rust,journal=fence,enabledFn=enabled}={}){
async function settleSell({ticket,proof,tax,sourceItemID,sourceItemIDs,client}={}){
 if(!enabledFn())throw Error("P2P_ATOMIC_SETTLEMENT_FLAGS_DISABLED");
 if(typeof client?.call!=="function"||!ticket||!proof||
  proof.bid!==false||!Object.isFrozen(proof))
  throw Error("P2P_ATOMIC_NATIVE_MARKET_AUTHORITIES_REQUIRED");
 // A claimant can only settle the exact order/cycle locked by Rust,
 // not a forged receipt or a merely published market order.
 const observed=await rustAPI.readClaim({ticket,client});
 const request=rustAPI.details(ticket,proof);
 if(!observed||observed.phase!=="claimed"||
    observed.order_id!==request.order_id||observed.cycle!==request.cycle||
    observed.buyer_id!==request.buyer_id||
    observed.seller_id!==request.seller_id||
    observed.volume_before!==request.volume_before||
    observed.filled_quantity!==request.filled_quantity||
    observed.volume_after!==request.volume_before-request.filled_quantity)
  throw Error("P2P_ATOMIC_ORIGINAL_RUST_CLAIM_NOT_VERIFIED");
 const receipt=atomicStore.settle({ticket,proof,tax,sourceItemID,sourceItemIDs});
 if(receipt?.phase!=="GAMESTORE_COMMITTED"||receipt?.replayed)
  throw Error("P2P_ATOMIC_NATIVE_COMMIT_REPLAY_REQUIRES_RECONCILIATION");
 const ack=await rustAPI.finalize({ticket,proof,client});
 journal.confirmRust(ticket,ack);
 journal.complete(ticket,{salesTax:tax});
 journal.requireSettled(ticket);
 const durable=atomicStore.requireReceipt(ticket,proof);
 const release=await rustAPI.release({ticket,proof,client,receipt:durable});
 return {receipt:durable,release,ack};
}
async function settleBuy({ticket,proof,tax,sourceItemID,client}={}){
 if(!enabledFn()||process.env.EVEJS_COOP_PLAYER_MARKET_BUY_RESERVE!=="1")
  throw Error("P2P_BUY_PAY_STRICT_FLAGS_REQUIRED");
 if(typeof client?.call!=="function"||!ticket||!Object.isFrozen(proof)||
    proof.bid!==true)
  throw Error("P2P_BUY_PAY_NATIVE_RUST_AUTHORITIES_REQUIRED");
 const expected=rustAPI.details(ticket,proof);
 const claim=await rustAPI.readClaim({ticket,client});
 if(!claim||claim.phase!=="claimed"||
    claim.order_id!==expected.order_id||claim.cycle!==expected.cycle||
    claim.buyer_id!==expected.buyer_id||
    claim.seller_id!==expected.seller_id||
    claim.volume_before!==expected.volume_before||
    claim.filled_quantity!==expected.filled_quantity||
    claim.volume_after!==expected.volume_before-expected.filled_quantity)
  throw Error("P2P_BUY_PAY_ORIGINAL_RUST_CLAIM_NOT_VERIFIED");
 const receipt=atomicBuyStore.settle({ticket,proof,sourceItemID,tax});
 if(!receipt||receipt.phase!=="GAMESTORE_COMMITTED"||receipt.replayed)
  throw Error("P2P_BUY_PAY_COMMITTED_REPLAY_REQUIRES_RECONCILIATION");
 const ack=await rustAPI.finalize({ticket,proof,client});
 journal.confirmRust(ticket,ack);
 journal.complete(ticket,{salesTax:tax});
 journal.requireSettled(ticket);
 const durable=atomicBuyStore.requireReceipt(ticket,proof);
 const release=await rustAPI.release({ticket,proof,client,receipt:durable});
 return {receipt:durable,ack,release};
}
return Object.freeze({settleSell,settleBuy});
}
const {settleSell,settleBuy}=createAtomicRuntime();
module.exports={enabled,settleSell,settleBuy,createAtomicRuntime};
