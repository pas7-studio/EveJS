"use strict";
/**
 * CH24+31: private native EveJS MarketProxy corporate mining bridge.
 * Reuses ORIGINAL marketDaemonClient, marketRules, GameStore, native session,
 * original corporate wallet, station and item/ore provenance. NO shadow ISK,
 * items, scheduler, accounts, or direct client-to-Rust token.
 */
const ext=__filename.endsWith(".cjs")?".cjs":"";
const load=n=>require("./"+n+ext);
const safe=n=>Number.isSafeInteger(n)&&n>0;
const cents=n=>{
 const v=n*100,out=Math.round(v);
 return typeof n==="number"&&Number.isFinite(v)&&safe(out)&&
   Math.abs(out-v)<1e-6?out:null;
};
const enabled=()=>[
 "EVEJS_COOP_PLAYER_NPC_MINING_CORP_PUBLIC_MARKET",
 "EVEJS_COOP_NATIVE_ATOMIC_ROWS",
 "EVEJS_COOP_PLAYER_NPC_MINING_COMPANY",
 "EVEJS_COOP_PLAYER_NPC_MINING_MARKET_READ",
 "EVEJS_COOP_PLAYER_NPC_MINING_CORP_SELL_ESCROW",
 "EVEJS_COOP_PLAYER_NPC_MINING_CORP_FILL",
 "EVEJS_COOP_PLAYER_NPC_MINING_CORP_FILL_LIFECYCLE",
 "EVEJS_COOP_PLAYER_NPC_MINING_CORP_BUYER_MATCH",
 "EVEJS_COOP_PLAYER_NPC_MINING_CORP_FEE_RULES"
].every(k=>process.env[k]==="1");
const blocked=r=>({status:"BLOCKED",reason:r});
function createCorporateMarketRuntime({
 gameStore,marketClient,access,readiness,
 getActiveSessions,getDockedLocationID,
 getCharacterRecord,findOriginalItemById,getMarketContext,
 computeSalesTaxAmount,computeBrokerFeeInfo,notifyPurchasedItem=()=>{},
 token,enabledFn=enabled,pnlEnabled=()=>false
}={}){
 const deps=[gameStore?.read,marketClient?.call,
  access?.isMember,access?.canIndustry,access?.canWallet,access?.canTake,
  readiness?.inspect,getActiveSessions,getDockedLocationID,
  getCharacterRecord,findOriginalItemById,getMarketContext,
  computeSalesTaxAmount,computeBrokerFeeInfo,notifyPurchasedItem,
  enabledFn,pnlEnabled];
 if(deps.some(x=>typeof x!=="function")||
  typeof token!=="string"||token.length<32||token.length>256)
  throw Error("CORP_MARKET_NATIVE_SOURCE_BINDINGS_MISSING");
 const fees=load("coopPlayerMiningCorporateFeeAuthority")
   .createCorporateMarketFeeAuthority({gameStore,getMarketContext,
     computeSalesTaxAmount,computeBrokerFeeInfo,getCharacterRecord,
     enabled:enabledFn});
 const quotePricePins=new WeakMap();
 const bridge=load("coopPlayerMiningCorporateSellBridge")
   .createNativeCorporateSellBridge({
    marketClient,gameStore,access,readiness,token,
    enabled:enabledFn,publishEnabled:enabledFn,
    quotePrice:({session,cargoID,ore})=>{
     const pin=quotePricePins.get(session);
     return pin?.cargoID===cargoID&&pin.itemID===ore.itemID?pin.priceCents:null;
    }
   });
 const readSale=(cargoID)=>gameStore.read("corporationRuntime",
  "/coopPlayerMiningCorpSell/"+cargoID);
 const readNextFillCycle=({orderID,corporationID,cargoID,sourceItemID})=>{
  const x=readSale(cargoID);
  const row=x?.success===true?x.data:null;
  return row?.orderID===orderID&&row.corporationID===corporationID&&
   row.itemID===sourceItemID&&
   ["ESCROW_BOUND_UNSETTLED","ACTIVE_SELL"].includes(row.phase)&&
   Number.isSafeInteger(row.lastSettledCycle??0)?
    (row.lastSettledCycle??0)+1:0;
 };
 const buyer=load("coopPlayerMiningCorporateBuyerMatch")
   .createNativeCorporateBuyerMatch({
     marketClient,getActiveSessions,
     isDockedAtMarket:(session,stationID)=>
       getDockedLocationID(session)===stationID,
     readNextFillCycle,token,enabled:enabledFn
   });
 const settlement=load("coopPlayerMiningCorporateFillSettlement")
   .createCorporateSellFillSettlement({
    gameStore,enabled:enabledFn,
    readNativeClaim:({orderID,cycle})=>marketClient.call("GetCorpFillClaim",{
      access_token:token,order_id:orderID,cycle}),
    quoteNativeFees:({claim,grossCents})=>
      fees.quoteNativeFees({claim,grossCents})
   });
 const lifecycle=load("coopPlayerMiningCorporateFillLifecycle")
   .createCorporateFillLifecycle({
    marketClient,getTrustedMatch:buyer.getTrustedMatch,
    settlement,token,enabled:enabledFn
   });
 const pnl=load("coopPlayerMiningCorporatePnl")
   .createMiningCorporatePnl({
    gameStore,access,findOriginalItemById,enabled:pnlEnabled,
    readNativeReleased:({orderID,cycle})=>
      marketClient.call("GetCorpFillClaim",{
        access_token:token,order_id:orderID,cycle})
   });
 const active=(session)=>safe(session?.characterID)&&
   session.socket?.destroyed!==true&&
   getActiveSessions().filter(s=>s===session).length===1;
 async function sellFromEntries({session,itemList,durationDays}={}){
  if(!enabledFn())return blocked("CORP_MARKET_OFF");
  if(!active(session)||!safe(session.corporationID)||
    !Array.isArray(itemList)||itemList.length!==1||
    !safe(durationDays)||durationDays>90)
   return blocked("CORP_MARKET_SELL_SCOPE_INVALID");
  const e=itemList[0],itemID=Number(e?.itemID),quantity=Number(e?.quantity),
   priceCents=cents(e?.price);
  if(!safe(itemID)||!safe(quantity)||!safe(priceCents)||
    priceCents>100000000||!safe(e?.typeID))
   return blocked("CORP_MARKET_ORIGINAL_SELL_ITEM_OR_PRICE_INVALID");
  if(access.isMember(session,session.corporationID)!==true||
   access.canIndustry(session,session.corporationID)!==true||
   access.canWallet(session,session.corporationID,1000)!==true)
   return blocked("CORP_MARKET_SELL_ROLE_DENIED");
  let titles;
  try{
   const r=gameStore.read("corporationRuntime","/coopPlayerMiningOreTitle");
   titles=r?.success===true?Object.values(r.data):[];
  }catch{return blocked("CORP_MARKET_TITLE_READ_UNAVAILABLE")}
  if(!Array.isArray(titles)||titles.length>10000)
   return blocked("CORP_MARKET_TITLE_INDEX_INVALID");
  const rows=titles.filter(r=>r?.status==="COMMITTED"&&
    r.itemID===itemID&&r.quantity===quantity&&
    r.typeID===e.typeID&&r.buyerCorpID===session.corporationID&&
    r.stationID===getDockedLocationID(session));
  if(rows.length!==1)return blocked("CORP_MARKET_ORIGINAL_TITLE_NOT_UNIQUE");
  const title=rows[0];
  if(!safe(title.cargoID)||typeof title.shiftID!=="string"||
    !/^coop-mining-shift:[a-f0-9]{32}$/.test(title.shiftID))
   return blocked("CORP_MARKET_ORIGINAL_TITLE_INVALID");
  if(quotePricePins.has(session))
   return blocked("CORP_MARKET_SELL_ALREADY_IN_FLIGHT");
  quotePricePins.set(session,{cargoID:title.cargoID,itemID,priceCents});
  try{
   const prepared=await bridge.prepareAndBind({session,
    corporationID:session.corporationID,operationID:title.shiftID,
    cargoID:title.cargoID});
   if(prepared?.status!=="ESCROW_PROVEN_NOT_PUBLISHED")
    return prepared||blocked("CORP_MARKET_PREPARE_NOT_COMMITTED");
   return await bridge.publishPrepared({session,
     corporationID:session.corporationID,
     operationID:title.shiftID,cargoID:title.cargoID,
     itemID,priceCents,orderID:prepared.orderID});
  }finally{quotePricePins.delete(session)}
 }
 async function buyFromOrder({session,sellOrder,quantity,maxUnitPriceCents}={}){
  if(!enabledFn())return blocked("CORP_MARKET_OFF");
  if(!active(session)||!safe(quantity)||
    String(sellOrder?.source)!=="coop-corporation"||
    sellOrder?.is_corp!==true||
    !safe(maxUnitPriceCents)||!safe(sellOrder?.station_id))
   return blocked("CORP_MARKET_BUY_UNTRUSTED_ORDER_OR_SESSION");
  const orderID=String(sellOrder.order_id),
   unitPrice=cents(sellOrder.price);
  if(!safe(unitPrice)||unitPrice>maxUnitPriceCents||
    getDockedLocationID(session)!==sellOrder.station_id)
   return blocked("CORP_MARKET_BUY_PRICE_OR_DOCKING_CHANGED");
  const quote=await buyer.quote({session,orderID,quantity,
   maxUnitPriceCents});
  if(quote?.status!=="ELIGIBLE_NOT_RESERVED")
   return quote||blocked("CORP_MARKET_BUY_RUST_QUOTE_INVALID");
  const result=await lifecycle.processVerifiedMatch({orderID,
   cycle:quote.cycle});
  if(result?.status!=="CORP_SELL_FILL_RELEASED")
   return result||blocked("CORP_MARKET_BUY_NOT_RELEASED");
  // Post-COMMIT client inventory notification is best-effort. Its failure
  // must never undo a real paid fill or trigger a second buyer debit.
  try{
   const item=findOriginalItemById(result.deliveredItemID);
   if(item?.ownerID===result.buyerCharacterID&&
      item.locationID===result.stationID&&
      item.itemID===result.deliveredItemID)
    notifyPurchasedItem(result.buyerCharacterID,item,{
      ownerID:result.sellerCorpID,locationID:9200000000+Number(orderID),
      flagID:4,quantity:result.filledQuantity,
      stacksize:result.filledQuantity
    });
  }catch{}
  return result;
 }
 return Object.freeze({sellFromEntries,buyFromOrder,
  pnlReport:params=>pnl.inspect(params),
  inspectUncertain:()=>({
    publish:bridge.inspectUncertain(),
    fill:lifecycle.requiresOperatorReconciliation()
  }),
  mode:"ORIGINAL_CORPORATE_MARKET_NATIVE_UI_GATED"});
}
let singleton=null;
function native(){
 if(singleton)return singleton;
 const gameStore=require("../gameStore");
 const market=require("../services/market/marketDaemonClient");
 const marketRules=require("../services/market/marketRules");
 const char=require("../services/character/characterState");
 const itemStore=require("../services/inventory/itemStore");
 const notifications=require("../services/raffles/raffleInventory");
 const access=require("./coopPlayerCorporationAccess");
 const readiness=require("./coopPlayerMiningMarketReadiness");
 const sessions=require("../services/chat/sessionRegistry");
 const location=require("../services/structure/structureLocation");
 const token=process.env.EVEJS_COOP_RUST_CORP_SELL_TOKEN;
 singleton=createCorporateMarketRuntime({
  gameStore,marketClient:market.marketDaemonClient,access,
  readiness:{inspect:input=>readiness.inspectCargoNative({
    ...input,cargoID:input.cargoIDs?.[0]})},
  getActiveSessions:sessions.getSessions,
  getDockedLocationID:location.getDockedLocationID,
  getCharacterRecord:char.getCharacterRecord,
  findOriginalItemById:itemStore.findItemById,
  notifyPurchasedItem:(buyerID,item,previousData)=>
    notifications.notifyInventoryChangesToCharacter(buyerID,[{item,previousData}]),
  getMarketContext:marketRules.getMarketContext,
  computeSalesTaxAmount:marketRules.computeSalesTaxAmount,
  computeBrokerFeeInfo:marketRules.computeBrokerFeeInfo,
  token,enabledFn:enabled,
  pnlEnabled:()=>process.env.EVEJS_COOP_PLAYER_NPC_MINING_PNL==="1"
 });
 return singleton;
}
async function sellFromEntries(args){
 if(!enabled())return blocked("CORP_MARKET_OFF");
 try{return await native().sellFromEntries(args)}
 catch{return blocked("CORP_MARKET_NATIVE_SELL_UNAVAILABLE")}
}
async function buyFromOrder(args){
 if(!enabled())return blocked("CORP_MARKET_OFF");
 try{return await native().buyFromOrder(args)}
 catch{return blocked("CORP_MARKET_NATIVE_BUY_UNAVAILABLE")}
}
async function pnlReport(args){
 if(process.env.EVEJS_COOP_PLAYER_NPC_MINING_PNL!=="1")
  return blocked("CORP_PNL_OFF");
 try{return await native().pnlReport(args)}
 catch{return blocked("CORP_PNL_NATIVE_READ_UNAVAILABLE")}
}
module.exports={createCorporateMarketRuntime,sellFromEntries,buyFromOrder,
 pnlReport,enabled};
