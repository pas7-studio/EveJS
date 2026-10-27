"use strict";
/**
 * CH24+31: native player-corporation funded mining shift (first bounded slice).
 * Creates a durable, paid offer for an EXISTING native NPC mining fleet.
 * It does not spawn NPCs, issue mining orders, move ore, or change market stock.
 * An A-Life dispatcher may act ONLY after a separate native identity and order
 * arbitration witness; FUNDED is not evidence that an NPC performed any work.
 */
const SEP="\u001f";
const TABLES=Object.freeze(["corporationRuntime"]);
const CONTRACT=id=>"coopPlayerMiningShift"+SEP+id;
const CORP=id=>"corporations"+SEP+id;
const FLEET_INDEX=(systemID,fleetID)=>"coopPlayerMiningFleet"+SEP+systemID+":"+fleetID;
const pos=x=>Number.isSafeInteger(x)&&x>0;
const validOperation=x=>typeof x==="string"&&/^coop-mining-shift:[0-9a-f]{32}$/.test(x);
const money=x=>{
 if(typeof x!=="number"||!Number.isFinite(x)||x<0)return null;
 const scaled=x*100,whole=Math.round(scaled);
 return Number.isSafeInteger(whole)&&Math.abs(scaled-whole)<=1e-6?whole:null;
};
const isk=c=>c/100;
const ids=x=>Array.isArray(x)&&x.length>0&&x.length<=32&&
 x.every(pos)&&new Set(x).size===x.length;
