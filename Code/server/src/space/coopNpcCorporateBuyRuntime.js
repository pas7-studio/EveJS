"use strict";
// COOP-035 optional server-side bridge. Only called by authenticated native market
// handler with exact docked session; NEVER impersonates a character or corp.
// Intentionally no background/startup side effects or timer.
// Source checkout contains .cjs, while pinned EveJS overlay deploys .js.
 // Keep native .js resolution first; do not disguise transitive missing deps.
function loadSettlement(){
 try{return require("./coopNpcCorporateSettlement")}
 catch(error){
  if(error?.code!=="MODULE_NOT_FOUND"||
     String(error.message).split("\n")[0]!==
      "Cannot find module './coopNpcCorporateSettlement'")
   throw error;
  return require("./coopNpcCorporateSettlement");
 }
}
const {createNpcCorporateSettlement}=loadSettlement();
const {marketDaemonClient}=require("../services/market/marketDaemonClient");
const {getEscrowRecord}=require("../services/market/marketEscrowState");
const {getCorporationRecord}=require("../services/corporation/corporationState");
const {getCorporationRuntime}=require("../services/corporation/corporationRuntimeState");
const {getDockedLocationID}=require("../services/structure/structureLocation");
const {findItemById}=require("../services/inventory/itemStore");
const {getCharacterRecord}=require("../services/character/characterState");
const {getAccountByUserName}=require("../services/login/accountStore");
const {notifyInventoryChangesToCharacter}=require("../services/raffles/raffleInventory");
const gameStore=require("../gameStore");
const pos=x=>Number.isSafeInteger(x)&&x>0;
const canonicalID=x=>{
 const n=Number(x);
 return (typeof x==="number"||typeof x==="string"&&/^[1-9][0-9]*$/.test(x))&&
  Number.isSafeInteger(n)&&n>0?n:0;
};
const sessionID=s=>{
 const a=canonicalID(s?.characterID),b=canonicalID(s?.charid);
 return a&&b&&a!==b?0:a||b;
};
// Session guard: never run an untrusted global buyer session across concurrent RPCs.
// Build a fresh actor-scoped instance with the same captured native authorities.
function makeForSession(session){
 if(!session||!pos(sessionID(session)))throw Error("NPC_BUY_AUTHENTICATED_SESSION_REQUIRED");
 const buyerID=sessionID(session);
 const market={
  claimOnce:({orderID,buyerID:claimBuyer,operationID})=>{
   if(claimBuyer!==buyerID)throw Error("NPC_BUY_ACTOR_CHANGED");
   return marketDaemonClient.call("ClaimNpcSellOrder",{operation_id:operationID,
    order_id:String(orderID),buyer_id:String(buyerID)});
  },
  finalizeOnce:({orderID,buyerID:claimBuyer,operationID,fillID})=>{
   if(claimBuyer!==buyerID)throw Error("NPC_BUY_ACTOR_CHANGED");
   return marketDaemonClient.call("FinalizeNpcSellOrder",{
    operation_id:operationID,order_id:String(orderID),buyer_id:String(buyerID),
    fill_id:String(fillID)});
  },
  inspectClaim:({operationID})=>marketDaemonClient.call("GetNpcSellClaim",{
   operation_id:operationID})
 };
 const verifyBuyerSession=(actor,stationID)=>{
  if(actor!==buyerID||session?.socket?.destroyed===true||
     sessionID(session)!==buyerID||
     Number(getDockedLocationID(session))!==stationID)return false;
  // Pinned EveJS characterState records are keyed by character ID, and
  // neither characterID nor accountId is persisted on the character row.
  // The trusted handshake binds userName -> account.id to session.userid;
  // character selection already binds the same native session to buyerID.
  const record=getCharacterRecord(buyerID);
  const userID=canonicalID(session.userid??session.userID??session.accountID);
  const userName=session.userName??session.username;
  const account=typeof userName==="string"&&userName.length>0?
   getAccountByUserName(userName):null;
  const embedded=record?.characterID??record?.charID;
  const optionalAccountID=record?.accountId??record?.accountID;
  return Boolean(record&&userID&&account&&account.banned!==true&&
   canonicalID(account.id)===userID&&
   (embedded===undefined||embedded===null||canonicalID(embedded)===buyerID)&&
   (optionalAccountID===undefined||optionalAccountID===null||
    canonicalID(optionalAccountID)===userID));
 };
 const verifyNpcCorporation=(corpID,stationID)=>{
  const record=getCorporationRecord(corpID),runtime=getCorporationRuntime(corpID);
  return Boolean(record?.corporationID===corpID&&record.isNPC===true&&
   runtime?.corporationID===corpID&&pos(stationID));
 };
 return createNpcCorporateSettlement({gameStore:gameStore.coopAtomicNativeRows,market,
  verifyBuyerSession,verifyNpcCorporation});
}
async function buyFromOrder({session,sellOrder,quantity}={}){
 if(process.env.EVEJS_COOP_NATIVE_NPC_CORP_SETTLEMENT!=="1"||
    process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS!=="1"||
    process.env.EVEJS_COOP_NATIVE_NPC_CORP_SETTLEMENT_PROOF!=="1")
   return {status:"BLOCKED",error:"NPC_BUY_NOT_ACTIVATED"};
 if(!session||!sellOrder||String(sellOrder.source)!=="coop-npc")
   return {status:"BLOCKED",error:"NPC_BUY_UNTRUSTED_ORDER"};
 const buyerID=sessionID(session),orderID=Number(sellOrder.order_id);
 const stationID=Number(sellOrder.station_id),typeID=Number(sellOrder.type_id);
 const listed=Number(sellOrder.vol_remaining);
 // An original Rust SELL order price must already be canonical cents.
 // Rounding 1.254 ISK to 1.25 changes the advertised contract before
 // any Rust claim / original GameStore escrow or wallet authority.
 const price=sellOrder.price;
 const rawPriceCents=price*100,priceCents=Math.round(rawPriceCents);
 if(!pos(buyerID)||!pos(orderID)||!pos(stationID)||!pos(typeID)||
    !pos(listed)||quantity!==listed||typeof price!=="number"||
    !Number.isFinite(price)||price<=0||
    !pos(priceCents)||priceCents>100000000||
    Math.abs(rawPriceCents-priceCents)>1e-7||
    Number(getDockedLocationID(session))!==stationID)
   return {status:"BLOCKED",error:"NPC_BUY_REQUIRES_FULL_STACK_DOCKED"};
 const escrow=getEscrowRecord(orderID);
 if(!escrow||escrow.escrowType!=="sell"||escrow.isCorp!==true||
    escrow.stationId!==stationID||escrow.typeId!==typeID||
    escrow.remainingQuantity!==quantity)
   return {status:"BLOCKED",error:"NPC_BUY_ESCROW_UNVERIFIED"};
 const identity={operationID:escrow.coopOperationID,orderID,
  ownerID:escrow.ownerId,stationID,typeID,itemID:escrow.sourceItemID,
  quantity:listed};
 const bridge=makeForSession(session);
 const result=await bridge.purchaseOnce({buyerID,identity,maxPriceCents:priceCents});
 if(result.status==="PURCHASED"){
  // Notifications run AFTER the atomic commit and Rust finalize. Their failure
  // must never trigger a second debit/delivery or a compensating mint.
  try{
   const item=findItemById(result.itemID);
   if(item?.ownerID===buyerID&&item.locationID===stationID)
     notifyInventoryChangesToCharacter(buyerID,[{item,
      previousData:{ownerID:identity.ownerID,locationID:9200000000+orderID,
       flagID:4,quantity:quantity,stacksize:quantity}}]);
  }catch(error){console.warn("[CoopNpcMarket] postcommit notification:",error.message)}
 }
 return result;
}
module.exports={buyFromOrder,makeForSession};
