"use strict";
/**
 * CH24+31 E2A: read-only NATIVE corporate ore sale readiness & scoped cash
 * accounting. Pinned EveJS marketProxyService.assertPersonalMarketOnly(true)
 * rejects corp orders, executeSellEntry requires character-owned hangar stock.
 *
 * Never call the personal SELL path with a corporation item, reassign stock
 * to a character, mark an order filled, or fabricate revenue/ISK.
 */
const SEP="\u001f",pos=x=>Number.isSafeInteger(x)&&x>0;
const bound=x=>Number.isSafeInteger(x)&&x>=0&&x<=Number.MAX_SAFE_INTEGER;
const iskCents=x=>{
 if(typeof x!=="number"||!Number.isFinite(x)||x<0)return null;
 const n=Math.round(x*100);
 return bound(n)&&Math.abs(x*100-n)<1e-6?n:null;
};
const readPath=(group,id)=>"/"+group+"/"+id;
const OP=/^coop-mining-shift:[0-9a-f]{32}$/;
function matchingWallet(corp,ownID,otherID,opID,amountCents,afterCents){
 const w=corp?.corporationID===ownID?corp?.wallet?.divisions?.["1000"]:null;
 if(!w||!bound(afterCents)||!Number.isSafeInteger(amountCents)||
  !Array.isArray(w.transactions)||!Array.isArray(w.journal))return false;
 const valid=row=>row?.transactionID===opID&&row.referenceID===opID&&
  row.ownerID1===ownID&&row.ownerID2===otherID&&row.accountKey===1000&&
  row.amount<0===(amountCents<0)&&
  iskCents(Math.abs(row.amount))===Math.abs(amountCents)&&
  iskCents(row.balance)===afterCents;
 const txn=w.transactions.filter(x=>x?.transactionID===opID);
 const journal=w.journal.filter(x=>x?.transactionID===opID);
 return txn.length===1&&journal.length===1&&valid(txn[0])&&valid(journal[0]);
}
function createCorporateMiningMarketReadiness({
 gameStore,itemStore,access,verifyOffice,enabled=()=>false
}={}){
 if(typeof gameStore?.read!=="function"||
  typeof itemStore?.findItemById!=="function"||
  [access?.isMember,access?.canIndustry,access?.canWallet,access?.canTake,
   verifyOffice,enabled].some(fn=>typeof fn!=="function"))
  throw Error("MINING_MARKET_ORIGINAL_READ_AUTHORITIES_REQUIRED");
 const denied=reason=>Object.freeze({status:"BLOCKED",reason,
  marketOrderCreated:false,nativeMutation:false,
  realizedRevenueCents:null,netProfitCents:null});
 function read(group,id){
  const r=gameStore.read("corporationRuntime",readPath(group,id));
  if(r?.success===true&&r.data!=null)return r.data;
  if(r?.errorMsg==="ENTRY_NOT_FOUND")return null;
  throw Error("MINING_MARKET_GAMESTORE_READ_UNAVAILABLE");
 }
 function inspect({session,corporationID,operationID,cargoIDs=[]}={}){
  if(enabled()!==true)return denied("NATIVE_MINING_MARKET_READ_DISABLED");
  if(!session||session.socket?.destroyed===true||!pos(session.characterID)||
   !pos(corporationID)||session.corporationID!==corporationID||
   typeof operationID!=="string"||!OP.test(operationID)||
   !Array.isArray(cargoIDs)||cargoIDs.length>100||
   cargoIDs.some(id=>!pos(id))||new Set(cargoIDs).size!==cargoIDs.length)
   return denied("MINING_MARKET_SCOPE_INVALID");
  if(access.isMember(session,corporationID)!==true||
   access.canIndustry(session,corporationID)!==true||
   access.canWallet(session,corporationID,1000)!==true)
   return denied("MINING_MARKET_FINANCE_ROLE_DENIED");
  try{
   const shift=read("coopPlayerMiningShift",operationID);
   if(shift?.version!==1||shift.status!=="FUNDED"||
    shift.operationID!==operationID||shift.corporationID!==corporationID||
    !pos(shift.employerCorpID)||!pos(shift.systemID)||!pos(shift.fleetID)||
    !pos(shift.createdAt)||!pos(shift.wageCents)||
    !bound(shift.buyerAfterCents)||!bound(shift.employerAfterCents)||
    shift.employerCorpID===corporationID)
    return denied("MINING_MARKET_FUNDED_SHIFT_NOT_VERIFIED");
   const index=read("coopPlayerMiningFleet",shift.systemID+":"+shift.fleetID);
   if(index?.operationID!==operationID||index.corporationID!==corporationID||
    index.employerCorpID!==shift.employerCorpID||
    index.systemID!==shift.systemID||index.fleetID!==shift.fleetID)
    return denied("MINING_MARKET_FLEET_BINDING_CONFLICT");
   const buyer=read("corporations",corporationID);
   const seller=read("corporations",shift.employerCorpID);
   if(!matchingWallet(buyer,corporationID,shift.employerCorpID,
     operationID,-shift.wageCents,shift.buyerAfterCents)||
    !matchingWallet(seller,shift.employerCorpID,corporationID,
     operationID,shift.wageCents,shift.employerAfterCents))
    return denied("MINING_MARKET_WAGE_WALLET_PROOF_MISSING");
   let purchaseCents=0;
   const inventory=[],seenItems=new Set();
   for(const cargoID of [...cargoIDs].sort((a,b)=>a-b)){
    const receipt=read("coopPlayerMiningOreTitle",cargoID);
    if(!receipt)return denied("MINING_MARKET_ORIGINAL_TITLE_RECEIPT_MISSING");
    if(receipt.version!==1||receipt.status!=="COMMITTED"||
     receipt.operationID!=="coop-mining-ore-title:v1:"+operationID+":"+cargoID||
     receipt.cargoID!==cargoID||receipt.shiftID!==operationID||
     !pos(receipt.committedAt)||receipt.committedAt<shift.createdAt||
     receipt.buyerCorpID!==corporationID||
     receipt.sourceCorpID!==shift.employerCorpID||
     !pos(receipt.itemID)||seenItems.has(receipt.itemID)||
     !pos(receipt.typeID)||!pos(receipt.quantity)||
     !pos(receipt.stationID)||!pos(receipt.officeFolderID)||
     ![115,116,117,118,119,120,121].includes(receipt.division)||
     !pos(receipt.priceCents)||!bound(receipt.buyerAfterCents)||
     !bound(receipt.sourceAfterCents))
     return denied("MINING_MARKET_TITLE_PROOF_INVALID");
    if(!matchingWallet(buyer,corporationID,shift.employerCorpID,
      receipt.operationID,-receipt.priceCents,receipt.buyerAfterCents)||
     !matchingWallet(seller,shift.employerCorpID,corporationID,
      receipt.operationID,receipt.priceCents,receipt.sourceAfterCents))
     return denied("MINING_MARKET_TITLE_PAYMENT_MISSING");
    if(!verifyOffice({buyerCorpID:corporationID,stationID:receipt.stationID,
      officeFolderID:receipt.officeFolderID,division:receipt.division,
      session})||
     access.canTake(session,corporationID,receipt.stationID,receipt.division)!==true)
     return denied("MINING_MARKET_ORIGINAL_HANGAR_RIGHTS_DENIED");
    const item=itemStore.findItemById(receipt.itemID);
    if(item?.itemID!==receipt.itemID||item.ownerID!==corporationID||
     item.locationID!==receipt.officeFolderID||
     item.flagID!==receipt.division||item.typeID!==receipt.typeID||
     item.singleton!==0||item.quantity!==receipt.quantity||
     item.stacksize!==receipt.quantity||
     item.customInfo!=="coop-warehouse:v1:cargo:"+cargoID)
     return denied("MINING_MARKET_ORIGINAL_ITEM_NO_LONGER_IN_HANGAR");
    if(!bound(purchaseCents+receipt.priceCents))
     return denied("MINING_MARKET_TOTAL_OVERFLOW");
    purchaseCents+=receipt.priceCents;
    seenItems.add(receipt.itemID);
    inventory.push(Object.freeze({
     cargoID,itemID:receipt.itemID,typeID:receipt.typeID,
     quantity:receipt.quantity,stationID:receipt.stationID,
     officeFolderID:receipt.officeFolderID,division:receipt.division,
     paidCents:receipt.priceCents}));
   }
   if(!bound(shift.wageCents+purchaseCents))
    return denied("MINING_MARKET_TOTAL_OVERFLOW");
   return Object.freeze({
    status:"NATIVE_CORPORATE_SELL_UNSUPPORTED",
    reason:"PINNED_MARKET_PROXY_REJECTS_CORP_ORDERS",
    corporationID,operationID,scope:"ONE_FUNDED_SHIFT_AND_EXPLICIT_CARGO_IDS",
    wagePaidCents:shift.wageCents,orePurchasedCents:purchaseCents,
    verifiedCashOutflowCents:shift.wageCents+purchaseCents,
    originalCorporateOre:inventory,marketOrderCreated:false,
    nativeMutation:false,realizedRevenueCents:null,netProfitCents:null,
    priceIsBinding:false
   });
  }catch{return denied("MINING_MARKET_NATIVE_READ_UNAVAILABLE");}
 }
 // Server-side exact source scan; the client never chooses ore IDs to
 // hide corporate expenses. A missing table is empty; a broken read blocks.
 function inspectShift(args={}){
  const {session,corporationID,operationID}=args;
  if(enabled()!==true)return denied("NATIVE_MINING_MARKET_READ_DISABLED");
  if(!session||!pos(corporationID)||!OP.test(operationID||"")||
   access.isMember(session,corporationID)!==true||
   access.canIndustry(session,corporationID)!==true||
   access.canWallet(session,corporationID,1000)!==true)
   return denied("MINING_MARKET_FINANCE_ROLE_DENIED");
  let records;
  try{records=gameStore.read("corporationRuntime","/coopPlayerMiningOreTitle");}
  catch{return denied("MINING_MARKET_ORIGINAL_TITLE_INDEX_UNAVAILABLE");}
  if(records?.errorMsg==="ENTRY_NOT_FOUND")
   return inspect({session,corporationID,operationID,cargoIDs:[]});
  const group=records?.data;
  if(records?.success!==true||!group||typeof group!=="object"||
   Array.isArray(group)||Object.keys(group).length>10000)
   return denied("MINING_MARKET_ORIGINAL_TITLE_INDEX_UNAVAILABLE");
  const selected=[];
  for(const [key,receipt] of Object.entries(group)){
   if(receipt?.shiftID!==operationID)continue;
   const id=Number(key);
   if(!pos(id)||String(id)!==key||receipt.cargoID!==id||
    receipt.buyerCorpID!==corporationID||selected.length>=100)
    return denied("MINING_MARKET_TITLE_INDEX_CONFLICT");
   selected.push(id);
  }
  return inspect({session,corporationID,operationID,cargoIDs:selected});
 }
 // No SELL mutation exists here. Never pass corporate items to the
 // character-owned stock marketProxyService or call the Rust orderbook.
 return Object.freeze({inspect,inspectShift,mode:"NATIVE_CORPORATE_MARKET_READ_ONLY",
  canPlaceNativeCorporateOrder:false});
}
// Original EveJS server only. This adapter is intentionally read-only;
// the market service itself rejects useCorp orders at the pinned source.
let runtimeService=null;
function native(){
 if(runtimeService)return runtimeService;
 const gameStore=require("../gameStore"),
  corp=require("../services/corporation/corporationState"),
  corpRuntime=require("../services/corporation/corporationRuntimeState"),
  itemStore=require("../services/inventory/itemStore"),
  location=require("../services/structure/structureLocation"),
  access=require("./coopPlayerCorporationAccess"),
  office=require("./coopPlayerMiningOreNativeBindings"),
  flags=require("./coopFlags");
 const binding=office.createNativeMiningOreBindings({
  gameStore,corporationState:corp,corporationRuntime:corpRuntime,
  itemStore,getDockedStation:location.getDockedLocationID,access});
 runtimeService=createCorporateMiningMarketReadiness({
  gameStore,itemStore,access,verifyOffice:binding.verifyOffice,
  enabled:()=>flags.on("EVEJS_COOP_PLAYER_NPC_MINING_MARKET_READ")&&
   flags.on("EVEJS_COOP_PLAYER_NPC_MINING_COMPANY")});
 return runtimeService;
}
function inspectNative(input){
 try{
  if(!require("./coopFlags").on("EVEJS_COOP_PLAYER_NPC_MINING_MARKET_READ"))
   return null;
  return native().inspectShift(input);
 }catch{return null;}
}
// Exact source-bound cargo lookup for native market orders; inventory may
// contain several owned cargo rows and only the selected item is for sale.
// Never scan all title rows as one indivisible order.
function inspectCargoNative(input){
 try{
  if(!require("./coopFlags").on("EVEJS_COOP_PLAYER_NPC_MINING_MARKET_READ")||
   !Number.isSafeInteger(input?.cargoID)||input.cargoID<=0)return null;
  return native().inspect({...input,cargoIDs:[input.cargoID]});
 }catch{return null;}
}
module.exports={createCorporateMiningMarketReadiness,matchingWallet,iskCents,
 inspectNative,inspectCargoNative};