function canonicalFleet(fleet,systemID,fleetID,employerCorpID){
 if(!fleet||fleet.systemID!==systemID||fleet.fleetID!==fleetID||
    fleet.ownerID!==employerCorpID||!ids(fleet.minerIDs)||!ids(fleet.haulerIDs)||
    fleet.minerIDs.length+fleet.haulerIDs.length>32||
    new Set([...fleet.minerIDs,...fleet.haulerIDs]).size!==
      fleet.minerIDs.length+fleet.haulerIDs.length)return null;
 return {systemID,fleetID,minerIDs:[...fleet.minerIDs],haulerIDs:[...fleet.haulerIDs]};
}
function wallet(corp,id){
 if(corp?.corporationID!==id)return null;
 const w=corp.wallet?.divisions?.["1000"];
 return w&&Array.isArray(w.journal)&&Array.isArray(w.transactions)&&money(w.balance)!==null?w:null;
}
function companyReceipt(corp,operationID,ownerID,otherID,amountCents,afterCents){
 const w=wallet(corp,ownerID);
 if(!w)return false;
 const witness=x=>x?.transactionID===operationID&&x?.referenceID===operationID&&
  x?.ownerID1===ownerID&&x?.ownerID2===otherID&&
  money(Math.abs(x.amount))===Math.abs(amountCents)&&
  (amountCents<0?x.amount<0:x.amount>0)&&money(x.balance)===afterCents;
 return w.transactions.filter(x=>x?.transactionID===operationID).length===1&&
  w.journal.filter(x=>x?.transactionID===operationID).length===1&&
  witness(w.transactions.find(x=>x?.transactionID===operationID))&&
  witness(w.journal.find(x=>x?.transactionID===operationID));
}
function createPlayerMiningCompany({gameStore,access,getFleet,verifyNativeFleet,
 verifyNpcCorporation,quoteWage,clock=()=>Date.now(),enabled=()=>false}={}){
 if(gameStore?.coopAtomicNativeRows?.mode!=="SERVER_INTERNAL_FLAGGED"||
  typeof gameStore.coopAtomicNativeRows.transact!=="function"||
  typeof gameStore.coopAtomicNativeRows.isPoisoned!=="function"||
  [access?.canIndustry,access?.canWallet,access?.isMember,getFleet,
   verifyNativeFleet,verifyNpcCorporation,quoteWage,clock,enabled]
   .some(x=>typeof x!=="function"))throw Error("MINING_COMPANY_NATIVE_AUTHORITIES_REQUIRED");
 const atomic=gameStore.coopAtomicNativeRows;
 function hire({session,corporationID,employerCorpID,systemID,fleetID,cycles,operationID}={}){
  const reject=reason=>({status:"BLOCKED",reason});
  if(enabled()!==true)return reject("MINING_COMPANY_DISABLED");
  if(!validOperation(operationID)||![corporationID,employerCorpID,systemID,fleetID].every(pos)||
     corporationID===employerCorpID||!Number.isSafeInteger(cycles)||cycles<1||cycles>120)
   return reject("INVALID_SHIFT_REQUEST");
  // The native access authority re-reads account + character + membership.
  const authorized=()=>access.isMember(session,corporationID)===true&&
   access.canIndustry(session,corporationID)===true&&
   access.canWallet(session,corporationID,1000)===true;
  if(!authorized())return reject("NATIVE_CORPORATION_PERMISSION_DENIED");
  if(atomic.isPoisoned())return reject("NATIVE_ATOMIC_STORE_POISONED");
  let fleet,quote;
  try{
   fleet=canonicalFleet(getFleet({systemID,fleetID}),systemID,fleetID,employerCorpID);
   if(!fleet||verifyNativeFleet({...fleet,ownerID:employerCorpID})!==true)
    return reject("PHYSICAL_NATIVE_FLEET_UNVERIFIED");
   quote=quoteWage({corporationID,employerCorpID,fleet,cycles});
  }catch(_){return reject("MINING_COMPANY_SOURCE_UNAVAILABLE");}
  const cost=quote?.wageCents;
  if(!pos(cost)||cost>1000000000000||quote?.employerCorpID!==employerCorpID||
     quote?.fleetID!==fleetID||quote?.cycles!==cycles)
   return reject("NATIVE_EMPLOYER_WAGE_QUOTE_INVALID");
  try{
   return atomic.transact(TABLES,tx=>{
    // Repeat preconditions INSIDE the only durable write boundary.
    if(!authorized())throw Error("NATIVE_CORPORATION_PERMISSION_REVOKED");
    const buyer=tx.get("corporationRuntime",CORP(corporationID));
    const employer=tx.get("corporationRuntime",CORP(employerCorpID));
    // Membership/role authority above proves a native player corporation.
    // The wallet's persisted runtime row need not duplicate isNPC.
    if(buyer?.corporationID!==corporationID||!verifyNpcCorporation(employerCorpID,employer))
     throw Error("MINING_COMPANY_OWNER_INVALID");
    const old=tx.get("corporationRuntime",CONTRACT(operationID));
    const indexKey=FLEET_INDEX(systemID,fleetID);
    const priorFleet=tx.get("corporationRuntime",indexKey);
    if(old){
     if(old.version!==1||old.status!=="FUNDED"||old.operationID!==operationID||
      old.corporationID!==corporationID||old.employerCorpID!==employerCorpID||
      old.systemID!==systemID||old.fleetID!==fleetID||old.cycles!==cycles||
      old.wageCents!==cost||priorFleet?.operationID!==operationID||
      priorFleet?.corporationID!==corporationID||!companyReceipt(buyer,operationID,corporationID,employerCorpID,-cost,old.buyerAfterCents)||
      !companyReceipt(employer,operationID,employerCorpID,corporationID,cost,old.employerAfterCents))
      throw Error("MINING_COMPANY_REPLAY_CONFLICT");
     return {status:"ALREADY_FUNDED",operationID,wageCents:cost};
    }
    // A physical mining fleet may not be sold to two player corporations.
    const existing=tx.scan("corporationRuntime").filter(({key,value})=>
     String(key).startsWith("coopPlayerMiningShift"+SEP)&&value?.status==="FUNDED"&&
     value?.systemID===systemID&&value?.fleetID===fleetID);
    if(existing.length||priorFleet)throw Error("MINING_FLEET_ALREADY_CONTRACTED");
    const src=wallet(buyer,corporationID),dst=wallet(employer,employerCorpID);
    if(!src||!dst)throw Error("NATIVE_CORPORATION_WALLET_MISSING");
    const a=money(src.balance),b=money(dst.balance);
    if(a<cost)throw Error("MINING_COMPANY_INSUFFICIENT_ISK");
    if(!Number.isSafeInteger(b+cost))throw Error("MINING_COMPANY_WALLET_OVERFLOW");
    for(const w of [src,dst])if(w.transactions.some(x=>x.transactionID===operationID)||
      w.journal.some(x=>x.transactionID===operationID))
      throw Error("MINING_COMPANY_WALLET_RECEIPT_COLLISION");
    // Revalidate physical identity immediately before committing funds.
    if(verifyNativeFleet({...fleet,ownerID:employerCorpID})!==true)
     throw Error("PHYSICAL_NATIVE_FLEET_CHANGED");
    const now=clock();if(!pos(now))throw Error("MINING_COMPANY_CLOCK_INVALID");
    const filetime=String(BigInt(now)*10000n+116444736000000000n);
    const entry=(owner,other,amount,after)=>({transactionID:operationID,
     referenceID:operationID,transactionDate:filetime,ownerID1:owner,ownerID2:other,
     accountKey:1000,entryTypeID:10,currency:1,sortValue:1,
     amount:isk(amount),balance:isk(after),
     description:"Native NPC mining shift "+operationID});
    const update=(corp,w,after,entry)=>({...corp,wallet:{...corp.wallet,divisions:{
     ...corp.wallet.divisions,"1000":{...w,balance:isk(after),
      journal:[...w.journal,entry].slice(-100),
      transactions:[...w.transactions,entry].slice(-2000)}}}});
    const paid=entry(corporationID,employerCorpID,-cost,a-cost),
     earned=entry(employerCorpID,corporationID,cost,b+cost);
    tx.put("corporationRuntime",CORP(corporationID),update(buyer,src,a-cost,paid));
    tx.put("corporationRuntime",CORP(employerCorpID),update(employer,dst,b+cost,earned));
    tx.put("corporationRuntime",indexKey,{version:1,operationID,
     corporationID,employerCorpID,systemID,fleetID});
    tx.put("corporationRuntime",CONTRACT(operationID),{version:1,status:"FUNDED",
     directive:"MINE",commandSeq:0,commandState:"IDLE",
     operationID,corporationID,employerCorpID,systemID,fleetID,cycles,
     minerIDs:fleet.minerIDs,haulerIDs:fleet.haulerIDs,wageCents:cost,
     buyerBeforeCents:a,buyerAfterCents:a-cost,
     employerBeforeCents:b,employerAfterCents:b+cost,createdAt:now});
    return {status:"FUNDED",operationID,wageCents:cost,systemID,fleetID};
   });
  }catch(error){
   // The native atomic API must determine rollback/poisoning. We cannot tell
   // from a thrown boundary whether a debit committed: never auto-refund/retry.
   return {status:"NEEDS_OPERATOR_REPAIR",reason:String(error?.message||error).slice(0,120),operationID};
  }
 }
 return Object.freeze({hire});
}
module.exports={createPlayerMiningCompany,canonicalFleet,companyReceipt,FLEET_INDEX,CONTRACT,CORP};
