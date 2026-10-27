"use strict";
// CH24+31 Stage C1: one original warehouse ore item -> native player corp office.
// Future trusted native adapter enables only EVEJS_COOP_PLAYER_NPC_MINING_ORE_TITLE=1.
// A payroll receipt NEVER transfers ore ownership. This is a separate, paid,
// source-bound atomic GameStore transaction, with no item grant/clone/split.
const SEP="\u001f";
const TABLES=Object.freeze(["items","corporationRuntime"]);
const CORP=id=>"corporations"+SEP+id;
const SHIFT=id=>"coopPlayerMiningShift"+SEP+id;
const INDEX=(systemID,fleetID)=>"coopPlayerMiningFleet"+SEP+systemID+":"+fleetID;
const RECEIPT=id=>"coopPlayerMiningOreTitle"+SEP+id;
const LEGACY=id=>"coopWarehouseTitleTransfer"+SEP+id;
const POS=x=>Number.isSafeInteger(x)&&x>0;
const cents=x=>{
 if(typeof x!=="number"||!Number.isFinite(x)||x<0)return null;
 const n=Math.round(x*100);
 return Number.isSafeInteger(n)&&Math.abs(x*100-n)<1e-7?n:null;
};
const isk=x=>x/100;
const marker=id=>"coop-warehouse:v1:cargo:"+id;
const op=(shiftID,cargoID)=>"coop-mining-ore-title:v1:"+shiftID+":"+cargoID;
const blocked=(reason,id)=>({status:"BLOCKED",reason,operationID:id,nativeMutation:false});
const wallet=(corp,id)=>{
 const w=corp?.corporationID===id?corp.wallet?.divisions?.["1000"]:null;
 return w&&Array.isArray(w.transactions)&&Array.isArray(w.journal)&&cents(w.balance)!==null?w:null;
};
function paid(w,id,ownerID,otherID,amount,after){
 if(!w)return false;
 const matches=xs=>xs.filter(x=>x?.transactionID===id);
 const correct=x=>x.referenceID===id&&x.ownerID1===ownerID&&
  x.ownerID2===otherID&&x.accountKey===1000&&
  cents(Math.abs(x.amount))===Math.abs(amount)&&
  (amount<0?x.amount<0:x.amount>0)&&cents(x.balance)===after;
 const a=matches(w.journal),b=matches(w.transactions);
 return a.length===1&&b.length===1&&correct(a[0])&&correct(b[0]);
}
function createPlayerMiningOreTitle({gameStore,access,getWarehouseReceipt,
 verifyNpcCorporation,verifyOffice,quoteOre,clock=()=>Date.now(),
 enabled=()=>false}={}){
 const atomic=gameStore?.coopAtomicNativeRows;
 if(atomic?.mode!=="SERVER_INTERNAL_FLAGGED"||
   typeof atomic.transact!=="function"||typeof atomic.isPoisoned!=="function"||
   [access?.isMember,access?.canIndustry,access?.canWallet,access?.canView,
    getWarehouseReceipt,verifyNpcCorporation,verifyOffice,quoteOre,clock,enabled]
    .some(x=>typeof x!=="function"))
  throw Error("MINING_ORE_NATIVE_AUTHORITIES_REQUIRED");
 const held=new Set();
 function transfer({session,shiftID,cargoID,itemID,typeID,quantity,systemID,
  fleetID,sourceCorpID,buyerCorpID,stationID,officeFolderID,division=115,
  maxPriceCents}={}){
  const id=op(shiftID,cargoID);
  if(![cargoID,itemID,typeID,quantity,systemID,fleetID,sourceCorpID,
    buyerCorpID,stationID,officeFolderID,maxPriceCents].every(POS)||
    typeof shiftID!=="string"||!/^coop-mining-shift:[0-9a-f]{32}$/.test(shiftID)||
    sourceCorpID===buyerCorpID||quantity>1000000000||
    maxPriceCents>100000000000||!Number.isSafeInteger(division)||
    division<115||division>121)return blocked("MINING_ORE_TRANSFER_SCOPE_INVALID",id);
  if(enabled()!==true)return blocked("MINING_ORE_TRANSFER_DISABLED",id);
  if(held.has(cargoID))return blocked("MINING_ORE_OPERATOR_REPAIR_REQUIRED",id);
  if(atomic.isPoisoned())return blocked("MINING_ORE_GAMESTORE_POISONED",id);
  const authorized=()=>access.isMember(session,buyerCorpID)===true&&
   access.canIndustry(session,buyerCorpID)===true&&
   access.canWallet(session,buyerCorpID,1000)===true&&
   access.canView(session,buyerCorpID,stationID,division)===true;
  if(!authorized())return blocked("MINING_ORE_CORPORATION_ROLE_DENIED",id);
  const context={buyerCorpID,sourceCorpID,stationID,officeFolderID,division,session};
  if(verifyOffice(context)!==true||verifyNpcCorporation(sourceCorpID)!==true)
   return blocked("MINING_ORE_OFFICE_OR_NPC_AUTHORITY_MISSING",id);
  let proof,quote;
  try{
   proof=getWarehouseReceipt(cargoID);
   if(proof?.version!==1||proof.phase!=="COMMITTED"||
     proof.cargoID!==cargoID||proof.itemID!==itemID||
     proof.typeID!==typeID||proof.quantity!==quantity||
     proof.systemID!==systemID||proof.fleetID!==fleetID||
     proof.corporationID!==sourceCorpID||proof.stationID!==stationID||
     !POS(proof.haulerID)||!POS(proof.updatedAt))
    return blocked("MINING_ORE_ORIGINAL_DELIVERY_NOT_ATTESTED",id);
   quote=quoteOre({shiftID,cargoID,itemID,typeID,quantity,stationID,
     sourceCorpID,buyerCorpID});
   if(quote?.verifiedNative!==true||quote.operationID!==id||
     quote.cargoID!==cargoID||quote.itemID!==itemID||
     quote.sourceCorpID!==sourceCorpID||quote.buyerCorpID!==buyerCorpID||
     quote.stationID!==stationID||quote.quantity!==quantity||
     quote.typeID!==typeID||!POS(quote.priceCents)||
     quote.priceCents>maxPriceCents||quote.priceCents>100000000000)
    return blocked("MINING_ORE_NATIVE_PRICE_NOT_ATTESTED",id);
  }catch{return blocked("MINING_ORE_SOURCE_OR_QUOTE_UNAVAILABLE",id);}
  let calledNative=false;
  try{
   const now=clock();if(!POS(now))return blocked("MINING_ORE_CLOCK_INVALID",id);
   calledNative=true;
   const result=atomic.transact(TABLES,tx=>{
    if(!authorized()||verifyOffice(context)!==true)
     throw Error("MINING_ORE_AUTHORITY_REVOKED");
    const shift=tx.get("corporationRuntime",SHIFT(shiftID));
    const index=tx.get("corporationRuntime",INDEX(systemID,fleetID));
    if(shift?.version!==1||shift.status!=="FUNDED"||
      shift.operationID!==shiftID||shift.corporationID!==buyerCorpID||
      shift.employerCorpID!==sourceCorpID||shift.systemID!==systemID||
      shift.fleetID!==fleetID||!POS(shift.createdAt)||
      !POS(proof.at)||proof.at<shift.createdAt||proof.updatedAt<proof.at||
      !Array.isArray(shift.haulerIDs)||
      !shift.haulerIDs.includes(proof.haulerID)||
      index?.operationID!==shiftID||index.corporationID!==buyerCorpID||
      index.employerCorpID!==sourceCorpID)
     throw Error("MINING_ORE_FUNDED_FLEET_RECEIPT_MISMATCH");
    const source=tx.get("corporationRuntime",CORP(sourceCorpID));
    const buyer=tx.get("corporationRuntime",CORP(buyerCorpID));
    const sourceWallet=wallet(source,sourceCorpID),buyerWallet=wallet(buyer,buyerCorpID);
    if(!sourceWallet||!buyerWallet||verifyNpcCorporation(sourceCorpID,source)!==true)
     throw Error("MINING_ORE_NATIVE_WALLETS_NOT_VERIFIED");
    const previous=tx.get("corporationRuntime",RECEIPT(cargoID));
    if(previous){
     if(previous.version!==1||previous.status!=="COMMITTED"||
       previous.operationID!==id||previous.shiftID!==shiftID||
       previous.cargoID!==cargoID||previous.itemID!==itemID||
       previous.typeID!==typeID||previous.quantity!==quantity||
       previous.sourceCorpID!==sourceCorpID||previous.buyerCorpID!==buyerCorpID||
       previous.stationID!==stationID||previous.officeFolderID!==officeFolderID||
       previous.division!==division||previous.priceCents!==quote.priceCents||
       !paid(sourceWallet,id,sourceCorpID,buyerCorpID,quote.priceCents,previous.sourceAfterCents)||
       !paid(buyerWallet,id,buyerCorpID,sourceCorpID,-quote.priceCents,previous.buyerAfterCents))
      throw Error("MINING_ORE_COMMITTED_RECEIPT_CONFLICT");
     // Item may already have been refined or sold. Never reassign it again.
     return {status:"ALREADY_TRANSFERRED",receipt:previous};
    }
    if(tx.get("corporationRuntime",LEGACY(cargoID)))
     throw Error("MINING_ORE_ALREADY_CLAIMED_BY_LEGACY_TRANSFER");
    const item=tx.get("items",String(itemID));
    if(!item||item.itemID!==itemID||item.ownerID!==sourceCorpID||
      item.locationID!==stationID||item.flagID!==4||item.singleton!==0||
      item.typeID!==typeID||item.quantity!==quantity||
      item.stacksize!==quantity||item.customInfo!==marker(cargoID))
     throw Error("MINING_ORE_ORIGINAL_ITEM_CUSTODY_MISMATCH");
    if(tx.scan("items").filter(x=>x.value?.customInfo===marker(cargoID)).length!==1)
     throw Error("MINING_ORE_DUPLICATE_CARGO_PROVENANCE");
    const sourceBefore=cents(sourceWallet.balance),buyerBefore=cents(buyerWallet.balance);
    if(buyerBefore<quote.priceCents||!Number.isSafeInteger(sourceBefore+quote.priceCents))
     throw Error("MINING_ORE_INSUFFICIENT_ISK");
    for(const w of [sourceWallet,buyerWallet])if(w.transactions.some(x=>x.transactionID===id)||
      w.journal.some(x=>x.transactionID===id))
      throw Error("MINING_ORE_WALLET_RECEIPT_COLLISION");
    const filetime=String(BigInt(now)*10000n+116444736000000000n);
    const entry=(owner,other,amount,after)=>({transactionID:id,referenceID:id,
      accountKey:1000,entryTypeID:10,currency:1,sortValue:1,
      transactionDate:filetime,ownerID1:owner,ownerID2:other,
      amount:isk(amount),balance:isk(after),
      description:"Original mining warehouse ore sale "+cargoID});
    const sourceAfter=sourceBefore+quote.priceCents,buyerAfter=buyerBefore-quote.priceCents;
    const add=(w,row,after)=>({...w,balance:isk(after),
      journal:[...w.journal,row].slice(-100),
      transactions:[...w.transactions,row].slice(-2000)});
    const sourceRow=entry(sourceCorpID,buyerCorpID,quote.priceCents,sourceAfter);
    const buyerRow=entry(buyerCorpID,sourceCorpID,-quote.priceCents,buyerAfter);
    const receipt={version:1,status:"COMMITTED",operationID:id,shiftID,cargoID,itemID,
      typeID,quantity,sourceCorpID,buyerCorpID,stationID,officeFolderID,division,
      priceCents:quote.priceCents,sourceBeforeCents:sourceBefore,sourceAfterCents:sourceAfter,
      buyerBeforeCents:buyerBefore,buyerAfterCents:buyerAfter,committedAt:now};
    tx.put("items",String(itemID),{...item,ownerID:buyerCorpID,
      locationID:officeFolderID,flagID:division});
    tx.put("corporationRuntime",CORP(sourceCorpID),{...source,wallet:{...source.wallet,
      divisions:{...source.wallet.divisions,"1000":add(sourceWallet,sourceRow,sourceAfter)}}});
    tx.put("corporationRuntime",CORP(buyerCorpID),{...buyer,wallet:{...buyer.wallet,
      divisions:{...buyer.wallet.divisions,"1000":add(buyerWallet,buyerRow,buyerAfter)}}});
    tx.put("corporationRuntime",RECEIPT(cargoID),receipt);
    return {status:"TITLE_TRANSFERRED",receipt};
   });
   if(!result||!["TITLE_TRANSFERRED","ALREADY_TRANSFERRED"].includes(result.status))
    throw Error("MINING_ORE_NATIVE_RESULT_UNKNOWN");
   return {...result,nativeMutation:result.status==="TITLE_TRANSFERRED",
     originalItemID:itemID,cargoID,operationID:id};
  }catch(error){
   if(calledNative)held.add(cargoID);
   return blocked("MINING_ORE_NATIVE_CUSTODY_OR_COMMIT_UNCERTAIN:"+
     String(error?.message||error).slice(0,110),id);
  }
 }
 return Object.freeze({transfer,requiresOperatorReconciliation:()=>[...held],
  mode:"NATIVE_ORIGINAL_ITEM_ATOMIC_ONLY",supportsLiveRuntime:false});
}
// Read-only reconciliation for the original NPC warehouse. A title transfer
// is legitimate only while the exact same physical item and reciprocal native
// wallet journal entries remain independently observable.
function createPlayerMiningOreAudit({readTitleReceipt,readCorporation,findItemById,
 findByCargoID,verifyOfficeReceipt}={}){
 if([readTitleReceipt,readCorporation,findItemById,findByCargoID,verifyOfficeReceipt]
   .some(x=>typeof x!=="function"))throw Error("MINING_ORE_AUDIT_AUTHORITIES_REQUIRED");
 function transferred(record){
  try{
   if(record?.phase!=="COMMITTED"||!POS(record.cargoID)||!POS(record.itemID))return false;
   const r=readTitleReceipt(record.cargoID);
   if(r?.version!==1||r.status!=="COMMITTED"||r.cargoID!==record.cargoID||
    r.itemID!==record.itemID||r.typeID!==record.typeID||
    r.quantity!==record.quantity||r.stationID!==record.stationID||
    r.sourceCorpID!==record.corporationID||!POS(r.buyerCorpID)||
    !POS(r.officeFolderID)||!POS(r.committedAt)||
    r.priceCents<=0||!POS(r.priceCents)||
    r.sourceBeforeCents+r.priceCents!==r.sourceAfterCents||
    r.buyerBeforeCents-r.priceCents!==r.buyerAfterCents||
    !POS(r.division)||r.division<115||r.division>121||
    verifyOfficeReceipt(r)!==true)return false;
   const seller=wallet(readCorporation(r.sourceCorpID),r.sourceCorpID),
    buyer=wallet(readCorporation(r.buyerCorpID),r.buyerCorpID);
   if(!paid(seller,r.operationID,r.sourceCorpID,r.buyerCorpID,
      r.priceCents,r.sourceAfterCents)||
      !paid(buyer,r.operationID,r.buyerCorpID,r.sourceCorpID,
      -r.priceCents,r.buyerAfterCents))return false;
   const item=findItemById(record.itemID),byCargo=findByCargoID(record.cargoID);
   return Boolean(item&&byCargo&&byCargo.itemID===item.itemID&&
    item.itemID===r.itemID&&item.ownerID===r.buyerCorpID&&
    item.locationID===r.officeFolderID&&item.flagID===r.division&&
    item.singleton===0&&item.typeID===record.typeID&&
    item.quantity===record.quantity&&item.stacksize===record.quantity&&
    item.customInfo===marker(record.cargoID));
  }catch{return false;}
 }
 return Object.freeze({transferred});
}
module.exports={createPlayerMiningOreTitle,createPlayerMiningOreAudit,RECEIPT,TABLES};
