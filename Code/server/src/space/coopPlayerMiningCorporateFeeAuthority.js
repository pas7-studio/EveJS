"use strict";
/**
 * CH24+31: exact ORIGINAL EveJS marketRules fee quote, server-only.
 * A corporation SELL is priced using its authenticated original
 * human representative stored DURABLY at corporate escrow creation.
 *
 * This policy collects broker fee on each successful CORPORATE fill rather
 * than at order placement. It is a deliberate source-backed corporate fee
 * schedule and must not be presented as stock personal-order fee timing.
 */
const pos=n=>Number.isSafeInteger(n)&&n>0;
const cents=v=>{
 const x=Number(v)*100,y=Math.round(x);
 return typeof v==="number"&&Number.isFinite(x)&&Number.isSafeInteger(y)&&
  Math.abs(x-y)<=1e-6?y:null;
};
function createCorporateMarketFeeAuthority({
 gameStore,getMarketContext,computeSalesTaxAmount,computeBrokerFeeInfo,
 getCharacterRecord,enabled=()=>false
}={}){
 if(typeof gameStore?.read!=="function"||
  [getMarketContext,computeSalesTaxAmount,computeBrokerFeeInfo,
   getCharacterRecord,enabled].some(x=>typeof x!=="function"))
  throw Error("CORP_MARKET_FEE_ORIGINAL_NATIVE_RULES_REQUIRED");
 function quoteNativeFees({claim,grossCents}={}){
  if(enabled()!==true)throw Error("CORP_MARKET_FEE_RULES_DISABLED");
  const seller=claim?.sellerCorpID,rep=claim?.sellerRepresentativeCharacterID;
  // The original Rust claim uses corporationID and physical cargoID,
  // while the representative identity is read ONLY from GameStore source.
  if(!pos(seller)||!pos(claim?.cargoID)||!pos(claim.stationID)||
   !pos(grossCents)||grossCents>100000000000)
   throw Error("CORP_MARKET_FEE_SCOPE_INVALID");
  const r=gameStore.read("corporationRuntime",
   "/coopPlayerMiningCorpSell/"+claim.cargoID);
  if(r?.success!==true||!r.data)
   throw Error("CORP_MARKET_FEE_ORIGINAL_ESCROW_RECEIPT_MISSING");
  const receipt=r.data,characterID=receipt.sellerRepresentativeCharacterID;
  if(receipt.corporationID!==seller||receipt.cargoID!==claim.cargoID||
   receipt.itemID!==claim.sourceItemID||
   receipt.stationID!==claim.stationID||
   receipt.orderID!==claim.orderID||
   !pos(characterID)||rep!=null&&rep!==characterID)
   throw Error("CORP_MARKET_FEE_SOURCE_IDENTITY_CHANGED");
  const character=getCharacterRecord(characterID);
  if(!character||character.corporationID!==seller||
   character.characterID!=null&&character.characterID!==characterID)
   throw Error("CORP_MARKET_FEE_REPRESENTATIVE_NO_LONGER_MEMBER");
  const context=getMarketContext({characterID,stationID:claim.stationID,
   session:null});
  const taxRate=context?.limits?.acc,
   brokerRate=context?.brokerCommissionRate;
  if(context?.characterID!==characterID||
   context.stationID!==claim.stationID||
   typeof taxRate!=="number"||!Number.isFinite(taxRate)||
   taxRate<0||taxRate>0.2||
   typeof brokerRate!=="number"||!Number.isFinite(brokerRate)||
   brokerRate<0||brokerRate>0.2)
   throw Error("CORP_MARKET_FEE_NATIVE_CONTEXT_INVALID");
  const grossISK=grossCents/100;
  const transactionTax=computeSalesTaxAmount(context,grossISK);
  const broker=computeBrokerFeeInfo(context,null,grossISK)?.amount;
  const transactionTaxCents=cents(transactionTax),
   brokerFeeCents=cents(broker);
  if(transactionTaxCents===null||brokerFeeCents===null||
   transactionTaxCents<0||brokerFeeCents<0||
   transactionTaxCents+brokerFeeCents>grossCents)
   throw Error("CORP_MARKET_FEE_NATIVE_RULES_NOT_CENT_EXACT");
  return Object.freeze({verifiedNative:true,
   feePolicy:"EVEJS_NATIVE_MARKET_RULES_CORP_FILL",
   representativeCharacterID:characterID,
   sellerCorpID:seller,
   transactionTaxCents,brokerFeeCents});
 }
 return Object.freeze({quoteNativeFees,
  mode:"CORP_MARKET_REAL_RULES_REPRESENTATIVE_BOUND"});
}
module.exports={createCorporateMarketFeeAuthority,cents};
