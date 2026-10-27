"use strict";
// Durable, fail-closed P2P fill witness. NEVER claims Rust/GameStore atomicity.
// A PREPARED or RUST_ACK entry survives restart and forbids blind replay.
const fs=require("node:fs"),path=require("node:path");
const {assertFillAck}=require("./coopPlayerMarketFill"+(__filename.endsWith(".cjs")?".cjs":""));
const natural=n=>typeof n==="number"&&Number.isSafeInteger(n)&&n>0;
const money=n=>{
 if(typeof n!=="number"||!Number.isFinite(n)||n<0)return null;
 const c=Math.round(n*100);
 return Number.isSafeInteger(c)&&Math.abs(n*100-c)<1e-6?c:null;
};
const positiveID=x=>typeof x==="string"&&/^[1-9][0-9]*$/.test(x);
const STATES=["PREPARED","RUST_ACK","SETTLED"];
const safeFile=file=>typeof file==="string"&&path.isAbsolute(file)&&
 file!==path.parse(file).root&&
 !/(?:^|[\\/])(?:tmp|temp)(?:[\\/]|$)/i.test(file);
function makeSettlementFence({file,storage=fs,readNative,clock=()=>Date.now(),
 platform=process.platform}={}){
 if(!safeFile(file)||!storage||!readNative||
  ["mkdirSync","openSync","writeSync","fsyncSync","closeSync","unlinkSync",
   "readFileSync"].some(x=>typeof storage[x]!=="function")||
  ["wallet","quantity","escrow"].some(x=>typeof readNative[x]!=="function"))
  throw Error("P2P_PERSISTENT_NATIVE_SETTLEMENT_BINDINGS_REQUIRED");
 let poisoned=false;
 const lock=file+".lock";
 const reject=msg=>{const e=Error(msg);e.coopExpectedRefusal=true;throw e};
 // Windows does not reliably support fsync() on directories. Require an
 // independently pre-created persistent journal so its directory entry is
 // not first allocated by a settlement that could be interrupted.
 if(platform==="win32"){
  try{
   const existing=storage.readFileSync(file,"utf8");
   if(typeof existing!=="string"||(existing&&!existing.endsWith("\n")))
    throw Error("P2P_WIN32_JOURNAL_NOT_VALID");
  }catch(e){throw Error("P2P_WIN32_PRECREATED_JOURNAL_REQUIRED")}
 }
 function records(){
  let body;
  try{body=storage.readFileSync(file,"utf8")}
  catch(e){if(e.code==="ENOENT")return new Map();throw e}
  if(typeof body!=="string"||(body.length&&!body.endsWith("\n")))
   throw Error("P2P_SETTLEMENT_JOURNAL_TRUNCATED");
  const map=new Map();
  for(const line of body.split("\n").filter(Boolean)){
   let event;
   try{event=JSON.parse(line)}catch{throw Error("P2P_SETTLEMENT_JOURNAL_CORRUPT")}
   if(event?.version!==1||!positiveID(event.orderID)||
      !natural(event.cycle)||!STATES.includes(event.phase)||
      typeof event.time!=="number"||!Number.isFinite(event.time))
    throw Error("P2P_SETTLEMENT_JOURNAL_INVALID_ENTRY");
   const prev=map.get(event.orderID);
   if(!prev){
    if(event.cycle!==1||event.phase!=="PREPARED"||!event.proof||!event.before)
     throw Error("P2P_SETTLEMENT_JOURNAL_INVALID_START");
   }else if(event.cycle===prev.cycle){
    if(!((prev.phase==="PREPARED"&&event.phase==="RUST_ACK")||
         (prev.phase==="RUST_ACK"&&event.phase==="SETTLED")))
     throw Error("P2P_SETTLEMENT_JOURNAL_INVALID_TRANSITION");
   }else if(event.cycle===prev.cycle+1){
    if(prev.phase!=="SETTLED"||event.phase!=="PREPARED"||
       !event.proof||!event.before||
       event.proof.volumeBefore!==prev.proof.volumeAfter)
     throw Error("P2P_SETTLEMENT_JOURNAL_INVALID_RESTART");
   }else throw Error("P2P_SETTLEMENT_JOURNAL_INVALID_SEQUENCE");
   map.set(event.orderID,{
    ...event,
    proof:Object.freeze(event.proof||prev?.proof),
    before:event.before||prev?.before,
    chargeBuyerWallet:event.chargeBuyerWallet??prev?.chargeBuyerWallet
   });
  }
  return map;
 }
 function append(ev){
  const dir=path.dirname(file);
  storage.mkdirSync(dir,{recursive:true});
  const fd=storage.openSync(file,"a",0o600);
  try{
   const row=JSON.stringify(ev)+"\n";
   const written=storage.writeSync(fd,row,null,"utf8");
   if(written!==Buffer.byteLength(row,"utf8"))
    throw Error("P2P_SETTLEMENT_SHORT_JOURNAL_WRITE");
   storage.fsyncSync(fd);
  }finally{storage.closeSync(fd)}
  if(platform!=="win32"){
   const directory=storage.openSync(dir,"r");
   try{storage.fsyncSync(directory)}finally{storage.closeSync(directory)}
  }
 }
 function withLock(fn){
  if(poisoned)throw Error("P2P_SETTLEMENT_PROCESS_POISONED");
  let fd;
  try{
   storage.mkdirSync(path.dirname(file),{recursive:true});
   fd=storage.openSync(lock,"wx",0o600);
   const row=JSON.stringify({pid:process.pid,time:clock()});
   storage.writeSync(fd,row,null,"utf8");storage.fsyncSync(fd);
   storage.closeSync(fd);fd=null;
  }catch(e){
   if(fd!==undefined)try{storage.closeSync(fd)}catch{}
   poisoned=true;throw Error("P2P_SETTLEMENT_LOCK_UNAVAILABLE");
  }
  try{return fn()}
  catch(e){if(!e?.coopExpectedRefusal)poisoned=true;throw e}
  finally{try{storage.unlinkSync(lock)}catch{poisoned=true}}
 }
 function snapshot(proof){
  const sellerID=proof.bid?proof.counterpartyID:proof.ownerID;
  const buyerID=proof.bid?proof.ownerID:proof.counterpartyID;
  const source=proof.sellerSourceLocationID;
  if(!natural(sellerID)||!natural(buyerID)||!natural(source)||
     !natural(proof.stationID)||!natural(proof.typeID))
   throw Error("P2P_SETTLEMENT_SOURCE_LOCATION_REQUIRED");
  const buyerWallet=money(readNative.wallet(buyerID));
  const sellerWallet=money(readNative.wallet(sellerID));
  const buyerItems=readNative.quantity(buyerID,proof.stationID,proof.typeID,4);
  const sellerItems=readNative.quantity(sellerID,source,proof.typeID,4);
  if(buyerWallet===null||sellerWallet===null||
     !Number.isSafeInteger(buyerItems)||buyerItems<0||
     !Number.isSafeInteger(sellerItems)||sellerItems<proof.filledQuantity)
   throw Error("P2P_SETTLEMENT_NATIVE_SNAPSHOT_UNAVAILABLE");
  return {buyerID,sellerID,buyerWallet,sellerWallet,buyerItems,sellerItems,
   sourceLocationID:source};
 }
 function assertClear(orderID){
  return withLock(()=>{
   if(!positiveID(String(orderID)))throw Error("P2P_SETTLEMENT_ORDER_ID_INVALID");
   const row=records().get(String(orderID));
   if(row&&row.phase!=="SETTLED")
    reject("P2P_SETTLEMENT_MANUAL_RECONCILIATION_REQUIRED");
   return true;
  });
 }
 function assertStationClear(stationID){
  return withLock(()=>{
   if(!natural(stationID))throw Error("P2P_SETTLEMENT_STATION_INVALID");
   for(const row of records().values())
    if(row.phase!=="SETTLED"&&row.proof.stationID===stationID)
     reject("P2P_SETTLEMENT_STATION_HAS_UNRECONCILED_FILLS");
   return true;
  });
 }
 function begin(proof,{chargeBuyerWallet=true}={}){
  return withLock(()=>{
   if(!proof||!Object.isFrozen(proof)||!positiveID(proof.orderID)||
      !natural(proof.volumeBefore)||!natural(proof.filledQuantity)||
      !natural(proof.sellerSourceLocationID)||
      !Number.isSafeInteger(proof.volumeAfter)||proof.volumeAfter<0)
    throw Error("P2P_SETTLEMENT_PROOF_INVALID");
   const existing=records(),prev=existing.get(proof.orderID);
   if(prev&&(prev.phase!=="SETTLED"||
      prev.proof.volumeAfter!==proof.volumeBefore))
    reject("P2P_SETTLEMENT_EXISTING_FILL_UNRECONCILED");
   const before=snapshot(proof);
   // Prevent overlapping wallet/inventory deltas for either participating
   // character. This is conservative but avoids false reconciliation.
   for(const row of existing.values()){
    if(row.phase==="SETTLED")continue;
    if([row.before.buyerID,row.before.sellerID].includes(before.buyerID)||
       [row.before.buyerID,row.before.sellerID].includes(before.sellerID))
     reject("P2P_SETTLEMENT_PARTICIPANT_IN_FLIGHT");
   }
   const cycle=prev?prev.cycle+1:1;
   const ev={version:1,orderID:proof.orderID,cycle,phase:"PREPARED",time:clock(),
    proof,before,chargeBuyerWallet:chargeBuyerWallet===true};
   append(ev);
   return Object.freeze({orderID:proof.orderID,cycle});
  });
 }
 function confirmRust(ticket,ack){
  return withLock(()=>{
   const prev=records().get(ticket?.orderID);
   if(!prev||prev.cycle!==ticket.cycle||prev.phase!=="PREPARED")
    throw Error("P2P_SETTLEMENT_RUST_ACK_NOT_PREPARED");
   assertFillAck({proof:prev.proof,ack});
   append({version:1,orderID:ticket.orderID,cycle:ticket.cycle,
    phase:"RUST_ACK",time:clock()});
   return true;
  });
 }
 function complete(ticket,{salesTax}={}){
  return withLock(()=>{
   const prev=records().get(ticket?.orderID);
   if(!prev||prev.cycle!==ticket.cycle||prev.phase!=="RUST_ACK")
    throw Error("P2P_SETTLEMENT_NOT_RUST_ACKED");
   const {proof,before}=prev;
   const after=snapshot(proof);
   const gross=proof.priceCents*proof.filledQuantity,tax=money(salesTax);
   if(!Number.isSafeInteger(gross)||gross<=0||tax===null||
      tax>gross||after.buyerID!==before.buyerID||
      after.sellerID!==before.sellerID||
      after.buyerItems-before.buyerItems!==proof.filledQuantity||
      before.sellerItems-after.sellerItems!==proof.filledQuantity||
      after.sellerWallet-before.sellerWallet!==gross-tax||
      after.buyerWallet-before.buyerWallet!==
       (prev.chargeBuyerWallet?-gross:0))
    throw Error("P2P_SETTLEMENT_NATIVE_CUSTODY_OR_WALLET_MISMATCH");
   const escrow=readNative.escrow(proof.orderID);
   if(proof.volumeAfter===0){
    if(escrow)throw Error("P2P_SETTLEMENT_TERMINAL_ESCROW_NOT_REMOVED");
   }else if(!escrow||escrow.remainingQuantity!==proof.volumeAfter||
     escrow.ownerId!==proof.ownerID||escrow.typeId!==proof.typeID||
     escrow.stationId!==proof.stationID||
     escrow.escrowType!==(proof.bid?"buy":"sell")||
     (proof.bid&&money(escrow.escrowAmount)!==proof.priceCents*proof.volumeAfter))
    throw Error("P2P_SETTLEMENT_PARTIAL_ESCROW_NOT_RECONCILED");
   append({version:1,orderID:ticket.orderID,cycle:ticket.cycle,
    phase:"SETTLED",time:clock()});
   return true;
  });
 }
 function requireSettled(ticket){
  return withLock(()=>{
   if(!ticket||!positiveID(ticket.orderID)||!natural(ticket.cycle))
    throw Error("P2P_SETTLEMENT_TICKET_REQUIRED");
   const row=records().get(ticket.orderID);
   if(!row||row.cycle!==ticket.cycle||row.phase!=="SETTLED")
    reject("P2P_SETTLEMENT_DURABLE_RECEIPT_NOT_SETTLED");
   return true;
  });
 }
 function inspect(){
  return withLock(()=>[...records().values()].map(x=>({
   orderID:x.orderID,cycle:x.cycle,phase:x.phase,
   buyerID:x.before.buyerID,sellerID:x.before.sellerID
  })));
 }
 return Object.freeze({begin,confirmRust,complete,requireSettled,assertClear,assertStationClear,inspect});
}
let instance=null,root=null;
function active(){
 if(process.env.EVEJS_COOP_PLAYER_MARKET_FILL_GUARD!=="1"||
    process.env.EVEJS_COOP_PLAYER_MARKET_SETTLEMENT_FENCE!=="1")
  throw Error("P2P_SETTLEMENT_GUARDS_DISABLED");
 const file=process.env.EVEJS_COOP_PLAYER_MARKET_SETTLEMENT_JOURNAL_FILE;
 if(!safeFile(file))throw Error("P2P_SETTLEMENT_PERSISTENT_JOURNAL_REQUIRED");
 if(instance){
  if(root!==file)throw Error("P2P_SETTLEMENT_JOURNAL_CHANGED");
  return instance;
 }
 const wallets=require("../services/account/walletState");
 const items=require("../services/inventory/itemStore");
 const escrow=require("../services/market/marketEscrowState");
 const native={
  wallet:id=>wallets.getCharacterWallet(id)?.balance,
  quantity:(ownerID,locationID,typeID,flagID)=>{
   const rows=items.listContainerItems(ownerID,locationID,flagID);
   if(!Array.isArray(rows))throw Error("P2P_SETTLEMENT_INVENTORY_UNAVAILABLE");
   const seen=new Set();let sum=0;
   for(const x of rows){
    if(!natural(x?.itemID)||seen.has(x.itemID)||
       x.ownerID!==ownerID||x.locationID!==locationID||x.flagID!==flagID)
      throw Error("P2P_SETTLEMENT_INVENTORY_IDENTITY_INVALID");
    seen.add(x.itemID);
    if(x.typeID!==typeID)continue;
    const q=x.singleton===1?1:Number(x.stacksize??x.quantity);
    if(!natural(q)||!Number.isSafeInteger(sum+q))
     throw Error("P2P_SETTLEMENT_INVENTORY_QUANTITY_INVALID");
    sum+=q;
   }
   return sum;
  },
  escrow:escrow.getEscrowRecord
 };
 const opened=makeSettlementFence({file,readNative:native});
 instance=opened;root=file;
 return opened;
}
module.exports={makeSettlementFence,
 begin:(proof,opts)=>active().begin(proof,opts),
 confirmRust:(ticket,ack)=>active().confirmRust(ticket,ack),
 complete:(ticket,opts)=>active().complete(ticket,opts),
 requireSettled:ticket=>active().requireSettled(ticket),
 assertClear:orderID=>active().assertClear(orderID),
 assertStationClear:stationID=>active().assertStationClear(stationID),
 inspect:()=>active().inspect()};
