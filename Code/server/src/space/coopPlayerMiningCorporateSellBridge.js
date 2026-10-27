"use strict";
// E2B2 source bridge: one original corp office item -> private Rust SELL prep
// -> native GameStore escrow -> independently re-read same source GameStore
// receipt from Rust. NO market publication or revenue settlement.
const crypto=require("node:crypto");
const {createOriginalCorporateSellCustody}=require(
 "./coopPlayerMiningCorporateSellCustody"+(__filename.endsWith(".js")?"":".cjs"));
const pos=n=>Number.isSafeInteger(n)&&n>0;
const hex=/^[a-f0-9]{32}$/;
const sourceOperation=({corporationID,operationID,cargoID,itemID,priceCents})=>
 "coop-corp-sell:"+crypto.createHash("sha256")
  .update([corporationID,operationID,cargoID,itemID,priceCents].join(":"))
  .digest("hex").slice(0,32);
function createNativeCorporateSellBridge({marketClient,gameStore,access,readiness,
 quotePrice,token,clock=()=>Date.now(),enabled=()=>false,
 publishEnabled=()=>false,observe=()=>{}}={}){
 if(typeof marketClient?.call!=="function"||
  [readiness?.inspect,quotePrice,access?.isMember,access?.canIndustry,
   access?.canWallet,access?.canTake,clock,enabled,publishEnabled,observe].some(f=>typeof f!=="function")||
  typeof token!=="string"||token.length<32||token.length>256)
  throw Error("CORP_SELL_NATIVE_RUST_AUTHORITIES_REQUIRED");
 const proofByOrder=new Map(),inFlight=new Set(),uncertain=new Set();
 const escrow=createOriginalCorporateSellCustody({
  gameStore,access,readiness,clock,enabled,
  verifyNativeSellOrder:({orderID,cargoID,corporationID,operationID,ore})=>{
   const record=proofByOrder.get(orderID);
   return record?.cargoID===cargoID&&record.corporationID===corporationID&&
    record.operationID===operationID&&record.ore.itemID===ore.itemID?
     record.proof:null;
  },
  // Cancellation / partial fills require a separately implemented original
  // Rust exact fill claimant. Never trust a claimed client cancel flag.
  readCancelProof:()=>null
 });
 const rejected=(reason,operationID=null)=>({status:"BLOCKED",reason,
  operationID,nativeMutation:false,marketOrderCreated:false,
  realizedRevenueCents:null,netProfitCents:null});
 function attest(prepared,ore,{op,shiftID,corporationID,cargoID,priceCents}){
  const order=prepared?.order;
  return prepared?.verifiedNative===true&&
   prepared?.phase==="PREPARED_UNPUBLISHED"&&
   prepared.isPublished===false&&prepared.totalFilled===0&&
   prepared.totalPaidCents===0&&prepared.operationID===op&&
   prepared.shiftID===shiftID&&prepared.cargoID===cargoID&&
   prepared.itemID===ore.itemID&&
   typeof prepared.orderID==="string"&&
   /^[1-9][0-9]{0,17}$/.test(prepared.orderID)&&
   order?.order_id===prepared.orderID&&order.owner_id===corporationID&&
   order.is_corp===true&&order.bid===false&&
   order.station_id===ore.stationID&&
   order.type_id===ore.typeID&&order.vol_entered===ore.quantity&&
   order.vol_remaining===ore.quantity&&
   order.source==="coop-corporation"&&order.state==="prepared"&&
   order.price_cents===priceCents;
 }
 async function prepareAndBind({session,corporationID,operationID,cargoID}={}){
  if(enabled()!==true)return rejected("CORP_SELL_PREPARE_DISABLED");
  if(!pos(corporationID)||!pos(cargoID)||!session||!hex.test(
    String(operationID||"").replace(/^coop-mining-shift:/,""))||
    session.corporationID!==corporationID)
   return rejected("CORP_SELL_PREPARE_SCOPE_INVALID");
  if(inFlight.has(cargoID)||uncertain.has(cargoID))
   return rejected("CORP_SELL_UNKNOWN_OR_IN_FLIGHT");
  let scope;
  try{scope=readiness.inspect({session,corporationID,operationID,
    cargoIDs:[cargoID]});}catch{return rejected("CORP_SELL_SOURCE_READ_UNAVAILABLE")}
  if(scope?.status!=="NATIVE_CORPORATE_SELL_UNSUPPORTED"||
   scope.originalCorporateOre?.length!==1||
   scope.originalCorporateOre[0]?.cargoID!==cargoID)
   return rejected("CORP_SELL_ORIGINAL_TITLE_OR_ROLE_NOT_VERIFIED");
  const ore=scope.originalCorporateOre[0];
  let priceCents;
  try{priceCents=quotePrice({session,corporationID,operationID,cargoID,ore})}
  catch{return rejected("CORP_SELL_NATIVE_PRICE_UNAVAILABLE")}
  if(!pos(priceCents)||priceCents>100_000_000)
   return rejected("CORP_SELL_NATIVE_PRICE_INVALID");
  const op=sourceOperation({corporationID,operationID,cargoID,
   itemID:ore.itemID,priceCents});
  const data={access_token:token,operation_id:op,shift_id:operationID,
   cargo_id:cargoID,source_item_id:ore.itemID,owner_id:corporationID,
   station_id:ore.stationID,type_id:ore.typeID,
   quantity:ore.quantity,price_cents:priceCents};
  inFlight.add(cargoID);
  let prepared,orderID;
  try{
   prepared=await marketClient.call("PrepareCorpSell",data);
   // Never trust a single acknowledgement: re-read immutable original Rust
   // prepared row and compare every source value before modifying GameStore.
   const read=await marketClient.call("GetCorpSell",{
    access_token:token,operation_id:op});
   if(!attest(prepared,ore,{op,shiftID:operationID,corporationID,cargoID,priceCents})||
      !attest(read,ore,{op,shiftID:operationID,corporationID,cargoID,priceCents})||
      read.orderID!==prepared.orderID)
    throw Error("CORP_SELL_RUST_PREPARE_WITNESS_MISMATCH");
   orderID=read.orderID;
   proofByOrder.set(orderID,{proof:read,cargoID,operationID,corporationID,ore});
   const result=escrow.reserve({session,corporationID,operationID,cargoID,orderID});
   if(result?.status!=="ESCROW_BOUND_UNSETTLED")
    throw Error("CORP_SELL_GAMESTORE_ESCROW_NOT_PROVEN");
   const source=await marketClient.call("VerifyCorpSellEscrow",{
    access_token:token,operation_id:op});
   if(source?.status!=="ESCROW_PROVEN_NOT_PUBLISHED"||
    source.orderID!==orderID||source.itemID!==ore.itemID||
    source.cargoID!==cargoID||source.corporationID!==corporationID||
    source.nativeMarketMutation!==false||source.verifiedGameStore!==true)
    throw Error("CORP_SELL_RUST_GAMESTORE_PROOF_MISSING");
   try{observe("corp-mining-sell-prepared",{status:"ESCROW_PROVEN_NOT_PUBLISHED",
    corporationID,operationID,cargoID,itemID:ore.itemID,orderID});}catch{}
   return {status:"ESCROW_PROVEN_NOT_PUBLISHED",operationID:op,
    orderID,cargoID,itemID:ore.itemID,corporationID,
    nativeMutation:true,marketOrderCreated:false,realizedRevenueCents:null,
    netProfitCents:null};
  }catch{
   // A Rust prepare may have committed even if its reply was lost; a native
   // escrow write may be durable although its RPC proof failed. NO retry,
   // auto-cancel, inventory refund or re-post after this boundary.
   uncertain.add(cargoID);
   return rejected("CORP_SELL_PREPARE_OR_ESCROW_OUTCOME_UNKNOWN",op);
  }finally{
   if(orderID)proofByOrder.delete(orderID);
   inFlight.delete(cargoID);
  }
 }

 async function publishPrepared({session,corporationID,operationID,cargoID,
   itemID,priceCents,orderID}={}){
  if(enabled()!==true||publishEnabled()!==true)
   return rejected("CORP_SELL_PUBLISH_DISABLED");
  if(!pos(session?.characterID)||session.socket?.destroyed===true||
    session.corporationID!==corporationID||
    !pos(corporationID)||!pos(cargoID)||!pos(itemID)||
    !pos(priceCents)||priceCents>100000000||
    !/^coop-mining-shift:[a-f0-9]{32}$/.test(operationID||"")||
    typeof orderID!=="string"||!/^[1-9][0-9]{0,17}$/.test(orderID)||
    BigInt(orderID)+9200000000n>BigInt(Number.MAX_SAFE_INTEGER)||
    uncertain.has(cargoID)||inFlight.has(cargoID))
   return rejected("CORP_SELL_PUBLISH_SCOPE_OR_UNKNOWN");
  if(access.isMember(session,corporationID)!==true||
     access.canIndustry(session,corporationID)!==true||
     access.canWallet(session,corporationID,1000)!==true)
   return rejected("CORP_SELL_PUBLISH_CORPORATION_ROLE_REVOKED");
  const op=sourceOperation({corporationID,operationID,cargoID,
    itemID,priceCents});
  const args={access_token:token,operation_id:op};
  inFlight.add(cargoID);
  let published=false;
  try{
   const order=await marketClient.call("GetCorpSell",args);
   if(order?.verifiedNative!==true||
     order.phase!=="PREPARED_UNPUBLISHED"||
     order.isPublished!==false||
     order.operationID!==op||order.shiftID!==operationID||
     order.cargoID!==cargoID||order.itemID!==itemID||
     order.orderID!==orderID||order.order?.order_id!==orderID||
     order.order?.owner_id!==corporationID||
     order.order?.is_corp!==true||order.order?.bid!==false||
     order.order?.price_cents!==priceCents||
     order.order?.state!=="prepared"||
     order.order?.source!=="coop-corporation")
     return rejected("CORP_SELL_PUBLISH_NATIVE_PREPARE_MISMATCH",op);
   const physical=await marketClient.call("VerifyCorpSellEscrow",args);
   if(physical?.status!=="ESCROW_PROVEN_NOT_PUBLISHED"||
     physical.orderID!==orderID||physical.itemID!==itemID||
     physical.cargoID!==cargoID||
     physical.corporationID!==corporationID||
     physical.verifiedGameStore!==true||
     physical.nativeMarketMutation!==false)
     return rejected("CORP_SELL_PUBLISH_ORIGINAL_ESCROW_UNVERIFIED",op);
   // From this point the Rust publisher is the sole mutation authority.
   // An unknown ACK fences this cargo from speculative reposting.
   published=true;
   const ack=await marketClient.call("PublishCorpSell",args);
   if(ack?.status!=="PUBLISHED_ORIGINAL_CORP_SELL"||
     ack.phase!=="OPEN"||ack.orderID!==orderID||
     ack.verifiedNative!==true||ack.verifiedGameStore!==true||
     ack.nativeMutation!==true)
     throw Error("CORP_SELL_PUBLISH_RUST_ACK_UNVERIFIED");
   try{observe("corp-mining-original-sell-published",{
     status:ack.status,corporationID,operationID,cargoID,itemID,orderID})}catch{}
   return {status:"CORPORATE_SELL_PUBLISHED",orderID,
     originalItemID:itemID,cargoID,corporationID,
     nativeMutation:true,marketOrderCreated:true,
     realizedRevenueCents:null,netProfitCents:null};
  }catch{
   if(published)uncertain.add(cargoID);
   return rejected("CORP_SELL_PUBLISH_RUST_OUTCOME_UNKNOWN",op);
  }finally{inFlight.delete(cargoID)}
 }
 return Object.freeze({prepareAndBind,publishPrepared,sourceOperation,
  inspectUncertain:()=>[...uncertain],
  supportsPreparedCorporatePublish:true,
  supportsNativeCorporatePublish:false,
  supportsNativeCorporateSettlement:false});
}
module.exports={createNativeCorporateSellBridge,sourceOperation};
