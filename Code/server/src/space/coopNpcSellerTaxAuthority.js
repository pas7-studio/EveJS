"use strict";
// COOP-051: seller sales tax uses *the existing* EveJS marketRules.
const valid=n=>Number.isSafeInteger(n)&&n>0;
function createNativeNpcSellerTaxQuote({getMarketContext,computeSalesTaxAmount}={}){
 if(typeof getMarketContext!=="function"||
    typeof computeSalesTaxAmount!=="function")
  throw Error("NPC_BUY_NATIVE_TAX_RULES_REQUIRED");
 return function quoteSellerTax({sellerID,stationID,grossCents}={}){
  if(!valid(sellerID)||!valid(stationID)||!valid(grossCents)||
     grossCents>100000000000)throw Error("NPC_BUY_TAX_IDENTITY_INVALID");
  // Same native seller context used in marketProxyService player sales.
  const context=getMarketContext({characterID:sellerID,stationID,session:null});
  const rate=context?.limits?.acc;
  if(context?.characterID!==sellerID||context?.stationID!==stationID||
     typeof rate!=="number"||!Number.isFinite(rate)||rate<0||rate>0.08)
   throw Error("NPC_BUY_TAX_CONTEXT_UNVERIFIED");
  const nativeTax=computeSalesTaxAmount(context,grossCents/100);
  if(typeof nativeTax!=="number"||!Number.isFinite(nativeTax)||
     nativeTax<0||nativeTax>grossCents/100)
   throw Error("NPC_BUY_TAX_QUOTE_INVALID");
  const taxCents=Math.round(nativeTax*100);
  if(!Number.isSafeInteger(taxCents)||taxCents<0||taxCents>grossCents||
     Math.abs(nativeTax*100-taxCents)>1e-7)
   throw Error("NPC_BUY_TAX_NOT_CENT_EXACT");
  return Object.freeze({sellerID,stationID,grossCents,taxCents,
   policy:"EVEJS_NATIVE_MARKET_RULES",rate});
 };
}
module.exports={createNativeNpcSellerTaxQuote};
