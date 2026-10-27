"use strict";
/**
 * E2B6 trusted buyer candidate (NOT a reserved order or a fill).
 * The buyer ID comes from the original authenticated live session, not
 * client input. Original Rust independently checks actual buyer wallet,
 * seller order, corporate physical escrow and exact original item identity.
 * One-use source candidate is re-attested before ClaimCorpFill.
 */
const positive=n=>Number.isSafeInteger(n)&&n>0;
const ORDER=/^[1-9][0-9]{0,17}$/;
const safeOrder=id=>typeof id==="string"&&ORDER.test(id)&&
 BigInt(id)+9200000000n<=BigInt(Number.MAX_SAFE_INTEGER);
const goodSource=q=>q?.verifiedNative===true&&
 q.status==="ELIGIBLE_NOT_RESERVED"&&
 q.source==="coop-corporation"&&q.is_corp===true&&q.bid===false&&
 q.nativeMutation===false&&q.buyerFundsReserved===false;
function createNativeCorporateBuyerMatch({
 marketClient,getActiveSessions,isDockedAtMarket,readNextFillCycle,
 token,enabled=()=>process.env.EVEJS_COOP_PLAYER_NPC_MINING_CORP_BUYER_MATCH==="1",clock=()=>Date.now(),ttlMs=30000
}={}){
 if(typeof marketClient?.call!=="function"||
  [getActiveSessions,isDockedAtMarket,readNextFillCycle,enabled,clock]
  .some(x=>typeof x!=="function")||
  typeof token!=="string"||token.length<32||token.length>256||
  !positive(ttlMs)||ttlMs>120000)
  throw Error("CORP_BUYER_MATCH_ORIGINAL_AUTHORITIES_REQUIRED");
 const pins=new Map(),fenced=new Set();
 const denied=reason=>({status:"BLOCKED",reason,nativeMutation:false,
  buyerFundsReserved:false,marketOrderPlaced:false});
 const scope=(session,orderID)=>{
  const current=getActiveSessions();
  return safeOrder(orderID)&&session&&
   Array.isArray(current)&&current.includes(session)&&
   positive(session.characterID)&&
   session.socket?.destroyed!==true;
 };
 const attest=(q,session,orderID,qty,maxPrice)=>{
  if(!goodSource(q)||q.orderID!==orderID||
   q.buyerCharacterID!==session.characterID||
   !positive(q.sellerCorpID)||!positive(q.cargoID)||
   !positive(q.sourceItemID)||!positive(q.stationID)||!positive(q.typeID)||
   q.sellerCorpID===session.characterID||
   q.quantity!==qty||!positive(q.volumeBefore)||q.volumeBefore<qty||
   !positive(q.priceCents)||q.priceCents>maxPrice||
   !Number.isSafeInteger(q.buyerWalletCentsAtQuote))return false;
  const gross=q.priceCents*qty;
  return positive(gross)&&q.grossCents===gross&&
   q.buyerWalletCentsAtQuote>=gross;
 };
 async function quote({session,orderID,quantity,maxUnitPriceCents}={}){
  if(enabled()!==true)return denied("CORP_BUYER_MATCH_DISABLED");
  if(!scope(session,orderID)||!positive(quantity)||
   !positive(maxUnitPriceCents)||maxUnitPriceCents>100000000||
   fenced.has(orderID))return denied("CORP_BUYER_SCOPE_INVALID_OR_UNCERTAIN");
  let q,cycle;
  try{
   q=await marketClient.call("GetCorpBuyerQuote",{
    access_token:token,order_id:orderID,buyer_id:session.characterID,
    quantity,max_price_cents:maxUnitPriceCents
   });
   if(!attest(q,session,orderID,quantity,maxUnitPriceCents)||
     isDockedAtMarket(session,q.stationID)!==true)
    return denied("CORP_BUYER_RUST_FUNDS_OR_STATION_UNVERIFIED");
   cycle=readNextFillCycle({orderID,corporationID:q.sellerCorpID,
     cargoID:q.cargoID,sourceItemID:q.sourceItemID});
   if(!positive(cycle))return denied("CORP_BUYER_ORIGINAL_CYCLE_UNVERIFIED");
  }catch{return denied("CORP_BUYER_ORIGINAL_QUOTE_UNAVAILABLE")}
  const now=clock(),key=orderID+":"+cycle;
  if(!positive(now))return denied("CORP_BUYER_QUOTE_CLOCK_INVALID");
  const current=pins.get(key);
  if(current&&current.expiresAt>now)return denied("CORP_BUYER_ORDER_ALREADY_QUOTED");
  pins.set(key,{session,orderID,cycle,quantity,maxUnitPriceCents,
   initial:q,expiresAt:now+ttlMs});
  return {status:"ELIGIBLE_NOT_RESERVED",orderID,cycle,
   verifiedUnitPriceCents:q.priceCents,grossCents:q.grossCents,
   availableQuantity:q.volumeBefore,
   expiresAt:now+ttlMs,buyerFundsReserved:false,
   marketOrderPlaced:false,nativeMutation:false};
 }
 async function getTrustedMatch({orderID,cycle}={}){
  if(enabled()!==true||!safeOrder(orderID)||!positive(cycle)||
    fenced.has(orderID))return null;
  const key=orderID+":"+cycle,pin=pins.get(key);
  if(!pin)return null;
  pins.delete(key); // one-shot before any native Rust request
  if(!scope(pin.session,orderID)||clock()>pin.expiresAt)return null;
  let q;
  try{
   q=await marketClient.call("GetCorpBuyerQuote",{
    access_token:token,order_id:orderID,buyer_id:pin.session.characterID,
    quantity:pin.quantity,max_price_cents:pin.maxUnitPriceCents
   });
   if(!attest(q,pin.session,orderID,pin.quantity,pin.maxUnitPriceCents)||
      isDockedAtMarket(pin.session,q.stationID)!==true||
      readNextFillCycle({orderID,corporationID:q.sellerCorpID,
       cargoID:q.cargoID,sourceItemID:q.sourceItemID})!==cycle||
      q.buyerCharacterID!==pin.initial.buyerCharacterID||
      q.sellerCorpID!==pin.initial.sellerCorpID||
      q.cargoID!==pin.initial.cargoID||q.sourceItemID!==pin.initial.sourceItemID||
      q.typeID!==pin.initial.typeID||q.stationID!==pin.initial.stationID||
      q.priceCents!==pin.initial.priceCents)
    return null;
  }catch{fenced.add(orderID);return null}
  return {verifiedNative:true,source:"coop-corporation",
   is_corp:true,bid:false,orderID,cycle,
   buyerCharacterID:pin.session.characterID,
   sellerCorpID:q.sellerCorpID,volumeBefore:q.volumeBefore,
   quantity:q.quantity,priceCents:q.priceCents};
 }
 return Object.freeze({quote,getTrustedMatch,
  requiresOperatorReconciliation:()=>[...fenced],
  supportsLiveBuyerMatching:false,mode:"READ_ONLY_PRIVATE_NATIVE_BUYER_CANDIDATE"});
}
module.exports={createNativeCorporateBuyerMatch};
