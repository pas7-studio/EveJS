"use strict";
// COOP-046 source-backed economic policies. PURE: no native wallet/item
// mutation, market RPC, fake demand, timer or independent A-Life scheduler.
const pos=n=>Number.isSafeInteger(n)&&n>0;
const nat=n=>Number.isSafeInteger(n)&&n>=0;
const money=n=>nat(n)&&n<=Number.MAX_SAFE_INTEGER;
const reject=reason=>Object.freeze({status:"BLOCKED",reason});
function planNpcNativePurchase({proof,ownerID,stationID,typeID,
 maxUnitPriceCents,maxSpendCents,maxQuantity=1000,minCashReserveCents=0}={}){
 if(proof?.authoritativeNative!==true||proof.ownerID!==ownerID||
    proof.stationID!==stationID||!pos(ownerID)||!pos(stationID)||!pos(typeID)||
    !money(proof.walletCents)||!nat(proof.targetStock)||!nat(proof.physicalOwned)||
    !nat(proof.incomingStock)||!nat(proof.outstandingBuys)||
    !money(maxUnitPriceCents)||!pos(maxUnitPriceCents)||!money(maxSpendCents)||
    !pos(maxSpendCents)||!pos(maxQuantity)||maxQuantity>50000||
    !money(minCashReserveCents)||!Array.isArray(proof.asks)||proof.asks.length>2000)
  return reject("NPC_BUY_NATIVE_EVIDENCE_INVALID");
 const needed=Math.max(0,proof.targetStock-proof.physicalOwned-
  proof.incomingStock-proof.outstandingBuys);
 if(!Number.isSafeInteger(needed))return reject("NPC_BUY_STOCK_OVERFLOW");
 if(needed===0)return Object.freeze({status:"ENOUGH_REAL_STOCK",quantity:0});
 const budget=Math.min(maxSpendCents,proof.walletCents-minCashReserveCents);
 if(budget<=0)return reject("NPC_BUY_NO_SPENDABLE_ISK");
 const orders=new Set();let tooLarge=false,hadAffordable=false;
 const candidates=[];
 for(const ask of proof.asks){
  if(!ask||ask.verifiedNative!==true||!pos(ask.orderID)||
     orders.has(ask.orderID)||ask.stationID!==stationID||
     ask.typeID!==typeID||!pos(ask.sellerOwnerID)||
     !pos(ask.remainingQuantity)||!money(ask.unitPriceCents)||
     !pos(ask.unitPriceCents)||ask.state!=="open")
   return reject("NPC_BUY_RUST_ASK_NOT_ATTESTED");
  orders.add(ask.orderID);
  if(ask.sellerOwnerID===ownerID)continue; // Never wash trade with own corp.
  if(ask.unitPriceCents>maxUnitPriceCents)continue;
  const cost=ask.unitPriceCents*ask.remainingQuantity;
  if(!money(cost))return reject("NPC_BUY_COST_OVERFLOW");
  if(cost>budget)continue;
  hadAffordable=true;
  // The current COOP-035 native Rust+GameStore path is whole-stack only.
  // Never send a partial claim before a proven atomic native splitter exists.
  if(ask.remainingQuantity>needed||ask.remainingQuantity>maxQuantity){
   tooLarge=true;continue;
  }
  candidates.push({...ask,cost});
 }
 if(!candidates.length)return reject(tooLarge?
  "NPC_BUY_PARTIAL_STACK_REQUIRES_ATOMIC_SPLITTER":
  hadAffordable?"NPC_BUY_QUANTITY_POLICY_BLOCKED":"NPC_BUY_NO_AFFORDABLE_NATIVE_ASK");
 candidates.sort((a,b)=>a.unitPriceCents-b.unitPriceCents||
   a.remainingQuantity-b.remainingQuantity||a.orderID-b.orderID);
 const best=candidates[0];
 return Object.freeze({status:"NATIVE_BUY_INTENT_ONLY",ownerID,stationID,typeID,
  orderID:best.orderID,sellerOwnerID:best.sellerOwnerID,
  quantity:best.remainingQuantity,totalCents:best.cost,
  budgetRemainingCents:budget-best.cost,authority:"RUST_ASK_AND_CORP_WALLET",
  supportsNativeMutation:false});
}
function suggestNativeAskPrice({ownerID,stationID,typeID,now,previousPriceCents,
 unitCostCents,feesCents=0,minMarginCents=0,minPriceCents=1,
 maxPriceCents=100000000,stockQuantity,targetStock,trades,maxChangeBps=1000}={}){
 if(!pos(ownerID)||!pos(stationID)||!pos(typeID)||!nat(now)||
  !pos(previousPriceCents)||!money(previousPriceCents)||
  !money(unitCostCents)||!money(feesCents)||!money(minMarginCents)||
  !pos(minPriceCents)||!money(maxPriceCents)||minPriceCents>maxPriceCents||
  !nat(stockQuantity)||!nat(targetStock)||targetStock>50000||
  !Array.isArray(trades)||trades.length>1000||!nat(maxChangeBps)||
  maxChangeBps>3000)
  return reject("NPC_PRICE_SOURCE_INVALID");
 const observed=[];
 for(const t of trades){
  if(!t||t.verifiedNative!==true||!pos(t.fillID)||!pos(t.quantity)||
   !pos(t.unitPriceCents)||!money(t.unitPriceCents)||!nat(t.at)||
   t.at>now||!pos(t.typeID)||!pos(t.stationID))
   return reject("NPC_PRICE_NATIVE_FILL_UNVERIFIED");
  if(t.typeID===typeID&&t.stationID===stationID&&now-t.at<=86400000)
   observed.push(t);
 }
 if(!observed.length)return reject("NPC_PRICE_NATIVE_TRADES_MISSING");
 if(new Set(observed.map(t=>t.fillID)).size!==observed.length)
  return reject("NPC_PRICE_NATIVE_FILL_REPLAY");
 const totalQty=observed.reduce((n,t)=>n+t.quantity,0);
 if(!pos(totalQty))return reject("NPC_PRICE_VOLUME_OVERFLOW");
 observed.sort((a,b)=>a.unitPriceCents-b.unitPriceCents||a.fillID-b.fillID);
 let medianPrice=observed[observed.length-1].unitPriceCents,cumulative=0;
 for(const t of observed){cumulative+=t.quantity;
  if(cumulative*2>=totalQty){medianPrice=t.unitPriceCents;break;}}
 const scarcity=targetStock===0?0:Math.max(-1000,Math.min(1000,
  Math.round((targetStock-stockQuantity)*1000/targetStock)));
 const marketTarget=Math.round(medianPrice*(10000+scarcity)/10000);
 const floor=Math.max(minPriceCents,unitCostCents+feesCents+minMarginCents);
 if(!money(floor)||floor>maxPriceCents)return reject("NPC_PRICE_NOT_PROFITABLE");
 const step=Math.floor(previousPriceCents*maxChangeBps/10000);
 const low=Math.max(minPriceCents,previousPriceCents-step);
 const high=Math.min(maxPriceCents,previousPriceCents+step);
 if(floor>high)return reject("NPC_PRICE_MARGIN_EXCEEDS_SAFE_CHANGE");
 const priceCents=Math.max(floor,Math.max(low,Math.min(high,marketTarget)));
 if(!money(priceCents)||priceCents>maxPriceCents)
  return reject("NPC_PRICE_NATIVE_QUOTE_OUT_OF_RANGE");
 return Object.freeze({status:"NATIVE_ASK_PRICE_INTENT_ONLY",priceCents,
  medianPriceCents:medianPrice,tradedQuantity:totalQty,
  profitFloorCents:floor,supportsNativeMutation:false});
}
function decideNpcSolvency({proof,reserveCents=0}={}){
 if(proof?.authoritativeNative!==true||!pos(proof.ownerID)||
  !pos(proof.stationID)||!money(proof.walletCents)||!money(reserveCents)||
  !nat(proof.unlistedOutput)||!nat(proof.readyJobs)||
  !nat(proof.openSellQuantity)||!nat(proof.activeJobs))
  return reject("NPC_SOLVENCY_NATIVE_PROOF_INVALID");
 if(proof.unlistedOutput>0)return {status:"SELL_FINISHED_NATIVE_STOCK",spendISK:false};
 if(proof.readyJobs>0)return {status:"DELIVER_ALREADY_PAID_JOB",spendISK:false};
 if(proof.walletCents<=reserveCents&&proof.openSellQuantity>0)
  return {status:"WAIT_FOR_VERIFIED_RUST_BUYER",spendISK:false};
 if(proof.walletCents<=reserveCents)
  return {status:"INSOLVENT_NO_MONEY_MINT",spendISK:false};
 return {status:"NORMAL_BUDGETED_OPERATIONS",spendISK:true,
  usableCents:proof.walletCents-reserveCents};
}
function chooseNativeRegionalProduct({ownerID,stationID,regionID,quotes,maxBatch=1000}={}){
 if(!pos(ownerID)||!pos(stationID)||!pos(regionID)||
    !pos(maxBatch)||maxBatch>50000||!Array.isArray(quotes)||quotes.length>8)
  return reject("NPC_REGION_NATIVE_PROOF_INVALID");
 const ids=new Set(),choices=[];
 for(const q of quotes){
  if(!q||q.authoritativeNative!==true||q.ownerID!==ownerID||
    q.stationID!==stationID||q.regionID!==regionID||
    !pos(q.typeID)||ids.has(q.typeID)||typeof q.hasOriginalBPO!=="boolean"||
    typeof q.factoryOnline!=="boolean"||!pos(q.outputQuantity)||
    !nat(q.actualBuyerVolume)||!nat(q.realShortage)||
    !money(q.marketUnitPriceCents)||!money(q.materialsCostCents)||
    !money(q.industryFeeCents)||!money(q.shippingCostCents))
   return reject("NPC_REGION_PRODUCT_AUTHORITY_CONFLICT");
  ids.add(q.typeID);
  if(!q.hasOriginalBPO||!q.factoryOnline||!q.actualBuyerVolume||
    !q.realShortage||q.outputQuantity>maxBatch)continue;
  const expectedSales=Math.min(q.outputQuantity,q.actualBuyerVolume,q.realShortage);
  const expectedGross=q.marketUnitPriceCents*expectedSales;
  const allCosts=q.materialsCostCents+q.industryFeeCents+q.shippingCostCents;
  if(!money(expectedGross)||!money(allCosts))return reject("NPC_REGION_MARGIN_OVERFLOW");
  const margin=expectedGross-allCosts;
  if(margin>0)choices.push({typeID:q.typeID,marginCents:margin,
   expectedSales,regionID});
 }
 if(!choices.length)return {status:"NO_PROVEN_PROFITABLE_REGIONAL_PRODUCT"};
 choices.sort((a,b)=>b.marginCents-a.marginCents||
   b.expectedSales-a.expectedSales||a.typeID-b.typeID);
 return Object.freeze({status:"NATIVE_REGIONAL_PRODUCT_INTENT_ONLY",
  ...choices[0],supportsNativeMutation:false});
}
module.exports={planNpcNativePurchase,suggestNativeAskPrice,decideNpcSolvency,
 chooseNativeRegionalProduct};
