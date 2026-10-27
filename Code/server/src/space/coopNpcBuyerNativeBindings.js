"use strict";
// COOP-049: native read/adapt only; delegates every paid write to COOP-048.
// No NPC session impersonation, virtual wallet, synthetic cargo, or new timer.
const {createNpcCorporateBuyer}=require("./coopNpcCorporateBuyerAtomic"+(typeof __filename==="string"&&__filename.endsWith(".js")?"":".cjs"));
const {createNpcBuyerCoordinator}=require("./coopNpcBuyerCoordinator"+(typeof __filename==="string"&&__filename.endsWith(".js")?"":".cjs"));
const {verifyNativeBookAsk,normalizeNativeOrderForCoordinator}=require("./coopNpcRustOrderAuthority"+(typeof __filename==="string"&&__filename.endsWith(".js")?"":".cjs"));
const {createNativeNpcSellerTaxQuote}=require("./coopNpcSellerTaxAuthority"+(typeof __filename==="string"&&__filename.endsWith(".js")?"":".cjs"));
const {auditNativeNpcBuyerRecovery}=require("./coopNpcBuyerRecoveryAudit"+(typeof __filename==="string"&&__filename.endsWith(".js")?"":".cjs"));
const {createNpcMarketCompletionNotifier}=require("./coopNpcMarketCompletionNotify"+(typeof __filename==="string"&&__filename.endsWith(".js")?"":".cjs"));
const fs=require("node:fs");
const pos=x=>Number.isSafeInteger(x)&&x>0;
const count=x=>Number.isSafeInteger(x)&&x>=0;
// Match the authoritative COOP-048 atomic wallet. An existing wallet with
// fractional cents is NOT spendable and must not acquire a Rust claim.
const cents=x=>{
 if(typeof x!=="number"||!Number.isFinite(x)||x<0)return null;
 const scaled=x*100,whole=Math.round(scaled);
 return Number.isSafeInteger(whole)&&Math.abs(scaled-whole)<=1e-6?
  whole:null;
};
function createNativeNpcBuyerBindings({gameStore,itemStore,marketClient,
 getStation,resolveActor,readNeeds,file,marketRules,
 authorizeRecoveryOperator=null,marketNotifier=null,
 clock=()=>Date.now(),env=process.env}={}){
 if(typeof gameStore?.read!=="function"||
    typeof gameStore?.coopAtomicNativeRows?.transact!=="function"||
    typeof itemStore?.listOwnedItems!=="function"||
    typeof itemStore?.findItemById!=="function"||
    typeof marketClient?.call!=="function"||
    [getStation,resolveActor,readNeeds,clock].some(x=>typeof x!=="function"))
  throw Error("ALIFE_NATIVE_BUYER_AUTHORITIES_REQUIRED");
 const read=(table,key)=>{
  const result=gameStore.read(table,key);
  if(result?.success!==true||result.data==null)
   throw Error("ALIFE_BUYER_NATIVE_READ_MISSING:"+table);
  return result.data;
 };
 function corp(id){
  const record=read("corporations","/records/"+id);
  const runtime=read("corporationRuntime","/corporations/"+id);
  if(record?.corporationID!==id||record.isNPC!==true||
     runtime?.corporationID!==id||cents(runtime?.wallet?.divisions?.["1000"]?.balance)===null)
   throw Error("ALIFE_BUYER_NATIVE_CORPORATION_NOT_VERIFIED");
  return {record,runtime,walletCents:cents(runtime.wallet.divisions["1000"].balance)};
 }
 function verifyCorp(id,stationID){
  try{
   const s=getStation(stationID);
   if(!pos(id)||!pos(stationID)||s?.stationID!==stationID)return false;
   corp(id);return true;
  }catch{return false}
 }
 function verifySeller(id,stationID){
  try{
   if(!pos(id)||!pos(stationID))return false;
   const s=read("characters","/"+id);
   // The original native GameStore key and verified Rust seller escrow
   // bind this record. Vanilla characterState may omit embedded IDs.
   const embedded=s?.characterID??s?.charID;
   return Boolean(s&&
     (embedded===undefined||embedded===null||Number(embedded)===id)&&
     cents(s.balance)!==null&&Array.isArray(s.walletJournal)&&
     Array.isArray(s.marketTransactions));
  }catch{return false}
 }
 const market={
  claimOnce:({claimKey,orderID,buyerCorpID,sellerID,quantity})=>
   marketClient.call("ClaimNpcCorpPlayerSell",{
    claim_key:claimKey,order_id:String(orderID),buyer_corp_id:String(buyerCorpID),
    seller_id:String(sellerID),quantity:String(quantity)}),
  finalizeOnce:({claimKey,orderID,buyerCorpID,fillID})=>
   marketClient.call("FinalizeNpcCorpPlayerSell",{
    claim_key:claimKey,order_id:String(orderID),buyer_corp_id:String(buyerCorpID),
    fill_id:String(fillID)}),
  inspectClaim:({claimKey})=>marketClient.call("GetNpcCorpPlayerClaim",{
   claim_key:claimKey})
 };
 // Exact native market tax from EveJS (skills + location discounts).
 // Only a validated native context authorizes seller net proceeds.
 const rules=marketRules||require("../services/market/marketRules");
 const quoteSellerTax=createNativeNpcSellerTaxQuote({
  getMarketContext:rules?.getMarketContext,
  computeSalesTaxAmount:rules?.computeSalesTaxAmount});
 const buyer=createNpcCorporateBuyer({gameStore:gameStore.coopAtomicNativeRows,
  market,verifyBuyerCorporation:verifyCorp,verifyPlayerSeller:verifySeller,
  quoteSellerTax,clock});
 const actor=id=>resolveActor(id);
 async function readProof(ownerID,stationID,typeID){
  const station=getStation(stationID);
  const proof=readNeeds(ownerID,stationID,typeID);
  if(station?.stationID!==stationID||!pos(station.regionID)||
     !proof||proof.authoritativeNative!==true||
     proof.ownerID!==ownerID||proof.stationID!==stationID||
     proof.typeID!==typeID||!pos(proof.required)||!count(proof.available)||
     !count(proof.shortage)||proof.shortage!==Math.max(0,proof.required-proof.available)||
     !count(proof.observedAt)||clock()<proof.observedAt||
     clock()-proof.observedAt>30000||proof.required>50000)
   throw Error("ALIFE_BUYER_NATIVE_SDE_DEFICIT_NOT_VERIFIED");
  const owner=corp(ownerID),items=itemStore.listOwnedItems(ownerID);
  if(!Array.isArray(items)||items.length>10000)throw Error("ALIFE_BUYER_NATIVE_ITEMS_UNAVAILABLE");
  let physicalOwned=0;const ids=new Set();
  const itemProof=items.map(i=>{
   if(!pos(i?.itemID)||ids.has(i.itemID)||i.ownerID!==ownerID||
      !pos(i.typeID)||!count(i.quantity??i.stacksize))
    throw Error("ALIFE_BUYER_NATIVE_ITEM_CUSTODY_CONFLICT");
   ids.add(i.itemID);
   if(i.typeID===typeID&&i.locationID===stationID&&[4,115].includes(i.flagID)){
    physicalOwned+=i.quantity??i.stacksize;
    if(!count(physicalOwned))throw Error("ALIFE_BUYER_STOCK_OVERFLOW");
   }
   return [i.itemID,i.ownerID,i.locationID,i.flagID,i.typeID,i.quantity??i.stacksize];
  }).sort((a,b)=>a[0]-b[0]);
  if(physicalOwned!==proof.available)
   throw Error("ALIFE_BUYER_MATERIAL_SHORTAGE_STALE");
  const result=await marketClient.call("GetOrders",{
   region_id:station.regionID,type_id:typeID});
  if(!result||!Array.isArray(result.sells)||result.sells.length>2000)
   throw Error("ALIFE_BUYER_NATIVE_RUST_BOOK_MISSING");
  // Global per-proof RPC budget: GetOrders is a public/ownerless book and
  // GetOrder requires an additional authoritative network round-trip.
  // Never fan out thousands of owner lookups in a 30-second A-Life tick.
  const MAX_OWNER_LOOKUPS=12;
  const asks=[],seen=new Set();let ownerLookups=0;
  for(const o of result.sells){
   // Actual upstream GetOrders returns a public OrderRow, which does NOT
   // expose owner_id/is_corp/state. Enrich via authoritative GetOrder.
   if(o?.source!=="player"||o.bid!==false||
      Number(o.station_id)!==stationID||Number(o.type_id)!==typeID)continue;
   const orderID=Number(o.order_id);
   if(!pos(orderID)||seen.has(orderID))
    throw Error("ALIFE_BUYER_DUPLICATE_RUST_ORDER");
   seen.add(orderID);
   if(ownerLookups>=MAX_OWNER_LOOKUPS)break;
   ownerLookups++;
   const nativeOwner=await marketClient.call("GetOrder",{
    order_id:String(orderID)});
   const verified=verifyNativeBookAsk(o,nativeOwner,{stationID,typeID});
   if(verified.ok!==true)
    throw Error("ALIFE_BUYER_RUST_OWNER_ROW_INVALID:"+verified.reason);
   const sellerID=verified.owner_id,quantity=verified.vol_remaining,
    price=verified.price_cents;
   if(sellerID===ownerID||quantity>50000||price>100000000)
    throw Error("ALIFE_BUYER_RUST_ASK_INVALID");
   // No seller session is forged: require a canonical marketEscrow row and
   // exactly one real owner/item in stock location for this first slice.
   let escrow;
   try{escrow=read("marketEscrow","/"+orderID)}
   catch{continue}
   if(escrow?.escrowType!=="sell"||escrow.isCorp!==false||
      String(escrow.orderId)!==String(orderID)||escrow.ownerId!==sellerID||
      escrow.typeId!==typeID||escrow.stationId!==stationID||
      escrow.remainingQuantity!==quantity||
      escrow.escrowLocationID!==9200000000+orderID)continue;
   const physical=itemStore.listOwnedItems(sellerID);
   if(!Array.isArray(physical)||physical.length>10000)continue;
   const escrowItems=physical.filter(i=>i?.ownerID===sellerID&&
     i.locationID===escrow.escrowLocationID&&i.flagID===4);
   if(escrowItems.length!==1||escrowItems[0].typeID!==typeID||
      escrowItems[0].quantity!==quantity||escrowItems[0].stacksize!==quantity||
      escrowItems[0].singleton!==0)continue;
   if(!verifySeller(sellerID,stationID))continue;
   asks.push({verifiedNative:true,orderID,stationID,typeID,
    sellerOwnerID:sellerID,remainingQuantity:quantity,unitPriceCents:price,
    state:"open"});
  }
  // Any wallet/item change while the Rust book was being read invalidates the
  // entire proof; next A-Life tick may retry, no speculative order execution.
  const again=corp(ownerID),updated=itemStore.listOwnedItems(ownerID);
  if(again.walletCents!==owner.walletCents||
     !Array.isArray(updated)||updated.length!==items.length||
     JSON.stringify(updated.map(i=>[
       i.itemID,i.ownerID,i.locationID,i.flagID,i.typeID,i.quantity??i.stacksize
      ]).sort((a,b)=>a[0]-b[0]))!==JSON.stringify(itemProof))
   throw Error("ALIFE_BUYER_SOURCE_CHANGED_DURING_RUST_READ");
  return {authoritativeNative:true,source:"GAMESTORE_SDE_RUST_ESCROW",
   ownerID,stationID,typeID,walletCents:owner.walletCents,
   targetStock:proof.required,physicalOwned,incomingStock:0,
   outstandingBuys:0,asks};
 }
 const coordinator=createNpcBuyerCoordinator({
  file,resolveActor:actor,readProof,
  getOrder:async id=>normalizeNativeOrderForCoordinator(
   await marketClient.call("GetOrder",{order_id:String(id)})),
  buyer,clock,env,
  auditRecovery:()=>audit(),authorizeRecoveryOperator
 });
 async function audit(){
  // No mutations. A read-only GameStore snapshot and Rust inspection must
  // agree before an operator handles a stale .lock / PREPARED journal.
  return auditNativeNpcBuyerRecovery({
   journal:coordinator.inspect(),
   lockPresent:fs.existsSync(file+".lock"),
   inspectRustClaim:async claimKey=>{
    try{return await marketClient.call("GetNpcCorpPlayerClaim",{
     claim_key:claimKey})}
    catch(error){
     // This is the pinned Rust explicit not-found response; transport errors
     // are NOT interpreted as absent durable claims.
     if(/NPC corporate player claim missing/.test(String(error?.message||"")))
      return null;
     throw error;
    }
   },
   listGameStoreReceipts:async claimKey=>{
    const result=gameStore.coopAtomicNativeRows.transact(
     ["npcMarketFills"],tx=>tx.scan("npcMarketFills")
      .filter(({value})=>value?.claimKey===claimKey)
      .map(({value})=>value));
    const rows=result?.result??result;
    if(!Array.isArray(rows))throw Error("NPC_BUY_RECEIPT_READ_INVALID");
    return rows;
   }
  });
 }
 // Genuine EveJS seller UI updates are optional and strictly post-commit.
 // Do not send one from a speculative A-Life opportunity or pending claim.
 const notifyAdapter=env.EVEJS_COOP_NPC_BUY_NOTIFY==="1"?
  marketNotifier||createNpcMarketCompletionNotifier({
   gameStore:gameStore.coopAtomicNativeRows,marketClient,
   sessions:require("../services/chat/sessionRegistry"),
   helpers:require("../services/_shared/serviceHelpers"),
   walletState:require("../services/account/walletState"),clock,env
  }):null;
 async function withSellerNotification(result,successStatus){
  if(!notifyAdapter||result?.status!==successStatus||
     !/^npc-corpbuy:[0-9a-f]{32}$/.test(result?.operation||"")||
     !pos(result?.fillID))return result;
  let sent;
  try{sent=await notifyAdapter.notifyCommitted({
   claimKey:result.operation,fillID:result.fillID})}
  catch{sent={status:"NOT_SENT",reason:"NOTIFY_AUTHORITY_UNAVAILABLE"}}
  // Best-effort UI delivery does not turn a successfully paid transaction
  // into a failed buyer tick and NEVER calls RecordTrade.
  return {...result,notification:sent?.status||"NOT_SENT"};
 }
 return Object.freeze({
  tick:args=>coordinator.tick(args).then(r=>
   withSellerNotification(r,"NPC_PLAYER_PURCHASE_SETTLED")),
  // Operator API is never called by the A-Life scheduler. Requires a
  // trusted authenticator injected by a separate server-admin adapter.
  recoverApproved:args=>coordinator.recoverApproved(args).then(r=>
   withSellerNotification(r,"NPC_BUY_OPERATOR_RECOVERED")),
  inspect:()=>coordinator.inspect(),audit,
  mode:"ALIFE_NATIVE_RUST_GAMESTORE_BUYER",supportsLiveRuntime:false});
}
module.exports={createNativeNpcBuyerBindings};
