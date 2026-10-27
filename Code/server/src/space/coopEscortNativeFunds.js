"use strict";
// Stage B: genuine EveJS GameStore wallet rows, NOT virtual NPC currency.
// The injected GameStore atomic bridge must own its SQLite connection and cache.
const {createHash}=require("node:crypto");
const SEP="\u001f";
const TABLES=Object.freeze(["corporationRuntime","characters"]);
const ESCROW_KEY="coopEscortEscrows";
const ACCOUNT_KEY="1000";
const pos=x=>Number.isSafeInteger(x)&&x>0;
const isObject=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const cents=x=>Number.isFinite(x)&&x>=0&&Number.isSafeInteger(Math.round(x*100))&&
 Math.abs(x*100-Math.round(x*100))<0.00001?Math.round(x*100):null;
const money=x=>x/100;
const clone=x=>JSON.parse(JSON.stringify(x));
const MAX_ESCROWS=512;
function fail(reason){throw Error("ESCORT_NATIVE_"+reason)}
function keyOf(c){return "corporations"+SEP+c.corporationID}
function transactionId(contractID,role){
 return Number.parseInt(createHash("sha256").update("evejs-escort/v1/"+contractID+"/"+role)
  .digest("hex").slice(0,12),16);
}
function entry(c,role,amountCents,balanceCents,at,ownerID1,ownerID2){
 const id=transactionId(c.contractID,role);
 return {transactionID:id,transactionDate:String(116444736000000000n+BigInt(at)*10000n),
  referenceID:id,entryTypeID:10,ownerID1,ownerID2,accountKey:1000,
  amount:money(amountCents),balance:money(balanceCents),
  description:"NPC escort "+role+" "+c.contractID,
  currency:1,sortValue:1,escortContractID:c.contractID};
}
function checkContract(c,isNpcCorporation){
 if(!isObject(c)||typeof c.contractID!=="string"||
  !/^escort-[a-zA-Z0-9-]{1,48}$/.test(c.contractID)||
  ![c.corporationID,c.amountISK].every(pos)||
  c.amountISK>1000000000||c.amountISK%2!==0||
  !Array.isArray(c.characters)||c.characters.length!==2||
  !c.characters.every(pos)||c.characters[0]>=c.characters[1]||
  typeof c.manifestKey!=="string"||!/^\d+-\d+-\d+$/.test(c.manifestKey)||
  isNpcCorporation(c.corporationID)!==true)fail("CONTRACT_INVALID");
 return c;
}
function readEscrows(tx){
 const table=tx.get("corporationRuntime",ESCROW_KEY);
 if(table===null)return {version:1,byContract:{}};
 if(!isObject(table)||table.version!==1||!isObject(table.byContract)||
  Object.keys(table.byContract).length>MAX_ESCROWS)fail("ESCROW_LEDGER_INVALID");
 return table;
}
function exact(row,c){
 return isObject(row)&&row.contractID===c.contractID&&
  row.corporationID===c.corporationID&&row.amountISK===c.amountISK&&
  row.manifestKey===c.manifestKey&&
  Array.isArray(row.characters)&&row.characters.length===2&&
  row.characters[0]===c.characters[0]&&row.characters[1]===c.characters[1]&&
  row.escrowKey===c.contractID;
}
function readCorp(tx,c){
 const row=tx.get("corporationRuntime",keyOf(c));
 const division=row?.wallet?.divisions?.[ACCOUNT_KEY];
 if(!isObject(row)||!isObject(division)||division.key!==1000||
  cents(division.balance)===null||!Array.isArray(division.journal)||
  !Array.isArray(division.transactions))fail("CORPORATION_WALLET_UNAVAILABLE");
 return {row,division,balanceCents:cents(division.balance)};
}
function readCharacter(tx,id){
 const row=tx.get("characters",String(id));
 if(!isObject(row)||row.characterID!==id||cents(row.balance)===null||
  !Array.isArray(row.walletJournal)||
  (row.balanceChange!==undefined&& !Number.isFinite(row.balanceChange)))
  fail("CHARACTER_WALLET_UNAVAILABLE");
 return {row,balanceCents:cents(row.balance)};
}
function appendCorpLedger(division,record){
 division.journal=[...division.journal,record].slice(-100);
 division.transactions=[...division.transactions,record].slice(-2000);
}
function appendCharLedger(row,record){
 row.walletJournal=[record,...row.walletJournal].slice(0,100);
}
function createEscortNativeFunds({atomicRows,isNpcCorporation,clock=()=>Date.now(),verifyNativeFailure=null,verifyRescueFailure=null}={}){
 if(typeof atomicRows?.transact!=="function"||
  typeof atomicRows?.isPoisoned!=="function"||
  typeof isNpcCorporation!=="function"||typeof clock!=="function")
  throw Error("ESCORT_GAMESTORE_ATOMIC_AUTHORITIES_REQUIRED");
 function enabled(){
  return process.env.EVEJS_COOP_NATIVE_ATOMIC_ROWS==="1"&&
   process.env.EVEJS_COOP_NATIVE_ESCORT_WALLET==="1"&&
   atomicRows.mode==="SERVER_INTERNAL_FLAGGED"&&atomicRows.isPoisoned()===false;
 }
 function requireEnabled(){if(!enabled())fail("ATOMIC_WALLET_DISABLED")}
 function apply(fn){requireEnabled();return atomicRows.transact(TABLES,fn)}
 function capabilities(){
  const ready=enabled();
  return {nativeDurable:ready,atomicDualCredit:ready,durableIdempotency:ready};
 }
 function verifyReservation(c){
  checkContract(c,isNpcCorporation);
  return apply(tx=>{
   const row=readEscrows(tx).byContract[c.contractID];
   if(!row)return {status:"NOT_FOUND"};
   if(!exact(row,c))fail("ESCROW_IDENTITY_CONFLICT");
   if(row.status!=="RESERVED")return {status:"NOT_RESERVED"};
   if(!pos(row.amountISK)||!pos(row.fundedAt))fail("ESCROW_CORRUPT");
   return {status:"RESERVED",contractID:c.contractID,corporationID:c.corporationID,
    amountISK:c.amountISK,escrowKey:c.contractID,nativeDurable:true};
  });
 }
 function verifySettlement(c){
  checkContract(c,isNpcCorporation);
  return apply(tx=>{
   const row=readEscrows(tx).byContract[c.contractID];
   if(!row)return {status:"NOT_FOUND"};
   if(!exact(row,c))fail("ESCROW_IDENTITY_CONFLICT");
   if(row.status!=="SETTLED")return {status:"NOT_SETTLED"};
   if(!pos(row.settledAt)||!Array.isArray(row.credits)||row.credits.length!==2||
    row.credits.some((x,i)=>x.characterID!==c.characters[i]||x.amountISK!==c.amountISK/2))
    fail("SETTLEMENT_CORRUPT");
   return {status:"SETTLED",contractID:c.contractID,corporationID:c.corporationID,
    amountISK:c.amountISK,escrowKey:c.contractID,escrowConsumed:true,
    nativeDurable:true,credits:clone(row.credits)};
  });
 }
 function reserveAtomic(c){
  checkContract(c,isNpcCorporation);
  return apply(tx=>{
   const ledger=readEscrows(tx);
   if(ledger.byContract[c.contractID])fail("CONTRACT_ALREADY_RESERVED");
   if(Object.keys(ledger.byContract).length>=MAX_ESCROWS)fail("ESCROW_CAP_REACHED");
   if(Object.values(ledger.byContract).some(x=>x?.manifestKey===c.manifestKey))
    fail("MANIFEST_ALREADY_FUNDED");
   const corp=readCorp(tx,c),cost=cents(c.amountISK);
   if(corp.balanceCents<cost)fail("INSUFFICIENT_CORPORATION_FUNDS");
   // Beneficiaries must be real persisted player characters *before* any debit.
   c.characters.forEach(x=>readCharacter(tx,x));
   const now=clock();if(!pos(now))fail("INVALID_CLOCK");
   const remaining=corp.balanceCents-cost;
   corp.division.balance=money(remaining);
   appendCorpLedger(corp.division,entry(c,"reserve",-cost,remaining,now,
    c.corporationID,0));
   tx.put("corporationRuntime",keyOf(c),corp.row);
   ledger.byContract[c.contractID]={contractID:c.contractID,
    escrowKey:c.contractID,manifestKey:c.manifestKey,
    corporationID:c.corporationID,amountISK:c.amountISK,
    characters:c.characters.slice(),status:"RESERVED",fundedAt:now,
    fundedBalanceISK:money(remaining)};
   tx.put("corporationRuntime",ESCROW_KEY,ledger);
   return {status:"RESERVED",contractID:c.contractID};
  });
 }
 function settleAtomic({contractID,corporationID,amountISK,credits}={}){
  if(typeof contractID!=="string"||!pos(corporationID)||!pos(amountISK)||
   !Array.isArray(credits)||credits.length!==2||
   credits.some(x=>!pos(x?.characterID)||!pos(x?.amountISK))||
   credits[0].characterID>=credits[1].characterID||
   credits.some(x=>x.amountISK!==amountISK/2))fail("SETTLEMENT_REQUEST_INVALID");
  return apply(tx=>{
   const ledger=readEscrows(tx),record=ledger.byContract[contractID];
   if(!record)fail("RESERVATION_NOT_FOUND");
   const c={contractID,corporationID,amountISK,
    manifestKey:record.manifestKey,characters:credits.map(x=>x.characterID)};
   checkContract(c,isNpcCorporation);
   if(!exact(record,c)||record.status!=="RESERVED")fail("RESERVATION_NOT_PAYABLE");
   // Every source and beneficiary row participates in the same GameStore/SQL
   // BEGIN IMMEDIATE transaction. No intermediate partial-credit state exists.
   const people=c.characters.map(id=>readCharacter(tx,id));
   const now=clock();if(!pos(now))fail("INVALID_CLOCK");
   const paid=[];
   for(let i=0;i<people.length;i++){
    const p=people[i],amountCents=cents(credits[i].amountISK);
    const next=p.balanceCents+amountCents;
    if(!Number.isSafeInteger(next))fail("CHARACTER_BALANCE_OVERFLOW");
    p.row.balance=money(next);p.row.balanceChange=credits[i].amountISK;
    appendCharLedger(p.row,entry(c,"pilot"+(i+1),amountCents,next,now,
     c.corporationID,c.characters[i]));
    tx.put("characters",String(c.characters[i]),p.row);
    paid.push({characterID:c.characters[i],amountISK:credits[i].amountISK});
   }
   record.status="SETTLED";record.settledAt=now;record.credits=paid;
   ledger.byContract[contractID]=record;
   tx.put("corporationRuntime",ESCROW_KEY,ledger);
   return {status:"SETTLED",contractID,credits:paid};
  });
 }

 // REFUNDED is a terminal alternative to SETTLED; not a new ISK source.
 // A timeout, missing process ACK or unproven empty scene is NOT a failure proof.
 function verifyRefund(c){
  checkContract(c,isNpcCorporation);
  return apply(tx=>{
   const row=readEscrows(tx).byContract[c.contractID];
   if(!row)return {status:"NOT_FOUND"};
   if(!exact(row,c))fail("ESCROW_IDENTITY_CONFLICT");
   if(row.status!=="REFUNDED")return {status:"NOT_REFUNDED"};
   if(!pos(row.refundedAt)||!pos(row.failureWitnessID)||
    !["NATIVE_HAULER_WRECK","NATIVE_PREWARP_CANCELLED"].includes(row.refundReason))
    fail("REFUND_CORRUPT");
   return {status:"REFUNDED",contractID:c.contractID,
    corporationID:c.corporationID,amountISK:c.amountISK,
    escrowKey:c.contractID,nativeDurable:true,
    reason:row.refundReason,failureWitnessID:row.failureWitnessID};
  });
 }
 function refundAtomic(c){
  if(process.env.EVEJS_COOP_ESCORT_REFUNDS!=="1")fail("REFUNDS_DISABLED");
  checkContract(c,isNpcCorporation);
  if(typeof verifyNativeFailure!=="function")fail("FAILURE_AUTHORITY_NOT_WIRED");
  // This callback MUST read durable, irreversible server-owned native
  // evidence, never a client request, UI timer or transient missing ship.
  let witness;try{witness=verifyNativeFailure(clone(c))}
  catch{fail("NATIVE_FAILURE_PROOF_UNAVAILABLE")}
  if(!isObject(witness)||witness.status!=="DURABLE_NATIVE_CONVOY_TERMINAL_FAILURE"||
    witness.contractID!==c.contractID||
    witness.manifestKey!==c.manifestKey||
    witness.corporationID!==c.corporationID||
    !["NATIVE_HAULER_WRECK","NATIVE_PREWARP_CANCELLED"].includes(witness.reason)||
    !pos(witness.failureWitnessID)||witness.nativeDurable!==true||
    witness.deliveryImpossible!==true||
    witness.noPriorPayout!==true)
    fail("NATIVE_FAILURE_NOT_VERIFIED");
  return apply(tx=>{
   const ledger=readEscrows(tx),record=ledger.byContract[c.contractID];
   if(!record)fail("RESERVATION_NOT_FOUND");
   if(!exact(record,c)||record.status!=="RESERVED")fail("REFUND_NOT_ALLOWED");
   const corp=readCorp(tx,c),add=cents(c.amountISK);
   const next=corp.balanceCents+add;
   if(!Number.isSafeInteger(next))fail("CORPORATION_BALANCE_OVERFLOW");
   const now=clock();if(!pos(now))fail("INVALID_CLOCK");
   corp.division.balance=money(next);
   appendCorpLedger(corp.division,entry(c,"refund",add,next,now,
    c.corporationID,0));
   tx.put("corporationRuntime",keyOf(c),corp.row);
   record.status="REFUNDED";record.refundedAt=now;
   record.refundReason=witness.reason;
   record.failureWitnessID=witness.failureWitnessID;
   ledger.byContract[c.contractID]=record;
   tx.put("corporationRuntime",ESCROW_KEY,ledger);
   return {status:"REFUNDED",contractID:c.contractID,
    corporationID:c.corporationID,amountISK:c.amountISK};
  });
 }
 // A competing real NPC may irreversibly remove original salvage from
 // the rescue prize pool. Corporate RESCUE escrow is returned with a real
 // native custody witness, NOT a timeout or player-supplied cancellation.
 function refundRescueAtomic(c){
  if(process.env.EVEJS_COOP_RESCUE_CONTRACTS!=="1"||
   process.env.EVEJS_COOP_ESCORT_REFUNDS!=="1")
   fail("RESCUE_REFUND_DISABLED");
  checkContract(c,isNpcCorporation);
  if(!c.contractID.startsWith("escort-rescue-")||
   typeof verifyRescueFailure!=="function")
   fail("RESCUE_REFUND_AUTHORITY_NOT_WIRED");
  let witness;try{witness=verifyRescueFailure(clone(c))}
  catch{fail("RESCUE_RIVAL_CUSTODY_SOURCE_UNAVAILABLE")}
  if(!isObject(witness)||
   witness.status!=="DURABLE_NATIVE_RESCUE_RIVAL_FAILURE"||
   witness.contractID!==c.contractID||
   witness.manifestKey!==c.manifestKey||
   witness.corporationID!==c.corporationID||
   witness.reason!=="NATIVE_RIVAL_CARGO_CAPTURED"||
   !pos(witness.failureWitnessID)||
   witness.nativeDurable!==true||
   witness.deliveryImpossible!==true||
   witness.noPriorPayout!==true)
   fail("RESCUE_RIVAL_CUSTODY_NOT_PROVEN");
  return apply(tx=>{
   const ledger=readEscrows(tx),record=ledger.byContract[c.contractID];
   if(!record)fail("RESCUE_RESERVATION_NOT_FOUND");
   if(!exact(record,c)||record.status!=="RESERVED")
    fail("RESCUE_REFUND_NOT_ALLOWED");
   const corp=readCorp(tx,c),add=cents(c.amountISK);
   const next=corp.balanceCents+add;
   if(!Number.isSafeInteger(next))fail("RESCUE_CORPORATION_BALANCE_OVERFLOW");
   const now=clock();if(!pos(now))fail("RESCUE_CLOCK_INVALID");
   corp.division.balance=money(next);
   appendCorpLedger(corp.division,entry(c,"rescue-rival-refund",
    add,next,now,c.corporationID,0));
   tx.put("corporationRuntime",keyOf(c),corp.row);
   record.status="REFUNDED";
   record.refundedAt=now;
   record.refundReason="NATIVE_RIVAL_CARGO_CAPTURED";
   record.failureWitnessID=witness.failureWitnessID;
   ledger.byContract[c.contractID]=record;
   tx.put("corporationRuntime",ESCROW_KEY,ledger);
   return {status:"REFUNDED",contractID:c.contractID,
    corporationID:c.corporationID,amountISK:c.amountISK,
    failureWitnessID:witness.failureWitnessID};
  });
 }
 return Object.freeze({capabilities,verifyReservation,verifySettlement,verifyRefund,
  reserveAtomic,settleAtomic,refundAtomic,refundRescueAtomic});
}
module.exports={createEscortNativeFunds,ESCROW_KEY,TABLES};
